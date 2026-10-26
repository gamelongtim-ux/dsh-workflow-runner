// Probe: what does the engine's import cache do on dsh's engine path?
//
// The engine closes its import cache on the FIRST WRITE. There are two
// triggers upstream:
//   1. a live `world.run`  (engine-world.ts: closeImportCache(..., "world-run"))
//   2. a subagent about to run a mutating tool (driver reports askMutating)
//
// dsh's subagents have NO tools, so trigger 2 cannot happen — a subagent
// cannot mutate the workspace. Trigger 1 is the real one.
//
// This probe drives a run that uses world.run and reports whether the
// engine's import cache was closed, and what event says so.
//
// Usage: node scripts/probe-import-cache.mjs

import { WorkflowRuntime } from '../lib/runtime.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ws = mkdtempSync(join(tmpdir(), 'dwf-imp-'));
const runtime = new WorkflowRuntime({
  config: { allowedModels: ['deepseek-chat'], workspaceRoot: ws },
  logger: { info() {}, warn() {}, error() {}, debug() {} },
});

// A run that writes to the workspace.
const script = `
phase("p");
const r = await world.run("node", ["-e", "process.stdout.write('x')"]);
report({ exitCode: r.exitCode });
return { ok: true };
`;

const started = await runtime.startEngine({ scriptText: script, workspaceRoot: ws });
await new Promise((r) => setTimeout(r, 2500));
const st = runtime.runs.get(started.runId);

console.log('status  :', st?.status);
console.log('settlement:', JSON.stringify(st?._engine?.settlement ?? null)?.slice(0, 300));

// The engine's own journal has the events.
const engineEvents = (st?.journal ?? []).filter((j) => j.kind === 'engine.event');
console.log('\nengine event types:');
for (const e of engineEvents) {
  if (e.type) console.log('  ', e.type);
}
const closed = engineEvents.filter((e) => e.type === 'import-cache-closed');
console.log('\nimport-cache-closed events:', closed.length);
if (closed.length > 0) console.log('  ', JSON.stringify(closed[0]));

// The engine's control plane can also report its own state.
const engine = runtime._engineControls.get(started.runId);
console.log('\nengine handle bound:', engine !== undefined);
process.exit(0);
