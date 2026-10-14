// dsh-workflow-runner sample —— 不调用 LLM 的最小烟雾测试
//
// 只验证：phase / log / report / world.run 是否能正常经过 RPC。
// 用于在没有 API key 的环境下确认管道通畅。
//
// 用户脚本约定：默认导出 async function main()，所有逻辑放函数体内。
// 顶层 await 也被支持（动态 import 会等待），但顶层 return 不行（ESM 语法）。
//
'use strict';
const { agent, world, phase, log, report } = globalThis.__dsh;

export default async function main() {
  phase('Smoke: phase tracking');
  log('phase() event sent');

  phase('Smoke: world.run echoes');
  const echo = await world.run('node', ['-e', 'process.stdout.write("hello from world.run\\n")'], { timeoutMs: 5000 });
  if (echo.exitCode !== 0) {
    log('echo failed: ' + echo.stderr, 'warn');
  } else {
    log('echo out: ' + echo.stdout.trim());
    report({ echo: echo.stdout.trim(), exitCode: echo.exitCode, durationMs: echo.durationMs }, 'echo');
  }

  phase('Smoke: failed shell command');
  const bad = await world.run('node', ['-e', 'process.exit(7)'], { timeoutMs: 5000 })
    .catch((err) => ({ exitCode: -1, error: String(err.message || err) }));
  log(`bad exitCode=${bad.exitCode} error=${bad.error || ''}`);
  report({ bad }, 'bad');

  phase('Smoke: report a structured item');
  report({ name: 'smoke', ok: true, n: 42, items: [1, 2, 3] }, 'summary');

  phase('Done');
  log('smoke complete');
  return { ranAt: new Date().toISOString() };
}
