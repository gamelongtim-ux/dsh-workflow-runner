// 3 路并行 summarizer + 一个 reducer：先扇出，再汇总。
//
// 扇出的三个 actor 名字各不相同——actor 名在一次 run 内必须唯一，它是修订续跑匹配缓存的身份键。
// 名字是运行期算出来的（带洞模板），编译期看不穿，唯一性由引擎在运行期兜底。

const SUBJECTS = [
  "Hungarian algorithm for assignment problems",
  "Stable matching and the Gale-Shapley theorem",
  "Minimum spanning tree: Kruskal vs Prim",
];

artifact.table("fanout", {
  title: "每个主题的摘要",
  columns: [
    { field: "subject", label: "Subject" },
    { field: "summary", label: "Summary" },
  ],
});

phase("Fan out: ask three summarizers in parallel");
log(`spawning 3 parallel summarizer agents over: ${SUBJECTS.join("; ")}`);

const [summaryA, summaryB, summaryC] = await Promise.all(
  SUBJECTS.map((topic, i) => {
    const name = `summarizer-${i + 1}`;
    return agent(name, {
      system:
        "You are a senior algorithms instructor. Explain in 2 paragraphs max, " +
        "using 1 concrete example. No preamble.",
    }).ask(`Write a brief yet precise summary of: ${topic}`);
  }),
);

report({ subject: SUBJECTS[0], summary: summaryA.slice(0, 1200) }, "fanout");
report({ subject: SUBJECTS[1], summary: summaryB.slice(0, 1200) }, "fanout");
report({ subject: SUBJECTS[2], summary: summaryC.slice(0, 1200) }, "fanout");

phase("Gate: shell word-count of one summary");
const wc = await world.run(
  "node",
  [
    "-e",
    "process.stdout.write(String(arguments[0].split(/\\s+/).filter(Boolean).length))",
    "--",
    summaryA,
  ],
  { timeoutMs: 5000 },
);
log(`summaryA word count = ${wc.stdout} (exit ${wc.exitCode})`);
if (wc.exitCode !== 0) {
  log("shell gate flagged an issue; continuing anyway");
}

phase("Reduce: synthesize into one mini-cheatsheet");
const reducer = await agent("reducer", {
  system:
    "You are a precise technical editor. Output ONE tight markdown cheatsheet: " +
    "three bullets, one per algorithm, each ≤60 words. No intro/outro.",
}).ask(
  `Synthesize these three summaries into a single cheatsheet:\n` +
    `\n# 1. Hungarian\n${summaryA}\n` +
    `\n# 2. Stable matching\n${summaryB}\n` +
    `\n# 3. MST\n${summaryC}\n`,
);
report({ cheatsheet: reducer.slice(0, 4000) });

return {
  summaries: { Hungarian: summaryA, StableMatching: summaryB, MST: summaryC },
  cheatsheet: reducer,
  wordCountSummaryA: Number(wc.stdout),
};
