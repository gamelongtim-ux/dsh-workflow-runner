// Plan, then critique, then revise — with a FRESH reviewer.
//
// The reviewer is a different agent with a different system prompt and no
// access to the planner's reasoning. A reviewer that shares the author's
// context inherits its blind spots; and the prompt asks for what is wrong,
// not for approval, because "is this good?" gets a yes.

interface Plan {
  /** One line: what the plan does. */
  summary: string;
  /** The steps, in order. */
  steps: string[];
}

interface Critique {
  /** What is wrong with the plan. */
  objections: string[];
  /** Is the plan good enough to ship? */
  acceptable: boolean;
}

phase("plan");

const plan = await agent("planner", { system: "You plan software work." })
  .ask<Plan>("Plan how to make this repository's test suite deterministic.");

phase("critique");

const critique = await agent("critic", { system: "You are a skeptic. You look for what is wrong, not for what is right." })
  .ask<Critique>(`Here is a plan:\n${JSON.stringify(plan)}\n\nWhat is wrong with it?`);

phase("revise");

// A DIFFERENT name: an actor name is an identity, unique within the run. It
// is also the key an amended re-run matches its cached work against, so a
// repeated name would make that match ambiguous.
const final = critique.acceptable
  ? plan
  : await agent("reviser", { system: "You plan software work. You take objections seriously." })
      .ask<Plan>(`Revise this plan, taking these objections seriously:\n${critique.objections.join("\n")}\n\nOriginal plan:\n${JSON.stringify(plan)}`);

report({ final, critique });

return { final, critique };
