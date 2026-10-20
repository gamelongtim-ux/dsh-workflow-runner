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
  ['dwf-extras-smoke.mjs', 'extras'],
  ['dwf-tools-smoke.mjs', 'model-facing tools'],
  ['dwf-samples-check.mjs', 'samples compile'],
  ['dwf-negative-check.mjs', 'negative fixtures refuse'],
  ['dwf-schema-diag-check.mjs', 'schema layer reports'],
  ['dwf-plugin-check.mjs', 'plugin entry'],
];

let failed = 0;
for (const [file, label] of CHECKS) {
  const r = spawnSync(process.execPath, [join(here, file)], {
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
