// Does the `/workflow` slash command reach the agent?
//
// The commands registry is scope-aware like the tools registry, but its
// `view(agent)` MERGES the global layer with the scope chain and applies
// NO admits filter -- so a command registered on the host IS visible to
// every agent. The tools registry filters, which is why the tools needed
// a per-agent registration and the command does not.
//
// This drives the host's own command path: the same `commands.execute`
// the chat calls when a line starts with "/".

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
  accept: 'application/json',
  'content-type': 'application/json',
  origin: base,
  referer: `${base}/`,
};

console.log('=== the host\'s command surface ===');
for (const path of ['/api/commands', '/api/command/list', '/api/session/commands']) {
  const r = await fetch(`${base}${path}`, { headers });
  const t = await r.text();
  const has = t.includes('workflow');
  console.log(`  ${path}: ${r.status}${has ? '  <-- "workflow" is here' : ''}`);
  if (r.status === 200 && has) {
    // Print the entries mentioning workflow.
    for (const m of t.matchAll(/\{"[^"]*name":"workflow"[^}]*\}/g)) {
      console.log('    ' + m[0].slice(0, 220));
    }
    if (!/name":"workflow"/.test(t)) {
      const i = t.indexOf('workflow');
      console.log('    ...' + t.slice(Math.max(0, i - 120), i + 160) + '...');
    }
  }
}
