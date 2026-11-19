# Task Result Artifacts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将普通会话和 agent 自动化的可交付结果统一为宿主持久化 Artifact，在会话中只显示一张结果卡，并支持右侧预览、沙箱 HTML、独立全屏和原字节下载。

**Architecture:** 普通交互父会话通过附件-only 的 `result_present` 提交；agent 自动化只通过 `runAgentTurn` 注入的终态封套提交。Host 统一校验、原子落盘和按需读取，客户端统一投影结果卡，Electron 通过声明式 `native:*` RPC 提供全屏窗口与系统保存对话框。

**Tech Stack:** TypeScript、React、Vitest、Electron BrowserWindow、既有 HostRpc、既有 `@deepseek-ai/dsh-client-ui-primitives` MarkdownText、既有 `runResultRender` 纯函数。

**Spec:** `docs/superpowers/specs/2026-11-15-task-result-artifacts-design.md`

**Plan order:** 3/3。截至 2026-11-19，技能与进度前置已合并；当前实施基线为 `a423eef9fc048fa6b50d8c8047dc188f32a8369b`。直接消费已存在的 `huaanwork-host/turn-anchors.ts`（`TurnAnchorStore` / `TurnAnchor`，经 `holders.ts` 注入 `ctx.huaanworkTurnAnchors`），不重新实施前置计划、不依赖 ProgressPanel 才能生成或预览 Artifact，不复制锚点实现、不修改该 store 内部。

**Review status:** 2026-11-19 再次反证后修订；8 项 Important、3 项 Minor 的处置与证据边界见文末复核记录。本文是待实施计划，所有实现、门禁和真机验收复选框仍未完成。

## Global Constraints

- 基线为外层 `a423eef9fc048fa6b50d8c8047dc188f32a8369b`，上游 pin `1600d8a1e140dcde43a1a0941940a0480712c011`。Files 中旧行号仅为定位提示，以本基线符号和测试为准。
- 产品源码只修改 `dsh-plugin-huaanwork/` 和必要的自有共享包 `packages/huaanwork-policy/`；允许同步本计划、对应规格和 `docs/evidence/2026-11-15-task-result-artifacts-acceptance.md`、`yarn.lock`，以及 `.github/workflows/ci.yml` 的 Artifact 专用探针步骤。不得修改 `deepseek-harness/`，不得顺带调整无关 CI、安全权限或全局 allowlist。上游 Markdown 只能通过正式包公开导出消费。
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
- 附件可见性在同步 `agent/inbox/claimed` 通知内以 `refreshAgentRestrict(ctx as never, sessionId)` 刷新，先于 prompt assembly；既有 pre-step 锚点记录及 `return next()` 链保持不变，不改全局 allow 或 `turn-anchors.ts`；回归只运行本计划列出的测试文件与既有未修改测试。
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
- Produces: `ArtifactFormat`、`ArtifactRef`（`{sessionId, artifactId}`）、`ArtifactAnchor`、`TaskArtifactSummary`、`ArtifactOutcome`。
- Produces: `ArtifactInput`、`ArtifactWriteScope = Pick<ArtifactInput, 'sessionId' | 'anchor' | 'idempotency'>` 与不透明 `ArtifactWrite`（内部合并 lease、暂存和提交状态，不暴露路径）。
- Produces: 同步 `beginArtifactWrite(profileDir, scope): ArtifactWrite`、`prepareArtifact(write, input: Omit<ArtifactInput, keyof ArtifactWriteScope>): Promise<void>`、`commitPreparedArtifact(write): Promise<{artifact: TaskArtifactSummary; created: boolean}>`、`discardPreparedArtifact(write): Promise<void>`。
- Produces: `createArtifact(profileDir, input): Promise<TaskArtifactSummary>`（组合上述两阶段接口，保持普通调用返回摘要）、`getArtifact(profileDir, sessionId, artifactId)`、`readArtifactContent`、`listArtifacts`、`findArtifactByRun`。
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

另测自动化同 `automationId + runId` 并发重放、100 个上限、路径段校验、损坏 manifest fail-closed，以及下载名不能含路径或控制字符。两阶段测试直接复用真实 store，不用 fake summary：

```ts
it('keeps prepared bytes private and commits one record for concurrent replay', async () => {
  const root = mkdtempSync(join(tmpdir(), 'artifact-prepared-'))
  const scope: ArtifactWriteScope = {
    sessionId: 'session-1',
    anchor: { kind: 'automation-run', automationId: 'automation-1', runId: 'run-1' },
    idempotency: { kind: 'automation-run', automationId: 'automation-1', runId: 'run-1' },
  }
  const writes = [beginArtifactWrite(root, scope), beginArtifactWrite(root, scope)]
  try {
    await Promise.all(writes.map((write) => prepareArtifact(write, {
      title: '报告', format: 'markdown', content: '# 完整正文',
    })))
    expect(await listArtifacts(root, scope.sessionId)).toEqual([])
    expect(existsSync(join(root, 'artifacts', scope.sessionId))).toBe(false)
    const results = await Promise.all(writes.map((write) => commitPreparedArtifact(write)))
    expect(results.filter((result) => result.created)).toHaveLength(1)
    expect(new Set(results.map((result) => result.artifact.artifactId)).size).toBe(1)
    expect(await readArtifactContent(root, scope.sessionId, results[0]!.artifact.artifactId))
      .toEqual(Buffer.from('# 完整正文', 'utf8'))
    await Promise.all(writes.map((write) => discardPreparedArtifact(write)))
    await Promise.all(writes.map((write) => discardPreparedArtifact(write)))
    expect(await listArtifacts(root, scope.sessionId)).toHaveLength(1) // discard 已提交句柄不删除正文
  } finally {
    await Promise.all(writes.map((write) => discardPreparedArtifact(write)))
    rmSync(root, { recursive: true, force: true })
  }
})
```

补 `existsSync/rmSync` 的测试导入；本例自动化幂等 discriminator 在 Step 4 定义。另测 prepare 失败、未 prepare 就 discard、重复 discard 和 commit 后 discard 均回收 lease；删除失效后 discard，旧句柄不能再提交，而同 scope 新 begin 的合法写入可成功，证明没有永久 owner tombstone。通过实现审查核对最后一个 lease 的 finally 释放分支同时删除映射（含 invalid 状态），不新增产品统计/测试接口。事件不属于 store，Task 3 另钉同 run 并发只有一次 emit。

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
export type ArtifactRef = { sessionId: string; artifactId: string }
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

存储侧类型与两阶段入口（放在 `artifacts-host.ts`；`ArtifactWrite` 是不透明句柄，不是路径、lease token 与暂存对象的三套接口）：

```ts
export type ArtifactInput = {
  sessionId: string
  anchor: ArtifactAnchor
  idempotency:
    | { kind: 'tool'; callId: string }
    | { kind: 'automation-run'; automationId: string; runId: string }
  title: string
  format: ArtifactFormat
  content: string
  downloadName?: string
}
export type ArtifactWriteScope = Pick<ArtifactInput, 'sessionId' | 'anchor' | 'idempotency'>
declare const artifactWriteBrand: unique symbol
export type ArtifactWrite = { readonly [artifactWriteBrand]: true }

export function beginArtifactWrite(profileDir: string, scope: ArtifactWriteScope): ArtifactWrite
export function prepareArtifact(write: ArtifactWrite, input: Omit<ArtifactInput, keyof ArtifactWriteScope>): Promise<void>
export function commitPreparedArtifact(write: ArtifactWrite): Promise<{ artifact: TaskArtifactSummary; created: boolean }>
export function discardPreparedArtifact(write: ArtifactWrite): Promise<void>
```

以上是待实现签名，不是无函数体的生产实现。`beginArtifactWrite` 同步校验 scope、登记活跃 lease，不做 I/O/await；内部 scope 捕获 session/run/automation 所有者，不可由调用方后续修改。`prepareArtifact` 执行上述运行时校验，只在会话 Artifact 最终目录之外的隐藏暂存根写正文/manifest 并核对字节与 sha256；不得创建 `artifacts/<sessionId>`、不得发布列表或事件。隐藏暂存也必须在同一文件系统内以支持 rename。

`commitPreparedArtifact` 在同一 profile Promise 锁内**先重验 lease**，失效即抛具名 `artifact-owner-deleted`（包括已有幂等记录的情况）；再查幂等键、复验数量和准备结果的字节/摘要，最后原子 rename。已存在返回 `{artifact,created:false}`，新建返回 `{artifact,created:true}`；并发同 run 只能有一个 created:true，调用方只有这一种情况 emit。幂等和数量检查不能只发生在 prepare。`discardPreparedArtifact` 幂等清理暂存并释放 lease，已 commit 绝不删最终正文；清理 I/O 失败也在 finally 释放 lease，但错误必须向调用方报告。活跃映射仅在持有句柄期间存在，最后一个 lease 释放即删除映射，不永久保存已删除所有者。

`createArtifact` 将 input 拆为 scope/body，同步 begin，try 中 await prepare/commit 并返回 commit.artifact，finally 中 discard；正常返回值仍为摘要，不负责 emit。需要区分首次创建的工具/自动化调用方直接使用两阶段入口，不用一次前置 find 代替锁内 created 判定。读侧重新核对实际字节和摘要；损坏记录抛具名错误，不得当成空列表。`findArtifactByRun` 只匹配 manifest 的自动化锚点和幂等键。Task 8 在删除原语中按 scope 使活跃 lease 失效，不延长原会话/运行保留期。

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
- Consumes: Task 1 的 `beginArtifactWrite/prepareArtifact/commitPreparedArtifact/discardPreparedArtifact`；以及已合并的 `dsh-plugin-huaanwork/src/huaanwork-host/turn-anchors.ts` 的 `TurnAnchorStore` / `TurnAnchor`（经 `holders.ts` 注入 `ctx.huaanworkTurnAnchors`）。本 Task 只 import 消费，不修改该模块、不依赖 ProgressPanel。只有 `sendToAgent` 的 `register()` 登记且消息已被 claim 才能获得高级/自动化来源；未登记包儿童经 `notePreStep` 得 `unknown`，登记但尚未 claim 的排队消息不改变当前附件。
- Produces: `RESULT_PRESENT_TOOL = "result_present"`、`registerResultArtifactTools(ctx, profileDir): () => void`、`makeResultPresentClaimed(ctx)`（同步 `agent/inbox/claimed` 通知处理器，payload 为 `{agent,message}`，不是 waterfall）。
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

首请求时序测试必须驱动真实 agent-loop，不能把 mock 的 `tools.schemas()` 或手工调用 pre-step 当作模型请求。现有 `present-as.cordis.spec.ts` 只有 `createMockAgent/createMockContext`，没有真实 loop harness；在本 Task 的 `result-artifact-tools.spec.ts` 内显式增加下列测试类/装配函数，使用公开包 API，不导入或修改上游测试。参考上游 `core/agent-loop/tests/tool-updates.spec.ts` 的真实服务装配顺序；这里不启用 toolUpdate 能力，直接检查每次 request.tools：

```ts
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { createTurnAnchorStore, installTurnAnchorHooks } from '../../src/huaanwork-host/turn-anchors.ts'
import { apply as applyPresentAs } from '../../src/huaanwork-guardrails/present-as.ts'

class RequestAdapter extends LlmAdapter {
  requests: GenerateOptions[] = []
  beforeFinish?: () => Promise<void>
  resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'ok' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'ok' } }
    await this.beforeFinish?.()
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function makeClaimHarness(profileDir: string) {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt, { personaPrefix: '', personaSuffix: '' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  const anchors = createTurnAnchorStore()
  Object.assign(ctx, { huaanworkTurnAnchors: anchors, huaanworkAttachments: emptyAttachments() })
  const adapter = new RequestAdapter()
  ctx.llm.registerAdapter(['artifact-test'], adapter)
  const unregister = registerResultArtifactTools(ctx as never, profileDir)
  applyPresentAs(ctx as never)
  installTurnAnchorHooks(ctx as never) // 保留真实 pre-step 的 next 链
  ctx.on('agent/inbox/claimed', makeResultPresentClaimed(ctx as never), { global: true })
  const agent = await ctx.agentLoop.create(SessionId('huaanwork-claim-test'), { provider: 'artifact-test', model: 'test' })
  return { ctx, agent, anchors, adapter, async dispose() { unregister(); await ctx.fiber.dispose() } }
}

it('includes result_present on the first advanced request and removes it on the first compat request', async () => {
  const profileDir = mkdtempSync(join(tmpdir(), 'artifact-claim-'))
  const h = await makeClaimHarness(profileDir)
  try {
    for (const origin of ['advanced', 'unknown'] as const) {
      const message = createUserMessage({ content: [{ type: 'text', text: '报告' }], source: { kind: 'user' } })
      h.anchors.register({ sessionId: h.agent.session.id, clientMessageId: message.id, origin })
      h.agent.followup(message)
      await h.agent.whenIdle()
      expect(h.adapter.requests.at(-1)!.tools?.some((tool) => tool.name === RESULT_PRESENT_TOOL))
        .toBe(origin === 'advanced')
    }
    expect(h.adapter.requests).toHaveLength(2)
  } finally {
    await h.dispose()
    rmSync(profileDir, { recursive: true, force: true })
  }
})
```

同一真实 harness 还必须覆盖（每个测试自己创建 profile/context 并 finally 释放）：
- 自动化 register(origin=automation) 首 request 和包儿童未 register 的首 request 均不含工具；普通直接执行但未 attached 必须拒绝。
- advanced 首轮后发送 `source.kind='goal'` 的消息，原 anchor/附件保留，续轮 request 仍含工具。
- `beforeFinish` 使用测试内 `Promise.withResolvers<void>()` 的 entered/release 两个屏障暂停首轮；第二条消息只 register 并排队、尚未 claim 时断言当前附件与 anchor 不变，再 release 并核对下一次 request（不靠 sleep）。
- 对真实 anchor store 的 `notePreStep` 或 restrict 刷新注入同步抛错，spy `agent.cancel`，断言收到 `{kind:'hook',reason:'result-present-attachment-sync-failed'}`，`await agent.whenIdle()` 后 adapter.requests 为零；不能只 expect throw，真实通知会吞监听器异常。
- 在现有 `present-as.cordis.spec.ts` 的 `createMockAgent/createMockContext` 上加入真实 anchor store，直接调用同一 claimed 处理器两次、以两种顺序调用 bridge 采用的 `notePreStep(sessionId,[message],now)`，比较 `restrictCalls.length` 相对初值仅加一；不再使用未声明的 `makeStep/countRestrictRefreshes/runBridgeSync`。另驱动 `installTurnAnchorHooks` 注册的真实 pre-step listener，并用本地计数 next 函数断言每次都委托。`TurnAnchorStore` 内部不修改，goal 无新用户继承、未知 sessionId 直接 return 都有钉。

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

工具输入严格为 `title/format/content/downloadName?`；运行时校验由 Task 1 的 `prepareArtifact` 执行，工具层不重复实现，只透传具名错误；直接使用两阶段入口取得锁内 `created` 判定，重放不重复 emit。执行时：

```ts
const sessionId = sessionIdOfAgentRef(exec?.agent)
if (!sessionId || !exec.callId) throw new Error('result-present-context-missing')
if (!isAgentToolAttached(ctx.huaanworkAttachments, sessionId, RESULT_PRESENT_TOOL)) {
  throw new Error('result-present-not-attached')
}
const anchor = ctx.huaanworkTurnAnchors?.current(sessionId) // TurnAnchorStore，进度计划共享模块
const write = beginArtifactWrite(profileDir, {
  sessionId,
  anchor: { kind: 'turn', ...(anchor?.clientMessageId !== undefined ? { clientMessageId: anchor.clientMessageId } : {}) },
  idempotency: { kind: 'tool', callId: exec.callId },
})
try {
  await prepareArtifact(write, {
    title: args.title, format: args.format, content: args.content,
    ...(args.downloadName !== undefined ? { downloadName: args.downloadName } : {}),
  })
  const { artifact, created } = await commitPreparedArtifact(write)
  if (created) ctx.huaanworkEmit?.({ event: 'artifact/created', artifact, sessionId })
  return { text: `已生成结果页“${artifact.title}”。artifactId: ${artifact.artifactId}` }
} finally {
  await discardPreparedArtifact(write)
}
```

`profileDir` 是注册时由 Host `apply()` 的 `config.profileDir` 显式传入的闭包参数，不新增 ctx 路径字段。工具全局注册，但只有 schema 注册 + 会话附件 + policy attached 三层都通过才可执行。

- [ ] **Step 4: 在同步 agent/inbox/claimed 按 TurnAnchorStore.origin 同步附件**

基线 `core/agent-loop/src/inbox.ts:109-113` 在 claim 内逐消息同步 emit，`agent.ts:271-272` 在 claim 后立即 assemble；`agent/pre-step` 已晚于 tools snapshot，不能负责本工具的首请求可见性。使用真实通知 payload 中的 `{agent,message}`（其余字段无需消费），处理器不能 async、不能延迟 refresh、没有 next 参数。既有 pre-step 锚点记录和 `return next()` 链原样保留。

```ts
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'

type ResultPresentClaimedContext = {
  huaanworkTurnAnchors?: TurnAnchorStore
  huaanworkAttachments: ReturnType<typeof emptyAttachments>
}
type ResultPresentClaimedPayload = { agent: Agent; message: UserMessage }

export function makeResultPresentClaimed(ctx: ResultPresentClaimedContext) {
  return function noteResultPresentAttachment({ agent, message }: ResultPresentClaimedPayload): void {
    const sessionId = sessionIdOfAgentRef(agent)
    if (!sessionId) return
    try {
      const anchor = ctx.huaanworkTurnAnchors?.notePreStep(sessionId, [message], new Date().toISOString())
      const wantAttached = anchor?.origin === 'advanced'
      const attached = isAgentToolAttached(ctx.huaanworkAttachments, sessionId, RESULT_PRESENT_TOOL)
      if (wantAttached === attached) return
      if (wantAttached) attachAgentTools(ctx.huaanworkAttachments, sessionId, [RESULT_PRESENT_TOOL])
      else detachAgentTools(ctx.huaanworkAttachments, sessionId, [RESULT_PRESENT_TOOL])
      refreshAgentRestrict(ctx as never, sessionId)
    } catch (error) {
      // notification 的异常会被分发器吞掉；必须取消 driver，不能靠 throw 阻断请求。
      agent.cancel({ kind: 'hook', reason: 'result-present-attachment-sync-failed' })
    }
  }
}

ctx.on('agent/inbox/claimed', makeResultPresentClaimed(ctx), { global: true })
```

上述窄 context 只列 helper 消费的 holder；实际传入完整 Host ctx，`refreshAgentRestrict(ctx as never, sessionId)` 继续使用既有 agents/restrict 服务，不用上述窄类型伪造运行时 ctx。`AgentCancelCause` 的真实 hook 形状在 `core/session/src/types.ts:190-194`；cancel 使 driver 的 signal 中止，assembly 后检查会阻止 llm 请求。缺 sessionId 直接 return。

唯一 origin 门是 advanced：automation/unknown（含兼容新回合和未登记包儿童）摘除旧附件，状态改变才 refresh；goal 没有新用户消息时共享 store 返回原 anchor，附件保留。register 只登记 pending，不触碰当前附件；真正 claimed 后才切换。与 bridge 的同一 `notePreStep` 入口幂等，重复消息及后续 pre-step 不重复 refresh。工具执行体仍检查 attached；不改 `turn-anchors.ts`、普通全局 allow、包儿童血缘或无人值守白名单。policy 对 `result_present` 只允许 `attached=true`。

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
- Produces: `AUTOMATION_RESULT_CONTRACT`、`prepareAutomationResult(write: ArtifactWrite, fullText: string): Promise<AutomationArtifactPreparation>`；只准备、不 commit、不 emit。
- Produces: `AutomationArtifactPreparation = {outcome:'prepared';title:string;format:ArtifactFormat} | {outcome:'failed';artifactError:string;artifactTitle?:string;artifactFormat?:ArtifactFormat} | {outcome:'skipped'}`；failed 仅在内容通过校验后准备/存储失败时带 title/format，坏封套不带。
- Extends: 私有 `finishAutomation` 的 run 参数增加 `artifact?: {write: ArtifactWrite; preparation: AutomationArtifactPreparation}`，不暴露新的生产测试入口。
- Consumes: `jsonToBlocks`、`blocksToMarkdown` 和 Task 1 的两阶段存储；冻结后的 commit 才返回 created，`created:false` 不 emit。

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

取消与冻结竞态测试放入既有 `automations-host.spec.ts`，复用真实 `makeHarness/startAutomation/agentTask`、`h.state.reply`、`stopAutomation`、`recentRuns`，不使用不存在的 `h.cancel/h.createArtifact` 或私有 `finishAutomation` 假导出。新增 `vi` 导入，在该测试文件内声明可控屏障和模块部分 mock；其余导出及实际文件存储照常运行：

```ts
const artifactBarriers = vi.hoisted(() => ({
  afterPrepare: undefined as undefined | (() => Promise<void>),
  beforeCommit: undefined as undefined | (() => Promise<void>),
  beforeAppend: undefined as undefined | (() => Promise<void>),
}))
vi.mock('../../src/huaanwork-host/artifacts-host.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/huaanwork-host/artifacts-host.ts')>()
  return {
    ...real,
    prepareArtifact: async (...args: Parameters<typeof real.prepareArtifact>) => {
      await real.prepareArtifact(...args)
      await artifactBarriers.afterPrepare?.()
    },
    commitPreparedArtifact: async (...args: Parameters<typeof real.commitPreparedArtifact>) => {
      await artifactBarriers.beforeCommit?.()
      return real.commitPreparedArtifact(...args)
    },
  }
})
vi.mock('../../src/huaanwork-host/automations-store.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/huaanwork-host/automations-store.ts')>()
  return {
    ...real,
    appendRun: async (...args: Parameters<typeof real.appendRun>) => {
      await artifactBarriers.beforeAppend?.()
      return real.appendRun(...args)
    },
  }
})
function promiseBarrier() {
  const entered = Promise.withResolvers<void>()
  const released = Promise.withResolvers<void>()
  return {
    entered: entered.promise,
    release: () => released.resolve(),
    wait: async () => { entered.resolve(); await released.promise },
  }
}
async function storedRun(profileDir: string, automationId: string, runId: string): Promise<RunSummary> {
  const summary = (await recentRuns(profileDir, automationId, 100)).find((run) => run.runId === runId)
  if (!summary) throw new Error(`run summary missing: ${runId}`)
  return summary
}
const artifactKeys = ['artifactOutcome', 'artifactId', 'artifactError', 'artifactTitle', 'artifactFormat'] as const
function artifactFieldsOf(value: object) {
  return Object.fromEntries(artifactKeys.filter((key) => Object.hasOwn(value, key)).map((key) => [key, Reflect.get(value, key)]))
}
const envelopeText = JSON.stringify({
  schemaVersion: 1, type: 'huaanwork.task-result', title: '季度报告', format: 'html', content: '<p>完整正文</p>',
})

it('cancels while preparation is pending without publishing any artifact fields', async () => {
  const h = makeHarness()
  h.state.reply = envelopeText
  const automation = await agentTask(h.profileDir)
  const gate = promiseBarrier()
  artifactBarriers.afterPrepare = gate.wait
  const run = await startAutomation(h, automation, { runId: 'stop-preparing' })
  try {
    await gate.entered
    const sessionId = automationRunSessionId(automation.id, run.runId)
    expect(await listArtifacts(h.profileDir, sessionId)).toEqual([])
    expect(await stopAutomation(automation.id)).toEqual({ stopped: true })
    gate.release()
    await run.done
    const summary = await storedRun(h.profileDir, automation.id, run.runId)
    expect(summary).toMatchObject({ ok: false, status: 'cancelled' })
    expect(artifactFieldsOf(summary)).toEqual({})
    const end = h.events.find((event) => event.event === 'automation/run-end' && event.runId === run.runId)!
    expect(artifactFieldsOf(end)).toEqual({})
    expect(await listArtifacts(h.profileDir, sessionId)).toEqual([])
    expect(h.events.filter((event) => event.event === 'artifact/created')).toEqual([])
  } finally {
    gate.release()
    await run.done
    artifactBarriers.afterPrepare = undefined
  }
})

it.each(['beforeCommit', 'beforeAppend'] as const)('freezes execution before %s even if stop arrives', async (point) => {
  const h = makeHarness()
  h.state.reply = envelopeText
  const automation = await agentTask(h.profileDir)
  const gate = promiseBarrier()
  artifactBarriers[point] = gate.wait
  const run = await startAutomation(h, automation, { runId: `stop-${point}` })
  try {
    await gate.entered
    expect(await stopAutomation(automation.id)).toEqual({ stopped: true })
    gate.release()
    await run.done
    const summary = await storedRun(h.profileDir, automation.id, run.runId)
    expect(summary).toMatchObject({ ok: true, status: 'ok', output: envelopeText, artifactOutcome: 'created' })
    expect(await findAutomation(h.profileDir, automation.id)).toMatchObject({ lastStatus: 'ok' })
    const end = h.events.find((event) => event.event === 'automation/run-end' && event.runId === run.runId)!
    expect(end).toMatchObject({ ok: true, status: 'ok' })
    expect(artifactFieldsOf(end)).toEqual(artifactFieldsOf(summary))
    expect(await readArtifactContent(h.profileDir, summary.sessionId!, summary.artifactId!))
      .toEqual(Buffer.from('<p>完整正文</p>', 'utf8'))
    expect(inFlightRuns.has(run.runId)).toBe(false)
    expect(await stopAutomation(automation.id)).toEqual({ stopped: false })
  } finally {
    gate.release()
    await run.done
    artifactBarriers[point] = undefined
  }
})
```

`storedRun/artifactFieldsOf/promiseBarrier` 均为测试内 helper，不新增宿主查询 API；`appendRun` 的实际导入来自 `automations-store.ts`（若经 `stores.ts` re-export，仍拦截该原始模块）。每个屏障 finally 释放并等待 run.done，afterEach 恢复部分 mock/spy；不能用 fake summary、未受理的异步 stop 或 sleep 猜测替代落盘断言。继续增加：
- 同 runId 并发重放：第一轮挂在 afterPrepare，此时原 scheduler 已释放；经同一 startAutomation 再受理同 runId，两个 prepare 都进入屏障后一起放行，断言真实 store 只有一份正文、两个 run-end 指向同一 artifactId、仅一个 `artifact/created`。beforeCommit/afterPrepare 回调在测试内显式计数并用 Promise.withResolvers 通知两次到达，不新建生产并发入口。另测顺序重放。
- afterPrepare/beforeCommit 回调分别抛具名写失败，读取真实 summary/end，断言 artifactOutcome=failed、稳定 artifactError 和已验证 title/format 一致，但冻结的 ok/status 仍为原执行结果。坏标记封套（如 pdf）失败时 title/format 缺席。`automation-artifacts.spec.ts` 直接 begin→prepareAutomationResult→discard，prepared 结果只有 title/format，prepare 后 list 仍为空、没有事件能力；普通文本 skipped，兼容 JSON 只准备 Markdown。
- 大于运行摘要截断阈值且小于 5 MiB 的正文：summary.output 仍截断，Artifact 字节等于完整 collector 的 content。
- queued 取消（不建 lease）、已 started 的项目不存在/建任务失败/markAutomation 失败、prepare 失败/取消、commit 失败和正常结束均回收 lease；discard I/O 失败要记录 logger 错误但仍写权威 summary/end，恢复 I/O 后重复 discard 清理残余。生命周期与 prune 的真实删除屏障详见 Task 8，不延长 collector/scheduler 占用。

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

`prepareAutomationResult(write, fullText)` 对 `fullText.trim()` 整体 `JSON.parse`；不得从解释文字中抽取最后一个对象。带 `type/schemaVersion` 标记但校验失败返回 `{outcome:'failed',artifactError:'invalid-result-envelope'}`（title/format 不可确认，不携带）。无标记 JSON 对象/数组经 `jsonToBlocks` 和 `blocksToMarkdown` 转为 Markdown；普通文本返回 skipped。

合法内容只调用 `prepareArtifact(write, {title,format,content,downloadName?})`，成功返回 `{outcome:'prepared',title,format}`，失败返回 failed、稳定错误码和已校验 title/format；不得调用 create/commit、不得查询后提前返回 created、不得接收 routeCtx/emit。run/automation/session 已在 executeRun 同步 begin 的 scope 中捕获，prepare 不重建 lease、不在 collector 释放后才登记所有权。幂等最终裁决仍在 commit 锁内，入口 find 不能替代它。

- [ ] **Step 5: 在截断前接线并持久化 outcome**

`executeRun` 保留 queued 取消同步早退；得到 agent 的 sessionId 后，在其外层 try 内、run-start 与首个 await 之前同步建立唯一 write（begin 失败仍由现有 finally 释放 admission/inFlight）。不得等 `runAgentTurn` 返回、collector/scheduler 释放之后再 begin。脚本无 write。局部变量显式声明为 `let write: ArtifactWrite | undefined`，agent 分支赋值：

```ts
write = beginArtifactWrite(routeCtx.profileDir, {
  sessionId,
  anchor: { kind: 'automation-run', automationId: automation.id, runId },
  idempotency: { kind: 'automation-run', automationId: automation.id, runId },
})
```

`sessionId` 在该分支已窄化为 string。在获得完整 output 后，且不在内层“模型执行失败”catch 中，await `prepareAutomationResult(write, output)`；当前已经取消时可省掉 prepare，传 `{outcome:'skipped'}`，但该预检查不是冻结点。随后紧接调用 `finishAutomation`，run 只增加 `{artifact:{write,preparation}}`；没有 write 的早退路径不带该字段。所有已建 write 的出口在 executeRun 外层 finally 调用 discard（即使 finish 已 discard 也安全）。finally 清理失败必须 `routeCtx.logger` 显式记录 `artifact-discard-failed` 及原错误，不能吞掉、不能阻断 admission/inFlight 的既有清理。

把原 executeRun 尾部“停止覆盖”同步代码移入 `finishAutomation` 的 summary 构建段。prepare 返回后重新读取 cancel，随即同步构建 summary，中间无 await：这才是冻结点，保留 `2026-10-21-automation-result-preview-design.md:103` 的旧裁定，不把冻结延迟至 commit/append。所有调用 finish 的早退同样经过该段：

```ts
const endedAt = Date.now()
const cancelled = inFlightRuns.get(run.runId)?.cancelRequested === true
const ok = cancelled ? false : run.ok
const status = cancelled ? 'cancelled' : (run.status ?? (ok ? 'ok' : 'error'))
const stoppedOutput = cancelled ? stripRunnerExitCodeFooter(run.output) : run.output
const output = cancelled && !stoppedOutput.trim() ? '已停止' : stoppedOutput
const durationMs = endedAt - run.startedAt
const summary: RunSummary = {
  runId: run.runId, startedAt: run.startedAt, endedAt, ok,
  output: clipOutput(output), status, trigger, durationMs,
  ...(coalescedCount === undefined ? {} : { coalescedCount }),
  ...(run.sessionId === undefined ? {} : { sessionId: run.sessionId }),
  ...(run.taskId === undefined ? {} : { taskId: run.taskId }),
}
// 此后不再读取 cancelRequested；后续异步操作只能补 artifact 字段，不能改变上面的执行值。
type ArtifactFields = Pick<RunSummary, 'artifactOutcome' | 'artifactId' | 'artifactError' | 'artifactTitle' | 'artifactFormat'>
let artifactFields: ArtifactFields = {}
if (run.artifact) {
  const { write, preparation } = run.artifact
  if (cancelled) {
    try {
      await discardPreparedArtifact(write)
    } catch (error) {
      routeCtx.logger(`artifact-discard-failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  } else if (preparation.outcome === 'failed') {
    artifactFields = {
      artifactOutcome: 'failed', artifactError: preparation.artifactError,
      ...(preparation.artifactTitle === undefined ? {} : { artifactTitle: preparation.artifactTitle }),
      ...(preparation.artifactFormat === undefined ? {} : { artifactFormat: preparation.artifactFormat }),
    }
  } else if (preparation.outcome === 'prepared') {
    let committed: Awaited<ReturnType<typeof commitPreparedArtifact>> | undefined
    try {
      committed = await commitPreparedArtifact(write)
    } catch (error) {
      artifactFields = {
        artifactOutcome: 'failed',
        artifactError: error instanceof Error && error.message === 'artifact-owner-deleted'
          ? 'artifact-owner-deleted' : 'artifact-write-failed',
        artifactTitle: preparation.title, artifactFormat: preparation.format,
      }
    }
    if (committed) {
      artifactFields = { artifactOutcome: 'created', artifactId: committed.artifact.artifactId }
      if (committed.created) routeCtx.emit({
        event: 'artifact/created', artifact: committed.artifact, sessionId: committed.artifact.sessionId,
      })
    }
  }
}
Object.assign(summary, artifactFields)
```

上段替换 finish 的 summary 初始化并接在原 appendRun try/finally 之前。commit 错误码映射沿用存储已定义的稳定具名码，必须保留 `artifact-owner-deleted`；示例未知写盘异常统一为 `artifact-write-failed`。取消分支从不 commit/emit、不写任何 artifact 字段；丢弃失败可报告但权威 summary 仍继续结算。skipped 同样没有值为 undefined 的键。prepared 的执行 ok/status 已冻结，存储失败只改变 artifactFields。

保持原 appendRun → finally 摘 inFlight → markAutomation → run-end 次序。markAutomation.lastStatus 从局部冻结的 `ok` 计算，不再使用 run.ok；run-end 展开**同一份** artifactFields，并使用局部 ok/status/durationMs。任务状态投影使用该冻结事件值，不另读 cancel。summary 构建后、commit 或 append 等待中到达的 stop 仍返回 stopped:true，但不改写这条记录；记录落盘且摘除 inFlight 后 stop 返回 false。无需改 stop/N2、prune 保留集、collector 或 scheduler。成功 created 事件可按 runId 暂存；保存失败的错误卡只来自 run-end/RunSummary。脚本不准备 Artifact，仍执行旧 clipOutput 与冻结规则。

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
      const groupStart = items.findIndex((item) => item.kind === 'artifact-group')
      const normalEnd = groupStart < 0 ? items.length : groupStart
      const nextUser = items.findIndex((item, index) => index > anchorIndex && index < normalEnd && item.kind === 'user')
      const insertAt = nextUser < 0 ? normalEnd : nextUser
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

自动化定位先由 `RunSummary` 的 `automationId + runId` 选中唯一运行标签，再执行上述 footnote 插入；不得跨运行标签查找。未定位分组只保留一个并始终是列表尾部；历史回填先按 `createdAt/artifactId` 对 `artifact.list` 排序，再逐项调用本函数。App 新增普通 user/assistant/note 时也插在已有 `artifact-group` 之前，不能把新回合追加到该分组后面；这只改变展示顺序，不改写 Artifact 的 anchor。

```ts
it.each([false, true])('keeps exact artifacts outside the trailing unlocated group, reverse=%s', (reverse) => {
  let id = 2
  const exact = { ...artifactFixture({ kind: 'turn', clientMessageId: 'user-1' }), artifactId: 'exact' }
  const loose = { ...artifactFixture({ kind: 'turn' }), artifactId: 'loose' }
  let result: ChatItem[] = [{ id: 1, kind: 'user', text: '生成报告', clientMessageId: 'user-1' }]
  for (const item of reverse ? [exact, loose] : [loose, exact]) {
    result = insertArtifactIntoHistory(result, item, () => id++)
  }
  result = insertArtifactIntoHistory(result, exact, () => id++)
  expect(result.map((item) => item.kind)).toEqual(['user', 'artifact', 'artifact-group', 'artifact'])
  expect(result[1]).toMatchObject({ artifactId: 'exact' })
  expect(result[3]).toMatchObject({ artifactId: 'loose' })
})
```

另在 App 接线测试中先回填未定位组，再发送新用户消息并接收该回合 Artifact，断言新 user/assistant/精确卡均在组标题之前，list 重放不增加组或重复卡。

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
- Create: `dsh-plugin-huaanwork/src/artifact-frame-guard.ts`（仅约束已登记 Artifact frame 的导航）
- Modify: `dsh-plugin-huaanwork/tsdown.config.ts`（为真实探针添加内部构建 entry `artifact-frame-guard`，不新增 package export）
- Test: `dsh-plugin-huaanwork/tests/artifact-frame-guard.spec.ts`
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
- Produces: `ArtifactPreview({artifact, onFullscreen, onDownload, prepareHtmlFrame, error?, onRetry})`、`ArtifactHtmlView({content,title,prepareFrame})`；`prepareFrame(frameName: string): Promise<void>` 是父页面提供的原生防护确认回调。
- Produces: `rendererFor(artifact: Pick<TaskArtifactSummary,'format'>): ArtifactFormat`（直接返回声明格式）、`withArtifactContentSecurity(content: string): string`、`installArtifactFrameGuard(renderer: WebContents): { registerEmptyFrame(frameName: string): void; dispose(): void }`。
- Consumes: 上游包根导出的 `MarkdownText` 和 `MarkdownLabels`；生产 prepareFrame 回调由 Task 7 的 `artifact.prepareFrame` 提供。Task 6 缺回调或调用失败时只显示错误，绝不先渲染模型 HTML；本 Task 探针直接调用同一个原生 guard，Task 7 再验证真实 RPC 接线。

- [ ] **Step 1: 写渲染选择、CSP 和 sandbox 失败测试**

测试文件使用 `// @vitest-environment jsdom`，从 `react-dom/server` 导入 `renderToStaticMarkup`，从 `react-dom/client` 导入 `createRoot`，从 `react` 导入 `act` 与 `createElement`。

```ts
it('selects the declared renderer', () => {
  expect(rendererFor({ format: 'markdown' })).toBe('markdown')
  expect(rendererFor({ format: 'html' })).toBe('html')
})

function renderHtmlFrame(content: string): HTMLIFrameElement {
  const markup = renderToStaticMarkup(createElement(ArtifactHtmlView, { content, title: '结果', prepareFrame: async () => undefined }))
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
  expect(secured.indexOf('Content-Security-Policy')).toBeLessThan(secured.indexOf('<script>window.ran=true</script>'))
  const frame = renderHtmlFrame(secured)
  expect(frame.getAttribute('sandbox')).toBe('allow-scripts')
  expect(frame.getAttribute('sandbox')).not.toContain('allow-same-origin')
  expect(frame.getAttribute('srcDoc')).toBeNull()
  expect(frame.getAttribute('src')).toBe('about:blank')
})

it('releases HTML only after the native frame guard acknowledges preparation', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  let release!: () => void
  const ready = new Promise<void>((resolve) => { release = resolve })
  const prepareFrame = vi.fn(() => ready)
  try {
    await act(async () => root.render(createElement(ArtifactHtmlView, {
      content: '<p>受控正文</p>', title: '结果', prepareFrame,
    })))
    const frame = container.querySelector('iframe')!
    await act(async () => { frame.dispatchEvent(new Event('load')) })
    expect(prepareFrame).toHaveBeenCalledWith(frame.name)
    expect(frame.getAttribute('srcdoc')).toBeNull()
    await act(async () => { release(); await ready })
    expect(frame.getAttribute('src')).toBeNull()
    expect(frame.getAttribute('srcdoc')).toContain('受控正文')
  } finally {
    await act(async () => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  }
})

it('does not auto-load remote images in markdown artifacts', () => {
  const markup = renderToStaticMarkup(createElement(ArtifactMarkdownView, {
    content: '![远程图](https://example.com/x.png)\n\n[链接](https://example.com/doc)',
  }))
  expect(markup).not.toContain('src="https://example.com/x.png"') // 远程 img 不自动加载（AM-8）
  expect(markup).toContain('https://example.com/doc') // http 链接保留走既有安全打开
})

it.each(['![图][ref]', '![ref][]', '![ref]'])('blocks remote reference image %s without deleting shared links', (image) => {
  const input = `${image}\n\n[普通链接][ref]\n\n[ref]: https://example.com/x.png`
  const filtered = withoutRemoteMarkdownImages(input)
  expect(filtered).toContain('远程图片（已禁用）')
  expect(filtered).toContain('[普通链接][ref]')
  expect(filtered).toContain('[ref]: https://example.com/x.png')
  const markup = renderToStaticMarkup(createElement(ArtifactMarkdownView, { content: input }))
  expect(markup).not.toContain('<img')
  expect(markup).toContain('href="https://example.com/x.png"')
})

it('uses normalized identifiers and the first definition while leaving code untouched', () => {
  const remoteFirst = '![图][REF]\n\n[ref]: https://example.com/first.png\n[REF]: local.png'
  expect(withoutRemoteMarkdownImages(remoteFirst)).not.toContain('![图][REF]')
  const localFirst = '![图][REF]\n\n[ref]: local.png\n[REF]: https://example.com/second.png'
  expect(withoutRemoteMarkdownImages(localFirst)).toBe(localFirst)
  const code = '```md\n![图][ref]\n[ref]: https://example.com/x.png\n```'
  expect(withoutRemoteMarkdownImages(code)).toBe(code)
})
```

真实 Electron renderer 探针使用既有 `playwright-core`，启动隐藏窗口，不启用 Node preload、不添加 `--no-sandbox`。`tests/electron/artifact-sandbox-main.mjs` 只创建测试窗口：

```js
import { app, BrowserWindow } from 'electron'
import { installArtifactFrameGuard } from '../../lib/artifact-frame-guard.js'
await app.whenReady()
const window = new BrowserWindow({
  show: false,
  webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true },
})
export const guard = installArtifactFrameGuard(window.webContents)
export const blockedNavigations = []
export function artifactFrameId(name) {
  return window.webContents.mainFrame.framesInSubtree.find((frame) => frame.name === name)?.frameTreeNodeId
}
window.webContents.on('will-frame-navigate', (event) => {
  if (event.defaultPrevented) blockedNavigations.push({ url: event.url, frameTreeNodeId: event.frame?.frameTreeNodeId })
})
window.on('closed', () => guard.dispose())
await window.loadURL('about:blank')
app.on('window-all-closed', () => app.quit())
```

`tests/electron/artifact-sandbox-probe.electron.ts` 通过真实 `srcDoc` iframe 检查行为，不读取静态 HTML 代替。该后缀不匹配公共 `vitest.config.ts` 的 `tests/**/*.spec.ts`，因此默认 workspace `test`、根 `test`、根 `check` 与 Ubuntu `check` job 都不会启动它；公共 Vitest 配置不做改动。

```ts
import { expect, it } from 'vitest'
import { _electron as electron } from 'playwright-core'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { WebSocketServer } from 'ws'

it('executes inline scripts while denying network and privileged access', async () => {
  const mainUrl = new URL('./artifact-sandbox-main.mjs', import.meta.url).href
  const electronPath: unknown = createRequire(import.meta.url)('electron')
  if (typeof electronPath !== 'string') throw new Error('electron executable path unavailable')
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
  delete env.ELECTRON_RUN_AS_NODE
  const app = await electron.launch({ executablePath: electronPath, args: [fileURLToPath(mainUrl)], env, chromiumSandbox: true })
  let receiver: ReturnType<typeof createServer> | undefined
  let sockets: WebSocketServer | undefined
  try {
    const requests: string[] = []
    const socketRequests: string[] = []
    receiver = createServer((request, response) => {
      requests.push(request.url ?? '')
      response.setHeader('access-control-allow-origin', '*')
      if (request.url?.startsWith('/redirect')) { response.writeHead(302, { location: '/received' }); response.end(); return }
      response.setHeader('content-type', 'text/html')
      response.end('<!doctype html><body>probe</body>')
    })
    sockets = new WebSocketServer({ server: receiver })
    sockets.on('connection', (socket, request) => { socketRequests.push(request.url ?? ''); socket.send('connected') })
    await new Promise<void>((resolve, reject) => { receiver!.once('error', reject); receiver!.listen(0, '127.0.0.1', resolve) })
    const address = receiver.address()
    if (typeof address !== 'object' || address === null) throw new Error('probe receiver unavailable')
    const forbiddenUrl = `http://127.0.0.1:${address.port}`
    const page = await app.firstWindow()
    await page.goto(`${forbiddenUrl}/parent`)
    await page.evaluate(async (base) => {
      await fetch(`${base}/http-control`)
      await new Promise<void>((resolve, reject) => {
        const socket = new WebSocket(`${base.replace('http:', 'ws:')}/ws-control`)
        const timer = setTimeout(() => { socket.close(); reject(new Error('renderer websocket control timeout')) }, 2000)
        socket.onopen = () => { clearTimeout(timer); socket.close(); resolve() }
        socket.onerror = () => { clearTimeout(timer); reject(new Error('renderer websocket control failed')) }
      })
    }, forbiddenUrl)
    await expect.poll(() => requests.includes('/http-control') && socketRequests.includes('/ws-control')).toBe(true)
    requests.length = 0
    socketRequests.length = 0
    const secured = withArtifactContentSecurity('<script>window.ran=true</script>')
    const frameName = 'huaanwork-artifact-11111111-1111-4111-8111-111111111111'
    await page.setContent(`<iframe name="${frameName}" sandbox="allow-scripts" src="about:blank"></iframe>`)
    const frameTreeNodeId = await app.evaluate(async (_electron, input) => {
      const { guard, artifactFrameId } = await import(input.mainUrl)
      guard.registerEmptyFrame(input.frameName)
      return artifactFrameId(input.frameName)
    }, { mainUrl, frameName })
    expect(typeof frameTreeNodeId).toBe('number')
    await page.locator('iframe').evaluate((element, content) => {
      element.removeAttribute('src')
      element.setAttribute('srcdoc', content)
    }, secured)
    const frame = page.frames().find((item) => item !== page.mainFrame())
    if (!frame) throw new Error('artifact iframe missing')
    await frame.waitForFunction(() => Reflect.get(window, 'ran') === true)
    const result = await frame.evaluate(async (forbiddenUrl) => {
      const rejects = async (run: () => unknown) => {
        try { await run(); return false } catch { return true }
      }
      const wsUrl = `${forbiddenUrl.replace('http:', 'ws:')}/ws-blocked`
      const wsEvidence = await new Promise<{ denied: boolean; blockedURI?: string }>((resolve) => {
        let socket: WebSocket | undefined
        let errorObserved = false
        let blockedURI: string | undefined
        const finish = (denied: boolean): void => {
          clearTimeout(timer)
          document.removeEventListener('securitypolicyviolation', onViolation)
          if (socket) { socket.onerror = null; socket.onopen = null; socket.close() }
          resolve({ denied, ...(blockedURI === undefined ? {} : { blockedURI }) })
        }
        const settle = (): void => { if (errorObserved && blockedURI !== undefined) finish(true) }
        const onViolation = (event: SecurityPolicyViolationEvent): void => {
          if (event.effectiveDirective !== 'connect-src') return
          try {
            if (new URL(event.blockedURI).origin !== new URL(wsUrl).origin) return
          } catch { return }
          blockedURI = event.blockedURI
          settle()
        }
        const timer = setTimeout(() => finish(false), 2000)
        document.addEventListener('securitypolicyviolation', onViolation)
        try {
          socket = new WebSocket(wsUrl)
          socket.onerror = () => { errorObserved = true; settle() }
          socket.onopen = () => finish(false)
        } catch (error) {
          errorObserved = error instanceof DOMException && error.name === 'SecurityError'
          if (!errorObserved) finish(false)
          else settle()
        }
      })
      const result = {
        requireDenied: typeof require === 'undefined',
        processDenied: typeof process === 'undefined',
        parentDenied: (() => { try { void window.parent.location.href; return false } catch { return true } })(),
        openerDenied: window.opener === null,
        popupDenied: window.open(forbiddenUrl) === null,
        fetchDenied: await rejects(() => fetch(forbiddenUrl)),
        xhrDenied: await new Promise<boolean>((resolve) => {
          const request = new XMLHttpRequest()
          const timer = setTimeout(() => resolve(false), 1000)
          request.onerror = () => { clearTimeout(timer); resolve(true) }
          request.onload = () => { clearTimeout(timer); resolve(false) }
          request.open('GET', forbiddenUrl)
          request.send()
        }),
        webSocketDenied: wsEvidence.denied,
        webSocketPolicyObserved: wsEvidence.blockedURI !== undefined,
        webSocketBlockedURI: wsEvidence.blockedURI,
        topNavigationDenied: (() => { try { window.top!.location.href = forbiddenUrl; return false } catch { return true } })(),
      }
      return result
    }, forbiddenUrl)
    expect(result).toMatchObject({
      requireDenied: true, processDenied: true, parentDenied: true, openerDenied: true,
      popupDenied: true, fetchDenied: true, xhrDenied: true, webSocketDenied: true, topNavigationDenied: true,
      webSocketPolicyObserved: true,
    })
    const formResult = await frame.evaluate(async (forbiddenUrl) => {
      const before = location.href
      const form = document.createElement('form')
      form.action = forbiddenUrl
      document.body.append(form)
      form.submit()
      await new Promise((resolve) => setTimeout(resolve, 100))
      return location.href === before
    }, forbiddenUrl)
    expect(formResult).toBe(true)
    for (const mode of ['script', 'link', 'meta', 'renamed', 'redirect']) {
      const navigationUrl = `${forbiddenUrl}/${mode === 'redirect' ? 'redirect' : 'received'}?case=${mode}`
      await frame.evaluate(({ mode, url }) => {
        if (mode === 'link') {
          const link = document.createElement('a'); link.href = url; document.body.append(link); link.click()
        } else if (mode === 'meta') {
          const meta = document.createElement('meta'); meta.httpEquiv = 'refresh'; meta.content = `0;url=${url}`; document.head.append(meta)
        } else {
          if (mode === 'renamed') window.name = 'renamed-by-content'
          location.href = url
        }
      }, { mode, url: navigationUrl })
      await expect.poll(async () => app.evaluate(async (_electron, input) => {
        const { blockedNavigations } = await import(input.mainUrl)
        return blockedNavigations.some((event: { url: string; frameTreeNodeId?: number }) =>
          event.url === input.url && event.frameTreeNodeId === input.frameTreeNodeId)
      }, { mainUrl, url: navigationUrl, frameTreeNodeId }), { timeout: 2000 }).toBe(true)
      expect(frame.url()).toBe('about:srcdoc')
      expect(requests).toEqual([])
      expect(socketRequests).toEqual([])
    }
  } finally {
    try { await app.close() } finally {
      try {
        if (sockets) {
          for (const socket of sockets.clients) socket.terminate()
          await new Promise<void>((resolve, reject) => sockets!.close((error) => error ? reject(error) : resolve()))
        }
      } finally {
        if (receiver?.listening) {
          receiver.closeAllConnections()
          await new Promise<void>((resolve, reject) => receiver!.close((error) => error ? reject(error) : resolve()))
        }
      }
    }
  }
}, 30_000)
```

探针只请求本机接收端；同一 Electron renderer 的 HTTP 与 WS control 都须成功，再清零各自接收计数。每个导航动作使用唯一 URL，按该 URL 与固定 frameTreeNodeId 有界等待真实 preventDefault 记录，而非固定睡眠或共享计数，随后核对零请求。WS 独立等待 error/open 与匹配其 blockedURI 的 connect-src 违规：浏览器可裁去路径，因此按 WS 协议和 origin 匹配，不能借用 fetch/XHR 的 HTTP 违规；还须零 WS 握手。真实 Electron 与 Chromium 证据分开记录；探针 main 加载同一生产 guard，不以测试专用拦截代替。

Electron npm 包运行时 require 返回路径、类型声明却是 Electron API，故显式以 unknown 接收并窄化为 string；传给 Playwright 的环境变量必须先过滤 undefined。该 `.electron.ts` 仍在测试 typecheck 范围，不能因它未进入默认 Vitest 就跳过类型验证。

窗口和本机监听端均在 finally 释放；仅对子进程环境副本移除 ELECTRON_RUN_AS_NODE，不改全局环境，也不添加 --no-sandbox。未安装原生 guard 时组件必须保持空 iframe，本 Task 不把尚未完成 Task 7 的 RPC 接线称为应用验收通过。

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
  identifier?: string
  position?: { start: { offset?: number }; end: { offset?: number } }
  children?: MarkdownNode[]
}

export function withoutRemoteMarkdownImages(content: string): string {
  const tree = fromMarkdown(content, {
    extensions: [gfm(), math()],
    mdastExtensions: [gfmFromMarkdown(), mathFromMarkdown()],
  }) as MarkdownNode
  const definitions = new Map<string, string>()
  const walk = (node: MarkdownNode, visit: (node: MarkdownNode) => void): void => {
    visit(node)
    node.children?.forEach((child) => walk(child, visit))
  }
  walk(tree, (node) => {
    if (node.type !== 'definition' || node.identifier === undefined || node.url === undefined) return
    const key = node.identifier.toUpperCase()
    if (!definitions.has(key)) definitions.set(key, node.url)
  })
  const replacements: Array<{ start: number; end: number }> = []
  walk(tree, (node) => {
    if (node.type !== 'image' && node.type !== 'imageReference') return
    const url = node.type === 'image'
      ? node.url
      : definitions.get(node.identifier?.toUpperCase() ?? '')
    if (!/^https?:\/\//i.test(url ?? '')) return
    const start = node.position?.start.offset
    const end = node.position?.end.offset
    if (start === undefined || end === undefined) throw new Error('artifact-markdown-image-position-missing')
    replacements.push({ start, end })
  })
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

`ArtifactHtmlView` 先创建空 iframe：随机 `frameName=huaanwork-artifact-${crypto.randomUUID()}`、`sandbox="allow-scripts"`、`src="about:blank"`、无 srcDoc。空 frame 的 load 后调用 `prepareFrame(frameName)`；成功且该组件/内容选择仍有效时，才移除 src 并设置 `srcDoc={secured}`。准备失败显示可见错误和重试，不提前插入模型 HTML。每次内容替换重建 frame/name，旧 Promise 返回不得武装新 frame；srcDoc 的 load 不得再次请求登记。不得增加其他 sandbox token。

原生防护模块只保存当前 WebContents 的活跃 Artifact frame 标识；frameName 仅在受信父页面尚未插入内容时用于定位，不作为后续授权依据。具体实现骨架如下，导入均为 Electron 公开类型：

```ts
import type { WebContents, WebFrameMain, WebContentsWillFrameNavigateEventParams } from 'electron'

export function installArtifactFrameGuard(renderer: WebContents) {
  const guarded = new Set<number>()
  const bootstrap = new Set<number>()
  const inside = (frame: WebFrameMain | null | undefined): boolean => {
    for (let current = frame; current && !current.detached; current = current.parent) {
      if (guarded.has(current.frameTreeNodeId)) return true
    }
    return false
  }
  const navigate = (event: Electron.Event<WebContentsWillFrameNavigateEventParams>): void => {
    const frame = event.frame
    if (!inside(frame) && !inside(event.initiator)) return
    if (frame && bootstrap.has(frame.frameTreeNodeId) && event.url === 'about:srcdoc') {
      bootstrap.delete(frame.frameTreeNodeId)
      return
    }
    event.preventDefault()
  }
  renderer.on('will-frame-navigate', navigate)
  return {
    registerEmptyFrame(frameName: string): void {
      const live = renderer.mainFrame.framesInSubtree.filter((frame) => !frame.detached)
      const liveIds = new Set(live.map((frame) => frame.frameTreeNodeId))
      for (const id of guarded) {
        if (!liveIds.has(id)) { guarded.delete(id); bootstrap.delete(id) }
      }
      const matches = live.filter((frame) => frame.name === frameName
        && frame.parent?.frameTreeNodeId === renderer.mainFrame.frameTreeNodeId
        && (frame.url === 'about:blank' || frame.url === ''))
      if (matches.length !== 1) throw new Error('artifact-frame-unavailable')
      const frame = matches[0]!
      guarded.add(frame.frameTreeNodeId)
      bootstrap.add(frame.frameTreeNodeId)
    },
    dispose(): void {
      renderer.off('will-frame-navigate', navigate)
      guarded.clear()
      bootstrap.clear()
    },
  }
}
```

`artifact-frame-guard.spec.ts` 用真实事件形状测试：唯一空直属子 frame 可登记；已带内容、重名、非直属或不存在的 frame 均拒绝；只放行一次 srcDoc 引导；改写 frame.name 后自导航仍 preventDefault；外部链接、meta refresh、重定向入口和后代导航均拒；未登记的其他 frame 和主页面导航不被此模块接管；移除 frame 后下一次登记回收旧标识；dispose 移除自己的 listener。Task 7 在主窗口与全屏生命周期中安装/释放该模块，不能仅在探针中使用。

`ArtifactPreview` 按声明 format 选择渲染器，提供全屏和下载；父页面把完整 ArtifactRef、固定 surface 与 frameName 发给 `artifact.prepareFrame`。frame 防护失败不影响原始字节下载，也不放松 CSP。

- [ ] **Step 5: 生成样式并运行构建与安全回归**

Run:
```bash
corepack yarn install
corepack yarn install --immutable
corepack yarn workspace dsh-plugin-huaanwork gen:styles
corepack yarn workspace dsh-plugin-huaanwork vitest run tests/client-huaanwork/ArtifactPreview.spec.ts tests/client-huaanwork/styles-generated.spec.ts tests/artifact-frame-guard.spec.ts
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
git add dsh-plugin-huaanwork/src/client-huaanwork/ArtifactPreview.tsx dsh-plugin-huaanwork/src/client-huaanwork/ArtifactMarkdownView.tsx dsh-plugin-huaanwork/src/client-huaanwork/ArtifactHtmlView.tsx dsh-plugin-huaanwork/src/artifact-frame-guard.ts dsh-plugin-huaanwork/tsdown.config.ts dsh-plugin-huaanwork/tests/artifact-frame-guard.spec.ts dsh-plugin-huaanwork/src/client-huaanwork/App.tsx dsh-plugin-huaanwork/src/client-huaanwork/styles.css dsh-plugin-huaanwork/src/client-huaanwork/styles.generated.ts dsh-plugin-huaanwork/package.json dsh-plugin-huaanwork/vitest.artifact-sandbox.config.ts .github/workflows/ci.yml yarn.lock dsh-plugin-huaanwork/tests/client-huaanwork/ArtifactPreview.spec.ts dsh-plugin-huaanwork/tests/electron/artifact-sandbox-probe.electron.ts dsh-plugin-huaanwork/tests/electron/artifact-sandbox-main.mjs
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
- Test: `dsh-plugin-huaanwork/tests/client-huaanwork/api.spec.ts`（另存为的外层交互等待）
- Test: `dsh-plugin-huaanwork/tests/huaanwork-host/artifact-routes.spec.ts`（双 ID、frame 准备及 summary.downloadName → native 接线）

**Interfaces:**
- Produces: `ArtifactNativeCapability`：`openArtifactFullscreen(target: ArtifactRef)`、`saveArtifact({downloadName, contentBase64, surface: 'main' | 'artifact'})`、`prepareArtifactFrame({surface, frameName})`；`huaanwork-host/index.ts` 从 `ctx.desktopRuntime` 窄化提供能力并挂入 `RouteContext`，缺失时路由返回 `artifact-native-unavailable`。
- Produces: `artifact.openFullscreen`、`artifact.download`、`artifact.prepareFrame` 宿主路由；三者都校验 `ArtifactRef`，后两者严格校验 surface，prepareFrame 额外校验 frameName。
- Produces: `ArtifactFullscreenPage({target: ArtifactRef})`、`artifactWindowTargetFromSearch(search): ArtifactRef | undefined` 与纯函数 `artifactWindowOptions(spec: Pick<DesktopShellSpec,"url">, target: ArtifactRef, partition: string)`。
- Preserves: 全屏窗口无业务 preload，旧 `will-download` 只处理旧附件；保存对话框 parent 为发起请求的窗口（全屏窗口请求时不得以主窗口为 parent）。

- [ ] **Step 1: 写窗口安全参数、启动模式和下载失败测试**

窗口纯函数在 `artifact-window.spec.ts` 测试；`runtime` 与既有 Electron dialog mock 沿用 `electron-runtime.spec.ts` 装配，并扩展 `showSaveDialogMock` 捕获实现。**该文件现状没有 `node:fs/promises` 的 writeFile/rename mock**：本 Task 新增 `vi.mock('node:fs/promises', ...)` 部分 mock，提供 `writeFileMock/renameMock/rm`；不得写成“复用既有 fs mock”。`writeFileMock` 将 Buffer 按临时路径存入 `temporaryContents`，`renameMock` 将对应字节搬到 `writtenTargets`，`rm` 清理对应键，使字节测试不依赖真实临时文件。不新增全局变量。

```ts
it('opens a fullscreen artifact window without node or business preload', () => {
  const options = artifactWindowOptions({ url: 'http://127.0.0.1:3000/' }, { sessionId: 'session-1', artifactId: 'artifact-1' }, 'huaanwork-artifact-test')
  expect(options.fullscreen).toBe(true)
  expect(options.webPreferences).toMatchObject({
    nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true,
  })
  expect(options.webPreferences.preload).toBeUndefined()
  expect(options.webPreferences.partition).toBe('huaanwork-artifact-test')
  expect(artifactWindowTargetFromSearch(new URL(options.url).search)).toEqual({ sessionId: 'session-1', artifactId: 'artifact-1' })
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

it('reloads the singleton with a complete target and renews only its own access listener', async () => {
  await runtime.openArtifactFullscreen({ sessionId: 'session-1', artifactId: 'artifact-1' })
  await runtime.openArtifactFullscreen({ sessionId: 'session-2', artifactId: 'artifact-2' })
  expect(browserWindowConstructor).toHaveBeenCalledTimes(1)
  const businessLoads = fullscreenContents.loadURL.mock.calls.filter(([url]) => url !== 'about:blank')
  expect(businessLoads).toHaveLength(2)
  expect(fullscreenWindow.focus).toHaveBeenCalledTimes(2)
  expect(artifactWindowTargetFromSearch(new URL(businessLoads[1]![0]).search))
    .toEqual({ sessionId: 'session-2', artifactId: 'artifact-2' })
  expect(callOrder(fullscreenContents)).toEqual([
    'loadBlank', 'authenticateRendererSession', 'installRendererAccessHeader', 'loadArtifact',
    'loadBlank', 'removeRendererAccessHeader', 'authenticateRendererSession', 'installRendererAccessHeader', 'loadArtifact',
  ])
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

`artifactWindowTargetFromSearch` 只接受 `artifactWindow=1` 且 sessionId/artifactId 均为合法单路径段，返回完整 `ArtifactRef`。`applyHuaanworkShell` 仍安装相同样式和 frame，但将 root 的 `tree` 设为：

```tsx
const search = window.location.search
const artifactMode = new URLSearchParams(search).get('artifactWindow') === '1'
const target = artifactWindowTargetFromSearch(search)
const tree = target
  ? React.createElement(ArtifactFullscreenPage, { target })
  : artifactMode
    ? React.createElement('div', { role: 'alert' }, '结果窗口参数无效')
    : React.createElement(App)
```

全屏页以 target 的双 ID 加载 `artifact.get/content`、调用下载和 HTML frame 准备接口，复用 `ArtifactPreview`；不得从主 App 状态猜 sessionId，也不增加 Profile 全量反查。Esc 与关闭按钮调用 `window.close()`，Electron `close` 释放资源；不加载完整主 App 或业务 preload，不新增关闭 RPC。补接线测试：从实际 `options.url` 解析 target，使用 Task 4 真实路由调用器读取首个 Artifact；切到另一会话 Artifact 后读取正确；错配 sessionId/artifactId 被拒绝；参数错误不挂载 App。

- [ ] **Step 4: 通过 HostRpc 增加声明式 native 能力**

在 `runtime.ts` 声明窄能力类型；ArtifactRef 以 type-only 导入，不向所有 DesktopRuntime 测试桩强加新方法：

```ts
export interface ArtifactNativeCapability {
  openArtifactFullscreen(target: ArtifactRef): Promise<void>
  saveArtifact(input: { downloadName: string; contentBase64: string; surface: 'main' | 'artifact' }):
    Promise<{ saved: false } | { saved: true; path: string }>
  prepareArtifactFrame(input: { surface: 'main' | 'artifact'; frameName: string }): Promise<void>
}
```

在 `createHostRuntime` 内构造以下方法，并把 `...artifactNativeMethods` 展开到既有返回对象，保留其他 runtime 方法：

```ts
const artifactNativeMethods: ArtifactNativeCapability = {
  openArtifactFullscreen: input => send('native:openArtifactFullscreen', [input]),
  saveArtifact: input => send('native:saveArtifact', [input]),
  prepareArtifactFrame: input => send('native:prepareArtifactFrame', [input]),
}
```

`bindNativeRuntime` 为三个方法注册精确 handler，校验双 ID、downloadName、base64 形状、`surface === 'main' || surface === 'artifact'`，以及 `frameName` 为 `huaanwork-artifact-` 前缀加 UUID 的有界字符串。`ArtifactNativeCapability` 是独立可选接口，不并入所有 DesktopRuntime 测试桩；由 `huaanwork-host/index.ts` 检查三个方法后注入 RouteContext，路由缺能力时报 `artifact-native-unavailable`。生产 Electron 装配必须提供，测试夹具只补该窄接口。

在 ROUTE_TABLE、rpc-types 的 method 联合与客户端 ROUTES 同步增加三个 POST：`artifact.openFullscreen → /huaanwork/artifact/openFullscreen`、`artifact.download → /huaanwork/artifact/download`、`artifact.prepareFrame → /huaanwork/artifact/prepareFrame`。body 分别为 ArtifactRef、ArtifactRef 加 surface、ArtifactRef 加 surface/frameName，不接受任意文件路径。

Host 的 openFullscreen/download/prepareFrame 均先用双 ID 校验当前 Profile 下的归属；开窗传完整 ArtifactRef，下载只传宿主读取的原字节 base64 和 summary.downloadName。prepareFrame 只传 surface/frameName，返回 `{prepared:true}`；原生侧选中对应 WebContents 后调用 Task 6 的 frame guard 登记空 frame，不能接受 renderer 自报的数字 frame ID。主窗口固定传 main，全屏固定传 artifact；Artifact 窗口不存在时报 `artifact-window-unavailable`，不得回落主窗口。

主窗口与全屏安装同一 frame guard，prepareArtifactFrame 选当前承载页面的真实 WebContents，不能误选兼容壳 chrome。全屏还要沿用主窗口的顶层同源导航约束与安全外链打开策略；Markdown 的外链不得通过默认 window.open 创建第二个应用窗口。

每个新 Artifact 窗口创建独占的非持久 partition：`huaanwork-artifact-${randomUUID()}`，不使用主窗口 partition。打开请求在 runtime 实例内串行，不在模块全局保存状态。每次业务开窗执行：加载 about:blank 撤下旧内容 → 释放旧 header listener → authenticateRendererSession → 安装新 header listener → loadURL 双 ID 业务地址 → focus；about:blank 不需要服务端鉴权。复用同一 WebContents，不复用其他窗口的 listener。失败时清理本次 listener、frame guard 和窗口并返回错误；关闭、Host handover 和 Runtime teardown 都执行同一幂等释放路径，不影响主窗口。

原生测试的 session.fetch mock 必须经过当前安装的真实 onBeforeSendHeaders listener，不能只记调用顺序：带已有认证 cookie 的第二次打开也要成功；无 renderer 身份请求在旧 listener 存在时确实会丢 header，修订后鉴权时旧 listener 已释放。另测鉴权失败清理、并发两次打开、关闭后主窗口 HTTP/WS 的 header listener 仍有效。真实 Electron 验收还须复测请求身份；这里不预称“第二次必现失败”。

交互超时两层同时处理：把 `native:saveArtifact` 加入 native interactive 无超时名单；客户端 api.ts 仅把 `artifact.download` 加入 `INTERACTIVE_METHODS`，为它省略 `AbortSignal.timeout`，其他方法仍保留既有超时。

```ts
const INTERACTIVE_METHODS = new Set(['artifact.download'])
const init: RequestInit = {
  method: route.http,
  ...(INTERACTIVE_METHODS.has(method) ? {} : { signal: AbortSignal.timeout(timeoutMs) }),
}
```

在 api.spec.ts 用可控 fetch Promise 与虚拟时钟参数化保存/取消：先断言 artifact.download 的 fetch init **没有 signal 字段**；普通 status.get 仍携带 AbortSignal。fetch mock 必须监听传入 signal 的 abort 并 reject(signal.reason)，预先 aborted 时立即拒绝，不能使用忽略 signal 的永不拒绝 Promise。调用下载后推进 180001ms，断言仍 pending，再释放 `{saved:true}` 或 `{saved:false}`，得到实际结果；普通请求到期仍拒绝。必要时在测试内用受虚拟时钟控制的 AbortController 实现 AbortSignal.timeout spy，不能假定 Node 原生 timeout 随 Vitest 时钟推进。

```ts
expect(downloadFetchInit).not.toHaveProperty('signal')
expect(statusFetchInit.signal).toBeInstanceOf(AbortSignal)
```

`downloadFetchInit` 与 `statusFetchInit` 来自相应调用的 fetch mock 参数，不是手工构造的期望对象。将 api.ts 临时恢复旧的无条件 `signal: AbortSignal.timeout(timeoutMs)` 时，本测试必须因 signal/超时转红，再恢复新实现；仅“Promise 仍 pending”不构成反证。真实 fetch 错误仍拒绝，不能当取消；native 测试确认保存一次、取消零次写入。

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
corepack yarn workspace dsh-plugin-huaanwork vitest run tests/artifact-window.spec.ts tests/desktop-browser-access.spec.ts tests/electron-runtime.spec.ts tests/client-huaanwork/artifactWindow.spec.ts tests/client-huaanwork/api.spec.ts tests/huaanwork-host/artifact-routes.spec.ts
corepack yarn workspace dsh-plugin-huaanwork typecheck
```
Expected: PASS；主窗口与全屏窗口都只有声明式能力。

- [ ] **Step 7: Commit**

```bash
git add dsh-plugin-huaanwork/src/client-huaanwork/ArtifactFullscreenPage.tsx dsh-plugin-huaanwork/src/client-huaanwork/shell.ts dsh-plugin-huaanwork/src/runtime.ts dsh-plugin-huaanwork/src/host-runtime-bridge.ts dsh-plugin-huaanwork/src/electron-runtime.ts dsh-plugin-huaanwork/src/electron-shell-generation.ts dsh-plugin-huaanwork/src/huaanwork-host/routes.ts dsh-plugin-huaanwork/src/huaanwork-host/index.ts dsh-plugin-huaanwork/src/client-huaanwork/api.ts dsh-plugin-huaanwork/src/client-huaanwork/rpc-types.ts dsh-plugin-huaanwork/tests/artifact-window.spec.ts dsh-plugin-huaanwork/tests/desktop-browser-access.spec.ts dsh-plugin-huaanwork/tests/electron-runtime.spec.ts dsh-plugin-huaanwork/tests/client-huaanwork/artifactWindow.spec.ts dsh-plugin-huaanwork/tests/client-huaanwork/api.spec.ts dsh-plugin-huaanwork/tests/huaanwork-host/artifact-routes.spec.ts
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
- Test: `dsh-plugin-huaanwork/tests/huaanwork-host/artifacts-host.spec.ts`（两阶段失效与释放）
- Test: `dsh-plugin-huaanwork/tests/huaanwork-host/automations-host.spec.ts`（复用 Task 3 真实运行 harness/屏障）
- Test: `dsh-plugin-huaanwork/tests/huaanwork-host/automations-store.spec.ts`
- Test: `dsh-plugin-huaanwork/tests/huaanwork-host/sessions.spec.ts`

**Interfaces:**
- Produces: `removeArtifactsOfSession`、`removeArtifactOfRun`、`removeArtifactsOfAutomation`、`scanArtifactManifests`（只读 manifest 扫描，供自动化/项目删除与测试仪器化）。
- Consumes: Task 1 的不透明 ArtifactWrite scope/活跃 lease；删除进入与退出 profile 锁的同步段各失效一次匹配 lease，commit 失效时报 `artifact-owner-deleted`。
- Preserves: 各现有删除原语的权威记录、错误与 N2 语义；删除不存在的 Artifact 幂等成功但仍失效活跃 write；不改变 prune 保留集、collector/scheduler 释放时点或运行会话生命周期。

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
  const first = await seedRunArtifact({ runId: 'run-1', title: '同名结果' })
  const other = await seedRunArtifact({ profileDir: first.profileDir, runId: 'run-2', title: '同名结果' })
  await rm(join(first.profileDir, 'sessions', first.sessionId), { recursive: true, force: true })
  await removeAutomation(first.profileDir, first.automationId)
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

`seedRunArtifact` 是测试内明确定义的夹具，参数类型为 `{profileDir?:string;runId?:string;title?:string;includeSessionId?:boolean}`：缺 profileDir 时新建并登记清理，提供时复用同一 profile；用真实 createAutomation 返回的 id（不虚构传入 id 的 API）、appendRun/createArtifact 写记录与锚定 Artifact，并返回 `{profileDir,automationId,runId,sessionId,artifactId}`。sessionId 用真实 `automationRunSessionId`；`includeSessionId:false` 只让 RunSummary 不带该字段，不删除 Artifact。两个 automation 同名用例必须共用 profile，不能以两个隔离目录假证精确匹配。`scanArtifactManifests` 是 Step 3 实现的只读扫描器，自动化/项目删除可调用，单 run 直定位不得调用。

增加可控删除屏障，直接调用真实 store（以下 helper 在 `artifact-lifecycle.spec.ts` 内定义，不新增产品测试接口）：

```ts
const deletionIo = vi.hoisted(() => ({
  path: undefined as string | undefined,
  wait: undefined as undefined | (() => Promise<void>),
}))
vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...real,
    rm: async (...args: Parameters<typeof real.rm>) => {
      if (args[0] === deletionIo.path) await deletionIo.wait?.()
      return real.rm(...args)
    },
  }
})
function deletionBarrier() {
  const entered = Promise.withResolvers<void>()
  const released = Promise.withResolvers<void>()
  return { entered: entered.promise, release: () => released.resolve(),
    wait: async () => { entered.resolve(); await released.promise } }
}

it('invalidates writes begun while deletion awaits I/O even when no final directory exists', async () => {
  const root = mkdtempSync(join(tmpdir(), 'artifact-delete-race-'))
  const scope: ArtifactWriteScope = {
    sessionId: 'session-1', anchor: { kind: 'turn' }, idempotency: { kind: 'tool', callId: 'race' },
  }
  const before = beginArtifactWrite(root, scope)
  const writes = [before]
  const gate = deletionBarrier()
  deletionIo.path = join(root, 'artifacts', scope.sessionId)
  deletionIo.wait = gate.wait
  const removing = removeArtifactsOfSession(root, scope.sessionId)
  try {
    await gate.entered
    const during = beginArtifactWrite(root, scope)
    writes.push(during)
    await prepareArtifact(during, { title: '迟到', format: 'markdown', content: '# 不应复活' })
    gate.release()
    await removing
    for (const write of writes) {
      await expect(commitPreparedArtifact(write)).rejects.toThrow('artifact-owner-deleted')
      await discardPreparedArtifact(write)
    }
    expect(await listArtifacts(root, scope.sessionId)).toEqual([])
    expect(existsSync(join(root, 'artifacts', scope.sessionId))).toBe(false)
  } finally {
    gate.release()
    await removing
    deletionIo.path = undefined
    deletionIo.wait = undefined
    await Promise.all(writes.map((write) => discardPreparedArtifact(write)))
    rmSync(root, { recursive: true, force: true })
  }
})
```

该例要求 remove 即使目标不存在也走锁内失效及 `rm(force:true)`；before 未 prepare 也必须优先报 owner-deleted。另以 `rm` 部分 mock 先等屏障再抛错误，验证 finally 仍使 during lease 失效且错误显式上报；afterEach 恢复 mock，所有等待者在 finally 释放。

在 `automations-host.spec.ts` 复用 Task 3 的 afterPrepare 屏障与真实运行 harness 增加 prune 用例：
1. h.state.reply 为合法封套；测试内通过 mkdir/writeFile 创建符合既有 session 枚举布局的当前自动化会话夹具（该 harness 的 agent double 本身不落会话文件），不得伪造 RunSummary。
2. await afterPrepare.entered，断言 `automationCollector.has(sessionId)===false`、scheduler 已释放该 session，且 `recentRuns` 中仍无该 run；write 必须已从执行开始持有。
3. 调用既有 `automation.pruneSessions` 真实 ROUTE_TABLE handler，使用原 collector/scheduler 计算的保留集，不手工添加 inFlight/write session。断言该会话仍被正常删除（不能以延迟释放或扩大保留集“修好”测试）。
4. release，await run.done，从 recentRuns 读取真实 summary，断言冻结执行 ok/status 不变、artifactOutcome=failed、artifactError=artifact-owner-deleted；无 artifact/created、会话 Artifact 最终目录不存在、正文不再生，run-end 同字段。

再覆盖反序：先 commit 落最终正文，再删除，最终为空；并发相同 run 只有一份正文/一次 emit（Task 3）；精确 run/automation 失效只影响匹配 scope，兄弟 lease 仍可 commit；取消、prepare/commit 失败和早退的 discard 回收后重复删除无悬挂等待，无永久 tombstone。所有结果核对真实磁盘与事件，不用 fake summary 或定时 sleep。

- [ ] **Step 2: 确认当前删除路径会遗留 Artifact**

Run:
```bash
corepack yarn workspace dsh-plugin-huaanwork vitest run tests/huaanwork-host/artifact-lifecycle.spec.ts
```
Expected: FAIL，Artifact 目录仍存在。

- [ ] **Step 3: 实现共享清理原语**

```ts
export async function removeArtifactsOfSession(profileDir: string, sessionId: string): Promise<void>
export async function removeArtifactOfRun(profileDir: string, sessionId: string | undefined, automationId: string, runId: string): Promise<void>
export async function removeArtifactsOfAutomation(profileDir: string, automationId: string): Promise<void>
```

实现均从安全 artifact 根和单段 ID 定位，拒绝符号链接逃逸；删除与 commit 共用 profile Promise 锁。`removeArtifactsOfSession` 在**进入锁后、删除 I/O 前**同步失效 session 匹配的全部活跃 lease；在**锁内 finally、退出锁前**再次失效，覆盖删除等待期间同步 begin 的新 lease。即使最终目录不存在或 rm 失败也执行两次失效；不能只在目录存在分支或调用 remove 之前失效。begin 不等待锁，commit 必须等待此锁并优先检查失效，失败为具名 `artifact-owner-deleted`，不得 rename 或发布成功。lease 失效不代替调用者 finally discard；最后一个 lease 释放即移除活跃映射，不保留永久删除标记。

`removeArtifactOfRun` 与 `removeArtifactsOfAutomation` 在相同进入/finally 两个同步段按 write scope 的精确 `automation-run` anchor 匹配 lease，不能只靠已落盘 manifest。`deleteAutomationRun` 把 `RunSummary.sessionId` 传给 `removeArtifactOfRun(profileDir, sessionId, automationId, runId)`，其磁盘删除只检查该会话 manifest，不扫描全 profile。自动化/项目级联删除允许扫描全部 manifest，但只按自动化锚点精确匹配，不按标题、下载名或目录名猜测。

`RunSummary` 缺 sessionId 时传 undefined（不是空字符串）；`removeArtifactOfRun` 仍在锁内按已知 automationId/runId 失效活跃 write，但不猜目录、不扫描磁盘，并向调用者报告清理不完整。权威记录删除照常完成，路由继续显示“记录已删除、结果文件未能完全清理”。这个窄化输入只让失效和原缺定位错误共用同一清理函数，不新增删除运行中记录的入口（原 inFlight 拒绝仍保留）。两阶段只防止删除中的在途 Artifact 晚到再生，不改变 N2、prune 保留集或 collector/scheduler。

- [ ] **Step 4: 接入所有共享删除路径**

- `removeSession`/`sessionRemove`：删除该会话 Artifact。
- `deleteAutomationRun`：删除该 run Artifact。
- `removeAutomation`：删除自动化全部 Artifact，确保 `removeAutomationsOfProject` 自动继承。
- `pruneAutomationSessions`：只清理实际被删会话的 Artifact；保留的运行记录不承诺完整结果页。
- 路由只报告底层清理结果，不另写一套目录删除。

- [ ] **Step 5: 运行生命周期、全量测试和仓级门禁**

Run:
```bash
corepack yarn workspace dsh-plugin-huaanwork vitest run tests/huaanwork-host/artifact-lifecycle.spec.ts tests/huaanwork-host/artifacts-host.spec.ts tests/huaanwork-host/automations-host.spec.ts tests/huaanwork-host/automations-store.spec.ts tests/huaanwork-host/sessions.spec.ts
corepack yarn workspace dsh-plugin-huaanwork typecheck
corepack yarn check
```
Expected: PASS。任何失败必须按实际输出处置；既有 `verify:aa` 并发 flake 只能串行重跑并记录，不能隐瞒。

- [ ] **Step 6: Commit**

```bash
git add dsh-plugin-huaanwork/src/huaanwork-host/artifacts-host.ts dsh-plugin-huaanwork/src/huaanwork-host/sessions.ts dsh-plugin-huaanwork/src/huaanwork-host/automations-store.ts dsh-plugin-huaanwork/src/huaanwork-host/routes.ts dsh-plugin-huaanwork/tests/huaanwork-host/artifact-lifecycle.spec.ts dsh-plugin-huaanwork/tests/huaanwork-host/artifacts-host.spec.ts dsh-plugin-huaanwork/tests/huaanwork-host/automations-host.spec.ts dsh-plugin-huaanwork/tests/huaanwork-host/automations-store.spec.ts dsh-plugin-huaanwork/tests/huaanwork-host/sessions.spec.ts
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
  执行：打开一个结果，再选择另一会话的结果复用窗口；分别用窗口内关闭按钮与 Esc 返回。
  证据：同一 WebContents 的双 ID 与两次内容读取、独占 session、旧 listener 撤销及新鉴权记录；关闭后主会话布局与消息不变、主窗口 RPC 可用。鉴权失败分支另保留原生测试证据，不以调用次数替代请求成功。
- [ ] **Step 4: HTML 交互与隔离**
  执行：在右侧预览与全屏中操作图表交互；分别验证空 frame 登记后才释放内容，并执行脚本自导航、链接、meta refresh、改名后导航、重定向入口探针。
  证据：交互成功、原生防护安装、父应用/网络/弹窗/表单/顶层导航不可达的记录；本地接收端先有 control 正例，再对禁止动作零请求；两种真实页面的安装接线必须验证，不能仅引用独立 Task 6 探针作为整机验收。
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
- 右侧预览按声明类型渲染；引用式远程 Markdown 图片不加载且普通链接保留。HTML 仅在原生 frame 防护确认后进入无同源沙箱；子资源与自身导航均不得访问网络，两个实际入口和 Electron 探针均有证据。
- 全屏携带双 ID、独占 session，访问头/RPC 可用；同 WebContents 切换前撤下旧页面与 listener，鉴权失败/关闭/teardown 不影响主窗口。下载 parent 为请求窗口、两层等待不被 180 秒截断，取消零写入、保存原字节一致。
- 五类删除路径无孤儿 Artifact；预算（UTF-8 字节）、幂等、路径归属和迟到应答测试通过。
- 规格 §12.2 七项用户验收已在 Task 9 逐步执行并留有证据，结论与证据一致。
- 包级 `typecheck` 与仓级 `corepack yarn check` 已实际执行并记录真实结果。

## 2026-11-19 复核与修订记录

本轮对上一轮意见重新做独立反证；保留 8 项 Important、3 项 Minor，但 I5/I6/I7 的影响表述收窄如下。这里评估的是待实施方案，不指称这些功能已上线或已完成真实 Electron 验收；产品裁定 R1–R10 不变，规格只同步技术机制。

| 项目 | 校准结论 | 本计划处置与可判别验证 |
| --- | --- | --- |
| I1 首轮 schema 时序 | Important，成立；影响首请求，不是全程不可用或执行越权 | Task 2 在真实 claimed 通知同步完成来源挂卸，捕获首模型请求并覆盖兼容切换、队列、goal 与包儿童 |
| I2 全屏缺会话 ID | Important，成立 | Task 7 贯通 ArtifactRef 双 ID，直接用启动参数调用真实查询路由；不扫描反查、不放宽归属校验 |
| I3 iframe 自导航 | Important，成立；Chromium 复现与 Electron 产品实测分开 | Task 6 原生 frame 专属防护先于内容，Task 7 两入口安装；本地接收端正例加零请求、真实 preventDefault 记录 |
| I4 引用式图片 | Important，成立 | Task 6 两遍 AST、归一化和首定义规则；完整/折叠/快捷引用、重复定义及代码块/普通链接保护 |
| I5 重复鉴权 listener | Important，部分成立；撤回无条件“第二次必然失败” | Task 7 明确独占 session、空页过渡、listener 撤销/安装及失败释放；测试真实 listener 处理、有 cookie 与主窗口不受影响 |
| I6 适配期取消 | Important，部分成立；不声称必然产生 cancelled 记录带 Artifact | Task 3 以 Summary 同步构造为冻结点；其前取消零发布，其后保留原有晚停止裁定，不扩大旧窗口治理 |
| I7 删除后再生 | Important，部分成立；不升级既有 N2 为新历史数据丢失 | Task 1/8 活跃写入句柄失效，阻止新 Artifact 晚提交；不修改 prune 保留集或 collector/scheduler 释放时机 |
| I8 WebSocket 探针 | Important，成立，属于验收断言而非运行时越权 | Task 6 等待异步 error/open、核对 CSP 违规及零握手，不把断网当隔离成功 |
| M1 未定位分组 | Minor，成立，是视觉错组而非 anchor 被改写 | Task 5 尾部分组与正常回合分离，两种插入顺序、后续新消息及 list 重放测试 |
| M2 保存外层超时 | Minor，成立，不是未经确认写文件 | Task 7 仅对 artifact.download 取消固定 HTTP 超时，虚拟时钟覆盖超过三分钟后的保存/取消 |
| M3 基线与范围 | Minor，成立 | 基线更新为 a423eef9fc；明确 CI/lock/证据例外，前置模块直接消费 |

依据包括当前 pin 的 `agent-loop/src/inbox.ts` 与 `agent.ts`、`huaanwork-host/turn-anchors.ts`、自动化取消/prune 原语、Electron 访问头实现与公开 frame 类型、Markdown 渲染器的 definition 解析；原有晚停止裁定见 `../specs/2026-10-21-automation-result-preview-design.md`，N2 边界见 `../specs/2026-11-09-automation-project-linkage-design.md`。真实模型请求、Electron 探针和七项用户验收仍需实施后执行；本轮文档修订不能勾选这些验收。
