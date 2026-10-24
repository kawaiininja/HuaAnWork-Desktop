# 会话内创建智能体包 M1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在华安工作台的会话里创建、运行、启停本地智能体包，并在 AgentsView 三页签中管理它们；M1 只在本地工作，不发布、不下载、不签名。

**Architecture:** 一个统一的本地智能体包目录 `{profileDir}/agents/{slug}/`，由宿主负责草稿、确认、原子落盘、启停和 `@` 分发；包里的 HTTP/MCP 脚本以沙箱子进程运行，persona/skill 由宿主读取后注入子代理。AgentsView 采用三页签：智能体广场（现有目录）、我的智能体（本地包 + catalog-legacy）、我的工具包（本地工具 + 公用机工具）。

**Tech Stack:** TypeScript、Cordis、React 19、Vitest、Node.js 22/24、`@deepseek-ai/dsh-sandbox`、`@deepseek-ai/dsh-tools`、现有 HuaAnWork HTTP RPC/WS 事件层。

**Spec:** `docs/superpowers/specs/2026-10-23-chat-created-agent-packages-design.md`

## Global Constraints

- 只实现 M1：本地创建、本地包、`@` 运行、启用/关闭、三页签、macOS + Windows。发布、签名、下载、安装、更新广场包、下架、撤销一律不做。
- 不改 `dsh-plugin-desktop/`、`dsh-plugin-desktop-beta/`、`dsh-desktop-next/`、`deepseek-harness/`、`dsh-community-market/`、`market-server/`。
- 智能体与数字员工是同一个实体；包目录使用 `agents/{slug}/`，不建第二套 `employees/`。
- 包内不得有 `.signature/`；M1 的本地包没有签名。`source` 只使用 `local` 与 `catalog-legacy`。
- 沙箱使用现有 `ctx.sandbox`，模式固定 `workspace-write`；`SANDBOX_UNAVAILABLE` 必须 fail-closed，禁止无沙箱执行。
- 现有沙箱只限制写；读文件与网络不隔离。UI 与文档必须写明。
- 字段上限：slug 1–32 且匹配 `^[a-z0-9]+(?:-[a-z0-9]+)*$`；displayName 1–40 UTF-16 码元；description 1–200；persona 32 KiB；SKILL.md 32 KiB；单脚本 256 KiB；最多 20 个脚本；HTTP/MCP 入口各 256 KiB；整包 5 MiB；persona + SKILL.md + allowSkills 正文合计 64 KiB；HTTP `argumentsSchema` 序列化后 1024 字符。
- 新建默认 `enabled:false`。同意句严格为 `可以`、`确认`、`同意`、`就这样`、`按这个建`（去首尾空白、去掉结尾一个 `。！!？?` 后整句匹配）；取消句为 `取消`、`先不要`。
- M1 脚本无跨轮状态；每个 `@` 回合独立拉起/停止。不做“以此身份开新会话”、知识库、依赖闭包、多密钥、撤销。
- 所有测试 headless；最终跑 `corepack yarn test`、`corepack yarn typecheck`、`corepack yarn check:desktop-variants`，并在 macOS 与 Windows 真机验收。
- 不新增第三方依赖；使用仓库已有依赖与 Node 标准库。

## M1 Boundary（与 §8 的隔离）

| 做 | 不做 |
|---|---|
| 会话创建 + grill-me 访谈 + 确认落盘 | 发布按钮、审查、签名、目录包 |
| 本地包 persona/SKILL.md/HTTP/MCP 脚本 | 广场下载/安装/更新/移除下载包 |
| `@` 运行、启停、本地更新 | 撤销、下架、三 token、审计服务端 |
| 三页签 + catalog-legacy 兼容 | market-server / agent-catalog-server 改动 |

## File Structure

**Create**

| 文件 | 职责 |
|---|---|
| `dsh-plugin-huaanwork/src/huaanwork-host/agent-package/types.ts` | manifest/state/draft/list/detail 类型与常量 |
| `dsh-plugin-huaanwork/src/huaanwork-host/agent-package/manifest.ts` | manifest 解析、字段校验、文件集校验 |
| `dsh-plugin-huaanwork/src/huaanwork-host/agent-package/store.ts` | 包目录、状态、原子写、列表/详情、slug 冲突 |
| `dsh-plugin-huaanwork/src/huaanwork-host/agent-package/drafts.ts` | propose/commit/cancel/update、同意句、幂等 |
| `dsh-plugin-huaanwork/src/huaanwork-host/agent-package/creation.ts` | 入口识别、技能注入、创建工具附件、turn 状态 |
| `dsh-plugin-huaanwork/src/huaanwork-host/agent-package/runtime.ts` | persona 合成、HTTP/MCP 进程、沙箱、工具白名单 |
| `dsh-plugin-huaanwork/src/huaanwork-host/agent-package/host.ts` | 组合 store/drafts/runtime、list/get/setEnabled、catalog-legacy 兼容 |
| `dsh-plugin-huaanwork/src/huaanwork-guardrails/agent-package-tools.ts` | `agent_propose`、`agent_commit`、`agent_skill_run`、`agent_http` |
| `dsh-plugin-huaanwork/src/client-huaanwork/logic/agentPackagesLogic.ts` | 纯函数：筛选、标签、更新提示、错误分类 |
| `dsh-plugin-huaanwork/src/client-huaanwork/AgentPackagesPanel.tsx` | 我的智能体页签 |
| `dsh-plugin-huaanwork/src/client-huaanwork/AgentsPlazaPanel.tsx` | 智能体广场页签 |
| `dsh-plugin-huaanwork/src/client-huaanwork/AgentToolkitPanel.tsx` | 我的工具包页签（含现有 modals） |
| `dsh-plugin-huaanwork/src/client-huaanwork/AgentConfirmCard.tsx` | 宿主生成的结构化确认卡渲染 |
| `dsh-plugin-huaanwork/skills/create-agent/SKILL.md` | 宿主注入的 grill-me 访谈技能 |
| `dsh-plugin-huaanwork/scripts/agent-package-sandbox-probe.mjs` | M1.0 沙箱长驻进程探针 |
| `dsh-plugin-huaanwork/tests/huaanwork-host/agent-package-store.spec.ts` | store/manifest 测试 |
| `dsh-plugin-huaanwork/tests/huaanwork-host/agent-package-drafts.spec.ts` | 草稿/同意/提交测试 |
| `dsh-plugin-huaanwork/tests/huaanwork-host/agent-package-creation.spec.ts` | 入口/技能/工具附件测试 |
| `dsh-plugin-huaanwork/tests/huaanwork-host/agent-package-runtime.spec.ts` | 运行时/沙箱/进程测试 |
| `dsh-plugin-huaanwork/tests/huaanwork-host/agent-package-routes.spec.ts` | 新 RPC 路由测试 |
| `dsh-plugin-huaanwork/tests/huaanwork-guardrails/agent-package-tools.spec.ts` | 四个工具的执行与门禁测试 |
| `dsh-plugin-huaanwork/tests/client-huaanwork/agentPackagesLogic.spec.ts` | 客户端纯函数测试 |
| `dsh-plugin-huaanwork/tests/client-huaanwork/agent-packages-panel.spec.ts` | 面板渲染/动作测试 |
| `dsh-plugin-huaanwork/tests/client-huaanwork/agent-confirm-card.spec.ts` | 结构化确认卡渲染测试 |
| `dsh-plugin-huaanwork/tests/fixtures/agent-package/` | persona、SKILL.md、脚本、HTTP/MCP fixture |
| `docs/evidence/2026-10-23-agent-package-sandbox-probe.md` | M1.0 探针证据 |
| `docs/huaanwork-agent-packages-m1.md` | M1 使用/排障 runbook |

**Modify**

| 文件 | 改动 |
|---|---|
| `dsh-plugin-huaanwork/src/huaanwork-host/holders.ts` | 新增 `huaanworkAgentPackageHost`、`huaanworkAgentPackageRequest` holder |
| `dsh-plugin-huaanwork/src/huaanwork-host/index.ts` | 创建 package host、注册 tools、初始化 catalog-legacy |
| `dsh-plugin-huaanwork/src/huaanwork-host/routes.ts` | 新增 package 路由；`skill.list` 过滤内部技能 |
| `dsh-plugin-huaanwork/src/huaanwork-host/sessions.ts` | 创建入口、技能注入、`@` package 分流 |
| `dsh-plugin-huaanwork/src/huaanwork-host/agent-invoke.ts` | package agent 分支 |
| `dsh-plugin-huaanwork/src/huaanwork-host/skill-invoke.ts` | 强制注入 create-agent |
| `dsh-plugin-huaanwork/src/huaanwork-guardrails/skills.ts` | package request 分支、隐藏内部技能 |
| `dsh-plugin-huaanwork/src/huaanwork-guardrails/agent-attachments.ts` | `isAgentToolAttached` |
| `dsh-plugin-huaanwork/src/huaanwork-guardrails/policy.ts` | package 工具 attached 判定 |
| `dsh-plugin-huaanwork/src/huaanwork-guardrails/present-as.ts` | 无白名单新增；依赖 `sessionAgentTools` + refresh |
| `dsh-plugin-huaanwork/src/client-huaanwork/rpc-types.ts` | RPC 方法、包类型、`agent/changed`、`agent/notice`、`agent/confirm` |
| `dsh-plugin-huaanwork/src/client-huaanwork/api.ts` | 新路由映射 |
| `dsh-plugin-huaanwork/src/client-huaanwork/AgentsView.tsx` | 三页签 shell |
| `dsh-plugin-huaanwork/src/client-huaanwork/AtAgentMenu.tsx` | 显示 displayName |
| `dsh-plugin-huaanwork/src/client-huaanwork/App.tsx` | `agent.invocableList`、`agent/notice`、`agent/changed`、`agent/confirm` |
| `dsh-plugin-huaanwork/src/client-huaanwork/styles.css` | 包卡片/详情的最小样式 |

---

## Task 1: M1.0 可行性 spike（硬门槛）

**Files:**
- Create: `dsh-plugin-huaanwork/scripts/agent-package-sandbox-probe.mjs`
- Create: `docs/evidence/2026-10-23-agent-package-sandbox-probe.md`

**Interfaces:**
- Consumes: `ctx.sandbox.confine(argv, policy, signal)`，`policy = { mode: 'workspace-write', workspaceRoot }`。
- Produces: `sandbox-probe.json` 事实（`httpReady`、`writeDenied`、`readOutside`、`networkOutside`、`enforcement`），以及是否继续 M1 的结论。

- [ ] **Step 1: 写探针脚本**

创建 `dsh-plugin-huaanwork/scripts/agent-package-sandbox-probe.mjs`。脚本做四件事：在临时 workspace 写一个 `server.mjs`；通过 `ctx.sandbox.confine` 包裹 `process.execPath`（Electron 用 `ELECTRON_RUN_AS_NODE=1`）启动长驻 HTTP 服务；请求 `http://127.0.0.1:<port>/health`；记录写越界/读越界/外网的观察结果。上下文 boot 直接复制 `deepseek-harness/packages/shell/bash-sandbox/tests/seatbelt.e2e.ts` 的 provider 装配方式，不要另造沙箱。

```js
// server.mjs 由探针生成在 temp workspace
import { createServer } from 'node:http'
const server = createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200).end('ok'); return }
  res.writeHead(404).end()
})
server.listen(0, '127.0.0.1', () => console.log(`READY ${server.address().port}`))
```

探针必须打印一行 JSON：

```json
{"platform":"darwin","enforcement":"full","httpReady":true,"writeDenied":true,"readOutside":true,"networkOutside":true}
```

- [ ] **Step 2: 在 macOS 跑探针**

Run: `node dsh-plugin-huaanwork/scripts/agent-package-sandbox-probe.mjs --platform darwin`

Expected: `httpReady:true`，`writeDenied:true`，`readOutside:true`，`networkOutside:true`，`enforcement:"full"`。

- [ ] **Step 3: 在 Windows 真机跑探针**

Run: `node dsh-plugin-huaanwork\scripts\agent-package-sandbox-probe.mjs --platform win32`

Expected: `httpReady:true`，`writeDenied:true`，`readOutside:true`，`networkOutside:true`，`enforcement:"partial"`。Windows 必须是真机；没有真机就记录 `BLOCKED`，不能宣布 M1 可开工。

- [ ] **Step 4: 写证据并做 gate 判断**

创建 `docs/evidence/2026-10-23-agent-package-sandbox-probe.md`，记录命令、原始 JSON、日期、机器、`enforcement`、以及“读/网络不隔离”的观察。若长驻进程无法通过 `confine` 启动，写 `BLOCKED`，停止后续任务并回到规格修订；若通过，继续。

- [ ] **Step 5: 提交**

```bash
git add dsh-plugin-huaanwork/scripts/agent-package-sandbox-probe.mjs docs/evidence/2026-10-23-agent-package-sandbox-probe.md
git commit -m "spike: verify sandboxed long-running agent package servers"
```

---

## Task 2: 包 manifest、store、状态与 catalog-legacy

**Files:**
- Create: `dsh-plugin-huaanwork/src/huaanwork-host/agent-package/types.ts`
- Create: `dsh-plugin-huaanwork/src/huaanwork-host/agent-package/manifest.ts`
- Create: `dsh-plugin-huaanwork/src/huaanwork-host/agent-package/store.ts`
- Test: `dsh-plugin-huaanwork/tests/huaanwork-host/agent-package-store.spec.ts`

**Interfaces:**
- Produces: `parseAgentPackageManifest(raw)`, `readAgentPackage(profileDir, slug)`, `listLocalAgentPackages(profileDir)`, `writeAgentPackageAtomically(input: WriteAgentPackageInput): void`, `readAgentPackageState(profileDir)`, `setAgentPackageEnabled(profileDir, slug, enabled)`, `assertAgentPackageSlugFree(profileDir, slug, taken: readonly string[]): void`。
- Consumes: `AGENT_NAME_RE` from `@huaanwork/policy/agent-catalog`；`agents-endpoints.json` 的本地工具名；legacy catalog 名由调用方传入。

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, test } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseAgentPackageManifest } from '../../src/huaanwork-host/agent-package/manifest.ts'
import { listLocalAgentPackages, readAgentPackageState, setAgentPackageEnabled } from '../../src/huaanwork-host/agent-package/store.ts'

const VALID = {
  schemaVersion: 1,
  slug: 'weekly-report',
  displayName: '周报小助手',
  description: '把一周工作整理成周报',
  version: '1.0.0',
  draftId: 'draft-1',
  createdAt: '2026-10-23T00:00:00.000Z',
  updatedAt: '2026-10-23T00:00:00.000Z',
  persona: 'persona.md',
  skill: { entry: 'skill/SKILL.md', summary: '生成周报' },
  tools: { mode: 'none' },
  allowSkills: [],
}

test('rejects bad slug and displayName', () => {
  expect(parseAgentPackageManifest({ ...VALID, slug: 'Bad Slug' }).ok).toBe(false)
  expect(parseAgentPackageManifest({ ...VALID, displayName: '' }).ok).toBe(false)
})

test('rejects selected tool without entry and unselected tool with entry', () => {
  expect(parseAgentPackageManifest({ ...VALID, tools: { mode: 'http' } }).ok).toBe(false)
  expect(parseAgentPackageManifest({ ...VALID, tools: { mode: 'none', http: { entry: 'tools/http/server.mjs' } } }).ok).toBe(false)
})

test('lists a broken card when agent.json is invalid', () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-package-store-'))
  mkdirSync(join(root, 'agents', 'bad'), { recursive: true })
  writeFileSync(join(root, 'agents', 'bad', 'agent.json'), '{"slug":"bad"}')
  const items = listLocalAgentPackages(root)
  expect(items[0]?.broken?.reason).toMatch(/manifest/i)
})

test('enabled defaults false and persists', () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-package-store-'))
  expect(readAgentPackageState(root)['local:weekly-report']?.enabled).toBeUndefined()
  setAgentPackageEnabled(root, 'weekly-report', true)
  expect(readAgentPackageState(root)['local:weekly-report']?.enabled).toBe(true)
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `corepack yarn workspace dsh-plugin-huaanwork test tests/huaanwork-host/agent-package-store.spec.ts`

Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现 types 与 manifest 校验**

`types.ts` 定义并导出：

```ts
export const AGENT_PACKAGE_SCHEMA_VERSION = 1 as const
export type AgentPackageToolsMode = 'none' | 'http' | 'mcp' | 'both'
export type AgentPackageManifest = {
  schemaVersion: typeof AGENT_PACKAGE_SCHEMA_VERSION
  slug: string
  displayName: string
  description: string
  version: string
  draftId: string
  createdAt: string
  updatedAt: string
  persona: 'persona.md'
  skill: { entry: 'skill/SKILL.md'; summary: string } | null
  tools: {
    mode: AgentPackageToolsMode
    http?: { entry: 'tools/http/server.mjs'; argumentsSchema?: unknown }
    mcp?: { entry: 'tools/mcp/server.mjs' }
  }
  allowSkills: string[]
}
export type AgentPackageState = Record<string, { source: 'local'; enabled: boolean; installedVersion: string }>
export type AgentPackageListItem = {
  slug: string
  displayName: string
  description: string
  version: string
  source: 'local' | 'catalog-legacy'
  enabled: boolean
  broken?: { reason: string }
}
export type AgentPackageDetail = AgentPackageListItem & {
  persona: string
  skill: { summary: string; markdown: string; scripts: string[] } | null
  tools: AgentPackageToolsMode
  files: Array<{ path: string; size: number }>
}
export type AgentPackageTurnRuntime = {
  slug: string
  packageDir: string
  workspaceRoot: string
  httpPort?: number
  mcpNames?: string[]
  skillScripts: string[]
  runSkillScript(script: string, args: Record<string, unknown>): Promise<{ text: string; isError?: boolean }>
}
export type AgentPackageSubagentRequest = {
  allow: string[]
  persona: string
  runtime: AgentPackageTurnRuntime
  bindChild(sessionId: string): void
}
export type AgentPackageProposalInput = {
  mode: 'create' | 'update'
  displayName?: string
  slug?: string
  description?: string
  persona?: string
  personaSummary?: string
  skillSummary?: string
  skill?: { summary: string; markdown: string; scripts: Array<{ path: string; content: string }> } | null
  allowSkills?: string[]
  tools?: AgentPackageToolsMode
  httpServer?: string
  mcpServer?: string
}
export type AgentPackageConfirmCard = {
  displayName: string
  slug: string
  description: string
  personaSummary: string
  skillSummary: string
  tools: AgentPackageToolsMode
  toolLabel: string
  warning: string
  consentHint: string
}
```

`manifest.ts` 的 `parseAgentPackageManifest(raw)` 必须逐项校验 slug/displayName/description/version/draftId/persona/skill/tools/allowSkills，并拒绝 `tools.mode` 与入口不一致、未声明文件的额外字段。返回 `{ ok: true; manifest } | { ok: false; fieldErrors: Array<{field:string;message:string}> }`。

- [ ] **Step 4: 实现 store**

`store.ts` 至少实现：

```ts
export function agentPackagesRoot(profileDir: string): string
export function agentPackageDir(profileDir: string, slug: string): string
export function agentPackageStatePath(profileDir: string): string
export function readAgentPackageState(profileDir: string): AgentPackageState
export function writeAgentPackageState(profileDir: string, state: AgentPackageState): void
export function listLocalAgentPackages(profileDir: string): AgentPackageListItem[]
export function readAgentPackage(profileDir: string, slug: string): AgentPackageDetail | undefined
export function writeAgentPackageAtomically(input: {
  profileDir: string
  manifest: AgentPackageManifest
  persona: string
  skill: { markdown: string; scripts: Array<{ path: string; content: string }> } | null
  httpServer?: string
  mcpServer?: string
  replace: boolean
}): void
export function setAgentPackageEnabled(profileDir: string, slug: string, enabled: boolean): void
export function assertAgentPackageSlugFree(profileDir: string, slug: string, taken: readonly string[]): void
```

原子写：写 `agents/.tmp-{slug}-{random}/`，写完全部文件后 rename 到 `agents/{slug}/`；`replace:true` 时先把旧目录 rename 为 `.old-{slug}-{random}`，新目录就位后删旧目录，失败恢复旧目录。启动时清理 `.tmp-*`；正式目录缺失且存在 `.old-*` 时恢复旧目录。状态文件用 `.tmp` + rename。

- [ ] **Step 5: 运行测试并提交**

Run: `corepack yarn workspace dsh-plugin-huaanwork test tests/huaanwork-host/agent-package-store.spec.ts`

Expected: PASS。

```bash
git add dsh-plugin-huaanwork/src/huaanwork-host/agent-package dsh-plugin-huaanwork/tests/huaanwork-host/agent-package-store.spec.ts
git commit -m "feat: add local agent package manifest and store"
```

---

## Task 3: 草稿、propose/commit/cancel、更新与幂等

**Files:**
- Create: `dsh-plugin-huaanwork/src/huaanwork-host/agent-package/drafts.ts`
- Create: `dsh-plugin-huaanwork/src/huaanwork-host/agent-package/host.ts`
- Test: `dsh-plugin-huaanwork/tests/huaanwork-host/agent-package-drafts.spec.ts`

**Interfaces:**
- Consumes: `writeAgentPackageAtomically`, `assertAgentPackageSlugFree`, `parseAgentPackageManifest`。
- Produces: `proposeAgentPackage`, `commitAgentPackage`, `cancelAgentPackage`, `loadAgentPackageDraft`, `isAgentConsentText`, `isAgentCancelText`, `createAgentPackageHost`。
- `AgentPackageHost`（Task 3 基线；Task 6/7 在同一导出类型上追加运行时与 legacy 方法）：

```ts
export type AgentPackageHost = {
  propose(sessionId: string, input: AgentPackageProposalInput): Promise<ProposeResult>
  commit(sessionId: string, draftId: string, rawUserText: string, opts?: { proposedThisTurn?: boolean }): Promise<CommitResult>
  cancel(sessionId: string): Promise<boolean>
  hasDraft(sessionId: string): boolean
  beginUpdate(sessionId: string, slug: string): Promise<void>
  lastUserText(sessionId: string): string | undefined
  listLocal(): AgentPackageListItem[]
  detail(slug: string): AgentPackageDetail | undefined
  setEnabled(slug: string, enabled: boolean): void
}
```

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, test } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { proposeAgentPackage, commitAgentPackage, isAgentConsentText, isAgentCancelText } from '../../src/huaanwork-host/agent-package/drafts.ts'

const proposal = {
  displayName: '周报小助手',
  slug: 'weekly-report',
  description: '把一周工作整理成周报',
  persona: '你是周报助手。',
  personaSummary: '写周报',
  skillSummary: '整理本周工作',
  skill: { summary: '整理本周工作', markdown: '---\nname: weekly-report\ndescription: x\n---\n正文', scripts: [] },
  allowSkills: [],
  tools: 'none' as const,
}

test('consent is exact after trimming one trailing punctuation', () => {
  expect(isAgentConsentText(' 可以。 ')).toBe(true)
  expect(isAgentConsentText('可以，但名字改成周报')).toBe(false)
  expect(isAgentCancelText('先不要！')).toBe(true)
})

test('propose then commit writes a disabled package and deletes the draft', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-package-drafts-'))
  const proposed = await proposeAgentPackage(root, 'session-1', { mode: 'create', ...proposal }, [])
  expect(proposed.ok).toBe(true)
  if (!proposed.ok) return
  const committed = await commitAgentPackage(root, 'session-1', proposed.draftId, '可以', [])
  expect(committed.ok).toBe(true)
  expect(committed.packagePath).toContain('agents/weekly-report')
})

test('same turn propose then commit is rejected', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-package-drafts-'))
  const proposed = await proposeAgentPackage(root, 'session-2', { mode: 'create', ...proposal }, [])
  if (!proposed.ok) throw new Error('propose failed')
  const committed = await commitAgentPackage(root, 'session-2', proposed.draftId, '可以', [], { proposedThisTurn: true })
  expect(committed.ok).toBe(false)
  expect(committed.error).toMatch(/同一轮/)
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `corepack yarn workspace dsh-plugin-huaanwork test tests/huaanwork-host/agent-package-drafts.spec.ts`

Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现草稿与同意/取消**

- 草稿路径 `{profileDir}/agents/.drafts/{sessionId}.json`；`sessionId` 必须是单个路径段，含 `/`、`\`、`..` 直接拒绝。
- `proposeAgentPackage`：`mode:'create'` 要求完整字段；`mode:'update'` 以现有本地包为 base，允许只提交变化字段并合并；生成 `draftId`；校验 slug 冲突、字段上限、脚本路径、入口文件一致性；返回 `{ ok:true; draftId; cardText; card: AgentPackageConfirmCard }` 或 `{ ok:false; fieldErrors }`。`cardText` 必须是宿主生成的原文，`card` 供结构化渲染：

```ts
const toolLabel = { none: '不要', http: 'HTTP', mcp: 'MCP', both: 'HTTP 和 MCP' }[draft.tools]
const card: AgentPackageConfirmCard = {
  displayName: draft.displayName,
  slug: draft.slug,
  description: draft.description,
  personaSummary: draft.personaSummary,
  skillSummary: draft.skillSummary,
  tools: draft.tools,
  toolLabel,
  warning: '脚本将在本机沙箱中运行；沙箱只限制写，读取文件和网络不受限制。',
  consentHint: '回复「可以」创建（默认关闭）；回复「取消」放弃。',
}
const cardText = [
  '请确认是否创建这名智能体：',
  `显示名：${card.displayName}`,
  `@标识：${card.slug}`,
  `能力简介：${card.description}`,
  `人设要点：${card.personaSummary}`,
  `技能包：${card.skillSummary}`,
  `工具：${card.toolLabel}`,
  card.warning,
  card.consentHint,
].join('\n')
```
- `commitAgentPackage`：校验原句是同意、`draftId` 匹配、没有同一轮 propose；写包；新建默认关闭；更新保留启用态并 patch+1；成功后删草稿。相同 `draftId` 且包内 `draftId` 相同则返回已有卡片，不覆盖。host 在 `propose` 成功后记录 `proposedThisTurn`，`commit` 读取并拒绝同轮提交；测试可直接传 `opts.proposedThisTurn`。
- `cancelAgentPackage`：删除草稿。
- `isAgentConsentText`/`isAgentCancelText` 严格按 Global Constraints。

- [ ] **Step 4: 实现 host facade**

`host.ts` 导出 `createAgentPackageHost({ profileDir, takenSlugs, lastUserText })`，把 Task 3 的 draft 函数与本任务之前的 store 组合成 `AgentPackageHost`。`lastUserText` 由 `creation.ts` 的 `noteCreationTurn` 写入；host 只读。`hasDraft` 读草稿文件存在性；`beginUpdate` 读取现有本地包并写入 `mode:'update'` 草稿；`detail` 返回本地包详情；`setEnabled` 写状态。所有写路径结束后发 `agent/changed` 由上层路由负责，host 不直接持有 hub。

- [ ] **Step 5: 运行测试并提交**

Run: `corepack yarn workspace dsh-plugin-huaanwork test tests/huaanwork-host/agent-package-drafts.spec.ts`

Expected: PASS。

```bash
git add dsh-plugin-huaanwork/src/huaanwork-host/agent-package/drafts.ts dsh-plugin-huaanwork/src/huaanwork-host/agent-package/host.ts dsh-plugin-huaanwork/tests/huaanwork-host/agent-package-drafts.spec.ts
git commit -m "feat: add agent package drafts and consent gate"
```

---

## Task 4: 创建入口、create-agent 技能、宿主工具

**Files:**
- Create: `dsh-plugin-huaanwork/skills/create-agent/SKILL.md`
- Create: `dsh-plugin-huaanwork/src/huaanwork-host/agent-package/creation.ts`
- Create: `dsh-plugin-huaanwork/src/huaanwork-guardrails/agent-package-tools.ts`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/sessions.ts`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/holders.ts`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/index.ts`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/routes.ts`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/skill-invoke.ts`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-guardrails/agent-attachments.ts`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-guardrails/policy.ts`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-guardrails/skills.ts`
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/rpc-types.ts`（`agent/notice`、`agent/confirm`）
- Test: `dsh-plugin-huaanwork/tests/huaanwork-host/agent-package-creation.spec.ts`
- Test: `dsh-plugin-huaanwork/tests/huaanwork-guardrails/agent-package-tools.spec.ts`

**Interfaces:**
- Produces: `detectAgentCreationIntent(text)`, `injectCreateAgentSkill(text)`, `attachCreationTools(ctx, sessionId)`, `detachCreationTools(ctx, sessionId)`, `noteCreationTurn(sessionId, rawText)`；holder 的 request 形状复用 Task 2 `types.ts` 的 `AgentPackageSubagentRequest`。
- Consumes: `proposeAgentPackage`/`commitAgentPackage`/`cancelAgentPackage`，`getBundledSkill('create-agent')`，`bundledSkillDir`，`wrapSkillPrompt`，`attachAgentTools`/`detachAgentTools`，`refreshAgentRestrict`。

- [ ] **Step 1: 写 create-agent 技能**

```md
---
name: create-agent
description: 宿主注入的本地智能体创建访谈流程。
disable-model-invocation: true
---

# 创建智能体

你正在帮助用户创建一个本地智能体包。每次只问一个问题，先给出你建议的答案，等用户回答后再继续。

固定顺序：用途 → 显示名与 @ 标识 → 能力简介 → 人设边界 → 技能包 → 工具选择（不要 / 只 HTTP / 只 MCP / 两者都要）。

规则：

- 只通过 `agent_propose` 提交草稿，禁止用终端创建 `agents/` 目录。
- `agent_propose` 返回确认卡后，把宿主生成的确认卡原样贴回会话，不得改写。
- 用户下一轮必须明确回复「可以」「确认」「同意」「就这样」「按这个建」之一；夹带修改不算同意，重新提议。
- 如果已有草稿且用户整句只是上述同意句，直接调用 `agent_commit`，不要再追问。
- 用户回复「取消」或「先不要」时停止；宿主会丢弃草稿。
- 更新模式：用户说“更新 <slug>”时，只提交要改的字段；宿主会合并现有包并 patch+1。
- 脚本会在本机沙箱中运行；沙箱只限制写，读取文件和网络不受限制。不要声称脚本被完全隔离。
```

- [ ] **Step 2: 写入口/技能/工具测试**

```ts
import { describe, expect, test } from 'vitest'
import { detectAgentCreationIntent, injectCreateAgentSkill } from '../../src/huaanwork-host/agent-package/creation.ts'

test('detects canonical phrases and slash command', () => {
  expect(detectAgentCreationIntent('帮我新建一个智能体')?.kind).toBe('create')
  expect(detectAgentCreationIntent('帮我建一个数字员工，专门写周报')?.initialText).toContain('专门写周报')
  expect(detectAgentCreationIntent('/create-agent update weekly-report')?.kind).toBe('update')
  expect(detectAgentCreationIntent('帮我做个助手')).toBeUndefined()
})

test('injects create-agent without requiring skill toggles', () => {
  const text = injectCreateAgentSkill('帮我新建一个智能体')
  expect(text).toContain('# 已启用技能：create-agent')
  expect(text).toContain('只通过 `agent_propose` 提交草稿')
})

test('an active draft turns the next message into a continue turn', () => {
  const text = injectCreateAgentSkill('可以', 'continue')
  expect(text).toContain('# 已启用技能：create-agent')
  expect(text).toContain('用户请求：\n可以')
})
```

- [ ] **Step 3: 实现入口识别与技能注入**

`creation.ts` 实现：

```ts
const CREATE_RE = /^(?:帮我)?(?:新建|创建|建)(?:一个|个)?(?:智能体|数字员工|助手)/
export function detectAgentCreationIntent(text: string):
  | { kind: 'create'; initialText: string }
  | { kind: 'update'; slug: string; initialText: string }
  | undefined
export function injectCreateAgentSkill(text: string, mode?: 'create'|'update'|'continue'): string
```

`injectCreateAgentSkill` 直接从 `getBundledSkill('create-agent')` 取正文与 `bundledSkillDir('create-agent')`，用 `wrapSkillPrompt` 包装，不读 `skill-toggles`。更新模式把 slug 写进提示。

- [ ] **Step 4: 实现宿主持有与工具附件**

在 `holders.ts` 增加：

```ts
huaanworkAgentPackageHost: AgentPackageHost
huaanworkAgentPackageRequest: { current: AgentPackageSubagentRequest | null }
```

在 `agent-attachments.ts` 增加 `isAgentToolAttached(maps, sessionId, toolName)`，复用 `sessionAgentTools`。在 `policy.ts` 中，对 `agent_propose`、`agent_commit`、`agent_skill_run`、`agent_http` 调用 `isAgentToolAttached` 设置 `attached`。

在 `creation.ts` 增加：

```ts
export function attachCreationTools(ctx: CreationContext, sessionId: string): void
export function detachCreationTools(ctx: CreationContext, sessionId: string): void
```

实现用 `attachAgentTools(ctx.huaanworkAttachments, sessionId, ['agent_propose', 'agent_commit'])`，再调用 `refreshAgentRestrict(ctx, sessionId)`；detach 反向。

- [ ] **Step 5: 实现 agent_propose / agent_commit 工具**

在 `agent-package-tools.ts` 用 `defineTool` 注册：

```ts
export const AGENT_PROPOSE_TOOL = 'agent_propose'
export const AGENT_COMMIT_TOOL = 'agent_commit'

export function registerAgentPackageCreationTools(ctx: unknown, host: AgentPackageHost): () => void
```

`agent_propose` 的工具 schema 至少声明这些字段（真实校验在宿主）：

```ts
parameters: {
  mode: { type: 'string', required: true, description: 'create 或 update' },
  displayName: { type: 'string' },
  slug: { type: 'string' },
  description: { type: 'string' },
  persona: { type: 'string' },
  personaSummary: { type: 'string' },
  skillSummary: { type: 'string' },
  skill: { type: 'object', additionalProperties: true },
  allowSkills: { type: 'array' },
  tools: { type: 'string' },
  httpServer: { type: 'string' },
  mcpServer: { type: 'string' },
}
```

execute 调 `host.propose(sessionId, args)`，把 `cardText` 返回给模型，并 `ctx.huaanworkEmit({ event: 'agent/confirm', card, sessionId })`；信息类提示仍用 `agent/notice`。`agent_commit` 的 parameters 只有 `{ draftId: { type: 'string', required: true } }`；execute 调 `host.commit(sessionId, draftId, host.lastUserText(sessionId))`，成功后 emit `agent/notice` 与 `agent/changed`，并 detach。

- [ ] **Step 6: 接入 sessions.ts**

在 `sendToAgent` 的 `skillName`/`atName` 判定之后、`resolveAgent` 之前：

```ts
const host = getAgentPackageHost()
const intent = !skillName && !atName ? detectAgentCreationIntent(text) : undefined
const activeDraft = !skillName && !atName && host.hasDraft(sessionId)
if (intent || activeDraft) {
  noteCreationTurn(sessionId, text)
  if (isAgentCancelText(text) && await host.cancel(sessionId)) {
    routeCtx.emit({ event: 'agent/notice', text: '已取消创建，没有写入智能体。', sessionId })
    return { queued: true, sessionId }
  }
  if (intent?.kind === 'update') await host.beginUpdate(sessionId, intent.slug)
  attachCreationTools(ctx as never, sessionId)
  const mode = intent?.kind ?? 'continue'
  text = injectCreateAgentSkill(intent ? (intent.initialText || text) : text, mode)
}
```

`noteCreationTurn` 把原始用户文本存到 host 的 per-session map，供 `agent_commit` 读取。`afterIdle` 时如果没有草稿则 detach。`sessions.ts` 新增 `setAgentPackageHost`/`getAgentPackageHost`（模式与 `setAgentsDirectory` 相同），由 `index.ts` 注入；测试可注入 fake host。`createAgentPackageHost` 的 `takenSlugs` 回调合并 `agentsHost.list().items.map(i => i.name)` 与 `agents-endpoints.json` 的本地工具名。

- [ ] **Step 7: 注册工具并隐藏内部技能**

在 `index.ts` 的 host apply 里先 `const agentPackageHost = createAgentPackageHost({ profileDir: config.profileDir, takenSlugs, lastUserText })`，`setAgentPackageHost(agentPackageHost)`；再在 tools 子插件里同时 `registerAgentPackageCreationTools(pc, agentPackageHost)` 与 `registerCallHostTool(toolCtx, agentsHost.snapshotForRuntime())`；`toolCtx` 增加 `huaanworkEmit: ctx.huaanworkEmit` 与 `huaanworkAgentPackageHost: agentPackageHost`，供新工具发事件和读写草稿。

- [ ] **Step 8: 隐藏内部技能**

在 `skills.ts` 增加 `INTERNAL_BUNDLED_SKILLS = new Set(['create-agent'])`；`listBundledSkills` 仍返回它用于 `takenNames`，但在 `routes.ts` 的 `skill.list` 组装 `bundled` 时过滤掉内部技能，避免出现在技能中心。

- [ ] **Step 9: 运行测试并提交**

Run: `corepack yarn workspace dsh-plugin-huaanwork test tests/huaanwork-host/agent-package-creation.spec.ts tests/huaanwork-guardrails/agent-package-tools.spec.ts tests/huaanwork-host/sessions.spec.ts`

Expected: PASS。

```bash
git add dsh-plugin-huaanwork/skills/create-agent dsh-plugin-huaanwork/src/huaanwork-host/agent-package/creation.ts dsh-plugin-huaanwork/src/huaanwork-guardrails/agent-package-tools.ts dsh-plugin-huaanwork/src/huaanwork-host/{sessions.ts,holders.ts,index.ts,routes.ts,skill-invoke.ts} dsh-plugin-huaanwork/src/huaanwork-guardrails/{agent-attachments.ts,policy.ts,skills.ts} dsh-plugin-huaanwork/src/client-huaanwork/rpc-types.ts dsh-plugin-huaanwork/tests/huaanwork-host/agent-package-creation.spec.ts dsh-plugin-huaanwork/tests/huaanwork-guardrails/agent-package-tools.spec.ts
git commit -m "feat: add chat-driven agent package creation flow"
```

---

## Task 5: 运行时进程、沙箱与 persona 合成

**Files:**
- Create: `dsh-plugin-huaanwork/src/huaanwork-host/agent-package/runtime.ts`
- Test: `dsh-plugin-huaanwork/tests/huaanwork-host/agent-package-runtime.spec.ts`
- Create: `dsh-plugin-huaanwork/tests/fixtures/agent-package/agent.json`
- Create: `dsh-plugin-huaanwork/tests/fixtures/agent-package/persona.md`
- Create: `dsh-plugin-huaanwork/tests/fixtures/agent-package/skill/SKILL.md`
- Create: `dsh-plugin-huaanwork/tests/fixtures/agent-package/skill/scripts/echo.mjs`
- Create: `dsh-plugin-huaanwork/tests/fixtures/agent-package/tools/http/server.mjs`
- Create: `dsh-plugin-huaanwork/tests/fixtures/agent-package/tools/mcp/server.mjs`

**Interfaces:**
- Produces: `composeAgentPackagePersona`, `composeAgentPackageToolAllowList`, `startAgentPackageProcesses`, `stopAgentPackageProcesses`, `AgentPackageRuntimeRegistry`, `createAgentPackageRuntimeRegistry()`。
复用 Task 2 `types.ts` 的 `AgentPackageTurnRuntime`；registry 的精确形状：

```ts
export type AgentPackageRuntimeRegistry = {
  bind(sessionId: string, runtime: AgentPackageTurnRuntime): void
  get(sessionId: string): AgentPackageTurnRuntime | undefined
  delete(sessionId: string): void
}
```

- Consumes: `ctx.get('sandbox')`、`ctx.get('sandboxPolicy')`、`ctx.subagents.start`、`setAgentPackageRequest`（Task 6 接线）。

- [ ] **Step 1: 写 fixture 与失败测试**

Fixture 包含 `agent.json`、`persona.md`、`skill/SKILL.md`、`skill/scripts/echo.mjs`、`tools/http/server.mjs`、`tools/mcp/server.mjs`。HTTP server 监听 `AGENT_HTTP_PORT`，`POST /invoke` 返回 `{ok:true,result:{echo:arguments}}`。MCP server 监听 `AGENT_MCP_PORT`，`/mcp` 返回一个 `echo` 工具（用最小 streamable HTTP 实现或已有测试桩）。测试文件补 `readFileSync`、`mkdtempSync`、`tmpdir`、`join` imports。

```ts
test('composes persona and tool allow list', async () => {
  const manifest = JSON.parse(readFileSync(join(pkgDir, 'agent.json'), 'utf8'))
  const profileDir = mkdtempSync(join(tmpdir(), 'agent-package-profile-'))
  const persona = composeAgentPackagePersona(pkgDir, manifest, profileDir)
  expect(persona).toContain('你是周报助手')
  expect(persona).toContain('SKILL.md 正文')
  const shell = process.platform === 'win32' ? 'pwsh' : 'bash'
  expect(composeAgentPackageToolAllowList(manifest, ['mcp__demo__echo'])).toEqual(
    expect.arrayContaining(['read', 'read_file', 'glob', 'grep', shell, 'agent_skill_run', 'agent_http', 'mcp__demo__echo']),
  )
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `corepack yarn workspace dsh-plugin-huaanwork test tests/huaanwork-host/agent-package-runtime.spec.ts`

Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现 persona 合成与工具白名单**

`composeAgentPackagePersona(packageDir, manifest, profileDir)`：读 `persona.md` + `skill/SKILL.md` + `allowSkills` 正文（用 `resolveInvocableSkill(profileDir, name)` 读取；它已执行内置技能启用校验，缺失/未启用抛错），合并 UTF-8 ≤ 64 KiB；缺文件抛带 slug 的错误。`composeAgentPackageToolAllowList(manifest, mcpNames)`：基础 `read/read_file/glob/grep` + 平台 shell；有脚本加 `agent_skill_run`；HTTP 加 `agent_http`；MCP 加 `mountSessionMcp` 返回的名字。不经过 `filterAgentAllow`。

- [ ] **Step 4: 实现沙箱进程启动**

```ts
type SandboxLike = {
  confine(argv: readonly string[], policy: { mode: 'workspace-write'; workspaceRoot: string }, signal?: AbortSignal): Promise<{
    argv: readonly string[]
    enforcement: 'full' | 'partial'
  }>
}
```

实现 `spawnConfined(scriptPath, env, workspaceRoot)`：取 `ctx.get('sandbox')`；缺失或 `SANDBOX_UNAVAILABLE` 抛 `当前系统无法启动沙箱，智能体未运行`；`confine([process.execPath, scriptPath], {mode:'workspace-write', workspaceRoot}, signal)`；`spawn(prepared.argv[0], prepared.argv.slice(1), { cwd: workspaceRoot, env: allowlist, stdio: ['ignore','pipe','pipe'] })`。若 `process.execPath` 是 Electron，env 加 `ELECTRON_RUN_AS_NODE=1`（Task 1 已验证）；env 只允许 `PATH/PATHEXT/SystemRoot/TEMP/TMPDIR/AGENT_*` 与该开关；不传 token/密钥/`HUAANWORK_*`。

- [ ] **Step 5: 实现 HTTP/MCP 启动、健康检查与停止**

- 选回环空闲端口；最多 3 次重试。
- HTTP 健康：5 秒内 TCP 连接成功；MCP 健康：5 秒内连接且 `mountSessionMcp` 至少返回一个工具。
- 两者都选时任一失败停掉另一个并抛错。
- 停止：`SIGTERM` → 2 秒后 `SIGKILL`；POSIX 用进程组，Windows 用 `taskkill /pid <pid> /T /F`；应用退出时统一清理。
- 提前退出：stderr 前 500 字符写进错误。
- 返回的 `AgentPackageTurnRuntime` 同时提供 `runSkillScript`：校验声明脚本、创建 `AGENT_STATE_DIR`、调用 `spawnConfined`、截断输出；没有脚本时返回明确错误。

- [ ] **Step 6: 运行测试并提交**

Run: `corepack yarn workspace dsh-plugin-huaanwork test tests/huaanwork-host/agent-package-runtime.spec.ts`

Expected: PASS（真实沙箱测试按平台可用性跳过时，必须用 fake `confine` 覆盖生命周期；真实沙箱事实由 Task 1 证据覆盖）。

```bash
git add dsh-plugin-huaanwork/src/huaanwork-host/agent-package/runtime.ts dsh-plugin-huaanwork/tests/huaanwork-host/agent-package-runtime.spec.ts dsh-plugin-huaanwork/tests/fixtures/agent-package
git commit -m "feat: run agent package HTTP and MCP servers in the sandbox"
```

---

## Task 6: `agent_skill_run` / `agent_http` / MCP 工具合成与 `@` 分发

**Files:**
- Create: `dsh-plugin-huaanwork/src/huaanwork-guardrails/agent-package-tools.ts`（在 Task 4 文件上追加两个工具）
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/agent-package/runtime.ts`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/agent-invoke.ts`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/sessions.ts`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-guardrails/skills.ts`
- Test: `dsh-plugin-huaanwork/tests/huaanwork-guardrails/agent-package-tools.spec.ts`
- Test: `dsh-plugin-huaanwork/tests/huaanwork-host/agent-package-runtime.spec.ts`（追加）

**Interfaces:**
- Produces: `agent_skill_run`, `agent_http` 工具；`registerAgentPackageRuntimeTools(ctx, registry): () => void`；`AgentPackageRuntimeRegistry` 的使用。
- Consumes: Task 5 的 `startAgentPackageProcesses`/`stopAgentPackageProcesses`、`composeAgentPackagePersona`、`composeAgentPackageToolAllowList`。

- [ ] **Step 1: 写失败测试**

覆盖：`agent_skill_run` 拒绝声明外脚本；正确传 `AGENT_SCRIPT_ARGS` 并截断输出；`agent_http` 解析 `{ok:true,result}`/`{ok:false,error}`、超时、32 KiB 截断；MCP 空工具本轮失败；`@slug` 的 persona 含 SKILL.md；工具名单含 `agent_http`，且不含 `call_host_tool`；allow 含不存在工具名时被与 `tools.schemas()` 的交集过滤（与 skills.ts 既有行为一致）；afterIdle 停止进程。

- [ ] **Step 2: 实现 `agent_skill_run`**

参数 `{ script: string; args?: Record<string, unknown> }`。工具的 `exec.agent` 用 `sessionIdOfAgentRef` 解析子会话，缺失时回落 `currentCallerSession()`；用该 id 查 `AgentPackageRuntimeRegistry` 后调用 `runtime.runSkillScript(script, args)`。`runSkillScript` 在 runtime 内用 `listAgentPackageSkillScripts(packageDir)` 枚举的 `skill/scripts/**` 精确匹配 `script`（manifest 的 `skill` 只有 `entry`/`summary`，脚本声明来自包目录），`realpath` 复检在 `skill/scripts/` 下；`spawnConfined(scriptPath, { AGENT_SCRIPT_ARGS: JSON.stringify(args), AGENT_WORKSPACE: workspaceRoot, AGENT_STATE_DIR: tempDir }, workspaceRoot)`；`AGENT_STATE_DIR` 用 `mkdtemp` 创建、回合 afterIdle 删除，M1 无跨轮状态；输出 32 KiB 截断；非 0 退出返回 stderr 前 500 字符。

- [ ] **Step 3: 实现 `agent_http`**

参数 `{ arguments?: Record<string, unknown> }`。用 `exec.agent` 的 `sessionIdOfAgentRef` 解析子会话（缺失时回落 `currentCallerSession()`），从 `AgentPackageRuntimeRegistry` 取该会话的 `httpPort`；POST `http://127.0.0.1:<port>/invoke`，body `JSON.stringify({ arguments: args.arguments ?? {} })`；超时 60s/硬顶 150s；响应读入 ≤1 MiB、输出 ≤32 KiB；`{ok:false,error}` 返回 `isError`，`{ok:true,result}` 返回 `result`。

- [ ] **Step 4: 在 skills.ts 接入 package subagent request**

先在 `skills.ts` 的 `Context` 类型加 `huaanworkAgentPackageRequest?: { current?: AgentPackageSubagentRequest }` 与 `huaanworkAttachments?: AttachmentMaps`，再在 `subagents.start` 包装里增加：

```ts
const pkg = ctx.huaanworkAgentPackageRequest?.current
const parentFromCall = sessionIdOf(parentFromStartArgs(args)) ?? currentCallerSession()
const run: any = await startParent.run(parentFromCall, () => original(...args))
if (pkg && run?.localAgent) {
  const childSessionId = sessionIdOf(run.localAgent.session?.header ?? run.localAgent)
  if (childSessionId) {
    attachAgentTools(ctx.huaanworkAttachments, childSessionId, ['agent_http', 'agent_skill_run'])
    refreshAgentRestrict(ctx as never, childSessionId)
    pkg.bindChild(childSessionId)
  }
  const tools = run.localAgent.ctx?.get?.('tools')
  const schemas = tools?.schemas?.() ?? []
  const existing = schemas.flatMap((s: { name?: string }) => s.name ? [s.name] : [])
  const allow = pkg.allow.filter((name) => existing.includes(name))
  tools?.restrict?.({ allow })
}
```

在 `finally` 清空 `ctx.huaanworkAgentPackageRequest.current`。

- [ ] **Step 5: 接入 `agent-invoke.ts` 与 `sessions.ts`**

`dispatchAt` 增加可选 `packageHost` 与 `packageRuntime`。在 `item.kind === 'agent'` 分支之前：

```ts
const pkg = packageHost?.findInvocable(name)
if (pkg) return packageRuntime.dispatch({ ctx, sessionId, pkg, remainder, resolveParent })
```

`packageRuntime.dispatch`：校验 enabled/broken；合成 persona/allow；按需启动 HTTP/MCP；设置 `huaanworkAgentPackageRequest.current = { allow, persona, runtime, bindChild: (id) => registry.bind(id, runtime) }` 并 `registry.bind(sessionId, runtime)`（父会话，供工具在缺少 child id 时回落）；调用 `ctx.subagents.start('spawn', { prompt, persona, parent, signal })`；返回 `{ text, afterIdle }`，afterIdle 停进程并清 holder。`sessions.ts` 把 package host/runtime 传给 `dispatchAt`，并在 `session.send` 的 `atName` 分支保持原逻辑。Task 6 在 `host.ts` 的 `AgentPackageHost` 导出类型上追加 `findInvocable(slug): Promise<AgentPackageDetail | undefined>` 与 `dispatch(input): Promise<{ text: string; afterIdle: () => Promise<void> }>`，并给 `createAgentPackageHost` 增加 `registry` 与 `createRuntime` 依赖。在 `index.ts` 创建 `const registry = createAgentPackageRuntimeRegistry()`，传给 package host/runtime 与 tools 子插件；在 tools 子插件里 `registerAgentPackageRuntimeTools(pc, registry)`；这两个工具全局注册，靠 `sessionAgentTools` 附件可见。

- [ ] **Step 6: 运行测试并提交**

Run: `corepack yarn workspace dsh-plugin-huaanwork test tests/huaanwork-guardrails/agent-package-tools.spec.ts tests/huaanwork-host/agent-package-runtime.spec.ts`

Expected: PASS。

```bash
git add dsh-plugin-huaanwork/src/huaanwork-guardrails/agent-package-tools.ts dsh-plugin-huaanwork/src/huaanwork-host/agent-package/runtime.ts dsh-plugin-huaanwork/src/huaanwork-host/{agent-invoke.ts,sessions.ts} dsh-plugin-huaanwork/src/huaanwork-guardrails/skills.ts dsh-plugin-huaanwork/tests
git commit -m "feat: invoke local agent packages with HTTP, MCP, and skill scripts"
```

---

## Task 7: Host 路由、RPC 类型与客户端 API

**Files:**
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/routes.ts`
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/rpc-types.ts`
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/api.ts`
- Modify: `dsh-plugin-huaanwork/tests/client-huaanwork/api.spec.ts`
- Modify: `dsh-plugin-huaanwork/tests/huaanwork-host/route-contract.spec.ts`
- Test: `dsh-plugin-huaanwork/tests/huaanwork-host/agent-package-routes.spec.ts`

**Interfaces:**
- Produces RPC：`agent.packageList`、`agent.packageDetail`、`agent.packageSetEnabled`、`agent.invocableList`。
- Produces event：`{ event: 'agent/changed'; slug?: string }`、`{ event: 'agent/notice'; text: string; sessionId?: string }`、`{ event: 'agent/confirm'; card: AgentPackageConfirmCard; sessionId?: string }`。
- Consumes: `getAgentPackageHost()`、`getAgentsDirectory()`。

- [ ] **Step 1: 写失败的路由测试**

覆盖：`agent.packageList` 返回本地包 + catalog agents + catalogError；`agent.packageDetail` 返回本地包详情；`agent.packageSetEnabled` 写状态；`agent.invocableList` 只返回已启用包/legacy/工具；未知 slug 400。

- [ ] **Step 2: 实现路由**

在 `ROUTE_TABLE` 增加：

```ts
{ method: 'agent.packageList', http: 'GET', path: '/huaanwork/agent/package/list', handler: storeRoute(async () => getAgentPackageHost().listWithLegacy()) },
{ method: 'agent.packageDetail', http: 'GET', path: '/huaanwork/agent/package/detail', handler: storeRoute(async (req) => {
  const slug = queryParam(req, 'slug') ?? ''
  return getAgentPackageHost().detail(slug) ?? (await getAgentsDirectory().get(slug)) ?? null
}) },
{ method: 'agent.packageSetEnabled', http: 'POST', path: '/huaanwork/agent/package/setEnabled', handler: storeRoute(async (req, ctx) => {
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
    throw new RouteError(400, 'bad-request', 'agent.packageSetEnabled requires object body')
  }
  const body = req.body as Record<string, unknown>
  const slug = typeof body.slug === 'string' ? body.slug : ''
  if (!slug) throw new RouteError(400, 'bad-request', 'agent.packageSetEnabled requires params.slug')
  const enabled = body.enabled === true
  const isLocalPackage = getAgentPackageHost().listLocal().some((pkg) => pkg.slug === slug)
  if (isLocalPackage) {
    getAgentPackageHost().setEnabled(slug, enabled)
  } else {
    getAgentsDirectory().setEnabled(slug, enabled, true)
  }
  ctx.emit({ event: 'agent/changed', slug })
  return { ok: true }
}) },
{ method: 'agent.invocableList', http: 'GET', path: '/huaanwork/agent/invocable', handler: storeRoute(async () => getAgentPackageHost().invocableWithLegacy()) },
```

Task 7 在 `host.ts` 的 `AgentPackageHost` 导出类型上追加 `listWithLegacy(): Promise<AgentPackageListResult>` 与 `invocableWithLegacy(): Promise<{ items: AgentListItem[] }>`。本地包判断用 `listLocal()`（含 broken），不要用 `detail()`，否则损坏 manifest 会误走 legacy 分支。

`listWithLegacy` 返回 `{ packages, catalogAgents, catalogError }`；`invocableWithLegacy` 返回 `{ items }`，把本地包映射成 `AgentListItem`（`source:'local'`, `kind:'agent'`, `name:slug`, `displayName`, `description`, `version`, `permissions:[]`, `enabled`, `broken`）。`packageSetEnabled` 对本地包写 state，对 catalog-legacy 调 `agentsHost.setEnabled(name, enabled, true)`；两个分支成功后都 `routeCtx.emit({ event: 'agent/changed', slug })`。`packageDetail` 先查本地包，找不到再回退 `agentsHost.get(slug)`。

- [ ] **Step 3: 加 RPC 类型与客户端路由**

在 `rpc-types.ts` 的 `RpcRequest.method` 加四个方法；定义以下类型，`AgentListItem` 加 `displayName?: string`，`RpcEvent` 加 `agent/changed`、`agent/notice` 与 `agent/confirm`：

```ts
export type AgentPackageListResult = {
  packages: AgentPackageListItem[]
  catalogAgents: AgentListItem[]
  catalogError?: string
}
export type AgentPackageDetailResult = AgentPackageDetail | AgentDetail
```

`api.ts` 的 `ROUTES` 加四个映射；GET `detail` 用 `objectQuery`。`AgentPackageDetail` 是本地包；legacy 走 `AgentDetail`，客户端按 `source` 收窄。`rpc-types.ts` 的包类型与 host `types.ts` 保持字段一致；客户端不从 host 导入。

- [ ] **Step 4: 更新 58→62 的 RPC 计数与期望表**

`tests/client-huaanwork/api.spec.ts` 的 `EXPECTED_ROUTES` 增加四行、测试标题「全表 58 项」改 62、`expect(Object.keys(ROUTES)).toHaveLength(62)`；`tests/huaanwork-host/route-contract.spec.ts` 的**全部 7 处** `58` 改为 `62`（:8、:64、:67 注释；:333、:342 测试标题；:337、:338 断言），不要只改两处；`api.ts` 头注释 `58 方法` 改为 `62 方法`。四行必须是：

```ts
'agent.packageList': { http: 'GET', path: '/huaanwork/agent/package/list' },
'agent.packageDetail': { http: 'GET', path: '/huaanwork/agent/package/detail' },
'agent.packageSetEnabled': { http: 'POST', path: '/huaanwork/agent/package/setEnabled' },
'agent.invocableList': { http: 'GET', path: '/huaanwork/agent/invocable' },
```

- [ ] **Step 5: 运行测试并提交**

Run: `corepack yarn workspace dsh-plugin-huaanwork test tests/huaanwork-host/agent-package-routes.spec.ts tests/client-huaanwork/api.spec.ts tests/huaanwork-host/route-contract.spec.ts`

Expected: PASS。

```bash
git add dsh-plugin-huaanwork/src/huaanwork-host/routes.ts dsh-plugin-huaanwork/src/client-huaanwork/{rpc-types.ts,api.ts} dsh-plugin-huaanwork/tests/huaanwork-host/agent-package-routes.spec.ts dsh-plugin-huaanwork/tests/client-huaanwork/api.spec.ts dsh-plugin-huaanwork/tests/huaanwork-host/route-contract.spec.ts
git commit -m "feat: expose agent package RPCs"
```

---

## Task 8: AgentsView 三页签与客户端交互

**Files:**
- Create: `dsh-plugin-huaanwork/src/client-huaanwork/logic/agentPackagesLogic.ts`
- Create: `dsh-plugin-huaanwork/src/client-huaanwork/AgentPackagesPanel.tsx`
- Create: `dsh-plugin-huaanwork/src/client-huaanwork/AgentsPlazaPanel.tsx`
- Create: `dsh-plugin-huaanwork/src/client-huaanwork/AgentToolkitPanel.tsx`
- Create: `dsh-plugin-huaanwork/src/client-huaanwork/AgentConfirmCard.tsx`
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/AgentsView.tsx`
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/AtAgentMenu.tsx`
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/App.tsx`
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/styles.css`
- Test: `dsh-plugin-huaanwork/tests/client-huaanwork/agentPackagesLogic.spec.ts`
- Test: `dsh-plugin-huaanwork/tests/client-huaanwork/agent-packages-panel.spec.ts`
- Test: `dsh-plugin-huaanwork/tests/client-huaanwork/agent-confirm-card.spec.ts`

**Interfaces:**
- Consumes：Task 7 RPCs、`agent.setEnabled`、`agent.list`、`agent.refresh`、`onSidecarEvent`。
- Produces：三页签 UI、卡片动作、空态、`AgentConfirmCard` 结构化确认卡、`agent/notice` 信息提示、`@` 补全刷新。

- [ ] **Step 1: 写纯函数测试**

```ts
import { describe, expect, test } from 'vitest'
import { filterPackageTab, packageSourceLabel, updateHintFor } from '../../src/client-huaanwork/logic/agentPackagesLogic.ts'

test('package source labels', () => {
  expect(packageSourceLabel('local')).toBe('本地创建')
  expect(packageSourceLabel('catalog-legacy')).toBe('旧目录智能体')
})

test('update hint uses the slug', () => {
  expect(updateHintFor('weekly-report')).toContain('/create-agent update weekly-report')
})
```

- [ ] **Step 2: 实现纯函数与面板**

`AgentsView.tsx` 只保留页面头、公用机配置栏、搜索、三页签切换和刷新；`TABS = [{id:'plaza', label:'智能体广场'}, {id:'mine', label:'我的智能体'}, {id:'tools', label:'我的工具包'}]`。

`AgentsPlazaPanel`：从 `agent.packageList` 的 `catalogAgents` 取 `kind:'agent'`；卡片显示名称/简介/版本/“公用机”；动作只有“查看详情”和启用/关闭（走 `agent.setEnabled`）；工具条目不在本页签。

`AgentPackagesPanel`：从 `agent.packageList` 的 `packages` + `catalogAgents.filter(a => a.kind === 'agent' && a.enabled)` 取卡片；本地卡片显示“本地创建”、版本、启用/关闭、详情、更新提示；catalog-legacy 卡片显示“旧目录智能体”。没有发布/下载/移除按钮。订阅 `agent/changed` 重拉。详情固定显示：**“脚本在本机沙箱中运行；沙箱只限制写，读取文件和网络不受限制。”**

空态文案：广场 `暂无可用智能体；请先配置公用机目录。`；我的智能体 `还没有智能体。在会话里说「帮我新建一个智能体」即可创建。`；我的工具包沿用现有本地入口空态。

`AgentToolkitPanel`：从 `agent.list` 取 `kind:'tool'`，按 `source` 分组；本地工具保留添加/删除；公用机工具保留启用/禁用。把现有 `EnableConfirmModal` 与 `AddEndpointModal` 移到该文件。`AddEndpointModal` 的 `takenNames` 必须并入 `agent.packageList` 的本地包 slug 与 catalog agents，避免新增工具与包重名。

`AtAgentMenu`：名称用 `a.displayName ?? a.name`，副标题保留 `@slug`。

`App.tsx` 的 `ChatItem` 联合加 `{ id: number; kind: 'agent-confirm'; card: AgentPackageConfirmCard }`；`ChatRow` 渲染 `<AgentConfirmCard card={item.card} />`，标题为「请确认是否创建这名智能体」，rows 显示名称/slug/简介/人设/技能/工具，底部固定 warning 与 consentHint。`App.tsx` 把 `agent.list` 的 at 补全数据源改为 `agent.invocableList`；在 `applyEvent` 中处理 `agent/changed`（重拉 `agent.invocableList`）、`agent/notice`（用 `noteTab(liveChatRef.current, event.text)` 追加 note）与 `agent/confirm`（把 kind `agent-confirm` 的 item 追加到 `liveChatRef.current`）。

- [ ] **Step 3: 写面板渲染测试**

按 `tests/client-huaanwork/market-view.spec.ts` 的 `createRoot + act` 形态：mock `rpcCall`，渲染 `AgentPackagesPanel`，断言显示名/简介/slug/启用按钮；点击启用调用 `agent.packageSetEnabled`；空态文案正确；没有发布按钮。再渲染 `AgentConfirmCard`，断言显示名、slug、warning、consentHint 都在，且没有可点击的「创建」按钮（创建只由用户在会话里回复同意句触发）。

- [ ] **Step 4: 运行测试并提交**

Run: `corepack yarn workspace dsh-plugin-huaanwork test tests/client-huaanwork/agentPackagesLogic.spec.ts tests/client-huaanwork/agent-packages-panel.spec.ts`

Expected: PASS。

```bash
git add dsh-plugin-huaanwork/src/client-huaanwork dsh-plugin-huaanwork/tests/client-huaanwork/agentPackagesLogic.spec.ts dsh-plugin-huaanwork/tests/client-huaanwork/agent-packages-panel.spec.ts dsh-plugin-huaanwork/tests/client-huaanwork/agent-confirm-card.spec.ts
git commit -m "feat: add three-tab agent package UI"
```

---

## Task 9: 硬化、兼容验收、双平台与 runbook

**Files:**
- Create: `docs/huaanwork-agent-packages-m1.md`
- Modify: `dsh-plugin-huaanwork/tests/huaanwork-host/agent-package-creation.spec.ts`
- Modify: `dsh-plugin-huaanwork/tests/huaanwork-host/agent-package-runtime.spec.ts`
- Modify: `dsh-plugin-huaanwork/tests/client-huaanwork/agent-packages-panel.spec.ts`

- [ ] **Step 1: 补 catalog-legacy 兼容测试**

Seed `agents-enabled.json` 为 `{ "catalog:legacy-assistant": true }`，catalog server 返回同名 persona 条目；断言 `agent.packageList` 把它放进 `catalogAgents` 且 enabled；`agent.packageSetEnabled` 能关闭；没有创建 `agents/legacy-assistant/`。目录不可达时保留旧启用态并显示 catalogError。

- [ ] **Step 2: 补安全/失败负例**

覆盖：slug 与本地工具冲突；会话 id 含 `../`；声明外脚本；入口文件缺失；沙箱不可用 fail-closed；HTTP 进程提前退出；MCP 空工具；afterIdle 后无残留进程；取消后草稿删除；重复 commit 不覆盖。

- [ ] **Step 3: 跑全量门禁**

Run:

```bash
corepack yarn workspace dsh-plugin-huaanwork test
corepack yarn workspace dsh-plugin-huaanwork typecheck
corepack yarn check:desktop-variants
corepack yarn check
```

Expected: 全绿；`check:desktop-variants` 不新增白名单。若 `check` 的 `verify:aa` 并发冲突，按仓库既有债务表记录并单独重跑该工作区，不能用跳过掩盖。

- [ ] **Step 4: macOS 真机验收**

在 macOS 上：说“帮我新建一个智能体”完成访谈 → 确认 → 我的智能体出现卡片（默认关闭）→ 启用 → `@slug` 运行 persona/SKILL → 创建带 HTTP 的 fixture 智能体 → `@` 调用 `agent_http` → 关闭 → 确认进程停止 → `/create-agent update <slug>` 更新版本 → 重启应用后卡片和状态仍在 → 旧 catalog-legacy 条目可见且可关闭。

- [ ] **Step 5: Windows 真机验收**

在 Windows 上重复 Step 4；记录 `enforcement:partial`、读/网络不隔离的观察、安装/退出后的进程清理；没有 Windows 真机则把 M1 标为 `BLOCKED`，不得宣布完成。

2026-10-24 后续裁定：本步的验收面改为 workflow_dispatch 的 GHA Windows 探针。job 退出码 0 才记为 `PASS（GHA Windows 探针）`；第一次 dispatch 未通过。GUI 访谈、确认卡与真实模型 `@slug` 改为可选项。现行说明见 `docs/huaanwork-agent-packages-m1.md` §11。上面这段是计划原文。

- [ ] **Step 6: 写 runbook**

`docs/huaanwork-agent-packages-m1.md` 写明：包目录位置、创建/更新/启停步骤、字段/大小上限、沙箱边界的原话、catalog-legacy 的含义、常见错误（沙箱不可用、slug 冲突、脚本启动失败）、日志位置、如何清理残留 `.tmp-*`/`.old-*`、如何验证 M1 不包含发布。

- [ ] **Step 7: 提交**

```bash
git add docs/huaanwork-agent-packages-m1.md dsh-plugin-huaanwork/tests
git commit -m "test: harden agent package M1 and document operations"
```

---

## Self-Review

**Spec coverage（M1）**

| 规格要求 | 任务 |
|---|---|
| M1.0 沙箱长驻进程 spike | Task 1 |
| 包 manifest、原子写、状态、slug 唯一 | Task 2 |
| 草稿/propose/commit/cancel/更新/默认关闭 | Task 3 |
| 会话入口、grill-me 技能、确认卡、宿主门禁 | Task 4 |
| persona/SKILL/allowSkills 注入、HTTP/MCP 沙箱运行时 | Task 5 |
| `agent_skill_run`/`agent_http`/MCP 与 `@` 分发 | Task 6 |
| 三页签、卡片、启停、catalog-legacy | Task 7、8 |
| macOS/Windows 验收、catalog-legacy 兼容、安全负例 | Task 9 |
| 发布/下载/签名/撤销 | 明确不做（M2） |

**Placeholder scan:** 已检查 `TODO/TBD/待定/FIXME`；本计划不含占位步骤。Task 1 的 provider 装配明确要求复制现有 e2e 测试的 boot 方式，不重新发明沙箱。

**Type consistency:** `AgentPackageManifest`、`AgentPackageListItem`、`AgentPackageDetail`、`AgentPackageListResult`、`AgentPackageConfirmCard`、`AgentPackageHost` 在 Task 2/3/6/7/8 中同名；工具名为 `agent_propose`、`agent_commit`、`agent_skill_run`、`agent_http`；RPC 为 `agent.packageList`、`agent.packageDetail`、`agent.packageSetEnabled`、`agent.invocableList`；事件为 `agent/changed`、`agent/notice`、`agent/confirm`。

## Review Disposition（2026-10-23）

| 审阅项 | 处置 |
|---|---|
| P0-1 事件命名 | 全部统一为 `agent/changed`；规格 §6.3、§9.2 同步 |
| P0-2 58→62 | Task 7 明确更新 `api.spec.ts`、`route-contract.spec.ts`（7 处）与 `api.ts` 注释；补四行期望表 |
| P0-3 catalog-legacy 状态位置 | 采纳计划：legacy 走旧 `agents-enabled.json`；规格移除 `agents-state.json` 的 legacy 示例并改“旧路径独占读写” |
| P1-1 确认卡 | 采用结构化卡：`AgentPackageConfirmCard` + `AgentConfirmCard.tsx` + `agent/confirm`；不再用纯文本 note 代替 |
| P1-2 restrict 交集 | 与 `tools.schemas()` 求交集后再 `restrict`，镜像 `skills.ts` 既有实现 |
| P1-3 persona 签名 | 测试与实现统一为 `(packageDir, manifest, profileDir)` |
| P1-4 “迁移”措辞 | 计划标题与规格 M1 测试矩阵/里程碑改为“兼容” |
| R2 UI “未明示” | 不采纳：用户已明确选择 AgentsView 三页签，规格 R5 记录；其余 R2 结论保留 |
| 二轮 N-1 route-contract 的 58 | 采纳：`route-contract.spec.ts` 全部 7 处改 62，不只两处 |
| 二轮 N-2a ChatRow 不存在 | 不采纳：`ChatRow` 存在于 `dsh-plugin-huaanwork/src/client-huaanwork/App.tsx:3344` 且在 `:2591` 使用；计划引用正确 |
| 二轮 N-2b M1.4 “迁移验收” | 采纳：规格 M1.4 与计划 Task 9 标题都改为“兼容验收” |
