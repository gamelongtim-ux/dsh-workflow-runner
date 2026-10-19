// A stage body for structural amend (v0.10.0), injected by FILE rather
// than inline code:
//
//   POST /api/amend { runId, name: "review", wait: true,
//                    codePath: "amend-stage-snippet.mjs" }
//
// `codePath` is resolved against the run's workspaceRoot — the same
// confinement `files.*` uses — so a stage body cannot be loaded from
// outside the workspace. The same `PATH_ESCAPE` guard applies.
//
// The body is a function expression, exactly like `hole<T>`. It gets
// `ctx` describing the run at injection time, plus the full `__dsh`
// facade: agent, world.run, files, git, report, artifact, channel, …
// and therefore the same sandboxed env and world.run allowlist the
// original run has.
export default async (ctx) => {
  const { phase, log, report } = globalThis.__dsh;

  await phase('Injected review');   // folds into the run's phase pills
  log(`review: run has ${ctx.run.phases.length} phase(s), ${ctx.reports.length} report(s)`);

  const verdict = {
    stage: ctx.stage.name,
    phaseAtInjection: ctx.run.currentPhase,
    reportsSoFar: ctx.reports.length,
    priorStages: ctx.previous.map((s) => s.name),
    models: ctx.run.models,
  };

  await report(verdict, 'review');
  return verdict;
};
