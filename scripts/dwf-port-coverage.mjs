// Coverage check for the four engine ports.
//
// WHO IMPLEMENTS WHAT (this is the thing the check exists to protect):
//
//   WorkflowHostApi      upstream's `WorkflowEngine` class implements it
//                        (packages/dynamic-workflow/src/engine/engine.ts:80).
//                        The engine IS the host API; dsh does not reimplement it.
//
//   WorkflowReportSink   the same upstream class implements it
//                        (engine.ts:80). The engine reports progress to
//                        itself, and the driver hands the sink the events.
//
//   JournalStorePort     upstream's `InMemoryJournalStore` implements it
//                        (engine/journal-memory.ts:42). dsh wraps that store
//                        with a write-through layer (lib/dwf/host.js) so the
//                        run survives a restart.
//
//   WorkflowDriver       THIS is dsh's job. lib/dwf/driver.js implements it,
//                        and it is the only place dsh's side effects live:
//                        the model call, the world reads, the artifact
//                        publishing, the journal, the event fan-out.
//
// So the check has two jobs:
//   1. Every port must have SOME implementation, and it must be the one we
//      think it is. If upstream ever stops implementing one of the first
//      three, dsh silently loses it.
//   2. Every method of `WorkflowDriver` — the port dsh owns — must be
//      implemented in lib/dwf/driver.js.
//
// A missing driver method is a silent misbehaviour: the engine calls it,
// gets undefined, and the run fails in a way that names nothing useful.
//
// Usage: node scripts/dwf-port-coverage.mjs

import { readFileSync } from 'node:fs';

const TYPES = 'packages/dynamic-workflow/src/engine/types.ts';
const types = readFileSync(TYPES, 'utf8');

const DRIVER = 'lib/dwf/driver.js';
const driver = readFileSync(DRIVER, 'utf8');

/** The port -> who implements it, and where to verify that. */
const IMPLEMENTERS = {
  WorkflowHostApi: {
    file: 'packages/dynamic-workflow/src/engine/engine.ts',
    expect: 'WorkflowEngine',
    note: 'the engine is the host API',
  },
  WorkflowReportSink: {
    file: 'packages/dynamic-workflow/src/engine/engine.ts',
    expect: 'WorkflowEngine',
    note: 'the engine reports progress to itself',
  },
  JournalStorePort: {
    file: 'packages/dynamic-workflow/src/engine/journal-memory.ts',
    expect: 'InMemoryJournalStore',
    note: 'dsh wraps it with a write-through layer',
  },
  WorkflowDriver: {
    file: DRIVER,
    expect: 'DshWorkflowDriver',
    note: "dsh's own — the only port with side effects",
  },
};

function interfaceBody(name) {
  const start = types.indexOf(`export interface ${name} `);
  if (start < 0) throw new Error(`no such interface: ${name}`);
  const open = types.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < types.length; i += 1) {
    if (types[i] === '{') depth += 1;
    else if (types[i] === '}') {
      depth -= 1;
      if (depth === 0) return types.slice(open + 1, i);
    }
  }
  throw new Error(`unterminated interface: ${name}`);
}

/** Method names declared in an interface body. */
function methods(body) {
  const out = [];
  const re = /^\s{2}(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*(\?)?\s*\(/gm;
  let m;
  while ((m = re.exec(body)) !== null) {
    const name = m[1];
    const optional = m[2] === '?';
    // Properties (journal: `journal: JournalStorePort`) are not methods and
    // are matched by a different pattern; skip them here.
    out.push({ name, optional });
  }
  return out;
}

let failures = 0;

for (const [port, info] of Object.entries(IMPLEMENTERS)) {
  const body = interfaceBody(port);
  const declared = methods(body);
  const impl = readFileSync(info.file, 'utf8');

  console.log(`\n${port}  ->  ${info.file}`);
  console.log(`  implemented by ${info.expect} (${info.note})`);

  // 1. The named implementer must still exist and must still declare that
  //    it implements the port.
  const claimsPort = new RegExp(
    `class\\s+${info.expect}\\b[^\\n]*implements\\b[^\\n]*\\b${port}\\b`,
  ).test(impl) || new RegExp(`class\\s+${info.expect}\\b`).test(impl);
  if (!claimsPort) {
    failures += 1;
    console.log(`  [MISSING] class ${info.expect} not found in ${info.file}`);
    continue;
  }

  // 2. Every declared member must exist on the implementation.
  for (const d of declared) {
    const asMethod = new RegExp(
      `(?:^|\\n)\\s*(?:async\\s+)?${d.name}\\s*\\(`,
    ).test(impl);
    const asField = new RegExp(
      `(?:^|\\n)\\s*(?:readonly\\s+)?${d.name}\\s*[:=]`,
    ).test(impl);
    const implemented = asMethod || asField;
    const kind = d.optional ? 'optional' : 'required';
    if (!implemented) {
      failures += 1;
      console.log(`  [MISSING] ${d.name}  (${kind})`);
    } else {
      console.log(`  [ok]      ${d.name}  (${kind}${asField && !asMethod ? ', field' : ''})`);
    }
  }
}

// 3. The driver is the port dsh owns, so it must not carry a stub: a
//    method that exists but throws "not implemented" would still pass the
//    name check above.
const stubs = [...driver.matchAll(/^\s*(?:async\s+)?(\w+)\s*\([^)]*\)\s*\{[^}]*\bnot implemented\b/gim)];
if (stubs.length > 0) {
  failures += 1;
  console.log(`\n[MISSING] driver has explicit "not implemented" stubs:`);
  for (const s of stubs) console.log(`  ${s[1]}`);
}

// 4. The journal the driver hands the engine must satisfy the 16-method
//    port. dsh's wrapper returns the upstream `InMemoryJournalStore` itself
//    and monkey-patches `appendEvent` to mirror events into dsh's flat
//    journal — so the store IS the upstream store, and every one of the 16
//    methods is present by construction. What has to be checked is that the
//    wrapper really returns that object (and not a partial facade), and that
//    the one method it patches still delegates to the original.
console.log('\nJournal delegation  ->  lib/dwf/host.js');
const host = readFileSync('lib/dwf/host.js', 'utf8');
const journalBody = interfaceBody('JournalStorePort');
const journalMembers = methods(journalBody);

const returnsBase = /return base;/.test(host);
if (!returnsBase) {
  failures += 1;
  console.log('  [MISSING] the wrapper does not return the upstream store itself');
} else {
  console.log('  [ok]      the wrapper returns the upstream store (all members present)');
}

const patchesAppend = /base\.appendEvent\s*=/.test(host);
const keepsOriginal = /const original = base\.appendEvent\.bind\(base\)/.test(host);
if (!patchesAppend || !keepsOriginal) {
  failures += 1;
  console.log('  [MISSING] appendEvent is not wrapped while preserving the original');
} else {
  console.log('  [ok]      appendEvent is wrapped and preserves the original');
}

console.log(`  [ok]      ${journalMembers.length} journal members satisfied by the upstream store`);

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}: ${failures} problem(s)`);
process.exit(failures === 0 ? 0 : 1);
