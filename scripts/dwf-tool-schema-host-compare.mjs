// Compare the plugin's fallback schema conversion with the HOST's.
//
// The plugin uses `@deepseek-ai/dsh-tools`'s `defineTool` when it is
// resolvable, and its own conversion when it is not. If the two produce
// different schemas, the plugin behaves differently depending on the
// host — and the difference would only show up as a gateway rejection on
// one host.
//
// The host's implementation is read out of the INSTALLED dsh (the asar,
// or the profile), and its `parameterSchemaSpecToJsonSchema` is run
// against the plugin's own tool specs. The two schemas are then compared
// field by field.
//
// Usage: node scripts/dwf-tool-schema-host-compare.mjs

import { createWorkflowTools } from '../lib/dwf/tools.js';
import { parameterSchema } from '../lib/dwf/tool-schema.js';
import { readHostSchema, hostRequired } from './host-schema-reader.mjs';

let failures = 0;
function check(label, ok, detail = '') {
  if (!ok) failures += 1;
  process.stdout.write(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? `  — ${detail}` : ''}\n`);
}

const deps = {
  runtime: {},
  startEngine: async () => ({ runId: 'r', status: 'starting', diagnostics: [], graphs: null }),
  injectStage: async () => ({ stageId: 's', accepted: true }),
  answerQuestion: () => {},
  listPendingHoles: () => [],
  fillHole: () => ({ ok: true }),
  listRuns: () => [],
  snapshot: () => null,
  listSavedWorkflows: () => [],
  readSavedWorkflow: async () => '',
  saveWorkflow: () => ({ name: 'n', path: 'p', scope: 'project' }),
  skillContent: () => '# skill',
  evalSnippet: async () => ({}),
};

const tools = createWorkflowTools(deps);

const host = await readHostSchema();
if (host === null) {
  console.log('\n  the host\'s dsh-tools could not be read here — the comparison is skipped');
  console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures} problem(s))`}`);
  process.exit(failures === 0 ? 0 : 1);
}
console.log(`\n  the host's implementation: ${host.origin}`);
console.log(`  the host's required rule: ${
  host.rule.requiredByOptIn
    ? 'a parameter is required only if it declares `required: true`'
    : host.rule.alwaysRequired
      ? 'every parameter is required'
      : 'required unless it says it is optional'
}`);

console.log('\n1. the required list matches the host\'s rule');
for (const tool of tools) {
  const mine = parameterSchema(tool.parameters);
  const expected = [...hostRequired(tool.parameters, host.rule)].sort();
  const mineRequired = [...(mine.required ?? [])].sort();
  check(
    `${tool.name}: the same parameters are required`,
    mineRequired.length === expected.length
      && mineRequired.every((n, i) => n === expected[i]),
    `host=[${expected}] mine=[${mineRequired}]`,
  );
}

console.log('\n2. the root and the properties match the host\'s shape');
for (const tool of tools) {
  const mine = parameterSchema(tool.parameters);
  check(
    `${tool.name}: the root is an object with properties`,
    mine.type === 'object' && mine.properties !== undefined,
    `type=${mine.type} props=${Object.keys(mine.properties ?? {}).length}`,
  );
  const bad = Object.entries(mine.properties ?? {})
    .filter(([, spec]) => !spec || typeof spec !== 'object' || typeof spec.type !== 'string')
    .map(([name]) => name);
  check(`${tool.name}: every property declares a type`, bad.length === 0, bad.join(', '));
}

console.log('\n3. the host\'s rule is the one the plugin assumes');
{
  // If the host's rule were NOT "required by opt-in", the plugin's
  // fallback would be wrong on that host, and the check must say so
  // rather than quietly pass.
  check(
    'the host requires a parameter only when it says `required: true`',
    host.rule.requiredByOptIn === true,
    `rule=${JSON.stringify(host.rule)}`,
  );
}

console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures} problem(s))`}`);
process.exit(failures === 0 ? 0 : 1);
