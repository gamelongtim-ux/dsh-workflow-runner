/** dsh-workflow
 * @name summarize
 * @description Summarize a topic in 3 short paragraphs using a single LLM ask.
 * @whenToUse Quick prose summary of any topic; no need for tools or multi-step.
 * @arg topic {string="Hungarian algorithm"} The topic to summarize
 * @arg maxWords {number=120} Soft target for total word count
 */
'use strict';
const { agent, phase, log, report, args } = globalThis.__dsh;

export default async function main() {
  const topic = String(args.topic || 'Hungarian algorithm');
  const maxWords = Number(args.maxWords) || 120;

  phase(`Summarize "${topic}"`);
  const summary = await agent('summarizer', {
    system: 'You are a senior algorithms instructor. Be precise, no filler.',
  }).ask(`Write a summary of "${topic}" in 3 short paragraphs, no more than ${maxWords} words total.`);

  // Normalize: agent.ask may return {content, usage} or a string.
  const text = typeof summary === 'string' ? summary : (summary && summary.content) || '';
  log(`got ${text.length} chars of summary`);
  report({ topic, summary: text.slice(0, 4000) }, 'summary');

  phase('Done');
  return { topic, charCount: text.length };
}
