// Where does the browser's module "react" come from?
//
// The host's own client bundles require("react"), so SOME registration
// answers it. This reads the boot graph the host injects and looks for
// it, across every id the graph mentions.
//
// Usage: node scripts/probe-boot-graph.mjs <base-url>

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
const html = await (await fetch(`${base}/`, {
  headers: { cookie: sessionCookie(authority, sessionSecret()), referer: `${base}/` },
})).text();

// The boot graph is injected as a global. Pull it out of the HTML.
const start = html.indexOf('__DSH_BOOT__');
console.log('=== the boot data ===');
console.log('  the marker is at', start);

// Every id the graph mentions.
const ids = new Set();
for (const m of html.matchAll(/"id":"([^"]+)"/g)) ids.add(m[1]);
for (const m of html.matchAll(/"id":\s*"([^"]+)"/g)) ids.add(m[1]);
console.log('  the graph mentions ' + ids.size + ' ids');
console.log('  is "react" among them? ' + (ids.has('react') ? 'YES' : 'NO'));

// The batches carry the module list.
const batches = [...html.matchAll(/"entries":\[([^\]]*)\]/g)].map((m) => m[1]);
console.log('  the graph has ' + batches.length + ' batch(es)');
for (const b of batches) {
  const names = [...b.matchAll(/"id":"([^"]+)"/g)].map((m) => m[1]);
  console.log('    ' + names.length + ': ' + names.join(', ').slice(0, 300));
}
