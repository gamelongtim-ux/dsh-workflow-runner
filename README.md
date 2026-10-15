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
git clone https://github.com/gamelongtim-ux/dsh-workflow-runner.git
cd dsh-workflow-runner
dsh plugin --profile desktop add file:"$PWD"
```

Then restart `dsh web` and look for the `▶ Workflow` button in the chat composer dock.

> 📌 If pnpm refuses to re-copy on the same version (a pnpm 12 `add file:`
> quirk), bump `version` in `package.json` or use `update.cmd`.

## Sharing this plugin with other dsh users

There are three install paths; pick the one that matches the audience you are
handing the URL to.

| Path | What the user pastes in dsh's "添加插件" dialog | Notes |
| --- | --- | --- |
| **GitHub URL** *(currently used)* | `https://github.com/gamelongtim-ux/dsh-workflow-runner` | Always available; pulls the latest `main` HEAD. |
| **Local path** | `<absolute path to a cloned checkout>` | Best for users who want to follow your local edits; pair with [`update.cmd`](#updating-after-local-edits). |
| **npm name** *(not yet published)* | `dsh-workflow-runner` | Faster in China through npm's mirror, locks a version, but requires the maintainer to publish to npmjs.org first. |

> The dsh desktop install dialog also has a "中国大陆镜像源" dropdown —
> that mirror is a read-side accelerator; the package itself must still be
> reachable on GitHub (or npmjs.org).

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

Check in order:

1. The plugin entry exists in **插件** page and the toggle is **on**.
2. dsh desktop is **restarted** after the toggle (Task Manager →
   `DeepSeek Harness.exe` → End task → reopen). Bundle load is at
   process start, not on toggle.
3. You're in a **new session** (左下角 → 新会话), not an old one
   that was opened before install.
4. The host's dsh version is **V0.2.0-rc.2 or above** — older
   versions may not have the `conversation.composer.dock` slot we
   register against.

## Out of scope (deliberate)

- TypeScript typecheck — JS + JSDoc only.
- `hole<T>()` mid-run human intervention — no interactive mode.
- Cache-aware amendment — script edits require re-running.
- Plugin configuration card on Settings → Plugins.
- Run history persistence — kept in memory only; closing dsh wipes runs.

## License

MIT.
