// dsh-workflow-runner sample —— AmendWorkflow cache reuse
//
// This sample shows the amend-cache flow end-to-end. It's designed to be
// run twice: the second time you POST /api/run with `amendFrom` pointing
// to the first runId. Identical (name, prompt) calls return cached
// results without re-running the LLM.
//
// IMPORTANT (v0.11.0): amend is now rejected with HTTP 400
// `AMEND_NO_CHANGE` if the script file is byte-identical to the run you
// are amending — replaying an unchanged script burns a full run and
// buys nothing. So the second run REQUIRES an edit. Bump PROMPT_VERSION
// between the two runs; that changes the file and also invalidates one
// cache key, which is the more interesting shape anyway.
//
// To exercise this in a smoke test:
//   1) POST /api/run { scriptPath: <this> }            → get runId A
//   2) wait for A to complete
//   3) edit PROMPT_VERSION below (v1 → v2)
//   4) POST /api/run { scriptPath: <this>, amendFrom: runIdA }
//                                                       → runId B
//   5) inspect B's log: two asks should show "amend replay from <A>";
//      the ask whose prompt you changed runs live.
//
// Note the replayed asks still REBUILD THE AGENT'S CHAT HISTORY —
// see CHANGELOG v0.11.0. Without that, a live ask later in the run
// would silently answer against a blank context.
//
// Needs an LLM key to be useful; with a keyless env the script errors on
// the first LLM call and amend is moot.
'use strict';
const { agent, phase, log, report, artifact } = globalThis.__dsh;

// --- edit me between run 1 and run 2 (v1 → v2) ------------------------------
const PROMPT_VERSION = 'v1';
// ---------------------------------------------------------------------------

export default async function main() {

phase('Single-ask intro');
const intro = await agent('planner', { system: 'You are concise.' })
  .ask(`Reply with exactly: ok`);
log(`intro: ${typeof intro === 'string' ? intro : (intro && intro.content) || ''}`);

phase('Three numbered asks (this is what amend will cache)');
const a = await agent('planner').ask(`Reply with exactly the letter A and nothing else. [${PROMPT_VERSION}]`);
const b = await agent('planner').ask('Reply with exactly the letter B and nothing else.');
const c = await agent('planner').ask('Reply with exactly the letter C and nothing else.');
log(`a=${norm(a)} b=${norm(b)} c=${norm(c)}`);

phase('Publish a summary');
const md = [
  '# Amend demo',
  '',
  `* intro: ${norm(intro)}`,
  `* a: ${norm(a)}`,
  `* b: ${norm(b)}`,
  `* c: ${norm(c)}`,
  '',
  '## How amend reuses this',
  '',
  'Re-run with the same (name, prompt) and `amendFrom=<previousRunId>`.',
  'The host returns the cached result for each `agent.ask`; no LLM call.',
  '',
].join('\n');
await artifact.markdown('report', md, { title: 'Amend demo', primary: true });

phase('Done');
return { a: norm(a), b: norm(b), c: norm(c) };
}

function norm(v) {
  return typeof v === 'string' ? v : (v && v.content) || '';
}
