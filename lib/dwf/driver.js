/**
 * The dsh side of the engine's downward port.
 *
 * ZCode's engine is a pure state machine: it never touches the network, the
 * filesystem, the clock or a random number generator. Everything with a side
 * effect arrives here, behind `WorkflowDriver` (the downward port) and
 * `JournalStorePort` (the storage port). The engine's upward port,
 * `WorkflowReportSink`, is implemented by the engine itself — the driver
 * calls back into it to report progress and to hand over a typed result.
 *
 * Three things in here are load-bearing and easy to get wrong:
 *
 * 1. **executeWorldRead is the only way out of the sandbox.** Every file read,
 *    glob, grep, git query and `world.run` lands here. dsh's path fences, file
 *    size caps and command allow-lists must be enforced at this one point —
 *    that is the whole reason the fences moved down from the child process.
 *
 * 2. **resolvedModel must be written inside createActorSession.** The engine
 *    reads it back out of the journal and rewrites the whole actor row; a
 *    driver that resolves the model one turn late has its value erased to
 *    undefined, silently, with no error. The model's tier is what the audit
 *    trail and the amend cache are keyed on.
 *
 * 3. **startAsk is fire-and-forget.** The engine is mid-dispatch when it
 *    calls us; calling back into it synchronously re-enters the scheduler.
 *    Every report we make happens on a later turn of the event loop.
 */

import { refToString, WorkflowError } from './engine.js';

/**
 * @typedef {object} DshWorkflowServices
 * @property {(req: {session: object, instructions: string, schema: unknown, violations: unknown[], signal: AbortSignal}) => Promise<{value?: unknown, text?: string, tokens?: number, toolCalls?: number, turns?: number}>} askModel
 *   One model turn. For a typed ask the result is `value` (matched against the
 *   schema by the engine); for an untyped ask it is `text`.
 * @property {(op: string, args: unknown[]) => Promise<unknown>} worldRead
 *   The sandboxed world: files.*, git.*, world.run. This is where dsh's path
 *   fences and command allow-lists are enforced.
 * @property {(request: object) => Promise<object>} publishArtifact
 *   Publish a content artifact's bytes into dsh's artifact store.
 * @property {(event: object) => void} emit
 *   Broadcast one engine event (a RunEvent) to the host's event stream.
 * @property {(persona: object) => string | undefined} [resolveModel]
 *   The model this subagent will actually run on, for the audit trail.
 * @property {() => void} [dispose]
 *   Release the resources this run holds (sessions, timers).
 */

export class DshWorkflowDriver {
  /**
   * @param {object} options
   * @param {import('./engine.js').WorkflowReportSink} options.sink - the engine's upward port
   * @param {import('./engine.js').JournalStorePort} options.journal - the storage port
   * @param {DshWorkflowServices} options.services - the host capabilities
   * @param {string} options.runId
   */
  constructor({ sink, journal, services, runId }) {
    this.sink = sink;
    this.journal = journal;
    this.services = services;
    this.runId = runId;

    // The driver publishes itself to the host, so the host can read the
    // run's live concurrency counters. The engine's own scheduler is what
    // admits asks on the engine path — dsh's semaphore is never acquired
    // there — so the driver is the only source of those numbers.
    if (typeof services.onDriver === 'function') {
      try { services.onDriver(this); } catch (_) { /* the host can live without it */ }
    }

    /** @type {Map<string, {session: object, message: object, persona: object}>} in-flight asks */
    this.pending = new Map();
    /** @type {Map<string, AbortController>} in-flight model calls */
    this.aborts = new Map();
    /** @type {Map<string, object>} live actor sessions, keyed by session id */
    this.sessions = new Map();
    /** @type {Map<string, object>} the actor record per (siteId, ordinal) */
    this.actors = new Map();

    // The asks whose subagent may touch the workspace.
    //
    // `askMutating` is the ONE driver observation the engine makes a
    // decision on: it closes the run's import cache, because a cached
    // answer is an answer about the PREDECESSOR's world, and that world
    // stops existing at the first write.
    //
    // dsh's subagents have no tools of their own — they answer in text —
    // so the mutation cannot come from a tool call inside the ask. It
    // comes from the HOST: the workspace-changing operations the host runs
    // on the ask's behalf (a `world.run` the ask drove, a file the ask
    // wrote). The host reports those here, and the driver relays them.
    /** @type {Map<string, {instance: object, actorName?: string}>} asks that may mutate */
    this.mutating = new Map();

    // The concurrency telemetry the run's `concurrency.stat()` reports.
    //
    // The engine path does NOT use dsh's semaphore — the engine's own
    // scheduler admits asks (`scheduler.ts`: `if (this.activeAsks >= caps.
    // maxConcurrency) return`). So the semaphore's counters would read zero
    // for a run that is plainly busy. These counters track the engine's
    // asks instead.
    this.concurrency = {
      active: 0,
      peak: 0,
      waiting: 0,
      totalAcquired: 0,
      totalWaitMs: 0,
    };
  }

  /**
   * The run's live concurrency telemetry.
   *
   * @returns {{limit: number, active: number, peak: number, waiting: number, totalAcquired: number, totalWaitMs: number}}
   */
  concurrencyStat(limit) {
    return {
      limit: Number.isFinite(limit) ? limit : 0,
      active: this.concurrency.active,
      peak: this.concurrency.peak,
      waiting: this.concurrency.waiting,
      totalAcquired: this.concurrency.totalAcquired,
      totalWaitMs: this.concurrency.totalWaitMs,
    };
  }

  // ————————————————— WorkflowDriver —————————————————

  /**
   * Mint an actor session. The engine calls this lazily, on the first live
   * dispatch of an ask — not when the actor is created.
   *
   * @param {{siteId: string, ordinal: number}} actor
   * @param {object} persona
   * @param {object} [seed] transcript to copy in (amend-resume)
   */
  async createActorSession(actor, persona, seed) {
    const sessionId = `dsh-session:${actor.siteId}@${actor.ordinal}`;

    // The engine owns the actor row but NOT these two fields: it rewrites the
    // whole row on every put, carrying the existing values forward. So they
    // have to be written here, before the engine's next put, or they are lost.
    const existing = this.journal.getActor(this.runId, actor.siteId, actor.ordinal);
    const resolvedModel =
      typeof this.services.resolveModel === 'function'
        ? this.services.resolveModel(persona)
        : undefined;
    this.journal.putActor({
      ...(existing ?? { runId: this.runId, siteId: actor.siteId, ordinal: actor.ordinal }),
      sessionId,
      resolvedModel,
    });

    const session = {
      id: sessionId,
      actor,
      persona,
      // The subagent's conversation. One conversation per actor: every ask
      // issued to the same actor continues the same thread.
      messages: [],
    };
    this.sessions.set(sessionId, session);

    // The seed is upstream's `ActorSessionSeed`: `{ sourceSessionId,
    // messageCount, resolvedModel? }` — a POINTER to a source session and
    // how many of its messages to copy, not the messages themselves.
    //
    // The copy is a read-modify-write of the target session, and it is
    // skipped on two conditions (upstream: "Driver side: boundaries and
    // seeding"):
    //
    //   - the target already holds at least `messageCount` messages. That
    //     is the crash-and-resume case: the session already has what was
    //     copied, plus what the run then produced.
    //   - the target holds any message that is not a seed clone at its own
    //     index. A session that has begun a life of its own is never written
    //     into again, however short it looks. Without this, a later rebuild
    //     that produces a larger boundary would append the predecessor's
    //     messages AFTER the successor's own — a transcript that reads out
    //     of order and was never that subagent's.
    if (seed !== undefined && seed !== null) {
      this.#seedSession(session, seed);
    }

    return session;
  }

  /**
   * Copy a source session's transcript prefix into a target session.
   *
   * @param {object} session - the target session
   * @param {object} seed - upstream's `ActorSessionSeed`
   */
  #seedSession(session, seed) {
    const sourceSessionId = typeof seed.sourceSessionId === 'string' ? seed.sourceSessionId : '';
    const messageCount = Number(seed.messageCount);
    if (sourceSessionId === '' || !Number.isFinite(messageCount) || messageCount <= 0) return;

    const source = this.sessions.get(sourceSessionId);
    if (source === undefined) {
      // The source session is not in this process. The engine's import
      // cache carries the RESULTS; the transcript lives in the
      // predecessor's session, which is gone. Upstream treats a missing
      // source as a `DriverError` with a mismatch, because a seed that
      // cannot be honoured would otherwise seed an empty session and
      // silently drop the predecessor's context.
      throw new WorkflowError(
        'DriverError',
        `the seed's source session '${sourceSessionId}' is not available`,
        { mismatch: { expected: messageCount, got: 0 } },
      );
    }

    // Skipped, not an error: the target already holds the prefix.
    if (session.messages.length >= messageCount) return;
    // Skipped, not an error: the target holds something that is not a seed
    // clone — it has a life of its own.
    if (session.messages.some((m, i) => m?.id !== `${session.id}-seed-${i}`)) return;

    const copied = source.messages.slice(0, messageCount);
    if (copied.length < messageCount) {
      // The source is shorter than the boundary says it should be. That is
      // a mismatch, and upstream reports it rather than seeding short.
      throw new WorkflowError(
        'DriverError',
        `the seed's source session has ${copied.length} messages, not ${messageCount}`,
        { mismatch: { expected: messageCount, got: copied.length } },
      );
    }
    session.messages = copied.map((m, i) => ({ ...m, id: `${session.id}-seed-${i}` }));
  }

  /**
   * Write an ask's `messageBoundary` into its node row.
   *
   * `messageBoundary` is the number of messages in the subagent's session
   * after this exchange ended. It is the count offset the amend-resume
   * transcript truncation is built on: copying the first N messages of a
   * source session changes every message ID but not the COUNT, so a
   * boundary written here stays valid in the copied session.
   *
   * The write is a read-modify-write of the row, and it is skipped if the
   * next ask has already started on the same session — the engine may
   * dispatch the subagent's next ask inside the call that reports this
   * one's outcome, and then the boundary belongs to the earlier exchange.
   *
   * The row itself is written by the ENGINE when the ask settles, which is
   * AFTER the driver reports the outcome. So the boundary is written after
   * the report, and retried on the next turn if the row is not there yet.
   *
   * Upstream: "After each exchange ends ... the driver counts the messages
   * persisted in the subagent's session and writes that count into the
   * ask's node row as `messageBoundary`."
   *
   * @param {string} key - the ask's key
   * @param {object} session - the subagent's session
   */
  #writeMessageBoundary(key, session) {
    const instance = this.#instanceOf(key);
    if (instance === undefined) return;
    const count = Array.isArray(session.messages) ? session.messages.length : 0;

    const write = () => {
      const row = this.journal.getNode(this.runId, instance.siteId, instance.ordinal);
      if (row === undefined) return false;
      // If the NEXT ask on this session has already started, the boundary
      // would describe a conversation that has already moved on. This ask's
      // own pending entry does not count — it is this exchange.
      const nextPending = [...this.pending.entries()].some(
        ([pendingKey, p]) => pendingKey !== key && p.session?.id === session.id,
      );
      if (nextPending) return true;
      this.journal.putNode({ ...row, messageBoundary: count });
      return true;
    };

    if (write()) return;
    // The engine has not written the row yet. It writes it when the ask
    // settles, which is the call the driver just made — so the row lands
    // one turn later. Retry then.
    queueMicrotask(() => {
      if (!write()) queueMicrotask(() => { write(); });
    });
  }

  /**
   * Dispatch one ask. Returns immediately; the model call happens later.
   *
   * @param {object} session
   * @param {{siteId: string, ordinal: number}} instance
   * @param {object} message
   */
  startAsk(session, instance, message) {
    const key = refToString(instance);
    this.pending.set(key, { session, message });

    // Never call back into the engine synchronously from here: the engine is
    // mid-dispatch and a synchronous callback re-enters its scheduler.
    queueMicrotask(() => {
      void this.#performAsk(key);
    });
  }

  /**
   * The engine's verdict on a submitted typed result.
   *
   * `accept` needs nothing from us — the engine settles the node itself.
   * `reject` means the value did not match the schema: we owe the model one
   * more turn, this time with the violations spelled out. `nudge` means a
   * typed ask ended without submitting anything: we owe it one more turn
   * asking for the result explicitly.
   *
   * @param {{siteId: string, ordinal: number}} instance
   * @param {{kind: string, violations?: unknown[]}} verdict
   */
  respondToSubmit(instance, verdict) {
    const key = refToString(instance);
    if (verdict.kind === 'accept') return;

    const pending = this.pending.get(key);
    if (pending === undefined) return;

    if (verdict.kind === 'reject') {
      this.#retry(key, pending, {
        violations: verdict.violations ?? [],
        instruction:
          'Your previous result did not match the required schema. Fix these problems and submit again:\n' +
          formatViolations(verdict.violations ?? []),
      });
    } else if (verdict.kind === 'nudge') {
      this.#retry(key, pending, {
        instruction:
          'You did not submit a result. Reply with the result object, matching the required schema exactly.',
      });
    }
  }

  /**
   * Cancel one in-flight ask. The engine calls this when a repair budget is
   * exhausted, and the host calls it when the user stops the run.
   *
   * @param {{siteId: string, ordinal: number}} instance
   */
  cancelAsk(instance) {
    const key = refToString(instance);
    const controller = this.aborts.get(key);
    if (controller !== undefined) {
      controller.abort();
      this.aborts.delete(key);
    }
    this.pending.delete(key);
  }

  /**
   * The one way out of the sandbox.
   *
   * `op` is one of: read, glob, grep, git-changed-files, git-diff, git-status,
   * git-log, run. `args` are the script's positional arguments, packed by the
   * lowering pass without any checking — validating them is this method's
   * job, and enforcing the sandbox is the host's job behind
   * `services.worldRead`.
   *
   * @param {string} op
   * @param {unknown[]} args
   */
  async executeWorldRead(op, args) {
    try {
      return await this.services.worldRead(op, args);
    } catch (cause) {
      // The engine wraps a plain driver error as "World read failed: <op>
      // <args>." and keeps the original only as `cause` — so the reason the
      // sandbox REFUSED the read, which is the part a user needs, would
      // never reach the run's error. Throwing a WorkflowError makes the
      // engine use this message as-is.
      throw new WorkflowError(
        'DriverError',
        cause && cause.message ? cause.message : String(cause),
        { cause },
      );
    }
  }

  /**
   * Report that an in-flight ask's subagent is about to change the
   * workspace.
   *
   * This is `askMutating` — the ONE driver observation the engine makes a
   * decision on. It closes the run's import cache, because a cached answer
   * is an answer about the PREDECESSOR's world, and that world stops
   * existing at the first write. The report has to arrive BEFORE the write,
   * so the cache is closed before the first byte lands.
   *
   * Upstream, this report comes from the driver's tool-activity observer: a
   * subagent's tool call that would write to the workspace is reported
   * after the permission decision and before the handler runs.
   *
   * dsh's subagents have NO tools — they answer in text — so there is no
   * tool call to observe. The mutation that matters on this path is the
   * workspace-changing work the HOST does on the ask's behalf: a
   * `world.run` the ask drove, or a stage the ask ran. The host reports
   * those here, and the driver relays them to the engine.
   *
   * @param {string} instanceKey - the ask's key (`<siteId>@<ordinal>`)
   * @param {object} [options]
   * @param {string} [options.actorName] - the subagent's name, for the event
   */
  reportMutation(instanceKey, options = {}) {
    const key = String(instanceKey ?? '');
    if (key === '') return;
    // The report is idempotent per ask: the engine's close is idempotent
    // too, and reporting twice would only add noise to the event log.
    if (this.mutating.has(key)) return;
    const instance = this.#instanceOf(key);
    if (instance === undefined) return;
    this.mutating.set(key, { instance, actorName: options.actorName });
    this.sink.askMutating(instance);
  }

  /**
   * Publish a content artifact's bytes. Optional in the port: without it the
   * engine rejects content artifacts loudly (ArtifactStoreUnavailable) rather
   * than silently pretending they were published.
   *
   * @param {object} request
   */
  async executeArtifactPublish(request) {
    return this.services.publishArtifact(request);
  }

  /**
   * The key of the ask that is in flight on a subagent, if any.
   *
   * The host uses this to attribute a workspace mutation to the ask whose
   * answer the write invalidates.
   *
   * @param {string} [actorName] - the subagent's name
   * @returns {string|undefined}
   */
  inFlightKeyFor(actorName) {
    for (const [key, pending] of this.pending.entries()) {
      if (actorName === undefined || actorName === null || actorName === '') return key;
      const name = pending.session?.persona?.name;
      if (name === actorName) return key;
    }
    return undefined;
  }

  /**
   * The instance ref for an ask key.
   *
   * @param {string} key
   * @returns {{siteId: string, ordinal: number}|undefined}
   */
  #instanceOf(key) {
    const at = key.lastIndexOf('@');
    if (at < 0) return undefined;
    const siteId = key.slice(0, at);
    const ordinal = Number(key.slice(at + 1));
    if (!Number.isFinite(ordinal)) return undefined;
    return { siteId, ordinal };
  }

  /**
   * @param {object} event
   */
  emit(event) {
    this.services.emit(event);
  }

  /**
   * Release this run's resources. The engine calls it exactly once, after
   * the run has settled, on all three terminal paths.
   */
  dispose() {
    for (const controller of this.aborts.values()) controller.abort();
    this.aborts.clear();
    this.pending.clear();
    // The session snapshot is kept, because it is what a SUCCESSOR reads:
    // the journal cannot say how many messages a session held, and the
    // `messageBoundary` of an unfinished ask is read from the session.
    // Upstream calls this the "quiesce" step — a run settles before its
    // abandoned turns have finished unwinding, so the count is taken at
    // the moment the run ends.
    this.sessionSnapshot = new Map();
    for (const [sessionId, session] of this.sessions.entries()) {
      this.sessionSnapshot.set(sessionId, {
        messageCount: Array.isArray(session?.messages) ? session.messages.length : 0,
        sessionId,
      });
    }
    this.sessions.clear();
    if (typeof this.services.dispose === 'function') this.services.dispose();
  }

  /**
   * The run's sessions as they were when it ended.
   *
   * @returns {Record<string, {messageCount: number, sessionId: string}>}
   */
  sessionCounts() {
    const out = {};
    for (const [sessionId, entry] of this.sessionSnapshot.entries()) {
      out[sessionId] = entry;
    }
    for (const [sessionId, session] of this.sessions.entries()) {
      out[sessionId] = {
        messageCount: Array.isArray(session?.messages) ? session.messages.length : 0,
        sessionId,
      };
    }
    return out;
  }

  // ————————————————— internals —————————————————

  /**
   * One model turn for the pending ask, then report the outcome to the
   * engine.
   *
   * @param {string} key
   */
  async #performAsk(key) {
    const pending = this.pending.get(key);
    if (pending === undefined) return;
    const { session, message } = pending;

    const controller = new AbortController();
    this.aborts.set(key, controller);

    // The engine's own scheduler admitted this ask, so it holds a slot
    // until it settles. Count it, so `concurrency.stat()` reports the run's
    // REAL concurrency rather than the legacy semaphore's zeros.
    this.concurrency.active += 1;
    this.concurrency.totalAcquired += 1;
    if (this.concurrency.active > this.concurrency.peak) {
      this.concurrency.peak = this.concurrency.active;
    }

    let result;
    try {
      result = await this.services.askModel({
        session,
        instructions: message.instructions ?? '',
        schema: message.typed ? message.schema : undefined,
        violations: message.violations ?? [],
        signal: controller.signal,
      });
    } catch (cause) {
      this.aborts.delete(key);
      this.pending.delete(key);
      this.concurrency.active = Math.max(0, this.concurrency.active - 1);
      // The error we hand the engine MUST be a WorkflowError. The engine
      // serialises it with `error.toJSON()` when it settles a failed ask
      // (upstream: engine/scheduler.ts -> settleFailed), so a plain object
      // turns a transient provider error into `TypeError: error.toJSON is
      // not a function` — an uncaught exception, and the host process dies.
      //
      // A deterministic provider error (auth expired, quota exhausted, the
      // model is not on the plan) is not a failed ask: it is the provider
      // saying it will not serve this run at all. Upstream has a code for
      // exactly that — `ProviderStop`, which stops the run with
      // `stopped(provider)` instead of failing one node. The engine only
      // stops a run that way when the driver reports it, so this is where
      // that decision has to be made.
      const providerStop = classifyProviderError(cause);
      if (providerStop !== null) {
        this.sink.stopRun(
          new WorkflowError(
            'ProviderStop',
            providerStop.reason,
            { cause, providerStop },
          ),
        );
        return;
      }
      this.sink.askFailed(
        refOf(key),
        new WorkflowError(
          'DriverError',
          cause instanceof Error ? cause.message : String(cause),
          { cause },
        ),
      );
      return;
    }
    this.aborts.delete(key);
    this.concurrency.active = Math.max(0, this.concurrency.active - 1);
    // The ask is over. Its pending entry must go, or the next ask on the
    // same session would look like it had already started — and the
    // boundary of this one would be skipped.
    this.pending.delete(key);

    if (result?.tokens !== undefined || result?.toolCalls !== undefined) {
      this.sink.askStats(refOf(key), {
        tokens: result.tokens ?? 0,
        toolCalls: result.toolCalls ?? 0,
        turns: result.turns ?? 1,
      });
    }

    // The boundary is counted and written AFTER the outcome is reported,
    // because the engine writes the ask's row when it settles — which is
    // the call the driver is about to make. Writing before would find no
    // row to write into.
    this.mutating.delete(key);

    if (message.typed) {
      // The engine validates the value against the site's schema and, if it
      // does not fit, calls back into respondToSubmit with the violations.
      this.sink.askSubmitAttempted(refOf(key), result?.value);
    } else {
      this.sink.askTurnEnded(refOf(key), result?.text ?? '');
    }

    this.#writeMessageBoundary(key, session);
  }

  /**
   * Ask again, with extra guidance. The engine's repair / nudge budget is
   * what bounds this loop: each rejection decrements the budget, and when it
   * runs out the engine cancels the ask and fails the run.
   *
   * @param {string} key
   * @param {{session: object, message: object}} pending
   * @param {{instruction: string, violations?: unknown[]}} extra
   */  #retry(key, pending, extra) {
    this.pending.set(key, {
      session: pending.session,
      message: {
        ...pending.message,
        instructions: `${pending.message.instructions ?? ''}\n\n${extra.instruction}`,
        violations: extra.violations ?? pending.message.violations ?? [],
      },
    });
    queueMicrotask(() => {
      void this.#performAsk(key);
    });
  }
}

/**
 * The instance ref, recovered from the key we track it by.
 *
 * The key is `<siteId>@<ordinal>` (see refToString). We keep the original ref
 * on the pending record instead of parsing it back, so a site id containing
 * an `@` cannot be misread.
 *
 * @param {string} key
 */
function refOf(key) {
  const at = key.lastIndexOf('@');
  return { siteId: key.slice(0, at), ordinal: Number(key.slice(at + 1)) };
}

/**
 * Render schema violations the way the model needs to see them: one line per
 * problem, naming the path that is wrong.
 *
 * @param {unknown[]} violations
 */
function formatViolations(violations) {
  if (!Array.isArray(violations) || violations.length === 0) return '(no details)';
  return violations
    .map((v) => {
      if (typeof v === 'string') return `- ${v}`;
      if (v !== null && typeof v === 'object') {
        const path = v.path === undefined || v.path === '' ? '(root)' : String(v.path);
        const message = v.message ?? v.code ?? JSON.stringify(v);
        return `- ${path}: ${message}`;
      }
      return `- ${String(v)}`;
    })
    .join('\n');
}

/**
 * Is this a DETERMINISTIC provider error, or a transient one?
 *
 * Upstream splits the two on purpose (`engine/errors.ts`): a deterministic
 * provider error — auth expired, the model is not on the plan, the quota is
 * gone — means the provider will not serve this run at all, so the run stops
 * with `stopped(provider)`. A transient one — a socket reset, a 429, a
 * timeout — is worth retrying, and failing one ask is the right outcome.
 *
 * The distinction cannot be made from the error message alone, so it comes
 * from the status the provider reported. Upstream's `ProviderStopDetails.kind`
 * names the buckets; this maps a provider status onto them.
 *
 * @param {unknown} cause
 * @returns {{kind: string, reason: string, status?: number}|null}
 */
function classifyProviderError(cause) {
  const status = providerStatus(cause);
  if (status === undefined) return null;

  const message = cause instanceof Error ? cause.message : String(cause);

  // 401 / 403: the credential is wrong or the plan does not include the
  // model. Nothing about this run can succeed without a human.
  if (status === 401 || status === 403) {
    return { kind: 'auth', reason: message, status };
  }
  // 402: payment required — the account is out of credit.
  if (status === 402) {
    return { kind: 'quota', reason: message, status };
  }
  // 404: the model id does not exist on this provider.
  if (status === 404) {
    return { kind: 'model_unavailable', reason: message, status };
  }
  // 429: the quota is exhausted. Upstream treats this as a stop, not a
  // retry — the run cannot make progress until the quota resets, and the
  // run panel should say so rather than burn a retry budget on it.
  if (status === 429) {
    return { kind: 'quota', reason: message, status };
  }
  // 400 with an "invalid request" shape: the provider will never accept
  // this call. But a 400 can also be a malformed request from the model
  // itself, which is transient. Only the explicit code counts.
  if (status === 400 && /invalid[_ ]?request/i.test(message)) {
    return { kind: 'invalid_request', reason: message, status };
  }
  // 5xx: the provider is broken. Transient, not deterministic.
  return null;
}

/**
 * The provider's HTTP status, if the error carries one. dsh's chat helper
 * attaches it as `status`; other shapes are tolerated so the classifier keeps
 * working if the helper changes.
 *
 * @param {unknown} cause
 * @returns {number|undefined}
 */
function providerStatus(cause) {
  if (cause === null || typeof cause !== 'object') return undefined;
  const direct = /** @type {{status?: unknown}} */ (cause).status;
  if (typeof direct === 'number' && Number.isFinite(direct)) return direct;
  const response = /** @type {{status?: unknown}} */ (cause).response;
  if (response !== null && typeof response === 'object') {
    const nested = /** @type {{status?: unknown}} */ (response).status;
    if (typeof nested === 'number' && Number.isFinite(nested)) return nested;
  }
  return undefined;
}
