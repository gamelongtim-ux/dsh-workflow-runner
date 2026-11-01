// Compare upstream ZCode's model-facing facade against the plugin's.
//
// Upstream's `FACADE_DTS` is "the single source of truth for the
// model-facing API" (packages/dynamic-workflow/src/facade/dts.ts). The
// plugin builds its own facade by APPENDING to it, so the question "is
// this the same feature?" has a precise answer: does the plugin's facade
// still contain every name upstream declares?
//
// This compares the DECLARED surfaces, not the implementations: what the
// model may write against.

import { FACADE_DTS } from '../packages/dynamic-workflow/dist/facade/dts.js';
import { DSH_FACADE_DTS, DSH_FACADE_DECLARATIONS } from '../lib/dwf/dsh-facade.js';

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

console.log('=== upstream ZCode: the model-facing facade ===');
console.log('  ' + [...upstream].sort().join(', '));
console.log('');
console.log('=== the plugin: upstream + dsh additions ===');
console.log('  the upstream part is byte-identical: ' + DSH_FACADE_DTS.startsWith(FACADE_DTS));
console.log('  the dsh additions:');
for (const line of DSH_FACADE_DECLARATIONS.split('\n')) {
  if (line.trim() !== '') console.log('    ' + line);
}
console.log('');

const missing = [...upstream].filter((n) => !plugin.has(n)).sort();
console.log('=== the comparison ===');
console.log('  upstream names MISSING from the plugin: ' + (missing.length === 0 ? 'none' : missing.join(', ')));
console.log('');

const added = [...plugin].filter((n) => !upstream.has(n)).sort();
console.log('  names the plugin adds (dsh extensions): ' + added.join(', '));
console.log('');

// And the real proof: the plugin's facade compiles a script against the
// upstream names.
console.log('=== the proof: does a script using every upstream name compile? ===');
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
console.log('  compiled: ' + out.ok);
if (!out.ok) {
  for (const e of out.errors ?? out.diagnostics ?? []) console.log('    ' + JSON.stringify(e).slice(0, 300));
} else {
  console.log('  graphs: ' + JSON.stringify(out.sizes));
  console.log('  the upstream names the compiler SAW: ' + (out.sites?.length ?? 'n/a') + ' sites');
}
