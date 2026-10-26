// dsh-workflow-runner —— cordis 服务端插件。
//
// 在 dsh 自带 Web 服务上挂 /workflow 前缀路由，对外暴露：
//   POST /api/run            启动一个 run（body: {scriptPath: string, runId?: string}）
//   POST /api/stop           取消一个 run（body: {runId: string}）
//   GET  /api/state          查询一个 run 的快照（?runId=...）
//   GET  /api/list           列出所有已知 run
//   GET  /api/stream         SSE 实时事件流（?runId=...）
//   POST /api/script-content 按路径加载脚本文本（仅允许在样本目录或 $DSH_HOME/workflows 内）
//   其余路径                静态文件（public/）
//
// 鉴权：使用 ctx.connection.requestRejection(req) 对 /api/* 路由进行短路，返回值
// 0/undefined 之外的状态码即拒绝；服务不可用或抛错时一律 503（fail closed）。
// 静态资源页面绕过鉴权（让 dsh 的 React 壳子能照常加载）。
//
'use strict';
import { readFile } from 'node:fs/promises';
import { promises as fsPromises, readFileSync } from 'node:fs';
import { dirname, extname, join, normalize, resolve as resolvePath, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorkflowRuntime } from './runtime.js';
import { compileWorkflow } from './dwf/index.js';
import { createWorkflowTools } from './dwf/tools.js';
// v0.7.0: Settings → Plugins card. Schemastery is a peer dep (optional)
// — the plugin still works without it (hand-rolled validator fills in),
// but the Settings card is only registered when schemastery is resolvable
// in the dsh profile (which is true today, see dsh-workbuddy-connect
// / dsh-context / dsh-plugin-subscriptions for the pattern). If your
// dsh install can't resolve @deepseek-ai/schemastery, the plugin
// activates but the card is silently absent (matches dsh-pet's pattern).
//
// v0.15.2: the unwrap matters, and the guard has to cover the USE, not just
// the import. @deepseek-ai/schemastery publishes its `z` namespace as the
// DEFAULT export — dsh's own plugins do `import z from
// '@deepseek-ai/schemastery'` — so a namespace import yields
// `{ default: Schema }` and `schemastery.z` is undefined. The old
// `schemastery.object(...)` therefore threw at module load in every real
// profile, and the plugin never activated at all.
//
// A peer dep that is optional must never be able to take the plugin down.
// Everything that touches schemastery — the import, the unwrap, the schema
// construction — happens inside one guard. A failure anywhere in it costs
// the Settings card, not the plugin.
let schemastery = null;
try {
  // eslint-disable-next-line global-require, import/no-unresolved
  const mod = await import('@deepseek-ai/schemastery');
  schemastery = mod.default ?? mod;
} catch (_) { /* optional peer dep; cards simply won't register */ }

const name = 'dsh-workflow-runner';
// `llm` is required: lib/llm.js reads ctx.llm.resolveCallConfig(...), and cordis
// throws `cannot get property "llm" without inject` when the service is not
// declared — every agent(name).ask(prompt) call died on this.
// `connection` is required: the /api/* gate below reads ctx.connection.gate /
// ctx.connection.requestRejection, and without the declaration the access threw,
// was swallowed as "gate fault → 当作允许", and left every /api/* route open.
const inject = ['webServer', 'authorization', 'credentials', 'llm', 'connection'];

/**
 * Hand-rolled Config validator — avoids the @deepseek-ai/schemastery peer
 * dependency, which dsh's bundled-bundle resolution can fail to find on
 * a fresh install (causing the cordis `failed to import` warning when the
 * plugin is enabled). Defaults are easy to keep here.
 *
 * @param {unknown} raw
 * @returns {{ path: string, scriptsRoots: string[], workspaceRoot: string|null, allowedModels: string[], workflowsDir: string|null }}
 */
/**
 * Resolve the script text for the engine endpoints.
 *
 * Inline `scriptText` wins; otherwise the file is read from
 * `scriptPath`, which must be inside the same scriptsRoots fence
 * /api/script-content uses. Returns null when there is nothing to run.
 *
 * @param {object} body
 * @param {object} config
 * @returns {Promise<string|null>}
 */
async function resolveEngineScript(body, config) {
  if (typeof body.scriptText === 'string' && body.scriptText.trim()) {
    return body.scriptText;
  }
  if (typeof body.scriptPath !== 'string' || !body.scriptPath) return null;
  const scriptsRoots = (config.scriptsRoots && config.scriptsRoots.length > 0)
    ? config.scriptsRoots
    : defaultScriptsRoots();
  const target = normalize(resolveSafe(body.scriptPath));
  const allowed = scriptsRoots.some((root) => {
    const r = normalize(resolveSafe(root));
    return target === r || target.startsWith(r + sep);
  });
  if (!allowed) {
    const err = new Error('script path not in allowed scriptsRoots');
    err.code = 'PATH_ESCAPE';
    throw err;
  }
  return readFile(target, 'utf8');
}
function validateConfig(raw) {
  const out = {
    path: '/workflow',
    scriptsRoots: [],
    workspaceRoot: null,
    allowedModels: ['deepseek-chat'],
    workflowsDir: null,
    typecheck: { strict: true },
    // v0.9.0: sandbox defaults. The actual allow/deny lists live
    // in `lib/runtime.js` (DEFAULT_ENV_ALLOWLIST / DEFAULT_ENV_DENYLIST)
    // — we only carry the per-deploy override flags here. The
    // runtime falls back to its built-in defaults if these are
    // absent.
    sandbox: { enabled: true, allowlist: null, denylist: null },
    // v0.11.0: amend cache lifecycle defaults. `autoCloseOnWrite: false`
    // is a DEBUGGING aid (cache stays open all run) — it is unsafe for
    // workflows that mutate the workspace.
    amend: { autoCloseOnWrite: true, maxChainDepth: 10 },
    // v0.12.0: concurrency ceiling on in-flight agent.ask calls.
    concurrency: { maxConcurrent: 8 },
  };
  if (raw && typeof raw === 'object') {
    if (typeof raw.path === 'string' && raw.path.length > 0) {
      out.path = '/' + raw.path.replace(/^\/+|\/+$/g, '');
    }
    if (Array.isArray(raw.scriptsRoots)) {
      out.scriptsRoots = raw.scriptsRoots.filter((x) => typeof x === 'string' && x.length > 0);
    }
    if (typeof raw.workspaceRoot === 'string' && raw.workspaceRoot.length > 0) {
      out.workspaceRoot = raw.workspaceRoot;
    }
    if (Array.isArray(raw.allowedModels)) {
      const models = raw.allowedModels.filter((x) => typeof x === 'string' && x.length > 0);
      if (models.length > 0) out.allowedModels = models;
    }
    if (typeof raw.workflowsDir === 'string' && raw.workflowsDir.length > 0) {
      out.workflowsDir = raw.workflowsDir;
    }
    if (raw.typecheck && typeof raw.typecheck === 'object') {
      if (typeof raw.typecheck.strict === 'boolean') {
        out.typecheck.strict = raw.typecheck.strict;
      }
    }
    if (raw.amend && typeof raw.amend === 'object') {
      if (typeof raw.amend.autoCloseOnWrite === 'boolean') {
        out.amend.autoCloseOnWrite = raw.amend.autoCloseOnWrite;
      }
      if (typeof raw.amend.maxChainDepth === 'number' && raw.amend.maxChainDepth > 0) {
        out.amend.maxChainDepth = Math.min(Math.floor(raw.amend.maxChainDepth), 100);
      }
    }
    if (raw.concurrency && typeof raw.concurrency === 'object') {
      if (typeof raw.concurrency.maxConcurrent === 'number' && raw.concurrency.maxConcurrent > 0) {
        out.concurrency.maxConcurrent = Math.min(Math.floor(raw.concurrency.maxConcurrent), 256);
      }
    }
    if (raw.sandbox && typeof raw.sandbox === 'object') {
      if (typeof raw.sandbox.enabled === 'boolean') {
        out.sandbox.enabled = raw.sandbox.enabled;
      }
      if (Array.isArray(raw.sandbox.allowlist)) {
        out.sandbox.allowlist = raw.sandbox.allowlist.filter((x) => typeof x === 'string');
      }
      if (Array.isArray(raw.sandbox.denylist)) {
        out.sandbox.denylist = raw.sandbox.denylist.filter((x) => typeof x === 'string');
      }
    }
  }
  return out;
}

// The authoring contract. One file, two consumers: the skill system (for
// the user) and the brief tool (for the model, and the gate the workflow
// tools enforce).
const SKILL_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'skill', 'dynamic-workflows', 'SKILL.md');
let SKILL_CONTENT = '';
try {
  SKILL_CONTENT = readFileSync(SKILL_PATH, 'utf8');
} catch (err) {
  console.warn('[dsh-workflow-runner] the dynamic-workflows skill is missing:', String(err && err.message || err));
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
};

function sendJson(res, code, payload) {
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(payload));
}

function sendText(res, code, type, body) {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
}

/**
 * Read a file for a tool: inside the same scriptsRoots fence the editor
 * uses, so a tool cannot read outside the roots the user granted.
 *
 * @param {object} config
 * @param {string} scriptPath
 * @returns {Promise<string>}
 */
async function readWorkspaceFile(config, scriptPath) {
  const scriptsRoots = (config.scriptsRoots && config.scriptsRoots.length > 0)
    ? config.scriptsRoots
    : defaultScriptsRoots();
  const target = normalize(resolveSafe(scriptPath));
  const allowed = scriptsRoots.some((root) => {
    const r = normalize(resolveSafe(root));
    return target === r || target.startsWith(r + sep);
  });
  if (!allowed) throw new Error('script path not in allowed scriptsRoots');
  return readFile(target, 'utf8');
}

/**
 * Compile and run a snippet, and wait for it to settle.
 *
 * A snippet that does not compile is a report, not a run: the diagnostics
 * come straight back. A snippet that does compile runs like any other
 * workflow, with a timeout.
 *
 * @param {object} runtime
 * @param {{scriptText: string, timeoutMs?: number, workspaceRoot?: string}} opts
 * @returns {Promise<object>}
 */
async function evalSnippet(runtime, opts) {
  const scriptText = String(opts.scriptText || '');
  const compiled = compileWorkflow(scriptText);
  if (!compiled.ok) {
    return { ok: false, diagnostics: compiled.diagnostics, value: null };
  }
  const started = await runtime.startEngine({
    scriptText,
    name: 'snippet',
    ...(opts.workspaceRoot ? { workspaceRoot: opts.workspaceRoot } : {}),
  });
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 60_000;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = runtime.runs.get(started.runId);
    if (state && (state.status === 'completed' || state.status === 'error' || state.status === 'stopped')) {
      const settlement = state._engine && state._engine.settlement;
      return {
        ok: state.status === 'completed',
        status: state.status,
        diagnostics: compiled.diagnostics,
        value: settlement ? (settlement.artifact ?? null) : null,
        error: settlement && settlement.error ? settlement.error : null,
      };
    }
    if (Date.now() > deadline) {
      runtime.stop(started.runId);
      return { ok: false, status: 'stopped', diagnostics: compiled.diagnostics, value: null, error: { code: 'Timeout', message: `the snippet did not settle within ${timeoutMs}ms` } };
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

function apply(ctx, rawConfig) {
  const config = validateConfig(rawConfig);
  const routePath = config.path;
  const pubRoot = normalize(join(dirname(fileURLToPath(import.meta.url)), '..', 'public'));

  // bootstrap 文件按本插件包 install 后的实际路径解析（与 usage-dashboard 写法一致）
  const bootstrapAbs = join(dirname(fileURLToPath(import.meta.url)), 'runner-bootstrap.mjs');

  // The runtime is built FIRST, on purpose.
  //
  // The tool/skill/command registrations below close over it, and `const` is
  // in its temporal dead zone until this line runs — so a `runtime` declared
  // further down the function is a ReferenceError the moment the tool
  // registration reads it. Every real dsh profile provides ctx.inject and
  // ctx.effect, so that path is not an edge case; it is the normal one.
  //
  // It only needs ctx, bootstrapAbs and config, all of which are settled
  // above.
  const runtime = new WorkflowRuntime({
    ctx,
    bootstrapPath: bootstrapAbs,
    defaultModelsAllowed: config.allowedModels,
    // v0.8.0: per-deploy typecheck defaults from the Settings card.
    // Per-run override is `args.typecheck: false` on the start() payload.
    typecheck: config.typecheck || { strict: true },
    // v0.9.0: per-deploy sandbox defaults from the Settings card.
    // Per-run override is `args.sandbox` on the start() payload —
    // pass `false` to bypass, or an object with `allowlist` / `denylist`
    // to override the regex / allow lists.
    sandbox: config.sandbox || { enabled: true, allowlist: null, denylist: null },
    // v0.11.0: per-deploy amend cache lifecycle from the Settings card.
    amend: config.amend || { autoCloseOnWrite: true, maxChainDepth: 10 },
    // v0.12.0: per-deploy concurrency ceiling from the Settings card.
    concurrency: config.concurrency || { maxConcurrent: 8 },
    onLifecycle: ({ type, runId, status }) => {
      // 仅在 lifecycle 事件里打日志；详细事件走 subscribe + SSE
      if (type === 'status' && (status === 'error' || status === 'stopped')) {
        // console 写入 dsh 主进程 stdout；插件通常不直接用 console，但这里便于调试
        // eslint-disable-next-line no-console
        console.log('[dsh-workflow-runner] lifecycle', runId, status);
      }
    },
  });

  // The model-facing tools, and the skill they are gated on.
  //
  // Without these the plugin is something the USER drives through the
  // editor; with them it is something the MODEL can drive: author a
  // workflow, run it, watch it, answer what it asks, amend it, keep it.
  //
  // Both services are optional. A profile without the chat surface has no
  // tools service, and the plugin keeps working as a web route.
  if (typeof ctx.inject === 'function' && typeof ctx.effect === 'function') {
    const toolDeps = {
      runtime,
      startEngine: (opts) => runtime.startEngine(opts),
      injectStage: (runId, opts) => runtime.injectStage(runId, opts),
      answerQuestion: (runId, questionId, answer) => runtime.answerQuestion(runId, questionId, answer),
      listPendingHoles: (runId) => runtime.listPendingHoles(runId),
      fillHole: (runId, holeId, body) => runtime.fillHole(runId, holeId, body),
      listRuns: () => runtime.listRuns(),
      snapshot: (runId, opts) => runtime.snapshot(runId, opts),
      listSavedWorkflows: async () => listSavedWorkflows(resolveWorkflowsDir(config)),
      readSavedWorkflow: async (name) => {
        // A saved workflow, by name. The project scope is searched first,
        // then the global one, so a project can shadow a global.
        const dirs = [resolveWorkflowsDir(config), resolveGlobalWorkflowsDir(config)];
        const safe = String(name || '').replace(/[^A-Za-z0-9_.-]/g, '');
        if (!safe) throw new Error('a saved workflow needs a name');
        for (const dir of dirs) {
          const file = join(dir, safe + '.mjs');
          try {
            return await readFile(file, 'utf8');
          } catch (_) {
            /* try the next scope */
          }
        }
        throw new Error(`no saved workflow named '${safe}'`);
      },
      saveWorkflow: async (name, spec) => {
        // `scope` is REQUIRED and has no default (upstream's SaveWorkflow
        // makes the model choose). A workflow saved without saying where it
        // belongs is a workflow nobody will find again.
        const scope = spec.scope === 'global' ? 'global' : 'project';
        const dir = scope === 'global'
          ? resolveGlobalWorkflowsDir(config)
          : resolveWorkflowsDir(config);
        await fsPromises.mkdir(dir, { recursive: true });
        const source = renderSavedWorkflowSource(name, spec.script, spec.description, spec.whenToUse, spec.args);
        const file = join(dir, name + '.mjs');
        await fsPromises.writeFile(file, source, 'utf8');
        return { name, path: file, scope };
      },
      skillContent: () => SKILL_CONTENT,
      evalSnippet: (opts) => evalSnippet(runtime, opts),
      readWorkspaceFile: (scriptPath) => readWorkspaceFile(config, scriptPath),
      ...(config.workspaceRoot ? { defaultWorkspaceRoot: config.workspaceRoot } : {}),
    };

    ctx.inject(['tools'], (toolsCtx) => {
      ctx.effect(() => {
        const disposers = [];
        for (const tool of createWorkflowTools(toolDeps)) {
          try {
            disposers.push(toolsCtx.tools.register(tool));
          } catch (err) {
            console.warn('[dsh-workflow-runner] could not register the tool', tool.name + ':', String(err && err.message || err));
          }
        }
        return () => { for (const d of disposers) { try { d(); } catch (_) { /* already gone */ } } };
      });
    });

    ctx.inject(['skills'], (skillsCtx) => {
      ctx.effect(() => {
        if (!SKILL_CONTENT) return () => {};
        try {
          return skillsCtx.skills.register({
            name: 'dynamic-workflows',
            content: SKILL_CONTENT,
            invocation: { modelInvocable: true, userInvocable: true },
          });
        } catch (err) {
          console.warn('[dsh-workflow-runner] could not register the dynamic-workflows skill:', String(err && err.message || err));
          return () => {};
        }
      });
    });
  }

  // Slash command: /workflow [scriptPath]
  // Lazy-inject the host's `commands` service. Mirrors dsh-agent-teams'
  // pattern (lib/command.js) — when the `commands` service is available
  // (most web profiles), we register a closed-namespace `/workflow`
  // command. When it isn't (headless CLI without the chat surface), the
  // fiber never pends on it and the plugin keeps working as a web route.
  if (typeof ctx.inject === 'function' && typeof ctx.effect === 'function') {
    ctx.inject(['commands'], (cmdCtx) => {
      ctx.effect(() => {
        let registered = [];
        const baseUrl = routePath.endsWith('/') ? routePath : routePath + '/';
        const dispose = cmdCtx.commands.register({
          name: 'workflow',
          description: 'open the dsh-workflow-runner editor (optionally prefill a script path)',
          input: { hint: '[<absolute path to .mjs>]' },
          handler(invocation) {
            const arg = String((invocation && invocation.rawInput) || '').trim();
            const url = baseUrl + (arg ? '?scriptPath=' + encodeURIComponent(arg) : '');
            // The success text becomes a clickable row in dsh's chat result
            // view. Keep the URL explicit so the user can right-click → copy
            // even if their dsh build doesn't auto-linkify.
            return {
              kind: 'success',
              text: 'Workflow runner editor: ' + url,
            };
          },
        });
        registered.push(dispose);
        return () => {
          for (const d of registered) {
            try { d && d(); } catch (_) { /* unregister may not exist on this host */ }
          }
          registered = [];
        };
      }, 'dsh-workflow-runner: /workflow command');
    });
  }

  // v0.7.0: register the Settings → Plugins card via the host's settings
  // service. Requires @deepseek-ai/schemastery to be resolvable; if it
  // isn't, we silently skip the card (plugin still works fine, just
  // no in-Settings UI for config). The card namespace matches our
  // package name so the Plugins page can find it.
  if (Config && typeof ctx.inject === 'function') {
    ctx.inject(['settings'], (settingsCtx) => {
      try {
        const legacy = settingsCtx.settings && settingsCtx.settings.legacy;
        if (legacy && typeof legacy.installSection === 'function') {
          legacy.installSection(ctx, 'dsh-workflow-runner', Config, config, {
            setSource(source) {
              // User edited the card. Replace the live config and clear
              // any in-memory state that depends on the old values
              // (e.g. modelsAllowed affects new runs, not existing ones).
              Object.assign(config, source);
              if (Array.isArray(source.allowedModels)) {
                runtime.defaultModelsAllowed = source.allowedModels.slice();
              }
            },
            onChange: () => {
              // Cordis effects inside the section handle re-registration;
              // nothing else to do here.
            },
          });
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.log('[dsh-workflow-runner] settings card init failed:', err && err.message || err);
      }
    });
  }

  const readBody = (req) => new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    const LIMIT = 256 * 1024;
    req.on('data', (c) => {
      total += c.length;
      if (total > LIMIT) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: routePath,
    async handler(req, res) {
      let url;
      try {
        url = new URL(req.url || '/', 'http://x');
      } catch (_) {
        sendText(res, 400, 'text/plain; charset=utf-8', 'bad request'); return;
      }
      let rest;
      try { rest = decodeURIComponent(url.pathname); } catch (_) {
        sendText(res, 400, 'text/plain; charset=utf-8', 'bad request'); return;
      }
      rest = rest.slice(routePath.length);

      // gate: /api/* 的 Host/Origin 防护
      //
      // ctx.connection.requestRejection(req) 把两步合成一个返回值：
      //   403 = Host/Origin fence 判定为跨站或 DNS rebinding —— 必须拒绝；
      //   401 = fence 已通过，只是请求没带 dsh 的浏览器会话 cookie。
      //
      // 本插件的编辑页是自挂的 /workflow 静态页，dsh 的 authorizeIndex 只对根路径
      // "/" 下发会话 cookie，所以这个页面永远拿不到 cookie。若把 401 也当作拒绝，
      // 页面能打开但 Load / Run / Stop 全部 401（v0.1.5 的实际症状）。
      //
      // 会话 cookie 对本地进程本来也不构成权限边界：签名密钥就存在
      // $DSH_HOME/.credentials.yaml 里，本地进程能自行签发一个。真正挡住 drive-by
      // 的是 fence —— 跨站 Origin 与伪造 Host 都会被判 403。
      //
      // 因此：403 一律拒绝；401 放行（fence 已通过）。服务缺失或抛错仍然
      // fail closed 成 503，绝不静默放行。
      if (rest.startsWith('/api/') || rest === '/api') {
        let rejection;
        try {
          rejection = (ctx.connection && typeof ctx.connection.requestRejection === 'function')
            ? ctx.connection.requestRejection(req)
            : 503;
        } catch (_) {
          rejection = 503;
        }
        if (rejection !== undefined && rejection !== 401) {
          sendText(res, rejection, 'text/plain; charset=utf-8',
            rejection === 403 ? 'forbidden' : 'gate unavailable');
          return;
        }
      }

      // --- API routes ---
      if (rest === '/api/run' || rest === '/api/run/') {
        if (req.method !== 'POST') { sendText(res, 405, 'text/plain; charset=utf-8', 'method'); return; }
        try {
          const body = JSON.parse((await readBody(req)) || '{}');
          if (!body.scriptPath || typeof body.scriptPath !== 'string') {
            sendJson(res, 400, { error: 'scriptPath required' }); return;
          }
          // worldRunAllowlist: editor shows the user the list of commands
          // extracted from the script; whatever they approve comes here. Pass
          // through verbatim to the runtime; an empty array means "deny all"
          // (rare but well-defined).
          const allowlist = Array.isArray(body.worldRunAllowlist)
            ? body.worldRunAllowlist.filter((x) => typeof x === 'string')
            : undefined;
          // args: must be a plain JSON object, not array / scalar. Sanitized
          // again in the runtime, but reject obviously-bad shapes here.
          let args;
          if (body.args !== undefined) {
            if (!body.args || typeof body.args !== 'object' || Array.isArray(body.args)) {
              sendJson(res, 400, { error: 'args must be a plain JSON object' }); return;
            }
            args = body.args;
          }
          // workspaceRoot: optional override of the runtime's default
          // (dirname(scriptPath)). Must be an absolute path string.
          let workspaceRoot;
          if (body.workspaceRoot !== undefined) {
            if (typeof body.workspaceRoot !== 'string' || !body.workspaceRoot) {
              sendJson(res, 400, { error: 'workspaceRoot must be a non-empty string' }); return;
            }
            workspaceRoot = body.workspaceRoot;
          } else if (config.workspaceRoot) {
            workspaceRoot = config.workspaceRoot;
          }
          // modelsAllowed: optional per-run override of plugin config.
          let modelsAllowed;
          if (Array.isArray(body.modelsAllowed)) {
            modelsAllowed = body.modelsAllowed.filter((x) => typeof x === 'string' && x.length > 0);
          } else {
            modelsAllowed = config.allowedModels;
          }
          // v0.5.0: amendFrom — agent.ask and world.run look up identical
          // (name, prompt) / (cmd, args) in the previous run's journal
          // and replay cached results without re-running.
          const amendFrom = typeof body.amendFrom === 'string' && body.amendFrom
            ? body.amendFrom : null;
          // v0.8.0: per-run typecheck opt-out. Editor surfaces a
          // "Skip typecheck" button; this is the flag it sends.
          const typecheck = body.typecheck === false ? false : undefined;
          // v0.12.0: per-run concurrency ceiling override. Overrides the
          // per-deploy `Config.concurrency.maxConcurrent` for this run.
          const maxConcurrency = (typeof body.maxConcurrency === 'number' && body.maxConcurrency > 0)
            ? body.maxConcurrency
            : undefined;
          // v0.9.0: per-run sandbox override. `false` bypasses
          // scrubbing; an object with `allowlist` / `denylist` keys
          // overrides the per-deploy Config card.
          const sandbox = (body.sandbox === false)
            ? false
            : (body.sandbox && typeof body.sandbox === 'object'
                ? {
                    enabled: body.sandbox.enabled !== false,
                    allowlist: Array.isArray(body.sandbox.allowlist) ? body.sandbox.allowlist.filter((x) => typeof x === 'string') : undefined,
                    denylist: Array.isArray(body.sandbox.denylist) ? body.sandbox.denylist.filter((x) => typeof x === 'string') : undefined,
                  }
                : undefined);
          const out = await runtime.start({
            scriptPath: body.scriptPath,
            runId: body.runId,
            worldRunAllowlist: allowlist,
            args,
            workspaceRoot,
            modelsAllowed,
            amendFrom,
            typecheck,
            maxConcurrency,
            sandbox,
          });
          sendJson(res, 200, out);
        } catch (err) {
          // v0.8.0: structured TS errors get a 400 with diagnostics so
          // the editor can render the line+col inline; everything else
          // stays a plain 500.
          if (err && (err.code === 'TS_TYPECHECK' || err.code === 'TS_TYPECHECK_PRE')) {
            sendJson(res, 400, {
              error: String(err.message || err),
              code: err.code,
              diagnostics: Array.isArray(err.diagnostics) ? err.diagnostics : [],
            });
            return;
          }
          if (err && err.code === 'TS_TRANSPILE') {
            sendJson(res, 500, {
              error: String(err.message || err),
              code: err.code,
              diagnostics: Array.isArray(err.diagnostics) ? err.diagnostics : [],
            });
            return;
          }
          // v0.11.0: amend rejections are user-fixable, not server
          // faults — surface the code so the editor can say "edit the
          // script first" instead of showing a raw error.
          if (err && typeof err.code === 'string' && err.code.startsWith('AMEND_')) {
            sendJson(res, 400, { error: String(err.message || err), code: err.code });
            return;
          }
          sendJson(res, 500, { error: String(err && err.message || err) });
        }
        return;
      }
      // --- ZCode Dynamic Workflow engine path (v0.13.0) ---
      //
      // The engine path compiles a workflow BEFORE it runs it: the script
      // is statically analysed, lowered to site-tagged JS, and its typed
      // asks are turned into JSON Schemas. These two endpoints expose
      // that: /api/engine/compile answers "is this script sound, and what
      // shape is it?" without running anything, and /api/engine/run does
      // the run.
      if (rest === '/api/engine/compile' || rest === '/api/engine/compile/') {
        if (req.method !== 'POST') { sendText(res, 405, 'text/plain; charset=utf-8', 'method'); return; }
        try {
          const body = JSON.parse((await readBody(req)) || '{}');
          const scriptText = await resolveEngineScript(body, config);
          if (scriptText === null) { sendJson(res, 400, { error: 'scriptText or scriptPath required' }); return; }
          sendJson(res, 200, compileWorkflow(scriptText));
        } catch (err) {
          sendJson(res, 500, { error: String(err && err.message || err) });
        }
        return;
      }
      if (rest === '/api/engine/run' || rest === '/api/engine/run/') {
        if (req.method !== 'POST') { sendText(res, 405, 'text/plain; charset=utf-8', 'method'); return; }
        try {
          const body = JSON.parse((await readBody(req)) || '{}');
          const scriptText = await resolveEngineScript(body, config);
          if (scriptText === null) { sendJson(res, 400, { error: 'scriptText or scriptPath required' }); return; }
          const out = await runtime.startEngine({
            scriptText,
            runId: body.runId,
            name: body.name,
            args: body.args,
            workspaceRoot: body.workspaceRoot || config.workspaceRoot,
            modelsAllowed: Array.isArray(body.modelsAllowed) ? body.modelsAllowed : config.allowedModels,
            worldRunAllowlist: Array.isArray(body.worldRunAllowlist) ? body.worldRunAllowlist : undefined,
            maxConcurrency: body.maxConcurrency,
            timeoutMs: body.timeoutMs,
            sandbox: body.sandbox,
            // The amend-resume import: the new run inherits this run's
            // cached answers.
            ...(typeof body.resumeFrom === 'string' && body.resumeFrom.trim() !== ''
              ? { resumeFrom: body.resumeFrom.trim() }
              : {}),
          });
          sendJson(res, out.status === 'error' ? 400 : 200, out);
        } catch (err) {
          sendJson(res, 500, { error: String(err && err.message || err) });
        }
        return;
      }
      if (rest === '/api/amend' || rest === '/api/amend/') {
        // v0.10.0: structural amend — inject a new stage into a RUNNING
        // run. Mirrors the standalone server's /api/amend exactly; the
        // stage executes inside the live child so it inherits that run's
        // agents, allowlist, sandboxed env and workspace confinement.
        if (req.method !== 'POST') { sendText(res, 405, 'text/plain; charset=utf-8', 'method'); return; }
        try {
          const body = JSON.parse((await readBody(req)) || '{}');
          const runId = String((body && body.runId) || '').trim();
          if (!runId) { sendJson(res, 400, { error: 'runId required' }); return; }
          const out = await runtime.injectStage(runId, {
            name: body.name,
            code: typeof body.code === 'string' ? body.code : undefined,
            codePath: typeof body.codePath === 'string' ? body.codePath : undefined,
            context: body.context,
            timeoutMs: body.timeoutMs,
            wait: body.wait === true,
          });
          sendJson(res, 200, out);
        } catch (err) {
          // 409 = the run isn't in a state that can accept an amendment.
          const message = String(err && err.message || err);
          const conflict = /unknown run|is \w+ —|is \w+ -|live run|already exited|restored shell|snippet|cap reached|too many stages/.test(message);
          sendJson(res, conflict ? 409 : 400, { error: message });
        }
        return;
      }
      if (rest === '/api/amend/stages' || rest === '/api/amend/stages/') {
        const runId = url.searchParams.get('runId');
        if (!runId) { sendJson(res, 400, { error: 'runId query required' }); return; }
        sendJson(res, 200, { stages: runtime.listInjectedStages(runId) });
        return;
      }
      if (rest === '/api/stop' || rest === '/api/stop/') {
        if (req.method !== 'POST') { sendText(res, 405, 'text/plain; charset=utf-8', 'method'); return; }
        try {
          const body = JSON.parse((await readBody(req)) || '{}');
          if (!body.runId) { sendJson(res, 400, { error: 'runId required' }); return; }
          const ok = runtime.stop(body.runId);
          sendJson(res, ok ? 200 : 404, { ok });
        } catch (err) {
          sendJson(res, 500, { error: String(err && err.message || err) });
        }
        return;
      }
      if (rest === '/api/state' || rest === '/api/state/') {
        const runId = url.searchParams.get('runId');
        if (!runId) { sendJson(res, 400, { error: 'runId query required' }); return; }
        // v0.11.0: `includeJournal=1` inlines the replay trail.
        const includeJournal = url.searchParams.get('includeJournal') === '1'
          || url.searchParams.get('includeJournal') === 'true';
        const snap = runtime.snapshot(runId, {
          includeJournal,
          journalLimit: Number(url.searchParams.get('journalLimit')) || undefined,
        });
        if (!snap) { sendJson(res, 404, { error: 'no such run' }); return; }
        sendJson(res, 200, snap);
        return;
      }
      if (rest === '/api/journal' || rest === '/api/journal/') {
        // v0.11.0: journal replay trail — what actually ran vs what was
        // replayed from an ancestor run's journal.
        const runId = url.searchParams.get('runId');
        if (!runId) { sendJson(res, 400, { error: 'runId query required' }); return; }
        const out = runtime.journal(runId, {
          limit: Number(url.searchParams.get('limit')) || undefined,
          full: url.searchParams.get('full') === '1' || url.searchParams.get('full') === 'true',
        });
        if (!out) { sendJson(res, 404, { error: 'no such run' }); return; }
        sendJson(res, 200, out);
        return;
      }
      if (rest === '/api/list' || rest === '/api/list/') {
        sendJson(res, 200, { runs: runtime.listRuns() });
        return;
      }
      // The editor's three sample buttons read this hint to turn a relative
      // sample name into an absolute path. lib/standalone.js has always served
      // it, but plugin.js did not, so under dsh every sample button failed.
      if (rest === '/api/samples' || rest === '/api/samples/') {
        sendJson(res, 200, { samplesDir: join(dirname(fileURLToPath(import.meta.url)), '..', 'samples') });
        return;
      }
      if (rest === '/api/stream' || rest === '/api/stream/') {
        const runId = url.searchParams.get('runId');
        if (!runId) { sendJson(res, 400, { error: 'runId query required' }); return; }
        // SSE: text/event-stream + no-cache + no buffering
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store',
          'connection': 'keep-alive',
          'x-accel-buffering': 'no',
        });
        const sendEvent = (evt) => {
          try { res.write('data: ' + JSON.stringify(evt) + '\n\n'); } catch (_) { /* ignore */ }
        };
        const unsubscribe = runtime.subscribe(runId, sendEvent);
        const heartbeat = setInterval(() => {
          try { res.write(': hb\n\n'); } catch (_) { /* ignore */ }
        }, 15000);
        req.on('close', () => {
          clearInterval(heartbeat);
          unsubscribe();
        });
        return;
      }
      if (rest === '/api/script-content' || rest === '/api/script-content/') {
        if (req.method !== 'POST') { sendText(res, 405, 'text/plain; charset=utf-8', 'method'); return; }
        try {
          const body = JSON.parse((await readBody(req)) || '{}');
          if (!body.scriptPath || typeof body.scriptPath !== 'string') {
            sendJson(res, 400, { error: 'scriptPath required' }); return;
          }
          const scriptsRoots = (config.scriptsRoots && config.scriptsRoots.length > 0)
            ? config.scriptsRoots
            : defaultScriptsRoots();
          const target = normalize(resolveSafe(body.scriptPath));
          const allowed = scriptsRoots.some((root) => {
            const r = normalize(resolveSafe(root));
            return target === r || target.startsWith(r + sep);
          });
          if (!allowed) {
            sendJson(res, 403, { error: 'script path not in allowed scriptsRoots', target }); return;
          }
          const content = await readFile(target, 'utf8');
          sendJson(res, 200, { path: target, content });
        } catch (err) {
          sendJson(res, 500, { error: String(err && err.message || err) });
        }
        return;
      }
      if (rest === '/api/extract-commands' || rest === '/api/extract-commands/') {
        // GET so the editor can fire it the moment the user clicks Run, before
        // the POST that actually starts the run. Same scriptsRoots fence as
        // /api/script-content.
        try {
          const scriptPath = url.searchParams.get('scriptPath');
          if (!scriptPath) { sendJson(res, 400, { error: 'scriptPath query required' }); return; }
          const scriptsRoots = (config.scriptsRoots && config.scriptsRoots.length > 0)
            ? config.scriptsRoots
            : defaultScriptsRoots();
          const target = normalize(resolveSafe(scriptPath));
          const allowed = scriptsRoots.some((root) => {
            const r = normalize(resolveSafe(root));
            return target === r || target.startsWith(r + sep);
          });
          if (!allowed) {
            sendJson(res, 403, { error: 'script path not in allowed scriptsRoots', target }); return;
          }
          const content = await readFile(target, 'utf8');
          const commands = extractWorldRunCommands(content);
          sendJson(res, 200, { path: target, commands });
        } catch (err) {
          sendJson(res, 500, { error: String(err && err.message || err) });
        }
        return;
      }
      if (rest === '/api/artifact-content' || rest === '/api/artifact-content/') {
        // Serves the inline content of a published artifact (markdown or file).
        // Same auth/gate as the rest of /api/*; no scriptsRoots check needed
        // because the user is reading their own run's output.
        try {
          const runId = url.searchParams.get('runId');
          const id = url.searchParams.get('id');
          const versionStr = url.searchParams.get('version');
          if (!runId || !id) { sendJson(res, 400, { error: 'runId and id required' }); return; }
          const version = versionStr ? Math.max(1, parseInt(versionStr, 10) || 1) : null;
          const snap = runtime.snapshot(runId);
          if (!snap) { sendJson(res, 404, { error: 'no such run' }); return; }
          const art = (snap.artifacts || []).find((a) => a.id === id);
          if (!art) { sendJson(res, 404, { error: 'no such artifact' }); return; }
          const v = version ? art.versions.find((x) => x.version === version) : art.versions[art.versions.length - 1];
          if (!v) { sendJson(res, 404, { error: 'no such version' }); return; }
          sendText(res, 200, v.contentType || 'text/plain; charset=utf-8', v.content || '');
        } catch (err) {
          sendJson(res, 500, { error: String(err && err.message || err) });
        }
        return;
      }
      if (rest === '/api/models' || rest === '/api/models/') {
        // Lists the model ids a script may pass through model(). Editor uses
        // this to populate a dropdown when the user edits a script; scripts
        // themselves see the same list through globalThis.__dsh.model() and
        // get rejected by the runtime if they try a non-allowlisted one.
        sendJson(res, 200, { models: config.allowedModels });
        return;
      }
      if (rest === '/api/saved-workflows' || rest === '/api/saved-workflows/') {
        // List / save saved workflows. The directory is $DSH_HOME/workflows
        // by default; plugin Config can override via workflowsDir.
        if (req.method === 'GET') {
          try {
            const dir = resolveWorkflowsDir(config);
            await fsPromises.mkdir(dir, { recursive: true });
            const items = await listSavedWorkflows(dir);
            sendJson(res, 200, { workflows: items, dir });
          } catch (err) {
            sendJson(res, 500, { error: String(err && err.message || err) });
          }
          return;
        }
        if (req.method === 'POST') {
          try {
            const body = JSON.parse((await readBody(req)) || '{}');
            const name = String((body && body.name) || '').trim();
            const script = String((body && body.script) || '');
            const description = typeof body.description === 'string' ? body.description : null;
            const whenToUse = typeof body.whenToUse === 'string' ? body.whenToUse : null;
            const args = (body && body.args && typeof body.args === 'object') ? body.args : null;
            if (!/^[A-Za-z0-9_.-]{1,64}$/.test(name)) {
              sendJson(res, 400, { error: 'name must match /^[A-Za-z0-9_.-]{1,64}$/' });
              return;
            }
            if (!script.trim()) {
              sendJson(res, 400, { error: 'script is required' });
              return;
            }
            if (script.length > 256 * 1024) {
              sendJson(res, 400, { error: 'script exceeds 256KB cap' });
              return;
            }
            const dir = resolveWorkflowsDir(config);
            await fsPromises.mkdir(dir, { recursive: true });
            const filePath = join(dir, name + '.mjs');
            const fullSource = renderSavedWorkflowSource(name, script, description, whenToUse, args);
            await fsPromises.writeFile(filePath, fullSource, 'utf8');
            sendJson(res, 200, { ok: true, path: filePath, name });
          } catch (err) {
            sendJson(res, 500, { error: String(err && err.message || err) });
          }
          return;
        }
        sendText(res, 405, 'text/plain; charset=utf-8', 'method');
        return;
      }
      if (rest === '/api/saved-workflows/delete' || rest === '/api/saved-workflows/delete/') {
        if (req.method !== 'POST') { sendText(res, 405, 'text/plain; charset=utf-8', 'method'); return; }
        try {
          const body = JSON.parse((await readBody(req)) || '{}');
          const name = String((body && body.name) || '').trim();
          if (!/^[A-Za-z0-9_.-]{1,64}$/.test(name)) {
            sendJson(res, 400, { error: 'name must match /^[A-Za-z0-9_.-]{1,64}$/' });
            return;
          }
          const dir = resolveWorkflowsDir(config);
          const filePath = join(dir, name + '.mjs');
          // Refuse to delete anything outside the workflows dir.
          if (!filePath.startsWith(resolvePath(dir))) {
            sendJson(res, 403, { error: 'refusing to delete outside workflows dir' });
            return;
          }
          await fsPromises.unlink(filePath).catch((err) => {
            if (err && err.code !== 'ENOENT') throw err;
          });
          sendJson(res, 200, { ok: true, name });
        } catch (err) {
          sendJson(res, 500, { error: String(err && err.message || err) });
        }
        return;
      }
      if (rest === '/api/saved-workflows/content' || rest === '/api/saved-workflows/content/') {
        try {
          const name = url.searchParams.get('name');
          if (!name || !/^[A-Za-z0-9_.-]{1,64}$/.test(name)) {
            sendJson(res, 400, { error: 'name query required (matches /^[A-Za-z0-9_.-]{1,64}$/)' });
            return;
          }
          const dir = resolveWorkflowsDir(config);
          const filePath = join(dir, name + '.mjs');
          if (!filePath.startsWith(resolvePath(dir))) {
            sendJson(res, 403, { error: 'refusing to read outside workflows dir' });
            return;
          }
          const content = await readFile(filePath, 'utf8');
          const meta = parseFrontmatter(content) || {};
          // Strip the frontmatter when sending the script body; the editor
          // will prepend a new one on save.
          const stripped = content.replace(/^\s*\/\*\*[\s\S]*?\*\/\s*/, '');
          sendJson(res, 200, { name, path: filePath, content: stripped, meta });
        } catch (err) {
          if (err && err.code === 'ENOENT') {
            sendJson(res, 404, { error: 'no such saved workflow' });
            return;
          }
          sendJson(res, 500, { error: String(err && err.message || err) });
        }
        return;
      }
      if (rest === '/api/eval' || rest === '/api/eval/') {
        // EvalWorkflowSnippet. Spawn a Node child with the bootstrap in
        // snippet mode, run synchronously, return the result + log.
        if (req.method !== 'POST') { sendText(res, 405, 'text/plain; charset=utf-8', 'method'); return; }
        try {
          const body = JSON.parse((await readBody(req)) || '{}');
          const code = String((body && body.code) || '');
          if (!code.trim()) { sendJson(res, 400, { error: 'code is required' }); return; }
          if (code.length > 64 * 1024) { sendJson(res, 400, { error: 'code exceeds 64KB cap' }); return; }
          const args = (body && body.args && typeof body.args === 'object' && !Array.isArray(body.args))
            ? body.args : {};
          const timeoutMs = typeof body.timeoutMs === 'number' && body.timeoutMs > 0
            ? Math.min(body.timeoutMs, 600_000) : 60_000;
          const workspaceRoot = (typeof body.workspaceRoot === 'string' && body.workspaceRoot)
            ? body.workspaceRoot
            : (config.workspaceRoot || process.cwd());
          const evalRun = await runtime.start({
            scriptPath: join(fileURLToPath(import.meta.url), 'placeholder.mjs'),
            args,
            workspaceRoot,
            evalMode: true,
            evalCode: code,
            evalTimeoutMs: timeoutMs,
            worldRunAllowlist: Array.isArray(body.worldRunAllowlist) ? body.worldRunAllowlist : [],
          });
          // Poll until the run finishes, but never longer than timeoutMs + 5s
          const deadline = Date.now() + timeoutMs + 5000;
          let snap;
          while (Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 100));
            snap = runtime.snapshot(evalRun.runId);
            if (!snap) { sendJson(res, 500, { error: 'eval run disappeared' }); return; }
            if (snap.status === 'completed' || snap.status === 'error' || snap.status === 'stopped') break;
          }
          // Read the finished event from the log/journals? Easiest: read
          // the last "finished" or "error" notify from the runtime. The
          // notify payload isn't in snapshot; we just report status +
          // what we can: the last lines of log.
          const result = (snap && snap.status === 'completed')
            ? (snap.reports && snap.reports.length > 0 ? snap.reports[snap.reports.length - 1] : null)
            : null;
          sendJson(res, 200, {
            status: snap.status,
            log: snap.log.slice(-200),
            result,
            workspaceRoot,
          });
        } catch (err) {
          sendJson(res, 500, { error: String(err && err.message || err) });
        }
        return;
      }
      if (rest === '/api/question-answer' || rest === '/api/question-answer/') {
        if (req.method !== 'POST') { sendText(res, 405, 'text/plain; charset=utf-8', 'method'); return; }
        try {
          const body = JSON.parse((await readBody(req)) || '{}');
          const runId = String((body && body.runId) || '').trim();
          const questionId = String((body && body.questionId) || '').trim();
          if (!runId || !questionId) {
            sendJson(res, 400, { error: 'runId and questionId required' });
            return;
          }
          runtime.answerQuestion(runId, questionId, body.answer);
          sendJson(res, 200, { ok: true });
        } catch (err) {
          sendJson(res, 500, { error: String(err && err.message || err) });
        }
        return;
      }
      if (rest === '/api/hole-answer' || rest === '/api/hole-answer/') {
        // v0.5.0: respond to a parked hole<T>() with a body string (or
        // an error). The body is evaluated by the child as an
        // AsyncFunction over `ctx`.
        if (req.method !== 'POST') { sendText(res, 405, 'text/plain; charset=utf-8', 'method'); return; }
        try {
          const body = JSON.parse((await readBody(req)) || '{}');
          const runId = String((body && body.runId) || '').trim();
          const holeId = String((body && body.holeId) || '').trim();
          if (!runId || !holeId) {
            sendJson(res, 400, { error: 'runId and holeId required' });
            return;
          }
          if (body.error) {
            runtime.answerHole(runId, holeId, null, String(body.error));
          } else {
            runtime.answerHole(runId, holeId, String(body.body == null ? '' : body.body), null);
          }
          sendJson(res, 200, { ok: true });
        } catch (err) {
          sendJson(res, 500, { error: String(err && err.message || err) });
        }
        return;
      }
      if (rest === '/api/escalate-answer' || rest === '/api/escalate-answer/') {
        // v0.6.0: respond to a parked escalate() with a direct user answer
        // (text, option, or boolean). Mirrors /api/question-answer.
        if (req.method !== 'POST') { sendText(res, 405, 'text/plain; charset=utf-8', 'method'); return; }
        try {
          const body = JSON.parse((await readBody(req)) || '{}');
          const runId = String((body && body.runId) || '').trim();
          const escalateId = String((body && body.escalateId) || '').trim();
          if (!runId || !escalateId) {
            sendJson(res, 400, { error: 'runId and escalateId required' });
            return;
          }
          runtime.answerEscalate(runId, escalateId, body.answer);
          sendJson(res, 200, { ok: true });
        } catch (err) {
          sendJson(res, 500, { error: String(err && err.message || err) });
        }
        return;
      }
      if (rest === '/api/escalate-think' || rest === '/api/escalate-think/') {
        // v0.6.0: dispatch an LLM call to answer the parked escalate
        // (ZCode "main agent thinks" path). Host builds context from
        // the run's recent log + the question + options, calls the
        // first allowed model, uses its response as the answer.
        if (req.method !== 'POST') { sendText(res, 405, 'text/plain; charset=utf-8', 'method'); return; }
        try {
          const body = JSON.parse((await readBody(req)) || '{}');
          const runId = String((body && body.runId) || '').trim();
          const escalateId = String((body && body.escalateId) || '').trim();
          if (!runId || !escalateId) {
            sendJson(res, 400, { error: 'runId and escalateId required' });
            return;
          }
          // Fire-and-forget: the LLM dispatch is async; the answer
          // gets sent to the child via stdin when it lands. The HTTP
          // response just acknowledges the click.
          runtime.thinkEscalate(runId, escalateId).catch((err) => {
            // best-effort logging; the error is also surfaced to the
            // child via the RPC respond above.
            // eslint-disable-next-line no-console
            console.log('[dsh-workflow-runner] escalate-think failed:', err && err.message || err);
          });
          sendJson(res, 200, { ok: true });
        } catch (err) {
          sendJson(res, 500, { error: String(err && err.message || err) });
        }
        return;
      }
      if (rest === '/api/runs' || rest === '/api/runs/') {
        // v0.5.0: list every known run, including those loaded from disk.
        try {
          const runs = runtime.listAllRuns();
          sendJson(res, 200, { runs });
        } catch (err) {
          sendJson(res, 500, { error: String(err && err.message || err) });
        }
        return;
      }

      // --- static ---
      // Only the slash-less form redirects; `/workflow/` must fall through to
      // the index.html branch below. Previously both `''` and `'/'` redirected
      // to `routePath + '/'`, so `/workflow/` redirected to itself forever
      // (ERR_TOO_MANY_REDIRECTS) — and the browser-half button opens exactly
      // `/workflow/?from=dsh`, so the UI入口 was unreachable.
      if (rest === '') {
        res.writeHead(302, { location: routePath + '/' });
        res.end();
        return;
      }
      let path = rest.replace(/^\/+/, '');
      if (path === '' || path.endsWith('/')) path += 'index.html';
      const target = normalize(join(pubRoot, path));
      if (target !== pubRoot && !target.startsWith(pubRoot + sep)) {
        sendText(res, 403, 'text/plain; charset=utf-8', 'forbidden'); return;
      }
      try {
        const body = await readFile(target);
        sendText(res, 200, MIME[extname(target)] ?? 'application/octet-stream', body);
      } catch (_) {
        sendText(res, 404, 'text/plain; charset=utf-8', 'not found');
      }
    },
  }), 'dsh-workflow-runner: route');
}

function resolveSafe(p) {
  // normalize + resolve; rejected if contains null bytes
  if (typeof p !== 'string' || p.includes('\0')) throw new Error('bad path');
  return resolvePath(p);
}

// --- v0.4.0: saved-workflow helpers (frontmatter parse / render, list) ---

/**
 * Decide where saved workflow files live. Plugin Config can override via
 * workflowsDir; default = $DSH_HOME/workflows/. The dir is created on
 * first save / list.
 */
function resolveWorkflowsDir(config) {
  if (config && typeof config.workflowsDir === 'string' && config.workflowsDir) {
    return resolvePath(config.workflowsDir);
  }
  const home = process.env.DSH_HOME || process.env.HOME || process.env.USERPROFILE || '.';
  return resolvePath(join(home, 'workflows'));
}

/**
 * Where a `global`-scoped workflow lives.
 *
 * A global workflow is for every workspace, so it lives under the dsh home
 * rather than in the workspace. A `project`-scoped one lives in the
 * workspace's own directory (`resolveWorkflowsDir`).
 *
 * @param {object} config
 * @returns {string}
 */
function resolveGlobalWorkflowsDir(config) {
  if (config && typeof config.globalWorkflowsDir === 'string' && config.globalWorkflowsDir) {
    return resolvePath(config.globalWorkflowsDir);
  }
  const home = process.env.DSH_HOME || process.env.HOME || process.env.USERPROFILE || '.';
  return resolvePath(join(home, 'workflows', 'global'));
}

/**
 * Parse the JSDoc-style dsh-workflow frontmatter at the top of a saved
 * script. Returns { name, description, whenToUse, args } or null if no
 * frontmatter is present.
 */
function parseFrontmatter(source) {
  const m = source.match(/^\s*\/\*\*\s*dsh-workflow\s*([\s\S]*?)\*\//);
  if (!m) return null;
  const body = m[1];
  const result = { name: null, description: null, whenToUse: null, args: {} };
  const fieldRe = /@(\w+)\s+([^\n@]+)/g;
  let fm;
  while ((fm = fieldRe.exec(body)) !== null) {
    const key = fm[1];
    const val = fm[2].trim();
    if (key === 'name') result.name = val;
    else if (key === 'description') result.description = val;
    else if (key === 'whenToUse') result.whenToUse = val;
    else if (key === 'arg') {
      // @arg name {type=default} description
      const am = val.match(/^(\S+)\s+\{([^}]*)\}(.*)$/);
      if (am) {
        const argName = am[1];
        const typeStr = am[2].trim();
        const desc = am[3].trim();
        const tm = typeStr.match(/^(\w+)(?:=(.+))?$/);
        if (tm) {
          let def;
          if (tm[2] !== undefined) {
            try { def = JSON.parse(tm[2]); } catch (_) { def = tm[2]; }
          }
          result.args[argName] = { type: tm[1], default: def, description: desc };
        }
      }
    }
  }
  return result;
}

/**
 * Render a saved workflow file: frontmatter (JSDoc-style) + script body.
 * Round-trips through parseFrontmatter on read.
 */
function renderSavedWorkflowSource(name, script, description, whenToUse, args) {
  const argLines = [];
  if (args && typeof args === 'object') {
    for (const [an, av] of Object.entries(args)) {
      if (!av || typeof av !== 'object') continue;
      const t = String(av.type || 'string');
      const def = av.default !== undefined ? `=${JSON.stringify(av.default)}` : '';
      const desc = av.description ? ` ${av.description}` : '';
      argLines.push(` * @arg ${an} {${t}${def}}${desc}`);
    }
  }
  const desc = description ? ` * @description ${description}\n` : '';
  const when = whenToUse ? ` * @whenToUse ${whenToUse}\n` : '';
  const fm = [
    `/** dsh-workflow`,
    ` * @name ${name}`,
    desc,
    when,
    ...argLines,
    ` */`,
    '',
  ].filter(Boolean).join('\n');
  return fm + (script.startsWith("'use strict'") || script.startsWith('"use strict"')
    ? script
    : `'use strict';\n` + script);
}

/**
 * List saved workflows in `dir`. Returns an array of metadata objects.
 */
async function listSavedWorkflows(dir) {
  let entries;
  try { entries = await fsPromises.readdir(dir, { withFileTypes: true }); }
  catch (_) { return []; }
  const out = [];
  for (const ent of entries) {
    if (!ent.isFile() || !ent.name.endsWith('.mjs')) continue;
    const name = ent.name.slice(0, -'.mjs'.length);
    const full = join(dir, ent.name);
    let content = '';
    try { content = await readFile(full, 'utf8'); } catch (_) { continue; }
    const meta = parseFrontmatter(content) || {};
    out.push({
      name,
      description: meta.description,
      whenToUse: meta.whenToUse,
      args: meta.args || {},
      path: full,
      size: content.length,
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/**
 * Extract the literal first argument of every `world.run(...)` call in a
 * script source, deduped. Static analysis only — dynamic strings (template
 * literals with `${}`, variables) come through as the literal text up to the
 * first interpolation, which is "good enough" for the confirm modal: it lists
 * *what the script is clearly going to call*, and dynamic strings still appear
 * (so the user sees something like "node" and is not surprised). The runtime
 * is the safety net; this is the warning.
 */
function extractWorldRunCommands(source) {
  const re = /world\.run\s*\(\s*["']([^"']+)["']/g;
  const seen = new Set();
  let m;
  while ((m = re.exec(source)) !== null) seen.add(m[1]);
  return Array.from(seen);
}

function defaultScriptsRoots() {
  const homes = [];
  if (process.env.DSH_HOME) homes.push(join(process.env.DSH_HOME, 'workflows'));
  // 也把样本目录作为允许目录（plugin 安装后能放哪儿不可控；这里给一个最常见的 hint）
  // 注意：runtime 不直接强制限制 run 端，跑的时候仍可传任意路径；此限制仅作用于 editor 加载文本端。
  homes.push(join(dirname(fileURLToPath(import.meta.url)), '..', 'samples'));
  return homes;
}

// We deliberately omit `Config` from the export list. dsh's cordis loader
// v0.7.0: optionally export a `Config` schema if @deepseek-ai/schemastery
// is resolvable. dsh's cordis loader looks for a `Config` export to
// register a Settings → Plugins card; without schemastery we omit it
// and the card simply doesn't appear (matches dsh-pet's "no card" pattern).
//
// v0.8.0: added `typecheck.strict` (default true). When false, the
// runtime skips the `tsc --noEmit --strict` pre-flight on `.ts` scripts
// and only emits. The per-run escape hatch is `args.typecheck: false`
// on the /api/run payload.
//
// v0.9.0: added `sandbox.{enabled, allowlist, denylist}`. When enabled
// (default), the workflow child process has its env scrubbed via
// `lib/runtime.js`'s `_scrubChildEnv` — API keys, OAuth tokens, cloud
// creds, and DSH_HOME bookkeeping are stripped before spawn. The
// `allowlist` (extra keys to KEEP) and `denylist` (regex patterns of
// keys to STRIP, applied AFTER the allowlist) are user-tunable for
// workflows that need keys outside the default safe set.
/**
 * The Settings → Plugins card schema, built against dsh's schemastery.
 *
 * The API used here is the one @deepseek-ai/schemastery 3.18.x actually has,
 * and every part of it was checked against the real package rather than
 * assumed: the `z` namespace is the default export, a description is
 * `.description()`, an integer is `.step(1)`, and a field that may be null
 * and may be absent is `.default(null)`. An optional peer dep is exactly
 * where an assumption turns into a plugin that will not import.
 *
 * @param {object} z - the schemastery default export
 * @returns {object} the Config schema
 */
function buildConfigSchema(z) {
  return z.object({
    path: z.string().default('/workflow'),
    scriptsRoots: z.array(z.string()).default([]),
    workspaceRoot: z.string().default(null),
    allowedModels: z.array(z.string()).default(['deepseek-chat']),
    workflowsDir: z.string().default(null),
    typecheck: z.object({
      strict: z.boolean().default(true)
        .description('Run tsc --strict on .ts workflows before launching (type errors reject the run with diagnostics).'),
    }).default({ strict: true }),
    sandbox: z.object({
      enabled: z.boolean().default(true)
        .description('Strip API keys, OAuth tokens, cloud creds, and DSH bookkeeping from the workflow child env. Disable to pass full host env (legacy).'),
      allowlist: z.array(z.string()).default([])
        .description('Extra env keys to KEEP in the child, on top of DSH_WORKFLOW_*. Empty = use built-in defaults (PATH, HOME, LANG, …).'),
      denylist: z.array(z.string()).default([])
        .description('Regex patterns of env keys to STRIP, applied AFTER the allowlist. Empty = use built-in defaults (DEEPSEEK_*, AWS_*, NODE_OPTIONS, …).'),
    }).default({ enabled: true, allowlist: [], denylist: [] }),
    // v0.11.0: amend cache lifecycle. A run started with `amendFrom`
    // opens the ancestor journal for reuse; `autoCloseOnWrite` closes
    // that reuse the moment this run does something live, so a mutated
    // workspace can never be answered from a stale ancestor journal.
    amend: z.object({
      autoCloseOnWrite: z.boolean().default(true)
        .description('Close the amend cache after this run\'s first LIVE world.run — the one cacheable action that can leave the workspace changed and invalidate an ancestor\'s cached results. Live agent.ask calls do NOT close it: replaying a byte-identical prompt is safe and is the point of amend.'),
      maxChainDepth: z.number().default(10)
        .description('How many ancestors back an amend will search for a reusable journal entry. Guards against unbounded recursive chains.'),
    }).default({ autoCloseOnWrite: true, maxChainDepth: 10 }),
    // v0.12.0: how many `agent.ask` calls may be in flight at once in a
    // single run. The rest queue for a slot. Protects the provider from
    // a fan-out that opens 50 parallel chats.
    concurrency: z.object({
      maxConcurrent: z.number().step(1).min(1).max(256).default(8)
        .description('Per-run ceiling on simultaneous agent.ask calls. Extra asks queue for a slot instead of firing at once.'),
    }).default({ maxConcurrent: 8 }),
  });
}

// The card is a nicety; the plugin is the product. If the peer dep is absent,
// or present but shaped differently than we expect, the plugin still loads
// and still works — it just has no Settings card.
let Config;
try {
  Config = schemastery ? buildConfigSchema(schemastery) : undefined;
} catch (_) {
  Config = undefined;
}

// tolerates a missing Config (treats it as "no validation"), and we use
// validateConfig() inside apply() to sanitize whatever raw object dsh hands
// us. This keeps the plugin from needing to resolve @deepseek-ai/schemastery
// at module load, which dsh's bundled-bundle resolver can fail to do on
// fresh installs (the `failed to import` warning seen on v0.1.1/0.1.2).
export { apply, inject, name, Config, WorkflowRuntime };
