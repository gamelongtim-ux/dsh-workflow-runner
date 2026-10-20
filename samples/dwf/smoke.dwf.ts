// The smallest useful workflow: a phase, one subagent, one result.
//
// Everything else in samples/dwf/ is this plus one more idea.

interface Answer {
  /** The one-line answer. */
  text: string;
  /** 0-1, how sure the subagent is. */
  confidence: number;
}

phase("answer");

const answer = await agent("answerer", { system: "You answer precisely." })
  .ask<Answer>("What is the capital of Portugal?");

report(answer);

return answer;
