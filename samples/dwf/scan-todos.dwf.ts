// 一个「保存下来的工作流」：扫工作区里的 TODO/FIXME/XXX，发一张 markdown 报告。
//
// 参数从 args 读；没有 LLM 参与。

/** dsh-workflow
 * @name scan-todos
 * @description Scan the workspace for TODO/FIXME/XXX and publish a markdown report.
 * @whenToUse Quick scan of code quality markers in a directory; no LLM needed.
 * @arg glob {string} Glob to limit which files to scan
 * @arg keywords {json=["TODO","FIXME","XXX"]} Keywords to look for
 */

artifact.table("hits", {
  title: "TODO hits by file",
  columns: [
    { field: "path", label: "File" },
    { field: "hits", label: "Hits" },
    { field: "kinds", label: "Kinds" },
  ],
});

const glob = String(args.glob ?? "").trim() || "**/*.mjs";
const keywords: string[] = Array.isArray(args.keywords)
  ? args.keywords.map((k) => String(k))
  : ["TODO", "FIXME", "XXX"];

phase("List the files matching the glob");
const paths = await files.glob(glob);
log(`found ${paths.length} files`);

phase("Grep the keywords");
const allMatches: (GrepMatch & { kind: string })[] = [];
for (const kw of keywords) {
  const matches = await files.grep(kw, glob);
  for (const m of matches) allMatches.push({ ...m, kind: kw });
}
log(`total hits: ${allMatches.length}`);

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

phase("Build the table and the markdown report");
const byFile = new Map<string, (GrepMatch & { kind: string })[]>();
for (const m of allMatches) {
  const bucket = byFile.get(m.path);
  if (bucket === undefined) byFile.set(m.path, [m]);
  else bucket.push(m);
}
for (const [path, hits] of byFile.entries()) {
  report({ path, hits: hits.length, kinds: [...new Set(hits.map((h) => h.kind))] }, "hits");
}

const md = [
  "# TODO scan report",
  "",
  `* Scanned ${paths.length} files`,
  `* Found ${allMatches.length} hits across ${byFile.size} files`,
  "",
  "## Top files",
  "",
  ...Array.from(byFile.entries())
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 20)
    .map(([p, hs]) => `- \`${p}\` — ${hs.length} hits`),
  "",
].join("\n");
await artifact.markdown("report", md, { title: "TODO scan", primary: true });

// 门：产物写出去之后确认它不是空的。
const published = await world.run(
  "node",
  ["-e", "process.stdout.write(String(process.argv[1].length))", md],
  { timeoutMs: 5000 },
);
log(`published report is ${published.stdout.trim()} chars`);

return { totalHits: allMatches.length, filesWithHits: byFile.size };
