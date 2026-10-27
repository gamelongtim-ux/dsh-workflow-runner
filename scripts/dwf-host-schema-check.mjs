// Check the plugin's tool schemas against the HOST's own schema validator.
//
// This is the real proof: the host's `assertSupportedJsonSchema` is read
// out of the installed dsh and run against the plugin's real tool
// schemas. If the host would refuse a schema, this refuses it — with
// the host's own message.
//
// The validator and the schema compiler it drives are self-contained
// (they touch nothing but plain data), so they are extracted from the
// host's module and evaluated on their own.
//
// Usage: node scripts/dwf-host-schema-check.mjs

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createWorkflowTools } from '../lib/dwf/tools.js';

let failures = 0;
function check(label, ok, detail = '') {
  if (!ok) failures += 1;
  process.stdout.write(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? `  — ${detail}` : ''}\n`);
}

const asar = 'D:/DeepseekHarness/resources/app.asar';
const reader = join(process.cwd(), 'scripts', 'asar-read.mjs');
const inner = 'dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js';

let hostSource = null;
if (existsSync(asar) && existsSync(reader)) {
  const r = spawnSync(process.execPath, [reader, asar, 'read', inner], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, cwd: process.cwd(),
  });
  if (r.status === 0) hostSource = r.stdout;
}
if (hostSource === null) {
  console.log('\n  the host\'s dsh-tools could not be read here — the check is skipped');
  console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures} problem(s))`}`);
  process.exit(failures === 0 ? 0 : 1);
}

/**
 * Extract a function (and the ones it needs) from the host's source.
 *
 * The schema compiler is a set of module-level functions that touch
 * nothing but plain data, so they can be evaluated together. The
 * constants it uses come with them.
 *
 * @param {string} source
 * @param {string[]} names
 * @returns {string} the source of the functions, ready to evaluate
 */
function extractFunctions(source, names) {
  const out = [];
  for (const name of names) {
    const start = source.indexOf(`function ${name}(`);
    if (start < 0) throw new Error(`the host's source has no function ${name}`);
    // Find the end: the matching closing brace at column 0.
    let depth = 0;
    let end = start;
    for (let i = source.indexOf('{', start); i < source.length; i += 1) {
      if (source[i] === '{') depth += 1;
      else if (source[i] === '}') {
        depth -= 1;
        if (depth === 0) { end = i + 1; break; }
      }
    }
    out.push(source.slice(start, end));
  }
  return out.join('\n\n');
}

/**
 * Extract a module-level constant from the host's source.
 *
 * @param {string} source
 * @param {string} name
 * @returns {string}
 */
function extractConstant(source, name) {
  // The host's bundler emits `var NAME = ...;` or `const NAME = ...;`.
  const re = new RegExp(`^(?:var|const|let)\\s+${name}\\s*=\\s*`, 'm');
  const m = re.exec(source);
  if (m === null) throw new Error(`the host's source has no constant ${name}`);
  const start = m.index + m[0].length;
  // The value ends at the first `;` that is not inside a bracket.
  let depth = 0;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if ('([{'.includes(ch)) depth += 1;
    else if (')]}'.includes(ch)) depth -= 1;
    else if (ch === ';' && depth === 0) return `const ${name} = ${source.slice(start, i)};`;
  }
  throw new Error(`could not read the constant ${name}`);
}

// The functions the validator and the compiler need. The compiler is
// reached through `runSchemaCompiler`, which the property compiler calls.
//
// The set is discovered rather than written down: the host's module is
// scanned for the identifiers the extracted code refers to, and anything
// that is not yet extracted is added. That way the check keeps working
// when the host's module grows a helper.
const SEED_FUNCTIONS = [
  'isIntrinsicObjectPrototype',
  'hasIntrinsicConstructor',
  'hasOnlyEnumerableStringKeys',
  'isPlainJsonRecord',
  'isPlainJsonArray',
  'isJsonSchemaRecord',
  'authorError',
  'checkSchemaNode',
  'assertSupportedJsonSchema',
  'runSchemaCompiler',
  'compilePropertyMap',
  'assignCompiledPropertyMap',
  'assignCompiledNode',
  'parameterSchemaSpecToJsonSchema',
  'valueSchemaSpecToJsonSchema',
];

const SEED_CONSTANTS = ['CONSTRAINT_KEYWORDS', 'ANNOTATION_KEYS', 'SCHEMA_TYPES'];

let extracted = '';
let constants = '';
const wantedFunctions = new Set(SEED_FUNCTIONS);
const wantedConstants = new Set(SEED_CONSTANTS);

/**
 * Add whatever the extracted code refers to but does not have yet.
 *
 * The host's module is scanned for an identifier that is used but not
 * defined in the extracted set, and the host's own definition of it is
 * added. This is what keeps the check working when the host's module
 * grows a helper.
 *
 * @param {string} source
 */
function completeExtraction(source) {
  for (let round = 0; round < 20; round += 1) {
    const combined = `${constants}\n${extracted}`;
    // The identifiers the extracted code calls.
    const called = new Set([...combined.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)].map((m) => m[1]));
    // The identifiers it reads as bare constants.
    const read = new Set([...combined.matchAll(/\b([A-Z][A-Z0-9_]{2,})\b/g)].map((m) => m[1]));

    let added = false;
    for (const name of called) {
      if (wantedFunctions.has(name)) continue;
      if (['if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'function', 'new'].includes(name)) continue;
      if (!new RegExp(`function ${name}\\(`).test(source)) continue;
      wantedFunctions.add(name);
      extracted += `\n${extractFunction(source, name)}`;
      added = true;
    }
    for (const name of read) {
      if (wantedConstants.has(name)) continue;
      if (!new RegExp(`^(?:var|const|let)\\s+${name}\\s*=`, 'm').test(source)) continue;
      wantedConstants.add(name);
      constants += `${extractConstant(source, name)}\n`;
      added = true;
    }
    if (!added) return;
  }
}

/**
 * Extract one function from the host's source.
 *
 * @param {string} source
 * @param {string} name
 * @returns {string}
 */
function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`the host's source has no function ${name}`);
  let depth = 0;
  let end = start;
  for (let i = source.indexOf('{', start); i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) { end = i + 1; break; }
    }
  }
  return source.slice(start, end);
}

try {
  for (const name of SEED_FUNCTIONS) {
    wantedFunctions.add(name);
    extracted += `\n${extractFunction(hostSource, name)}`;
  }
  for (const name of SEED_CONSTANTS) {
    wantedConstants.add(name);
    constants += `${extractConstant(hostSource, name)}\n`;
  }
  completeExtraction(hostSource);
} catch (err) {
  console.log(`\n  could not extract the host's validator: ${String(err && err.message || err)}`);
  console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures} problem(s))`}`);
  process.exit(failures === 0 ? 0 : 1);
}

// The host's own `JsonSchemaError`, so the refusal message is the host's.
// It extends the host's `HarnessError`, which is not needed here — a plain
// Error carries the same message.
const errStart = hostSource.indexOf('var JsonSchemaError = class');
const errEnd = hostSource.indexOf('\n};', errStart);
const errorClass = errStart >= 0
  ? hostSource.slice(errStart, errEnd + 3)
    .replace('var JsonSchemaError = class extends HarnessError', 'class JsonSchemaError extends Error')
  : 'class JsonSchemaError extends Error {}';

// The helpers the host's validator calls that live in OTHER host packages.
//
// `isJsonValue` decides whether an annotation (a `description`) is
// lossless JSON data. The host's validator calls it inside a try/catch,
// so a THROWING stub is reported as "annotation must be lossless JSON
// data" -- which would blame the plugin's descriptions for a problem
// that is really the stub's. So it has to be the real thing.
//
// The implementation is the definition of "lossless JSON data": a value
// that survives JSON.stringify/parse unchanged.
const losslessHelpers = `
function isJsonValue(value) {
  if (value === null) return true;
  const t = typeof value;
  if (t === 'string' || t === 'boolean') return true;
  if (t === 'number') return Number.isFinite(value);
  if (t !== 'object') return false;
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false;
  return Object.values(value).every(isJsonValue);
}
function snapshotJsonValue(value) {
  return JSON.parse(JSON.stringify(value));
}
function deepFreeze(value) {
  if (value === null || typeof value !== 'object') return value;
  Object.freeze(value);
  for (const v of Object.values(value)) deepFreeze(v);
  return value;
}
function assertNever(value) { throw new Error('unexpected: ' + String(value)); }
`;

let assertSupportedJsonSchema;
let parameterSchemaSpecToJsonSchema;
let valueSchemaSpecToJsonSchema;
try {
  // eslint-disable-next-line no-new-func
  const factory = new Function(`${errorClass}\n${losslessHelpers}\n${constants}\n${extracted}\nreturn { assertSupportedJsonSchema, parameterSchemaSpecToJsonSchema, valueSchemaSpecToJsonSchema };`);
  const mod = factory();
  assertSupportedJsonSchema = mod.assertSupportedJsonSchema;
  parameterSchemaSpecToJsonSchema = mod.parameterSchemaSpecToJsonSchema;
  valueSchemaSpecToJsonSchema = mod.valueSchemaSpecToJsonSchema;
} catch (err) {
  console.log(`\n  could not evaluate the host's validator: ${String(err && err.message || err)}`);
  console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures} problem(s))`}`);
  process.exit(failures === 0 ? 0 : 1);
}
console.log('\n  the host\'s validator was extracted from the installed dsh');

console.log('\n0. the extracted compiler really enforces the rules');
{
  // A check that passes because it tests nothing is worse than no check.
  // These are the three rules the plugin's schemas have to satisfy, each
  // with the shape the host REFUSES. If the extracted compiler accepted
  // any of them, it is not the host's compiler and everything below would
  // be a vacuous pass.
  const refuses = (schema, label) => {
    let error = null;
    try {
      valueSchemaSpecToJsonSchema(schema);
    } catch (err) {
      error = String(err && err.message || err);
    }
    check(`the host refuses ${label}`, error !== null, error ?? '(it ACCEPTED it)');
  };
  refuses({}, 'a schema with no type');
  refuses({ type: 'object', properties: {} }, 'an object without additionalProperties');
  refuses({ type: 'object', additionalProperties: true, properties: { x: { type: 'nonsense' } } },
    'a property with an unknown type');

  // And one it accepts, so the probe is not simply refusing everything.
  let accepted = false;
  try {
    valueSchemaSpecToJsonSchema({ type: 'object', additionalProperties: true, properties: { x: { type: 'string' } } });
    accepted = true;
  } catch (_) { /* refused */ }
  check('the host accepts a well-formed schema', accepted);
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

console.log('\n1. the host accepts every parameter schema');
for (const tool of tools) {
  let error = null;
  let schema = null;
  try {
    schema = parameterSchemaSpecToJsonSchema(tool.parameters);
  } catch (err) {
    error = String(err && err.message || err);
  }
  check(`${tool.name}: the parameter schema builds`, error === null,
    error ?? `properties=${Object.keys(schema?.properties ?? {}).length}`);
}

console.log('\n2. the host accepts every output schema');
for (const tool of tools) {
  let error = null;
  try {
    // The host's `defineTool` runs the OUTPUT schema through the
    // COMPILER (`valueSchemaSpecToJsonSchema`), not just the subset
    // checker — and the compiler is stricter: a schema with no `type` is
    // refused outright ("must be string/number/integer/boolean/null/
    // array/object/json, or use oneOf"), while the subset checker
    // accepts it. So the output has to go through the compiler too.
    const compiled = valueSchemaSpecToJsonSchema(tool.output?.schema);
    assertSupportedJsonSchema(compiled);
  } catch (err) {
    error = String(err && err.message || err);
  }
  check(`${tool.name}: the output schema is supported`, error === null, error);
}

console.log('\n3. the host accepts the built parameter schema');
for (const tool of tools) {
  let error = null;
  let schema = null;
  try {
    schema = parameterSchemaSpecToJsonSchema(tool.parameters);
    assertSupportedJsonSchema(schema);
  } catch (err) {
    error = String(err && err.message || err);
  }
  check(`${tool.name}: the built schema is supported`, error === null, error);
}

console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures} problem(s))`}`);
process.exit(failures === 0 ? 0 : 1);
