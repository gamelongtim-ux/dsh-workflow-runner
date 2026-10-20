// 注入 stage 的正文长什么样。
//
// 旧路径里 stage 正文是一份独立文件，用 `export default async (ctx) => {...}` 导出；
// 新作者面里脚本不是模块（没有 import / export），所以 stage 正文是**一个函数表达式**——
// 宿主在注入时把它求值，它看到的是同一份环境声明的 facade。
//
// 旧正文靠 `ctx` 拿运行上下文（阶段数、已报告条数、同批 stage）；本路径里宿主把注入的
// stage 记成一条 stage 记录，脚本用 stages.* 读它。所以这里演示能表达的那一半：
// 正文里直接用 facade，脚本侧用 stages.* 读回结果。

artifact.table("review", {
  title: "Injected review verdicts",
  columns: [
    { field: "stage", label: "Stage" },
    { field: "phaseAtInjection", label: "Phase" },
    { field: "reportsSoFar", label: "Reports" },
  ],
});

phase("Run a stage body the way the host would inject one");

// 一段 stage 正文：函数表达式，闭包里就是脚本的环境声明。
const review = async (): Promise<{
  stage: string;
  phaseAtInjection: string;
  reportsSoFar: number;
  priorStages: string[];
  models: readonly string[];
}> => {
  // stage 正文里的 phase 会折进这个 run 的 phase pills。
  phase("Injected review");
  log(`review: this run may use ${models.length} model(s)`);

  const priorStages: string[] = [];
  const verdict = {
    stage: "review",
    phaseAtInjection: "Injected review",
    reportsSoFar: 0,
    priorStages,
    models,
  };
  report(verdict, "review");
  return verdict;
};

const verdict = await review();

phase("Collect the stages the run recorded");
const all = await stages.list();
log(`the run recorded ${all.length} stage(s)`);

// 门：产物写出去之后确认它不是空的。
const gate = await world.run(
  "node",
  ["-e", "process.stdout.write(String(process.argv[1].length))", JSON.stringify(verdict)],
  { timeoutMs: 5000 },
);
log(`verdict is ${gate.stdout.trim()} chars`);

return { verdict, stages: all.length };
