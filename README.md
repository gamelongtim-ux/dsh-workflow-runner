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
| `phase(name)` | `Promise<{ok:true}>` | Mark a workflow phase. All complete phases are listed in the UI. |
| `log(message, level='info')` | `Promise<{ok:true}>` | Stream into the event log. `level` ∈ `info`, `warn`, `error`, `debug`. |
| `report(item, tag=null)` | `Promise<{ok:true}>` | Surface a structured item in the Reports panel. `item` can be any JSON-serializable value. |
| `agent(name, opts).ask(prompt)` | `Promise<{content, usage}>` | Spawn (or reuse) a sub-agent by name; same-name reuse keeps chat history. `opts` ∈ `{system, model, temperature, maxTokens}`. |
| `agent(name).close()` | `Promise<{closed:true}>` | (Optional) hint; history is per-run, freed when the run ends. |
| `world.run(cmd, args, opts)` | `Promise<{exitCode, signal, stdout, stderr, durationMs}>` | Spawn a local shell command. Non-zero exit is a value, not an exception. `opts.cwd / env / timeoutMs` configurable. |

> The first argument to `agent(name, opts)` may be just `agent('planner')`; `opts` is optional.

## Samples

Three are in `samples/`:

| File | Pattern |
| --- | --- |
| `smoke.mjs` | Phase + log + world.run + report — no LLM calls; runs without an API key. |
| `planner-critic.mjs` | `planner` then `critic`, then `planner` again with critique in prompt — bounded single-thread loop. |
| `fanout-summarize.mjs` | Three parallel `summarizer-N` agents, then a `reducer` agent synthesizes the result. |

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

This is **not** caused by `dsh-workflow-runner` itself — the plugin
has zero third-party runtime deps. pnpm's lockfile verifier checks
**every** entry in the profile's lockfile against
`minimumReleaseAge` and rejects any package published within the
window (default 24h). The error names the offending package (e.g.
`dsh-workbuddy-connect@0.7.5 was published at 2026-10-14T17:23Z`).

Two ways out:

- **Wait** until the offending package ages past the policy window
  (typically 1-3 days), then retry the install.
- **Bypass** with a manual copy that skips pnpm entirely:

  ```powershell
  $D = "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-workflow-runner"
  $S = "D:\ZcodeStorage\.zcode\workspace\default\dsh-workflow-runner"
  New-Item -ItemType Directory -Force -Path $D | Out-Null
  Copy-Item "$S\lib","$S\public","$S\samples","$S\package.json","$S\cordis.patch.yml" `
           -Recurse -Force -Destination $D
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

- TypeScript typecheck — JS + JSDoc only.
- `hole<T>()` mid-run human intervention — no interactive mode.
- Cache-aware amendment — script edits require re-running.
- Plugin configuration card on Settings → Plugins.
- Run history persistence — kept in memory only; closing dsh wipes runs.

## License

MIT.
