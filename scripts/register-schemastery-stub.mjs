// Point `@deepseek-ai/schemastery` at the local stub.
//
// This is an ESM resolve hook: everything else resolves normally, and only
// the one specifier is redirected. The stub has the same shape as the real
// package, so a plugin that uses the API wrongly fails here.
//
// Usage: node --import ./scripts/register-schemastery-stub.mjs <script>

import { register } from 'node:module';

register('./schemastery-stub-loader.mjs', import.meta.url);
