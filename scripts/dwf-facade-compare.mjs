// Check the plugin's facade against upstream ZCode's.
//
// "Is this the same feature as ZCode's?" is worth measuring rather than
// asserting, so this measures it.
//
// Upstream's FACADE_DTS is "the single source of truth for the
// model-facing API" (packages/dynamic-workflow/src/facade/dts.ts). The
// plugin builds its facade by APPENDING to it, so the question has a
// precise answer: does the plugin's facade still contain every name
// upstream declares?
//
// This compares the DECLARED surfaces, not the implementations: what the
// model may write against. And the proof that matters is not the name
// list but the COMPILER -- a script using every upstream name has to
// compile against the plugin's facade.
//
// Usage: node scripts/dwf-facade-compare.mjs

import { FACADE_DTS } from '../packages/dynamic-workflow/dist/facade/dts.js';
import { DSH_FACADE_DTS, DSH_FACADE_DECLARATIONS } from '../lib/dwf/dsh-facade.js';

let failures = 0;
function check(label, ok, detail = '') {
  if (!ok) failures += 1;
  process.stdout.write(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? `  — ${detail}` : ''}\n`);
}

/** The names a .d.ts declares, at any nesting depth. */
function declaredNames(dts) {
  const names = new Set();
  for (const m of dts.matchAll(/^\s*(?:export\s+)?declare\s+(?:function|const|interface|type|class)\s+([A-Za-z_][A-Za-z0-9_]*)/gm)) {
    names.add(m[1]);
  }
  // The members of the declared namespaces.
  for (const m of dts.matchAll(/^\s*(?:readonly\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\(/gm)) {
    names.add(m[1]);
  }
  return names;
}

const upstream = declaredNames(FACADE_DTS);
const plugin = declaredNames(DSH_FACADE_DTS);

console.log('\n1. the plugin keeps upstream\'s facade intact');
{
  check(
    'the upstream part is byte-identical',
    DSH_FACADE_DTS.startsWith(FACADE_DTS),
    `the plugin's facade starts with upstream's ${FACADE_DTS.length} bytes`,
  );
  const missing = [...upstream].filter((n) => !plugin.has(n)).sort();
  check(
    'no upstream name is missing',
    missing.length === 0,
    missing.length === 0 ? `${upstream.size} names` : `missing: ${missing.join(', ')}`,
  );
}

console.log('\n2. the dsh additions are additions, not replacements');
{
  const added = [...plugin].filter((n) => !upstream.has(n)).sort();
  check('the plugin adds names', added.length > 0, added.join(', '));
  check(
    'the additions are declared in the dsh block',
    DSH_FACADE_DECLARATIONS.length > 0,
    `${DSH_FACADE_DECLARATIONS.length} bytes of declarations`,
  );
  // The additions are dsh's, not upstream's: upstream declares none of
  // them, and the engine does not know them either.
  const upstreamOnly = ['askUser', 'escalate', 'route', 'models', 'stages', 'concurrency', 'constants'];
  check(
    'the dsh extensions are not upstream names',
    upstreamOnly.every((n) => !upstream.has(n)),
    upstreamOnly.join(', '),
  );
}

console.log('\n3. a script using EVERY upstream name compiles');
{
  // The real proof. It uses model, agent, log, report, phase, all six
  // artifact kinds, all three files.* reads, all four git.* reads, and
  // world.run -- everything upstream declares.
  const script = `
phase("p");
const m = model("deepseek-chat");
const a = agent("s", { system: "x" });
const l = log("hello");
const r = report({ x: 1 });
const af = artifact.file("f1", "a.txt");
const am = artifact.markdown("m1", "# t");
const ac = artifact.chart("c1", { type: "bar", x: { field: "a" }, y: { field: "b" } });
const at = artifact.table("t1", { columns: [{ field: "a" }] });
const amt = artifact.metrics("x1", { metrics: [{ field: "a" }] });
const ab = artifact.board("b1", { key: "id", status: "state", columns: ["todo"] });
const fg = files.glob("**/*.ts");
const fr = files.read("a.txt");
const fgr = files.grep("x", ".");
const gc = git.changedFiles();
const gd = git.diff();
const gs = git.status();
const gl = git.log();
const wr = world.run("node", ["-e", "0"]);
return { m, a, l, r, af, am, ac, at, amt, ab, fg, fr, fgr, gc, gd, gs, gl, wr };
`;
  const { compileWorkflow } = await import('../lib/dwf/index.js');
  const out = compileWorkflow(script);
  check('the script compiles', out.ok);
  if (!out.ok) {
    for (const e of out.errors ?? out.diagnostics ?? []) {
      process.stdout.write(`      ${JSON.stringify(e).slice(0, 300)}\n`);
    }
  } else {
    check('all four graphs are produced', out.sizes?.site > 0 && out.sizes?.causality > 0
      && out.sizes?.controlFlow > 0 && out.sizes?.handoff > 0, JSON.stringify(out.sizes));
  }
}

console.log('\n4. upstream\'s authoring rules came with the engine');
{
  // A script that violates upstream's rules must be REFUSED. These are
  // upstream's diagnostics, not the plugin's: 9007 is "an artifact id
  // belongs to exactly one kind", and the report-tag rule is upstream's
  // own authoring rule.
  const { compileWorkflow } = await import('../lib/dwf/index.js');
  const reusedId = compileWorkflow(`
const a = artifact.file("x", "a.txt");
const b = artifact.markdown("x", "# t");
return { a, b };
`);
  const codes = (reusedId.errors ?? reusedId.diagnostics ?? []).map((e) => e.code);
  check(
    'an artifact id reused across two kinds is refused',
    !reusedId.ok && codes.includes(9007),
    `codes: ${JSON.stringify(codes)}`,
  );

  const tagged = compileWorkflow(`
const f = artifact.file("x", "a.txt");
report({ a: 1 }, "x");
return { f };
`);
  check(
    'a report tag naming a file artifact is refused',
    !tagged.ok,
    `ok=${tagged.ok}`,
  );
}

console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures} problem(s))`}`);
process.exitCode = failures === 0 ? 0 : 1;
