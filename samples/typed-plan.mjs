// dsh-workflow-runner sample —— ask<T> 类型化结果演示
//
// 跟 v0.2.0 的 artifact-demo.mjs 类似,但 ask() 直接返结构化对象(不再
// 是 `{content, usage}` 字符串),plan.steps[0] / plan.risks[1] 这种字段
// 访问直接可用,不用自己 JSON.parse。
//
// 跑法:编辑器里点 Run。需要 LLM key。
//
'use strict';
const { agent, phase, log, report, artifact } = globalThis.__dsh;

export default async function main() {

phase('Plan a typed response from the planner agent');
const plan = await agent('planner', {
  system: 'You are a senior algorithm textbook author. You plan articles, not write them.',
}).ask(
  'Plan a 3-paragraph explanation of the Hungarian algorithm for assignment problems. Be precise and avoid filler.',
  {
    result: {
      title: 'one-line plan title',
      paragraphs: ['each paragraph as a separate string'],
      steps: ['each step'],
      risks: ['each risk or open question'],
      needsReview: false,
    },
  },
);

log(`got typed plan: ${plan.title} (${plan.paragraphs.length} paragraphs, ${plan.steps.length} steps)`);
log(`plan.paragraphs[0] (first 120 chars): ${plan.paragraphs[0].slice(0, 120)}`);

phase('Declare a table artifact for the plan steps');
artifact.table('steps', {
  title: 'Plan steps',
  columns: [
    { field: 'index', label: '#' },
    { field: 'step', label: 'Step' },
  ],
});
plan.steps.forEach((step, i) => report({ index: i + 1, step }, 'steps'));

phase('Publish a markdown report');
const md = [
  `# ${plan.title}`,
  '',
  `* Paragraphs: ${plan.paragraphs.length}`,
  `* Steps: ${plan.steps.length}`,
  `* Risks: ${plan.risks.length}`,
  `* needsReview: ${plan.needsReview}`,
  '',
  '## Paragraphs',
  '',
  ...plan.paragraphs.map((p, i) => `### ${i + 1}\n\n${p}`),
  '',
  '## Steps',
  '',
  ...plan.steps.map((s, i) => `${i + 1}. ${s}`),
  '',
  '## Risks',
  '',
  ...plan.risks.map((r) => `- ${r}`),
  '',
].join('\n');
await artifact.markdown('report', md, { title: plan.title, primary: true });

phase('Done');
return {
  title: plan.title,
  paragraphCount: plan.paragraphs.length,
  stepCount: plan.steps.length,
  needsReview: plan.needsReview,
};
}
