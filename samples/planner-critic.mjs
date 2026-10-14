// dsh-workflow-runner sample —— planner / critic 双轮门控循环
//
// 用户写："Explain what a Hungarian algorithm is and when to use it."
// 流程：
//   phase("Plan")      → planner 给出第一稿
//   report(draft,'draft')
//   phase("Critique")  → critic 列出 3 条最具体的问题
//   report(critique,'critique')
//   phase("Revise")    → planner 同名 agent（保留历史）按 critique 改写
//   report(final,'final')
//   phase("Gate")      → world.run 跑 node -e 把 final 喂回 stdout，作为可读 sanity check
//
// 跑法：node lib/standalone.js 后访问 http://127.0.0.1:7910/api/run {"scriptPath":"...planner-critic.mjs"}
//
'use strict';
const { agent, world, phase, log, report } = globalThis.__dsh;

const TOPIC = 'Explain what a Hungarian algorithm is and when to use it.';

export default async function main() {
  phase('Plan a first draft');
  log('asking planner for the initial draft');
  const draft = await agent('planner', {
    system: 'You are a senior algorithm textbook author. Aim for 3 short paragraphs. Be precise, avoid filler.',
  }).ask(TOPIC);
  report({ title: 'Draft (round 1)', content: draft.slice(0, 4000) }, 'draft');

  phase('Critique the draft');
  log('asking critic for 3 specific issues');
  const criticName = 'critic';
  const critique = await agent(criticName, {
    system: 'You are a sharp technical reviewer. List exactly 3 most important flaws ' +
            'or omissions, each ≤25 words. Be specific. Output as a JSON array: ["...","...","..."].',
  }).ask('Critique:\n' + draft);
  const critiqueJson = (() => {
    const m = critique.match(/\[[^\]]*\]/);
    if (m) try { return JSON.parse(m[0]); } catch (_) {}
    return critique.split(/\n+/).filter(Boolean).slice(0, 3);
  })();
  report({ title: 'Critique', items: critiqueJson }, 'critique');

  phase('Revise per critique');
  const critiqueText = Array.isArray(critiqueJson) ? critiqueJson.join('\n- ') : String(critiqueJson);
  const final = await agent('planner').ask(
    'Revise the previous draft by addressing each critique point:\n- ' + critiqueText + '\nKeep it under 4 short paragraphs.'
  );
  report({ title: 'Revised draft', content: final.slice(0, 4000) }, 'final');

  phase('Gate: shell sanity check');
  log('running world.run: count words in final');
  const wordCount = await world.run('node', ['-e',
    `process.stdout.write(String(${JSON.stringify(final)}.split(/\\s+/).filter(Boolean).length))`,
  ], { timeoutMs: 5000 });
  log(`wordcount=${wordCount.stdout} exit=${wordCount.exitCode} durationMs=${wordCount.durationMs}`);

  phase('Done');
  log('workflow complete');
  return {
    draft, critique: critiqueJson, final,
    wordCount: Number(wordCount.stdout),
    wordCountCommandExit: wordCount.exitCode,
  };
}
