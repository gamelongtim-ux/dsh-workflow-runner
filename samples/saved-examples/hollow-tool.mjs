/** dsh-workflow
 * @name hollow-tool
 * @description Saved workflow demo: greet a user and let a hole decide the message format.
 * @whenToUse When you want the human to write a small JS function that shapes the final reply.
 * @arg name {string="world"} Who to greet
 * @arg styleOptions {json=["upper","lower","title"]} Style choices the human can pick from in the hole body
 */
'use strict';
const { phase, log, report, hole, args } = globalThis.__dsh;

export default async function main() {
  const name = String(args.name || 'world');
  const styles = Array.isArray(args.styleOptions) && args.styleOptions.length > 0
    ? args.styleOptions
    : ['upper', 'lower', 'title'];

  phase(`Park on a hole to pick a greeting style for "${name}"`);
  // The body the user fills in has access to `ctx` (the third arg) plus
  // the runtime facade. Body is eval'd as `async (ctx) => { ... }`.
  const message = await hole('pick-style', 'Return a greeting string.', { name, styles });

  phase('Done');
  log(`final message: ${message}`);
  report({ name, message, at: Date.now() }, 'result');
  return { name, message };
}
