// Run every check script in this repo and report one line each.
//
// The scripts themselves are the source of truth; this only makes sure none
// of them gets skipped, and makes the summary readable in one place.
//
// Usage: node scripts/run-all-checks.mjs

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

const CHECKS = [
  ['dwf-smoke.mjs', 'engine end-to-end'],
  ['dwf-runtime-smoke.mjs', 'runtime layer'],
  ['legacy-smoke.mjs', 'legacy path regression'],
  ['dwf-compile-check.mjs', 'compile API'],
  ['dwf-port-coverage.mjs', 'engine ports covered'],
  ['dwf-facade-drift-check.mjs', 'facades agree'],
  ['dwf-failure-check.mjs', 'engine failure paths'],
  ['dwf-hole-fill-check.mjs', 'engine hole fill'],
  ['dwf-stage-check.mjs', 'engine structural amend'],
  ['dwf-import-cache-check.mjs', 'engine amend-resume cache'],
  ['dwf-restart-resume-check.mjs', 'resume survives a restart'],
  ['dwf-resume-crashed-check.mjs', 'resume an interrupted run'],
  ['dwf-journal-contract-check.mjs', 'journal: upstream contract'],
  ['dwf-tool-schema-check.mjs', 'tool schemas are valid'],
  ['dwf-tool-schema-host-compare.mjs', 'tool schema matches the host'],
  ['dwf-host-schema-check.mjs', 'the host\'s compiler accepts them'],
  ['dwf-peer-resolution-check.mjs', 'host tools resolve as a peer'],
  ['dwf-extras-smoke.mjs', 'extras'],
  ['dwf-tools-smoke.mjs', 'model-facing tools'],
  ['dwf-samples-check.mjs', 'samples compile'],
  ['dwf-negative-check.mjs', 'negative fixtures refuse'],
  ['dwf-schema-diag-check.mjs', 'schema layer reports'],
  ['dwf-schemastery-check.mjs', 'peer dep: schemastery', ['--import', './scripts/register-schemastery-stub.mjs']],
  ['dwf-apply-check.mjs', 'the plugin activates', ['--import', './scripts/register-schemastery-stub.mjs']],
  ['check-pack-contents.mjs', 'package contents'],
  ['dwf-plugin-check.mjs', 'plugin entry'],
];

let failed = 0;
for (const [file, label, args = []] of CHECKS) {
  const r = spawnSync(process.execPath, [...args, join(here, file)], {
    encoding: 'utf8',
    cwd: join(here, '..'),
  });
  const ok = r.status === 0;
  if (!ok) failed += 1;
  const tail = `${r.stdout || ''}${r.stderr || ''}`
    .split('\n')
    .filter((l) => l.trim())
    .slice(-1)[0];
  process.stdout.write(
    `${ok ? '  [PASS]' : '  [FAIL]'} ${file.padEnd(26)} ${label}${tail ? `  — ${tail.trim()}` : ''}\n`,
  );
  if (!ok) {
    process.stdout.write(`${r.stdout || ''}\n${r.stderr || ''}\n`);
  }
}

process.stdout.write(`\n${failed === 0 ? 'ALL PASS' : `FAIL (${failed} check(s))`}\n`);
process.exit(failed === 0 ? 0 : 1);
