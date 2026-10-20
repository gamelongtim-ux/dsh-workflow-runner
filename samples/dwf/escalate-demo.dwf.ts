// escalate()：把问题交给人，宿主可以先用模型想一想再让人确认。
//
// 形状与 askUser 一样（都是把 run 停在这里等人回答），区别是宿主的 UI 会多给一个
// 「Think via LLM」按钮：宿主拿 run 最近的日志 + 问题当上下文去调一次 LLM，用模型的回答当答案。
//
// 答案有三个来源：
//   1. 人直接回答；
//   2. 人点了 Think via LLM，宿主派发 LLM，答案从那里来；
//   3. 超时后宿主自动派发（本路径未开启）。
//
// Think-via-LLM 那条路需要 LLM key；没有 key 时人直接回答照样走通。

phase("First escalate: three options, the user picks or the host thinks via an LLM");
const tier = await escalate("Which quality tier should we ship at?", {
  options: ["fast", "balanced", "thorough"],
});
log(`tier answer: ${JSON.stringify(tier)}`);

phase("Second escalate: confirm");
const proceed = await escalate(`Tier "${tier}" chosen. Proceed with this?`, { kind: "confirm" });
log(`confirm answer: ${JSON.stringify(proceed)}`);

if (!proceed) {
  phase("User declined — exit early");
  return { tier, proceed, early: true };
}

phase("Third escalate: free-text, no options");
const note = await escalate("Any extra note for the report? (empty to skip)");
log(`note answer: ${JSON.stringify(note)}`);

phase("Publish a markdown report of the answers");
const md = [
  "# Escalate demo",
  "",
  `* Tier: \`${tier}\``,
  `* Confirmed: ${proceed}`,
  `* Note: ${note && note.length > 0 ? note : "_(none)_"}`,
  "",
  "The answers above came from one of three sources:",
  "1. The user typed a direct answer",
  "2. The user clicked \"Think via LLM\" — the host dispatched an LLM",
  "3. The default (host auto-dispatch after a timeout — not enabled here)",
  "",
].join("\n");
await artifact.markdown("report", md, { title: "Escalate demo", primary: true });

// 门：产物写出去之后确认它不是空的。
const gate = await world.run(
  "node",
  ["-e", "process.stdout.write(String(process.argv[1].length))", md],
  { timeoutMs: 5000 },
);
log(`published report is ${gate.stdout.trim()} chars`);

return { tier, proceed, note };
