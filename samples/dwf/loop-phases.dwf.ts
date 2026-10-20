// phase 折叠演示：循环里反复调用同名 phase，UI 应当只显示一个 pill（带 ×N 角标）。
//
// 新作者面里 phase() 是环境声明里的一个自由标识符：名字必须是字面量，调用必须独立成句。

artifact.table("check", {
  title: "每一轮 check 的结果",
  columns: [
    { field: "round", label: "Round" },
    { field: "ok", label: "OK" },
  ],
});

artifact.table("summary", {
  title: "五轮跑完的总览",
  columns: [
    { field: "total", label: "Total" },
    { field: "allOk", label: "All OK" },
  ],
});

const ROUNDS = 5;

phase("init");
const banner = await world.run("node", ["-e", "process.stdout.write('starting')"], {
  timeoutMs: 5000,
});
log(banner.stdout.trim());

const checks: { round: number; ok: boolean }[] = [];

for (let i = 1; i <= ROUNDS; i += 1) {
  phase("check");
  // 每一轮只跑一条极小的命令，整个 run 几秒就结束。
  const r = await world.run("node", ["-e", `process.stdout.write("round ${i} ok\\n");`], {
    timeoutMs: 5000,
  });
  log(`round ${i}: ${r.stdout.trim()}`);
  checks.push({ round: i, ok: r.exitCode === 0 });
  report({ round: i, ok: r.exitCode === 0 }, "check");
}

phase("summary");
const total = await world.run("node", ["-e", `process.stdout.write(String(${checks.length}))`], {
  timeoutMs: 5000,
});
log(`total rounds: ${total.stdout.trim()}`);

report({ total: checks.length, allOk: checks.every((c) => c.ok) }, "summary");

return { rounds: checks.length, allOk: checks.every((c) => c.ok) };
