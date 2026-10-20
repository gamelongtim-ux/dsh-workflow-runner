// Acceptance check for the copy installed in the dsh profile.
//
// The repo's own checks run against the working tree. This one runs against
// what is actually installed in the profile: the plugin must load from there,
// the engine must compile a workflow there, and TypeScript must resolve from
// the profile rather than from the repository.
//
// Usage: node scripts/verify-profile-install.mjs <path-to-installed-plugin>

import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const pluginDir = process.argv[2];
if (!pluginDir) {
  process.stderr.write('usage: verify-profile-install.mjs <path-to-installed-plugin>\n');
  process.exit(2);
}
if (!existsSync(join(pluginDir, 'package.json'))) {
  process.stderr.write(`not a package directory: ${pluginDir}\n`);
  process.exit(2);
}

const require = createRequire(join(pluginDir, 'package.json'));
const importFrom = (rel) => import(pathToFileURL(join(pluginDir, rel)).href);
const problems = [];

const pkg = require(join(pluginDir, 'package.json'));
process.stdout.write(`installed version : ${pkg.version}\n`);

// The engine and the harness must be built, not just present as source.
for (const rel of [
  'packages/dynamic-workflow/dist/index.js',
  'packages/dynamic-workflow-runtime/dist/index.js',
]) {
  const ok = existsSync(join(pluginDir, rel));
  process.stdout.write(`${rel.padEnd(48)} ${ok ? 'present' : 'MISSING'}\n`);
  if (!ok) problems.push(`${rel} is missing`);
}

// The plugin entry must load from the profile.
const plugin = await importFrom('lib/plugin.js');
process.stdout.write(`plugin exports    : ${Object.keys(plugin).join(', ')}\n`);

// The engine must actually compile there.
const { compileWorkflow } = await importFrom('lib/dwf/index.js');
const out = compileWorkflow(
  'phase("P");\nconst r = await agent("a").ask<{x:number}>("q");\nreport({r});\nreturn {r};',
);
process.stdout.write(`engine compile    : ok=${out.ok} graphs=${JSON.stringify(out.sizes)}\n`);
if (!out.ok) problems.push('the engine did not compile a valid workflow in the profile');

// TypeScript must resolve from the profile, not from the repo.
const ts = require.resolve('typescript', { paths: [pluginDir] });
process.stdout.write(`typescript        : ${ts}\n`);
if (!ts.replace(/\\/g, '/').toLowerCase().includes('/profiles/')) {
  problems.push(`typescript resolved outside the profile: ${ts}`);
}

// The author's own files must be there.
for (const rel of [
  'skill/dynamic-workflows/SKILL.md',
  'public/graph-view.js',
  'lib/dwf/tools.js',
  'lib/dwf/dsh-facade.js',
]) {
  const ok = existsSync(join(pluginDir, rel));
  process.stdout.write(`${rel.padEnd(48)} ${ok ? 'present' : 'MISSING'}\n`);
  if (!ok) problems.push(`${rel} is missing`);
}

// The plugin must ACTIVATE, not merely import: apply() is what a dsh
// profile runs, and it registers the tools, the skill, the command, the
// Settings card and the web route. Two bugs lived here — a peer-dep API
// that threw at import, and a `const` read before its declaration — and
// neither was visible from the repository, where the peer dep does not
// resolve and apply() was never called.
const registered = { tools: [], skills: [], commands: [], web: [], sections: [] };
const mockCtx = {
  inject: (deps, fn) => {
    for (const dep of deps) {
      const service = {
        register: (def) => {
          if (dep === 'tools') registered.tools.push(def);
          else if (dep === 'skills') registered.skills.push(def);
          else if (dep === 'commands') registered.commands.push(def);
          return () => {};
        },
      };
      if (dep === 'settings') {
        service.legacy = {
          installSection: () => {
            registered.sections.push({});
            return () => {};
          },
        };
      }
      fn({ [dep]: service });
    }
  },
  effect: (fn) => fn(),
  webServer: { register: (def) => { registered.web.push(def); return () => {}; } },
  connection: { requestRejection: () => null },
};

try {
  plugin.apply(mockCtx, { path: '/workflow' });
} catch (err) {
  problems.push(`apply() threw in the profile: ${err && (err.stack || err.message)}`);
}
process.stdout.write(
  `apply() registered  : ${registered.tools.length} tool(s), ${registered.skills.length} skill(s), ` +
  `${registered.commands.length} command(s), ${registered.web.length} route(s), ${registered.sections.length} section(s)\n`,
);
if (registered.tools.length !== 10) problems.push(`apply() registered ${registered.tools.length} tools, expected 10`);
if (registered.skills.length !== 1) problems.push(`apply() registered ${registered.skills.length} skills, expected 1`);
if (registered.commands.length !== 1) problems.push(`apply() registered ${registered.commands.length} commands, expected 1`);
if (registered.web.length !== 1) problems.push(`apply() registered ${registered.web.length} routes, expected 1`);

if (problems.length > 0) {
  process.stdout.write(`\nFAIL:\n${problems.map((p) => `  - ${p}`).join('\n')}\n`);
  process.exit(1);
}
process.stdout.write('\nPASS: the profile copy is complete and working\n');
