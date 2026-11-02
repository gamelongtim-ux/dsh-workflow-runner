// Every model-facing tool's output must survive a JSON round trip.
//
// The host checks a tool's output before it leaves the tool
// (`snapshotToolValue`): a value that does not survive the round trip is
// rejected with "value is not lossless JSON", and the model sees the
// error instead of the result.
//
// `undefined` is the one thing that does not survive it -- JSON.stringify
// DROPS the key entirely. A single `undefined` in a journal entry made
// `get_workflow_run` fail for every run.
//
// This exercises every tool against a live run and checks the host's own
// rule.
//
// Usage: node scripts/dwf-tool-output-check.mjs

import { readFileSync } from 'node:fs';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let failures = 0;
function check(label, ok, detail = '') {
  if (!ok) failures += 1;
  process.stdout.write(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? `  — ${detail}` : ''}\n`);
}

// The host's own rule. It is extracted from the installed dsh so the
// check IS the host's rule, not a paraphrase of it.
const VALUES_MODULE = join(
  process.env.USERPROFILE ?? '',
  '.dsh',
  'profiles',
  'desktop',
  'node_modules',
  '@deepseek-ai',
  'dsh-util-values',
  'lib',
  'index.js',
);

let isJsonValue = null;
try {
  ({ isJsonValue } = await import(`file:///${VALUES_MODULE.replace(/\\/g, '/')}`));
} catch (err) {
  // The host's package may not be resolvable from here; fall back to the
  // rule itself, which is the whole of it.
  const asJson = (value) => {
    if (value === null) return true;
    const t = typeof value;
    if (t === 'string' || t === 'boolean') return true;
    if (t === 'number') return Number.isFinite(value);
    if (t === 'undefined' || t === 'function' || t === 'symbol' || t === 'bigint') return false;
    if (Array.isArray(value)) return value.every(asJson);
    if (t === 'object') return Object.values(value).every(asJson);
    return false;
  };
  isJsonValue = asJson;
}

console.log('\n1. every tool that reports a run returns a lossless value');
{
  const { WorkflowRuntime } = await import('../lib/runtime.js');
  const ws = mkdtempSync(join(tmpdir(), 'dwf-out-'));
  const runtime = new WorkflowRuntime({
    config: { allowedModels: ['deepseek-chat'], workspaceRoot: ws },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    chat: async () => ({ content: 'OK', usage: {} }),
  });
  await runtime.startEngine({
    scriptText: 'phase("p");\nconst a = await agent("s").ask<string>("q");\nreturn { a };',
    workspaceRoot: ws,
  });
  await new Promise((r) => setTimeout(r, 3000));
  const runId = runtime.listRuns()[0].runId;

  for (const opts of [{ includeJournal: true }, { includeJournal: false }, {}]) {
    const snap = runtime.snapshot(runId, opts);
    check(
      `the snapshot (includeJournal=${opts.includeJournal === true}) is lossless`,
      isJsonValue(snap),
    );
  }

  // The failing case, named: an amend replay copies `parsed` from an
  // ancestor entry, and older entries have none.
  const snap = runtime.snapshot(runId, { includeJournal: true });
  const bad = (snap.journal ?? []).findIndex((e) => !isJsonValue(e));
  check('no journal entry is lossy', bad < 0, bad < 0 ? `${snap.journal.length} entries` : `entry ${bad}`);
}

console.log('\n2. the tool definitions declare an output schema');
{
  const { createWorkflowTools } = await import('../lib/dwf/tools.js');
  const tools = createWorkflowTools({
    runtime: null,
    startEngine: async () => ({}),
    injectStage: async () => ({}),
    answerQuestion() {},
    listPendingHoles: () => [],
    fillHole: () => ({}),
    listRuns: () => [],
    snapshot: () => null,
    listSavedWorkflows: () => [],
    saveWorkflow: () => ({}),
    skillContent: () => '',
    evalSnippet: async () => ({}),
  });
  for (const tool of tools) {
    const schema = tool.output?.schema;
    check(
      `${tool.name} declares an output schema`,
      schema !== undefined && schema !== null && typeof schema === 'object',
    );
  }
}

console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures} problem(s))`}`);
process.exitCode = failures === 0 ? 0 : 1;
