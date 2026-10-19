// dsh-workflow-runner sample — clean TypeScript that passes strict
//
// v0.8.0: companion to `typecheck-fail.ts`. The strict typecheck pass
// runs against this file and emits zero diagnostics, so the run
// proceeds to the emit pass and child spawn. Run completes with
// `status: completed`, no type errors.
//
// Demonstrates the ambient-facade pattern: `phase`, `log`, `world`,
// `report` are visible as bare names because `lib/facade.d.ts`
// declares them globally during typecheck, and the bootstrap mounts
// them on `globalThis` at runtime. `interface` / `import type` from
// cross-file `.ts` files compile away cleanly.

interface EchoResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

phase('Strict-typed: world.run echoes with typed result');
const echo: EchoResult = await world.run(
  'node',
  ['-e', 'process.stdout.write("hello from typed-ok\\n")'],
  { timeoutMs: 5000 },
);
if (echo.exitCode !== 0) {
  log(`echo failed: ${echo.stderr}`, 'warn');
} else {
  log(`echo out: ${echo.stdout.trim()}`);
  report({ exitCode: echo.exitCode, stdout: echo.stdout }, 'echo');
}

phase('Strict-typed: report a structured item');
const ok: boolean = true;
const items: readonly number[] = [1, 2, 3];
report({ name: 'typecheck-ok', ok, n: items.length, items }, 'summary');

phase('Done');
log('typecheck-ok complete');

export default async function main(): Promise<{
  echo: { exitCode: number; stdout: string };
  ok: boolean;
  ranAt: string;
}> {
  return {
    echo: { exitCode: echo.exitCode, stdout: echo.stdout.trim() },
    ok,
    ranAt: new Date().toISOString(),
  };
}