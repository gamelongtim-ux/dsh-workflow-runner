// 沙箱的两道门：环境清洗与工作区围栏。
//
// 旧路径的 sample 直接读子进程的 process.env；新作者面里做不到——脚本被编译进一个
// 纯 ES realm 的 vm cell，那里没有 process / require / Buffer，也没有定时器。
// 所以能演示的是**第二层进程**看得见什么：world.run 起的那个 shell 子进程，它的 env
// 是清洗过的。而「脚本自己看不见宿主 env」这一条在本路径下是结构性成立的，不必读 env 证明。

phase("Ask a child shell how many KEY/TOKEN/SECRET env keys it sees");
const wc = await world.run(
  "node",
  [
    "-e",
    "const k = Object.keys(process.env).filter((x) => /KEY|TOKEN|SECRET/.test(x));" +
      "process.stdout.write(k.length + ' sensitive keys visible')",
  ],
  { timeoutMs: 5000 },
);
log(`shell child saw: ${wc.stdout.trim()}`);

phase("Try to escape the workspace via files.glob (should be rejected)");
let escapeRejected = false;
try {
  await files.glob("/etc/**/shadow");
} catch (err) {
  escapeRejected = true;
  log(`files.glob escape rejected as expected: ${String((err as Error).message).split("\n")[0]}`);
}
report({ escapeRejected });

// 围栏只拦越界的读取，不拦后续步骤：再跑一条命令证明脚本还活着。
const still = await world.run("node", ["-e", "process.stdout.write('still running')"], {
  timeoutMs: 5000,
});
log(still.stdout.trim());

const shellCount = Number((wc.stdout.trim() || "0").split(" ")[0]) || 0;

return {
  shellChildSensitiveKeyCount: shellCount,
  pathEscapeRejected: escapeRejected,
};
