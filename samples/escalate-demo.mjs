// dsh-workflow-runner sample —— escalate() with Think via LLM (v0.6.0)
//
// `escalate(question, opts)` is the v0.6.0 "ask the main agent" facade.
// Same parked-RPC shape as askUser, but the editor offers a
// "Think via LLM" button that triggers the host to dispatch an LLM
// call (with the run's recent log + question as context) and use the
// LLM's response as the answer.
//
// Smoke test:
//   1) POST /api/run with this script
//   2) Read the pendingEscalates via /api/state
//   3) Two options:
//      a) POST /api/escalate-answer { runId, escalateId, answer: 'A' }
//         → direct user answer
//      b) POST /api/escalate-think { runId, escalateId }
//         → host dispatches LLM, answer comes from there
//
// Needs an LLM key for the Think-via-LLM path; without it, the direct
// answer still works.
'use strict';
const { phase, log, report, artifact, escalate } = globalThis.__dsh;

export default async function main() {

phase('First escalate: three options, user picks or Think-via-LLM');
const tier = await escalate('Which quality tier should we ship at?', {
  options: ['fast', 'balanced', 'thorough'],
});
log(`tier answer: ${JSON.stringify(tier)}`);

phase('Second escalate: confirm with LLM dispatch path');
const proceed = await escalate(`Tier "${tier}" chosen. Proceed with this?`, {
  kind: 'confirm',
});
log(`confirm answer: ${JSON.stringify(proceed)}`);

if (!proceed) {
  phase('User declined — exit early');
  return { tier, proceed, early: true };
}

phase('Third escalate: free-text, no options');
const note = await escalate('Any extra note for the report? (empty to skip)');
log(`note answer: ${JSON.stringify(note)}`);

phase('Publish a markdown report of the answers');
const md = [
  '# Escalate demo',
  '',
  `* Tier: \`${tier}\``,
  `* Confirmed: ${proceed}`,
  `* Note: ${note && note.length > 0 ? note : '_(none)_'}`,
  '',
  'The answers above came from one of three sources:',
  '1. User typed a direct answer (`/api/escalate-answer`)',
  '2. User clicked "Think via LLM" (`/api/escalate-think` → LLM dispatch)',
  '3. Default (host auto-dispatch after timeout — not enabled in v0.6.0)',
  '',
].join('\n');
await artifact.markdown('report', md, { title: 'Escalate demo', primary: true });

phase('Done');
return { tier, proceed, note };
}
