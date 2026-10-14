// dsh-workflow-runner —— DeepSeek chat-completion helper。
//
// 设计原则：尽可能复用 dsh 宿主侧的 LLM 路由；只有当 ctx.llm 不可用时才直接 fetch。
// 真实在线运行时（dsh web / desktop）：ctx.llm.resolveCallConfig() 给出 baseURL + 路由
// 字段，由 llm-deepseek-api-key 行负责注入 Authorization；这里走 raw fetch 即可。
// 独立运行模式（lib/standalone.js）：没 ctx，自己读 key 调同一端点。
//
// 历史管理由 lib/runtime.js 持有；本模块无状态。
'use strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = os.homedir();
const DEFAULT_BASE_URL = 'https://api.deepseek.com';
const DEFAULT_MODEL = 'deepseek-chat';
const COMPLETIONS_PATH = '/v1/chat/completions';

/**
 * 读取 DeepSeek API key（dsh 官方 + 用户级 .credentials.yaml 优先）。
 * 路径规则与 dsh-usage-dashboard/lib/balance.js 保持一致。
 *
 * @param {{credsOverride?: string|null}} [opts]
 * @returns {string|null}
 */
export function readConfiguredKey(opts = {}) {
  if (opts.credsOverride) return opts.credsOverride.trim();
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY.trim();
  const dirs = [process.env.DSH_HOME, path.join(HOME, '.dsh')].filter(Boolean);
  for (const d of dirs) {
    try {
      const t = fs.readFileSync(path.join(d, '.credentials.yaml'), 'utf8');
      const m = t.match(/DEEPSEEK_API_KEY["']?\s*:\s*["']?([A-Za-z0-9_-]{10,})["']?/);
      if (m) return m[1];
    } catch (_) { /* 文件不存在则跳 */ }
  }
  return null;
}

/**
 * Resolve a base URL given the dsh ctx (or fallback to https://api.deepseek.com).
 * Plugin ctx may carry an `llm` service from @deepseek-ai/dsh-llm; we use it if present.
 *
 * @param {object} [ctx] - cordis plugin context (optional; we only poke `llm` service)
 * @param {string} [model] - model id, e.g. 'deepseek-chat' / 'deepseek-reasoner'
 * @returns {{baseUrl: string, model: string}}
 */
export function resolveEndpoint(ctx, model) {
  const m = model || DEFAULT_MODEL;
  if (ctx && ctx.llm && typeof ctx.llm.resolveCallConfig === 'function') {
    try {
      const cfg = ctx.llm.resolveCallConfig({ provider: 'deepseek-official', model: m }, undefined);
      if (cfg && (cfg.baseUrl || cfg.endpoint || cfg.apiBase)) {
        return { baseUrl: (cfg.baseUrl || cfg.endpoint || cfg.apiBase).replace(/\/+$/, ''), model: cfg.model || m };
      }
    } catch (_) { /* 出错回退到默认 */ }
  }
  return { baseUrl: DEFAULT_BASE_URL, model: m };
}

/**
 * Execute one DeepSeek chat-completion request.
 *
 * @param {object} args
 * @param {Array<{role:'system'|'user'|'assistant', content:string}>} args.messages
 * @param {string} [args.model] - model id, default 'deepseek-chat'
 * @param {number} [args.temperature]
 * @param {number} [args.maxTokens]
 * @param {string} [args.apiKey] - override; if null/undefined we'll read it
 * @param {string} [args.baseUrl] - override; default https://api.deepseek.com
 * @param {number} [args.timeoutMs] - default 300000 (5 minutes for long agent asks)
 * @param {object} [ctx] - cordis plugin context (optional, for endpoint resolution if baseUrl not supplied)
 * @returns {Promise<{content: string, usage: object, raw: object}>}
 */
export async function chat(args, ctx) {
  const endpoint = args.baseUrl && args.model
    ? { baseUrl: args.baseUrl.replace(/\/+$/, ''), model: args.model }
    : resolveEndpoint(ctx, args.model);
  const apiKey = args.apiKey || readConfiguredKey();
  if (!apiKey) {
    const err = new Error('DeepSeek API key not configured (set DEEPSEEK_API_KEY or add to $DSH_HOME/.credentials.yaml)');
    err.code = 'NO_API_KEY';
    throw err;
  }
  const body = {
    model: endpoint.model,
    messages: args.messages,
    stream: false,
  };
  if (typeof args.temperature === 'number') body.temperature = args.temperature;
  if (typeof args.maxTokens === 'number') body.max_tokens = args.maxTokens;

  const controller = new AbortController();
  const timeoutMs = typeof args.timeoutMs === 'number' ? args.timeoutMs : 300_000;
  const t = setTimeout(() => controller.abort(), timeoutMs);

  let res;
  try {
    res = await fetch(endpoint.baseUrl + COMPLETIONS_PATH, {
      method: 'POST',
      headers: {
        'authorization': 'Bearer ' + apiKey,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(t);
    if (err && err.name === 'AbortError') {
      const e = new Error('chat completion timed out after ' + timeoutMs + 'ms');
      e.code = 'TIMEOUT';
      throw e;
    }
    throw err;
  }
  clearTimeout(t);

  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (_) {
    const e = new Error(`chat completion returned non-JSON (${res.status}): ${text.slice(0, 500)}`);
    e.code = 'BAD_RESPONSE';
    throw e;
  }
  if (!res.ok) {
    const msg = (parsed && parsed.error && parsed.error.message) || `HTTP ${res.status}`;
    const e = new Error(msg);
    e.code = 'HTTP_' + res.status;
    e.raw = parsed;
    throw e;
  }
  const choice = (parsed.choices || [])[0];
  return {
    content: choice ? (choice.message && choice.message.content) || '' : '',
    usage: parsed.usage || {},
    raw: parsed,
  };
}
