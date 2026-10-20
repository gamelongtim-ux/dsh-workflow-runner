// ask<T> 的类型化结果：子代理直接返回一个结构化对象，字段访问直接可用，不用自己 JSON.parse。
//
// 形状写在脚本自己体内的一个 interface 里——脚本被编译进函数体，没有 import 可用。
// 字段上的 JSDoc 不是装饰：它就是子代理真正读到的 schema 说明。

interface Plan {
  /** 一行标题，说明这份计划要做什么。 */
  title: string;
  /** 每一段正文，各自一个字符串。 */
  paragraphs: string[];
  /** 步骤，按顺序。 */
  steps: string[];
  /** 每一条风险或待定的问题。 */
  risks: string[];
  /** 这份计划是否还需要人来过一遍。 */
  needsReview: boolean;
}

artifact.table("steps", {
  title: "Plan steps",
  columns: [
    { field: "index", label: "#" },
    { field: "step", label: "Step" },
  ],
});

phase("Plan a typed response from the planner agent");
const plan = await agent("planner", {
  system: "You are a senior algorithm textbook author. You plan articles, not write them.",
}).ask<Plan>(
  "Plan a 3-paragraph explanation of the Hungarian algorithm for assignment problems. Be precise and avoid filler.",
);

log(
  `got typed plan: ${plan.title} (${plan.paragraphs.length} paragraphs, ${plan.steps.length} steps)`,
);
log(`plan.paragraphs[0] (first 120 chars): ${plan.paragraphs[0].slice(0, 120)}`);

phase("Report the plan steps into the declared table");
plan.steps.forEach((step, i) => report({ index: i + 1, step }, "steps"));

phase("Publish a markdown report");
const md = [
  `# ${plan.title}`,
  "",
  `* Paragraphs: ${plan.paragraphs.length}`,
  `* Steps: ${plan.steps.length}`,
  `* Risks: ${plan.risks.length}`,
  `* needsReview: ${plan.needsReview}`,
  "",
  "## Paragraphs",
  "",
  ...plan.paragraphs.map((p, i) => `### ${i + 1}\n\n${p}`),
  "",
  "## Steps",
  "",
  ...plan.steps.map((s, i) => `${i + 1}. ${s}`),
  "",
  "## Risks",
  "",
  ...plan.risks.map((r) => `- ${r}`),
  "",
].join("\n");
await artifact.markdown("report", md, { title: plan.title, primary: true });

// 门：产物写出去之后确认它不是空的。
const gate = await world.run(
  "node",
  ["-e", "process.stdout.write(String(process.argv[1].length))", md],
  { timeoutMs: 5000 },
);
log(`published report is ${gate.stdout.trim()} chars`);

return {
  title: plan.title,
  paragraphCount: plan.paragraphs.length,
  stepCount: plan.steps.length,
  needsReview: plan.needsReview,
};
