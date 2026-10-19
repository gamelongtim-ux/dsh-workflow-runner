# dsh-workflow-runner

<p align="right">
  <a href="README.md">🇬🇧 English</a> · <a href="README.zh-CN.md">🇨🇳 中文</a>
</p>

把 ZCode 风格的 **dynamic-workflows** 语义搬进 [dsh][dsh] Web UI。
写一小段 JS workflow 脚本,使用顶层 await 友好的 facade
(`phase` / `log` / `report` / `agent(name).ask(prompt)` / `world.run(cmd, args)`),
插件把它跑在隔离的 Node 子进程里,实时把进度广播到聊天输入区按钮、每轮尾巴卡片和浮动监控点上。

[dsh]: https://github.com/deepseek-ai/dsh

> **目标宿主**:dsh **桌面版** profile,**V0.2.0-rc.2** 及以上版本。
> 与 [`dsh-agent-teams`][dteams] 完全独立 —— 不依赖它,不与之协作,卸了它本插件照常工作。
[dteams]: https://www.npmjs.com/package/@nanmicoder/dsh-agent-teams

## 你会拿到

- **三个 UI slot**(通过 cordis 注册):
  - `conversation.composer.dock` —— `▶ Workflow` 按钮(点击在新窗口打开编辑器)
  - `conversation.chat.turnTail` —— 每轮 assistant 尾巴下的被动监控卡
  - `shell.overlay` —— 运行中时右上角的浮动小点

- **standalone Web 应用**(`/workflow/` 路径),含:
  - 脚本选择器(三个样本)、文件路径、源码预览
  - `▶ Run` / `◼ Stop` 按钮
  - 实时 phase 进度、子代理活动、报告列表、事件日志

- **服务端运行时**:spawn 用户脚本为 Node 子进程,stdin/stdout 上跑 JSON-RPC,使用与 dsh `balance` 同样的 key 解析路径调 DeepSeek chat-completion,跑 shell 命令并有可控超时。

## 安装

把插件按 dsh bundle 标准装入。从 dsh 宿主(它跑在 WSL)执行,**desktop** profile:

```bash
dsh plugin --profile desktop add dsh-workflow-runner
```

这会装 npm 上的正式发布版。想跟这个仓库的最新 `main`:

```bash
git clone https://github.com/gamelongtim-ux/dsh-workflow-runner.git
cd dsh-workflow-runner
dsh plugin --profile desktop add file:"$PWD"
```

然后重启 `dsh web`。聊天输入区里能看到 `▶ Workflow` 按钮。

要求 **dsh 0.2.0-rc.2 及以上**——已声明为 `engines.dsh`,插件市场能据此显示宿主版本要求,而不是"未声明"。

> 📌 如果同版本 pnpm `add file:` 不重新拷贝(pnpm 12 的怪行为),改 `package.json` 里的 `version`,或者直接用 `update.cmd`。

## 把这个插件给其他 dsh 用户用

下游 dsh 用户在"添加插件"对话框里有三种装入路径,看你打算怎么分发来选:

| 路径 | 在 dsh "添加插件"对话框里粘贴 | 备注 |
| --- | --- | --- |
| **npm 包名** *(默认)* | `dsh-workflow-runner` | 自 **0.1.5** 起已发到 npmjs.org。国内走镜像源更快,且能锁版本 |
| **GitHub URL** | `https://github.com/gamelongtim-ux/dsh-workflow-runner` | 永远可用;拉的是最新 `main` HEAD,而不是已发布版本 |
| **本地路径** | `<本地 clone 的绝对路径>` | 想跟你的本地编辑同步改;搭配 `update.cmd` |

> dsh 桌面"添加插件"对话框里的"中国大陆镜像源"是**读端加速**;包本身还得能经 npmjs.org(或 GitHub)拿到。

### 版本兼容性

npm manifest 里用 `engines.dsh` 声明宿主版本要求,dsh 插件市场读这个字段(以及 lockstep 的 `@deepseek-ai/dsh-*` peer)来标注卡片是"兼容"还是"不兼容"。`dsh.compatibility.dshReleases` 也一并声明,作为面向作者的元数据。dsh 自身在加载时**只强制检查 `peerDependencies`**,所以本包刻意**不**声明任何 `@deepseek-ai/dsh-*` peer:它只需要 base bundle 提供的挂载点与服务,声明宿主 peer 范围反而可能误拒一个实际可用的宿主。

## 独立运行(不需要 dsh)

测脚本很好用:

```bash
node lib/standalone.js          # 监听 127.0.0.1:7910
```

浏览器开 <http://127.0.0.1:7910/>,选个样本即可。

## 写一个 workflow

脚本是 **ES module** (`.mjs`),默认导出 `async function main()`:

```js
'use strict';
const { agent, world, phase, log, report } = globalThis.__dsh;

export default async function main() {
  phase('Plan');
  const draft = await agent('planner', {
    system: 'You are a senior algorithm textbook author.',
  }).ask('用三段话解释匈牙利算法');

  phase('Critique');
  const issues = await agent('critic', {
    system: '列出 3 个最关键遗漏,每个 ≤25 字。',
  }).ask(draft);

  phase('Gate');
  const wc = await world.run('node', ['-e',
    'process.stdout.write(String(arguments[0].split(/\\s+/).filter(Boolean).length))',
    '--', draft,
  ], { timeoutMs: 5000 });
  if (wc.exitCode !== 0) log('gate 警告 exit=' + wc.exitCode, 'warn');

  report({ draft, issues, wordCount: Number(wc.stdout) }, 'final');
  phase('Done');
  return { ok: true };
}
```

### Facade 参考

| 调用 | 返回 | 备注 |
| --- | --- | --- |
| `phase(name)` | `Promise<{ok:true}>` | 标记一个 phase。同名 phase 在循环里折叠成一个 UI pill,带 `× N` 角标 |
| `log(message, level='info')` | `Promise<{ok:true}>` | 流到事件日志。`level` ∈ `info`, `warn`, `error`, `debug` |
| `report(item, tag=null)` | `Promise<{ok, artifactId?}>` | 在 Reports 面板露出结构化项。若 `tag` 匹配 chart/table/metrics/board artifact 的 id,该项会同时进入那个 artifact 的数据流 |
| `agent(name, opts).ask(prompt)` | `Promise<{content, usage}>` | 按名创建(或复用)子代理;同名复用保留历史。`opts` ∈ `{system, model, temperature, maxTokens}` |
| `agent(name).close()` | `Promise<{closed:true}>` | (可选)提示;历史随 run 结束释放 |
| `world.run(cmd, args, opts)` | `Promise<{exitCode, signal, stdout, stderr, durationMs}>` | spawn 本地 shell 命令。**非零退出码是值,不抛异常**。运行时拒绝不在本 run 白名单里的 `cmd`。`opts.cwd / env / timeoutMs` 可配 |
| `artifact.chart(id, spec)` | `Promise<{ok}>` | 声明一个 chart preset,由 `report(item, id)` 喂数据。`spec ∈ {x, y, type, baseline, title}` |
| `artifact.table(id, spec)` | `Promise<{ok}>` | 声明一个 table。`spec ∈ {columns, key?}` |
| `artifact.metrics(id, spec)` | `Promise<{ok}>` | 声明一行大数字 tile。`spec ∈ {metrics: [{field,label,unit?},…]}` |
| `artifact.board(id, spec)` | `Promise<{ok}>` | 声明一个 kanban 看板。`spec ∈ {key, status, columns, cardTitle?, detail?}` |
| `artifact.markdown(id, content, opts)` | `Promise<{id, version}>` | 发布 markdown 文本(256 KB 上限)。`opts ∈ {title, description, primary}` |
| `artifact.file(id, path, opts)` | `Promise<{id, version}>` | 发布工作区文件(仅文本,20 MB 上限)。`opts ∈ {title, description, primary}` |
| `args` | `Readonly<Record<string, unknown>>` | `POST /api/run` body 的 `args: object` 传入,64 KB 上限,顶层 frozen |
| `files.glob(pattern)` | `Promise<string[]>` | 匹配 glob 的工作区相对路径。沙箱 = `workspaceRoot`(每 run)。2000 文件上限。支持 `**` / `*` / `?` / `[abc]` |
| `files.read(path)` | `Promise<string>` | 读工作区相对文件,UTF-8,256 KB 上限 |
| `files.grep(pattern, glob?)` | `Promise<{path,line,text}[]>` | 工作区正则匹配(可选 glob 限定范围)。2000 行 / 256 KB 上限 |
| `git.changedFiles(base?)` | `Promise<string[]>` | `git diff --name-only <base>`,无 base 时是 uncommitted + untracked。不在 git repo catchable reject |
| `git.diff(base?, path?)` | `Promise<string>` | `git diff <base> -- <path>`。512 KB 上限 |
| `git.status()` | `Promise<{branch,clean,staged,unstaged,untracked}>` | `git status --porcelain --branch` 解析结果 |
| `git.log(count?)` | `Promise<{hash,subject,author,date}[]>` | `git log -n<count>`,默认 20,最多 100 |
| `channel<T>(name?)` | `{ send, close, [Symbol.asyncIterator] }` | in-process FIFO + async 迭代。发送方在 `finally` 里 close。close 后 send 抛 `ChannelClosed` |
| `future<T>(body)` | `Promise<T>` | 下个 microtask 启动 body,返回其 promise。`Promise.all([future(a), future(b)])` 并行 |
| `model(id)` | `{ __modelRef, id }` | 传给 `agent(name, { model })`。host 校验 id 在 `modelsAllowed`(默认 `['deepseek-chat']`,Config 可改) |
| `agent.ask(prompt, { result: <shape> })` | 解析后的对象(或 throw) | v0.4.0。shape 用小语法:`'string'\|'number'\|'boolean'` 是基本类型;`['string']` 是数组;`[{...}]` 是对象数组;`{ key: <shape>, ... }` 是嵌套对象(所有 key 必填);`null` 是任意。host 生成 JSON Schema,用 DeepSeek 的 `response_format: json_object`,解析+校验,失败重试 1 次。不传 `result` 时行为完全不变 |
| `askUser(question, opts?)` | `Promise<string \| boolean>` | v0.4.0。脚本卡住等用户答。`opts.kind: 'confirm'` 返 bool;`opts.options: string[]` 返其中一个;不传 options 走自由文本。5 分钟 host watchdog |
| `hole(name, prompt, ctx?, body?)` | `Promise<any>` | v0.5.0。中途代码注入。三种 form:unfilled (`hole(name, prompt, ctx)` body 从 `/api/hole-answer` 来);filled with ctx (`hole(name, prompt, ctx, bodyFn)`);filled no ctx (`hole(name, prompt, bodyFn)`)。body 字符串被 `new AsyncFunction('ctx', body)(ctx)` 跑;能访问 `ctx` 和 `globalThis.__dsh.*`。10 分钟 watchdog |
| `escalate(question, opts?)` | `Promise<string \| boolean>` | v0.6.0。"问主代理"带 Think via LLM。跟 askUser 同 parked-RPC 形状,但编辑器多一个 🧠 Think via LLM 按钮,会发 LLM 调用(用 run context:最近 log + question + options)拿回答。`kind:'confirm'` 返 bool;`options:[...]` 返其一。5 分钟 watchdog |
| `__dsh.models` | `string[]` | v0.6.0。本 run 允许的 model id 列表,等价 ZCode `ListModels` 工具。从 host 的 `modelsAllowed` 来 |
| `t.string` / `t.number` / `t.boolean` / `t.array(item)` / `t.optional(s)` | shape 片段 | v0.6.0。`ask<T>` result shape 的语法糖。跟字符串字面量字面等价,host 早能识别;常量在 JSDoc 里读起来更顺 |
| `shape(s)` | = `s` | v0.6.0。等价透传,`result: shape({title: t.string})` 跟 `result: {title: 'string'}` 完全一样 |
| `route(MODELS, routerFn, answererFn)` | `Promise<any>` | v0.6.0。一行多 model 路由。跑 `routerFn(MODELS.light)` 选 tier,再跑 `answererFn(MODELS[tier])` 拿答。解析 router 的 `{"tier":"light"\|"strong"}`;解析失败 fallback 'light' |

> 第一个参数 `agent(name, opts)` 可只写 `agent('planner')`;`opts` 可省。

## 样本

`samples/` 里有十份:

| 文件 | 模式 |
| --- | --- |
| `smoke.mjs` | phase + log + world.run + report —— 不调 LLM,可无 key 跑通 |
| `planner-critic.mjs` | `planner` → `critic` → `planner` 同名复用带 critique 的修订 |
| `fanout-summarize.mjs` | 三个并行 `summarizer-N`,再 `reducer` 汇总成 cheatsheet |
| `artifact-demo.mjs` | 声明 chart + metrics + board,跑三轮 `world.run`,用 `report(item, 'latency')` 喂图,最后 `artifact.markdown` 出主产物。不需 API key |
| `confirm-demo.mjs` | 用三种不同命令(`node` / `git` / `powershell`)调 `world.run`,可以观察确认弹窗和按 run 的 allowlist 表现 |
| `loop-phases.mjs` | `for (i=0; i<5; i++) phase("check")`,展示 phase 折叠:UI 上只看到一个 `check × 5` 的 pill |
| `file-grep.mjs` | `files.grep('TODO', '**/*.mjs')` × 3 关键词,渲染 per-file table + markdown 摘要。不需 API key |
| `git-changed.mjs` | `git.status` + `git.changedFiles` + `git.log` + `git.diff` 渲染成一份 markdown;不在 git repo 时优雅降级 |
| `channel-pipeline.mjs` | 3 个 producer `future` → `channel('facts')` → 2 个 verifier `future`。用 `world.run('node', …)` 假数据,不需 API key |
| `model-router.mjs` | 轻量路由判定每题 tier(light/strong),答复者用对应 `model()`。keyless 环境下 LLM 调用会报错,路由结构本身对 |
| `typed-plan.mjs` | `agent.ask(prompt, { result: <shape> })` 返解析后的 plan 对象,脚本直接用 `plan.paragraphs[0]`。需 LLM key |
| `ask-user.mjs` | 三次 `askUser()` 串行:三选一、confirm、自由文本。不需 API key |
| `hole-demo.mjs` | 先 `askUser` 选一个 threshold,然后 `await hole(name, prompt, ctx)` 卡住;body 字符串通过 `POST /api/hole-answer` 提交,提交什么就 unblock 什么。不需 LLM |
| `amend-demo.mjs` | 三个固定 `agent.ask`。跑两遍,第二遍 `amendFrom: <第一遍 runId>` 复用前一遍 journal,LLM 不再调 |
| `models-list.mjs` | 列 `__dsh.models` + 出 table artifact。不需 LLM |
| `route-demo.mjs` | 两道题走 `route(MODELS, router, answerer)`,answerer 拿到对应 tier。需 LLM |
| `escalate-demo.mjs` | 三次顺序 `escalate()`:选项 / confirm / 自由文本。每次都能用户答或 Think-via-LLM |
| `typed-minimal.ts` + `typed-shapes.ts` | **TypeScript** 烟雾样本 —— phase / log / report / world.run,带跨文件 `import type` 和 `interface` 类型声明。不需 API key;需 `typescript` dev dep(见下文 [TypeScript 工作流](#typescript-工作流)) |
| `samples/saved-examples/summarize.mjs` | 带 JSDoc frontmatter 的 saved workflow 例子(`@name` / `@description` / `@whenToUse` / `@arg topic {string=...}`)。复制到 `~/.dsh/workflows/` 即可在编辑器里看到 |
| `samples/saved-examples/scan-todos.mjs` | 同上,用 `files.grep` 扫,出 table + markdown artifact |

## TypeScript 工作流

v0.7.1 起可选支持 **TypeScript**。扩展名是 `.ts`(或 `.mts`)的 workflow 在启动子进程前会用本地 `typescript` 包的 `tsc` CLI 编译成 ESM `.js` 到 per-run tmp 目录。子进程看到的还是纯 ESM;类型与 type-only import 全部被擦除。

### 静态类型检查(v0.8.0)

每个 `.ts` workflow 还会**对 `lib/facade.d.ts` 跑类型检查**——一个镜像 ZCode dynamic-workflows §16.2 契约的 ambient 声明。在 emit 之前,`tsc --noEmit --strict` 会在 per-run tmpdir 跑一次;类型错误以 HTTP 400 + 结构化 `diagnostics` 数组拒掉这次 run,**不会**进 spawn 阶段。

facade 声明了用户脚本能调的一切:

```ts
declare const phase: (name: string) => void;
declare const log: (message: string, level?: 'info'|'warn'|'error') => void;
declare const report: (item: unknown, artifactId?: string) => void;
declare const agent: (name?: string, persona?: string | AgentPersona) => Agent;
declare const world: { run(cmd: string, args?: string[], opts?: { timeoutMs?: number }): Promise<WorldRunResult> };
declare const files: { glob(...): Promise<string[]>; read(...): Promise<string>; grep(...): Promise<GrepMatch[]> };
declare const git: { changedFiles(...): Promise<string[]>; diff(...): Promise<string>; status(): Promise<GitStatus>; log(...): Promise<GitCommit[]> };
declare const channel: <T>(name?: string) => Channel<T>;
declare const future: <T>(body: () => Promise<T>) => Promise<T>;
declare const model: (id: string) => ModelRef;
declare const hole: <T>(name: string, prompt?: string) => Promise<T>;
declare const askUser: (q: string, opts?: ...) => Promise<string>;
declare const escalate: (q: string, opts?: ...) => Promise<string>;
declare const artifact: { file(...); markdown(...); chart(...); table(...); metrics(...); board(...) };
// ... 还有所有支撑接口
```

用户脚本可以 ambient 直接用(`phase('Plan')`),也可以走 bootstrap 在运行时挂的 `globalThis.__dsh` 命名空间。两种风格都能用,都过同一份 facade。

### 跳过类型检查

按 run 跳过:`/api/run` payload 带 `typecheck: false`。runtime 仍然 emit 时用 `--strict`,只是跳过专门的 typecheck 预跑。

按部署跳过:在 dsh **Settings → Plugins → dsh-workflow-runner** 里把 **typecheck.strict** 取消勾。脚本里满是 `as any` 又不想改的时候有用。

### 安装

```bash
npm install --save-dev typescript
```

够了。`dsh-workflow-runner` 用 `createRequire(import.meta.url)` 自己解析 `typescript/bin/tsc`,不依赖全局 PATH。

### 能写的

- `import type { ... } from './local-shapes'` —— 跨文件 type-only import 可用,tsc 会擦除
- 本地 `interface` / `type` 声明 —— 也被擦除,运行时无开销
- 任何能编译到 ES2022 ESM 的 TS 语法(`async`/`await` / `Promise.all` / `for await` / `?.` 等)

### 暂时不支持

- 每个脚本自定义 tsconfig.json —— 宿主用一套固定参数
  (`--target es2022 --module esnext --moduleResolution bundler --skipLibCheck --esModuleInterop --strict`)。要自定义选项,请手动编译后指向 `.mjs`
- npm 外部包 —— 只有本地同级 `.ts`/`.mts` 会被拷进编译目录。`node_modules` 里的包在子进程加载时按 Node 默认解析,照常可用
- `tsx` / `esbuild` / 其它 runner —— 只接了 `tsc`

### 编译流水线

1. `WorkflowRuntime.start()` 检测 `.ts` 后缀,调 `_transpileTs(absScript)`
2. 在 `os.tmpdir()/dsh-workflow-ts/run-XXXXXX/` 开一个新 tmp 目录,塞一个 `{"type":"module"}` 的小 `package.json`(让编译产物 `.js` 被当作 ESM 加载)
3. 入口文件 + 源目录同级所有 `.ts`/`.mts` 全部 copy 到 tmp
4. 用 `cwd: tmpDir` + `--rootDir tmpDir` 跑 tsc,产物平铺在 `<tmpDir>/<entry>.js`
5. 用编译产物 spawn 子进程;原 `.ts` 路径保留在 `state.scriptPath`,`/api/runs` UI 看到的是用户写的那份(不是已被清掉的 tmp 文件)
6. run 落到终止态(`completed` / `error` / `stopped`)时,`#setStatus` 调 cleanup 回调把 tmp 目录删掉

### 失败模式

| `code` | 原因 |
| --- | --- |
| `TS_MISSING_DEP` | 没装 `typescript`,`npm install --save-dev typescript` |
| `TS_COMPILE_FAIL` | `tsc` 退出非零,完整 stderr/stdout 会嵌进 thrown error |
| `TS_COMPILE_TIMEOUT` | 编译超过 30 秒(小脚本基本碰不到;大项目要调 `lib/runtime.js` 里的常量) |

### 示例

```ts
// typed-minimal.ts
import type { WorldRunResult } from './typed-shapes';

const { phase, log, report, world } = globalThis.__dsh as any;

export default async function main() {
  phase('Typed: world.run echoes');
  const echo: WorldRunResult = await world.run(
    'node', ['-e', 'process.stdout.write("hello\\n")'], { timeoutMs: 5000 }
  );
  report({ echo: echo.stdout.trim() }, 'echo');
}
```

## Saved workflows(保存的工作流)

插件读写 `~/.dsh/workflows/<name>.mjs`(Config `workflowsDir` 可覆盖)。每个文件是 workflow + JSDoc 风格 frontmatter:

```js
/** dsh-workflow
 * @name my-workflow
 * @description 一句话说明
 * @whenToUse 什么时候用
 * @arg topic {string="Hungarian algorithm"} 主题
 * @arg depth {number=2} 深度
 */
'use strict';
const { agent, args, ... } = globalThis.__dsh;
export default async function main() { ... }
```

编辑器"样例按钮"下面那一栏"Saved workflows"列出该目录全部,点击加载到编辑器,改完 "💾 Save…" 自动加 frontmatter 写回。

## 跑 snippet(无 run / 无 LLM)

`POST /api/eval` body `{ code, args?, timeoutMs?, worldRunAllowlist? }` 同步返 `{ status, log, result }`。Facade 裁到 `args, log, files, git, world.run, channel, future`,`agent / artifact.* / phase / report / model / askUser` 都没了,任何引用 throw。编辑器主编辑框下面那个 "Try a snippet" 折叠区就是它的薄壳:

```bash
curl -X POST http://127.0.0.1:7910/api/eval \
  -H 'content-type: application/json' \
  -d '{"code":"export default async function main() { log(\"hi\"); return 42; }"}'
```

## 跑一半问用户

脚本里 `await askUser('threshold?', { options: ['90','95','100'] })` 会让脚本挂起,编辑器里出 question card。用户选完,`POST /api/question-answer` 走通,脚本继续。流程:

```
子 → 主: { id, method:'question.ask', params:{ questionId, question, kind?, options? } }
主广播: { event:'question.asked', question:{...} }
[用户填表,编辑器 POST /api/question-answer]
POST /api/question-answer { runId, questionId, answer }
主写子 stdin: { id:<原 rpcId>, result:<answer> }
子 await askUser() 拿到 answer
```

每个 question 5 分钟 watchdog,UI 一直不答会 reject。

## 批准 shell 命令(确认弹窗)

脚本里任何 `world.run` 都是 workflow 想在你机器上 spawn 的 shell 命令。run 启动前,编辑器会扫脚本里所有 `world.run("name", …)`,去重后列在弹窗里:

- **勾上** → 运行时这次 run 允许 `cmd` 正好是这个名字的 `world.run`
- **不勾** → 任何 `world.run("X", …)`(`X` 在未勾选名单里)被运行时拒绝,错误是
  `world.run: command 'X' is not in the approved list for this run`,事件日志里能看到 `world.run.declined`

allowlist 是按 run 的,**不持久化**——每次 Run 都会再问一次。这是"安全优先"的默认:脚本中间新加了一个 `world.run` 调用点,下次 Run 那个新命令就会出现在弹窗里。

脚本里没出现 `world.run` 时直接跳过弹窗(避免噪音)。

## 沙箱(v0.9.0)

v0.9.0 加了**实际可用的 OS 级沙箱**,三层:

### 1. 环境变量脱敏
bootstrap child 在 spawn 之前过 `lib/runtime.js` 的 `_scrubChildEnv(allowlist, denylist, env)`。默认 allowlist 保留工具链必备(`PATH` / `HOME` / `LANG` / `USER` / `SHELL` / `TERM` 等)+ host 注入的全部 `DSH_WORKFLOW_*` 键。默认 denylist 匹配所有 LLM provider 的 API key、所有云厂商凭证前缀、所有 VCS token、所有动态链接劫持向量(`LD_PRELOAD` / `NODE_OPTIONS` / `DYLD_INSERT_LIBRARIES`)、还有 dsh 自家的 DSH 账本(`DSH_HOME` / `DSH_API_KEY` 等)。

run log 写明:
```
sandboxed env: kept 15 keys, stripped 5 sensitive keys (from 80 host keys) — DSH_API_KEY, DEEPSEEK_API_KEY, AWS_ACCESS_KEY_ID, LD_PRELOAD, NODE_OPTIONS
```

workflow 调 `world.run` 起的 shell child 也继承同一份脱敏 env,`node` / `git` / `npm` 调用一样被保护。

### 2. 路径越权检查
`files.glob` / `files.grep` / `git.diff` 现在以 `code: 'PATH_ESCAPE'` 拒掉 workspace 越权——`/etc/...` 或 `C:\…` 这种锚到 FS 根的 pattern、带 `..` 段的 pattern,在 walk 开始前就拦。`world.run` 的 `opts.cwd` 也会对照 `state.workspaceRoot` 检查。

### 3. 可配置 allow/deny
**Settings → Plugins → dsh-workflow-runner → sandbox**:
- `enabled`(默认 `true`)— 开 / 关脱敏
- `allowlist`— 额外保留的 env 键(在默认基础上加)
- `denylist`— 额外剥的 regex 模式(在默认基础上加)

按 run 覆盖:`sandbox: false` 直接关;sandbox: { allowlist: [...], denylist: [...] } 覆盖 Config。

### 范围之外
真正的 OS 级隔离——Windows Job Object / AppContainer / Linux cgroups+namespaces / macOS `sandbox-exec`——都是平台特定的,留给 v0.10.0+。v0.9.0 是 runtime 层跨平台能给的最强沙箱。

## 结构性 amend(v0.10.0)

`v0.10.0` 加上了 ZCode 的 `AmendWorkflow`:**向一个正在运行的 workflow 注入新 stage**。

这和 `amendFrom`(v0.5.0)是两回事。`amendFrom` 是拿上一轮的 journal 重跑一个
**已经跑完的** workflow,相同的 `agent.ask` / `world.run` 直接命中缓存。结构性
amend 动的是**运行中**的 run:不重启、不重放、不克隆,原计划照常往下跑,注入的
stage 跟它交错执行。

```bash
curl -X POST http://127.0.0.1:7910/api/amend \
  -H 'content-type: application/json' \
  -d '{
        "runId": "<正在运行中的 run>",
        "name": "review",
        "wait": true,
        "code": "async (ctx) => { return { phase: ctx.run.currentPhase }; }"
      }'
```

| 字段 | 含义 |
| --- | --- |
| `runId` | 必填,目标 run |
| `name` | 日志和 stage 列表里显示的名字 |
| `code` | 内联 body(见下面三种写法) |
| `codePath` | 从文件读 body,相对该 run 的 `workspaceRoot` 解析 |
| `context` | 额外塞进 stage `ctx` 的键 |
| `wait` | `true` 表示等 stage 跑完再返回 |
| `timeoutMs` | `wait: true` 的上限(最多 5 分钟) |

`GET /api/amend/stages?runId=…` 看列表。run 自己的 `/api/state` 里有
`injectedStages`,SSE 会推 `stage.injected` / `stage.started` / `stage.finished`。

### stage 跑在 run 里面

这才是重点。注入的 stage 在活的子进程里执行,所以它拿到的是**同一批 agent
handle**(也就带着同一个 agent 的对话历史),外加同一份 `world.run` 白名单、
同一份脱敏后的 env(v0.9.0)、同一套工作区路径约束。它跟脚本自己写的
`future()` 是同级关系,在每个 `await` 处交错。

所以它**不是**绕过沙箱的后门。stage 里读 `process.env` 看到的东西跟脚本完全
一样;`codePath` 走的是和 `files.*` 同一个 `#resolveInWorkspace`,越界直接
`PATH_ESCAPE`。

### body 的三种写法

按顺序尝试:

```js
// 1. `export default …` —— 独立 .mjs 文件的样子,
//    同一个文件既能当 sample 跑,也能当 stage 注入
export default async (ctx) => { return { ok: true }; };

// 2. 裸函数表达式 —— hole<T> 的写法
async (ctx) => { return { ok: true }; }

// 3. 裸语句块(里面可以 return)
const n = ctx.reports.length;
return { n };
```

开头的 `//` 和块注释会先剥掉,所以 stage 文件可以带文档头。样例见
`samples/amend-stage-snippet.mjs`。

### `ctx`

宿主在注入那一刻组装好:

```js
{
  stage:   { id, name, injectedAt, runId },
  run:     { runId, status, scriptPath, workspaceRoot, currentPhase,
             phases, phaseSummary, agents, models },
  args:    <该 run 的用户参数>,
  reports: [ … 最近 50 条 … ],
  artifacts: [ … id 列表 … ],
  previous: [ { id, name, result, endedAt } … ],  // 本轮里更早的 stage
  ...context,                                     // 调用方额外传的键
}
```

`previous` 就是让多次注入能层层递进的地方。

### 脚本侧

```js
if (globalThis.__dsh.stages) {
  await globalThis.__dsh.stages.await({ timeoutMs: 15000 });
  const all = await globalThis.__dsh.stages.list();
}
```

一般不用写。bootstrap 在发 `finished` 之前会自动 drain 还在跑的 stage,所以
「脚本快结束时才注入进来的 stage」也能跑完。

### 失败与上限

stage 抛异常只记成 `status: 'error'`,**run 继续跑**——注入是对原计划的修订,
不该有能力把 run 带走。body ≤ 64 KB,每个 run 最多 32 个 stage,同时最多 4 个
在跑。往已结束的 run、从磁盘恢复的 run、eval/snippet run 注入都返回 HTTP 409。

## amend 缓存(v0.11.0)

`amendFrom`(v0.5.0)是拿上一轮的 journal 重跑一个跑完的 workflow,没变过的部分
不花钱。`samples/amend-structure.mjs` 是不用 API key 的完整走查:跑一次,改
`MARKER` 那行,再带着 `amendFrom` 指向第一次的 runId 跑第二次。

```bash
curl -X POST http://127.0.0.1:7910/api/run -H 'content-type: application/json' \
  -d '{ "scriptPath": "<abs>/samples/amend-structure.mjs" }'
# 改完 MARKER 之后:
curl -X POST http://127.0.0.1:7910/api/run -H 'content-type: application/json' \
  -d '{ "scriptPath": "<abs>/samples/amend-structure.mjs", "amendFrom": "<runId>" }'
```

### 缓存生命周期

带 `amendFrom` 启动时缓存打开,在**本轮第一次 live 的 `world.run`** 之后关闭 ——
那是唯一可能把工作区改掉、从而让祖先的缓存结果失效的可缓存动作。

live 的 `agent.ask` **不**关缓存。LLM 调用不改工作区;在它上面关,等于改掉第一个
prompt 就把后面所有 ask 都逼成 live,正好毁掉 amend 存在的意义。
`Config.amend.autoCloseOnWrite: false` 可以恢复成永不关闭。

### `AMEND_NO_CHANGE`

从**字节完全相同**的脚本那一轮 amend 会被 HTTP 400 拒掉 —— 重放一个没改的脚本
要付一整轮的钱却什么也没省。要么改文件,要么去掉 `amendFrom`。另外两种拒绝:
`AMEND_NOT_FOUND`(源 run 不存在)和 `AMEND_CHAIN_TOO_DEEP`(超过
`Config.amend.maxChainDepth`,默认 10)。这三种都在 spawn 子进程**之前**判定,
所以被拒的 amend 不会留下孤儿进程。

### 链式

被 amend 过的 run 还能再被 amend。查找沿着 `amendFrom` 由近及远走,最多
`maxChainDepth` 层,每一层取**最后一个**匹配项。「后者为准」是关键:同一个 key
被改过两次时,要重放较新的那个答案,不是旧的。

### 什么算可复用

只有 `agent.ask`(key = `name` + 字节一致的 `prompt`)和 `world.run`
(key = `cmd` + 完全一致的 `args`)。`system` / `model` / `temperature` 故意
**不**进 key —— 改了这些就不该重放旧答案,应该重开一轮。

### 命中时会重建 agent 的历史

这条很重要,v0.11.0 之前是坏的。命中时除了返回值,还会把该 agent 的对话历史一起
重放,所以后面同一 agent 的 live ask 看到的上下文和原来那一轮一致。

没有这条,一轮「ask 1-3 命中重放、ask 4 走 live」的运行会把空白上下文发给 ask 4,
拿到不一样的答案 —— 不报错、不打日志,就是结果错了。
`samples/amend-demo.mjs`(一个 agent、四次连续 ask)正是这个形状。

### 看复演轨迹

```bash
curl 'http://127.0.0.1:7910/api/journal?runId=<runId>&limit=200'
```

每条都带 `live`(本轮真跑了) 和 `fromRun`(来自哪一轮祖先)。编辑器的 Progress
页签把它渲染成一个默认折叠的 **Journal replay trail**:live 是琥珀色,重放是灰色。
`/api/state?includeJournal=1` 可以内联同一份数组。journal 上限 5000 条,超出后
从最旧开始裁,裁掉的数量记在 `journalTrimmed`。

### `Config.amend`

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `autoCloseOnWrite` | `true` | 本轮第一次 live `world.run` 之后关缓存,`false` = 调试用。 |
| `maxChainDepth` | `10` | amend 最多往回查几层祖先。 |

## 并发、phase 与死锁(v0.12.0)

### `max_concurrency`

`Config.concurrency.maxConcurrent`(默认 **8**)是一个 run 里同时最多几个
`agent.ask` 在飞。超出的排队等空位,而不是一起打出去 —— 防止 50 路 fan-out
把 provider 冲垮。

```bash
# 单次 run 覆盖
curl -X POST http://127.0.0.1:7910/api/run -H 'content-type: application/json' \
  -d '{ "scriptPath": "<abs script>", "maxConcurrency": 2 }'
```

重放出来的答案(amend 缓存命中)在 provider 那边不花钱,所以它既不占槽位,
也不会让真的 ask 排在它后面。

脚本里要拿数字,问宿主 —— 只有宿主知道真实并发,脚本自己数「在飞的 ask」会把
还在排队的也算进去:

```js
const { limit, active, peak, waiting } = await __dsh.concurrency.stat();
```

`peak` 是同时打向 provider 的峰值,`waiting` 是当前排队的数量。

### phase 生命周期

`phase()` 现在带显式状态 —— `active` / `done` / `error`,宿主同时推
`phase.start` / `phase.complete` / `phase.cancel`,老的 `phase` 事件照发。
**没有新的 facade 调用**:生命周期是从你脚本里本来就有的 `phase()` 调用推出来的。

- 下一个 phase 开始时,上一个就完成。
- 再次进入**同名** phase(循环)保持 active,只把计数徽标 +1。
- run 正常结束 → 最后一个 phase 完成;run 报错或被停 → 最后一个 phase **被取消**
  —— 错误就发生在那里。

### channel 死锁

ZCode 的规矩是「channel deadlock 是 fail,不是 stall」。v0.12.0 把它变成真的:
run 以 `status: 'error'` + `exitCode: -1` 失败,而不是挂到 30 分钟 watchdog。

什么算死锁,值得说准:

- **不算**「close() 时还有 consumer 在等」—— 那是**正常**收尾路径。close() 就是
  producer 放走 consumer 的方式,`for await (const x of ch)` 靠 close 结束。
  把它当死锁会毁掉每一个正确的 pipeline。
- **算**「producer 已经没了、channel 从没 close、consumer 还阻塞在上面」——
  没人会再 send、也没人会再 close,consumer 永远醒不过来。

channel 会记下「还有可能往它 send 的 future scope」。这些 scope 全部 settle 之后
就不会再有新数据了,这时一个没 close 且有 consumer 阻塞的 channel 就是死锁。
阻塞的 consumer 会被唤醒,同时通知宿主,run 判失败。

失败样例见 `samples/channel-deadlock.mjs`,正确写法见
`samples/channel-pipeline.mjs`。

## 架构

```
┌────────────────────┐   stdio 行分隔 JSON     ┌──────────────────────────┐
│  用户 .mjs 脚本    │◀──── RPC + notify ─────▶│  Node 子进程             │
│  (subprocess)      │                          │   runner-bootstrap.mjs  │
└────────────────────┘                          └──────────┬───────────────┘
                                                            │
                                                            ▼
                                                  ┌──────────────────────┐
                                                  │  WorkflowRuntime      │
                                                  │  (cordis 宿主)        │
                                                  │                       │
                                                  │  - agent 状态表       │
                                                  │  - 通过 ctx 调 LLM    │
                                                  │  - shell 调度         │
                                                  │  - SSE 广播           │
                                                  └──────┬───────┬────────┘
                                                         │       │
                              ┌──────────────────────────┘       └───────────────────────────┐
                              ▼                                                                  ▼
                   ┌──────────────────┐                                              ┌──────────────────┐
                   │ webServer 路由   │                                              │ dsh 聊天 UI      │
                   │ /workflow/api/*  │  ─ SSE 事件流 ──▶  ┌────────────┐        │ (三个 slot:       │
                   │ /workflow/       │                    │  iframe     │       │ composer, turn-   │
                   └──────────────────┘                    │  editor +   │       │ tail, overlay)    │
                                                            │  viewer     │       └──────────────────┘
                                                            └────────────┘
```

LLM 子代理直接打 DeepSeek `/v1/chat/completions`,优先通过 `ctx.llm.resolveCallConfig(...)` 取,
回退到与 [`dsh-usage-dashboard` 的 balance 模块][usage-dash-balance] 完全一致的
`DEEPSEEK_API_KEY` / `$DSH_HOME/.credentials.yaml` 解析路径。

[usage-dash-balance]: https://github.com/gamelongtim-ux/dsh-usage-dashboard

## 排错

### "启用失败: dsh: warning: 1 entry did not activate dsh-workflow-runner (dsh-workflow-runner): failed to import"

在 **v0.1.3** 修复了——去掉了 `@deepseek-ai/schemastery` 这个 peer 依赖。dsh 的 cordis 加载器解析裸 import 时先在 bundle 自己的 `node_modules` 找,新装时 schemastery 提升到宿主 profile 不一定找得到。如果你装的是 v0.1.1 / v0.1.2,卸了重装 GitHub URL 那条,会拉到 v0.1.3,零三方依赖。

### 装完没看到 `▶ Workflow` 按钮

在 **v0.1.5** 修复了。根因是包里混进了一个多余的 `lib/package.json`:dsh 的 `dsh.client` 扫描从解析到的入口(`lib/plugin.js`)向上找最近的 manifest,命中了这个 shadow 文件,于是把客户端 bundle 路径算成 `lib/lib/client.js`——该文件不存在。浏览器半边就这样被**静默丢弃**(UI 上没有任何报错),而服务端半边照常工作(所以 `/workflow/api/*` 有响应、聊天区里却什么都没挂上)。如果你在 v0.1.4 或更早,从 npm 或 GitHub 重装到 v0.1.5;手动删掉那个 shadow 文件也有效。

其余情况按这个顺序排查:

1. **插件**页里有 `dsh-workflow-runner` 且**开关是开**的
2. 拨完开关后**重启 dsh**(`任务管理器` → `DeepSeek Harness.exe` → 结束任务 → 重开)。bundle 是在进程启动时加载,不是拨开关时。
3. 你在**新会话**里看(左下角 → 新会话),不是装插件之前打开的老会话
4. dsh 桌面版是 **V0.2.0-rc.2 或以上**——已声明为 `engines.dsh`;老版本可能没有 `conversation.composer.dock` 这个 slot

### 打开 `/workflow` 报 `ERR_TOO_MANY_REDIRECTS`

在 **v0.1.5** 修复了。`/workflow` 和 `/workflow/` 原本都 302 到 `/workflow/`,于是带斜杠那个自己跳自己,永远跳不完。修复后 `/workflow/` 直接返回 `index.html`,只有不带斜杠的 `/workflow` 会重定向。

### 页面能开,但 Load / Run / Stop 点了没反应

分两种情况,请先看 `runStatus` 那一行或弹窗提示:

**报了 `run failed: HTTP 401`,且表单里没有错误提示** —— 在 **v0.1.6** 修复。0.1.5 给 `/api/*` 加了防护,却把 `requestRejection()` 的两种拒绝当成了一回事。它们并不等价:

- **403** 是 Host/Origin fence 判定"跨站 / DNS rebinding",这是**真正挡住网页 drive-by 的那一层**,必须一律拒绝;
- **401** 表示 fence **已经通过**,只是请求没带 dsh 的浏览器会话 cookie。

编辑页是自挂的 `/workflow` 静态页,而 dsh 只在根路径 `/` 的 token 握手上才下发会话 cookie,所以这个页面永远拿不到 cookie。把 401 也当作拒绝,就等于让插件自己的界面永久不可用,而且**没有增加任何本地防护**——cookie 的签名密钥就在 `$DSH_HOME/.credentials.yaml` 里,本地进程本来就能自己签一个。如果你在 v0.1.5,请升级到 v0.1.6。

**报 404 / `not found` 或按钮完全没反应** —— 在 **v0.1.5** 修复。编辑页 `public/editor.js` 原本用根路径 `/api/*` 调接口,而在 dsh 下这些请求会打到 dsh 自己的 API 网关。现在接口基址从模块自身 URL 推导,所以 dsh 前缀路由和独立模式(站点根)都能用。

### `▶ Workflow` 打开后显示的是 dsh 登录页

那是**宿主自己的鉴权**,不是本插件的问题:dsh 把每个页面都放在进程启动令牌之后。请打开宿主启动时打印的那个带 `?token=…` 的网址,让壳子先拿到会话 cookie,然后从应用内的 `▶ Workflow` 按钮进入,不要用手写的裸地址。

### "Lockfile failed supply-chain policy check" / `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`

**不是本插件本身的问题**——pnpm 验 lockfile 时**整个 profile 的所有条目**都过 `minimumReleaseAge`,刚发的包(默认窗口 24h)直接拒。错误信息里点名的那个包(比如 `dsh-workbuddy-connect@0.7.5 was published at 2026-10-14T17:23Z`)才是元凶。

> **v0.13.0 起**本插件有一个三方运行时依赖:`typescript`(vendor 进来的 ZCode 引擎在运行时 import 它)。它发布已久,不会被年龄策略拦;但手动拷贝安装时必须一起带上,见下面的命令。

两条路:

- **等**那个包超过策略窗口(通常 1-3 天)再重试
- **绕过 pnpm** 直接拷:

  ```powershell
  $D = "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-workflow-runner"
  $S = "D:\ZcodeStorage\.zcode\workspace\default\dsh-workflow-runner"
  New-Item -ItemType Directory -Force -Path $D | Out-Null
  New-Item -ItemType Directory -Force -Path "$D\node_modules" | Out-Null
  Copy-Item "$S\lib","$S\public","$S\samples","$S\packages","$S\package.json","$S\cordis.patch.yml" `
           -Recurse -Force -Destination $D
  # typescript 是 vendor 进来的引擎的运行时依赖,它自己没有任何依赖,拷这一个包就够
  Copy-Item "$S\node_modules\typescript" -Recurse -Force -Destination "$D\node_modules"
  ```

  拷完**重启 dsh**。如果"插件"页还是没出现,手填 `~/.dsh/profiles/desktop/cordis.patch.yml`:

  ```yaml
  - insert:
      - id: dsh-workflow-runner
        name: dsh-workflow-runner
        config: { path: /workflow }
  ```

## 显式不做

- TypeScript 类型检查 —— 只用 JS + JSDoc(v0.6.0 加了 `t` + `shape()` 让 shape 写起来更顺,真要编译期类型检查得加 build 步骤。v0.7.0 想加 `tsc` 编译 `.ts` 路径,撞了 V8 parser 的 forward ref 检查,回退;v0.7.1 换种姿势再来)
- Settings → Plugins 上的 Plugin configuration 卡片 —— **v0.7.0 已加**(但只在 `@deepseek-ai/schemastery` 能解析时才有;dsh-market 里 3 个 companion plugin 都 work)。卡片本身只放个"打开编辑器"链接,实际配置在编辑器里

## 协议

MIT
