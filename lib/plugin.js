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
import { dirname, extname, join, normalize, resolve as resolvePath, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorkflowRuntime } from './runtime.js';

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
 * plugin is enabled). Two scalar fields, defaults are easy to keep here.
 *
 * @param {unknown} raw
 * @returns {{ path: string, scriptsRoots: string[] }}
 */
function validateConfig(raw) {
  const out = { path: '/workflow', scriptsRoots: [] };
  if (raw && typeof raw === 'object') {
    if (typeof raw.path === 'string' && raw.path.length > 0) {
      out.path = '/' + raw.path.replace(/^\/+|\/+$/g, '');
    }
    if (Array.isArray(raw.scriptsRoots)) {
      out.scriptsRoots = raw.scriptsRoots.filter((x) => typeof x === 'string' && x.length > 0);
    }
  }
  return out;
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

function apply(ctx, rawConfig) {
  const config = validateConfig(rawConfig);
  const routePath = config.path;
  const pubRoot = normalize(join(dirname(fileURLToPath(import.meta.url)), '..', 'public'));

  // bootstrap 文件按本插件包 install 后的实际路径解析（与 usage-dashboard 写法一致）
  const bootstrapAbs = join(dirname(fileURLToPath(import.meta.url)), 'runner-bootstrap.mjs');

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

  const runtime = new WorkflowRuntime({
    ctx,
    bootstrapPath: bootstrapAbs,
    onLifecycle: ({ type, runId, status }) => {
      // 仅在 lifecycle 事件里打日志；详细事件走 subscribe + SSE
      if (type === 'status' && (status === 'error' || status === 'stopped')) {
        // console 写入 dsh 主进程 stdout；插件通常不直接用 console，但这里便于调试
        // eslint-disable-next-line no-console
        console.log('[dsh-workflow-runner] lifecycle', runId, status);
      }
    },
  });

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

      // gate: 仅对 /api/* 强制鉴权
      // The real service API is `ctx.connection.requestRejection(req)`, which
      // returns 401/403 (a number) or undefined when admitted — there is no
      // `connection.gate`. It is synchronous and may throw, so both outcomes
      // are handled explicitly and we FAIL CLOSED: an unusable gate answers
      // 503 instead of silently admitting a caller who could then run arbitrary
      // scripts and shell commands through /api/run.
      if (rest.startsWith('/api/') || rest === '/api') {
        let rejection;
        try {
          if (ctx.connection && typeof ctx.connection.requestRejection === 'function') {
            rejection = ctx.connection.requestRejection(req);
          } else {
            rejection = 503;
          }
        } catch (_) {
          rejection = 503;
        }
        if (rejection !== undefined) {
          sendText(res, rejection, 'text/plain; charset=utf-8',
            rejection === 401 ? 'unauthorized' : rejection === 403 ? 'forbidden' : 'gate unavailable');
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
          const out = runtime.start({ scriptPath: body.scriptPath, runId: body.runId });
          sendJson(res, 200, out);
        } catch (err) {
          sendJson(res, 500, { error: String(err && err.message || err) });
        }
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
        const snap = runtime.snapshot(runId);
        if (!snap) { sendJson(res, 404, { error: 'no such run' }); return; }
        sendJson(res, 200, snap);
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

function defaultScriptsRoots() {
  const homes = [];
  if (process.env.DSH_HOME) homes.push(join(process.env.DSH_HOME, 'workflows'));
  // 也把样本目录作为允许目录（plugin 安装后能放哪儿不可控；这里给一个最常见的 hint）
  // 注意：runtime 不直接强制限制 run 端，跑的时候仍可传任意路径；此限制仅作用于 editor 加载文本端。
  homes.push(join(dirname(fileURLToPath(import.meta.url)), '..', 'samples'));
  return homes;
}

// We deliberately omit `Config` from the export list. dsh's cordis loader
// tolerates a missing Config (treats it as "no validation"), and we use
// validateConfig() inside apply() to sanitize whatever raw object dsh hands
// us. This keeps the plugin from needing to resolve @deepseek-ai/schemastery
// at module load, which dsh's bundled-bundle resolver can fail to do on
// fresh installs (the `failed to import` warning seen on v0.1.1/0.1.2).
export { apply, inject, name, WorkflowRuntime };
