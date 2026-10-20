// Every sample must compile.
//
// The compile-time layer is the point of the engine path: a workflow that
// does not compile never runs, and the compiler says why. This checks the
// shipped samples against it, so a sample that drifts out of the contract
// fails in CI rather than in a user's run.
//
// Usage: node scripts/dwf-samples-check.mjs

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { compileWorkflow } from '../lib/dwf/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const samplesDir = join(repoRoot, 'samples', 'dwf');

let failures = 0;
const files = readdirSync(samplesDir).filter((f) => f.endsWith('.dwf.ts')).sort();

for (const file of files) {
  const source = readFileSync(join(samplesDir, file), 'utf8');
  const out = compileWorkflow(source);
  if (out.ok) {
    const sites = out.askSites.length;
    process.stdout.write(
      `  [PASS] ${file} — ${sites} ask site(s), graphs ${JSON.stringify(out.sizes)}\n`,
    );
  } else {
    failures += 1;
    process.stdout.write(`  [FAIL] ${file}\n`);
    for (const d of out.diagnostics) {
      process.stdout.write(`         ${d.code}@${d.line}: ${d.message}\n`);
    }
  }
}

process.stdout.write(`\n${failures === 0 ? 'PASS' : `FAIL (${failures} sample(s))`}\n`);
process.exit(failures === 0 ? 0 : 1);
