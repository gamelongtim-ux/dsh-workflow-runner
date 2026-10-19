// dsh-workflow-runner sample —— max_concurrency 上限(v0.12.0)
//
// 这个 sample 演示 `Config.concurrency.maxConcurrent`:一个 run 里最多同时
// 有多少个 `agent.ask` 在飞,超出的排队等空位,而不是一起打出去。
//
// 零 API key 也能跑:`agent.ask` 在没有 key 时会立刻失败,但**排队语义照样
// 成立** —— 上限是在发请求之前拿的槽,跟请求本身成不成功无关。所以这个
// sample 拿宿主的权威数字(`__dsh.concurrency.stat()`)来观察上限,不需要
// 真的调通 LLM。
//
// 跑法:
//
//   POST /api/run { scriptPath: <this>, maxConcurrency: 2 }
//   → report 里 hostPeakConcurrency 应该是 2(而不是 8)
//
// 想看真 LLM 下的时间差(2 个一批 → 4 批),配上 key 再跑一次即可。
'use strict';
const { phase, log, report, agent } = globalThis.__dsh;

const TOTAL_ASKS = 8;

export default async function main() {
  phase(`Launch ${TOTAL_ASKS} concurrent asks`);

  // 每个 ask 自己记下「进入 ask 前」和「拿到结果后」的时间戳。
  // 上限是 2 的话,任意时刻最多 2 个 ask 处在「已进入、未返回」区间里。
  const started = [];
  const finished = [];

  const jobs = Array.from({ length: TOTAL_ASKS }, (_, i) => (async () => {
    started.push({ i, at: Date.now() });
    try {
      await agent(`worker-${i}`).ask(`Reply with exactly the digit ${i} and nothing else.`);
    } catch (_) {
      // 没有 API key 时 ask 会失败 —— 这不影响并发上限的演示,
      // 槽位在发请求之前就已经拿到了。
    }
    finished.push({ i, at: Date.now() });
  })());

  await Promise.all(jobs);

  phase('Reconstruct the timeline');
  // 客户端自己算的「同时在飞」是**高估**的:ask 等槽位的时间也算在里面,
  // 而槽位持有时间才是真正打到 provider 的并发数。权威数字在宿主那边,
  // 通过 `__dsh.concurrency.stat()` 拿。
  const host = globalThis.__dsh.concurrency ? await globalThis.__dsh.concurrency.stat() : null;

  const first = Math.min(...started.map((s) => s.at));
  const last = Math.max(...finished.map((f) => f.at));

  report({
    totalAsks: TOTAL_ASKS,
    limit: host ? host.limit : null,
    hostPeakConcurrency: host ? host.peak : null,
    hostTotalAcquired: host ? host.totalAcquired : null,
    clientSpanMs: last - first,
    askedAt: started.map((s) => s.at - first),
    finishedAt: finished.map((f) => f.at - first),
  }, 'concurrency');

  log(`limit=${host ? host.limit : '?'} host peak concurrency=${host ? host.peak : '?'} ` +
    `over ${TOTAL_ASKS} asks in ${last - first}ms`);
  phase('Done');
  return { totalAsks: TOTAL_ASKS, limit: host ? host.limit : null, hostPeak: host ? host.peak : null };
}
