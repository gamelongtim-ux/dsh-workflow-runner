// dsh-workflow-runner sample —— amend cache reuse, no LLM required.
//
// Everything here uses `world.run` + `agent`-free helpers, so you can
// exercise the whole v0.11.0 amend lifecycle without an API key.
//
// The two-run recipe:
//
//   1. POST /api/run { scriptPath: <this file> }          → runId A
//      wait for A to finish. 3 shell calls, all `live: true`.
//
//   2. EDIT this file — the marker line below carries a counter.
//      Change `MARKER` from 'v1' to 'v2'. Any byte change counts;
//      the runtime compares a SHA-256 of the file.
//
//   3. POST /api/run { scriptPath: <this file>, amendFrom: A }
//                                                       → runId B
//      B's log shows:
//        amend from A: chain depth 1, source journal has 3 entries
//                        — cache OPEN until this run's first live action
//        world.run(...): amend replay from A        ×2
//        world.run(...): <no replay>                 ×1   ← marker changed
//        amend cache closed (this run executed a live action)
//
//      B's journal shows the split: 2 entries with
//      `live: false, fromRun: A`, and 1 with `live: true`.
//
//   4. Re-run step 3 WITHOUT editing again → HTTP 400
//      `AMEND_NO_CHANGE`. That is deliberate: replaying a byte-identical
//      script costs a full run and buys nothing.
//
// `GET /api/journal?runId=B` renders the trail the editor panel shows.
'use strict';
const { phase, log, report, world } = globalThis.__dsh;

// --- edit me between run 1 and run 2 ---------------------------------------
const MARKER = 'v3';
// ---------------------------------------------------------------------------

export default async function main() {
  phase('Stage 1 · echo');
  const a = await world.run('node', ['-e', 'process.stdout.write("one")'], { timeoutMs: 5000 });
  report({ marker: MARKER, stage: 1, stdout: a.stdout }, 'stages');

  phase('Stage 2 · echo (unchanged between runs)');
  const b = await world.run('node', ['-e', 'process.stdout.write("two")'], { timeoutMs: 5000 });
  report({ marker: MARKER, stage: 2, stdout: b.stdout }, 'stages');

  phase('Stage 3 · marker (this is the one you edit)');
  const c = await world.run('node', ['-e', 'process.stdout.write(process.argv[1])', MARKER], { timeoutMs: 5000 });
  report({ marker: MARKER, stage: 3, stdout: c.stdout }, 'stages');

  phase('Done');
  log(`amend-structure finished with marker=${MARKER}`);
  return { marker: MARKER, outs: [a.stdout, b.stdout, c.stdout] };
}
