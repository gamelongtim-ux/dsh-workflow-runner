// route()：两段式多模型路由的糖——脚本自己写 router 与 answerer 两个函数，route() 把它们接起来。
//
// route(MODELS, routerFn, answererFn)：
//   - MODELS 把档位名映射到模型 id。它必须是字面量表，这样模型名在运行前就是封闭的。
//   - routerFn 拿到 light 档的模型 id，回答一个档位名（"light" / "strong"）。
//   - answererFn 拿到选中的模型 id，返回真正的答案。
// 两个函数都是脚本自己的，所以模型调用本身始终在脚本手里。

interface Tier {
  /** "light" 还是 "strong"。 */
  tier: string;
}

const MODELS = {
  light: "deepseek-chat",
  strong: "deepseek-chat",
} as const;

artifact.table("replies", {
  title: "Replies by tier",
  columns: [
    { field: "index", label: "#" },
    { field: "question", label: "Question" },
    { field: "answerLen", label: "Chars" },
  ],
});

const questions = [
  'Rename the config key in the README from "limit" to "maxRows".',
  "Explain the retry design with exponential backoff and jitter.",
];

phase("Run each question through route()");
const rows: { index: number; question: string; answerLen: number; preview: string }[] = [];

for (let i = 0; i < questions.length; i += 1) {
  const q = questions[i];
  log(`routing Q${i + 1}: ${q}`);

  // router 回答一个 typed 的 {tier}；answerer 返回真正的回答。
  // route() 解析 router 的 tier，然后把选中的模型交给 answerer。
  const answer = await route(
    MODELS,
    async (light) => {
      const v = await agent(`router-${i + 1}`, { model: light }).ask<Tier>(
        `Classify this question as "light" (simple rename) or "strong" (needs explanation).\n` +
          `Reply with JSON {"tier": "light" | "strong"} only.\n\nQuestion: ${q}`,
      );
      return JSON.stringify({ tier: v.tier });
    },
    async (m) => await agent(`answerer-${i + 1}`, { model: m }).ask<string>(q),
  );

  const text = String(answer);
  log(`Q${i + 1} answered (${text.length} chars)`);
  rows.push({ index: i + 1, question: q, answerLen: text.length, preview: text.slice(0, 80) });
}

phase("Publish the report");
for (const r of rows) report(r, "replies");

const md = [
  "# route() demo",
  "",
  `* ${rows.length} questions routed through light/strong`,
  ...rows.map((r) => `* Q${r.index}: ${r.answerLen} chars — ${r.preview}…`),
  "",
].join("\n");
await artifact.markdown("report", md, { title: "route() demo", primary: true });

// 门：产物写出去之后确认它不是空的。
const gate = await world.run(
  "node",
  ["-e", "process.stdout.write(String(process.argv[1].length))", md],
  { timeoutMs: 5000 },
);
log(`published report is ${gate.stdout.trim()} chars`);

return { rows };
