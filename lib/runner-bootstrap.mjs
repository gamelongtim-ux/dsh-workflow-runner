// dsh-workflow-runner —— 子进程侧 facade。
//
// 本文件由 lib/runtime.js 通过 `node lib/runner-bootstrap.mjs <userScriptPath>` 启动。
// 通过 stdin/stdout 的 JSON-RPC 与宿主通讯：宿主发来请求，本进程解析并执行后回送结果。
// 用户脚本通过 globalThis.__dsh 拿到 facade（agent、world.run、phase、log、report）。
//
// 用法（用户脚本）：
//
//   const { agent, world, phase, log, report } = globalThis.__dsh;
//   phase('Plan a fix');
//   const plan = await agent('planner', { system: 'You are a senior planner.' })
//                   .ask('Plan a fix for the bug described as: ...');
//   report({ plan }, 'plan');
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

function onLine(line) {
  if (!line) return;
  let msg;
  try { msg = JSON.parse(line); }
  catch (_) { return; }
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
    ask(prompt, askOpts) {
      return rpc('agent.ask', {
        name,
        system: (opts && opts.system) || null,
        model: (opts && opts.model) || null,
        temperature: typeof (opts && opts.temperature) === 'number' ? opts.temperature : undefined,
        prompt,
        askOpts: askOpts || null,
      });
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

globalThis.__dsh = {
  agent,
  world: { run: worldRun },
  phase,
  log,
  report,
  constants: { rpcVersion: 1 },
};

// --- 通知宿主我们已就绪 ---
send({ notify: 'ready', at: Date.now() });

async function runUserScript() {
  if (!scriptPathArg) {
    throw new Error('runner bootstrap: missing script path argv');
  }
  const abs = resolvePath(scriptPathArg);
  const url = pathToFileURL(abs).href;
  const mod = await import(url);
  // 用户的 .mjs 可以有两种形态：默认导出函数 / 顶层 await。两种我们都 run。
  send({ notify: 'started', scriptPath: abs, at: Date.now() });
  const t0 = performance.now();
  let result;
  if (typeof mod.default === 'function') {
    result = await mod.default({ agent, world: { run: worldRun }, phase, log, report });
  }
  // otherwise: the user used top-level await; import() already awaited it.
  const dt = Math.round(performance.now() - t0);
  send({ notify: 'finished', result: result === undefined ? null : safeResult(result), ms: dt, at: Date.now() });
}

function safeResult(v) {
  try { return JSON.parse(JSON.stringify(v)); } catch (_) { return String(v); }
}

// 默认 30 分钟 watchdog
const WATCHDOG_MS = 30 * 60 * 1000;
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
