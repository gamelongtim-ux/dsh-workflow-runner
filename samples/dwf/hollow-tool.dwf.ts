// 一个「保存下来的工作流」：先跟人问好，再由一段留白决定这条问候长什么样。
//
// 留白的补全正文是一段 async 箭头函数，它在留白所在的词法作用域里求值——
// 所以 name 与 styles 它都直接看得见，不必再传一个 ctx。

/** dsh-workflow
 * @name hollow-tool
 * @description Saved workflow demo: greet a user and let a hole decide the message format.
 * @whenToUse When you want the human to write a small JS function that shapes the final reply.
 * @arg name {string="world"} Who to greet
 * @arg styleOptions {json=["upper","lower","title"]} Style choices the human can pick from in the hole body
 */

const name = String(args.name ?? "").trim() || "world";
const styles: string[] = Array.isArray(args.styleOptions)
  ? args.styleOptions.map((s) => String(s))
  : ["upper", "lower", "title"];

phase("Park on a hole to pick a greeting style");

// 类型实参是这份契约：补全写出来的正文要按它检查，所以它必须显式写出。
// 提示里把决策需要的东西说清楚——name 与 styles 在补全的词法作用域里。
const message = await hole<string>(
  "pick-style",
  `Return a greeting string for "${name}". Pick one of these styles: ${styles.join(", ")}.`,
);

phase("Report the greeting");
log(`final message: ${message}`);
report({ name, message, styles });

// 门：把问候交给 shell 读回来，验证它不是空的。
const gate = await world.run(
  "node",
  ["-e", "process.stdout.write(String(process.argv[1].length))", message],
  { timeoutMs: 5000 },
);
log(`the greeting is ${gate.stdout.trim()} chars`);

return { name, message };
