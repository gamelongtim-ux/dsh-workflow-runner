# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> **npm release note.** Versions up to and including **0.1.4** existed only as
> git tags / GitHub `main`; the package name was never published to
> registry.npmjs.org. **0.1.5 was the first version on npm.**

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
[0.1.5]: https://github.com/gamelongtim-ux/dsh-workflow-runner/releases/tag/v0.1.5
[0.1.4]: https://github.com/gamelongtim-ux/dsh-workflow-runner/releases/tag/v0.1.4
[0.1.3]: https://github.com/gamelongtim-ux/dsh-workflow-runner/releases/tag/v0.1.3
[0.1.2]: https://github.com/gamelongtim-ux/dsh-workflow-runner/releases/tag/v0.1.2
[0.1.1]: https://github.com/gamelongtim-ux/dsh-workflow-runner/releases/tag/v0.1.1
