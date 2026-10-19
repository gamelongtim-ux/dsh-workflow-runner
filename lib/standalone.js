// dsh-workflow-runner —— 独立运行模式（不装进 dsh 时用）
//
// 启动：node lib/standalone.js [PORT] [--bootstrap=<path>]
// 默认监听 127.0.0.1:7910；将 samples/ 暴露在编辑器默认加载目录下。
'use strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { promises as fsPromises } from 'node:fs';
import { dirname, extname, join, normalize, resolve as resolvePath, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorkflowRuntime } from './runtime.js';

const args = process.argv.slice(2);
let PORT = 7910;
let extraBootstrap = null;
for (const a of args) {
  if (a.startsWith('--bootstrap=')) extraBootstrap = a.slice('--bootstrap='.length);
  else if (/^\d+$/.test(a)) PORT = Number(a);
}

const HERE = dirname(fileURLToPath(import.meta.url));
const PUB = join(HERE, '..', 'public');
const SAMPLES = join(HERE, '..', 'samples');

const runtime = new WorkflowRuntime({
  bootstrapPath: extraBootstrap || join(HERE, 'runner-bootstrap.mjs'),
  defaultModelsAllowed: ['deepseek-chat'],
});

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
};

const sendJson = (res, code, obj) => {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
};
const sendText = (res, code, type, body) => {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
};

const readBody = (req) => new Promise((resolve, reject) => {
  const chunks = []; let total = 0;
  const LIMIT = 256 * 1024;
  req.on('data', (c) => {
    total += c.length;
    if (total > LIMIT) { reject(new Error('body too large')); req.destroy(); return; }
    chunks.push(c);
  });
  req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  req.on('error', reject);
});

function extractWorldRunCommands(source) {
  // Static scan for world.run("name", ...) calls. Same caveat as plugin.js:
  // dynamic strings won't be caught, but the runtime is the real gate.
  const re = /world\.run\s*\(\s*["']([^"']+)["']/g;
  const seen = new Set();
  let m;
  while ((m = re.exec(source)) !== null) seen.add(m[1]);
  return Array.from(seen);
}

// --- v0.4.0: saved-workflow helpers (mirrored from plugin.js) ---

function resolveWorkflowsDir() {
  const home = process.env.DSH_HOME || process.env.HOME || process.env.USERPROFILE || '.';
  return resolvePath(join(home, 'workflows'));
}

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
      const am = val.match(/^(\S+)\s+\{([^}]*)\}(.*)$/);
      if (am) {
        const argName = am[1];
        const typeStr = am[2].trim();
        const desc = am[3].trim();
        const tm = typeStr.match(/^(\w+)(?:=(.+))?$/);
        if (tm) {
          let def;
          if (tm[2] !== undefined) { try { def = JSON.parse(tm[2]); } catch (_) { def = tm[2]; } }
          result.args[argName] = { type: tm[1], default: def, description: desc };
        }
      }
    }
  }
  return result;
}

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
    out.push({ name, description: meta.description, whenToUse: meta.whenToUse, args: meta.args || {}, path: full, size: content.length });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

const server = http.createServer(async (req, res) => {
  let url;
  try { url = new URL(req.url, 'http://x'); }
  catch (_) { sendText(res, 400, 'text/plain; charset=utf-8', 'bad request'); return; }
  const path = url.pathname;

  if (path === '/api/run') {
    if (req.method !== 'POST') { sendText(res, 405, 'text/plain; charset=utf-8', 'method'); return; }
    try {
      const body = JSON.parse((await readBody(req)) || '{}');
      if (!body.scriptPath) { sendJson(res, 400, { error: 'scriptPath required' }); return; }
      const allowlist = Array.isArray(body.worldRunAllowlist)
        ? body.worldRunAllowlist.filter((x) => typeof x === 'string')
        : undefined;
      let args;
      if (body.args !== undefined) {
        if (!body.args || typeof body.args !== 'object' || Array.isArray(body.args)) {
          sendJson(res, 400, { error: 'args must be a plain JSON object' }); return;
        }
        args = body.args;
      }
      let workspaceRoot;
      if (typeof body.workspaceRoot === 'string' && body.workspaceRoot) {
        workspaceRoot = body.workspaceRoot;
      }
      let modelsAllowed;
      if (Array.isArray(body.modelsAllowed)) {
        modelsAllowed = body.modelsAllowed.filter((x) => typeof x === 'string' && x.length > 0);
      }
      const amendFrom = typeof body.amendFrom === 'string' && body.amendFrom ? body.amendFrom : null;
      const typecheck = body.typecheck === false ? false : undefined;
      // v0.12.0: per-run concurrency ceiling override.
      const maxConcurrency = (typeof body.maxConcurrency === 'number' && body.maxConcurrency > 0)
        ? body.maxConcurrency
        : undefined;
      // v0.9.0: per-run sandbox override — `false` bypasses scrubbing;
      // an object with `allowlist` / `denylist` overrides the per-deploy
      // Config card.
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
      // v0.8.0: structured TS errors get a 400 with diagnostics so the
      // editor can render the line+col inline; everything else stays
      // a plain 500.
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
      // v0.11.0: amend rejections are user-fixable, not server faults —
      // surface the code so the editor can say "edit the script first"
      // instead of showing a raw stack.
      if (err && typeof err.code === 'string' && err.code.startsWith('AMEND_')) {
        sendJson(res, 400, { error: String(err.message || err), code: err.code });
        return;
      }
      sendJson(res, 500, { error: String(err && err.message || err) });
    }
    return;
  }
  if (path === '/api/amend') {
    // v0.10.0: structural amend — inject a new stage into a RUNNING run.
    // The stage executes inside the live child process, so it shares the
    // run's agents, allowlist, sandboxed env and workspace confinement.
    // Body is a function expression (`async (ctx) => {...}`) or a bare
    // statement block; `ctx` carries the run's phases / reports / args /
    // prior stage results.
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
  if (path === '/api/amend/stages') {
    const runId = url.searchParams.get('runId');
    if (!runId) { sendJson(res, 400, { error: 'runId query required' }); return; }
    sendJson(res, 200, { stages: runtime.listInjectedStages(runId) });
    return;
  }
  if (path === '/api/stop') {
    if (req.method !== 'POST') { sendText(res, 405, 'text/plain; charset=utf-8', 'method'); return; }
    try {
      const body = JSON.parse((await readBody(req)) || '{}');
      sendJson(res, runtime.stop(body.runId) ? 200 : 404, { ok: runtime.stop(body.runId) });
    } catch (err) { sendJson(res, 500, { error: String(err && err.message || err) }); }
    return;
  }
  if (path === '/api/state') {
    const runId = url.searchParams.get('runId');
    if (!runId) { sendJson(res, 400, { error: 'runId query required' }); return; }
    // v0.11.0: `includeJournal=1` inlines the replay trail. Off by
    // default — the journal can be thousands of entries.
    const includeJournal = url.searchParams.get('includeJournal') === '1'
      || url.searchParams.get('includeJournal') === 'true';
    const snap = runtime.snapshot(runId, {
      includeJournal,
      journalLimit: Number(url.searchParams.get('journalLimit')) || undefined,
    });
    if (!snap) { sendJson(res, 404, { error: 'no such run' }); return; }
    sendJson(res, 200, snap); return;
  }
  if (path === '/api/journal') {
    // v0.11.0: journal replay trail — what actually ran vs what was
    // replayed from an ancestor run's journal.
    const runId = url.searchParams.get('runId');
    if (!runId) { sendJson(res, 400, { error: 'runId query required' }); return; }
    const out = runtime.journal(runId, {
      limit: Number(url.searchParams.get('limit')) || undefined,
      full: url.searchParams.get('full') === '1' || url.searchParams.get('full') === 'true',
    });
    if (!out) { sendJson(res, 404, { error: 'no such run' }); return; }
    sendJson(res, 200, out); return;
  }
  if (path === '/api/list') {
    sendJson(res, 200, { runs: runtime.listRuns() });
    return;
  }
  if (path === '/api/stream') {
    const runId = url.searchParams.get('runId');
    if (!runId) { sendJson(res, 400, 'text/plain; charset=utf-8', 'runId required'); return; }
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      'connection': 'keep-alive',
      'x-accel-buffering': 'no',
    });
    const sendEvent = (evt) => {
      try { res.write('data: ' + JSON.stringify(evt) + '\n\n'); } catch (_) {}
    };
    const unsubscribe = runtime.subscribe(runId, sendEvent);
    const hb = setInterval(() => { try { res.write(': hb\n\n'); } catch (_) {} }, 15000);
    req.on('close', () => { clearInterval(hb); unsubscribe(); });
    return;
  }
  if (path === '/api/script-content') {
    if (req.method !== 'POST') { sendText(res, 405, 'text/plain; charset=utf-8', 'method'); return; }
    try {
      const body = JSON.parse((await readBody(req)) || '{}');
      if (!body.scriptPath) { sendJson(res, 400, { error: 'scriptPath required' }); return; }
      const target = normalize(resolvePath(body.scriptPath));
      const allowedRoots = [SAMPLES, resolvePath(process.env.DSH_HOME || process.env.HOME || '.', 'workflows')];
      const allowed = allowedRoots.some((root) => {
        const r = normalize(root);
        return target === r || target.startsWith(r + sep);
      });
      if (!allowed) { sendJson(res, 403, { error: 'not in allowed roots', target }); return; }
      sendJson(res, 200, { path: target, content: await readFile(target, 'utf8') });
    } catch (err) { sendJson(res, 500, { error: String(err && err.message || err) }); }
    return;
  }
  if (path === '/api/extract-commands') {
    try {
      const scriptPath = url.searchParams.get('scriptPath');
      if (!scriptPath) { sendJson(res, 400, { error: 'scriptPath query required' }); return; }
      const target = normalize(resolvePath(scriptPath));
      const allowedRoots = [SAMPLES, resolvePath(process.env.DSH_HOME || process.env.HOME || '.', 'workflows')];
      const allowed = allowedRoots.some((root) => {
        const r = normalize(root);
        return target === r || target.startsWith(r + sep);
      });
      if (!allowed) { sendJson(res, 403, { error: 'not in allowed roots', target }); return; }
      const content = await readFile(target, 'utf8');
      const commands = extractWorldRunCommands(content);
      sendJson(res, 200, { path: target, commands });
    } catch (err) { sendJson(res, 500, { error: String(err && err.message || err) }); }
    return;
  }
  if (path === '/api/artifact-content') {
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
    } catch (err) { sendJson(res, 500, { error: String(err && err.message || err) }); }
    return;
  }
  if (path === '/api/samples') {
    sendJson(res, 200, { samplesDir: SAMPLES });
    return;
  }
  if (path === '/api/models') {
    sendJson(res, 200, { models: ['deepseek-chat'] });
    return;
  }
  if (path === '/api/saved-workflows') {
    if (req.method === 'GET') {
      try {
        const dir = resolveWorkflowsDir();
        await fsPromises.mkdir(dir, { recursive: true });
        const items = await listSavedWorkflows(dir);
        sendJson(res, 200, { workflows: items, dir });
      } catch (err) { sendJson(res, 500, { error: String(err && err.message || err) }); }
      return;
    }
    if (req.method === 'POST') {
      try {
        const body = JSON.parse((await readBody(req)) || '{}');
        const name = String((body && body.name) || '').trim();
        const script = String((body && body.script) || '');
        if (!/^[A-Za-z0-9_.-]{1,64}$/.test(name)) {
          sendJson(res, 400, { error: 'name must match /^[A-Za-z0-9_.-]{1,64}$/' }); return;
        }
        if (!script.trim()) { sendJson(res, 400, { error: 'script is required' }); return; }
        if (script.length > 256 * 1024) { sendJson(res, 400, { error: 'script exceeds 256KB cap' }); return; }
        const dir = resolveWorkflowsDir();
        await fsPromises.mkdir(dir, { recursive: true });
        const filePath = join(dir, name + '.mjs');
        const fullSource = renderSavedWorkflowSource(name, script, body.description || null, body.whenToUse || null, body.args || null);
        await fsPromises.writeFile(filePath, fullSource, 'utf8');
        sendJson(res, 200, { ok: true, path: filePath, name });
      } catch (err) { sendJson(res, 500, { error: String(err && err.message || err) }); }
      return;
    }
    sendText(res, 405, 'text/plain; charset=utf-8', 'method'); return;
  }
  if (path === '/api/saved-workflows/delete') {
    if (req.method !== 'POST') { sendText(res, 405, 'text/plain; charset=utf-8', 'method'); return; }
    try {
      const body = JSON.parse((await readBody(req)) || '{}');
      const name = String((body && body.name) || '').trim();
      if (!/^[A-Za-z0-9_.-]{1,64}$/.test(name)) {
        sendJson(res, 400, { error: 'name must match /^[A-Za-z0-9_.-]{1,64}$/' }); return;
      }
      const dir = resolveWorkflowsDir();
      const filePath = join(dir, name + '.mjs');
      if (!filePath.startsWith(resolvePath(dir))) { sendJson(res, 403, { error: 'refusing to delete outside workflows dir' }); return; }
      await fsPromises.unlink(filePath).catch((err) => { if (err && err.code !== 'ENOENT') throw err; });
      sendJson(res, 200, { ok: true, name });
    } catch (err) { sendJson(res, 500, { error: String(err && err.message || err) }); }
    return;
  }
  if (path === '/api/saved-workflows/content') {
    try {
      const name = url.searchParams.get('name');
      if (!name || !/^[A-Za-z0-9_.-]{1,64}$/.test(name)) {
        sendJson(res, 400, { error: 'name query required' }); return;
      }
      const dir = resolveWorkflowsDir();
      const filePath = join(dir, name + '.mjs');
      if (!filePath.startsWith(resolvePath(dir))) { sendJson(res, 403, { error: 'refusing to read outside workflows dir' }); return; }
      const content = await readFile(filePath, 'utf8');
      const meta = parseFrontmatter(content) || {};
      const stripped = content.replace(/^\s*\/\*\*[\s\S]*?\*\/\s*/, '');
      sendJson(res, 200, { name, path: filePath, content: stripped, meta });
    } catch (err) {
      if (err && err.code === 'ENOENT') { sendJson(res, 404, { error: 'no such saved workflow' }); return; }
      sendJson(res, 500, { error: String(err && err.message || err) });
    }
    return;
  }
  if (path === '/api/eval') {
    if (req.method !== 'POST') { sendText(res, 405, 'text/plain; charset=utf-8', 'method'); return; }
    try {
      const body = JSON.parse((await readBody(req)) || '{}');
      const code = String((body && body.code) || '');
      if (!code.trim()) { sendJson(res, 400, { error: 'code is required' }); return; }
      if (code.length > 64 * 1024) { sendJson(res, 400, { error: 'code exceeds 64KB cap' }); return; }
      const args = (body && body.args && typeof body.args === 'object' && !Array.isArray(body.args)) ? body.args : {};
      const timeoutMs = typeof body.timeoutMs === 'number' && body.timeoutMs > 0 ? Math.min(body.timeoutMs, 600_000) : 60_000;
      const workspaceRoot = (typeof body.workspaceRoot === 'string' && body.workspaceRoot) ? body.workspaceRoot : process.cwd();
      const evalRun = await runtime.start({
        scriptPath: join(HERE, 'placeholder.mjs'),
        args, workspaceRoot,
        evalMode: true, evalCode: code, evalTimeoutMs: timeoutMs,
        worldRunAllowlist: Array.isArray(body.worldRunAllowlist) ? body.worldRunAllowlist : [],
      });
      const deadline = Date.now() + timeoutMs + 5000;
      let snap;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
        snap = runtime.snapshot(evalRun.runId);
        if (!snap) { sendJson(res, 500, { error: 'eval run disappeared' }); return; }
        if (snap.status === 'completed' || snap.status === 'error' || snap.status === 'stopped') break;
      }
      const result = (snap && snap.status === 'completed')
        ? (snap.reports && snap.reports.length > 0 ? snap.reports[snap.reports.length - 1] : null)
        : null;
      sendJson(res, 200, { status: snap.status, log: snap.log.slice(-200), result, workspaceRoot });
    } catch (err) { sendJson(res, 500, { error: String(err && err.message || err) }); }
    return;
  }
  if (path === '/api/question-answer') {
    if (req.method !== 'POST') { sendText(res, 405, 'text/plain; charset=utf-8', 'method'); return; }
    try {
      const body = JSON.parse((await readBody(req)) || '{}');
      const runId = String((body && body.runId) || '').trim();
      const questionId = String((body && body.questionId) || '').trim();
      if (!runId || !questionId) { sendJson(res, 400, { error: 'runId and questionId required' }); return; }
      runtime.answerQuestion(runId, questionId, body.answer);
      sendJson(res, 200, { ok: true });
    } catch (err) { sendJson(res, 500, { error: String(err && err.message || err) }); }
    return;
  }
  if (path === '/api/hole-answer') {
    if (req.method !== 'POST') { sendText(res, 405, 'text/plain; charset=utf-8', 'method'); return; }
    try {
      const body = JSON.parse((await readBody(req)) || '{}');
      const runId = String((body && body.runId) || '').trim();
      const holeId = String((body && body.holeId) || '').trim();
      if (!runId || !holeId) { sendJson(res, 400, { error: 'runId and holeId required' }); return; }
      if (body.error) {
        runtime.answerHole(runId, holeId, null, String(body.error));
      } else {
        runtime.answerHole(runId, holeId, String(body.body == null ? '' : body.body), null);
      }
      sendJson(res, 200, { ok: true });
    } catch (err) { sendJson(res, 500, { error: String(err && err.message || err) }); }
    return;
  }
  if (path === '/api/escalate-answer') {
    if (req.method !== 'POST') { sendText(res, 405, 'text/plain; charset=utf-8', 'method'); return; }
    try {
      const body = JSON.parse((await readBody(req)) || '{}');
      const runId = String((body && body.runId) || '').trim();
      const escalateId = String((body && body.escalateId) || '').trim();
      if (!runId || !escalateId) { sendJson(res, 400, { error: 'runId and escalateId required' }); return; }
      runtime.answerEscalate(runId, escalateId, body.answer);
      sendJson(res, 200, { ok: true });
    } catch (err) { sendJson(res, 500, { error: String(err && err.message || err) }); }
    return;
  }
  if (path === '/api/escalate-think') {
    if (req.method !== 'POST') { sendText(res, 405, 'text/plain; charset=utf-8', 'method'); return; }
    try {
      const body = JSON.parse((await readBody(req)) || '{}');
      const runId = String((body && body.runId) || '').trim();
      const escalateId = String((body && body.escalateId) || '').trim();
      if (!runId || !escalateId) { sendJson(res, 400, { error: 'runId and escalateId required' }); return; }
      runtime.thinkEscalate(runId, escalateId).catch(() => {});
      sendJson(res, 200, { ok: true });
    } catch (err) { sendJson(res, 500, { error: String(err && err.message || err) }); }
    return;
  }
  if (path === '/api/runs') {
    try {
      const runs = runtime.listAllRuns();
      sendJson(res, 200, { runs });
    } catch (err) { sendJson(res, 500, { error: String(err && err.message || err) }); }
    return;
  }

  // static
  let p = path === '/' ? '/index.html' : path;
  const target = normalize(join(PUB, p));
  if (!target.startsWith(normalize(PUB))) { sendText(res, 403, 'text/plain; charset=utf-8', 'forbidden'); return; }
  try {
    const body = await readFile(target);
    sendText(res, 200, MIME[extname(target)] ?? 'application/octet-stream', body);
  } catch (_) {
    sendText(res, 404, 'text/plain; charset=utf-8', 'not found');
  }
});

server.listen(PORT, '127.0.0.1', () => {
  // eslint-disable-next-line no-console
  console.log('[dsh-workflow-runner] standalone on http://127.0.0.1:' + PORT);
});
