---
name: dynamic-workflows
description: Author and run Dynamic Workflows in dsh — multi-step, multi-agent TypeScript workflows that read the workspace, run commands, and deliver artifacts. Use when a task needs several dependent steps, parallel subagents, or a review loop.
whenToUse: When the task is a multi-step workflow: several dependent stages, several subagents working in parallel, a plan-then-critique loop, or anything that should end in a deliverable rather than a paragraph.
---

# Writing Dynamic Workflows

A Dynamic Workflow is a **TypeScript file** that runs inside dsh's workflow
engine. The engine compiles it first — statically analysing it, lowering it to
instrumented JavaScript, and turning every typed `ask<T>()` into a JSON Schema
— and only then runs it. A workflow that does not compile never runs, and the
compiler tells you why.

The authoring surface is small. Everything below is the whole contract.

## 1. The shape of a workflow

A workflow is a **script**, not a module: no imports, no exports, no `require`.
Top-level `await` is allowed, and the value you `return` is the run's result.

```ts
interface Plan {
  title: string;
  steps: string[];
}

phase("plan");

const plan = await agent("planner", { system: "You plan fixes." }).ask<Plan>(
  "Plan the fix for the failing test.",
);

report({ plan });
return { plan };
```

Two rules the compiler enforces, both worth internalising:

- **A `phase()` marker is required**, and it must be a literal string.
- **Facade calls must be direct.** `const a = agent; a("x")` is rejected: a facade
  call that escapes into value space loses its site, and a site is what makes
  the call visible in the graph, the journal and the resume.

## 2. The facade

Everything you can call:

| Call | What it does |
|---|---|
| `phase("name")` | Marks a group of steps. Presentation only; it starts, waits and returns nothing. Required. |
| `agent(name?, persona?)` | Creates a subagent. `persona` is a string (the system prompt) or `{ system, model }`. |
| `agent(...).ask<T>(text)` | Gives the subagent one task. With `T`, the answer is a value of type `T`, validated against a schema built from it. Without, the answer is its final reply text. |
| `log("message")` | Progress narration. |
| `report(item, artifactId?)` | Publishes one intermediate result. It survives the run, even a failed one. |
| `artifact.file(id, path, opts?)` | Publishes a workspace file to the user. |
| `artifact.markdown(id, text, opts?)` | Publishes markdown to the user. |
| `artifact.chart(id, spec)` | Declares a chart fed by `report(item, id)`. |
| `artifact.table(id, spec)` | Declares a table fed by `report(item, id)`. |
| `artifact.metrics(id, spec)` | Declares a row of metric tiles. |
| `artifact.board(id, spec)` | Declares a board of cards. |
| `files.glob(pattern)` | Workspace-relative paths matching a glob. |
| `files.read(path)` | One workspace file, as text. |
| `files.grep(pattern, glob?)` | Matching lines. |
| `git.changedFiles(base?)` | Paths that changed. |
| `git.diff(base?, path?)` | A unified diff. |
| `git.status()` | The working tree's status. |
| `git.log(count?)` | Recent commits, newest first. |
| `world.run(cmd, args?, opts?)` | Runs a command. `cmd` must be a literal, and it is shown to the user for approval. |
| `channel<T>(name?)` | A typed stream between two stages. |
| `future<T>(body)` | Runs a block as a concurrent stage. |
| `hole<T>(name, prompt?)` | A typed gap: code you write later, once an earlier step's findings are in. |
| `model("id")` | Names a model for one subagent. |
| `args` | The run's arguments. |

And dsh's own additions:

| Call | What it does |
|---|---|
| `askUser(question, opts?)` | Asks the **human** a question mid-run and waits for the answer. `opts.kind` is `"text"` or `"confirm"`. |
| `escalate(question, opts?)` | Asks the human, but the host may answer with a model first and the human confirms. |
| `route(MODELS, router, answerer)` | Two-stage routing. `MODELS` maps a tier to a model id; the router picks the tier, the answerer does the work. |
| `models` | The model ids this run may use. |
| `concurrency.stat()` | The host's view of the run's concurrency limiter. |
| `stages.list()` / `stages.pending()` / `stages.await()` | The stages the host injected into this run. |
| `constants` | Runtime constants. |

## 3. Typed results

Give `ask` a type argument and you get a **value**, not prose:

```ts
interface Finding {
  /** The test that flaked. */
  testId: string;
  /** 0-1, how confident the scan is. */
  confidence: number;
}

const findings = await agent("scanner", { system: "You find flaky tests." })
  .ask<Finding[]>("Find the flaky tests.");
```

Two things to know:

- `T` is an **interface you declare in the same file**, with a plain
  `interface` declaration — no `declare` modifier (the script is compiled
  inside a function body, where ambient declarations are illegal).
- **The doc comments on `T` are not decoration.** They become the field
  descriptions the subagent actually reads. A one-line comment per field is
  the difference between a schema the model fills correctly and one it
  guesses at.

Narrow the result. `ask<Finding[]>`, not `ask<Finding>` — the schema follows
the type, and a narrow schema is a checkable one.

## 4. Subagents

- **A name is an identity.** It must be unique within the run. A duplicate
  literal name is a compile error; a computed one fails the run.
- **A name is also a cache key.** An amended re-run matches its cached work
  by actor name, so a stable name means a cache hit and a fresh name means
  fresh work.
- **Every `agent()` call starts a new, empty conversation.** To continue one,
  keep the returned value: `const reviewer = agent("reviewer"); await reviewer.ask(...); await reviewer.ask(...)`.
- **One agent per job.** Two agents with different system prompts are two
  different judges. Two calls to the same agent are the same judge, twice.

## 5. Fresh eyes

When a step should not trust the previous step, use a **different** agent with
a **different** system prompt. Four rules:

1. **Independent context.** A reviewer that shares the author's context
   inherits its blind spots.
2. **Ask for failure, not approval.** "Find what is wrong with this" gets
   findings; "is this good?" gets a yes.
3. **The same evidence.** A reviewer that cannot see the artefact cannot
   review it — and a reviewer that only sees the summary is reviewing the
   summary.
4. **Prose needs a separate reader.** If a human will read the output, a
   subagent should read it too.

## 6. Phases, reports and artifacts

```ts
phase("scan");
const findings = await agent("scanner", { system: "You find flaky tests." })
  .ask<Finding[]>("Find the flaky tests.");

report({ count: findings.length }, "perf");   // tagged → feeds the "perf" artifact

phase("plan");
const plan = await agent("planner", { system: "You plan fixes." })
  .ask<Plan>("Plan the fix.");

artifact.chart("perf", {
  x: { field: "count" },
  y: { field: "count" },
});
```

- A `phase()` marker covers every step from it to the end of the block it
  stands in. Two markers with the same name are one phase.
- Every phase contains at least one `ask` or `world.run`.
- `report(item, id)` routes the item to a declared chart/table/metrics/board
  **and** to the run's results. Declare the artifact before the first tagged
  report.
- Artifacts are what the user keeps. `file` and `markdown` are effects —
  they publish bytes. `chart`, `table`, `metrics` and `board` are
  declarations — they draw from reported items.

## 7. The world

The script sees the workspace through a small, read-only door:

- `files.*` and `git.*` are **read-only**. Writing is a subagent's job.
- Every path is **workspace-relative**. A path that resolves outside the
  workspace is refused, and so is a symbolic link that points out of it.
- `world.run(cmd, args?)` runs a command with **fixed argv** — no shell, no
  pipes, no redirection. `cmd` must be a literal, and the user sees the
  command before it runs.
- `world.run` is the only way to change anything, and the run's journal
  records it, so a resumed run does not repeat it.

## 8. Concurrency

`channel` and `future` are the pipeline primitives.

```ts
const facts = channel<Finding>("facts");

const scanner = future(async () => {
  const found = await agent("scanner", { system: "You find flaky tests." })
    .ask<Finding[]>("Find the flaky tests.");
  for (const f of found) facts.send(f);
  facts.close();
});

const reader = future(async () => {
  for await (const f of facts) {
    log("saw " + f.testId);
  }
});

await Promise.all([scanner, reader]);
```

**A channel nobody closes is a deadlock**, and a deadlock fails the run — it
does not hang. Every producer closes its channel.

## 9. Asking the human

```ts
const name = await askUser("What should the report be called?", { kind: "text" });
const ok = await askUser("Apply the fix?", { kind: "confirm" });
```

The run **pauses** here. The question reaches the user, and the answer comes
back on the same run. Use it when the workflow cannot proceed without a human
— not to ask about something you could have derived.

`escalate` is the same thing with a model in the middle: the host proposes an
answer, the human confirms it. Use it when the model's judgement is worth
checking but the answer is likely to be accepted.

## 10. Holes

A hole is code you write later, once an earlier step's findings are in:

```ts
const findings = await agent("scanner", { system: "You find flaky tests." })
  .ask<Finding[]>("Find the flaky tests.");

const fix = await hole<Fix>(
  "write-fix",
  "Write the fix for: " + findings.map((f) => f.testId).join(", "),
);
```

The run parks at the hole; the rest of it keeps going. The body runs in the
hole's place and sees the bindings declared before it.

## 11. Anti-patterns

- **One giant agent doing everything.** Split the work: different agents,
  different system prompts, one job each.
- **A reviewer that shares the author's context.** It cannot surprise you.
- **Asking for approval instead of failure.** "Find three problems" beats
  "is this fine".
- **Passing content where a path would do.** A subagent that can read the
  file should get the path, not the bytes.
- **A wide, loosely typed result.** `ask<string>` returns prose you then
  parse. `ask<Finding[]>` returns a value you can use.
- **Forgetting to close a channel.** That is a deadlock.
- **`world.run` with a computed command.** It has to be a literal, so the
  user can be shown it.
- **A `phase()` with nothing in it.** Every phase needs an `ask` or a
  `world.run`.

## 12. Before you submit

- Every `ask` that needs structure has a type argument, and every field of
  that type has a doc comment.
- Every agent name is unique, and every name is meaningful.
- Every phase has work in it.
- Every channel is closed.
- Every `world.run` command is a literal, and the user would be happy to
  approve it.
- The script `return`s the run's result — the thing the user asked for.
