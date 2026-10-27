// Adversarial check: the plugin's peer declaration is what makes the
// host's `defineTool` resolvable.
//
// The host resolves a bare import for a plugin when the plugin's OWN
// `package.json` lists the package as a peer dependency: the host reads
// the manifest of the directory that owns the import
// (`readPeerNames` in @deepseek-ai/dsh-app-boot's profile-resolution
// bootstrap) and routes the request to the installation's copy.
//
// So the plugin's manifest must declare `@deepseek-ai/dsh-tools` as a
// peer — without that, the import falls through to the plugin's
// node_modules and fails, and the plugin silently uses its own fallback
// instead of the host's.
//
// This checks the manifest, and checks the host's own rule against it.
//
// Usage: node scripts/dwf-peer-resolution-check.mjs

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

let failures = 0;
function check(label, ok, detail = '') {
  if (!ok) failures += 1;
  process.stdout.write(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? `  — ${detail}` : ''}\n`);
}

const manifest = JSON.parse(readFileSync('package.json', 'utf8'));

console.log('\n1. the manifest declares the host\'s tools package as a peer');
{
  const peers = manifest.peerDependencies ?? {};
  check(
    '@deepseek-ai/dsh-tools is a peer dependency',
    typeof peers['@deepseek-ai/dsh-tools'] === 'string',
    `peers=${JSON.stringify(Object.keys(peers))}`,
  );
  check(
    'it is marked optional, so a host without it still installs',
    manifest.peerDependenciesMeta?.['@deepseek-ai/dsh-tools']?.optional === true,
    JSON.stringify(manifest.peerDependenciesMeta?.['@deepseek-ai/dsh-tools']),
  );
  check(
    'it is NOT a hard dependency (the host provides it)',
    manifest.dependencies?.['@deepseek-ai/dsh-tools'] === undefined,
    JSON.stringify(Object.keys(manifest.dependencies ?? {})),
  );
}

console.log('\n2. the host really uses the peer declaration');
{
  // The host reads the manifest of the directory that owns the import and
  // routes a peer to the installation's copy. This reads the host's own
  // source to confirm that rule is still what it does — if the host ever
  // changes it, the plugin's manifest would have to change with it.
  const asar = 'D:/DeepseekHarness/resources/app.asar';
  const reader = join(process.cwd(), 'scripts', 'asar-read.mjs');
  let hostSource = null;
  if (existsSync(asar) && existsSync(reader)) {
    const r = spawnSync(process.execPath, [
      reader, asar, 'read',
      'dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/worker/profile-resolution-bootstrap.js',
    ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (r.status === 0) hostSource = r.stdout;
  }
  if (hostSource === null) {
    console.log('  (the host\'s resolver is not readable here — the rule is not re-verified)');
  } else {
    check(
      'the host reads the peer names of the importing directory',
      /readPeerNames\(/.test(hostSource) && /peerDependencies/.test(hostSource),
      'readPeerNames reads peerDependencies',
    );
    check(
      'a peer is routed to the installation\'s copy',
      /scope === "installation"/.test(hostSource),
      'the installation scope is the route target',
    );
  }
}

console.log('\n3. the plugin imports the host\'s tools package');
{
  const plugin = readFileSync('lib/plugin.js', 'utf8');
  check(
    "the plugin imports '@deepseek-ai/dsh-tools'",
    /import\(['"]@deepseek-ai\/dsh-tools['"]\)/.test(plugin),
    'a dynamic import, so a host without it does not break the module load',
  );
  check(
    'a failure to import falls back rather than throwing',
    /catch\s*\(_?\)?\s*\{[^}]*defineTool = null/s.test(plugin),
    'the fallback is taken',
  );
  check(
    'the fallback is the plugin\'s own conversion',
    /import\(['"]\.\/dwf\/tool-schema\.js['"]\)/.test(plugin),
    'lib/dwf/tool-schema.js',
  );
}

console.log('\n4. the plugin\'s own conversion is the host\'s rule');
{
  // The fallback must implement the host's rule exactly: a parameter is
  // required only if it declares `required: true`.
  const schema = readFileSync('lib/dwf/tool-schema.js', 'utf8');
  check(
    "the fallback requires a parameter only on `required: true`",
    /required\s*===\s*true/.test(schema),
    'the opt-in rule',
  );
}

console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures} problem(s))`}`);
process.exit(failures === 0 ? 0 : 1);
