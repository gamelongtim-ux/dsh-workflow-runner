// Adversarial check: the process-level concurrency governor.
//
// Upstream's engine does not own the concurrency decision. It admits at
// most `caps.maxConcurrency` live asks, and the ADMISSION of individual
// model requests beneath that belongs to a governor: a per-provider-key
// AIMD state machine that shrinks the cap when the provider throttles and
// grows it back when the provider proves the higher level works.
//
// The controller itself is upstream's, vendored unmodified. This checks
// the part around it: the classification of a failure, the sharing of the
// state across runs, and the fact that a throttle moves the cap while a
// transient failure does not.
//
// Usage: node scripts/dwf-governor-check.mjs

import { ConcurrencyGovernor, classifyModelFailure } from '../lib/dwf/governor.js';

let failures = 0;
function check(label, ok, detail = '') {
  if (!ok) failures += 1;
  process.stdout.write(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? `  — ${detail}` : ''}\n`);
}

console.log('\n1. a throttle is told apart from a transient failure');
{
  check('429 is a throttle', classifyModelFailure({ status: 429 }).throttled === true);
  check('429 is "rate_limited"', classifyModelFailure({ status: 429 }).reason === 'rate_limited');
  check('503 is a throttle', classifyModelFailure({ status: 503 }).throttled === true);
  check('500 is not', classifyModelFailure({ status: 500 }).throttled === false);
  check('a timeout is not', classifyModelFailure({ code: 'TIMEOUT' }).throttled === false);
  check(
    'the Retry-After is carried through',
    classifyModelFailure({ status: 429, retryAfterMs: 2500 }).retryAfterMs === 2500,
  );
  check('a non-error is not', classifyModelFailure(null).throttled === false);
}

console.log('\n2. a throttle lowers the cap, and a transient failure does not');
{
  const g = new ConcurrencyGovernor({ initial: 8 });
  const key = 'deepseek/deepseek-chat';
  check('the cap starts at the initial concurrency', g.cap(key) === 8, `cap=${g.cap(key)}`);

  const changes = g.throttled(key, 1000, 'r1', { reason: 'rate_limited' });
  check('the throttle reports a change', changes.length === 1, JSON.stringify(changes));
  check('the change names the reason', changes[0]?.reason === 'rate_limited');
  check('the cap came down', g.cap(key) === 6, `cap=${g.cap(key)}`);

  const before = g.cap(key);
  g.failedTransient(key, 1100, 'r2');
  check('a transient failure leaves the cap alone', g.cap(key) === before, `cap=${g.cap(key)}`);
}

console.log('\n3. the cap is SHARED across runs — it is process-level');
{
  // Two "runs" against the same provider key. The provider's rate limit
  // is one limit, so the learned cap has to be one cap.
  const g = new ConcurrencyGovernor({ initial: 8 });
  const key = 'deepseek/deepseek-chat';
  g.throttled(key, 1000, 'runA-request', { reason: 'rate_limited' });
  check('the first run lowered the cap', g.cap(key) === 6, `cap=${g.cap(key)}`);
  // A second run, same key: it starts from the LEARNED cap, not the initial.
  check('the second run inherits the learned cap', g.cap(key) === 6, `cap=${g.cap(key)}`);

  // A DIFFERENT key is a different provider limit: it starts fresh.
  const other = 'deepseek/deepseek-reasoner';
  check('a different key starts at its own initial', g.cap(other) === 8, `cap=${g.cap(other)}`);
}

console.log('\n4. the cap grows back, but only on proven success AND demand');
{
  const g = new ConcurrencyGovernor({ initial: 8 });
  const key = 'deepseek/deepseek-chat';

  // Four successes, no waiters: the streak is recorded but there is no
  // demand, so the cap does not grow.
  for (let i = 0; i < 4; i += 1) {
    g.admitted(key, 1000 + i, `s${i}`);
    g.succeeded(key, 1000 + i, `s${i}`);
  }
  check('no demand means no growth', g.cap(key) === 8, `cap=${g.cap(key)}`);

  // With a waiter, the same streak grows the cap by one.
  g.waiters(key, 1100, 2);
  for (let i = 0; i < 4; i += 1) {
    g.admitted(key, 1200 + i, `t${i}`);
    g.succeeded(key, 1200 + i, `t${i}`);
  }
  check('demand plus proven success grows the cap', g.cap(key) === 9, `cap=${g.cap(key)}`);
}

console.log('\n5. a stale verdict does not move the current cap');
{
  // The epoch is what makes an old verdict ignorable: a 429 for a request
  // issued under a cap that has since been lowered says nothing about the
  // current one.
  const g = new ConcurrencyGovernor({ initial: 8 });
  const key = 'deepseek/deepseek-chat';
  const epoch = g.admitted(key, 1000, 'r1');
  g.throttled(key, 1100, 'r2', { reason: 'rate_limited' });   // epoch +1
  const capAfter = g.cap(key);
  // A verdict for the OLD epoch arrives late.
  const changes = g.throttled(key, 1200, 'r1', { reason: 'rate_limited' });
  check('the stale verdict changes nothing', g.cap(key) === capAfter, `cap=${g.cap(key)}`);
  check('and reports no change', changes.length === 0, JSON.stringify(changes));
  void epoch;
}

console.log('\n6. the governor keeps one controller per key');
{
  const g = new ConcurrencyGovernor({ initial: 8 });
  g.admitted('a/b', 1000, 'r1');
  g.admitted('c/d', 1000, 'r2');
  check('two keys means two controllers', g.controllers.size === 2, `size=${g.controllers.size}`);
  check('the snapshot reports both', g.snapshot().length === 2);
}

console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures} problem(s))`}`);
process.exit(failures === 0 ? 0 : 1);
