// Structural amend (v0.10.0) — inject a new stage into a RUNNING run.
//
// This workflow deliberately stays alive for a few seconds so the host
// has a window to amend it. Drive it like this:
//
//   POST /api/run      { scriptPath: "<abs path to this file>" }
//   POST /api/amend    { runId, name: "review", wait: true,
//                        code: "async (ctx) => { ... return 'ok'; }" }
//
// The injected stage runs inside THIS process, so it sees the same
// facade the script does — same agents (and their chat history), same
// world.run allowlist, same sandboxed env, same workspace confinement.
//
// Watch it from the script side with `stages.list()` / `stages.await()`.
'use strict';
const { phase, log, report, world } = globalThis.__dsh;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default async function main() {
  phase('Plan');
  const stageNs = globalThis.__dsh.stages;
  log('structural amend: entering the injection window');
  report({ stage: 'waiting', pendingAtStart: stageNs ? stageNs.pending() : 0 }, 'amend');

  // Three short rounds. Each one is a place a host-injected stage can
  // land and interleave with the original plan.
  for (const n of [1, 2, 3]) {
    await sleep(1200);
    phase(`Work ${n}`);
    const wc = await world.run('node', ['-e', 'process.stdout.write("round-" + process.argv[1])', String(n)], {
      timeoutMs: 5000,
    });
    report({ round: n, stdout: wc.stdout, exitCode: wc.exitCode }, 'round');
  }

  phase('Collect');
  // Explicitly join anything the host injected. The bootstrap also
  // drains outstanding stages automatically before `finished` — this
  // call is for workflows that want to read results deterministically.
  if (stageNs) await stageNs.await({ timeoutMs: 15000 });
  const all = stageNs ? await stageNs.list() : [];
  report({
    count: all.length,
    stages: all.map((s) => ({ id: s.id, name: s.name, status: s.status, result: s.result, error: s.error })),
  }, 'stages');

  phase('Done');
  return { ok: true, stages: all.length };
}
