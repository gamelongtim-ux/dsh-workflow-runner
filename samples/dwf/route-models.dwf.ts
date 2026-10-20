// Route between two models: a cheap one decides, an expensive one answers.
//
// The router and the answerer are the SCRIPT's own functions, so the model
// call stays in the script's hands — route() is sugar over two of your own
// callbacks, not a hidden dispatcher.

interface Verdict {
  /** "light" or "strong". */
  tier: string;
  /** Why. */
  reason: string;
}

phase("route");

const verdict = await route(
  { light: "deepseek-chat", strong: "deepseek-reasoner" },
  async (light) => {
    const v = await agent("triage", { system: "You are a triage model. You are fast." })
      .ask<Verdict>(`Is this question deep or shallow?\n${String(args.question ?? "")}`);
    return JSON.stringify({ tier: v.tier });
  },
  async (model) => {
    const answer = await agent("answerer", { system: "You answer precisely.", model })
      .ask<string>(String(args.question ?? ""));
    return answer;
  },
);

report(verdict);

return verdict;
