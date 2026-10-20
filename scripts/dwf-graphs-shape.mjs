// Print the four graphs' actual shapes, so the editor renders what is there
// rather than what we imagine is there.
//
//   node scripts/dwf-graphs-shape.mjs [sample]
//
// The default sample is samples/dwf/planner-critic.dwf.ts.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { compileWorkflow } from '../lib/dwf/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const sample = process.argv[2] || join('samples', 'dwf', 'planner-critic.dwf.ts');
const source = readFileSync(join(here, '..', sample), 'utf8');
const out = compileWorkflow(source);

for (const key of ['site', 'causality', 'controlFlow', 'handoff']) {
  const g = out.graphs[key];
  console.log(`\n=== ${key} ===`);
  if (g === null || g === undefined) { console.log('  (none)'); continue; }
  for (const [field, value] of Object.entries(g)) {
    if (!Array.isArray(value)) { console.log(`  ${field}: ${typeof value}`); continue; }
    console.log(
      `  ${field} (${value.length}): ${JSON.stringify(value[0] ?? null).slice(0, 220)}`,
    );
  }
}
