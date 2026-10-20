// 一个「保存下来的工作流」：参数从 args 读，一次 LLM 问句出一段摘要。
//
// args 是环境声明里的一个只读记录，值都是 unknown，要自己收窄。
// phase 的名字必须是编译期字面量，所以摘要对象是带洞的这件事只能出现在提示词里。

/** dsh-workflow
 * @name summarize
 * @description Summarize a topic in 3 short paragraphs using a single LLM ask.
 * @whenToUse Quick prose summary of any topic; no need for tools or multi-step.
 * @arg topic {string="Hungarian algorithm"} The topic to summarize
 * @arg maxWords {number=120} Soft target for total word count
 */

const topic = String(args.topic ?? "").trim() || "Hungarian algorithm";
const maxWords = Number(args.maxWords) || 120;

phase("Summarize the topic");
const summary = await agent("summarizer", {
  system: "You are a senior algorithms instructor. Be precise, no filler.",
}).ask(`Write a summary of "${topic}" in 3 short paragraphs, no more than ${maxWords} words total.`);

log(`got ${summary.length} chars of summary`);
report({ topic, summary: summary.slice(0, 4000) });

phase("Done");
return { topic, charCount: summary.length };
