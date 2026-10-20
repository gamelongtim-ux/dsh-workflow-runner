// world.run 的命令确认弹窗演示。
//
// 提交前编辑器会列出脚本里出现的 world.run 命令（本脚本里是 node / git / powershell），
// 用户勾选要批准的子集后才会真正开始 run——只有被批准的命令会执行。

phase("Confirm gate: world.run in this script");
log("this run will only execute world.run commands the user approved in the dialog");

phase("Run a tiny node -e");
const echo = await world.run(
  "node",
  ["-e", 'process.stdout.write("echo from node: " + process.platform + "\\n");'],
  { timeoutMs: 5000 },
);
log(`echo exit=${echo.exitCode} stdout=${JSON.stringify(echo.stdout)}`);
report({ kind: "node-echo", exitCode: echo.exitCode, stdout: echo.stdout });

phase("Try git --version (only if the user approved it)");
let gitOut: string | null = null;
let gitErr: string | null = null;
try {
  const gitVersion = await world.run("git", ["--version"], { timeoutMs: 5000 });
  gitOut = gitVersion.stdout.trim();
  log(`git exit=${gitVersion.exitCode} stdout=${JSON.stringify(gitOut)}`);
  report({ kind: "git-version", exitCode: gitVersion.exitCode, stdout: gitOut });
} catch (err) {
  gitErr = String((err as Error).message || err);
  log("git rejected or failed: " + gitErr);
  report({ kind: "git-version", error: gitErr });
}

phase("Try powershell (Windows-only; declined if the user did not check it)");
let psOut: string | null = null;
let psErr: string | null = null;
try {
  const ps = await world.run(
    "powershell",
    ["-NoProfile", "-Command", "Get-Date | Select-Object -ExpandProperty ToString"],
    { timeoutMs: 5000 },
  );
  psOut = (ps.stdout || "").trim();
  log(`powershell exit=${ps.exitCode} stdout=${JSON.stringify(psOut)}`);
  report({ kind: "powershell-date", exitCode: ps.exitCode, stdout: psOut });
} catch (err) {
  psErr = String((err as Error).message || err);
  log("powershell rejected or failed: " + psErr);
  report({ kind: "powershell-date", error: psErr });
}

phase("Done");
return {
  approved: { node: true, git: gitOut !== null, powershell: psOut !== null },
  errors: { git: gitErr, powershell: psErr },
};
