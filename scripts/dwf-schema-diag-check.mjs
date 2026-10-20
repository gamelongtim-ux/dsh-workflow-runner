// The schema layer must report why it refused.
//
// Regression probe for a defect the sample migration found: prepareWorkflow
// counted the schema diagnostics into `ok`, but never carried them out, so a
// script refused by the data contract came back as "did not compile" with no
// reason attached.
//
// Usage: node scripts/dwf-schema-diag-check.mjs

import { compileWorkflow } from '../lib/dwf/index.js';

const SCRIPT = `
interface Row { id: string; note: string | undefined }
const rows: Row[] = [];
report({ rows: rows.map((r) => ({ id: r.id, note: r.note })) });
return { rows };
`;

const out = compileWorkflow(SCRIPT);

console.log('ok         :', out.ok);
console.log('diagnostics:', out.diagnostics.length);
for (const d of out.diagnostics) {
  console.log(`  ${d.code}@${d.line}:${d.column} ${d.message}`);
}

const problems = [];
if (out.ok) problems.push('the script compiled, but a non-optional property carrying undefined must be refused');
if (out.diagnostics.length === 0) problems.push('it was refused with no diagnostic — the schema layer is being swallowed');

if (problems.length > 0) {
  console.log(`\nFAIL: ${problems.join('; ')}`);
  process.exit(1);
}
console.log('\nPASS');
