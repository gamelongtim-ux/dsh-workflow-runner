// TypeScript 最小流水线：phase / log / report / world.run 全部带类型。
//
// 旧路径里这份脚本用 `import type` 从另一个文件取形状；新作者面里没有 import——
// 脚本被编译进一个函数体，模块系统不存在，形状只能声明在脚本自己体内。
//
// 刻意不调用 LLM，所以无 API key 也能跑。

interface EchoResult {
  /** The process exit code. */
  exitCode: number;
  /** The captured stdout. */
  stdout: string;
  /** The captured stderr. */
  stderr: string;
}

interface FailedCommand {
  /** The exit code, or -1 when the command could not run at all. */
  exitCode: number;
  /** The failure message, empty when the command ran. */
  error: string;
}

phase("Typed: phase tracking");
log("phase() event sent from a .ts script");

phase("Typed: world.run echoes");
const echo: EchoResult = await world.run(
  "node",
  ["-e", 'process.stdout.write("hello from typed world.run\\n")'],
  { timeoutMs: 5000 },
);
if (echo.exitCode !== 0) {
  log("echo failed: " + echo.stderr);
} else {
  log("echo out: " + echo.stdout.trim());
  report({ echo: echo.stdout.trim(), exitCode: echo.exitCode });
}

phase("Typed: failed shell command");
let bad: FailedCommand = { exitCode: -1, error: "" };
try {
  const r = await world.run("node", ["-e", "process.exit(7)"], { timeoutMs: 5000 });
  bad = { exitCode: r.exitCode, error: "" };
} catch (err) {
  bad = { exitCode: -1, error: String((err as Error).message || err) };
}
log(`bad exitCode=${bad.exitCode}`);
report({ bad });

phase("Typed: report a structured item");
const ok: boolean = true;
const items: readonly number[] = [1, 2, 3];
report({ name: "typed", ok, n: items.length, items });

phase("Done");
log("typed-minimal complete");

return {
  echo: { exitCode: echo.exitCode, stdout: echo.stdout.trim() },
  bad,
  ok,
};
