# Contributing to dsh-workflow-runner

Thanks for considering a contribution. This plugin is intentionally small
(≈2 400 LoC) and built on top of three stable contracts: dsh's cordis host,
the DeepSeek `/v1/chat/completions` API, and Node's `child_process` stdio.
Contributions that improve ergonomics or broaden the facade are welcome;
changes that couple the plugin to dsh internals are not.

## Quick setup

```bash
git clone https://github.com/gamelongtim-ux/dsh-workflow-runner.git
cd dsh-workflow-runner
node lib/standalone.js          # 127.0.0.1:7910
# visit http://127.0.0.1:7910/ in a browser
```

## File layout (cheat sheet)

| Path | Purpose |
| --- | --- |
| `lib/plugin.js` | cordis host-side plugin (registers the `/workflow` web route) |
| `lib/runtime.js` | `WorkflowRuntime` class — owns runs, JSON-RPC, SSE broadcast |
| `lib/runner-bootstrap.mjs` | runs in the user-script child process; talks to the host via stdio |
| `lib/llm.js` | DeepSeek chat-completion helper + key resolution |
| `lib/standalone.js` | same host behaviour, no cordis dependency |
| `lib/client.js` | browser-side cordis plugin (3 slots) |
| `public/index.html` + `public/editor.js` + `public/styles.css` | the editor/viewer UI |
| `samples/*.mjs` | three reference workflows; safe to copy as a starting point |

## Code conventions

- **ESM only.** All `.js` and `.mjs` files are ES modules.
- **No external runtime deps.** The package intentionally has zero `dependencies`
  — the dsh host already provides `@deepseek-ai/schemastery` (peer).
  Adding a new dep is a discussion item, not a unilateral move.
- **User-script contract** is documented in the README under "Writing a workflow".
  Anything user-facing that changes that contract belongs in a major-version bump.

## Testing

There is no formal test suite. The smoke workflow in `samples/smoke.mjs` is
the de-facto end-to-end test — it exercises every facade path and runs without
an API key. To run it:

```bash
# in one shell
node lib/standalone.js
# in another
curl -sS -X POST http://127.0.0.1:7910/api/run \
  -H 'content-type: application/json' \
  -d '{"scriptPath":"'$(pwd)'/samples/smoke.mjs"}'
# then watch the SSE stream
curl -sS 'http://127.0.0.1:7910/api/list' | head -c 200
```

## Pull requests

1. Open a PR against `main`.
2. Add or update a sample in `samples/` if your change adds a new facade.
3. Make sure `node --check` passes on every `.js` and `.mjs` you touched.
4. Update the README — both English and Chinese — if the public contract moved.

## Security

This plugin executes user-supplied `.mjs` files as Node subprocesses and
`world.run(cmd, args)` as local shell commands. The default scripts-root
allowlist for `api/script-content` is `$DSH_HOME/workflows` plus the bundled
`samples/` directory. **Do not** widen the allowlist without understanding the
implications for whoever runs this in a multi-user dsh host.
