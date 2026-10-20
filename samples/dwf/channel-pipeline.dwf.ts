// channel + future 的并发流水线：3 个 producer 产出事实，2 个 verifier 消费并判定。
//
// 关键点：producer 在 finally 里 close(channel)，verifier 的 for-await 因此会退出。
// 没人 close 的 channel 是死锁，而死锁是 fail，不是挂起。

const angles = ["architecture", "data flow", "error handling"];

const PRODUCERS = 3;
const VERIFIERS = 2;

interface Fact {
  /** 这条事实说了什么。 */
  claim: string;
  /** 它从哪儿来。 */
  source: string;
  /** 这条事实在流水线里的唯一编号。 */
  id: string;
}

const facts = channel<Fact>("facts");
const passed: Fact[] = [];
const rejected: string[] = [];
let produced = 0;
let judged = 0;

phase("Spawn 3 producer futures + 2 verifier futures");

const producer = future(async () => {
  try {
    await Promise.all(
      Array.from({ length: PRODUCERS }, async (_, k) => {
        const angle = angles[k % angles.length];
        // 用 node 伪造一条事实：这里要演示的是 channel/future 的控制流，不是 LLM 集成。
        const r = await world.run(
          "node",
          [
            "-e",
            `process.stdout.write(JSON.stringify([` +
              `{claim:'fact from ${angle} #1',source:'node-${k}-1'},` +
              `{claim:'fact from ${angle} #2',source:'node-${k}-2'}` +
              `]));`,
          ],
          { timeoutMs: 5000 },
        );
        if (r.exitCode !== 0) {
          log(`producer ${k} failed`);
          return;
        }
        let arr: Fact[];
        try {
          arr = JSON.parse(r.stdout) as Fact[];
        } catch (_) {
          return;
        }
        for (let i = 0; i < arr.length; i += 1) {
          facts.send({ ...arr[i], id: `${angle}-${i + 1}` });
          produced += 1;
        }
      }),
    );
  } finally {
    // producer 负责 close：verifier 的 for-await 到这里就会退出。
    facts.close();
    log(`producer stage done, sent ${produced} facts, channel closed`);
  }
});

const consumer = future(async () => {
  // 每个 verifier 是自己的 future，各自把 channel 抽干。
  const verifiers = Array.from({ length: VERIFIERS }, (_, k) =>
    future(async () => {
      let myJudged = 0;
      for await (const fact of facts) {
        myJudged += 1;
        judged += 1;
        // 伪判定：claim 以 "fact" 开头就算站得住。
        const holds = fact.claim.startsWith("fact");
        if (holds) passed.push(fact);
        else rejected.push(fact.claim);
      }
      log(`verifier-${k} drained ${myJudged} facts`);
    }),
  );
  await Promise.all(verifiers);
  log(`consumer stage done, judged ${judged} total`);
});

phase("Wait for the pipeline to drain");
await Promise.all([producer, consumer]);

phase("Publish a markdown summary as the primary deliverable");
const md = [
  "# Channel / future pipeline demo",
  "",
  `* Producers: ${PRODUCERS}`,
  `* Verifiers: ${VERIFIERS}`,
  `* Facts produced: ${produced}`,
  `* Facts judged: ${judged}`,
  `* Held: ${passed.length}`,
  `* Rejected: ${rejected.length}`,
  "",
  "## Held facts",
  "",
  ...passed.map((f) => `- \`${f.id}\`: ${f.claim}  (source: ${f.source})`),
  "",
  "## Rejected",
  "",
  rejected.length > 0 ? rejected.map((c) => `- ${c}`).join("\n") : "_(none)_",
  "",
].join("\n");
await artifact.markdown("report", md, { title: "Channel pipeline report", primary: true });

// 门：产物写出去之后确认它不是空的。
const gate = await world.run(
  "node",
  ["-e", "process.stdout.write(String(process.argv[1].length))", md],
  { timeoutMs: 5000 },
);
log(`published report is ${gate.stdout.trim()} chars`);

return { produced, judged, held: passed.length, rejected: rejected.length };
