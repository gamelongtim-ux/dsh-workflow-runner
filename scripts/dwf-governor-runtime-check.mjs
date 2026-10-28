// Adversarial check: the governor is WIRED into the real run.
//
// The governor check drives the controller directly. This one drives a
// real RUN through the runtime, with a model that always answers 429, and
// checks that:
//
//   - the run's asks are admitted under a cap that came DOWN
//   - the engine recorded a `concurrency-changed` event
//   - the throttle did not fail the run (a 429 is a throttle, not a
//     permanent provider error — well, dsh treats it as one; see below)
//
// Usage: node scripts/dwf-governor-runtime-check.mjs

import { WorkflowRuntime } from '../lib/runtime.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let failures = 0;
function check(label, ok, detail = '') {
  if (!ok) failures += 1;
  process.stdout.write(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? `  — ${detail}` : ''}\n`);
}

const ws = mkdtempSync(join(tmpdir(), 'dwf-gov-'));
let calls = 0;

// A model that is always throttled.
const throttledChat = async () => {
  calls += 1;
  const err = new Error('rate limited');
  err.status = 429;
  err.retryAfterMs = 1000;
  throw err;
};

const runtime = new WorkflowRuntime({
  config: { allowedModels: ['deepseek-chat'], workspaceRoot: ws },
  logger: { info() {}, warn() {}, error() {}, debug() {} },
  chat: throttledChat,
});

console.log('\n1. a run against a throttled provider');
const script = `
phase("p");
const a = await agent("s").ask<string>("q");
return { a };
`;
const started = await runtime.startEngine({ scriptText: script, workspaceRoot: ws });
await new Promise((r) => setTimeout(r, 2500));
const st = runtime.runs.get(started.runId);

check('the run was attempted', calls >= 1, `model calls=${calls}`);
check('the run did not crash the host', st !== undefined, `status=${st?.status}`);

console.log('\n2. the governor learned from the throttle');
{
  const snapshot = runtime._governor.snapshot();
  check('the governor has a controller for the key', snapshot.length >= 1,
    JSON.stringify(snapshot.map((s) => s.key)));
  const controller = snapshot[0];
  check('the cap came down below the initial concurrency',
    controller !== undefined && controller.cap < controller.initial,
    controller === undefined ? '' : `cap=${controller.cap} initial=${controller.initial}`);
  check('the controller says the provider throttled',
    controller !== undefined && controller.lastBad !== undefined,
    controller === undefined ? '' : `lastBad=${controller.lastBad}`);
}

console.log('\n3. the engine recorded the change');
{
  const events = st?._engineJournal
    ?.listEvents(started.runId, { types: 'all', reportItems: 'all' }) ?? [];
  const changed = events.filter((e) => e.event?.type === 'concurrency-changed');
  check('a concurrency-changed event was recorded', changed.length >= 1,
    `events=${changed.length}`);
  if (changed.length > 0) {
    const change = changed[0].event;
    check('the change names the reason', typeof change.reason === 'string',
      `reason=${change.reason}`);
    check('the change shows the cap going down',
      change.next < change.previous,
      `${change.previous} -> ${change.next}`);
  }
}

console.log('\n4. the cap is shared — a second run inherits it');
{
  const before = runtime._governor.snapshot()[0]?.cap;
  const second = await runtime.startEngine({ scriptText: script, workspaceRoot: ws });
  await new Promise((r) => setTimeout(r, 1500));
  const after = runtime._governor.snapshot()[0]?.cap;
  check('the second run did not raise the cap back',
    after === undefined || after <= before,
    `before=${before} after=${after}`);
  check('the second run was attempted', runtime.runs.get(second.runId) !== undefined);
}

console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures} problem(s))`}`);
process.exit(failures === 0 ? 0 : 1);
