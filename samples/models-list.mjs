// dsh-workflow-runner sample —— __dsh.models (ZCode ListModels)
//
// `__dsh.models` is the runtime equivalent of ZCode's `ListModels` tool:
// an array of model ids the run is allowed to use, populated from the
// host's modelsAllowed (which itself comes from the plugin Config or
// the per-run `modelsAllowed` body field). A subagent can iterate it
// to discover what's available before calling `model(id)`.
//
// No LLM needed. Useful as a sanity check.
'use strict';
const { agent, phase, log, report, artifact, models, model } = globalThis.__dsh;

export default async function main() {

phase('List allowed models (ListModels equivalent)');
log(`__dsh.models = ${JSON.stringify(models)}`);

phase('Validate each model id works as a ModelRef');
const refs = models.map((m) => [m, model(m)]);
const table = refs.map(([id, ref]) => ({
  id,
  isModelRef: !!(ref && ref.__modelRef),
}));

artifact.table('models', {
  title: 'Allowed models for this run',
  columns: [
    { field: 'id', label: 'Model id' },
    { field: 'isModelRef', label: 'Valid ModelRef' },
  ],
});
for (const row of table) report(row, 'models');

phase('Publish a markdown report');
const md = [
  '# Models available in this run',
  '',
  `* ${models.length} model(s) allowed:`,
  ...models.map((m) => `  - \`${m}\``),
  '',
  'All entries pass `model()` validation (host checks against this allowlist).',
  '',
].join('\n');
await artifact.markdown('report', md, { title: 'Models report', primary: true });

phase('Done');
return { count: models.length, models };
}
