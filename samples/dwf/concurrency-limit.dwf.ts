// 并发上限：一个 run 里最多同时有多少个 ask 在飞，超出的排队等空位，而不是一起打出去。
//
// 上限的权威数字在宿主那边（concurrency.stat()）：脚本自己算的「同时在飞」是高估的——
// 等空位的时间也算在里面，而槽位持有时间才是真正打到 provider 的并发数。

const TOTAL_ASKS = 8;

artifact.metrics("concurrency", {
  title: "并发上限的宿主视角",
  metrics: [
    { field: "limit", label: "Limit" },
    { field: "hostPeakConcurrency", label: "Peak" },
    { field: "hostTotalAcquired", label: "Slots taken" },
  ],
});

phase("Launch 8 concurrent asks");

// 上限是 2 的话，任意时刻最多 2 个 ask 处在「已进入、未返回」的区间里。
const jobs = Array.from({ length: TOTAL_ASKS }, (_, i) =>
  (async () => {
    try {
      await agent(`worker-${i}`).ask(`Reply with exactly the digit ${i} and nothing else.`);
    } catch (_) {
      // 没有 API key 时 ask 会失败——这不影响并发上限的演示：
      // 槽位在发请求之前就已经拿到了。
    }
  })(),
);

await Promise.all(jobs);

phase("Read the host's authoritative concurrency numbers");

const limits = await concurrency.stat();

log(
  `limit=${limits.limit} host peak concurrency=${limits.peak} ` +
    `over ${TOTAL_ASKS} asks`,
);

report({
  totalAsks: TOTAL_ASKS,
  limit: limits.limit,
  hostPeakConcurrency: limits.peak,
  hostTotalAcquired: limits.totalAcquired,
}, "concurrency");

return { totalAsks: TOTAL_ASKS, limit: limits.limit, hostPeak: limits.peak };
