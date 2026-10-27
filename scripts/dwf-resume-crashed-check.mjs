// Adversarial check: resume a CRASHED run from its journal.
//
// Two different things are called "resume", and only one of them is
// missing:
//
//  - AMEND-RESUME (done): a NEW run inherits the predecessor's cached
//    answers. dsh's `resume_from`.
//
//  - RESUME (missing): the SAME run, restarted from its journal after a
//    crash. Upstream's `ResumeWorkflowRun`. The engine supports it: the
//    same run id plus a byte-identical script takes the resume branch
//    (upstream: engine.ts, `restoreFromJournal`), which restores the
//    settle order, the recorded asks, the report tally and the artifact
//    state — and refuses with `ScriptHashMismatch` if the script changed.
//
// This drives the whole thing offline.
//
// Usage: node scripts/dwf-resume-crashed-check.mjs

import { WorkflowRuntime } from '../lib/runtime.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let failures = 0;
function check(label, ok, detail = '') {
  if (!ok) failures += 1;
  process.stdout.write(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? `  — ${detail}` : ''}\n`);
}

const ws = mkdtempSync(join(tmpdir(), 'dwf-resume-'));
const counter = { calls: 0 };
const runtime = new WorkflowRuntime({
  config: { allowedModels: ['deepseek-chat'], workspaceRoot: ws },
  logger: { info() {}, warn() {}, error() {}, debug() {} },
  chat: async ({ messages }) => {
    counter.calls += 1;
    const last = messages[messages.length - 1];
    return { content: `answer#${counter.calls}: ${String(last?.content ?? '')}`, usage: { total_tokens: 10 } };
  },
});

const script = `
phase("plan");
const answer = await agent("scout", { system: "You scout." }).ask<string>("Find the flaky tests.");
report({ answer });
return { answer };
`;

console.log('\n1. a run is recorded in the journal');
// A fresh run id: the journal is DURABLE and SHARED, so a fixed id would
// find a previous run's rows and start from "resume" rather than "new".
const runId = `resume-probe-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6)}`;
const first = await runtime.startEngine({ scriptText: script, workspaceRoot: ws, runId });
await new Promise((r) => setTimeout(r, 2500));
const firstState = runtime.runs.get(runId);
check('the run completed', firstState?.status === 'completed', `status=${firstState?.status}`);
check('the model was called once', counter.calls === 1, `calls=${counter.calls}`);
check('the run is in the journal', firstState?._engineJournal?.getRun(runId) !== undefined);

console.log('\n2. the SAME run id with the SAME script resumes');
{
  // The engine's resume branch is taken when the journal already has the
  // run. The run row is put back to "running" and the recorded asks are
  // re-seeded, so an ask that already settled is NOT paid for again.
  const before = counter.calls;
  const second = await runtime.startEngine({ scriptText: script, workspaceRoot: ws, runId });
  await new Promise((r) => setTimeout(r, 2500));
  const secondState = runtime.runs.get(runId);
  check('the run completed again', secondState?.status === 'completed', `status=${secondState?.status}`);
  check(
    'the settled ask was NOT paid for again',
    counter.calls === before,
    `calls=${counter.calls} (was ${before})`,
  );
  const events = secondState?._engineJournal
    ?.listEvents(runId, { types: 'all', reportItems: 'all' }) ?? [];
  const cached = events.filter((e) => e.event?.type === 'node-settled' && e.event?.cached === true);
  check(
    'the ask was settled from the journal',
    cached.length >= 1,
    `cached settles=${cached.length}`,
  );
}

console.log('\n3. the SAME run id with a DIFFERENT script is refused');
{
  // Upstream refuses with `ScriptHashMismatch`, and it refuses the
  // RESUME rather than accepting it and failing the run -- a run that
  // could still be resumed with the right script must not be poisoned by
  // a failed one.
  //
  // The refusal surfaces as the RUN's error, not as a synchronous throw
  // from `startEngine`: the engine raises it while it constructs, and the
  // engine's construction happens inside the harness's own task. So the
  // check looks at the run's error.
  const different = script.replace('Find the flaky tests.', 'Find the slow tests.');
  const third = await runtime.startEngine({ scriptText: different, workspaceRoot: ws, runId });
  await new Promise((r) => setTimeout(r, 2000));
  const thirdState = runtime.runs.get(runId);
  const error = thirdState?._engineError ?? thirdState?.settlement?.error?.message ?? '';
  check('the resume is refused', Boolean(error), error || '(it was accepted)');
  check(
    'the refusal names the script hash',
    /ScriptHashMismatch|script changed/i.test(error),
    error.slice(0, 120),
  );
  check(
    'the run ends up failed, not silently "running"',
    thirdState?.status === 'error',
    `status=${thirdState?.status}`,
  );
}

console.log('\n4. the runtime refuses to resume a LIVE run');
{
  // A run that is still going does not need resuming, and resuming it
  // would start a second engine on the same journal row.
  const ws2 = mkdtempSync(join(tmpdir(), 'dwf-resume-live-'));
  const runtime2 = new WorkflowRuntime({
    config: { allowedModels: ['deepseek-chat'], workspaceRoot: ws2 },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    chat: async () => {
      // Slow enough that the run is still going when the resume is tried.
      await new Promise((r) => setTimeout(r, 1500));
      return { content: 'x', usage: { total_tokens: 1 } };
    },
  });
  const liveId = `resume-live-${Date.now().toString(36)}`;
  await runtime2.startEngine({ scriptText: script, workspaceRoot: ws2, runId: liveId });
  await new Promise((r) => setTimeout(r, 300));
  let error = null;
  try {
    await runtime2.resumeRun(liveId, script);
  } catch (err) {
    error = String(err && err.message || err);
  }
  check('the resume is refused', error !== null, error ?? '(it was accepted)');
  check(
    'the refusal says the run is live',
    /does not need resuming|is running/i.test(error ?? ''),
    error ?? '',
  );
}

console.log('\n5. the runtime refuses to resume an unknown run');
{
  let error = null;
  try {
    await runtime.resumeRun('no-such-run-at-all', script);
  } catch (err) {
    error = String(err && err.message || err);
  }
  check('the resume is refused', error !== null, error ?? '(it was accepted)');
}

console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures} problem(s))`}`);
process.exit(failures === 0 ? 0 : 1);
