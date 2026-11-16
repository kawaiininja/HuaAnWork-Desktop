# Task Result Artifacts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将普通会话和 agent 自动化的可交付结果统一为宿主持久化 Artifact，在会话中只显示一张结果卡，并支持右侧预览、沙箱 HTML、独立全屏和原字节下载。

**Architecture:** 普通交互父会话通过附件-only 的 `result_present` 提交；agent 自动化只通过 `runAgentTurn` 注入的终态封套提交。Host 统一校验、原子落盘和按需读取，客户端统一投影结果卡，Electron 通过声明式 `native:*` RPC 提供全屏窗口与系统保存对话框。

**Tech Stack:** TypeScript、React、Vitest、Electron BrowserWindow、既有 HostRpc、既有 `@deepseek-ai/dsh-client-ui-primitives` MarkdownText、既有 `runResultRender` 纯函数。

**Spec:** `docs/superpowers/specs/2026-11-15-task-result-artifacts-design.md`

**Plan order:** 3/3。先完成技能与进度计划。本计划可复用进度计划建立的通用回合锚点，但不得依赖右栏 ProgressPanel 才能生成或预览 Artifact。进度计划 Task 1 的 `huaanwork-host/turn-anchors.ts`（`TurnAnchorStore` / `TurnAnchor`，经 `holders.ts` 注入 `ctx.huaanworkTurnAnchors`）是独立共享模块，可先独立合并，不要求先完成 ProgressPanel Tasks 2-4；本计划所有锚点消费一律 import 该模块与类型，不复制实现、不改其内部。

## Global Constraints

- 基线为外层 `ff29debd37d72a92f10d446eafa07867d17befd8`，上游 pin `1600d8a1e140dcde43a1a0941940a0480712c011`。
- 只修改 `dsh-plugin-huaanwork/` 和必要的自有共享包 `packages/huaanwork-policy/`；不得修改 `deepseek-harness/`。上游 Markdown 只能通过正式包公开导出消费。
- 使用 Node.js `^22.19.0` 或 `>=24.0.0` 与 Corepack Yarn `4.18.0`。
- 单 Artifact 正文最大 5 MiB，每会话最多 100 个；超限拒绝，不静默截断或淘汰。
- `result_present` 全局注册但仅通过普通交互父会话附件可见；不得加入全局 `ALLOWED_TOOLS`，不得暴露给自动化或包儿童。
- agent 自动化的唯一生产者是终态封套适配器；自动化会话不得使用 `result_present`，自动化幂等键为 `automationId + runId`。
- `<task-result-contract>` 必须在 `runAgentTurn` 的 `automation.prompt` 之后、`<automation-fire>` 封装之前注入；有人/无人值守及 manual/schedule/catchup 均覆盖。
- 自动化适配必须读取 `executeRun` 中尚未进入 `finishAutomation` 截断的完整 collector 文本；脚本一期不生成 Artifact。
- 每项结果只能有一种展示：`result_present` 正文不得进入通用工具参数卡；新自动化运行不得再生成旧双附件。
- Artifact 正文只按需读取；WebSocket `artifact/created` 只含摘要。
- HTML 只允许 `sandbox="allow-scripts"` 的无同源 iframe；禁止 Node、父页面、网络、表单、弹窗和顶层导航。
- 全屏窗口无业务 preload、无 Node，复用同源启动参数与 renderer access header；下载不走 renderer `will-download`。
- 清理接在共享 store 原语，覆盖会话、单运行、自动化、项目级联和 prune。
- 附件可见性刷新一律沿用既有 `refreshAgentRestrict(ctx as never)` 惯用法；回归命令只运行本计划列出的测试文件与既有未修改测试，不改动无关测试。
- 修改 `styles.css` 后运行 `corepack yarn workspace dsh-plugin-huaanwork gen:styles`。
- `clientMessageId` 契约：普通高级会话 App 每次 `session.send` 新生成 `crypto.randomUUID()` 顶层发送；自动化回合顶层 `clientMessageId=runId`（run-start user item 记录同一 runId，`origin='automation'`），不用随机 UUID。Host 取 `UserMessage.id = 顶层 clientMessageId ?? crypto.randomUUID()`，旧客户端缺顶层字段时 Host 现场生成，绝不用 `at.clientMessageId` 兜底（避免与渲染 allocId 重复 MessageId）。`ChatItem.id` 仍用渲染侧 allocId，`user.clientMessageId`（`HistoryChatItem`/`ChatItem` user 均携带）单独存 UUID，不得用 `String(userMsg.id)`；既有 `at.clientMessageId` 数值字符串仅作 legacy 展示兼容，精确匹配用新 UUID（自动化回合用 runId）。
- 所有命令在仓库根执行；最终执行仓级 `corepack yarn check`，不与其他含 `verify:aa` 的命令并发。

---

### Task 1: Artifact 类型、校验、原子存储与幂等读取

**Files:**
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/rpc-types.ts:385-398,432-446,521-598`
- Create: `dsh-plugin-huaanwork/src/huaanwork-host/artifacts-host.ts`
- Test: `dsh-plugin-huaanwork/tests/huaanwork-host/artifacts-host.spec.ts`

**Interfaces:**
- Produces: `ArtifactFormat`、`ArtifactAnchor`、`TaskArtifactSummary`、`ArtifactOutcome`。
- Produces: `createArtifact(profileDir, input)`、`getArtifact(profileDir, sessionId, artifactId)`、`readArtifactContent`、`listArtifacts`、`findArtifactByRun`。
- Produces: `sanitizeArtifactDownloadName(title, format, requested?)`。
- Consumes: 无；后续工具、自动化和路由只调用这些函数。

- [ ] **Step 1: 写创建、读取和幂等失败测试**

```ts
it('persists and replays one markdown artifact', async () => {
  const root = mkdtempSync(join(tmpdir(), 'artifact-store-'))
  const input = {
    sessionId: 'session-1', title: '日报', format: 'markdown' as const,
    content: '# 日报\n\n完成存储', anchor: { kind: 'turn' as const },
    idempotency: { kind: 'tool' as const, callId: 'call-1' },
  }
  const first = await createArtifact(root, input)
  const replay = await createArtifact(root, input)
  expect(first.artifactId).toBe(replay.artifactId)
  expect(first.downloadName).toBe('日报.md') // title 兜底也必须经 sanitizer 并强制扩展名
  expect((await readArtifactContent(root, 'session-1', first.artifactId)).toString('utf8')).toBe(input.content)
  expect((await listArtifacts(root, 'session-1')).map((item) => item.artifactId)).toEqual([first.artifactId])
  await expect(readArtifactContent(root, 'other-session', first.artifactId)).rejects.toThrow('artifact-not-found')
  const renamed = await createArtifact(root, {
    ...input, title: '报告', downloadName: 'a:b.txt', idempotency: { kind: 'tool', callId: 'call-2' },
  })
  expect(renamed.downloadName).toBe('a-b.md') // 原始名先清理再进入 summary，download 链路不得另猜名称
})

it('rejects oversized content and cross-session reads', async () => {
  const root = mkdtempSync(join(tmpdir(), 'artifact-limit-'))
  await expect(createArtifact(root, {
    sessionId: 'session-1', title: '过大', format: 'html', content: 'x'.repeat(5 * 1024 * 1024 + 1),
    anchor: { kind: 'turn' }, idempotency: { kind: 'tool', callId: 'call-large' },
  })).rejects.toThrow('artifact-too-large')
  expect(await listArtifacts(root, 'session-1')).toEqual([])
})
```

另测自动化同 `automationId + runId` 重放、100 个上限、路径段校验、损坏 manifest fail-closed，以及下载名不能含路径或控制字符。

运行时输入校验（TypeScript 类型不构成验证）与 UTF-8 字节边界：

```ts
it('validates runtime input beyond TypeScript types', async () => {
  const root = mkdtempSync(join(tmpdir(), 'artifact-validate-'))
  const base = {
    sessionId: 'session-1', anchor: { kind: 'turn' as const },
    idempotency: { kind: 'tool' as const, callId: 'call-v' },
  }
  await expect(createArtifact(root, { ...base, title: '', format: 'markdown', content: 'x' }))
    .rejects.toThrow('artifact-invalid-title')
  await expect(createArtifact(root, { ...base, title: '多\n行', format: 'markdown', content: 'x' }))
    .rejects.toThrow('artifact-invalid-title')
  await expect(createArtifact(root, { ...base, title: 't', format: 'pdf' as never, content: 'x' }))
    .rejects.toThrow('artifact-invalid-format')
  await expect(createArtifact(root, { ...base, title: 't', format: 'markdown', content: 42 as never }))
    .rejects.toThrow('artifact-invalid-content')
  await expect(createArtifact(root, { ...base, title: 't', format: 'markdown', content: 'x', downloadName: 7 as never }))
    .rejects.toThrow('artifact-invalid-download-name')
})

it('measures the size budget in UTF-8 bytes, not string length', async () => {
  const root = mkdtempSync(join(tmpdir(), 'artifact-utf8-'))
  const fit = '汉'.repeat(Math.floor(MAX_ARTIFACT_BYTES / 3)) // MAX-2 字节，处于预算内
  await expect(createArtifact(root, {
    sessionId: 'session-1', title: '边界', format: 'markdown', content: fit,
    anchor: { kind: 'turn' }, idempotency: { kind: 'tool', callId: 'call-fit' },
  })).resolves.toBeDefined()
  await expect(createArtifact(root, {
    sessionId: 'session-1', title: '越界', format: 'markdown', content: `${fit}汉`, // MAX+1 字节
    anchor: { kind: 'turn' }, idempotency: { kind: 'tool', callId: 'call-over' },
  })).rejects.toThrow('artifact-too-large')
})

it('round-trips original bytes with BOM, CRLF, Chinese and emoji', async () => {
  const root = mkdtempSync(join(tmpdir(), 'artifact-bytes-'))
  const content = '﻿# 标题\r\n正文 😀 中文\r\n'
  const artifact = await createArtifact(root, {
    sessionId: 'session-1', title: '字节', format: 'markdown', content,
    anchor: { kind: 'turn' }, idempotency: { kind: 'tool', callId: 'call-bytes' },
  })
  expect(await readArtifactContent(root, 'session-1', artifact.artifactId))
    .toEqual(Buffer.from(content, 'utf8'))
})
```

下载名 sanitizer 纯函数测试（Windows 非法字符、保留设备名、强制扩展名）：

```ts
it('sanitizes windows-illegal characters and reserved device names', () => {
  expect(sanitizeArtifactDownloadName('报告', 'markdown', 'a:b*c?d"e<f>g|h.md')).toBe('a-b-c-d-e-f-g-h.md')
  expect(sanitizeArtifactDownloadName('报告', 'markdown', 'CON.txt')).toBe('_CON.md')
  expect(sanitizeArtifactDownloadName('报告', 'markdown', 'com1.log')).toBe('_com1.md')
  expect(sanitizeArtifactDownloadName('报告', 'html', '结果')).toBe('结果.html')
  expect(sanitizeArtifactDownloadName('报告', 'markdown', 'x.txt')).toBe('x.md')
  expect(sanitizeArtifactDownloadName('报告', 'markdown', '../../etc/passwd')).not.toContain('/')
})
```

- [ ] **Step 2: 确认存储测试因模块缺失失败**

Run:
```bash
corepack yarn workspace dsh-plugin-huaanwork vitest run tests/huaanwork-host/artifacts-host.spec.ts
```
Expected: FAIL，`artifacts-host.ts` 不存在。

- [ ] **Step 3: 定义线上类型**

```ts
export type ArtifactFormat = 'markdown' | 'html'
export type ArtifactAnchor =
  | { kind: 'turn'; clientMessageId?: string }
  | { kind: 'automation-run'; automationId: string; runId: string }
export type ArtifactOutcome = 'created' | 'failed'

export type TaskArtifactSummary = {
  artifactId: string
  sessionId: string
  title: string
  format: ArtifactFormat
  downloadName: string
  sizeBytes: number
  sha256: string
  createdAt: string
  anchor: ArtifactAnchor
}
```

`RunSummary` 增加可选 `artifactOutcome?: ArtifactOutcome`、`artifactId?: string`、`artifactError?: string`、`artifactTitle?: string`、`artifactFormat?: ArtifactFormat`；旧记录缺省。`artifactTitle`/`artifactFormat` 仅在封套/兼容 JSON 已通过校验、仅持久化失败时记录；带标记但校验失败的封套不可确认 title/format，两个字段缺席，客户端错误卡显示“任务结果/未知格式”。`RpcEvent` 的 `automation/run-end` 联合也逐项增加同名五个可选字段，Host emit 与 `RunSummary` 使用同一 `artifactFields` 对象；不得只扩存储类型而让实时事件无字段。`RpcEvent` 另增加：

```ts
{ event: 'artifact/created'; artifact: TaskArtifactSummary; sessionId: string }
```

- [ ] **Step 4: 实现有界原子存储**

存储路径固定为 `<profileDir>/artifacts/<sessionId>/<artifactId>/`。`manifest` 额外保存幂等键，正文为 `content.md` 或 `content.html`。所有 ID 使用单路径段；`artifactId=randomUUID()`。

`createArtifact` 先做运行时校验（TS 类型不算验证）：`title` 非空且不含 `\n`/`\r`（否则 `artifact-invalid-title`）；`format` 必须 `'markdown' | 'html'`，第三种值一律 `artifact-invalid-format`；`content` 必须 `string`（`artifact-invalid-content`）；`downloadName` 若提供必须 `string`（`artifact-invalid-download-name`）。大小预算用 `Buffer.byteLength(content, 'utf8')` 计量，不得用 `content.length`。

下载名清理修正 Windows 非法字符 `: * ? " < > |`、控制字符（`0x00-0x1F`）与路径分隔符 `/ \`；保留设备名按首个点前的名称识别：

```ts
export const MAX_ARTIFACT_BYTES = 5 * 1024 * 1024
export const MAX_ARTIFACTS_PER_SESSION = 100

export function sanitizeArtifactDownloadName(
  title: string,
  format: 'markdown' | 'html',
  requested?: string,
): string {
  const cleaned = (typeof requested === 'string' ? requested.trim() : '') || title.trim() || '任务结果'
  const safe = cleaned
    .replace(/[:*?"<>|/\\\x00-\x1f]/g, '-')
    .replace(/^\.+/, '')
    .replace(/[. ]+$/g, '')
  const deviceStem = (safe.split('.')[0] || '').trim()
  const reserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(deviceStem)
  const withPrefix = reserved ? `_${safe}` : safe
  const lastDot = withPrefix.lastIndexOf('.')
  const withoutExtension = (lastDot > 0 ? withPrefix.slice(0, lastDot) : withPrefix) || '任务结果'
  return `${withoutExtension}.${format === 'markdown' ? 'md' : 'html'}`
}
```

`createArtifact` 在 profile 级 Promise 锁内先查幂等记录，再检查数量/字节预算；写临时目录、计算 `sha256`、rename。读侧重新核对实际字节和摘要；损坏记录抛具名错误，不得当成空列表。`findArtifactByRun` 只匹配 manifest 的自动化锚点和幂等键。

- [ ] **Step 5: 运行存储和类型测试**

Run:
```bash
corepack yarn workspace dsh-plugin-huaanwork vitest run tests/huaanwork-host/artifacts-host.spec.ts
corepack yarn workspace dsh-plugin-huaanwork typecheck
```
Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add dsh-plugin-huaanwork/src/client-huaanwork/rpc-types.ts dsh-plugin-huaanwork/src/huaanwork-host/artifacts-host.ts dsh-plugin-huaanwork/tests/huaanwork-host/artifacts-host.spec.ts
git commit -m "feat(artifacts): add bounded persistent result storage"
```

---

### Task 2: `result_present` 普通父会话工具与内容最小化

**Files:**
- Create: `dsh-plugin-huaanwork/src/huaanwork-guardrails/result-artifact-tools.ts`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-guardrails/policy.ts`
- Modify: `packages/huaanwork-policy/src/decide.ts`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/index.ts`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-guardrails/bridge.ts:120-172`
- Test: `dsh-plugin-huaanwork/tests/huaanwork-guardrails/result-artifact-tools.spec.ts`
- Test: `dsh-plugin-huaanwork/tests/huaanwork-guardrails/present-as.cordis.spec.ts`
- Test: `dsh-plugin-huaanwork/tests/huaanwork-guardrails/policy.cordis.spec.ts`

**Interfaces:**
- Consumes: Task 1 的 `createArtifact`；以及进度计划 Task 1 独立共享模块 `dsh-plugin-huaanwork/src/huaanwork-host/turn-anchors.ts` 导出的 `TurnAnchorStore` / `TurnAnchor`（经 `holders.ts` 注入 `ctx.huaanworkTurnAnchors`）。前置顺序：该共享模块可先独立合并，本 Task 只 import 消费，不要求 ProgressPanel Tasks 2-4 完成；本 Task 不修改 `turn-anchors.ts`。**同时消费其 fail-closed 契约**：只有 `sessions.ts sendToAgent` 的 `register()` 登记会话才能获得高级/自动化来源，未登记的包儿童经 `notePreStep` 只会得到 `origin='unknown'`；本 Task 的 origin 门依赖该语义，若共享 store 改动它必须同步重审本 Task。
- Produces: `RESULT_PRESENT_TOOL = "result_present"`、`registerResultArtifactTools(ctx, profileDir): () => void`、`makeResultPresentPreStep(ctx)`（agent/pre-step 附件同步，`return next()`）。
- Preserves: 全局 `ALLOWED_TOOLS` 不含 `result_present`。

- [ ] **Step 1: 写工具可见性与结果最小化失败测试**

```ts
type ResultPresentArgs = { title: string; format: 'markdown' | 'html'; content: string; downloadName?: string }
type ToolDefinition = {
  name: string
  description: string
  execute: (args: ResultPresentArgs, exec: { agent?: unknown; callId?: string }) => Promise<{ text: string }>
}

const agentForSession = (sessionId: string) => ({ session: { id: sessionId } })

function makeToolContext(registered: Map<string, ToolDefinition>, events: RpcEvent[], anchor?: TurnAnchor) {
  const attachments = emptyAttachments()
  attachAgentTools(attachments, 'session-1', [RESULT_PRESENT_TOOL])
  return {
    tools: { register: (definition: ToolDefinition) => { registered.set(definition.name, definition); return () => undefined } },
    huaanworkAttachments: attachments,
    huaanworkTurnAnchors: { current: (sessionId: string) => sessionId === 'session-1' ? anchor : undefined },
    huaanworkEmit: (event: RpcEvent) => events.push(event),
  }
}

it('creates an artifact without returning its content', async () => {
  const profileDir = mkdtempSync(join(tmpdir(), 'result-present-'))
  const registered = new Map<string, ToolDefinition>()
  const events: RpcEvent[] = []
  registerResultArtifactTools(makeToolContext(registered, events, {
    clientMessageId: 'uuid-1', startedAt: '2026-11-15T10:00:00.000Z', origin: 'advanced',
  }), profileDir)
  const result = await registered.get('result_present')!.execute({
    title: '分析报告', format: 'markdown', content: '# 正文',
  }, { agent: agentForSession('session-1'), callId: 'call-1' })
  expect(result.text).toContain('分析报告')
  expect(result.text).toContain('artifactId')
  expect(result.text).not.toContain('# 正文')
  expect(events).toContainEqual(expect.objectContaining({
    event: 'artifact/created',
    artifact: expect.objectContaining({ anchor: { kind: 'turn', clientMessageId: 'uuid-1' } }),
  }))
})

it('embeds the five model guidelines verbatim in the tool description', () => {
  const registered = new Map<string, ToolDefinition>()
  registerResultArtifactTools(makeToolContext(registered, []), mkdtempSync(join(tmpdir(), 'result-present-desc-')))
  const description = registered.get('result_present')!.description
  expect(description).toContain('报告、分析、列表、表格、代码说明和线性文档优先使用 Markdown')
  expect(description).toContain('需要非线性布局、图表或交互的可视化结果使用 HTML')
  expect(description).toContain('普通对话答复不调用该工具')
  expect(description).toContain('同一交付物只提交一次，不同时提交两种格式')
  expect(description).toContain('工具成功后的最终助手回复只给简短说明，不重复完整 content')
})

it('falls back to an unanchored turn for a pre-upgrade in-flight submission', async () => {
  const profileDir = mkdtempSync(join(tmpdir(), 'result-present-no-anchor-'))
  const registered = new Map<string, ToolDefinition>()
  const events: RpcEvent[] = []
  registerResultArtifactTools(makeToolContext(registered, events, undefined), profileDir)
  await registered.get('result_present')!.execute({
    title: '升级前在途回合', format: 'markdown', content: '# 正文',
  }, { agent: agentForSession('session-1'), callId: 'call-legacy-inflight' })
  expect(events).toContainEqual(expect.objectContaining({
    event: 'artifact/created',
    artifact: expect.objectContaining({ anchor: { kind: 'turn' } }),
  }))
})

it('requires an ordinary parent attachment', () => {
  const attachments = emptyAttachments()
  expect(isAgentToolAttached(attachments, 'ordinary-parent', RESULT_PRESENT_TOOL)).toBe(false)
  attachAgentTools(attachments, 'ordinary-parent', [RESULT_PRESENT_TOOL])
  expect(isAgentToolAttached(attachments, 'ordinary-parent', RESULT_PRESENT_TOOL)).toBe(true)
  expect(isAgentToolAttached(attachments, 'automation', RESULT_PRESENT_TOOL)).toBe(false)
  expect(isAgentToolAttached(attachments, 'package-child', RESULT_PRESENT_TOOL)).toBe(false)
})
```

附件与 `TurnAnchorStore.origin` 同步的 pre-step 测试（幂等、与 bridge 次序无关、`return next()`）。`makePreStepContext` 的 fake store 同时实现 `notePreStep(sessionId, messages, startedAt)` 与 `current(sessionId)`，前者按消息登记/继承 anchor；`makeStep` 使用真实 `agent/pre-step` 的 `{agent,messages}` 形状：

```ts
it('attaches only for advanced origin ordinary parent sessions and detaches otherwise', async () => {
  const anchors = new Map<string, TurnAnchor>()
  const ctx = makePreStepContext(anchors) // 含 huaanworkAttachments、huaanworkTurnAnchors
  const notePreStep = makeResultPresentPreStep(ctx)
  anchors.set('advanced-parent', { clientMessageId: 'u1', startedAt: 't', origin: 'advanced' })
  anchors.set('automation-run', { clientMessageId: 'u2', startedAt: 't', origin: 'automation' })
  anchors.set('compat-turn', { clientMessageId: 'u3', startedAt: 't', origin: 'unknown' })
  await notePreStep(makeStep({ sessionId: 'advanced-parent' }), () => Promise.resolve())
  expect(isAgentToolAttached(ctx.huaanworkAttachments, 'advanced-parent', RESULT_PRESENT_TOOL)).toBe(true)
  await notePreStep(makeStep({ sessionId: 'automation-run' }), () => Promise.resolve())
  expect(isAgentToolAttached(ctx.huaanworkAttachments, 'automation-run', RESULT_PRESENT_TOOL)).toBe(false)
  await notePreStep(makeStep({ sessionId: 'compat-turn' }), () => Promise.resolve())
  expect(isAgentToolAttached(ctx.huaanworkAttachments, 'compat-turn', RESULT_PRESENT_TOOL)).toBe(false)
  // 包儿童不经 sendToAgent register：fake store 按共享契约从未登记消息得到 unknown，而不是按 ID 猜测包血缘。
  await notePreStep(makeStep({ sessionId: 'package-child-unregistered' }), () => Promise.resolve())
  expect(isAgentToolAttached(ctx.huaanworkAttachments, 'package-child-unregistered', RESULT_PRESENT_TOOL)).toBe(false)
})

it('is idempotent and order-independent with the bridge listener', async () => {
  const anchors = new Map<string, TurnAnchor>([['s1', { clientMessageId: 'u1', startedAt: 't', origin: 'advanced' }]])
  const ctx = makePreStepContext(anchors)
  const notePreStep = makeResultPresentPreStep(ctx)
  const step = makeStep({ sessionId: 's1' })
  let nextCalls = 0
  await notePreStep(step, () => { nextCalls += 1; return Promise.resolve() })
  await notePreStep(step, () => { nextCalls += 1; return Promise.resolve() }) // 重入不得重复 refresh/attach
  expect(nextCalls).toBe(2) // 每次调用都必须 return next()
  expect(countRestrictRefreshes(ctx, 's1')).toBe(1) // attach 幂等，refresh 只发生一次
  // 与 bridge listener 以相反次序重复执行同一回合，附件终态一致
  await runBridgeSync(ctx, step)
  await notePreStep(step, () => Promise.resolve())
  expect(isAgentToolAttached(ctx.huaanworkAttachments, 's1', RESULT_PRESENT_TOOL)).toBe(true)
})

it('keeps attachment across goal continuation that inherits the advanced anchor', async () => {
  const anchor = { clientMessageId: 'u-goal', startedAt: 't', origin: 'advanced' as const }
  const anchors = new Map<string, TurnAnchor>([['goal-session', anchor]])
  const ctx = makePreStepContext(anchors)
  const notePreStep = makeResultPresentPreStep(ctx)
  await notePreStep(makeStep({ sessionId: 'goal-session', goalContinuation: true }), () => Promise.resolve())
  expect(isAgentToolAttached(ctx.huaanworkAttachments, 'goal-session', RESULT_PRESENT_TOOL)).toBe(true)
})
```

在 `present-as.cordis.spec.ts` 用现有 schema/restrict harness 另行验证：挂附件的普通父会话有效 allow 含 `result_present`，自动化与包儿童不含；不得只测附件表而漏掉实际 restrict。

- [ ] **Step 2: 确认工具注册和可见性测试失败**

Run:
```bash
corepack yarn workspace dsh-plugin-huaanwork vitest run tests/huaanwork-guardrails/result-artifact-tools.spec.ts tests/huaanwork-guardrails/present-as.cordis.spec.ts tests/huaanwork-guardrails/policy.cordis.spec.ts
```
Expected: FAIL，工具未注册。

- [ ] **Step 3: 注册工具并在执行上下文绑定身份**

工具注册时 `description` 逐字包含五条模型指引（多行字符串原样拼接，不得改写）：

```ts
export const RESULT_PRESENT_DESCRIPTION = [
  '- 报告、分析、列表、表格、代码说明和线性文档优先使用 Markdown；',
  '- 需要非线性布局、图表或交互的可视化结果使用 HTML；',
  '- 普通对话答复不调用该工具；',
  '- 同一交付物只提交一次，不同时提交两种格式；',
  '- 工具成功后的最终助手回复只给简短说明，不重复完整 content。',
].join('\n')
```

工具输入严格为 `title/format/content/downloadName?`；运行时校验由 `createArtifact` 执行（Task 1），工具层不重复实现，只透传具名错误。执行时：

```ts
const sessionId = sessionIdOfAgentRef(exec?.agent)
if (!sessionId || !exec.callId) throw new Error('result-present-context-missing')
if (!isAgentToolAttached(ctx.huaanworkAttachments, sessionId, RESULT_PRESENT_TOOL)) {
  throw new Error('result-present-not-attached')
}
const anchor = ctx.huaanworkTurnAnchors?.current(sessionId) // TurnAnchorStore，进度计划共享模块
const artifact = await createArtifact(profileDir, {
  sessionId, title: args.title, format: args.format, content: args.content,
  ...(args.downloadName !== undefined ? { downloadName: args.downloadName } : {}),
  anchor: { kind: 'turn', ...(anchor?.clientMessageId !== undefined ? { clientMessageId: anchor.clientMessageId } : {}) },
  idempotency: { kind: 'tool', callId: exec.callId },
})
ctx.huaanworkEmit?.({ event: 'artifact/created', artifact, sessionId })
return { text: `已生成结果页“${artifact.title}”。artifactId: ${artifact.artifactId}` }
```

`profileDir` 是注册时由 Host `apply()` 的 `config.profileDir` 显式传入的闭包参数，不新增 ctx 路径字段。工具全局注册，但只有 schema 注册 + 会话附件 + policy attached 三层都通过才可执行。

- [ ] **Step 4: 在 agent/pre-step 按 TurnAnchorStore.origin 同步附件**

附件不再挂在 `ensureChannelAgent` 创建分支，而是由 pre-step 在每次模型调用前同步（先于 `prepareCall` 生效；本步骤实现为 `notePreStep(step, next)` 形态，处理后必须 `return next()`，不得截断调用链）：

```ts
export function makeResultPresentPreStep(ctx: AgentStepContext) {
  return async function noteResultPresentAttachment(step: AgentStep, next: () => Promise<unknown>): Promise<unknown> {
    const sessionId = sessionIdOfAgentRef(step.agent)
    if (!sessionId) return next()
    // 与 bridge 使用同一个幂等记录入口，双方任意先后都会得到同一 anchor。
    const anchor = ctx.huaanworkTurnAnchors?.notePreStep(sessionId, step.messages, new Date().toISOString())
    // 唯一门控是共享 anchor.origin；包儿童不经 register，notePreStep 得 unknown 并在这里 fail-closed。
    const wantAttached = anchor?.origin === 'advanced'
    const attached = isAgentToolAttached(ctx.huaanworkAttachments, sessionId, RESULT_PRESENT_TOOL)
    if (wantAttached && !attached) {
      attachAgentTools(ctx.huaanworkAttachments, sessionId, [RESULT_PRESENT_TOOL])
      refreshAgentRestrict(ctx as never, sessionId)
    } else if (!wantAttached && attached) {
      detachAgentTools(ctx.huaanworkAttachments, sessionId, [RESULT_PRESENT_TOOL])
      refreshAgentRestrict(ctx as never, sessionId)
    }
    return next() // 必须继续调用链；重复执行时 attached===wantAttached，无副作用
  }
}

// 注册到实际上游事件；step.agent/messages 来自 agent/pre-step payload。
ctx.on('agent/pre-step', makeResultPresentPreStep(ctx) as never, { global: true })
```

规则：`origin='automation'` 和 `origin='unknown'`（含兼容模式新回合与未登记包儿童）一律 detach 并 refresh restrict——不得只写“compat 不可达”，要显式摘除。goal 续轮由 `TurnAnchorStore` 保留原 anchor（`origin='advanced'`），pre-step 看到同一 anchor，附件随之保留。`notePreStep` 与 bridge 监听都必须幂等、可任意次序重入：状态不变时不得重复 `refreshAgentRestrict`，不得依赖两个 listener 的注册先后。工具执行体仍执行 attached 检查（Step 3），不依赖 pre-step 结果。包儿童由 subagent provider 创建，不经 `sessions.ts sendToAgent` 的 `register()`；共享 store 因此对它们返回 `unknown`，这就是本门的包儿童 fail-closed 来源，不再引入不存在或重复的血缘谓词。不得额外添加包附件。无人值守自动化既被排除，也继续受既有白名单过滤。policy 对 `result_present` 只允许 `attached=true` 的执行。

- [ ] **Step 5: 在桥接层抑制参数正文**

`tool/start` 的 `result_present` 不构造通用 args 详情；只保留 name/callId/sessionId/roundKey，供客户端识别该工具。历史侧在 Task 5 做同形处理。

Run:
```bash
corepack yarn workspace dsh-plugin-huaanwork vitest run tests/huaanwork-guardrails/result-artifact-tools.spec.ts tests/huaanwork-guardrails/present-as.cordis.spec.ts tests/huaanwork-guardrails/policy.cordis.spec.ts tests/huaanwork-guardrails/agent-attachments.spec.ts
corepack yarn workspace @huaanwork/policy check
```
Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add dsh-plugin-huaanwork/src/huaanwork-guardrails/result-artifact-tools.ts dsh-plugin-huaanwork/src/huaanwork-guardrails/policy.ts packages/huaanwork-policy/src/decide.ts dsh-plugin-huaanwork/src/huaanwork-host/index.ts dsh-plugin-huaanwork/src/huaanwork-guardrails/bridge.ts dsh-plugin-huaanwork/tests/huaanwork-guardrails/result-artifact-tools.spec.ts dsh-plugin-huaanwork/tests/huaanwork-guardrails/present-as.cordis.spec.ts dsh-plugin-huaanwork/tests/huaanwork-guardrails/policy.cordis.spec.ts
git commit -m "feat(artifacts): add parent-only result presentation tool"
```

---

### Task 3: 自动化封套提示注入、截断前适配与运行结果记录

**Files:**
- Create: `dsh-plugin-huaanwork/src/huaanwork-host/automation-artifacts.ts`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/automations-host.ts:341-443,591-651,783-838`
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/rpc-types.ts:385-398`
- Test: `dsh-plugin-huaanwork/tests/huaanwork-host/automation-artifacts.spec.ts`
- Test: `dsh-plugin-huaanwork/tests/huaanwork-host/automations-host.spec.ts`
- Test: `dsh-plugin-huaanwork/tests/huaanwork-host/automations-script-error.spec.ts`

**Interfaces:**
- Produces: `AUTOMATION_RESULT_CONTRACT`、`adaptAutomationResult(routeCtx, automation, sessionId, runId, fullText)`。
- Produces: `{outcome:"created",artifact}`、`{outcome:"failed",artifactError,artifactTitle?,artifactFormat?}`、`{outcome:"skipped"}` 三态适配结果；failed 在封套已通过校验、仅持久化失败时携带 `artifactTitle`/`artifactFormat`，带标记但校验失败的封套不可确认，两个字段缺席。
- Consumes: `jsonToBlocks`、`blocksToMarkdown` 和 Task 1 存储。

- [ ] **Step 1: 写提示注入和完整文本适配失败测试**

使用 `automations-host.spec.ts` 的现有 `makeHarness` 与 `followups`：

```ts
it.each([
  { label: 'attended', unattended: undefined },
  { label: 'unattended', unattended: { enabled: true, allow: ['read'] } },
])('injects the result contract for $label agent runs', async ({ unattended }) => {
  const h = makeHarness()
  const project = await createProject(h.profileDir, { root: h.neutral, name: '封套提示' })
  const automation = await agentTask(h.profileDir, {
    projectId: project.id,
    name: '生成报告',
    prompt: '生成报告',
    ...(unattended !== undefined ? { unattended } : {}),
  })
  const run = await startAutomation(h, automation, { trigger: 'manual', runId: 'prompt-contract-1' })
  await poll(() => h.followups.length === 1)
  const prompt = h.followups[0]!.text
  expect(prompt).toContain('<task-result-contract>')
  expect(prompt).toContain('最终可见输出必须且只能是一个 JSON 对象')
  expect(prompt.indexOf('生成报告')).toBeLessThan(prompt.indexOf('<task-result-contract>'))
  expect(prompt).toContain('<automation-fire')
  h.release(h.followups[0]!.sessionId)
  await run.done
})
```

另以 manual/schedule/catchup 参数化同一断言；普通会话和脚本 harness 断言不含该段。

取消覆盖、重放不重复 emit、失败记录可展示字段：

```ts
it('does not create an artifact for a cancelled run', async () => {
  const h = makeHarness()
  const project = await createProject(h.profileDir, { root: h.neutral, name: '取消' })
  const automation = await agentTask(h.profileDir, { projectId: project.id, name: '取消', prompt: '生成报告' })
  const run = await startAutomation(h, automation, { trigger: 'manual', runId: 'cancel-artifact-1' })
  await poll(() => h.followups.length === 1)
  h.cancel(h.followups[0]!.sessionId) // 取消先于适配生效
  await run.done
  const summary = await getRunSummary(h.profileDir, automation.id, 'cancel-artifact-1')
  expect(summary.status).toBe('cancelled')
  expect(summary.artifactOutcome).toBeUndefined()
  expect(await findArtifactByRun(h.profileDir, automation.id, 'cancel-artifact-1')).toBeUndefined()
})

it('replays an existing run artifact without re-emitting or duplicating', async () => {
  const h = makeHarness()
  const automation = { id: 'automation-1', kind: 'agent' as const }
  const fullText = JSON.stringify({
    schemaVersion: 1, type: 'huaanwork.task-result', title: '季度报告', format: 'html', content: '<p>正文</p>',
  })
  const first = await adaptAutomationResult(h.routeCtx, automation, 'session-1', 'run-1', fullText)
  const replay = await adaptAutomationResult(h.routeCtx, automation, 'session-1', 'run-1', fullText)
  expect(first.outcome).toBe('created')
  expect(replay.outcome).toBe('created')
  if (first.outcome === 'created' && replay.outcome === 'created') {
    expect(replay.artifact.artifactId).toBe(first.artifact.artifactId)
  }
  expect(h.events.filter((event) => event.event === 'artifact/created')).toHaveLength(1)
  expect(h.createArtifact).toHaveBeenCalledTimes(1)
})

it('records validated title and format when persistence fails', async () => {
  const h = makeHarness({ createArtifactError: new Error('artifact-write-failed') })
  const fullText = JSON.stringify({
    schemaVersion: 1, type: 'huaanwork.task-result', title: '季度报告', format: 'html', content: '<p>正文</p>',
  })
  const result = await adaptAutomationResult(h.routeCtx, { id: 'automation-1', kind: 'agent' }, 'session-1', 'run-2', fullText)
  expect(result).toMatchObject({
    outcome: 'failed', artifactError: 'artifact-write-failed', artifactTitle: '季度报告', artifactFormat: 'html',
  })
  const summary = await finishWithAdaptation(h, result)
  expect(summary).toMatchObject({ status: 'ok', artifactOutcome: 'failed', artifactTitle: '季度报告', artifactFormat: 'html' })
})

it('omits title and format for invalid marked envelopes', async () => {
  const h = makeHarness()
  const result = await adaptAutomationResult(
    h.routeCtx,
    { id: 'automation-1', kind: 'agent' },
    'session-1',
    'run-3',
    '{"schemaVersion":1,"type":"huaanwork.task-result","title":"坏封套","format":"pdf","content":"正文"}',
  )
  expect(result).toMatchObject({ outcome: 'failed', artifactError: 'invalid-result-envelope' })
  expect(result).not.toHaveProperty('artifactTitle')
  expect(result).not.toHaveProperty('artifactFormat')
})
```

上述 harness 扩展只负责接线：`createArtifactError` 让存储抛错，`h.createArtifact` 记录真实存储调用次数，`finishWithAdaptation` 将 adaptation 映射为 run 参数后调用现有 `finishAutomation` 并重新读取落盘 summary；不得用 fake summary 代替持久化断言。`getRunSummary` 是本 spec 内声明的 harness 包装，**不是 store 既有导出**：实现为 `(await recentRuns(profileDir, automationId, 100)).find((run) => run.runId === runId)`，未命中返回 `undefined`；不得按虚构的宿主 API 新建生产函数。

- [ ] **Step 2: 确认提示注入测试失败**

Run:
```bash
corepack yarn workspace dsh-plugin-huaanwork vitest run tests/huaanwork-host/automations-host.spec.ts tests/huaanwork-host/automation-artifacts.spec.ts
```
Expected: FAIL，当前 prompt 无封套指引。

- [ ] **Step 3: 在唯一 prompt 组装点注入固定文本**

`AUTOMATION_RESULT_CONTRACT` 使用规格中的完整文本。`runAgentTurn` 改为：

```ts
const body = [
  ...(mergedPrefix ? ['上次成功运行的产出（截断至 4 KB）：', mergedPrefix] : []),
  automation.prompt ?? '',
  AUTOMATION_RESULT_CONTRACT,
].join('\n')
const prompt = `<automation-fire name="${escapeXmlAttr(automation.name)}" trigger="${trigger}" missed="${missed}">\n${body}\n</automation-fire>`
```

不得只加入某一触发分支，也不得注入普通会话或脚本命令。

- [ ] **Step 4: 实现唯一终态封套适配器**

封套类型固定：

```ts
type AutomationResultEnvelope = {
  schemaVersion: 1
  type: 'huaanwork.task-result'
  title: string
  format: 'markdown' | 'html'
  content: string
  downloadName?: string
}
```

`adaptAutomationResult` 对 `fullText.trim()` 整体 `JSON.parse`；不得从解释文字中抽取最后一个对象。带 `type/schemaVersion` 标记但校验失败返回 `{outcome:'failed',artifactError:'invalid-result-envelope'}`（title/format 不可确认，不携带）。无标记 JSON 对象/数组经 `jsonToBlocks` 和 `blocksToMarkdown` 转为 Markdown；普通文本返回 skipped。

成功调用 `createArtifact`，anchor 为 `{kind:'automation-run',automationId:automation.id,runId}`，幂等为同两者；随后 emit `artifact/created` 并返回 created。适配入口先按 `automationId + runId` 查既有 Artifact，已存在则直接复用并返回 created，不重复写盘、不重复 emit。存储失败返回 failed、稳定错误码和已通过校验的 `artifactTitle`/`artifactFormat`，不抛掉原任务执行结果。

- [ ] **Step 5: 在截断前接线并持久化 outcome**

适配前先检查取消标记：`cancelled` 运行不调用适配器、不写任何 artifact 字段（AM-1：取消覆盖先于适配）。在 `executeRun` 获得完整 `output` 后、`finishAutomation` 前调用适配器；仅 `automation.kind==='agent'` 调用。将 created/failed 映射到 run 参数：

```ts
const artifactFields = adaptation.outcome === 'created'
  ? { artifactOutcome: 'created' as const, artifactId: adaptation.artifact.artifactId }
  : adaptation.outcome === 'failed'
    ? {
        artifactOutcome: 'failed' as const,
        artifactError: adaptation.artifactError,
        ...(adaptation.artifactTitle !== undefined ? { artifactTitle: adaptation.artifactTitle } : {}),
        ...(adaptation.artifactFormat !== undefined ? { artifactFormat: adaptation.artifactFormat } : {}),
      }
    : {}
```

将 `artifactFields` 条件展开到 run 参数，不在 skipped 时写入值为 undefined 的可选键。`finishAutomation` 把这份 `artifactFields` 原样写入 `RunSummary` 并构造 `automation/run-end`（emit 与入库同源同一份对象，不得二次构造，避免实时事件与历史记录漂移）；成功时 `artifact/created` 可按 `runId` 暂存，失败没有事件——错误卡的唯一来源是 `run-end`/`RunSummary` 字段。现有 `clipOutput` 与任务执行状态不变。脚本分支不调用适配器。

Run:
```bash
corepack yarn workspace dsh-plugin-huaanwork vitest run tests/huaanwork-host/automation-artifacts.spec.ts tests/huaanwork-host/automations-host.spec.ts tests/huaanwork-host/automations-script-error.spec.ts
```
Expected: PASS；同 runId 重放无双写，长正文在运行摘要截断前完整入 Artifact。

- [ ] **Step 6: Commit**

```bash
git add dsh-plugin-huaanwork/src/huaanwork-host/automation-artifacts.ts dsh-plugin-huaanwork/src/huaanwork-host/automations-host.ts dsh-plugin-huaanwork/src/client-huaanwork/rpc-types.ts dsh-plugin-huaanwork/tests/huaanwork-host/automation-artifacts.spec.ts dsh-plugin-huaanwork/tests/huaanwork-host/automations-host.spec.ts dsh-plugin-huaanwork/tests/huaanwork-host/automations-script-error.spec.ts
git commit -m "feat(artifacts): adapt complete automation result envelopes"
```

---

### Task 4: Artifact 查询 RPC 与按需正文读取

**Files:**
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/routes.ts`
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/rpc-types.ts:3-84`
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/api.ts:13-146`
- Test: `dsh-plugin-huaanwork/tests/huaanwork-host/artifact-routes.spec.ts`
- Test: `dsh-plugin-huaanwork/tests/client-huaanwork/api.spec.ts`

**Interfaces:**
- Produces: `artifact.get`、`artifact.content`、`artifact.list`。
- Preserves: `rpc-types` method 联合与 `api.ts` ROUTES 双事实源一致。

- [ ] **Step 1: 写路由归属和按需读取失败测试**

测试文件从 `agent-package-creation.spec.ts:88` 复制最小 `makeRouteCtx` 夹具，并使用以下真实 ROUTE_TABLE 调用器：

```ts
const sessionId = 'session-1'
const artifactInput = {
  sessionId, title: '报告', format: 'markdown' as const, content: '# 正文',
  anchor: { kind: 'turn' as const }, idempotency: { kind: 'tool' as const, callId: 'route-call-1' },
}

function call(method: string, routeCtx: RouteContext, params: Record<string, string>) {
  const route = ROUTE_TABLE.find((item) => item.method === method)
  if (!route) throw new Error(`missing route ${method}`)
  return route.handler({ params: {}, body: undefined, query: new URLSearchParams(params) }, routeCtx)
}

it('reads content only for the owning profile and session', async () => {
  const profileDir = mkdtempSync(join(tmpdir(), 'artifact-route-'))
  const routeCtx = makeRouteCtx(profileDir, [])
  const artifact = await createArtifact(profileDir, artifactInput)
  expect((await call('artifact.get', routeCtx, { sessionId, artifactId: artifact.artifactId })).artifact.title).toBe('报告')
  expect((await call('artifact.content', routeCtx, { sessionId, artifactId: artifact.artifactId })).content).toBe('# 正文')
  await expect(call('artifact.content', routeCtx, { sessionId: 'other', artifactId: artifact.artifactId })).rejects.toThrow('artifact-not-found')
})
```

另测 list 只含摘要、不含 content；query 缺字段、路径穿越和未知 ID 均失败。

- [ ] **Step 2: 确认路由测试失败**

Run:
```bash
corepack yarn workspace dsh-plugin-huaanwork vitest run tests/huaanwork-host/artifact-routes.spec.ts tests/client-huaanwork/api.spec.ts
```
Expected: FAIL，方法不在 ROUTE_TABLE/ROUTES。

- [ ] **Step 3: 实现三个只读路由**

```text
artifact.get      → GET /huaanwork/artifact/get
artifact.content  → GET /huaanwork/artifact/content
artifact.list     → GET /huaanwork/artifact/list
```

三个 GET 都通过既有 `objectQuery`（客户端 `dsh-plugin-huaanwork/src/client-huaanwork/api.ts` 的查询构造助手）传递 `sessionId` 与 `artifactId`（list 只传 sessionId）。实际路径常量加入 ROUTE_TABLE 和客户端 ROUTES；handler 从 `routeCtx.profileDir` 取存储根，不信任调用方 path。`artifact.content` 返回 `{artifact: summary, content: buffer.toString('utf8')}`；其他路由不读正文。list 按 createdAt/artifactId 确定性排序。

- [ ] **Step 4: 运行路由、既有 webserver 与类型回归**

Run:
```bash
corepack yarn workspace dsh-plugin-huaanwork vitest run tests/huaanwork-host/artifact-routes.spec.ts tests/client-huaanwork/api.spec.ts tests/webserver.spec.ts
corepack yarn workspace dsh-plugin-huaanwork typecheck
```
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add dsh-plugin-huaanwork/src/huaanwork-host/routes.ts dsh-plugin-huaanwork/src/client-huaanwork/rpc-types.ts dsh-plugin-huaanwork/src/client-huaanwork/api.ts dsh-plugin-huaanwork/tests/huaanwork-host/artifact-routes.spec.ts dsh-plugin-huaanwork/tests/client-huaanwork/api.spec.ts
git commit -m "feat(artifacts): expose scoped on-demand result reads"
```

---

### Task 5: 统一结果卡、工具正文抑制与新旧自动化折叠互斥

**Files:**
- Create: `dsh-plugin-huaanwork/src/client-huaanwork/ResultArtifactCard.tsx`
- Create: `dsh-plugin-huaanwork/src/client-huaanwork/logic/artifactProjection.ts`
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/App.tsx`
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/logic/sessionChannel.ts`
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/logic/runResultAttachments.ts`
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/logic/runTabsLogic.ts`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/session-view.ts:203-253`
- Test: `dsh-plugin-huaanwork/tests/client-huaanwork/artifactProjection.spec.ts`
- Test: `dsh-plugin-huaanwork/tests/client-huaanwork/runResultAttachments.spec.ts`
- Test: `dsh-plugin-huaanwork/tests/client-huaanwork/sessionChannel.spec.ts`
- Test: `dsh-plugin-huaanwork/tests/client-huaanwork/runTabsLogic.spec.ts`
- Test: `dsh-plugin-huaanwork/tests/client-huaanwork/appWiring.spec.ts`

**Interfaces:**
- Produces: `ChatItem kind="artifact"`、`kind="artifact-error"`、`ResultArtifactCard`。
- Produces: `projectAutomationResult(items, run, artifact?, createAttachment?)`、`insertArtifactIntoHistory(items, artifact, allocId, run?)`、`shouldApplyArtifactResponse(current, response)`、`openArtifactPreview(state, artifactId)`。
- Produces: 内容暂不可读时的占位/重试卡投影（`artifact-loading` → 重试后收敛 `artifact-error`）。
- Preserves: 无 `artifactOutcome` 的旧运行仍使用 `foldRunAssistantItems(items, createAttachment)`；签名扩展注入附件构造器，旧分支每次运行仍只插 1 个 attachment，attachment id 由调用方显式传入的 id 工厂生成，不得自增计数器。

- [ ] **Step 1: 写唯一展示与历史锚定失败测试**

```ts
const resultPresentToolCall = {
  kind: 'tool-call' as const, time: 1, name: 'result_present', callId: 'call-1',
  args: '{"title":"报告","format":"markdown","content":"完整结果正文"}',
}
const resultPresentToolResult = {
  kind: 'tool-result' as const, time: 2, callId: 'call-1', text: '已生成结果页', isError: false,
}
type ProjectionItem = { id: number; kind: string; text?: string; sourceText?: string }
const items: ProjectionItem[] = [{ id: 1, kind: 'assistant', text: '{"title":"报告","content":"完整结果正文"}' }]
const legacyItems = items
const createdRun = { artifactOutcome: 'created' as const, artifactId: 'artifact-1' }
const failedRun = { artifactOutcome: 'failed' as const, artifactError: 'artifact-write-failed' }
const legacyRun = {}
const isArtifactCard = (item: { kind: string }) => item.kind === 'artifact'
const isArtifactErrorCard = (item: { kind: string }) => item.kind === 'artifact-error'
const isLegacyAttachment = (item: { kind: string }) => item.kind === 'attachment'
const createAttachment = (sourceText: string): ProjectionItem => ({ id: 99, kind: 'attachment', sourceText })

function artifactFixture(anchor: ArtifactAnchor): TaskArtifactSummary {
  return {
    artifactId: 'artifact-1', sessionId: 'session-1', title: '报告', format: 'markdown',
    downloadName: '报告.md', sizeBytes: 4, sha256: 'sha256:test', createdAt: '2026-11-15T10:00:00.000Z', anchor,
  }
}
const artifact = artifactFixture({ kind: 'turn', clientMessageId: 'message-1' })
const unanchoredArtifact = artifactFixture({ kind: 'turn' })

it('never shows result_present arguments as a tool card', () => {
  const items = historyItemsFromRecords([resultPresentToolCall, resultPresentToolResult])
  expect(items.some((item) => item.kind === 'tool')).toBe(false)
  expect(JSON.stringify(items)).not.toContain('完整结果正文')
})

it('uses exactly one automation result presentation', () => {
  expect(projectAutomationResult(items, createdRun, artifact).filter(isArtifactCard)).toHaveLength(1)
  expect(projectAutomationResult(items, failedRun).filter(isArtifactErrorCard)).toHaveLength(1)
  expect(projectAutomationResult(legacyItems, legacyRun, undefined, createAttachment).filter(isLegacyAttachment)).toHaveLength(1)
})

it('removes the original envelope and never duplicates created cards', () => {
  const projected = projectAutomationResult(items, createdRun, artifact)
  expect(JSON.stringify(projected)).not.toContain('完整结果正文') // AI-5：原封套/正文消失
  expect(projected.filter((item) => item.kind === 'assistant')).toHaveLength(0)
  expect(projected.filter(isArtifactCard)).toHaveLength(1) // 不得重复卡
  // 同一 artifactId 的 created 事件 + artifact.list 快照去重后仍只有一张卡
  const withListReplay = projectAutomationResult(projected, createdRun, artifact)
  expect(withListReplay.filter(isArtifactCard)).toHaveLength(1)
})

it('shows a failed run as a single error card with title, format and error code', () => {
  const failedWithMeta = {
    artifactOutcome: 'failed' as const,
    artifactError: 'artifact-write-failed',
    artifactTitle: '季度报告',
    artifactFormat: 'html' as const,
  }
  const projected = projectAutomationResult(items, failedWithMeta)
  expect(projected.filter(isArtifactErrorCard)).toHaveLength(1)
  expect(projected.filter((item) => item.kind === 'assistant')).toHaveLength(0)
  expect(projected.filter(isArtifactCard)).toHaveLength(0)
  expect(projected.filter(isLegacyAttachment)).toHaveLength(0)
  expect(JSON.stringify(projected)).toContain('季度报告')
  expect(JSON.stringify(projected)).toContain('artifact-write-failed')
  expect(JSON.stringify(projected)).not.toContain('完整结果正文')
  // 校验失败的封套无 title/format：回退“任务结果/未知格式”
  const projectedUnknown = projectAutomationResult(items, failedRun)
  expect(JSON.stringify(projectedUnknown)).toContain('任务结果')
  expect(JSON.stringify(projectedUnknown)).toContain('未知格式')
})

it('keeps a temporarily unreadable artifact as a retryable placeholder, then a terminal error card', () => {
  const loading = projectAutomationResult(items, createdRun, undefined /* 摘要暂存、内容未读 */)
  expect(loading.filter((item) => item.kind === 'artifact-loading')).toHaveLength(1)
  expect(loading.filter(isLegacyAttachment)).toHaveLength(0) // 不回退旧附件
  expect(JSON.stringify(loading)).not.toContain('完整结果正文')
  const permanent = projectAutomationResult(items, { ...createdRun, artifactReadError: 'artifact-content-missing' })
  expect(permanent.filter((item) => item.kind === 'artifact-loading')).toHaveLength(0) // 不无限停留
  expect(permanent.filter(isArtifactErrorCard)).toHaveLength(1)
})

it('backfills a lost created event from RunSummary without double-emitting', () => {
  const loading = projectAutomationResult(items, createdRun, undefined)
  expect(loading.filter((item) => item.kind === 'artifact-loading')).toHaveLength(1)
  const repaired = projectAutomationResult(loading, createdRun, artifact)
  expect(repaired.filter(isArtifactCard)).toHaveLength(1)
  expect(repaired.filter((item) => item.kind === 'artifact-loading')).toHaveLength(0)
  expect(repaired.filter(isLegacyAttachment)).toHaveLength(0)
  expect(JSON.stringify(repaired)).not.toContain('完整结果正文')
  // Host 侧“只 emit 一次”由 Task 3 的适配重放测试覆盖，投影不再触发任何 emit。
})

it('places an unanchored historical artifact in the explicit group', () => {
  const result = insertArtifactIntoHistory([], unanchoredArtifact, () => 9)
  expect(result[0]).toMatchObject({ kind: 'artifact-group', text: '未定位的历史结果' })
  expect(result[1].kind).toBe('artifact')
})

it('places an automation artifact immediately before its exact run footer', () => {
  const automationArtifact = artifactFixture({
    kind: 'automation-run', automationId: 'automation-1', runId: 'run-1',
  })
  const run = { automationId: 'automation-1', summary: { runId: 'run-1', status: 'ok' as const } }
  const history = [
    { id: 1, kind: 'assistant' as const, text: '运行中' },
    { id: 2, kind: 'note' as const, text: runResultNoteText(run.summary.status) },
  ]
  const result = insertArtifactIntoHistory(history, automationArtifact, () => 3, run)
  expect(result.map((item) => item.kind)).toEqual(['assistant', 'artifact', 'note'])
})

it('clicking the card opens the preview rail and selects the artifact', async () => {
  const fetchArtifact = vi.fn().mockResolvedValue({ summary: artifact, content: '# 正文' })
  const next = await openArtifactPreview(
    { rightOpen: false, rightTab: 'chat', previewArtifactId: undefined },
    'artifact-1',
    fetchArtifact,
  )
  expect(next).toMatchObject({ rightOpen: true, rightTab: 'preview', previewArtifactId: 'artifact-1' })
  expect(fetchArtifact).toHaveBeenCalledWith('artifact-1') // 触发 artifact.get + artifact.content
})

it('drops a late response from the previously selected session', () => {
  expect(shouldApplyArtifactResponse(
    { sessionId: 'new-session', epoch: 4 },
    { sessionId: 'old-session', epoch: 3 },
  )).toBe(false)
})
```

- [ ] **Step 2: 确认客户端投影测试失败**

Run:
```bash
corepack yarn workspace dsh-plugin-huaanwork vitest run tests/client-huaanwork/artifactProjection.spec.ts tests/client-huaanwork/sessionChannel.spec.ts tests/client-huaanwork/runResultAttachments.spec.ts
```
Expected: FAIL，新投影不存在且新封套会走旧折叠。

- [ ] **Step 3: 实现确定性历史锚点**

规则固定为纯函数实现（找不到精确锚点时才进入未定位分组）：

```ts
function insertArtifactIntoHistory(
  items: ChatItem[],
  artifact: TaskArtifactSummary,
  allocId: () => number,
  run?: { automationId: string; summary: Pick<RunSummary, 'runId' | 'status'> },
): ChatItem[] {
  if (items.some((item) => item.kind === 'artifact' && item.artifactId === artifact.artifactId)) return items
  const card: ChatItem = { id: allocId(), kind: 'artifact', artifactId: artifact.artifactId, artifact }
  if (artifact.anchor.kind === 'turn' && artifact.anchor.clientMessageId) {
    const anchorIndex = items.findIndex((item) =>
      item.kind === 'user' && item.clientMessageId === artifact.anchor.clientMessageId)
    if (anchorIndex >= 0) {
      const nextUser = items.findIndex((item, index) => index > anchorIndex && item.kind === 'user')
      const insertAt = nextUser < 0 ? items.length : nextUser
      return [...items.slice(0, insertAt), card, ...items.slice(insertAt)]
    }
  }
  if (artifact.anchor.kind === 'automation-run') {
    const exactRun = run !== undefined
      && run.automationId === artifact.anchor.automationId
      && run.summary.runId === artifact.anchor.runId
    const footnoteText = exactRun ? runResultNoteText(run.summary.status) : undefined
    const footnote = footnoteText === undefined
      ? -1
      : items.findLastIndex((item) => item.kind === 'note' && item.text === footnoteText)
    if (footnote >= 0) return [...items.slice(0, footnote), card, ...items.slice(footnote)]
  }
  if (items.some((item) => item.kind === 'artifact-group')) return [...items, card]
  return [
    ...items,
    { id: allocId(), kind: 'artifact-group', text: '未定位的历史结果' },
    card,
  ]
}
```

自动化定位先由 `RunSummary` 的 `automationId + runId` 选中唯一运行标签，再执行上述 footnote 插入；不得跨运行标签查找。未定位分组只保留一个；历史回填先按 `createdAt/artifactId` 对 `artifact.list` 排序，再逐项调用本函数，避免实时事件到达次序影响历史顺序。

`session-view.ts` 的 user `data.id → clientMessageId` 透传、`HistoryChatItem`/`ChatItem` 的 user 字段与 `historyToChatItems` 接线均由进度计划 Task 1 提供，本 Task 只消费，不重复实现；普通高级会话使用 App 发送时生成的 `crypto.randomUUID()`（Host 兜底 `顶层 clientMessageId ?? randomUUID()`），自动化回合等于 `runId`（run-start user item 同源），`ChatItem.id` 仍用渲染侧 allocId，二者不得混用（禁用 `String(userMsg.id)`，刷新后 allocId 会重复）；既有 `at.clientMessageId` 数值字符串仅作 legacy 展示兼容读取，不参与精确匹配。不修改上游日志格式。缺失时使用未定位分组，不按正文或时间猜测。

所有 `artifact.get/content/list` 请求在发起时捕获 `{sessionId, epoch}`，返回后必须经过同一纯函数；只有当前选择仍匹配才写入标签：

```ts
export function shouldApplyArtifactResponse(
  current: { sessionId: string; epoch: number },
  response: { sessionId: string; epoch: number },
): boolean {
  return current.sessionId === response.sessionId && current.epoch === response.epoch
}
```

会话切换时递增既有 reconcile epoch；旧会话或旧 epoch 的内容响应直接丢弃，不得覆盖当前预览。

- [ ] **Step 4: 抑制 `result_present` 的实时与历史工具卡**

实时 `tool/start/tool/end` 遇到该工具不写普通工具卡；失败只追加不含参数的紧凑 note。历史 `sessionChannel` 跳过该工具的 call/result 配对；`session-view` 不调用通用 `formatToolArguments` 生成正文参数。成功结果只由 `artifact/created` 或 `artifact.list` 插卡。

- [ ] **Step 5: 实现自动化三态投影**

`projectAutomationResult(items, run, artifact?, createAttachment?)` 规则（`createAttachment` 只有走旧折叠时才允许省略调用方传入；进入旧分支时缺失必须抛出 `legacy-attachment-factory-required`，不得自增计数器）：

```ts
if (run.artifactOutcome === 'created' && run.artifactReadError) {
  return replaceRunAssistantWithError(items, {
    title: artifact?.title ?? '任务结果',
    format: artifact?.format ?? 'unknown',
    error: run.artifactReadError,
  })
}
if (run.artifactOutcome === 'created' && artifact) return replaceRunAssistantWithArtifact(items, artifact)
if (run.artifactOutcome === 'created' && !artifact) return replaceRunAssistantWithArtifactLoading(items, run.artifactId)
if (run.artifactOutcome === 'failed') {
  return replaceRunAssistantWithError(items, {
    title: run.artifactTitle ?? '任务结果',
    format: run.artifactFormat ?? 'unknown',
    error: run.artifactError ?? 'artifact-write-failed',
  })
}
if (run.artifactOutcome === undefined) {
  if (!createAttachment) throw new Error('legacy-attachment-factory-required')
  return foldRunAssistantItems(items, createAttachment)
}
return items
```

实时 `run-end` 与历史回填都调用它，但 run 来源必须分清：**实时路径直接用当前 `run-end` event 的 automation/run/status/artifact 字段构造投影所需 run 对象，历史路径使用持久化 `RunSummary`**；实时侧不得再猜事件顺序或额外拉取运行列表。`artifact/created` 事件丢失时用 RunSummary.artifactId + `artifact.get/list` 补齐。`artifactReadError` 仅是客户端读取失败状态，不写回 `RunSummary`，也不把 `artifactOutcome` 改成 `failed`。created 事件与 list 快照按 `artifactId` 去重，同一运行只渲染一张卡；补齐路径不得重复 emit。`artifact-loading` 占位卡带重试按钮，重试仍失败按永久失败收敛为无正文错误终态，不无限停留原封套、不回退旧附件。失败卡不含原始封套，原始 output 仍由既有运行记录规则保留。

在 `appWiring.spec.ts` 增加 **run-end 接线级钉**：定位真实 run-end 处理分支，分别覆盖 `artifactOutcome='created'` 与 `'failed'`，断言它们用 event 构造的 run 调用 `projectAutomationResult`，且该分支不调用 `foldRunAssistantItems`；无 `artifactOutcome` 的旧运行仍走旧折叠。沿用该文件现有源码接线断言风格，不只测脱离 App 的纯函数；同步校对既有 `foldRunAssistantItems` 调用计数钉，若分支重构改变静态计数，应按真实调用点更新并说明，不得把旧折叠从 legacy 分支一并删除。

旧折叠签名同步改为 `foldRunAssistantItems(items, createAttachment)`：旧分支只插 1 个 attachment，attachment 对象由注入的构造器创建，id 由调用方显式传入的 id 工厂生成（AI-4）；旧行为（无 `artifactOutcome` 历史运行生成“结果.md/结果.html”双附件）不扩张。

- [ ] **Step 6: 运行客户端投影回归**

Run:
```bash
corepack yarn workspace dsh-plugin-huaanwork vitest run tests/client-huaanwork/artifactProjection.spec.ts tests/client-huaanwork/runResultAttachments.spec.ts tests/client-huaanwork/sessionChannel.spec.ts tests/client-huaanwork/runTabsLogic.spec.ts tests/client-huaanwork/appWiring.spec.ts
```
Expected: PASS；任何事件顺序都不出现正文工具卡 + Artifact 或 Artifact + 旧双附件。

- [ ] **Step 7: Commit**

```bash
git add dsh-plugin-huaanwork/src/client-huaanwork/ResultArtifactCard.tsx dsh-plugin-huaanwork/src/client-huaanwork/logic/artifactProjection.ts dsh-plugin-huaanwork/src/client-huaanwork/App.tsx dsh-plugin-huaanwork/src/client-huaanwork/logic/sessionChannel.ts dsh-plugin-huaanwork/src/client-huaanwork/logic/runResultAttachments.ts dsh-plugin-huaanwork/src/client-huaanwork/logic/runTabsLogic.ts dsh-plugin-huaanwork/src/huaanwork-host/session-view.ts dsh-plugin-huaanwork/tests/client-huaanwork/artifactProjection.spec.ts dsh-plugin-huaanwork/tests/client-huaanwork/runResultAttachments.spec.ts dsh-plugin-huaanwork/tests/client-huaanwork/sessionChannel.spec.ts dsh-plugin-huaanwork/tests/client-huaanwork/runTabsLogic.spec.ts dsh-plugin-huaanwork/tests/client-huaanwork/appWiring.spec.ts
git commit -m "feat(artifacts): unify live and historical result cards"
```

---

### Task 6: Markdown/HTML 右侧预览与安全沙箱

**Files:**
- Create: `dsh-plugin-huaanwork/src/client-huaanwork/ArtifactPreview.tsx`
- Create: `dsh-plugin-huaanwork/src/client-huaanwork/ArtifactMarkdownView.tsx`
- Create: `dsh-plugin-huaanwork/src/client-huaanwork/ArtifactHtmlView.tsx`
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/App.tsx:3064-3090,3970-4017`
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/styles.css`
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/styles.generated.ts`
- Modify: `dsh-plugin-huaanwork/package.json`（显式声明 AST/GFM/math 解析依赖，并新增 `test:artifact-sandbox` 专用 script）
- Create: `dsh-plugin-huaanwork/vitest.artifact-sandbox.config.ts`（真实图形探针独立 include）
- Modify: `.github/workflows/ci.yml`（desktop-windows/desktop-macos 各增专用探针 step）
- Modify: `yarn.lock`（随依赖安装更新）
- Test: `dsh-plugin-huaanwork/tests/client-huaanwork/ArtifactPreview.spec.ts`
- Test: `dsh-plugin-huaanwork/tests/client-huaanwork/styles-generated.spec.ts`
- Test: `dsh-plugin-huaanwork/tests/electron/artifact-sandbox-probe.electron.ts`（真实 Electron renderer 探针；`.electron.ts` 不匹配默认 `tests/**/*.spec.ts`）
- Test: `dsh-plugin-huaanwork/tests/electron/artifact-sandbox-main.mjs`（探针专用隐藏窗口入口）

**Interfaces:**
- Produces: `ArtifactPreview({artifact, onFullscreen, onDownload, error?, onRetry})`、`ArtifactHtmlView({content,title})`。
- Produces: `withArtifactContentSecurity(content: string): string`。
- Consumes: 上游包根导出的 `MarkdownText` 和 `MarkdownLabels`。

- [ ] **Step 1: 写渲染选择、CSP 和 sandbox 失败测试**

测试文件使用 `// @vitest-environment jsdom`，从 `react-dom/server` 导入 `renderToStaticMarkup`，从 `react` 导入 `createElement`。

```ts
it('selects the declared renderer', () => {
  expect(rendererFor({ format: 'markdown' })).toBe('markdown')
  expect(rendererFor({ format: 'html' })).toBe('html')
})

function renderHtmlFrame(content: string): HTMLIFrameElement {
  const markup = renderToStaticMarkup(createElement(ArtifactHtmlView, { content, title: '结果' }))
  const document = new DOMParser().parseFromString(markup, 'text/html')
  const frame = document.querySelector('iframe')
  if (!frame) throw new Error('iframe missing')
  return frame
}

it('allows scripts only inside an opaque sandbox and denies network', () => {
  const secured = withArtifactContentSecurity('<script>window.ran=true</script>')
  expect(secured).toContain("default-src 'none'")
  expect(secured).toContain("connect-src 'none'")
  expect(secured).toContain("script-src 'unsafe-inline'")
  // AI-7：CSP meta 必须出现在任何模型内容之前，srcDoc 非空、src 必须为空
  expect(secured.indexOf('Content-Security-Policy')).toBeLessThan(secured.indexOf('<script>window.ran=true</script>'))
  const frame = renderHtmlFrame(secured)
  expect(frame.getAttribute('sandbox')).toBe('allow-scripts')
  expect(frame.getAttribute('sandbox')).not.toContain('allow-same-origin')
  expect(frame.getAttribute('srcDoc')?.length).toBeGreaterThan(0)
  expect(frame.getAttribute('src')).toBeNull()
})

it('does not auto-load remote images in markdown artifacts', () => {
  const markup = renderToStaticMarkup(createElement(ArtifactMarkdownView, {
    content: '![远程图](https://example.com/x.png)\n\n[链接](https://example.com/doc)',
  }))
  expect(markup).not.toContain('src="https://example.com/x.png"') // 远程 img 不自动加载（AM-8）
  expect(markup).toContain('https://example.com/doc') // http 链接保留走既有安全打开
})
```

真实 Electron renderer 探针使用既有 `playwright-core`，启动隐藏窗口，不启用 Node preload、不添加 `--no-sandbox`。`tests/electron/artifact-sandbox-main.mjs` 只创建测试窗口：

```js
import { app, BrowserWindow } from 'electron'
await app.whenReady()
const window = new BrowserWindow({
  show: false,
  webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true },
})
await window.loadURL('about:blank')
app.on('window-all-closed', () => app.quit())
```

`tests/electron/artifact-sandbox-probe.electron.ts` 通过真实 `srcDoc` iframe 检查行为，不读取静态 HTML 代替。该后缀不匹配公共 `vitest.config.ts` 的 `tests/**/*.spec.ts`，因此默认 workspace `test`、根 `test`、根 `check` 与 Ubuntu `check` job 都不会启动它；公共 Vitest 配置不做改动。

```ts
import { expect, it } from 'vitest'
import electronPath from 'electron'
import { _electron as electron } from 'playwright-core'
import { fileURLToPath } from 'node:url'

it('executes inline scripts while denying network and privileged access', async () => {
  const app = await electron.launch({
    executablePath: electronPath,
    args: [fileURLToPath(new URL('./artifact-sandbox-main.mjs', import.meta.url))],
  })
  try {
    const page = await app.firstWindow()
    const secured = withArtifactContentSecurity('<script>window.ran=true</script>')
    const srcdoc = secured.replace(/&/g, '&amp;').replace(/"/g, '&quot;')
    await page.setContent(`<iframe sandbox="allow-scripts" srcdoc="${srcdoc}"></iframe>`)
    const frame = page.frames().find((item) => item !== page.mainFrame())
    if (!frame) throw new Error('artifact iframe missing')
    await frame.waitForFunction(() => Reflect.get(window, 'ran') === true)
    const result = await frame.evaluate(async () => {
      const rejects = async (run: () => unknown) => {
        try { await run(); return false } catch { return true }
      }
      return {
        requireDenied: typeof require === 'undefined',
        processDenied: typeof process === 'undefined',
        parentDenied: (() => { try { void window.parent.location.href; return false } catch { return true } })(),
        openerDenied: window.opener === null,
        popupDenied: window.open('https://example.com') === null,
        fetchDenied: await rejects(() => fetch('https://example.com')),
        xhrDenied: await new Promise<boolean>((resolve) => {
          const request = new XMLHttpRequest()
          const timer = setTimeout(() => resolve(false), 1000)
          request.onerror = () => { clearTimeout(timer); resolve(true) }
          request.onload = () => { clearTimeout(timer); resolve(false) }
          request.open('GET', 'https://example.com')
          request.send()
        }),
        webSocketDenied: await rejects(() => new WebSocket('wss://example.com')),
        topNavigationDenied: (() => { try { window.top!.location.href = 'https://example.com'; return false } catch { return true } })(),
      }
    })
    expect(result).toEqual({
      requireDenied: true, processDenied: true, parentDenied: true, openerDenied: true,
      popupDenied: true, fetchDenied: true, xhrDenied: true, webSocketDenied: true, topNavigationDenied: true,
    })
    const formResult = await frame.evaluate(async () => {
      const before = location.href
      const form = document.createElement('form')
      form.action = 'https://example.com'
      document.body.append(form)
      form.submit()
      await new Promise((resolve) => setTimeout(resolve, 100))
      return location.href === before
    })
    expect(formResult).toBe(true)
  } finally {
    await app.close()
  }
})
```

探针必须实际启动 Electron 并读取上述运行时结果；任一能力未被拒绝都使测试失败。窗口只用于本测试并在 `finally` 关闭，不新增全局环境变量。

专用 `vitest.artifact-sandbox.config.ts` 只包含该探针，并保留 Windows 的既有 Electron 准备步骤：

```ts
import { defineConfig } from 'vitest/config'
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/electron/artifact-sandbox-probe.electron.ts'],
    globalSetup: process.platform === 'win32' ? ['../scripts/prepare-test-electron.mjs'] : [],
  },
})
```

`package.json` 增加 `"test:artifact-sandbox": "vitest run --config vitest.artifact-sandbox.config.ts"`。`.github/workflows/ci.yml` 在 `desktop-windows` 与 `desktop-macos` 的 `check:*:platform` 成功之后各增加以下 step，不在 Ubuntu `check` job、默认 workspace `test` 或根 `test/check` 中运行：

```yaml
- name: Artifact sandbox renderer probe
  if: matrix.workspace == 'dsh-plugin-huaanwork'
  run: yarn workspace dsh-plugin-huaanwork test:artifact-sandbox
```

另测 Markdown 原始 HTML/不安全协议由上游安全策略禁用，不传 fileMentions/pathImages，本地路径不解析为文件读取；`ArtifactPreview` 收到读取错误时显示 `role="alert"` 和“重试”按钮，点击调用 onRetry，不得把空内容显示为成功页面。

- [ ] **Step 2: 确认预览测试失败**

Run:
```bash
corepack yarn workspace dsh-plugin-huaanwork vitest run tests/client-huaanwork/ArtifactPreview.spec.ts
```
Expected: FAIL，新组件不存在。

- [ ] **Step 3: 实现 Markdown 正式包适配器**

```tsx
import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { mathFromMarkdown } from 'mdast-util-math'
import { gfm } from 'micromark-extension-gfm'
import { math } from 'micromark-extension-math'

const labels: MarkdownLabels = {
  code: {
    copyLabel: '复制', copiedLabel: '已复制',
    toolbarLabels: { codeLabel: '代码', wrapLabel: '换行', unwrapLabel: '不换行' },
  },
  footnotes: '脚注',
}

type MarkdownNode = {
  type: string
  url?: string
  position?: { start: { offset?: number }; end: { offset?: number } }
  children?: MarkdownNode[]
}

/** 在渲染前移除远程图片节点；保留其位置之外的 GFM/表格/数学/代码块原文。 */
export function withoutRemoteMarkdownImages(content: string): string {
  const replacements: Array<{ start: number; end: number }> = []
  const visit = (node: MarkdownNode) => {
    if ((node.type === 'image' || node.type === 'imageReference') && /^https?:\/\//i.test(node.url ?? '')) {
      const start = node.position?.start.offset
      const end = node.position?.end.offset
      if (start === undefined || end === undefined) throw new Error('artifact-markdown-image-position-missing')
      replacements.push({ start, end })
    }
    node.children?.forEach(visit)
  }
  const tree = fromMarkdown(content, {
    extensions: [gfm(), math()],
    mdastExtensions: [gfmFromMarkdown(), mathFromMarkdown()],
  }) as MarkdownNode
  visit(tree)
  return replacements.sort((a, b) => b.start - a.start).reduce(
    (text, edit) => `${text.slice(0, edit.start)}远程图片（已禁用）${text.slice(edit.end)}`,
    content,
  )
}

export function ArtifactMarkdownView({ content }: { content: string }) {
  return <MarkdownText text={withoutRemoteMarkdownImages(content)} streaming={false} labels={labels} />
}
```

解析器使用与上游相同的公开 npm 包和版本：`mdast-util-from-markdown@^2.0.3`、`mdast-util-gfm@^3.1.0`、`mdast-util-math@^3.0.0`、`micromark-extension-gfm@^3.0.0`、`micromark-extension-math@^3.1.0`。这些依赖只负责给出 AST 与 UTF-16 源码偏移，不需要另写 Markdown 序列化器；`MarkdownText` 仍从 `@deepseek-ai/dsh-client-ui-primitives` 包根导入。不得传 `fileMentions/pathImages`，也不得使用上游 npm 包并未随发布文件提供的 `src/*` 路径。测试除远程 img 不渲染外，还须断言 fenced code 中 `![示例](https://example.com/x.png)` 作为代码文本保留、表格和 KaTeX 仍渲染。运行桌面包 build，验证 CSS modules、Katex 字体和 Shiki 均本地打包。若公开导出或构建实测不满足，则按规格切换为本树受控子集渲染器，并在代码评审中记录实际原因，不静默保留失败依赖。

- [ ] **Step 4: 实现 HTML CSP 与右侧预览**

```ts
const ARTIFACT_CSP = [
  "default-src 'none'", "script-src 'unsafe-inline'", "style-src 'unsafe-inline'",
  "img-src data:", "font-src data:", "connect-src 'none'", "object-src 'none'",
  "frame-src 'none'", "worker-src 'none'", "form-action 'none'", "base-uri 'none'",
].join('; ')

export function withArtifactContentSecurity(content: string): string {
  return `<!doctype html><meta http-equiv="Content-Security-Policy" content="${ARTIFACT_CSP}">${content}`
}
```

`ArtifactHtmlView` 使用 `<iframe sandbox="allow-scripts" srcDoc={secured} title={title} />`，不添加其他 sandbox token。`ArtifactPreview` 按 `artifact.format` 选择渲染器，工具栏提供“全屏”和“下载”；点击结果卡仍留在当前会话并设置 `previewArtifactId`。

- [ ] **Step 5: 生成样式并运行构建与安全回归**

Run:
```bash
corepack yarn install
corepack yarn install --immutable
corepack yarn workspace dsh-plugin-huaanwork gen:styles
corepack yarn workspace dsh-plugin-huaanwork vitest run tests/client-huaanwork/ArtifactPreview.spec.ts tests/client-huaanwork/styles-generated.spec.ts
corepack yarn workspace dsh-plugin-huaanwork build
```
Expected: 上述 headless 命令 PASS；首次 `corepack yarn install` 更新 `yarn.lock`，随后 `--immutable` 不再产生变更。Artifact iframe 与新增渲染资源（Katex/Shiki/CSS modules）无远程运行时依赖。既有应用外壳的 Google Fonts 不在本 Task 本地化，不计入该断言，也不得声称已本地化。

真实探针另在 desktop-windows/desktop-macos CI job 或有图形会话的本地机器执行：

```bash
corepack yarn workspace dsh-plugin-huaanwork test:artifact-sandbox
```

Expected: PASS，并记录实际运行环境；无图形会话时不得把“未运行”写成通过，也不得把它重新加入 headless 默认门禁。

- [ ] **Step 6: Commit**

```bash
git add dsh-plugin-huaanwork/src/client-huaanwork/ArtifactPreview.tsx dsh-plugin-huaanwork/src/client-huaanwork/ArtifactMarkdownView.tsx dsh-plugin-huaanwork/src/client-huaanwork/ArtifactHtmlView.tsx dsh-plugin-huaanwork/src/client-huaanwork/App.tsx dsh-plugin-huaanwork/src/client-huaanwork/styles.css dsh-plugin-huaanwork/src/client-huaanwork/styles.generated.ts dsh-plugin-huaanwork/package.json dsh-plugin-huaanwork/vitest.artifact-sandbox.config.ts .github/workflows/ci.yml yarn.lock dsh-plugin-huaanwork/tests/client-huaanwork/ArtifactPreview.spec.ts dsh-plugin-huaanwork/tests/electron/artifact-sandbox-probe.electron.ts dsh-plugin-huaanwork/tests/electron/artifact-sandbox-main.mjs
git commit -m "feat(artifacts): add rendered and sandboxed result preview"
```

---

### Task 7: 独立全屏窗口、访问鉴权与系统另存为

**Files:**
- Create: `dsh-plugin-huaanwork/src/client-huaanwork/ArtifactFullscreenPage.tsx`
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/shell.ts:29-60`
- Modify: `dsh-plugin-huaanwork/src/runtime.ts`
- Modify: `dsh-plugin-huaanwork/src/host-runtime-bridge.ts:50-69,83-170,180-216`
- Modify: `dsh-plugin-huaanwork/src/electron-runtime.ts:917-921`
- Modify: `dsh-plugin-huaanwork/src/electron-shell-generation.ts:72-181,676-688,903-908`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/routes.ts`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/index.ts`
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/api.ts`
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/rpc-types.ts`
- Test: `dsh-plugin-huaanwork/tests/artifact-window.spec.ts`
- Test: `dsh-plugin-huaanwork/tests/desktop-browser-access.spec.ts`
- Test: `dsh-plugin-huaanwork/tests/electron-runtime.spec.ts`
- Test: `dsh-plugin-huaanwork/tests/client-huaanwork/artifactWindow.spec.ts`
- Test: `dsh-plugin-huaanwork/tests/huaanwork-host/artifact-routes.spec.ts`（补 summary.downloadName → native 能力的接线钉）

**Interfaces:**
- Produces: `ArtifactNativeCapability`（`openArtifactFullscreen({artifactId})` / `saveArtifact({downloadName, contentBase64, surface: 'main' | 'artifact'})` 形状）；`huaanwork-host/index.ts` 从 `ctx.desktopRuntime` 窄化提供该能力并挂入 `RouteContext`，缺失时路由返回 `artifact-native-unavailable`。
- Produces: `artifact.openFullscreen`、`artifact.download` 宿主路由。
- Produces: `ArtifactFullscreenPage`、`artifactWindowIdFromSearch(search)` 与纯函数 `artifactWindowOptions(spec: Pick<DesktopShellSpec,"url">, artifactId)`。
- Preserves: 全屏窗口无业务 preload，旧 `will-download` 只处理旧附件；保存对话框 parent 为发起请求的窗口（全屏窗口请求时不得以主窗口为 parent）。

- [ ] **Step 1: 写窗口安全参数、启动模式和下载失败测试**

窗口纯函数在 `artifact-window.spec.ts` 测试；`runtime` 与既有 Electron dialog mock 沿用 `electron-runtime.spec.ts` 装配，并扩展 `showSaveDialogMock` 捕获实现。**该文件现状没有 `node:fs/promises` 的 writeFile/rename mock**：本 Task 新增 `vi.mock('node:fs/promises', ...)` 部分 mock，提供 `writeFileMock/renameMock/rm`；不得写成“复用既有 fs mock”。`writeFileMock` 将 Buffer 按临时路径存入 `temporaryContents`，`renameMock` 将对应字节搬到 `writtenTargets`，`rm` 清理对应键，使字节测试不依赖真实临时文件。不新增全局变量。

```ts
it('opens a fullscreen artifact window without node or business preload', () => {
  const options = artifactWindowOptions({ url: 'http://127.0.0.1:3000/' }, 'artifact-1')
  expect(options.fullscreen).toBe(true)
  expect(options.webPreferences).toMatchObject({
    nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true,
  })
  expect(options.webPreferences.preload).toBeUndefined()
  expect(options.url).toContain('artifactWindow=1&artifactId=artifact-1')
})

it('does not create a file when save is cancelled', async () => {
  showSaveDialogMock.mockResolvedValue({ canceled: true, filePath: undefined })
  await expect(runtime.saveArtifact({ downloadName: '报告.md', contentBase64: '', surface: 'main' })).resolves.toEqual({ saved: false })
  expect(writeFileMock).not.toHaveBeenCalled()
})

it('parents the save dialog to the requesting window, not the main window', async () => {
  showSaveDialogMock.mockResolvedValue({ canceled: true, filePath: undefined })
  await runtime.saveArtifact({ downloadName: '报告.md', contentBase64: '', surface: 'artifact' })
  expect(showSaveDialogMock).toHaveBeenCalledWith(
    fullscreenWindow,
    expect.objectContaining({ defaultPath: '报告.md' }),
  )
  expect(showSaveDialogMock).not.toHaveBeenCalledWith(mainWindow, expect.anything())
})

it('passes the host-owned download name to defaultPath without native re-sanitizing', async () => {
  let capturedDefaultPath: string | undefined
  showSaveDialogMock.mockImplementation((window, opts) => {
    capturedDefaultPath = opts.defaultPath
    return Promise.resolve({ canceled: true, filePath: undefined })
  })
  await runtime.saveArtifact({ downloadName: 'a:b.txt', contentBase64: '', surface: 'main' })
  expect(capturedDefaultPath).toBe('a:b.txt') // native 纯透传；清理由 Task 1 summary 与 Host 路由负责
})

it('writes the exact host artifact bytes through save-as', async () => {
  const content = Buffer.from('﻿# 标题\r\n正文 😀 中文\r\n', 'utf8')
  showSaveDialogMock.mockResolvedValue({ canceled: false, filePath: '/tmp/artifact-target.html' })
  renameMock.mockImplementation(async (temporary, target) => {
    const bytes = temporaryContents.get(temporary)
    if (!bytes) throw new Error('temporary artifact bytes missing')
    writtenTargets.set(target, bytes)
  })
  await runtime.saveArtifact({ downloadName: '结果.html', contentBase64: content.toString('base64'), surface: 'main' })
  expect(writtenTargets.get('/tmp/artifact-target.html')).toEqual(content)
})

it('reloads the singleton fullscreen window for another artifact without opening a second one', async () => {
  await runtime.openArtifactFullscreen({ artifactId: 'artifact-1' })
  await runtime.openArtifactFullscreen({ artifactId: 'artifact-2' })
  expect(browserWindowConstructor).toHaveBeenCalledTimes(1)
  expect(fullscreenContents.loadURL).toHaveBeenCalledTimes(2)
  expect(fullscreenWindow.focus).toHaveBeenCalledTimes(2)
  expect(callOrder(fullscreenContents)).toEqual([
    'authenticateRendererSession', 'installRendererAccessHeader', 'loadURL',
    'authenticateRendererSession', 'installRendererAccessHeader', 'loadURL',
  ])
  expect(fullscreenContents.loadURL.mock.calls[1][0]).toContain('artifactId=artifact-2')
})

it('keeps new artifacts named 结果.md out of the legacy will-download branch', async () => {
  showSaveDialogMock.mockResolvedValue({ canceled: true, filePath: undefined })
  await runtime.saveArtifact({ downloadName: '结果.md', contentBase64: '', surface: 'main' })
  expect(showSaveDialogMock).toHaveBeenCalledTimes(1)
  expect(legacyWillDownloadHandler).not.toHaveBeenCalled()
  expect(blobDownloadCreateElement).not.toHaveBeenCalled()
})
```

另测新窗口 `authenticateRendererSession` 与 `installRendererAccessHeader` 均以新 WebContents 调用，非主窗口 ID；下载不触发旧 `will-download`。

在 `tests/huaanwork-host/artifact-routes.spec.ts` 补真正的 sanitizer 接线钉：以原始 `downloadName: '结果.txt'`、HTML 内容创建 Artifact，经 `artifact.download` 路由调用 fake `artifactNative.saveArtifact`，断言 native 收到的 `downloadName === '结果.html'`（即 Task 1 的 `summary.downloadName`），且 `contentBase64` 解码等于宿主读出的原字节。这里从路由输入原始存储名，不再由 native 单测自己先调 sanitizer；native 保持纯透传，不重复实现清理策略。

- [ ] **Step 2: 确认原生能力测试失败**

Run:
```bash
corepack yarn workspace dsh-plugin-huaanwork vitest run tests/artifact-window.spec.ts tests/desktop-browser-access.spec.ts tests/electron-runtime.spec.ts tests/client-huaanwork/artifactWindow.spec.ts
```
Expected: FAIL，native 方法和全屏页面不存在。

- [ ] **Step 3: 实现同源全屏启动模式**

`artifactWindowIdFromSearch` 只接受 `artifactWindow=1` 且 artifactId 为单路径段。`applyHuaanworkShell` 仍安装相同样式和 frame，但将 root 的 `tree` 设为：

```tsx
const artifactId = artifactWindowIdFromSearch(window.location.search)
const tree = artifactId
  ? React.createElement(ArtifactFullscreenPage, { artifactId })
  : React.createElement(App)
```

全屏页只加载 `artifact.get/content`，复用 `ArtifactPreview`，并提供关闭和下载；Esc 与关闭按钮调用浏览器窗口自身的 `window.close()`，Electron `close` 事件负责释放窗口资源。不要加载完整主 App 或业务 preload，也不新增用于关闭窗口的 RPC。

- [ ] **Step 4: 通过 HostRpc 增加两个声明式 native 能力**

在 `createHostRuntime` 增加：

```ts
openArtifactFullscreen: input => send('native:openArtifactFullscreen', [input]),
saveArtifact: input => send('native:saveArtifact', [input]),
```

将 `native:saveArtifact` 加入 interactive 无超时名单；`bindNativeRuntime` 分别为两个方法注册精确 handler，校验 artifactId、downloadName、base64 形状和 `surface === 'main' || surface === 'artifact'`。`ArtifactNativeCapability` 是独立的可选能力接口，不并入所有 `DesktopRuntime` 测试桩；`RouteContext` 增加该可选能力字段，由 `huaanwork-host/index.ts` 从 `ctx.desktopRuntime` 窄化检查后注入（AI-10：窄化与注入发生在 index.ts，不在 routes.ts 散写），路由 handler 只读 `routeCtx.artifactNative`，缺失时返回 `artifact-native-unavailable`，生产 Electron 装配必须提供。Files/commit 清单与 `RouteContext` 夹具同步补齐该字段。

Host 路由先校验 Artifact 归属；开窗只传 artifactId，下载由宿主读取原始字节后传 base64，不接受调用方文件路径。`artifact.download` 额外接收并严格校验 `surface: 'main' | 'artifact'`：主窗口 App 固定传 `main`，带 `artifactWindow=1` 启动参数的页面固定传 `artifact`，该字段仅用于选择对话框 parent，不改变归属校验。

Electron 侧开窗复用主窗口 spec.url，添加查询参数；对新 WebContents 先 `authenticateRendererSession`，再 `installRendererAccessHeader`，最后 `loadURL`。新窗口使用单例：选择新 Artifact 时在同一 `WebContents` 上按同一顺序（鉴权/header 先于每次 loadURL）重新 `loadURL` 并聚焦，不新建第二个窗口。关闭时释放 header listener；Esc 和关闭按钮只销毁该窗口。

- [ ] **Step 5: 实现系统保存对话框与原子写**

```ts
// ElectronDesktopRuntime 记录主窗口 this.window 与单例 Artifact 窗口 this.artifactWindow。
const owner = surface === 'artifact' ? this.artifactWindow : this.window
const target = await this.showArtifactSaveDialog(owner, { defaultPath: downloadName })
if (target.canceled || !target.filePath) return { saved: false }
const content = Buffer.from(contentBase64, 'base64')
const temporary = `${target.filePath}.huaanwork-${randomUUID()}.tmp`
try {
  await writeFile(temporary, content, { flag: 'wx' })
  await rename(temporary, target.filePath)
  return { saved: true, path: target.filePath }
} catch (error) {
  await rm(temporary, { force: true }).catch(() => undefined)
  throw error
}
```

新增 `showArtifactSaveDialog(owner: BrowserWindow | undefined, options)`：owner 在场时调用 `dialog.showSaveDialog(owner, options)`，缺席时调用不带 parent 的 `dialog.showSaveDialog(options)`；`rm` 从 `node:fs/promises` 导入。**不得复用把 parent 固定为主窗口的 `showUpdateSaveDialog`**。`surface='artifact'` 对应已创建的单例全屏窗口，因此 sheet 挂在全屏窗口；主窗口 renderer 仍挂主窗口。若请求 Artifact surface 时单例窗口已不存在，返回 `artifact-window-unavailable`，不得回退主窗口。写失败时清理临时文件并返回可见错误；文件名由 Task 1 sanitizer 处理，扩展名固定。整个流程不创建 Blob `<a download>`，因此同名“结果.md/html”也不会进入旧拦截器。

- [ ] **Step 6: 运行原生、路由和构建回归**

Run:
```bash
corepack yarn workspace dsh-plugin-huaanwork vitest run tests/artifact-window.spec.ts tests/desktop-browser-access.spec.ts tests/electron-runtime.spec.ts tests/client-huaanwork/artifactWindow.spec.ts tests/huaanwork-host/artifact-routes.spec.ts
corepack yarn workspace dsh-plugin-huaanwork typecheck
```
Expected: PASS；主窗口与全屏窗口都只有声明式能力。

- [ ] **Step 7: Commit**

```bash
git add dsh-plugin-huaanwork/src/client-huaanwork/ArtifactFullscreenPage.tsx dsh-plugin-huaanwork/src/client-huaanwork/shell.ts dsh-plugin-huaanwork/src/runtime.ts dsh-plugin-huaanwork/src/host-runtime-bridge.ts dsh-plugin-huaanwork/src/electron-runtime.ts dsh-plugin-huaanwork/src/electron-shell-generation.ts dsh-plugin-huaanwork/src/huaanwork-host/routes.ts dsh-plugin-huaanwork/src/huaanwork-host/index.ts dsh-plugin-huaanwork/src/client-huaanwork/api.ts dsh-plugin-huaanwork/src/client-huaanwork/rpc-types.ts dsh-plugin-huaanwork/tests/artifact-window.spec.ts dsh-plugin-huaanwork/tests/desktop-browser-access.spec.ts dsh-plugin-huaanwork/tests/electron-runtime.spec.ts dsh-plugin-huaanwork/tests/client-huaanwork/artifactWindow.spec.ts dsh-plugin-huaanwork/tests/huaanwork-host/artifact-routes.spec.ts
git commit -m "feat(artifacts): add secure fullscreen and save-as flows"
```

---

### Task 8: 全生命周期清理与最终门禁

**Files:**
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/artifacts-host.ts`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/sessions.ts:617-653,1066-1075`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/automations-store.ts:397-447,596-732`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/routes.ts`（会话/自动化/运行/项目/prune 的删除结果报告）
- Test: `dsh-plugin-huaanwork/tests/huaanwork-host/artifact-lifecycle.spec.ts`
- Test: `dsh-plugin-huaanwork/tests/huaanwork-host/automations-store.spec.ts`
- Test: `dsh-plugin-huaanwork/tests/huaanwork-host/sessions.spec.ts`

**Interfaces:**
- Produces: `removeArtifactsOfSession`、`removeArtifactOfRun`、`removeArtifactsOfAutomation`、`scanArtifactManifests`（只读 manifest 扫描，供自动化/项目删除与测试仪器化）。
- Preserves: 各现有删除原语的权威记录与错误语义；删除不存在的 Artifact 幂等成功。

- [ ] **Step 1: 写五类清理失败测试**

```ts
const deletionCases = [
  'session.remove',
  'automation.deleteRun',
  'automation.remove',
  'project.remove',
  'automation.pruneSessions',
] as const
```

每个用例先创建真实 Artifact，再调用对应公开原语，断言 manifest/content 均删除且兄弟 Artifact 保留。另测目录不存在幂等、清理失败会返回“记录已删除、结果文件未能完全清理”，不得静默成功。

AM-6 用例：

```ts
it('locates a run artifact directly via RunSummary.sessionId without scanning', async () => {
  const { profileDir, automationId, runId, sessionId } = await seedRunArtifact()
  const scan = vi.spyOn(artifactStore, 'scanArtifactManifests')
  await deleteAutomationRun(profileDir, automationId, runId, { sessionsRoot: join(profileDir, 'sessions') })
  expect(await listArtifacts(profileDir, sessionId)).toEqual([])
  expect(scan).not.toHaveBeenCalled()
})

it('scans manifests by exact automation anchor when sessions are gone', async () => {
  const first = await seedRunArtifact({ automationId: 'automation-1', runId: 'run-1', title: '同名结果' })
  const other = await seedRunArtifact({ automationId: 'automation-2', runId: 'run-2', title: '同名结果' })
  await rm(join(first.profileDir, 'sessions', first.sessionId), { recursive: true, force: true })
  await removeAutomation(first.profileDir, 'automation-1')
  expect(await listArtifacts(first.profileDir, first.sessionId)).toEqual([])
  expect((await listArtifacts(other.profileDir, other.sessionId)).map((item) => item.artifactId)).toEqual([other.artifactId])
})

it('reports incomplete cleanup when RunSummary lacks sessionId', async () => {
  const seeded = await seedRunArtifact({ includeSessionId: false })
  const report = await deleteAutomationRun(seeded.profileDir, seeded.automationId, seeded.runId, {
    sessionsRoot: join(seeded.profileDir, 'sessions'),
  })
  expect(JSON.stringify(report)).toContain('记录已删除、结果文件未能完全清理')
  expect((await recentRuns(seeded.profileDir, seeded.automationId, 100)).some((run) => run.runId === seeded.runId)).toBe(false)
  expect((await listArtifacts(seeded.profileDir, seeded.sessionId)).map((item) => item.artifactId)).toEqual([seeded.artifactId])
})
```

`seedRunArtifact` 是测试夹具：在独立 profile 中写入真实 RunSummary 与锚定 Artifact，并返回 `{profileDir, automationId, runId, sessionId, artifactId}`；`includeSessionId:false` 只从 RunSummary 删除该字段，不删除 Artifact 目录。`scanArtifactManifests` 是 Step 3 实现的只读扫描器，自动化/项目删除可调用，单 run 直定位路径不得调用。

- [ ] **Step 2: 确认当前删除路径会遗留 Artifact**

Run:
```bash
corepack yarn workspace dsh-plugin-huaanwork vitest run tests/huaanwork-host/artifact-lifecycle.spec.ts
```
Expected: FAIL，Artifact 目录仍存在。

- [ ] **Step 3: 实现共享清理原语**

```ts
export async function removeArtifactsOfSession(profileDir: string, sessionId: string): Promise<void>
export async function removeArtifactOfRun(profileDir: string, sessionId: string, automationId: string, runId: string): Promise<void>
export async function removeArtifactsOfAutomation(profileDir: string, automationId: string): Promise<void>
```

实现均从安全 artifact 根和单段 ID 定位，拒绝符号链接逃逸；删除使用 profile 锁。`deleteAutomationRun` 先把 `RunSummary.sessionId` 传给 `removeArtifactOfRun(profileDir, sessionId, automationId, runId)`，后者只检查该会话目录内 manifest 的自动化锚点，无需扫描（AM-6）。自动化/项目级联删除（运行会话可能已不存在）允许扫描全部 manifest，但只按 manifest 内的自动化锚点（`automationId + runId`）精确匹配，不按标题、下载名或目录名猜测。`RunSummary` 缺失 `sessionId` 时不得猜测清理对象，也不得用空字符串调用上述函数：权威记录删除照常完成，清理结果报告“记录已删除、结果文件未能完全清理”，不得静默成功。

- [ ] **Step 4: 接入所有共享删除路径**

- `removeSession`/`sessionRemove`：删除该会话 Artifact。
- `deleteAutomationRun`：删除该 run Artifact。
- `removeAutomation`：删除自动化全部 Artifact，确保 `removeAutomationsOfProject` 自动继承。
- `pruneAutomationSessions`：只清理实际被删会话的 Artifact；保留的运行记录不承诺完整结果页。
- 路由只报告底层清理结果，不另写一套目录删除。

- [ ] **Step 5: 运行生命周期、全量测试和仓级门禁**

Run:
```bash
corepack yarn workspace dsh-plugin-huaanwork vitest run tests/huaanwork-host/artifact-lifecycle.spec.ts tests/huaanwork-host/automations-store.spec.ts tests/huaanwork-host/sessions.spec.ts
corepack yarn workspace dsh-plugin-huaanwork typecheck
corepack yarn check
```
Expected: PASS。任何失败必须按实际输出处置；既有 `verify:aa` 并发 flake 只能串行重跑并记录，不能隐瞒。

- [ ] **Step 6: Commit**

```bash
git add dsh-plugin-huaanwork/src/huaanwork-host/artifacts-host.ts dsh-plugin-huaanwork/src/huaanwork-host/sessions.ts dsh-plugin-huaanwork/src/huaanwork-host/automations-store.ts dsh-plugin-huaanwork/src/huaanwork-host/routes.ts dsh-plugin-huaanwork/tests/huaanwork-host/artifact-lifecycle.spec.ts dsh-plugin-huaanwork/tests/huaanwork-host/automations-store.spec.ts dsh-plugin-huaanwork/tests/huaanwork-host/sessions.spec.ts
git commit -m "fix(artifacts): clean result files with owning records"
```

---

### Task 9: 规格 §12.2 用户验收执行与证据

**Files:**
- Create: `docs/evidence/2026-11-15-task-result-artifacts-acceptance.md`（本 Task 执行时生成；只记录真实执行结果，不预先声称通过）

**Interfaces:**
- Consumes: Task 1-8 全部已交付能力；无新代码接口。
- Produces: 七项验收的证据记录（执行环境、操作步骤、实际输出/截图引用、通过或失败结论）。

以下七步对应规格 §12.2，必须逐步真实执行并当场记录证据；任何一步失败都按实际结果处置并回填，不得改写为通过。

- [ ] **Step 1: Markdown 报告与 HTML 交互结果的唯一展示**
  执行：普通会话分别生成一个 Markdown 报告和一个带内联交互图表的 HTML 结果。
  证据：会话导出 JSON 与截图，证明各只有一张结果卡，正文未出现在工具参数卡或旧附件中。
- [ ] **Step 2: 卡片点击与右侧预览**
  执行：分别点击两类结果卡；随后切换到另一会话再切回。
  证据：右栏展开、`rightTab="preview"`、目标 Artifact 渲染正确的截图；切换前后预览内容与所属会话一致、无串页的记录。
- [ ] **Step 3: 独立全屏窗口**
  执行：点击“全屏”；分别用窗口内关闭按钮与 Esc 返回。
  证据：独立全屏页面截图；返回后主会话布局与消息不变的截图；全屏内 RPC 内容读取成功的记录。
- [ ] **Step 4: HTML 交互与隔离**
  执行：在右侧预览与全屏中操作图表交互；复核隔离边界。
  证据：交互成功截图；父应用、网络、弹窗、表单、顶层导航不可达的验证记录（可引用 Task 6 renderer 探针结果）。
- [ ] **Step 5: 下载另存为**
  执行：点击“下载”选择保存位置保存；再触发一次并在系统对话框中取消。
  证据：保存文件与提交内容的字节/哈希比对（含中文等非 ASCII 内容）；取消后目标目录无新文件的核验。
- [ ] **Step 6: 刷新与历史重开**
  执行：刷新应用并重新打开当前会话与历史会话；构造或选取无 `clientMessageId` 的旧结果。
  证据：结果卡、预览和下载仍可用的记录；旧结果进入“未定位的历史结果”分组的截图。
- [ ] **Step 7: 自动化新旧协议并存**
  执行：运行一个新封套 agent 自动化；查看一个旧历史自动化运行和一个脚本运行。
  证据：新运行只显示一个 Artifact 的截图；旧历史运行仍按旧双附件展示的截图；脚本运行记录与 32 KiB 截断不变的记录。
- [ ] **Step 8: Commit**
  ```bash
  git add docs/evidence/2026-11-15-task-result-artifacts-acceptance.md
  git commit -m "docs(artifacts): record task result acceptance evidence"
  ```

## Completion Criteria

- 普通会话可生成 Markdown/HTML Artifact，正文不进入工具参数卡；自动化封套有真实 prompt 注入且与终态适配互斥。
- 每项结果只有一张卡；新自动化不生成旧双附件，保存失败有含标题/格式/错误码的可回放错误卡（缺失字段回退“任务结果/未知格式”），旧历史保持兼容。
- 右侧预览按声明类型渲染；HTML 脚本仅在无同源沙箱运行，网络与父应用不可达（Electron renderer 探针实测）。
- 全屏新窗口安全参数、访问头和 RPC 均可用，单例同 WebContents 重新加载；下载支持系统另存为、parent 为请求窗口、取消零写入和原字节一致。
- 五类删除路径无孤儿 Artifact；预算（UTF-8 字节）、幂等、路径归属和迟到应答测试通过。
- 规格 §12.2 七项用户验收已在 Task 9 逐步执行并留有证据，结论与证据一致。
- 包级 `typecheck` 与仓级 `corepack yarn check` 已实际执行并记录真实结果。
