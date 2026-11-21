# 会话任务结果 Artifact、预览、全屏与下载设计规格

- 日期：2026-11-15
- 状态：设计已确认；已吸收独立评审与实施计划复核，并于 2026-11-19 同步首请求工具时序、Artifact 提交边界、HTML 导航隔离和全屏参数的技术勘误；实施计划为 `docs/superpowers/plans/2026-11-15-task-result-artifacts.md`，尚未实施
- 基线：外层仓库 `a423eef9fc048fa6b50d8c8047dc188f32a8369b`；`deepseek-harness` pin `1600d8a1e140dcde43a1a0941940a0480712c011`（`0.2.1-rc.1`）；技能与进度前置已合并
- 范围：HuaAnWork 高级模式中普通会话与 agent 自动化会话的可交付结果 Artifact、会话结果卡、右侧“预览”、独立全屏窗口和本地下载
- 约束：产品源码只改 `dsh-plugin-huaanwork/` 及必要的自有共享包 `packages/huaanwork-policy/`；允许同步本规格、对应计划与验收证据、依赖锁文件 `yarn.lock`，以及 `.github/workflows/ci.yml` 的 Artifact 专用图形探针步骤；不修改 `deepseek-harness/`，不调整无关 CI 或安全权限

## 1. 背景与结论

当前自动化运行对话已能把整段 JSON 助手结果折叠为“结果.md”和“结果.html”两份附件，并在右侧“预览”中展示：

- `logic/runResultAttachments.ts` 负责折叠；
- `logic/runResultRender.ts` 负责 JSON → 块树 → Markdown/HTML；
- `App.tsx` 保存 `previewFile` 并渲染右侧预览；
- `electron-shell-generation.ts` 对两个固定文件名执行下载目录落盘。

该实现的边界是：仅覆盖自动化 JSON 结果、一次生成两份固定附件、Markdown 预览只显示源码、HTML 禁止脚本、没有全屏、下载不弹保存框且同名覆盖。

本需求需要把“结果页”提升为宿主管理的持久化 Artifact。仅在客户端增加消息折叠和按钮，无法统一解决历史恢复、大正文传输、安全隔离、原始字节下载和独立窗口生命周期。

评审复核还确认了两个必须在协议层消除的冲突：

1. `result_present` 的 `content` 若进入普通工具卡参数展示，会把完整正文重新铺进会话。
2. 新自动化 JSON 封套若仍进入旧 `foldRunAssistantItems`，会同时产生新 Artifact 与旧双附件。

因此，“统一结果页”必须同时覆盖生产、呈现、历史回填和旧折叠退出条件，而不只是新增存储与预览组件。

## 2. 目标与非目标

### 2.1 目标

1. 普通交互会话与 agent 自动化会话的可交付任务结果使用同一种 Artifact 元数据、结果卡和预览能力。
2. 每项结果只生成一张可点击页面卡片；正文不得通过工具参数卡或旧双附件再次铺开。
3. 结果格式通过结构化字段声明，并由宿主白名单校验；前端不负责猜测类型。
4. 点击结果卡后留在当前会话，在右侧“预览”展示实际渲染内容。
5. Markdown 显示渲染结果；HTML 支持沙箱内 JavaScript 交互。
6. “全屏”打开新的受控 Electron 全屏窗口；“下载”通过系统保存对话框保存原始内容。
7. 刷新、重连和重新打开历史会话后，Artifact 仍可读取和确定性定位。
8. 普通问答、中间思考、工具日志和进度消息不强制生成 Artifact。
9. 普通交互工具提交与自动化终态适配互不重复；同一次工具调用和同一自动化运行各自最多产生一个 Artifact。

### 2.2 非目标

- 不为所有助手消息生成页面；只处理明确提交的可交付结果。
- 脚本自动化没有运行对话，一期不生成会话 Artifact，也不改变其 32 KiB 输出截断和运行记录展示。未来若支持脚本 Artifact，必须在 `runScript` 的 `clipOutput` 之前采集完整封套，不能使用已截断 output。
- 包儿童会话不直接生成 Artifact；智能体包的最终结果由父会话统一提交。
- 不支持 PDF、Office、图片或其他新格式；既有文件预览能力不被替换。
- 不允许模型指定任意文件路径、远程 URL 或本地资源读取路径。
- 不允许 HTML 访问 Node、父页面、应用同源数据、任意网络或本地文件。
- 不整体替换为上游 deliverables/documentpreview 会话体系。
- 不批量迁移或重写既有历史消息；旧自动化附件保留兼容读取。
- 不承诺下载后的 HTML 在本机浏览器中仍处于应用沙箱内。

## 3. 已确认的产品裁定

| 编号 | 裁定 |
| --- | --- |
| R1 | 采用“结构化声明 + 宿主校验”，格式字段只允许 `markdown` 或 `html` |
| R2 | HTML 允许在隔离沙箱中执行内联 JavaScript，以支持图表和交互 |
| R3 | 全屏使用新的受控 Electron `BrowserWindow`，不使用未受控 `window.open` 或 `file://` |
| R4 | 下载使用系统“另存为”对话框，保存宿主持久化的原始字节；不经过 renderer 下载事件 |
| R5 | 宿主保存 Artifact 正文与元数据；WebSocket 事件只携带摘要，正文按需读取 |
| R6 | 普通交互父会话使用 `result_present`；agent 自动化只使用运行终态封套，两条生产路径互斥 |
| R7 | 自动化适配在运行摘要截断前采集；幂等键为 `automationId + runId`，不引入未定义的 `resultRevision` |
| R8 | 新协议运行不再进入旧 JSON 双附件折叠；只有无 Artifact 的历史运行才走旧逻辑 |
| R9 | 包儿童与自动化会话不向模型暴露 `result_present`；普通父会话通过会话附件获得该工具 |
| R10 | 全屏窗口使用同源内部启动参数和独立 Artifact 页面，不新增 URL router，不加载业务 preload |

## 4. 方案取舍

| 方案 | 优点 | 主要缺陷 | 结论 |
| --- | --- | --- | --- |
| A. 宿主持久化 Artifact + 统一预览适配器 | 单一内容源；支持历史、下载、全屏和统一安全策略 | 需要新增协议、存储和原生接线 | **采用** |
| B. 仅在前端把消息转换为 `srcDoc`/Blob | 初期改动少 | 正文重复进入消息状态；历史锚定、大小控制和下载真实性较弱 | 排除 |
| C. 整体接入上游 deliverables/documentpreview | 上游能力完整 | 与自研 App、会话历史和右栏组合差异大；仍需处理自有自动化与 Electron 约束 | 本期排除；可按公开包边界复用渲染组件 |

## 5. 统一 Artifact 协议

### 5.1 普通交互提交入口

新增模型工具 `result_present`，只用于普通交互父会话形成可交付结果时提交一次最终页面。输入：

```ts
type ResultPresentInput = {
  title: string;
  format: "markdown" | "html";
  content: string;
  downloadName?: string;
};
```

`sessionId`、回合锚点和工具 `callId` 由宿主从执行上下文绑定，模型不得填写。

宿主在执行时校验运行时输入（TypeScript 类型不构成验证）：`title` 必须是非空单行字符串（不含 `\n`/`\r`），`format` 只允许 `markdown` 或 `html`（任何第三种值一律拒绝），`content` 必须是字符串，`downloadName` 若提供必须是字符串。任一校验失败不生成 Artifact、不发送 `artifact/created`，返回紧凑错误码，不展开提交正文。

工具 `description` 逐字包含以下五条模型指引，不得改写或合并：

```text
- 报告、分析、列表、表格、代码说明和线性文档优先使用 Markdown；
- 需要非线性布局、图表或交互的可视化结果使用 HTML；
- 普通对话答复不调用该工具；
- 同一交付物只提交一次，不同时提交两种格式；
- 工具成功后的最终助手回复只给简短说明，不重复完整 content。
```

工具注册与工具可见性分开处理：`result_present` 通过现有 `huaanworkAttachments` 挂载到普通交互父会话，利用 `ALLOWED_TOOLS ∪ 会话附件` 的现有计算生效。它不得全局常驻到自动化或包儿童会话，也不得因加入某个全局 allowlist 而突破包血缘收窄。

附件生命周期与统一回合锚点同步（见 §6.1）。

### 5.2 元数据

```ts
type TaskArtifactSummary = {
  artifactId: string;
  sessionId: string;
  title: string;
  format: "markdown" | "html";
  downloadName: string;
  sizeBytes: number;
  sha256: string;
  createdAt: string;
  anchor:
    | { kind: "turn"; clientMessageId?: string }
    | { kind: "automation-run"; automationId: string; runId: string };
};
```

事件只发送 `TaskArtifactSummary`。`content` 不出现在 `artifact/created` 事件中，由预览、全屏和下载分别按需读取。

回合锚点一律来自进度计划 Task 1 建立的独立共享模块 `huaanwork-host/turn-anchors.ts` 的 `TurnAnchorStore`（经 `holders.ts` 注入 `ctx.huaanworkTurnAnchors`），其条目形状为 `TurnAnchor = { clientMessageId: string; startedAt: string; origin: 'advanced' | 'automation' | 'unknown' }`。`clientMessageId` 的生成契约：普通高级会话中，App 每次 `session.send` 都新生成 `const clientMessageId = crypto.randomUUID()` 并在消息顶层发送，Host followup 直接使用该 UUID 作为 `UserMessage.id`；自动化回合由 `runAgentTurn` 直接以 `runId` 作为顶层 `clientMessageId`（run-start 的 user item 记录同一 runId，`origin='automation'`），不使用随机 UUID。Host 侧取 `UserMessage.id = 顶层 clientMessageId ?? crypto.randomUUID()`；旧客户端消息缺顶层字段时由 Host 现场生成 UUID，绝不用 `at.clientMessageId` 兜底（避免与渲染 allocId 重复 MessageId）。`ChatItem.id` 仍用渲染侧 allocId，`user.clientMessageId` 单独存放 UUID（`HistoryChatItem`/`ChatItem` 的 user 均携带），不得用 `String(userMsg.id)` 充当持久 clientMessageId（刷新后 allocId 会重复）。既有 `at.clientMessageId` 数值字符串仅作 legacy 展示兼容，不参与任何精确匹配；Artifact、todo、system-skill 的精确匹配一律使用新 UUID（自动化回合则用 runId）。同步 claimed 监听在 schema 采集前用真实消息调用共享 notePreStep，既有 pre-step 再幂等复核 anchor；goal 续轮保留原 anchor 的 `clientMessageId` 与 `origin`。本规格与该模块的关系仅为 import 消费：不复制另建锚点实现、不依赖 ProgressPanel 的 Tasks 2-4；该共享模块已在本基线合并可用。读取不到 anchor 时，仅允许升级前已在途且附件仍合法的提交退化为 `{ kind: 'turn' }`，历史结果进入未定位分组；compat/unknown 新回合必须在同步 claimed 监听中、首请求 schema 采集前摘除工具，不得借该回退新产出 Artifact。`TurnAnchorStore.register` 在 followup 抛错时必须清理已登记的 pending 状态，且 `pending` 与 `anchors` 容器都要有界，不得无限增长。

历史定位规则是本协议新增规则，不引用不存在的既定回退：

1. 普通会话存在 `clientMessageId` 且历史中能命中用户条目时，Artifact 卡插在该用户回合末尾，即下一条用户消息之前；没有下一条用户消息时位于正常会话内容末尾、“未定位的历史结果”分组之前。该尾部分组不属于最后一个用户回合；新增普通消息也不得追加到该分组内部。
2. 自动化使用 `automationId + runId` 精确匹配运行会话，结果卡位于运行结束脚注之前，与旧附件的位置一致。
3. 精确锚点缺失时，将结果集中到会话末尾的“未定位的历史结果”分组，并保留标题与时间；不得按正文相似度、名称或时间接近程度猜测回合。
4. 实时回合仍优先使用当前 `clientMessageId` 精确插入；`artifact.list` 对账也遵循上述规则，不因快照到达而改挂到最后一条用户消息。

### 5.3 持久化与幂等

Artifact 存放于当前 Profile 的应用数据目录，使用宿主生成的 ID：

```text
artifacts/<sessionId>/<artifactId>/manifest.json
artifacts/<sessionId>/<artifactId>/content.md | content.html
```

路径中的会话和 Artifact ID 必须是单路径段；模型标题和下载名不得参与目录定位。

下载名清理修正：将 Windows 非法字符 `< > : " / \ | ? *`、控制字符（`0x00-0x1F`）与路径分隔符统一替换为 `-`；Windows 保留设备名按首个点之前的名称识别（`CON.txt`、`com1.log` 等同样视为保留名），命中时加安全前缀；最终强制扩展名与 `format` 一致（`markdown → .md`、`html → .html`），模型传入的其他扩展名一律改写。大小预算使用 `Buffer.byteLength(content, 'utf8')` 计量，正确处理中文、emoji 等 UTF-8 多字节字符边界，不按字符串长度估算。

写入采用准备/提交两阶段，将所有权 lease、暂存和提交状态合入一个不透明 `ArtifactWrite`，不向调用者暴露临时或最终路径：

```ts
type ArtifactWriteScope = Pick<ArtifactInput, 'sessionId' | 'anchor' | 'idempotency'>
function beginArtifactWrite(profileDir: string, scope: ArtifactWriteScope): ArtifactWrite
function prepareArtifact(write: ArtifactWrite, input: Omit<ArtifactInput, keyof ArtifactWriteScope>): Promise<void>
function commitPreparedArtifact(write: ArtifactWrite): Promise<{artifact: TaskArtifactSummary; created: boolean}>
function discardPreparedArtifact(write: ArtifactWrite): Promise<void>
```

`ArtifactInput` 为宿主绑定的 scope 加 title/format/content/downloadName；上面仅列接口。begin 同步登记活跃 lease、捕获不可变 scope，不做 I/O。prepare 校验输入，只在同文件系统内、会话 Artifact 最终目录之外的隐藏暂存根写全并验证实际字节/sha256；不创建 `artifacts/<sessionId>`、不进入 list、无事件。commit 在 profile 锁内先重验 lease，再查幂等、复验数量和准备结果，最后原子 rename。lease 失效须优先报 `artifact-owner-deleted`，不能因有旧幂等记录而绕过。初始预算为单 Artifact 5 MiB、每会话 100 个；超限拒绝，不截断或淘汰。

discard 幂等清理暂存并释放 lease，已 commit 时不删除正文；清理 I/O 失败仍在 finally 释放 lease，错误向调用者报告。映射仅存活跃句柄，最后一个 lease 释放后删除映射，不存永久 tombstone。删除时的失效规则见 §9。普通 `createArtifact(profileDir,input)` 组合 begin→prepare→commit→finally discard，保持返回 `TaskArtifactSummary`，不自行 emit；需控制事件的生产者直接使用两阶段返回的 created 判定。

幂等规则：

- 普通工具提交：`sessionId + callId`；同一调用返回原 Artifact。
- agent 自动化：`automationId + runId`；锁内裁决（不能先 find 后无锁写入），并发重放最多一份正文。
- commit 新建返回 `created:true`、复用返回 `created:false`；只有 true 的生产者 emit 一次 `artifact/created`，prepare 永远不 emit。
- 事件与列表快照按 artifactId 去重，不按标题或内容相似度去重。

## 6. 普通会话与自动化适配

### 6.1 普通交互会话

1. 模型在交付结果形成时调用 `result_present`。
2. 宿主校验并持久化，发出 `artifact/created`。
3. 客户端在当前回合插入一张 `ResultArtifactCard`。
4. 工具结果只返回 `artifactId` 与简短成功信息（含 `artifactId` 文本），不把完整正文再次复制进会话。
5. 实时 `tool/start/tool/end` 和历史 `tool-call/tool-result` 投影遇到 `result_present` 时均不得进入普通 `ToolPanel`；参数中的 `content` 不得渲染为 `<pre>` 或进入其他通用参数详情。
6. 成功时只显示 Artifact 卡；失败时显示紧凑的工具失败摘要和可重试提示，仍不得展开完整提交正文。

附件生命周期在同步 `agent/inbox/claimed` 通知中与 `TurnAnchorStore.origin` 同步。基线 `core/agent-loop/src/inbox.ts:109-113` 逐消息同步 emit，`agent.ts:271-272` 在 claim 后即 assemble；pre-step 已晚于 schema 快照，不能用它实现首请求工具可见性。`makeResultPresentClaimed` 消费真实 `{agent,message}`，缺 sessionId 直接 return；同步调用共享 `notePreStep(sessionId,[message],now)`，仅 advanced 挂载，automation/unknown（含兼容新回合、未 register 包儿童）摘除，状态变化才调用 `refreshAgentRestrict(ctx as never,sessionId)`。不得 async、不得改普通全局 allow、不得修改 `turn-anchors.ts`。

已 register 但未 claim 的排队消息不改变当前 anchor/附件；goal 无新用户时继承原 anchor，附件保持。与 bridge 通过同一 notePreStep 入口幂等重入，相同状态不重复 refresh；既有 pre-step 锚点记录及 `return next()` waterfall 链仍保留，但不承担附件同步。通知异常会被分发器吞掉，处理器 catch 必须执行 `agent.cancel({kind:'hook',reason:'result-present-attachment-sync-failed'})`，利用真实 AgentCancelCause 中止 driver，不能靠 throw 声称阻断模型请求。工具执行体仍检查 attached；成功只在 commit 返回 created:true 时发事件，重放只返回原摘要。

校验或写盘失败不发送成功事件，原任务的普通助手说明和错误提示仍按现有会话规则保留。

### 6.2 agent 自动化：唯一生产者为终态封套适配器

自动化会话不向模型暴露 `result_present`，因此不存在“运行中已提交、运行结束又提交”的第二条生产路径。无人值守工具白名单也无需加入该工具。

新协议封套为：

```ts
type AutomationResultEnvelope = {
  schemaVersion: 1;
  type: "huaanwork.task-result";
  title: string;
  format: "markdown" | "html";
  content: string;
  downloadName?: string;
};
```

提示契约的唯一注入点为 `automations-host.ts` 的 `runAgentTurn`：在现有 `mergedPrefix` 与 `automation.prompt` 拼接之后、外层 `<automation-fire>` 封装之前，固定追加 `<task-result-contract>` 文本段。manual/schedule/catchup、有人值守和无人值守的 agent 自动化都经过该函数；普通交互会话不经过，脚本自动化不经过。

注入文本固定为：

```text
<task-result-contract>
若形成可交付任务结果，最终可见输出必须且只能是一个 JSON 对象，不要输出 Markdown 代码围栏或任何解释文字。
对象形状为 {"schemaVersion":1,"type":"huaanwork.task-result","title":"简短标题","format":"markdown 或 html","content":"完整结果内容","downloadName":"可选文件名"}。
content 必须是 JSON 字符串；format 只能使用 markdown 或 html；同一结果只提交一次。
若不生成 Artifact，则保持原有输出，不得输出 huaanwork.task-result 标记。
</task-result-contract>
```

生产与提取规则：

1. 自动化提示契约要求整段最终可见输出只包含一个封套 JSON；不得在前后附加解释文字。
2. `executeRun` 确定 agent 的 sessionId 后，在首个 await 前同步 beginArtifactWrite（queued 取消早退不建）；lease 覆盖整个执行和结算，不能在 collector/scheduler 释放后才建立。获得完整 collector 文本后、finishAutomation 和摘要截断前调用 `prepareAutomationResult(write,fullText)`；只返回 prepared(title/format)、failed(error/可确认元数据) 或 skipped，不 commit、不 emit。不得使用已截断 RunSummary.output。executeRun 所有出口 finally discard/release，不延长 collector/scheduler 生命周期。
3. collector 的可见 token 拼接只作为“整段封套”的输入，不尝试从多段说明文字中猜测最后一条消息。`stripModelThinking` 后， trim 整体必须是唯一合法 JSON 封套。
4. 带 `type="huaanwork.task-result"` 或 `schemaVersion` 标记但校验失败时，报告结果协议错误，不生成 Artifact，也不把它降级为旧 JSON 文档。
5. 没有新协议标记的整段 JSON 对象/数组走兼容路径：复用现有 JSON → 块树 → Markdown 纯函数生成一个 Markdown Artifact。普通文本不生成 Artifact。
6. 已取消可跳过 prepare，但必须在 prepare 返回后、finishAutomation 同步构建 RunSummary 前重新读 cancel，紧接构建 summary，中间无 await。这是唯一冻结点（保留 `2026-10-21-automation-result-preview-design.md:103`）；原 executeRun 尾部停止覆盖移到此处。冻结为 cancelled 时 discard，不 commit/emit、不写任何 artifact 字段；prepare 等待中到达的 stop 也如此。
7. finishAutomation 的 run 参数增加 `artifact?:{write,preparation}`。冻结为非取消且 prepared 才 commit；同一 automationId/runId 在 profile 锁内重验 lease/幂等/数量，新建 created:true 才 emit，复用 created:false 不重复发布。summary 构建后的 commit/append 等待中 stop 仍返回 stopped:true，但不改变冻结记录；落盘并摘 inFlight 后 stop 返回 false。summary 之后不再读 cancel，markAutomation 和任务状态使用冻结 ok/status。
8. 新封套合法或兼容 JSON 转换成功，但准备或提交失败时，不发 artifact/created；在未冻结为取消的 summary 中写 artifactOutcome=failed、稳定 artifactError（删除失效保留 artifact-owner-deleted）、已验证 title/format，不带正文，不改变冻结的执行 ok/status。坏标记封套不可确认 title/format，字段缺席，错误卡回退“任务结果 / 未知格式”。discard 失败须显式记录错误且释放 lease，不吞掉，也不能阻断权威 summary 结算或原 admission/inFlight 清理。

脚本自动化不进入上述流程。其既有 stdout 采集和截断保持不变；未来扩展必须另设 `clipOutput` 前的完整封套采集点。

### 6.3 新旧折叠互斥与保存失败

Artifact 提交结果和运行记录必须先于 automation/run-end 建立可查询关联：成功记录 artifactOutcome=created + artifactId，失败记录 artifactOutcome=failed + artifactError（外加可确认的 artifactTitle/artifactFormat）。run 参数传 write/preparation，不传提前 emit 的 created 结果；finishAutomation 在同步冻结执行 summary 后完成取消丢弃或非取消提交，由此构造唯一 artifactFields，写入同一 summary 并展开至 run-end，不能分别重算。取消或 skipped 不写任何 artifact 可选键；存储失败不改冻结 ok/status，后续 markAutomation 与任务投影也不得回读取消标记。

客户端实时路径用事件构造 run、历史路径用 RunSummary，走同一投影。仅 commit.created=true 发一次 artifact/created，可按 runId 暂存；created=false 重放不发。准备阶段永无事件；保存失败的错误卡只能来自 run-end/RunSummary 字段。保持 appendRun 落盘后 finally 摘 inFlight 的既有次序，不能为 Artifact 延后停止冻结点。

客户端实时与历史路径共用以下判定：

1. 当前运行 `artifactOutcome="created"` 且 Artifact 可读时，移除原始封套/兼容 JSON 助手气泡，在旧附件本应出现的位置插入唯一 Artifact 卡；不得再调用旧双附件折叠。
2. 实时收到 `artifact/created` 时可先按 `runId` 暂存摘要，在 `run-end` 使用同一投影完成替换，避免原始封套长期停留。
3. `artifact/created` 事件丢失时，通过运行记录或 `artifact.list` 补齐；不得因事件缺失回退成双附件。created 事件与 `artifact.list` 快照按 `artifactId` 去重，同一运行只渲染一张卡、不重复 emit。
4. 当前运行 `artifactOutcome="failed"` 时，同样收起原始封套/兼容 JSON，显示只含标题（缺失时为“任务结果”）、格式（缺失时为“未知格式”）和错误码的“结果页保存失败”卡，不生成旧附件，也不展开完整正文。Artifact 已创建但内容暂不可读（加载竞态、瞬时读失败）时显示占位卡与“重试”按钮；重试仍失败按永久失败收敛为上述无正文错误终态，不无限停留原封套、不回退旧附件。该读取失败仅是客户端展示状态，不写回 `RunSummary`，也不把已创建的 outcome 改成 `failed`。原始输出仍按既有运行记录的截断规则保留；历史回填根据同一失败标记显示相同错误卡。
5. 只有没有 `artifactOutcome` 的既有历史运行才调用 `foldRunAssistantItems`，生成旧的“结果.md / 结果.html”。新协议运行无论 Artifact 保存成功或失败，都不得进入旧折叠。
6. 历史读取不得静默创建 Artifact 或改写失败标记；新结果及失败结果只能由运行时的宿主适配产生。

## 7. 会话结果卡与预览

### 7.1 结果卡

卡片展示标题、格式徽标、生成时间和大小，整卡可点击。点击后：

1. 保持当前会话标签；
2. 展开右侧栏；
3. 切换 `rightTab="preview"`；
4. 将当前标签的预览选择设为 `artifactId`；
5. 通过 `artifact.get` 读取元数据，通过 `artifact.content` 读取正文。

不为每个结果自动打开右栏，避免任务完成时打断用户当前操作。`result_present` 不产生第二张通用工具卡，自动化新协议也不产生旧双附件卡。

### 7.2 Markdown

新增本地 `ArtifactMarkdownView` 适配层。依赖策略为：

- 只通过 `@deepseek-ai/dsh-client-ui-primitives` 的正式包公开导出复用 Markdown 能力，不使用相对路径引用上游源码；
- 在桌面包显式声明依赖，并验证当前 pin 的导出、CSS modules、Katex/Shiki 资源和 Vite 构建兼容性；样式资源随应用本地打包，不运行时访问公网；
- 若当前公开导出不能承载该适配层，则在本树实现受控 Markdown 子集渲染器，覆盖标题、段落、列表、表格和代码块；不得为复用而修改上游子模块。

渲染安全默认值：远程图片（`http(s)` img）默认禁止自动加载。适配层先使用显式声明的同版公开依赖 `mdast-util-from-markdown/gfm/math` 与 `micromark-extension-gfm/math` 解析 AST，先建立 definition 表，再按节点位置移除 HTTP(S) `image` 和解析后目标为 HTTP(S) 的 `imageReference`，最后交给包根导出的 `MarkdownText`。引用标识按上游规则归一化，重复 definition 首个生效；只替换图片节点，保留共享 definition 的普通链接。不得读取不存在的 `imageReference.url`，不得在浏览器插入 DOM 后才隐藏图片，也不用正则猜测 Markdown 结构，不引用 npm 发布包未包含的上游 `src/*` 文件。GFM、表格、数学和 fenced code 原文必须保留。正文中的 `http(s)` 链接仍走既有安全打开流程，不内联展开、不自动导航。

适配层还负责：

- 禁用或安全处理原始 HTML；
- 链接、代码块和表格的统一展示；
- 不默认读取任意本地图片路径；
- 渲染失败时显示错误和可用的原始下载入口。

### 7.3 HTML

HTML 在 `sandbox="allow-scripts"` 的 iframe 中展示。禁止添加 `allow-same-origin`、`allow-top-navigation`、`allow-popups`、`allow-forms`、`allow-modals` 或 Node 能力。

CSP 与 sandbox 不阻止 iframe 自身导航，必须另设 Artifact 专属的 Electron frame 导航防护。父页面先创建带随机名称的空 about:blank iframe，调用带双 ID 和 surface 的 `artifact.prepareFrame`；原生端只登记对应 WebContents 中该名称的唯一空直属子 frame，按稳定 `frameTreeNodeId` 识别它及其后代。防护确认成功后才移除 src 并写入带 CSP 的 srcDoc；任何准备失败都不得释放模型 HTML。防护仅允许这次可信的空 frame→srcDoc 引导，随后在请求发出前拒绝该 frame 的文档导航，包括脚本自导航、普通链接、meta refresh 和重定向入口；改写 window.name 不得解除防护。主窗口和全屏均使用同一实现，不能用全应用禁网替代，关闭/移除 frame 后回收状态。

统一 HTML 引导层在任何模型内容前注入 CSP，至少保证：

- `default-src 'none'`；
- `connect-src 'none'`、`form-action 'none'`、`object-src 'none'`、`frame-src 'none'`；
- 只允许内联脚本、内联样式和受控 data 图片/字体；
- 不加载远程脚本、样式、图片或字体。

沙箱是安全边界，CSP 是网络与资源的纵深限制；不使用 HTML 字符串清理替代沙箱。本节的无远程依赖断言只覆盖 Artifact 渲染 iframe 与其新增渲染资源（Markdown 适配器引入的 Katex/Shiki/CSS）；既有应用外壳（含 shell 现有 Google Fonts 引用）不在本期本地化范围，不假装已本地化。

## 8. 全屏与下载

### 8.1 独立全屏窗口

点击“全屏”调用宿主/原生桥接，由 Electron 创建新的 `BrowserWindow`：

- `fullscreen=true`，并提供窗口内关闭按钮和 Esc；
- `nodeIntegration=false`、`contextIsolation=true`、`sandbox=true`、`webSecurity=true`；
- 不加载业务 preload；
- 不直接 `loadURL(file://...)`，不把模型 HTML 作为拥有应用权限的顶层文档。

加载机制固定为：复用主窗口同源 webserver URL，增加 `artifactWindow=1&sessionId=<sessionId>&artifactId=<artifactId>` 启动参数；两项 ID 来自已校验的 Artifact 摘要并分别编码。客户端启动时识别该参数，只渲染 `ArtifactFullscreenPage` 及其工具栏，按双 ID 调用读取和下载接口，不进入完整主 App 视图；无需引入 URL router，也不新增跨会话扫描反查。启动参数不是授权凭据，错配双 ID 必须失败。

新窗口的 RPC 访问不能依赖业务 preload。Electron 主进程必须把现有 renderer access header 的注入/校验显式覆盖到该窗口或其受限 session，并复用 same-origin frame 校验。`artifactId` 只用于选择内容，宿主仍须执行 Profile、会话和 Artifact 归属校验。

全屏页面使用与右侧预览相同的 Markdown/HTML 沙箱渲染器。一期使用单例窗口和该窗口独占的非持久 Electron session，不与主窗口共享 webRequest listener。打开请求串行处理；切换 Artifact 时保留同一 WebContents，先加载无业务内容的 `about:blank`，释放旧访问头 listener，再鉴权、安装新 listener、加载新的双 ID 启动参数并聚焦。只有业务 URL 的每次 loadURL 需要此前完成鉴权；about:blank 仅用于撤下旧页面。鉴权或加载失败必须清理本次 listener 和窗口，不恢复旧结果、不影响主窗口；关闭及 Host/Runtime teardown 同样释放窗口、frame 防护与 listener。

### 8.2 下载

点击“下载”后：

1. 通过专用宿主 RPC 按 `artifactId` 读取原始字节和元数据；
2. 清理下载名中的路径分隔符、控制字符和平台保留名；
3. 强制扩展名与 `format` 一致；
4. 调用系统 `showSaveDialog`，对话框的 parent 必须是发起请求的窗口（全屏窗口内发起的下载不得以主窗口为 parent）。下载 RPC 严格校验 `surface: "main" | "artifact"`：主窗口传 `main`，`artifactWindow=1` 页面传 `artifact`；原生侧据此选择主窗口或已登记的单例 Artifact 窗口。Artifact surface 对应窗口已不存在时返回 `artifact-window-unavailable`，不得回退主窗口；
5. 用户确认后原子写入所选位置，取消则不创建文件；
6. 已存在文件由系统保存对话框执行覆盖确认。

`artifact.download` 的客户端 HTTP 请求和 `native:saveArtifact` 均按交互式等待处理，不使用固定 180 秒超时，也不全局延长其他 RPC；保存框停留超过三分钟后，确认仍返回实际保存结果，取消仍返回零写入结果。真实连接错误仍须显示为错误，不伪装为用户取消。

该流程不得创建 Blob `<a download>`，因此不会触发主窗口的 `will-download`。旧“结果.md/结果.html直接覆盖下载目录”的特殊分支只服务旧附件；即使新 Artifact 使用相同下载名，也不能被旧拦截器接管。

下载不得序列化预览 DOM，也不得把 sandbox 注入代码或引导样式写入交付文件。保存字节与宿主持久化的原始字节逐字节一致（含中文、emoji、BOM、CRLF 边界），不重新编码、不做行尾归一化。

## 9. 生命周期与级联清理

清理必须接在共享 store/删除原语，而不是只接路由 handler：

| 删除动作 | Artifact 行为 |
| --- | --- |
| 普通 `session.remove` | 删除该会话全部 Artifact |
| `deleteAutomationRun` | 删除该 `automationId + runId` 的 Artifact；`RunSummary.sessionId` 存在时直接定位该会话目录精确删除 |
| `automation.remove` / 共享 `removeAutomation` | 删除该自动化全部运行及会话 Artifact；运行会话可能已不存在时允许扫描 artifact manifest，只按 manifest 内的自动化锚点（`automationId + runId`）精确匹配，不按标题、下载名或目录名猜测 |
| `project.remove` → `removeAutomationsOfProject` | 通过同一自动化删除原语清理，不另写漏路径 |
| `pruneAutomationSessions` 删除某运行会话 | 同步删除该会话 Artifact；保留的运行记录不承诺仍可打开完整结果页，与既有“早期运行可能无完整会话”语义一致 |

删除与 commit 使用同一 profile 锁。removeArtifactsOfSession 在进入锁后、删除 I/O 前失效所有 session 匹配的活跃 write lease，并在锁内 finally、退出锁前再次失效，覆盖删除 I/O 等待中新 begin 的 write；最终目录不存在或删除失败也必须执行。begin 本身同步且不等锁；commit 等锁后先验证 lease，失效返回具名 artifact-owner-deleted，不能重建最终目录、rename 或发布成功。

单 run/automation 清理同样在锁进入和退出时按 write scope 的 automation-run anchor 精确失效，不能只依赖已落盘 manifest。磁盘清理仍使用上表定位：单 run 不扫描，自动化/项目才可扫描 manifest。当 RunSummary 缺 sessionId 时不得猜磁盘目录，必须报告“记录已删除、结果文件未能完全清理”并继续完成权威删除；已知 automationId/runId 的活跃 lease 仍按 scope 精确失效。既有 inFlight 拒绝删除运行中记录的行为不变。

本期只防在途 Artifact 在删除后晚到再生：不改变 prune 保留集、collector/scheduler 释放时点或既有 N2 语义。collector/scheduler 已释放而 summary 未构建时，prune 仍可正常删会话，预先持有的 write 因失效不能再提交。反之 commit 先完成，则删除随后清净已提交结果。失效不是永久 tombstone；调用者 finally discard 释放最后一个 lease 时删除映射，不无限积累已删 owner。

删除顺序和错误反馈沿用现有原语：权威记录已删除但正文清理失败须报告“记录已删除、结果文件未能完全清理”，不静默成功、不回滚成半恢复。不存在的 Artifact 幂等成功，但不能跳过上述 lease 失效。discard 清理失败显式报告并释放 lease，不阻断自动化权威 summary 结算。

## 10. 涉及模块

| 类型 | 建议模块 |
| --- | --- |
| 消费（只读，来自进度计划 Task 1） | `huaanwork-host/turn-anchors.ts`：`TurnAnchorStore` / `TurnAnchor`，经 `holders.ts` 注入 `ctx.huaanworkTurnAnchors`；只 import 消费，不复制另建实现 |
| 新增 | `huaanwork-guardrails/result-artifact-tools.ts`：`result_present`（含逐字五条模型指引 description、运行时输入校验、`artifactId` 返回） |
| 复用 | `agent-attachments.ts`：同步 claimed 监听按回合来源挂卸 `result_present`，不新增第二套附件表 |
| 核对/必要时最小修改 | `present-as.ts`、`skills.ts`：验证附件并集和包儿童不继承；不得在此重复实现进度规格的 `subagent` 可见性改造 |
| 新增 | `huaanwork-host/artifacts-host.ts`：校验、存储、幂等、读取和删除原语 |
| 修改 | `automations-host.ts`：封套提示注入、完整输出 prepare；finishAutomation 同步冻结取消状态后提交/丢弃，统一构造 artifactFields |
| 修改 | `automations-store.ts`、会话/项目删除原语：完整级联清理 |
| 修改 | `huaanwork-host/routes.ts`：`artifact.get/content/list/openFullscreen/download/prepareFrame`；读取与原生入口均校验双 ID |
| 修改 | `client-huaanwork/rpc-types.ts`：Artifact 请求、摘要、运行关联和事件 |
| 新增 | `client-huaanwork/ResultArtifactCard.tsx` |
| 新增 | `client-huaanwork/ArtifactPreview.tsx`、`ArtifactFullscreenPage.tsx` 及渲染适配器 |
| 修改 | `App.tsx`：工具参数隐藏、结果卡、预览选择、全屏启动参数和右栏接线 |
| 修改 | `logic/sessionChannel.ts`、`logic/runTabsLogic.ts`：历史工具隐藏、Artifact 锚定和新旧折叠互斥 |
| 修改 | `electron-runtime.ts`、`electron-shell-generation.ts`：全屏独占 session、双 ID、访问头生命周期、frame 准备与保存对话框 |
| 新增 | `artifact-frame-guard.ts`：主窗口/全屏共用的 Artifact frame 专属导航防护；对应内部构建 entry 与真实 Electron 探针 |
| 保留并收窄 | `runResultAttachments.ts`、`attachmentDownload.ts`：只服务无 Artifact 的既有历史附件 |

`runResultRender.ts` 是无客户端依赖的纯函数，可由宿主直接复用或移至自有共享目录；不得因此引入 React/DOM 依赖。

样式只改 `styles.css` 源文件，并重新生成 `styles.generated.ts`。

## 11. 异常、安全与一致性约束

- 写盘失败、摘要不符或元数据不可读时不得发出成功结果卡。
- 预览内容缺失时显示可重试错误；不能把空内容伪装为成功页面。
- WebSocket 丢失事件后，通过 `artifact.list` 按会话对账；事件与快照使用 `artifactId` 去重。
- 切换会话必须取消或忽略上一会话迟到的内容应答，防止串页。
- Artifact 内容、元数据和列表读取均校验 Profile 与会话归属，不能通过构造 ID 读取其他目录。
- 单文件和单会话预算在持久化前执行；实际写入后再次核对字节数和摘要。
- 自动化适配必须先于运行摘要截断；脚本一期不参与，不得用已截断脚本 output 冒充完整 Artifact。
- 下载是用户显式导出不可信内容；不得为了改善下载后体验而放宽应用内沙箱。
- 全屏窗口与主窗口使用同一读取、安全和访问鉴权策略，不形成第二个特权渲染路径。
- 新协议封套、兼容 JSON、Artifact 卡和旧附件之间必须有唯一展示结果，任何事件顺序都不得双发。

## 12. 测试与验收

### 12.1 自动化测试

至少覆盖：

1. 两种格式的白名单、标题非空单行、第三种格式拒绝、content/downloadName 运行时类型、大小（Buffer.byteLength UTF-8 多字节边界）、路径、摘要和幂等；下载名 Windows 非法字符、设备名与强制扩展名。两阶段准备仅写隐藏暂存且 list 不可见，commit 锁内重验 lease/幂等/数量；并发重放仅一个 created:true；重复 discard 与 commit 后 discard 不删正文，最后 lease 释放不残留永久 owner 标记。
2. 用真实 agent-loop 捕获首个 llm request.tools：普通 advanced 首请求含 result_present，advanced→compat 的首请求即摘除，自动化/包儿童首请求不含；同步 agent/inbox/claimed 使用真实 message 和共享 notePreStep，goal 无新用户保留，register 但未 claim 的排队消息不改附件。同步异常触发真实 hook cancel，且零 llm 请求，不能只测 throw；与 bridge 重入不重复 refresh，既有 pre-step return next 链保留。测试内显式定义新增真实 loop harness/adapter，不把现有 mock schemas 表当模型请求。
3. `result_present` 实时和历史工具卡均不展示完整 args/content；成功只有 Artifact 卡，失败只有紧凑错误摘要；工具 description 逐字含五条模型指引，结果返回 `artifactId`；anchor 缺失退化为未定位分组。
4. 自动化仅 prepareAutomationResult 准备、finishAutomation 冻结后提交；真实 store/harness + 可控 Promise 屏障验证 prepare 中 stop → cancelled、零正文/created 事件/artifact 字段；commit/append 中 stop → stopped:true 但冻结 ok/status 不变，落盘摘 inFlight 后 stop:false。同 run 并发重放只有一份正文和一个 emit；取消/失败/早退均回收 lease，discard 失败显式报告且不阻断权威结算，不以 fake summary 或 sleep 代替验证。
5. manual/schedule/catchup 及有人/无人值守 agent 均在 runAgentTurn 的 automation.prompt 后带同一 task-result-contract；普通会话/脚本不注入。完整 collector 用于 prepare，入库摘要仍截断；坏标记封套不降级且 title/format 缺席，旧 JSON 只准备 Markdown，普通文本 skipped。合法内容准备/提交失败时，真实 RunSummary 与 run-end 使用同一 artifactFields，含稳定 error 和已验证 title/format，不改变同步冻结的执行终态或后续 markAutomation/任务状态；prepared 阶段无 emit。
6. 新协议和兼容 Artifact 均跳过旧双附件折叠（`foldRunAssistantItems(items, createAttachment)`，旧分支仍只插 1 个 attachment，id 由调用方 id 工厂显式生成）；created/failed 均断言原封套消失且无重复卡；内容暂不可读显示占位/重试卡、永久失败收敛为无正文错误终态；事件与 list 按 `artifactId` 去重、事件丢失经 RunSummary 补齐不双发；无 `artifactOutcome` 的历史运行仍显示旧附件。
7. 事件与 `artifact.list` 去重、会话切换迟到应答、精确历史锚定（`HistoryChatItem`/`ChatItem` user 均携带 `crypto.randomUUID()` 生成的 `clientMessageId`，与渲染 allocId 分离）和未定位分组；卡片点击展开右栏 + `rightTab="preview"` + `previewArtifactId` 并触发 `artifact.get`/`artifact.content`。
8. Markdown 依赖构建、原始 HTML 安全策略、远程图片默认不自动加载（http 链接仍走既有安全打开）和渲染失败兜底；不通过源码相对路径引用上游。
9. HTML 引导阶段仅有空 about:blank iframe；原生 frame 防护确认后，CSP meta 位于任何模型内容之前、`srcDoc` 非空且 `src` 为空。真实 Electron renderer 探针验证内联脚本可执行，fetch、父页面、Node、弹窗、表单和顶层导航被拒；WebSocket 以异步 error/open 和 CSP 违规证据判断，不假定构造时抛错。用已验证可接收请求的本地端点证明脚本自导航、链接、meta refresh、改名后导航及重定向入口均零请求；右侧与全屏分别覆盖。
10. 全屏双 ID 启动参数、安全参数、独占非持久 session、renderer access header、same-origin 校验；单例同 WebContents 重新加载时先撤下旧页面/旧 listener，再鉴权及加载业务 URL；覆盖有 cookie 的二次打开、跨会话切换、鉴权失败、关闭及 teardown，不影响主窗口。
11. 下载不经过 renderer `will-download`，原始字节一致（中文/emoji/BOM/CRLF）、文件名清理、扩展名固定、保存对话框 parent 为请求窗口（全屏不得用主窗口）、取消零写入和覆盖确认；超过 180 秒仍等待真实交互结果，不调整其他 RPC 超时；使用“结果.md/html”名称也不走旧分支。
12. 超预算、写盘失败、内容缺失及五类清理：会话、单 run 直定位（禁止扫描）、自动化/项目 manifest 精确匹配、prune；缺 sessionId 报清理不完整。真实屏障验证 collector/scheduler 已释放而 summary 未构建时 prune 仍照常删会话，后续 commit 报 artifact-owner-deleted 且零再生/成功事件；删除等待中新 begin 的 lease 也在 finally 失效，最终目录不存在或删除失败同样失效；commit 先完成则删除清净，兄弟 scope 不受影响。不改变保留集、既有 N2 或运行时释放时点。
13. 脚本自动化输出与 32 KiB 截断保持既有行为，不生成会话 Artifact。
14. `ArtifactNativeCapability` 由 `huaanwork-host/index.ts` 从 `desktopRuntime` 窄化提供并进入 `RouteContext`，缺失返回 `artifact-native-unavailable`。

### 12.2 用户验收

以下七项不预先声称已执行；实施计划的最后一个 Task 将其逐步执行，并为每一步记录证据（执行环境、命令/操作、实际输出或截图、通过/失败结论）。任何一项失败都必须按实际结果处置并回填记录，不得改写为通过。

1. **Markdown 报告与 HTML 交互结果的唯一展示**：分别生成一个 Markdown 报告和一个带内联交互图表的 HTML 结果。证据：会话导出与截图，证明会话中各只有一张结果卡，正文不在工具参数卡或旧附件中重复出现。
2. **卡片点击与右侧预览**：点击两类卡片。证据：右栏展开、`rightTab="preview"`、目标 Artifact 渲染正确的截图；随后切换到另一会话再切回，预览内容与所属会话一致、无串页。
3. **独立全屏窗口**：打开结果后再选择另一会话的结果复用该窗口。证据：同一 WebContents 两次读取正确双 ID、独占 session 的鉴权/访问头记录；窗口内关闭按钮与 Esc 均可返回；主会话布局与消息不变，主窗口 RPC 仍可用。
4. **HTML 交互与隔离**：在全屏与右侧预览中操作图表交互。证据：交互成功截图；原生 frame 准备先于模型内容、父应用/网络/弹窗/表单/顶层导航不可达；自导航、链接、meta refresh、改名导航和重定向入口被拒且本地接收端零请求的记录。须验证两个实际入口均安装生产防护，不能只引用独立探针替代接线验收。
5. **下载另存为**：点击“下载”，选择保存位置保存，再触发一次并取消。证据：保存文件的哈希/字节与提交内容一致（含非 ASCII 内容）；取消操作后目标目录无新文件。
6. **刷新与历史重开**：刷新应用并重新打开会话与历史会话。证据：结果卡、预览和下载仍可用；人为构造/选取一个无 `clientMessageId` 的旧结果，展示其进入明确的“未定位的历史结果”分组。
7. **自动化新旧协议并存**：分别运行一个新封套 agent 自动化、查看一个旧历史自动化运行和一个脚本运行。证据：新运行只显示一个 Artifact；旧历史运行仍按旧双附件展示；脚本运行记录行为与 32 KiB 截断保持不变。

## 13. 独立性

本需求不依赖对话创建技能或进度面板。回合锚点直接消费进度计划 Task 1 建立的独立共享模块 `turn-anchors.ts`（`TurnAnchorStore` 经 `holders.ts` 注入 `ctx.huaanworkTurnAnchors`），不复制另建实现、不等待 ProgressPanel Tasks 2-4；该共享模块已在本基线合并可用。技能创建确认卡不是任务 Artifact；进度页也不负责生成或保存 Artifact。后续若需从进度页打开某项结果，只能通过已稳定的 `artifactId` 做导航，不能共享或复制正文状态。
