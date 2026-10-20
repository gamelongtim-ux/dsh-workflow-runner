// channel 死锁演示：producer 发完就结束，却**不** close(channel)。
//
// 死锁是 fail，不是 stall：run 应当以 status=error + [ChannelDeadlock] 结束，而不是挂到 watchdog。
//
// 两种收尾的区别：
//   - close() 时还有 consumer 在等 → 这是**正常**的收尾路径。close() 就是 producer 用来收束
//     consumer 的 `for await (const x of ch)` 的那个信号。
//   - producer 已经结束却没有 close channel → consumer 永远等不到东西，这就是死锁。
//
// 所以这个 sample 造的是**后者**：producer future 干完活直接返回，consumer 停在 for-await 里。

const ch = channel<{ fact: string }>("trickle");

phase("Set up a producer that never closes its channel");

const producer = future(async () => {
  ch.send({ fact: "only-one" });
  // 故意不 close：这就是死锁的成因。
});

const consumer = future(async () => {
  const seen: { fact: string }[] = [];
  for await (const item of ch) {
    seen.push(item);
  }
  return seen;
});

phase("Wait for the producer to finish (the consumer will block)");
await producer;

// consumer 还在等。检测器应该已经把 run 标成 error，宿主会及时收尾。
// 这里再等一下 consumer，让宿主有时间处理。
await consumer.catch(() => {});

phase("Done");
log("channel-deadlock sample finished");
report({ producerFinished: true, consumerResolved: true });
return { ok: true };
