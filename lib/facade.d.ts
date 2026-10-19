// dsh-workflow-runner facade — ambient declaration for workflow scripts.
//
// Mirrors the ZCode dynamic-workflows §16.2 contract (`declare` blocks).
// The host injects this file (renamed `__dsh_facade__.d.ts`) into the
// per-run tmpDir used by `tsc --noEmit --strict` so user `.ts` scripts
// typecheck against the same shapes the runtime exposes at runtime.
//
// Conventions:
//   - This file is intentionally a *script* (no top-level `export`),
//     so its `declare const` / `declare interface` declarations live
//     in the global ambient scope and are visible to every `.ts` file
//     tsc compiles in the same program. If you ever add `export {}`,
//     the file becomes a module and the declarations go module-scoped
//     — they will not be visible to user scripts anymore.
//   - `declare const __dsh` describes the namespace object.
//   - Individual `declare const` / `declare function` lines expose the
//     top-level bindings the user can `const { agent, world, … } = __dsh`
//     or destructure directly.
//   - Interfaces describe the public shapes (Agent, WorldRunResult, …).
//
// Scope mirrors ZCode:
//   - Eval-mode (snippet) scripts see the same facade minus `agent`,
//     `artifact.*`, `phase`, `report`, `hole`, `model`, `askUser`,
//     `escalate`, `t`, `route`. The runner handles pruning on the
//     bootstrap side; from the type system perspective the full facade
//     is available — `constants.mode === 'snippet'` when in eval mode.

declare const __dsh: {
  /** A subagent: one conversation that keeps its context across asks. */
  agent(name?: string, persona?: string | AgentPersona): Agent;

  /** Run a deterministic command. */
  world: { run(cmd: string, args?: string[], opts?: WorldRunOptions): Promise<WorldRunResult> };

  /** Mark the start of a phase. */
  phase(name: string): void;

  /** Emit a progress message. */
  log(message: string, level?: 'info' | 'warn' | 'error'): void;

  /** Publish one intermediate result; survives run failure. */
  report(item: unknown, artifactId?: string): void;

  /** Publish and declare artifacts. */
  artifact: ArtifactNs;

  /** Read-only views of the workspace. */
  files: {
    glob(pattern: string): Promise<string[]>;
    read(path: string): Promise<string>;
    grep(pattern: string, glob?: string): Promise<GrepMatch[]>;
  };

  /** Read-only git views. */
  git: {
    changedFiles(base?: string): Promise<string[]>;
    diff(base?: string, path?: string): Promise<string>;
    status(): Promise<GitStatus>;
    log(count?: number): Promise<GitCommit[]>;
  };

  /** A stream of typed items between two stages. */
  channel<T>(name?: string): Channel<T>;

  /** Run an async block as a concurrent stage. */
  future<T>(body: () => Promise<T>): Promise<T>;

  /** Declare a model subagents may run on. */
  model(id: string): ModelRef;

  /** The run's arguments. */
  args: Readonly<Record<string, unknown>>;

  /** Typed gap the user fills mid-run. Three overloads. */
  hole<T>(name: string, prompt?: string): Promise<T>;
  hole<T>(name: string, body: () => Promise<T>): Promise<T>;
  hole<T>(name: string, prompt: string, body: () => Promise<T>): Promise<T>;

  /** Mid-run human input. */
  askUser(
    question: string,
    opts?: { kind?: 'text' | 'confirm'; options?: string[] }
  ): Promise<string>;

  /** Mid-run escalation with optional Think-via-LLM. */
  escalate(
    question: string,
    opts?: { kind?: 'text' | 'confirm' | 'options'; options?: string[] }
  ): Promise<string>;

  /** Available model ids (ZCode's `ListModels` equivalent). */
  models: readonly string[];

  /**
   * v0.10.0: structural amend. Stages the host injected into this run
   * while it was executing (via `POST /api/amend`). The bootstrap drains
   * them automatically before the run finishes, so `await()` is only
   * needed when a workflow wants to join them explicitly.
   */
  stages: {
    list(): Promise<readonly InjectedStage[]>;
    pending(): number;
    await(opts?: { timeoutMs?: number }): Promise<void>;
  };

  /**
   * v0.12.0: concurrency telemetry.
   *
   * `stat()` returns the HOST's view of the concurrency limiter — the
   * limit, the high-water mark of simultaneous provider calls, and how
   * many asks are queued right now. A script measuring this itself
   * would over-count: time spent waiting for a slot is not time spent
   * holding one.
   */
  concurrency: {
    stat(): Promise<ConcurrencyStat>;
  };

  /** Read-only runtime constants. */
  constants: {
    rpcVersion: number;
    artifactKinds: { declare: readonly string[]; publish: readonly string[] };
    mode?: 'snippet';
  };

  /** Compact string-literal sugar for `resultShape`. */
  t: {
    string(opts?: { description?: string }): unknown;
    number(opts?: { description?: string }): unknown;
    boolean(opts?: { description?: string }): unknown;
    array(item: unknown): unknown;
    optional(shape: unknown): unknown;
  };

  /** Two-stage multi-model routing helper. */
  route<M extends string>(
    models: readonly M[],
    router: (light: M) => Promise<{ tier: 'light' | 'strong' }>,
    answerer: (model: M) => Promise<string>
  ): Promise<string>;
};

declare const agent: typeof __dsh.agent;
declare const world: typeof __dsh.world;
declare const phase: typeof __dsh.phase;
declare const log: typeof __dsh.log;
declare const report: typeof __dsh.report;
declare const artifact: typeof __dsh.artifact;
declare const files: typeof __dsh.files;
declare const git: typeof __dsh.git;
declare const channel: typeof __dsh.channel;
declare const future: typeof __dsh.future;
declare const model: typeof __dsh.model;
declare const args: typeof __dsh.args;
declare const hole: typeof __dsh.hole;
declare const askUser: typeof __dsh.askUser;
declare const escalate: typeof __dsh.escalate;
declare const models: typeof __dsh.models;
declare const stages: typeof __dsh.stages;
declare const concurrency: typeof __dsh.concurrency;
declare const constants: typeof __dsh.constants;
declare const t: typeof __dsh.t;
declare const route: typeof __dsh.route;

declare global {
  /** The facade namespace, mounted on globalThis at workflow load time. */
  // eslint-disable-next-line no-var
  var __dsh: typeof __dsh;
}

declare interface Agent {
  ask<T = string>(
    prompt: string,
    opts?: { maxTokens?: number; result?: unknown }
  ): Promise<T>;
  close(): void;
}

declare interface AgentPersona {
  system?: string;
  model?: ModelRef | string;
  temperature?: number;
}

declare interface WorldRunOptions {
  timeoutMs?: number;
  cwd?: string;
  env?: Record<string, string>;
}

/**
 * v0.12.0 — the host's view of the per-run concurrency limiter.
 */
declare interface ConcurrencyStat {
  /** The ceiling this run is operating under. */
  limit: number;
  /** Asks currently holding a slot (i.e. actually talking to the provider). */
  active: number;
  /** High-water mark of `active` for this run. */
  peak: number;
  /** Asks queued right now, waiting for a slot. */
  waiting: number;
  /** Total slots acquired this run. */
  totalAcquired: number;
  /** Total milliseconds spent queued across all asks. */
  totalWaitMs: number;
}

/**
 * v0.10.0 — one host-injected stage in a structural amend.
 *
 * `status` moves injected → running → completed | error. A run that
 * ends before the stage starts leaves it `abandoned`.
 */
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

declare interface WorldRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs?: number;
  error?: string;
}

declare interface GrepMatch {
  path: string;
  line: number;
  text: string;
}

declare interface GitStatus {
  branch?: string;
  clean: boolean;
  staged: string[];
  unstaged: string[];
  untracked: string[];
}

declare interface GitCommit {
  hash: string;
  subject: string;
  author: string;
  date: string;
}

declare interface Channel<T> extends AsyncIterable<T> {
  send(item: T): void;
  close(): void;
}

declare class ModelRef {
  private readonly __dsh_modelRef: never;
}

declare interface ArtifactRef {
  id: string;
  version: number;
}

declare interface ArtifactOptions {
  title?: string;
  description?: string;
  primary?: boolean;
}

declare interface ArtifactFileOptions extends ArtifactOptions {
  contentType?: string;
}

declare interface ArtifactField {
  field: string;
  label?: string;
  unit?: string;
}

declare interface ChartSpec extends ArtifactOptions {
  type?: 'line' | 'bar' | 'scatter';
  x: ArtifactField;
  y: ArtifactField | ArtifactField[];
  scale?: 'linear' | 'log';
  baseline?: ArtifactField;
}

declare interface TableSpec extends ArtifactOptions {
  columns: ArtifactField[];
  key?: string;
}

declare interface MetricsSpec extends ArtifactOptions {
  metrics: ArtifactField[];
}

declare interface BoardSpec extends ArtifactOptions {
  key: string;
  status: string;
  columns: string[];
  cardTitle?: string;
  detail?: ArtifactField[];
}

declare interface ArtifactNs {
  file(id: string, path: string, opts?: ArtifactFileOptions): Promise<ArtifactRef>;
  markdown(id: string, content: string, opts?: ArtifactOptions): Promise<ArtifactRef>;
  chart(id: string, spec: ChartSpec): void;
  table(id: string, spec: TableSpec): void;
  metrics(id: string, spec: MetricsSpec): void;
  board(id: string, spec: BoardSpec): void;
}