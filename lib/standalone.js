// dsh-workflow-runner —— 独立运行模式（不装进 dsh 时用）
//
// 启动：node lib/standalone.js [PORT] [--bootstrap=<path>]
// 默认监听 127.0.0.1:7910；将 samples/ 暴露在编辑器默认加载目录下。
'use strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
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
      const out = runtime.start({ scriptPath: body.scriptPath, runId: body.runId });
      sendJson(res, 200, out);
    } catch (err) { sendJson(res, 500, { error: String(err && err.message || err) }); }
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
    const snap = runtime.snapshot(runId);
    if (!snap) { sendJson(res, 404, { error: 'no such run' }); return; }
    sendJson(res, 200, snap); return;
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
  if (path === '/api/samples') {
    sendJson(res, 200, { samplesDir: SAMPLES });
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
