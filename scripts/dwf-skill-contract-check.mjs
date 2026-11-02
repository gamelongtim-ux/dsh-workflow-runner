// A workflow written against the SKILL's own contract.
//
// The skill says:
//   - "A `phase()` marker is required, and it must be a literal string."
//   - "Every phase contains at least one `ask` or `world.run`."
//   - "T is an interface you declare in the same file ... The doc comments
//     on T are not decoration. They become the field descriptions the
//     subagent actually reads."
//   - "A name is also a cache key."
//   - "Every `agent()` call starts a new, empty conversation."
//   - "The script `return`s the run's result."
//
// So this uses a declared interface with per-field doc comments, unique
// agent names, one phase per ask, and a return value.

const base = process.argv[2];
const hdr = {
  Accept: 'application/json',
  Referer: `${base}/workflow/`,
  Origin: base,
  'Content-Type': 'application/json',
};

const script = `
interface Haiku {
  /** The three lines of the haiku, without trailing newlines. */
  lines: string[];
  /** The season the haiku is about. */
  season: string;
}

interface Critique {
  /** The single strongest weakness, in one short phrase. */
  weakness: string;
  /** How much the haiku improves after fixing it, 0-1. */
  confidence: number;
}

phase("draft");
const haiku = await agent("poet", {
  system: "You write haiku. Three lines, nothing else.",
}).ask<Haiku>("Write a haiku about autumn. The season is autumn.");

phase("critique");
const critique = await agent("critic", {
  system: "You are terse. One short phrase, then a number.",
}).ask<Critique>("Name the strongest weakness of this haiku: " + haiku.lines.join(" / "));

report({ haiku, critique });
return { haiku, critique };
`;

const r = await (await fetch(`${base}/workflow/api/engine/run`, {
  method: 'POST', headers: hdr, body: JSON.stringify({ scriptText: script }),
})).json();
console.log('  the run:', r.runId, r.status);

for (let i = 0; i < 25; i++) {
  await new Promise((x) => setTimeout(x, 3000));
  const s = await (await fetch(`${base}/workflow/api/state?runId=${r.runId}`, { headers: hdr })).json();
  if (['completed', 'error', 'stopped'].includes(s.status)) {
    console.log('  settled:', s.status);
    if (s.error ?? s.engine?.error) {
      console.log('  the error:', JSON.stringify(s.error ?? s.engine?.error).slice(0, 400));
    }
    console.log('  the artifact:');
    console.log('  ' + JSON.stringify(s.engine?.settlement?.artifact, null, 2).replace(/\n/g, '\n  '));
    console.log('  the report:');
    console.log('  ' + JSON.stringify(s.engine?.settlement?.report?.items ?? s.reports?.[0]?.item, null, 2).replace(/\n/g, '\n  '));
    break;
  }
}
