// dsh-workflow-runner sample —— files.{glob,read,grep} 演示
//
// 找当前目录(含子目录)里的 TODO/FIXME 注释,用 files.grep 走,再把结果
// 渲染成一张 markdown artifact。没有 LLM 调用,没有 world.run,无 API key 即可跑。
//
// 工作区根 = 脚本所在目录(即 samples/),所以这里实际上是在 samples/ 里搜
// .mjs 里的 TODO。打开编辑器点 Run 看。
//
'use strict';
const { agent, world, phase, log, report, artifact, files, args } = globalThis.__dsh;

export default async function main() {

phase('List mjs files in workspace');
const paths = await files.glob('**/*.mjs');
log(`found ${paths.length} mjs files under workspace`);

phase('Grep for TODO / FIXME / XXX in those files');
const allMatches = [];
for (const scope of ['TODO', 'FIXME', 'XXX']) {
  // One files.grep call per keyword; the host enforces caps.
  const matches = await files.grep(scope, '**/*.mjs');
  log(`${scope}: ${matches.length} hits`);
  for (const m of matches) {
    allMatches.push({ ...m, kind: scope });
  }
}

phase('Group by file');
const byFile = new Map();
for (const m of allMatches) {
  if (!byFile.has(m.path)) byFile.set(m.path, []);
  byFile.get(m.path).push(m);
}
const summary = Array.from(byFile.entries())
  .map(([path, hits]) => ({ path, hits: hits.length, kinds: [...new Set(hits.map((h) => h.kind))] }))
  .sort((a, b) => b.hits - a.hits);

phase('Declare a table artifact for the per-file rollup');
artifact.table('hits', {
  title: 'TODO/FIXME/XXX hits by file',
  columns: [
    { field: 'path', label: 'File' },
    { field: 'hits', label: 'Hits' },
    { field: 'kinds', label: 'Kinds' },
  ],
});
for (const row of summary) {
  report(row, 'hits');
}

phase('Publish a markdown report as the primary deliverable');
const lines = [
  '# TODO scan',
  '',
  `* Scanned ${paths.length} files under workspace`,
  `* Found ${allMatches.length} TODO/FIXME/XXX hits in ${byFile.size} files`,
  '',
  '## Files with hits (top 20)',
  '',
  ...summary.slice(0, 20).map((s) => `- \`${s.path}\` — ${s.hits} (${s.kinds.join(', ')})`),
  '',
  '## All hits (raw)',
  '',
  ...allMatches.slice(0, 50).map((m) => `- **${m.kind}** ${m.path}:${m.line} — \`${m.text.trim().slice(0, 100)}\``),
  '',
  summary.length > 20 ? `\n…and ${summary.length - 20} more files.\n` : '',
];
const md = lines.join('\n');
await artifact.markdown('report', md, { title: 'TODO scan report', primary: true });

phase('Done');
log(`file-grep demo complete: ${allMatches.length} hits across ${byFile.size} files`);
return { totalHits: allMatches.length, filesWithHits: byFile.size, totalFiles: paths.length };
}
