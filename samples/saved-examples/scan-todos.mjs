/** dsh-workflow
 * @name scan-todos
 * @description Scan the workspace for TODO/FIXME/XXX and publish a markdown report.
 * @whenToUse Quick scan of code quality markers in a directory; no LLM needed.
 * @arg glob {string} Glob to limit which files to scan
 * @arg keywords {json=["TODO","FIXME","XXX"]} Keywords to look for
 */
'use strict';
const { phase, log, report, artifact, files, args } = globalThis.__dsh;

export default async function main() {
  const glob = String(args.glob || '**/*.mjs');
  const keywords = Array.isArray(args.keywords) ? args.keywords : ['TODO', 'FIXME', 'XXX'];

  phase(`List files matching ${glob}`);
  const paths = await files.glob(glob);
  log(`found ${paths.length} files`);

  phase('Grep keywords');
  const allMatches = [];
  for (const kw of keywords) {
    const matches = await files.grep(kw, glob);
    for (const m of matches) allMatches.push({ ...m, kind: kw });
  }
  log(`total hits: ${allMatches.length}`);

  phase('Build table + markdown report');
  artifact.table('hits', {
    title: 'TODO hits by file',
    columns: [
      { field: 'path', label: 'File' },
      { field: 'hits', label: 'Hits' },
      { field: 'kinds', label: 'Kinds' },
    ],
  });
  const byFile = new Map();
  for (const m of allMatches) {
    if (!byFile.has(m.path)) byFile.set(m.path, []);
    byFile.get(m.path).push(m);
  }
  for (const [path, hits] of byFile.entries()) {
    report({ path, hits: hits.length, kinds: [...new Set(hits.map((h) => h.kind))] }, 'hits');
  }

  const md = [
    '# TODO scan report',
    '',
    `* Scanned ${paths.length} files`,
    `* Found ${allMatches.length} hits across ${byFile.size} files`,
    '',
    '## Top files',
    '',
    ...Array.from(byFile.entries())
      .sort((a, b) => b[1].length - a[1].length)
      .slice(0, 20)
      .map(([p, hs]) => `- \`${p}\` — ${hs.length} hits`),
    '',
  ].join('\n');
  await artifact.markdown('report', md, { title: 'TODO scan', primary: true });

  return { totalHits: allMatches.length, filesWithHits: byFile.size };
}
