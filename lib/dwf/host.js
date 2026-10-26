/**
 * The dsh side of the ZCode engine's injection ports.
 *
 * The engine (packages/dynamic-workflow) is a pure state machine: it never
 * touches the network, the filesystem, the clock or a random number generator.
 * Everything with a side effect arrives through the ports implemented here.
 *
 * The shape of the world is the important part. In the engine, `worldRead` is
 * the ONLY door a script has to the outside: files, git and `world.run` all
 * pass through it, and the engine has no other route. That makes it the right
 * place for the sandbox fences, and this module is deliberately the only
 * caller of dsh's world operations on the engine path.
 *
 * Two of the engine's ports are implemented by the engine itself and are
 * reached, not implemented:
 *
 *   - `WorkflowHostApi`   — the `__host.*` surface the lowered script calls.
 *                            The engine IS the host; the script is bound to it.
 *   - `WorkflowReportSink` — the upward port. The driver calls back into the
 *                            engine through it to report progress and to hand
 *                            over a typed result.
 *
 * What lives here is the driver-facing side: `WorkflowDriver` (the downward
 * port) and `JournalStorePort` (the storage port).
 */

import { InMemoryJournalStore } from './engine.js';

/**
 * The world operations, and how each one's positional arguments map onto the
 * shape dsh's runtime uses.
 *
 * The op names come from ZCode's facade registry (packages/dynamic-workflow/
 * src/facade/registry.ts) and the payloads from dsh's RPC handlers. The
 * mapping is one to one by design: ZCode's registry exists so that adding a
 * world primitive is one line, and it must not need a second table here.
 */
const WORLD_OPS = {
  read: (args) => ({ path: args[0] }),
  glob: (args) => ({ pattern: args[0] }),
  grep: (args) => ({ pattern: args[0], glob: args[1] }),
  'git-changed-files': (args) => ({ base: args[0] }),
  'git-diff': (args) => ({ base: args[0], path: args[1] }),
  'git-status': () => ({}),
  'git-log': (args) => ({ count: args[0] }),
  run: (args) => ({ cmd: args[0], args: args[1] || [], opts: args[2] || {} }),
};

/** The artifact ops the engine routes through the driver (the content family). */
const ARTIFACT_OPS = new Set(['file', 'markdown']);

/**
 * dsh's own operations, riding the worldRead channel.
 *
 * The cell's `__host` object is fixed — it has exactly ten members, and
 * adding one would mean editing the vendored upstream. But `worldRead`'s op
 * string is passed through untouched to the driver, so an op no ZCode op
 * uses is a channel of its own. These are the operations that need the
 * host: asking the human, escalating, the injected stages, the concurrency
 * telemetry.
 *
 * @param {object} services - dsh's host capabilities
 */
function dshWorldOp(services, op, args) {
  switch (op) {
    case 'dsh-ask-user':
      return services.askUser(args[0], args[1] || {});
    case 'dsh-escalate':
      return services.escalate(args[0], args[1] || {});
    case 'dsh-stages': {
      const action = String(args[0] || 'list');
      if (action === 'pending') return services.stagesPending();
      if (action === 'await') return services.stagesAwait(args[1] || {});
      if (action === 'run') return services.stageRun(args[1] || {});
      return services.stagesList();
    }
    case 'dsh-concurrency':
      return services.concurrencyStat();
    default:
      return undefined;
  }
}

/**
 * Format the engine's schema violations for the model.
 *
 * The engine reports them per property, and the repair turn is the only
 * chance the model gets to fix them, so each line has to name the offending
 * path and say what was wrong with it.
 *
 * @param {unknown[]} violations
 * @returns {string}
 */
export function formatViolations(violations) {
  if (!Array.isArray(violations) || violations.length === 0) return '(no details given)';
  return violations
    .map((v) => {
      if (typeof v === 'string') return `- ${v}`;
      if (v === null || typeof v !== 'object') return `- ${String(v)}`;
      const path = v.path === undefined || v.path === '' ? '(root)' : String(v.path);
      const message = v.message ?? v.code ?? JSON.stringify(v);
      return `- ${path}: ${message}`;
    })
    .join('\n');
}

/**
 * Pull a JSON value out of a model reply.
 *
 * Returns `{ parsed, raw }`: `parsed` is undefined when the reply is not
 * JSON at all. The engine's own submit path tolerates a JSON *string*
 * payload and parses it once (engine/scheduler-submit.ts: normalizeSubmit),
 * so handing back the raw text is not a loss — the engine still gets a
 * chance to read it. Handing back the raw text for prose, on the other hand,
 * is what lets the engine report a real violation instead of silently
 * accepting a string.
 *
 * @param {string} content
 * @returns {{parsed: unknown, raw: string}}
 */
export function parseModelJson(content) {
  const raw = String(content ?? '').trim();
  let s1 = raw;
  const fence = s1.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence) s1 = fence[1];
  try {
    return { parsed: JSON.parse(s1), raw };
  } catch (_) {
    return { parsed: undefined, raw };
  }
}

/**
 * Build the services object the engine's driver consumes.
 *
 * @param {object} deps
 * @param {string} deps.runId
 * @param {object} deps.state - the run state (dsh's `s`): agents, reports, artifacts, modelsAllowed
 * @param {object} deps.ctx - the cordis plugin context (for the LLM endpoint)
 * @param {(args: object) => Promise<any>} deps.chat - lib/llm.js `chat`
 * @param {object} deps.world - the world operations, bound to this run
 * @param {(request: object) => Promise<object>} deps.publishArtifact - publishes one content artifact
 * @param {(event: object) => void} deps.emit - the runtime's broadcast
 * @param {(level: string, message: string) => void} [deps.appendLog]
 * @param {(entry: object) => void} [deps.journalPush] - dsh's flat journal
 * @param {() => string | undefined} [deps.resolveModel] - the model a persona asks for
 * @param {number} [deps.askTimeoutMs]
 * @param {object} [deps.constants] - runtime constants
 * @returns {import('./driver.js').DshWorkflowServices}
 */
export function createDwfServices(deps) {
  const {
    runId,
    state,
    ctx,
    chat,
    world,
    publishArtifact,
    emit,
    appendLog,
    journalPush,
    resolveModel,
    askTimeoutMs = 300_000,
    defaultModel = 'deepseek-chat',
    defaultSystem = 'You are a helpful assistant.',
    // dsh's own host capabilities, for the operations that ride the
    // worldRead channel (see dshWorldOp).
    askUser,
    escalate,
    stagesList,
    stagesPending,
    stagesAwait,
    stageRun,
    concurrencyStat,
    onDriver,
  } = deps;
  const services = { askUser, escalate, stagesList, stagesPending, stagesAwait, stageRun, concurrencyStat };

  /** Agents, keyed the way dsh's runtime keys them: by name. */
  function agentKeyFor(session) {
    const name = session?.persona?.name;
    if (name) return name;
    // An anonymous actor has no identity of its own, so it needs a synthetic
    // one. The engine's site id plus the ordinal is stable within the run.
    const actor = session?.actor;
    return actor ? `${actor.siteId}@${actor.ordinal}` : `actor-${runId}`;
  }

  function agentFor(session) {
    const key = agentKeyFor(session);
    let agent = state.agents.get(key);
    const persona = session.persona || {};
    if (!agent) {
      agent = {
        name: persona.name || key,
        system: persona.system || defaultSystem,
        model: persona.model || defaultModel,
        temperature: undefined,
        messages: [],
        asks: 0,
        lastTokens: null,
        lastDurationMs: null,
        createdAt: Date.now(),
      };
      state.agents.set(key, agent);
      if (!state.agentsOrder.includes(key)) state.agentsOrder.push(key);
      emit({
        event: 'agent.new',
        agent: {
          name: agent.name,
          system: agent.system,
          model: agent.model,
          createdAt: agent.createdAt,
        },
      });
    } else {
      if (persona.system) agent.system = persona.system;
      if (persona.model) agent.model = persona.model;
    }
    // The engine's session and dsh's agent record are two views of the same
    // conversation. Keep the engine's session authoritative so that a resume
    // that replays a seeded session sees the same history.
    if (Array.isArray(session?.messages) && session.messages.length > 0) {
      agent.messages = session.messages;
    }
    return { agent, key };
  }

  return {
    /**
     * One model turn for one ask.
     *
     * The typed path hands the engine the raw JSON Schema the compile step
     * synthesized from the script's `ask<T>()` type argument, and returns the
     * model's value. The engine validates it; when it does not fit, the
     * engine calls back into `respondToSubmit` with the violations, and the
     * driver re-asks with those violations in the prompt. So this method
     * makes ONE attempt and lets the engine own the repair budget.
     */
    async askModel({ session, instructions, schema, violations, signal }) {
      const { agent } = agentFor(session);
      const persona = session.persona || {};

      const system = persona.system || agent.system || defaultSystem;
      const model = persona.model || agent.model || defaultModel;

      let userText = String(instructions ?? '');
      if (Array.isArray(violations) && violations.length > 0) {
        userText +=
          '\n\nYour previous result did not match the required schema:\n' +
          `${formatViolations(violations)}\n\n` +
          'Return ONLY a valid JSON object matching the schema, with no other text.';
      }

      const typed = schema !== undefined && schema !== null;
      const jsonInstruction = typed
        ? `\n\nYou MUST respond with a single JSON object (no prose, no markdown fences) matching this JSON Schema:\n${JSON.stringify(schema, null, 2)}`
        : '';

      // The schema instruction is per-ask, so it never enters the history:
      // it would otherwise pile up on every turn of a long conversation.
      const history = agent.messages.length > 0 ? agent.messages.slice() : [];
      if (history.length === 0 || history[0].role !== 'system') {
        history.unshift({ role: 'system', content: system });
      }
      const messages = typed
        ? [
            { role: 'system', content: history[0].content + jsonInstruction },
            ...history.slice(1),
            { role: 'user', content: userText },
          ]
        : [...history, { role: 'user', content: userText }];

      const t0 = Date.now();
      const result = await chat(
        {
          messages,
          model,
          maxTokens: undefined,
          responseFormat: typed ? { type: 'json_object' } : null,
          timeoutMs: askTimeoutMs,
        },
        ctx,
      );
      const durationMs = Date.now() - t0;

      const raw = result?.content || '';
      agent.asks += 1;
      agent.lastTokens = result?.usage || null;
      agent.lastDurationMs = durationMs;

      // Keep the history the engine's session holds, so a later ask to the
      // same actor continues the same conversation.
      const nextHistory = [...history, { role: 'user', content: userText }];
      nextHistory.push({ role: 'assistant', content: raw });
      agent.messages = nextHistory;
      if (Array.isArray(session?.messages)) session.messages = nextHistory;

      const usage = result?.usage || {};
      const tokens = usage.total_tokens ?? (usage.prompt_tokens || 0) + (usage.completion_tokens || 0);

      if (journalPush) {
        journalPush({
          kind: 'agent.ask',
          name: agent.name,
          prompt: userText,
          content: typed ? undefined : raw,
          parsed: typed ? parseModelJson(raw).parsed : undefined,
          usage: result?.usage,
          typed,
          live: true,
        });
      }

      if (!typed) {
        emit({
          event: 'agent.ask.done',
          name: agent.name,
          askIndex: agent.asks - 1,
          contentPreview: raw.slice(0, 400),
          usage: result?.usage,
          durationMs,
          at: Date.now(),
        });
        return { text: raw, tokens, toolCalls: 0, turns: 1 };
      }

      const { parsed, raw: trimmed } = parseModelJson(raw);
      emit({
        event: 'agent.ask.done',
        name: agent.name,
        askIndex: agent.asks - 1,
        contentPreview: (parsed === undefined ? trimmed : JSON.stringify(parsed)).slice(0, 400),
        usage: result?.usage,
        durationMs,
        typed: true,
        at: Date.now(),
      });
      // The engine validates. Handing it the parsed value when the model did
      // produce JSON, and the raw text when it did not, lets the engine's
      // tolerant path (one JSON.parse of a string payload) do the rest.
      return { value: parsed === undefined ? trimmed : parsed, tokens, toolCalls: 0, turns: 1 };
    },

    /**
     * The only way out of the sandbox.
     *
     * Every op is delegated to dsh's runtime operation of the same name, and
     * those operations carry the path fences, the size caps and the command
     * allow-list. Because the engine has no other route to the world, the
     * fences cannot be bypassed on this path.
     */
    async worldRead(op, args) {
      const build = WORLD_OPS[op];
      if (build === undefined) {
        // dsh's own operations come through the same channel.
        const list = Array.isArray(args) ? args : [];
        const dsh = dshWorldOp(services, op, list);
        if (dsh !== undefined) return dsh;
        throw new Error(`unknown world operation: ${op}`);
      }
      const params = build(Array.isArray(args) ? args : []);
      return world[op](params);
    },

    /**
     * Publish one content artifact (file or markdown).
     *
     * The engine computes the version number and hands it over; the version
     * is the engine's, not ours, because the engine's journal is keyed on it.
     */
    async publishArtifact(request) {
      if (!ARTIFACT_OPS.has(request.op)) {
        throw new Error(`artifact op must be a content op, got '${request.op}'`);
      }
      const record = await publishArtifact(request);
      return {
        id: request.id,
        kind: request.op,
        version: request.version,
        title: record?.title,
        description: record?.description,
        contentType: record?.contentType,
        bytes: record?.bytes,
        uri: record?.uri,
        sourcePath: record?.sourcePath,
        publishedAt: record?.publishedAt ?? Date.now(),
        ...(record?.primary ? { primary: true } : {}),
      };
    },

    /** Broadcast one engine event. */
    emit(event) {
      emit(event);
    },

    /**
     * The model this subagent will actually run on.
     *
     * The engine reads this back out of the journal and rewrites the whole
     * actor row, so a value written late is erased silently. The driver
     * therefore writes it inside `createActorSession`, which is why this
     * resolver is a pure lookup.
     */
    resolveModel(persona) {
      if (typeof resolveModel === 'function') return resolveModel(persona);
      return undefined;
    },

    /**
     * The driver publishes itself here when it is constructed, so the host
     * can read the run's live concurrency counters. The engine's own
     * scheduler admits asks on the engine path — dsh's semaphore is never
     * acquired there — so the driver is the only source of those numbers.
     */
    onDriver(driver) {
      if (typeof onDriver === 'function') onDriver(driver);
    },
  };
}

/**
 * Translate an engine event into the event shape dsh's editor already
 * consumes.
 *
 * dsh's SSE stream carries `{ event: '<name>', ... }` payloads, and the
 * editor switches on that name. The engine's events carry `type` instead,
 * so every one of them is mapped explicitly. An unmapped event still gets
 * through, under an `engine.*` name, so nothing is ever silently dropped —
 * the editor shows what it knows and ignores the rest.
 *
 * @param {object} event - a ZCode RunEvent
 * @returns {object | null} - a dsh payload, or null to drop it
 */
export function mapEngineEvent(event) {
  if (!event || typeof event.type !== 'string') return null;
  const rest = { ...event };
  delete rest.type;

  switch (event.type) {
    case 'run-started':
      return { event: 'engine.run.started', ...rest };
    case 'run-launched':
      return { event: 'engine.run.launched', ...rest };
    case 'run-settled':
      return { event: 'engine.run.settled', ...rest };
    case 'run-stalled':
      return { event: 'engine.run.stalled', ...rest };
    case 'run-caps-changed':
      return { event: 'engine.run.caps', ...rest };
    case 'phase-entered':
      // dsh's editor already knows the `phase` event.
      return { event: 'phase', name: event.name, ordinal: event.ordinal, at: Date.now() };
    case 'actor-created':
      return { event: 'engine.actor.created', ...rest };
    case 'node-queued':
      return { event: 'engine.node.queued', ...rest };
    case 'node-dispatched':
      return { event: 'engine.node.dispatched', ...rest };
    case 'node-settled':
      return { event: 'engine.node.settled', ...rest };
    case 'node-waiting':
      return { event: 'agent.ask.queued', ...rest };
    case 'node-executing':
      return { event: 'agent.ask.start', ...rest };
    case 'node-progress':
      return { event: 'agent.ask.progress', ...rest };
    case 'node-repairing':
      return { event: 'agent.ask.repairing', ...rest };
    case 'node-nudged':
      return { event: 'agent.ask.nudged', ...rest };
    case 'concurrency-changed':
      return { event: 'engine.concurrency', ...rest };
    case 'usage-updated':
      return { event: 'engine.usage', ...rest };
    case 'import-cache-closed':
      return { event: 'cache.closed', ...rest };
    case 'log':
      return { event: 'log', level: 'info', message: event.message, at: Date.now() };
    case 'report':
      return { event: 'report', report: { at: Date.now(), item: event.item, tag: event.artifactId }, artifactId: event.artifactId };
    case 'artifact-published':
      return { event: 'artifact.publish', artifact: event.artifact, ...rest };
    case 'artifact-failed':
      return { event: 'artifact.failed', ...rest };
    case 'hole-reached':
      return { event: 'hole.waiting', ...rest };
    case 'hole-filled':
      return { event: 'hole.answered', ...rest };
    case 'escalation-raised':
      return { event: 'escalate.asked', ...rest };
    case 'escalation-resolved':
      return { event: 'escalate.answered', ...rest };
    default:
      return { event: `engine.${event.type}`, ...rest };
  }
}

/**
 * A journal store for the engine.
 *
 * The engine's own `InMemoryJournalStore` implements the 16-method
 * `JournalStorePort` and is what the engine's own contract suite
 * (src/testing/journal-contract.ts) exercises, so it is the base here. What
 * this adds is the write-through into dsh's flat journal, so the editor's
 * journal view keeps working on the engine path.
 *
 * @param {object} [opts]
 * @param {(entry: object) => void} [opts.onEvent] - called for every event
 * @param {object} [opts.base] - an existing store to delegate to
 */
export function createDwfJournal(opts = {}) {
  const base = opts.base ?? new InMemoryJournalStore();
  if (typeof opts.onEvent === 'function') {
    const original = base.appendEvent.bind(base);
    base.appendEvent = (runId, event) => {
      const stored = original(runId, event);
      try {
        opts.onEvent(stored);
      } catch (_) {
        /* the mirror is best effort; the engine's journal is the truth */
      }
      return stored;
    };
  }
  return base;
}
