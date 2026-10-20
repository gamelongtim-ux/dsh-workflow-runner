// model() 多模型路由：先让一个便宜的模型打 tier 标签，再按 tier 把问题交给对应模型回答。
//
// model() 的实参必须是编译期字面量——脚本能交给子代理的模型名，在运行前就是一个封闭集合，
// 确认窗据此把每个名字对着宿主的模型目录解析一遍。
// 所以这里的表是字面量，ModelRef 只是「这个档位用哪个模型」的另一个写法。

const MODEL_IDS: Record<string, string> = {
  light: "deepseek-chat",
  strong: "deepseek-chat",
};

const MODELS: Record<string, ModelRef> = {
  light: model("deepseek-chat"),
  strong: model("deepseek-chat"),
};

artifact.table("replies", {
  title: "Replies by tier",
  columns: [
    { field: "question", label: "Question" },
    { field: "tier", label: "Tier" },
    { field: "model", label: "Model" },
    { field: "answer", label: "Answer (preview)" },
  ],
});

artifact.metrics("counts", {
  title: "Tier counts",
  metrics: [
    { field: "light", label: "Light" },
    { field: "strong", label: "Strong" },
    { field: "total", label: "Total" },
  ],
});

const questions = [
  "Rename the config key in the README",
  "Explain the retry design with backoff",
];

phase("Spawn router + answerers");
let light = 0;
let strong = 0;

for (let i = 0; i < questions.length; i += 1) {
  const q = questions[i];
  let tier = "light";
  let routerAnswer = '{"tier":"light"}';

  try {
    // router 子代理——没有 key 时这里会 fail，脚本退回 light 档。
    routerAnswer = await agent(`分诊-${i + 1}`, { model: MODELS.light }).ask(
      `Would answering this well need the strong model?\n${q}\nAnswer with JSON: {"tier":"light"|"strong"}`,
    );
  } catch (err) {
    log("router " + (i + 1) + " failed: " + String((err as Error).message));
  }

  try {
    const parsed = JSON.parse(routerAnswer.replace(/[^]*?(\{[^}]+\})[^]*?/, "$1")) as {
      tier?: string;
    };
    if (parsed.tier === "strong") tier = "strong";
  } catch (_) {
    /* keep light */
  }

  let answerText = "";
  try {
    answerText = await agent(`答复者-${i + 1}`, { model: MODELS[tier] }).ask(q);
  } catch (err) {
    log("answerer " + (i + 1) + " failed: " + String((err as Error).message));
    answerText = "(no LLM available)";
  }

  if (tier === "strong") strong += 1;
  else light += 1;
  report(
    { question: q, tier, model: MODEL_IDS[tier], answer: answerText.slice(0, 200) },
    "replies",
  );
  log(`Q${i + 1} routed to ${tier}`);
}

phase("Push counts");
report({ light, strong, total: light + strong }, "counts");

phase("Done");
log(`model-router demo complete: ${light} light, ${strong} strong`);
return { light, strong, total: light + strong };
