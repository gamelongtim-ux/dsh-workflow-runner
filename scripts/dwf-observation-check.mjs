// Adversarial check: the engine's OBSERVATION surface.
//
// `WorkflowReportSink` has eleven members. Eight are decisions or
// outcomes; three are pure observation — `askProgress`, `askWaiting` and
// `askExecuting` — and the engine only RECORDS them:
//
//   askProgress  -> `node-progress`
//   askWaiting   -> `node-waiting`
//   askExecuting -> `node-executing`
//
// They are how a long ask looks alive instead of stalled, so they are
// worth having. And they carry a CONTRACT: the progress of a turn must
// precede the usage of that turn, because the two events' order is what a
// reader relies on (upstream: types.ts, "必须先于同一次 turn 的 askStats
// 调用 —— 两条事件的先后是读面的契约").
//
// This drives the driver directly and records the order the engine saw.
//
// Usage: node scripts/dwf-observation-check.mjs

import { DshWorkflowDriver } from '../lib/dwf/driver.js';

let failures = 0;
function check(label, ok, detail = '') {
  if (!ok) failures += 1;
  process.stdout.write(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? `  — ${detail}` : ''}\n`);
}

/** A sink that records the order it was called in. */
function makeSink(record) {
  return {
    askSubmitAttempted: (i) => record.calls.push('askSubmitAttempted'),
    askTurnEnded: (i) => record.calls.push('askTurnEnded'),
    askStats: (i) => record.calls.push('askStats'),
    askProgress: (i, p) => record.calls.push(`askProgress:${JSON.stringify(p)}`),
    askWaiting: (i, w) => record.calls.push(`askWaiting:${JSON.stringify(w)}`),
    askExecuting: (i) => record.calls.push('askExecuting'),
    askFailed: (i, e) => record.calls.push('askFailed'),
    askMutating: (i) => record.calls.push('askMutating'),
    stopRun: (e) => record.calls.push('stopRun'),
    runStalled: () => record.calls.push('runStalled'),
    concurrencyChanged: () => record.calls.push('concurrencyChanged'),
  };
}

function makeJournal() {
  const rows = new Map();
  return {
    rows,
    createRun() {},
    getRun() { return undefined; },
    updateRunStatus() {},
    updateRunUsage() {},
    updateRunCaps() {},
    updateRunScript() {},
    putActor() {},
    getActor() { return undefined; },
    listActors() { return []; },
    putNode() {},
    getNode() { return undefined; },
    listNodes() { return []; },
    countNodes() { return 0; },
    sumResultBytes() { return 0; },
    appendEvent(runId, e) { rows.set(e, (rows.get(e) ?? 0) + 1); return { sequence: rows.size, event: e, timeCreated: 0 }; },
    listEvents() { return []; },
  };
}

console.log('\n1. an ask reports the observations the engine records');
{
  const record = { calls: [] };
  const driver = new DshWorkflowDriver({
    sink: makeSink(record),
    journal: makeJournal(),
    runId: 'obs',
    services: {
      askModel: async () => ({ text: 'hello', tokens: 12, toolCalls: 0, turns: 1 }),
      async worldRead() { return null; },
      async publishArtifact() { return null; },
      emit() {},
      resolveModel() { return 'deepseek-chat'; },
    },
  });
  driver.startAsk({ id: 's1', messages: [] }, { siteId: 'ask#1', ordinal: 1 }, {
    instructions: 'hi', typed: false,
  });
  await new Promise((r) => setTimeout(r, 100));

  check('the request going out is reported', record.calls.includes('askExecuting'),
    record.calls.join(' -> '));
  check('the progress is reported', record.calls.some((c) => c.startsWith('askProgress:')),
    record.calls.join(' -> '));
  check('the usage is reported', record.calls.includes('askStats'),
    record.calls.join(' -> '));
  check('the outcome is reported', record.calls.includes('askTurnEnded'),
    record.calls.join(' -> '));
}

console.log('\n2. the progress of a turn precedes the usage of that turn');
{
  const record = { calls: [] };
  const driver = new DshWorkflowDriver({
    sink: makeSink(record),
    journal: makeJournal(),
    runId: 'obs',
    services: {
      askModel: async () => ({ text: 'hello', tokens: 12, toolCalls: 0, turns: 1 }),
      async worldRead() { return null; },
      async publishArtifact() { return null; },
      emit() {},
      resolveModel() { return 'deepseek-chat'; },
    },
  });
  driver.startAsk({ id: 's1', messages: [] }, { siteId: 'ask#1', ordinal: 1 }, {
    instructions: 'hi', typed: false,
  });
  await new Promise((r) => setTimeout(r, 100));

  const progressAt = record.calls.findIndex((c) => c.startsWith('askProgress:'));
  const statsAt = record.calls.indexOf('askStats');
  check('both were reported', progressAt >= 0 && statsAt >= 0, record.calls.join(' -> '));
  check(
    'the progress comes first',
    progressAt >= 0 && statsAt >= 0 && progressAt < statsAt,
    `progress@${progressAt} stats@${statsAt}`,
  );
}

console.log('\n3. a retry reports the wait');
{
  const record = { calls: [] };
  const driver = new DshWorkflowDriver({
    sink: makeSink(record),
    journal: makeJournal(),
    runId: 'obs',
    services: {
      askModel: async () => ({ text: 'hello', tokens: 12, toolCalls: 0, turns: 1 }),
      async worldRead() { return null; },
      async publishArtifact() { return null; },
      emit() {},
      resolveModel() { return 'deepseek-chat'; },
    },
  });
  // The engine calls `respondToSubmit` SYNCHRONOUSLY inside
  // `askSubmitAttempted` — a typed result that does not fit the schema is
  // answered by a retry, and the engine drives it by calling back into the
  // driver right there. So the sink has to answer that callback the way
  // the engine does, or the retry never happens.
  //
  // The rejection is bounded: the engine has a repair budget, and so does
  // this check — an unbounded rejection would retry forever.
  const sink = makeSink(record);
  let rejections = 0;
  sink.askSubmitAttempted = (instance) => {
    record.calls.push('askSubmitAttempted');
    rejections += 1;
    if (rejections > 2) return;
    // This is the engine's own behaviour: a result that does not fit the
    // schema is rejected, and the driver owes the model another turn.
    driver.respondToSubmit(instance, {
      kind: 'reject',
      violations: [{ path: 'a', message: 'wrong type' }],
    });
  };
  driver.sink = sink;

  driver.startAsk({ id: 's1', messages: [] }, { siteId: 'ask#1', ordinal: 1 }, {
    instructions: 'hi', typed: true,
  });
  await new Promise((r) => setTimeout(r, 100));

  const wait = record.calls.find((c) => c.startsWith('askWaiting:'));
  check('the wait is reported', wait !== undefined, record.calls.join(' -> '));
  check(
    'the wait names its cause',
    wait !== undefined && /"cause":"backoff"/.test(wait),
    wait ?? '',
  );
  check(
    'the ask was retried — the model was called again',
    record.calls.filter((c) => c === 'askExecuting').length >= 2,
    `executions=${record.calls.filter((c) => c === 'askExecuting').length}`,
  );
}

console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures} problem(s))`}`);
process.exit(failures === 0 ? 0 : 1);
