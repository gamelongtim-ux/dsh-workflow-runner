// A typed scan: the schema comes from the type argument, and the doc
// comments on the fields are what the subagent actually reads.
//
// The interface is declared HERE, in the same file, with a plain `interface`
// declaration — the script is compiled inside a function body, where
// `declare` is not allowed.

interface Finding {
  /** The file the problem is in. */
  path: string;
  /** The line number, 1-based. */
  line: number;
  /** What is wrong there, in one sentence. */
  problem: string;
  /** 0-1, how confident the scan is about this one. */
  confidence: number;
}

interface Summary {
  /** How many findings there are in total. */
  count: number;
  /** The finding you would fix first, and why. */
  worst: string;
}

phase("scan");

const findings = await agent("scanner", { system: "You find real problems in code." })
  .ask<Finding[]>("Find the problems in this repository. Report at most five.");

phase("judge");

const summary = await agent("judge", { system: "You triage. You are terse." })
  .ask<Summary>(`Triage these findings and say which one to fix first:\n${JSON.stringify(findings)}`);

report({ summary, findings });

return { summary, findings };
