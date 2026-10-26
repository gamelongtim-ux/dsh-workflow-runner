// Drift check between the two facades.
//
// There are two facades, because there are two run paths:
//
//   lib/facade.d.ts          the LEGACY path's ambient declaration, injected
//                            into the tsc program as `__dsh_facade__.d.ts`
//   lib/dwf/dsh-facade.js    the ENGINE path's facade, which is upstream's
//                            FACADE_DTS plus dsh's own members
//
// Nothing keeps them in step. They have drifted before: `route` was
// declared as taking an ARRAY in the legacy facade while every
// implementation took a map, and `stages.pending()` was declared
// synchronous while every implementation returned a promise.
//
// This check compares the members the two declare and reports the ones that
// disagree, so a drift is a failure rather than a surprise at runtime.
//
// Usage: node scripts/dwf-facade-drift-check.mjs

import { readFileSync } from 'node:fs';
import { DSH_FACADE_DTS } from '../lib/dwf/dsh-facade.js';

const legacy = readFileSync('lib/facade.d.ts', 'utf8');

/** The `__dsh` object's members, from the legacy facade. */
function legacyMembers(src) {
  const start = src.indexOf('declare const __dsh: {');
  if (start < 0) throw new Error('legacy facade: no __dsh object');
  const open = src.indexOf('{', start + 'declare const __dsh:'.length);
  let depth = 0;
  let end = open;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) { end = i; break; }
    }
  }
  const body = src.slice(open + 1, end);
  const out = new Map();
  // A member is `name(...): T` or `name: {`.
  const re = /^\s{2}([A-Za-z_$][\w$]*)\s*(\??\s*[:(])/gm;
  let m;
  while ((m = re.exec(body)) !== null) {
    out.set(m[1], m[2].includes('(') ? 'callable' : 'object');
  }
  return out;
}

/** The engine facade's top-level members. */
function engineMembers(src) {
  const out = new Map();
  const re = /declare\s+(const|function)\s+([A-Za-z_$][\w$]*)/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    out.set(m[2], m[1] === 'function' ? 'callable' : 'object');
  }
  return out;
}

/**
 * The members whose SHAPE differs between the two facades.
 *
 * A member may be declared as a function in one and as an object in the
 * other, and both are fine — the legacy facade wraps everything in a
 * `__dsh` namespace, so `agent` is a property there and a function here.
 * What matters is that a member with the SAME NAME has the same call
 * signature on both paths, so a script written for one compiles on the
 * other.
 */
const SHAPE_CHECKS = [
  {
    name: 'route',
    // The parameter's type, up to the comma that ends it. The type can
    // contain commas (`Record<string, M>`), so the match is balanced
    // rather than a lazy regex.
    legacyPattern: /route<M extends string>\(\s*models:\s*/,
    enginePattern: /route<M extends string>\(\s*MODELS:\s*/,
    balanced: true,
  },
  {
    name: 'stages.pending',
    legacyPattern: /pending\(\)\s*:\s*([^;]+);/,
    enginePattern: /pending\(\)\s*:\s*([^;]+);/,
  },
];

/**
 * The text of a type that starts at `index`, up to the comma at its own
 * nesting depth.
 *
 * @param {string} src
 * @param {number} index
 * @returns {string}
 */
function balancedType(src, index) {
  let depth = 0;
  for (let i = index; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === '<' || ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === '>' || ch === ')' || ch === ']' || ch === '}') depth -= 1;
    else if (ch === ',' && depth === 0) return src.slice(index, i).replace(/\s+/g, ' ').trim();
    else if (ch === ';' && depth === 0) return src.slice(index, i).replace(/\s+/g, ' ').trim();
  }
  return src.slice(index).replace(/\s+/g, ' ').trim();
}

let failures = 0;
const legacySet = legacyMembers(legacy);
const engineSet = engineMembers(DSH_FACADE_DTS);

console.log('\n1. the members both facades declare');
const onlyLegacy = [...legacySet.keys()].filter((n) => !engineSet.has(n));
const onlyEngine = [...engineSet.keys()].filter((n) => !legacySet.has(n) && n !== '__dsh');

// `t` is legacy-only on purpose: it is runtime sugar for `opts.result`,
// which the engine path does not have (the engine takes a TYPE argument).
const EXPECTED_LEGACY_ONLY = new Set(['t']);

const unexpectedLegacy = onlyLegacy.filter((n) => !EXPECTED_LEGACY_ONLY.has(n));
if (unexpectedLegacy.length > 0) {
  failures += 1;
  console.log(`  [FAIL] declared by the legacy facade but NOT by the engine facade: ${unexpectedLegacy.join(', ')}`);
} else {
  console.log(`  [ok]   every legacy member exists on the engine facade (except: ${[...EXPECTED_LEGACY_ONLY].join(', ')} — legacy-only by design)`);
}

// The engine facade has upstream's members plus dsh's own; the legacy
// facade wraps the same set in `__dsh`.
const shared = [...engineSet.keys()].filter((n) => legacySet.has(n));
console.log(`  [ok]   ${shared.length} members are declared by both`);

console.log('\n2. the members whose shape must match');
for (const check of SHAPE_CHECKS) {
  const l = legacy.match(check.legacyPattern);
  const e = DSH_FACADE_DTS.match(check.enginePattern);
  if (!l || !e) {
    failures += 1;
    console.log(`  [FAIL] ${check.name}: could not read both declarations`);
    continue;
  }
  let lText;
  let eText;
  if (check.balanced) {
    lText = balancedType(legacy, l.index + l[0].length);
    eText = balancedType(DSH_FACADE_DTS, e.index + e[0].length);
  } else {
    lText = l[1].replace(/\s+/g, ' ').trim();
    eText = e[1].replace(/\s+/g, ' ').trim();
  }
  // `Readonly<T>` and `T` accept the same values here, so the wrapper is
  // not a difference in the contract.
  const normalize = (t) => t.replace(/^Readonly<(.*)>$/, '$1');
  if (normalize(lText) === normalize(eText)) {
    console.log(`  [ok]   ${check.name}: ${lText}`);
  } else {
    failures += 1;
    console.log(`  [FAIL] ${check.name}: legacy says "${lText}", engine says "${eText}"`);
  }
}

console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures} problem(s))`}`);
process.exit(failures === 0 ? 0 : 1);
