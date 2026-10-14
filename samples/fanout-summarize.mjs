// dsh-workflow-runner sample —— 3 路并行 summarizer + reducer
//
// 演示：
//   - Promise.all(3 个不同 name 的 agent 并行)
//   - report(...) 中间结果
//   - world.run 做轻量 gate（字数检查）
//   - reducer agent 汇总
//
// 跑法：在 editor 里点 Run。完成后 shell.overlay 浮动点会变为绿勾。
//
'use strict';
const { agent, world, phase, log, report } = globalThis.__dsh;

const SUBJECTS = [
  'Hungarian algorithm for assignment problems',
  'Stable matching and the Gale-Shapley theorem',
  'Minimum spanning tree: Kruskal vs Prim',
];

export default async function main() {
  phase('Fan out: ask three summarizers in parallel');
  log(`spawning 3 parallel summarizer agents over: ${SUBJECTS.join('; ')}`);
  const [summaryA, summaryB, summaryC] = await Promise.all(
    SUBJECTS.map((topic, i) => {
      const name = `summarizer-${i + 1}`;
      return agent(name, {
        system: 'You are a senior algorithms instructor. Explain in 2 paragraphs max, ' +
                'using 1 concrete example. No preamble.',
      }).ask(`Write a brief yet precise summary of: ${topic}`);
    }),
  );
  report({
    subjects: SUBJECTS,
    summaries: [summaryA, summaryB, summaryC].map((s) => s.slice(0, 1200)),
  }, 'fanout');

  phase('Gate: shell word-count of one summary');
  const wc = await world.run('node', ['-e',
    'process.stdout.write(String(arguments[0].split(/\\s+/).filter(Boolean).length))',
    '--', summaryA,
  ], { timeoutMs: 5000 });
  log(`summaryA word count = ${wc.stdout} (exit ${wc.exitCode})`);
  if (wc.exitCode !== 0) {
    log('shell gate flagged an issue; continuing anyway', 'warn');
  }

  phase('Reduce: synthesize into one mini-cheatsheet');
  const reducer = await agent('reducer', {
    system: 'You are a precise technical editor. Output ONE tight markdown cheatsheet: ' +
            'three bullets, one per algorithm, each ≤60 words. No intro/outro.',
  }).ask(
    `Synthesize these three summaries into a single cheatsheet:\n` +
    `\n# 1. Hungarian\n${summaryA}\n` +
    `\n# 2. Stable matching\n${summaryB}\n` +
    `\n# 3. MST\n${summaryC}\n`
  );
  report({ cheatsheet: reducer.slice(0, 4000) }, 'final');

  phase('Done');
  log('fan-out + reduce complete');
  return {
    summaries: { Hungarian: summaryA, StableMatching: summaryB, MST: summaryC },
    cheatsheet: reducer,
    wordCountSummaryA: Number(wc.stdout),
  };
}
