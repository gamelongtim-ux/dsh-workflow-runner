// Check the plugin's tool schemas against the HOST's schema compiler's
// rules.
//
// The host's compiler is strict in ways the plugin's own conversion is
// not. Two of its rules have already cost this plugin a real outage:
//
//  1. A tool registered with a FLAT `parameters` map is not a JSON
//     Schema at all — the model is shown a schema, and that schema needs
//     a root `{ type: "object", properties: {...} }`.
//
//  2. An object schema must declare `additionalProperties` EXPLICITLY.
//     The host's compiler refuses it otherwise, and the refusal is loud:
//     `unsupported JSON schema: parameters.args.additionalProperties must
//     be explicitly true or false` — which happened when the host's
//     `defineTool` was first used on the plugin's tools.
//
// The host's rules are read out of the INSTALLED dsh, so the check is
// against the real thing rather than a copy of it.
//
// Usage: node scripts/dwf-tool-schema-host-compare.mjs

import { createWorkflowTools } from '../lib/dwf/tools.js';
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

/**
 * The host's compiler rules, applied to a schema.
 *
 * @param {unknown} spec
 * @param {string} path
 * @returns {string[]} the problems
 */
function compilerProblems(spec, path) {
  const problems = [];
  if (spec === null || typeof spec !== 'object') return problems;

  if (spec.type === 'object') {
    // The host's rule: `additionalProperties` must be present and boolean.
    if (spec.additionalProperties === undefined || typeof spec.additionalProperties !== 'boolean') {
      problems.push(`${path}.additionalProperties must be explicitly true or false`);
    }
  }
  for (const [name, child] of Object.entries(spec.properties ?? {})) {
    problems.push(...compilerProblems(child, `${path}.${name}`));
  }
  for (const [name, child] of Object.entries(spec.items ?? {})) {
    problems.push(...compilerProblems(child, `${path}.${name}`));
  }
  for (const [i, child] of (Array.isArray(spec.oneOf) ? spec.oneOf : []).entries()) {
    problems.push(...compilerProblems(child, `${path}.oneOf[${i}]`));
  }
  return problems;
}

console.log('\n1. every parameter schema is legal to the host\'s compiler');
for (const tool of tools) {
  // The host receives the FLAT map, and its own `defineTool` is what
  // wraps it in a root. So the root the host builds is not the plugin's
  // to declare — but the plugin's own conversion has to build the same
  // one, and every parameter's schema has to survive the compiler.
  const problems = compilerProblems(
    { type: 'object', additionalProperties: true, properties: tool.parameters ?? {} },
    'parameters',
  );
  check(`${tool.name}: the parameter schema compiles`, problems.length === 0, problems.join('; '));
}

console.log('\n2. every output schema is legal to the host\'s compiler');
for (const tool of tools) {
  const problems = compilerProblems(tool.output?.schema, 'output.schema');
  check(`${tool.name}: the output schema compiles`, problems.length === 0, problems.join('; '));
}

console.log('\n3. the required list matches the host\'s rule');
for (const tool of tools) {
  const expected = [...hostRequired(tool.parameters, host.rule)].sort();
  const fromSpec = Object.entries(tool.parameters ?? {})
    .filter(([, raw]) => raw !== null && typeof raw === 'object' && raw.required === true)
    .map(([n]) => n)
    .sort();
  check(
    `${tool.name}: the same parameters are required`,
    fromSpec.length === expected.length && fromSpec.every((n, i) => n === expected[i]),
    `host=[${expected}] spec=[${fromSpec}]`,
  );
}

console.log('\n4. the host\'s rule is the one the plugin assumes');
check(
  'the host requires a parameter only when it says `required: true`',
  host.rule.requiredByOptIn === true,
  `rule=${JSON.stringify(host.rule)}`,
);

console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures} problem(s))`}`);
process.exit(failures === 0 ? 0 : 1);
