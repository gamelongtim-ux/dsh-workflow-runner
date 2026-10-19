# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> **npm release note.** Versions up to and including **0.1.4** existed only as
> git tags / GitHub `main`; the package name was never published to
> registry.npmjs.org. **0.1.5 was the first version on npm.**

## [0.13.0] — 2026-10-20

The ZCode Dynamic Workflow port, stage A and B: ZCode's own engine and
harness are vendored into this package, and a dsh-side adapter drives them
end to end.

> **What this release is.** The foundation of the port, not the port itself.
> The plugin's runtime path is unchanged — a `.mjs` / `.ts` script still runs
> in a child process behind the same facade. What is new is that the real
> ZCode Dynamic Workflow engine now lives in this package, builds, and runs a
> workflow to settlement under a stub host. Wiring it to dsh's LLM, sandbox
> and artifact store is the next stage.

### Vendored packages
- **`packages/dynamic-workflow/`** — ZCode's `@zcode/dynamic-workflow`: the
  static analysis layer (site / causality / control-flow / hand-off graphs),
  the compiler and lowering pass, the `ask<T>` → JSON Schema synthesis, the
  facade single source of truth, and the execution engine.
- **`packages/dynamic-workflow-runtime/`** — ZCode's
  `@zcode/dynamic-workflow-runtime`: the harness that runs a lowered script
  in a sandboxed child process and bridges its `__host.*` calls to the engine
  over NDJSON.
- **The sources are upstream, unmodified.** 458 + 26 files, byte-identical to
  `zai-org/ZCode`. The one exception is the harness's import specifier, which
  named a workspace package that does not exist here; the vendor script
  rewrites it to a relative path and records the rewrite in the manifest.
- **`npm run verify:vendor`** re-hashes the vendored tree and fails on any
  drift, so an accidental edit to upstream code cannot ship silently.
- **`npm run build`** builds both packages: the TS stdlib closure is
  regenerated, then `tsc` compiles the engine and the harness.
- **`typescript` moves from devDependencies to dependencies.** The engine
  imports it at runtime (39 of its emitted files do), so it is no longer
  optional. This release is the first one with a third-party runtime
  dependency, and the README's pnpm-free manual install path no longer
  applies — see the Troubleshooting section.
- **`.npmignore`** exists so npm does not fall back to `.gitignore`, which
  excludes exactly the built output the published package must carry.

### The adapter — `lib/dwf/`
- **`prepare.js`** — the compile-time half. One typed program yields the four
  graphs, the site table, the JSON Schema of every typed `ask<T>` site, and
  the lowered function body with a stable site id on every facade call.
- **`driver.js`** — the host side of the engine's downward port. The model
  call, the world reads, the artifact publishing and the event broadcast are
  all injected; the engine itself stays a pure state machine.
  - `executeWorldRead` is the single choke point every file read, glob, grep,
    git query and `world.run` passes through — the place the sandbox fences
    belong.
  - `resolvedModel` is written inside `createActorSession`, because the
    engine rewrites the whole actor row and would otherwise erase it.
- **`index.js`** — `runDwfWorkflow()`: compile, then hand the lowered body to
  the harness, and return the engine's settlement.

### Verification
- **`scripts/dwf-smoke.mjs`** runs a workflow end to end with a stub model
  and a stub world: compile → analyse → lower → child process → vm cell →
  NDJSON bridge → engine → settlement `completed`, with the journal holding
  the typed results, the world read and the report. It runs in CI.
- Upstream's own test corpus passes against the vendored copy: **38 test
  files, 1983 tests**, plus **13/13 lowering golden files byte-identical**.
- `docs/dynamic-workflow-port.md` is the port's design record: the capability
  gap against ZCode, the architecture, the risk register, and the stage
  plan.

## [0.12.0] — 2026-10-20

The state-machine cluster: a user-level concurrency ceiling, an explicit
phase lifecycle, and channel-deadlock detection that fails a stalled run
instead of hanging it.

### #10 — `max_concurrency`
- **`Config.concurrency.maxConcurrent`** (default 8) — the per-run
  ceiling on simultaneous `agent.ask` calls. The rest queue for a slot
  instead of firing at once. Per-run override: `maxConcurrency` on the
  `/api/run` body.
- **`lib/semaphore.js`** — `createSemaphore(limit)`, its own file so it
  can be unit-tested on its own; a semaphore is the one piece of this
  release that adds a layer of failure surface. Slots are *handed over*
  on release rather than freed and re-contested, so `active` can never
  briefly exceed `limit` during a handoff. `acquire()` returns an
  idempotent release function, so a nested `finally` cannot double-release.
  The limit is mutable and raising it wakes queued waiters immediately —
  that is what v0.13.0's adaptive fan-out needs.
- **Acquired after the amend cache check**, so a replayed answer — which
  costs nothing at the provider — neither occupies a slot nor makes real
  asks wait behind it.
- **`__dsh.concurrency.stat()`** — the host's authoritative telemetry
  (`limit`, `active`, `peak`, `waiting`, `totalAcquired`). A script
  cannot measure this from the outside: time spent *waiting* for a slot
  is not time spent *holding* one, so a client-side "asks in flight"
  count over-counts. Measured, not assumed: the first version of
  `samples/concurrency-limit.mjs` reported a peak of 8 with a limit of 2
  for exactly this reason.
- The run state carries `concurrency` telemetry; `agent.ask.queued` is
  broadcast when an ask had to wait.

### #6 — phase lifecycle
- **`phase.start` / `phase.complete` / `phase.cancel`** events, alongside
  the existing `phase` event (which existing clients already consume).
  There is no new facade call — the lifecycle is server-side, derived
  from the `phase()` calls the script already makes.
- **Every phase node now carries a status**: `active`, `done`, or
  `error`. The previous phase completes when the next one starts;
  re-entering the *same* phase name (a loop) keeps it active and just
  bumps its count. A run that ends normally completes its last phase; a
  run that errors or is stopped **cancels** it — that is where the
  error happened, and the editor needs to show the difference.
- The editor renders the status directly, falling back to the old
  derivation for runs persisted before v0.12.0.
- `pending` is a reserved CSS class: the facade has no way to declare
  phases in advance, so a phase the script never reached is not
  knowable yet. It is there so a future "declared phases" feature drops
  in without touching the renderer.

### #7 — channel deadlock
- **A channel deadlock is now a fail, not a stall** (ZCode §16.3). The
  child detects it and reports `channel.deadlock` to the host, which
  fails the run with `status: 'error'` and `exitCode: -1`, and
  terminates the child instead of waiting for the 30-minute watchdog.
- **What counts as a deadlock here is worth stating precisely**, because
  the obvious definition is wrong:
  - ✗ *"`close()` was called while a consumer was waiting"* — that is
    the **normal** termination path. `close()` is exactly how a producer
    releases its consumers, and `for await (const x of ch)` ends on
    close. Treating that as a deadlock would fail every correct
    pipeline; `samples/channel-pipeline.mjs` depends on it.
  - ✓ *the producer is gone, the channel was never closed, and a
    consumer is still blocked on it* — nothing will ever send or close
    again, so the consumer will never be woken. That is the deadlock.
- **Detection.** A channel records the future scopes that may still
  send on it — the scope that created it, plus every scope that has
  sent on it. When all of them have settled, no more items can arrive,
  and an unclosed channel with a blocked consumer is a deadlock. The
  sender attribution matters: the common shape is a channel created at
  the top level of the script and fed from a future, where the creator
  scope is null. The check also runs when a consumer *becomes* blocked,
  so it does not miss the race where the consumer arrives just after
  the producer finished.
- Channels are still keyed by object identity, not by name — `channel('x')`
  returns a fresh object every call. A name-keyed registry would be a
  breaking change to the facade.
- The blocked consumers are woken before the host is notified, so the
  child is not left holding unresolved promises when it is terminated.
- **Known limit:** a producer that is the *main script itself* (not a
  future) and never closes its channel, while a consumer blocks, is not
  detected — the script never returns, so the end-of-script check never
  runs. The 30-minute watchdog remains the backstop for that shape.

### Samples
- **`samples/concurrency-limit.mjs`** — no API key needed. Reports the
  host's authoritative peak against the configured limit.
- **`samples/channel-deadlock.mjs`** — no API key needed. A producer
  that finishes without closing its channel; the run must end as an
  error with a `[ChannelDeadlock]` log line.
- `samples/channel-pipeline.mjs` (the *correct* usage) still passes —
  no false positive.

### Verified
- `maxConcurrency=2` → host peak 2; `maxConcurrency=8` → host peak 8.
- Phase states: mid-run `Alpha=done, Beta=active`; after a failure
  inside Beta, `Beta=error`.
- Deadlock: `status=error`, `exitCode=-1`, log
  `[ChannelDeadlock] channel 'trickle': producer future finished
  without closing the channel; 1 consumer(s) still waiting`.
- All 11 pre-existing samples unchanged, and the v0.10.0 / v0.11.0
  suites still pass.

## [0.11.0] — 2026-10-19

The other half of structural amend. v0.5.0 shipped `amendFrom` — re-run
a finished workflow and reuse matching results from its journal — but
left the cache permanently open, searched only one level, and could not
tell you what it had reused. This release gives that machinery a
lifecycle, makes reuse *sound*, and makes it legible.

### Fixed
- **A cache hit no longer loses the agent's chat history.** This is the
  significant one. The hit returned at `runtime.js:1391`, before
  `agent.messages` was touched at `:1460`, so it neither restored
  history nor incremented `agent.asks`. For a multi-ask agent the
  consequence was silent: if asks 1–3 replayed and ask 4 missed, ask 4
  ran against an EMPTY context and produced a different answer than the
  original run did — no error, no log line, just a wrong result.
  `samples/amend-demo.mjs` is exactly this shape (one `planner`, four
  sequential asks). The hit now happens *after* the message block runs,
  so the system prompt and user turn are pushed normally and the cached
  assistant turn is replayed on top.
  Verified offline against a local fake OpenAI endpoint: an amended run
  whose third ask changed sends `[system, q1, reply-1, q2, reply-2,
  q3-v2]` to the model — identical in shape to the original run. Before
  the fix it sent `[system, q3-v2]`.
- **`WorkflowRuntime`'s default bootstrap path was broken.** It used
  `resolvePath(fileURLToPath(import.meta.url), 'runner-bootstrap.mjs')`,
  which treats `runtime.js` as a directory and yields
  `.../lib/runtime.js/runner-bootstrap.mjs` → `MODULE_NOT_FOUND`. Every
  caller in this package passes `bootstrapPath` explicitly, so the
  default documented as "本目录下的 runner-bootstrap.mjs" had never
  actually been exercised. Now `dirname()` + `join()`.
- **`world.run` could buffer output without bound.** A runaway command
  (`yes`, a build log, a `cat` of a large file) accumulated in host
  memory *and* landed in the journal, which is then persisted to disk
  and reloaded on restart. Hard 1 MiB ceiling per stream; the stream is
  still drained so the child never blocks on a full pipe, and the
  truncation is reported in the run log.

### Added
- **Cache lifecycle.** `state.cacheOpen` opens on an `amendFrom` run and
  closes on the run's first **live `world.run`** — the one cacheable
  action that can leave the workspace changed and invalidate an
  ancestor's cached results. Closing on a live `agent.ask` was
  deliberately NOT adopted: an LLM call does not mutate the workspace,
  and closing there meant that editing the *first* prompt of a workflow
  forced every later ask live too, destroying the reuse amend exists to
  provide. Measured, not assumed — see the verification below.
  `Config.amend.autoCloseOnWrite: false` restores never-close.
- **Recursive amend chains.** `#lookupAmendChain` walks `amendFrom`
  ancestors nearest-first, bounded by `Config.amend.maxChainDepth`
  (default 10). We walk rather than bulk-copying ancestor journals into
  the new run's journal on purpose: a copied journal makes `find` return
  the *oldest* entry for a key while fresh entries sit at the tail, so a
  key amended twice would replay the stale answer. Taking the last match
  per journal, then falling through to the next ancestor, keeps
  "most recent wins" honest.
- **`AMEND_NO_CHANGE`.** Amending from a run whose script file is
  byte-identical is refused with HTTP 400 — replaying an unchanged
  script costs a full run and saves nothing. ZCode's behaviour.
  `AMEND_NOT_FOUND` and `AMEND_CHAIN_TOO_DEEP` round it out; all three
  are resolved before `spawn`, so a rejected amend cannot leave an
  orphaned child behind.
- **`GET /api/journal?runId=X&limit=200&full=1`** — the replay trail.
  Each entry carries `live` and `fromRun`. Large `result` payloads are
  dropped unless `full=1`.
- **`/api/state?includeJournal=1`** inlines the trail; off by default
  because the journal can be thousands of entries.
- **Editor journal replay trail** — a collapsed panel in the Progress
  tab showing `agent.ask(name)` / `world.run(cmd)` per entry, live in
  amber and replayed in grey with its source run. Loaded lazily on first
  open, and only offered when the run actually amends another.
  `GET /api/runs` rows gained `stageCount`.
- **`samples/amend-structure.mjs`** — a no-LLM, three-stage sample whose
  marker line you edit between the two runs. Covers the whole lifecycle
  end to end without an API key.

### Changed
- **`scriptHash` is computed for every run**, not just amended ones. It
  is what a *later* amend compares against, so a fresh run that skipped
  it could never be the subject of an `AMEND_NO_CHANGE` check. It hashes the
  user's ORIGINAL file — for a `.ts` run, `absScript` has already been
  swapped for the transpiled `.mjs` in a per-run tmp dir, so hashing it
  would compare build output rather than the source being edited.
- **Journal entries are marked `live` / `fromRun`.** Before this,
  importing an ancestor's journal carried that ancestor's `live: true`,
  so every replayed entry in an amended run rendered as if it had really
  executed. Replays are also journaled (as `live: false`) rather than
  silently skipped, which is what makes the panel possible.
- **`samples/amend-demo.mjs` now requires an edit between runs**
  (`PROMPT_VERSION`), because `AMEND_NO_CHANGE` now rejects the
  byte-identical replay its old comment recommended.
- Journal is capped at 5000 entries; overflow trims oldest-first and
  counts into `journalTrimmed`, mirroring the existing `s.log` trim.

### Verified
- Fresh run → 3 live, depth 0. Amend unchanged → `400 AMEND_NO_CHANGE`.
  Edit + amend → depth 1, **2 replay + 1 live**, cache opens then closes.
  Chain to depth 2 → same split. Depth 11 → `400 AMEND_CHAIN_TOO_DEEP`.
  Unknown source → `400 AMEND_NOT_FOUND`.
- 3 MiB `world.run` stdout → truncated at 1048576 bytes with a warning.
- Agent-history replay: asserted on the exact messages array the model
  received (offline, against a local fake endpoint).
- All 10 pre-existing non-LLM samples unchanged.

## [0.10.0] — 2026-10-19

Closes the **structural amend** item from the 0.7.0 "out of scope"
list — ZCode's `AmendWorkflow`: inject a *new stage* into a workflow
that is already running.

v0.5.0's `amendFrom` is the other half of the same idea (re-run a
finished workflow against a warm cache). This is the live one: the run
is not restarted, not replayed, and not cloned. The original plan keeps
executing untouched while the amendment interleaves with it.

### Added
- **`WorkflowRuntime.injectStage(runId, opts)`** — push a stage into a
  live run. Returns `{stageId, accepted}` immediately, or the full
  `{stageId, name, status, result, error}` when `wait: true`.
  Rejects (HTTP 409) when the run is terminal, restored from disk, an
  eval/snippet run, over the per-run cap, or over the in-flight cap.
- **`POST /api/amend`** — the HTTP surface, on both the standalone server
  and the dsh-hosted plugin server. Body:
  `{runId, name?, code? | codePath?, context?, timeoutMs?, wait?}`.
- **`GET /api/amend/stages?runId=`** — the stage list for a run.
- **New wire shape: host→child requests.** The stdio protocol already
  carried `{id, …}` in both directions. v0.10.0 adds `{hostId, method,
  params}` from host to child, answered with `{hostId, result|error}`
  plus a `stageId` correlation field on errors. Distinct tag space, so
  the two directions can never be mistaken for each other on the shared
  pipe.
- **Stage body accepts three shapes**, tried in order:
  1. `export default <expr>;` — a standalone `.mjs` file, so one file
     can be both a runnable sample and an injectable stage;
  2. a bare function expression — the existing `hole<T>` convention;
  3. a bare statement block, `return` allowed inside.
  Leading `//` and block comments are stripped before shape 1 is
  detected, so a file may open with a docblock.
- **`__dsh.stages`** on the script side — `list()`, `pending()`,
  `await({timeoutMs})`. The bootstrap also drains outstanding stages
  automatically before signalling `finished`, so a workflow does not
  have to opt in.
- **`injectedStages` on the run state** — visible in `/api/state`,
  persisted to disk (name / source / timestamps / status / result, with
  the body reduced to a 200-char preview), and counted as `stageCount`
  in `/api/runs`.
- **SSE events** `stage.injected`, `stage.started`, `stage.finished`.
- **`samples/amend-inject.mjs`** — a run that stays alive for an
  injection window; **`samples/amend-stage-snippet.mjs`** — a stage
  body loaded by `codePath`.
- **`InjectedStage` in `lib/facade.d.ts`** plus the `stages` facade
  entry, so `.ts` workflows typecheck against the new surface.

### Security
An injected stage runs **inside the existing child process**, so it
inherits everything the sandbox already enforces: the scrubbed env
(v0.9.0), the `world.run` allowlist, and workspace path confinement.
It is not a way around any of them — verified by a stage that reads
`process.env` and finds zero `KEY|TOKEN|SECRET` keys while the host had
five fakes exported. `codePath` goes through the same
`#resolveInWorkspace` confinement as `files.*`; a path outside the
workspace is rejected with `PATH_ESCAPE`.

A stage that throws is recorded with `status: 'error'` and the run
continues — an amendment is not part of the original plan, so it must
not be able to take the run down with it.

### Limits
- Body ≤ 64 KB; ≤ 32 stages per run; ≤ 4 concurrently in flight;
  `wait: true` parks at most 5 minutes.
- Eval/snippet runs do not accept injected stages (the snippet facade
  is deliberately pruned).
- A stage injected after the child drains is refused by the child
  itself, not just by the host's status check — the window between
  those two is where a naive implementation silently loses work.

### Fixed
- **`public/editor.js` had two top-level `escapeHtml` declarations.**
  It loads as `<script type="module">`, so the duplicate is a hard
  `SyntaxError` — the entire browser editor UI failed to load, and CI's
  `node --check` over every `.js`/`.mjs` would fail. Removed the older,
  narrower copy (the one that did not escape `'`). This was introduced
  in the v0.8.0 typecheck UI work and would have shipped broken in
  v0.9.0.

## [0.9.0] — 2026-10-18

Closes the **OS-level subagent sandboxing** item from the 0.7.0 "out of
scope" list. This is the strongest sandbox the runtime layer can
deliver portably — true OS isolation (Windows Job Object /
AppContainer, Linux namespaces, macOS sandbox-exec) is platform-specific
and belongs in v0.10.0+.

### Added
- **`_scrubChildEnv(allowlist, denylist, env)`** in `lib/runtime.js` —
  the env-scrubbing primitive. Rules, in order: any key matching
  the denylist regexes is dropped; any `DSH_WORKFLOW_*` is preserved
  (host handoff); otherwise the key must be in the allowlist.
  Returns `{ env, stripped, strippedKeys }` for the run log.
- **`DEFAULT_ENV_ALLOWLIST`** (~25 entries) — `PATH`, `HOME`,
  `USERPROFILE`, `TEMP` / `TMP` / `TMPDIR`, `LANG` and `LC_*` locale
  family, `NODE_ENV`, `USER` / `USERNAME` / `LOGNAME`, `SHELL`,
  `TERM` / `COLORTERM` / `FORCE_COLOR` / `NO_COLOR`, `HOSTNAME` /
  `COMPUTERNAME`, `PAGER` / `EDITOR` / `VISUAL`. Plus the 7
  `DSH_WORKFLOW_*` keys the host injects.
- **`DEFAULT_ENV_DENYLIST`** (24 regex patterns) — `^DEEPSEEK_.+`,
  `^OPENAI_.+`, `^ANTHROPIC_.+`, `^GOOGLE_.+`, `^VERTEX_.+`,
  `^HUGGING.+`, `^REPLICATE_.+`, `^STABILITY_.+`, `^MISTRAL_.+`,
  `^COHERE_.+`, `^GROQ_.+`, `^XAI_.+`, `^OPENROUTER_.+`,
  `^TOGETHER_.+`, `^FIREWORKS_.+`, `^AWS_.+`, `^AZURE_.+`,
  `^GCP_.+`, `^GOOGLE_APPLICATION_CREDENTIALS$`, `^GITHUB_.+`,
  `^GH_.+`, `^GL_TOKEN$`, `^GLAB_.+`, `^GITLAB_.+`,
  `^NPM_.+TOKEN$`, `^NODE_AUTH_.+`, `^DSH_HOME$`, `^DSH_API_KEY$`,
  `^DSH_PROFILE_KEY$`, `^DSH_AUTH_TOKEN$`, `^DSH_PROXY_.+`,
  `^NODE_OPTIONS$`, `^NODE_EXTRA_CA_CERTS$`, `^LD_PRELOAD$`,
  `^LD_LIBRARY_PATH$`, `^DYLD_INSERT_LIBRARIES$`, plus catch-alls
  `+_TOKEN$`, `+_SECRET$`, `+_API_KEY$`.
- **`Config.sandbox.{enabled, allowlist, denylist}`** — schemastery
  card. `enabled: true` (default) turns scrubbing on; `allowlist`
  and `denylist` are extra / override lists on top of the built-in
  defaults. Users can extend either without forking the runtime.
- **Per-run `args.sandbox`** — `false` bypasses scrubbing (legacy
  behavior); an object with `allowlist` / `denylist` keys overrides
  the per-deploy Config card for that one run.
- **Run log line on every spawn**: `sandboxed env: kept N keys,
  stripped M sensitive keys (from K host keys) — DSH_API_KEY,
  DEEPSEEK_API_KEY, ...`. Lets users audit what was actually
  stripped.
- **`state.sandboxedChildEnv`** — the post-scrub env object is
  stashed on the run state and reused as the base for `world.run`
  shell children, so any command the workflow spawns inherits the
  same scrubbing (not just the bootstrap child).
- **Path-confinement** for `files.glob`, `files.grep`, and
  `git.diff` — patterns anchored to `/` or `C:\`, or containing
  `..` segments, are rejected with `code: 'PATH_ESCAPE'` before
  the walk starts. `files.read` already had the check via
  `#resolveInWorkspace`; the other three are now consistent.
- **`world.run` cwd check** — `opts.cwd` must resolve inside
  `state.workspaceRoot`; an escape attempt throws
  `code: 'PATH_ESCAPE'`.
- **`samples/env-scrub.ts`** — non-LLM sample that reads
  `process.env` keys visible to the workflow child, spawns a
  `node -e` shell to count KEY/TOKEN/SECRET keys from a
  second-tier process, and tries `files.glob('/etc/**/shadow')` to
  verify the path-escape check.

### Changed
- **`WorkflowRuntime.start()` builds `childEnv` via `_scrubChildEnv`**
  when sandbox is enabled; falls back to `{ ...process.env, ... }`
  (legacy) only when `args.sandbox === false` or
  `this.sandbox.enabled === false`.
- **`WorkflowRuntime` constructor** accepts `opts.sandbox`. Per-deploy
  default is `{ enabled: true, allowlist: DEFAULT_ENV_ALLOWLIST,
  denylist: DEFAULT_ENV_DENYLIST }` if omitted.
- **`#worldRun`** now resolves `state.sandboxedChildEnv` (not
  `process.env`) as the base for shell children's env, so commands
  like `git`, `npm`, `node` that workflows spawn don't see API keys
  either.

### Implementation notes
- **Why the runtime layer, not the OS layer:** Windows has no
  portable chroot / namespace primitive. Job Objects and
  AppContainer work but are deeply Windows-specific; cgroups /
  namespaces are Linux; `sandbox-exec` is macOS-only. v0.9.0 keeps
  the cross-platform surface; v0.10.0+ can layer the platform APIs
  on top for stricter enforcement.
- **Why allowlist + denylist (not one or the other):** denylist
  alone misses the credential-style keys the user added between
  releases (`*_TOKEN$`, `*_API_KEY$` catch-alls cover most). An
  allowlist alone makes the toolchain-hostile — without `PATH`
  every spawned `git` / `node` / `npm` fails. The combination: any
  denylisted key is dropped regardless of allowlist (defense in
  depth), everything else is either explicitly allowed or
  dropped.
- **Why `state.sandboxedChildEnv` is a reference, not a copy:**
  the bootstrap child receives a real Node env object. We keep
  the same reference on `state` so `#worldRun` shell children
  re-spawn against the same post-scrub env without re-running
  the algorithm. Both children are short-lived Node processes
  that don't mutate the env object.
- **30-second `tsc` / 30-minute child watchdog are unchanged**;
  sandbox adds new defenses on top.

### Out of scope (v0.10.0+)
- Windows Job Object / AppContainer
- Linux cgroups + namespaces (`unshare(2)`)
- macOS `sandbox-exec` profile
- `world.run` cmd-level OS sandboxing (the per-run
  `worldRunAllowlist` is command-name only; we don't yet
  enforce that the cmd is path-anchored or that its argv
  doesn't carry shell-injection vectors)
- The other 8 dynamic-workflows divergences (structural amend,
  hole auto-fill by subagent, phase lifecycle hooks,
  ChannelDeadlock detection, provider retry/adaptive fan-out,
  subagent snapshot semantics, `max_concurrency`, subagent
  worktree isolation, `.mjs` `--checkJs` opt-in, eval snippet
  pre-flight typecheck, `/api/typecheck` preflight endpoint,
  inline editor squiggle UI)

### Regression
- All 9 non-LLM samples still pass with the same metrics:
  - smoke.mjs            — phases=5  reports=3  artifacts=0
  - loop-phases.mjs      — phases=8  reports=6  artifacts=0
  - file-grep.mjs        — phases=6  reports=2  artifacts=2
  - git-changed.mjs      — phases=6  reports=0  artifacts=1
  - channel-pipeline.mjs — phases=5  reports=0  artifacts=1
  - artifact-demo.mjs    — phases=6  reports=7  artifacts=4
  - typed-minimal.ts     — phases=5  reports=3  artifacts=0
  - typecheck-ok.ts      — phases=3  reports=2  artifacts=0
  - env-scrub.ts         — phases=4  reports=2  artifacts=0  *(new)*
- With `DSH_API_KEY=fake-secret-123 DEEPSEEK_API_KEY=sk-fake
  AWS_ACCESS_KEY_ID=AKIAFAKE NODE_OPTIONS=... LD_PRELOAD=...`
  set in the host, `env-scrub.ts` reports:
  - `sandboxed env: kept 15 keys, stripped 5 sensitive keys (from 80 host keys) — AWS_ACCESS_KEY_ID, DEEPSEEK_API_KEY, DSH_API_KEY, LD_PRELOAD, NODE_OPTIONS`
  - `hasDshApiKey=false, hasDeepSeekKey=false, hasNodeOptions=false, hasAwsAccessKey=false, hasLdPreload=false` in the workflow child
  - `shell child saw: 0 sensitive keys visible` (second-tier `world.run` process inherits the scrub)
  - `path-escape rejected: true` for `files.glob('/etc/**/shadow')`

## [0.8.0] — 2026-10-18

Closes the **compiler-side static typecheck** item from 0.7.0's "out of scope"
list — ZCode dynamic-workflows §16.3. Workflow `.ts` scripts are now
typechecked against an ambient `declare`-block facade that mirrors
ZCode's `CreateWorkflow` §16.2, before they're allowed to run.

### Added
- **`lib/facade.d.ts`** — Ambient declaration of the entire user-facing
  surface (`agent` / `phase` / `log` / `report` / `artifact` / `world.run`
  / `files` / `git` / `channel` / `future` / `model` / `args` / `hole`
  / `askUser` / `escalate` / `models` / `constants` / `t` / `route`),
  plus the supporting interfaces (`Agent`, `WorldRunResult`,
  `GrepMatch`, `GitStatus`, `GitCommit`, `Channel<T>`, `ModelRef`,
  `ArtifactRef`, `ArtifactOptions`, `ArtifactFileOptions`,
  `ArtifactField`, `ChartSpec`, `TableSpec`, `MetricsSpec`,
  `BoardSpec`, `AgentPersona`). Mirrors ZCode's `declare` block
  contract — the user script never uses `declare` itself.
- **`_typecheckTs(absScript)`** in `lib/runtime.js` — runs
  `tsc --noEmit --strict` against a per-run tmpdir that includes
  the user's `.ts` plus a copy of `lib/facade.d.ts` as
  `__dsh_facade__.d.ts`. Parses tsc stderr into a structured
  `Diagnostic[]`. Throws `code: 'TS_TYPECHECK'` with `diagnostics`
  attached when any errors are found.
- **`Config.typecheck.strict`** (default `true`) — schemastery card
  setting. When `false`, the runtime skips the typecheck pass; the
  emit pass still runs `--strict` as belt-and-suspenders. Per-run
  override via `args.typecheck: false` on `/api/run` payloads.
- **`POST /api/run` 400 with structured `diagnostics[]`** — when
  typecheck fails, the response carries
  `{error, code: 'TS_TYPECHECK', diagnostics: [{file,line,column,code,message}, …]}`
  instead of a plain 500.
- **`samples/typecheck-fail.ts`** — a deliberately broken sample
  (TS2322 / TS2304) that triggers the new flow.
- **`samples/typecheck-ok.ts`** — a clean TS sample with typed
  `WorldRunResult` that exercises the strict pass.
- **Editor UI** — `public/editor.js` `showTypecheckErrors()`
  renders diagnostics as a list (file:line:col + error code + message)
  in the log pane when `/api/run` returns 400 with `diagnostics`.

### Changed
- **`WorkflowRuntime.start()` is now typecheck-aware.** The `.ts` path
  runs `_typecheckTs()` first; on success, `_transpileTs()` emits the
  compiled `.js` (also with `--strict` now). A failed typecheck
  short-circuits the run — no spawn, no work done.
- **`_transpileTs()` now uses `--project tsconfig.json`** instead of
  inline CLI flags. The tsconfig lists only the entry file (plus the
  facade) — sibling `.ts` files in the same directory are NOT
  typechecked unless the entry explicitly imports them. This is what
  lets `samples/typecheck-fail.ts` and `samples/typecheck-ok.ts` sit
  side by side without one contaminating the other.
- **`lib/runner-bootstrap.mjs` exposes bare globals** —
  `globalThis.phase`, `globalThis.log`, etc. — alongside the
  namespaced `globalThis.__dsh`. ESM module scope doesn't see
  `declare global { var __dsh }` at runtime, so user scripts that
  call `phase(...)` directly (the ZCode convention) need explicit
  globalThis assignment in the bootstrap. The destructured-from-arg
  pattern still works too.
- **`public/styles.css`** — `.typecheck-header` + `.typecheck-row`
  styles for the diagnostics list.

### Implementation notes
- **Why no `export {}` in `facade.d.ts`:** `tsc` only picks up
  `declare const` as ambient when the file is a *script*, not a
  *module*. The file is intentionally export-less so `phase`, `log`,
  etc. become globally visible to every `.ts` file tsc compiles.
- **Why bare globals on `globalThis`:** the user's compiled
  `.js` (after tsc erases types) is plain ESM. There's no `import`
  statement for `phase`, so the lookup has to resolve through the
  global object. The bootstrap does `globalThis.phase = ...` for
  every facade symbol so the compiled code works.
- **Why `tsc -p tsconfig.json` instead of inline CLI flags:** only
  `--project` accepts a tsconfig with `files:` that includes the
  `.d.ts` ambient. Inline `--strict` etc. doesn't load co-located
  `.d.ts` files.
- **Why only the entry file in `files:`:** the natural alternative
  (include every `.ts` in the source dir) meant running
  `samples/typed-minimal.ts` reported errors from `typecheck-fail.ts`
  too. tsc's import-graph following already pulls in
  `./typed-shapes.ts` automatically, which is the only sibling the
  entry actually needs.
- **30-second typecheck timeout.** Failure surfaces as a thrown
  `Error` with `code: 'TS_COMPILE_TIMEOUT'` / `'TS_COMPILE_FAIL'`
  / `'TS_TYPECHECK'` / `'TS_MISSING_DEP'`, caught by the HTTP
  handler and returned as `{error, code, diagnostics}`.
- **Per-run override:** the `/api/run` payload accepts
  `typecheck: false` to skip the pre-flight for that one run (handy
  for incremental iteration while editing).

### Out of scope (v0.8.1+)
- `.mjs` typecheck via `--checkJs` (opt-in, default off)
- Eval snippet pre-flight typecheck (would need to write `evalCode`
  to a tmp file before the data-URL import)
- `POST /api/typecheck` standalone pre-flight endpoint for editor
  side-channel diagnostics
- Inline editor squiggles + line/column click-to-jump
- The remaining 9 dynamic-workflows divergences (OS sandboxing,
  structural amend, hole auto-fill, phase lifecycle hooks,
  ChannelDeadlock detection, provider retry/adaptive fan-out,
  subagent snapshot semantics, `max_concurrency`, subagent worktree
  isolation)

### Regression
- All 8 non-LLM samples still pass with the same metrics:
  - smoke.mjs            — phases=5  reports=3  artifacts=0
  - loop-phases.mjs      — phases=8  reports=6  artifacts=0
  - file-grep.mjs        — phases=6  reports=2  artifacts=2
  - git-changed.mjs      — phases=6  reports=0  artifacts=1
  - channel-pipeline.mjs — phases=5  reports=0  artifacts=1
  - artifact-demo.mjs    — phases=6  reports=7  artifacts=4
  - typed-minimal.ts     — phases=5  reports=3  artifacts=0  *(now typechecked)*
  - typecheck-ok.ts      — phases=3  reports=2  artifacts=0  *(new)*
- typecheck-fail.ts intentionally fails with HTTP 400 + 5
  diagnostics (TS2322 × 4 + TS2304 × 1), verifying the new flow.

## [0.7.1] — 2026-10-18

Closes the TypeScript support item that 0.7.0 deferred.

### Added
- **TypeScript workflow support.** `WorkflowRuntime.start()` now detects
  `.ts` script paths and compiles them to ESM `.js` in a per-run tmp
  directory via the local `typescript` package's `tsc` CLI before
  launching the child. The child sees plain ESM; types are fully erased.
- **`samples/typed-minimal.ts`** + **`samples/typed-shapes.ts`** — a
  non-LLM TypeScript smoke sample that exercises phase / log / report
  / world.run with `import type { ... }` cross-file imports and a
  local `interface`/`type` definition. Validates the full compile →
  spawn → execute → cleanup chain without an API key.
- **`typescript` is now a devDependency** (`^5.9.3`). The host resolves
  `typescript/bin/tsc` via `createRequire(import.meta.url)` so we don't
  depend on global PATH.
- **Per-run tmp dir cleanup.** The TS compile creates a fresh
  `os.tmpdir()/dsh-workflow-ts/run-XXXXXX/` per run. The cleanup
  callback is stashed on the run state and invoked from
  `#setStatus` on terminal states (completed / error / stopped), so
  the on-disk artifacts don't accumulate.

### Changed
- **`start()` is now `async`.** It `await`s the TS compile before
  spawning. The two sync callsites in `lib/standalone.js` and
  `lib/plugin.js` got an `await`. The return shape is unchanged
  (`{runId, status:'starting'}`), so existing callers and clients are
  unaffected.
- **Run state now records `compiledScriptPath`** in addition to
  `scriptPath`. `scriptPath` is the user's original entry (.ts or
  .mjs); `compiledScriptPath` is the actual file the child loads.
  This keeps the `/api/runs` UI showing the user's `.ts` file even
  after the tmp dir is cleaned up.

### Implementation notes
- The TS compile helper is `_transpileTs(absScript)`, a regular
  (non-`#`) method. The earlier v0.7.0 attempt used `#transpileTs`
  and tripped V8's parse-time private-name forward-reference check
  on the constructor-style `this.#x(...)` call from `start()`. The
  v0.7.0 fix wasn't durable — naming it `_transpileTs` (underscore,
  not `#`) sidesteps the parser check entirely and keeps the
  semantics of a "private enough" helper. This is the same
  workaround already used by the constructor's `setImmediate(...)`
  wrap on `#loadPersistedRuns`.
- The tmp dir gets a tiny `package.json` with `{"type":"module"}` so
  Node treats the compiled `.js` as ESM (default is CJS in dirs
  without one).
- All sibling `.ts`/`.mts` files in the source directory are copied
  into the tmp dir alongside the entry, so relative imports like
  `import type { ... } from './typed-shapes'` resolve during the
  compile.
- `tsc` flags: `--target es2022 --module esnext --moduleResolution
  bundler --skipLibCheck --esModuleInterop --allowJs false
  --declaration false --sourceMap false --noEmitOnError true` with
  `--rootDir` set to the tmp dir so the output structure stays flat.
- 30-second compile timeout. Failure surfaces as a thrown
  `Error` with `code: 'TS_COMPILE_FAIL'` / `'TS_COMPILE_TIMEOUT'`
  / `'TS_MISSING_DEP'`, caught by the HTTP handler and returned
  as `{error}`.

### Regression (against v0.7.0)
- All 7 non-LLM samples still pass with the same metrics:
  - smoke.mjs            — phases=5  reports=3  artifacts=0
  - loop-phases.mjs      — phases=8  reports=6  artifacts=0
  - file-grep.mjs        — phases=6  reports=2  artifacts=2
  - git-changed.mjs      — phases=6  reports=0  artifacts=1
  - channel-pipeline.mjs — phases=5  reports=0  artifacts=1
  - artifact-demo.mjs    — phases=6  reports=7  artifacts=4
  - typed-minimal.ts     — phases=5  reports=3  artifacts=0  *(new)*

## [0.7.0] — 2026-10-16

Closes the last three "Out of scope" items from 0.6.0 except for
TypeScript support (deferred to v0.7.1 — see below).

### Added

- **Recent runs in the editor.** The editor's new "Recent runs" card
  sits under the script picker and calls `GET /api/runs` every 5s
  (auto-paused when the tab is hidden). Each row shows status / script
  basename / started-at / runId short / disk-vs-memory badge, with two
  inline actions:
  - **Load** — fills the script path from the run, and if the script is
    a saved workflow, fetches the source via `/api/saved-workflows/content`
    and loads it into the editor.
  - **Amend from** — fills the `amendFrom` input above the Run button
    with a brief outline flash, so the next click of Run reuses the
    prior run's LLM / shell journal as cache.

- **Settings → Plugins card.** Re-introduces `@deepseek-ai/schemastery`
  as an *optional* peer dep (matching the three working companion
  plugins: dsh-workbuddy-connect, dsh-context, dsh-plugin-subscriptions).
  The plugin now exports a `Config` schema (`z.object` of path /
  scriptsRoots / workspaceRoot / allowedModels / workflowsDir) and
  registers a `settings.plugin.item` slot for the card. The card is
  auto-rendered by dsh from the schema; the entry in the Plugins page
  links out to the workflow editor (where richer per-run controls live).
  If schemastery isn't resolvable in the dsh profile, the plugin still
  works — the card is simply not registered, matching `dsh-pet`'s
  "no card" pattern. **Risk**: v0.1.3's `failed to import` bug
  re-appeared if schemastery resolution fails on a specific dsh install.
  Tested against the current `0.2.0-rc.2` profile (where the 3
  companion plugins resolve schemastery fine). Users hitting
  `failed to import` can fall back to 0.6.0.

### Deferred to v0.7.1

- **TypeScript support** — the v0.7.0 plan called for `tsc` to compile
  `.ts` scripts on the fly. We added the `typescript` devDep and the
  `transpileTs` method, but the latter triggered a V8 parser quirk
  ("Private field must be declared in an enclosing class") when called
  from `start()` before the method definition appears in source order.
  The fix is non-trivial (either re-order the class, switch the method
  to non-`#` private, or pre-declare all forward-referenced names). To
  keep the 0.7.0 release focused, we rolled back the runtime-side
  change. v0.7.1 will pick this back up.

### Migration from 0.6.x

- Existing scripts that don't use the new features keep working
  unchanged.
- `schemastery` is now in `peerDependencies` (optional via
  `peerDependenciesMeta`); not present in dsh-workflow-runner's own
  `node_modules` — dsh's profile node_modules is expected to provide it
  (or the card is simply absent).
- No new runtime dependencies.

## [0.6.0] — 2026-10-16

Closes the four remaining differences from ZCode dynamic-workflows:
the script can now enumerate allowed models, route between tiers, and
escalate to either a human or an LLM as the "main agent" — without
writing the parking/wakeup boilerplate by hand.

### Added

- **`__dsh.models` array.** Runtime equivalent of ZCode's
  `ListModels` tool. Populated from `DSH_WORKFLOW_MODELS` env
  (which the host sets from `modelsAllowed` in `POST /api/run`).
  Scripts can `__dsh.models.forEach(...)` to discover what's
  available before calling `model(id)`.

- **`t` + `shape()` builder for typed `ask<T>`.** Same shape syntax
  the host already understands (`'string'`, `['string']`, `{...}`),
  but with a fluent builder that JSDocs cleanly:
  `t.string`, `t.number`, `t.boolean`, `t.array(item)`,
  `t.optional(s)`, plus `shape({...})` as a no-op wrapper for
  readability. `result: shape({ title: t.string, steps: t.array(t.string) })`
  reads better than `result: { title: 'string', steps: ['string'] }`.
  The runtime contract is unchanged — host's `#shapeToJsonSchema`
  still consumes the same shape object.

- **`route(MODELS, routerFn, answererFn)` one-call multi-model
  routing.** Encapsulates the `samples/model-router.mjs` pattern:
  run `routerFn(MODELS.light)` and parse its `{"tier": "light"|"strong"}`
  JSON reply (fallback to `'light'` on parse error), then run
  `answererFn(MODELS[tier])` and return its result. `MODELS` is a
  plain `{ light: ModelRef, strong: ModelRef, ... }`.

- **`escalate(question, opts)` — "ask the main agent" with Think via
  LLM.** v0.4.0 had `askUser` (script → human). v0.6.0 adds
  `escalate`: same parked-RPC shape, but the editor offers a second
  input path — a "🧠 Think via LLM" button. When clicked, the host
  builds context from the run's recent log + the question + options,
  dispatches an LLM call (uses the first model in `modelsAllowed`
  as the "thinker"), and uses its response as the escalate answer.
  The LLM context is a single system + user message, total < 2KB.
  `kind: 'confirm'` → boolean; `options: [...]` → button row;
  default → free-text input. 5-minute watchdog.

### New samples

- `samples/models-list.mjs` — list `__dsh.models`, build a table
  artifact, publish a markdown report. No LLM.
- `samples/route-demo.mjs` — two questions routed through
  `route(MODELS, router, answerer)`; the answerer gets the right
  tier. Needs an LLM.
- `samples/escalate-demo.mjs` — three sequential `escalate()`
  calls: a three-option picker, a confirm, a free-text. Each can
  be answered by the user directly or via "Think via LLM".

### Protocol

- `lib/runner-bootstrap.mjs` exposes `models`, `t`, `shape`, `route`,
  `escalate` and bumps `constants.rpcVersion` to 6 (additive).
- `lib/runtime.js` adds `#escalateAsk` (parked), public
  `answerEscalate` (direct), public `thinkEscalate` (LLM dispatch),
  and a `pendingEscalates` Map on `RunState`. `snapshot()` and
  `#serializeState` include the new field.
- `lib/plugin.js` and `lib/standalone.js` add `POST /api/escalate-answer`
  and `POST /api/escalate-think`.

### Migration from 0.5.x

- Existing scripts that don't use `escalate` / `route` / `t` /
  `__dsh.models` keep working unchanged.
- `__dsh.models` is empty if the run is started with no `modelsAllowed`
  and the plugin Config's `allowedModels` is also empty (shouldn't
  happen with the default `['deepseek-chat']`).
- `escalate()` shadows nothing; if you have a local variable with that
  name, it just goes away.
- `route()` is sugar — `samples/model-router.mjs` still works exactly
  the same; both approaches compile to the same ask() calls.
- `t.*` and `shape()` are pure identity helpers — the host sees the
  same object it always did.

## [0.5.0] — 2026-10-16

The final piece of the ZCode dynamic-workflows replication: the script
can pause mid-run for a human to write code (hole<T>), LLM / shell
results can be replayed from a prior run's journal (AmendWorkflow),
and the run history survives a dsh restart (on-disk persistence).
ResumeWorkflowRun is exposed as `amendFrom: <previousRunId>` — same
mechanism, clearer name in the API.

### Added

- **`hole<T>(name, prompt, ctx?)` mid-run code injection.** Parked-RPC
  pattern: the child sends `hole.wait`, the host broadcasts
  `hole.waiting`, the user (or main agent) submits a body string via
  `POST /api/hole-answer`, the host responds on the original RPC id,
  and the bootstrap evals the body as `new AsyncFunction('ctx', body)(ctx)`.
  Three forms: unfilled (`hole(name, prompt, ctx)`), filled with ctx
  (`hole(name, prompt, ctx, bodyFn)`), filled without ctx
  (`hole(name, prompt, bodyFn)`). 10-minute host-side watchdog. The
  body has access to `ctx` and to `globalThis.__dsh.*` (the facade),
  but NOT to the script's lexical scope — the user passes any
  needed locals in `ctx`. Eval-mode prunes `hole` (in `__dsh`) so
  snippets can't park on holes.

- **`AmendWorkflow` cache.** `POST /api/run` body accepts
  `amendFrom: <runId>`. The new run's `#agentAsk` and `#worldRun` look
  up the prior run's journal and short-circuit on a `(name, prompt)` /
  `(cmd, args)` match, returning the cached content/result without
  re-running the LLM or shell. Cache key intentionally ignores
  `system` / `model` / `temperature` / `resultShape` — if you change
  those, don't amend. `agent.ask.cache_hit` and `world.run.cache_hit`
  events broadcast on a hit; the log gets a one-line note.

- **Resume = Amend.** ResumeWorkflowRun is the same mechanism under a
  different name: take a stopped or errored `runId`, pass it as
  `amendFrom` in a new `/api/run`. Same script, same journal, same
  cache. We didn't ship a separate `/api/runs/:id/resume` route on
  purpose — the semantics collapse cleanly.

- **On-disk run history persistence.** Every state change schedules a
  debounced (500ms) write of the run's JSON to
  `$DSH_HOME/runs/<runId>.json` (or `~/.dsh/runs/` if `DSH_HOME` is
  unset). Terminal states (`completed` / `error` / `stopped`) flush
  synchronously so the on-disk file matches memory. On startup, the
  runtime scans the directory and rehydrates the in-memory `runs`
  map with a "shell" RunState (no live child / subscribers / timers,
  but full journal + reports + artifacts). Best-effort: corrupt
  files are skipped silently. New `GET /api/runs` lists every known
  run including disk-loaded ones.

- **Journal extensions.** v0.3.0 only journaled `files.*` and `git.*`.
  v0.5.0 also journals `agent.ask` (with the result object) and
  `world.run` (with the result), so amend can replay them.

### New samples

- `samples/hole-demo.mjs` — `askUser` for a threshold, then `await
  hole(...)` to let a body string shape the final result. No LLM
  needed; manual test via `POST /api/hole-answer`.
- `samples/amend-demo.mjs` — three fixed `agent.ask` calls; run
  twice with the second `amendFrom` pointing at the first; the second
  run's `agent.ask` calls should all show "amend cache hit" in the
  log. Needs an LLM key.
- `samples/saved-examples/hollow-tool.mjs` — saved workflow with a
  `hole` call, with a `@arg` for the greeting target.

### Protocol

- `lib/runner-bootstrap.mjs` exposes `hole` and bumps
  `constants.rpcVersion` to 5 (additive). `globalThis.__dsh.hole` is
  in normal mode only.
- `lib/runtime.js` adds `#holeWait` / `answerHole` (private + public),
  `amendFrom` cache lookup in `#agentAsk` and `#worldRun`,
  `#schedulePersist` + `#writeRunToDisk` (atomic tmp + rename) +
  `#loadPersistedRuns`, `listAllRuns()`, and `journal.push` in
  `#agentAsk` and `#worldRun`.
- `lib/plugin.js` adds `POST /api/hole-answer`, `GET /api/runs`, and
  `amendFrom?: string` in `POST /api/run` body.
- `lib/standalone.js` mirrors the 3 changes.

### Migration from 0.4.x

- Existing scripts that don't use `hole()` or `amendFrom` keep working
  unchanged. The new `hole` facade shadows nothing; if you have a
  local variable named `hole` it just goes away.
- The 500ms persistence debounce is invisible to live runs; the
  on-disk JSON only shows up after the run finishes (terminal state
  flushes synchronously). If you want to wipe history, just `rm
  ~/.dsh/runs/*.json` (or `$DSH_HOME/runs/*.json`).
- Amend cache key is intentionally narrow. If you want stronger
  matching (e.g. on system prompt or model), add a `cacheKey?` field
  on `agent.ask` in a future round; for v0.5.0 the simple
  `(name, prompt)` match is what you get.

## [0.4.0] — 2026-10-16

Four ZCode dynamic-workflows features land: scripts can ask the LLM for typed
structured answers, get saved and reloaded from a managed directory, be
exercised by synchronous test snippets, and stop mid-run to ask the user a
question. Together these turn dsh-workflow-runner from "write and run" into
"manage, test, and interact with" workflows.

### Added

- **`ask<T>` typed results.** `agent(name).ask(prompt, { result: <shape> })`
  returns a structured object matching the shape, not a string. The shape
  uses a small JSON-friendly syntax:
  - `'string'` / `'number'` / `'boolean'` — primitives
  - `['string']` / `[{...}]` — arrays (one element = element shape)
  - `{ key: <shape>, ... }` — object with all keys required
  - `null` — any
  The host generates a JSON Schema, sets DeepSeek's
  `response_format: { type: 'json_object' }`, parses and validates, and
  retries once with a "fix the JSON" prompt if the response doesn't match.
  Throws with a clear error if both attempts fail. Without `result`, ask()
  behaves exactly as in v0.3.0 (`{ content, usage }`).

- **`SaveWorkflow` / `ListSavedWorkflows`.** New `~/.dsh/workflows/`
  directory (overridable via plugin Config `workflowsDir`) holds `.mjs`
  files with a JSDoc-style frontmatter:
  ```js
  /** dsh-workflow
   * @name my-workflow
   * @description One-line description
   * @whenToUse When to reach for this
   * @arg topic {string} The topic
   * @arg depth {number=2} How deep
   */
  ```
  Endpoints:
  - `GET /api/saved-workflows` — list (frontmatter parsed)
  - `POST /api/saved-workflows` — save
  - `POST /api/saved-workflows/delete` — remove
  - `GET /api/saved-workflows/content?name=...` — read source
  Editor lists the saved workflows under the bundled samples; click to
  load, edit, run. The "💾 Save…" button writes the current editor
  contents with new frontmatter.

- **`EvalWorkflowSnippet`.** New `POST /api/eval` runs an ad-hoc JS snippet
  synchronously and returns `{ status, log, result }`. Facade is pruned
  to the ZCode-defined subset (`args, log, files, git, world.run, channel,
  future`); `agent`, `artifact`, `phase`, `report`, `hole`, `model` are
  absent and any reference fails fast. 60-second watchdog, 64 KB code cap.
  The bootstrap detects `DSH_WORKFLOW_EVAL_MODE=snippet` and switches to
  the reduced facade. Editor exposes it as a "Try a snippet" panel under
  the main editor.

- **`ResolveWorkflowQuestion` via `askUser()`.** `await askUser(question, opts)`
  parks the script until the user answers. `opts` supports `kind: 'confirm'`
  (returns boolean) and `options: string[]` (returns one of the options,
  rendered as a button row). 5-minute host-side watchdog if the UI never
  answers. Editor renders a "Pending questions" card with the input
  control; submitting POSTs to `/api/question-answer` and the script
  resumes. Both sample-standalone and embedded in the dsh editor work.

### New samples

- `samples/typed-plan.mjs` — `ask({result: ...})` returns a structured
  plan object the script reads with `plan.paragraphs[0]` etc.
- `samples/ask-user.mjs` — three askUser() calls in sequence: a
  three-option picker, a confirm, a free-text. No LLM required.
- `samples/saved-examples/summarize.mjs`,
  `samples/saved-examples/scan-todos.mjs` — two example saved-workflow
  files with frontmatter; copy to `~/.dsh/workflows/` to see them in the
  editor's Saved list.

### Protocol

- `lib/runner-bootstrap.mjs` exposes `askUser` and forwards `result` in
  askOpts to the host. Bumps `constants.rpcVersion` to 4 (additive).
- `lib/runtime.js` adds `#questionAsk` (parks the RPC, broadcasts
  `question.asked` over SSE), `answerQuestion(runId, questionId, answer)`
  (public method for the API), `#agentAsk` resultShape branch (JSON
  schema generation, JSON-mode retry), and an `evalMode` start option
  that flips three env vars and uses a placeholder argv path.
- `lib/llm.js` `chat()` accepts `responseFormat` and forwards it as
  `response_format` in the request body.
- `lib/plugin.js` and `lib/standalone.js` add 5 endpoints
  (`/api/saved-workflows` ×3, `/api/saved-workflows/content`, `/api/eval`,
  `/api/question-answer`) and the frontmatter parse / render helpers.

### Migration from 0.3.x

- Existing scripts that don't use the new features keep working as-is.
  `ask()` without `result` still returns `{ content, usage }`. `agent()`,
  `artifact.*`, `phase()`, `report()`, `world.run()` all unchanged.
- Saved workflows stored in `~/.dsh/workflows/<name>.mjs` are now a
  managed directory; `runtime.snapshot()` exposes `evalMode` and
  `pendingQuestions` but no UI breaks if you don't use them.
- The new `askUser` facade shadows nothing in v0.3.x; if you have a
  local variable named `askUser` it just goes away.
- No new runtime dependencies.

## [0.3.0] — 2026-10-16

Six new facade functions from ZCode's `dynamic-workflows` skill land in
`globalThis.__dsh`, completing the script-authoring surface. The script can
now read its own workspace, see git state, stream items between stages, run
concurrent stages, route to specific models, and accept parameters — the
pieces a real ZCode-style workflow needs before its orchestration layer
becomes the bottleneck.

### Added

- **`args` — run parameters.** `POST /api/run` body accepts `args: object`;
  the host passes it as `DSH_WORKFLOW_ARGS` env. The bootstrap parses,
  sanitizes (JSON round-trip + freeze), and exposes it as a frozen
  `args` field. 64 KB cap; non-object / array values rejected with 400.

- **`files.{glob,read,grep}` — workspace read views.** Three new RPCs
  resolved against a per-run `workspaceRoot` (default = `dirname(scriptPath)`,
  overridable via plugin Config or per-run body). All paths are sandboxed
  to that root; escapes reject. Caps: 2000 files for `glob` / `grep`,
  256 KB for `read`, 256 KB of results for `grep`. `node_modules` / `.git`
  / `.zcode` skipped during walk. The `glob` subset supports `**`, `*`,
  `?` and `[abc]` — enough for typical scopes, no brace / extglob.

- **`git.{changedFiles,diff,status,log}` — git read views.** Four new RPCs
  running `git` in the workspaceRoot. Outside a git repository, or
  without `git` in PATH, every call rejects catchably — scripts
  `try/catch` and fall back. Caps: 512 KB diff, 20 commits default
  (max 100).

- **`channel<T>()` — in-process stage-to-stage stream.** FIFO queue with
  async iteration. Producing side owns `close()` in a `finally`. Send
  after close throws `ChannelClosed`. No host involvement; matches
  ZCode's `examples.md #6` fact-finding pipeline shape.

- **`future<T>(body)` — concurrent stage.** Starts `body` on the next
  microtask and returns its promise. `Promise.all([future(a), future(b)])`
  runs two stages concurrently. No host involvement.

- **`model(id)` — ModelRef marker.** Pass `model('deepseek-reasoner')` to
  `agent(name, { model })`. The host validates the id against the
  per-run `modelsAllowed` allowlist (default `['deepseek-chat']`,
  configurable in plugin Config and per-run body). `GET /api/models`
  exposes the list to the editor.

### New samples

- `samples/file-grep.mjs` — scan the workspace for TODO/FIXME/XXX,
  render per-file table + markdown summary. No API key.
- `samples/git-changed.mjs` — render "what changed" as a markdown
  artifact; gracefully degrades if the workspace isn't a git repo.
- `samples/channel-pipeline.mjs` — 3 producer futures → channel → 2
  verifier futures, with `close()` in the producer's `finally`. Mock
  data via `world.run('node', ...)` so no API key is needed.
- `samples/model-router.mjs` — light router decides per-question tier
  (light / strong), the answerer uses the chosen model. Will error on
  the LLM calls in a keyless env; the routing shape itself is correct.

### Protocol

- `lib/runner-bootstrap.mjs` exposes the six new facades and bumps
  `constants.rpcVersion` from 2 to 3 (additive — v2 scripts keep working).
- `lib/runtime.js` adds `workspaceRoot` / `modelsAllowed` / `journal` to
  per-run state, validates paths in `files.*` against `workspaceRoot`,
  and rejects `__modelRef` ids not in `modelsAllowed`.
- `lib/plugin.js` and `lib/standalone.js` accept `args` / `workspaceRoot` /
  `modelsAllowed` in `POST /api/run` body, and serve `GET /api/models`.
- Plugin Config accepts `workspaceRoot?: string` and
  `allowedModels?: string[]` (both optional; defaults preserve prior
  behavior).

### Migration from 0.2.x

- Existing scripts that don't use the new facades keep working as-is.
  `args` defaults to `{}`; `workspaceRoot` defaults to script's dirname;
  `modelsAllowed` defaults to `['deepseek-chat']`; any `model('foo')` that
  isn't in the allowlist now rejects instead of silently using that id
  (the previous behavior with no allowlist). Configure `allowedModels`
  in the plugin Config to restore prior freedom if you used other model
  ids.
- No new runtime dependencies. Node `fs.promises` and `path` are used
  directly; the glob subset is a 50-line hand-roll, not a package.
- `journal` is recorded but not yet consumed; it's the cache `AmendWorkflow`
  will key off in v0.5.0.

## [0.2.0] — 2026-10-16

Three features from ZCode's `dynamic-workflows` skill land in dsh-workflow-runner.
Together they make the dsh editor's live view feel like the ZCode phase graph,
and the script's outputs feel like real deliverables (charts, tables, kanban,
markdown, files) instead of a flat list of `report` items.

### Added

- **`artifact.*` facade.** Six new functions exposed through
  `globalThis.__dsh.artifact`:
  - `artifact.chart(id, spec)` — declare a line/bar/scatter chart fed by
    `report(item, id)`
  - `artifact.table(id, spec)` — declare a table (keyed rows supported)
  - `artifact.metrics(id, spec)` — declare a row of big-number tiles
  - `artifact.board(id, spec)` — declare a kanban board (status columns,
    keyed cards)
  - `artifact.markdown(id, content, opts)` — publish markdown text
    (256 KB cap)
  - `artifact.file(id, path, opts)` — publish a workspace file (text only,
    20 MB cap)
  - `primary: true` opts mark the deliverable; the editor highlights it
    with an accent border.
  - `report(item, tag)` whose `tag` matches a chart/table/metrics/board
    id is routed to that artifact's data list; the item still appears in
    the Reports panel (so existing scripts keep working). A new Artifacts
    tab in the viewer renders charts as hand-rolled SVG, tables as HTML,
    metrics as number tiles, boards as kanban columns, markdown via a
    minimal in-house subset (h1-3 / ul / ol / code / pre / **bold** /
    *italic* / links), and file artifacts as a link to
    `/api/artifact-content`.

- **`world.run` confirm modal.** Before a run starts, the editor extracts
  every `world.run("name", ...)` command name from the script source
  (regex-based, deduped) and shows a modal listing them. The user picks
  the subset to allow; the run starts with that list as
  `worldRunAllowlist`. Any `world.run` call whose `cmd` is not in the
  approved list is rejected by the runtime with a clear error and logged
  as a `world.run.declined` event. Scripts with no `world.run` skip the
  modal (no noise). The allowlist is per-run, not persisted — every Run
  re-asks, matching the "safe default" the user picked.

- **Phase folding.** Calling `phase("X")` in a loop now collapses to a
  single UI pill with an `× N` badge, matching ZCode's phase graph
  behavior. The runtime keeps the full call log (`phases` array on
  snapshot) and exposes the deduped view as `phaseSummary`; the editor
  uses `phaseSummary`. Both worlds (old snapshots without
  `phaseSummary` and new ones) render correctly.

### New samples

- `samples/artifact-demo.mjs` — declares a chart, metrics tiles, and a
  kanban board, runs three rounds of `world.run` to feed the chart, then
  publishes a markdown summary as the primary deliverable. No API key
  needed.
- `samples/confirm-demo.mjs` — exercises the confirm modal by calling
  `world.run("node", …)`, `world.run("git", …)` and
  `world.run("powershell", …)` so the user can see the three
  accept/deny outcomes in one run.
- `samples/loop-phases.mjs` — `for (i=0; i<5; i++) phase("check")` to
  demonstrate phase folding.

### Protocol

- `lib/runner-bootstrap.mjs` exposes `artifact` and bumps
  `constants.rpcVersion` from 1 to 2 (artifacts are additive, v1 scripts
  keep working).
- `lib/runtime.js` adds `artifacts: Map<id, …>`, `phaseSummary: Map<name, …>`,
  and `worldRunAllowlist: Set<string> | null` to the per-run state.
- `lib/plugin.js` and `lib/standalone.js` get `GET /api/extract-commands`
  and `GET /api/artifact-content`; `POST /api/run` body accepts
  `worldRunAllowlist: string[]`.

### Migration from 0.1.x

- Existing scripts (no `artifact.*`, no allowlist) keep working as-is.
  The new RPC methods are additive; `constants.rpcVersion: 2` is just a
  hint for tooling.
- Plugin install path and cordis patch unchanged. The 401/403 gate
  behavior is unchanged. No new runtime dependencies.
- Editors built against 0.1.x's snapshot shape (no `phaseSummary`, no
  `artifacts`) still render: `editor.js` falls back to the flat
  `phases` array when `phaseSummary` is absent.

## [0.1.6] — 2026-10-15

### Fixed

- **`run failed: HTTP 401` on every Load / Run / Stop.** 0.1.5 introduced the
  `/api/*` gate and treated *both* of `requestRejection()`'s refusals as a
  denial. They are not equivalent:
  - **403** is the Host/Origin fence rejecting a cross-site or DNS-rebinding
    caller — the real protection against a web page driving the local server.
  - **401** means the fence already **passed** and only dsh's browser-session
    cookie is absent.

  The editor is a self-mounted `/workflow` page, and dsh mints its session
  cookie only for the root `/` token handshake, so that page can never present
  one. Treating 401 as a denial therefore made the plugin's own UI permanently
  unusable while adding no local security: the cookie's signing secret lives in
  `$DSH_HOME/.credentials.yaml`, so any local process can mint a valid session
  anyway. The gate now denies only non-401 refusals; 403 still always denies,
  and a missing or throwing gate still fails closed with 503.

### Verification

Added a `no-session` mode to the offline harness — a stub `requestRejection`
that returns 403 for a hostile Origin and 401 otherwise, mirroring the real
service. 0.1.5 scores `no-session 5/8` (the three failures being
`/api/list`, `/api/run` and `/api/samples` all answering 401, i.e. the reported
bug); 0.1.6 scores `no-session 9/9`, with `cross-site`, `no-gate` and
`throwing-gate` all still denying.

## [0.1.5] — 2026-10-15

The first npm release. Fixes five defects that together made the plugin look
"installed but broken": the editor page could not be opened at all, and the
API behind it was both unreachable from the browser and unauthenticated.
### Fixed

- **Editor page returned an infinite redirect.** `plugin.js` redirected both
  `''` and `'/'` to `routePath + '/'`, so `/workflow/` redirected to itself
  forever (`ERR_TOO_MANY_REDIRECTS`). The browser-half button opens exactly
  `/workflow/?from=dsh`, so the entire UI was unreachable. Only the slash-less
  form redirects now; `/workflow/` falls through to `index.html`.
- **Every `agent(name).ask(prompt)` call failed** with
  `cannot get property "llm" without inject`. `lib/llm.js` reads
  `ctx.llm.resolveCallConfig(...)`, but `llm` was missing from the plugin's
  `inject` list, and cordis refuses to hand out an undeclared service. Only
  LLM-free scripts (`world.run` / `phase` / `report`) ever worked.
- **The editor's API calls all hit the wrong URL.** `public/editor.js` used
  root-absolute paths (`/api/run`, `/api/state`, …), which under dsh resolve to
  the host's own API gateway and answer **401** — Load / Run / Stop were dead.
  The base is now derived from the module's own URL, so the page works both
  under the dsh route prefix and at the site root in standalone mode.
- **`/api/*` was effectively unauthenticated.** The gate read a
  `ctx.connection.gate` object that does not exist (the real API is
  `ctx.connection.requestRejection(req)`), and the thrown access error was
  swallowed as "gate fault → allow". Any local process could therefore POST
  `/api/run` and execute arbitrary scripts and shell commands. The gate now
  calls the real API and **fails closed**: if the service is missing or throws,
  the route answers **503** instead of admitting the caller.
- **The three sample buttons did nothing** under dsh: `editor.js` reads an
  `/api/samples` hint to resolve a sample to an absolute path, and
  `lib/standalone.js` served that route while `lib/plugin.js` did not. Added.

### Changed

- `dsh.client` bundle resolution no longer breaks on a shadowing
  `lib/package.json`. A stray manifest inside `lib/` made the host's
  `dsh.client` scan resolve the client entry to `lib/lib/client.js` (which does
  not exist), so the browser half was silently dropped and no `▶ Workflow`
  button ever appeared. The file is not part of the published package; the
  client entry now resolves to `lib/client.js` as intended.

### Added

- `engines.dsh` (`>=0.2.0-rc.2`) and `dsh.compatibility.dshReleases`, so the
  plugin market can display the host requirement instead of "undeclared".
- `CHANGELOG.md` (now shipped in the npm tarball).

### Verification

Every fix is covered by an offline harness that boots the plugin's real
`apply()` against a stub cordis context and drives real HTTP through the
resulting route, in three gate modes (healthy / service-missing / throwing):

```
route + gate + samples   healthy 9/9 · no-gate 8/8 · throwing-gate 8/8
inject / llm plumbing    9/9
```

The same suite run against 0.1.4 scores `healthy 5/8 · no-gate 3/8 ·
throwing-gate 3/8` — the `no-gate` failures being `/api/list` and `/api/run`
answering **200** without authentication, which is the security fix above.

## [0.1.4] — 2026-10-15

### Added

- A `/workflow` slash command in dsh's chat surface, returning a clickable link
  to the editor (optionally prefilled with a script path).

> Tagged in git only — this version was never published to npm. The client half
> it added could not load because of the `lib/package.json` shadowing bug fixed
> in 0.1.5.

## [0.1.3] — 2026-10-15

### Fixed

- Dropped the `@deepseek-ai/schemastery` peer dependency, which dsh's bundled
  bundle resolver could fail to find on a fresh install, producing
  `failed to import` and leaving the plugin inactive. Config is now validated
  by a hand-rolled validator inside `apply()`, so module load needs no
  third-party resolution.

## [0.1.2] — 2026-10-15

### Added

- npm publishing metadata (`files`, `publishConfig`, `exports`) and the
  `update.cmd` maintainer script that commits, optionally bumps and publishes,
  then copies the sources into the installed dsh profile.
- GitHub Actions workflow running `node --check` on every `.js` / `.mjs` file.

## [0.1.1] — 2026-10-15

### Added

- Initial release: a cordis server plugin mounting `/workflow` on dsh's web
  server, a `WorkflowRuntime` that spawns each workflow script as a Node child
  process over line-delimited stdio JSON-RPC, the
  `phase` / `log` / `report` / `agent().ask()` / `world.run()` facade, a
  live SSE progress view, and an editor page.

[0.1.6]: https://github.com/gamelongtim-ux/dsh-workflow-runner/releases/tag/v0.1.6
[0.7.0]: https://github.com/gamelongtim-ux/dsh-workflow-runner/releases/tag/v0.7.0
[0.6.0]: https://github.com/gamelongtim-ux/dsh-workflow-runner/releases/tag/v0.6.0
[0.5.0]: https://github.com/gamelongtim-ux/dsh-workflow-runner/releases/tag/v0.5.0
[0.4.0]: https://github.com/gamelongtim-ux/dsh-workflow-runner/releases/tag/v0.4.0
[0.3.0]: https://github.com/gamelongtim-ux/dsh-workflow-runner/releases/tag/v0.3.0
[0.2.0]: https://github.com/gamelongtim-ux/dsh-workflow-runner/releases/tag/v0.2.0
[0.1.5]: https://github.com/gamelongtim-ux/dsh-workflow-runner/releases/tag/v0.1.5
[0.1.4]: https://github.com/gamelongtim-ux/dsh-workflow-runner/releases/tag/v0.1.4
[0.1.3]: https://github.com/gamelongtim-ux/dsh-workflow-runner/releases/tag/v0.1.3
[0.1.2]: https://github.com/gamelongtim-ux/dsh-workflow-runner/releases/tag/v0.1.2
[0.1.1]: https://github.com/gamelongtim-ux/dsh-workflow-runner/releases/tag/v0.1.1
