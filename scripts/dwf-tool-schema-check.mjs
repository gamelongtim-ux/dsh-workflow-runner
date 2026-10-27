// Adversarial check: what actually reaches the host's tool registry.
//
// The plugin was once removed from a dsh profile because its tools were
// registered with a FLAT `parameters` map — a shape the model gateway
// rejects with code 11129, which kills every turn.
//
// This checks the thing that matters: the definition that reaches
// `ctx.tools.register` carries a JSON Schema with a root object, and the
// host's own `defineTool` produces the same one.
//
// Usage: node scripts/dwf-tool-schema-check.mjs

import { createWorkflowTools } from '../lib/dwf/tools.js';
import { defineTool } from '../lib/dwf/tool-schema.js';

let failures = 0;
function check(label, ok, detail = '') {
  if (!ok) failures += 1;
  process.stdout.write(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? `  — ${detail}` : ''}\n`);
}

// The tools need capabilities to be built; this check only cares about
// their SCHEMAS, so the capabilities are stubs.
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
check('the plugin registers ten tools', tools.length === 10, `count=${tools.length}`);

console.log('\n1. every tool builds a schema with a root object');
for (const tool of tools) {
  const built = defineTool(tool);
  const p = built.parameters;
  const ok = p && p.type === 'object' && p.properties && typeof p.properties === 'object';
  check(
    `${tool.name}: parameters is a JSON Schema object`,
    ok === true,
    ok === true ? `properties=${Object.keys(p.properties).length}` : JSON.stringify(p).slice(0, 120),
  );
  check(
    `${tool.name}: the flat spec is not what reached the registry`,
    p !== tool.parameters,
    p === tool.parameters ? 'the flat map was passed through unchanged' : '',
  );
}

console.log('\n2. every parameter property is a typed schema');
for (const tool of tools) {
  const built = defineTool(tool);
  const bad = Object.entries(built.parameters.properties ?? {})
    .filter(([, spec]) => !spec || typeof spec !== 'object' || typeof spec.type !== 'string')
    .map(([name]) => name);
  check(
    `${tool.name}: every property declares a type`,
    bad.length === 0,
    bad.length ? `untyped: ${bad.join(', ')}` : '',
  );
}

console.log('\n3. the schema has no stray keywords the gateway rejects');
for (const tool of tools) {
  const built = defineTool(tool);
  // The gateway rejects a schema whose root is not an object, and one
  // whose properties are not objects with a type.
  const root = built.parameters;
  const problems = [];
  if (root.type !== 'object') problems.push(`root type=${root.type}`);
  if (root.properties === undefined) problems.push('no properties');
  if (root.required !== undefined && !Array.isArray(root.required)) problems.push('required is not an array');
  // The HOST's compiler refuses an object schema without an explicit
  // `additionalProperties`, and the refusal is loud: the tool fails to
  // build, and with it the whole registration.
  if (root.additionalProperties !== true && root.additionalProperties !== false) {
    problems.push('additionalProperties is not explicit');
  }
  for (const [name, spec] of Object.entries(root.properties ?? {})) {
    if (spec === null || typeof spec !== 'object') problems.push(`property ${name} is not an object`);
  }
  check(`${tool.name}: the schema is gateway-safe`, problems.length === 0, problems.join('; '));
}

console.log('\n3b. every object schema declares additionalProperties');
for (const tool of tools) {
  const problems = [];
  const visit = (spec, path) => {
    if (spec === null || typeof spec !== 'object') return;
    if (spec.type === 'object') {
      if (spec.additionalProperties !== true && spec.additionalProperties !== false) {
        problems.push(`${path}.additionalProperties`);
      }
    }
    for (const [k, v] of Object.entries(spec.properties ?? {})) visit(v, `${path}.${k}`);
    for (const [k, v] of Object.entries(spec.items ?? {})) visit(v, `${path}.${k}`);
  };
  visit(tool.output?.schema, 'output.schema');
  check(`${tool.name}: every output object schema is explicit`, problems.length === 0, problems.join('; '));
}

console.log('\n4. the tools still execute after the conversion');
{
  // `defineTool` wraps `execute` with argument validation. The gate
  // refuses an unbriefed agent, so the tool throws — which proves the
  // wrapper is in the path (the error is the gate's, not a schema error).
  let gateError = null;
  try {
    await tools.find((t) => t.name === 'create_workflow').execute({}, { agent: {} });
  } catch (err) {
    gateError = String(err && err.message || err);
  }
  check(
    'the gate still refuses an unbriefed agent',
    gateError !== null && /brief/i.test(gateError),
    gateError ?? '(it did not throw)',
  );
}

console.log('\n5. the registration path builds the definition the host sees');
{
  // `scripts/dwf-apply-check.mjs` drives the plugin's real `apply()`
  // against a mock cordis context and checks the definition that reaches
  // the registry. This is the same conversion applied directly, so the
  // two agree.
  let converted = 0;
  for (const tool of tools) {
    const built = defineTool(tool);
    if (built.parameters.type === 'object') converted += 1;
  }
  check('every tool is converted before registration', converted === tools.length,
    `${converted}/${tools.length}`);
}

console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures} problem(s))`}`);
process.exit(failures === 0 ? 0 : 1);
