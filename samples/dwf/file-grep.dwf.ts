// files.{glob,read,grep} 演示：在工作区里找 TODO/FIXME/XXX 注释，再渲染成一张 markdown 产物。
//
// 没有 LLM 调用，无 API key 即可跑。工作区根是仓库根，所以下面这个 glob 扫的是整个仓库。

artifact.table("hits", {
  title: "TODO/FIXME/XXX hits by file",
  columns: [
    { field: "path", label: "File" },
    { field: "hits", label: "Hits" },
    { field: "kinds", label: "Kinds" },
  ],
});

phase("List mjs files in the workspace");
const paths = await files.glob("**/*.mjs");
log(`found ${paths.length} mjs files under workspace`);

phase("Grep for TODO / FIXME / XXX in those files");
const allMatches: (GrepMatch & { kind: string })[] = [];
for (const scope of ["TODO", "FIXME", "XXX"]) {
  // 一次 files.grep 一个关键词；上限由宿主执行。
  const matches = await files.grep(scope, "**/*.mjs");
  log(`${scope}: ${matches.length} hits`);
  for (const m of matches) {
    allMatches.push({ ...m, kind: scope });
  }
}

// 门：把命中的行交给 shell 数一遍字，验证读到的内容不是空的。
const gate = await world.run(
  "node",
  [
    "-e",
    "process.stdout.write(String(process.argv[1].split(/\\s+/).filter(Boolean).length))",
    allMatches.map((m) => m.text).join(" "),
  ],
  { timeoutMs: 5000 },
);
log(`the shell counted ${gate.stdout.trim()} words across ${allMatches.length} hits`);

phase("Group by file and publish the report");
const byFile = new Map<string, (GrepMatch & { kind: string })[]>();
for (const m of allMatches) {
  const bucket = byFile.get(m.path);
  if (bucket === undefined) byFile.set(m.path, [m]);
  else bucket.push(m);
}
const summary = Array.from(byFile.entries())
  .map(([path, hits]) => ({
    path,
    hits: hits.length,
    kinds: [...new Set(hits.map((h) => h.kind))],
  }))
  .sort((a, b) => b.hits - a.hits);

for (const row of summary) {
  report(row, "hits");
}

const lines = [
  "# TODO scan",
  "",
  `* Scanned ${paths.length} files under workspace`,
  `* Found ${allMatches.length} TODO/FIXME/XXX hits in ${byFile.size} files`,
  "",
  "## Files with hits (top 20)",
  "",
  ...summary.slice(0, 20).map((s) => `- \`${s.path}\` — ${s.hits} (${s.kinds.join(", ")})`),
  "",
  "## All hits (raw)",
  "",
  ...allMatches.slice(0, 50).map((m) => `- **${m.kind}** ${m.path}:${m.line} — \`${m.text.trim().slice(0, 100)}\``),
  "",
  summary.length > 20 ? `\n…and ${summary.length - 20} more files.\n` : "",
];
const md = lines.join("\n");
await artifact.markdown("report", md, { title: "TODO scan report", primary: true });

// 门：产物写出去之后确认它不是空的。
const published = await world.run(
  "node",
  ["-e", "process.stdout.write(String(process.argv[1].length))", md],
  { timeoutMs: 5000 },
);
log(`published report is ${published.stdout.trim()} chars`);

log(`file-grep demo complete: ${allMatches.length} hits across ${byFile.size} files`);
return { totalHits: allMatches.length, filesWithHits: byFile.size, totalFiles: paths.length };
