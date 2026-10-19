// Shared type aliases for the typed-minimal.ts sample.
//
// Kept as a separate file to demonstrate cross-file type-only imports
// (`import type { ... } from './typed-shapes'`). tsc erases both the
// imports and these declarations entirely — none of it survives into
// the compiled .mjs, so the child never sees them.

export type PhaseName = string;
export type ReportTitle = string;

export interface WorldRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs?: number;
  error?: string;
}