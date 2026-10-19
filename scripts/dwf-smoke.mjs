#!/usr/bin/env node
/**
 * End-to-end smoke test for the Dynamic Workflow port.
 *
 * Runs a real workflow through the vendored ZCode engine and harness, with a
 * stub model and a stub world, and prints what came out. No network, no LLM,
 * no dsh host — the point is to prove that the whole chain is wired:
 *
 *   script -> compile -> analyse (4 graphs) -> lower (site ids) -> schemas
 *          -> engine -> harness -> child process -> vm cell -> NDJSON bridge
 *          -> driver -> stub model -> back to the engine -> settlement
 *
 * Usage: node scripts/dwf-smoke.mjs
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runDwfWorkflow, prepareWorkflow, projectWorkflowGraphs } from '../lib/dwf/index.js';
import { InMemoryJournalStore } from '../lib/dwf/engine.js';

const SCRIPT = `
interface Finding {
  /** The test that flaked. */
  testId: string;
  /** 0-1, how confident the scan is */
  confidence: number;
}

interface Plan {
  /** One line describing the fix. */
  title: string;
  /** The steps, in order. */
  steps: string[];
  /** Whether a human should look at this. */
  needsReview: boolean;
}

phase("scan");

const findings = await agent("scanner", { system: "You find flaky tests." }).ask<Finding[]>(
  "Find the flaky tests.",
);

phase("plan");

const plan = await agent("planner", { system: "You plan fixes." }).ask<Plan>(
  "Plan the fix for the flaky tests.",
);

log("scanned " + findings.length + " findings");

const notes = await files.read("NOTES.md");

report({ plan, count: findings.length });

return { plan, count: findings.length, notes };
`;

function banner(text) {
  process.stdout.write(`\n${text}\n${'-'.repeat(text.length)}\n`);
}

async function main() {
  const cwd = mkdtempSync(join(tmpdir(), 'dwf-smoke-'));
  const journal = new InMemoryJournalStore();
  const events = [];

  // A stub model that answers from the schema it is handed. This is enough to
  // exercise the whole typed path: schema synthesis, validation, the submit
  // verdict, and the journal row.
  const answers = {
    'Find the flaky tests.': [
      { testId: 'a.spec.ts', confidence: 0.9 },
      { testId: 'b.spec.ts', confidence: 0.4 },
    ],
    'Plan the fix for the flaky tests.': {
      title: 'Seed the clock',
      steps: ['freeze time', 're-run'],
      needsReview: false,
    },
  };

  const services = {
    async askModel({ instructions, schema }) {
      const hit = Object.entries(answers).find(([k]) => instructions.includes(k));
      const value = hit === undefined ? 'stub' : hit[1];
      if (schema === undefined) {
        return { text: String(value), tokens: 11, toolCalls: 0, turns: 1 };
      }
      return { value, tokens: 11, toolCalls: 0, turns: 1 };
    },
    async worldRead(op, args) {
      if (op === 'read') return `stub-content:${args[0]}`;
      if (op === 'glob') return ['a.spec.ts'];
      if (op === 'grep') return [];
      return null;
    },
    async publishArtifact() {
      throw new Error('this workflow publishes no artifacts');
    },
    emit(event) {
      events.push(event);
    },
    resolveModel() {
      return 'stub/model';
    },
  };

  banner('1. compile-time: analysis, lowering, schemas');
  const prepared = prepareWorkflow(SCRIPT);
  const graphs = projectWorkflowGraphs(prepared);
  process.stdout.write(`ok                : ${prepared.ok}\n`);
  process.stdout.write(`diagnostics       : ${prepared.analysis.diagnostics.length}\n`);
  process.stdout.write(`graphs            : ${JSON.stringify(graphs.sizes)}\n`);
  process.stdout.write(`ask sites        : ${[...prepared.askSpecs.keys()].join(', ')}\n`);
  process.stdout.write(`schemas          : ${Object.keys(prepared.schemas).join(', ')}\n`);
  process.stdout.write('lowered code     :\n');
  for (const line of prepared.lowered.lowered.code.split('\n')) {
    process.stdout.write(`  | ${line}\n`);
  }

  banner('2. end-to-end run');
  const result = await runDwfWorkflow({
    scriptText: SCRIPT,
    runId: 'dwf-smoke-1',
    name: 'smoke',
    journal,
    services,
    cwd,
  });

  const settlement = result.settlement;
  process.stdout.write(`status            : ${settlement.status}\n`);
  process.stdout.write(`error             : ${settlement.error ? JSON.stringify(settlement.error) : '(none)'}\n`);
  process.stdout.write(`artifact          : ${JSON.stringify(settlement.artifact ?? null)}\n`);
  process.stdout.write(`events            : ${events.length}\n`);

  banner('3. journal');
  const run = journal.getRun('dwf-smoke-1');
  process.stdout.write(`run status        : ${run?.status}\n`);
  process.stdout.write(`spent tokens      : ${run?.spentTokens}\n`);
  const nodes = journal.listNodes('dwf-smoke-1', { kinds: 'all', withResult: true });
  for (const node of nodes) {
    process.stdout.write(
      `  ${node.kind.padEnd(12)} ${node.siteId}@${node.ordinal} ${node.status}` +
        `${node.result === undefined ? '' : ` -> ${JSON.stringify(node.result).slice(0, 70)}`}\n`,
    );
  }
  const actors = journal.listActors('dwf-smoke-1', {});
  for (const actor of actors) {
    process.stdout.write(
      `  actor ${actor.siteId}@${actor.ordinal} name=${actor.name} model=${actor.resolvedModel}\n`,
    );
  }

  // The child process may still be releasing its entry file; a locked
  // temp directory is not a test failure.
  try {
    rmSync(cwd, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch {
    process.stdout.write(`(could not remove ${cwd} — Windows file lock, ignoring)\n`);
  }

  banner('result');
  const ok = settlement.status === 'completed';
  process.stdout.write(ok ? 'PASS\n' : 'FAIL\n');
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  process.stderr.write(`smoke test crashed: ${err?.stack ?? err}\n`);
  process.exit(1);
});
