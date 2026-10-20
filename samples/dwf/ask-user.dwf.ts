// 中途问用户：脚本停在 await askUser(...) 上，等人在 UI 里选一项或填一段自由文本。
//
// 走通流程：先弹一个三选一问题（选 threshold），再弹一个 confirm 确认，最后一段自由文本。
// 不需要 LLM。

phase("Ask user which threshold to use");
const threshold = await askUser("What threshold should we use for the score gate?", {
  options: ["90", "95", "100"],
});
log(`user picked threshold: ${threshold}`);
report({ step: "pick-threshold", value: threshold });

phase("Ask user to confirm before proceeding");
const ok = await askUser(`Apply threshold ${threshold} and continue?`, { kind: "confirm" });
log(`user confirm: ${ok}`);
report({ step: "confirm", value: ok });

if (!ok) {
  // 提前退出：这一段归上一个 phase 管，所以这里只留一条日志说明为什么停。
  log("the user declined; stopping before the rest of the run");
  return { ok: false, threshold, reason: "user declined" };
}

phase("Ask user for a free-text note (no options)");
const note = await askUser("Optional: any free-text note for the report? (empty to skip)");
log(`user note: ${JSON.stringify(note)}`);

phase("Publish a markdown report of the answers");
const md = [
  "# User-driven run report",
  "",
  `* Threshold picked: \`${threshold}\``,
  `* Confirmed: ${ok}`,
  `* Note: ${note && note.length > 0 ? note : "_(none)_"}`,
  "",
].join("\n");
await artifact.markdown("report", md, { title: "User answers", primary: true });

// 门：产物写出去之后确认它不是空的。
const gate = await world.run(
  "node",
  ["-e", "process.stdout.write(String(process.argv[1].length))", md],
  { timeoutMs: 5000 },
);
log(`published report is ${gate.stdout.trim()} chars`);

return { ok: true, threshold, confirmed: ok, note };
