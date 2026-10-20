// artifact 体系演示：chart / metrics / board 三种预置看板 + 一份 markdown 产物。
//
// 预置（chart/table/metrics/board）是**声明**：在脚本顶层声明一次，说明「被 report(item, "<id>")
// 标记的条目会被画成什么」；内容成员（file/markdown）是**效应**，每次调用发一版。
// 预置声明不能长在循环或回调里，所以它们都在最上面。

artifact.chart("latency", {
  title: "Round-trip latency (ms)",
  x: { field: "round", label: "Round" },
  y: { field: "ms", label: "ms" },
  type: "line",
});

artifact.metrics("overview", {
  title: "Overview",
  metrics: [
    { field: "rounds", label: "Rounds" },
    { field: "totalMs", label: "Total ms" },
    { field: "bestMs", label: "Best ms" },
  ],
});

artifact.board("candidates", {
  title: "Candidates",
  key: "name",
  status: "status",
  columns: ["queued", "done"],
});

phase("Enqueue two candidates, then run three latency rounds");
report({ name: "alpha", status: "queued" }, "candidates");
report({ name: "beta", status: "queued" }, "candidates");
log("two candidates queued");

let totalMs = 0;
let bestMs = Number.POSITIVE_INFINITY;
const samples: { round: number; ms: number }[] = [];

for (let round = 1; round <= 3; round += 1) {
  const r = await world.run(
    "node",
    [
      "-e",
      "const ms = 80 + Math.floor(Math.random() * 60); setTimeout(() => process.stdout.write(String(ms)), ms);",
    ],
    { timeoutMs: 5000 },
  );
  const ms = Number(r.stdout || "0");
  totalMs += ms;
  if (ms < bestMs) bestMs = ms;
  samples.push({ round, ms });
  log(`round ${round}: ${ms}ms (exit ${r.exitCode})`);
  report({ round, ms }, "latency");
}

phase("Promote alpha to done, publish the overview and the report");
// 同一个 key 再推一行：board 上 alpha 变成另一张卡（后来的条目替换同 key 的那条）。
report({ name: "alpha", status: "done" }, "candidates");
log("alpha moved to done");

report({ rounds: 3, totalMs, bestMs }, "overview");

const md = [
  "# Artifact demo run",
  "",
  "Three rounds of `world.run`, each emitting a latency sample. The chart",
  "tab shows them as a line; the overview tile shows the totals.",
  "",
  `* Rounds: 3`,
  `* Total: ${totalMs} ms`,
  `* Best: ${bestMs} ms`,
  "",
  "## Per-round samples",
  "",
  ...samples.map((s) => `- round ${s.round}: **${s.ms} ms**`),
  "",
].join("\n");
await artifact.markdown("report", md, { title: "Demo report", primary: true });

// 门：产物写出去之后确认它不是空的。
const gate = await world.run(
  "node",
  ["-e", "process.stdout.write(String(process.argv[1].length))", md],
  { timeoutMs: 5000 },
);
log(`published report is ${gate.stdout.trim()} chars`);

return { rounds: 3, totalMs, bestMs, samples };
