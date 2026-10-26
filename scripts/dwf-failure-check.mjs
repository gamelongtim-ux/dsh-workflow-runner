// Adversarial check for the engine path's FAILURE paths.
//
// The happy-path checks pass while a provider error kills the host and the
// engine's control plane never binds. This drives the failure paths.
//
// Every case here runs offline: no network, no API key.
//
// Usage: node scripts/dwf-failure-check.mjs

import { DshWorkflowDriver } from '../lib/dwf/driver.js';
import { WorkflowRuntime } from '../lib/runtime.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let failures = 0;
function check(label, ok, detail = '') {
  if (!ok) failures += 1;
  process.stdout.write(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? `  — ${detail}` : ''}\n`);
}

/** A journal that satisfies the port, recording what the driver wrote. */
function makeJournal() {
  const rows = [];
  return {
    rows,
    createRun() {},
    getRun() {},
    updateRunStatus() {},
    updateRunUsage() {},
    updateRunCaps() {},
    updateRunScript() {},
    putActor() {},
    getActor() {},
    listActors() { return []; },
    putNode() {},
    getNode() {},
    listNodes() { return []; },
    countNodes() { return 0; },
    sumResultBytes() { return 0; },
    appendEvent(runId, event) { rows.push(event); },
    listEvents() { return rows; },
  };
}

/**
 * A sink that mimics the engine's own use of what it is handed.
 *
 * The engine serialises a failed ask's error with `error.toJSON()`
 * (upstream: engine/scheduler.ts -> settleFailed). A sink that does the same
 * is the honest test: it fails exactly the way the engine fails.
 */
function makeSink(record) {
  return {
    askFailed(instance, error) {
      record.askFailed = { instance, error };
      // This is the line that used to throw `TypeError: error.toJSON is not
      // a function` and take the host process down.
      record.askFailedJson = error.toJSON();
    },
    askStats() {},
    askSubmitAttempted() {},
    askTurnEnded() {},
    stopRun(error) {
      record.stopRun = error;
      record.stopRunJson = error.toJSON();
    },
    askProgress() {},
    askWaiting() {},
    askExecuting() {},
    askMutating() {},
    runStalled() {},
    concurrencyChanged() {},
  };
}

function makeDriver(askModel) {
  const record = {};
  const sink = makeSink(record);
  const driver = new DshWorkflowDriver({
    sink,
    journal: makeJournal(),
    runId: 'failure-probe',
    services: {
      askModel,
      async worldRead() { return null; },
      async publishArtifact() { return null; },
      emit() {},
      resolveModel() { return 'deepseek-chat'; },
    },
  });
  return { driver, record };
}

async function drive(askModel) {
  const { driver, record } = makeDriver(askModel);
  driver.startAsk({ id: 'session#1', messages: [] }, { siteId: 'ask#1' }, {
    instructions: 'hello',
    typed: false,
  });
  await new Promise((r) => setTimeout(r, 150));
  return record;
}

console.log('\n1. a transient provider error fails the ask, and does not crash');
{
  const record = await drive(async () => {
    throw new Error('ECONNRESET: socket hang up');
  });
  check('the ask is failed', record.askFailed !== undefined);
  check(
    'the error is a WorkflowError',
    record.askFailed?.error?.name === 'WorkflowError',
    `name=${record.askFailed?.error?.name}`,
  );
  check(
    'the error serialises (this is what used to crash the host)',
    record.askFailedJson !== undefined && record.askFailedJson.code !== undefined,
    JSON.stringify(record.askFailedJson),
  );
  check(
    'the code is DriverError',
    record.askFailedJson?.code === 'DriverError',
    `code=${record.askFailedJson?.code}`,
  );
  check('the run was NOT stopped', record.stopRun === undefined);
}

console.log('\n2. a deterministic provider error stops the run');
for (const [label, status, kind] of [
  ['401 (auth expired)', 401, 'auth'],
  ['403 (not on the plan)', 403, 'auth'],
  ['402 (out of credit)', 402, 'quota'],
  ['429 (quota exhausted)', 429, 'quota'],
  ['404 (no such model)', 404, 'model_unavailable'],
]) {
  const record = await drive(async () => {
    const err = new Error(`provider said ${status}`);
    err.status = status;
    throw err;
  });
  check(
    `${label} stops the run`,
    record.stopRun !== undefined,
    record.stopRun ? `kind=${record.stopRun.providerStop?.kind}` : 'no stopRun',
  );
  check(
    `${label} carries code ProviderStop`,
    record.stopRunJson?.code === 'ProviderStop',
    `code=${record.stopRunJson?.code}`,
  );
  check(
    `${label} classifies the kind as ${kind}`,
    record.stopRun?.providerStop?.kind === kind,
    `kind=${record.stopRun?.providerStop?.kind}`,
  );
  check(
    `${label} does not fail the individual ask`,
    record.askFailed === undefined,
  );
}

console.log('\n3. a transient server error is NOT treated as deterministic');
{
  const record = await drive(async () => {
    const err = new Error('upstream 503');
    err.status = 503;
    throw err;
  });
  check('a 503 fails the ask', record.askFailed !== undefined);
  check('a 503 does not stop the run', record.stopRun === undefined);
}

console.log('\n4. the engine\'s control plane binds');
{
  const ws = mkdtempSync(join(tmpdir(), 'dwf-fail-'));
  const runtime = new WorkflowRuntime({
    config: { allowedModels: ['deepseek-chat'], workspaceRoot: ws },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  });
  const started = await runtime.startEngine({
    scriptText: 'phase("p"); return { ok: true };',
    workspaceRoot: ws,
  });
  await new Promise((r) => setTimeout(r, 1500));
  const st = runtime.runs.get(started.runId);
  check('the run completed', st?.status === 'completed', `status=${st?.status}`);
  check(
    'the live engine handle was bound',
    runtime._engineControls.size === 1,
    `_engineControls.size=${runtime._engineControls.size}`,
  );
  const engine = runtime._engineControls.get(started.runId);
  check('the handle is the engine', engine !== undefined && typeof engine === 'object');
  check(
    'the engine can change a live run\'s concurrency ceiling',
    typeof engine?.setMaxConcurrency === 'function',
    `setMaxConcurrency=${typeof engine?.setMaxConcurrency}`,
  );
}

console.log('\n5. the run\'s concurrency telemetry is real on the engine path');
{
  const ws2 = mkdtempSync(join(tmpdir(), 'dwf-fail-cc-'));
  // A chat slow enough for the stat to observe it in flight.
  const slowChat = async () => {
    await new Promise((r) => setTimeout(r, 600));
    return { content: 'hi', usage: { total_tokens: 1 } };
  };
  const runtime2 = new WorkflowRuntime({
    config: { allowedModels: ['deepseek-chat'], workspaceRoot: ws2 },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    chat: slowChat,
  });
  const started2 = await runtime2.startEngine({
    scriptText: `
phase("p");
const before = await concurrency.stat();
const x = await agent("a").ask("q");
const after = await concurrency.stat();
report({ before, after });
return { before, after };
`,
    workspaceRoot: ws2,
  });
  await new Promise((r) => setTimeout(r, 3000));
  const st2 = runtime2.runs.get(started2.runId);
  const item = st2?.reports?.at(-1)?.item;
  check('the run completed', st2?.status === 'completed', `status=${st2?.status}`);
  check(
    'the telemetry counts the ask',
    item?.after?.totalAcquired >= 1,
    `totalAcquired=${item?.after?.totalAcquired}`,
  );
  check(
    'the telemetry records a peak',
    item?.after?.peak >= 1,
    `peak=${item?.after?.peak}`,
  );
  check(
    'the limit is reported',
    item?.after?.limit > 0,
    `limit=${item?.after?.limit}`,
  );
}

console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures} problem(s))`}`);
process.exit(failures === 0 ? 0 : 1);
