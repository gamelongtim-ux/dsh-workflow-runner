// Adversarial check: the engine's journal survives a host restart.
//
// The engine's journal is the truth for replay, resume and the amend-resume
// import cache. If it only lives in memory, none of those survive a dsh
// restart: the predecessor's cached answers are gone.
//
// This drives the whole chain offline:
//
//   1. a predecessor run, whose answers are journaled
//   2. a NEW runtime over the SAME persist directory — a new process, as
//      far as the journal is concerned
//   3. a successor that asks the same thing -> a cache hit, with the model
//      NOT called
//
// Usage: node scripts/dwf-restart-resume-check.mjs

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

const persistDir = mkdtempSync(join(tmpdir(), 'dwf-restart-'));
const counter = { calls: 0 };

const script = `
phase("plan");
const answer = await agent("scout", { system: "You scout." }).ask<string>("Find the flaky tests.");
report({ answer });
return { answer };
`;

console.log('\n1. the predecessor runs in the FIRST process');
const first = new WorkflowRuntime({
  config: { allowedModels: ['deepseek-chat'], workspaceRoot: persistDir },
  logger: { info() {}, warn() {}, error() {}, debug() {} },
  persistDir,
  chat: countingChat(counter),
});
const firstRun = await first.startEngine({ scriptText: script, workspaceRoot: persistDir });
await new Promise((r) => setTimeout(r, 2500));
const firstState = first.runs.get(firstRun.runId);
check('the predecessor completed', firstState?.status === 'completed', `status=${firstState?.status}`);
check('the model was called once', counter.calls === 1, `calls=${counter.calls}`);
check('the predecessor is persisted', firstState !== undefined);

console.log('\n2. a SECOND process starts over the same persist directory');
// A new runtime is a new process as far as the journal is concerned: it has
// no in-memory state, only what is on disk.
const second = new WorkflowRuntime({
  config: { allowedModels: ['deepseek-chat'], workspaceRoot: persistDir },
  logger: { info() {}, warn() {}, error() {}, debug() {} },
  persistDir,
  chat: countingChat(counter),
});
await new Promise((r) => setTimeout(r, 400));
const restored = second.runs.get(firstRun.runId);
check('the predecessor was restored from disk', restored !== undefined,
  `restored=${restored !== undefined}`);
check('the restored run knows it is finished', restored?.status === 'completed',
  `status=${restored?.status}`);

console.log('\n3. the successor imports the cache across the restart');
{
  const before = counter.calls;
  const successor = await second.startEngine({
    scriptText: script,
    workspaceRoot: persistDir,
    resumeFrom: firstRun.runId,
  });
  await new Promise((r) => setTimeout(r, 2500));
  const succState = second.runs.get(successor.runId);
  check('the successor completed', succState?.status === 'completed', `status=${succState?.status}`);
  check(
    'the model was NOT called — the answer came from the restored cache',
    counter.calls === before,
    `calls=${counter.calls} (was ${before})`,
  );
  check(
    'the successor returned the cached answer',
    succState?._engine?.settlement?.artifact?.answer === 'answer#1: Find the flaky tests.',
    JSON.stringify(succState?._engine?.settlement?.artifact),
  );
}

console.log('\n4. the restored predecessor is visible in the run list');
{
  const runs = second.listRuns();
  check(
    'the restored run is listed',
    runs.some((r) => r.runId === firstRun.runId),
    `runs=${runs.length}`,
  );
}

console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures} problem(s))`}`);
process.exit(failures === 0 ? 0 : 1);
