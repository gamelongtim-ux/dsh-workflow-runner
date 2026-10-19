/**
 * The compile-time half of a Dynamic Workflow.
 *
 * One script goes in; four graphs, a lowered function body, the per-ask type
 * contract and the site table come out. Nothing here touches the network, the
 * filesystem or the LLM — the whole point of this layer is that a workflow's
 * shape is known *before* it runs.
 *
 * The pipeline, and where each piece comes from:
 *
 *   analyzeWorkflowScript(script)   → the four graphs + diagnostics
 *                                      (site / causality / control-flow / handoff)
 *   lowerWorkflowScript(script)     → the lowered async function body
 *                                      (every facade call rewritten to __host.*,
 *                                       every site carrying a stable site id)
 *   createWorkflowProgram(script)   → one typed program, shared by the site
 *                                      table and the schema synthesis below
 *   synthesizeAskSchemas(program)   → JSON Schema per typed ask site,
 *                                      synthesized from the ask<T> type argument
 *   buildAskSpecs(table, schemas)   → the engine's per-site spec map
 *
 * Why the site table and the schemas are built from ONE program: the engine
 * treats a missing ask spec as a wiring error and fails the whole run
 * (MissingAskSpec). Two separate compiles could in principle disagree about
 * which sites exist, and that disagreement would surface as a run-time failure
 * rather than a compile error. One program makes the two impossible to
 * disagree.
 */

import {
  analyzeWorkflowScript,
  buildAskSpecs,
  collectSitePhases,
  collectSites,
  createWorkflowProgram,
  lowerWorkflowScript,
  synthesizeAskSchemas,
} from './engine.js';

/**
 * @typedef {object} PreparedWorkflow
 * @property {import('./engine.js').AnalyzeResult} analysis - the four graphs + diagnostics
 * @property {import('./engine.js').LowerResult} lowered - the lowered function body
 * @property {Map<string, import('./engine.js').AskSpec>} askSpecs - per-ask-site contract
 * @property {Map<string, string>} sitePhases - site id → the phase it was born in
 * @property {Record<string, unknown>} schemas - ask site id → JSON Schema
 * @property {boolean} ok - submittable: no diagnostics at all
 */

/**
 * Compile a workflow script.
 *
 * @param {string} scriptText - the author's script (TypeScript, no imports)
 * @returns {PreparedWorkflow}
 */
export function prepareWorkflow(scriptText) {
  const analysis = analyzeWorkflowScript(scriptText);
  const lowered = lowerWorkflowScript(scriptText);

  // One program for the site table and the schema synthesis.
  const workflow = createWorkflowProgram(scriptText);
  const table = collectSites(workflow);
  const schemaResult = synthesizeAskSchemas(workflow, table);
  const askSpecs = buildAskSpecs(table, schemaResult.schemas);
  const sitePhases = analysis.core === undefined ? new Map() : collectSitePhases(analysis.core);

  return {
    analysis,
    lowered,
    askSpecs,
    sitePhases,
    schemas: schemaResult.schemas,
    ok: analysis.ok && lowered.ok && schemaResult.diagnostics.length === 0,
  };
}

/**
 * The diagnostics of a prepared workflow, flattened and de-duplicated.
 *
 * The three layers report independently — the analyzer, the lowering pass and
 * the schema synthesis — and a single script can trip more than one. The
 * editor shows them as one list, so they are merged here, keeping the first
 * occurrence of each (code, line, column, message).
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
    prepared.analysis.diagnostics,
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
