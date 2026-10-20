// The negative fixtures must NOT compile.
//
// samples/dwf/ is compiled wholesale by dwf-samples-check.mjs, and every file
// in there has to compile. A file whose *purpose* is to fail cannot live
// there, so it lives in samples/dwf-negative/ — and this script is the other
// half of that contract: each fixture must fail, and it must fail with the
// diagnostic codes it was written to provoke.
//
// Usage: node scripts/dwf-negative-check.mjs

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { compileWorkflow } from '../lib/dwf/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, '..', 'samples', 'dwf-negative');

// Each fixture names the codes it is supposed to provoke. A fixture that
// fails for a *different* reason is a broken fixture: it would still "pass"
// this script while testing nothing.
const EXPECTED = {
  'typecheck-fail.dwf.ts': ['1184', '2322', '2304'],
  'authoring-rules.dwf.ts': ['9003', '9004', '9005', '9007', '9010', '9012'],
};

const files = readdirSync(dir).filter((f) => f.endsWith('.dwf.ts')).sort();
if (files.length === 0) {
  process.stdout.write('no negative fixtures found\n');
  process.exit(1);
}

let failures = 0;
for (const file of files) {
  const source = readFileSync(join(dir, file), 'utf8');
  const out = compileWorkflow(source);
  const expected = EXPECTED[file] ?? [];

  if (out.ok) {
    failures += 1;
    process.stdout.write(`  [FAIL] ${file} — it compiled, but it must not\n`);
    continue;
  }
  if (out.diagnostics.length === 0) {
    failures += 1;
    process.stdout.write(`  [FAIL] ${file} — it did not compile, but with no diagnostic\n`);
    continue;
  }

  const codes = new Set(out.diagnostics.map((d) => String(d.code)));
  const missing = expected.filter((c) => !codes.has(c));
  if (missing.length > 0) {
    failures += 1;
    process.stdout.write(
      `  [FAIL] ${file} — missing diagnostic code(s) ${missing.join(', ')}; got ${[...codes].join(', ')}\n`,
    );
    continue;
  }

  process.stdout.write(
    `  [PASS] ${file} — ${out.diagnostics.length} diagnostic(s), codes ${[...codes].sort().join(', ')}\n`,
  );
}

process.stdout.write(`\n${failures === 0 ? 'PASS' : `FAIL (${failures} fixture(s))`}\n`);
process.exit(failures === 0 ? 0 : 1);
