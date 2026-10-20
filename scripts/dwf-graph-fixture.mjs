// Write the graph fixture the browser-side render check uses.
//
//   node scripts/dwf-graph-fixture.mjs
//
// It compiles a sample and writes the four graphs to public/_graph-fixture.json,
// which public/_graph-fixture.html loads and draws. Both are dev artifacts, not
// part of the plugin.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { compileWorkflow } from '../lib/dwf/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const sample = process.argv[2] || join('samples', 'dwf', 'planner-critic.dwf.ts');

const source = readFileSync(join(repoRoot, sample), 'utf8');
const out = compileWorkflow(source);
const target = join(repoRoot, 'public', '_graph-fixture.json');
writeFileSync(target, JSON.stringify(out.graphs, null, 2), 'utf8');
console.log('fixture written:', target);
console.log('sizes:', JSON.stringify(out.sizes));
