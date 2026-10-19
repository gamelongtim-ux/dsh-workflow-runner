// dsh-workflow-runner sample —— hole<T>() mid-run code injection
//
// The script parks on a hole, the user (or main agent) fills a body
// string, the body is eval'd as an AsyncFunction with `ctx` (the third
// arg) as the only parameter, and the result is what `await hole()`
// resolves to.
//
// Run:  POST /api/run { scriptPath }
// Then: POST /api/hole-answer { runId, holeId, body: '({plan,threshold}) => plan.steps.slice(0,threshold)' }
//
// This sample can be tested end-to-end without an LLM key.
'use strict';
const { phase, log, report, artifact, hole, askUser } = globalThis.__dsh;

export default async function main() {

phase('Build some context that the body needs to consume');
const plan = {
  steps: ['gather requirements', 'design API', 'implement', 'test', 'ship'],
  risks: ['scope creep', 'integration bugs'],
};
const threshold = await askUser('How many steps should the body return?', { options: ['2', '3', '5'] });
log(`user picked threshold=${threshold}`);

phase('Park on a hole — the body will run later');
// Pass `ctx` so the body has access to our locals. The body is a string
// the user provides; we eval it as `async (ctx) => { ... }`.
const result = await hole('pick-steps', 'Decide which steps survive the cut.', { plan, threshold });
log(`hole result: ${JSON.stringify(result)}`);

phase('Publish a markdown report of what came out of the hole');
const md = [
  '# Hole demo',
  '',
  `* Threshold picked: ${threshold}`,
  `* Steps total: ${plan.steps.length}`,
  `* Steps returned by hole: ${Array.isArray(result) ? result.length : 'not-an-array'}`,
  '',
  '## Returned by the hole body',
  '',
  ...(Array.isArray(result) ? result.map((s, i) => `${i + 1}. ${s}`) : [String(result)]),
  '',
].join('\n');
await artifact.markdown('report', md, { title: 'Hole demo report', primary: true });

phase('Done');
return {
  threshold,
  stepsTotal: plan.steps.length,
  resultKind: Array.isArray(result) ? 'array' : typeof result,
  result,
};
}
