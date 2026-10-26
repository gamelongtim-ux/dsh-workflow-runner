/**
 * dsh's own facade additions, on top of ZCode's.
 *
 * ZCode's facade (packages/dynamic-workflow/src/facade/dts.ts) is the
 * authoring contract of the Dynamic Workflow: agent, ask, phase, log,
 * report, artifact.*, files.*, git.*, world.run, channel, future, hole,
 * model, args. It is the right contract, and the engine's analysis, the
 * lowering and the engine all agree on it.
 *
 * dsh has a few capabilities of its own that the contract does not cover:
 * asking the human a question mid-run, escalating to them, routing between
 * models, asking what models exist, seeing the run's concurrency telemetry,
 * seeing the stages the host injected, and reading the runtime constants.
 * Those are declared here and implemented on the host side.
 *
 * HOW THE ADDITIONS REACH THE SCRIPT
 *
 * Two halves, and neither of them touches the vendored upstream:
 *
 * 1. The DECLARATIONS go into the facade text. `createWorkflowProgram` takes
 *    a `facadeDts` override, so the compiler sees dsh's members and the
 *    author gets them typechecked. The file name stays
 *    `workflow-facade.d.ts` — the engine recognises facade identity by that
 *    name, in five places, and a different name would leave the site table
 *    silently empty.
 *
 * 2. The IMPLEMENTATIONS are installed as globals of the sandbox, by
 *    prepending them to the lowered body. The lowered body runs inside the
 *    vm context, and `globalThis` there is the context's own global object
 *    — the cell does not freeze or seal it (it only replaces `Date` and
 *    `Math.random`). So `globalThis.askUser = ...` defines a global the
 *    script can call.
 *
 *    The lowering leaves these members alone: they are in none of the
 *    engine's registries, so they produce no site and no rewrite, and they
 *    stay free identifiers in the lowered code. That is exactly what a
 *    global is.
 *
 * WHY THE HOST-ROUND-TRIP MEMBERS GO THROUGH worldRead
 *
 * `askUser`, `escalate`, `stages` and `concurrency.stat` need the host. The
 * cell's `__host` object is fixed — it has exactly ten members, and adding
 * one would mean editing upstream. But `__host.worldRead(siteId, op, args)`
 * is a general request/response channel: the op string is passed through
 * untouched to `driver.executeWorldRead`. So the dsh-specific operations
 * ride that channel, with op names no ZCode op uses.
 */

import { FACADE_DTS } from './engine.js';

/**
 * The facade declarations, as TypeScript. Ambient on purpose: the file has
 * no top-level import or export, so these land in the global scope where
 * the script can see them.
 */
export const DSH_FACADE_DECLARATIONS = String.raw`
/** A stage the host injected into this run. */
declare interface InjectedStage {
  id: string;
  name: string;
  status: 'injected' | 'running' | 'completed' | 'error' | 'abandoned' | 'timed-out';
  injectedAt: number;
  startedAt?: number;
  endedAt?: number;
  result?: unknown;
  error?: string | null;
}

/** The host's view of the run's concurrency limiter. */
declare interface ConcurrencyStat {
  /** The ceiling this run is operating under. */
  limit: number;
  /** Asks currently holding a slot. */
  active: number;
  /** High-water mark of active for this run. */
  peak: number;
  /** Asks queued right now, waiting for a slot. */
  waiting: number;
  /** Total slots acquired this run. */
  totalAcquired: number;
  /** Total milliseconds spent queued across all asks. */
  totalWaitMs: number;
}

/**
 * Ask the human a question and wait for the answer.
 *
 * The run pauses here; the question reaches the user through the run panel,
 * and the answer comes back on the same run. A "confirm" question answers
 * with a boolean, an "options" question with one of the given strings.
 */
declare function askUser(
  question: string,
  opts?: { kind?: 'text' | 'confirm'; options?: string[] },
): Promise<string>;

/**
 * Escalate to the human.
 *
 * Like askUser, but the host may answer it with a model first and ask the
 * human to confirm that answer — the point of an escalation is that the
 * model's own answer is not trusted without a human.
 */
declare function escalate(
  question: string,
  opts?: { kind?: 'text' | 'confirm' | 'options'; options?: string[] },
): Promise<string>;

/**
 * Two-stage multi-model routing.
 *
 * MODELS maps a tier name to a model id. The router is called with the
 * light model id and answers with a tier ("light" or "strong"); the answerer
 * is then called with the chosen model's id. Both are the script's own
 * functions, so the model call itself stays in the script's hands.
 */
declare function route<M extends string>(
  MODELS: Record<string, M>,
  router: (light: M) => Promise<string | { content?: string }>,
  answerer: (model: M) => Promise<string>,
): Promise<string>;

/** The model ids this run may use. */
declare const models: readonly string[];

/** The stages the host injected into this run. */
declare const stages: {
  /** Every stage recorded for this run. */
  list(): Promise<readonly InjectedStage[]>;
  /** How many stages have not settled yet. */
  pending(): Promise<number>;
  /** Wait until no stage is in flight. */
  await(opts?: { timeoutMs?: number; forStage?: boolean }): Promise<void>;
  /** Run one injected stage and return its result. */
  run(stageId: string, ctx?: Record<string, unknown>): Promise<unknown>;
};

/** The host's authoritative view of the run's concurrency limiter. */
declare const concurrency: {
  stat(): Promise<ConcurrencyStat>;
};

/** Read-only runtime constants. */
declare const constants: {
  rpcVersion: number;
  artifactKinds: { declare: readonly string[]; publish: readonly string[] };
  mode?: 'snippet';
};
`;

/**
 * The facade the compiler sees: ZCode's, plus dsh's own members.
 *
 * The file name stays the engine's (`workflow-facade.d.ts`) — the engine
 * recognises facade identity by that name in five places, and a different
 * name would leave the site table silently empty.
 */
export const DSH_FACADE_DTS = FACADE_DTS + DSH_FACADE_DECLARATIONS;

/**
 * The implementations, as source text.
 *
 * This string is prepended to the lowered body, so it runs INSIDE the vm
 * context: `__host` is the cell's shim object, and `globalThis` is the
 * context's global. Everything here must be ES2022 and must not reach for
 * anything the cell has banned (`Date.now`, argless `new Date()`,
 * `Math.random`).
 *
 * The values that are known at compile time (the model list, the runtime
 * constants) are baked in as JSON; the ones that need the host go through
 * `__host.worldRead`, whose op string the engine passes through untouched
 * to the driver.
 *
 * @param {object} values
 * @param {readonly string[]} values.models
 * @param {object} values.constants
 * @returns {string} source text to prepend to the lowered body
 */
export function buildDshGlobalsSource(values) {
  const models = JSON.stringify(Array.isArray(values.models) ? values.models : []);
  const constants = JSON.stringify(values.constants ?? {});
  return String.raw`
// ——— dsh facade additions (lib/dwf/dsh-facade.js) ———
//
// Installed as globals of the sandbox context. The lowering leaves these
// members alone — they are in none of the engine's registries, so they
// produce no site and no rewrite — which is exactly what a global is.

globalThis.models = ${models};
globalThis.constants = ${constants};

globalThis.askUser = async function askUser(question, opts) {
  return await __host.worldRead(
    'world-read#dsh-askUser',
    'dsh-ask-user',
    [String(question === undefined || question === null ? '' : question), opts || {}],
  );
};

globalThis.escalate = async function escalate(question, opts) {
  return await __host.worldRead(
    'world-read#dsh-escalate',
    'dsh-escalate',
    [String(question === undefined || question === null ? '' : question), opts || {}],
  );
};

globalThis.route = async function route(MODELS, routerFn, answererFn) {
  const tierNames = Object.keys(MODELS || {});
  if (tierNames.length === 0) throw new Error('route: MODELS is empty');
  const light = MODELS.light || MODELS[tierNames[0]];
  let tier = 'light';
  try {
    const raw = await routerFn(light);
    const text = typeof raw === 'string' ? raw : (raw && raw.content) || '';
    const m = text.match(/\{[\s\S]*?"tier"[\s\S]*?\}/);
    if (m) {
      const parsed = JSON.parse(m[0]);
      if (parsed && typeof parsed.tier === 'string' && MODELS[parsed.tier]) {
        tier = parsed.tier;
      }
    }
  } catch (_) { /* fall through to light */ }
  return await answererFn(MODELS[tier]);
};

globalThis.stages = {
  list: async function list() {
    return await __host.worldRead('world-read#dsh-stages', 'dsh-stages', ['list']);
  },
  pending: async function pending() {
    return await __host.worldRead('world-read#dsh-stages', 'dsh-stages', ['pending']);
  },
  await: async function awaitStages(opts) {
    return await __host.worldRead(
      'world-read#dsh-stages',
      'dsh-stages',
      ['await', opts || {}],
    );
  },  /**
   * Run a stage the host injected, and return its result.
   *
   * The stage's body is host-supplied code, so it runs on the HOST side of
   * the worldRead channel — not inside the sandbox. That is the same place
   * the legacy path runs it, and it is what gives the stage the run's
   * agents, its workspace confinement and its sandbox: the host owns those,
   * not the sandbox.
   */
  run: async function run(stageId, ctx) {
    return await __host.worldRead(
      'world-read#dsh-stages',
      'dsh-stages',
      ['run', { stageId, ctx: ctx || {} }],
    );
  },
};

globalThis.concurrency = {
  stat: async function stat() {
    return await __host.worldRead('world-read#dsh-concurrency', 'dsh-concurrency', ['stat']);
  },
};
`;
}
