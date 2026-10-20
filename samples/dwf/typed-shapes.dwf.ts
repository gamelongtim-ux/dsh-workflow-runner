// 「共享类型」在新作者面里的样子。
//
// 旧路径里这一份是独立文件：别的脚本用 `import type` 从这里取形状，tsc 把它整个擦掉。
// 新作者面没有 import——脚本被编译进一个函数体，模块系统不存在，跨文件的类型拿不到。
// 于是形状只能声明在脚本自己体内：下面这几个声明既是本脚本的类型标注，也是 ask<T> 的契约，
// 字段上的 JSDoc 是子代理真正读到的 schema 说明。

/** 一个 phase 的名字，显示在 run 的 phase pills 上。 */
type PhaseName = string;

/** 一条 report 的标题，显示在结果列表上方。 */
type ReportTitle = string;

/** 一条 world.run 命令的结果。 */
interface CommandResult {
  /** The process exit code. Nonzero is a normal outcome, not a failure. */
  exitCode: number;
  /** The captured stdout, as UTF-8 text. */
  stdout: string;
  /** The captured stderr, as UTF-8 text. */
  stderr: string;
}

/** 一个子代理给出的判断。 */
interface Verdict {
  /** "ok" or "problem". */
  status: string;
  /** One sentence of evidence for the status. */
  evidence: string;
}

phase("Run one command and read it through a locally declared shape");

const probe: CommandResult = await world.run(
  "node",
  ["-e", "process.stdout.write('shapes ok')"],
  { timeoutMs: 5000 },
);

log(`exit=${probe.exitCode} stdout=${probe.stdout.trim()}`);

phase("Ask a subagent for a shape declared in this same file");

const verdict = await agent("judge", { system: "You answer precisely." }).ask<Verdict>(
  "Is 'shapes ok' a healthy command result? Answer with a status and one sentence of evidence.",
);

const title: ReportTitle = "Shapes";
const phaseLabel: PhaseName = "shapes";
log(`${phaseLabel}: ${verdict.status}: ${verdict.evidence}`);
report({ title, status: verdict.status, evidence: verdict.evidence });

// 门：把判断交给 shell 读回来，验证它不是空的。
const gate = await world.run(
  "node",
  ["-e", "process.stdout.write(String(process.argv[1].length))", verdict.evidence],
  { timeoutMs: 5000 },
);
log(`the shell read back ${gate.stdout.trim()} chars of evidence`);

return { probe, verdict };
