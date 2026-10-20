// 干净的 TypeScript：严格模式下零诊断，所以 run 会照常走下去。
//
// 这是 typecheck-fail 的对照面：那份是故意写坏的，编译期就被拦下。
//
// 这里演示的「环境声明」用法：phase、log、world、report 都是环境里的自由标识符，
// 脚本自己不需要 import 任何东西；类型标注写在脚本体内。

interface EchoResult {
  /** The process exit code. */
  exitCode: number;
  /** The captured stdout. */
  stdout: string;
  /** The captured stderr. */
  stderr: string;
}

phase("Strict-typed: world.run echoes with typed result");
const echo: EchoResult = await world.run(
  "node",
  ["-e", 'process.stdout.write("hello from typed-ok\\n")'],
  { timeoutMs: 5000 },
);
if (echo.exitCode !== 0) {
  log(`echo failed: ${echo.stderr}`);
} else {
  log(`echo out: ${echo.stdout.trim()}`);
  report({ exitCode: echo.exitCode, stdout: echo.stdout });
}

phase("Strict-typed: report a structured item");
const ok: boolean = true;
const items: readonly number[] = [1, 2, 3];
report({ name: "typecheck-ok", ok, n: items.length, items });

phase("Done");
log("typecheck-ok complete");

return {
  echo: { exitCode: echo.exitCode, stdout: echo.stdout.trim() },
  ok,
};
