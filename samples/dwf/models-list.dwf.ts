// models：这个 run 被允许使用的模型 id 列表。
//
// 新作者面里 models 是环境声明里的一个只读数组。model("…") 的实参必须是编译期字面量——
// 脚本能交给子代理的模型名在运行前就是一个封闭集合，确认窗据此把每个名字对着宿主的
// 模型目录解析一遍（解析不出来会退回 9011，什么都不跑）。所以这里演示的是「列出来」
// 与「取一个」。

artifact.table("models", {
  title: "Allowed models for this run",
  columns: [
    { field: "index", label: "#" },
    { field: "id", label: "Model id" },
  ],
});

phase("List the models this run may use");
log(`models = ${JSON.stringify(models)}`);

for (const [i, id] of models.entries()) {
  report({ index: i + 1, id }, "models");
}

phase("Build a ModelRef from a literal model id");
// model() 只吃编译期字面量，所以它造出来的 ModelRef 也只对应一个字面量名字。
// ModelRef 只活在类型系统里：运行期它就是模型名字符串本身。
model("deepseek-chat");
const allowed = models.includes("deepseek-chat");
log(`a ModelRef for "deepseek-chat" is buildable; this run allows it: ${allowed}`);

// 门：把模型名交给 shell 读回来，验证读到的列表不是空的。
const gate = await world.run(
  "node",
  ["-e", "process.stdout.write(String(process.argv[1].length))", models.join(",")],
  { timeoutMs: 5000 },
);
log(`the shell read back ${gate.stdout.trim()} chars of model ids`);

return { count: models.length, models };
