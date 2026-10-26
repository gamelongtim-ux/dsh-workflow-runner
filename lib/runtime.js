// dsh-workflow-runner —— WorkflowRuntime。
//
// 宿主侧的运行时中枢：
//   - 维护活跃运行集合（runId → RunState）
//   - 为每个 run spawn 一个 Node 子进程跑 lib/runner-bootstrap.mjs
//   - 解析子进程 stdio 上的 JSON-RPC 与 notify
//   - 处理子进程发来的方法调用（agent.ask / world.run / phase / log / report）并回送响应
//   - 管理 per-(runId, name) 的 LLM 会话历史
//   - 维护订阅者集合，给 SSE handler 用
//
// 双向协议：
//
//   child → host (stdout): {"id":N,"method":"...","params":{...}}     child 请求宿主
//   host → child (stdin):  {"id":N,"result":<v>}|{"id":N,"error":{...}} 宿主响应子进程
//   child → host (stdout): {"notify":"ready|started|finished|error",...} 子进程通知
//   （当前宿主不主动发起 RPC；保留双向能力留作扩展）
//
'use strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, basename, join, relative, resolve as resolvePath, isAbsolute, sep as PATH_SEP } from 'node:path';
import { readdir, readFile, stat, writeFile, rename, unlink, mkdir as fsPromisesMkdir, rm as fsPromisesRm } from 'node:fs/promises';
import { readdirSync, readFileSync, existsSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { chat } from './llm.js';
import { createSemaphore } from './semaphore.js';
import { runDwfWorkflow, projectWorkflowGraphs, prepareWorkflow, collectPreparedDiagnostics } from './dwf/index.js';
import { inputHash } from './dwf/engine.js';
import { buildImportedCache } from './dwf/imported-cache.js';
import { DurableJournalStore } from './dwf/durable-journal.js';
import { createDwfServices, createDwfJournal, mapEngineEvent } from './dwf/host.js';

const RUN_TIMEOUT_MS = 30 * 60 * 1000;       // 子进程 watchdog
const ASK_TIMEOUT_MS = 5 * 60 * 1000;        // 单次 chat 完成超时
const SHELL_TIMEOUT_MS = 10 * 60 * 1000;     // world.run 默认超时
const FILES_GLOB_CAP = 2000;                 // files.glob / files.grep 上限
const FILES_READ_CAP = 256 * 1024;           // files.read 字节上限
const FILES_GREP_RESULTS_CAP = 256 * 1024;   // files.grep 累计结果字节上限
const GIT_DIFF_CAP = 512 * 1024;             // git diff 字节上限
const GIT_LOG_DEFAULT = 20;
const GIT_LOG_MAX = 100;
const QUESTION_TIMEOUT_MS = 5 * 60 * 1000;   // askUser 无回超时
const HOLE_TIMEOUT_MS = 10 * 60 * 1000;      // hole<T> 无回超时(比 ask 长,因为 user 要写代码)
const TYPED_ASK_RETRY = 1;                   // ask<T> 失败重试次数
const PERSIST_DEBOUNCE_MS = 500;             // 写盘 debounce
const PERSIST_DIR = resolveRunsDir();         // $DSH_HOME/runs/ or ~/.dsh/runs/

// v0.10.0: structural amend. A host-injected stage runs inside the
// already-running child, so it inherits that child's sandboxed env and
// facade — the caps below are the only new ceiling it operates under.
const STAGE_MAX_BODY = 64 * 1024;            // injected body byte cap
const STAGE_MAX_PER_RUN = 32;                // total stages per run
const STAGE_MAX_INFLIGHT = 4;                // concurrently executing stages
const STAGE_MAX_WAIT_MS = 5 * 60 * 1000;     // host-side wait:true ceiling

// v0.11.0: amend cache lifecycle. The cache is only open for a run
// started with `amendFrom`, and closes on the first live action.
const DEFAULT_AMEND_MAX_CHAIN = 10;          // ancestors to search
const JOURNAL_MAX_ENTRIES = 5000;            // hard cap on journal length
const WORLD_RUN_OUTPUT_CAP = 1024 * 1024;    // 1 MiB per stdout / stderr
const ARTIFACT_FILE_CAP = 20 * 1024 * 1024; // artifact.file byte cap

// v0.12.0: concurrency ceiling on in-flight agent.ask calls.
const DEFAULT_MAX_CONCURRENT = 8;

function normalizeConcurrency(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 1) return DEFAULT_MAX_CONCURRENT;
  return Math.min(Math.floor(v), 256);
}

// v0.9.0: env scrubbing for the child process. The workflow child
// shouldn't see the host's API keys, OAuth tokens, cloud
// credentials, or DSH_HOME bookkeeping. The default allowlist
// preserves the toolchain-essential keys (PATH, HOME, LANG, …) and
// the host's own DSH_WORKFLOW_* handoff vars. The default denylist
// matches common API-key / token / loader-hijack patterns. Users
// can extend either via the `Config.sandbox` card.
//
// Anything that starts with `DSH_WORKFLOW_` is also auto-allowed
// regardless of these lists — that's the host→child handoff channel.
const DEFAULT_ENV_ALLOWLIST = Object.freeze([
  // POSIX / Windows toolchain paths
  'PATH', 'Path',
  'HOME', 'USERPROFILE',
  'TEMP', 'TMP', 'TMPDIR',
  // Locale / encoding
  'LANG', 'LC_ALL', 'LANGUAGE', 'TZ',
  'LC_CTYPE', 'LC_MESSAGES', 'LC_NUMERIC', 'LC_TIME', 'LC_COLLATE', 'LC_MONETARY', 'LC_PAPER', 'LC_NAME',
  // Node / npm
  'NODE_ENV', 'NODE_PATH',
  // User identity (no secrets)
  'USER', 'USERNAME', 'LOGNAME', 'HOME',
  // Terminal / shell
  'SHELL', 'TERM', 'COLORTERM', 'FORCE_COLOR', 'NO_COLOR',
  'HOSTNAME', 'COMPUTERNAME',
  // Misc but commonly needed
  'PAGER', 'EDITOR', 'VISUAL', 'LANG',
]);

// Regex patterns (case-insensitive) of env keys to STRIP. The host
// process's API keys, OAuth tokens, cloud creds, dynamic-linker
// injection vectors, and the host's own DSH bookkeeping must not
// reach the workflow child.
const DEFAULT_ENV_DENYLIST = Object.freeze([
  // LLM provider keys
  '^DEEPSEEK_.+',
  '^OPENAI_.+',
  '^ANTHROPIC_.+',
  '^GOOGLE_.+',
  '^VERTEX_.+',
  '^HUGGING.+',
  '^REPLICATE_.+',
  '^STABILITY_.+',
  '^MISTRAL_.+',
  '^COHERE_.+',
  '^GROQ_.+',
  '^XAI_.+',
  '^OPENROUTER_.+',
  '^TOGETHER_.+',
  '^FIREWORKS_.+',
  // Cloud creds
  '^AWS_.+',
  '^AZURE_.+',
  '^GCP_.+',
  '^GOOGLE_APPLICATION_CREDENTIALS$',
  // VCS tokens
  '^GITHUB_.+',
  '^GH_.+',
  '^GL_TOKEN$',
  '^GLAB_.+',
  '^GITLAB_.+',
  // NPM / package manager tokens
  '^NPM_.+TOKEN$',
  '^NODE_AUTH_.+',
  // DSH internal — host bookkeeping the child doesn't need
  '^DSH_HOME$',
  '^DSH_API_KEY$',
  '^DSH_PROFILE_KEY$',
  '^DSH_AUTH_TOKEN$',
  '^DSH_PROXY_.+',
  // Dynamic-linker / Node injection vectors
  '^NODE_OPTIONS$',
  '^NODE_EXTRA_CA_CERTS$',
  // POSIX / macOS dynamic-linker hijack
  '^LD_PRELOAD$',
  '^LD_LIBRARY_PATH$',
  '^DYLD_INSERT_LIBRARIES$',
  // Generic catch-all for anything obviously credential-like that
  // the allowlist might miss.
  '.+_TOKEN$',
  '.+_SECRET$',
  '.+_API_KEY$',
]);

/**
 * Resolve the on-disk run history directory. Matches the style of
 * `resolveWorkflowsDir` in plugin.js: prefer $DSH_HOME/runs, then
 * ~/.dsh/runs, then a tmp-style fallback. We run this once at module
 * load so persistence callsites can `import` the constant.
 */
function resolveRunsDir() {
  if (process.env.DSH_HOME && process.env.DSH_HOME.length > 0) {
    return join(process.env.DSH_HOME, 'runs');
  }
  const home = process.env.HOME || process.env.USERPROFILE || '.';
  return join(home, '.dsh', 'runs');
}

/**
 * Splice a hole's body into the script text, as the hole call's fourth
 * argument.
 *
 * A hole is written `hole<T>("name", "prompt")`. A FILLED hole is written
 * `hole<T>("name", "prompt", async () => { ... })` — the body is inline in
 * the source, and the compiler's lowering pass extracts it into
 * `holeBodies[siteId]`. That inline shape is why a fill has to recompile:
 * the engine's "valid script" is the recompiled text, and its spec table
 * describes THAT script.
 *
 * The splice is by source position, not by string replacement: the hole's
 * name is a literal in the call, and the call is found by scanning for it.
 * Replacing the name's text instead would corrupt any other occurrence of
 * the same string.
 *
 * @param {string} scriptText
 * @param {string} holeName - the hole's name (its phase name)
 * @param {string} body - the body source
 * @returns {{ok: true, text: string}|{ok: false, reason: string}}
 */
function spliceHoleBody(scriptText, holeName, body) {
  const needle = JSON.stringify(holeName);
  // The hole call: `hole<...>(` then the name as a string literal, then
  // either `)` (nothing after the name) or `,` (a prompt follows).
  const pattern = new RegExp(`(hole\\s*<[^>]*>\\s*\\(\\s*${needle})(\\s*[,)])`, 'g');
  const match = pattern.exec(scriptText);
  if (match === null) {
    return {
      ok: false,
      reason: `the script has no hole named '${holeName}'`,
    };
  }
  const tail = match[2];
  if (tail === ',') {
    // There is already a third argument (the prompt). The body goes after it.
    const afterName = match.index + match[1].length;
    const close = scriptText.indexOf(')', afterName);
    if (close < 0) return { ok: false, reason: `the hole '${holeName}' is malformed` };
    const text = `${scriptText.slice(0, close)}, ${body}${scriptText.slice(close)}`;
    return { ok: true, text };
  }
  // Only the name so far: the body becomes the third argument.
  const insertAt = match.index + match[1].length;
  const text = `${scriptText.slice(0, insertAt)}, ${body}${scriptText.slice(insertAt)}`;
  return { ok: true, text };
}

  /**
   * @param {object} [opts]
   * @param {object} [opts.ctx] - cordis 插件上下文（注入 llm service 用于解析 baseURL）
   * @param {string} [opts.bootstrapPath] - 默认本目录下 runner-bootstrap.mjs
   * @param {string} [opts.nodeBin] - 默认当前进程 execPath
   * @param {string[]} [opts.defaultModelsAllowed] - 默认允许的 model id 列表;空则用 ['deepseek-chat']
   * @param {{onLifecycle?: Function}} [opts]
   */
  /**
 * Resolve a path to its real location, tolerating a missing tail.
 *
 * The path being checked may not exist yet (a file the workflow is about to
 * read, a directory it is about to create), so the deepest EXISTING ancestor
 * is resolved and the missing tail re-attached. Returns null when nothing
 * along the path exists.
 *
 * @param {string} abs
 * @returns {string|null}
 */
function realpathOfNearestExisting(abs) {
  const tail = [];
  let dir = abs;
  for (;;) {
    try {
      const real = realpathSync(dir);
      return tail.length === 0 ? real : join(real, ...tail);
    } catch (_) {
      const parent = dirname(dir);
      if (parent === dir) return null;
      tail.unshift(basename(dir));
      dir = parent;
    }
  }
}

export class WorkflowRuntime {
  constructor(opts = {}) {
    this.ctx = opts.ctx || null;
    this.bootstrapPath = opts.bootstrapPath || null;
    this.nodeBin = opts.nodeBin || process.execPath;
    // v0.13.0: the model call is injectable so the engine path can be
    // exercised offline. Defaults to the real DeepSeek client.
    this.chat = opts.chat || chat;
    this.onLifecycle = (opts && opts.onLifecycle) || null;
    this.runs = new Map();
    this.scriptsRoot = (opts && opts.scriptsRoot) || null; // allowed roots for scriptPath
    this.defaultModelsAllowed = (opts && Array.isArray(opts.defaultModelsAllowed) && opts.defaultModelsAllowed.length > 0)
      ? opts.defaultModelsAllowed.slice()
      : ['deepseek-chat'];
    // v0.8.0: per-deploy typecheck defaults. Plugin.js wires this
    // from the Config card (Settings → Plugins). Per-run override
    // is via `args.typecheck: false` on the start() payload.
    this.typecheck = (opts && opts.typecheck && typeof opts.typecheck === 'object')
      ? { strict: opts.typecheck.strict !== false }
      : { strict: true };
    // v0.9.0: per-deploy sandbox defaults. Plugin.js wires this
    // from the Config card (Settings → Plugins). Per-run override
    // is via `args.sandbox` on the start() payload.
    this.sandbox = (opts && opts.sandbox && typeof opts.sandbox === 'object')
      ? {
          enabled: opts.sandbox.enabled !== false,
          allowlist: Array.isArray(opts.sandbox.allowlist) ? opts.sandbox.allowlist.slice() : DEFAULT_ENV_ALLOWLIST.slice(),
          denylist: Array.isArray(opts.sandbox.denylist) ? opts.sandbox.denylist.slice() : DEFAULT_ENV_DENYLIST.slice(),
        }
      : {
          enabled: true,
          allowlist: DEFAULT_ENV_ALLOWLIST.slice(),
          denylist: DEFAULT_ENV_DENYLIST.slice(),
        };
    // v0.11.0: amend cache lifecycle config. `autoCloseOnWrite` off is a
    // debugging aid — the cache then stays open for the whole run, which
    // is useful when you want to see every replay hit but is NOT safe if
    // the run mutates the workspace. `maxChainDepth` bounds how far back
    // an amend will look for a reusable journal entry.
    this.amend = (opts && opts.amend && typeof opts.amend === 'object')
      ? {
          autoCloseOnWrite: opts.amend.autoCloseOnWrite !== false,
          maxChainDepth: (typeof opts.amend.maxChainDepth === 'number' && opts.amend.maxChainDepth > 0)
            ? Math.min(Math.floor(opts.amend.maxChainDepth), 100)
            : DEFAULT_AMEND_MAX_CHAIN,
        }
      : { autoCloseOnWrite: true, maxChainDepth: DEFAULT_AMEND_MAX_CHAIN };
    // v0.12.0: per-run concurrency ceiling. `maxConcurrent` is the number
    // of `agent.ask` calls allowed in flight at once; the rest queue.
    // Per-run override is `args.maxConcurrency` on the start() payload.
    this.concurrency = (opts && opts.concurrency && typeof opts.concurrency === 'object')
      ? { maxConcurrent: normalizeConcurrency(opts.concurrency.maxConcurrent) }
      : { maxConcurrent: DEFAULT_MAX_CONCURRENT };
    // v0.5.0: per-run debounce timer for the on-disk write.
    this._persistTimers = new Map(); // runId -> Timeout
    // The live engines of the runs in flight, for the control plane:
    // filling a hole, changing the concurrency ceiling. The harness binds
    // the engine here once it has built it.
    this._engineControls = new Map(); // runId -> WorkflowEngine
    this._persistDir = (opts && opts.persistDir) || PERSIST_DIR;
    // The engine's durable journal. One store for the whole process, so a
    // run's rows survive a host restart: the engine's journal is the truth
    // for replay, resume and the amend-resume import cache.
    this._engineJournalStore = new DurableJournalStore({
      dir: join(this._persistDir, 'engine-journal'),
    });
    // The journal's write-through is debounced, so a process that exits
    // between two flushes would lose the last rows. Flushing on exit
    // closes that window — and `exit` is the hook that runs for a normal
    // shutdown as well as for an uncaught exception.
    const flushJournal = () => {
      try { this._engineJournalStore.flushAll(); } catch (_) { /* best-effort */ }
    };
    process.once('exit', flushJournal);
    process.once('SIGINT', () => { flushJournal(); });
    process.once('SIGTERM', () => { flushJournal(); });
    // v0.5.0: on startup, load any prior runs from disk so amend-from and
    // the /api/runs list can reference them after a dsh restart. Use
    // setImmediate to push the work off the constructor's call stack so
    // the private-method binding is fully resolved first.
    setImmediate(() => { try { this.#loadPersistedRuns(); } catch (_) { /* best-effort */ } });
  }

  /**
   * Start a workflow run.
   * @param {{
   *   scriptPath: string,
   *   runId?: string,
   *   worldRunAllowlist?: string[],
   *   args?: object,
   *   workspaceRoot?: string,
   *   modelsAllowed?: string[],
   *   evalMode?: boolean,
   *   evalCode?: string,
   *   evalTimeoutMs?: number,
   *   amendFrom?: string,
   * }} args
   * @returns {Promise<{runId:string, status:'starting'}>}
   */
  async start(args) {
    const runId = args.runId || randomUUID();
    let absScript = resolvePath(args.scriptPath);
    if (!this.#isScriptAllowed(absScript)) {
      throw new Error('script path not allowed: ' + absScript);
    }

    // v0.7.1: TypeScript transpile. If the script ends in `.ts`, compile
    // it to a sibling `.mjs` in a per-run tmp dir and use that as the
    // actual child entry point. The cleanup callback is stashed on the
    // run state so #setStatus can rm the dir on terminal states.
    //
    // We keep `originalScriptPath` pointing at the user's .ts file so
    // the /api/runs UI can show the entry they actually wrote, even
    // after the tmpDir is cleaned up at run completion.
    const originalScriptPath = absScript;
    let _transpileCleanup = null;
    if (absScript.toLowerCase().endsWith('.ts')) {
      // v0.8.0: typecheck pass runs first so a script with type errors
      // never reaches the emit step. `_typecheckTs` throws
      // `code: 'TS_TYPECHECK'` with a parsed `diagnostics` array; we
      // re-wrap so the HTTP handler can surface the structured form.
      //
      // The flag is opt-out via `args.typecheck === false` (per-run
      // escape hatch) or via the Config card (per-deploy default).
      const typecheckEnabled = args.typecheck !== false
        && !(this.typecheck && this.typecheck.strict === false);
      if (typecheckEnabled) {
        try {
          await this._typecheckTs(absScript);
        } catch (err) {
          if (err && err.code === 'TS_TYPECHECK') {
            throw err;  // pass through with diagnostics intact
          }
          const wrapped = new Error(
            `TypeScript typecheck failed for ${absScript}: ${String(err && err.message || err)}`
          );
          wrapped.code = err && err.code || 'TS_TYPECHECK_PRE';
          wrapped.cause = err;
          throw wrapped;
        }
      }
      try {
        const out = await this._transpileTs(absScript);
        absScript = out.absJsPath;
        _transpileCleanup = out.cleanup;
      } catch (err) {
        const wrapped = new Error(
          `TypeScript transpile failed for ${absScript}: ${String(err && err.message || err)}`
        );
        wrapped.code = err && err.code || 'TS_TRANSPILE';
        wrapped.diagnostics = err && err.diagnostics || undefined;
        wrapped.cause = err;
        throw wrapped;
      }
    }
    
    const bootstrapAbs = this.bootstrapPath
      ? resolvePath(this.bootstrapPath)
      // dirname(), NOT resolvePath(file, 'x') — the latter treats
      // runtime.js as a DIRECTORY and yields `.../runtime.js/runner-
      // bootstrap.mjs`, i.e. MODULE_NOT_FOUND. Every caller in this
      // package passes bootstrapPath explicitly, so the default was
      // never exercised until v0.11.0's tests constructed a runtime
      // directly.
      : join(dirname(fileURLToPath(import.meta.url)), 'runner-bootstrap.mjs');

    // workspaceRoot: user-supplied > runtime default = dirname(scriptPath)
    const workspaceRoot = args.workspaceRoot
      ? resolvePath(args.workspaceRoot)
      : dirname(absScript);

    // modelsAllowed: user-supplied > runtime default = ['deepseek-chat']
    const modelsAllowed = Array.isArray(args.modelsAllowed) && args.modelsAllowed.length > 0
      ? args.modelsAllowed.slice()
      : (Array.isArray(this.defaultModelsAllowed) && this.defaultModelsAllowed.length > 0
          ? this.defaultModelsAllowed.slice()
          : ['deepseek-chat']);

    // args: passed through verbatim; sanitized again in the child.
    const safeArgs = (args.args && typeof args.args === 'object' && !Array.isArray(args.args))
      ? args.args
      : {};
    let argsJson;
    try { argsJson = JSON.stringify(safeArgs); }
    catch (_) { argsJson = '{}'; }
    if (argsJson.length > 64 * 1024) {
      throw new Error('args exceeds 64KB cap after JSON encoding');
    }

    // v0.4.0: eval mode (EvalWorkflowSnippet). The host passes the code via
    // env; the bootstrap prunes its facade and evals instead of importing.
    const evalMode = !!args.evalMode;
    const evalCode = typeof args.evalCode === 'string' ? args.evalCode : '';
    if (evalMode && !evalCode) {
      throw new Error('evalMode: evalCode is required');
    }
    if (evalMode && evalCode.length > 64 * 1024) {
      throw new Error('evalMode: evalCode exceeds 64KB cap');
    }
    const evalTimeoutMs = typeof args.evalTimeoutMs === 'number' && args.evalTimeoutMs > 0
      ? Math.min(args.evalTimeoutMs, 600_000)
      : 60_000;

    // In eval mode we still need a placeholder scriptPath for the bootstrap
    // argv (it expects one). Use a synthetic name that can't collide on disk.
    const childArgvPath = evalMode ? '<eval>' : absScript;

    // --- v0.11.0: script hash + amend cache plan ---------------------------
    //
    // Computed BEFORE spawn so that a rejected amend (unknown source,
    // unchanged script, chain too deep) cannot leave an orphaned child
    // process behind.
    //
    // The hash is over the user's ORIGINAL file, not `absScript`: for a
    // `.ts` run, `absScript` has already been swapped for the transpiled
    // .mjs in a per-run tmp dir by this point, so hashing it would
    // compare build output rather than the source the user edits.
    //
    // It is computed for EVERY run, not just amended ones — the hash is
    // what a LATER amend compares against, so a fresh run that skipped
    // it would be permanently uncacheable-by-comparison.
    let scriptHash = null;
    if (!evalMode) {
      try {
        scriptHash = createHash('sha256')
          .update(await readFile(originalScriptPath))
          .digest('hex');
      } catch (_) {
        scriptHash = null;   // unreadable — fall back to "can't tell"
      }
    }

    let amendPlan = null;
    if (typeof args.amendFrom === 'string' && args.amendFrom) {
      const sourceId = args.amendFrom;
      const prev = this.runs.get(sourceId);
      if (!prev) {
        const err = new Error(`amend: no such source run '${sourceId}' (it may have been pruned, or the host restarted with a different runs dir)`);
        err.code = 'AMEND_NOT_FOUND';
        throw err;
      }

      if (scriptHash && prev.scriptHash && scriptHash === prev.scriptHash) {
        const err = new Error(
          `amend: ${originalScriptPath} is byte-identical to run ${sourceId}; ` +
          'edit the script (or drop amendFrom) — replaying an unchanged script costs a full run and saves nothing'
        );
        err.code = 'AMEND_NO_CHANGE';
        throw err;
      }

      const depth = (prev.journalImportDepth || 0) + 1;
      if (depth > this.amend.maxChainDepth) {
        const err = new Error(
          `amend: chain depth ${depth} exceeds maxChainDepth ${this.amend.maxChainDepth} ` +
          `(source run ${sourceId} is already ${prev.journalImportDepth || 0} deep)`
        );
        err.code = 'AMEND_CHAIN_TOO_DEEP';
        throw err;
      }

      amendPlan = { sourceId, depth, scriptHash, entries: prev.journal ? prev.journal.length : 0 };
    }

    // v0.9.0: env sandbox. Per-run override `args.sandbox === false`
    // bypasses scrubbing entirely (legacy behavior); an object passes
    // `allowlist` / `denylist` overrides that take precedence over
    // the per-deploy Config card.
    const sandboxArg = args.sandbox;
    const sandboxEnabled = sandboxArg !== false
      && !(this.sandbox && this.sandbox.enabled === false);
    let strippedKeys = [];
    let scrubbedFrom = 0;
    const baseEnv = sandboxEnabled
      ? (() => {
          const allow = (sandboxArg && Array.isArray(sandboxArg.allowlist))
            ? sandboxArg.allowlist
            : (this.sandbox && Array.isArray(this.sandbox.allowlist) ? this.sandbox.allowlist : DEFAULT_ENV_ALLOWLIST);
          const deny = (sandboxArg && Array.isArray(sandboxArg.denylist))
            ? sandboxArg.denylist
            : (this.sandbox && Array.isArray(this.sandbox.denylist) ? this.sandbox.denylist : DEFAULT_ENV_DENYLIST);
          const out = this._scrubChildEnv(allow, deny, process.env);
          strippedKeys = out.strippedKeys;
          scrubbedFrom = Object.keys(process.env || {}).length;
          return out.env;
        })()
      : { ...process.env };
    const childEnv = {
      ...baseEnv,
      DSH_WORKFLOW_RUN_ID: runId,
      DSH_WORKFLOW_ARGS: argsJson,
      DSH_WORKFLOW_WORKSPACE: workspaceRoot,
      DSH_WORKFLOW_MODELS: modelsAllowed.join(','),
    };
    if (evalMode) {
      childEnv.DSH_WORKFLOW_EVAL_MODE = 'snippet';
      childEnv.DSH_WORKFLOW_EVAL_CODE = evalCode;
      childEnv.DSH_WORKFLOW_EVAL_TIMEOUT_MS = String(evalTimeoutMs);
    }
    const sandboxSummary = sandboxEnabled
      ? `sandboxed env: kept ${Object.keys(childEnv).length} keys, stripped ${strippedKeys.length} sensitive keys (from ${scrubbedFrom} host keys)${strippedKeys.length ? ' — ' + strippedKeys.slice(0, 8).join(', ') + (strippedKeys.length > 8 ? ', …' : '') : ''}`
      : 'sandbox disabled: passing full host env to child';

    const child = spawn(this.nodeBin, [bootstrapAbs, childArgvPath], {
      cwd: evalMode ? process.cwd() : dirname(absScript),
      stdio: ['pipe', 'pipe', 'pipe'],
      env: childEnv,
    });

    const state = this.#newState({
      runId,
      originalScriptPath,
      absScript,
      evalMode,
      child,
      args,
      workspaceRoot,
      modelsAllowed,
      amendPlan,
      scriptHash,
      _transpileCleanup,
      childEnv,
    });

    this.runs.set(runId, state);

    // v0.12.0: build the per-run semaphore now that the state exists.
    state.concurrency.semaphore = createSemaphore(state.concurrency.maxConcurrent);
    this.#appendLog(runId, 'debug',
      `concurrency: max ${state.concurrency.maxConcurrent} concurrent agent.ask calls`);

    // v0.9.0: announce the sandbox state in the run log so users
    // can see what was stripped. The summary line is built above
    // (next to childEnv) and broadcast now that the state exists.
    this.#appendLog(runId, sandboxEnabled ? 'info' : 'warn', sandboxSummary);
    if (amendPlan) {
      this.#appendLog(runId, 'info',
        `amend from ${amendPlan.sourceId}: chain depth ${amendPlan.depth}, source journal has ` +
        `${amendPlan.entries} entries — cache OPEN until this run's first live world.run`);
      this.#broadcast(runId, {
        event: 'amend.open',
        fromRun: amendPlan.sourceId,
        depth: amendPlan.depth,
        entries: amendPlan.entries,
        at: Date.now(),
      });
    }
    this.#broadcast(runId, {
      event: 'sandbox',
      enabled: sandboxEnabled,
      stripped: strippedKeys.length,
      sample: strippedKeys.slice(0, 8),
      at: Date.now(),
    });

    const rlOut = createInterface({ input: child.stdout });
    rlOut.on('line', (line) => this.#onChildLine(runId, line));

    const rlErr = createInterface({ input: child.stderr });
    rlErr.on('line', (line) => this.#appendLog(runId, 'error', '[stderr] ' + line));

    child.on('exit', (code, signal) => this.#onChildExit(runId, code, signal));
    child.on('error', (err) => {
      this.#appendLog(runId, 'error', '[child error] ' + String(err && err.message || err));
      this.#setStatus(runId, 'error');
    });

    state.watchdog = setTimeout(() => {
      if (this.runs.has(runId)) {
        this.#appendLog(runId, 'error', 'host watchdog: force killing child');
        try { child.kill('SIGKILL'); } catch (_) {}
        this.#setStatus(runId, 'error');
      }
    }, RUN_TIMEOUT_MS);

    if (this.onLifecycle) this.onLifecycle({ type: 'started', runId });
    return { runId, status: 'starting' };
  }
  /**
   * v0.13.0 — start a run on the ZCode Dynamic Workflow engine.
   *
   * The engine path is a different architecture from the child-process path
   * above, and it is worth being precise about why.
   *
   * The SCRIPT still runs in a child process — the vendored harness spawns
   * it and bridges its `__host.*` calls over NDJSON — so the process-level
   * sandbox (scrubbed environment, path fences, command allow-list) is
   * unchanged. What moved is the CONTROL: instead of the child interpreting
   * the script and calling back into the host for everything, the script is
   * compiled (statically analysed, lowered to site-tagged JS, its typed
   * asks turned into JSON Schemas) and then executed by ZCode's engine, which
   * lives in this process and calls out to the host through four injection
   * ports.
   *
   * The consequences that matter:
   *   - the world is reached through exactly one door (the driver's
   *     worldRead), so the fences cannot be bypassed;
   *   - the engine's journal is the run's source of truth, and dsh's flat
   *     journal mirrors it for the editor;
   *   - the run state is the same shape as the child path's, so snapshot(),
   *     journal(), listRuns(), subscribe() and the on-disk serializer keep
   *     working unchanged.
   *
   * @param {{
   *   scriptText: string,
   *   runId?: string,
   *   name?: string,
   *   args?: object,
   *   workspaceRoot?: string,
   *   modelsAllowed?: string[],
   *   worldRunAllowlist?: string[],
   *   maxConcurrency?: number,
   *   timeoutMs?: number,
   * }} args
   * @returns {Promise<{runId: string, status: string}>}
   */
  async startEngine(args = {}) {
    const scriptText = typeof args.scriptText === 'string' ? args.scriptText : '';
    if (!scriptText.trim()) throw new Error('scriptText is required');

    const runId = args.runId || `dwf-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
    const workspaceRoot = args.workspaceRoot ? resolvePath(args.workspaceRoot) : process.cwd();
    const modelsAllowed = Array.isArray(args.modelsAllowed) && args.modelsAllowed.length > 0
      ? args.modelsAllowed.slice()
      : (Array.isArray(this.defaultModelsAllowed) && this.defaultModelsAllowed.length > 0
        ? this.defaultModelsAllowed.slice()
        : ['deepseek-chat']);

    // The amend-resume import.
    //
    // `resumeFrom` names a predecessor run. The successor gets the
    // predecessor's CACHED ANSWERS: an ask whose instructions and persona
    // are unchanged is settled from the cache instead of being paid for
    // again.
    //
    // The cache is built from the PREDECESSOR's journal, and it is closed
    // at the first write — because a cached answer is an answer about the
    // predecessor's world, and that world stops existing at the first
    // write.
    let importedCache;
    let inheritedTokens;
    const predecessorId = typeof args.resumeFrom === 'string' && args.resumeFrom
      ? args.resumeFrom
      : null;
    if (predecessorId !== null) {
      const imported = this.#buildEngineImport(predecessorId);
      if (!imported.ok) {
        throw new Error(`cannot resume from '${predecessorId}': ${imported.reason}`);
      }
      importedCache = imported.cache;
      inheritedTokens = imported.inheritedTokens;
    }

    // The env policy is the child path's, unchanged: the shell children
    // that `world.run` spawns inherit the scrubbed environment, and that is
    // where the scrubbing happens now that there is no bootstrap child.
    const sandboxArg = args.sandbox;
    const sandboxEnabled = sandboxArg !== false
      && !(this.sandbox && this.sandbox.enabled === false);
    const baseEnv = sandboxEnabled
      ? (() => {
          const allow = (sandboxArg && Array.isArray(sandboxArg.allowlist))
            ? sandboxArg.allowlist
            : (this.sandbox && Array.isArray(this.sandbox.allowlist) ? this.sandbox.allowlist : DEFAULT_ENV_ALLOWLIST);
          const deny = (sandboxArg && Array.isArray(sandboxArg.denylist))
            ? sandboxArg.denylist
            : (this.sandbox && Array.isArray(this.sandbox.denylist) ? this.sandbox.denylist : DEFAULT_ENV_DENYLIST);
          return this._scrubChildEnv(allow, deny, process.env).env;
        })()
      : { ...process.env };
    const childEnv = {
      ...baseEnv,
      DSH_WORKFLOW_RUN_ID: runId,
      DSH_WORKFLOW_WORKSPACE: workspaceRoot,
      DSH_WORKFLOW_MODELS: modelsAllowed.join(','),
    };

    const state = this.#newState({
      runId,
      originalScriptPath: args.name || 'inline.dwf.ts',
      absScript: args.name || 'inline.dwf.ts',
      evalMode: false,
      child: null,
      args,
      workspaceRoot,
      modelsAllowed,
      amendPlan: null,
      scriptHash: null,
      _transpileCleanup: null,
      childEnv,
    });
    this.runs.set(runId, state);
    state.concurrency.semaphore = createSemaphore(state.concurrency.maxConcurrent);

    const abort = new AbortController();
    state._engineAbort = abort;

    // The engine owns the run's journal; dsh's flat journal mirrors it so
    // the editor's journal panel keeps working.
    //
    // The base is a DURABLE store: the engine's journal is the truth for
    // replay, resume and the amend-resume import cache, and none of those
    // survive a host restart if the journal only lives in memory. The
    // durable store is upstream's `InMemoryJournalStore` plus a write-through
    // to a file per run, so every semantic is upstream's.
    const journal = createDwfJournal({
      base: this.#engineJournal(),
      onEvent: (stored) => {
        const type = (stored && (stored.event?.type || stored.type)) || null;
        this.#journalPush(state, runId, {
          kind: 'engine.event',
          type,
          live: true,
        });
      },
    });

    // The engine's own journal is kept, so a SUCCESSOR run can read it.
    // The amend-resume import cache is built from the predecessor's
    // journal, and the predecessor's journal is not in dsh's flat one —
    // it is the engine's.
    state._engineJournal = journal;

    const services = createDwfServices({
      runId,
      state,
      ctx: this.ctx,
      chat: this.chat,
      world: this.#engineWorld(runId),
      publishArtifact: (request) => this.#enginePublishArtifact(runId, request),
      emit: (event) => this.#engineEmit(runId, event),
      appendLog: (level, message) => this.#appendLog(runId, level, message),
      journalPush: (entry) => this.#journalPush(state, runId, entry),
      // The host reports the workspace-changing work it does on an ask's
      // behalf, so the engine can close its import cache before the first
      // byte lands. A cached answer is an answer about the PREDECESSOR's
      // world, and that world stops existing at the first write.
      reportMutation: (actorName) => this.#reportEngineMutation(runId, actorName),
      resolveModel: (persona) => {
        if (persona && typeof persona.model === 'string' && state.modelsAllowed.has(persona.model)) {
          return persona.model;
        }
        return Array.from(state.modelsAllowed)[0];
      },
      askTimeoutMs: ASK_TIMEOUT_MS,
      defaultModel: Array.from(state.modelsAllowed)[0] || 'deepseek-chat',
      // dsh's own facade members. Each one is a request the script makes
      // of the host, the way the legacy path made them child RPCs.
      askUser: (question, opts) => this.#askUserOnHost(runId, question, opts),
      escalate: (question, opts) => this.#escalateOnHost(runId, question, opts),
      stagesList: () => this.listInjectedStages(runId),
      stagesPending: () => this.#pendingStageCount(runId),
      stagesAwait: (opts) => this.#awaitStages(runId, opts),
      stageRun: (request) => this.#runEngineStage(runId, request),
      concurrencyStat: () => this.#concurrencyStat(runId),
      // The driver publishes itself here, so the run's live concurrency
      // counters are reachable while the run is in flight.
      onDriver: (driver) => { state._engineDriverRef = driver; },
    });

    this.#setStatus(runId, 'running');

    // Compile FIRST, and synchronously. A script that does not compile
    // is a REPORT, not a run: the caller gets the diagnostics straight
    // away instead of polling a run that was never going to start.
    const prepared = prepareWorkflow(scriptText, {
      models: Array.from(state.modelsAllowed),
      constants: {
        rpcVersion: 7,
        artifactKinds: { declare: ['chart', 'table', 'metrics', 'board'], publish: ['markdown', 'file'] },
      },
    });
    const diagnostics = collectPreparedDiagnostics(prepared);
    if (!prepared.ok) {
      state._engine = { prepared, diagnostics, graphs: projectWorkflowGraphs(prepared), scriptText };
      state.exitCode = 1;
      const message = `the workflow did not compile: ${diagnostics.length} diagnostic(s)`;
      this.#appendLog(runId, 'error', message);
      this.#setStatus(runId, 'error');
      return {
        runId, status: 'error', diagnostics,
        error: { code: 'CompileFailed', message, diagnostics },
      };
    }

    // The run's script text, kept on the state from the start. A hole fill
    // needs it: the fill splices the body into the script and recompiles,
    // and a run that is parked on a hole has not settled yet, so the
    // settlement-time `_engine` assignment has not happened.
    state._engineScriptText = scriptText;

    // The run itself happens in the background, the way the
    // child-process path does: the caller gets a run id and watches the
    // event stream.
    this.#engineRun(runId, state, {
      scriptText,
      prepared,
      services,
      journal,
      abort,
      args,
      workspaceRoot,
      // The control plane: the harness hands us the live engine, which is
      // the only way to reach a parked hole or to change the ceiling of a
      // run that is already going.
      control: {
        bind: (engine) => {
          this._engineControls.set(runId, engine);
        },
      },
      // The amend-resume import: the predecessor's cached answers, the
      // lineage pointer, and the tokens the predecessor already spent.
      ...(importedCache === undefined ? {} : { importedCache }),
      ...(predecessorId === null ? {} : { resumedFrom: predecessorId }),
      ...(inheritedTokens === undefined ? {} : { inheritedTokens }),
    }).catch(() => {
      /* the run's own error path has already settled the run */
    });

    return { runId, status: 'starting', diagnostics, graphs: projectWorkflowGraphs(prepared) };
  }

  /**
   * Run a compiled workflow to settlement.
   *
   * @param {string} runId
   * @param {object} state
   * @param {object} plan
   * @returns {Promise<void>}
   */
  async #engineRun(runId, state, plan) {
    const {
      scriptText, prepared, services, journal, abort, args, workspaceRoot, control,
      importedCache, resumedFrom, inheritedTokens,
    } = plan;
    try {
      const { settlement, diagnostics, driver } = await runDwfWorkflow({
        scriptText,
        // The compile we already did. Passing it means the run does not
        // compile a second time — and, more importantly, that the dsh
        // facade's baked-in globals (the model list, the runtime constants)
        // survive into the body that actually runs.
        prepared,
        runId,
        name: args.name,
        args: args.args,
        maxConcurrency: state.concurrency.maxConcurrent,
        services,
        journal,
        signal: abort.signal,
        timeoutMs: args.timeoutMs,
        cwd: workspaceRoot,
        // The control plane. The harness hands us the live engine as soon as
        // it has one, and that handle is the ONLY way to reach a parked hole
        // (to fill it) or to change the ceiling of a run that is already
        // going. Without it, `fill_workflow_hole` is dead and a live run's
        // concurrency ceiling cannot be changed.
        control,
        // The amend-resume import: the predecessor's cached answers, the
        // lineage pointer, and the tokens the predecessor already spent.
        ...(importedCache === undefined ? {} : { importedCache }),
        ...(resumedFrom === undefined ? {} : { resumedFrom }),
        ...(inheritedTokens === undefined ? {} : { inheritedTokens }),
      });

      // The driver holds the run's live concurrency counters. The engine
      // path never acquires dsh's semaphore, so these are the only real
      // numbers `concurrency.stat()` can report here.
      state._engineDriver = driver ?? null;

      state._engine = {
        settlement,
        prepared,
        diagnostics,
        graphs: projectWorkflowGraphs(prepared),
      };
      state.exitCode = settlement.status === 'completed' ? 0 : 1;

      if (settlement.status === 'completed') {
        this.#setStatus(runId, 'completed');
      } else if (settlement.status === 'stopped') {
        this.#setStatus(runId, 'stopped');
      } else {
        const message = settlement.error
          ? (settlement.error.message || JSON.stringify(settlement.error))
          : 'the workflow did not complete';
        this.#appendLog(runId, 'error', message);
        this.#setStatus(runId, 'error');
      }

      // The run is over, so its rows are final: flush them now rather than
      // waiting for the debounce. A predecessor that is amended later must
      // be able to read them.
      this.#engineJournal().flush(runId);

      if (this.onLifecycle) this.onLifecycle({ type: 'settled', runId, status: state.status });
    } catch (err) {
      state._engineError = String((err && err.message) || err);
      this.#appendLog(runId, 'error', state._engineError);
      this.#setStatus(runId, 'error');
    }
  }

  /**
   * Build the amend-resume import from a predecessor run.
   *
   * The cache is built from the PREDECESSOR's engine journal — the
   * predecessor's cached answers, not dsh's flat mirror of them. The
   * predecessor's live sessions are consulted too, because the journal
   * cannot say how many messages a session held: only the driver knows
   * that, and the `messageBoundary` of an unfinished ask is read from the
   * session.
   *
   * The journal is DURABLE, so a predecessor from before a host restart is
   * still importable: its rows are read back from disk. The sessions are
   * not — they died with the process — so a restored predecessor
   * contributes its completed prefix and no in-flight ask. That is
   * upstream's "quiesce" behaviour: a session that misses the wait yields
   * no `inFlight`, which is what an amendment did before the carry existed.
   *
   * @param {string} predecessorId
   * @returns {{ok: true, cache: object, inheritedTokens: number}|{ok: false, reason: string}}
   */
  #buildEngineImport(predecessorId) {
    const predecessor = this.runs.get(predecessorId);
    if (!predecessor) return { ok: false, reason: 'no such run' };

    // The journal is the durable store, so a predecessor that only exists
    // on disk is still importable.
    const journal = this.#engineJournal();
    if (journal.getRun(predecessorId) === undefined) {
      return {
        ok: false,
        reason: 'it has no engine journal to import from',
      };
    }

    // The predecessor's sessions: their message counts and ids. The driver
    // holds them — the journal cannot say how many messages a session held.
    // The driver's snapshot is taken when the run ended, because the run
    // disposes its sessions as it settles.
    const sessions = {};
    const driver = predecessor._engineDriver;
    if (driver && typeof driver.sessionCounts === 'function') {
      Object.assign(sessions, driver.sessionCounts());
    }

    const built = buildImportedCache(journal, predecessorId, { sessions });
    if (!built.ok) return { ok: false, reason: built.reason };

    // The predecessor's spent tokens. A run reports the cost of its whole
    // lineage, and each predecessor's figure is itself cumulative — so the
    // chain sums by construction and nothing walks it. The engine keeps the
    // figure on the run row.
    const runRow = journal.getRun(predecessorId);
    const inheritedTokens = Number(runRow?.spentTokens ?? 0) || 0;
    return { ok: true, cache: built.cache, inheritedTokens };
  }

  /**
   * The engine's durable journal store.
   *
   * One store for the whole process, so a run's rows survive a host
   * restart.
   *
   * @returns {DurableJournalStore}
   */
  #engineJournal() {
    return this._engineJournalStore;
  }

  /**
   * The world operations for an engine run, bound to this run.
   *
   * This is the ONLY way the engine path reaches the outside world, and
   * every one of these operations carries the path fences, the size caps
   * and the command allow-list.
   *
   * @param {string} runId
   * @returns {Record<string, (params: object) => Promise<any>>}
   */
  #engineWorld(runId) {
    return {
      read: (p) => this.#filesRead(runId, p),
      glob: (p) => this.#filesGlob(runId, p),
      grep: (p) => this.#filesGrep(runId, p),
      'git-changed-files': (p) => this.#gitChangedFiles(runId, p),
      'git-diff': (p) => this.#gitDiff(runId, p),
      'git-status': () => this.#gitStatus(runId),
      'git-log': (p) => this.#gitLog(runId, p),
      run: (p) => this.#worldRun(runId, p),
    };
  }

  /**
   * Report a workspace mutation to the engine, on behalf of an in-flight
   * ask.
   *
   * This is `askMutating` — the ONE driver observation the engine makes a
   * decision on. It closes the run's import cache, because a cached answer
   * is an answer about the PREDECESSOR's world, and that world stops
   * existing at the first write.
   *
   * The engine closes the cache itself for a live `world.run` (upstream:
   * `engine-world.ts`, `closeImportCache(state, instance, "world-run")`).
   * This path covers the writes the engine does NOT see: the ones the host
   * performs on an ask's behalf — a stage the ask ran, a command the ask
   * drove.
   *
   * @param {string} runId
   * @param {string} [actorName] - the subagent whose ask is in flight
   */
  #reportEngineMutation(runId, actorName) {
    const driver = this.runs.get(runId)?._engineDriverRef;
    if (!driver || typeof driver.reportMutation !== 'function') return;
    // The ask that is in flight on this subagent is the one whose answer
    // the write invalidates. If no ask is in flight there is nothing to
    // attribute the write to — and upstream's `askMutating` ignores a
    // report for an ask that has already settled, so there is nothing to
    // report either.
    const key = driver.inFlightKeyFor?.(actorName);
    if (key === undefined || key === null) return;
    driver.reportMutation(key, actorName ? { actorName } : {});
  }

  /**
   * Publish one content artifact for an engine run.
   *
   * The engine computes the version and hands it over; dsh's store
   * computes its own. They agree as long as an id is only ever published
   * through one path, and a divergence is reported rather than papered
   * over.
   *
   * @param {string} runId
   * @param {object} request
   * @returns {Promise<object>}
   */
  async #enginePublishArtifact(runId, request) {
    const s = this.runs.get(runId);
    const opts = request.opts && typeof request.opts === 'object' ? request.opts : {};
    let content = request.content;
    let filename = null;
    let sourcePath = null;

    if (request.op === 'file') {
      const rel = String(request.path || '');
      if (!rel) throw new Error('artifact.file: a workspace-relative path is required');
      const abs = this.#resolveInWorkspace(runId, rel);
      const st = await stat(abs).catch(() => null);
      if (!st || !st.isFile()) throw new Error(`artifact.file: not a file: ${rel}`);
      if (st.size > ARTIFACT_FILE_CAP) {
        throw new Error(`artifact.file: ${rel} is ${st.size}B, over the ${ARTIFACT_FILE_CAP}B cap`);
      }
      content = await readFile(abs, 'utf8');
      filename = rel.split(/[\\/]/).pop();
      sourcePath = rel;
    }

    const res = await this.#artifactPublish(runId, {
      id: request.id,
      kind: request.op,
      content,
      filename,
      title: opts.title,
      description: opts.description,
      primary: opts.primary,
    });
    if (res.version !== request.version && s) {
      this.#appendLog(
        runId,
        'warn',
        `artifact ${request.id}: engine version ${request.version} and store version ${res.version} disagree`,
      );
    }
    const art = s && s.artifacts.get(request.id);
    const stored = art && art.versions.find((v) => v.version === res.version);
    return {
      id: request.id,
      kind: request.op,
      version: res.version,
      title: opts.title,
      description: opts.description,
      contentType: stored && stored.contentType,
      bytes: content === undefined || content === null ? 0 : Buffer.byteLength(String(content), 'utf8'),
      uri: `dsh-artifact://${request.id}/${res.version}`,
      sourcePath,
      publishedAt: Date.now(),
      ...(opts.primary ? { primary: true } : {}),
    };
  }

  /**
   * One engine event, in dsh's terms.
   *
   * Three of the engine's events have side effects dsh's own run state
   * needs — a phase, a report and a log line — so they go through the same
   * helpers the child path uses. Everything else is a broadcast.
   *
   * @param {string} runId
   * @param {object} event
   */
  #engineEmit(runId, event) {
    if (!event || typeof event.type !== 'string') return;
    switch (event.type) {
      case 'phase-entered':
        this.#enterPhase(runId, String(event.name || ''));
        return;
      case 'report':
        this.#recordReport(runId, event.item, event.artifactId || null);
        return;
      case 'hole-reached': {
        // The run parked on a hole. Record it, so the editor and the
        // fill tool can see which one is waiting.
        const siteId = event.instance && event.instance.siteId;
        const s = this.runs.get(runId);
        if (s && siteId) {
          s.pendingHoles.set(siteId, {
            holeId: siteId,
            name: event.name,
            prompt: event.prompt,
            hasContext: false,
            askedAt: Date.now(),
          });
        }
        return;
      }
      case 'log':
        this.#appendLog(runId, 'info', String(event.message || ''));
        return;
      default:
        break;
    }
    const payload = mapEngineEvent(event);
    if (payload) this.#broadcast(runId, payload);
  }
  /**
   * The run state, in one place.
   *
   * v0.13.0: the ZCode Dynamic Workflow engine path builds the same shape
   * as the child-process path, so snapshot(), journal(), listRuns(),
   * subscribe() and the on-disk serializer keep working unchanged. One
   * factory, two architectures — the state is the contract between them.
   *
   * @param {object} p
   * @returns {object} the run state
   */
  #newState({
    runId, originalScriptPath, absScript, evalMode, child, args, workspaceRoot,
    modelsAllowed, amendPlan, scriptHash, _transpileCleanup, childEnv,
  }) {
    return {
      runId,
      scriptPath: originalScriptPath,    // what the user wrote (.ts or .mjs)
      compiledScriptPath: absScript,     // what the child actually loads
      evalMode,
      status: 'starting',
      startedAt: Date.now(),
      endedAt: null,
      exitCode: null,
      child,
      agents: new Map(),
      agentsOrder: [],
      phases: [],
      phaseSummary: new Map(),
      currentPhase: null,
      log: [],
      reports: [],
      artifacts: new Map(), // id -> {kind, spec?, title?, description?, primary, versions:[...]}
      worldRunAllowlist: Array.isArray(args.worldRunAllowlist) ? new Set(args.worldRunAllowlist) : null,
      worldRunDeclined: [],
      workspaceRoot,
      modelsAllowed: new Set(modelsAllowed),
      // The flat journal the editor reads. On the engine path it mirrors
      // the engine's own journal, which stays the source of truth.
      journal: [],
      pendingQuestions: new Map(),
      pendingHoles: new Map(),
      pendingEscalates: new Map(),
      amendFrom: typeof args.amendFrom === 'string' && args.amendFrom ? args.amendFrom : null,
      cacheOpen: !!amendPlan,
      journalImportDepth: amendPlan ? amendPlan.depth : 0,
      scriptHash,
      journalTrimmed: 0,
      concurrency: {
        maxConcurrent: normalizeConcurrency(
          typeof args.maxConcurrency === 'number' && args.maxConcurrency > 0
            ? args.maxConcurrency
            : (this.concurrency && this.concurrency.maxConcurrent) || DEFAULT_MAX_CONCURRENT
        ),
        semaphore: null,   // filled in by the caller
        peak: 0,
        waiting: 0,
      },
      _transpileCleanup,
      sandboxedChildEnv: childEnv,
      injectedStages: [],
      pendingStageCalls: new Map(),
      _nextHostId: 1,
      subscribers: new Set(),
      _stopRequested: false,
      watchdog: null,
    };
  }

  /**
   * Enter a phase: fold it into the summary, complete the previous one,
   * and broadcast. Shared by the child path and the engine path so the
   * editor sees the same lifecycle on both.
   *
   * @param {string} runId
   * @param {string} name
   */
  #enterPhase(runId, name) {
    const s = this.runs.get(runId);
    if (!s) return;
    const at = Date.now();
    s.phases.push({ name, at });
    // Fold: same name in a loop is one node, with a count badge in the UI.
    const existing = s.phaseSummary.get(name);
    if (existing) {
      existing.lastAt = at;
      existing.count += 1;
    } else {
      s.phaseSummary.set(name, { name, firstAt: at, lastAt: at, count: 1, status: 'active' });
    }
    // v0.12.0: phase lifecycle. The previous phase is complete the
    // moment a new one starts — there is no explicit "end" call in
    // the facade, and inventing one would change the script contract.
    // Re-entering the SAME phase name (a loop) does not complete it:
    // the node stays active and just bumps its count.
    if (s.currentPhase && s.currentPhase !== name) {
      this.#broadcast(runId, {
        event: 'phase.complete',
        phase: { name: s.currentPhase, at },
        phaseSummary: Array.from(s.phaseSummary.values()),
      });
      const prevSummary = s.phaseSummary.get(s.currentPhase);
      if (prevSummary && prevSummary.status === 'active') prevSummary.status = 'done';
    }
    const summary = s.phaseSummary.get(name);
    if (summary) summary.status = 'active';
    s.currentPhase = name;
    s.currentPhaseStartedAt = at;
    this.#broadcast(runId, {
      event: 'phase',
      phase: { name, at },
      phaseSummary: Array.from(s.phaseSummary.values()),
    });
    // v0.12.0: explicit start event, alongside the legacy `phase`
    // event (which existing clients already consume).
    this.#broadcast(runId, {
      event: 'phase.start',
      phase: { name, at },
      phaseSummary: Array.from(s.phaseSummary.values()),
    });
  }

  /**
   * Record one reported item, and route it to a preset artifact when the
   * tag names one. Returns the artifact id it was routed to, or null.
   *
   * @param {string} runId
   * @param {unknown} item
   * @param {string|null} tag
   * @returns {string|null}
   */
  #recordReport(runId, item, tag) {
    const s = this.runs.get(runId);
    if (!s) return null;
    const at = Date.now();
    const entry = { at, item, tag };
    s.reports.push(entry);
    // Route: if `tag` matches a chart/table/metrics/board artifact id, append
    // a data point to that artifact's versions list. The Reports panel still
    // gets the entry, so existing UI keeps working.
    let artifactId = null;
    if (tag) {
      const art = s.artifacts.get(tag);
      if (art && (art.kind === 'chart' || art.kind === 'table' || art.kind === 'metrics' || art.kind === 'board')) {
        artifactId = art.id;
        art.versions.push({ version: art.versions.length + 1, at, item });
      }
    }
    this.#broadcast(runId, { event: 'report', report: entry, artifactId });
    return artifactId;
  }

  /**
   * v0.10.0 — structural amend: inject a new stage into a RUNNING run.
   *
   * This is ZCode's `AmendWorkflow` semantics. The stage body executes
   * inside the live child process, so it shares the run's agents (and
   * their chat history), its `world.run` allowlist, its sandboxed env and
   * its workspace confinement. It does NOT restart the run and does NOT
   * replay the journal — the original plan keeps executing untouched
   * while the amendment interleaves with it.
   *
   * @param {string} runId
   * @param {{
   *   name?: string,
   *   code?: string,        // function-expression or statement-block body
   *   codePath?: string,    // read the body from a workspace file instead
   *   timeoutMs?: number,   // how long the stage itself may run
   *   wait?: boolean,       // resolve only once the stage has settled
   *   context?: object,     // merged into the stage's ctx
   * }} opts
   * @returns {Promise<{stageId:string, accepted:boolean, result?:*, error?:string}>}
   */
  async injectStage(runId, opts = {}) {
    const s = this.runs.get(runId);
    if (!s) throw new Error('unknown run: ' + runId);
    if (s._loadedFromDisk) {
      throw new Error('run is a restored shell (not live) — cannot inject a stage');
    }
    if (s.status !== 'starting' && s.status !== 'running') {
      throw new Error(`run is ${s.status} — structural amend needs a live run (status: starting|running)`);
    }
    if (s.evalMode) {
      throw new Error('eval-mode (snippet) runs do not accept injected stages');
    }
    // The legacy path hands the stage to the child over its stdin. The
    // engine path has no child of ours to hand it to — the script lives in
    // a harness-spawned sandbox — so the stage is parked on the HOST side
    // and the script picks it up with `stages.run(stageId)`.
    const isEngineRun = this._engineControls.has(runId);
    if (!isEngineRun && (!s.child || s.child.exitCode !== null)) {
      throw new Error('run child has already exited');
    }
    if (s.injectedStages.length >= STAGE_MAX_PER_RUN) {
      throw new Error(`stage cap reached: ${STAGE_MAX_PER_RUN} stages per run`);
    }
    const inflight = s.injectedStages.filter((x) => x.status === 'injected' || x.status === 'running').length;
    if (inflight >= STAGE_MAX_INFLIGHT) {
      throw new Error(`too many stages in flight: ${inflight}/${STAGE_MAX_INFLIGHT} — wait for one to settle`);
    }

    // Body: inline `code`, or read `codePath` out of the workspace.
    let body = typeof opts.code === 'string' ? opts.code : '';
    if (!body && typeof opts.codePath === 'string' && opts.codePath) {
      // Resolve a relative codePath against the run's workspaceRoot, not
      // the host's cwd — "a file inside this run's project" is what the
      // caller means. `#resolveInWorkspace` then does the containment
      // check (and raises PATH_ESCAPE for anything pointing outside).
      const raw = opts.codePath;
      const candidate = isAbsolute(raw) ? raw : join(s.workspaceRoot, raw);
      const abs = this.#resolveInWorkspace(runId, candidate);
      const st = await stat(abs).catch(() => null);
      if (!st || !st.isFile()) throw new Error('stage codePath is not a file: ' + raw);
      if (st.size > STAGE_MAX_BODY) {
        throw new Error(`stage codePath exceeds ${STAGE_MAX_BODY} byte cap`);
      }
      body = await readFile(abs, 'utf8');
    }
    if (!body || !body.trim()) {
      throw new Error('injectStage: one of `code` or `codePath` is required');
    }
    if (body.length > STAGE_MAX_BODY) {
      throw new Error(`injectStage: body exceeds ${STAGE_MAX_BODY} byte cap`);
    }

    const stageId = randomUUID();
    const name = (typeof opts.name === 'string' && opts.name.trim()) ? opts.name.trim() : 'injected-stage';
    const injectedAt = Date.now();

    // Context handed to the stage: what the run knows about itself at
    // injection time, plus the results of earlier stages in this run so
    // amendments can build on each other.
    const stageCtx = {
      stage: { id: stageId, name, injectedAt, runId },
      run: {
        runId,
        status: s.status,
        scriptPath: s.scriptPath,
        workspaceRoot: s.workspaceRoot,
        currentPhase: s.currentPhase,
        phases: s.phases.map((p) => p.name),
        phaseSummary: Array.from(s.phaseSummary.values()),
        agents: s.agentsOrder.slice(),
        models: Array.from(s.modelsAllowed || []),
      },
      args: this.#serializeArgs(s),
      reports: s.reports.slice(-50).map((r) => ({ at: r.at, tag: r.tag, item: r.item })),
      artifacts: Array.from(s.artifacts.keys()),
      previous: s.injectedStages
        .filter((x) => x.status === 'completed')
        .map((x) => ({ id: x.stageId, name: x.name, result: x.result, endedAt: x.endedAt })),
      ...(opts.context && typeof opts.context === 'object' ? opts.context : {}),
    };

    const record = {
      stageId,
      name,
      body,
      source: typeof opts.codePath === 'string' && opts.codePath ? opts.codePath : 'inline',
      injectedAt,
      startedAt: null,
      endedAt: null,
      status: 'injected',
      result: null,
      error: null,
    };
    s.injectedStages.push(record);

    this.#appendLog(runId, 'info', `stage injected: ${name} (${record.source})`);
    this.#broadcast(runId, {
      event: 'stage.injected',
      stage: { stageId, name, source: record.source, injectedAt },
      at: injectedAt,
    });
    this.#schedulePersist(runId);

    // The engine path: the stage is parked for the script to run. The
    // script calls `stages.run(stageId)`, which comes back to the host
    // over the worldRead channel, and the host evaluates the body.
    if (this._engineControls.has(runId)) {
      return this.#engineStage(runId, record, stageCtx, opts);
    }

    // One deferred per stage. `#appendStageNotify` settles it when the
    // child reports `stage.finished`; `#setStatus` settles it when the
    // run ends first. `wait: true` is just a consumer of it.
    let resolveStage;
    let rejectStage;
    const settled = new Promise((resolve, reject) => { resolveStage = resolve; rejectStage = reject; });
    s.pendingStageCalls.set(stageId, { resolve: resolveStage, reject: rejectStage, stageId, name, timer: null });

    const hostId = this.#hostCall(runId, 'stage.inject', { stageId, name, body, ctx: stageCtx, injectedAt });
    if (hostId === null) {
      s.pendingStageCalls.delete(stageId);
      record.status = 'error';
      record.error = 'run child is gone — stage never reached it';
      record.endedAt = Date.now();
      throw new Error(record.error);
    }

    if (!opts.wait) {
      // Fire-and-forget: the caller polls /api/state for
      // `injectedStages[].status` or listens for the SSE events.
      settled.catch(() => {});   // never let an unobserved rejection surface
      return { stageId, accepted: true, name };
    }

    const timeoutMs = (typeof opts.timeoutMs === 'number' && opts.timeoutMs > 0)
      ? Math.min(opts.timeoutMs, STAGE_MAX_WAIT_MS)
      : STAGE_MAX_WAIT_MS;
    const timer = setTimeout(() => {
      if (!s.pendingStageCalls.delete(stageId)) return;
      const rec = s.injectedStages.find((x) => x.stageId === stageId);
      if (rec && rec.status === 'injected') {
        rec.status = 'timed-out';
        rec.error = `no result within ${timeoutMs}ms (the stage may still be running in the child)`;
        rec.endedAt = Date.now();
      }
      rejectStage(new Error(`stage ${name} did not settle within ${timeoutMs}ms`));
    }, timeoutMs);
    const entry = s.pendingStageCalls.get(stageId);
    if (entry) entry.timer = timer;
    else clearTimeout(timer);

    return settled.then(() => {
      const rec = s.injectedStages.find((x) => x.stageId === stageId) || record;
      return { stageId, accepted: true, name, status: rec.status, result: rec.result, error: rec.error };
    });
  }

  /**
   * Park a stage on an engine run.
   *
   * The engine path has no child of ours to hand the stage to. The stage
   * body is therefore parked here, on the HOST side, and the script runs it
   * with `stages.run(stageId)` — which comes back over the worldRead
   * channel.
   *
   * Running the body host-side is deliberate. The stage's whole point is
   * that it inherits the RUN's capabilities: its subagents and their chat
   * history, its workspace confinement, its command allow-list and its
   * sandboxed environment. Those live on the host, not inside the
   * sandbox, so a stage evaluated inside the sandbox would have none of
   * them.
   *
   * @param {string} runId
   * @param {object} record - the stage record
   * @param {object} stageCtx - the context handed to the stage
   * @param {object} opts - the injectStage options
   * @returns {Promise<object>}
   */
  async #engineStage(runId, record, stageCtx, opts) {
    const s = this.runs.get(runId);
    record.status = 'injected';

    // The stage waits for the script to ask for it. A `wait: true` caller
    // waits for the stage to settle; a fire-and-forget caller polls.
    let resolveStage;
    let rejectStage;
    const settled = new Promise((resolve, reject) => { resolveStage = resolve; rejectStage = reject; });
    s.pendingStageCalls.set(record.stageId, {
      resolve: resolveStage,
      reject: rejectStage,
      stageId: record.stageId,
      name: record.name,
      timer: null,
    });

    if (!opts.wait) {
      settled.catch(() => {});
      return { stageId: record.stageId, accepted: true, name: record.name };
    }

    const timeoutMs = (typeof opts.timeoutMs === 'number' && opts.timeoutMs > 0)
      ? Math.min(opts.timeoutMs, STAGE_MAX_WAIT_MS)
      : STAGE_MAX_WAIT_MS;
    const timer = setTimeout(() => {
      if (!s.pendingStageCalls.delete(record.stageId)) return;
      if (record.status === 'injected') {
        record.status = 'timed-out';
        record.error = `no result within ${timeoutMs}ms (the script may never have run the stage)`;
        record.endedAt = Date.now();
      }
      rejectStage(new Error(`stage ${record.name} did not settle within ${timeoutMs}ms`));
    }, timeoutMs);
    const entry = s.pendingStageCalls.get(record.stageId);
    if (entry) entry.timer = timer;
    else clearTimeout(timer);

    return settled.then(() => ({
      stageId: record.stageId,
      accepted: true,
      name: record.name,
      status: record.status,
      result: record.result,
      error: record.error,
    }));
  }

  /**
   * Run a stage the script asked for, on an engine run.
   *
   * Reached from the sandbox through `stages.run(stageId)`.
   *
   * @param {string} runId
   * @param {object} request - `{ stageId, ctx }`
   * @returns {Promise<unknown>}
   */
  async #runEngineStage(runId, request) {
    const s = this.runs.get(runId);
    if (!s) throw new Error('unknown run: ' + runId);
    const stageId = String((request && request.stageId) || '');
    const record = s.injectedStages.find((x) => x.stageId === stageId);
    if (!record) throw new Error(`no injected stage with id '${stageId}'`);
    if (record.status === 'completed' || record.status === 'error') {
      // Already settled. Returning the recorded result keeps a second call
      // idempotent instead of running the body twice.
      return record.result;
    }

    record.status = 'running';
    record.startedAt = Date.now();
    this.#broadcast(runId, {
      event: 'stage.started',
      stage: { stageId, name: record.name, at: record.startedAt },
      at: record.startedAt,
    });

    try {
      const value = await this.#evaluateStageBody(record.body, this.#engineStageContext(runId, record), s);
      record.status = 'completed';
      record.result = value === undefined ? null : value;
      record.endedAt = Date.now();
      this.#broadcast(runId, {
        event: 'stage.finished',
        stage: {
          stageId, name: record.name, status: 'completed', result: record.result,
          durationMs: record.endedAt - record.startedAt, at: record.endedAt,
        },
        at: record.endedAt,
      });
      const waiter = s.pendingStageCalls.get(stageId);
      if (waiter) {
        s.pendingStageCalls.delete(stageId);
        if (waiter.timer) clearTimeout(waiter.timer);
        waiter.resolve();
      }
      return record.result;
    } catch (err) {
      record.status = 'error';
      record.error = String(err && err.message || err);
      record.endedAt = Date.now();
      this.#broadcast(runId, {
        event: 'stage.finished',
        stage: {
          stageId, name: record.name, status: 'error', error: record.error,
          durationMs: record.endedAt - record.startedAt, at: record.endedAt,
        },
        at: record.endedAt,
      });
      const waiter = s.pendingStageCalls.get(stageId);
      if (waiter) {
        s.pendingStageCalls.delete(stageId);
        if (waiter.timer) clearTimeout(waiter.timer);
        waiter.resolve();
      }
      throw err;
    }
  }

  /**
   * The context an engine run's stage sees.
   *
   * @param {string} runId
   * @param {object} record
   * @returns {object}
   */
  #engineStageContext(runId, record) {
    const s = this.runs.get(runId);
    return {
      stage: { id: record.stageId, name: record.name, injectedAt: record.injectedAt, runId },
      run: {
        runId,
        status: s.status,
        scriptPath: s.scriptPath,
        workspaceRoot: s.workspaceRoot,
        currentPhase: s.currentPhase,
        phases: s.phases.map((p) => p.name),
        phaseSummary: Array.from(s.phaseSummary.values()),
        agents: s.agentsOrder.slice(),
        models: Array.from(s.modelsAllowed || []),
      },
      args: this.#serializeArgs(s),
      reports: s.reports.slice(-50).map((r) => ({ at: r.at, tag: r.tag, item: r.item })),
      artifacts: Array.from(s.artifacts.keys()),
      previous: s.injectedStages
        .filter((x) => x.status === 'completed')
        .map((x) => ({ id: x.stageId, name: x.name, result: x.result, endedAt: x.endedAt })),
    };
  }

  /**
   * Evaluate a stage body.
   *
   * Three accepted shapes, tried in order — the same three the legacy path
   * accepts:
   *   1. `export default <expr>;` — a standalone .mjs stage file
   *   2. a bare function expression — the `hole()` convention
   *   3. a bare statement block, with `return` allowed inside
   *
   * @param {string} body
   * @param {object} ctx
   * @param {object} s - the run state, for the run's facade
   * @returns {Promise<unknown>}
   */
  async #evaluateStageBody(body, ctx, s) {
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const trimmed = String(body || '').trim();
    if (!trimmed) throw new Error('stage body is empty');

    // Three accepted shapes, tried in order — the same three the legacy
    // path accepts:
    //   1. `export default <expr>;` — a standalone .mjs stage file
    //   2. a bare function expression — the `hole()` convention
    //   3. a bare statement block, with `return` allowed inside
    //
    // Shapes 1 and 2 are the same body with different packaging: a function
    // expression, called with the context. Shape 3 is the body itself.
    const candidates = [];
    const head = trimmed.replace(/^(?:\s*\/\/[^\n]*\n|\s*\/\*[\s\S]*?\*\/\s*)+/, '');
    const exported = head.match(/^export\s+default\s+/);
    if (exported) {
      const offset = trimmed.length - head.length + exported[0].length;
      candidates.push(trimmed.slice(offset).replace(/;\s*$/, ''));
    }
    candidates.push(trimmed);

    // Shape 1/2: a function expression, CALLED with the context. The call
    // must live inside the arrow body — `( SRC )(ctx)` outside it evaluates
    // to the function itself, which then stringifies into the stage's
    // "result" and looks like it silently worked.
    //
    // The stage function receives `(ctx, dsh)` — the run's context, and the
    // facade it may use (phase, log, report, agent, world, files, git).
    // The legacy path passes the facade the same way, as the second
    // argument.
    for (const src of candidates) {
      try {
        const fn = new AsyncFunction('ctx', 'dsh', `return (async () => ( ${src} )(ctx, dsh))();`);
        return await fn(ctx, this.#stageFacade(s));
      } catch (err) {
        if (err instanceof SyntaxError) continue;
        throw err;
      }
    }

    // Shape 3: a bare statement block. `return` is allowed inside it.
    const fn = new AsyncFunction('ctx', 'dsh', `return (async () => {\n${trimmed}\n})();`);
    return fn(ctx, this.#stageFacade(s));
  }

  /**
   * The facade an engine run's stage sees.
   *
   * The stage gets the run's own capabilities: its agents, its world reads,
   * its command allow-list. They are the host's, so they are handed over
   * directly rather than proxied through the sandbox.
   *
   * @param {object} s - the run state
   * @returns {object}
   */
  #stageFacade(s) {
    const world = this.#engineWorld(s.runId);
    return {
      phase: (name) => this.#enterPhase(s.runId, String(name ?? '')),
      log: (message, level) => this.#appendLog(s.runId, level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info', String(message ?? '')),
      report: (item, artifactId) => this.#recordReport(s.runId, item, artifactId ?? null),
      agent: (name, persona) => this.#engineStageAgent(s, name, persona),
      // The world ops take their arguments as a POSITIONAL array, the same
      // shape the engine's worldRead channel passes them in.
      world: {
        run: (cmd, args, opts) => {
          // A command can write to the workspace, and this write happens on
          // the HOST side — the engine does not see it, so the engine cannot
          // close its import cache for it.
          //
          // The route is the ENGINE's own `worldRead`, not the host's world
          // op: a live `world.run` closes the import cache before it is
          // dispatched (upstream: engine-world.ts, `closeImportCache(...,
          // "world-run")`), and a write that skipped that would leave a
          // stale cache open — a cached answer about a world that no longer
          // exists.
          const engine = this._engineControls.get(s.runId);
          if (engine !== undefined) {
            return engine.worldRead('world-read#stage', 'run', [cmd, args ?? [], opts ?? {}]);
          }
          this.#reportEngineMutation(s.runId);
          return world.run([cmd, args ?? [], opts ?? {}]);
        },
      },
      files: {
        read: (p) => world.read([p]),
        glob: (p) => world.glob([p]),
        grep: (p, g) => world.grep([p, g]),
      },
      git: {
        changedFiles: (base) => world['git-changed-files'](base === undefined ? [] : [base]),
        diff: (base, path) => world['git-diff']([base, path]),
        status: () => world['git-status']([]),
        log: (count) => world['git-log'](count === undefined ? [] : [count]),
      },
      models: Array.from(s.modelsAllowed || []),
      constants: { rpcVersion: 7, artifactKinds: { declare: ['chart', 'table', 'metrics', 'board'], publish: ['markdown', 'file'] } },
    };
  }

  /**
   * The `agent` handle a stage sees.
   *
   * The stage shares the run's agents — that is the point of a structural
   * amend — so the handle is the same one the run's own asks use.
   *
   * @param {object} s - the run state
   * @param {string} name
   * @param {object|string} persona
   * @returns {object}
   */
  #engineStageAgent(s, name, persona) {
    const agentName = typeof name === 'string' && name.trim() ? name.trim() : 'stage-agent';
    const system = typeof persona === 'string' ? persona : (persona && persona.system) || undefined;
    return {
      async ask(instructions, opts) {
        const result = await this.#engineStageAsk(s, agentName, system, String(instructions ?? ''));
        return result;
      },
    };
  }

  /**
   * One model turn for a stage.
   *
   * @param {object} s
   * @param {string} name
   * @param {string|undefined} system
   * @param {string} instructions
   * @returns {Promise<{content: string, usage: object}>}
   */
  async #engineStageAsk(s, name, system, instructions) {
    // The stage's ask goes through the same model path the run's own asks
    // do, so it costs the same and is audited the same way.
    const model = Array.from(s.modelsAllowed || [])[0] || 'deepseek-chat';
    const messages = [];
    if (system) messages.push({ role: 'system', content: system });
    messages.push({ role: 'user', content: instructions });
    const result = await this.chat({ messages, model, maxTokens: undefined, responseFormat: null, timeoutMs: 300_000 }, this.ctx);
    const content = result?.content || '';
    this.#journalPush(s, s.runId, {
      kind: 'agent.ask',
      name,
      promptPreview: instructions.slice(0, 200),
      typed: false,
      usage: result?.usage || null,
    });
    return { content, usage: result?.usage || {} };
  }

  /** Stages recorded for a run (durable view, also used by /api/state). */
  listInjectedStages(runId) {
    const s = this.runs.get(runId);
    if (!s) return [];
    // The facade calls a stage's id `id`; the run record calls it `stageId`.
    // Both are handed out, so a script reading `stage.id` and a tool
    // reading `stage.stageId` see the same value.
    return s.injectedStages.map((x) => ({ ...x, id: x.stageId }));
  }

  /** Stop a run. SIGTERM with 2s grace, then SIGKILL. */
  stop(runId) {
    const s = this.runs.get(runId);
    if (!s) return false;
    if (s.status === 'completed' || s.status === 'error' || s.status === 'stopped') return true;
    s._stopRequested = true;
    if (s._engineAbort) {
      // The engine path has no child of ours to signal: the abort
      // signal IS the harness's cancellation channel, and it tears the
      // child down and settles the run.
      try { s._engineAbort.abort(); } catch (_) {}
      this.#appendLog(runId, 'info', 'stop requested');
      return true;
    }
    try { s.child.kill('SIGTERM'); } catch (_) {}
    setTimeout(() => {
      const cur = this.runs.get(runId);
      if (cur && (cur.status === 'running' || cur.status === 'starting')) {
        try { cur.child.kill('SIGKILL'); } catch (_) {}
      }
    }, 2000);
    this.#appendLog(runId, 'info', 'stop requested');
    return true;
  }

  /**
   * v0.11.0: the journal replay trail.
   *
   * Each entry carries `live` — true when this run really executed the
   * action, false when it was replayed from `fromRun`. That pair is what
   * the editor's journal panel renders, and what you read to answer
   * "how much of this run was actually paid for?".
   *
   * Large `result` payloads are dropped unless `full` is set: a run that
   * read a 200 KB file should not drag that through the panel on every
   * poll.
   *
   * @param {string} runId
   * @param {{limit?: number, full?: boolean}} [opts]
   */
  journal(runId, opts = {}) {
    const s = this.runs.get(runId);
    if (!s) return null;
    const limit = Math.min(Math.max(1, Number(opts.limit) || 200), 5000);
    const slice = s.journal.slice(-limit);
    const entries = slice.map((e) => {
      const out = {
        at: e.at,
        kind: e.kind,
        live: e.live !== false,
        fromRun: e.fromRun || null,
      };
      if (e.kind === 'agent.ask') {
        out.name = e.name;
        out.promptPreview = String(e.prompt || '').slice(0, 200);
        out.typed = !!e.typed;
        out.usage = e.usage || null;
      } else if (e.kind === 'world.run') {
        out.cmd = e.cmd;
        out.argCount = Array.isArray(e.args) ? e.args.length : 0;
        out.exitCode = e.result ? e.result.exitCode : null;
      } else {
        out.label = e.pattern || e.path || e.base || e.count || e.kind;
      }
      if (opts.full) out.result = e.result === undefined ? null : e.result;
      return out;
    });
    return {
      runId,
      total: s.journal.length,
      trimmed: s.journalTrimmed || 0,
      cacheOpen: !!s.cacheOpen,
      journalImportDepth: s.journalImportDepth || 0,
      amendFrom: s.amendFrom || null,
      entries,
    };
  }

  /** Snapshot the run (HTTP /api/state)。 */
  snapshot(runId, opts = {}) {
    const s = this.runs.get(runId);
    if (!s) return null;
    return {
      runId,
      scriptPath: s.scriptPath,
      status: s.status,
      startedAt: s.startedAt,
      endedAt: s.endedAt,
      exitCode: s.exitCode,
      currentPhase: s.currentPhase,
      // `phases` keeps the full call log (every phase() call, for the event log);
      // `phaseSummary` is the deduped view the UI pills render (ZCode-style: same
      // name in a loop is one node, not N).
      phases: s.phases,
      phaseSummary: Array.from(s.phaseSummary.values()),
      log: s.log.slice(-2000),
      reports: s.reports,
      artifacts: Array.from(s.artifacts.values()).map((a) => ({
        id: a.id, kind: a.kind, spec: a.spec || null,
        title: a.title || null, description: a.description || null, primary: !!a.primary,
        versions: a.versions,
      })),
      worldRunAllowlist: s.worldRunAllowlist ? Array.from(s.worldRunAllowlist) : null,
      worldRunDeclined: s.worldRunDeclined,
      workspaceRoot: s.workspaceRoot,
      modelsAllowed: Array.from(s.modelsAllowed),
      evalMode: !!s.evalMode,
      pendingQuestions: Array.from(s.pendingQuestions.entries()).map(([id, q]) => ({
        questionId: id, question: q.question, kind: q.kind, options: q.options, askedAt: q.askedAt,
      })),
      pendingHoles: Array.from(s.pendingHoles.entries()).map(([id, h]) => ({
        holeId: id, name: h.name, prompt: h.prompt, hasContext: h.hasContext, askedAt: h.askedAt,
      })),
      pendingEscalates: Array.from(s.pendingEscalates.entries()).map(([id, e]) => ({
        escalateId: id, question: e.question, kind: e.kind, options: e.options, askedAt: e.askedAt,
      })),
      agents: s.agentsOrder.map((n) => {
        const a = s.agents.get(n);
        return {
          name: a.name,
          system: a.system,
          model: a.model,
          asks: a.asks,
          lastTokens: a.lastTokens,
          lastDurationMs: a.lastDurationMs,
        };
      }),
      // v0.10.0: structural-amend view. `body` is included so the
      // editor can show what was injected; it never leaves the host.
      injectedStages: (s.injectedStages || []).map((x) => ({ ...x })),
      // v0.11.0: amend cache state. Always included (it is tiny and the
      // editor badges the run with it); the journal itself is opt-in via
      // `includeJournal` because it can be thousands of entries.
      cacheOpen: !!s.cacheOpen,
      journalImportDepth: s.journalImportDepth || 0,
      journalLength: s.journal.length,
      journalTrimmed: s.journalTrimmed || 0,
      // v0.12.0: concurrency telemetry — how close the run got to its cap.
      concurrency: s.concurrency ? {
        maxConcurrent: s.concurrency.maxConcurrent,
        peak: s.concurrency.peak,
        waiting: s.concurrency.waiting,
        active: s.concurrency.semaphore ? s.concurrency.semaphore.active : 0,
        totalAcquired: s.concurrency.semaphore ? s.concurrency.semaphore.totalAcquired : 0,
      } : null,
      ...(opts && opts.includeJournal ? { journal: s.journal.slice(-(Number(opts.journalLimit) || 200)) } : {}),
      // The engine path's report: what the compile step found, and the
      // four graphs the editor draws. Absent on the child-process path.
      ...(s._engine
        ? {
            engine: {
              diagnostics: s._engine.diagnostics || [],
              graphs: s._engine.graphs || null,
              sizes: (s._engine.graphs && s._engine.graphs.sizes) || null,
              settlement: s._engine.settlement
                ? {
                    status: s._engine.settlement.status,
                    artifact: s._engine.settlement.artifact,
                    error: s._engine.settlement.error,
                  }
                : null,
            },
          }
        : {}),
    };
  }

  /**
   * Subscribe to live events. `cb({event,...payload})`.
   * @returns {() => void}
   */
  subscribe(runId, cb) {
    const s = this.runs.get(runId);
    if (!s) return () => {};
    s.subscribers.add(cb);
    queueMicrotask(() => {
      try { cb({ event: 'hello', runId, snapshot: this.snapshot(runId) }); } catch (_) {}
    });
    return () => s.subscribers.delete(cb);
  }

  /** List all known run ids + summary. */
  listRuns() {
    return Array.from(this.runs.values()).map((s) => ({
      runId: s.runId,
      scriptPath: s.scriptPath,
      status: s.status,
      startedAt: s.startedAt,
      endedAt: s.endedAt,
    }));
  }

  // ---------- private ----------

  /**
   * v0.7.1: Compile a `.ts` script to plain `.mjs` in a tmp dir using the
   * `typescript` package's CLI, and return the compiled path + an async
   * cleanup callback (used by #setStatus on terminal states).
   *
   * Implemented as a non-`#` method so V8's parse-time private-name
   * check doesn't trip on the forward reference from `start()` —
   * underscored methods bypass that check entirely.
   *
   * @param {string} absScript
   * @returns {Promise<{absJsPath: string, cleanup: () => Promise<void>}>}
   */
  async _transpileTs(absScript) {
    // Locate the typescript package relative to *this* file so we don't
    // depend on global PATH. createRequire(import.meta.url) lets us
    // resolve a sibling package the same way Node's own loader does.
    let tscPath;
    try {
      const req = createRequire(import.meta.url);
      tscPath = req.resolve('typescript/bin/tsc');
    } catch (_) {
      const err = new Error(
        'TypeScript support requires the `typescript` package. ' +
        'Install it with: npm install --save-dev typescript'
      );
      err.code = 'TS_MISSING_DEP';
      throw err;
    }

    // Per-run tmp dir under os.tmpdir()/dsh-workflow-ts/<runId>. We do
    // NOT use crypto.randomUUID() here because start() hasn't decided on
    // a runId yet at some call sites — but for the standalone API,
    // start() runs before us, so we can rely on crypto.randomUUID().
    const { mkdtemp, writeFile: fsWriteFile, mkdir: fsMkdir, copyFile: fsCopyFile, readdir: fsReaddir, stat: fsStat } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const tmpRoot = join(tmpdir(), 'dsh-workflow-ts');
    // Ensure the parent exists — `mkdtemp` on Windows refuses a missing
    // directory even though POSIX silently creates the prefix.
    await fsMkdir(tmpRoot, { recursive: true });
    const tmpDir = await mkdtemp(join(tmpRoot, 'run-'));

    // Drop a tiny package.json so Node treats the compiled .js files
    // as ESM (in a directory without one, .js defaults to CJS).
    await fsWriteFile(join(tmpDir, 'package.json'), '{"type":"module"}\n');
    // v0.8.0: also drop the ambient facade so the emit pass sees
    // the same declarations the typecheck pass did. The facade is
    // present in the host at `<plugin lib>/facade.d.ts`.
    try {
      const facadeSrc = await readFile(resolvePath(fileURLToPath(import.meta.url), '..', 'facade.d.ts'), 'utf8');
      await fsWriteFile(join(tmpDir, '__dsh_facade__.d.ts'), facadeSrc);
    } catch (_) {
      // facade.d.ts missing — emit still works without the ambient
      // types; the user will get implicit-any errors instead of typed
      // errors. Not fatal for emit.
    }

    // Copy the source file (and any sibling .ts files in its directory,
    // since relative imports like `./typed-shapes` need to resolve
    // during the compile) into tmpDir. Then tsc treats tmpDir as the
    // rootDir and emits flat outputs into outDir.
    //
    // Without this copy, tsc would compute rootDir from the absolute
    // source path and produce output paths like
    //   <tmpDir>/D:/ZcodeStorage/.../samples/typed-minimal.js
    // which Node's path parser can't open.
    const { basename, extname, dirname: dn } = await import('node:path');
    const srcBase = basename(absScript, extname(absScript));
    const srcDir = dn(absScript);
    const srcExt = extname(absScript);
    const localTs = (await fsReaddir(srcDir))
      .filter((n) => n.endsWith('.ts') || n.endsWith('.mts'));
    for (const f of localTs) {
      await fsCopyFile(join(srcDir, f), join(tmpDir, f));
    }
    // Copy the entry script too if it wasn't in the local listing
    // (e.g., it's the only .ts in its folder — should already be in
    // localTs but be defensive).
    if (!localTs.includes(srcBase + srcExt)) {
      await fsCopyFile(absScript, join(tmpDir, srcBase + srcExt));
    }
    const entryInTmp = join(tmpDir, srcBase + srcExt);
    const outAbs = join(tmpDir, srcBase + '.js');

    // v0.8.0: write a tsconfig that includes the ambient facade in
    // `files` so the emit pass sees the same declarations the
    // typecheck pass did. Using `--project` is also the only way to
    // get `files` (not `include`) into tsc's program — inline CLI
    // flags don't pick up co-located `.d.ts` files.
    const tsconfigPath = join(tmpDir, 'tsconfig.json');
    await fsWriteFile(tsconfigPath, JSON.stringify({
      compilerOptions: {
        target: 'es2022',
        module: 'esnext',
        moduleResolution: 'bundler',
        skipLibCheck: true,
        esModuleInterop: true,
        allowJs: false,
        strict: true,
        declaration: false,
        sourceMap: false,
        noEmitOnError: true,
        outDir: tmpDir,
        rootDir: tmpDir,
        noUncheckedIndexedAccess: false,
        exactOptionalPropertyTypes: false,
        noImplicitOverride: false,
        noFallthroughCasesInSwitch: false,
      },
      files: ['__dsh_facade__.d.ts', srcBase + srcExt],
    }, null, 2));

    await new Promise((resolve, reject) => {
      const args = [
        tscPath,
        '--project', tsconfigPath,
      ];
      const child = spawn(this.nodeBin, args, {
        cwd: tmpDir,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderr = '';
      let stdout = '';
      const ro = createInterface({ input: child.stdout });
      ro.on('line', (line) => { stdout += line + '\n'; });
      const re = createInterface({ input: child.stderr });
      re.on('line', (line) => { stderr += line + '\n'; });
      const timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch (_) {}
        const e = new Error('tsc compile timeout after 30s');
        e.code = 'TS_COMPILE_TIMEOUT';
        reject(e);
      }, 30_000);
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else {
          const e = new Error(
            `tsc compile failed (exit ${code})\n${stderr || stdout}`
          );
          e.code = 'TS_COMPILE_FAIL';
          reject(e);
        }
      });
    });

    const cleanup = async () => {
      try { await fsPromisesRm(tmpDir, { recursive: true, force: true }); }
      catch (_) { /* best-effort */ }
    };
    return { absJsPath: outAbs, cleanup };
  }

  /**
   * v0.8.0: Run `tsc --noEmit --strict` against the user's `.ts` script
   * plus its sibling `.ts`/`.mts` files and the ambient facade
   * (`lib/facade.d.ts` copied as `__dsh_facade__.d.ts`). Returns the
   * parsed `Diagnostic[]` if there are any; throws with
   * `code: 'TS_TYPECHECK'` and a `diagnostics` array attached.
   *
   * Non-`#` method so V8's parse-time private-name check doesn't trip
   * on the call from `start()` — same workaround as `_transpileTs`.
   *
   * @param {string} absScript
   * @returns {Promise<{diagnostics: Array<{file:string,line:number,column:number,code:string,message:string}>}>}
   */
  async _typecheckTs(absScript) {
    let tscPath;
    try {
      const req = createRequire(import.meta.url);
      tscPath = req.resolve('typescript/bin/tsc');
    } catch (_) {
      const err = new Error(
        'TypeScript support requires the `typescript` package. ' +
        'Install it with: npm install --save-dev typescript'
      );
      err.code = 'TS_MISSING_DEP';
      throw err;
    }

    const { mkdtemp, writeFile: fsWriteFile, mkdir: fsMkdir, copyFile: fsCopyFile, readdir: fsReaddir, rm: fsPromisesRm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const tmpRoot = join(tmpdir(), 'dsh-workflow-ts');
    await fsMkdir(tmpRoot, { recursive: true });
    const tmpDir = await mkdtemp(join(tmpRoot, 'check-'));

    // Drop the ambient facade + package.json so the .ts/.d.ts files
    // tsc loads form a coherent program.
    try {
      const facadeSrc = await readFile(resolvePath(fileURLToPath(import.meta.url), '..', 'facade.d.ts'), 'utf8');
      await fsWriteFile(join(tmpDir, '__dsh_facade__.d.ts'), facadeSrc);
    } catch (_) {
      // facade.d.ts missing — treat as if typecheck is not configured.
      const err = new Error('lib/facade.d.ts missing; cannot typecheck.');
      err.code = 'TS_FACADE_MISSING';
      throw err;
    }
    await fsWriteFile(join(tmpDir, 'package.json'), '{"type":"module"}\n');

    // Copy the entry + sibling .ts/.mts so relative imports resolve.
    const { basename, extname, dirname: dn } = await import('node:path');
    const srcBase = basename(absScript, extname(absScript));
    const srcExt = extname(absScript);
    const srcDir = dn(absScript);
    const entryInTmp = join(tmpDir, srcBase + srcExt);
    if (!existsSync(srcDir)) {
      const err = new Error(`source directory missing: ${srcDir}`);
      err.code = 'TS_SOURCE_MISSING';
      throw err;
    }
    const localTs = (await fsReaddir(srcDir))
      .filter((n) => n.endsWith('.ts') || n.endsWith('.mts'));
    for (const f of localTs) {
      await fsCopyFile(join(srcDir, f), join(tmpDir, f));
    }
    if (!localTs.includes(srcBase + srcExt)) {
      await fsCopyFile(absScript, entryInTmp);
    }

    // tsconfig.json wires the facade as part of the program (`files`)
    // and pins our strict-but-pragmatic compiler options.
    //
    // We deliberately do NOT include sibling `.ts` files in `files` —
    // tsc follows the entry's import graph on its own, so only files
    // the entry actually imports get checked. Adding siblings
    // explicitly would typecheck them even if the entry never touches
    // them, which is wrong for samples/ (where multiple .ts scripts
    // sit side by side: typecheck-fail.ts and typecheck-ok.ts must
    // be checked in isolation).
    const tsconfigPath = join(tmpDir, 'tsconfig.json');
    await fsWriteFile(tsconfigPath, JSON.stringify({
      compilerOptions: {
        target: 'es2022',
        module: 'esnext',
        moduleResolution: 'bundler',
        skipLibCheck: true,
        esModuleInterop: true,
        allowJs: false,
        strict: true,
        noEmit: true,
        noUncheckedIndexedAccess: false,
        exactOptionalPropertyTypes: false,
        noImplicitOverride: false,
        noFallthroughCasesInSwitch: false,
      },
      files: ['__dsh_facade__.d.ts', srcBase + srcExt],
    }, null, 2));
    let stderr = '';
    let stdout = '';
    await new Promise((resolve, reject) => {
      const args = [tscPath, '--project', tsconfigPath];
      const child = spawn(this.nodeBin, args, {
        cwd: tmpDir,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const ro = createInterface({ input: child.stdout });
      ro.on('line', (line) => { stdout += line + '\n'; });
      const re = createInterface({ input: child.stderr });
      re.on('line', (line) => { stderr += line + '\n'; });
      const timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch (_) {}
        const e = new Error('tsc typecheck timeout after 30s');
        e.code = 'TS_COMPILE_TIMEOUT';
        reject(e);
      }, 30_000);
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });

    // Best-effort cleanup; tmp dirs are cheap but no reason to leak.
    fsPromisesRm(tmpDir, { recursive: true, force: true }).catch(() => { /* best-effort */ });

    const diagnostics = this._parseTypecheckOutput(stderr + '\n' + stdout);
    if (diagnostics.length > 0) {
      const formatted = this._formatTypecheckErrors(diagnostics);
      const err = new Error(
        `TS typecheck failed (${diagnostics.length} error${diagnostics.length === 1 ? '' : 's'})\n${formatted}`
      );
      err.code = 'TS_TYPECHECK';
      err.diagnostics = diagnostics;
      throw err;
    }
    return { diagnostics };
  }

  /**
   * v0.8.0: Parse tsc's `file(line,col): error TSxxxx: message` lines
   * into structured diagnostics. Lines that don't match the format
   * are ignored (tsc also emits informational lines, headers, etc.).
   * Returns an array, possibly empty.
   *
   * @param {string} output
   * @returns {Array<{file:string,line:number,column:number,code:string,message:string}>}
   */
  _parseTypecheckOutput(output) {
    const diagnostics = [];
    const re = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.+)$/gm;
    let m;
    while ((m = re.exec(output)) !== null) {
      diagnostics.push({
        file: m[1],
        line: Number(m[2]),
        column: Number(m[3]),
        code: m[4],
        message: m[5].trim(),
      });
    }
    return diagnostics;
  }

  /** v0.8.0: Render diagnostics back into the human-friendly format. */
  _formatTypecheckErrors(diagnostics) {
    return diagnostics.map((d) =>
      `${d.file}(${d.line},${d.column}): error ${d.code}: ${d.message}`
    ).join('\n');
  }

  /**
   * v0.9.0: Strip API keys, OAuth tokens, cloud creds, and DSH
   * bookkeeping from the env that the workflow child will see.
   * The default allow/deny lists come from
   * DEFAULT_ENV_ALLOWLIST / DEFAULT_ENV_DENYLIST at the top of
   * this file; the caller can pass overrides from
   * `Config.sandbox` or per-run `args.sandbox`.
   *
   * Returns `{ env, stripped, strippedKeys }` where `env` is the
   * scrubbed object, `stripped` is the count of keys removed, and
   * `strippedKeys` is the array of names for the run log.
   *
   * Rules:
   *   1. Anything matching the denylist regexes is removed.
   *   2. Anything starting with `DSH_WORKFLOW_` is preserved (the
   *      host's per-run handoff channel).
   *   3. Otherwise, only keys in the allowlist are preserved.
   *   4. Empty values are also dropped (an explicit empty `=`
   *      would otherwise still leak the key name).
   */
  _scrubChildEnv(allowlist, denylist, env) {
    const allow = new Set(allowlist);
    const deny = denylist.map((p) => new RegExp(p, 'i'));
    const out = {};
    const strippedKeys = [];
    for (const [k, v] of Object.entries(env || {})) {
      if (deny.some((r) => r.test(k))) {
        strippedKeys.push(k);
        continue;
      }
      if (k.startsWith('DSH_WORKFLOW_')) {
        out[k] = v;
        continue;
      }
      if (allow.has(k)) out[k] = v;
    }
    return { env: out, stripped: strippedKeys.length, strippedKeys };
  }

  #isScriptAllowed(p) {
    if (!this.scriptsRoot || this.scriptsRoot.length === 0) return true;
    const abs = resolvePath(p);
    return this.scriptsRoot.some((root) => {
      const r = resolvePath(root);
      return abs === r || abs.startsWith(r + PATH_SEP);
    });
  }

  /**
   * v0.10.0: fire a host→child request. The child answers with a
   * `{hostId, result|error}` line, matched back to the run's pending
   * stage calls in #onChildLine. Returns the hostId that was used.
   *
   * Note this is a distinct wire shape from `{id, …}`: `id` is the
   * child's request namespace, `hostId` is ours, so the two directions
   * can never be mistaken for each other on a shared stdout pipe.
   */
  #hostCall(runId, method, params) {
    const s = this.runs.get(runId);
    if (!s || !s.child || s.child.exitCode !== null) return null;
    const hostId = s._nextHostId++;
    try {
      s.child.stdin.write(JSON.stringify({ hostId, method, params }) + '\n');
    } catch (_) {
      this.#appendLog(runId, 'error', `structural amend: child stdin unavailable for ${method}`);
      return null;
    }
    return hostId;
  }

  /**
   * v0.11.0: walk the amendFrom chain looking for a journal entry that
   * satisfies `predicate`. Nearest ancestor first, up to
   * `Config.amend.maxChainDepth` hops.
   *
   * We walk rather than bulk-copying the ancestor journals into this
   * run's own journal on purpose. A copied journal would make `find`
   * return the OLDEST entry for a key while freshly-appended entries
   * sit at the tail — so a key that was amended twice would replay the
   * stale answer. Taking the LAST match per journal, then falling
   * through to the next ancestor, keeps "most recent wins" honest.
   *
   * @returns {{entry: object, fromRun: string} | null}
   */
  #lookupAmendChain(s, kind, predicate) {
    const limit = (this.amend && this.amend.maxChainDepth) || DEFAULT_AMEND_MAX_CHAIN;
    let cursor = s.amendFrom;
    let hops = 0;
    while (cursor && hops < limit) {
      const prev = this.runs.get(cursor);
      if (!prev || !Array.isArray(prev.journal)) break;
      let found = null;
      for (const e of prev.journal) {
        if (e && e.kind === kind && predicate(e)) found = e;
      }
      if (found) return { entry: found, fromRun: cursor };
      cursor = prev.amendFrom;
      hops += 1;
    }
    return null;
  }

  /**
   * v0.11.0: journal bookkeeping for one amendable action.
   *
   * `live: true`    — this entry was actually executed in THIS run.
   * `live: false`   — replayed from an ancestor run's journal; the
   *                   matching entry was never re-executed here.
   * `fromRun`       — which ancestor the cached value came from.
   *
   * The distinction is load-bearing: the journal replay-trail panel in
   * the editor renders live entries red and replays grey, and it can
   * only do that if the two are never conflated. Before v0.11.0 an
   * imported entry carried the ancestor's `live: true`, so everything
   * in an amended run rendered as if it had really run.
   *
   * Pushing an entry also closes the amend cache (unless
   * `Config.amend.autoCloseOnWrite` is off): once this run has done
   * something live, later calls must not be answered from a stale
   * ancestor journal.
   */
  #journalPush(s, runId, entry) {
    const live = entry.live !== false;
    s.journal.push({ at: Date.now(), live, ...entry });
    if (s.journal.length > JOURNAL_MAX_ENTRIES) {
      const drop = s.journal.length - JOURNAL_MAX_ENTRIES;
      s.journal.splice(0, drop);
      s.journalTrimmed = (s.journalTrimmed || 0) + drop;
    }
    // Closing the cache on a live `agent.ask` is too blunt, and measurably
    // so: editing the FIRST prompt of a workflow would then make every
    // LATER ask run live too, zeroing out the reuse amend exists to
    // provide. The stated reason for closing at all is "don't answer from
    // a stale ancestor journal once this run has mutated the workspace" —
    // and an LLM call does not mutate the workspace. Replaying a
    // byte-identical prompt is exactly what the user wants, and it is
    // sound now that a cache hit rebuilds the agent's history.
    //
    // So the close is scoped to `world.run`, the only cacheable kind that
    // can actually invalidate a cached result.
    if (live && entry.kind === 'world.run'
        && s.cacheOpen && this.amend && this.amend.autoCloseOnWrite !== false) {
      s.cacheOpen = false;
      this.#appendLog(runId, 'info',
        'amend cache closed (this run ran a live shell command — later results may not reflect the workspace it left)');
      this.#broadcast(runId, { event: 'cache.closed', at: Date.now() });
    }
  }

  /** v0.10.0: the run's user-facing args, for injected-stage context. */
  #serializeArgs(s) {
    try {
      const raw = s.sandboxedChildEnv && s.sandboxedChildEnv.DSH_WORKFLOW_ARGS;
      const parsed = raw ? JSON.parse(raw) : {};
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (_) { return {}; }
  }

  #onChildLine(runId, line) {
    const s = this.runs.get(runId);
    if (!s || !line) return;
    let msg;
    try { msg = JSON.parse(line); }
    catch (_) {
      this.#appendLog(runId, 'debug', '[non-json] ' + line.slice(0, 400));
      return;
    }
    if (msg && typeof msg.id === 'number') {
      // child-initiated call: id + method + params → dispatch + respond via stdin
      if (typeof msg.method === 'string') {
        // v0.4.0: question.ask is special — it parks the RPC instead of
        // responding, and the answer comes back through /api/question-answer
        // which writes to stdin directly. The default auto-respond path
        // would unblock the rpc Promise immediately, which we don't want.
        if (msg.method === 'question.ask') {
          this.#questionAsk(runId, msg);
          return;
        }
        // v0.5.0: same parked-RPC pattern for hole.wait. The body comes
        // back through /api/hole-answer; default respond would unblock
        // the Promise with `undefined`, which we don't want either.
        if (msg.method === 'hole.wait') {
          this.#holeWait(runId, msg);
          return;
        }
        if (msg.method === 'escalate.ask') {
          this.#escalateAsk(runId, msg);
          return;
        }
        this.#handleChildCall(runId, msg).catch((err) => {
          this.#respondChild(runId, msg.id, null, err);
        });
        return;
      }
      // stray response (no host-initiated RPC in v1; could happen if child echoes)
      return;
    }
    if (msg && typeof msg.hostId === 'number') {
      // v0.10.0: reply to one of OUR host→child requests. The ack for
      // `stage.inject` carries `{accepted, stageId}`; an error here
      // means the child refused (e.g. the run finished first), so we
      // settle the waiting caller and mark the record failed. The child
      // echoes `stageId` back on error so we can correlate — without it
      // a `wait: true` caller would hang until its ceiling.
      if (!msg.error) return;                       // plain ack; keep waiting
      const stageId = typeof msg.stageId === 'string' && msg.stageId
        ? msg.stageId
        : null;
      const errMsg = String(msg.error.message || 'inject failed');
      if (stageId && s.pendingStageCalls.has(stageId)) {
        const waiter = s.pendingStageCalls.get(stageId);
        if (waiter.timer) clearTimeout(waiter.timer);
        s.pendingStageCalls.delete(stageId);
        const rec = s.injectedStages.find((x) => x.stageId === stageId);
        if (rec) { rec.status = 'error'; rec.error = errMsg; rec.endedAt = Date.now(); }
        this.#appendLog(runId, 'error', `stage rejected: ${errMsg}`);
        this.#broadcast(runId, { event: 'stage.finished', stageId, status: 'error', error: errMsg, at: Date.now() });
        waiter.reject(new Error(errMsg));
      } else {
        // Uncorrelated child error — still visible in the log, but there
        // is no waiter to release.
        this.#appendLog(runId, 'error', `stage inject failed: ${errMsg}`);
      }
      return;
    }
    if (msg && msg.notify) {
      this.#appendNotify(runId, msg);
      return;
    }
    this.#appendLog(runId, 'debug', '[unparsed] ' + line.slice(0, 400));
  }

  async #handleChildCall(runId, msg) {
    try {
      const result = await this.#dispatch(runId, msg.method, msg.params);
      this.#respondChild(runId, msg.id, result, null);
    } catch (err) {
      this.#respondChild(runId, msg.id, null, err);
    }
  }

  #respondChild(runId, id, result, error) {
    const s = this.runs.get(runId);
    if (!s || s.child.exitCode !== null) return;
    const out = error
      ? { id, error: { message: String(error && error.message || error) } }
      : { id, result };
    try {
      s.child.stdin.write(JSON.stringify(out) + '\n');
    } catch (_) { /* child closed stdin */ }
  }

  #dispatch(runId, method, params) {
    const s = this.runs.get(runId);
    if (!s) throw new Error('unknown run: ' + runId);
    if (method === 'agent.ask') return this.#agentAsk(runId, params);
    if (method === 'agent.close') return Promise.resolve({ closed: (params && params.name) || true });
    if (method === 'world.run') return this.#worldRun(runId, params);
    if (method === 'phase') {
      this.#enterPhase(runId, String((params && params.name) || ''));
      return Promise.resolve({ ok: true });
    }
    if (method === 'log') {
      const message = String((params && params.message) || '');
      const level = (params && params.level) || 'info';
      this.#appendLog(runId, level, message);
      return Promise.resolve({ ok: true });
    }
    if (method === 'concurrency.stat') {
      // v0.12.0: the host's authoritative view of the limiter. A script
      // measuring "asks in flight" from the outside over-counts, because
      // time spent WAITING for a slot is not time spent holding one.
      const sem = s.concurrency && s.concurrency.semaphore;
      return Promise.resolve({
        limit: s.concurrency ? s.concurrency.maxConcurrent : 0,
        active: sem ? sem.active : 0,
        peak: sem ? sem.peak : 0,
        waiting: sem ? sem.waiting : 0,
        totalAcquired: sem ? sem.totalAcquired : 0,
        totalWaitMs: sem ? sem.totalWaitMs : 0,
      });
    }
    if (method === 'channel.deadlock') {
      // v0.12.0: a channel deadlock is a FAIL, not a stall (ZCode §16.3).
      // The child detected that the producer is gone but the channel was
      // never closed, leaving a consumer blocked forever.
      const p = params || {};
      const name = String(p.name || '(unnamed)');
      const waiters = Number(p.waiters) || 0;
      const reason = String(p.reason || 'producer finished without closing the channel');
      const message = `[ChannelDeadlock] channel '${name}': ${reason}; ${waiters} consumer(s) still waiting`;
      this.#appendLog(runId, 'error', message);
      this.#broadcast(runId, {
        event: 'channel.deadlock',
        channel: { name, waiters, reason },
        at: Date.now(),
      });
      // Mark the run as deadlocked. exitCode is pinned to -1 so the
      // failure is distinguishable from an ordinary script error, and
      // #onChildExit will not overwrite it.
      s._deadlocked = { channel: name, waiters, reason };
      s.exitCode = -1;
      this.#setStatus(runId, 'error');
      // The child is blocked on a promise that will never settle —
      // terminate it rather than waiting for the 30-minute watchdog.
      try { if (s.child) s.child.kill('SIGTERM'); } catch (_) {}
      return Promise.resolve({ ok: false, deadlocked: true, channel: name });
    }
    if (method === 'report') {
      const item = (params && params.item);
      const tag = (params && params.tag) || null;
      const artifactId = this.#recordReport(runId, item, tag);
      return Promise.resolve({ ok: true, artifactId });
    }
    if (method === 'artifact.declare') return this.#artifactDeclare(runId, params);
    if (method === 'artifact.publish') return this.#artifactPublish(runId, params);
    if (method === 'files.glob')   return this.#filesGlob(runId, params);
    if (method === 'files.read')   return this.#filesRead(runId, params);
    if (method === 'files.grep')   return this.#filesGrep(runId, params);
    if (method === 'git.changedFiles') return this.#gitChangedFiles(runId, params);
    if (method === 'git.diff')         return this.#gitDiff(runId, params);
    if (method === 'git.status')       return this.#gitStatus(runId, params);
    if (method === 'git.log')          return this.#gitLog(runId, params);
    return Promise.reject(new Error('unknown rpc method: ' + method));
  }

  #artifactDeclare(runId, params) {
    const s = this.runs.get(runId);
    if (!s) throw new Error('unknown run');
    const id = String((params && params.id) || '');
    const kind = String((params && params.kind) || '');
    const spec = (params && params.spec) || {};
    if (!id) throw new Error('artifact.declare: id required');
    if (!['chart', 'table', 'metrics', 'board'].includes(kind)) {
      throw new Error('artifact.declare: kind must be chart/table/metrics/board, got ' + kind);
    }
    if (s.artifacts.has(id)) {
      const existing = s.artifacts.get(id);
      // Re-declaring the same id with the same spec is a no-op (lets the host
      // tolerate accidental re-declarations from a re-runs). Different spec =
      // error, because mixing two specs under one id is almost always a bug.
      if (existing.kind !== kind) {
        throw new Error(`artifact.declare: id '${id}' already declared as ${existing.kind}, not ${kind}`);
      }
      return { ok: true, noop: true };
    }
    s.artifacts.set(id, {
      id, kind, spec, title: null, description: null, primary: false,
      versions: [],
    });
    this.#broadcast(runId, { event: 'artifact.declare', id, kind, spec });
    return { ok: true };
  }

  #artifactPublish(runId, params) {
    const s = this.runs.get(runId);
    if (!s) throw new Error('unknown run');
    const id = String((params && params.id) || '');
    const kind = String((params && params.kind) || '');
    if (!id) throw new Error('artifact.publish: id required');
    if (!['markdown', 'file'].includes(kind)) {
      throw new Error('artifact.publish: kind must be markdown/file, got ' + kind);
    }
    // 20MiB / 256KB caps mirror ZCode's. We already have text in hand here
    // (the child reads files before sending), so the size check is cheap.
    if (kind === 'markdown') {
      const text = String((params && params.content) || '');
      if (text.length > 256 * 1024) throw new Error('artifact.publish: markdown content exceeds 256KB cap');
    } else {
      const text = String((params && params.content) || '');
      if (text.length > 20 * 1024 * 1024) throw new Error('artifact.publish: file content exceeds 20MB cap');
    }
    let art = s.artifacts.get(id);
    if (!art) {
      art = { id, kind, spec: null, title: null, description: null, primary: false, versions: [] };
      s.artifacts.set(id, art);
    } else if (art.kind !== kind) {
      throw new Error(`artifact.publish: id '${id}' already declared as ${art.kind}, not ${kind}`);
    }
    const version = art.versions.length + 1;
    const v = {
      version, at: Date.now(),
      content: kind === 'markdown' ? String(params.content || '') : String(params.content || ''),
      contentType: kind === 'file' ? (params.contentType || 'text/plain; charset=utf-8') : 'text/markdown; charset=utf-8',
      filename: kind === 'file' ? (params.filename || null) : null,
    };
    art.versions.push(v);
    art.title = (params && params.title) || art.title;
    art.description = (params && params.description) || art.description;
    if (params && params.primary) art.primary = true;
    this.#broadcast(runId, { event: 'artifact.publish', id, kind, version });
    return { id, version };
  }

  async #agentAsk(runId, params) {
    const s = this.runs.get(runId);
    if (!s) throw new Error('unknown run');
    const { name, system, model, temperature, prompt, askOpts } = params || {};
    if (!name || !prompt) throw new Error('agent.ask: name and prompt are required');

    // model may arrive as either a string or a { __modelRef: true, id } marker
    // produced by globalThis.__dsh.model(id). Resolve the marker; otherwise
    // use the literal as the model id. Either way, validate against this
    // run's modelsAllowed allowlist.
    let resolvedModel = null;
    if (model && typeof model === 'object' && model.__modelRef && typeof model.id === 'string') {
      resolvedModel = model.id;
    } else if (typeof model === 'string' && model) {
      resolvedModel = model;
    }
    if (resolvedModel && !s.modelsAllowed.has(resolvedModel)) {
      throw new Error(`agent.ask: model '${resolvedModel}' is not in this run's modelsAllowed list (allowed: ${Array.from(s.modelsAllowed).join(', ')})`);
    }

    // v0.4.0: resultShape (passed via askOpts.resultShape from the bootstrap
    // forwarding askOpts.result). When set, we ask the LLM for JSON, parse,
    // validate, and return the parsed object as `content`.
    const resultShape = askOpts && askOpts.resultShape;
    const useTyped = resultShape && (typeof resultShape === 'object' || Array.isArray(resultShape) || typeof resultShape === 'string');
    const jsonSchema = useTyped ? this.#shapeToJsonSchema(resultShape) : null;
    const jsonInstruction = jsonSchema
      ? `\n\nYou MUST respond with a single JSON object (no prose, no markdown fences) matching this JSON Schema:\n${JSON.stringify(jsonSchema, null, 2)}`
      : '';

    // v0.11.0: amend cache lookup. Deliberately NOT short-circuiting
    // here — a cache hit still has to rebuild the agent's message
    // history, and that only happens further down, after the agent
    // record exists. Cache key intentionally ignores system / model /
    // temperature / resultShape: if the user changed those they should
    // not be replaying the old answer.
    let amendHit = null;
    let amendHitFrom = null;
    if (s.cacheOpen && s.amendFrom) {
      const found = this.#lookupAmendChain(s, 'agent.ask', (e) => e.name === name && e.prompt === prompt);
      if (found) { amendHit = found.entry; amendHitFrom = found.fromRun; }
    }

    let agent = s.agents.get(name);
    const t0 = Date.now();
    if (!agent) {
      agent = {
        name,
        system: system || 'You are a helpful assistant.',
        model: resolvedModel || 'deepseek-chat',
        temperature: typeof temperature === 'number' ? temperature : undefined,
        messages: [],
        asks: 0,
        lastTokens: null,
        lastDurationMs: null,
        createdAt: Date.now(),
      };
      s.agents.set(name, agent);
      s.agentsOrder.push(name);
      this.#broadcast(runId, {
        event: 'agent.new',
        agent: { name: agent.name, system: agent.system, model: agent.model, createdAt: agent.createdAt },
      });
    } else {
      if (system) agent.system = system;
      if (resolvedModel) agent.model = resolvedModel;
      if (typeof temperature === 'number') agent.temperature = temperature;
    }

    // For typed ask, prepend the schema instruction to the effective system
    // prompt. Don't mutate agent.system (it's reused across asks); instead,
    // build a one-shot messages array.
    let messages;
    if (useTyped) {
      const baseSystem = agent.messages.length > 0 && agent.messages[0].role === 'system'
        ? agent.messages[0].content
        : (system || 'You are a helpful assistant.');
      messages = [
        { role: 'system', content: baseSystem + jsonInstruction },
        ...agent.messages.slice(1),
        { role: 'user', content: prompt },
      ];
    } else {
      if (agent.messages.length === 0) {
        agent.messages.push({ role: 'system', content: agent.system });
      } else if (agent.messages[0].role === 'system' && agent.messages[0].content !== agent.system) {
        agent.messages[0] = { role: 'system', content: agent.system };
      }
      agent.messages.push({ role: 'user', content: prompt });
      messages = agent.messages;
    }

    this.#broadcast(runId, {
      event: 'agent.ask.start',
      name, askIndex: agent.asks, promptPreview: prompt.slice(0, 200), at: Date.now(),
    });

    agent.asks += 1;
    let lastContent = '';

    // v0.11.0: amend cache hit. Reached only AFTER the messages block
    // above ran, which is the whole point: that block has already pushed
    // the system prompt and this ask's user turn onto `agent.messages`.
    // Before v0.11.0 the hit returned much earlier, so a replayed ask
    // left the agent's history empty — and any LATER live ask on the
    // same agent then ran against a blank context, silently producing a
    // different answer than the original run did.
    if (amendHit) {
      const usage = amendHit.usage || null;
      agent.lastTokens = usage;
      agent.lastDurationMs = Date.now() - t0;
      s.lastTokens = usage;
      if (useTyped) {
        // Typed asks build a one-shot message array and never maintain
        // `agent.messages`, so there is no history to rebuild here.
        this.#appendLog(runId, 'info', `agent.ask(${name}): amend replay from ${amendHitFrom}`);
        this.#broadcast(runId, { event: 'agent.ask.cache_hit', name, fromRun: amendHitFrom, at: Date.now() });
        this.#journalPush(s, runId, {
          kind: 'agent.ask', name, prompt, resultShape,
          parsed: amendHit.parsed, usage, typed: true,
          live: false, fromRun: amendHitFrom,
        });
        this.#schedulePersist(runId);
        return { content: amendHit.parsed, usage, typed: true };
      }
      const cached = String(amendHit.content == null ? '' : amendHit.content);
      // Close the loop: push the cached assistant turn so the next ask
      // on this agent sees exactly the history the original run had.
      agent.messages.push({ role: 'assistant', content: cached });
      this.#appendLog(runId, 'info', `agent.ask(${name}): amend replay from ${amendHitFrom}`);
      this.#broadcast(runId, { event: 'agent.ask.cache_hit', name, fromRun: amendHitFrom, at: Date.now() });
      this.#journalPush(s, runId, {
        kind: 'agent.ask', name, prompt,
        content: cached, usage, typed: false,
        live: false, fromRun: amendHitFrom,
      });
      this.#schedulePersist(runId);
      return { content: cached, usage };
    }

    // v0.12.0: concurrency ceiling. Acquired HERE, after the amend cache
    // check — a replayed answer costs nothing at the provider, so it
    // must not occupy a slot and must not make real asks wait.
    //
    // One slot covers the whole ask, including the typed path's
    // internal retry loop: the retries are part of the same provider
    // round-trip budget, not separate calls.
    const sem = s.concurrency && s.concurrency.semaphore;
    const queuedAt = Date.now();
    const releaseSlot = sem ? await sem.acquire() : null;
    if (sem) {
      const waitMs = Date.now() - queuedAt;
      s.concurrency.peak = Math.max(s.concurrency.peak, sem.peak);
      s.concurrency.waiting = sem.waiting;
      if (waitMs > 0) {
        this.#broadcast(runId, {
          event: 'agent.ask.queued', name, askIndex: agent.asks,
          waitMs, active: sem.active, waiting: sem.waiting,
          limit: sem.limit, at: Date.now(),
        });
      }
    }

    try {
      // For typed ask we may retry up to TYPED_ASK_RETRY times on parse/validate
      // failure; untyped ask is single-shot (existing behavior).
      const maxAttempts = useTyped ? (1 + TYPED_ASK_RETRY) : 1;
      let lastError = null;
      let lastRaw = '';
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const result = await this.chat({
          messages: attempt === 1
            ? messages
            : [
                ...messages,
                { role: 'assistant', content: lastRaw },
                { role: 'user', content: `Your previous response did not match the required JSON Schema. Error: ${lastError}\n\nPlease return ONLY a valid JSON object matching the schema, no other text.` },
              ],
          model: agent.model,
          temperature: agent.temperature,
          maxTokens: askOpts && askOpts.maxTokens,
          apiKey: askOpts && askOpts.apiKey,
          responseFormat: useTyped ? { type: 'json_object' } : null,
          timeoutMs: ASK_TIMEOUT_MS,
        }, this.ctx);
        lastContent = result.content || '';
        lastRaw = lastContent;
        if (!useTyped) {
          agent.messages.push({ role: 'assistant', content: lastContent });
          agent.lastTokens = result.usage || null;
          agent.lastDurationMs = Date.now() - t0;
          this.#journalPush(s, runId, {
            kind: 'agent.ask', name, prompt,
            content: lastContent, usage: result.usage,
            typed: false, live: true,
          });
          this.#schedulePersist(runId);
          this.#broadcast(runId, {
            event: 'agent.ask.done', name, askIndex: agent.asks - 1,
            contentPreview: lastContent.slice(0, 400), usage: result.usage,
            durationMs: agent.lastDurationMs, at: Date.now(),
          });
          return { content: lastContent, usage: result.usage };
        }
        // Typed: parse + validate
        let parsed = null;
        let parseErr = null;
        // Try direct parse; if the LLM wrapped the JSON in fences, strip them.
        let s1 = lastContent.trim();
        const fence = s1.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
        if (fence) s1 = fence[1];
        try { parsed = JSON.parse(s1); }
        catch (err) { parseErr = err.message; }
        const valRes = parsed ? this.#validateShape(parsed, jsonSchema) : { ok: false, reason: parseErr || 'JSON parse failed' };
        if (valRes.ok) {
          // The script's ask() returns `content` directly. We pass the parsed
          // object so the script can do `const plan = await agent.ask(...)`.
          agent.lastTokens = result.usage || null;
          agent.lastDurationMs = Date.now() - t0;
          this.#journalPush(s, runId, {
            kind: 'agent.ask', name, prompt, resultShape,
            parsed, usage: result.usage,
            typed: true, live: true,
          });
          this.#schedulePersist(runId);
          this.#broadcast(runId, {
            event: 'agent.ask.done', name, askIndex: agent.asks - 1,
            contentPreview: JSON.stringify(parsed).slice(0, 400), usage: result.usage,
            durationMs: agent.lastDurationMs, at: Date.now(),
            typed: true,
          });
          return { content: parsed, usage: result.usage, typed: true };
        }
        lastError = valRes.reason;
        if (attempt < maxAttempts) {
          this.#appendLog(runId, 'warn', `agent.ask(${name}): JSON ${valRes.reason}, retrying`);
        }
      }
      // All attempts failed.
      const msg = `agent.ask(${name}): result did not match schema after ${maxAttempts} attempt(s); last error: ${lastError}; last response: ${lastRaw.slice(0, 400)}`;
      agent.lastDurationMs = Date.now() - t0;
      this.#broadcast(runId, {
        event: 'agent.ask.error', name, askIndex: agent.asks - 1,
        message: msg, at: Date.now(),
      });
      throw new Error(msg);
    } catch (err) {
      agent.lastDurationMs = Date.now() - t0;
      this.#broadcast(runId, {
        event: 'agent.ask.error',
        name,
        askIndex: agent.asks - 1,
        message: String(err && err.message || err),
        at: Date.now(),
      });
      throw err;
    } finally {
      // v0.12.0: always give the slot back, on success, on error, and on
      // the early `return`s inside the try. `releaseSlot` is idempotent,
      // so a double-release (which a nested finally could cause) is safe.
      if (releaseSlot) {
        releaseSlot();
        if (sem) {
          s.concurrency.peak = Math.max(s.concurrency.peak, sem.peak);
          s.concurrency.waiting = sem.waiting;
        }
      }
    }
  }

  #worldRun(runId, params) {
    return new Promise((resolve, reject) => {
      const s = this.runs.get(runId);
      if (!s) return reject(new Error('unknown run'));

      // v0.11.0: amend cache for shell commands. Same (cmd, args) in an
      // ancestor run's journal → return cached result, don't re-spawn.
      // Gated on `cacheOpen`, and resolved through the amend chain so a
      // run amended from a run that was itself amended still reuses the
      // original shell result.
      const cmd = (params && params.cmd) || '';
      const args = (params && params.args) || [];
      if (s.cacheOpen && s.amendFrom && cmd) {
        const argsKey = JSON.stringify(args || []);
        const found = this.#lookupAmendChain(s, 'world.run',
          (e) => e.cmd === cmd && JSON.stringify(e.args || []) === argsKey);
        if (found && found.entry.result) {
          this.#appendLog(runId, 'info', `world.run(${cmd}): amend replay from ${found.fromRun}`);
          this.#broadcast(runId, {
            event: 'world.run.cache_hit',
            cmd, fromRun: found.fromRun, at: Date.now(),
          });
          this.#journalPush(s, runId, {
            kind: 'world.run', cmd, args,
            result: found.entry.result, live: false, fromRun: found.fromRun,
          });
          this.#schedulePersist(runId);
          resolve(found.entry.result);
          return;
        }
      }
      const opts = (params && params.opts) || {};
      const timeoutMs = typeof opts.timeoutMs === 'number' ? opts.timeoutMs : SHELL_TIMEOUT_MS;
      if (!cmd) return reject(new Error('world.run: cmd is required'));
      // Per-run allowlist. Editor sends it after the user picks the subset of
      // extracted commands; an empty set means "deny all" (the editor should
      // never send that, but a deny-all run is well-defined and safe).
      if (s.worldRunAllowlist && !s.worldRunAllowlist.has(cmd)) {
        s.worldRunDeclined.push({ cmd, at: Date.now() });
        this.#appendLog(runId, 'warn', `world.run: command '${cmd}' is not in the approved list for this run`);
        this.#broadcast(runId, { event: 'world.run.declined', cmd, at: Date.now() });
        return reject(new Error(`world.run: command '${cmd}' is not in the approved list for this run`));
      }
      // v0.9.0: sandbox cwd. If the user passes an explicit `opts.cwd`
      // it must resolve inside `s.workspaceRoot` — without this, a
      // workflow could spawn a shell in /etc or anywhere else on
      // disk. The default cwd (script dir) is always inside the
      // workspace, so it doesn't need re-checking.
      if (opts.cwd) {
        const absCwd = resolvePath(opts.cwd);
        const rel = relative(s.workspaceRoot, absCwd);
        if (rel.startsWith('..') || isAbsolute(rel)) {
          const err = new Error(
            `world.run: cwd '${opts.cwd}' escapes workspaceRoot '${s.workspaceRoot}'`
          );
          err.code = 'PATH_ESCAPE';
          return reject(err);
        }
      }
      // v0.9.0: sandbox the child shell's env too. We use the
      // runtime's scrubbed env from the bootstrap child as the
      // starting point (already stripped of API keys), then layer
      // `opts.env` on top so per-call additions still work.
      const shellBaseEnv = (s && s.sandboxedChildEnv) || process.env;
      let child;
      try {
        child = spawn(cmd, args, {
          cwd: opts.cwd || dirname(s.scriptPath),
          env: { ...shellBaseEnv, ...(opts.env || {}) },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (err) {
        return reject(err);
      }
      let stdout = '';
      let stderr = '';
      let stdoutTruncated = false;
      let stderrTruncated = false;
      const t0 = Date.now();
      this.#broadcast(runId, { event: 'world.run.start', cmd, args, timeoutMs, at: Date.now() });
      // v0.11.0: hard 1 MiB ceiling per stream. Without it a runaway
      // command (`yes`, a build log, a `cat` of a huge file) buffers
      // without bound in the host AND lands in the journal, which is
      // then persisted to disk and reloaded on restart. We stop
      // accumulating but keep draining the stream so the child never
      // blocks on a full pipe.
      child.stdout.on('data', (buf) => {
        if (stdoutTruncated) return;
        if (stdout.length + buf.length > WORLD_RUN_OUTPUT_CAP) {
          stdout += buf.toString('utf8').slice(0, Math.max(0, WORLD_RUN_OUTPUT_CAP - stdout.length));
          stdoutTruncated = true;
          return;
        }
        const s2 = buf.toString('utf8'); stdout += s2;
        this.#broadcast(runId, { event: 'world.run.chunk', stream: 'stdout', chunk: s2.slice(-1024), at: Date.now() });
      });
      child.stderr.on('data', (buf) => {
        if (stderrTruncated) return;
        if (stderr.length + buf.length > WORLD_RUN_OUTPUT_CAP) {
          stderr += buf.toString('utf8').slice(0, Math.max(0, WORLD_RUN_OUTPUT_CAP - stderr.length));
          stderrTruncated = true;
          return;
        }
        const s2 = buf.toString('utf8'); stderr += s2;
        this.#broadcast(runId, { event: 'world.run.chunk', stream: 'stderr', chunk: s2.slice(-1024), at: Date.now() });
      });
      const killer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch (_) {}
        reject(new Error('world.run timed out after ' + timeoutMs + 'ms'));
      }, timeoutMs);
      child.on('error', (err) => {
        clearTimeout(killer);
        this.#broadcast(runId, {
          event: 'world.run.error', message: String(err && err.message || err), at: Date.now(),
        });
        reject(err);
      });
      child.on('exit', (code, signal) => {
        clearTimeout(killer);
        const dt = Date.now() - t0;
        const result = { exitCode: code, signal: signal || null, stdout, stderr, durationMs: dt };
        // v0.5.0: journal this world.run so amend can replay identical
        // (cmd, args) calls without re-spawning. Use a JSON-serialized
        // arg fingerprint for the cache key lookup above.
        this.#journalPush(s, runId, {
          kind: 'world.run', cmd, args,
          result, live: true,
        });
        if (stdoutTruncated || stderrTruncated) {
          this.#appendLog(runId, 'warn',
            `world.run(${cmd}): output truncated at ${WORLD_RUN_OUTPUT_CAP} bytes ` +
            `(stdout: ${stdoutTruncated ? 'yes' : 'no'}, stderr: ${stderrTruncated ? 'yes' : 'no'})`);
        }
        this.#schedulePersist(runId);
        this.#broadcast(runId, {
          event: 'world.run.done', exitCode: code, signal, durationMs: dt, at: Date.now(),
        });
        resolve(result);
      });
    });
  }

  #appendNotify(runId, msg) {
    if (msg.notify === 'ready') {
      this.#setStatus(runId, 'running');
      this.#appendLog(runId, 'debug', 'child ready, rpc ready');
    } else if (msg.notify === 'started') {
      this.#appendLog(runId, 'info', 'script started');
    } else if (msg.notify === 'finished') {
      this.#appendLog(runId, 'info', 'script finished in ' + (msg.ms || 0) + 'ms');
    } else if (msg.notify === 'error') {
      this.#appendLog(runId, 'error', String(msg.message || 'runner error'));
      this.#setStatus(runId, 'error');
    } else if (String(msg.notify).startsWith('stage.')) {
      this.#appendStageNotify(runId, msg);
    }
  }

  /** v0.10.0: structural-amend lifecycle notifications from the child. */
  #appendStageNotify(runId, msg) {
    const s = this.runs.get(runId);
    if (!s) return;
    const stageId = String(msg.stageId || '');
    const rec = stageId ? s.injectedStages.find((x) => x.stageId === stageId) : null;
    if (msg.notify === 'stage.draining') {
      this.#appendLog(runId, 'info', `draining ${msg.count} injected stage(s) before finish`);
      return;
    }
    if (!rec) return;
    if (msg.notify === 'stage.started') {
      rec.status = 'running';
      rec.startedAt = Number(msg.at) || Date.now();
      this.#broadcast(runId, {
        event: 'stage.started',
        stage: { stageId, name: rec.name, at: rec.startedAt },
        at: rec.startedAt,
      });
      this.#schedulePersist(runId);
      return;
    }
    if (msg.notify === 'stage.finished') {
      rec.status = msg.status === 'error' ? 'error' : 'completed';
      rec.result = msg.result === undefined ? null : msg.result;
      rec.error = msg.error ? String(msg.error) : null;
      rec.endedAt = Number(msg.at) || Date.now();
      if (rec.status === 'error') {
        this.#appendLog(runId, 'warn', `stage ${rec.name} failed: ${rec.error}`);
      } else {
        this.#appendLog(runId, 'info', `stage ${rec.name} completed in ${msg.durationMs || 0}ms`);
      }
      this.#broadcast(runId, {
        event: 'stage.finished',
        stage: {
          stageId, name: rec.name, status: rec.status,
          result: rec.result, error: rec.error,
          durationMs: msg.durationMs || 0, at: rec.endedAt,
        },
        at: rec.endedAt,
      });
      // Release any `wait: true` caller parked on this stage.
      const waiter = s.pendingStageCalls.get(stageId);
      if (waiter) {
        if (waiter.timer) clearTimeout(waiter.timer);
        s.pendingStageCalls.delete(stageId);
        waiter.resolve({ stageId });
      }
      this.#schedulePersist(runId);
    }
  }

  #appendLog(runId, level, message) {
    const s = this.runs.get(runId);
    if (!s) return;
    s.log.push({ at: Date.now(), level, message });
    if (s.log.length > 5000) s.log.splice(0, s.log.length - 5000);
    this.#broadcast(runId, { event: 'log', entry: s.log[s.log.length - 1] });
    this.#schedulePersist(runId);
  }

  #setStatus(runId, status) {
    const s = this.runs.get(runId);
    if (!s) return;
    if (s.status === status) return;
    if (status === 'completed' || status === 'error' || status === 'stopped') s.endedAt = Date.now();
    s.status = status;
    // v0.12.0: close the phase lifecycle. A run that ends normally
    // completes its last phase; a run that errors or is stopped CANCELS
    // it — a cancelled phase never finished, and the editor needs to
    // show that difference (that is where the error happened).
    if (status === 'completed' || status === 'error' || status === 'stopped') {
      if (s.currentPhase) {
        const cancelled = status !== 'completed';
        const summary = s.phaseSummary.get(s.currentPhase);
        if (summary && summary.status === 'active') summary.status = cancelled ? 'error' : 'done';
        this.#broadcast(runId, {
          event: cancelled ? 'phase.cancel' : 'phase.complete',
          phase: { name: s.currentPhase, at: Date.now(), cancelled },
          phaseSummary: Array.from(s.phaseSummary.values()),
        });
      }
    }
    this.#broadcast(runId, { event: 'status', status, at: Date.now() });
    if (this.onLifecycle) this.onLifecycle({ type: 'status', runId, status });
    this.#schedulePersist(runId);
    // Force a final flush on terminal states so the on-disk file matches
    // the in-memory state by the time the user looks at /api/runs.
    if (status === 'completed' || status === 'error' || status === 'stopped') {
      this.#writeRunToDisk(runId).catch(() => { /* best-effort */ });
      // v0.10.0: nothing can be injected into a terminal run any more,
      // so release every `wait: true` caller still parked on a stage.
      // Stages the child never got to finish are recorded as such —
      // "injected but never ran" is useful audit information.
      if (s.pendingStageCalls && s.pendingStageCalls.size) {
        for (const [stageId, waiter] of Array.from(s.pendingStageCalls.entries())) {
          if (waiter.timer) clearTimeout(waiter.timer);
          s.pendingStageCalls.delete(stageId);
          const rec = s.injectedStages.find((x) => x.stageId === stageId);
          if (rec && rec.status === 'injected') {
            rec.status = 'abandoned';
            rec.error = 'run ended before the stage started';
            rec.endedAt = Date.now();
          }
          waiter.reject(new Error(`run ${status} before stage ${waiter.name} settled`));
        }
      }
      // v0.7.0: clean up the per-run TypeScript transpile tmp dir.
      const s2 = this.runs.get(runId);
      if (s2 && s2._transpileCleanup) {
        Promise.resolve(s2._transpileCleanup()).catch(() => { /* best-effort */ });
        s2._transpileCleanup = null;
      }
    }
  }

  #broadcast(runId, payload) {
    const s = this.runs.get(runId);
    if (!s) return;
    for (const cb of s.subscribers) {
      try { cb(payload); } catch (_) { /* ignore */ }
    }
  }

  #onChildExit(runId, code, signal) {
    const s = this.runs.get(runId);
    if (!s) return;
    // v0.12.0: a deadlock pins exitCode to -1 so the failure mode is
    // distinguishable from an ordinary script error. Don't let the
    // SIGTERM we sent to clean up overwrite it.
    if (!s._deadlocked) s.exitCode = code;
    if (s.watchdog) { clearTimeout(s.watchdog); s.watchdog = null; }
    let status;
    if (s._stopRequested) status = 'stopped';
    else if (s._deadlocked) status = 'error';
    else if (code === 0) status = 'completed';
    else status = 'error';
    this.#appendLog(runId, status === 'completed' ? 'info' : 'error',
      `child exited code=${code} signal=${signal || 'null'} → status=${status}`);
    this.#setStatus(runId, status);
  }

  // --- files / git handler helpers (ZCode §16.2) ---

  /**
   * Resolve a user-supplied path against this run's workspaceRoot and verify
   * it stays inside the root. Throws on any escape attempt.
   *
   * v0.13.0: two corrections.
   *
   * A RELATIVE path is resolved against the workspace root, not the host
   * process's cwd. The facade contract says "workspace-relative path" (ZCode
   * §16.2), and the engine path runs in the host process where cwd is
   * wherever dsh was launched — not the workspace. Resolving against cwd
   * only happened to work when the two coincided.
   *
   * And the containment check is no longer purely lexical. A symbolic link
   * INSIDE the workspace that points outside it passed the old check, and
   * then read whatever it pointed at. The real path is resolved and checked
   * against the real path of the root.
   *
   * @returns {string} absolute resolved path
   */
  #resolveInWorkspace(runId, inputPath) {
    const s = this.runs.get(runId);
    if (!s) throw new Error('unknown run');
    if (typeof inputPath !== 'string' || !inputPath) {
      throw new Error('path must be a non-empty string');
    }
    if (inputPath.includes('\0')) throw new Error('path contains null byte');
    const root = s.workspaceRoot;
    const abs = isAbsolute(inputPath) ? resolvePath(inputPath) : resolvePath(root, inputPath);
    // Lexical check first: cheap, and it rejects the obvious escapes.
    const rel = relative(root, abs);
    if (rel.startsWith('..') || rel === '..' || abs !== join(root, rel)) {
      throw new Error(`path '${inputPath}' resolves outside workspaceRoot '${root}'`);
    }
    // Then the real check, which catches a link pointing out of the tree.
    // The root itself may be a link (a temp dir on macOS, for one), so both
    // sides are resolved before they are compared.
    const realRoot = realpathOfNearestExisting(root);
    const realAbs = realpathOfNearestExisting(abs);
    if (realRoot !== null && realAbs !== null) {
      const realRel = relative(realRoot, realAbs);
      if (realRel.startsWith('..') || isAbsolute(realRel)) {
        const err = new Error(
          `path '${inputPath}' escapes workspaceRoot '${root}' through a symbolic link`,
        );
        err.code = 'PATH_ESCAPE';
        throw err;
      }
    }
    return abs;
  }

  /**
   * Convert a small glob subset to a RegExp. Supports:
   *   **  → any chars including /
   *   *   → any chars not /
   *   ?   → single char not /
   *   [abc], [!abc]  → character class
   *   leading `/`  → relative to root
   * No braces, no extglob. Enough for files.grep scopes.
   */
  #globToRegex(glob) {
    let re = '^';
    let i = 0;
    while (i < glob.length) {
      const c = glob[i];
      if (c === '*') {
        if (glob[i + 1] === '*') {
          re += '.*';
          i += 2;
          if (glob[i] === '/') i++;
        } else {
          re += '[^/]*';
          i++;
        }
      } else if (c === '?') {
        re += '[^/]';
        i++;
      } else if (c === '[') {
        const end = glob.indexOf(']', i);
        if (end === -1) { re += '\\['; i++; continue; }
        let cls = glob.slice(i, end + 1);
        if (cls[1] === '!') cls = '[^' + cls.slice(2);
        re += cls;
        i = end + 1;
      } else if ('.+^$()|{}'.includes(c)) {
        re += '\\' + c;
        i++;
      } else {
        re += c;
        i++;
      }
    }
    re += '$';
    return new RegExp(re);
  }

  /**
   * Recursively walk a directory, returning up to `max` matching relative paths.
   * Skips node_modules / .git by convention (ZCode skips them too).
   */
  async #walkFiles(root, max, results = []) {
    if (results.length >= max) return results;
    let entries;
    try { entries = await readdir(root, { withFileTypes: true }); }
    catch (_) { return results; }
    for (const ent of entries) {
      if (results.length >= max) break;
      const name = ent.name;
      if (name === 'node_modules' || name === '.git' || name === '.zcode') continue;
      const full = join(root, name);
      if (ent.isDirectory()) {
        await this.#walkFiles(full, max, results);
      } else if (ent.isFile()) {
        results.push(full);
      }
    }
    return results;
  }

  async #filesGlob(runId, params) {
    const s = this.runs.get(runId);
    if (!s) throw new Error('unknown run');
    const pattern = String((params && params.pattern) || '').trim();
    if (!pattern) throw new Error('files.glob: pattern required');
    const root = s.workspaceRoot;
    // v0.9.0: reject patterns that try to anchor to an absolute
    // path outside the workspace. The user might write "/etc/**"
    // (anchor to FS root) or "../foo/**" (escape via parent). Both
    // are now caught before the walk starts.
    if (/^\/|^[A-Za-z]:[\\/]/.test(pattern)) {
      const err = new Error(`files.glob: pattern must be workspace-relative ('${pattern}')`);
      err.code = 'PATH_ESCAPE';
      throw err;
    }
    // Strip a leading "/" so "**/*.mjs" doesn't try to anchor to FS root.
    const cleanPattern = pattern.replace(/^\/+/, '');
    // Split into dir part and file part so we know where to walk from.
    const m = cleanPattern.match(/^(.*?)\*\*?\/([^\/*?[]*)$/);
    let walkRoot = root;
    let re;
    if (m) {
      const dirPart = m[1].replace(/\/+$/, '');
      if (dirPart && (dirPart.includes('..') || isAbsolute(dirPart))) {
        const err = new Error(`files.glob: dir part '${dirPart}' escapes workspace`);
        err.code = 'PATH_ESCAPE';
        throw err;
      }
      walkRoot = dirPart ? join(root, dirPart) : root;
      // Final defense: the resolved walkRoot must be inside `root`.
      const relCheck = relative(root, walkRoot);
      if (relCheck.startsWith('..') || isAbsolute(relCheck)) {
        const err = new Error(`files.glob: walkRoot '${walkRoot}' escapes workspace`);
        err.code = 'PATH_ESCAPE';
        throw err;
      }
      re = this.#globToRegex(cleanPattern);
    } else {
      // Pattern with no ** or * in the path — just match the basename.
      re = this.#globToRegex(cleanPattern);
    }
    const all = await this.#walkFiles(walkRoot, FILES_GLOB_CAP + 1);
    if (all.length > FILES_GLOB_CAP) {
      throw new Error(`files.glob: matches exceed ${FILES_GLOB_CAP} files cap; narrow the pattern`);
    }
    const matched = all
      .filter((abs) => re.test(relative(root, abs).split(PATH_SEP).join('/')))
      .map((abs) => relative(root, abs).split(PATH_SEP).join('/'))
      .sort();
    this.#journalPush(s, runId, { kind: 'files.glob', pattern, result: matched, live: true });
    return matched;
  }

  async #filesRead(runId, params) {
    const s = this.runs.get(runId);
    if (!s) throw new Error('unknown run');
    const abs = this.#resolveInWorkspace(runId, (params && params.path) || '');
    let st;
    try { st = await stat(abs); } catch (err) { throw new Error('files.read: ' + err.message); }
    if (st.size > FILES_READ_CAP) {
      throw new Error(`files.read: file ${st.size}B exceeds ${FILES_READ_CAP}B cap`);
    }
    const text = await readFile(abs, 'utf8');
    this.#journalPush(s, runId, { kind: 'files.read', path: relative(s.workspaceRoot, abs), result: text, live: true });
    return text;
  }

  async #filesGrep(runId, params) {
    const s = this.runs.get(runId);
    if (!s) throw new Error('unknown run');
    const pattern = String((params && params.pattern) || '');
    if (!pattern) throw new Error('files.grep: pattern required');
    let re;
    try { re = new RegExp(pattern); }
    catch (err) { throw new Error('files.grep: invalid regex: ' + err.message); }
    const scope = params && params.glob ? String(params.glob) : null;
    // v0.9.0: same workspace-relativity check as files.glob — a
    // user passing "/etc/**" or "../*" must not be able to walk
    // outside the workspace.
    if (scope && (/^\/|^[A-Za-z]:[\\/]/.test(scope))) {
      const err = new Error(`files.grep: glob must be workspace-relative ('${scope}')`);
      err.code = 'PATH_ESCAPE';
      throw err;
    }
    if (scope && scope.replace(/^\/+/, '').split(/[\\/]/).some((seg) => seg === '..')) {
      const err = new Error(`files.grep: glob contains '..' ('${scope}')`);
      err.code = 'PATH_ESCAPE';
      throw err;
    }
    const root = s.workspaceRoot;
    const matches = [];
    let totalBytes = 0;
    let scanned = 0;
    if (scope) {
      const re2 = this.#globToRegex(scope.replace(/^\/+/, ''));
      const all = await this.#walkFiles(root, FILES_GLOB_CAP + 1);
      for (const abs of all) {
        const rel = relative(root, abs).split(PATH_SEP).join('/');
        if (!re2.test(rel)) continue;
        await this.#grepOne(abs, rel, re, matches, () => totalBytes, (n) => { totalBytes += n; });
        if (matches.length >= FILES_GLOB_CAP || totalBytes > FILES_GREP_RESULTS_CAP) break;
        scanned++;
      }
    } else {
      // No scope: scan everything under root.
      const all = await this.#walkFiles(root, FILES_GLOB_CAP + 1);
      for (const abs of all) {
        const rel = relative(root, abs).split(PATH_SEP).join('/');
        await this.#grepOne(abs, rel, re, matches, () => totalBytes, (n) => { totalBytes += n; });
        if (matches.length >= FILES_GLOB_CAP || totalBytes > FILES_GREP_RESULTS_CAP) break;
        scanned++;
      }
    }
    if (matches.length >= FILES_GLOB_CAP || totalBytes > FILES_GREP_RESULTS_CAP) {
      throw new Error(`files.grep: cap exceeded (${matches.length} matches / ${totalBytes}B); narrow the scope`);
    }
    this.#journalPush(s, runId, { kind: 'files.grep', pattern, glob: scope, result: matches, live: true });
    return matches;
  }

  async #grepOne(abs, rel, re, matches, getBytes, addBytes) {
    let text;
    try { text = await readFile(abs, 'utf8'); }
    catch (_) { return; } // binary or unreadable; skip
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) {
        matches.push({ path: rel, line: i + 1, text: lines[i] });
        addBytes(lines[i].length + rel.length + 16);
        if (matches.length >= FILES_GLOB_CAP) return;
      }
    }
  }

  // --- git handlers ---

  #runGit(runId, args, opts = {}) {
    const s = this.runs.get(runId);
    if (!s) return Promise.reject(new Error('unknown run'));
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = spawn('git', args, {
          cwd: s.workspaceRoot,
          // The scrubbed environment, not the raw host env: the sandbox
          // strips API keys from the child, and a git subprocess that
          // inherited the raw env would hand them straight back.
          env: { ...(s.sandboxedChildEnv || process.env), ...(opts.env || {}) },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (err) { return reject(err); }
      let stdout = '', stderr = '';
      child.stdout.on('data', (b) => { stdout += b.toString('utf8'); });
      child.stderr.on('data', (b) => { stderr += b.toString('utf8'); });
      const t = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch (_) {}
        reject(new Error('git command timed out after 60s'));
      }, 60_000);
      child.on('error', (err) => {
        clearTimeout(t);
        if (err && err.code === 'ENOENT') {
          reject(new Error('git binary not found in PATH'));
        } else {
          reject(err);
        }
      });
      child.on('exit', (code) => {
        clearTimeout(t);
        if (code === 0) return resolve({ stdout, stderr });
        reject(new Error(`git ${args[0]} exited ${code}: ${stderr.trim().slice(0, 400)}`));
      });
    });
  }

  async #gitChangedFiles(runId, params) {
    const s = this.runs.get(runId);
    if (!s) throw new Error('unknown run');
    const base = params && params.base ? String(params.base) : null;
    let paths;
    if (base) {
      // Tracked files whose current state differs from the ref.
      const r = await this.#runGit(runId, ['diff', '--name-only', '--diff-filter=ACMRT', base]);
      paths = r.stdout.trim() ? r.stdout.trim().split(/\r?\n/) : [];
    } else {
      // Uncommitted edits (HEAD vs working tree) + untracked.
      const r1 = await this.#runGit(runId, ['diff', '--name-only', '--diff-filter=ACMRT', 'HEAD']);
      const tracked = r1.stdout.trim() ? r1.stdout.trim().split(/\r?\n/) : [];
      let untracked = [];
      try {
        const r2 = await this.#runGit(runId, ['ls-files', '--others', '--exclude-standard']);
        untracked = r2.stdout.trim() ? r2.stdout.trim().split(/\r?\n/) : [];
      } catch (_) { /* not in a git repo */ }
      paths = [...new Set([...tracked, ...untracked])].filter(Boolean);
    }
    if (paths.length > FILES_GLOB_CAP) {
      throw new Error(`git.changedFiles: ${paths.length} paths exceeds ${FILES_GLOB_CAP} cap`);
    }
    this.#journalPush(s, runId, { kind: 'git.changedFiles', base, result: paths, live: true });
    return paths;
  }

  async #gitDiff(runId, params) {
    const s = this.runs.get(runId);
    if (!s) throw new Error('unknown run');
    const base = params && params.base ? String(params.base) : 'HEAD';
    const path = params && params.path ? String(params.path) : null;
    // v0.9.0: `path` is fed to `git diff <base> -- <path>`. Without
    // a check, `path` can walk out of the workspace (e.g. `../../etc/...`).
    // Refuse absolute paths and dot-segments here; the resolver
    // catches the rest after the request goes to git.
    if (path) {
      if (/^\/|^[A-Za-z]:[\\/]/.test(path) || path.split(/[\\/]/).some((seg) => seg === '..')) {
        const err = new Error(`git.diff: path '${path}' escapes workspace`);
        err.code = 'PATH_ESCAPE';
        throw err;
      }
    }
    const args = ['diff'];
    args.push(base);
    if (path) args.push('--', path);
    const r = await this.#runGit(runId, args);
    if (r.stdout.length > GIT_DIFF_CAP) {
      throw new Error(`git.diff: output ${r.stdout.length}B exceeds ${GIT_DIFF_CAP}B cap`);
    }
    this.#journalPush(s, runId, { kind: 'git.diff', base, path, result: r.stdout, live: true });
    return r.stdout;
  }

  async #gitStatus(runId) {
    const s = this.runs.get(runId);
    if (!s) throw new Error('unknown run');
    const r = await this.#runGit(runId, ['status', '--porcelain', '--branch']);
    const out = { branch: null, clean: true, staged: [], unstaged: [], untracked: [] };
    const lines = r.stdout.split(/\r?\n/);
    for (const line of lines) {
      if (!line) continue;
      if (line.startsWith('## ')) {
        // "## <branch>" or "## <branch>...origin/<x> [ahead N, behind M]"
        const head = line.slice(3);
        const m = head.match(/^([^.\s]+)/);
        if (m) out.branch = m[1];
        continue;
      }
      // Two-char XY code + path; e.g. "M  src/a.ts", "?? new.ts", "A  staged.ts"
      const code = line.slice(0, 2);
      const path = line.slice(3);
      if (code === '??') { out.untracked.push(path); out.clean = false; continue; }
      const x = code[0], y = code[1];
      if (x !== ' ' && x !== '?') { out.staged.push(path); out.clean = false; }
      if (y !== ' ' && y !== '?') { out.unstaged.push(path); out.clean = false; }
    }
    this.#journalPush(s, runId, { kind: 'git.status', result: out, live: true });
    return out;
  }

  async #gitLog(runId, params) {
    const s = this.runs.get(runId);
    if (!s) throw new Error('unknown run');
    const count = (params && typeof params.count === 'number' && params.count > 0)
      ? Math.min(params.count, GIT_LOG_MAX)
      : GIT_LOG_DEFAULT;
    const r = await this.#runGit(runId, ['log', `-n${count}`, '--format=%H%n%s%n%an%n%aI']);
    const chunks = r.stdout.split(/\n\n/).map((c) => c.trim()).filter(Boolean);
    const commits = chunks.map((c) => {
      const [hash, subject, author, date] = c.split(/\n/);
      return { hash, subject: subject || '', author: author || '', date: date || '' };
    });
    this.#journalPush(s, runId, { kind: 'git.log', count, result: commits, live: true });
    return commits;
  }

  // --- v0.4.0: ask<T> typed results ---

  /**
   * Convert the user's `result` shape to a JSON Schema. The shape syntax
   * is small and JSON-friendly:
   *   'string' | 'number' | 'boolean'  → primitive
   *   ['string'] / [{...}]            → array (one element = element shape)
   *   { key: <shape>, ... }            → object with required keys
   *   null / other                     → any
   * Required keys are all keys in object shapes (strict: no extras).
   */
  #shapeToJsonSchema(shape) {
    if (typeof shape === 'string') {
      if (shape === 'string' || shape === 'number' || shape === 'boolean') {
        return { type: shape };
      }
      return { type: 'string' };
    }
    if (Array.isArray(shape)) {
      if (shape.length === 0) return { type: 'array', items: {} };
      return { type: 'array', items: this.#shapeToJsonSchema(shape[0]) };
    }
    if (shape && typeof shape === 'object') {
      const properties = {};
      const required = [];
      for (const [k, v] of Object.entries(shape)) {
        properties[k] = this.#shapeToJsonSchema(v);
        required.push(k);
      }
      return { type: 'object', properties, required, additionalProperties: false };
    }
    return {}; // permissive
  }

  /**
   * Walk a parsed value against a schema. Returns { ok: true } or
   * { ok: false, reason: 'human-readable' }. Used to decide whether the
   * LLM's JSON answer actually matches the user's shape, before returning
   * it to the script.
   */
  #validateShape(value, schema, path = '$') {
    if (!schema || !schema.type) return { ok: true };
    if (schema.type === 'object') {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return { ok: false, reason: `${path}: expected object, got ${Array.isArray(value) ? 'array' : typeof value}` };
      }
      const required = schema.required || [];
      for (const k of required) {
        if (!(k in value)) return { ok: false, reason: `${path}.${k}: missing required field` };
      }
      if (schema.additionalProperties === false) {
        for (const k of Object.keys(value)) {
          if (!schema.properties[k]) return { ok: false, reason: `${path}.${k}: unexpected field` };
        }
      }
      for (const [k, sub] of Object.entries(schema.properties || {})) {
        if (k in value) {
          const r = this.#validateShape(value[k], sub, `${path}.${k}`);
          if (!r.ok) return r;
        }
      }
      return { ok: true };
    }
    if (schema.type === 'array') {
      if (!Array.isArray(value)) {
        return { ok: false, reason: `${path}: expected array, got ${typeof value}` };
      }
      if (schema.items) {
        for (let i = 0; i < value.length; i++) {
          const r = this.#validateShape(value[i], schema.items, `${path}[${i}]`);
          if (!r.ok) return r;
        }
      }
      return { ok: true };
    }
    if (schema.type === 'string') {
      return typeof value === 'string' ? { ok: true } : { ok: false, reason: `${path}: expected string, got ${typeof value}` };
    }
    if (schema.type === 'number') {
      return typeof value === 'number' ? { ok: true } : { ok: false, reason: `${path}: expected number, got ${typeof value}` };
    }
    if (schema.type === 'boolean') {
      return typeof value === 'boolean' ? { ok: true } : { ok: false, reason: `${path}: expected boolean, got ${typeof value}` };
    }
    return { ok: true };
  }

  // --- v0.4.0: question.ask (parked RPC) ---

  /**
   * Park an askUser() RPC from the child. We don't respond — instead we
   * broadcast the question over SSE and wait for /api/question-answer to
   * come in. A 5-minute watchdog per question forces a reject if the UI
   * never answers.
   */
  #questionAsk(runId, msg) {
    const s = this.runs.get(runId);
    if (!s) return;
    const params = (msg && msg.params) || {};
    const questionId = String(params.questionId || ('q-' + msg.id));
    const question = String(params.question || '');
    const kind = String(params.kind || 'text');
    const options = Array.isArray(params.options) ? params.options : null;
    if (!question) {
      // Nothing to ask — reject the rpc immediately.
      this.#respondChild(runId, msg.id, null, new Error('question.ask: empty question'));
      return;
    }
    // If a question with the same id is already pending, reject the new one.
    if (s.pendingQuestions.has(questionId)) {
      this.#respondChild(runId, msg.id, null, new Error(`question.ask: questionId '${questionId}' already pending`));
      return;
    }
    const askedAt = Date.now();
    const timer = setTimeout(() => {
      const cur = this.runs.get(runId);
      const pq = cur && cur.pendingQuestions.get(questionId);
      if (!pq) return;
      cur.pendingQuestions.delete(questionId);
      this.#respondChild(runId, pq.rpcId, null,
        new Error(`askUser: no answer within ${QUESTION_TIMEOUT_MS / 1000}s`));
      this.#broadcast(runId, {
        event: 'question.timeout',
        questionId, askedAt, at: Date.now(),
      });
    }, QUESTION_TIMEOUT_MS);
    s.pendingQuestions.set(questionId, {
      rpcId: msg.id,
      question, kind, options, askedAt, timer,
    });
    this.#broadcast(runId, {
      event: 'question.asked',
      question: { questionId, question, kind, options, askedAt, at: askedAt },
    });
  }

  /**
   * Park a question on behalf of the ENGINE path.
   *
   * The legacy path parks a child RPC: the question goes out over SSE and
   * the answer comes back by writing to the child's stdin. The engine path
   * has no child RPC to park — the script is waiting inside the driver, in
   * this process. So the same pending-question record carries a deferred
   * instead, and #answerQuestion resolves whichever it finds.
   *
   * @param {string} runId
   * @param {string} question
   * @param {{kind?: string, options?: string[]}} [opts]
   * @returns {Promise<string>}
   */
  #askUserOnHost(runId, question, opts = {}) {
    const s = this.runs.get(runId);
    if (!s) return Promise.reject(new Error('unknown run'));
    const q = String(question || '');
    if (!q) return Promise.reject(new Error('askUser: empty question'));
    const kind = String(opts.kind || 'text');
    const options = Array.isArray(opts.options) ? opts.options : null;
    const questionId = `q-${randomUUID()}`;
    const askedAt = Date.now();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const cur = this.runs.get(runId);
        const pq = cur && cur.pendingQuestions.get(questionId);
        if (!pq) return;
        cur.pendingQuestions.delete(questionId);
        this.#broadcast(runId, {
          event: 'question.timeout', questionId, askedAt, at: Date.now(),
        });
        reject(new Error(`askUser: no answer within ${QUESTION_TIMEOUT_MS / 1000}s`));
      }, QUESTION_TIMEOUT_MS);
      s.pendingQuestions.set(questionId, {
        question: q, kind, options, askedAt, timer, resolve, reject,
      });
      this.#broadcast(runId, {
        event: 'question.asked',
        question: { questionId, question: q, kind, options, askedAt, at: askedAt },
      });
    });
  }

  /**
   * Park an escalation on behalf of the ENGINE path. Same shape as
   * #askUserOnHost; the answer comes from /api/escalate-answer (the human)
   * or /api/escalate-think (the model, with the human confirming).
   *
   * @param {string} runId
   * @param {string} question
   * @param {{kind?: string, options?: string[]}} [opts]
   * @returns {Promise<string>}
   */
  #escalateOnHost(runId, question, opts = {}) {
    const s = this.runs.get(runId);
    if (!s) return Promise.reject(new Error('unknown run'));
    const q = String(question || '');
    if (!q) return Promise.reject(new Error('escalate: empty question'));
    const kind = String(opts.kind || 'text');
    const options = Array.isArray(opts.options) ? opts.options : null;
    const escalateId = `e-${randomUUID()}`;
    const askedAt = Date.now();
    if (!s.pendingEscalates) s.pendingEscalates = new Map();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const cur = this.runs.get(runId);
        const ep = cur && cur.pendingEscalates && cur.pendingEscalates.get(escalateId);
        if (!ep) return;
        cur.pendingEscalates.delete(escalateId);
        this.#broadcast(runId, {
          event: 'escalate.timeout', escalateId, askedAt, at: Date.now(),
        });
        reject(new Error(`escalate: no answer within ${QUESTION_TIMEOUT_MS / 1000}s`));
      }, QUESTION_TIMEOUT_MS);
      s.pendingEscalates.set(escalateId, {
        question: q, kind, options, askedAt, timer, resolve, reject,
      });
      this.#broadcast(runId, {
        event: 'escalate.asked',
        escalate: { escalateId, question: q, kind, options, askedAt, at: askedAt },
      });
    });
  }

  /**
   * How many injected stages have not settled yet.
   *
   * @param {string} runId
   * @returns {number}
   */
  #pendingStageCount(runId) {
    const s = this.runs.get(runId);
    if (!s) return 0;
    return s.injectedStages.filter((x) => x.status === 'injected' || x.status === 'running').length;
  }

  /**
   * Wait until no injected stage is in flight — or, with `forStage`, until a
   * stage ARRIVES.
   *
   * The two are different waits. "No stage in flight" is the drain at the
   * end of a run. "A stage arrives" is the script parking for the host to
   * inject one, which is the only way a script can wait for an amendment
   * that has not been written yet.
   *
   * @param {string} runId
   * @param {{timeoutMs?: number, forStage?: boolean}} [opts]
   * @returns {Promise<void>}
   */
  async #awaitStages(runId, opts = {}) {
    const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : STAGE_MAX_WAIT_MS;
    const deadline = Date.now() + timeoutMs;
    const forStage = opts.forStage === true;
    for (;;) {
      const pending = this.#pendingStageCount(runId);
      if (forStage) {
        // Wait for a stage to ARRIVE, and return as soon as one has. It
        // must NOT wait for the stage to settle: the stage settles only
        // after the script runs it, and the script is the thing waiting
        // here — waiting for the settle would deadlock the pair.
        if (pending > 0) return;
      } else if (pending === 0) {
        return;
      }
      if (Date.now() > deadline) {
        throw new Error(
          forStage
            ? `stages.await: no stage arrived within ${timeoutMs}ms`
            : `stages.await: stages still in flight after ${timeoutMs}ms`,
        );
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  /**
   * The run's concurrency telemetry — the same numbers the legacy
   * `concurrency.stat` RPC returns.
   *
   * The two paths are governed by different limiters, so the numbers come
   * from different places:
   *
   * - The LEGACY path admits asks through dsh's semaphore, so the
   *   semaphore's counters are the truth.
   * - The ENGINE path admits asks through the engine's own scheduler
   *   (`scheduler.ts`: `if (this.activeAsks >= caps.maxConcurrency) return`),
   *   and the driver counts them. Reading the semaphore here would report
   *   zeros for a run that is plainly busy — the semaphore is never
   *   acquired on this path.
   *
   * @param {string} runId
   * @returns {Promise<object>}
   */
  #concurrencyStat(runId) {
    const s = this.runs.get(runId);
    if (!s) return Promise.reject(new Error('unknown run'));
    const limit = s.concurrency ? s.concurrency.maxConcurrent : 0;

    // The driver holds the live counters. It is reachable two ways: the run
    // state, once the run has settled, and the services object, which is
    // built BEFORE the run starts — so the numbers are real while the run
    // is in flight, which is the only time they matter.
    const driver = s._engineDriver ?? s._engineDriverRef ?? null;
    if (driver && typeof driver.concurrencyStat === 'function') {
      return Promise.resolve(driver.concurrencyStat(limit));
    }

    const sem = s.concurrency && s.concurrency.semaphore;
    return Promise.resolve({
      limit,
      active: sem ? sem.active : 0,
      peak: sem ? sem.peak : 0,
      waiting: sem ? sem.waiting : 0,
      totalAcquired: sem ? sem.totalAcquired : 0,
      totalWaitMs: sem ? sem.totalWaitMs : 0,
    });
  }

  /**
   * Respond to a parked question from the API. Called by
   * POST /api/question-answer. Looks up the questionId, sends the answer
   * back on the original RPC id, cleans up.
   */
  #answerQuestion(runId, questionId, answer) {
    const s = this.runs.get(runId);
    if (!s) throw new Error('unknown run');
    const id = String(questionId || '');
    const pq = s.pendingQuestions.get(id);
    if (!pq) throw new Error(`no pending question with id '${id}'`);
    s.pendingQuestions.delete(id);
    if (pq.timer) clearTimeout(pq.timer);
    // For confirm kind, normalize answer to boolean; for options kind, ensure
    // it's a string from the option set; otherwise pass through.
    let normalized = answer;
    if (pq.kind === 'confirm') {
      if (typeof answer === 'boolean') normalized = answer;
      else if (answer === 'true' || answer === '1') normalized = true;
      else if (answer === 'false' || answer === '0') normalized = false;
      else throw new Error('confirm question expects a boolean answer');
    } else if (Array.isArray(pq.options) && pq.options.length > 0) {
      if (typeof answer !== 'string' || !pq.options.includes(answer)) {
        throw new Error(`options question expects one of: ${pq.options.join(', ')}`);
      }
    }
    if (typeof pq.resolve === 'function') {
      // The engine path: the script is waiting inside the driver, in this
      // process. There is no child RPC to answer.
      pq.resolve(normalized);
    } else {
      this.#respondChild(runId, pq.rpcId, normalized, null);
    }
    this.#broadcast(runId, {
      event: 'question.answered',
      questionId: id, at: Date.now(),
    });
  }

  /**
   * Public answerQuestion, used by HTTP /api/question-answer. Same shape
   * as the private method; exposed so the plugin can call it.
   */
  answerQuestion(runId, questionId, answer) {
    return this.#answerQuestion(runId, questionId, answer);
  }

  // --- v0.5.0: hole<T>() parked RPC + answer ---

  /**
   * Park a hole<T>() RPC from the child. The body comes back via
   * /api/hole-answer, which writes to stdin and unblocks the rpc Promise
   * with the body string. The bootstrap then evals the body as an
   * AsyncFunction and resolves the user's `await hole(...)`.
   */
  #holeWait(runId, msg) {
    const s = this.runs.get(runId);
    if (!s) return;
    const params = (msg && msg.params) || {};
    const holeId = String(params.holeId || ('h-' + msg.id));
    const name = String(params.name || '');
    const prompt = String(params.prompt || '');
    const hasContext = !!params.hasContext;
    if (!name) {
      this.#respondChild(runId, msg.id, null, new Error('hole.wait: empty name'));
      return;
    }
    if (s.pendingHoles.has(holeId)) {
      this.#respondChild(runId, msg.id, null, new Error(`hole.wait: holeId '${holeId}' already pending`));
      return;
    }
    const askedAt = Date.now();
    const timer = setTimeout(() => {
      const cur = this.runs.get(runId);
      const hp = cur && cur.pendingHoles.get(holeId);
      if (!hp) return;
      cur.pendingHoles.delete(holeId);
      this.#respondChild(runId, hp.rpcId, null,
        new Error(`hole: no answer within ${HOLE_TIMEOUT_MS / 1000}s`));
      this.#broadcast(runId, {
        event: 'hole.timeout', holeId, at: Date.now(),
      });
    }, HOLE_TIMEOUT_MS);
    s.pendingHoles.set(holeId, {
      rpcId: msg.id, name, prompt, hasContext, askedAt, timer,
    });
    this.#broadcast(runId, {
      event: 'hole.waiting',
      hole: { holeId, name, prompt, hasContext, askedAt, at: askedAt },
    });
  }

  /**
   * Respond to a parked hole from the API. Called by POST /api/hole-answer.
   * Sends the body string (or an error message) back to the child on
   * the original RPC id.
   */
  #answerHole(runId, holeId, body, errorMessage) {
    const s = this.runs.get(runId);
    if (!s) throw new Error('unknown run');
    const id = String(holeId || '');
    const hp = s.pendingHoles.get(id);
    if (!hp) throw new Error(`no pending hole with id '${id}'`);
    s.pendingHoles.delete(id);
    if (hp.timer) clearTimeout(hp.timer);
    if (errorMessage) {
      this.#respondChild(runId, hp.rpcId, { error: String(errorMessage) }, null);
    } else {
      this.#respondChild(runId, hp.rpcId, { body: typeof body === 'string' ? body : '' }, null);
    }
    this.#broadcast(runId, {
      event: 'hole.answered', holeId: id, at: Date.now(),
    });
  }

  /**
   * Fill a hole a running workflow parked on.
   *
   * An engine run parks its holes inside the engine, and the engine is
   * reached through the control plane. A legacy run parks a child RPC, and
   * that one is answered the old way. A run is one or the other, never
   * both, so the two never contend.
   *
   * @param {string} runId
   * @param {string} holeId
   * @param {string} body
   */
  fillHole(runId, holeId, body) {
    const engine = this._engineControls.get(runId);
    if (engine !== undefined) return this.#fillEngineHole(runId, engine, holeId, body);
    return this.#answerHole(runId, holeId, body, null);
  }

  /**
   * Fill a hole on an engine run.
   *
   * Upstream's fill contract is not "answer this hole" — it is "this run's
   * VALID SCRIPT is now this text". The engine keeps two columns (the
   * original script and the valid one) and a fill replaces the valid one,
   * together with the ask spec table and the site-phase table that go with
   * it. `fillHole(fill: HoleFill)` therefore needs the recompiled script,
   * its hash, the spec table, the phase table and the phase names
   * (upstream: engine/engine-holes.ts, `HoleFill`).
   *
   * A hole's body lives INLINE in the script source, as the fourth argument
   * of the `hole<T>(...)` call — `hole<T>(name, prompt, async () => { ... })`.
   * The lowering extracts it into `holeBodies[siteId]`. So filling a hole
   * means: splice the body into the script text at that hole's call,
   * recompile, and hand the engine the new valid script.
   *
   * @param {string} runId
   * @param {object} engine - the live engine (the control plane's handle)
   * @param {string} holeId - the hole's site id
   * @param {string} body - the body, as source text
   * @returns {{ok: boolean, reason?: string}}
   */
  #fillEngineHole(runId, engine, holeId, body) {
    const s = this.runs.get(runId);
    if (!s) return { ok: false, reason: 'unknown run' };

    const source = typeof body === 'string' ? body.trim() : '';
    if (!source) return { ok: false, reason: 'body is required' };

    // The hole the caller named must be one the engine is actually parked
    // on. Upstream's fill is keyed on the site id, and the engine knows
    // which sites are waiting.
    const open = engine.openHoles?.() ?? [];
    const target = open.find((h) => h.siteId === holeId);
    if (target === undefined) {
      return { ok: false, reason: `no hole is waiting at '${holeId}'` };
    }

    const scriptText = this.#engineScriptText(runId);
    if (!scriptText) return { ok: false, reason: 'the run has no script to fill' };

    const filled = spliceHoleBody(scriptText, target.name, source);
    if (!filled.ok) return filled;

    // Recompile the valid script. A fill that does not compile must not
    // reach the engine: the engine's spec table would then describe a
    // script that does not exist.
    let prepared;
    try {
      prepared = prepareWorkflow(filled.text, {
        models: Array.from(s.modelsAllowed ?? []),
        constants: s._engine?.prepared?.constants ?? {},
      });
    } catch (err) {
      return { ok: false, reason: `the filled script did not compile: ${String(err && err.message || err)}` };
    }
    const diagnostics = collectPreparedDiagnostics(prepared);
    if (!prepared.ok || prepared.lowered.lowered === undefined) {
      const first = diagnostics[0];
      return {
        ok: false,
        reason: first
          ? `the filled script did not compile: ${first.message ?? first.code}`
          : 'the filled script did not compile',
      };
    }

    const lowered = prepared.lowered.lowered;
    const holeBody = lowered.holeBodies?.[target.siteId];
    if (holeBody === undefined) {
      return {
        ok: false,
        reason: `the filled script does not carry a body for '${target.siteId}'`,
      };
    }

    const result = engine.fillHole({
      siteId: target.siteId,
      code: holeBody,
      script: { text: filled.text, hash: inputHash(filled.text) },
      askSpecs: prepared.askSpecs,
      sitePhases: prepared.sitePhases,
      phaseNames: [...new Set(prepared.sitePhases?.values?.() ?? [])],
      holes: [...(prepared.analysis?.core?.holes ?? [])],
      filledBy: 'dsh-workflow-runner',
    });

    if (result?.ok === true) {
      // The hole is no longer waiting. Drop it from dsh's mirror so the
      // editor does not keep offering it.
      s.pendingHoles?.delete(target.siteId);
      this.#appendLog(runId, 'info', `hole filled: ${target.name}`);
    }
    return result ?? { ok: false, reason: 'the engine did not accept the fill' };
  }

  /**
   * The run's original script text, for a fill to splice into.
   *
   * @param {string} runId
   * @returns {string}
   */
  #engineScriptText(runId) {
    const s = this.runs.get(runId);
    const text = s?._engineScriptText ?? s?._engine?.scriptText;
    return typeof text === 'string' ? text : '';
  }

  /**
   * The holes a running workflow is waiting on.
   *
   * @param {string} runId
   * @returns {Array<object>}
   */
  listPendingHoles(runId) {
    const s = this.runs.get(runId);
    if (!s) return [];
    return Array.from(s.pendingHoles.values()).map((h) => ({
      holeId: h.holeId || h.id,
      name: h.name,
      prompt: h.prompt,
    }));
  }

  /**
   * Public answerHole, used by HTTP /api/hole-answer. Same shape as the
   * private method; exposed so the plugin can call it.
   */
  answerHole(runId, holeId, body, errorMessage) {
    return this.#answerHole(runId, holeId, body, errorMessage);
  }

  // --- v0.6.0: escalate (ZCode ResolveWorkflowQuestion + LLM dispatch) ---

  /**
   * Park an escalate() RPC from the child. Same shape as #questionAsk:
   * no response until the user submits via /api/escalate-answer or the
   * LLM dispatch via /api/escalate-think. 5-minute watchdog.
   */
  #escalateAsk(runId, msg) {
    const s = this.runs.get(runId);
    if (!s) return;
    const params = (msg && msg.params) || {};
    const escalateId = String(params.escalateId || ('e-' + msg.id));
    const question = String(params.question || '');
    const kind = String(params.kind || 'text');
    const options = Array.isArray(params.options) ? params.options : null;
    if (!question) {
      this.#respondChild(runId, msg.id, null, new Error('escalate.ask: empty question'));
      return;
    }
    if (s.pendingEscalates && s.pendingEscalates.has(escalateId)) {
      this.#respondChild(runId, msg.id, null,
        new Error(`escalate.ask: escalateId '${escalateId}' already pending`));
      return;
    }
    if (!s.pendingEscalates) s.pendingEscalates = new Map();
    const askedAt = Date.now();
    const timer = setTimeout(() => {
      const cur = this.runs.get(runId);
      const ep = cur && cur.pendingEscalates.get(escalateId);
      if (!ep) return;
      cur.pendingEscalates.delete(escalateId);
      this.#respondChild(runId, ep.rpcId, null,
        new Error(`escalate: no answer within ${QUESTION_TIMEOUT_MS / 1000}s`));
      this.#broadcast(runId, {
        event: 'escalate.timeout', escalateId, at: Date.now(),
      });
    }, QUESTION_TIMEOUT_MS);
    s.pendingEscalates.set(escalateId, {
      rpcId: msg.id, question, kind, options, askedAt, timer,
    });
    this.#broadcast(runId, {
      event: 'escalate.asked',
      escalate: { escalateId, question, kind, options, askedAt, at: askedAt },
    });
  }

  /**
   * Public answerEscalate, used by HTTP /api/escalate-answer. Direct
   * user answer (like askUser).
   */
  answerEscalate(runId, escalateId, answer) {
    const s = this.runs.get(runId);
    if (!s) throw new Error('unknown run');
    const id = String(escalateId || '');
    const ep = s.pendingEscalates && s.pendingEscalates.get(id);
    if (!ep) throw new Error(`no pending escalate with id '${id}'`);
    s.pendingEscalates.delete(id);
    if (ep.timer) clearTimeout(ep.timer);
    // Normalize: confirm kind expects boolean, options expects string.
    let normalized = answer;
    if (ep.kind === 'confirm') {
      if (typeof answer === 'boolean') normalized = answer;
      else if (answer === 'true' || answer === '1') normalized = true;
      else if (answer === 'false' || answer === '0') normalized = false;
      else throw new Error('escalate: confirm question expects a boolean answer');
    } else if (Array.isArray(ep.options) && ep.options.length > 0) {
      if (typeof answer !== 'string' || !ep.options.includes(answer)) {
        throw new Error(`escalate: options question expects one of: ${ep.options.join(', ')}`);
      }
    }
    if (typeof ep.resolve === 'function') {
      // The engine path: the script is waiting inside the driver, in this
      // process. There is no child RPC to answer.
      ep.resolve(normalized);
    } else {
      this.#respondChild(runId, ep.rpcId, normalized, null);
    }
    this.#broadcast(runId, { event: 'escalate.answered', escalateId: id, at: Date.now() });
  }

  /**
   * Public thinkEscalate, used by HTTP /api/escalate-think. Dispatch
   * an LLM call with run context (recent log + question + options) and
   * use its response as the answer. Picks the first model in
   * modelsAllowed (the LLM "thinker" for the run).
   */
  async thinkEscalate(runId, escalateId) {
    const s = this.runs.get(runId);
    if (!s) throw new Error('unknown run');
    const id = String(escalateId || '');
    const ep = s.pendingEscalates && s.pendingEscalates.get(id);
    if (!ep) throw new Error(`no pending escalate with id '${id}'`);
    s.pendingEscalates.delete(id);
    if (ep.timer) clearTimeout(ep.timer);
    // Build context: last 20 log lines + question + options.
    const logTail = (s.log || []).slice(-20)
      .map((l) => `[${l.level}] ${l.message}`).join('\n');
    const optsLine = Array.isArray(ep.options) && ep.options.length > 0
      ? `\nOptions: ${ep.options.map((o) => JSON.stringify(o)).join(', ')}`
      : '';
    const system = [
      'You are helping a workflow decide. The user is the main agent of this workflow.',
      'Recent log lines (last 20):',
      logTail || '(none)',
    ].join('\n');
    const user = `${ep.question}${optsLine}\n\nAnswer concisely. ${ep.kind === 'confirm' ? 'Reply YES or NO only.' : 'If options were given, reply with exactly one of them.'}`;
    // Pick the first allowed model; bail if none.
    const modelId = Array.from(s.modelsAllowed)[0];
    if (!modelId) {
      this.#respondChild(runId, ep.rpcId, null, new Error('escalate: no models allowed for this run; cannot Think via LLM'));
      this.#broadcast(runId, { event: 'escalate.timeout', escalateId: id, at: Date.now() });
      return;
    }
    this.#appendLog(runId, 'info', `escalate: Think via LLM using ${modelId}…`);
    let answer = '';
    try {
      const r = await chat({
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        model: modelId,
        timeoutMs: ASK_TIMEOUT_MS,
      }, this.ctx);
      answer = (r && r.content) || '';
    } catch (err) {
      this.#respondChild(runId, ep.rpcId, null, new Error('escalate: Think via LLM failed: ' + (err && err.message || err)));
      this.#broadcast(runId, { event: 'escalate.timeout', escalateId: id, at: Date.now() });
      return;
    }
    // Normalize answer the same way as the user-supplied path.
    let normalized = answer.trim();
    if (ep.kind === 'confirm') {
      const low = normalized.toLowerCase();
      if (low === 'yes' || low === 'y' || low === 'true') normalized = true;
      else if (low === 'no' || low === 'n' || low === 'false') normalized = false;
      // Pass through if it's already boolean or unparseable; let it surface.
    } else if (Array.isArray(ep.options) && ep.options.length > 0) {
      // Best-effort: find the first option that appears in the answer.
      const match = ep.options.find((o) => normalized.includes(String(o)));
      if (match) normalized = String(match);
    }
    this.#appendLog(runId, 'info', `escalate: Think answer (${normalized.length} chars)`);
    if (typeof ep.resolve === 'function') {
      ep.resolve(normalized);
    } else {
      this.#respondChild(runId, ep.rpcId, normalized, null);
    }
    this.#broadcast(runId, { event: 'escalate.answered', escalateId: id, at: Date.now() });
  }

  // --- v0.5.0: on-disk run history persistence ---

  /**
   * Schedule a debounced write-to-disk for a run. Multiple state changes
   * within PERSIST_DEBOUNCE_MS coalesce into one write.
   */
  #schedulePersist(runId) {
    if (!this._persistDir) return;
    if (this._persistTimers.has(runId)) {
      clearTimeout(this._persistTimers.get(runId));
    }
    const t = setTimeout(() => {
      this._persistTimers.delete(runId);
      this.#writeRunToDisk(runId).catch((err) => {
        // Best-effort: log and continue. A failed write shouldn't kill
        // the run.
        this.#appendLog(runId, 'warn', `persist: write failed: ${err && err.message || err}`);
      });
    }, PERSIST_DEBOUNCE_MS);
    this._persistTimers.set(runId, t);
  }

  /**
   * Synchronously snapshot the run to JSON and write it to
   * `${persistDir}/${runId}.json` via tmp+rename. Best-effort.
   */
  async #writeRunToDisk(runId) {
    if (!this._persistDir) return;
    const s = this.runs.get(runId);
    if (!s) return;
    // Strip non-serializable fields.
    const snap = this.#serializeState(s);
    const dir = this._persistDir;
    try {
      await fsPromisesMkdir(dir, { recursive: true });
    } catch (_) { /* best-effort */ }
    const filePath = join(dir, runId + '.json');
    const tmpPath = filePath + '.tmp';
    try {
      await writeFile(tmpPath, JSON.stringify(snap, null, 2), 'utf8');
      await rename(tmpPath, filePath);
    } catch (err) {
      // Try to clean up the tmp file before bubbling.
      try { await unlink(tmpPath); } catch (_) { /* ignore */ }
      throw err;
    }
  }

  /**
   * Convert a RunState into a JSON-serializable snapshot. We drop fields
   * that hold live OS handles (child process, SSE subscribers, watchdog
   * timer) and keep the journal / pendingHoles / pendingQuestions as
   * plain objects (Maps → arrays).
   */
  #serializeState(s) {
    return {
      runId: s.runId,
      scriptPath: s.scriptPath,
      evalMode: !!s.evalMode,
      status: s.status,
      startedAt: s.startedAt,
      endedAt: s.endedAt,
      exitCode: s.exitCode,
      agents: s.agentsOrder.map((n) => {
        const a = s.agents.get(n);
        return {
          name: a.name, system: a.system, model: a.model,
          temperature: a.temperature, asks: a.asks,
          lastTokens: a.lastTokens, lastDurationMs: a.lastDurationMs,
          createdAt: a.createdAt,
          // Don't serialize full message history (could be large and is
          // rebuildable on amend); just the count.
          messageCount: Array.isArray(a.messages) ? a.messages.length : 0,
        };
      }),
      phases: s.phases,
      phaseSummary: Array.from(s.phaseSummary.values()),
      currentPhase: s.currentPhase,
      log: s.log,
      reports: s.reports,
      artifacts: Array.from(s.artifacts.values()).map((a) => ({
        id: a.id, kind: a.kind, spec: a.spec || null,
        title: a.title || null, description: a.description || null, primary: !!a.primary,
        versions: a.versions,
      })),
      worldRunAllowlist: s.worldRunAllowlist ? Array.from(s.worldRunAllowlist) : null,
      worldRunDeclined: s.worldRunDeclined,
      workspaceRoot: s.workspaceRoot,
      modelsAllowed: Array.from(s.modelsAllowed),
      evalMode: !!s.evalMode,
      journal: s.journal,
      pendingQuestions: Array.from(s.pendingQuestions.entries()).map(([id, q]) => ({
        questionId: id, question: q.question, kind: q.kind, options: q.options, askedAt: q.askedAt,
      })),
      pendingHoles: Array.from(s.pendingHoles.entries()).map(([id, h]) => ({
        holeId: id, name: h.name, prompt: h.prompt, hasContext: h.hasContext, askedAt: h.askedAt,
      })),
      amendFrom: s.amendFrom || null,
      // v0.11.0: amend cache lifecycle — persisted so a chain survives a
      // host restart and so `script_unchanged` still works against an
      // ancestor that was restored from disk.
      cacheOpen: !!s.cacheOpen,
      journalImportDepth: s.journalImportDepth || 0,
      scriptHash: s.scriptHash || null,
      journalTrimmed: s.journalTrimmed || 0,
      // v0.10.0: structural-amend audit trail. The full body is NOT
      // persisted — it can be large and it is user code; a short preview
      // plus the outcome is what you actually want when reading a run
      // back off disk months later.
      injectedStages: (s.injectedStages || []).map((x) => ({
        stageId: x.stageId,
        name: x.name,
        source: x.source,
        codePreview: String(x.body || '').slice(0, 200),
        injectedAt: x.injectedAt,
        startedAt: x.startedAt,
        endedAt: x.endedAt,
        status: x.status,
        result: x.result === undefined ? null : x.result,
        error: x.error,
      })),
    };
  }

  /**
   * On startup, read every .json file in the persist dir and reconstruct
   * a "shell" RunState for each — just enough to support amend-from and
   * /api/runs listing. Live fields (child, subscribers, watchdog, timers)
   * are set to empty / null.
   */
  #loadPersistedRuns() {
    if (!this._persistDir) return;
    let entries;
    try {
      // synchronous readdir — load happens at construction, before the
      // server is listening for HTTP, so sync is fine here.
      entries = readdirSync(this._persistDir, { withFileTypes: true });
    } catch (_) { return; } // dir doesn't exist yet
    for (const ent of entries) {
      if (!ent.isFile() || !ent.name.endsWith('.json')) continue;
      if (ent.name.endsWith('.tmp')) continue; // half-written
      const filePath = join(this._persistDir, ent.name);
      let raw;
      try { raw = readFileSync(filePath, 'utf8'); }
      catch (_) { continue; }
      let snap;
      try { snap = JSON.parse(raw); }
      catch (_) { continue; } // skip corrupted files
      if (!snap || !snap.runId) continue;
      const s = this.#deserializeState(snap);
      this.runs.set(snap.runId, s);
    }
  }

  /**
   * Reverse of #serializeState. Maps array-form fields back to Maps /
   * Sets so the rest of the runtime can consume them uniformly.
   */
  #deserializeState(snap) {
    const agents = new Map();
    for (const a of (snap.agents || [])) {
      agents.set(a.name, {
        name: a.name, system: a.system, model: a.model,
        temperature: a.temperature, asks: a.asks || 0,
        lastTokens: a.lastTokens || null, lastDurationMs: a.lastDurationMs || null,
        createdAt: a.createdAt || 0,
        messages: [], // rebuild on first ask; amend won't replay messages
      });
    }
    const artifacts = new Map();
    for (const a of (snap.artifacts || [])) {
      artifacts.set(a.id, {
        id: a.id, kind: a.kind, spec: a.spec || null,
        title: a.title || null, description: a.description || null, primary: !!a.primary,
        versions: a.versions || [],
      });
    }
    const phaseSummary = new Map();
    for (const p of (snap.phaseSummary || [])) phaseSummary.set(p.name, p);
    const worldRunAllowlist = Array.isArray(snap.worldRunAllowlist)
      ? new Set(snap.worldRunAllowlist) : null;
    const modelsAllowed = new Set(snap.modelsAllowed || ['deepseek-chat']);
    return {
      runId: snap.runId,
      scriptPath: snap.scriptPath,
      evalMode: !!snap.evalMode,
      status: snap.status,
      startedAt: snap.startedAt || 0,
      endedAt: snap.endedAt || null,
      exitCode: snap.exitCode ?? null,
      // Live handles — all null / empty after a process restart.
      child: null,
      agents, agentsOrder: (snap.agents || []).map((a) => a.name),
      phases: snap.phases || [],
      phaseSummary,
      currentPhase: snap.currentPhase || null,
      log: snap.log || [],
      reports: snap.reports || [],
      artifacts,
      worldRunAllowlist,
      worldRunDeclined: snap.worldRunDeclined || [],
      workspaceRoot: snap.workspaceRoot || null,
      modelsAllowed,
      journal: snap.journal || [],
      pendingQuestions: new Map(),
      pendingHoles: new Map(),
      pendingEscalates: new Map(),
      amendFrom: snap.amendFrom || null,
      // v0.11.0: restored for audit. A disk-restored shell has no live
      // child, so its cache can never be consulted again — `cacheOpen`
      // is forced false; only `scriptHash` / `journalImportDepth` carry
      // forward, because the NEXT amend needs them.
      cacheOpen: false,
      journalImportDepth: snap.journalImportDepth || 0,
      scriptHash: snap.scriptHash || null,
      journalTrimmed: snap.journalTrimmed || 0,
      // v0.10.0: restored for audit. These runs are shells — there is no
      // child to inject into — so `body` is gone (never persisted) and
      // every entry is terminal as far as this process is concerned.
      injectedStages: (snap.injectedStages || []).map((x) => ({ ...x, body: '' })),
      pendingStageCalls: new Map(),
      _nextHostId: 1,
      subscribers: new Set(),
      _stopRequested: false,
      watchdog: null,
      _loadedFromDisk: true,
    };
  }

  /**
   * Public: list every known run, including those loaded from disk but
   * no longer in this process's live state. For now, the in-memory
   * map is the source of truth (disk-loaded runs are in it too).
   */
  listAllRuns(opts = {}) {
    const includeFromDisk = opts.includeFromDisk !== false;
    const out = [];
    for (const s of this.runs.values()) {
      out.push({
        runId: s.runId,
        scriptPath: s.scriptPath,
        status: s.status,
        startedAt: s.startedAt,
        endedAt: s.endedAt,
        loadedFromDisk: !!s._loadedFromDisk,
        amendFrom: s.amendFrom || null,
        // v0.10.0: how many stages were amended into this run, so the
        // runs list can badge them without loading full state.
        stageCount: (s.injectedStages || []).length,
      });
    }
    if (includeFromDisk) {
      // The disk listing is already merged into this.runs via
      // #loadPersistedRuns(), so this branch is a no-op. Kept as a hook
      // for future "scan disk without populating memory" callers.
    }
    out.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
    return out;
  }
}

