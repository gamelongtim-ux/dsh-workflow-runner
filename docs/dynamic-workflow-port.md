# ZCode Dynamic Workflow → dsh 移植方案

> 目标：把 [ZCode](https://github.com/zai-org/ZCode) 的 **Dynamic Workflow** 做成一个 dsh
> (DeepSeek Harness) 桌面端插件，在 dsh 里以原生体验使用。
>
> 本文基于对两边的**源码级测绘**（2026-10-20），不是设计构想。每条结论都带 `file:line` 证据。

---

## 0. 结论速览

1. **两边是完全不同的产品。** ZCode = `zai-org/ZCode`（智谱，AI 编程工作台）；dsh =
   `deepseek-ai/deepseek-harness`（DeepSeek Harness）。没有可复用的宿主代码。
2. **本仓库 v0.12.0 已经移植了 ZCode 的「运行时语义」，但没有移植「编译期语义」。**
   静态分析、四张图、lowering、site id、泛型 schema 合成、内置 skill、模型面工具——**全部为零**。
3. **模型目前什么都做不了。** 插件只暴露 HTTP API + web editor，**没有向模型注册任何 tool**。
   模型是旁观者，不是参与者。这是当前最大的产品级缺口。
4. **移植在技术上完全可行，已实测到端到端。** ZCode 引擎源码**零修改**即可构建运行，
   四张图、site id 注入、`ask<T>` → JSON Schema 全部真实产出（§8 V1）。
5. **dsh 侧能携带 `typescript` 运行时依赖**，无体积上限、无 asar 问题、无供应链策略阻拦（§8 V2）。
6. **dsh 原生 `workflow` tool 与 ZCode Dynamic Workflow 不是同一套东西**——它只是
   一个固定 6 hook 的 JS 编排 DSL，**无文件、无网络、无命令、无产物**。
   本插件的能力面**远超**它，不存在重复造轮子的问题（§8 V3）。
7. **移植会打破本仓库刻意维持的两条属性**：零第三方运行时依赖、无构建步骤。详见 §6。

---

## 0b. 当前进度（2026-10-20）

| 阶段 | 状态 | 说明 |
|---|---|---|
| **A. vendor + 构建流水线** | ✅ 完成 | 两个上游包进仓；`npm run build` 出 dist；`npm run verify:vendor` 校验字节一致；CI 建包 + 校验 + 冒烟 |
| **B. 适配层（编译期 + 引擎驱动）** | ✅ 完成 | `lib/dwf/`：`prepare.js`（四图 + lowering + schema）、`driver.js`（WorkflowDriver 四个端口）、`index.js`（`runDwfWorkflow`）、`host.js`（dsh 侧服务 + 事件翻译） |
| **端到端验证** | ✅ PASS | `scripts/dwf-smoke.mjs`：编译 → 分析 → 降级 → 子进程 vm → NDJSON 桥 → 引擎结算 `completed` |
| **C. 接入 dsh 现有 runtime** | ✅ 完成 | `lib/runtime.js` 的 `startEngine()`；run state 抽成 `#newState`（两条路径共用）；phase/report 抽成 `#enterPhase`/`#recordReport`；`stop()` 支持 abort 引擎 run；`ctx.llm` 的模型调用做成可注入 |
| **C 的验收** | ✅ PASS | `scripts/dwf-runtime-smoke.mjs`：run 完成、产物正确、phase/agent/report/journal 落在同一 state 形状上、四张图非空、**路径逃逸与 symlink 逃逸双双被拒且给出原因** |
| **C 顺带修掉的三个缺陷** | ✅ | ① 相对路径按 `process.cwd()` 解析（应按工作区根）② 围栏纯词法判断，symlink 可逃逸 ③ `#runGit` 把**未洗白的 host env** 给了 git 子进程（API key 泄漏） |
| **C+. 接进 dsh 的 HTTP API** | ✅ 完成 | `POST /api/engine/compile`（只编译，出诊断 + 四张图 + 站点表 + 降级体）与 `POST /api/engine/run`（跑）；`/api/state` 带上 `engine` 段（诊断 + 图 + 结算） |
| **旧路径回归** | ✅ PASS | `scripts/legacy-smoke.mjs`：子进程路径照常工作 |
| **D. dsh 独有 facade 能力** | ✅ 完成 | `askUser`/`escalate`/`route`/`models`/`concurrency.stat`/`stages`/`constants` 全部在引擎路径上可用；**上游一个字节未改**（声明进 facade，实现作为 sandbox 全局注入，宿主往返走 worldRead 通道） |
| **E. 模型面工具 + 内置 skill** | ✅ 完成 | 10 个 tool 注册到宿主 `tools` 服务；`skill/dynamic-workflows/SKILL.md` 注册到 `skills` 服务；**硬门禁**：`create_workflow` 在模型读过契约前拒绝执行 |
| **F. 编辑器四图 + samples 迁移** | ✅ 完成 | 编辑器加 **Graphs 标签页**，`public/graph-view.js` 渲染 site / causality / control-flow / handoff 四张图；**33 个 `samples/dwf/*.dwf.ts`** 全部编译通过（25 个旧 `.mjs` sample 全部有对应 + 8 个新增范式）；另立 `samples/dwf-negative/` 放**必须编译不过**的负例 |

### 已验证的硬事实

- **上游保真**：`packages/dynamic-workflow/src` 与 `zai-org/ZCode` **逐字节一致**（458 文件），
  唯一改写是 harness 的 import specifier（26 文件里的 2 个）。`npm run verify:vendor` 随时可查。
- **上游测试全绿**：`npx vitest run tests` → **38 文件 / 1983 测试全过**；
  `node verify-goldens.mjs` → **13/13 lowering 黄金逐字节一致**（在 `.spike/zcode-engine/`）。
- **本移植的端到端**：typed ask 的 schema 由 `ask<T>` 泛型合成（含 JSDoc description 的
  harvest），引擎校验后回 `accept`，journal 落 typed 结果行。
- **作者面全绿**：`samples/dwf/` 33 个 `.dwf.ts` 全部编译通过；
  `samples/dwf-negative/` 2 个负例全部**按预期诊断码**失败。
  一条命令看全部：`node scripts/run-all-checks.mjs`（10 个检查脚本）。
- **旧路径没被牺牲**：`samples/` 下的 25 个 `.mjs` 与 5 个 `.ts` 一个字节没动，
  `node scripts/legacy-smoke.mjs` 照常通过。
- **插件真的会激活**（v0.15.2/0.15.3 修的两个 bug 都在这条线上）：
  `scripts/dwf-apply-check.mjs` 用假 cordis ctx 调 `apply()`，
  断言注册出 10 个 tool、1 个 skill、1 个 `/workflow` 命令、1 张 Settings 卡片、
  1 条 web 路由，且每个 effect 的 disposer 都能安全调用。
  `scripts/verify-profile-install.mjs` 对**实际装进 profile 的那份**做同样的事。
  ⚠️ 这两个 bug 都**在仓库里看不见**——peer 依赖在仓库里解析不到，
  而仓库里从来没人调用过 `apply()`。**能 import ≠ 能用。**
- **Electron 兼容**：vendored 的 harness 显式带 `ELECTRON_RUN_AS_NODE: "1"`
  （`harness.ts:292`）——dsh 桌面端是 Electron，这一条是必需的。
  ⚠️ dsh 现有的 `lib/runtime.js:454` **没有**带这个变量，需在接线时核对。

---

## 1. 三方定位

| | **ZCode Dynamic Workflow** | **dsh (DeepSeek Harness)** | **本仓库 dsh-workflow-runner v0.12.0** |
|---|---|---|---|
| 形态 | 闭源产品的内置特性 | 插件化 harness | dsh 插件 |
| 工作流脚本 | TypeScript `.dwf.ts` | — | ESM `.mjs` / `.ts` |
| 执行位置 | 宿主进程内 | — | **独立 Node 子进程**（JSON-RPC over stdio） |
| 编译期 | 分析 → lowering → 带 site id 的 JS | — | **无**（`.ts` 仅 tsc 转译） |
| 模型面 | 10 个 workflow tool + 硬门禁 skill | 有 tool / skill 子系统 | **无 tool、无 skill** |
| 产物 | 图表、看板、文件、指标 | — | 6 类 artifact（file/markdown/chart/table/metrics/board） |

**ZCode 侧坐标**（仓库 `zai-org/ZCode`）：

| 位置 | 内容 |
|---|---|
| `apps/zcode-cli/packages/dynamic-workflow/src/` | 引擎本体，120 文件 / ~23,000 行 |
| ├ `analysis/` (57 文件 / 13,555 行) | 静态分析，产出 site / causality / control-flow / handoff 四张图 |
| ├ `engine/` (32 文件 / 6,300 行) | 状态机、调度器、journal、并发控制器 |
| ├ `schema/` (7 文件) | 从 `ask<T>` 泛型合成 JSON Schema |
| ├ `lowering/` (3 文件) | 降级成带 site id 的 async 函数体 |
| ├ `facade/` (8 文件) | facade 单一事实源（`FACADE_DTS`） |
| └ `compiler/compile.ts` | 虚拟 host + `ts.Program` + type checker |
| `apps/zcode-cli/packages/bundled-skills/skills/dynamic-workflows/` | SKILL.md 93KB + patterns.md 35KB + examples.md 49KB |
| `apps/zcode-cli/packages/contracts/src/tools/*workflow*.ts` | 工具 schema（zod） |
| `apps/zcode-cli/packages/core/src/tool/handlers/*workflow*.ts` | 40 文件 / 383KB 宿主处理器（**ZCode 特有，不搬**） |
| `docs/dynamic-workflow.md` + `docs/dynamic-workflow/*.md` | 规范，5 篇共 640KB |

**唯一硬依赖**：`typescript@^5.9.0`（`packages/dynamic-workflow/package.json:32-38`）。
工具契约另需 `zod` + `zod-to-json-schema`（**dsh profile 里已经装了这两个**）。

---

## 2. 能力差距矩阵

| ZCode 能力 | 本仓库现状 | 证据 |
|---|---|---|
| `.dwf.ts` + lowering 注入 site id | ❌ 无。`.mjs` 直接 `import()` 解释执行；`.ts` 仅 tsc 转译，不注入 site id | `lib/runtime.js:454`、`:951`、`lib/runner-bootstrap.mjs:1043` |
| 静态分析四张图 | ❌ 无。`lib/` 全量 grep `site\|causality\|handoff\|lowering\|mermaid\|graph` 仅 7 处**无关**命中 | `lib/runtime.js:981`、`:72`、`:1176` |
| `ask<T>` 泛型 → JSON Schema | ❌ 无。`T` 是类型层 fiction，运行时被擦除；真实 schema 来自 `opts.result` 的**运行时字面量**，再拼成提示词文本塞给模型 | `lib/facade.d.ts:172`、`lib/runtime.js:2665`、`:1749-1751` |
| facade `.d.ts` 单一事实源 | ⚠️ 手写镜像。注释自称「Mirrors the ZCode dynamic-workflows §16.2 contract」，但**无 vendored 源、无同步机制** | `lib/facade.d.ts:3`、`CHANGELOG.md:434` |
| `CreateWorkflow` / `AmendWorkflow` / `SaveWorkflow` / `EvalWorkflowSnippet` 等 10 个 tool | ❌ **零个 tool**。同名语义只以 HTTP 端点存在 | `lib/plugin.js:422`、`:710`、`:609` |
| bundled skill 硬门禁 | ❌ 无 skill 目录（全仓 `**/SKILL.md` 零命中） | — |
| 运行时语义：facade / artifact / amend / hole / askUser / escalate / channel / 并发 / 死锁 | ✅ **大部分已移植**，v0.8–v0.12 系统性补齐 | `CHANGELOG.md:11-15` |
| OS 级沙箱（env 清洗 + 路径限制） | ✅ 有 | v0.9.0 |
| journal 断点恢复 / 落盘持久化 | ✅ 有 | v0.10.0–v0.11.0 |
| 三处 UI slot + web editor | ✅ 有，且是当前产品的门面 | `lib/client.js:6-9`、`public/editor.js` |

**一句话**：ZCode 的 Dynamic Workflow = **编译期语义 + 运行时语义 + 模型面**。
本仓库做完了运行时语义，**编译期语义和模型面是空白**。

---

## 3. 架构对照：两套执行模型

这是移植的核心难点——两边的执行模型根本不同。

### 3.1 ZCode：进程内 + 端口注入

```
.ts 脚本 ──ts.Program──> analysis(四图) ──> schema(ask<T>→JSON Schema)
   │
   └──ts.transform──> lowering ──> async 函数体，__host 为唯一自由标识符
                                        │
                             ┌──────────┴──────────┐
                             │  WorkflowEngine     │  ← 纯状态机
                             └──────────┬──────────┘
                    ┌───────────────────┼───────────────────┐
              WorkflowHostApi     WorkflowDriver     JournalStorePort
              (__host.* 面)       (子代理/工作区/事件)   (同步仓储)
```

`engine/` **零外部依赖、零 node 内建、零 I/O**（`packages/dynamic-workflow/README.md:14-16`）。
宿主只需实现 4 个端口（`src/engine/types.ts`）：

- `WorkflowHostApi`（`:244-290`）— 降级脚本看到的 `__host.*` 面
- `WorkflowDriver`（`:312-355`）— 子代理会话、ask 派发、工作区只读、事件流
- `JournalStorePort`（`:979`）— 仓储式**同步**方法，内存实现 `journal-memory.ts` 已有
- `WorkflowReportSink`（`:408`）— 向上回报面（ask 生命周期、并发变化、stall）

### 3.2 本仓库：子进程 + JSON-RPC

```
host(插件)  ──spawn(node)──>  child(runner-bootstrap.mjs)
   │                                    │
   │  ←──── JSON-RPC over stdio ───────┤
   │                                    └─ import(用户脚本) ──> globalThis.__dsh
   ├─ agent 会话 / world.run / files / git
   ├─ artifact / journal / SSE 广播
   └─ web editor UI
```

### 3.3 映射结论：引擎在宿主、脚本在子进程（ZCode 自己的架构）

> ⚠️ 本节结论在测绘中途被修正过一次。最初据 `__host` 是内存引用推断「脚本必须搬进宿主进程」，
> 那是错的：**ZCode 自己就是「引擎在父进程 + 脚本在子进程 + NDJSON 桥」**
> （`dynamic-workflow-runtime` 的 `harness.ts` / `child-source.ts` / `protocol.ts`）。
> 下面是正确的分层。

```
host 进程（dsh 插件）                      child 进程
─────────────────────                      ───────────
WorkflowEngine  ──NDJSON 桥──▶  vm cell 执行 lowered 脚本
WorkflowDriver  (dsh 的副作用)  ◀──NDJSON──  __host.* 调用
JournalStorePort(存储口)
```

**为什么引擎必须在宿主**：journal 口是**同步**的，且坐在引擎自己的决策路径上——
`scheduler.ts:135` 用 `journal.getNode` 决定「命中导入缓存」还是「live 派发」，
`engine.ts:390` 用 `journal.getActor` 保住 driver 拥有的字段。跨进程代理 journal 做不到。

**为什么脚本可以留在子进程**：子进程里的 `__host` 是一组**发消息的 shim**
（`child-source.ts:208` 组装 `globalThis.__host`），不是引擎本身。
每次 `__host.ask(...)` 变成一条 NDJSON 请求，宿主侧引擎处理完再回一条响应。

**这个分层对 dsh 恰好是好消息**：dsh 现有的进程级 OS 沙箱（env 洗白、路径围栏、
`world.run` 允许清单）**原样保留**——脚本本来就在独立子进程里跑。
用户选择的「围栏下沉到 `executeWorldRead`」因此是**加固**而不是**替代**。

**要 vendor 的两个包**（都已进仓）：

| 包 | 内容 | 依赖 |
|---|---|---|
| `packages/dynamic-workflow/` | 引擎：analysis / compiler / lowering / schema / facade | `typescript` |
| `packages/dynamic-workflow-runtime/` | harness：子进程 + NDJSON 桥 + vm cell | 引擎（相对路径 import） |

**唯一的上游改动**：harness 用 workspace 包名 import 引擎，vendor 脚本把它改写成
相对路径（`"@zcode/dynamic-workflow"` → `"../../dynamic-workflow/dist/index.js"`）。
改写被记进 manifest（改写后的哈希），所以漂移照样能查出来。

### 3.4 端口方法 → dsh 现有代码的映射

| ZCode 端口方法 | dsh 现有实现 | 状态 |
|---|---|---|
| `createActorSession` | `#agentAsk` 里按 **name** 键建 `s.agents` | ⚠️ 语义不等价（ZCode 用 `(siteId, ordinal)`），**需重做** |
| `startAsk` | `#dispatch('agent.ask')` → `#agentAsk` | ✅ 可直接接 |
| `respondToSubmit` | **无对应**——dsh 在 `#agentAsk` 内部就把结果返回子进程 | ❌ **必须新增**（ZCode 的 repair 预算靠它） |
| `cancelAsk` | 只有整 run `stop(runId)` | ❌ **必须新增** |
| `executeWorldRead`（read/glob/grep/git-*/run） | `#filesRead` / `#filesGlob` / `#filesGrep` / `#git*` / `#worldRun` | ✅ 直接可用（git op 名需转换前缀） |
| `executeArtifactPublish` | `#artifactPublish` | ✅ 基本可用（ZCode 额外要求越界拒绝 + contentType 推断） |
| `journal`（16 个同步方法） | `s.journal` 扁平数组 | ❌ **形状完全不对，需整体重写** |
| `emit` | `#broadcast` → SSE | ✅ 直接可用（ZCode 事件类型更丰富，需做类型映射） |
| `WorkflowReportSink`（11 方法，**引擎实现**） | 无对应面 | ❌ **需新增**（`askProgress` / `stopRun` / `askMutating` 等无对应） |

---

## 4. 移植分层与工作量

| 层 | 内容 | 工作量 | 是否必须 |
|---|---|---|---|
| L0 | **模型面工具**：10 个 workflow tool + 宿主适配 | 中 | ⭐ 性价比最高 |
| L0.5 | **facade 单一事实源**：`facade/dts.ts` 派生 + 站点收集同名约束 | 小 | 强烈建议 |
| L1 | **内置 skill**：SKILL.md + patterns + examples 改写为 dsh 词汇 | 中 | ⭐ |
| L2 | **引擎移植**：`engine/` 整包 vendored + 4 端口实现 | 中 | 真移植必须 |
| L3 | **编译期**：`analysis/` + `lowering/` + `schema/` + `compiler/` | **大** | 真移植必须 |
| L4 | **facade 单一事实源**：从 ZCode `facade/dts.ts` 派生，替换手写 `facade.d.ts` | 小 | 强烈建议 |
| L5 | **四图呈现**：编辑器渲染 site/causality/control-flow/handoff | 中 | 可选 |

### L0 — 模型面工具（当前最大的缺口）

ZCode 的工具契约（`contracts/src/tools/`，zod → `toToolJsonSchema`）：

| 工具 | 入参要点 |
|---|---|
| `CreateWorkflow` | `script?` \| `saved?` \| `path?` **恰好一个**（XOR 不写在 zod，由 `validateInput` 强制，`create-workflow.ts:78-87`）；`args?`、`max_concurrency?`、`subagent_model?`。返回 `{diagnostics[], ok, response, causalityGraph?, status?, backgroundTaskId?}` |
| `AmendWorkflow` | `run_id` 必填；`script?`\|`path?`（全省=沿用前驱）；`max_concurrency?` / `subagent_model?` 是**三态**（省略=沿用 / null=回默认 / 数字=设定） |
| `SaveWorkflow` | `name`、`description` 必填；`scope` **必填无默认**（`project`\|`global`）；`script?`\|`script_path?` |
| `EvalWorkflowSnippet` | `code?`\|`path?`；`timeoutMs?` 默认 60000 / 上限 600000 |
| 其余 | `FillWorkflowHole`、`ResumeWorkflowRun`、`ListWorkflowRuns`、`GetWorkflowRun`、`ListSavedWorkflows`、`ResolveWorkflowQuestion` |

本仓库的 HTTP 端点已经覆盖了大部分语义（`/api/run`、`/api/amend`、`/api/eval`、
`/api/saved-workflows`），**L0 主要是把这些端点包成 dsh tool**，外加 `causalityGraph` 展示载荷。

### L1 — 内置 skill

ZCode 的 skill 是**硬门禁**：`CreateWorkflow` / `AmendWorkflow` / `SaveWorkflow` /
`EvalWorkflowSnippet` 在会话里没加载过该 skill 就拒绝提交脚本
（`contracts/src/tools/create-workflow.ts:15`）。这意味着 skill 本身就是「模型怎么写工作流」的
全部规范。

**可移植**：专家级交付标准、拓扑决策法、fresh-eyes 四规则、typed result + JSDoc 规则、
窄结果/传路径、阶段命名与流水线写法、验证纪律、留白手法、anti-patterns、§16.2 facade 参考。
**必须改写**：ZCode 工具名与宿主路由、`.zcode/workflows/*.dwf.ts` 等路径约定、
「legacy `Workflow` tool 和 `/expert`」的冲突说明、Results 区/看板等 UI 词汇。

⚠️ **注意**：ZCode 的 SKILL.md 用 `<!-- facade-dts:start -->` 内嵌了 facade 全文，
且被 `packages/bootstrap/tests/dynamic-workflow-skill.test.ts:6-10` 断言与 `FACADE_DTS`
**逐字相等**。改 facade 必须同步改 skill，否则测试变红。移植时这条约束要保留。

---

## 5. 关键技术风险

### R1 — `ts.Program` 不可省（阻断 L3）

`ask<T>` → JSON Schema 这条链**没有 AST-only 路径**。`src/schema/synthesize.ts:43-48`：

```ts
function askResultType(checker: ts.TypeChecker, call: ts.CallExpression): ts.Type | undefined {
  const typeNode = call.typeArguments?.[0];
  if (typeNode === undefined) return undefined;
  const type = checker.getTypeFromTypeNode(typeNode);
  return (type.flags & ts.TypeFlags.String) !== 0 ? undefined : type;
}
```

`src/schema/emit.ts` 全部走 checker API（`getPropertiesOfType` / `getTypeOfSymbolAtLocation` /
`getIndexInfoOfType` / `getTypeArguments` / `getPropertyOfType`）。
`analysis/` 里约 20 个文件也调 `program.getTypeChecker()`
（`sites.ts:303`、`state.ts:160`、`taint.ts:103,252,321,568,653`、`callbacks.ts:155-191` 等）。

> 注意 `src/interpret.ts:40-41` 的限定：**投影层是纯的**（`graph.ts` / `causality-graph.ts`
> 不 import `typescript`、不碰 AST、不碰 checker），**但铸 core 的那半不是**。
> `src/projections.ts` 就是为此存在的浏览器安全桶。

**结论**：要拿到 typed results，就必须让 `typescript` 进到运行时。这是 L3 的硬前提。

### R2 — `typescript` 作为运行时依赖，打破本仓库的两条既有属性

本仓库 v0.12.0 明确维持：**零第三方运行时依赖** + **无构建步骤**。
README 的故障排查里给的免 pnpm 手动安装路径甚至**不拷 `node_modules`**：

```powershell
Copy-Item "$S\lib","$S\public","$S\samples","$S\package.json","$S\cordis.patch.yml" -Recurse -Force -Destination $D
```

引入 `typescript`（≈ 几十 MB）后，这条路径失效。

**✅ 已验证（V2）：dsh 侧可行。** 依赖由 pnpm 装进 profile 并 hoisted，插件的 bare import
能正常命中；无体积上限；`minimumReleaseAge` 拦的是「刚发布 <24h 的版本」不拦大包；asar 无影响。

**但连带影响仍在**：上面那条手动安装路径对阶段 3 失效，必须补一条「连 `node_modules` 一起拷」
的变体，或在 README 里明确标注「阶段 3 起该路径不再适用」。

**缓解**：ZCode 的 `scripts/generate-libs.mjs` 会把 TS stdlib 的 `.d.ts` 闭包嵌进
`src/compiler/libs.generated.ts`（`TS_LIBS`，实测 485 KB），使编译器 host **全虚拟、零磁盘访问**。
但这解决的是 stdlib，**不解决 `typescript` 本体**——它仍然是运行时要 import 的。

### R3 — facade 漂移

`lib/facade.d.ts` 是手写镜像，**没有 vendored 源，也没有自动同步机制**。ZCode 侧
`facade/dts.ts` 是手写但**单一事实源**（`FACADE_DTS` 与 `SNIPPET_FACADE_DTS` 从同一批段拼出，
`dts.ts:9-12` 注明「子集绝不手抄」），并由 skill 的嵌入块 + 测试钉住。

移植后必须让 dsh 的 facade 从同一份源派生，否则两边必然漂移。
**而且 `FACADE_FILE_NAME = "workflow-facade.d.ts"` 改名会让站点收集静默变空**
（`compile.ts:80-84`）——这是个静默失败，必须防。

### R4 — `libs.generated.ts` 是 gitignored 的生成物

`compile.ts:3` 直接 import 它。移植必须跑一次 `generate-libs.mjs` 并把产物一并带走，
否则 import 直接断。生成器串在 `build`/`typecheck`/`test`/`coverage` 四条脚本里。

### R5 — 构建流水线从零开始

本仓库 `lib/` 全部是**手写 plain JS**（零构建）。移植 TS 源码意味着要引入：
`tsc` 构建 + 产物目录 + 发布时带上 `dist/`。这会改变 `package.json` 的 `files`、
`exports`、以及 dsh 加载器解析入口的路径。

> ⚠️ **一个必须记住的坑**：vendored 包的 `package.json` **必须加 `"type": "module"`**。
> 缺它时 `module: NodeNext` 会把 `.ts` 当 CJS，tsc 产出 `exports.foo = ...` 的 CJS，
> 与上游 ESM 产物不同形。补上后 `dist/index.js` 才是标准 ESM。

---

### 5b. 语义与行为层的风险（实测得出，完整版见 `.spike/zcode-engine/FINDINGS.md` §6）

| # | 风险 | 严重度 | 要点 |
|---|---|---|---|
| **R6** | **沙箱围栏的落点变了** | 🟠（原判 🔴，已缓解） | ZCode 的沙箱契约是 vm 上下文（只给 ES intrinsics + `__host`）。但**脚本仍在独立子进程里跑**（§3.3），所以 dsh 现有的进程级隔离（env 洗白 `lib/runtime.js:1296`、允许/拒绝清单 `:78-101`、路径围栏 `:2301`）**原样保留**。<br>用户选的「围栏下沉到 `executeWorldRead`」因此是**加固**：那已经是脚本触达世界的唯一收口点（`engine-world.ts:117`），把路径围栏 / 文件 cap / git 允许清单沉到这里，围栏在**进程边界 + 收口点**两处都成立。 |
| **R7** | **journal 口形状完全不同** | 🟠 | ZCode 的 `JournalStorePort` 有 16 个**同步**方法（run / actor / node / event 四类读写的仓储式接口），dsh 现在是 `s.journal` 一个扁平数组（`lib/runtime.js:1397`）。<br>**可行路径**：引擎自带的 `InMemoryJournalStore` 已经实现了这个口，且上游有一套**契约测试套件**（`src/testing/journal-contract.ts`）专门验它。v1 直接复用它；持久化用一层 write-through 包装（委托给内存实现 + 落盘），包装层同样跑那套契约测试。 |
| **R8** | **`WorkflowReportSink` 11 个方法带强顺序契约** | 🟠 | `askProgress` **必须先于**同 turn 的 `askStats`（`types.ts:415-417`，原文「两条事件的先后是读面的契约」）；`askSubmitAttempted` 触发**同步**校验并回 `respondToSubmit`（`engine/scheduler-submit.ts:23-49`）；`stopRun` 要求 `error.code === "ProviderStop"`（`:423-428`）。 |
| **R9** | **driver 拥有的字段写入时机是个陷阱** | 🟠 | `resolvedModel` / `sessionId` 是 **driver 拥有**的字段，且必须在 `createActorSession` **内部**写（`engine/scheduler.ts:474-487`；上游 fake `tests/engine/fake-driver.ts:132-137`；`engine.ts:391-399` 注释明确「必须把既有值原样带过去」）。晚一步解析模型 → 引擎那次 `putActor` 把它抹成 `undefined` → **档位审计与 resume 依据丢失，而且不报错**。<br>✅ 本移植的 `lib/dwf/driver.js` 已按此实现，冒烟测试实测 actor 行带上了 `resolvedModel`。 |
| **R10** | **typed-ask 作者面是 breaking change** | 🟠 | dsh 现在是运行期形状对象 `ask(prompt, { result: shape })`（`lib/runtime.js:2665` / `:2694`）；ZCode 是编译期类型实参 `ask<T>()`。切过去**现有 dsh 脚本全要改**。另一面：ZCode 要求 `askSpecs` 覆盖**每一个** ask 站点，缺席即 `MissingAskSpec` **硬失败**（`engine.ts:412-424`）。<br>**缓解**：`buildAskSpecs`（`schema/synthesize.ts:150-158`）是唯一正确写法，本移植已用它；`ask<T>()` 的 schema 合成已实测（含 JSDoc description 的 harvest）。 |

> **好消息**：dsh 的 `lib/facade.d.ts` **明确是 script（无顶层 export）**，注释写着
> 「Mirrors the ZCode dynamic-workflows §16.2 contract」（`lib/facade.d.ts:1-26`），
> 且**两侧 facade 名字集 dsh ⊇ ZCode**（dsh 外加 `askUser / escalate / models / stages /
> concurrency / constants / t / route`）。**现有 dsh 脚本在语法上就是 ZCode 脚本。**
>
> 唯一硬约束：ZCode 的站点收集按 facade **声明文件名**判定（`compiler/compile.ts:80-84`，
> `FACADE_FILE_NAME` 改名会让站点收集**静默变空**）。dsh 现在注入的是 `__dsh_facade__.d.ts`
> （`lib/runtime.js:999`、`:1135`），**不能沿用这个文件名**。
> 解法：`createWorkflowProgram(scriptText, { facadeDts })` 注入 dsh 自己的 facade 文本，
> 引擎内部会统一以 `workflow-facade.d.ts` 入 host。

---

## 6. 路线（2026-10-20 已调整为「全量移植」）

> 原计划是分三阶段推进；用户已选定**直接做全量移植**（引擎 + 编译期一起上），
> 沙箱围栏**下沉到 `executeWorldRead`**。下表是调整后的顺序。

### 阶段 A — vendor + 构建流水线 ✅ 已完成

- `packages/dynamic-workflow/` + `packages/dynamic-workflow-runtime/` 进仓，源码逐字节等于上游
- `npm run build` → 两包 dist；`npm run verify:vendor` → 字节一致性校验
- CI：建包 + 校验 + 冒烟

### 阶段 B — 适配层 ✅ 已完成

- `lib/dwf/prepare.js`：一次编译 → 四图 + 站点表 + `ask<T>` schema + 降级体
- `lib/dwf/driver.js`：`WorkflowDriver` 四个端口；`resolvedModel` 在 `createActorSession` 内写（R9）
- `lib/dwf/index.js`：`runDwfWorkflow()` 串起 compile → harness → 引擎 → 结算
- `scripts/dwf-smoke.mjs`：端到端冒烟，**PASS**

### 阶段 C — 接入 dsh 现有 runtime ✅ 已完成

把 `lib/runtime.js` 的能力接到 `lib/dwf` 的 `services` 上：

| `services` 成员 | dsh 现有实现 | 状态 |
|---|---|---|
| `askModel` | 一次模型轮次；schema 由编译期从 `ask<T>` 合成 | ✅ 新增 `lib/dwf/host.js`；typed 的校验与 repair 预算归引擎 |
| `worldRead` | `#filesRead` / `#filesGlob` / `#filesGrep` / `#git*` / `#worldRun` | ✅ op 名一一对应；**围栏随这些方法一起生效** |
| `publishArtifact` | `#artifactPublish` | ✅ 引擎算 version，store 也算 version，分歧会报警 |
| `emit` | `#broadcast` → SSE | ✅ 27 个引擎事件类型逐个映射；phase/report/log 走共享副作用 |
| `resolveModel` | `s.modelsAllowed` | ✅ persona 点名的模型优先 |
| `journal` | `InMemoryJournalStore` + write-through | ✅ 引擎的 journal 是真相，dsh 的扁平 journal 是镜像 |

**共享代码**（两条路径共用，避免语义漂移）：
- `#newState` — run state 的唯一工厂，两条路径同一形状
- `#enterPhase` / `#recordReport` — phase 折叠与 report 路由的唯一实现

**顺带修掉的三个缺陷**：
1. `#resolveInWorkspace` 把**相对路径**按 `process.cwd()` 解析——facade 契约写的是「工作区相对」，
   而引擎路径跑在宿主进程里，cwd 是 dsh 的启动目录。之前只是「碰巧」能用。
2. 围栏是**纯词法**判断，工作区内的 symlink 指向外部可以逃逸。现在解析真实路径再比一次
   （根也解析，因为 macOS 的临时目录本身就是链接）。
3. `#runGit` 把**未洗白的 `process.env`** 给了 git 子进程——沙箱刚剥掉的 API key 原样还回去了。

**验收**：`scripts/dwf-runtime-smoke.mjs` 全绿——run 完成、产物正确、phase/agent/report/journal
落在同一 state 形状上、四张图非空、**路径逃逸与 symlink 逃逸双双被拒并说明原因**。
`scripts/legacy-smoke.mjs` 确认旧路径照常工作。两者都在 CI 里跑，离线。

### 阶段 D — dsh 独有 facade 能力 ✅ 已完成

`askUser` / `escalate` / `stages` / `route` / `t` / `concurrency` / `models` / `constants`：
写进 dsh 自己的 facade 文本（用 `createWorkflowProgram(text, { facadeDts })` 注入），
并在沙箱 globals 里提供实现。**注意**：ZCode 的 registry 不认识这些成员，
所以它们不产生站点、不落 journal 行——这是相对旧实现的**语义降级**，需要在文档里说清楚。

### 阶段 E — 模型面工具 + 内置 skill ✅ 已完成

`CreateWorkflow` / `AmendWorkflow` / `SaveWorkflow` / `EvalWorkflowSnippet` /
`FillWorkflowHole` / `ListWorkflowRuns` / `GetWorkflowRun` / `ListSavedWorkflows` / `ResolveWorkflowQuestion`
（`ctx.tools.register`），加改写后的 `dynamic-workflows` skill（`ctx.skills.register`）作硬门禁。

### 阶段 F — 编辑器四图 + samples 迁移 ✅

编辑器渲染 site / causality / control-flow / handoff 四张图；
现有 30 个 sample 从 `ask(prompt, { result: shape })` 迁到 `ask<T>()`。

**落地情况**（2026-10-20）：

- `public/graph-view.js`（独立模块）：site / control-flow 共用一套节点图渲染器，
  causality 是表格，handoff 是参与者列表。编辑器加 **Graphs 标签页**接上。
  `.dwf.ts` 按扩展名分流到引擎路径；sample 路径解析不再丢目录部分。
- `samples/dwf/*.dwf.ts` **33 个全部编译通过**（`node scripts/dwf-samples-check.mjs`）。
  25 个旧 `.mjs` sample 每个都有对应文件，另加 8 个新范式
  （`ask-human` / `env-scrub` / `models-list` / `scan-todos` / `summarize` /
  `typecheck-ok` / `typed-minimal` / `typed-shapes`）。
  **旧 `.mjs` 与顶层 `.ts` 全部保留**——老路径仍然可用。
- `samples/dwf-negative/*.dwf.ts` **2 个负例**：一个打在 TypeScript 层
  （1184 / 2322 / 2304），一个打在作者规则层（9003 / 9004 / 9005 / 9007 / 9010 / 9012）。
  「必须编译不过」的文件不能住在 `samples/dwf/`——那目录是整目录编译的，
  所以另立一个兄弟目录，让这个约定本身可被检查
  （`node scripts/dwf-negative-check.mjs`：不只断言"编译不过"，
  还断言"败在预期的诊断码上"，否则一个因为别的原因失败的负例等于什么都没测）。

**迁移过程中编译器真正抓到的旧 sample 毛病**（证明这层不是摆设）：

| 码 | 抓到了什么 |
|---|---|
| 9004 | phase 名必须是字面量——旧 sample 里的 `phase(\`Work ${n}\`)`、`phase(\`Summarize "${topic}"\`)` 全是运行期才成形的名字 |
| 9005 | actor 名在一次 run 内必须唯一——旧 `planner-critic.mjs` 用了两次 `agent('planner')` |
| 9007 | report 的标签必须指向本脚本声明过的预置看板——旧 sample 里的自由标签（`'echo'` / `'summary'` / `'hits'` …） |
| 9008 | 预置看板不能在循环/回调里声明——旧 `file-grep.mjs` 在函数体内 `artifact.table('hits', …)` |
| 9003 | `world.run` 的命令名必须是字面量 | 
| 9010 | `model()` 的参数必须是已知的模型名（模型集合在运行前闭合） |
| 9012 | 留白必须写出类型实参 |
| 9001 | facade 只能直接调用——`const p = phase` 会把调用点洗掉 |
| 9002 | 数据契约层：`error: s.error` 把 `undefined` 带进了非可选属性 |

**顺带修掉的一个真缺陷**（`lib/dwf/prepare.js`）：`prepareWorkflow` 把 schema
诊断算进了 `ok`，却**没有把它们带出来**——结果就是"编译不过，但没有任何理由"，
检查脚本只能看到一个空的 `[FAIL]`。现在 schema 层是第三个诊断层，
`collectPreparedDiagnostics` 会把它并进去，`/api/engine/compile` 也一并受益。
回归探针：`node scripts/dwf-schema-diag-check.mjs`。

---

## 7. 与既有实现的冲突点（阶段 2/3 必须逐条对齐）

| 本仓库自研特性 | ZCode 对应 | 冲突性质 |
|---|---|---|
| `max_concurrency` 信号量（`lib/semaphore.js`） | `engine/concurrency.ts`（AIMD 状态机，不读时钟） | **语义不同**：ZCode 是自适应 AIMD，本仓库是固定上限 |
| phase 生命周期 `active/done/error` | `engine-phase-stamp.ts` | 需对齐状态机 |
| channel 死锁检测 | `engine/scheduler.ts` | 本仓库的失败策略 vs ZCode 的 stall 语义 |
| amend 缓存生命周期（live/replayed、`AMEND_NO_CHANGE`、chain 深度） | `engine/imported-cache*.ts`、`engine-resume.ts` | 命名与触发时机不同 |
| `ask<T>` 用 `opts.result` 运行时字面量 | `schema/synthesize.ts` 泛型 | **直接冲突**：两种 schema 来源，需定优先级（见 R10） |
| `t` builder（`t.optional` 是 no-op） | `facade/dts-model.ts` | ZCode 无 `t`，需决定保留还是废弃 |

### 7.2 dsh 已有、ZCode 引擎没有的能力（移植时的**净损失**风险）

这些是本仓库 v0.9–v0.12 积累的自研优势。ZCode 引擎**没有对应概念**，
移植时要么在 driver 层补回，要么明确接受降级：

| dsh 能力 | ZCode 引擎对应 | 位置 |
|---|---|---|
| `askUser` / `escalate`（中途问人、Think-via-LLM） | **无**（ZCode 只有 `hole`） | `lib/runtime.js:2749`、`:2914` |
| `stages`（结构化 amend：向运行中的 run 注入新 stage） | **无** | `lib/runtime.js:630`、`:837` |
| `route`（多模型路由） | **无** | `lib/runner-bootstrap.mjs:641` |
| `t`（上下文构造器） | **无** | `lib/runner-bootstrap.mjs:613` |
| `concurrency` 统计面 | `ConcurrencyController`（进程级 provider key 治理，语义不同） | `lib/runtime.js:1584` |
| **进程级 OS 沙箱**（env 洗白、路径围栏、`world.run` 允许清单） | **无**（ZCode 只有编译期纯度 + vm 上下文） | `lib/runtime.js:78-101`、`:1296`、`:2301` |

> 最后一条是**最需要正视的**——它是安全属性，不是功能特性。见 §5b R6。

---

## 8. 验证结论（V1–V4，已实测）

### V1 — ZCode 引擎能否独立跑通：✅ **可以，且源码零修改**

在 `.spike/zcode-engine/` 做了完整 spike（可复跑）：

- 复制 ZCode `src/` → `npm install typescript@^5.9.3` → `node scripts/generate-libs.mjs` → `tsc`
- **逐文件哈希比对：ZCode 源码零修改**，唯一新增是生成物 `compiler/libs.generated.ts`（485 KB stdlib 闭包）
- 产出可运行 `dist/`（analysis / compiler / engine / facade / lowering / schema / testing 全量，363 个文件）
- `generate-libs.mjs` **原样跑通**，无需降级方案：它完全自包含（只 `require.resolve("typescript/package.json")`），
  不引用仓库相对路径、不引用 workspace 依赖 → **虚拟 stdlib 闭包原封不动，`analysis` 纯度不受影响**
- 唯一编译障碍：`src/testing/*.ts` import `vitest`（上游 devDep）→ 装同版本 `vitest@^4.1.5` 即干净通过，**不改源码**

**保真度实测（本机亲自跑的结果）**：

| 检查 | 结果 |
|---|---|
| `npx tsc` | exit 0，零错误零警告 |
| `npx vitest run tests`（上游测试语料） | **38 个测试文件 / 1983 个测试全绿** |
| `node verify-goldens.mjs`（lowering 黄金） | **13/13 逐字节一致** |
| 端到端 `node spike.mjs` | run 结算 `completed`，19 条事件、4 条 journal 节点行 |

> 1983 个上游测试 + 13 个逐字节黄金全过，等于**vendored 引擎的行为与上游完全一致**。
> 这是「可以原样 vendor」的最强证据。

**只有 3 处改动需要做**（均不在 `src/` 里）：

| 文件 | 改动 | 原因 |
|---|---|---|
| `scripts/generate-libs.mjs:19-26` | 输出路径 → vendored 目录 | spike 布局；闭包遍历逻辑与输出格式**逐字未动** |
| `tsconfig.json` | `rootDir` / `include` 指向 vendored src | 同上；`compilerOptions` 与上游逐字段相同 |
| `package.json` | **加 `"type": "module"`** | **必须**：缺它时 `module: NodeNext` 会把 `.ts` 当 CJS，tsc 产出 CJS 而非 ESM |

实测跑通三个真实工作流：

| 脚本 | 编译 | 分析 | 四张图 | lowering | schema | 引擎 |
|---|---|---|---|---|---|---|
| 7 行 inline | ✅ 0 diag | ✅ 63ms | ✅ 全非空 | ✅ | — | — |
| `tests/workflows/planner-reviewer.ts` | ✅ 0 diag | ⚠️ 报 9006 | ✅ 全非空 | ✅ | ✅ 3 个 | — |
| `tests/smoke/xiangqi-two-agent-match-a.dwf.ts` | ✅ 0 diag | ✅ 178ms | ✅ 全非空 | ✅ | ✅ 2 个 | — |

**四张图实测统计**（planner-reviewer）：site = 8 节点 / 4 actors / 14 边；causality = 4 步 / 3 region / 4 lane / 5 边；
control-flow = 4 节点 / 7 边；handoff = 4 participants / 4 handoffs。**四张图全部非空。**

**lowering 产物**（真实输出，site id 已注入）：

```js
const findings = await __host.ask("ask#1", __host.createActor("actor#1", "scanner"), "Find flaky tests");
const planner = __host.createActor("actor#2", "planner", "You plan fixes...");
const reviewer = __host.createActor("actor#3", "reviewer", { system: "You critique plans..." });
for (let round = 0; round < 5; round++) {
    const plan = await __host.ask("ask#2", planner, `Plan fixes. Feedback: ${feedback}`);
    const review = await __host.ask("ask#3", reviewer, `Critique: ${plan}`);
    if (review.approved) return plan;
}
```

**`ask<T>` → JSON Schema 真的合成出来了**（这是 R1 的正反两面证据）：

```json
"ask#1": { "type": "object", "properties": { "findings": { "type": "array", "items": {
  "type": "object", "properties": {
    "testId": { "type": "string" },
    "confidence": { "type": "number", "description": "0-1, how confident the scan is" }
  }, "required": ["testId", "confidence"], "additionalProperties": false } } },
  "required": ["findings"], "additionalProperties": false }
```

> **JSDoc 约束被 harvest 进来了**（`"description": "0-1, how confident the scan is"`）——
> 这正是 ZCode skill 里「JSDoc 成为子代理真读到的字段描述」那条规则的实现依据。
> 同时也证明：**没有完整 `ts.Program` + type checker 就拿不到这个**。

**引擎 + stub host 实跑**：run 正常终止 `status: completed`，journal 落下
4 条 `dwf_node`（ask#1 / ask#2 / world-read#1 / report#1）、2 条 `dwf_actor`、19 条 `dwf_event`
（`run-started → phase-entered → actor-created → node-queued → node-dispatched → usage-updated
→ node-settled → … → report → log → run-settled`）、`spentTokens: 14`。
**typed ask 把 schema 原样交到了 driver 手上**，submit verdict / actor session / world read 全部按预期触发。

> 附带收获：ZCode 的**编译期诊断 9006** 在 `planner-reviewer.ts` 上真实触发
> （"fan-out 里 actor 名固定会导致 DuplicateActorName"）——这层静态检查本身就是产品价值。

### V2 — dsh 能否携带 `typescript` 运行时依赖：✅ **可以**

| 环节 | 结论 | 证据 |
|---|---|---|
| 依赖怎么装 | 插件的 `dependencies` 由 **pnpm 装进 profile 目录**，`nodeLinker: hoisted` 扁平落到 `<profile>/node_modules` | `dsh-plugin-manager/lib/index.js:610-621`、`:712`；`pnpm-workspace.yaml:3` |
| bare import 解析顺序 | ① 插件自身 `node_modules` → ② profile 的 hoisted `node_modules`（物理存在即 native 命中）→ ③ installation runtime table（interception）→ ④ Node 默认 | `dsh-app-boot/lib/worker/profile-resolution-bootstrap.js:402-455`、`:515-532` |
| 有无体积上限 | **未找到 dsh 施加的任何包体积限制** | `dsh-plugin-manager` 内 `limit/size` 关键词只命中日志 `outputBytes` |
| `minimumReleaseAge` | 本机启用 = **1440 分钟（24h）**。它拦的是「刚发布 <24h 的版本」，**不拦大包**；`typescript` 最新版早已超过 24h | `.pnpm-workspace-state-v1.json` `minimumReleaseAge: 1440`；`dsh-client-ui-plugin-manager/lib/client.js:490` |
| Electron asar 影响 | **无**。asar 只打包 installation 自带包；插件及其依赖在真实磁盘上 | `D:\DeepseekHarness\resources\app.asar` 只含 `@deepseek-ai/*` |
| peer 依赖 | `autoInstallPeers: false` → peer 不会自动装。`typescript` 无原生构建，不涉及 `allowBuilds` | `pnpm-workspace.yaml:4-8` |
| `engines.dsh` 闸门 | 只针对 `@deepseek-ai/dsh*` 系列 peer range；把 `typescript` 放 `dependencies` 不受影响 | `dsh-app-boot/README.md:52`、`:56` |

> ⚠️ **一个必须处理的连带影响**：README 里那条「绕开 pnpm 供应链策略」的**手动安装路径**
> （`Copy-Item lib,public,samples,package.json,cordis.patch.yml`）**不拷 `node_modules`**，
> 引入 `typescript` 后这条路径对阶段 3 失效。阶段 1 不受影响。

### V3 — dsh 原生 workflow 子系统：**不是同一套东西**

dsh 自带 `dsh-tool-workflow`，但形态与 ZCode Dynamic Workflow **完全不同**：

| | dsh 原生 `workflow` tool | ZCode Dynamic Workflow |
|---|---|---|
| 模型面 | **一个** tool，名为 `workflow` | 10 个 tool（CreateWorkflow / AmendWorkflow / …） |
| 脚本 | **纯 JavaScript 正文** | TypeScript `.dwf.ts` |
| 可用 hook | 固定 6 个：`agent(prompt, opts?)`、`pipeline(items, ...stages)`、`parallel(thunks)`、`phase(title)`、`log(message)`、`args` | 完整 facade（21 成员） |
| 能力边界 | **"The script has no filesystem, network, timer, or Node.js APIs; the agents do the work."** | files / git / world.run / artifact / hole / escalate / amend |
| 执行隔离 | PTC 运行时（`dsh-workflow-ptc`），Node 进程隔离 | 进程内引擎 + 4 端口 |

证据：`dsh-tool-workflow/lib/index.js:60`（`name = "tool-workflow"`）、`:67`（`toolName` 默认 `"workflow"`）、
`:143-148`（hook 集合与「无 fs / 无 network / 无 timer / 无 Node API」声明）、`:270`（`ctx.tools.register`）；
引擎 Service `dsh-workflow/lib/index.js:59-62`（`class WorkflowEngine extends Service`），实现 `dsh-workflow-ptc/lib/index.js`（66 KB）。

**结论**：**本插件的能力面远超 dsh 原生 workflow tool**（后者只能编排 agent，不能读文件、不能跑命令、
不能出产物、不能中途问人）。所以本插件**不是**在重复造轮子，而是在补 dsh 的短板。
这反过来强化了阶段 1 的价值——**把这份能力暴露给模型**，才是它真正的用途。

### V4 — dsh 的注册契约（阶段 1 的实现依据）

全部为**本机已安装代码**的真实签名：

| API | 签名要点 | 证据 |
|---|---|---|
| `ctx.tools.register` | `defineTool({ name, description, parameters, output: { schema, render, presentationMeta? }, execute(args, exec) })`。`output.schema` **必填**（否则 `TypeError`）；`run_code` 是保留名；同 scope 重名注册失败 | `dsh-tools/lib/types/index.js:468-489`、`:462-467`；`dsh-tools/lib/types/schema.js:274` |
| `ctx.skills.register` | 注册**单个内存 skill**；未给 `invocation` 自动补 `{modelInvocable:true, userInvocable:true}`，未给 `provider` 自动补 `"runtime"`；同层同名 first-wins + warning；返回 effect disposer。skill 名必须 kebab-case | `dsh-skill/lib/index.js:193-215`、`:132`、`:17` |
| `ctx.skills.registerProvider` | 注册发现 provider（扫目录）。本机真实调用点：`dsh-skill-office/lib/index.js:101`、`dsh-skill-badge/lib/index.js:50`、`dsh-skill-filesystem/lib/index.js:47` | `dsh-skill/lib/index.js:147`、`:161` |
| `ctx.llm.resolveCallConfig` | `async (config, signal?) => config`。只**物化 adapter 默认值**（`maxTokens`、`reasoningEffort`），**不发起请求**；`prepareCall` 用于「日志 + 流式共享同一次 adapter 注册」 | `dsh-llm/lib/typert.host.js:250`；`dsh-llm/lib/index.js:2164-2176`、`:2183-2200` |
| `ctx.commands.register` | `{ name（小写）, description, input?: { hint, attachments }, definitionId?, handler({agent, rawInput}) → {kind:'success'|'error', text?} }` | `dsh-commands/lib/index.js:268`；`dsh-commands/README.md:32-46` |
| `ctx.webServer.register` | `{ kind: 'exact'\|'prefix', path, handler }`；重复 `(kind,path)` 抛错；匹配序 = 精确 → 最长前缀 → fallback | `dsh-host-webserver/lib/index.js:326-333`、`:348-350` |

**本仓库的改动点**：`lib/plugin.js:44` 当前是
`inject = ['webServer','authorization','credentials','llm','connection']`，
另有 `ctx.inject(['commands'])`（`:160`）、`ctx.inject(['settings'])`（`:223`）。
阶段 1 需要**追加 `'tools'` 与 `'skills'`** 两个 service 依赖。

> 参考本机真实可运行范例（工具注册）：
> `C:\Users\GGBOND\.dsh\profiles\desktop\node_modules\@deepseek-ai\dsh-tool-subagent\lib\index.js:172-196`
> （`defineTool` + `parameters` + `output.schema` + `output.render` + `execute(args, exec)`）

### V5 — 附带发现

- 本机 dsh 桌面端在 **`D:\DeepseekHarness`**（不在 Program Files），核心包全在
  `resources/app.asar\dsh\node_modules\@deepseek-ai\`（194 个包），形态是**已编译 JS**。
- 解析优先级是 **installation 优先，再 profile 的 node_modules**（`dsh/README.md:46`）——
  这解释了 `dsh-base` / `dsh-web-app` 为何不在 profile 的 `node_modules` 里。
- `zod` + `zod-to-json-schema` **已经在 profile 里**，ZCode 的工具 schema 依赖可直接满足。
- **本机 marketplace 状态里 `dsh-workflow-runner` 当前是 disabled**
  （`profiles/desktop/.dsh-market/state.json` → `{"disabled":["dsh-workflow-runner"]}`）。
  验证新版本前需要先在插件市场里打开。

### V6 — npm 发布的 403：账号只读状态

**现象**：`npm publish` 走完浏览器的 2FA 之后，PUT 才被 registry 拒绝：

```
npm error code E403
npm error 403 Forbidden - PUT https://registry.npmjs.org/dsh-workflow-runner -
npm error   Your account has been temporarily suspended due to a recent
npm error   security-sensitive action.
```

**根因**：npm 把「用 2FA 恢复码冒充 OTP」这类动作记为 security-sensitive action，并据此把账号
置入 **72 小时只读状态**——期间禁止发布、token 管理、包可见性变更与 org/team 变更。
`npm whoami` 仍然正常（读权限没挂），所以看起来像「token 没问题但发不上去」。

**处置**：
1. **等**。状态自动解除，不需要做任何操作。
2. **绝不要用恢复码去「修」**——每用一次就重新计时 72 小时。恢复码只用于**登录救急**，
   永远不要塞进 `--otp`。
3. 解封后直接 `npm publish --access public --auth-type=web`。版本号与 tag 都已就位，
   **不要重跑 `npm version`**——失败的 publish 之后再 `npm version` 会留下孤儿版本号和孤儿 tag。
4. 需要人工申诉：https://support.npmjs.com/ ，附上账号名和这条 403。

`scripts/publish-release.ps1` 识别这两种情况（账号只读 / EOTP 没拿到 2FA）并直接给出上面的
处置，而不是把原始 403 甩给你。

---

## 附录 A：证据索引

### A.1 本仓库

- `lib/runtime.js`（3,296 行）— 宿主侧手写引擎：run 状态机、子进程 spawn、stdio JSON-RPC
  dispatch、agent 会话历史、world.run/files/git、artifact、amend 注入、journal、落盘持久化、
  SSE 广播、tsc 转译 + typecheck、sandbox env 清洗
- `lib/runner-bootstrap.mjs`（1,129 行）— 子进程侧 facade 实现（`globalThis.__dsh` 21 个成员）
- `lib/plugin.js`（1,094 行）— cordis 宿主插件；`inject = ['webServer','authorization','credentials','llm','connection']`（`:44`）
- `lib/client.js` — 3 个 UI slot（`conversation.composer.dock` / `conversation.chat.turnTail` / `shell.overlay`）
- `lib/facade.d.ts`（317 行）— 21 个 facade 成员 + 20 个接口
- `public/editor.js`（1,610 行）— 编辑器 UI

### A.2 ZCode

- `packages/dynamic-workflow/src/index.ts` — barrel，导出 6 组公开 API
- `packages/dynamic-workflow/src/compiler/compile.ts:95,118,129` — `createWorkflowProgram` /
  `collectDiagnostics` / `compileWorkflowScript`
- `packages/dynamic-workflow/src/engine/types.ts:244,312,408,979` — 4 个注入端口定义
- `packages/dynamic-workflow/src/schema/synthesize.ts:43-48` — `ask<T>` 类型提取
- `packages/dynamic-workflow/src/lowering/lower.ts:56,71,81-91,145-318` — lowering 两遍法与产物契约
- `packages/dynamic-workflow/src/facade/dts.ts:9-12,19` — facade 单一事实源
- `packages/dynamic-workflow/src/projections.ts:1-12` — 浏览器安全桶
- `packages/dynamic-workflow/scripts/generate-libs.mjs` — TS stdlib `.d.ts` 闭包生成器
- `packages/contracts/src/tools/create-workflow.ts:15,78-87,88-157,552-599` — 工具契约与硬门禁
- `packages/contracts/src/tools/amend-workflow.ts:33,68-81` / `save-workflow.ts:29,66-70` / `eval-workflow-snippet.ts:22`
- `packages/bundled-skills/skills/dynamic-workflows/SKILL.md` — 创作契约全文（93KB）

### A.3 dsh 宿主（本机已安装代码）

- `D:\DeepseekHarness\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-tool-workflow\lib\index.js:60,67,143-148,270` —
  dsh 原生 workflow tool（单 tool、固定 6 hook、无 fs/network/timer）
- `…\dsh-workflow\lib\index.js:59-62` — `WorkflowEngine` Service 定义；实现见 `dsh-workflow-ptc`
- `…\dsh-tools\lib\types\index.js:462-489` — `ctx.tools.register` 契约
- `…\dsh-skill\lib\index.js:17,132,147,193-215` — `ctx.skills.register` / `registerProvider`
- `…\dsh-llm\lib\typert.host.js:250` + `dsh-llm/lib/index.js:2164-2200` — `ctx.llm.resolveCallConfig`
- `…\dsh-commands\lib\index.js:268` — `ctx.commands.register`
- `…\dsh-host-webserver\lib\index.js:286,326-350` — `ctx.webServer.register`
- `…\dsh-app-boot\lib\worker\profile-resolution-bootstrap.js:402-532` — bare import 解析顺序
- `…\dsh-plugin-manager\lib\index.js:610-621,712` — 插件依赖装进 profile 的 pnpm 调用
- `…\dsh-app-boot\README.md:46,52,56,138` — installation-first 解析、版本闸门、"Runtime resolution creates no links"

---

## 9. 可复现物

### 9.1 spike 工作区

`.spike/zcode-engine/`（已 gitignore，可随时重建）：

```
├─ spike-src/src/          121 个 .ts（上游 120 + 生成的 libs.generated.ts），22,991 行
├─ scripts/generate-libs.mjs   唯一改动：输出路径
├─ dist/                   363 个文件（121 .js + 121 .d.ts + 121 .d.ts.map）
├─ tests/                  上游测试语料副本
├─ spike.mjs               端到端：compile → analyze → lower → schema → engine run
├─ stub-host.mjs           手写 stub host（4 个端口）
├─ verify-goldens.mjs      lowering 黄金逐字节比对
├─ spike-output.txt        完整运行日志
├─ spike-evidence.json     结构化证据
└─ FINDINGS.md             完整测绘结论（39 KB）
```

复跑：

```powershell
cd .spike/zcode-engine
npm install                 # typescript + @types/node + vitest（与上游 devDeps 同版本）
npm run build               # = node scripts/generate-libs.mjs && tsc   → exit 0
node verify-goldens.mjs     # 13/13 降级黄金逐字节一致
npx vitest run tests        # 38 files / 1983 tests 全绿
node spike.mjs              # 端到端
```

> `spike-src/src` 通过一个 **junction**（`<spike>/src` → `<spike>/spike-src/src`）暴露给上游测试，
> 因为上游测试用相对路径 `../src/...` 引用包源码。junction 不复制文件，改源码即时生效。

### 9.2 本文档

- 本文件：差距分析 + 移植方案 + 验证结论
- `.spike/zcode-engine/FINDINGS.md`：ZCode 引擎侧的详细测绘（端口清单、隐式期待、映射表、Top-5 风险）
