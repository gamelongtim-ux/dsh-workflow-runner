// Adversarial check: structural amend (stage injection) on an engine run.
//
// The legacy path hands an injected stage to the child over its stdin. The
// engine path has no child of ours, so the stage is parked on the HOST side
// and the script picks it up with `stages.run(stageId)`.
//
// This drives the whole thing offline: a run injects a stage, the script
// runs it, and the stage's result comes back.
//
// Usage: node scripts/dwf-stage-check.mjs

import { WorkflowRuntime } from '../lib/runtime.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let failures = 0;
function check(label, ok, detail = '') {
  if (!ok) failures += 1;
  process.stdout.write(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? `  — ${detail}` : ''}\n`);
}

const ws = mkdtempSync(join(tmpdir(), 'dwf-stage-'));
const runtime = new WorkflowRuntime({
  config: { allowedModels: ['deepseek-chat'], workspaceRoot: ws },
  logger: { info() {}, warn() {}, error() {}, debug() {} },
});

// The script waits for a stage to appear, then runs it.
//
// The local names avoid the facade's member names: a local called `list`
// collides with `git.status`'s sibling and trips the facade-siting rule.
const script = `
phase("plan");
await stages.await({ timeoutMs: 15000, forStage: true });
const items = await stages.list();
let ran = null;
if (items.length > 0) {
  ran = await stages.run(items[0].id);
}
report({ ran });
return { ran };
`;

const started = await runtime.startEngine({ scriptText: script, workspaceRoot: ws });
const runId = started.runId;
await new Promise((r) => setTimeout(r, 800));

console.log('\n1. a stage is injected into a live engine run');
const injected = await runtime.injectStage(runId, {
  name: 'review',
  code: 'async (ctx) => { return { verdict: "ok", stage: ctx.stage.name }; }',
  wait: false,
});
check('the stage was accepted', injected?.accepted === true, JSON.stringify(injected));
check('the stage has an id', typeof injected?.stageId === 'string' && injected.stageId.length > 0);

console.log('\n2. the script sees the stage and runs it');
// The script polls for the stage, so give it a moment to pick it up.
await new Promise((r) => setTimeout(r, 2500));
const st = runtime.runs.get(runId);
const stages = runtime.listInjectedStages(runId);
check('the stage was recorded', stages.length === 1, `stages=${stages.length}`);
const rec = stages[0];
check(
  'the stage ran',
  rec?.status === 'completed',
  `status=${rec?.status} error=${rec?.error ?? ''}`,
);
check(
  'the stage returned its result',
  rec?.result?.verdict === 'ok' && rec?.result?.stage === 'review',
  JSON.stringify(rec?.result),
);
check(
  'the script saw the stage list',
  (st?.reports?.at(-1)?.item?.ran?.verdict ?? null) === 'ok',
  JSON.stringify(st?.reports?.at(-1)?.item),
);

console.log('\n3. a stage with a broken body is recorded as an error');
{
  // The run has finished by now, so this checks the refusal instead: a
  // terminal run does not accept a stage.
  let refused = null;
  try {
    await runtime.injectStage(runId, {
      name: 'broken',
      code: 'async (ctx) => { throw new Error("stage blew up"); }',
      wait: false,
    });
  } catch (err) {
    refused = String(err && err.message || err);
  }
  check('a terminal run refuses a stage', refused !== null, refused ?? '(it was accepted)');
}

console.log('\n4. a stage whose body throws is recorded as an error');
{
  // A fresh run, so the stage has a live run to fail in.
  const ws2 = mkdtempSync(join(tmpdir(), 'dwf-stage2-'));
  const runtime2 = new WorkflowRuntime({
    config: { allowedModels: ['deepseek-chat'], workspaceRoot: ws2 },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  });
  const started2 = await runtime2.startEngine({
    scriptText: `
phase("plan");
await stages.await({ timeoutMs: 10000, forStage: true });
const items = await stages.list();
let ran = null;
let failed = false;
if (items.length > 0) {
  try { ran = await stages.run(items[0].id); } catch (e) { failed = true; }
}
report({ ran, failed });
return { ran, failed };
`,
    workspaceRoot: ws2,
  });
  await new Promise((r) => setTimeout(r, 700));
  await runtime2.injectStage(started2.runId, {
    name: 'broken',
    code: 'async (ctx) => { throw new Error("stage blew up"); }',
    wait: false,
  });
  await new Promise((r) => setTimeout(r, 2000));
  const rec = runtime2.listInjectedStages(started2.runId)[0];
  check(
    'the stage is recorded as failed',
    rec?.status === 'error',
    `status=${rec?.status} error=${rec?.error ?? ''}`,
  );
  check(
    'the error is recorded',
    /blew up/.test(String(rec?.error ?? '')),
    `error=${rec?.error}`,
  );
}

console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures} problem(s))`}`);
process.exit(failures === 0 ? 0 : 1);
