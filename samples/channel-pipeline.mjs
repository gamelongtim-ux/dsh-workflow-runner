// dsh-workflow-runner sample —— channel + future 并发原语演示
//
// 模拟 ZCode `examples.md #6` 的 research → verify 流:
//   3 路 researcher(并行,future) 各自产生若干 fact,送进 facts channel
//   2 路 verifier(并行,future) 从 channel 拉 fact,judge
//   writer 把 hold 的 fact 汇总成 markdown artifact
//
// 关键点:researcher 在送完事实后 close(channel),verifier 看到 channel 关闭
// 后就退出各自的 for-await 循环,跟 ZCode 的 ChannelDeadlock 语义对齐。
//
// 这个 sample 不真的调 LLM(没 key 会失败),改用 world.run(node) 假扮 fact
// 来源,verifier 也用 world.run(node) 假扮判决。目的是演示 channel/future
// 的控制流,不是 LLM 集成。
//
'use strict';
const { agent, world, phase, log, report, artifact, channel, future } = globalThis.__dsh;

export default async function main() {

phase('Set up: 3 angles, each producing 2 fake facts');
const angles = ['architecture', 'data flow', 'error handling'];
const facts = channel('facts'); // shared between producers and consumers
const passed = [];
const rejected = [];
let produced = 0;
let judged = 0;

const PRODUCERS = 3;
const VERIFIERS = 2;

phase(`Spawn ${PRODUCERS} producer futures + ${VERIFIERS} verifier futures`);

const producer = future(async () => {
  try {
    await Promise.all(
      Array.from({ length: PRODUCERS }, async (_, k) => {
        const angle = angles[k % angles.length];
        // Fake a "fact" by running node to print two pseudo-facts
        const r = await world.run('node', ['-e',
          `process.stdout.write(JSON.stringify([` +
          `{claim:'fact from ${angle} #1',source:'node-${k}-1'},` +
          `{claim:'fact from ${angle} #2',source:'node-${k}-2'}` +
          `]));`,
        ], { timeoutMs: 5000 });
        if (r.exitCode !== 0) {
          log(`producer ${k} failed`, 'warn');
          return;
        }
        let arr;
        try { arr = JSON.parse(r.stdout); } catch (_) { return; }
        for (let i = 0; i < arr.length; i++) {
          facts.send({ ...arr[i], id: `${angle}-${i + 1}` });
          produced++;
        }
      }),
    );
  } finally {
    facts.close(); // producer owns close(); verifiers exit their for-await after this
    log(`producer stage done, sent ${produced} facts, channel closed`);
  }
});

const consumer = future(async () => {
  // Each verifier is its own future, draining the channel.
  const verifiers = Array.from({ length: VERIFIERS }, (_, k) => future(async () => {
    let myJudged = 0;
    for await (const fact of facts) {
      myJudged++;
      judged++;
      // Fake verify: "holds" if claim starts with "fact"
      const holds = typeof fact.claim === 'string' && fact.claim.startsWith('fact');
      if (holds) passed.push(fact);
      else rejected.push(fact.claim);
    }
    log(`verifier-${k} drained ${myJudged} facts`);
  }));
  await Promise.all(verifiers);
  log(`consumer stage done, judged ${judged} total`);
});

phase('Wait for pipeline to drain');
await Promise.all([producer, consumer]);

phase('Publish a markdown summary as the primary deliverable');
const md = [
  '# Channel / future pipeline demo',
  '',
  `* Producers: ${PRODUCERS}`,
  `* Verifiers: ${VERIFIERS}`,
  `* Facts produced: ${produced}`,
  `* Facts judged: ${judged}`,
  `* Held: ${passed.length}`,
  `* Rejected: ${rejected.length}`,
  '',
  '## Held facts',
  '',
  ...passed.map((f) => `- \`${f.id}\`: ${f.claim}  (source: ${f.source})`),
  '',
  '## Rejected',
  '',
  rejected.length > 0 ? rejected.map((c) => `- ${c}`).join('\n') : '_(none)_',
  '',
].join('\n');
await artifact.markdown('report', md, { title: 'Channel pipeline report', primary: true });

phase('Done');
return { produced, judged, held: passed.length, rejected: rejected.length };
}
