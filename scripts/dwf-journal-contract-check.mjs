/**
 * Run upstream's `JournalStorePort` contract suite against dsh's durable
 * journal.
 *
 * The suite is vendored for exactly this purpose — the vendored
 * `tsconfig.runtime.json` says: "it is meant to be run against OUR journal
 * implementation".
 *
 * The suite is TypeScript and imports vitest, so it is compiled into a temp
 * directory and run with vitest from there. Nothing is written into the
 * repository.
 *
 * Usage: node scripts/dwf-journal-contract-check.mjs
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');

let failures = 0;
function check(label, ok, detail = '') {
  if (!ok) failures += 1;
  process.stdout.write(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? `  — ${detail}` : ''}\n`);
}

const work = mkdtempSync(join(tmpdir(), 'dwf-contract-'));

console.log('\n1. compiling the vendored engine + upstream\'s contract suite');
const tsc = join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc');
const compile = spawnSync(process.execPath, [
  tsc,
  '-p', join(repoRoot, 'packages', 'dynamic-workflow', 'tsconfig.json'),
  '--outDir', work,
  '--declaration', 'false',
  '--declarationMap', 'false',
], {
  encoding: 'utf8',
  cwd: join(repoRoot, 'packages', 'dynamic-workflow'),
});
check('the engine and the suite compile', compile.status === 0,
  compile.status === 0 ? '' : ((compile.stdout || '') + (compile.stderr || '')).split('\n').slice(0, 6).join(' | '));
if (compile.status !== 0) {
  process.exit(1);
}
check('the contract suite was emitted', existsSync(join(work, 'testing', 'journal-contract.js')));

console.log('\n2. running the suite against dsh\'s durable journal');
// The suite imports "vitest" by bare specifier, so it must resolve from a
// directory that has vitest in its node_modules. The temp dir does not, so
// a `node_modules` symlink is created pointing at the repo's — then the
// suite's own `import { it } from "vitest"` resolves.
try {
  const link = join(work, 'node_modules');
  if (!existsSync(link)) {
    // Windows needs the junction/symlink privilege; a directory junction
    // works without it, and a symlink to a directory does too.
    const { symlinkSync } = await import('node:fs');
    symlinkSync(join(repoRoot, 'node_modules'), link, 'junction');
  }
} catch (err) {
  check('the temp dir can see vitest', false, String(err && err.message || err));
}

const testFile = join(work, 'contract.test.js');
writeFileSync(testFile, `
import { runJournalStoreContract } from './testing/journal-contract.js';
import { DurableJournalStore } from ${JSON.stringify(pathToFileURL(join(repoRoot, 'lib', 'dwf', 'durable-journal.js')).href)};

runJournalStoreContract(() => new DurableJournalStore({ enabled: false }));
`);

const run = spawnSync(process.execPath, [
  join(repoRoot, 'node_modules', 'vitest', 'vitest.mjs'),
  'run', '--root', work,
], { encoding: 'utf8', cwd: repoRoot });

const output = (run.stdout || '') + (run.stderr || '');
// vitest prints "Tests  83 passed (83)" and "Test Files  1 passed (1)".
// The test count is the one on the `Tests` line.
const testsLine = /^\s*Tests\s+(.*)$/m.exec(output);
const passedCount = testsLine
  ? Number(/(\d+)\s+passed/.exec(testsLine[1])?.[1] ?? 0)
  : 0;
const failedCount = testsLine
  ? Number(/(\d+)\s+failed/.exec(testsLine[1])?.[1] ?? 0)
  : 0;
check('the contract suite passes against the durable journal',
  run.status === 0 && failedCount === 0,
  run.status === 0
    ? `${passedCount} tests passed`
    : output.split('\n').filter((l) => /FAIL|✕|Error/.test(l)).slice(0, 4).join(' | '));
check('the whole upstream suite ran', passedCount >= 83, `${passedCount} of 83`);
if (run.status !== 0 || passedCount < 83) {
  process.stdout.write(output.split('\n').slice(-40).join('\n'));
}

console.log('\n3. the durable journal\'s persistence works across a store');
{
  // The contract suite runs with persistence OFF (it is about semantics).
  // This checks the persistence itself: rows written by one store are read
  // back by a NEW store over the same directory.
  const dir = mkdtempSync(join(tmpdir(), 'dwf-durable-'));
  const { DurableJournalStore } = await import(pathToFileURL(join(repoRoot, 'lib', 'dwf', 'durable-journal.js')).href);
  const first = new DurableJournalStore({ dir });
  first.createRun({ runId: 'r1', caps: { maxConcurrency: 4 }, spentTokens: 0, status: 'running' });
  first.putActor({ runId: 'r1', siteId: 'actor#1', ordinal: 1, name: 'scout', sessionId: 's1' });
  first.putNode({
    runId: 'r1', siteId: 'ask#1', ordinal: 1, kind: 'ask',
    actorSiteId: 'actor#1', actorOrdinal: 1, actorSeq: 0,
    inputHash: 'h1', status: 'completed', result: { answer: 'x' }, messageBoundary: 3,
  });
  first.appendEvent('r1', { type: 'log', message: 'hello' });
  // The write-through is debounced; flush so the rows are on disk.
  first.flush('r1');

  const second = new DurableJournalStore({ dir });
  const run = second.getRun('r1');
  check('the run row survived', run?.runId === 'r1' && run?.status === 'running');
  const actors = second.listActors('r1', { withPersona: true });
  check('the actor row survived', actors.length === 1 && actors[0].name === 'scout');
  const nodes = second.listNodes('r1', { kinds: 'all', withResult: true });
  check('the node row survived', nodes.length === 1 && nodes[0].messageBoundary === 3,
    `nodes=${JSON.stringify(nodes.map((n) => ({ s: n.siteId, mb: n.messageBoundary })))}`);
  const events = second.listEvents('r1', { types: 'all', reportItems: 'all' });
  check('the event survived', events.length === 1 && events[0].event.message === 'hello');
  check('the persisted run is listed', second.listPersistedRuns().includes('r1'),
    JSON.stringify(second.listPersistedRuns()));
  rmSync(dir, { recursive: true, force: true });
}

console.log('\n4. the write-through is debounced, and an explicit flush writes now');
{
  const dir = mkdtempSync(join(tmpdir(), 'dwf-durable-flush-'));
  const { DurableJournalStore } = await import(pathToFileURL(join(repoRoot, 'lib', 'dwf', 'durable-journal.js')).href);
  const store = new DurableJournalStore({ dir });
  store.createRun({ runId: 'r1', caps: { maxConcurrency: 4 }, spentTokens: 0, status: 'running' });
  store.appendEvent('r1', { type: 'log', message: 'hello' });

  // The write-through is debounced, so the rows are not on disk yet.
  const early = new DurableJournalStore({ dir });
  check('the rows are not on disk yet', early.getRun('r1') === undefined);

  // An explicit flush writes them.
  store.flush('r1');
  const after = new DurableJournalStore({ dir });
  check('an explicit flush makes them readable', after.getRun('r1') !== undefined);
  check('the event is readable too',
    after.listEvents('r1', { types: 'all', reportItems: 'all' }).length === 1);

  // The debounce also writes them without an explicit flush.
  const dir2 = mkdtempSync(join(tmpdir(), 'dwf-durable-debounce-'));
  const store2 = new DurableJournalStore({ dir: dir2, flushDelayMs: 20 });
  store2.createRun({ runId: 'r2', caps: { maxConcurrency: 4 }, spentTokens: 0, status: 'running' });
  await new Promise((r) => setTimeout(r, 120));
  const later = new DurableJournalStore({ dir: dir2 });
  check('the debounce writes them on its own', later.getRun('r2') !== undefined);

  rmSync(dir, { recursive: true, force: true });
  rmSync(dir2, { recursive: true, force: true });
}

rmSync(work, { recursive: true, force: true });
console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures} problem(s))`}`);
process.exit(failures === 0 ? 0 : 1);
