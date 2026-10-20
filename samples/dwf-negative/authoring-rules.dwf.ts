// 故意违反作者规则的 TypeScript：这一份要**编译不过**，而且败在作者规则上（9xxx），
// 不是 TypeScript 自己的诊断上。
//
// 旧路径里这些毛病都是运行期才炸的：phase 的名字是运行期算出来的，actor 重名让整个 run
// 失败，world.run 的命令名在运行期才成形，report 的标签指向一个不存在的看板。
// 编译期层把它们全变成带定位、带修法的诊断——提交之前就能看见。
//
// 它住在 samples/dwf-negative/ 而不是 samples/dwf/：samples/dwf/ 里的每一个文件都必须
// 编译通过，负样本的职责正好相反。

// 9004 —— phase 的名字必须是编译期字面量：运行期才成形的名字没法画进确认窗上的图。
const phaseName = "late";
phase(phaseName);

// 9005 —— actor 名在一次 run 内必须唯一：它是修订续跑匹配缓存的身份键。
agent("worker").ask("first");
agent("worker").ask("second");

// 9003 —— world.run 的命令名必须是编译期字面量：脚本的命令集在提交前就是一个封闭集合。
const command = "node";
await world.run(command, ["--version"]);

// 9007 —— report 的标签必须指向本脚本里声明过的预置看板。
report({ hello: "world" }, "nowhere");

// 9010 —— 子代理的 model 必须是编译期已知的名字：模型集合在运行前必须闭合。
const wideModel: string = "deepseek-chat";
await agent("worker2", { model: wideModel }).ask("q");

// 9012 —— 留白必须写出类型实参：类型是补全被检查的契约。
await hole("gap", "fill me in");
