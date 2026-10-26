// Adversarial check: filling a hole on an engine run.
//
// The hole fill is the one place where a model supplies CODE that the engine
// then runs. The contract upstream is not "answer this hole" — it is "this
// run's VALID SCRIPT is now this text", which means the fill recompiles.
//
// This drives the whole thing offline: a run parks on a hole, the host
// fills it, and the run must finish with the filled body's value.
//
// Usage: node scripts/dwf-hole-fill-check.mjs

import { WorkflowRuntime } from '../lib/runtime.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let failures = 0;
function check(label, ok, detail = '') {
  if (!ok) failures += 1;
  process.stdout.write(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? `  — ${detail}` : ''}\n`);
}

const ws = mkdtempSync(join(tmpdir(), 'dwf-holefill-'));
const runtime = new WorkflowRuntime({
  config: { allowedModels: ['deepseek-chat'], workspaceRoot: ws },
  logger: { info() {}, warn() {}, error() {}, debug() {} },
});

const script = `
phase("plan");
const decision = await hole<string>("decide", "What should we do?");
return { decision };
`;

const started = await runtime.startEngine({ scriptText: script, workspaceRoot: ws });
const runId = started.runId;
await new Promise((r) => setTimeout(r, 2000));

const st = runtime.runs.get(runId);
check('the run parked on the hole', st?.status === 'running', `status=${st?.status}`);

const engine = runtime._engineControls.get(runId);
check('the control plane is bound', engine !== undefined);

const open = engine?.openHoles?.() ?? [];
check('the engine reports one open hole', open.length === 1, `open=${JSON.stringify(open)}`);
const siteId = open[0]?.siteId;

console.log('\n1. filling a hole that is not waiting is refused');
{
  const bad = runtime.fillHole(runId, 'hole#00000000', 'async () => 1');
  check('the fill is refused', bad?.ok !== true, JSON.stringify(bad));
}

console.log('\n2. a fill whose body does not compile is refused');
{
  const bad = runtime.fillHole(runId, siteId, 'async () => { this is not valid js');
  check('the fill is refused', bad?.ok !== true, JSON.stringify(bad));
  check(
    'the reason names the compile failure',
    /compile/i.test(String(bad?.reason ?? '')),
    `reason=${bad?.reason}`,
  );
}

console.log('\n3. a valid fill is accepted and the run finishes');
{
  const good = runtime.fillHole(runId, siteId, 'async () => { return "ship it"; }');
  check('the fill is accepted', good?.ok === true, JSON.stringify(good));

  await new Promise((r) => setTimeout(r, 1500));
  const after = runtime.runs.get(runId);
  check('the run completed', after?.status === 'completed', `status=${after?.status}`);
  const settlement = after?._engine?.settlement;
  check(
    'the run returned the filled body\'s value',
    settlement?.artifact?.decision === 'ship it',
    `artifact=${JSON.stringify(settlement?.artifact)}`,
  );
  check(
    'the hole is no longer pending',
    (after?.pendingHoles?.size ?? 0) === 0,
    `pendingHoles=${after?.pendingHoles?.size}`,
  );
  check(
    'the engine remembers the fill',
    (engine?.filledHoles?.() ?? []).length === 1,
    JSON.stringify(engine?.filledHoles?.()),
  );
}

console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures} problem(s))`}`);
process.exit(failures === 0 ? 0 : 1);
