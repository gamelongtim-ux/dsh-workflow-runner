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

import { refToString } from './engine.js';

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

    /** @type {Map<string, {session: object, message: object, persona: object}>} in-flight asks */
    this.pending = new Map();
    /** @type {Map<string, AbortController>} in-flight model calls */
    this.aborts = new Map();
    /** @type {Map<string, object>} live actor sessions, keyed by session id */
    this.sessions = new Map();
    /** @type {Map<string, object>} the actor record per (siteId, ordinal) */
    this.actors = new Map();
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
      messages: seed === undefined ? [] : [...(seed.messages ?? [])],
    };
    this.sessions.set(sessionId, session);
    return session;
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
    return this.services.worldRead(op, args);
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
    this.sessions.clear();
    if (typeof this.services.dispose === 'function') this.services.dispose();
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
      this.sink.askFailed(refOf(key), {
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      });
      return;
    }
    this.aborts.delete(key);

    if (result?.tokens !== undefined || result?.toolCalls !== undefined) {
      this.sink.askStats(refOf(key), {
        tokens: result.tokens ?? 0,
        toolCalls: result.toolCalls ?? 0,
        turns: result.turns ?? 1,
      });
    }

    if (message.typed) {
      // The engine validates the value against the site's schema and, if it
      // does not fit, calls back into respondToSubmit with the violations.
      this.sink.askSubmitAttempted(refOf(key), result?.value);
    } else {
      this.sink.askTurnEnded(refOf(key), result?.text ?? '');
    }
  }

  /**
   * Ask again, with extra guidance. The engine's repair / nudge budget is
   * what bounds this loop: each rejection decrements the budget, and when it
   * runs out the engine cancels the ask and fails the run.
   *
   * @param {string} key
   * @param {{session: object, message: object}} pending
   * @param {{instruction: string, violations?: unknown[]}} extra
   */
  #retry(key, pending, extra) {
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
