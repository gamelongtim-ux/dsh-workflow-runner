# dsh-workflow-runner

<p align="right">
  <a href="README.md">🇬🇧 English</a> · <a href="README.zh-CN.md">🇨🇳 中文</a>
</p>

Bring ZCode-style **dynamic-workflows** semantics into the [dsh][dsh] web UI.
Write a small JS workflow script that uses top-level-await-friendly facade calls
(`phase` / `log` / `report` / `agent(name).ask(prompt)` / `world.run(cmd, args)`)
and the plugin runs it in an isolated Node child process, broadcasting live
progress to the chat composer dock, a per-turn tail card, and a floating monitor.

[dsh]: https://github.com/deepseek-ai/dsh

> **Target host:** dsh **desktop** profile, version **V0.2.0-rc.2** and above.
> The plugin is independent of [`dsh-agent-teams`][dteams] — it does not
> require it, does not collaborate with it, and will not break if you uninstall it.
[dteams]: https://www.npmjs.com/package/@nanmicoder/dsh-agent-teams

## What you get

- **Three UI slots** registered through cordis:
  - `conversation.composer.dock` — `▶ Workflow` button (opens the editor in a new window).
  - `conversation.chat.turnTail` — a passive monitor card after each assistant turn.
  - `shell.overlay` — a small floating dot top-right while a run is active.

- **A standalone web app** at `/workflow/` showing:
  - script picker (with three sample workflows), file path, source viewer;
  - `▶ Run` / `◼ Stop` buttons;
  - live phase pills, sub-agent activity, reported items, event log.

- **A server-side runtime** that spawns the user script as a Node child process,
  pipes stdio JSON-RPC between them, talks to the DeepSeek chat-completion API
  using the same key resolution path as the dsh `balance` service, and runs
  shell commands under controlled timeouts.

## Install

The plugin is a normal dsh bundle. From the dsh host (WSL where dsh itself runs),
in the **desktop** profile:

```bash
dsh plugin --profile desktop add dsh-workflow-runner
```

That pulls the published npm release. To track this repository instead:

```bash
git clone https://github.com/gamelongtim-ux/dsh-workflow-runner.git
cd dsh-workflow-runner
dsh plugin --profile desktop add file:"$PWD"
```

Then restart `dsh web` and look for the `▶ Workflow` button in the chat composer dock.

Requires **dsh 0.2.0-rc.2 or newer** — declared as `engines.dsh`, so the plugin
market can show the host requirement instead of "undeclared".

> 📌 If pnpm refuses to re-copy on the same version (a pnpm 12 `add file:`
> quirk), bump `version` in `package.json` or use `update.cmd`.

## Sharing this plugin with other dsh users

There are three install paths; pick the one that matches the audience you are
handing the URL to.

| Path | What the user pastes in dsh's "添加插件" dialog | Notes |
| --- | --- | --- |
| **npm name** *(default)* | `dsh-workflow-runner` | Published on npmjs.org since **0.1.5**. Fastest in China through npm's mirror, and locks a version. |
| **GitHub URL** | `https://github.com/gamelongtim-ux/dsh-workflow-runner` | Always available; pulls the latest `main` HEAD rather than a released version. |
| **Local path** | `<absolute path to a cloned checkout>` | Best for users who want to follow your local edits; pair with `update.cmd`. |

> The dsh desktop install dialog also has a "中国大陆镜像源" dropdown —
> that mirror is a read-side accelerator; the package itself must still be
> reachable on npmjs.org (or GitHub).

### Version compatibility

The npm manifest declares the host requirement in `engines.dsh`; dsh's plugin
market reads that field (alongside any lockstep `@deepseek-ai/dsh-*` peers) to
label a card compatible or incompatible. `dsh.compatibility.dshReleases` is
also declared as author-facing metadata. dsh itself enforces only
`peerDependencies` at load time, so this package deliberately declares **no**
`@deepseek-ai/dsh-*` peers: it just needs the mount points and services the
base bundle provides, and a host peer range would risk rejecting a host that
works fine.

## Standalone (no dsh required)

Useful for testing scripts without involving the dsh host:

```bash
node lib/standalone.js          # listens on 127.0.0.1:7910
```

Open <http://127.0.0.1:7910/> and pick a sample.

## Writing a workflow

A script is an **ES module** (`.mjs`) that default-exports an `async function main()`:

```js
'use strict';
const { agent, world, phase, log, report } = globalThis.__dsh;

export default async function main() {
  phase('Plan');
  const draft = await agent('planner', {
    system: 'You are a senior algorithm textbook author.',
  }).ask('Explain the Hungarian algorithm in 3 short paragraphs.');

  phase('Critique');
  const issues = await agent('critic', {
    system: 'List exactly 3 most important omissions, ≤25 words each.',
  }).ask(draft);

  phase('Gate');
  const wc = await world.run('node', ['-e',
    'process.stdout.write(String(arguments[0].split(/\\s+/).filter(Boolean).length))',
    '--', draft,
  ], { timeoutMs: 5000 });
  if (wc.exitCode !== 0) log('gate flagged exit=' + wc.exitCode, 'warn');

  report({ draft, issues, wordCount: Number(wc.stdout) }, 'final');
  phase('Done');
  return { ok: true };
}
```

### Facade reference

| Call | Returns | Notes |
| --- | --- | --- |
| `phase(name)` | `Promise<{ok:true}>` | Mark a workflow phase. Same name in a loop is one UI pill with an `× N` badge. |
| `log(message, level='info')` | `Promise<{ok:true}>` | Stream into the event log. `level` ∈ `info`, `warn`, `error`, `debug`. |
| `report(item, tag=null)` | `Promise<{ok, artifactId?}>` | Surface a structured item in the Reports panel. If `tag` matches a `chart/table/metrics/board` artifact id, the item is also appended to that artifact's data. |
| `agent(name, opts).ask(prompt)` | `Promise<{content, usage}>` | Spawn (or reuse) a sub-agent by name; same-name reuse keeps chat history. `opts` ∈ `{system, model, temperature, maxTokens}`. |
| `agent(name).close()` | `Promise<{closed:true}>` | (Optional) hint; history is per-run, freed when the run ends. |
| `world.run(cmd, args, opts)` | `Promise<{exitCode, signal, stdout, stderr, durationMs}>` | Spawn a local shell command. Non-zero exit is a value, not an exception. The runtime rejects `cmd` not in the per-run allowlist. `opts.cwd / env / timeoutMs` configurable. |
| `artifact.chart(id, spec)` | `Promise<{ok}>` | Declare a chart preset fed by `report(item, id)`. `spec ∈ {x, y, type, baseline, title}`. |
| `artifact.table(id, spec)` | `Promise<{ok}>` | Declare a table. `spec ∈ {columns, key?}`. |
| `artifact.metrics(id, spec)` | `Promise<{ok}>` | Declare a row of big-number tiles. `spec ∈ {metrics: [{field,label,unit?},…]}`. |
| `artifact.board(id, spec)` | `Promise<{ok}>` | Declare a kanban board. `spec ∈ {key, status, columns, cardTitle?, detail?}`. |
| `artifact.markdown(id, content, opts)` | `Promise<{id, version}>` | Publish markdown text (256 KB cap). `opts ∈ {title, description, primary}`. |
| `artifact.file(id, path, opts)` | `Promise<{id, version}>` | Publish a workspace file (text only, 20 MB cap). `opts ∈ {title, description, primary}`. |
| `args` | `Readonly<Record<string, unknown>>` | Frozen plain object passed via `POST /api/run` body `args: object`. 64 KB cap. |
| `files.glob(pattern)` | `Promise<string[]>` | Workspace-relative paths matching the glob. Sandbox: `workspaceRoot` per run. 2000 file cap. Supports `**`, `*`, `?`, `[abc]`. |
| `files.read(path)` | `Promise<string>` | Read a workspace-relative file as UTF-8. 256 KB cap. |
| `files.grep(pattern, glob?)` | `Promise<{path,line,text}[]>` | Regex match across workspace files (optionally scoped to a glob). 2000 matches / 256 KB cap. |
| `git.changedFiles(base?)` | `Promise<string[]>` | `git diff --name-only <base>` (or uncommitted + untracked if no base). Rejects catchably if not a git repo. |
| `git.diff(base?, path?)` | `Promise<string>` | `git diff <base> -- <path>` (whole diff when path omitted). 512 KB cap. |
| `git.status()` | `Promise<{branch,clean,staged,unstaged,untracked}>` | `git status --porcelain --branch`, parsed. |
| `git.log(count?)` | `Promise<{hash,subject,author,date}[]>` | `git log -n<count>`, default 20, max 100. |
| `channel<T>(name?)` | `{ send, close, [Symbol.asyncIterator] }` | In-process FIFO with async iteration. Producing side owns `close()` in a `finally`. `send` after `close` throws `ChannelClosed`. |
| `future<T>(body)` | `Promise<T>` | Run `body` on the next microtask; return its promise. `Promise.all([future(a), future(b)])` for two concurrent stages. |
| `model(id)` | `{ __modelRef, id }` | Marker passed to `agent(name, { model })`. Host validates `id` against `modelsAllowed` (default `['deepseek-chat']`, plugin Config overridable). |
| `agent.ask(prompt, { result: <shape> })` | typed object (or throws) | v0.4.0. Pass a plain object describing the expected structure; the host generates a JSON Schema, asks the LLM in JSON mode, parses and validates, and returns the parsed object. Shape syntax: `'string' \| 'number' \| 'boolean'` for primitives; `['string']` for arrays of primitives; `[{...}]` for arrays of objects; `{ key: <shape>, ... }` for nested objects (all keys required). Retries once on parse/validate failure. Without `result`, ask() returns `{ content, usage }` as before. |
| `askUser(question, opts?)` | Promise<string \| boolean> | v0.4.0. Park the script until the user answers. `opts.kind: 'confirm'` returns boolean. `opts.options: string[]` returns one of the strings (rendered as a button row). Without options, a free-text input. 5-minute host-side watchdog. |
| `hole(name, prompt, ctx?, body?)` | Promise<any> | v0.5.0. Mid-run code injection. Three forms: unfilled (`hole(name, prompt, ctx)` — body comes from `/api/hole-answer`), filled with ctx (`hole(name, prompt, ctx, bodyFn)`), filled without ctx (`hole(name, prompt, bodyFn)`). The body string is eval'd as `new AsyncFunction('ctx', body)(ctx)`; it has access to `ctx` and to `globalThis.__dsh.*`. 10-minute watchdog. |
| `escalate(question, opts?)` | Promise<string \| boolean> | v0.6.0. "Ask the main agent" with Think via LLM. Same parked-RPC shape as `askUser`, but the editor offers a 🧠 Think via LLM button that dispatches an LLM call (using run context: recent log + question + options) and uses its response as the answer. `kind: 'confirm'` returns boolean; `options: [...]` returns one of them. 5-min watchdog. |
| `__dsh.models` | `string[]` | v0.6.0. List of model ids this run is allowed to use. Equivalent to ZCode's `ListModels` tool. Populated from the host's `modelsAllowed`. |
| `t.string` / `t.number` / `t.boolean` / `t.array(item)` / `t.optional(s)` | shape fragment | v0.6.0. Sugar for `ask<T>` result shapes. Identical to the literal-shape syntax the host already understands (`'string'`, `['string']`, etc.); the constants read better in JSDoc and code. |
| `shape(s)` | same as `s` | v0.6.0. Identity wrapper. `result: shape({title: t.string})` is the same as `result: {title: 'string'}`. |
| `route(MODELS, routerFn, answererFn)` | Promise<any> | v0.6.0. One-call multi-model routing. Runs `routerFn(MODELS.light)` to pick a tier, then `answererFn(MODELS[tier])` and returns its result. Parses `{"tier": "light"\|"strong"}` from router; falls back to `'light'` on parse error. |

> The first argument to `agent(name, opts)` may be just `agent('planner')`; `opts` is optional.

## Samples

Ten are in `samples/`:

| File | Pattern |
| --- | --- |
| `smoke.mjs` | Phase + log + world.run + report — no LLM calls; runs without an API key. |
| `planner-critic.mjs` | `planner` then `critic`, then `planner` again with critique in prompt — bounded single-thread loop. |
| `fanout-summarize.mjs` | Three parallel `summarizer-N` agents, then a `reducer` agent synthesizes the result. |
| `artifact-demo.mjs` | Declares a chart + metrics + board, runs three rounds of `world.run`, feeds the chart with `report(item, 'latency')`, publishes a markdown summary as the primary deliverable. No API key. |
| `confirm-demo.mjs` | Calls `world.run` with three different commands (`node`, `git`, `powershell`) so the confirm modal can be exercised and the per-run allowlist can be observed. |
| `loop-phases.mjs` | `for (i=0; i<5; i++) phase("check")` to show phase folding: one pill with `× 5` in the UI. |
| `file-grep.mjs` | `files.grep('TODO', '**/*.mjs')` × 3 keywords; renders per-file table + markdown summary. No API key. |
| `git-changed.mjs` | `git.status` + `git.changedFiles` + `git.log` + `git.diff` rendered as one markdown report. Catches git-rejection gracefully if workspace isn't a repo. |
| `channel-pipeline.mjs` | 3 producer `future`s → `channel('facts')` → 2 verifier `future`s. Mock data via `world.run('node', …)` so no API key is needed. |
| `model-router.mjs` | Light router decides per-question tier (light / strong); answerer uses the chosen `model()`. Will error on LLM calls in a keyless env; the routing shape itself is correct. |
| `typed-plan.mjs` | `agent.ask(prompt, { result: <shape> })` returns a structured plan object the script reads with `plan.paragraphs[0]` etc. Needs an LLM key. |
| `ask-user.mjs` | Three `askUser()` calls in sequence: a three-option picker, a confirm, a free-text. No API key needed. |
| `hole-demo.mjs` | `askUser` picks a threshold, then `await hole(name, prompt, ctx)` parks; the body string is submitted via `POST /api/hole-answer` and is what unblocks the script. No LLM needed. |
| `amend-demo.mjs` | Three fixed `agent.ask` calls. Run twice; the second run with `amendFrom: <firstRunId>` reuses the prior journal's results without re-calling the LLM. |
| `models-list.mjs` | Lists `__dsh.models`, builds a table artifact. No LLM. |
| `route-demo.mjs` | Two questions routed through `route(MODELS, router, answerer)`; the answerer gets the right tier. Needs an LLM. |
| `escalate-demo.mjs` | Three sequential `escalate()` calls (options / confirm / free-text). Each can be answered by the user or via Think-via-LLM. |
| `typed-minimal.ts` + `typed-shapes.ts` | **TypeScript** smoke sample — phase / log / report / world.run, with `import type` cross-file imports and a local `interface`. Runs without an API key. Requires `typescript` as a dev dep (see [TypeScript workflows](#typescript-workflows) below). |
| `samples/saved-examples/summarize.mjs` | Example saved workflow with JSDoc frontmatter (`@name`, `@description`, `@whenToUse`, `@arg topic {string=...}`). Copy to `~/.dsh/workflows/` to see in the editor. |
| `samples/saved-examples/scan-todos.mjs` | Same pattern; uses `files.grep` to scan, produces a table + markdown artifact. |
| `samples/saved-examples/hollow-tool.mjs` | Greet workflow with a `hole()` call; the user picks the message format by writing a JS body. |

## TypeScript workflows

`v0.7.1` added opt-in support for writing workflows in **TypeScript**.
Workflows with a `.ts` (or `.mts`) extension are compiled to ESM `.js`
in a per-run tmp directory via the local `typescript` package's `tsc`
CLI before being launched. The child sees plain ESM; all types and
type-only imports are erased.

### Static typecheck (v0.8.0)

Every `.ts` workflow is also **typechecked** against
`lib/facade.d.ts` — an ambient declaration that mirrors ZCode's
dynamic-workflows §16.2 contract. `tsc --noEmit --strict` runs in a
per-run tmpdir before the emit pass; type errors reject the run
with HTTP 400 and a structured `diagnostics` array, never reaching
the spawn step.

The facade declares everything a user script can call:

```ts
declare const phase: (name: string) => void;
declare const log: (message: string, level?: 'info'|'warn'|'error') => void;
declare const report: (item: unknown, artifactId?: string) => void;
declare const agent: (name?: string, persona?: string | AgentPersona) => Agent;
declare const world: { run(cmd: string, args?: string[], opts?: { timeoutMs?: number }): Promise<WorldRunResult> };
declare const files: { glob(...): Promise<string[]>; read(...): Promise<string>; grep(...): Promise<GrepMatch[]> };
declare const git: { changedFiles(...): Promise<string[]>; diff(...): Promise<string>; status(): Promise<GitStatus>; log(...): Promise<GitCommit[]> };
declare const channel: <T>(name?: string) => Channel<T>;
declare const future: <T>(body: () => Promise<T>) => Promise<T>;
declare const model: (id: string) => ModelRef;
declare const hole: <T>(name: string, prompt?: string) => Promise<T>;
declare const askUser: (q: string, opts?: ...) => Promise<string>;
declare const escalate: (q: string, opts?: ...) => Promise<string>;
declare const artifact: { file(...); markdown(...); chart(...); table(...); metrics(...); board(...) };
// ... plus all the supporting interfaces
```

User scripts use these as ambient names (`phase('Plan')`) or via
the `globalThis.__dsh` namespace the bootstrap mounts at runtime.
Both styles work; both typecheck against the same facade.

### Skipping typecheck

Opt-out per-run: send `typecheck: false` in the `/api/run` payload.
The runtime still emits with `--strict`, but skips the dedicated
typecheck pre-flight.

Opt-out per-deploy: in dsh **Settings → Plugins → dsh-workflow-runner**,
uncheck **typecheck.strict**. Useful when you have scripts that
rely on `as any` everywhere and don't want to fix them.

### Setup

```bash
npm install --save-dev typescript
```

That's it — `dsh-workflow-runner` resolves `typescript/bin/tsc`
relative to itself via `createRequire(import.meta.url)`, so a
sibling install is enough.

### What you can write

- `import type { ... } from './local-shapes'` — cross-file type-only
  imports work; tsc erases them.
- Local `interface` and `type` declarations — erased, no runtime cost.
- Any TypeScript syntax that compiles to ES2022 ESM
  (`async`/`await`, `Promise.all`, `for await`, `?.`, etc).

### What you can't do (yet)

- Custom tsconfig.json per script — the host uses a fixed set of
  compiler flags (`--target es2022 --module esnext --moduleResolution
  bundler --skipLibCheck --esModuleInterop --strict`). If you need
  custom options, transpile manually and point at the resulting `.mjs`.
- External npm packages — only your local sibling `.ts`/`.mts` files
  get copied into the compile dir. Node's module resolution at child
  load time will pick up packages from `node_modules` as usual.
- `tsx` / `esbuild` / other runners — only `tsc` is wired up.

### Compile pipeline

1. `WorkflowRuntime.start()` sees the `.ts` extension and calls
   `_transpileTs(absScript)`.
2. A fresh tmp dir is created at
   `os.tmpdir()/dsh-workflow-ts/run-XXXXXX/`, with a tiny
   `package.json` containing `{"type":"module"}` so the compiled
   `.js` is loaded as ESM.
3. The entry file and every sibling `.ts`/`.mts` in its source
   directory are copied into the tmp dir.
4. `tsc` is invoked with `cwd: tmpDir` and `--rootDir tmpDir`, so
   outputs stay flat at `<tmpDir>/<entry>.js`.
5. The child is spawned with the compiled path; the original
   `.ts` path is preserved on `state.scriptPath` so `/api/runs`
   shows the user's entry (not the cleaned-up tmp artifact).
6. On terminal status (`completed` / `error` / `stopped`),
   `#setStatus` invokes the cleanup callback, which removes the
   tmp dir.

### Failure modes

| `code` | Cause |
| --- | --- |
| `TS_MISSING_DEP` | `typescript` is not installed. Run `npm install --save-dev typescript`. |
| `TS_COMPILE_FAIL` | `tsc` exited non-zero. The full stderr/stdout is embedded in the thrown error. |
| `TS_COMPILE_TIMEOUT` | Compile exceeded 30 seconds (rare for small scripts; adjust in `lib/runtime.js` for big projects). |

### Example

```ts
// typed-minimal.ts
import type { WorldRunResult } from './typed-shapes';

const { phase, log, report, world } = globalThis.__dsh as any;

export default async function main() {
  phase('Typed: world.run echoes');
  const echo: WorldRunResult = await world.run(
    'node', ['-e', 'process.stdout.write("hello\\n")'], { timeoutMs: 5000 }
  );
  report({ echo: echo.stdout.trim() }, 'echo');
}
```

## Saved workflows

The plugin reads and writes `~/.dsh/workflows/<name>.mjs` (Config
`workflowsDir` overrides). Each file is a workflow plus JSDoc-style
frontmatter:

```js
/** dsh-workflow
 * @name my-workflow
 * @description One-line description
 * @whenToUse When to reach for this
 * @arg topic {string="Hungarian algorithm"} The topic
 * @arg depth {number=2} How deep
 */
'use strict';
const { agent, args, ... } = globalThis.__dsh;
export default async function main() { ... }
```

The editor's "Saved workflows" row under the samples lists everything in
the directory; click to load into the editor, edit, then "💾 Save…" to
write a new one (with auto-generated frontmatter) or to update an
existing one.

## Eval a snippet (no run, no LLM)

`POST /api/eval` with `{ code, args?, timeoutMs?, worldRunAllowlist? }`
returns `{ status, log, result }` synchronously. Facade is pruned to
`args, log, files, git, world.run, channel, future` — `agent`,
`artifact.*`, `phase`, `report`, `model`, `askUser` are not available
and any reference throws. The editor's "Try a snippet" panel under the
main editor is a thin wrapper around this endpoint.

```bash
curl -X POST http://127.0.0.1:7910/api/eval \
  -H 'content-type: application/json' \
  -d '{"code":"export default async function main() { log(\"hi\"); return 42; }"}'
```

## Mid-run human questions

Inside a script, `await askUser('What threshold?', { options: ['90','95','100'] })`
parks the script and shows a card in the editor. The user picks one and
clicks; the script resumes with the picked value. The protocol:

```
child → host: { id, method: 'question.ask', params: { questionId, question, kind?, options? } }
host broadcasts: { event: 'question.asked', question: { questionId, question, kind, options, askedAt } }
[user fills the form, editor POSTs to /api/question-answer]
POST /api/question-answer { runId, questionId, answer }
host writes to child stdin: { id: <original rpcId>, result: <answer> }
child's await askUser() resolves with answer
```

5-minute watchdog per question covers the "UI never answered" case.

## Approving shell commands (confirm modal)

Any `world.run` call in a script is a shell command the workflow wants to
spawn on your machine. Before a run starts, the editor scans the script for
`world.run("name", …)` calls, dedupes the names, and shows them in a modal:

- **Checked** → the runtime will allow `world.run` with that exact `cmd` for
  the duration of this run.
- **Unchecked** → any `world.run` with that `cmd` is rejected with
  `world.run: command 'X' is not in the approved list for this run` and the
  event is logged as `world.run.declined`.

The allowlist is per-run and is **not persisted** — every Run re-asks. This is
the safe default: a script that grows a new `world.run` call site between
edits will show that new command in the modal next time you Run it.

Scripts with no `world.run` skip the modal entirely (no noise).

## Sandbox (v0.9.0)

`v0.9.0` added **practical OS-level sandboxing** for the workflow
child process. Three layers:

### 1. Env scrubbing
The bootstrap child has its `process.env` filtered through
`lib/runtime.js`'s `_scrubChildEnv(allowlist, denylist, env)` before
spawn. The default allowlist keeps the toolchain essentials
(`PATH`, `HOME`, `LANG`, `USER`, `SHELL`, `TERM`, …) plus all
`DSH_WORKFLOW_*` keys the host injects for the run. The default
denylist matches every LLM-provider API key, every cloud-cred
prefix, every VCS token, every dynamic-linker hijack vector
(`LD_PRELOAD`, `NODE_OPTIONS`, `DYLD_INSERT_LIBRARIES`), and the
host's own DSH bookkeeping (`DSH_HOME`, `DSH_API_KEY`, …).

The run log announces the result:
```
sandboxed env: kept 15 keys, stripped 5 sensitive keys (from 80 host keys) — DSH_API_KEY, DEEPSEEK_API_KEY, AWS_ACCESS_KEY_ID, LD_PRELOAD, NODE_OPTIONS
```

The same scrubbed env is reused for any `world.run` shell child
spawned by the workflow, so `node` / `git` / `npm` invocations
inherit the same protection.

### 2. Path confinement
`files.glob` / `files.grep` / `git.diff` now reject workspace
escapes with `code: 'PATH_ESCAPE'`. Patterns anchored to
`/etc/...` or `C:\…`, or containing `..` segments, are caught
before the walk starts. `world.run`'s `opts.cwd` is also checked
against `state.workspaceRoot`.

### 3. Configurable allow/deny lists
In **Settings → Plugins → dsh-workflow-runner** → **sandbox**:
- `enabled` (default `true`) — turn scrubbing on/off
- `allowlist` — extra env keys to KEEP (added to defaults)
- `denylist` — regex patterns of keys to STRIP (added to defaults)

Per-run override: send `sandbox: false` to bypass; send
`sandbox: { allowlist: [...], denylist: [...] }` to override.

### Out of scope
Real OS-level isolation — Windows Job Object, AppContainer,
Linux cgroups/namespaces, macOS `sandbox-exec` — is
platform-specific and lives in v0.10.0+. v0.9.0 is the strongest
sandbox the runtime layer can deliver portably.

## Structural amend (v0.10.0)

`v0.10.0` adds ZCode's `AmendWorkflow`: **inject a new stage into a
workflow that is already running**.

This is different from `amendFrom` (v0.5.0). `amendFrom` re-runs a
*finished* workflow against the previous run's journal so identical
`agent.ask` / `world.run` calls replay from cache. Structural amend
touches the *live* run: nothing is restarted, nothing is replayed, and
the original plan keeps executing untouched while the amendment
interleaves with it.

```bash
curl -X POST http://127.0.0.1:7910/api/amend \
  -H 'content-type: application/json' \
  -d '{
        "runId": "<a run that is currently running>",
        "name": "review",
        "wait": true,
        "code": "async (ctx) => { return { phase: ctx.run.currentPhase }; }"
      }'
```

| Field | Meaning |
| --- | --- |
| `runId` | required — the live run to amend |
| `name` | label shown in the log and the stage list |
| `code` | inline body (see the three accepted shapes below) |
| `codePath` | load the body from a file instead, resolved against the run's `workspaceRoot` |
| `context` | extra keys merged into the stage's `ctx` |
| `wait` | `true` resolves only once the stage has settled |
| `timeoutMs` | ceiling for `wait: true` (max 5 min) |

`GET /api/amend/stages?runId=…` lists them. The run's own
`/api/state` carries `injectedStages`, and the SSE stream emits
`stage.injected`, `stage.started` and `stage.finished`.

### The stage runs *inside* the run

That is the whole point. An injected stage executes in the live child
process, so it gets the same `agent` handles — and therefore the same
per-agent chat history — as the original script, plus the same
`world.run` allowlist, the same scrubbed env (v0.9.0) and the same
workspace confinement. It is a peer of the script's own `future()`
blocks, and it interleaves at every `await`.

It is therefore **not** a way around the sandbox. A stage that reads
`process.env` sees exactly what the script sees; `codePath` goes
through the same `#resolveInWorkspace` confinement as `files.*` and is
rejected with `PATH_ESCAPE` outside the workspace.

### Body shapes

Three forms are accepted, tried in order:

```js
// 1. `export default …` — a standalone .mjs file, so one file can be
//    both a runnable sample and an injectable stage body
export default async (ctx) => { return { ok: true }; };

// 2. a bare function expression — the hole<T> convention
async (ctx) => { return { ok: true }; }

// 3. a bare statement block (return allowed inside)
const n = ctx.reports.length;
return { n };
```

Leading `//` and block comments are stripped first, so a stage file may
open with a docblock. See `samples/amend-stage-snippet.mjs`.

### `ctx`

The context is assembled host-side at injection time:

```js
{
  stage:   { id, name, injectedAt, runId },
  run:     { runId, status, scriptPath, workspaceRoot, currentPhase,
             phases, phaseSummary, agents, models },
  args:    <the run's user args>,
  reports: [ … last 50 … ],
  artifacts: [ … ids … ],
  previous: [ { id, name, result, endedAt } … ],  // earlier stages in THIS run
  ...context,                                     // caller's extra keys
}
```

`previous` is how amendments build on each other.

### From the script side

```js
if (globalThis.__dsh.stages) {
  await globalThis.__dsh.stages.await({ timeoutMs: 15000 });
  const all = await globalThis.__dsh.stages.list();
}
```

You rarely need to. The bootstrap drains outstanding stages
automatically before signalling `finished`, so a stage that lands just
before the script returns still gets to finish.

### Failure and limits

A stage that throws is recorded as `status: 'error'` and **the run keeps
going** — an amendment is not part of the original plan, so it must not
be able to take the run down. Body ≤ 64 KB, ≤ 32 stages per run, ≤ 4
in flight at once. Injection into a terminal run, a run restored from
disk, or an eval/snippet run returns HTTP 409.

## Amend cache (v0.11.0)

`amendFrom` (v0.5.0) re-runs a finished workflow and reuses matching
results from its journal, so unchanged parts cost nothing.
`samples/amend-structure.mjs` is the no-API-key walkthrough: run it,
edit the `MARKER` line, run it again with `amendFrom` pointing at the
first run.

```bash
curl -X POST http://127.0.0.1:7910/api/run -H 'content-type: application/json' \
  -d '{ "scriptPath": "<abs>/samples/amend-structure.mjs" }'
# edit MARKER, then:
curl -X POST http://127.0.0.1:7910/api/run -H 'content-type: application/json' \
  -d '{ "scriptPath": "<abs>/samples/amend-structure.mjs", "amendFrom": "<runId>" }'
```

### Cache lifecycle

The cache opens when a run starts with `amendFrom`, and **closes on
that run's first live `world.run`** — the one cacheable action that can
leave the workspace changed and invalidate an ancestor's cached result.

A live `agent.ask` does *not* close it. An LLM call doesn't mutate the
workspace, and closing there would mean that editing the first prompt
of a workflow forced every later ask live too — which destroys the
reuse amend exists to provide. `Config.amend.autoCloseOnWrite: false`
restores never-close.

### `AMEND_NO_CHANGE`

Amending from a run whose script file is **byte-identical** is
refused with HTTP 400. Replaying an unchanged script costs a full run
and buys nothing; edit the file, or drop `amendFrom`. Also rejected:
`AMEND_NOT_FOUND` (unknown source run) and `AMEND_CHAIN_TOO_DEEP`
(deeper than `Config.amend.maxChainDepth`, default 10). All three are
resolved before the child is spawned, so a rejected amend never leaves
an orphaned process behind.

### Chains

An amended run can itself be amended. Lookups walk `amendFrom`
ancestors nearest-first, up to `maxChainDepth`, and take the **last**
matching entry per journal. "Last wins" is the point: the same key
amended twice replays the newer answer, not the older one.

### What counts as reusable

Only `agent.ask` (keyed on `name` + byte-identical `prompt`) and
`world.run` (keyed on `cmd` + identical `args`). `system`, `model` and
`temperature` are deliberately **not** part of the key — change those
and you should not be replaying the old answer; start a fresh run.

### A cache hit rebuilds the agent's history

This matters and was broken before v0.11.0. On a hit, the agent's
message history is replayed along with the answer, so a later live ask
on the same agent sees the same context the original run had.

Without it, a run whose asks 1–3 replayed and whose ask 4 went live
would send ask 4 a blank context and get a different answer — silently,
with no error. `samples/amend-demo.mjs` (one agent, four asks) is
exactly that shape.

### Reading the replay trail

```bash
curl 'http://127.0.0.1:7910/api/journal?runId=<runId>&limit=200'
```

Every entry carries `live` (really executed here) and `fromRun` (which
ancestor it came from). The editor's Progress tab renders this as a
collapsed **Journal replay trail**: amber for live, grey for replay.
`/api/state?includeJournal=1` inlines the same array. The journal is
capped at 5000 entries; overflow trims oldest-first and counts into
`journalTrimmed`.

### `Config.amend`

| Field | Default | Meaning |
| --- | --- | --- |
| `autoCloseOnWrite` | `true` | Close the cache after the run's first live `world.run`. `false` = debugging aid. |
| `maxChainDepth` | `10` | Ancestors an amend will search. |

## Concurrency, phases and deadlocks (v0.12.0)

### `max_concurrency`

`Config.concurrency.maxConcurrent` (default **8**) is the per-run
ceiling on simultaneous `agent.ask` calls. Anything over the limit
queues for a slot instead of firing at once — this is what stops a
50-way fan-out from stampeding the provider.

```bash
# per-run override
curl -X POST http://127.0.0.1:7910/api/run -H 'content-type: application/json' \
  -d '{ "scriptPath": "<abs script>", "maxConcurrency": 2 }'
```

A replayed answer (an amend cache hit) costs nothing at the provider,
so it never occupies a slot and never makes a real ask wait behind it.

From the script, ask the host for the numbers — it knows the real
concurrency, because a script counting "asks in flight" would also
count the ones still queued:

```js
const { limit, active, peak, waiting } = await __dsh.concurrency.stat();
```

`peak` is the high-water mark of simultaneous provider calls;
`waiting` is how many asks are queued right now.

### Phase lifecycle

`phase()` calls now carry an explicit status — `active`, `done`, or
`error` — and the host emits `phase.start`, `phase.complete` and
`phase.cancel` alongside the existing `phase` event. There is no new
facade call: the lifecycle is derived from the `phase()` calls your
script already makes.

- The previous phase completes when the next one starts.
- Re-entering the *same* phase name (a loop) keeps it active and bumps
  its count badge.
- A run that ends normally completes its last phase; a run that errors
  or is stopped **cancels** it — that is where the error happened.

### Channel deadlock

ZCode's rule is "a channel deadlock is a fail, not a stall". v0.12.0
makes that true: the run fails with `status: 'error'` and
`exitCode: -1` instead of hanging until the 30-minute watchdog.

What counts as a deadlock is worth being precise about:

- **Not** "`close()` was called while a consumer was waiting" — that is
  the *normal* termination path. `close()` is how a producer releases
  its consumers, and `for await (const x of ch)` ends on close. Treating
  that as a deadlock would break every correct pipeline.
- **Yes** "the producer is gone, the channel was never closed, and a
  consumer is still blocked on it" — nothing will ever send or close
  again, so the consumer will never be woken.

A channel tracks the future scopes that may still send on it. When all
of them have settled, no more items can arrive, and an unclosed channel
with a blocked consumer is a deadlock. The blocked consumers are woken
and the host is notified, which fails the run.

See `samples/channel-deadlock.mjs` for the failing case and
`samples/channel-pipeline.mjs` for the correct one.

## Architecture

```
┌────────────────────┐   stdio line-delimited   ┌──────────────────────────┐
│  User .mjs script  │◀──── JSON-RPC + notify ─▶│  Node child process       │
│  (subprocess)      │                          │   runner-bootstrap.mjs   │
└────────────────────┘                          └──────────┬───────────────┘
                                                            │
                                                            ▼
                                                  ┌──────────────────────┐
                                                  │  WorkflowRuntime      │
                                                  │  (cordis host)        │
                                                  │                       │
                                                  │  - agent state map    │
                                                  │  - LLM bridge via ctx │
                                                  │  - shell spawner      │
                                                  │  - SSE broadcaster    │
                                                  └──────┬───────┬────────┘
                                                         │       │
                              ┌──────────────────────────┘       └───────────────────────────┐
                              ▼                                                                  ▼
                   ┌──────────────────┐                                              ┌──────────────────┐
                   │ webServer routes │                                              │ dsh chat UI      │
                   │ /workflow/api/*  │  ─ SSE event stream ──▶  ┌────────────┐    │ (3 slots:         │
                   │ /workflow/       │                          │  iframe     │    │ composer, turn-   │
                   └──────────────────┘                          │  editor +   │    │ tail, overlay)    │
                                                                  │  viewer     │    └──────────────────┘
                                                                  └────────────┘
```

The LLM sub-agents call DeepSeek `/v1/chat/completions` directly through
`ctx.llm.resolveCallConfig(...)` when available, falling back to the same
`DEEPSEEK_API_KEY` / `$DSH_HOME/.credentials.yaml` path that
[`dsh-usage-dashboard`'s balance module][usage-dash-balance] uses.

[usage-dash-balance]: https://github.com/gamelongtim-ux/dsh-usage-dashboard

## Troubleshooting

### "启用失败: dsh: warning: 1 entry did not activate dsh-workflow-runner (dsh-workflow-runner): failed to import"

Fixed in **v0.1.3** by removing the `@deepseek-ai/schemastery` peer
dependency. dsh's cordis loader resolves bare imports against the
bundle's own `node_modules` first, and the schemastery hoisted to the
host profile isn't always reachable on a fresh install. If you see
this on v0.1.1 / v0.1.2, uninstall the bundle and reinstall via the
GitHub URL — you'll get v0.1.3 which has zero third-party runtime
dependencies.

### `▶ Workflow` button does not appear after install

**First check this one — it is the most common cause and it is silent.**

Look at `~/.dsh/profiles/desktop/cordis.patch.yml`. If it contains a row

```yaml
- id: dsh-workflow-runner
  disabled: true
```

the plugin is **disabled**: dsh's Loader never imports it, so `/workflow/`
returns **404** and the button never appears. There is no warning — dsh's
startup audit skips disabled rows, so a disabled plugin fails completely
silently.

Fix it by flipping that row to `disabled: false` (dsh's documented
force-enable form), or deleting the row entirely:

```yaml
- id: dsh-workflow-runner
  disabled: false
```

The patch file is hot-reloaded, so this takes effect **without restarting
dsh**.

To check what the profile actually composes to, from a checkout of this
repository:

```bash
node scripts/patch-sim.mjs ~/.dsh/profiles/desktop
```

It replays dsh's own patch algorithm against the profile and prints the
composed rows plus a verdict. (The published tarball ships `lib/`, `public/`,
`samples/`, `packages/` and `skill/` — not `scripts/` — so this helper is
for maintainers working from a clone.)

> **Why this is easy to hit.** The plugin's own bundle patch
> (`cordis.patch.yml` inside the package) is a bare `insert:`. The profile's
> user layer is what actually creates the row. So if a profile patch adds a
> `disabled: true` row for the same id — which is what dsh's plugin
> marketplace writes when you turn a plugin **off** — it disables the row
> that insert created, because dsh applies patches in file order and an
> inserted row is indexed immediately.

---

Fixed in **v0.1.5**. The cause was a stray `lib/package.json` inside the
package: dsh's `dsh.client` scan walks up from the resolved entry
(`lib/plugin.js`) to the nearest manifest, found that shadow file, and computed
the client bundle path as `lib/lib/client.js` — which does not exist. The
browser half was therefore dropped silently, with no error in the UI, while the
server half kept working (so `/workflow/api/*` responded but nothing was
mounted in the chat). If you are on v0.1.4 or earlier, reinstall from npm or
GitHub to get v0.1.5; deleting the shadow file by hand also works.

Otherwise, check in order:

1. The plugin entry exists in **插件** page and the toggle is **on**.
2. dsh desktop is **restarted** after the toggle (Task Manager →
   `DeepSeek Harness.exe` → End task → reopen). Bundle load is at
   process start, not on toggle.
3. You're in a **new session** (左下角 → 新会话), not an old one
   that was opened before install.
4. The host's dsh version is **V0.2.0-rc.2 or above** — declared as
   `engines.dsh`; older versions may not have the
   `conversation.composer.dock` slot we register against.

### Every turn fails with `invalid function call parameters` (gateway code 11129)

**This one kills the whole session, not just a tool call.** If every turn
in dsh answers with HTTP 400 / code `11129 "invalid function call
parameters"`, the plugin's tools are registered with a schema the model
gateway rejects.

Fixed in **v0.15.4**. The plugin used to register its tools with a FLAT
`parameters` map:

```js
parameters: {
  script: { type: 'string', description: '…' },
  path:   { type: 'string', description: '…' },
}
```

That is how a tool reads in source, but it is **not a JSON Schema**: the
model is shown a schema, and that schema needs a root —
`{ type: 'object', properties: { … } }`. The host's `defineTool` is what
builds it (`parameterSchemaSpecToJsonSchema` wraps the flat map in the
root object and adds the `required` list). Registering the flat map
directly skips the conversion.

`ctx.tools.register()` only validates `output.schema` — never
`parameters` — so nothing complained at registration time. The gateway
does the complaining, and it complains about **every turn**, because the
invalid schema sits in the model's tool list rather than in one call.

The tools now go through `defineTool` before they are registered. The
host's own `@deepseek-ai/dsh-tools` is used when it resolves, and a
local fallback when it does not — and the fallback implements the
host's exact rules, which `scripts/dwf-tool-schema-host-compare.mjs`
checks against the **real installed host** rather than a copy of it.

There are two rules to get right, and the host enforces both loudly:

1. A parameter is **required only if it declares `required: true`**.
   (The earlier version of the fallback used "required unless it says it
   is optional", which would have marked optional parameters required and
   made the model invent values for them.)
2. An **object schema must declare `additionalProperties` explicitly** —
   `true` or `false`, not absent. Without it the host's compiler refuses
   the schema with
   `unsupported JSON schema: parameters.args.additionalProperties must
   be explicitly true or false`.

To see which conversion a running host is using, and every tool's
schema:

```bash
curl http://127.0.0.1:<port>/workflow/api/tool-schema
```

> **This failure mode is why the plugin was removed from a profile once.**
> If you find the tools gone from your patch file, check the comment
> there — it usually records the reason and the version that fixed it.

### `ERR_TOO_MANY_REDIRECTS` when opening `/workflow`

Fixed in **v0.1.5**. Both `/workflow` and `/workflow/` redirected to
`/workflow/`, so the slash form redirected to itself forever. The fix is to
serve `index.html` for `/workflow/` directly; then only `/workflow` redirects.

### `run failed: HTTP 401` — the page opens but Load / Run / Stop always fail

Fixed in **v0.1.6**. The `/api/*` gate treated both of `requestRejection()`'s
refusals as a denial, but they are not equivalent:

- **403** is the Host/Origin fence refusing a cross-site or DNS-rebinding
  caller — the real protection, and it must always deny.
- **401** means that fence already **passed**; only dsh's browser-session
  cookie is missing.

The editor is a self-mounted `/workflow` page, and dsh mints its session cookie
only for the root `/` token handshake, so that page can never present one. As a
consequence, honouring the 401 made the plugin's own UI unusable while adding no
local protection: the cookie's signing secret lives in
`$DSH_HOME/.credentials.yaml`, so any local process can mint a valid session
regardless. If you are on v0.1.5, upgrade to v0.1.6.

### `▶ Workflow` opens, but the browser shows a dsh login page

That is the host's own auth, not this plugin's: dsh serves every page behind a
process-launch token. Open the URL the host printed (the one carrying
`?token=…`) so the shell mints a session cookie, then use the in-app
`▶ Workflow` button rather than a bookmarked bare URL.

### "Lockfile failed supply-chain policy check" / `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`

This is **not** caused by `dsh-workflow-runner` itself. pnpm's lockfile
verifier checks **every** entry in the profile's lockfile against
`minimumReleaseAge` and rejects any package published within the
window (default 24h). The error names the offending package (e.g.
`dsh-workbuddy-connect@0.7.5 was published at 2026-10-14T17:23Z`).

> As of **v0.13.0** the plugin has one third-party runtime dependency:
> `typescript` (the vendored ZCode engine imports it). It is published long
> ago, so the age policy never blocks it — but a manual copy install now has
> to bring it along, as shown below.

Two ways out:

- **Wait** until the offending package ages past the policy window
  (typically 1-3 days), then retry the install.
- **Bypass** with a manual copy that skips pnpm entirely:

  ```powershell
  $D = "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-workflow-runner"
  $S = "D:\ZcodeStorage\.zcode\workspace\default\dsh-workflow-runner"
  New-Item -ItemType Directory -Force -Path $D | Out-Null
  New-Item -ItemType Directory -Force -Path "$D\node_modules" | Out-Null
  Copy-Item "$S\lib","$S\public","$S\samples","$S\packages","$S\package.json","$S\cordis.patch.yml" `
           -Recurse -Force -Destination $D
  # typescript is a runtime dependency of the vendored engine; it has no
  # dependencies of its own, so copying the one package is enough.
  Copy-Item "$S\node_modules\typescript" -Recurse -Force -Destination "$D\node_modules"
  ```

  Then **restart dsh**. If the plugin still doesn't appear in the
  插件 page, add the cordis row to
  `~/.dsh/profiles/desktop/cordis.patch.yml` manually:

  ```yaml
  - insert:
      - id: dsh-workflow-runner
        name: dsh-workflow-runner
        config: { path: /workflow }
  ```

## Out of scope (deliberate)

- Plugin configuration card **now exists** (v0.7.0) but only when
  `@deepseek-ai/schemastery` resolves in the dsh profile — see
  CHANGELOG. The card itself is a thin link to the workflow editor;
  the actual per-run knobs live in the editor.

## Two run paths

A workflow runs on one of two paths. Which one is chosen is by **file
extension**, not by a setting.

| | **Engine path** (`.dwf.ts`) | **Legacy path** (`.mjs`, `.ts`) |
|---|---|---|
| What runs it | ZCode's vendored `@zcode/dynamic-workflow` engine, in-process | a Node child process, JSON-RPC over stdio |
| Before it runs | **compiled**: statically analysed, lowered to site-tagged JS, `ask<T>` synthesised into a JSON Schema | typechecked only (`tsc --noEmit --strict`) |
| Diagnostics | compiler diagnostics with stable codes (9001–9012, 2322, …) | TypeScript errors only |
| Four graphs | yes — site / causality / control-flow / hand-off | no |
| Typed asks | `ask<T>()` — the type argument *is* the contract | `ask(prompt, { result: shape })` |
| Editor | **Graphs** tab renders all four | — |

Both paths share the same run-state shape, the same phase folding, the same
report routing, the same sandbox, the same artifacts and the same journal.

The engine path is the one the **model** uses: `create_workflow` and the
other model-facing tools always go through it, so a workflow the model
writes is always compiled before it runs, and a script that does not
compile is reported instead of run.

### The engine path, end to end

```bash
# compile only — diagnostics, four graphs, per-ask schemas, lowered body
curl -X POST http://127.0.0.1:54912/workflow/api/engine/compile \
  -H 'content-type: application/json' \
  -d '{"scriptText":"phase(\"plan\");\nconst x = await agent(\"a\").ask<string>(\"hi\");\nreturn {x};"}'

# compile and run
curl -X POST http://127.0.0.1:54912/workflow/api/engine/run \
  -H 'content-type: application/json' \
  -d '{"scriptText":"..."}'
```

`ask<string>()` above is not decoration: the engine synthesises
`{"type":"string"}` from the type argument, hands the schema to the model,
and validates the answer against it.

### A note on the upstream engine

The engine is vendored **unmodified** — `npm run verify:vendor` checks it
against the upstream manifest byte for byte (458 + 26 files). The one
adaptation is in `lib/dwf/`: dsh's LLM, sandbox and artifact store are
injected through the four upstream ports (`WorkflowHostApi`,
`WorkflowDriver`, `JournalStorePort`, `WorkflowReportSink`).

dsh's own facade additions — `askUser`, `escalate`, `route`, `t`,
`concurrency.stat`, `stages`, `models`, `constants` — are declared in
`lib/dwf/dsh-facade.js` and implemented as sandbox globals. They are not
in the engine's registries, so they produce no site and no journal row:
that is a documented semantic difference from ZCode, not an oversight.

See `docs/dynamic-workflow-port.md` for the full port analysis.

## License

MIT.
