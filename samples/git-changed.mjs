// dsh-workflow-runner sample —— git.* 演示
//
// 用 git.changedFiles + git.diff + git.status + git.log 把"今天改了什么"渲染
// 成一张 markdown artifact。如果工作区根不在 git repo 里,所有 git.* 调用会
// reject catchable —— 脚本会优雅降级为"not a git repo"提示。
//
// 工作区根默认 = 脚本所在目录 = samples/(不是 git repo),所以这里默认会
// 走 catch 分支。要看真实结果,需要在 git repo 根目录跑。
//
'use strict';
const { agent, world, phase, log, report, artifact, git } = globalThis.__dsh;

export default async function main() {

phase('git.status');
let status;
try {
  status = await git.status();
  log(`branch: ${status.branch || '(detached)'} · clean: ${status.clean}`);
  log(`staged: ${status.staged.length} · unstaged: ${status.unstaged.length} · untracked: ${status.untracked.length}`);
} catch (err) {
  log('git.status failed: ' + err.message, 'warn');
  status = null;
}

phase('git.changedFiles (no base = uncommitted + untracked)');
let changed = [];
try {
  changed = await git.changedFiles();
  log(`changed files: ${changed.length}`);
} catch (err) {
  log('git.changedFiles failed: ' + err.message, 'warn');
}

phase('git.log (last 10 commits)');
let log10 = [];
try {
  log10 = await git.log(10);
  log(`commits: ${log10.length}`);
} catch (err) {
  log('git.log failed: ' + err.message, 'warn');
}

phase('git.diff for the first changed file (truncated)');
let diffSnippet = '(no diff available)';
if (changed.length > 0) {
  try {
    const full = await git.diff(undefined, changed[0]);
    diffSnippet = full.split('\n').slice(0, 30).join('\n');
    if (full.split('\n').length > 30) diffSnippet += `\n… (${full.split('\n').length - 30} more lines truncated)`;
  } catch (err) {
    diffSnippet = '(diff failed: ' + err.message + ')';
  }
}

phase('Publish a markdown report');
const lines = [
  '# Git status snapshot',
  '',
  status
    ? `* Branch: \`${status.branch || '(detached)'}\``
    : '* Branch: (not a git repository)',
  status && status.clean ? '* Working tree: clean' : '* Working tree: dirty',
  status ? `* Staged: ${status.staged.length} · Unstaged: ${status.unstaged.length} · Untracked: ${status.untracked.length}` : '',
  '',
  '## Uncommitted changes',
  '',
  changed.length > 0
    ? changed.map((p) => `- \`${p}\``).join('\n')
    : status && status.clean ? 'Working tree is clean.' : 'Not a git repository — nothing to show.',
  '',
  '## Recent commits',
  '',
  log10.length > 0
    ? log10.map((c) => `- \`${c.hash.slice(0, 7)}\` ${c.subject}  *(${c.author}, ${c.date.slice(0, 10)})*`).join('\n')
    : '(no log available)',
  '',
  changed.length > 0 ? `## Diff of first changed file (\`${changed[0]}\`)\n\n\`\`\`diff\n${diffSnippet}\n\`\`\`` : '',
  '',
];
await artifact.markdown('report', lines.filter(Boolean).join('\n'), {
  title: 'Git snapshot',
  primary: true,
});

phase('Done');
return { status, changedCount: changed.length, logCount: log10.length };
}
