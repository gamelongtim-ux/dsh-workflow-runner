#!/usr/bin/env node
/**
 * End-to-end test of the ZCode Dynamic Workflow engine path inside dsh's
 * own runtime.
 *
 * Unlike scripts/dwf-smoke.mjs (which drives the vendored engine directly),
 * this one goes through lib/runtime.js: the run is registered in the same
 * runs map, the same state shape, the same journal and the same broadcast
 * path as the legacy child-process runs. The model call is stubbed, so the
 * test needs no network and no API key.
 *
 * It also checks the sandbox: a path that escapes the workspace, and a
 * symlink that points out of it, must both be refused.
 *
 * Usage: node scripts/dwf-runtime-smoke.mjs
 */

import { mkdtempSync, writeFileSync, symlinkSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { WorkflowRuntime } from '../lib/runtime.js';

const WORKING = `
interface Plan {
  title: string;
  steps: string[];
}

phase("plan");

const plan = await agent("planner", { system: "You plan fixes." }).ask<Plan>("Plan it.");
const notes = await files.read("NOTES.md");

report({ plan, count: notes.length });

return { plan, notes };
`;

const ESCAPE = `
const leaked = await files.read("../../outside.txt");
return { leaked };
`;

const SYMLINK = `
const leaked = await files.read("link.txt");
return { leaked };
`;

let failures = 0;
function check(label, ok, detail) {
  const mark = ok ? 'PASS' : 'FAIL';
  if (!ok) failures += 1;
  process.stdout.write(`  [${mark}] ${label}${detail === undefined ? '' : ` — ${detail}`}\n`);
}

/** A stub model that answers the two asks above and nothing else. */
function stubChat({ messages }) {
  const user = messages.filter((m) => m.role === 'user').map((m) => m.content).join('\n');
  let content;
  if (user.includes('Plan it.')) {
    content = JSON.stringify({ title: 'Seed the clock', steps: ['freeze time', 're-run'] });
  } else {
    content = 'stub';
  }
  return {
    content,
    usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
    raw: {},
  };
}

async function main() {
  const root = mkdtempSync(join(tmpdir(), 'dwf-rt-'));
  const workspace = join(root, 'workspace');
  const outside = join(root, 'outside.txt');
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, 'NOTES.md'), 'notes inside the workspace\n');
  writeFileSync(outside, 'secret outside the workspace\n');
  try {
    symlinkSync(outside, join(workspace, 'link.txt'));
  } catch (_) {
    process.stdout.write('  (symlink unavailable on this filesystem — that case is skipped)\n');
  }

  const runtime = new WorkflowRuntime({
    chat: stubChat,
    persistDir: join(root, 'runs'),
  });

  // ——— 1. a workflow that completes ———
  process.stdout.write('\n1. a workflow on the engine path\n');
  const { runId, status, settlement } = await runtime.startEngine({
    scriptText: WORKING,
    workspaceRoot: workspace,
    name: 'working.dwf.ts',
  });
  check('run reaches the engine path', Boolean(runtime.runs.get(runId)?._engine), `run ${runId}`);
  check('the run completes', status === 'completed', `status=${status} ${settlement?.error ? JSON.stringify(settlement.error) : ''}`);
  check('the artifact is the script\'s return value',
    settlement?.artifact?.plan?.title === 'Seed the clock',
    JSON.stringify(settlement?.artifact));

  const snap = runtime.snapshot(runId);
  check('the phase is recorded', (snap?.phases || []).some((p) => p.name === 'plan'),
    JSON.stringify(snap?.phases));
  check('the agent is recorded', (snap?.agents || []).some((a) => a.name === 'planner'),
    JSON.stringify((snap?.agents || []).map((a) => a.name)));
  check('the report is recorded', (snap?.reports || []).length === 1,
    JSON.stringify(snap?.reports?.map((r) => r.tag)));
  const withJournal = runtime.snapshot(runId, { includeJournal: true });
  check('the world read is journaled',
    (withJournal?.journal || []).some((e) => e.kind === 'files.read'),
    JSON.stringify((withJournal?.journal || []).map((e) => e.kind)));
  const graphs = runtime.runs.get(runId)?._engine?.graphs;
  check('the four graphs are present',
    Boolean(graphs?.site) && Boolean(graphs?.causality)
      && Boolean(graphs?.controlFlow) && Boolean(graphs?.handoff),
    JSON.stringify(graphs?.sizes));

  // ——— 2. the sandbox refuses an escape ———
  process.stdout.write('\n2. the sandbox\n');
  const escape = await runtime.startEngine({
    scriptText: ESCAPE,
    workspaceRoot: workspace,
    name: 'escape.dwf.ts',
  });
  check('a path outside the workspace is refused',
    escape.status === 'error' || escape.status === 'stopped',
    `status=${escape.status}`);
  const escapeError = escape.settlement?.error?.message || String(escape.settlement?.error || '');
  check('the refusal names the workspace', /outside workspaceRoot|escapes workspaceRoot/.test(escapeError),
    escapeError.slice(0, 140));

  // ——— 3. the sandbox refuses a symlink out ———
  process.stdout.write('\n3. a symlink pointing out of the workspace\n');
  const link = await runtime.startEngine({
    scriptText: SYMLINK,
    workspaceRoot: workspace,
    name: 'symlink.dwf.ts',
  });
  check('the symlinked file is refused',
    link.status === 'error' || link.status === 'stopped',
    `status=${link.status}`);
  const linkError = link.settlement?.error?.message || String(link.settlement?.error || '');
  check('the refusal names the symbolic link', /symbolic link|outside workspaceRoot/.test(linkError),
    linkError.slice(0, 140));

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
