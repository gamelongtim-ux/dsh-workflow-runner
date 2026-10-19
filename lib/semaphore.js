// dsh-workflow-runner —— 并发信号量。
//
// v0.12.0 引入:`Config.concurrency.maxConcurrent` 是「一个 run 里最多同时
// 有多少个 agent.ask 在飞」的用户上限。超过上限的 ask 排队等空位,而不是
// 一起打出去把 provider 打爆。
//
// 设计要点:
//   - limit 可变。v0.13.0 的 adaptive fan-out 要在运行中收紧/放宽上限,
//     所以这里不是固定值,而是 setter 可改 + 改完立刻唤醒排队者。
//   - 槽位是「交接」而不是「释放后再抢」。release() 把槽位直接交给下一个
//     等待者,active 计数在交接瞬间就转移,避免交接窗口里被第三个调用
//     插队(那会让 active 短暂超过 limit)。
//   - acquire() 返回一个幂等的 release 函数,调用方用 try/finally 释放。
//     幂等很重要:同一段代码里嵌套的 finally 可能重复释放。
//
// 独立成文件而不是塞进 runtime.js,是为了能单独 unit test —— 信号量是
// v0.12.0 三个特性里唯一一个「加了一层就会引入新故障面」的部件。
'use strict';

/** 归一化上限:非有限数 / <1 一律当 1,避免 0 造成死等。 */
function normalizeLimit(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 1) return 1;
  return Math.floor(v);
}

export function createSemaphore(initialLimit) {
  let limit = normalizeLimit(initialLimit);
  const waiters = [];   // FIFO:resolve 数组
  let active = 0;
  let peak = 0;
  let totalAcquired = 0;
  let totalWaitMs = 0;

  /** 上限提高后,立刻把空出来的槽位分给排队者,别让它们白等。 */
  function drainWaiters() {
    while (waiters.length > 0 && active < limit) {
      active += 1;
      const next = waiters.shift();
      next();
    }
  }

  function release() {
    active -= 1;
    if (waiters.length > 0) {
      // 槽位直接交接:active 已在交接瞬间转移给等待者。
      active += 1;
      waiters.shift()();
    }
  }

  return {
    get limit() { return limit; },
    /** 改上限。放宽时立即唤醒排队者;收紧时不会打断已持有的槽位。 */
    set limit(n) {
      limit = normalizeLimit(n);
      drainWaiters();
    },
    get active() { return active; },
    get peak() { return peak; },
    get waiting() { return waiters.length; },
    get totalAcquired() { return totalAcquired; },
    get totalWaitMs() { return totalWaitMs; },

    /**
     * 占用一个槽位。resolve 时返回幂等的 release 函数。
     * @returns {Promise<() => void>}
     */
    async acquire() {
      const t0 = Date.now();
      if (active < limit) {
        active += 1;
      } else {
        await new Promise((resolve) => waiters.push(resolve));
        // 槽位在 release() 里就已经交接过来了,这里不能再 +1,
        // 否则 active 会短暂超过 limit。
      }
      totalAcquired += 1;
      totalWaitMs += Date.now() - t0;
      if (active > peak) peak = active;
      let released = false;
      return function releaseOnce() {
        if (released) return;
        released = true;
        release();
      };
    },
  };
}

export default createSemaphore;
