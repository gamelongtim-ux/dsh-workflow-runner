// dsh-workflow-runner sample —— world.run 命令确认弹窗演示
//
// 跑这个 sample 时,编辑器会先弹一个 modal,列出脚本里出现的 world.run 命令
// (本脚本里是 node + git),用户勾选要批准的子集后才会真正开始 run。
// 这是 v0.2.0 引入的安全护栏;以前 world.run("powershell", ...) 会直接执行。
//
// 跑法:点 Run → 弹窗列 `node` 和 `git` → 勾上 → Approve & run → 看结果。
//
'use strict';
const { agent, world, phase, log, report } = globalThis.__dsh;

export default async function main() {
phase('Confirm gate: world.run in this script');
log('this run will only execute world.run commands the user approved in the dialog');

phase('Run a tiny node -e');
const echo = await world.run('node', ['-e',
  'process.stdout.write("echo from node: " + process.platform + "\\n");',
], { timeoutMs: 5000 });
log(`echo exit=${echo.exitCode} stdout=${JSON.stringify(echo.stdout)}`);
report({ kind: 'node-echo', exitCode: echo.exitCode, stdout: echo.stdout }, 'node');

phase('Try git --version (only if user approved it)');
let gitOut = null;
let gitErr = null;
try {
  const git = await world.run('git', ['--version'], { timeoutMs: 5000 });
  gitOut = git.stdout.trim();
  log(`git exit=${git.exitCode} stdout=${JSON.stringify(gitOut)}`);
  report({ kind: 'git-version', exitCode: git.exitCode, stdout: gitOut }, 'git');
} catch (err) {
  gitErr = String(err.message || err);
  log('git rejected or failed: ' + gitErr, 'warn');
  report({ kind: 'git-version', error: gitErr }, 'git');
}

phase('Try powershell (Windows-only; will be declined if user did not check it)');
let psOut = null;
let psErr = null;
try {
  const ps = await world.run('powershell', ['-NoProfile', '-Command', 'Get-Date | Select-Object -ExpandProperty ToString'],
    { timeoutMs: 5000 });
  psOut = (ps.stdout || '').trim();
  log(`powershell exit=${ps.exitCode} stdout=${JSON.stringify(psOut)}`);
  report({ kind: 'powershell-date', exitCode: ps.exitCode, stdout: psOut }, 'powershell');
} catch (err) {
  psErr = String(err.message || err);
  log('powershell rejected or failed: ' + psErr, 'warn');
  report({ kind: 'powershell-date', error: psErr }, 'powershell');
}

phase('Done');
return {
  approved: { node: true, git: !!gitOut, powershell: !!psOut },
  errors: { git: gitErr, powershell: psErr },
};
}
