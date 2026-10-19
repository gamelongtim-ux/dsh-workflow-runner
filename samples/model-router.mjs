// dsh-workflow-runner sample —— model() 多模型路由演示
//
// 模拟 ZCode §16.2 `models` 路由模式:
//   1) 一个 light-router 子代理给每个问题打"tier"标签
//   2) 路由器自身用 light model(deepseek-chat),问"这个需要 strong model 吗"
//   3) 按 tier 把问题路由到对应 model 的 answerer
//
// 因为这个环境大概率没 API key,router / answerer 都会 fail。脚本本身的设计
// 是对的:子代理的 model 字段从 model() 标记里来,host 端校验 allowlist。
// 你在有 deepseek-reasoner key 的环境里跑就能看到路由效果。
//
'use strict';
const { agent, world, phase, log, report, artifact, model, args } = globalThis.__dsh;

export default async function main() {

// 模型声明:不调用就不发请求,只是在子代理 ask 时被 host 校验
const MODELS = {
  light:  model('deepseek-chat'),
  strong: model('deepseek-chat'), // 没 reasoner key 就都用 light,演示不挂
};

phase('Declare the same artifact shape as ZCode model-router example');
artifact.table('replies', {
  title: 'Replies by tier',
  columns: [
    { field: 'question', label: 'Question' },
    { field: 'tier', label: 'Tier' },
    { field: 'model', label: 'Model' },
    { field: 'answer', label: 'Answer (preview)' },
  ],
});
artifact.metrics('counts', {
  title: 'Tier counts',
  metrics: [
    { field: 'light', label: 'Light' },
    { field: 'strong', label: 'Strong' },
    { field: 'total', label: 'Total' },
  ],
});

const questions = [
  'Rename the config key in the README',
  'Explain the retry design with backoff',
];

phase('Spawn router + answerers');
let light = 0, strong = 0;
for (let i = 0; i < questions.length; i++) {
  const q = questions[i];
  let tier = 'light';
  let routerModel = MODELS.light;
  let routerAnswer;
  try {
    // router 子代理 — 这里会因为没 API key 而 fail
    routerAnswer = await agent(`分诊-${i + 1}`, { model: routerModel })
      .ask(`Would answering this well need the strong model?\n${q}\nAnswer with JSON: {"tier":"light"|"strong"}`);
  } catch (err) {
    log('router ' + (i + 1) + ' failed: ' + err.message, 'warn');
    routerAnswer = '{"tier":"light"}';
  }
  try {
    const m = JSON.parse(routerAnswer.replace(/[^]*?(\{[^}]+\})[^]*?/, '$1'));
    if (m.tier === 'strong') tier = 'strong';
  } catch (_) { /* keep light */ }

  const chosen = MODELS[tier];
  let answerText = '';
  try {
    // dsh-workflow-runner returns {content, usage}; older runtimes may have
    // returned the raw string. Normalize so the report row is always a string.
    const resp = await agent(`答复者-${i + 1}`, { model: chosen }).ask(q);
    answerText = typeof resp === 'string' ? resp : (resp && resp.content) || '';
  } catch (err) {
    log('answerer ' + (i + 1) + ' failed: ' + err.message, 'warn');
    answerText = '(no LLM available)';
  }
  if (tier === 'strong') strong++; else light++;
  report({ question: q, tier, model: chosen.id, answer: answerText.slice(0, 200) }, 'replies');
  log(`Q${i + 1} routed to ${tier}`);
}

phase('Push counts');
report({ light, strong, total: light + strong }, 'counts');

phase('Done');
log(`model-router demo complete: ${light} light, ${strong} strong`);
return { light, strong, total: light + strong };
}
