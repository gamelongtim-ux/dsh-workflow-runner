// 留白：跑到这里停下，等人（或主代理）把这一段代码补上，补完再继续。
//
// 补全的正文是一段 async 箭头函数，它在**留白所在的词法作用域**里求值——
// 所以它能直接读到留白之前声明的每个绑定（plan、threshold），不需要再传一个 ctx。

interface Plan {
  /** 这个计划要做的几步。 */
  steps: string[];
  /** 计划里的风险。 */
  risks: string[];
}

phase("Build some context that the body needs to consume");

const plan: Plan = {
  steps: ["gather requirements", "design API", "implement", "test", "ship"],
  risks: ["scope creep", "integration bugs"],
};

const threshold = await askUser("How many steps should the body return?", {
  options: ["2", "3", "5"],
});
log(`user picked threshold=${threshold}`);

phase("Park on a hole — the body will run later");

// 类型实参是这份契约：补全写出来的正文要按它检查，所以它必须显式写出。
// 第二个实参是补全者会收到的提示——把决策需要的信息插进去。
const result = await hole<string[]>("pick-steps", "Decide which steps survive the cut.");

phase("Publish a markdown report of what came out of the hole");
const md = [
  "# Hole demo",
  "",
  `* Threshold picked: ${threshold}`,
  `* Steps total: ${plan.steps.length}`,
  `* Steps returned by hole: ${Array.isArray(result) ? result.length : "not-an-array"}`,
  "",
  "## Returned by the hole body",
  "",
  ...(Array.isArray(result) ? result.map((s, i) => `${i + 1}. ${s}`) : [String(result)]),
  "",
].join("\n");
await artifact.markdown("report", md, { title: "Hole demo report", primary: true });

// 门：产物写出去之后确认它不是空的。
const gate = await world.run(
  "node",
  ["-e", "process.stdout.write(String(process.argv[1].length))", md],
  { timeoutMs: 5000 },
);
log(`published report is ${gate.stdout.trim()} chars`);

return {
  threshold,
  stepsTotal: plan.steps.length,
  resultKind: Array.isArray(result) ? "array" : typeof result,
  result,
};
