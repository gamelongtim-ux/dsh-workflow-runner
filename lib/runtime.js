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
import { randomUUID } from 'node:crypto';
import { dirname, resolve as resolvePath, sep as PATH_SEP } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { chat } from './llm.js';

const RUN_TIMEOUT_MS = 30 * 60 * 1000;       // 子进程 watchdog
const ASK_TIMEOUT_MS = 5 * 60 * 1000;        // 单次 chat 完成超时
const SHELL_TIMEOUT_MS = 10 * 60 * 1000;     // world.run 默认超时

/**
 * @param {object} [opts]
 * @param {object} [opts.ctx] - cordis 插件上下文（注入 llm service 用于解析 baseURL）
 * @param {string} [opts.bootstrapPath] - 默认本目录下 runner-bootstrap.mjs
 * @param {string} [opts.nodeBin] - 默认当前进程 execPath
 * @param {{onLifecycle?: Function}} [opts]
 */
export class WorkflowRuntime {
  constructor(opts = {}) {
    this.ctx = opts.ctx || null;
    this.bootstrapPath = opts.bootstrapPath || null;
    this.nodeBin = opts.nodeBin || process.execPath;
    this.onLifecycle = (opts && opts.onLifecycle) || null;
    this.runs = new Map();
    this.scriptsRoot = (opts && opts.scriptsRoot) || null; // allowed roots for scriptPath
  }

  /**
   * Start a workflow run.
   * @param {{scriptPath:string, runId?:string}} args
   * @returns {{runId:string, status:'starting'}}
   */
  start(args) {
    const runId = args.runId || randomUUID();
    const absScript = resolvePath(args.scriptPath);
    if (!this.#isScriptAllowed(absScript)) {
      throw new Error('script path not allowed: ' + absScript);
    }
    const bootstrapAbs = this.bootstrapPath
      ? resolvePath(this.bootstrapPath)
      : resolvePath(fileURLToPath(import.meta.url), 'runner-bootstrap.mjs');

    const child = spawn(this.nodeBin, [bootstrapAbs, absScript], {
      cwd: dirname(absScript),
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, DSH_WORKFLOW_RUN_ID: runId },
    });

    const state = {
      runId,
      scriptPath: absScript,
      status: 'starting',
      startedAt: Date.now(),
      endedAt: null,
      exitCode: null,
      child,
      agents: new Map(),
      agentsOrder: [],
      phases: [],
      currentPhase: null,
      log: [],
      reports: [],
      subscribers: new Set(),
      _stopRequested: false,
      watchdog: null,
    };

    this.runs.set(runId, state);

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

  /** Stop a run. SIGTERM with 2s grace, then SIGKILL. */
  stop(runId) {
    const s = this.runs.get(runId);
    if (!s) return false;
    if (s.status === 'completed' || s.status === 'error' || s.status === 'stopped') return true;
    s._stopRequested = true;
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

  /** Snapshot the run (HTTP /api/state)。 */
  snapshot(runId) {
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
      phases: s.phases,
      log: s.log.slice(-2000),
      reports: s.reports,
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

  #isScriptAllowed(p) {
    if (!this.scriptsRoot || this.scriptsRoot.length === 0) return true;
    const abs = resolvePath(p);
    return this.scriptsRoot.some((root) => {
      const r = resolvePath(root);
      return abs === r || abs.startsWith(r + PATH_SEP);
    });
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
        this.#handleChildCall(runId, msg).catch((err) => {
          this.#respondChild(runId, msg.id, null, err);
        });
        return;
      }
      // stray response (no host-initiated RPC in v1; could happen if child echoes)
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
      const name = String((params && params.name) || '');
      s.phases.push({ name, at: Date.now() });
      s.currentPhase = name;
      this.#broadcast(runId, { event: 'phase', phase: { name, at: Date.now() } });
      return Promise.resolve({ ok: true });
    }
    if (method === 'log') {
      const message = String((params && params.message) || '');
      const level = (params && params.level) || 'info';
      this.#appendLog(runId, level, message);
      return Promise.resolve({ ok: true });
    }
    if (method === 'report') {
      const entry = { at: Date.now(), item: (params && params.item), tag: (params && params.tag) || null };
      s.reports.push(entry);
      this.#broadcast(runId, { event: 'report', report: entry });
      return Promise.resolve({ ok: true });
    }
    return Promise.reject(new Error('unknown rpc method: ' + method));
  }

  async #agentAsk(runId, params) {
    const s = this.runs.get(runId);
    if (!s) throw new Error('unknown run');
    const { name, system, model, temperature, prompt, askOpts } = params || {};
    if (!name || !prompt) throw new Error('agent.ask: name and prompt are required');

    let agent = s.agents.get(name);
    const t0 = Date.now();
    if (!agent) {
      agent = {
        name,
        system: system || 'You are a helpful assistant.',
        model: model || 'deepseek-chat',
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
      if (model) agent.model = model;
      if (typeof temperature === 'number') agent.temperature = temperature;
    }

    if (agent.messages.length === 0) {
      agent.messages.push({ role: 'system', content: agent.system });
    } else if (agent.messages[0].role === 'system' && agent.messages[0].content !== agent.system) {
      agent.messages[0] = { role: 'system', content: agent.system };
    }
    agent.messages.push({ role: 'user', content: prompt });

    this.#broadcast(runId, {
      event: 'agent.ask.start',
      name, askIndex: agent.asks, promptPreview: prompt.slice(0, 200), at: Date.now(),
    });

    agent.asks += 1;
    try {
      const result = await chat({
        messages: agent.messages,
        model: agent.model,
        temperature: agent.temperature,
        maxTokens: askOpts && askOpts.maxTokens,
        apiKey: askOpts && askOpts.apiKey,
        timeoutMs: ASK_TIMEOUT_MS,
      }, this.ctx);
      const content = result.content || '';
      agent.messages.push({ role: 'assistant', content });
      agent.lastTokens = result.usage || null;
      agent.lastDurationMs = Date.now() - t0;
      this.#broadcast(runId, {
        event: 'agent.ask.done',
        name,
        askIndex: agent.asks - 1,
        contentPreview: content.slice(0, 400),
        usage: result.usage,
        durationMs: agent.lastDurationMs,
        at: Date.now(),
      });
      return { content, usage: result.usage };
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
    }
  }

  #worldRun(runId, params) {
    return new Promise((resolve, reject) => {
      const s = this.runs.get(runId);
      if (!s) return reject(new Error('unknown run'));
      const cmd = (params && params.cmd) || '';
      const args = (params && params.args) || [];
      const opts = (params && params.opts) || {};
      const timeoutMs = typeof opts.timeoutMs === 'number' ? opts.timeoutMs : SHELL_TIMEOUT_MS;
      if (!cmd) return reject(new Error('world.run: cmd is required'));
      let child;
      try {
        child = spawn(cmd, args, {
          cwd: opts.cwd || dirname(s.scriptPath),
          env: { ...process.env, ...(opts.env || {}) },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (err) {
        return reject(err);
      }
      let stdout = '';
      let stderr = '';
      const t0 = Date.now();
      this.#broadcast(runId, { event: 'world.run.start', cmd, args, timeoutMs, at: Date.now() });
      child.stdout.on('data', (buf) => {
        const s2 = buf.toString('utf8'); stdout += s2;
        this.#broadcast(runId, { event: 'world.run.chunk', stream: 'stdout', chunk: s2.slice(-1024), at: Date.now() });
      });
      child.stderr.on('data', (buf) => {
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
        this.#broadcast(runId, {
          event: 'world.run.done', exitCode: code, signal, durationMs: dt, at: Date.now(),
        });
        resolve({ exitCode: code, signal: signal || null, stdout, stderr, durationMs: dt });
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
    }
  }

  #appendLog(runId, level, message) {
    const s = this.runs.get(runId);
    if (!s) return;
    s.log.push({ at: Date.now(), level, message });
    if (s.log.length > 5000) s.log.splice(0, s.log.length - 5000);
    this.#broadcast(runId, { event: 'log', entry: s.log[s.log.length - 1] });
  }

  #setStatus(runId, status) {
    const s = this.runs.get(runId);
    if (!s) return;
    if (s.status === status) return;
    if (status === 'completed' || status === 'error' || status === 'stopped') s.endedAt = Date.now();
    s.status = status;
    this.#broadcast(runId, { event: 'status', status, at: Date.now() });
    if (this.onLifecycle) this.onLifecycle({ type: 'status', runId, status });
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
    s.exitCode = code;
    if (s.watchdog) { clearTimeout(s.watchdog); s.watchdog = null; }
    let status;
    if (s._stopRequested) status = 'stopped';
    else if (code === 0) status = 'completed';
    else status = 'error';
    this.#appendLog(runId, status === 'completed' ? 'info' : 'error',
      `child exited code=${code} signal=${signal || 'null'} → status=${status}`);
    this.#setStatus(runId, status);
  }
}

