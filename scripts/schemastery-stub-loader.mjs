// The ESM resolve hook that redirects @deepseek-ai/schemastery to the stub.
//
// Registered by scripts/register-schemastery-stub.mjs.

import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const stub = pathToFileURL(
  join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'schemastery-stub.mjs'),
).href;

export function resolve(specifier, context, nextResolve) {
  if (specifier === '@deepseek-ai/schemastery') {
    return { url: stub, shortCircuit: true, format: 'module' };
  }
  return nextResolve(specifier, context);
}
