#!/usr/bin/env node
/**
 * Test the model-facing surface: the tools and the gate.
 *
 * The tools are what turn this plugin from "something the user drives" into
 * "something the model drives". The gate is the point of the brief tool: a
 * model that has not read the authoring contract cannot hand a script to the
 * engine.
 *
 * The tools are driven here the way the host drives them — a plain definition
 * with an `execute(args, exec)` — so this is the real contract, not a mock of
 * it.
 *
 * Usage: node scripts/dwf-tools-smoke.mjs
 */

import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createWorkflowTools } from '../lib/dwf/tools.js';
import { WorkflowRuntime } from '../lib/runtime.js';

let failures = 0;
function check(label, ok, detail) {
  if (!ok) failures += 1;
  process.stdout.write(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail === undefined ? '' : ` — ${detail}`}\n`);
}

const SKILL = `# Writing Dynamic Workflows\n\nThe facade, the rules, the anti-patterns.\n`;

async function main() {
  const root = mkdtempSync(join(tmpdir(), 'dwf-tools-'));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace, { recursive: true });

  const runtime = new WorkflowRuntime({
    chat: async () => ({ content: 'stub', usage: {}, raw: {} }),
    persistDir: join(root, 'runs'),
  });

  const tools = createWorkflowTools({
    runtime,
    startEngine: (opts) => runtime.startEngine(opts),
    injectStage: (runId, opts) => runtime.injectStage(runId, opts),
    answerQuestion: (runId, questionId, answer) => runtime.answerQuestion(runId, questionId, answer),
    listPendingHoles: (runId) => runtime.listPendingHoles(runId),
    fillHole: (runId, holeId, body) => runtime.fillHole(runId, holeId, body),
    listRuns: () => runtime.listRuns(),
    snapshot: (runId, opts) => runtime.snapshot(runId, opts),
    listSavedWorkflows: async () => [],
    saveWorkflow: async (name, spec) => ({ name, path: `/tmp/${name}.mjs`, scope: spec.scope }),
    skillContent: () => SKILL,
    evalSnippet: async () => ({ ok: true, value: 'snippet' }),
    readWorkspaceFile: async () => 'phase("x");\nreturn 1;',
    defaultWorkspaceRoot: workspace,
  });

  process.stdout.write('\nthe model-facing tools\n');
  const names = tools.map((t) => t.name).sort();
  check('the tool set is complete', names.length === 11, names.join(', '));
  check('every tool has a description', tools.every((t) => typeof t.description === 'string' && t.description.length > 20));
  check('every tool has an output schema', tools.every((t) => t.output && t.output.schema && typeof t.output.render === 'function'));

  const byName = new Map(tools.map((t) => [t.name, t]));
  const create = byName.get('create_workflow');
  const brief = byName.get('dynamic_workflows_brief');

  // ——— the gate ———
  process.stdout.write('\nthe gate\n');
  const agent = {};
  let refused = null;
  try {
    await create.execute({ script: 'phase("x");\nreturn 1;' }, { agent });
  } catch (err) {
    refused = err;
  }
  check('a workflow is refused before the brief is read', refused !== null,
    refused ? refused.message.slice(0, 60) : 'it was accepted');
  check('the refusal names the brief tool', refused && refused.message.includes('dynamic_workflows_brief'));

  const briefText = await brief.execute({}, { agent });
  check('the brief returns the contract', String(briefText).includes('Dynamic Workflows'));

  const started = await create.execute(
    { script: 'phase("x");\nconst v = await agent("a").ask<string>("hi");\nreturn v;' },
    { agent },
  );
  check('the workflow runs once the brief is read', started.status === 'starting', `status=${started.status}`);
  check('the run has an id', typeof started.run_id === 'string' && started.run_id.length > 0, started.run_id);
  check('no diagnostics for a sound script', (started.diagnostics || []).length === 0,
    JSON.stringify(started.diagnostics));
  check('the analysis graphs come back', started.graphs && started.graphs.site !== undefined,
    JSON.stringify(started.graphs && started.graphs.sizes));

  // A different agent has not read the brief.
  const other = {};
  let refused2 = null;
  try {
    await create.execute({ script: 'phase("x");\nreturn 1;' }, { agent: other });
  } catch (err) {
    refused2 = err;
  }
  check('the gate is per agent, not global', refused2 !== null);

  // ——— a broken script is a report ———
  process.stdout.write('\na broken script\n');
  const broken = await create.execute(
    { script: 'const x: number = "nope";\nreturn x;' },
    { agent },
  );
  check('a broken script comes back as diagnostics, not a run', broken.status === 'error', broken.status);
  check('the diagnostics are there', (broken.diagnostics || []).length > 0,
    JSON.stringify((broken.diagnostics || []).map((d) => d.code)));

  // ——— the other tools ———
  process.stdout.write('\nthe other tools\n');
  const runs = await byName.get('list_workflow_runs').execute({}, { agent });
  check('list_workflow_runs answers', Array.isArray(runs), String(Array.isArray(runs)));

  const snap = await byName.get('get_workflow_run').execute({ run_id: started.run_id }, { agent });
  check('get_workflow_run answers', snap && snap.runId === started.run_id, snap && snap.runId);

  const saved = await byName.get('save_workflow').execute(
    { name: 'demo', description: 'a demo', script: 'phase("x");\nreturn 1;', scope: 'global' },
    { agent },
  );
  check('save_workflow answers', saved.name === 'demo' && saved.scope === 'global', JSON.stringify(saved));

  const listed = await byName.get('list_saved_workflows').execute({}, { agent });
  check('list_saved_workflows answers', Array.isArray(listed));

  const snippet = await byName.get('eval_workflow_snippet').execute({ code: 'return 1;' }, { agent });
  check('eval_workflow_snippet answers', snippet && snippet.ok === true, JSON.stringify(snippet));

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
