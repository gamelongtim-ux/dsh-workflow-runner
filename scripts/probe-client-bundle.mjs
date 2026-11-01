// Is the plugin's client bundle reachable at the URL the browser uses?
//
// The host serves a plugin's client at
//   /plugins/<id>/<fileName>?rev=<revision>
// for a package-local chunk, and the composed combo at
//   /plugins/??<id>/client.js,...&rev=<comboRevision>
//
// The revision comes from the package's own metadata
// (artifactRevision: mtime + ctime + size), so it is knowable.
//
// This asks the host for the plugin's client bundle the way the browser
// does, and reports what comes back.
//
// Usage: node scripts/probe-client-bundle.mjs <base-url> [package-name]

import { createHash, createHmac } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const base = process.argv[2];
const pkgName = process.argv[3] ?? 'dsh-workflow-runner';
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

// The host's `artifactRevision`: a framed hash of the package's own
// metadata (mtime, ctime, size) — NOT of its contents.
function artifactRevision(pkgPath) {
  const st = statSync(pkgPath);
  const framed = (domain, parts) => {
    const h = createHash('sha1').update(domain);
    for (const p of parts) h.update(`${String(Buffer.byteLength(p))}:${p}`);
    return h.digest('hex').slice(0, 12);
  };
  return framed('plugin-artifact', [
    String(st.mtimeMs),
    String(st.ctimeMs),
    String(st.size),
  ]);
}

const profileDir = join(process.env.USERPROFILE, '.dsh', 'profiles', 'desktop');
const pkgPath = join(profileDir, 'node_modules', pkgName, 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const clientRel = pkg.exports['./client'];
const clientPath = join(profileDir, 'node_modules', pkgName, clientRel.replace(/^\.\//, ''));

console.log(`=== ${pkgName}'s client bundle ===`);
console.log(`  the manifest : ${pkgPath}`);
console.log(`  the client   : ${clientPath}`);
console.log(`  it exists    : ${readFileSync(clientPath, 'utf8').length} bytes`);
console.log(`  the revision : ${artifactRevision(pkgPath)}`);
console.log('');

const rev = artifactRevision(pkgPath);
const urls = [
  `/plugins/${pkgName}/client.js?rev=${rev}`,
  `/plugins/??${pkgName}/client.js&rev=${rev}`,
  `/plugins/${pkgName}/client.js`,
];
for (const path of urls) {
  const r = await fetch(`${base}${path}`, { headers });
  const text = await r.text();
  console.log(`  ${r.status}  ${path}`);
  if (r.status === 200) {
    console.log(`    ${text.length} bytes`);
    for (const slot of ['conversation.composer.dock', 'conversation.chat.turnTail', 'shell.overlay', 'conversation.chat.commandview', 'settings.plugin.item']) {
      if (text.includes(slot)) console.log('    slot: ' + slot);
    }
  }
}
