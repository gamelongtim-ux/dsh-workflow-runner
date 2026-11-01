// Compare the profile's plugins: which declare a client bundle, and are
// they in the host's client combo?
//
// The combo is the set of browser bundles the host preloads. A plugin's
// UI slots (the `▶ Workflow` button, the turn-tail card) only exist if
// its client bundle is in it.
//
// Usage: node scripts/probe-client-combo.mjs <base-url>

import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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

const m = /plugins\/\?\?([^"'\s]+)/.exec(html);
const comboIds = (m === null ? [] : m[1].split('&')[0].split(',')).map((s) => s.replace(/\/client\.js$/, ''));

console.log(`=== the host preloads ${comboIds.length} client bundle(s) ===`);
console.log('');

const profileDir = join(process.env.USERPROFILE, '.dsh', 'profiles', 'desktop');
const profile = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'));

console.log('=== the profile\'s own plugins ===');
for (const name of Object.keys(profile.dependencies ?? {})) {
  let info = { client: null, export: null, present: false, error: null };
  try {
    const pkg = JSON.parse(readFileSync(join(profileDir, 'node_modules', name, 'package.json'), 'utf8'));
    info.client = pkg.dsh?.client ?? null;
    info.export = pkg.exports?.['./client'] ?? null;
  } catch (err) {
    info.error = String(err.code ?? err.message);
  }
  info.present = comboIds.includes(name);
  console.log(`  ${name}`);
  console.log(`    dsh.client: ${JSON.stringify(info.client)}${info.error === null ? '' : '  (manifest unreadable: ' + info.error + ')'}`);
  console.log(`    in the combo: ${info.present ? 'YES' : 'NO'}`);
}

console.log('');
console.log('=== a host-owned plugin, for comparison ===');
{
  const hostPkg = 'D:/DeepseekHarness/resources/app.asar.unpacked';
  void hostPkg;
  const comboOnly = comboIds.filter((id) => id.startsWith('@deepseek-ai/')).slice(0, 3);
  for (const id of comboOnly) console.log(`  ${id}  (in the combo)`);
}
