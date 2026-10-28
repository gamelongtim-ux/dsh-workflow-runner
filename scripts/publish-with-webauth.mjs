#!/usr/bin/env node
/**
 * Publish, with npm's web-2FA flow made to work.
 *
 * THE PROBLEM: this account's second factor is a security key (webauthn),
 * and npm's only web flow (`otplease` → `webAuthOpener`) starts when the
 * registry's 401 carries `authUrl` and `doneUrl` IN THE RESPONSE BODY:
 *
 *   if (err.code === "EOTP" && err.body?.authUrl && err.body?.doneUrl) { … }
 *
 * The registry does not put them there. It puts the auth URL in the
 * `npm-notice` HEADER, and its body says only:
 *
 *   {"error":"You must provide a one-time pass. Upgrade your client to
 *    npm@latest in order to use 2FA."}
 *
 * So npm 11 and npm 12 both fall through to the classic path — "Enter
 * OTP:" — and, since the account has no TOTP, that prompt wants a RECOVERY
 * CODE. Typing one there is what puts the account into the 72-hour
 * read-only hold. So the flow must not reach that prompt at all.
 *
 * WHAT THIS DOES: it wraps the registry so the 401's body ALSO carries
 * `authUrl` and `doneUrl`, taken from the `npm-notice` header. npm's own
 * web flow then runs: it opens the browser, waits for the key touch, polls
 * the done-URL, and finishes the publish itself.
 *
 * The registry is reached through a local proxy on 127.0.0.1, so the
 * token never leaves the machine and the registry is not modified.
 *
 * Usage: node scripts/publish-with-webauth.mjs [--dry-run]
 */

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const REGISTRY = 'https://registry.npmjs.org';
const dryRun = process.argv.includes('--dry-run');

const npmrc = join(process.env.USERPROFILE ?? '', '.npmrc');
const tokenLine = readFileSync(npmrc, 'utf8')
  .split(/\r?\n/)
  .find((l) => l.includes('_authToken='));
if (tokenLine === undefined) {
  process.stderr.write('no _authToken in %s\n', npmrc);
  process.exit(1);
}
const token = tokenLine.slice(tokenLine.indexOf('_authToken=') + '_authToken='.length).trim();

/** A local proxy that teaches npm's web-2FA flow where the auth URL is. */
const proxy = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    const body = Buffer.concat(chunks);
    const target = REGISTRY + req.url;
    try {
      const upstream = await fetch(target, {
        method: req.method,
        headers: {
          ...req.headers,
          host: 'registry.npmjs.org',
          authorization: `Bearer ${token}`,
        },
        body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
        redirect: 'manual',
      });

      const headers = {};
      for (const [k, v] of upstream.headers.entries()) {
        if (k === 'content-encoding' || k === 'content-length' || k === 'transfer-encoding') continue;
        headers[k] = v;
      }

      // The 401 from the registry: move the auth URL from the header into
      // the body, in the shape npm's `otplease` looks for.
      if (upstream.status === 401) {
        const notice = upstream.headers.get('npm-notice') ?? '';
        const authUrl = /https:\/\/www\.npmjs\.com\/login\/[A-Za-z0-9_-]+/.exec(notice)?.[0];
        if (authUrl !== undefined) {
          const doneUrl = `${REGISTRY}/-/v1/done?authId=${
            authUrl.slice(authUrl.lastIndexOf('/') + 1)
          }`;
          const payload = {
            error: 'You must provide a one-time pass.',
            authUrl,
            doneUrl,
          };
          const text = JSON.stringify(payload);
          headers['content-type'] = 'application/json';
          headers['content-length'] = String(Buffer.byteLength(text));
          res.writeHead(401, headers);
          res.end(text);
          return;
        }
      }

      const buf = Buffer.from(await upstream.arrayBuffer());
      headers['content-length'] = String(buf.length);
      res.writeHead(upstream.status, headers);
      res.end(buf);
    } catch (err) {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: String(err && err.message || err) }));
    }
  });
});

await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
const port = proxy.address().port;
const localRegistry = `http://127.0.0.1:${port}/`;

process.stdout.write(`proxy: ${REGISTRY} -> ${localRegistry}\n`);

/**
 * npm's web-2FA flow needs a TTY.
 *
 * `otplease` (npm/lib/utils/auth.js) starts with:
 *
 *   if (!process.stdin.isTTY || !process.stdout.isTTY) { throw err }
 *
 * so without a terminal npm rethrows the 401 instead of opening the
 * browser — and the auth URL it would have opened is the only way through
 * a security key. This is why the publish has to run in a real terminal.
 */
if (!process.stdin.isTTY || !process.stdout.isTTY) {
  process.stderr.write(
    'This publish needs a real terminal.\n' +
    '\n' +
    "npm's web-2FA flow only starts when stdin AND stdout are a TTY, and the\n" +
    "account's second factor is a security key, so the browser prompt is the\n" +
    'only way through. Run this in PowerShell or cmd, not through a pipe:\n' +
    '\n' +
    '  node scripts/publish-with-webauth.mjs\n' +
    '\n' +
    'The browser will open at npmjs.com; touch the key there.\n',
  );
  proxy.close();
  process.exit(1);
}

const args = [
  'publish',
  '--access', 'public',
  '--auth-type=web',
  '--registry', localRegistry,
  ...(dryRun ? ['--dry-run'] : []),
];
process.stdout.write(`running: npm ${args.join(' ')}\n\n`);

/**
 * A temporary npmrc that points npm at the local proxy AND gives the
 * proxy the token.
 *
 * npm looks for a registry-scoped token under the key
 * `//<host><path>:_authToken` — a key an environment variable cannot
 * carry (it holds slashes and a colon). So the credential goes in a
 * throwaway npmrc, and npm is told to use it.
 */
const npmrcPath = join(repoRoot, '.npmrc.webauth');
writeFileSync(npmrcPath, [
  `registry=${localRegistry}`,
  `//127.0.0.1:${port}/:_authToken=${token}`,
  'audit=false',
  'fund=false',
  '',
].join('\n'), 'utf8');

// npm 11 does not read the auth URL out of the 401 body, so its web flow
// never starts and it falls through to the classic "Enter OTP:" prompt —
// which, on an account with only a security key, is a RECOVERY CODE
// prompt. npm 12 reads it, so the web flow runs and that prompt is never
// reached.
//
// The npm under the repo is not used: npm 12 is run from here.
const npm12 = join(repoRoot, 'node_modules', 'npm', 'bin', 'npm-cli.js');
if (!existsSync(npm12)) {
  process.stderr.write(
    'npm 12 is not installed next to the repo. Install it with:\n' +
    '  npm install --no-save npm@12\n',
  );
  proxy.close();
  try { unlinkSync(npmrcPath); } catch (_) { /* best-effort */ }
  process.exit(1);
}
process.stdout.write('using npm 12 (the web-2FA flow needs it)\n\n');

const child = spawn(process.execPath, [npm12, ...args], {
  cwd: repoRoot,
  stdio: 'inherit',
  env: {
    ...process.env,
    npm_config_userconfig: npmrcPath,
    npm_config_registry: localRegistry,
  },
});

const code = await new Promise((resolve) => {
  child.on('exit', (c) => resolve(c ?? 1));
  child.on('error', () => resolve(1));
});

proxy.close();
try { unlinkSync(npmrcPath); } catch (_) { /* best-effort */ }
process.stdout.write(`\nnpm exited with ${code}\n`);
process.exit(code);
