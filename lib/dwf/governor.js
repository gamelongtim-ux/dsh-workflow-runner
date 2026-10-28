/**
 * The process-level concurrency governor.
 *
 * ZCode's engine does not own the concurrency decision. It admits at most
 * `caps.maxConcurrency` live asks, and that cap comes from the run record.
 * The ADMISSION of individual model requests beneath it belongs to a
 * governor: a per-provider-key AIMD state machine that shrinks the cap when
 * the provider throttles and grows it back when the provider proves the
 * higher level works.
 *
 * Upstream ships that state machine — `ConcurrencyController` — as a pure
 * class: no clock, no I/O, `now` passed in. It is vendored, unmodified, in
 * `packages/dynamic-workflow/src/engine/concurrency.ts`.
 *
 * WHAT THIS MODULE IS: the part upstream puts OUTSIDE the controller — the
 * piece that owns one controller per provider key, decides which key a
 * request belongs to, feeds the controller the signals, and turns the
 * controller's decisions into the engine's caps.
 *
 * WHY IT IS PROCESS-LEVEL: a provider's rate limit is a fact about the
 * provider, not about a run. Two runs against the same key share one
 * budget, so the learned cap has to be shared too. That is why the
 * controller is keyed by `${providerId}/${modelId}` and why this module
 * keeps one per key for the life of the process.
 *
 * THE SIGNALS, and where each comes from:
 *
 *   - a request ADMITTED      -> `admitted(now)`, which returns the epoch
 *     the request belongs to. The epoch is what makes a stale verdict
 *     ignorable: a 429 for a request issued under an older cap says nothing
 *     about the current one.
 *   - a request SUCCEEDED      -> `succeeded(now, epoch)`
 *   - a request THROTTLED      -> `throttled(now, epoch, reason, retryAfterMs)`
 *   - a request FAILED (other) -> `failedTransient(now)` — a 5xx or a
 *     timeout says the provider is unwell, not that the cap is too high.
 *   - a request ENDED          -> `ended(now)`
 *
 * The controller is upstream's; this module only decides what to tell it.
 */

import { ConcurrencyController } from './engine.js';

/**
 * The reasons the controller understands. They are upstream's, and they go
 * straight into the `concurrency-changed` event.
 */
const THROTTLE_REASONS = new Set(['rate_limited', 'provider_overloaded', 'offpeak_queued']);

/**
 * Classify a model error for the governor.
 *
 * The distinction matters: a throttle means "the cap is too high", and the
 * cap must come down. A transient failure (a 5xx, a timeout, a dropped
 * socket) means the provider is unwell, and the cap should stay where it
 * is — shrinking it because the provider had a bad minute would punish
 * every other run for it.
 *
 * @param {unknown} cause
 * @returns {{throttled: boolean, reason?: string, retryAfterMs?: number}}
 */
export function classifyModelFailure(cause) {
  if (cause === null || typeof cause !== 'object') return { throttled: false };
  const status = Number(/** @type {{status?: unknown}} */ (cause).status);
  const retryAfterMs = /** @type {{retryAfterMs?: unknown}} */ (cause).retryAfterMs;

  if (status === 429) {
    return {
      throttled: true,
      reason: 'rate_limited',
      ...(typeof retryAfterMs === 'number' ? { retryAfterMs } : {}),
    };
  }
  // 503 with a provider-overloaded body is a throttle in disguise: the
  // provider is saying "come back later", not "your request was wrong".
  if (status === 503) {
    return { throttled: true, reason: 'provider_overloaded' };
  }
  return { throttled: false };
}

/**
 * The governor: one `ConcurrencyController` per provider key.
 */
export class ConcurrencyGovernor {
  /**
   * @param {object} [options]
   * @param {number} [options.initial] - the default concurrency D
   */
  constructor(options = {}) {
    this.initial = Number.isFinite(options.initial) && options.initial > 0
      ? Math.floor(options.initial)
      : 8;
    /** @type {Map<string, ConcurrencyController>} one per provider key */
    this.controllers = new Map();
    /** @type {Map<string, number>} the epoch each admitted request belongs to */
    this.epochs = new Map();
  }

  /**
   * The controller for a key, created on first use.
   *
   * @param {string} key - `${providerId}/${modelId}`
   * @returns {ConcurrencyController}
   */
  controller(key) {
    let controller = this.controllers.get(key);
    if (controller === undefined) {
      controller = new ConcurrencyController(key, this.initial);
      this.controllers.set(key, controller);
    }
    return controller;
  }

  /**
   * The growth limit of a key — the ceiling its cap may climb to.
   *
   * Read from the SNAPSHOT, not from the controller's public
   * `growthLimit` field: that field is the value the controller was
   * CONSTRUCTED with, and it does not follow `setGrowthLimit`. Reading it
   * would make the governor believe the ceiling was still the initial
   * concurrency, and the cap could never climb.
   *
   * @param {string} key
   * @returns {number}
   */
  growthLimit(key) {
    return this.controller(key).snapshot().growthLimit;
  }

  /**
   * The cap a key is currently allowed to run at.
   *
   * @param {string} key
   * @returns {number}
   */
  cap(key) {
    return this.controller(key).snapshot().cap;
  }

  /**
   * A request was admitted under this key. Returns the epoch it belongs
   * to, which the request carries back when it ends.
   *
   * @param {string} key
   * @param {number} now
   * @param {string} requestId - identifies the request, so its epoch can be
   *   looked up when it ends
   * @returns {number} the epoch
   */
  admitted(key, now, requestId) {
    const controller = this.controller(key);
    // An idle key resets to its starting point before the admission, so a
    // run that starts after an hour of quiet does not inherit a cap that
    // was learned against a different load.
    controller.observe(now);
    const epoch = controller.admitted(now);
    this.epochs.set(requestId, epoch);
    return epoch;
  }

  /**
   * A request succeeded.
   *
   * @param {string} key
   * @param {number} now
   * @param {string} requestId
   * @returns {object[]} the cap changes it caused
   */
  succeeded(key, now, requestId) {
    const controller = this.controller(key);
    const epoch = this.epochs.get(requestId);
    this.epochs.delete(requestId);
    return controller.succeeded(now, epoch ?? controller.epoch);
  }

  /**
   * A request was throttled by the provider.
   *
   * @param {string} key
   * @param {number} now
   * @param {string} requestId
   * @param {{reason?: string, retryAfterMs?: number}} [info]
   * @returns {object[]} the cap changes it caused
   */
  throttled(key, now, requestId, info = {}) {
    const controller = this.controller(key);
    const epoch = this.epochs.get(requestId);
    this.epochs.delete(requestId);
    const reason = THROTTLE_REASONS.has(info.reason) ? info.reason : 'rate_limited';
    return controller.throttled(now, epoch ?? controller.epoch, reason, info.retryAfterMs);
  }

  /**
   * A request failed for a reason that says nothing about the cap.
   *
   * @param {string} key
   * @param {number} now
   * @param {string} requestId
   * @returns {object[]} the cap changes it caused
   */
  failedTransient(key, now, requestId) {
    const controller = this.controller(key);
    this.epochs.delete(requestId);
    return controller.failedTransient(now);
  }

  /**
   * A request ended without a verdict (cancelled, or a ticket that only
   * ever saw its release).
   *
   * @param {string} key
   * @param {number} now
   * @param {string} requestId
   * @returns {object[]} the cap changes it caused
   */
  ended(key, now, requestId) {
    const controller = this.controller(key);
    this.epochs.delete(requestId);
    return controller.ended(now);
  }

  /**
   * The number of requests waiting for a slot on this key.
   *
   * The controller only grows the cap when there is DEMAND for it, so this
   * is how the governor tells it.
   *
   * It also raises the GROWTH LIMIT: the limit is the ceiling the cap may
   * climb to, and it defaults to the initial concurrency. Without raising
   * it, a key that once throttled could never recover — the cap would be
   * pinned below the level the provider is now serving happily. The limit
   * is raised to the initial concurrency times two, which is the bound
   * upstream's governor uses ("max(2D, …)": twice the default).
   *
   * @param {string} key
   * @param {number} now
   * @param {number} count
   * @returns {object[]} the cap changes it caused
   */
  waiters(key, now, count) {
    const controller = this.controller(key);
    const changes = controller.waiters(now, count);
    // Demand means the cap may be worth climbing, so the ceiling it climbs
    // to has to be above the current one.
    if (count > 0 && this.growthLimit(key) <= this.cap(key)) {
      changes.push(...controller.setGrowthLimit(now, controller.initial * 2));
    }
    return changes;
  }

  /**
   * Move the automatic growth limit for a key.
   *
   * @param {string} key
   * @param {number} now
   * @param {number} limit
   * @returns {object[]} the cap changes it caused
   */
  setGrowthLimit(key, now, limit) {
    return this.controller(key).setGrowthLimit(now, limit);
  }

  /**
   * Jump the cap straight to a target — a user raising a run's ceiling
   * should not have to wait for the cap to climb one step at a time.
   *
   * @param {string} key
   * @param {number} now
   * @param {number} target
   * @returns {object[]} the cap changes it caused
   */
  seed(key, now, target) {
    return this.controller(key).seed(now, target);
  }

  /**
   * A read-only snapshot of every key's state.
   *
   * @returns {object[]}
   */
  snapshot() {
    return [...this.controllers.values()].map((c) => c.snapshot());
  }
}
