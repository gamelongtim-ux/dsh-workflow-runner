// dsh-workflow-runner sample —— route() multi-model routing helper (v0.6.0)
//
// `route(MODELS, routerFn, answererFn)` is the v0.6.0 sugar around the
// pattern in `samples/model-router.mjs`. The script defines a router
// function (decides "light" vs "strong" from the question) and an
// answerer function (uses the chosen model). `route()` wires them up.
//
// In a real workflow with both deepseek-chat and deepseek-reasoner
// allowed, this lets a cheap model filter questions and a strong one
// answer them. With only one model allowed (default config), this is
// a "shape demo" of the pattern.
'use strict';
const { agent, phase, log, report, artifact, model, route, t, shape } = globalThis.__dsh;

export default async function main() {

phase('Set up MODELS table (both tiers point at deepseek-chat in this env)');
const MODELS = {
  light: model('deepseek-chat'),
  strong: model('deepseek-chat'),
};

const questions = [
  'Rename the config key in the README from "limit" to "maxRows".',
  'Explain the retry design with exponential backoff and jitter.',
];

phase('Run each question through route()');
const rows = [];
for (let i = 0; i < questions.length; i++) {
  const q = questions[i];
  log(`routing Q${i + 1}: ${q}`);

  // The router returns a typed {tier} object; the answerer returns the
  // actual response. `route()` parses the router's tier and dispatches
  // the answerer with the matching ModelRef.
  const answer = await route(MODELS,
    (m) => agent(`router-${i + 1}`, { model: m }).ask(
      `Classify this question as "light" (simple rename) or "strong" (needs explanation).\n` +
      `Reply with JSON {"tier": "light" | "strong"} only.\n\nQuestion: ${q}`,
      { result: shape({ tier: t.string }) }
    ),
    (m) => agent(`answerer-${i + 1}`, { model: m }).ask(q),
  );

  // Normalize answer to string (ask() returns typed object in v0.4+)
  const text = typeof answer === 'string' ? answer : (answer && answer.content) || '';
  log(`Q${i + 1} answered (${text.length} chars)`);
  rows.push({ index: i + 1, question: q, answerLen: text.length, preview: text.slice(0, 80) });
}

phase('Publish a markdown report');
artifact.table('replies', {
  title: 'Replies by tier',
  columns: [
    { field: 'index', label: '#' },
    { field: 'question', label: 'Question' },
    { field: 'answerLen', label: 'Chars' },
  ],
});
for (const r of rows) report(r, 'replies');

const md = [
  '# route() demo',
  '',
  `* ${rows.length} questions routed through light/strong`,
  ...rows.map((r) => `* Q${r.index}: ${r.answerLen} chars — ${r.preview}…`),
  '',
].join('\n');
await artifact.markdown('report', md, { title: 'route() demo', primary: true });

phase('Done');
return { rows };
}
