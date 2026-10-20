// git.* 演示：用 git.changedFiles + git.diff + git.status + git.log 把「今天改了什么」
// 渲染成一张 markdown 产物。
//
// 所有 git.* 调用都在工作区里读，只读不写；工作区不在 git repo 里时它们会可捕获地 reject，
// 脚本于是优雅降级为「not a git repo」提示。

phase("git.status");
let status: GitStatus | undefined;
try {
  status = await git.status();
  log(`branch: ${status.branch || "(detached)"} · clean: ${status.clean}`);
  log(
    `staged: ${status.staged.length} · unstaged: ${status.unstaged.length} ` +
      `· untracked: ${status.untracked.length}`,
  );
} catch (err) {
  log("git.status failed: " + String((err as Error).message));
  status = undefined;
}

phase("git.changedFiles (no base = uncommitted + untracked)");
let changed: string[] = [];
try {
  changed = await git.changedFiles();
  log(`changed files: ${changed.length}`);
} catch (err) {
  log("git.changedFiles failed: " + String((err as Error).message));
}

phase("git.log (last 10 commits)");
let commits: GitCommit[] = [];
try {
  commits = await git.log(10);
  log(`commits: ${commits.length}`);
} catch (err) {
  log("git.log failed: " + String((err as Error).message));
}

phase("git.diff for the first changed file (truncated)");
let diffSnippet = "(no diff available)";
if (changed.length > 0) {
  try {
    const full = await git.diff(undefined, changed[0]);
    diffSnippet = full.split("\n").slice(0, 30).join("\n");
    if (full.split("\n").length > 30) {
      diffSnippet += `\n… (${full.split("\n").length - 30} more lines truncated)`;
    }
  } catch (err) {
    diffSnippet = "(diff failed: " + String((err as Error).message) + ")";
  }
}

phase("Publish a markdown report");
const lines = [
  "# Git status snapshot",
  "",
  status ? `* Branch: \`${status.branch || "(detached)"}\`` : "* Branch: (not a git repository)",
  status && status.clean ? "* Working tree: clean" : "* Working tree: dirty",
  status
    ? `* Staged: ${status.staged.length} · Unstaged: ${status.unstaged.length} · Untracked: ${status.untracked.length}`
    : "",
  "",
  "## Uncommitted changes",
  "",
  changed.length > 0
    ? changed.map((p) => `- \`${p}\``).join("\n")
    : status && status.clean
      ? "Working tree is clean."
      : "Not a git repository — nothing to show.",
  "",
  "## Recent commits",
  "",
  commits.length > 0
    ? commits
        .map((c) => `- \`${c.hash.slice(0, 7)}\` ${c.subject}  *(${c.author}, ${c.date.slice(0, 10)})*`)
        .join("\n")
    : "(no log available)",
  "",
  changed.length > 0 ? `## Diff of first changed file (\`${changed[0]}\`)\n\n\`\`\`diff\n${diffSnippet}\n\`\`\`` : "",
  "",
];
const md = lines.filter(Boolean).join("\n");
await artifact.markdown("report", md, { title: "Git snapshot", primary: true });

// 门：产物写出去之后确认它不是空的。
const gate = await world.run(
  "node",
  ["-e", "process.stdout.write(String(process.argv[1].length))", md],
  { timeoutMs: 5000 },
);
log(`published report is ${gate.stdout.trim()} chars`);

return { status, changedCount: changed.length, logCount: commits.length };
