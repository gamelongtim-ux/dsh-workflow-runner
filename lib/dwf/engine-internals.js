/**
 * The engine's internals, in one place.
 *
 * ZCode's barrel (packages/dynamic-workflow/src/index.ts) exports most of
 * the analysis surface, but five functions it uses internally are not on it:
 *
 *   collectFacadeMisuse      the facade-siting check
 *   projectSiteGraph         the site graph
 *   projectCausalityGraph    the causality graph
 *   collectActorModels       the model-name authoring rule (9010)
 *   collectDuplicateActorNames  the duplicate-actor-name rules (9006 / duplicate)
 *
 * We need them because the engine's convenience entry points
 * (`analyzeWorkflowScript`, `lowerWorkflowScript`) compile against ZCode's
 * facade and offer no way to substitute our own. dsh's facade adds members
 * to that facade (see dsh-facade.js), so the compile has to happen against
 * the extended facade, and the analysis has to run on THAT program — the
 * site table and the lowering match nodes by identity, so they have to come
 * from the same program.
 *
 * These are the vendored package's own modules, imported by path. The
 * vendor manifest (packages/dynamic-workflow/vendor-manifest.json) hashes
 * the SOURCE of every vendored file, so an upstream change to any of these
 * is caught by `npm run verify:vendor` rather than surfacing as a mystery
 * at run time.
 */

export { collectFacadeMisuse } from '../../packages/dynamic-workflow/dist/analysis/facade-misuse.js';
export { projectSiteGraph } from '../../packages/dynamic-workflow/dist/analysis/graph.js';
export { projectCausalityGraph } from '../../packages/dynamic-workflow/dist/analysis/causality-graph.js';
export { collectActorModels } from '../../packages/dynamic-workflow/dist/analysis/actor-models.js';
export {
  collectDuplicateActorNames,
  FANOUT_ACTOR_NAME_CODE,
} from '../../packages/dynamic-workflow/dist/analysis/actor-names.js';
