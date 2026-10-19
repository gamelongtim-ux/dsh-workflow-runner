// dsh-workflow-runner sample —— askUser() 中途问用户演示
//
// 脚本会停在 await askUser(...) 上,等用户在 UI 里填一个选项或自由文本。
// 走通流程:弹一个三选一问题(选 threshold),然后弹一个 confirm 确认。
// 不需要 LLM。
//
// 跑法:点 Run → UI 出现 Pending questions 卡 → 选完一项 → 下一项出现 → 选完 →
// 脚本完成。
//
'use strict';
const { phase, log, report, artifact, askUser } = globalThis.__dsh;

export default async function main() {

phase('Ask user which threshold to use');
const threshold = await askUser(
  'What threshold should we use for the score gate?',
  { options: ['90', '95', '100'] },
);
log(`user picked threshold: ${threshold}`);
report({ step: 'pick-threshold', value: threshold }, 'answers');

phase('Ask user to confirm before proceeding');
const ok = await askUser(
  `Apply threshold ${threshold} and continue?`,
  { kind: 'confirm' },
);
log(`user confirm: ${ok}`);
report({ step: 'confirm', value: ok }, 'answers');

if (!ok) {
  phase('User declined — exit early');
  return { ok: false, threshold, reason: 'user declined' };
}

phase('Ask user for a free-text note (no options)');
const note = await askUser(
  'Optional: any free-text note for the report? (empty to skip)',
);
log(`user note: ${JSON.stringify(note)}`);

phase('Publish a markdown report of the answers');
const md = [
  '# User-driven run report',
  '',
  `* Threshold picked: \`${threshold}\``,
  `* Confirmed: ${ok}`,
  `* Note: ${note && note.length > 0 ? note : '_(none)_'}`,
  '',
].join('\n');
await artifact.markdown('report', md, { title: 'User answers', primary: true });

phase('Done');
return { ok: true, threshold, confirmed: ok, note };
}
