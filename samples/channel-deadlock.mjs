// dsh-workflow-runner sample —— channel 死锁检测(v0.12.0)
//
// ZCode §16.3:「channel deadlock 是 fail,不是 stall」。v0.12.0 让死锁
// 变成一次明确的失败,而不是把 run 挂到 30 分钟 watchdog。
//
// 关键:什么才算死锁?
//
//   ✗ close() 时还有 consumer 在等 —— 这是**正常**的收尾路径。
//     close() 就是 producer 用来放走 consumer 的;`for await (const x of ch)`
//     靠 close 结束。把它当死锁会毁掉每一个正确的 pipeline。
//
//   ✓ producer 已经结束(future settle 了)却没 close channel,而
//     consumer 还阻塞在上面 —— 没人会再 send,也没人会再 close,
//     consumer 永远醒不过来。这才是死锁。
//
// 所以这个 sample 造的是**后者**:producer future 干完活直接返回,
// 不 close;consumer 在 for-await 里等。两边都跑,run 必须以
// `status=error` + `[ChannelDeadlock]` 结束,而不是挂死。
//
// 对照组是 `samples/channel-pipeline.mjs` —— 那个是**正确**写法
// (producer 在 finally 里 close),v0.12.0 之后它依然正常通过。
'use strict';
const { phase, log, report, channel, future } = globalThis.__dsh;

export default async function main() {
  phase('Set up a producer that never closes its channel');

  const ch = channel('trickle');

  // producer:送一条,然后**不 close** 就结束。
  const producer = future(async () => {
    ch.send({ fact: 'only-one' });
    // 故意不 close —— 这就是死锁的成因。
  });

  // consumer:正常写法会一直等下去。
  const consumer = future(async () => {
    const seen = [];
    for await (const item of ch) {
      seen.push(item);
    }
    return seen;
  });

  phase('Wait for the producer to finish (the consumer will block)');
  await producer;

  // consumer 还在等。检测器应该已经报了死锁,宿主会把 run 标成 error。
  // 这里再等一下 consumer,好让宿主有时间处理。
  await consumer.catch(() => {});

  phase('Done');
  log('channel-deadlock sample finished');
  report({ producerFinished: true, consumerResolved: true }, 'deadlock');
  return { ok: true };
}
