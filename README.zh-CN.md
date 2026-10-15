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
git clone https://github.com/gamelongtim-ux/dsh-workflow-runner.git
cd dsh-workflow-runner
dsh plugin --profile desktop add file:"$PWD"
```

然后重启 `dsh web`。聊天输入区里能看到 `▶ Workflow` 按钮。

> 📌 如果同版本 pnpm `add file:` 不重新拷贝(pnpm 12 的怪行为),改 `package.json` 里的 `version`,或者直接用 `update.cmd`。

## 把这个插件给其他 dsh 用户用

下游 dsh 用户在"添加插件"对话框里有三种装入路径,看你打算怎么分发来选:

| 路径 | 在 dsh "添加插件"对话框里粘贴 | 备注 |
| --- | --- | --- |
| **GitHub URL** *(当前在用)* | `https://github.com/gamelongtim-ux/dsh-workflow-runner` | 永远可用;拉的是最新 `main` HEAD |
| **本地路径** | `<本地 clone 的绝对路径>` | 想跟你的本地编辑同步改;搭配 [`update.cmd`](#修改后更新) |
| **npm 包名** *(暂未发到 npm)* | `dsh-workflow-runner` | 国内走镜像源更快、可锁版本,但要先有维护者发到 npmjs.org |

> dsh 桌面"添加插件"对话框里的"中国大陆镜像源"是**读端加速**;包本身还得能经 GitHub(或 npmjs.org)拿到。

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
| `phase(name)` | `Promise<{ok:true}>` | 标记一个 phase。所有已完成的 phase 都在 UI 列出 |
| `log(message, level='info')` | `Promise<{ok:true}>` | 流到事件日志。`level` ∈ `info`, `warn`, `error`, `debug` |
| `report(item, tag=null)` | `Promise<{ok:true}>` | 在 Reports 面板露出结构化项。`item` 可以是任意可 JSON 序列化的值 |
| `agent(name, opts).ask(prompt)` | `Promise<{content, usage}>` | 按名创建(或复用)子代理;同名复用保留历史。`opts` ∈ `{system, model, temperature, maxTokens}` |
| `agent(name).close()` | `Promise<{closed:true}>` | (可选)提示;历史随 run 结束释放 |
| `world.run(cmd, args, opts)` | `Promise<{exitCode, signal, stdout, stderr, durationMs}>` | spawn 本地 shell 命令。**非零退出码是值,不抛异常**。`opts.cwd / env / timeoutMs` 可配 |

> 第一个参数 `agent(name, opts)` 可只写 `agent('planner')`;`opts` 可省。

## 样本

`samples/` 里有三份:

| 文件 | 模式 |
| --- | --- |
| `smoke.mjs` | phase + log + world.run + report —— 不调 LLM,可无 key 跑通 |
| `planner-critic.mjs` | `planner` → `critic` → `planner` 同名复用带 critique 的修订 |
| `fanout-summarize.mjs` | 三个并行 `summarizer-N`,再 `reducer` 汇总成 cheatsheet |

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

按这个顺序排查:

1. **插件**页里有 `dsh-workflow-runner` 且**开关是开**的
2. 拨完开关后**重启 dsh**(`任务管理器` → `DeepSeek Harness.exe` → 结束任务 → 重开)。bundle 是在进程启动时加载,不是拨开关时。
3. 你在**新会话**里看(左下角 → 新会话),不是装插件之前打开的老会话
4. dsh 桌面版是 **V0.2.0-rc.2 或以上**——老版本可能没有 `conversation.composer.dock` 这个 slot

## 显式不做

- TypeScript 类型检查 —— 只用 JS + JSDoc
- `hole<T>()` 运行中人工接管 —— 没有交互模式
- 缓存复用 amend —— 改脚本要重跑
- Settings → Plugins 上的 Plugin configuration 卡片
- 运行历史持久化 —— 仅内存保存,关 dsh 即丢

## 协议

MIT
