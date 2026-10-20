import { prepareWorkflow } from '../lib/dwf/prepare.js';

const p = prepareWorkflow('const m = models.length; const c = constants.rpcVersion; return { m, c };', {
  models: ['model-a', 'model-b'],
  constants: { rpcVersion: 7, artifactKinds: { declare: ['chart'], publish: ['file'] } },
});
console.log('ok:', p.ok);
console.log('--- lowered head ---');
console.log(p.lowered.lowered.code.split('\n').slice(0, 16).join('\n'));
