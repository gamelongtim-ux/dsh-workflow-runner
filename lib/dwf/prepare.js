/**
 * The compile-time half of a Dynamic Workflow.
 *
 * One script goes in; four graphs, a lowered function body, the per-ask type
 * contract and the site table come out. Nothing here touches the network,
 * the filesystem or the LLM — the whole point of this layer is that a
 * workflow's shape is known *before* it runs.
 *
 * The pipeline mirrors ZCode's own `analyzeWorkflowScript`, with one
 * difference that matters: the compile runs against DSH'S facade, not
 * ZCode's. dsh adds members to the facade (askUser, escalate, route, …),
 * and the author's script has to typecheck against the whole surface it can
 * actually use. Because the site table and the lowering match nodes by
 * identity, the analysis has to run on that same program — hence the
 * lower-level API rather than the convenience entry points, which hardcode
 * ZCode's facade.
 */

import {
  buildAskSpecs,
  collectArtifactDeclarations,
  collectDiagnostics,
  collectHoleDiagnostics,
  collectPhaseMarkerDiagnostics,
  collectSitePhases,
  collectSites,
  collectWorldRunCommands,
  createWorkflowProgram,
  interpret,
  lowerWorkflow,
  projectControlFlow,
  projectHandoffGraph,
  synthesizeAskSchemas,
} from './engine.js';

import {
  collectActorModels,
  collectDuplicateActorNames,
  collectFacadeMisuse,
  FANOUT_ACTOR_NAME_CODE,
  projectCausalityGraph,
  projectSiteGraph,
} from './engine-internals.js';

import { DSH_FACADE_DTS, buildDshGlobalsSource } from './dsh-facade.js';

/**
 * @typedef {object} PreparedWorkflow
 * @property {object} analysis - the four graphs and the diagnostics
 * @property {object} lowered - the lowered function body
 * @property {object} schema - the data-contract layer: ok + its diagnostics
 * @property {Map<string, object>} askSpecs - per-ask-site contract
 * @property {Map<string, string>} sitePhases - site id → the phase it was born in
 * @property {Record<string, unknown>} schemas - ask site id → JSON Schema
 * @property {boolean} ok - submittable: no diagnostics at all
 */

/**
 * Compile a workflow script.
 *
 * @param {string} scriptText - the author's script (TypeScript, no imports)
 * @param {object} [options]
 * @param {string} [options.facadeDts] - the facade to compile against
 * @param {readonly string[]} [options.models] - the model ids, for the `models` global
 * @param {object} [options.constants] - the runtime constants, for the `constants` global
 * @returns {PreparedWorkflow}
 */
export function prepareWorkflow(scriptText, options = {}) {
  const facadeDts = options.facadeDts ?? DSH_FACADE_DTS;

  const workflow = createWorkflowProgram(scriptText, { facadeDts });
  const diagnostics = collectDiagnostics(workflow.program);
  if (diagnostics.length > 0) {
    return failed(diagnostics);
  }

  const table = collectSites(workflow);
  const misuse = collectFacadeMisuse(workflow, table);
  if (misuse.length > 0) {
    return failed(misuse);
  }

  // The authoring rules, all of them compile-time: a runtime-only command has
  // nothing to show in the confirmation window, a non-literal phase name has
  // nothing to point at, a static actor name inside a fan-out is a
  // DuplicateActorName waiting to happen.
  const worldRun = collectWorldRunCommands(workflow, table);
  const artifacts = collectArtifactDeclarations(workflow, table);
  const models = collectActorModels(workflow, table);
  const authoring = [
    ...worldRun.diagnostics,
    ...artifacts.diagnostics,
    ...models.diagnostics,
    ...collectPhaseMarkerDiagnostics(workflow, table),
    ...collectHoleDiagnostics(workflow, table),
    ...collectDuplicateActorNames(workflow, table),
  ];

  // The fan-out actor name (9006) is the one authoring rule that does NOT
  // withhold the graphs: the shape is perfectly analysable, and withholding
  // the graph would hide the picture exactly when the author needs it to see
  // which fan-out to fix. It still clears `ok`.
  const withholding = authoring.filter((d) => d.code !== FANOUT_ACTOR_NAME_CODE);
  if (withholding.length > 0) {
    return failed(authoring, { declaredArtifacts: artifacts.declaredArtifacts, modelReferences: models.references });
  }

  // One interpretation feeds everything: the core carries the taint facts and
  // the temporal trace, and the graphs project off it.
  const core = interpret(workflow, table);
  const graph = projectSiteGraph(core);
  const causality = projectCausalityGraph(core, graph);

  const schemaResult = synthesizeAskSchemas(workflow, table);
  const askSpecs = buildAskSpecs(table, schemaResult.schemas);
  const sitePhases = collectSitePhases(core);
  const lowered = lowerWorkflow(workflow, table);

  // dsh's own facade members are installed as globals of the sandbox, by
  // prepending them to the lowered body. The lowering leaves them alone —
  // they are in none of the engine's registries — so they stay free
  // identifiers, which is exactly what a global is.
  const globals = buildDshGlobalsSource({
    models: options.models ?? [],
    constants: options.constants ?? {},
  });
  const code = `${globals}\n${lowered.code}`;

  return {
    ok: authoring.length === 0 && schemaResult.diagnostics.length === 0,
    analysis: {
      diagnostics: authoring,
      ok: authoring.length === 0,
      core,
      graph,
      causality,
      flow: projectControlFlow(core),
      handoff: projectHandoffGraph(core, causality, graph),
      declaredArtifacts: artifacts.declaredArtifacts,
      modelReferences: models.references,
    },
    lowered: {
      ok: true,
      diagnostics: [],
      lowered: { ...lowered, code },
    },
    // The schema layer sits between the authoring rules and the lowering: the
    // script typechecks and the shape is analysable, but the *data* contract
    // is not expressible (a result type that cannot be serialized into JSON
    // Schema, a report item carrying `undefined`). It refuses to run, so it
    // has to refuse with a reason — these are the reasons.
    schema: {
      ok: schemaResult.diagnostics.length === 0,
      diagnostics: schemaResult.diagnostics,
    },
    askSpecs,
    sitePhases,
    schemas: schemaResult.schemas,
  };
}

/**
 * A workflow that did not make it: the diagnostics, and empty everything
 * else. The shape is the same either way, so a caller never has to ask
 * whether a field exists.
 */
function failed(diagnostics, extra = {}) {
  return {
    ok: false,
    analysis: {
      diagnostics,
      ok: false,
      core: undefined,
      graph: undefined,
      causality: undefined,
      flow: undefined,
      handoff: undefined,
      declaredArtifacts: extra.declaredArtifacts ?? [],
      modelReferences: extra.modelReferences ?? [],
    },
    lowered: { ok: false, diagnostics, lowered: undefined },
    schema: { ok: false, diagnostics: [], schemas: {} },
    askSpecs: new Map(),
    sitePhases: new Map(),
    schemas: {},
  };
}

/**
 * The diagnostics of a prepared workflow, flattened and de-duplicated.
 *
 * The layers report independently — the compiler, the facade-siting check,
 * the authoring rules and the schema synthesis — and a single script can trip
 * more than one. The editor shows them as one list, so they are merged here,
 * keeping the first occurrence of each (code, line, column, message).
 *
 * @param {PreparedWorkflow} prepared
 * @returns {Array<{code: number, line: number, column: number, message: string}>}
 */
export function collectPreparedDiagnostics(prepared) {
  const seen = new Set();
  const out = [];
  const layers = [
    prepared.analysis.diagnostics,
    prepared.lowered.diagnostics,
    prepared.schema?.diagnostics,
  ];
  for (const list of layers) {
    for (const d of list ?? []) {
      const key = `${d.code}:${d.line}:${d.column}:${d.message}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ code: d.code, line: d.line, column: d.column, message: d.message });
    }
  }
  return out;
}
