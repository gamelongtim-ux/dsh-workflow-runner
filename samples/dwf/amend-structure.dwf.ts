// AmendWorkflow 的缓存复用：不需要 LLM，全程 world.run。
//
// 两次 run 的做法：
//
//   1. 跑一遍这个文件 → runId A。三条 shell 命令，全部 live。
//
//   2. 改这个文件——下面那行标记带一个计数器。把 MARKER 从 'v1' 改成 'v2'。
//      任何字节变化都算数；运行时比的是这个文件的 SHA-256。
//
//   3. 再跑一遍，amendFrom 指向 A → runId B。
//      B 的日志里应当看到：
//        amend from A: chain depth 1, source journal has 3 entries
//                        — cache OPEN until this run's first live action
//        world.run(...): amend replay from A        ×2
//        world.run(...): <no replay>                 ×1   ← 标记改了
//        amend cache closed (this run executed a live action)
//
//      B 的 journal 里能看出这个分界：两条 live: false, fromRun: A，一条 live: true。
//
//   4. 不再改文件、重复第 3 步 → HTTP 400 `AMEND_NO_CHANGE`。
//      这是故意的：重放一个字节相同的脚本要花掉一整次 run，却什么也没换到。

artifact.table("stages", {
  title: "三步 world.run 的输出",
  columns: [
    { field: "stage", label: "Stage" },
    { field: "stdout", label: "Stdout" },
  ],
});

// --- 两次 run 之间改这里（v1 → v2）-------------------------------------------
const MARKER = "v3";
// ---------------------------------------------------------------------------

phase("Stage 1 · echo");
const a = await world.run("node", ["-e", 'process.stdout.write("one")'], { timeoutMs: 5000 });
report({ marker: MARKER, stage: 1, stdout: a.stdout }, "stages");

phase("Stage 2 · echo (unchanged between runs)");
const b = await world.run("node", ["-e", 'process.stdout.write("two")'], { timeoutMs: 5000 });
report({ marker: MARKER, stage: 2, stdout: b.stdout }, "stages");

phase("Stage 3 · marker (this is the one you edit)");
const c = await world.run(
  "node",
  ["-e", "process.stdout.write(process.argv[1])", MARKER],
  { timeoutMs: 5000 },
);
report({ marker: MARKER, stage: 3, stdout: c.stdout }, "stages");

phase("Done");
log(`amend-structure finished with marker=${MARKER}`);
return { marker: MARKER, outs: [a.stdout, b.stdout, c.stdout] };
