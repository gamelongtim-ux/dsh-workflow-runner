/**
 * The vendored ZCode engine, re-exported from one place.
 *
 * Everything in this directory talks to the engine through this module, so there
 * is exactly one import path to the vendored package and one place to change if
 * the vendored layout ever moves.
 *
 * The engine is upstream source, unmodified except the import specifier the
 * vendor script rewrites (see scripts/vendor-dynamic-workflow.mjs). Its own
 * README calls the package "no session spawning, no storage, no disk or network
 * I/O" — the engine is a pure state machine, and all of the side effects live
 * behind the four injection ports we implement in driver.js.
 */

export * from '../../packages/dynamic-workflow/dist/index.js';
