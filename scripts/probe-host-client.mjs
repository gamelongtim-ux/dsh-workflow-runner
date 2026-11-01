// Is the plugin's CLIENT bundle served, and does the host's client-module
// registry know about it?
//
// The plugin's chat-facing pieces — the `▶ Workflow` button, the turn-tail
// card, the floating dot — are a browser bundle (lib/client.js) that
// registers through `window.__ModuleLoader__.load(...)`. The host serves
// it at /plugins/<id>/client.js and composes it into the page's module
// combo.
//
// If that bundle is not served, the chat shows no workflow UI at all and
// a typed message has nothing to react to.
//
// Usage: node scripts/probe-host-client.mjs <base-url>

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
const headers = {
  cookie: sessionCookie(authority, sessionSecret()),
  accept: '*/*',
  referer: `${base}/`,
};

console.log('=== the plugin client bundle ===');
for (const path of [
  '/plugins/dsh-workflow-runner/client.js',
  '/plugins/??dsh-workflow-runner/client.js',
]) {
  const r = await fetch(`${base}${path}`, { headers });
  const body = await r.text();
  console.log(`  ${path}: ${r.status}  ${body.length} bytes`);
  if (r.status === 200) {
    console.log('    it registers: ' + (body.includes('__ModuleLoader__') ? 'yes (the module loader)' : 'NO module loader'));
    for (const slot of ['conversation.composer.dock', 'conversation.chat.turnTail', 'shell.overlay', 'conversation.chat.commandview', 'settings.plugin.item']) {
      if (body.includes(slot)) console.log('    slot: ' + slot);
    }
  }
}

console.log('');
console.log('=== the host\'s client-module registry ===');
// The host's index.html preloads a combo of every plugin's client.js.
const r = await fetch(`${base}/`, { headers });
const html = await r.text();
if (r.status !== 200) {
  console.log(`  GET /: ${r.status}  ${html.slice(0, 120)}`);
} else {
  console.log(`  GET /: ${r.status}, ${html.length} bytes`);
  const combo = /\/plugins\/\?\?[^"')\s]+/.exec(html);
  console.log('  the plugin combo: ' + (combo === null ? '(not in the HTML)' : combo[0]));
  if (combo !== null) {
    console.log('  does it include us? ' + (combo[0].includes('dsh-workflow-runner') ? 'YES' : 'NO'));
  }
  const preloads = [...html.matchAll(/<script[^>]*src="([^"]+)"/g)].map((m) => m[1]);
  for (const p of preloads) console.log('    script: ' + p);
}
