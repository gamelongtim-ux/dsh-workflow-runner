/**
 * Running a Dynamic Workflow inside dsh.
 *
 * This is the seam between ZCode's engine and the dsh host. The split is:
 *
 *   host process                        child process
 *   ------------                        -------------
 *   WorkflowEngine  ── NDJSON bridge ──> vm cell running the lowered script
 *   WorkflowDriver  (our side effects)  the script's __host.* calls
 *   JournalStorePort (the storage port)
 *
 * The engine stays in the host because its journal port is synchronous and
 * sits on the engine's own decision path (a cache hit versus a live dispatch
 * is decided by reading the journal). The script stays in a child process
 * because that is where dsh's process-level sandbox lives: the child gets a
 * scrubbed environment, and the path fences are enforced one level up, in
 * the driver's executeWorldRead.
 *
 * Everything with a side effect — the model call, the file and git reads, the
 * command execution, the artifact publishing — is injected by the caller as
 * `services`. This module knows nothing about dsh's LLM, its sandbox or its
 * artifact store; it only knows how to wire them into the engine.
 */

import { runWorkflowScript } from '../../packages/dynamic-workflow-runtime/dist/index.js';

import { InMemoryJournalStore, inputHash, validate } from './engine.js';
import { DshWorkflowDriver } from './driver.js';
import { collectPreparedDiagnostics, prepareWorkflow } from './prepare.js';

export { DshWorkflowDriver } from './driver.js';
export { prepareWorkflow, collectPreparedDiagnostics } from './prepare.js';

/**
 * @typedef {object} RunDwfOptions
 * @property {string} scriptText - the author's script
 * @property {string} [runId]
 * @property {string} [name] - the run's display name
 * @property {Record<string, unknown>} [args] - the run's arguments
 * @property {number} [maxConcurrency] - ceiling on simultaneous asks
 * @property {import('./driver.js').DshWorkflowServices} services - the host capabilities
 * @property {import('./engine.js').JournalStorePort} [journal] - defaults to an in-memory store
 * @property {{bind: (engine: object) => void}} [control] - the live control plane
 * @property {AbortSignal} [signal] - external cancellation
 * @property {number} [timeoutMs] - wall-clock timeout
 * @property {string} [cwd] - the working directory for the run and the child
 * @property {string} [parentSessionId]
 * @property {import('./imported-cache.js').ImportedRunCache} [importedCache]
 *   The amend-resume import cache: pure data built from a predecessor's
 *   journal. The engine keeps zero I/O, so the caller builds it.
 * @property {string} [resumedFrom] - the predecessor's run id (the lineage)
 * @property {number} [inheritedTokens] - the predecessor's spent tokens
 */

/**
 * Compile and run a workflow.
 *
 * @param {RunDwfOptions} options
 * @returns {Promise<{settlement: object, prepared: object, diagnostics: object[]}>}
 */
export async function runDwfWorkflow(options) {
  const {
    scriptText,
    // A caller that already compiled the script passes the result in, so
    // the compile happens once rather than twice.
    prepared: providedPrepared,
    runId = `dwf-${Date.now().toString(36)}`,
    name,
    args,
    maxConcurrency = 8,
    services,
    journal = new InMemoryJournalStore(),
    control,
    signal,
    timeoutMs,
    cwd,
    parentSessionId,
    importedCache,
    resumedFrom,
    inheritedTokens,
  } = options;

  const prepared = providedPrepared ?? prepareWorkflow(scriptText, {
    ...(options.facadeDts === undefined ? {} : { facadeDts: options.facadeDts }),
    ...(options.models === undefined ? {} : { models: options.models }),
    ...(options.constants === undefined ? {} : { constants: options.constants }),
  });
  const diagnostics = collectPreparedDiagnostics(prepared);

  if (!prepared.ok || prepared.lowered.lowered === undefined) {
    return {
      settlement: {
        status: 'errored',
        error: {
          code: 'CompileFailed',
          message:
            diagnostics.length > 0
              ? `The workflow did not compile: ${diagnostics.length} diagnostic(s).`
              : 'The workflow did not compile.',
          diagnostics,
        },
      },
      prepared,
      diagnostics,
    };
  }

  // The driver is created by the harness, one per run. The caller needs a
  // handle on it: the run's concurrency telemetry lives there, and on the
  // engine path the semaphore is never acquired, so the driver is the only
  // source of those numbers.
  let driver = null;

  const settlement = await runWorkflowScript({
    scriptText,
    // The lowered body we already compiled. Passing it means the harness does
    // not lower the script a second time.
    lowered: prepared.lowered.lowered.code,
    runId,
    makeDriver: (sink) => {
      driver = new DshWorkflowDriver({ sink, journal, services, runId });
      return driver;
    },
    caps: { maxConcurrency },
    askSpecs: prepared.askSpecs,
    sitePhases: prepared.sitePhases,
    validate,
    // The engine compares this hash on resume, so it must be the hash of the
    // AUTHOR's text — not of the lowered body, which changes with every
    // compiler version.
    scriptHash: inputHash(scriptText),
    ...(name === undefined ? {} : { name }),
    ...(args === undefined ? {} : { args }),
    ...(control === undefined ? {} : { control }),
    ...(signal === undefined ? {} : { signal }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(cwd === undefined ? {} : { cwd }),
    ...(parentSessionId === undefined ? {} : { parentSessionId }),
    ...(importedCache === undefined ? {} : { importedCache }),
    ...(resumedFrom === undefined ? {} : { resumedFrom }),
    ...(inheritedTokens === undefined ? {} : { inheritedTokens }),
  });

  return { settlement, prepared, diagnostics, driver };
}

/**
 * Compile a workflow script and report what it looks like — without
 * running it.
 *
 * This is the answer to "is this script sound, and what shape is it?":
 * the diagnostics, the four graphs, the per-ask type contracts, and the
 * lowered body the engine would execute.
 *
 * @param {string} scriptText
 * @returns {object}
 */
export function compileWorkflow(scriptText) {
  const prepared = prepareWorkflow(scriptText);
  const diagnostics = collectPreparedDiagnostics(prepared);
  const graphs = projectWorkflowGraphs(prepared);
  return {
    ok: prepared.ok,
    diagnostics,
    graphs,
    sizes: graphs.sizes,
    askSites: [...prepared.askSpecs.keys()],
    schemas: prepared.schemas,
    siteIds: prepared.lowered.lowered?.siteIds ?? [],
    loweredCode: prepared.lowered.lowered?.code ?? null,
  };
}

/**
 * The four graphs, in a shape the editor can draw.
 *
 * The analysis result carries the site graph, the causality graph, the
 * control-flow graph and the hand-off graph. They are plain objects; this
 * helper only names them and reports their sizes, so the editor can show
 * "this workflow has no hand-offs" instead of an empty canvas.
 *
 * @param {object} prepared - the result of prepareWorkflow
 */
export function projectWorkflowGraphs(prepared) {
  const { graph, causality, flow, handoff } = prepared.analysis;
  return {
    site: graph ?? null,
    causality: causality ?? null,
    controlFlow: flow ?? null,
    handoff: handoff ?? null,
    sizes: {
      site: graph?.nodes?.length ?? 0,
      causality: causality?.steps?.length ?? 0,
      controlFlow: flow?.nodes?.length ?? 0,
      handoff: handoff?.participants?.length ?? 0,
    },
  };
}
