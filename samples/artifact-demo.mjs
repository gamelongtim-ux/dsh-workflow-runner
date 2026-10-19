// dsh-workflow-runner sample —— artifact 体系演示
//
// 不需要 LLM,纯 world.run + artifact。展示四件事:
//   1) artifact.chart 声明 + report(item, 'chart-id') 喂数据 → 折线图
//   2) artifact.metrics 声明 + report 喂数据 → 数字 tile
//   3) artifact.markdown(id, content, opts) → 产物页
//   4) artifact.board 声明 + report 喂数据 → 看板
//
// 跑法:编辑器里点 Run。无 world.run 的 shell 命令,不会触发 confirm 弹窗。
//
'use strict';
const { agent, world, phase, log, report, artifact } = globalThis.__dsh;

export default async function main() {
// 1) Declare: 一个 latency 折线图,X=round,Y=ms
artifact.chart('latency', {
  title: 'Round-trip latency (ms)',
  x: { field: 'round', label: 'Round' },
  y: { field: 'ms', label: 'ms' },
  type: 'line',
});

// 1) Declare: 一个总览 metrics tile
artifact.metrics('overview', {
  title: 'Overview',
  metrics: [
    { field: 'rounds', label: 'Rounds' },
    { field: 'totalMs', label: 'Total ms' },
    { field: 'bestMs', label: 'Best ms' },
  ],
});

// 4) Declare: 一个 kanban board(初始列: queued / done)
artifact.board('candidates', {
  title: 'Candidates',
  key: 'name',
  status: 'status',
  columns: ['queued', 'done'],
});

phase('Set up: enqueue two candidates');
report({ name: 'alpha', status: 'queued' }, 'candidates');
report({ name: 'beta', status: 'queued' }, 'candidates');
log('two candidates queued');

phase('Run three rounds: world.run + report latency');
let totalMs = 0;
let bestMs = Number.POSITIVE_INFINITY;
const samples = [];
for (let round = 1; round <= 3; round++) {
  const r = await world.run('node', ['-e',
    'const ms = 80 + Math.floor(Math.random() * 60); setTimeout(() => process.stdout.write(String(ms)), ms);',
  ], { timeoutMs: 5000 });
  const ms = Number(r.stdout || '0');
  totalMs += ms;
  if (ms < bestMs) bestMs = ms;
  samples.push({ round, ms });
  log(`round ${round}: ${ms}ms (exit ${r.exitCode})`);
  report({ round, ms }, 'latency');
}

phase('Promote alpha to done');
// We push a fresh row keyed by 'name' so the board shows alpha as a
// different card (a later item with the same `key` replaces the row in
// ZCode's table/board spec).
report({ name: 'alpha', status: 'done' }, 'candidates');
log('alpha moved to done');

phase('Push overview metrics');
report({ rounds: 3, totalMs, bestMs }, 'overview');

phase('Publish final markdown report');
const md = [
  '# Artifact demo run',
  '',
  'Three rounds of `world.run`, each emitting a latency sample. The chart',
  'tab shows them as a line; the overview tile shows the totals.',
  '',
  `* Rounds: 3`,
  `* Total: ${totalMs} ms`,
  `* Best: ${bestMs} ms`,
  '',
  '## Per-round samples',
  '',
  ...samples.map((s) => `- round ${s.round}: **${s.ms} ms**`),
  '',
].join('\n');
await artifact.markdown('report', md, { title: 'Demo report', primary: true });

phase('Done');
log('artifact demo complete');
return { rounds: 3, totalMs, bestMs, samples };
}
