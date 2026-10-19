// dsh-workflow-runner sample —— phase 折叠演示
//
// 在循环里反复调用同名 phase,UI 应该只看到一个 pill,带 ×N 角标(像 ZCode
// dynamic-workflows 的 phase 图那样)。这里用 5 轮 `phase("check")` 来演示。
//
// 没有 LLM 调用、没有 world.run,所以没有 confirm 弹窗,点 Run 直接跑。
//
'use strict';
const { agent, world, phase, log, report } = globalThis.__dsh;

export default async function main() {
phase('init');
log('about to run 5 rounds of "check" — UI should fold to one pill');

const checks = [];
for (let i = 1; i <= 5; i++) {
  phase('check');
  // Make each "check" a tiny thing so the run finishes in seconds.
  const r = await world.run('node', ['-e',
    `process.stdout.write("round ${i} ok\\n");`,
  ], { timeoutMs: 5000 });
  log(`round ${i}: ${r.stdout.trim()}`);
  checks.push({ round: i, ok: r.exitCode === 0 });
  report({ round: i, ok: r.exitCode === 0 }, 'check');
}

phase('summary');
report({ total: checks.length, allOk: checks.every((c) => c.ok) }, 'summary');

phase('Done');
log('phase folding demo complete');
return { rounds: checks.length, allOk: checks.every((c) => c.ok) };
}
