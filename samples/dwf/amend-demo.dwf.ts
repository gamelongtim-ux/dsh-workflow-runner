// AmendWorkflow 的缓存复用：同一次 run 里的多次 ask，第二次跑时可以从上一次的结果里复用。
//
// 同一个 actor 的多次 ask 写成「一次 agent()、多次 .ask()」：agent() 的返回值就是那个会话，
// 后续 ask 接着它的上下文说下去。actor 名在一次 run 内必须唯一，所以这里只建一个 planner。

// --- 两次 run 之间改这里（v1 → v2）-------------------------------------------
const PROMPT_VERSION = "v1";
// ---------------------------------------------------------------------------

const planner = agent("planner", { system: "You are concise." });

phase("Single-ask intro");
const intro = await planner.ask("Reply with exactly: ok");
log(`intro: ${intro.trim()}`);

phase("Three numbered asks (this is what amend will cache)");
const a = await planner.ask(
  `Reply with exactly the letter A and nothing else. [${PROMPT_VERSION}]`,
);
const b = await planner.ask("Reply with exactly the letter B and nothing else.");
const c = await planner.ask("Reply with exactly the letter C and nothing else.");
log(`a=${a.trim()} b=${b.trim()} c=${c.trim()}`);

phase("Publish a summary");
const md = [
  "# Amend demo",
  "",
  `* intro: ${intro.trim()}`,
  `* a: ${a.trim()}`,
  `* b: ${b.trim()}`,
  `* c: ${c.trim()}`,
  "",
  "## How amend reuses this",
  "",
  "Re-run with the same actor and the same prompt, pointing amendFrom at the previous run.",
  "The host returns the cached result for each ask; no LLM call.",
  "",
].join("\n");
await artifact.markdown("report", md, { title: "Amend demo", primary: true });

// 门：产物写出去之后确认它不是空的。
const gate = await world.run(
  "node",
  ["-e", "process.stdout.write(String(process.argv[1].length))", md],
  { timeoutMs: 5000 },
);
log(`published report is ${gate.stdout.trim()} chars`);

return { a: a.trim(), b: b.trim(), c: c.trim() };
