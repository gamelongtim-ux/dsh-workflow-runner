// dsh-workflow-runner sample —— TypeScript minimal pipeline
//
// v0.7.1: demonstrates the opt-in `.ts` workflow support. The host
// detects the .ts extension at start() time and compiles the script
// to a tmp `.mjs` via tsc before launching the child. From the
// child's perspective the code is plain ESM; the types are erased.
//
// This sample is intentionally non-LLM so it runs without an API key.
// It uses phase / log / report and one world.run gate to validate that
// type annotations on the workflow code don't change runtime behavior.
//
// Run from the editor: paste the absolute path to this file into the
// scriptPath field and click Run. Or via HTTP:
//
//   curl -X POST http://127.0.0.1:7910/api/run \
//     -H 'content-type: application/json' \
//     -d '{"scriptPath":"<abs path>/typed-minimal.ts"}'

import type { PhaseName, ReportTitle, WorldRunResult } from './typed-shapes';   // type-only, erased by tsc

// ZCode convention: use the ambient symbols directly. The runner's
// facade.d.ts declares these as top-level bindings during typecheck,
// and the bootstrap mounts them on globalThis.__dsh at runtime — the
// runtime shape is identical, so the destructuring works in both
// contexts without a `globalThis.__dsh` reference.

async function main(): Promise<{ ranAt: string; echo: WorldRunResult; bad: { exitCode: number; error?: string } }> {
  phase('Typed: phase tracking');
  log('phase() event sent from a .ts script');

  phase('Typed: world.run echoes');
  const echo: WorldRunResult = await world.run(
    'node',
    ['-e', 'process.stdout.write("hello from typed world.run\\n")'],
    { timeoutMs: 5000 },
  );
  if (echo.exitCode !== 0) {
    log('echo failed: ' + echo.stderr, 'warn');
  } else {
    log('echo out: ' + echo.stdout.trim());
    report({ echo: echo.stdout.trim(), exitCode: echo.exitCode, durationMs: echo.durationMs }, 'echo');
  }

  phase('Typed: failed shell command');
  const bad = await world
    .run('node', ['-e', 'process.exit(7)'], { timeoutMs: 5000 })
    .catch((err: Error) => ({ exitCode: -1, error: String(err.message || err) }));
  log(`bad exitCode=${bad.exitCode}`);
  report({ bad }, 'bad');

  phase('Typed: report a structured item');
  report({ name: 'typed', ok: true, n: 42, items: [1, 2, 3] }, 'summary');

  phase('Done');
  log('typed-minimal complete');
  return { ranAt: new Date().toISOString(), echo, bad: { exitCode: bad.exitCode, error: bad.error } };
}

export default main;