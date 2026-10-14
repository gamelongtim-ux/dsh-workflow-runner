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
// 鉴权：使用 ctx.connection.gate.requestRejection(req) 对 /api/* 路由进行 401/403/503 短路；
// 静态资源页面绕过 gate（让 dsh 的 React 壳子能照常加载）。
//
'use strict';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, normalize, resolve as resolvePath, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import z from '@deepseek-ai/schemastery';
import { WorkflowRuntime } from './runtime.js';

const name = 'dsh-workflow-runner';
const inject = ['webServer', 'authorization', 'credentials'];

const Config = z.object({
  /** 前缀路径；空字符串或 / 时走根。默认 /workflow */
  path: z.string().default('/workflow'),
  /** 限制能跑的脚本根目录；为空则放行所有（仅在 user-script-content 接口生效；run 直接接受任意路径） */
  scriptsRoots: z.array(z.string()).default([]),
});

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

function apply(ctx, config) {
  const routePath = '/' + String(config.path ?? '/workflow').replace(/^\/+|\/+$/g, '');
  const pubRoot = normalize(join(dirname(fileURLToPath(import.meta.url)), '..', 'public'));

  // bootstrap 文件按本插件包 install 后的实际路径解析（与 usage-dashboard 写法一致）
  const bootstrapAbs = join(dirname(fileURLToPath(import.meta.url)), 'runner-bootstrap.mjs');

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
      if (rest.startsWith('/api/') || rest === '/api') {
        try {
          if (ctx.connection && ctx.connection.gate && typeof ctx.connection.gate.requestRejection === 'function') {
            if (await ctx.connection.gate.requestRejection(req)) return;
          }
        } catch (_) { /* gate fault → 当作允许 */ }
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
      if (rest === '' || rest === '/') {
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

export { Config, apply, inject, name, WorkflowRuntime };
