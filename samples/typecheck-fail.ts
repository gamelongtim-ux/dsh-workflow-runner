// dsh-workflow-runner sample — intentionally broken TypeScript
//
// v0.8.0: demonstrates the static typecheck pass. `tsc --noEmit
// --strict` runs against this file before launch and rejects the
// run with a `TS_TYPECHECK` error containing structured diagnostics.
//
// Expected /api/run response (HTTP 400):
//
//   {
//     "error": "TS typecheck failed (N errors)\n...",
//     "code": "TS_TYPECHECK",
//     "diagnostics": [
//       { "file": ".../typecheck-fail.ts",
//         "line": 22, "column": 7,
//         "code": "TS2322",
//         "message": "Type 'string' is not assignable to type 'number'." },
//       ...
//     ]
//   }
//
// The editor's error panel renders each diagnostic with the file
// path, line, column, error code, and human-readable message.
//
// Note: the runtime doesn't reach the spawn step because
// `_typecheckTs()` throws before `_transpileTs()` ever runs.

// These statements look syntactically fine but fail strict typecheck.
phase('Intentionally broken — this should never execute');

const n: number = 'this is a string, not a number';   // TS2322
const arr: string[] = [1, 2, 3];                       // TS2322 (each element)
const missing = doesNotExist;                          // TS2304

log(`n=${n} arr=${arr.join(',')} missing=${missing}`);

export default async function main(): Promise<never> {
  return { n, arr, missing } as never;
}