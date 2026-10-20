// 结构化 amend：宿主在**运行中**往这个 run 里注入一个新 stage。
//
// 这个 workflow 故意多活几秒，好让宿主有一个注入窗口。
// 注入的 stage 与本脚本在同一个进程里跑，看到的是同一份环境声明的 facade——
// 同样的 agent、同样的 world.run 允许清单、同样的工作区围栏。
//
// 脚本这一侧用 stages.* 观察注入：stages.pending() 看还有几个没落地，stages.await() 等它们
// 全部结束，stages.list() 读回每一条 stage 的结果。

artifact.table("rounds", {
  title: "每一轮 world.run 的输出",
  columns: [
    { field: "round", label: "Round" },
    { field: "exitCode", label: "Exit" },
    { field: "stdout", label: "Stdout" },
  ],
});

artifact.table("stages", {
  title: "宿主注入的 stage",
  columns: [
    { field: "id", label: "ID" },
    { field: "name", label: "Name" },
    { field: "status", label: "Status" },
  ],
});

// 脚本所在的环境里没有定时器（那是一个纯 ES realm 的 vm cell），所以「等一会儿」
// 只能借一个子进程来等。
const sleep = (ms: number) =>
  world.run("node", ["-e", `setTimeout(() => process.stdout.write('slept'), ${ms})`], {
    timeoutMs: 5000,
  });

phase("Plan");
log("structural amend: entering the injection window");
const pendingAtStart = await stages.pending();
report({ stage: "waiting", pendingAtStart });

// 三小轮。每一轮都是一个宿主注入的 stage 可以落进来、与原计划交错的地方。
// phase 的名字必须是编译期字面量，所以这里是同一个 "Work"：三轮折成一枚 pill。
for (const n of [1, 2, 3]) {
  await sleep(1200);
  phase("Work");
  const wc = await world.run(
    "node",
    ["-e", "process.stdout.write('round-' + process.argv[1])", String(n)],
    { timeoutMs: 5000 },
  );
  report({ round: n, stdout: wc.stdout, exitCode: wc.exitCode }, "rounds");
}

phase("Collect");
// 显式地等任何宿主注入的 stage。引导流程在结束前也会自动收干未落地的 stage，
// 这一句是给想确定性地读结果的 workflow 用的。
await stages.await({ timeoutMs: 15000 });
const all = await stages.list();
report({
  count: all.length,
  stages: all.map((s) => ({
    id: s.id,
    name: s.name,
    status: s.status,
    result: s.result,
    error: s.error,
  })),
}, "stages");

phase("Done");
return { ok: true, stages: all.length };
