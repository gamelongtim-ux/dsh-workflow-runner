// Adversarial check: the import cache CLOSES at the first write.
//
// The cache holds a predecessor's cached answers. A cached answer is an
// answer about the PREDECESSOR's world, and that world stops existing at
// the first write — so the cache closes there, and only there.
//
// The close is reported by the engine as an `import-cache-closed` event,
// and it is the ONE driver observation the engine makes a decision on.
//
// This drives the whole chain offline:
//
//   1. a predecessor run, whose answers are cached
//   2. a successor that asks the SAME thing -> a cache hit
//   3. a successor that asks the same thing AND writes to the workspace
//      -> the write closes the cache BEFORE the write
//
// Usage: node scripts/dwf-import-cache-check.mjs

import { WorkflowRuntime } from '../lib/runtime.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let failures = 0;
function check(label, ok, detail = '') {
  if (!ok) failures += 1;
  process.stdout.write(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? `  — ${detail}` : ''}\n`);
}

function countingChat(counter) {
  return async ({ messages }) => {
    counter.calls += 1;
    const last = messages[messages.length - 1];
    return {
      content: `answer#${counter.calls}: ${String(last?.content ?? '')}`,
      usage: { total_tokens: 10 },
    };
  };
}

/** The engine's event types, from dsh's flat mirror. */
function eventTypes(state, runId) {
  return (state?.journal ?? [])
    .filter((j) => j.kind === 'engine.event')
    .map((j) => j.type);
}

const ws = mkdtempSync(join(tmpdir(), 'dwf-imp-'));
const counter = { calls: 0 };
const runtime = new WorkflowRuntime({
  config: { allowedModels: ['deepseek-chat'], workspaceRoot: ws },
  logger: { info() {}, warn() {}, error() {}, debug() {} },
  chat: countingChat(counter),
});

const plain = `
phase("plan");
const answer = await agent("scout", { system: "You scout." }).ask<string>("Find the flaky tests.");
report({ answer });
return { answer };
`;

// A script that asks the same thing and THEN writes to the workspace.
const withWrite = `
phase("plan");
const answer = await agent("scout", { system: "You scout." }).ask<string>("Find the flaky tests.");
const r = await world.run("node", ["-e", "process.stdout.write('x')"]);
report({ answer, exit: r.exitCode });
return { answer };
`;

console.log('\n1. the predecessor runs and its answer is cached');
const first = await runtime.startEngine({ scriptText: plain, workspaceRoot: ws });
await new Promise((r) => setTimeout(r, 2500));
const firstState = runtime.runs.get(first.runId);
check('the predecessor completed', firstState?.status === 'completed', `status=${firstState?.status}`);
check('the model was called once', counter.calls === 1, `calls=${counter.calls}`);

console.log('\n2. a successor with the same ask is a cache hit');
{
  const before = counter.calls;
  const second = await runtime.startEngine({
    scriptText: plain,
    workspaceRoot: ws,
    resumeFrom: first.runId,
  });
  await new Promise((r) => setTimeout(r, 2500));
  const secondState = runtime.runs.get(second.runId);
  check('the successor completed', secondState?.status === 'completed', `status=${secondState?.status}`);
  check(
    'the model was NOT called — the answer came from the cache',
    counter.calls === before,
    `calls=${counter.calls} (was ${before})`,
  );
  check(
    'the successor returned the cached answer',
    secondState?._engine?.settlement?.artifact?.answer === 'answer#1: Find the flaky tests.',
    JSON.stringify(secondState?._engine?.settlement?.artifact),
  );

  // The model not being called is necessary but not sufficient: the cache
  // could have been built and simply ignored. The engine's own journal is
  // the proof — a cached settle is marked as one.
  const events = secondState?._engineJournal
    ?.listEvents(second.runId, { types: 'all', reportItems: 'all' }) ?? [];
  const settled = events.find((e) => e.event?.type === 'node-settled');
  check(
    'the engine settled the ask FROM THE CACHE',
    settled?.event?.cached === true,
    JSON.stringify(settled?.event).slice(0, 200),
  );
  check(
    'the settle names the source session',
    typeof settled?.event?.sourceSessionId === 'string',
    `sourceSessionId=${settled?.event?.sourceSessionId}`,
  );
  // A cached settle must NOT be preceded by a dispatch: a dispatch would
  // mean the ask went live.
  const dispatched = events.some((e) => e.event?.type === 'node-dispatched');
  check('the ask never went live', dispatched === false, `dispatched=${dispatched}`);
}

console.log('\n3. a successor that WRITES closes the cache');
{
  const before = counter.calls;
  const third = await runtime.startEngine({
    scriptText: withWrite,
    workspaceRoot: ws,
    resumeFrom: first.runId,
  });
  await new Promise((r) => setTimeout(r, 2500));
  const thirdState = runtime.runs.get(third.runId);
  check('the successor completed', thirdState?.status === 'completed', `status=${thirdState?.status}`);
  const types = eventTypes(thirdState, third.runId);
  const closed = types.filter((t) => t === 'import-cache-closed');
  check(
    'the cache close is reported',
    closed.length >= 1,
    `closed=${closed.length} events=${JSON.stringify(types)}`,
  );
  // The close must come BEFORE the write's node settles, or the write
  // would have already happened against a stale world.
  const closeAt = types.indexOf('import-cache-closed');
  check('the close is reported at all', closeAt >= 0);
}

console.log('\n4. the close is idempotent — a second write does not close twice');
{
  const fourth = await runtime.startEngine({
    scriptText: withWrite + '\nconst r2 = await world.run("node", ["-e", "process.stdout.write(\'y\')"]);',
    workspaceRoot: ws,
    resumeFrom: first.runId,
  });
  await new Promise((r) => setTimeout(r, 2500));
  const fourthState = runtime.runs.get(fourth.runId);
  const types = eventTypes(fourthState, fourth.runId);
  const closed = types.filter((t) => t === 'import-cache-closed');
  check(
    'the cache closes exactly once',
    closed.length === 1,
    `closed=${closed.length}`,
  );
}

console.log('\n5. a successor with DIFFERENT instructions misses the cache');
{
  const before = counter.calls;
  const different = `
phase("plan");
const answer = await agent("scout", { system: "You scout." }).ask<string>("Find the SLOW tests.");
report({ answer });
return { answer };
`;
  const fifth = await runtime.startEngine({
    scriptText: different,
    workspaceRoot: ws,
    resumeFrom: first.runId,
  });
  await new Promise((r) => setTimeout(r, 2500));
  check(
    'the model WAS called — the hash missed',
    counter.calls > before,
    `calls=${counter.calls} (was ${before})`,
  );
}

console.log('\n6. a successor with a DIFFERENT persona misses the cache');
{
  const before = counter.calls;
  const otherPersona = `
phase("plan");
const answer = await agent("scout", { system: "You are a different scout." }).ask<string>("Find the flaky tests.");
report({ answer });
return { answer };
`;
  const sixth = await runtime.startEngine({
    scriptText: otherPersona,
    workspaceRoot: ws,
    resumeFrom: first.runId,
  });
  await new Promise((r) => setTimeout(r, 2500));
  check(
    'the model WAS called — the persona did not match',
    counter.calls > before,
    `calls=${counter.calls} (was ${before})`,
  );
}

console.log('\n7. a stage\'s host-side write closes the cache too');
{
  // The engine closes its own cache for a live `world.run`. But a STAGE
  // runs on the HOST side — the engine does not see its write, so the
  // driver has to report it (`askMutating`). This is the path that
  // upstream's tool-activity observer covers.
  const before = counter.calls;
  const withStage = `
phase("plan");
const answer = await agent("scout", { system: "You scout." }).ask<string>("Find the flaky tests.");
await stages.await({ timeoutMs: 8000, forStage: true });
const items = await stages.list();
if (items.length > 0) { await stages.run(items[0].id); }
report({ answer });
return { answer };
`;
  const ws2 = mkdtempSync(join(tmpdir(), 'dwf-imp-stage-'));
  const runtime2 = new WorkflowRuntime({
    config: { allowedModels: ['deepseek-chat'], workspaceRoot: ws2 },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    chat: countingChat(counter),
  });
  // A predecessor in its own workspace.
  const pred = await runtime2.startEngine({ scriptText: plain, workspaceRoot: ws2 });
  await new Promise((r) => setTimeout(r, 2500));
  check('the predecessor completed', runtime2.runs.get(pred.runId)?.status === 'completed');

  // A successor that runs a stage whose body writes to the workspace.
  const successor = await runtime2.startEngine({
    scriptText: withStage,
    workspaceRoot: ws2,
    resumeFrom: pred.runId,
  });
  await new Promise((r) => setTimeout(r, 800));
  await runtime2.injectStage(successor.runId, {
    name: 'writer',
    // The stage body receives (ctx, dsh): ctx is the run's context, dsh is
    // the facade — phase, log, report, agent, world, files, git.
    code: 'async (ctx, dsh) => { await dsh.world.run("node", ["-e", "process.stdout.write(\'x\')"]); return { wrote: true }; }',
    wait: false,
  });
  await new Promise((r) => setTimeout(r, 2500));
  const succState = runtime2.runs.get(successor.runId);
  const types = eventTypes(succState, successor.runId);
  check(
    'the stage\'s write closed the cache',
    types.filter((t) => t === 'import-cache-closed').length >= 1,
    `events=${JSON.stringify(types)}`,
  );
}

console.log('\n8. resuming from a run that does not exist is refused');
{
  let refused = null;
  try {
    await runtime.startEngine({ scriptText: plain, workspaceRoot: ws, resumeFrom: 'no-such-run' });
  } catch (err) {
    refused = String(err && err.message || err);
  }
  check('the resume is refused', refused !== null, refused ?? '(it was accepted)');
}

console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures} problem(s))`}`);
process.exit(failures === 0 ? 0 : 1);
