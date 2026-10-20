// The plugin must import cleanly when schemastery IS resolvable.
//
// The peer dep is optional, and that is exactly what hid a real bug: in the
// repository the package does not resolve, so the plugin took the "no
// schemastery" branch and imported fine. In a dsh profile it does resolve,
// and the plugin threw at module load — `schemastery.z.object(...)`, while
// @deepseek-ai/schemastery publishes its `z` namespace as the default
// export. The plugin never activated in any real profile.
//
// This runs the plugin against a stub with the same shape as the real
// package, so that branch is the one under test.
//
// Usage: node --import ./scripts/register-schemastery-stub.mjs scripts/dwf-schemastery-check.mjs

import { pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const problems = [];

// The stub must be faithful, or the test proves nothing.
const stub = await import(pathToFileURL(join(here, 'fixtures', 'schemastery-stub.mjs')).href);
const z = stub.default;
for (const absent of ['z', 'describe', 'nullable', 'optional', 'int']) {
  const present = typeof z[absent] === 'function' || (absent === 'z' && z[absent] !== undefined);
  if (present) problems.push(`the stub exposes "${absent}", but the real package does not`);
}
if (typeof z.object !== 'function') problems.push('the stub has no z.object()');
if (typeof z.string().description !== 'function') problems.push('the stub has no .description()');
if (typeof z.number().step !== 'function') problems.push('the stub has no .step()');

// Now the plugin, with the peer dep resolvable.
let plugin;
try {
  plugin = await import(pathToFileURL(join(here, '..', 'lib', 'plugin.js')).href);
} catch (err) {
  problems.push(`the plugin failed to import with schemastery resolvable: ${err && err.message}`);
}

if (plugin) {
  process.stdout.write(`plugin exports    : ${Object.keys(plugin).join(', ')}\n`);
  if (plugin.Config === undefined) {
    problems.push('Config is undefined — the Settings card was not built');
  } else {
    process.stdout.write('Config            : built\n');
  }
  for (const name of ['apply', 'inject', 'name']) {
    if (plugin[name] === undefined) problems.push(`the plugin does not export ${name}`);
  }
}

if (problems.length > 0) {
  process.stdout.write(`\nFAIL:\n${problems.map((p) => `  - ${p}`).join('\n')}\n`);
  process.exit(1);
}
process.stdout.write('\nPASS\n');
