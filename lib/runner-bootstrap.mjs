// dsh-workflow-runner —— 子进程侧 facade。
//
// 本文件由 lib/runtime.js 通过 `node lib/runner-bootstrap.mjs <userScriptPath>` 启动。
// 通过 stdin/stdout 的 JSON-RPC 与宿主通讯：宿主发来请求，本进程解析并执行后回送结果。
// 用户脚本通过 globalThis.__dsh 拿到 facade（agent、world.run、phase、log、report）。
//
// 用法（用户脚本）：
//
//   const { agent, world, phase, log, report, files, git, channel, future, model, args }
//     = globalThis.__dsh;
//   phase('Plan a fix');
//   const plan = await agent('planner', { system: 'You are a senior planner.' })
//                   .ask('Plan a fix for the bug described as: ...');
//   report({ plan }, 'plan');
//   const todos = await files.grep('TODO', '**/*.mjs');  // 读工作区
//   for await (const fact of channel('facts')) { ... }    // 阶段间流
//   await Promise.all([future(workA), future(workB)]);    // 并行 stage
//
// 顶层 await 也支持（ESM 模块顶部 await 在动态 import() 解析时就会同步等待）。
//
// 协议（行分隔 JSON；stdout 输出会被父进程解析）：
//
//   请求（宿主 → 本进程；stdin）：  {"id":N,"method":"<method>","params":{...}}
//   响应（本进程 → 宿主；stdout）：{"id":N,"result":<value>} 或 {"id":N,"error":{"message":"..."}}
//   通知（本进程 → 宿主；stdout）：{"notify":"ready|started|finished|error","runId":"...","at":<ms>}
//
// 设计要点：
//   - 每个 agent.handle 是宿主分配的整数 id；本进程只持有映射，本地不再有 LLM 历史
//   - 同 name 的 agent 在不同 ask() 之间复用宿主侧的 chat history，由宿主维护
//   - 30 分钟 watchdog 超时；用户脚本 catch 不到的顶层错误会被宿主转成 run.error
//
'use strict';

import { createInterface } from 'node:readline';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import { resolve as resolvePath } from 'node:path';
import { readFileSync, statSync } from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';

const scriptPathArg = process.argv[2];
const stdin = createInterface({ input: process.stdin, crlfDelay: Infinity });

let nextId = 1;
const pending = new Map(); // id -> {resolve, reject}
let closed = false;

function send(obj) {
  if (closed) return;
  try { process.stdout.write(JSON.stringify(obj) + '\n'); }
  catch (_) { /* parent gone */ }
}

/** Send an RPC request and await the response. */
function rpc(method, params) {
  if (closed) return Promise.reject(new Error('runner closed'));
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    send({ id, method, params });
  });
}

// --- v0.10.0: host → child requests (structural amend) ---
//
// The wire already carries `{id, result|error}` (our responses to the
// host's... actually: our *requests* use `id`, the host's replies use
// `id` too). v0.10.0 adds the third shape: the host pushing a NEW call
// down to us, tagged `hostId` so it can never be confused with a reply
// to a request we made. Answer with `{hostId, result|error}`.
const hostHandlers = new Map();

/** Correlation fields echoed back on every host reply, error or not. */
function hostCorrelation(msg) {
  const p = msg.params;
  if (p && typeof p.stageId === 'string' && p.stageId) return { stageId: p.stageId };
  return null;
}

function replyHost(hostId, result, error, extra) {
  // `extra` carries a correlation field (stageId) so the host can settle
  // the right waiter when a request is REJECTED rather than answered.
  const base = extra ? { hostId, ...extra } : { hostId };
  send(error
    ? { ...base, error: { message: String(error && error.message || error) } }
    : { ...base, result });
}

function onLine(line) {
  if (!line) return;
  let msg;
  try { msg = JSON.parse(line); }
  catch (_) { return; }
  // v0.10.0: host-initiated request (structural amend / introspection).
  if (typeof msg.hostId === 'number') {
    const handler = hostHandlers.get(String(msg.method || ''));
    if (!handler) {
      replyHost(msg.hostId, null, new Error('unknown host method: ' + msg.method));
      return;
    }
    Promise.resolve()
      .then(() => handler(msg.params || {}))
      .then((r) => replyHost(msg.hostId, r === undefined ? null : r, null, hostCorrelation(msg)))
      .catch((err) => replyHost(msg.hostId, null, err, hostCorrelation(msg)));
    return;
  }
  if (typeof msg.id !== 'number' || !pending.has(msg.id)) return;
  const { resolve, reject } = pending.get(msg.id);
  pending.delete(msg.id);
  if (msg.error) reject(new Error(msg.error.message || 'rpc error'));
  else resolve(msg.result);
}

stdin.on('line', onLine);
stdin.on('close', () => {
  closed = true;
  for (const { reject } of pending.values()) reject(new Error('runner stdin closed'));
  pending.clear();
});

process.on('uncaughtException', (err) => {
  send({ notify: 'error', message: String(err && err.stack || err) });
});
process.on('unhandledRejection', (err) => {
  send({ notify: 'error', message: 'unhandledRejection: ' + String(err && err.stack || err) });
});

// --- 用户侧 facade ---

function agentFactory(name, opts) {
  return {
    name,
    opts: opts || {},
    async ask(prompt, askOpts) {
      // v0.4.0: forward `result` shape (a plain object describing the
      // expected structure) so the host can request JSON-mode from the LLM
      // and validate. Without `result`, behavior is unchanged.
      const a = askOpts || {};
      const resp = await rpc('agent.ask', {
        name,
        system: (opts && opts.system) || null,
        model: (opts && opts.model) || null,
        temperature: typeof (opts && opts.temperature) === 'number' ? opts.temperature : undefined,
        prompt,
        askOpts: {
          maxTokens: a.maxTokens,
          resultShape: a.result || null,
        },
      });
      // When the user asked for a typed result, the host returns
      // { content: <parsed object>, usage, typed: true }. Unwrap so user
      // code does `const plan = await agent(...).ask(...)` and gets `plan`
      // directly.
      if (resp && resp.typed && 'content' in resp) return resp.content;
      return resp;
    },
    close() {
      // server tracks by name; close by sending a synthetic close intent (no-op semantics server-side)
      return rpc('agent.close', { name });
    },
  };
}
const agent = new Proxy(agentFactory, {
  apply(_t, _this, args) { return agentFactory.apply(null, args); },
  get(_t, prop) { return agentFactory[prop]; },
});

async function worldRun(cmd, args, opts) {
  return rpc('world.run', { cmd, args: args || [], opts: opts || {} });
}
async function phase(name) {
  return rpc('phase', { name });
}
async function log(message, level) {
  return rpc('log', { message: String(message), level: level || 'info' });
}
async function report(item, tag) {
  return rpc('report', { item, tag: tag || null });
}

// --- artifact facade (ZCode-style deliverables) ---
//
//   artifact.chart(id, spec)    — declare a chart fed by report(item, id)
//   artifact.table(id, spec)    — declare a table
//   artifact.metrics(id, spec)  — declare a metrics tile row
//   artifact.board(id, spec)    — declare a kanban board
//   artifact.markdown(id, md, opts)  — publish markdown text
//   artifact.file(id, path, opts)    — publish a workspace file (text)
//
// declare() returns {ok:true}; publish() returns {id, version}.
//
// IDs must be unique per run; the host enforces that and rejects duplicates.

const PRESET_KINDS = new Set(['chart', 'table', 'metrics', 'board']);
const PUBLISH_KINDS = new Set(['markdown', 'file']);

async function artifactDeclare(kind, id, spec) {
  if (!PRESET_KINDS.has(kind)) throw new Error(`artifact.${kind}: unknown kind`);
  if (typeof id !== 'string' || !id) throw new Error(`artifact.${kind}: id must be a non-empty string`);
  return rpc('artifact.declare', { id, kind, spec: spec || {} });
}
async function artifactPublish(kind, id, payload, opts) {
  if (!PUBLISH_KINDS.has(kind)) throw new Error(`artifact.${kind}: unknown kind`);
  if (typeof id !== 'string' || !id) throw new Error(`artifact.${kind}: id must be a non-empty string`);
  const o = opts || {};
  if (kind === 'file') {
    // Read the file here in the child so the host only sees text. 20 MB hard cap to
    // mirror ZCode's cap; binary detection is best-effort (NUL byte in first 8KB).
    const abs = resolvePath(String(payload || ''));
    let stat;
    try { stat = statSync(abs); } catch (err) { throw new Error('artifact.file: ' + err.message); }
    if (stat.size > 20 * 1024 * 1024) throw new Error('artifact.file: file exceeds 20MB cap');
    let text;
    try { text = readFileSync(abs, 'utf8'); }
    catch (err) { throw new Error('artifact.file: cannot read as utf-8 (binary files not supported): ' + err.message); }
    if (text.indexOf('\0') !== -1) throw new Error('artifact.file: file appears to be binary; only text is supported');
    return rpc('artifact.publish', {
      id, kind: 'file', content: text, contentType: 'text/plain; charset=utf-8',
      filename: abs.split(/[\\/]/).pop(),
      title: o.title, description: o.description, primary: !!o.primary,
    });
  }
  // markdown
  const text = String(payload == null ? '' : payload);
  if (text.length > 256 * 1024) throw new Error('artifact.markdown: content exceeds 256KB cap');
  return rpc('artifact.publish', {
    id, kind: 'markdown', content: text,
    title: o.title, description: o.description, primary: !!o.primary,
  });
}

const artifact = {
  chart:    (id, spec)        => artifactDeclare('chart',    id, spec),
  table:    (id, spec)        => artifactDeclare('table',    id, spec),
  metrics:  (id, spec)        => artifactDeclare('metrics',  id, spec),
  board:    (id, spec)        => artifactDeclare('board',    id, spec),
  markdown: (id, content, o)  => artifactPublish('markdown', id, content, o),
  file:     (id, path, o)     => artifactPublish('file',     id, path, o),
};

// --- args: read DSH_WORKFLOW_ARGS env, expose as a frozen plain object. ---
//
// The host passes the run's args (from POST /api/run body) as a JSON env var.
// We do best-effort deep sanitization via JSON round-trip and freeze the top
// level. Scripts should narrow with String()/Number() before use.

function readArgs() {
  const raw = process.env.DSH_WORKFLOW_ARGS || '{}';
  if (raw.length > 64 * 1024) throw new Error('DSH_WORKFLOW_ARGS exceeds 64KB cap');
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch (_) { parsed = {}; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) parsed = {};
  let safe;
  try { safe = JSON.parse(JSON.stringify(parsed)); }
  catch (_) { safe = {}; }
  return Object.freeze(safe);
}
const args = readArgs();

// --- files: workspace read views (RPCs to host). ---
//
// All paths must resolve under the host's workspaceRoot. The host validates
// this; we just send the path and let it reject. results are recorded so
// resume / amend can replay without re-reading.

const files = {
  glob(pattern) {
    return rpc('files.glob', { pattern: String(pattern || '') });
  },
  read(path) {
    return rpc('files.read', { path: String(path || '') });
  },
  grep(pattern, glob) {
    return rpc('files.grep', {
      pattern: String(pattern || ''),
      glob: glob != null ? String(glob) : null,
    });
  },
};

// --- git: read-only git views (RPCs to host). ---
//
// Outside a git repository (or without git in PATH) every call rejects
// catchably; scripts can `try { ... } catch { ... }` to fall back.

const git = {
  changedFiles(base) {
    return rpc('git.changedFiles', { base: base != null ? String(base) : null });
  },
  diff(base, path) {
    return rpc('git.diff', {
      base: base != null ? String(base) : null,
      path: path != null ? String(path) : null,
    });
  },
  status() {
    return rpc('git.status', {});
  },
  log(count) {
    return rpc('git.log', { count: typeof count === 'number' ? count : null });
  },
};

// --- channel<T>: in-process stream between two stages. ---
//
// Modeled on ZCode's dynamic-workflows channel (§16.2): a single-producer /
// single-consumer FIFO with async iteration. The producing side owns
// close() (call in `finally` to release a stalled consumer).
//
// Throws ChannelClosed on send after close. No host RPCs — entirely in the
// child process, like ZCode.
//
// v0.12.0 adds DEADLOCK DETECTION, and it is worth being precise about
// what a deadlock is here, because the obvious definition is wrong:
//
//   WRONG: "close() was called while a consumer was waiting" → that is
//   the NORMAL termination path. close() is exactly how a producer
//   releases its consumers, and `for await (const x of ch)` ends when
//   the channel closes. Treating that as a deadlock would fail every
//   correct pipeline (samples/channel-pipeline.mjs relies on it).
//
//   RIGHT: "the producer is GONE but the channel was never closed, and
//   a consumer is still blocked on it". The consumer will never be
//   woken, because the only thing that wakes it is a send or a close,
//   and neither will ever come. That is the deadlock.
//
// To know the producer is "gone" we need to know which future owns the
// channel — hence AsyncLocalStorage: a channel created inside a
// future() body records that future as its owner, and when the future
// settles we can ask "did you leave a channel open with waiters on it?".
//
// Note the channel is NOT keyed by name. `channel('x')` returns a fresh
// object every call; two calls are unrelated. A name-keyed registry
// would be a breaking change to the facade, so the detector tracks
// channels by object identity instead.

const futureScope = new AsyncLocalStorage();
const liveChannels = new Set();   // every channel that has not been closed
let pendingFutures = 0;

function channel(name) {
  const queue = [];
  let closed = false;
  const waiters = [];
  let sent = 0;

  function wakeWaitersWithDone() {
    while (waiters.length > 0) {
      waiters.shift().resolve({ value: undefined, done: true });
    }
  }

  // Internal bookkeeping for the deadlock detector.
  //
  // `producers` is the set of future scopes that may still call send()
  // on this channel — the scope that created it, plus every scope that
  // has sent on it. When all of them have settled, no more items can
  // ever arrive, and an unclosed channel with a consumer still blocked
  // on it is a deadlock.
  //
  // Attributing by SENDER (not just creator) matters: the common shape
  // is a channel created at the top level of the script and fed from a
  // future. The creator scope is null there, so creator-only attribution
  // would never fire.
  const meta = {
    name: name || null,
    waiters,
    get waiterCount() { return waiters.length; },
    get closed() { return closed; },
    get sent() { return sent; },
    reported: false,
    producers: new Set(),
    hadProducer: false,
    producerGone: false,
    lastActivity: Date.now(),
    wakeAll: wakeWaitersWithDone,
  };

  const createScope = futureScope.getStore() || null;
  if (createScope) {
    meta.producers.add(createScope);
    meta.hadProducer = true;
    if (Array.isArray(createScope.channels)) createScope.channels.push(meta);
  }
  liveChannels.add(meta);

  function claimProducerScope() {
    const scope = futureScope.getStore();
    if (!scope) return;
    if (meta.producers.has(scope)) return;
    meta.producers.add(scope);
    meta.hadProducer = true;
    if (Array.isArray(scope.channels) && !scope.channels.includes(meta)) {
      scope.channels.push(meta);
    }
  }

  function checkDeadlock() {
    // The producer is gone, the channel was never closed, and a
    // consumer is blocked. Nothing will ever wake it.
    if (meta.reported || meta.closed) return;
    if (!meta.producerGone) return;
    if (meta.waiterCount === 0) return;
    reportChannelDeadlock(meta, 'producer finished without closing the channel');
  }

  return {
    name: meta.name,
    send(item) {
      if (closed) throw new Error('ChannelClosed: ' + (name || 'channel'));
      sent += 1;
      meta.lastActivity = Date.now();
      claimProducerScope();
      if (waiters.length > 0) {
        waiters.shift().resolve({ value: item, done: false });
      } else {
        queue.push(item);
      }
    },
    close() {
      if (closed) return;
      closed = true;
      meta.lastActivity = Date.now();
      wakeWaitersWithDone();
      liveChannels.delete(meta);
    },
    [Symbol.asyncIterator]() {
      return {
        next: () => {
          if (queue.length > 0) {
            return Promise.resolve({ value: queue.shift(), done: false });
          }
          if (closed) return Promise.resolve({ value: undefined, done: true });
          return new Promise((resolve) => {
            waiters.push({ resolve });
            // A consumer can only block AFTER the producer is gone if
            // the producer settled a moment earlier. Check here as
            // well as at producer-settle time, so we do not miss the
            // race where the consumer arrives just after the producer
            // finished.
            checkDeadlock();
          });
        },
      };
    },
    __meta: meta,
  };
}

/**
 * v0.12.0: report a channel deadlock to the host and release the
 * blocked consumers so the run does not hang forever.
 */
function reportChannelDeadlock(meta, reason) {
  if (meta.reported) return;
  meta.reported = true;
  const waiters = meta.waiterCount;
  // Wake the consumers first: an unresolved `next()` promise is what
  // keeps the run alive, and the host kill would land on a process
  // that is still holding them.
  meta.wakeAll();
  try {
    rpc('channel.deadlock', {
      name: meta.name,
      waiters,
      sent: meta.sent,
      reason,
    });
  } catch (_) { /* host gone */ }
}

// --- future<T>: run an async block as a concurrent stage. ---
//
// Starts the body on the next microtask and returns its promise. No host
// involvement; the body shares this process with its siblings. Multiple
// futures are concurrent JS, with one shared event loop.
//
// v0.12.0: the body runs inside an AsyncLocalStorage scope, so any
// channel it creates knows which future owns it. When the future
// settles, channels it left open with waiters on them are deadlocks.

function future(body) {
  const scope = { channels: [] };
  pendingFutures += 1;
  const p = Promise.resolve().then(() => futureScope.run(scope, () => body()));
  const done = () => {
    pendingFutures -= 1;
    // This producer is gone. For every channel it fed: if no other
    // producer remains and the channel was never closed, a consumer
    // blocked on it can never be woken.
    for (const meta of scope.channels) {
      meta.producers.delete(scope);
      if (meta.hadProducer && meta.producers.size === 0) {
        meta.producerGone = true;
        if (!meta.closed && meta.waiterCount > 0) {
          reportChannelDeadlock(meta, 'producer future finished without closing the channel');
        }
      }
    }
  };
  p.then(done, done);
  return p;
}

/**
 * v0.12.0: called when the user's main function returns. If no futures
 * are still running and a consumer is still blocked on a channel that
 * was never closed, the workflow cannot make progress — report it.
 */
function checkForOrphanedConsumers() {
  if (pendingFutures > 0) return;   // futures still running — not orphaned yet
  for (const meta of liveChannels) {
    if (!meta.closed && meta.waiterCount > 0) {
      reportChannelDeadlock(meta, 'workflow finished while a consumer was still waiting on the channel');
    }
  }
}

// --- model(id): ModelRef marker. ---
//
// ZCode's MODELS table: declare the models a run may use up front, then pass
// the marker into agent(name, { model }). The host validates the id against
// its allowedModels allowlist and rejects anything else.

function model(id) {
  if (typeof id !== 'string' || !id) throw new Error('model(): id must be a non-empty string');
  return { __modelRef: true, id };
}

// --- hole<T>(name, prompt, ctx?, body?): mid-run code injection (ZCode-style) ---
//
// Three forms:
//   1) hole(name, prompt, ctx)
//        Unfilled: child sends hole.wait RPC, parks; user (or main agent)
//        fills via /api/hole-answer; the body comes back as a string. We
//        eval it as `new AsyncFunction('ctx', body)(ctx)` to get the
//        result. The body has access to `ctx` and to `globalThis.__dsh`
//        (the facade). It does NOT have access to the script's lexical
//        scope, so the user must pass any needed locals in `ctx`.
//   2) hole(name, prompt, ctx, bodyFn)
//        Filled with a function (run immediately).
//   3) hole(name, prompt, bodyFn)
//        Filled, no ctx.
//
// 10-minute host-side watchdog covers "UI never answers" case.

const pendingHoles = new Map(); // holeId -> { resolve, reject }

function hole(name, prompt, ctxOrBody, maybeBody) {
  if (typeof name !== 'string' || !name) {
    return Promise.reject(new Error('hole: name must be a non-empty string'));
  }
  // Form 2/3: filled — body is a function
  if (typeof ctxOrBody === 'function') {
    const bodyFn = ctxOrBody;
    const ctx = (maybeBody !== undefined) ? maybeBody : undefined;
    return Promise.resolve().then(() => bodyFn(ctx));
  }
  // Form 1: unfilled
  const ctx = (ctxOrBody !== undefined) ? ctxOrBody : undefined;
  const hasContext = ctx !== undefined;
  const holeId = (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function')
    ? globalThis.crypto.randomUUID()
    : ('h-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10));
  return new Promise((resolve, reject) => {
    pendingHoles.set(holeId, { resolve, reject });
    rpc('hole.wait', {
      holeId, name, prompt: String(prompt == null ? '' : prompt),
      hasContext,
    }).then(
      (resp) => {
        pendingHoles.delete(holeId);
        if (!resp || !resp.body) {
          // Empty body: treat as a no-op (caller sees undefined).
          resolve(undefined);
          return;
        }
        if (resp.error) {
          reject(new Error(String(resp.error)));
          return;
        }
        try {
          // Eval the body as an AsyncFunction. The body is expected to be
          // a function expression like `({x}) => x * 2` or `(ctx) => doStuff(ctx)`.
          // We wrap it as `(BODY)(ctx)` so the user's arrow function is
          // actually called. It has access to `ctx` (the third arg) and
          // to globalThis.__dsh.
          const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
          const fn = new AsyncFunction('ctx', 'return (async () => ( ' + resp.body + ' )(ctx))();');
          resolve(fn(ctx));
        } catch (err) {
          reject(err);
        }
      },
      (err) => {
        pendingHoles.delete(holeId);
        reject(err);
      },
    );
  });
}

// --- v0.6.0: shape helper + t.* builder + route() + models array ---

// `t` is a tiny fluent builder for typed `ask<T>` results. It produces
// the same plain-object shape the host's `#shapeToJsonSchema` already
// understands (v0.4.0), so this is a documentation sugar — `t.string` and
// `'string'` are interchangeable from the host's point of view. The
// win is JSDoc friendliness: an IDE can highlight `t.string` as a
// known constant where a string literal is just a string.
const t = {
  string: 'string',
  number: 'number',
  boolean: 'boolean',
  // `array(item)` describes an array of `item`. Mirrors ZCode's `['string']`
  // shape syntax one-for-one; just lets you write `t.array(t.string)`
  // without bracket noise.
  array: (item) => [item],
  // `optional(s)` is a passthrough marker — every object field is already
  // required by the v0.4.0 strict schema, so this is currently a no-op.
  // Kept for forward-compatibility: a future round could make `optional`
  // fields actually optional in the JSON schema.
  optional: (s) => s,
};

// `shape(s)` is identity — it just renames the shape to make intent
// obvious at the call site. The runtime never sees the wrapper.
function shape(s) { return s; }

// `route(MODELS, routerFn, answererFn)` — one-call multi-model routing.
// Encapsulates the pattern from `samples/model-router.mjs`:
//   1. Run `routerFn(MODELS.light)` and parse the JSON it returns
//      (expected shape: `{"tier": "light" | "strong"}`).
//   2. Pick the matching `MODELS[tier]` (fallback to `light` on parse error).
//   3. Run `answererFn(MODELS[tier])` and return its result.
//
// The user supplies both functions, so the LLM prompts are theirs.
// `MODELS` is a plain `{ light: ModelRef, strong: ModelRef, ... }`.
async function route(MODELS, routerFn, answererFn) {
  const tierNames = Object.keys(MODELS);
  if (tierNames.length === 0) throw new Error('route: MODELS is empty');
  const light = MODELS.light || MODELS[tierNames[0]];
  let tier = 'light';
  try {
    const raw = await routerFn(light);
    const text = typeof raw === 'string' ? raw : (raw && raw.content) || '';
    const m = text.match(/\{[\s\S]*?"tier"[\s\S]*?\}/);
    if (m) {
      const parsed = JSON.parse(m[0]);
      if (parsed && typeof parsed.tier === 'string' && MODELS[parsed.tier]) {
        tier = parsed.tier;
      }
    }
  } catch (_) { /* fall through to light */ }
  return await answererFn(MODELS[tier]);
}

// v0.6.0: list the model ids the run is allowed to use, parsed from
// `DSH_WORKFLOW_MODELS` env (set by the host in `runtime.start()`).
// This is the runtime equivalent of ZCode's `ListModels` tool — a
// subagent can `__dsh.models.forEach(...)` to discover what's available.
const runModels = (process.env.DSH_WORKFLOW_MODELS || '').split(',').map((s) => s.trim()).filter(Boolean);

// --- askUser(question, opts): ask the human a question mid-run (ZCode-style escalation) ---
//
// Sends a 'question.ask' RPC. The host parks the request and broadcasts
// 'question.asked' over SSE; the editor (or API caller) submits an answer
// via POST /api/question-answer, the host responds on the original RPC id,
// and this Promise resolves with the answer.
//
// opts:
//   kind: 'text' (default) | 'confirm'   — confirm returns boolean
//   options: string[]                    — when set, editor renders a <select>
//
// 5-minute host-side watchdog covers the "UI never answers" case.

const pendingQuestions = new Map(); // questionId -> { resolve, reject }

function askUser(question, opts) {
  const o = opts || {};
  if (typeof question !== 'string' || !question) {
    return Promise.reject(new Error('askUser: question must be a non-empty string'));
  }
  const questionId = (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function')
    ? globalThis.crypto.randomUUID()
    : ('q-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10));
  return new Promise((resolve, reject) => {
    pendingQuestions.set(questionId, { resolve, reject });
    rpc('question.ask', {
      questionId,
      question,
      kind: o.kind || 'text',
      options: Array.isArray(o.options) ? o.options : null,
    }).then(
      (answer) => {
        pendingQuestions.delete(questionId);
        resolve(answer);
      },
      (err) => {
        pendingQuestions.delete(questionId);
        reject(err);
      },
    );
  });
}

// v0.6.0: escalate(question, opts) — "ask the main agent". Same parked-
// RPC shape as askUser, but the editor offers a "Think via LLM" button
// that triggers the host to dispatch an LLM call (with the run's recent
// log + question as context) and use its response as the answer. So:
//
//   await escalate('Which approach?', { options: ['A', 'B'] })
//     → user picks A | B | "Think via LLM" → unblock
//   await escalate('Decide.', { kind: 'confirm' })
//     → user picks yes | no | "Think via LLM" → unblock
//
// The LLM context is built host-side from the run's log + phase
// summary, so subagents don't need to know the model id or pass
// context themselves. `thinkWith?: string` is accepted but not used
// by this round (host picks the first allowed model).
const pendingEscalates = new Map();

function escalate(question, opts) {
  const o = opts || {};
  if (typeof question !== 'string' || !question) {
    return Promise.reject(new Error('escalate: question must be a non-empty string'));
  }
  const escalateId = (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function')
    ? globalThis.crypto.randomUUID()
    : ('e-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10));
  return new Promise((resolve, reject) => {
    pendingEscalates.set(escalateId, { resolve, reject });
    rpc('escalate.ask', {
      escalateId,
      question,
      kind: o.kind || 'text',
      options: Array.isArray(o.options) ? o.options : null,
    }).then(
      (answer) => {
        pendingEscalates.delete(escalateId);
        resolve(answer);
      },
      (err) => {
        pendingEscalates.delete(escalateId);
        reject(err);
      },
    );
  });
}

// --- v0.10.0: structural amend — stages injected by the host mid-run ---
//
// ZCode's `AmendWorkflow` injects a *new stage* into a workflow that is
// already running. v0.5.0's `amendFrom` is the other half of the idea —
// re-run a finished workflow with a warm cache. This is the live one.
//
// The injected stage runs **in this process**, so it gets the exact same
// facade as the user's script: the same `agent` handles (and therefore the
// same chat history), the same `world.run` allowlist, the same sandboxed
// env, the same workspace confinement. That is the whole point — the
// injected stage is a peer of the script's own `future()` blocks.
//
// Body convention matches `hole()`: a function-expression string that gets
// called with `ctx`. As a convenience we also accept a bare statement
// block (anything that fails to parse as a function expression is retried
// as a statement body), so multi-statement stages don't need ceremony.
//
// The stage is fire-and-forget by default, but the bootstrap drains
// outstanding stages before signalling `finished`, so an injection that
// lands just before the script returns still completes.

const stageRecords = new Map(); // stageId -> {id, name, status, at, startedAt, endedAt, result?, error?}
const inFlightStages = new Set(); // Promises for stages currently executing
let runFinished = false;          // set right before the `finished` notify

const STAGE_DRAIN_MS = parseInt(process.env.DSH_WORKFLOW_STAGE_DRAIN_MS, 10) || 120_000;
const STAGE_MAX_BODY = 64 * 1024;

/** Drop leading whitespace and line/block comments so that an
 *  `export default` can be recognised even when the stage file opens
 *  with a docblock. */
function stripLeadingComments(src) {
  let s = String(src);
  for (;;) {
    const t = s.replace(/^\s+/, '');
    if (t.startsWith('//')) {
      const i = t.indexOf('\n');
      if (i === -1) return '';
      s = t.slice(i + 1);
      continue;
    }
    if (t.startsWith('/*')) {
      const i = t.indexOf('*/');
      if (i === -1) return t;
      s = t.slice(i + 2);
      continue;
    }
    return t;
  }
}

function compileStageBody(body) {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const trimmed = String(body).trim();

  // Three accepted shapes, tried in order:
  //   1. `export default <expr>;`  — what a standalone .mjs stage file
  //      naturally looks like, so one file can be both a runnable
  //      sample and an injectable stage body.
  //   2. a bare function expression — the `hole()` convention.
  //   3. a bare statement block, `return` allowed inside.
  //
  // NOTE on shape 1/2: the `( SRC )(ctx)` call must live INSIDE the
  // arrow body. Writing `( SRC )(__dsh)` or `(async () => ( SRC ))(ctx)`
  // evaluates to the function itself instead of calling it — which
  // then stringifies into the stage's "result" and looks like it
  // silently worked.
  const candidates = [];
  const head = stripLeadingComments(trimmed);
  const exported = head.match(/^export\s+default\s+/);
  if (exported) {
    const offset = trimmed.length - head.length + exported[0].length;
    candidates.push(trimmed.slice(offset).replace(/;\s*$/, ''));
  }
  candidates.push(trimmed);

  for (const src of candidates) {
    try {
      return new AsyncFunction('ctx', '__dsh', 'return (async () => ( ' + src + ' )(ctx))();');
    } catch (_) { /* not a function expression — try the next shape */ }
  }
  return new AsyncFunction('ctx', '__dsh', 'return (async () => {\n' + body + '\n})();');
}

async function runInjectedStage(params) {
  const stageId = String((params && params.stageId) || '');
  const name = String((params && params.name) || 'injected-stage');
  const body = String((params && params.body) == null ? '' : params.body);
  const ctx = (params && params.ctx) || {};
  if (!stageId) throw new Error('stage.inject: stageId required');
  if (!body) throw new Error('stage.inject: body is empty');
  if (body.length > STAGE_MAX_BODY) {
    throw new Error('stage.inject: body exceeds ' + STAGE_MAX_BODY + ' byte cap');
  }
  if (runFinished) {
    throw new Error('stage.inject: run already finished — cannot inject into a terminal run');
  }

  const rec = {
    id: stageId,
    name,
    status: 'running',
    injectedAt: Date.now(),
    startedAt: Date.now(),
    endedAt: null,
    result: undefined,
    error: null,
  };
  stageRecords.set(stageId, rec);
  send({ notify: 'stage.started', stageId, name, at: rec.startedAt });

  try {
    const fn = compileStageBody(body);
    // The stage shares this event loop with the user's script, so it
    // interleaves at every `await` — same semantics as `future()`.
    const value = await fn(ctx, globalThis.__dsh);
    rec.status = 'completed';
    rec.result = value === undefined ? null : safeResult(value);
    rec.endedAt = Date.now();
    send({
      notify: 'stage.finished', stageId, name,
      status: 'completed', result: rec.result,
      durationMs: rec.endedAt - rec.startedAt, at: rec.endedAt,
    });
    return rec.result;
  } catch (err) {
    rec.status = 'error';
    rec.error = String(err && err.message || err);
    rec.endedAt = Date.now();
    // A failing injected stage must NOT take the user's run down with it —
    // it is an amendment, not part of the original plan.
    send({
      notify: 'stage.finished', stageId, name,
      status: 'error', error: rec.error,
      durationMs: rec.endedAt - rec.startedAt, at: rec.endedAt,
    });
    return null;
  }
}

/** Wait for every in-flight injected stage, bounded by `timeoutMs`. */
async function drainStages(timeoutMs) {
  if (inFlightStages.size === 0) return;
  const limit = Number.isFinite(timeoutMs) ? Number(timeoutMs) : STAGE_DRAIN_MS;
  await Promise.race([
    Promise.allSettled(Array.from(inFlightStages)),
    new Promise((resolve) => setTimeout(resolve, limit)),
  ]);
}

hostHandlers.set('stage.inject', (params) => {
  const p = runInjectedStage(params);
  inFlightStages.add(p);
  p.finally(() => inFlightStages.delete(p));
  // Acknowledge immediately with the stageId so the host can broadcast
  // `stage.injected` without waiting for the body to finish.
  return { accepted: true, stageId: String((params && params.stageId) || '') };
});

hostHandlers.set('stage.list', () => Array.from(stageRecords.values()).map((r) => ({ ...r })));
hostHandlers.set('stage.pending', () => inFlightStages.size);

// v0.12.0: the host's own view of the concurrency limiter. A script
// cannot measure this from the outside — the time an ask spends WAITING
// for a slot is not the time it spends holding one, so a client-side
// count of "asks in flight" over-counts. The host knows the real
// number, so it is the host that reports it.
hostHandlers.set('concurrency.stat', () => rpc('concurrency.stat', {}));

// Script-side view. `stages.await()` lets a workflow explicitly join the
// amendments instead of relying on the pre-exit drain.
const stages = {
  list: () => Promise.resolve(Array.from(stageRecords.values()).map((r) => ({ ...r }))),
  pending: () => inFlightStages.size,
  await: (opts) => drainStages((opts && opts && opts.timeoutMs) || undefined),
};

// v0.12.0: concurrency telemetry. `stat()` returns the HOST's view of
// the limiter — the limit, the high-water mark of simultaneous
// provider calls, and how many asks are queued right now.
const concurrency = {
  stat: () => rpc('concurrency.stat', {}),
};

// v0.4.0: detect EvalWorkflowSnippet mode. In snippet mode the facade is
// pruned to the ZCode-defined subset (args / log / files / git / world /
// channel / future); agent / artifact / phase / report / hole / model /
// askUser are all absent and any reference fails fast.
const EVAL_MODE = process.env.DSH_WORKFLOW_EVAL_MODE === 'snippet';

if (!EVAL_MODE) {
  const __dshFacade = {
    agent,
    world: { run: worldRun },
    phase,
    log,
    report,
    artifact,
    args,
    files,
    git,
    channel,
    future,
    model,
    askUser,
    hole,
    escalate,
    // v0.6.0: language sugar for typed ask<T> + one-call multi-model routing.
    t, shape, route,
    // v0.6.0: array of model ids the run is allowed to use. Equivalent
    // to ZCode's `ListModels` tool. Populated from DSH_WORKFLOW_MODELS
    // env (set by the host at start() time).
    models: runModels,
    // v0.10.0: structural amend. `stages.await()` lets a running
    // workflow join host-injected stages explicitly; the pre-exit
    // drain covers the fire-and-forget case.
    stages,
    // v0.12.0: concurrency telemetry (host's authoritative view).
    concurrency,
    constants: {
      rpcVersion: 7,
      artifactKinds: { declare: [...PRESET_KINDS], publish: [...PUBLISH_KINDS] },
    },
  };
  // v0.8.0: also expose bare globals so user scripts compiled from
  // `.ts` (where ambient declarations resolve to bare names after
  // tsc erasure) can call `phase(...)` etc. directly.
  globalThis.__dsh = __dshFacade;
  for (const [k, v] of Object.entries(__dshFacade)) {
    if (typeof v === 'function' || typeof v === 'object') globalThis[k] = v;
  }
} else {
  const __dshEvalFacade = {
    args,
    log,
    files,
    git,
    world: { run: worldRun },
    channel,
    future,
    models: runModels,
    constants: {
      rpcVersion: 6,
      mode: 'snippet',
      artifactKinds: { declare: [...PRESET_KINDS], publish: [...PUBLISH_KINDS] },
    },
  };
  globalThis.__dsh = __dshEvalFacade;
  for (const [k, v] of Object.entries(__dshEvalFacade)) {
    if (typeof v === 'function' || typeof v === 'object') globalThis[k] = v;
  }
}

// --- 通知宿主我们已就绪 ---
send({ notify: 'ready', at: Date.now() });

async function runUserScript() {
  // v0.4.0: EvalWorkflowSnippet mode. We don't load a script from disk; the
  // host has placed the source in DSH_WORKFLOW_EVAL_CODE. We eval it in a
  // fresh module-shaped context so `import.meta.url` is reasonable, and
  // require the user to provide a default-export async function (the same
  // shape scripts use), so the rest of the lifecycle is identical.
  if (EVAL_MODE) {
    const code = process.env.DSH_WORKFLOW_EVAL_CODE || '';
    if (!code) throw new Error('eval mode: DSH_WORKFLOW_EVAL_CODE is empty');
    send({ notify: 'started', scriptPath: '(eval)', at: Date.now() });
    const t0 = performance.now();
    // Load the snippet as a module via a data: URL. The user's code is
    // expected to look like a normal script: `export default async function
    // main() { ... }`. We do NOT add anything to the source.
    const dataUrl = 'data:text/javascript;base64,' + Buffer.from(code, 'utf8').toString('base64');
    // v0.8.0: prune eval-mode facade (ZCode's `EvalWorkflowSnippet`
    // contract — no agent / artifact / phase / report / hole / model /
    // askUser / escalate / t / route) and mount it on globalThis for
    // ambient access.
    if (!globalThis.__dsh) {
      const evalFacade = {
        args, log, files, git,
        world: { run: worldRun },
        channel, future,
        models, constants: { ...constants, mode: 'snippet' },
      };
      globalThis.__dsh = evalFacade;
      for (const [k, v] of Object.entries(evalFacade)) {
        if (typeof v === 'function' || typeof v === 'object') globalThis[k] = v;
      }
    }
    const mod = await import(dataUrl);
    let result;
    if (typeof mod.default === 'function') {
      result = await mod.default(globalThis.__dsh);
    }
    const dt = Math.round(performance.now() - t0);
    send({ notify: 'finished', result: result === undefined ? null : safeResult(result), ms: dt, at: Date.now() });
    return;
  }
  if (!scriptPathArg) {
    throw new Error('runner bootstrap: missing script path argv');
  }
  const abs = resolvePath(scriptPathArg);
  const url = pathToFileURL(abs).href;
  // v0.8.0: mount the facade on globalThis before the user's module
  // loads. This matches ZCode's runtime, where ambient declarations
  // (phase / log / agent / …) are visible at module top level. User
  // scripts that destructure the default-export arg still work —
  // the facade is available both ways. We expose BOTH the namespaced
  // `globalThis.__dsh` AND the bare symbols (`globalThis.phase`,
  // `globalThis.log`, etc.) because ESM module scope doesn't see
  // `var` declarations from `declare global` in a `.d.ts`; only
  // explicit globalThis assignments become bare-name-visible.
  if (!globalThis.__dsh) {
    // Eval mode already populated __dsh at top level; this branch is
    // only here as defensive insurance for the unusual flow where
    // globalThis.__dsh was somehow cleared between then and now.
    const facade = {
      agent, world: { run: worldRun }, phase, log, report, artifact,
      args, files, git, channel, future, model, askUser,
      models, constants,
    };
    globalThis.__dsh = facade;
    for (const [k, v] of Object.entries(facade)) {
      if (typeof v === 'function' || typeof v === 'object') globalThis[k] = v;
    }
  }
  const mod = await import(url);
  // 用户的 .mjs 可以有两种形态：默认导出函数 / 顶层 await。两种我们都 run。
  send({ notify: 'started', scriptPath: abs, at: Date.now() });
  const t0 = performance.now();
  let result;
  if (typeof mod.default === 'function') {
    result = await mod.default(globalThis.__dsh);
  }
  // otherwise: the user used top-level await; import() already awaited it.
  //
  // v0.10.0 (structural amend): the script's own work is done, but a
  // stage injected via /api/amend may still be running. Drain it
  // (bounded by STAGE_DRAIN_MS) BEFORE reporting `finished`, so an
  // amendment that landed just before the script returned still gets to
  // finish and report its result. `runFinished` flips after the drain,
  // which also closes the door on injections that arrive too late.
  if (inFlightStages.size > 0) {
    send({ notify: 'stage.draining', count: inFlightStages.size, at: Date.now() });
    await drainStages();
  }
  // v0.12.0: last chance to catch a deadlock. If the script is done, no
  // future is still running, and a consumer is still blocked on a
  // channel nobody will ever close or feed — that is a deadlock, and
  // the run must fail rather than hang until the 30-minute watchdog.
  checkForOrphanedConsumers();
  runFinished = true;
  const dt = Math.round(performance.now() - t0);
  send({ notify: 'finished', result: result === undefined ? null : safeResult(result), ms: dt, at: Date.now() });
}

function safeResult(v) {
  try { return JSON.parse(JSON.stringify(v)); } catch (_) { return String(v); }
}

// 默认 30 分钟 watchdog;eval 模式可调短
const WATCHDOG_MS = EVAL_MODE
  ? (parseInt(process.env.DSH_WORKFLOW_EVAL_TIMEOUT_MS, 10) || 60_000)
  : 30 * 60 * 1000;
const watchdog = setTimeout(() => {
  send({ notify: 'error', message: 'workflow watchdog exceeded ' + WATCHDOG_MS + 'ms' });
  process.exit(2);
}, WATCHDOG_MS);

runUserScript()
  .then(() => {
    clearTimeout(watchdog);
    setImmediate(() => process.exit(0));
  })
  .catch((err) => {
    clearTimeout(watchdog);
    send({ notify: 'error', message: String(err && err.stack || err) });
    setImmediate(() => process.exit(1));
  });
