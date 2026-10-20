#!/usr/bin/env node
/**
 * Regression test for the LEGACY child-process path.
 *
 * v0.13.0 changed the path fence (relative paths now resolve against the
 * workspace root, and symbolic links are resolved before the containment
 * check) and made the model call injectable. Both touch the legacy path, so
 * this checks that it still runs end to end — the script is executed by a
 * real child process, and the model call is stubbed at the host.
 *
 * Usage: node scripts/legacy-smoke.mjs
 */

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { WorkflowRuntime } from '../lib/runtime.js';

const SCRIPT = `
export default async function main() {
  const { agent, phase, log, report, files } = globalThis.__dsh;
  phase('scan');
  const findings = await agent('scanner', { system: 'You find things.' }).ask('Find things.');
  const notes = await files.read('NOTES.md');
  report({ findings });
  log('scanned');
  return { findings, notes };
}
`;

let failures = 0;
function check(label, ok, detail) {
  if (!ok) failures += 1;
  process.stdout.write(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail === undefined ? '' : ` — ${detail}`}\n`);
}

async function main() {
  const root = mkdtempSync(join(tmpdir(), 'dwf-legacy-'));
  const scriptPath = join(root, 'workflow.mjs');
  writeFileSync(scriptPath, SCRIPT);
  writeFileSync(join(root, 'NOTES.md'), 'notes inside the workspace\n');

  const runtime = new WorkflowRuntime({
    chat: async () => ({
      content: 'stub findings',
      usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      raw: {},
    }),
    persistDir: join(root, 'runs'),
  });

  process.stdout.write('\nthe legacy child-process path\n');
  const { runId } = await runtime.start({ scriptPath, workspaceRoot: root });

  // The run settles asynchronously; poll for it.
  let state = null;
  for (let i = 0; i < 100; i += 1) {
    state = runtime.runs.get(runId);
    if (state && (state.status === 'completed' || state.status === 'error' || state.status === 'stopped')) break;
    await new Promise((r) => setTimeout(r, 100));
  }

  check('the run settles', state?.status === 'completed', `status=${state?.status} exit=${state?.exitCode}`);
  check('the phase is recorded', (state?.phases || []).some((p) => p.name === 'scan'),
    JSON.stringify(state?.phases));
  check('the agent is recorded', (state?.agentsOrder || []).includes('scanner'),
    JSON.stringify(state?.agentsOrder));
  check('the report is recorded', (state?.reports || []).length === 1,
    JSON.stringify(state?.reports?.length));
  check('the world read is journaled', (state?.journal || []).some((e) => e.kind === 'files.read'),
    JSON.stringify(state?.journal?.map((e) => e.kind)));

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
