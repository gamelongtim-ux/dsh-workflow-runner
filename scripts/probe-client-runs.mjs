// Does the plugin's client bundle RUN, with the platform seed the host
// provides?
//
// The browser's module system resolves a require in this order:
//   1. a PLATFORM SEED word — react, react-dom, @deepseek-ai/cordis,
//      @deepseek-ai/dsh-client-ui-slots, …
//   2. a materialized module
//   3. a registered package factory
//
// The seed is the platform's, and it is the same for every bundle. A
// bundle that requires a seed word works; a bundle that requires a
// package it did not declare in `dsh.client.inject` does not.
//
// This runs the plugin's factory with the host's real seed list, and
// reports the first failure.
//
// Usage: node scripts/probe-client-runs.mjs <base-url>

import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';

const base = process.argv[2];
const b64url = (b) => Buffer.from(b).toString('base64url');

function sessionSecret() {
  const yaml = readFileSync(`${process.env.USERPROFILE}/.dsh/.credentials.yaml`, 'utf8');
  const m = yaml.match(/kind:\s*grant\s*\r?\n\s*payload:\s*\r?\n\s*version:\s*\S+\s*\r?\n\s*secret:\s*(\S+)/);
  return Buffer.from(m[1], 'base64url');
}

function sessionCookie(authority, secret) {
  const name = 'dsh-auth-' + b64url(createHash('sha256').update(authority).digest());
  const now = Date.now();
  const payload = { version: 1, authority, issuedAt: now, expiresAt: now + 12 * 60 * 60 * 1000 };
  const body = b64url(Buffer.from(JSON.stringify(payload), 'utf8'));
  const sig = b64url(createHmac('sha256', secret).update(body).digest());
  return `${name}=v1.${body}.${sig}`;
}

const authority = new URL(base).host;
const headers = { cookie: sessionCookie(authority, sessionSecret()), referer: `${base}/` };

// The platform seed: the words the host's frontend provides to every
// bundle. Read out of the host's own frontend bundle.
const { execFileSync } = await import('node:child_process');
let seedWords = [];
try {
  const src = execFileSync(process.execPath, [
    'scripts/asar-read.mjs', 'D:/DeepseekHarness/resources/app.asar', 'read',
    'dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist/assets/index-BXV-oxvX.js',
  ], { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
  const m = /return\{react:[^}]*\}/.exec(src);
  if (m !== null) {
    // The first entry has no quotes around it (`react:aC`), so the quoted
    // pattern alone would drop it — and `react` is exactly the word a
    // plugin's bundle is most likely to require.
    const body = m[0].slice('return{'.length, -1);
    seedWords = body
      .split(',')
      .map((pair) => {
        const at = pair.indexOf(':');
        if (at < 0) return undefined;
        const key = pair.slice(0, at).trim().replace(/^["']|["']$/g, '');
        return key === '' ? undefined : key;
      })
      .filter(Boolean);
  }
} catch (err) {
  console.log('  (could not read the frontend: ' + String(err.message).slice(0, 80) + ')');
}
console.log('=== the platform seed ===');
console.log('  ' + (seedWords.length === 0 ? '(unknown)' : seedWords.join(', ')));
console.log('');

const html = await (await fetch(`${base}/`, { headers })).text();
const row = /"id":"dsh-workflow-runner","url":"([^"]+)"/.exec(html);
if (row === null) {
  console.log('  the boot graph has no row for the plugin');
  process.exitCode = 1;
} else {
  const url = row[1];
  const src = await (await fetch(`${base}/${url}`, { headers })).text();
  console.log('=== the plugin\'s client bundle ===');
  console.log(`  ${url}`);
  console.log(`  served: ${src.length} bytes`);

  const loader = { mode: 'queue', pendingQueue: [], load(reg) { loader.pendingQueue.push(reg); } };
  globalThis.window = globalThis;
  globalThis.__ModuleLoader__ = loader;
  // eslint-disable-next-line no-new-func
  new Function('window', 'globalThis', src)(globalThis, globalThis);

  const factories = new Map(loader.pendingQueue.map((r) => [r.id, r.factory]));
  // The seed stands in for the platform's real modules; the bundle only
  // needs them to EXIST for the resolution to succeed.
  const seed = new Map(seedWords.map((w) => [w, { __exports: {} }]));

  const requireFn = (id) => {
    if (seed.has(id)) return seed.get(id).__exports;
    if (!factories.has(id)) {
      throw new Error(`client-modules: require("${id}") missed the module table`);
    }
    const factory = factories.get(id);
    if (factory.__exports !== undefined) return factory.__exports;
    // The factory signature is `factory(require)`, and it RETURNS its
    // module.exports.
    const returned = factory(requireFn);
    factory.__exports = returned ?? {};
    return factory.__exports;
  };

  try {
    const exports = requireFn('dsh-workflow-runner');
    console.log('  the factory RAN OK');
    console.log('    exports: ' + Object.keys(exports).join(', '));
    console.log('    inject : ' + JSON.stringify(exports.inject));
  } catch (err) {
    console.log('  the factory FAILED:');
    console.log('    ' + String(err && err.message || err));
    process.exitCode = 1;
  }
}
