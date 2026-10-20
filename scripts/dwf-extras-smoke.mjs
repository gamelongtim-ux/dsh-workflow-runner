#!/usr/bin/env node
/**
 * Test dsh's own facade members on the engine path.
 *
 * ZCode's facade does not cover them, so they are declared in dsh's facade
 * and installed as globals of the sandbox (see lib/dwf/dsh-facade.js). The
 * ones that need the host ride the worldRead channel; the ones that do not
 * (route, models, constants) are pure sugar or baked-in values.
 *
 * Usage: node scripts/dwf-extras-smoke.mjs
 */

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { WorkflowRuntime } from '../lib/runtime.js';

const SCRIPT = `
phase("extras");

// models / constants are baked into the sandbox.
const modelCount = models.length;
const rpcVersion = constants.rpcVersion;

// concurrency.stat() is the host's authoritative telemetry.
const conc = await concurrency.stat();

// stages is empty on a run nobody amended.
const stageCount = (await stages.list()).length;
const stagePending = await stages.pending();

// route is pure sugar: the router and the answerer are the script's own.
const routed = await route(
  { light: 'model-a', strong: 'model-b' },
  async () => '{"tier":"strong"}',
  async (model) => 'answered by ' + model,
);

// askUser reaches the human and comes back with the answer.
const answer = await askUser('What is your name?', { kind: 'text' });

report({ modelCount, rpcVersion, limit: conc.limit, stageCount, stagePending, routed, answer });
return { modelCount, rpcVersion, limit: conc.limit, stageCount, stagePending, routed, answer };
`;

let failures = 0;
function check(label, ok, detail) {
  if (!ok) failures += 1;
  process.stdout.write(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail === undefined ? '' : ` — ${detail}`}\n`);
}

async function main() {
  const root = mkdtempSync(join(tmpdir(), 'dwf-extras-'));
  const workspace = join(root, 'workspace');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(workspace, { recursive: true });

  const runtime = new WorkflowRuntime({
    chat: async () => ({ content: 'stub', usage: {}, raw: {} }),
    persistDir: join(root, 'runs'),
    defaultModelsAllowed: ['model-a', 'model-b'],
  });

  process.stdout.write('\ndsh facade members on the engine path\n');
  const started = await runtime.startEngine({
    scriptText: SCRIPT,
    workspaceRoot: workspace,
    name: 'extras.dwf.ts',
  });
  check('the run starts', started.status === 'starting', `status=${started.status}`);
  check('no diagnostics', (started.diagnostics || []).length === 0,
    JSON.stringify(started.diagnostics));

  // The run parks on askUser. Answer it the way the editor does.
  const runId = started.runId;
  let answered = false;
  for (let i = 0; i < 100 && !answered; i += 1) {
    const state = runtime.runs.get(runId);
    const pending = state && state.pendingQuestions
      ? [...state.pendingQuestions.keys()]
      : [];
    if (pending.length > 0) {
      // The question reached the user over SSE, and the answer comes back
      // on the same question id.
      const question = state.pendingQuestions.get(pending[0]);
      check('the question reached the user', question.question === 'What is your name?',
        question.question);
      runtime.answerQuestion(runId, pending[0], 'Ada');
      answered = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  check('the question was answered', answered);

  let state = null;
  for (let i = 0; i < 200; i += 1) {
    state = runtime.runs.get(runId);
    if (state && (state.status === 'completed' || state.status === 'error' || state.status === 'stopped')) break;
    await new Promise((r) => setTimeout(r, 100));
  }

  const settlement = state?._engine?.settlement;
  check('the run completes', state?.status === 'completed',
    `status=${state?.status} ${settlement?.error ? JSON.stringify(settlement.error) : ''}`);

  const artifact = settlement?.artifact ?? {};
  check('models lists the run\'s models', artifact.modelCount === 2, String(artifact.modelCount));
  check('constants carries the rpc version', artifact.rpcVersion === 7, String(artifact.rpcVersion));
  check('concurrency.stat reports the limit', artifact.limit === 8, String(artifact.limit));
  check('stages is empty on an un-amended run', artifact.stageCount === 0, String(artifact.stageCount));
  check('stages.pending is zero', artifact.stagePending === 0, String(artifact.stagePending));
  check('route picked the strong tier', artifact.routed === 'answered by model-b', artifact.routed);
  check('askUser got the human\'s answer', artifact.answer === 'Ada', artifact.answer);

  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch (_) {
    process.stdout.write(`(could not remove ${root} — file lock, ignoring)\n`);
  }

  process.stdout.write(`\n${failures === 0 ? 'PASS' : `FAIL (${failures} check(s))`}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  process.stderr.write(`smoke test crashed: ${err?.stack ?? err}\n`);
  process.exit(1);
});
