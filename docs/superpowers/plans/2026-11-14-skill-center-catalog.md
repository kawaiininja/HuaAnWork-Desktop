# 技能中心双标签与内网共享流转 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 将现有四标签技能页收敛为“技能中心 / 我的技能”，建立内网共享技能的上传即发布与下载副本机制，并让所有本地技能受真实启用门控制。

**Architecture:** 技能中心由应用内置技能和独立 `/v1/skills` 内网目录组成；我的技能是当前 Profile 下的独立副本。共享包格式由 `@huaanwork/skill-format` 统一定义，服务端以 owner + revision 管理发布，桌面 Host 负责安全下载、上传和显式 `/` 执行门，客户端只消费投影状态。

**Tech Stack:** TypeScript、React、Node.js、Cordis Profile、Vitest、node:test、node-tar、现有 `agent-catalog-server` HTTP/审计基础设施。

**Spec:** `docs/superpowers/specs/2026-11-14-skill-center-catalog-design.md`

## Global Constraints

- 上游 `deepseek-harness/` 子模块零修改；所有桌面行为改动落在 HuaAnWork 自有代码与 Profile 组合层。
- 使用 Node.js `^22.19.0 || >=24.0.0` 与 root Yarn `4.18.0`，通过 Corepack 执行仓库命令。
- 页面只保留“技能中心、我的技能”；外部技能只能显式导入后启用。
- 上传即发布，不引入审核、智能体包签名、keyring、下架或撤销流程。
- 下载和上传都是快照复制；中心与本地互不移动、互不自动覆盖。
- 启用状态只属于本机；新创建、导入、下载默认未启用，存量迁移保留既有可用性。
- 我的技能启用后即可 `/` 调用；不暴露“禁止用户手动调用”选项，`user-invocable: false` 不作为手动调用禁用依据；创建不写该键，导入/编辑保留既有 frontmatter。
- 新共享包必须进入 root workspace 布局门禁、桌面 devDependencies `"*"`、tsdown 内联、bundled runtime marker 与许可证第一方登记；服务端使用 `workspace:*` 依赖。
- 路由总数按任务推进：72 → 75（Task 6）→ 76（Task 7）→ 77（Task 8）→ 77（Task 9 删 skill.list、增 skill.duplicate）；设置必选键 13 → 14。
- 技能审计复用 `slug=name`、`version=String(revision)`；`secretList` 包含全部技能上传 token；技能路由按 `route.audit` 全路径分流。
- 内置同名本地副本通过“另存为新技能”复制完整资源后再上传；preset 隔离本轮只覆盖全局 `~/.agents/skills`。
- 共享归档 `.tar.gz` 上限 5 MiB，文件内容总量上限 5 MiB，条目上限 256，路径上限 512 UTF-8 字节。
- `SKILL.md` 正文上限 64 KiB，描述上限 1024 字符，名称上限 64 字符且为 kebab-case。
- read 请求复用 `agents_host/agents_port/agents_catalog_token`；上传使用独立 `agents_skill_upload_token`，publisher 只能由服务端 token 映射得出。
- 内网目录失败不得影响我的技能、启停和 `/` 调用；不完整分页结果不得覆盖缓存。
- 每个任务先写失败测试并确认旧实现失败，再实现、跑绿、独立提交；不得把单元测试写成真机或跨机器验收通过。
- 最终必须执行 `corepack yarn typecheck`、`corepack yarn test`、`corepack yarn check` 并记录退出码；Windows 真机不可用时标为 BLOCKED。

## File Structure

| 文件 | 责任 | 任务 |
| --- | --- | --- |
| `packages/huaanwork-skill-format/**` | 共享 Markdown 解析、目录枚举、摘要、归档和预算 | 1 |
| `scripts/verify-layout.mjs`、`tsdown.config.ts`、bundled runtime/许可证脚本 | 新共享包布局、内联与许可证门禁 | 1 |
| `dsh-plugin-huaanwork/src/huaanwork-host/skill-local-state.ts` | 用户启停、本地来源、摘要和发布快照 | 2 |
| `dsh-plugin-huaanwork/src/huaanwork-host/skill-center-migration.ts` | 一次性迁移旧用户技能与旧内置启用态 | 2 |
| `dsh-plugin-huaanwork/src/huaanwork-host/skills-host.ts` | 本地 CRUD、来源读取和启用写入 | 2、3 |
| `dsh-plugin-huaanwork/src/huaanwork-host/skill-invoke.ts` | 显式 `/` 与 `allowSkills` 共用执行门 | 3 |
| `dsh-plugin-huaanwork/src/profile.ts` | 三种 preset 的外部技能扫描隔离 | 3 |
| `agent-catalog-server/src/skill-types.ts` | 技能 revision、series 和状态类型 | 4 |
| `agent-catalog-server/src/skill-store.ts` | 独立技能状态、归档提交、名称锁和分页 | 4 |
| `agent-catalog-server/src/config.ts` / `src/auth.ts` | 独立上传者 token 映射与身份判定 | 4 |
| `agent-catalog-server/src/skills.ts` | 上传即发布、列表、详情和下载 handler | 5 |
| `agent-catalog-server/src/server.ts` / `src/audit.ts` | 技能路由、独立技能审计与崩溃恢复 | 5 |
| `dsh-plugin-huaanwork/src/huaanwork-host/catalog-transport.ts` | 同源、禁重定向、限时和限字节传输 | 6 |
| `dsh-plugin-huaanwork/src/huaanwork-host/skill-catalog-client.ts` | 技能目录 HTTP client | 6、8 |
| `dsh-plugin-huaanwork/src/huaanwork-host/skill-center.ts` | 内置/共享中心合并、缓存和状态投影 | 6 |
| `dsh-plugin-huaanwork/src/huaanwork-host/skill-catalog-download.ts` | 内置/共享下载、冲突和原子落盘 | 7 |
| `dsh-plugin-huaanwork/src/huaanwork-host/skill-catalog-upload.ts` | 本地快照、expected revision 和发布状态 | 8 |
| `dsh-plugin-huaanwork/src/huaanwork-host/skill-duplicate.ts` | 另存为新技能，复制完整资源并默认禁用 | 9 |
| `dsh-plugin-huaanwork/src/huaanwork-host/routes.ts` | 中心/本地/可调用/下载/上传 RPC | 6、7、8、9 |
| `dsh-plugin-huaanwork/src/client-huaanwork/SkillsView.tsx` | 两标签页面与卡片操作 | 9 |
| `dsh-plugin-huaanwork/src/client-huaanwork/logic/skillsLogic.ts` | 标签、搜索、按钮状态和 `/` 查询 | 9 |
| `dsh-plugin-huaanwork/src/client-huaanwork/App.tsx` / `SlashSkillMenu.tsx` | 只加载系统技能和已启用本地技能 | 9 |
| `docs/user-guide*.md`、`docs/skill-center*.md`、`docs/skill-center.i18n.yaml` | 用户流程、服务端部署、token、备份与双语门禁 | 10 |
| `docs/evidence/2026-11-14-skill-center-catalog.md` | 命令退出码、真机矩阵和 BLOCKED 项 | 11 |

## Shared Test Fixtures

计划中的示例测试统一使用以下夹具；实施时放入对应测试文件，不依赖未定义 helper：

```ts
const validFiles = [
  { path: 'SKILL.md', data: Buffer.from('---\nname: demo\ndescription: 演示\n---\n\n正文\n', 'utf8') },
  { path: 'scripts/run.mjs', data: Buffer.from('console.log("demo")\n', 'utf8') },
]
const validArchive = await buildSkillArchive(validFiles)

function makeHome(): string {
  return mkdtempSync(join(tmpdir(), 'hw-skill-center-'))
}

function writeLocalSkill(profileDir: string, name: string, body: string): string {
  const dir = join(profileDir, 'skills', name)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'SKILL.md')
  writeFileSync(file, `---\nname: ${name}\ndescription: ${name}\n---\n\n${body}\n`, 'utf8')
  return file
}

function writeExternalSkill(name: string, body: string): string {
  const root = join(process.env.DSH_AGENTS_HOME!, 'skills')
  mkdirSync(root, { recursive: true })
  const file = join(root, `${name}.md`)
  writeFileSync(file, `---\nname: ${name}\ndescription: ${name}\n---\n\n${body}\n`, 'utf8')
  return file
}
```

`makeHome()` 创建临时 Profile；服务端 `request()` 沿用 `agent-catalog-server/tests/helpers.ts`，Task 5 为其增加 `raw?: Buffer` 与自定义 headers 支持。每个测试在 `afterEach` 清理临时目录并恢复 `DSH_AGENTS_HOME`，不读写真实 `~/.agents/skills`。

---

### Task 1: 共享技能格式与归档预算

**Files:**
- Create: `packages/huaanwork-skill-format/package.json`
- Create: `packages/huaanwork-skill-format/tsconfig.json`
- Create: `packages/huaanwork-skill-format/src/index.ts`
- Create: `packages/huaanwork-skill-format/src/markdown.ts`
- Create: `packages/huaanwork-skill-format/src/archive.ts`
- Create: `packages/huaanwork-skill-format/tests/markdown.test.ts`
- Create: `packages/huaanwork-skill-format/tests/archive.test.ts`
- Modify: `package.json`（workspaces 与 typecheck/test/check 门禁闭包）
- Modify: `scripts/expected-root-gate-scripts.json`
- Modify: `scripts/verify-layout.mjs`（workspace 精确数组 13 → 14）
- Modify: `dsh-plugin-huaanwork/tests/package.spec.ts`（EXPECTED_WORKSPACES）
- Modify: `yarn.lock`
- Modify: `dsh-plugin-huaanwork/package.json`（devDependencies `"@huaanwork/skill-format": "*"`）
- Modify: `dsh-plugin-huaanwork/tsdown.config.ts`（deps.alwaysBundle）
- Modify: `dsh-plugin-huaanwork/scripts/huaanwork-verify-bundled-runtime.mjs`（运行时包与 marker）
- Modify: `dsh-plugin-huaanwork/scripts/huaanwork-bundled-runtime.spec.mjs`
- Modify: `dsh-plugin-huaanwork/scripts/verify-licenses.mjs`（BUNDLED_FIRST_PARTY_PACKAGES）
- Modify: `agent-catalog-server/package.json`（dependencies `"@huaanwork/skill-format": "workspace:*"`）
- Modify: `dsh-plugin-huaanwork/src/huaanwork-guardrails/skills.ts`（改用共享 Markdown 实现）
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/skills-host.ts`（切换 Markdown 与 SKILL_NAME_RE 导入）
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/skill-invoke.ts`（切换 SKILL_NAME_RE 导入）
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/agent-package/drafts.ts`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/agent-package/runtime.ts`
- Modify: `dsh-plugin-huaanwork/tests/huaanwork-guardrails/skills.spec.ts`（切换 Markdown 导入）

**Interfaces:**
- Consumes: 现有 `parseSkillMarkdown` / `serializeSkillMarkdown` 的 managed keys 与 `extraLines` 语义。
- Produces: `SkillArchiveFile`、`InspectedSkillArchive`、`readSkillDirectory`、`createSkillDigest`、`buildSkillArchive`、`inspectSkillArchive`、`writeSkillDirectory`。

- [x] **Step 1: 写共享格式失败测试**

```ts
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  buildSkillArchive,
  createSkillDigest,
  inspectSkillArchive,
  readSkillDirectory,
} from '../src/index.ts'

test('round-trips a skill bundle with resources and stable digest', async () => {
  const root = mkdtempSync(join(tmpdir(), 'skill-format-'))
  try {
    mkdirSync(join(root, 'scripts'), { recursive: true })
    writeFileSync(join(root, 'SKILL.md'), '---\nname: demo\ndescription: 演示\n---\n\n正文\n')
    writeFileSync(join(root, 'scripts', 'run.mjs'), 'console.log("demo")\n')
    const files = readSkillDirectory(root)
    const archive = await buildSkillArchive(files)
    const inspected = await inspectSkillArchive(archive)
    assert.equal(inspected.name, 'demo')
    assert.equal(inspected.digest, createSkillDigest(files))
    assert.deepEqual(inspected.files.map(file => file.path), ['SKILL.md', 'scripts/run.mjs'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
```

同时写参数化负例：绝对路径、`../escape`、反斜杠、drive prefix、重复路径、文件/目录冲突、缺 `SKILL.md`、名称不一致、符号链接、硬链接、非普通文件、嵌套 gzip/zstd、压缩前后超 5 MiB、超过 256 条目和 512 字节路径。

- [x] **Step 2: 运行测试确认旧基线失败**

Run: `corepack yarn workspace @huaanwork/skill-format test`

Expected: FAIL，工作区或 `src/index.ts` 尚不存在。

- [x] **Step 3: 创建共享包并迁移纯 Markdown 实现**

`packages/huaanwork-skill-format/package.json` 使用以下脚本和依赖：

```json
{
  "name": "@huaanwork/skill-format",
  "version": "0.1.0",
  "license": "MIT",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts",
    "./markdown": "./src/markdown.ts"
  },
  "scripts": {
    "test": "node --experimental-strip-types --test tests/*.test.ts",
    "typecheck": "tsc --noEmit",
    "check": "yarn test && yarn typecheck"
  },
  "dependencies": { "tar": "7.5.22" },
  "devDependencies": { "@types/node": "^22.20.0", "typescript": "6.0.3" }
}
```

把现有 `parseSkillMarkdown`、`serializeSkillMarkdown`、`ParsedSkillMarkdown`、`MANAGED_KEYS` 及 **`SKILL_NAME_RE`** 移到 `markdown.ts`，`SKILL_NAME_RE` 以共享包为唯一来源，删除 `skills.ts` 内的重复定义。全部消费者改为从 `@huaanwork/skill-format/markdown` 导入，不保留转发层：`skills.ts` 自身内部引用（`findBundledEntry`/`readSkillToggles` 等）、`skills-host.ts`、`skill-invoke.ts`、`agent-package/drafts.ts`、`agent-package/runtime.ts`，以及 `tests/huaanwork-guardrails/skills.spec.ts`。`skill-invoke.ts` 仍从 `skills.ts` 导入 `SYSTEM_SKILLS`/`bundledSkillDir`/`readSkillToggles`，仅 `SKILL_NAME_RE` 改源。客户端 `skillsLogic.ts` 的本地 `SKILL_NAME_RE` 副本不在本任务范围。归档核心常量固定为：

```ts
export const MAX_SKILL_ARCHIVE_BYTES = 5 * 1024 * 1024
export const MAX_SKILL_ARCHIVE_CONTENT_BYTES = 5 * 1024 * 1024
export const MAX_SKILL_ENTRIES = 256
export const MAX_SKILL_PATH_BYTES = 512
export const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
```

摘要使用排序后的文件行计算 canonical JSON 的 SHA-256：

```ts
const rows = [...files]
  .sort((a, b) => a.path.localeCompare(b.path))
  .map(file => ({
    path: file.path,
    size: file.data.byteLength,
    sha256: createHash('sha256').update(file.data).digest('hex'),
  }))
const digest = createHash('sha256')
  .update(JSON.stringify({ schemaVersion: 1, files: rows }), 'utf8')
  .digest('hex')
return `sha256:${digest}`
```

归档实现采用 `tar` 的 portable/noMtime 模式；解压复用 `packages/agent-package-format/src/bundle.ts` 已验证的 gunzip 输出计量、嵌套压缩魔数拒绝、raw header 路径校验和条目预算模式，但不得引入 `agent.json`、`.signature`、签名或 keyring 逻辑。

把 `@huaanwork/skill-format` 加入 root workspaces，并在 root `typecheck`、`test`、`check` 的 `@huaanwork/agent-package-format` 之后加入对应 workspace 命令；同步更新 `scripts/expected-root-gate-scripts.json`、`scripts/verify-layout.mjs` 的精确 workspace 数组与 `package.spec.ts` 的 `EXPECTED_WORKSPACES`，避免新包逃过全量门禁。

桌面依赖必须放 `dsh-plugin-huaanwork/devDependencies` 且写 `"*"`，不得写 `workspace:`/`portal:`/`link:` 或放 dependencies；`agent-catalog-server/dependencies` 写 `"workspace:*"`。同步把新包加入 `tsdown.config.ts` 的 `deps.alwaysBundle`、`huaanwork-verify-bundled-runtime.mjs` 的 `AGENT_PACKAGE_RUNTIME_PACKAGES` 与 `BUNDLED_MARKERS`（marker 可用 `MAX_SKILL_ARCHIVE_BYTES`）、对应 `.spec.mjs`，以及 `verify-licenses.mjs` 的 `BUNDLED_FIRST_PARTY_PACKAGES`。

- [x] **Step 4: 跑共享包与既有 Markdown 消费者测试**

Run: `corepack yarn workspace @huaanwork/skill-format check`

Run: `corepack yarn workspace dsh-plugin-huaanwork exec vitest run tests/huaanwork-guardrails/skills.spec.ts tests/huaanwork-host/skills-host.spec.ts tests/package.spec.ts`

Run: `corepack yarn check:layout`

Expected: PASS；`extraLines`、invocation 布尔值、frontmatter 行为、工作区门禁闭包和布局门禁不变。bundled runtime 与许可证闭环在 Task 11 构建后全量验证。

- [x] **Step 5: 提交共享格式**

```bash
git add package.json scripts/expected-root-gate-scripts.json scripts/verify-layout.mjs yarn.lock packages/huaanwork-skill-format agent-catalog-server/package.json dsh-plugin-huaanwork/package.json dsh-plugin-huaanwork/tsdown.config.ts dsh-plugin-huaanwork/scripts/huaanwork-verify-bundled-runtime.mjs dsh-plugin-huaanwork/scripts/huaanwork-bundled-runtime.spec.mjs dsh-plugin-huaanwork/scripts/verify-licenses.mjs dsh-plugin-huaanwork/tests/package.spec.ts dsh-plugin-huaanwork/src/huaanwork-guardrails/skills.ts dsh-plugin-huaanwork/src/huaanwork-host/skills-host.ts dsh-plugin-huaanwork/src/huaanwork-host/skill-invoke.ts dsh-plugin-huaanwork/src/huaanwork-host/agent-package/drafts.ts dsh-plugin-huaanwork/src/huaanwork-host/agent-package/runtime.ts dsh-plugin-huaanwork/tests/huaanwork-guardrails/skills.spec.ts
git commit -m "feat(skills): add shared skill archive format"
```

---

### Task 2: 本地启用状态、来源记录与一次性迁移

**Files:**
- Create: `dsh-plugin-huaanwork/src/huaanwork-host/skill-local-state.ts`
- Create: `dsh-plugin-huaanwork/src/huaanwork-host/skill-center-migration.ts`
- Create: `dsh-plugin-huaanwork/tests/huaanwork-host/skill-local-state.spec.ts`
- Create: `dsh-plugin-huaanwork/tests/huaanwork-host/skill-center-migration.spec.ts`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/skills-host.ts`
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/rpc-types.ts`（提前定义本地来源与本地技能投影）
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/index.ts`
- Modify: `dsh-plugin-huaanwork/tests/huaanwork-host/skills-host.spec.ts`
- Modify: `dsh-plugin-huaanwork/tests/huaanwork-host/routes.spec.ts`（setEnabled 内置用例改写）
- Modify: `dsh-plugin-huaanwork/tests/huaanwork-migration/extras.spec.ts`
- Modify: `dsh-plugin-huaanwork/tests/huaanwork-migration/end-to-end.spec.ts`

**Interfaces:**
- Consumes: Task 1 的目录读取与摘要；现有 `readSkillToggles` 只作为旧迁移输入。
- Produces: `SkillOrigin`、`SkillLocalEntry`、`LocalSkillInfo`、`readUserSkillToggles`、`setUserSkillToggle`、`readSkillLocalState`、`writeSkillLocalEntry`、`removeSkillLocalEntry`、`ensureSkillCenterMigration`。

- [x] **Step 1: 写本地状态与迁移失败测试**

```ts
test('new imported skills are disabled and state survives removal', async () => {
  const profile = makeHome()
  const fixturePath = writeExternalSkill('demo', '正文')
  const imported = await importSkill(profile, { path: fixturePath })
  assert.equal(imported.ok, true)
  assert.equal(readUserSkillToggles(profile).demo, undefined)
  assert.equal(readSkillLocalState(profile).skills.demo.origin.kind, 'imported')
  await removeSkill(profile, 'demo')
  assert.equal(readSkillLocalState(profile).skills.demo, undefined)
  assert.equal(readUserSkillToggles(profile).demo, undefined)
})

test('migration enables existing user skills without importing external skills', async () => {
  const profile = makeHome()
  writeLocalSkill(profile, 'legacy', '旧本地技能')
  writeExternalSkill('external-only', '外部技能')
  const warnings = await ensureSkillCenterMigration(profile)
  assert.equal(readUserSkillToggles(profile).legacy, true)
  assert.equal(readUserSkillToggles(profile)['external-only'], undefined)
  assert.equal(readSkillLocalState(profile).migration.version, 1)
  assert.deepEqual(warnings, [])
})
```

另覆盖：旧启用普通内置复制为 `origin.kind='bundled'`、系统技能不复制、同名本地不覆盖但启用本地并给警告、迁移完成后再次启动不重新启用已禁用技能、半完成状态可重入、外部原文件保持不变；创建不写 `user-invocable`，导入保留 `user-invocable: false`，编辑后该行仍存在。

- [x] **Step 2: 运行测试确认旧实现失败**

Run: `corepack yarn workspace dsh-plugin-huaanwork exec vitest run tests/huaanwork-host/skill-local-state.spec.ts tests/huaanwork-host/skill-center-migration.spec.ts`

Expected: FAIL，本地状态和迁移模块尚不存在。

- [x] **Step 3: 实现独立用户启停和本地状态**

先在 `rpc-types.ts` 定义后续任务共同使用的本地类型，避免 Host 反向依赖未定义符号：

```ts
export type SkillOrigin =
  | { kind: 'created' }
  | { kind: 'imported' }
  | { kind: 'bundled' }
  | { kind: 'catalog'; name: string; revision: number; publisher: string; digest: string }

export type SkillLocalEntry = {
  origin: SkillOrigin
  contentDigest: string
  publishedRevision?: number
  publishedDigest?: string
}

export type LocalSkillInfo = {
  name: string
  description: string
  source: 'user'
  whenToUse?: string
  enabled: boolean
  origin: SkillOrigin
  contentDigest: string
  publishedRevision?: number
  publishedDigest?: string
  publishState: 'not-published' | 'published' | 'modified'
}
```

本地状态文档使用这些类型：

```ts
export type SkillLocalStateDocument = {
  schemaVersion: 1
  migration?: { version: 1; completedAt: string }
  skills: Record<string, SkillLocalEntry>
  migrationWarnings?: string[]
}

export function readUserSkillToggles(profileDir: string): Record<string, true>
export function setUserSkillToggle(profileDir: string, name: string, enabled: boolean): void
export function readSkillLocalState(profileDir: string): SkillLocalStateDocument
export function writeSkillLocalEntry(profileDir: string, name: string, entry: SkillLocalEntry): void
export function removeSkillLocalEntry(profileDir: string, name: string): void
```

两个文档均使用同目录临时文件 + rename；损坏状态抛具名错误，不把损坏文档静默解释成“全部禁用”。`setSkillEnabled` 改为只接受存在的用户技能并写 `user-skill-toggles.json`。删除 `restoreEnabledBundledSkills`、普通 bundled 注册记账和 Host 启动调用；系统技能仍由 guardrails 注册。

`createSkill`、`importSkill` 写 `created/imported` 来源和当前摘要，不写启用键；`updateSkill` 保留来源和发布字段并重算摘要；`removeSkill` 同时删除本地状态与启用键。扁平 `.md` 技能在上传/下载时统一规范化为 `<name>/SKILL.md`。

`takenNames` 改为既有用户技能名 + `SYSTEM_SKILLS` + `INTERNAL_BUNDLED_SKILLS`；普通内置名不再阻止本地创建/导入，但 Task 8 首次上传仍检查当前内置名称占用。

invocation 字段按 R7 收敛：`createSkill` 不写 `user-invocable`；`importSkill` 原样保留导入文件 frontmatter；`updateSkill` 不再从表单接收 `userInvocable`，但必须保留原文件既有 `user-invocable` 行（可经 `extraLines` 或显式原值回填），不得因编辑静默删除。`disable-model-invocation` 仍按现有表单字段处理，不参与显式 `/` 门。

本地读/写投影同步闭合：`listUserSkills` 返回 `LocalSkillInfo[]`；`createSkill`、`updateSkill`、`importSkill` 的成功结果返回完整 `LocalSkillInfo`（含 `enabled`、`origin`、`contentDigest`、`publishState`）；`previewSkillImport` 返回 `SkillDetail` 读模型与预览附加字段，不要求列表 UI 状态。旧 `SkillInfo` 可暂保留到 Task 9，但上述返回不得缺少新投影必填字段。

必须同步改写以下既有用例（否则本任务跑 `skills-host.spec.ts`/`routes.spec.ts` 即失败）：
- `skills-host.spec.ts:162-185`：创建断言含 `user-invocable: false`，与 R7“创建不写该键”冲突，改为断言不含该行。
- `skills-host.spec.ts:397-450`：`setSkillEnabled` 整块围绕内置 pdf + mock registrar + `readSkillToggles`，与“只接受用户技能、删除 bundled registrar”冲突，整块改写为本地用户技能启停（写 `user-skill-toggles.json`、无 registrar）。
- `skills-host.spec.ts:455 起`：`restoreEnabledBundledSkills` describe 块随函数删除而整块移除/改写，`import` 同步清理。
- `routes.spec.ts:1221-1228`：对内置 pdf 调 `setEnabled` 期望 200，改为对已存在本地技能开关，并补“未下载内置 pdf 拒绝”断言。

- [x] **Step 4: 实现迁移并在 Host 启动时调用**

`ensureSkillCenterMigration(profileDir)` 只在 `skill-local-state.json` 缺少 `migration.version === 1` 时运行。先读取旧用户目录和旧 `skill-toggles.json`，再复制旧启用普通内置；所有文件成功后原子写状态完成标记。Host 在技能路由可用前 `await ensureSkillCenterMigration(config.profileDir)`。

- [x] **Step 5: 跑本地与迁移回归**

Run: `corepack yarn workspace dsh-plugin-huaanwork exec vitest run tests/huaanwork-host/skill-local-state.spec.ts tests/huaanwork-host/skill-center-migration.spec.ts tests/huaanwork-host/skills-host.spec.ts tests/huaanwork-host/routes.spec.ts tests/huaanwork-migration/extras.spec.ts tests/huaanwork-migration/end-to-end.spec.ts`

Expected: PASS。

- [x] **Step 6: 提交本地状态与迁移**

```bash
git add dsh-plugin-huaanwork/src/huaanwork-host/skill-local-state.ts dsh-plugin-huaanwork/src/huaanwork-host/skill-center-migration.ts dsh-plugin-huaanwork/src/huaanwork-host/skills-host.ts dsh-plugin-huaanwork/src/client-huaanwork/rpc-types.ts dsh-plugin-huaanwork/src/huaanwork-host/index.ts dsh-plugin-huaanwork/tests/huaanwork-host/skill-local-state.spec.ts dsh-plugin-huaanwork/tests/huaanwork-host/skill-center-migration.spec.ts dsh-plugin-huaanwork/tests/huaanwork-host/skills-host.spec.ts dsh-plugin-huaanwork/tests/huaanwork-host/routes.spec.ts dsh-plugin-huaanwork/tests/huaanwork-migration/extras.spec.ts dsh-plugin-huaanwork/tests/huaanwork-migration/end-to-end.spec.ts
git commit -m "feat(skills): persist local enable state and migrate skill ownership"
```

---

### Task 3: 移除外部自动发现并封住所有显式调用入口

**Files:**
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/skills-host.ts`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/skill-invoke.ts`
- Modify: `dsh-plugin-huaanwork/src/profile.ts`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/routes.ts`（skill.get sourceParam 收窄）
- Modify: `dsh-plugin-huaanwork/tests/huaanwork-host/routes.spec.ts`
- Modify: `dsh-plugin-huaanwork/tests/huaanwork-host/skills-host.spec.ts`
- Modify: `dsh-plugin-huaanwork/tests/huaanwork-host/sessions.spec.ts`
- Modify: `dsh-plugin-huaanwork/tests/huaanwork-host/agent-package-creation.spec.ts`
- Modify: `dsh-plugin-huaanwork/tests/huaanwork-host/agent-package-drafts.spec.ts`
- Modify: `dsh-plugin-huaanwork/tests/huaanwork-host/agent-package-runtime.spec.ts`
- Modify: `dsh-plugin-huaanwork/tests/profile.spec.ts`

**Interfaces:**
- Consumes: Task 2 的 `readUserSkillToggles`。
- Produces: `SkillSourceFilter = "bundled" | "user"`；`resolveInvocableSkill` 只允许系统内置或已启用本地技能；三个 preset 的 `skill-filesystem.agentsHome` 指向空隔离目录。

- [x] **Step 1: 写外部与未启用调用失败测试**

```ts
test('disabled local skill is rejected by the Host resolver', async () => {
  writeLocalSkill(profile, 'demo', '正文')
  setUserSkillToggle(profile, 'demo', false)
  await expect(resolveInvocableSkill(profile, 'demo'))
    .rejects.toThrow('skill demo is disabled')
})

test('external skills are not an implicit fallback', async () => {
  writeExternalSkill('external-only', '正文')
  assert.equal(await getSkill(profile, 'external-only'), undefined)
  await expect(resolveInvocableSkill(profile, 'external-only'))
    .rejects.toThrow('skill external-only was not found')
})
```

```ts
test('user-invocable false does not block an enabled local skill', async () => {
  const profile = makeHome()
  const dir = join(profile, 'skills', 'demo')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), '---\nname: demo\ndescription: demo\nuser-invocable: false\n---\n\n正文\n', 'utf8')
  setUserSkillToggle(profile, 'demo', true)
  await expect(resolveInvocableSkill(profile, 'demo')).resolves.toMatchObject({ skill: { name: 'demo' } })
})
```

`profile.spec.ts` 对 standard、ptc、cordis 分别断言嵌套 `skill-filesystem.config.agentsHome === join(profileDir, 'skill-provider-empty-agents-home')`，并断言 ptc 既有 `tool-presentation.disabled === true` 未被覆盖。

- [x] **Step 2: 运行测试确认旧实现失败**

Run: `corepack yarn workspace dsh-plugin-huaanwork exec vitest run tests/huaanwork-host/skills-host.spec.ts tests/huaanwork-host/sessions.spec.ts tests/profile.spec.ts -t "disabled local|external skills|skill-filesystem"`

Expected: FAIL，当前用户技能始终可调用且外部根仍被扫描。

- [x] **Step 3: 收敛 Host resolver**

```ts
const skill = await getSkill(storageRoot, name)
if (!skill) throw new Error(`skill ${name} was not found`)
if (skill.source === 'user') {
  if (readUserSkillToggles(storageRoot)[name] !== true) {
    throw new Error(`skill ${name} is disabled`)
  }
} else if (!SYSTEM_SKILLS.has(skill.name)) {
  throw new Error(`skill ${name} requires a downloaded local copy`)
}
```

`getSkill` 删除 external root 与 external 参数分支；无 source 时只读 user，再读系统内置。`resourceDirFor` 同步只处理 user 与 bundled。`getSkill(name, 'bundled')` 仍可用于中心查看普通内置，但不代表可调用。`resolveInvocableSkill` 只检查启用状态与系统技能身份，不读取 `userInvocable`；`user-invocable: false` 的已启用本地技能仍允许显式 `/` 调用。

`routes.ts` 的 `skill.get` 同步把 `sourceParam` 校验收窄为 `'bundled' | 'user'`，删除 external 分支；Task 6 再扩展 `'catalog'`。`routes.spec.ts` 同步更新 source 非法值与 external 回退用例，避免中间提交 typecheck 断裂。

- [x] **Step 4: 在 Profile 中隔离三种 preset 的外部根**

Profile 准备阶段创建 `<profileDir>/skill-provider-empty-agents-home`。把现有 ptc 嵌套覆盖扩展为 `huaanworkPresetOverrides(patches, profileDir)`：保留 ptc presentation 行为，并对三个 preset 的嵌套 `skill-filesystem` 行写：

```ts
skillFilesystem.config = {
  ...rowConfig(skillFilesystem),
  agentsHome: join(profileDir, 'skill-provider-empty-agents-home'),
}
```

缺失任一目标 preset 或嵌套行时 fail loud；不得直接修改 `deepseek-harness/` 或 vendored patch 文件。保持 ptc presentation 与 ConfigEditor 延迟落盘既有不变量。本轮只隔离全局 `$DSH_AGENTS_HOME/skills`；项目 `.dsh/skills`、`.agents/skills` 与 `$DSH_HOME/skills` 不在本轮范围，规格已写明边界。更新所有 `allowSkills` fixture，在调用前显式启用所需用户技能。

- [x] **Step 5: 跑 Host 与 Profile 回归**

Run: `corepack yarn workspace dsh-plugin-huaanwork exec vitest run tests/huaanwork-host/skills-host.spec.ts tests/huaanwork-host/routes.spec.ts tests/huaanwork-host/sessions.spec.ts tests/huaanwork-host/agent-package-creation.spec.ts tests/huaanwork-host/agent-package-drafts.spec.ts tests/huaanwork-host/agent-package-runtime.spec.ts tests/profile.spec.ts`

Expected: PASS。

- [x] **Step 6: 提交外部收敛**

```bash
git add dsh-plugin-huaanwork/src/huaanwork-host/skills-host.ts dsh-plugin-huaanwork/src/huaanwork-host/skill-invoke.ts dsh-plugin-huaanwork/src/profile.ts dsh-plugin-huaanwork/src/huaanwork-host/routes.ts dsh-plugin-huaanwork/tests/huaanwork-host/skills-host.spec.ts dsh-plugin-huaanwork/tests/huaanwork-host/routes.spec.ts dsh-plugin-huaanwork/tests/huaanwork-host/sessions.spec.ts dsh-plugin-huaanwork/tests/huaanwork-host/agent-package-creation.spec.ts dsh-plugin-huaanwork/tests/huaanwork-host/agent-package-drafts.spec.ts dsh-plugin-huaanwork/tests/huaanwork-host/agent-package-runtime.spec.ts dsh-plugin-huaanwork/tests/profile.spec.ts
git commit -m "fix(skills): require explicit enablement and retire external discovery"
```

---

### Task 4: 技能目录存储、revision 与上传者身份

**Files:**
- Create: `agent-catalog-server/src/skill-types.ts`
- Create: `agent-catalog-server/src/skill-store.ts`
- Create: `agent-catalog-server/tests/skill-store.spec.ts`
- Modify: `agent-catalog-server/src/config.ts`
- Modify: `agent-catalog-server/src/auth.ts`
- Modify: `agent-catalog-server/tests/auth-legacy.spec.ts`

**Interfaces:**
- Consumes: Task 1 的 `InspectedSkillArchive`。
- Produces: `SkillRevisionRecord`、`SkillRevisionSummary`、`SkillSeries`、`SkillState`、`SkillStore.open/read/listAfter/get/publish`、`authenticateSkillPublisher`、`AgentCatalogConfig.skillUploaders`。

- [x] **Step 1: 写 store 与身份失败测试**

```ts
test('only the owner advances a skill revision', async () => {
  const dataDir = makeHome()
  const store = await SkillStore.open(dataDir)
  const first = await store.publish({
    name: 'demo', publisher: 'alice', digest: 'sha256:' + 'a'.repeat(64),
    description: '演示', archive: validArchive, expectedRevision: undefined,
    requestId: 'r1', createdAt: '2026-11-14T00:00:00.000Z',
  })
  assert.equal(first.created, true)
  await expect(store.publish({
    name: 'demo', publisher: 'bob', digest: 'sha256:' + 'b'.repeat(64),
    description: '覆盖', archive: validArchive, expectedRevision: 1,
    requestId: 'r2', createdAt: '2026-11-14T00:01:00.000Z',
  })).rejects.toMatchObject({ code: 'skill-name-conflict' })
})
```

另覆盖同摘要幂等先于 revision 冲突、同 owner revision 递增、expectedRevision 过期、并发同名提交串行、状态损坏拒绝启动、归档先落盘后状态可见、分页稳定排序、token 映射和所有 token 互斥。

- [x] **Step 2: 运行测试确认失败**

Run: `corepack yarn workspace agent-catalog-server exec vitest run tests/skill-store.spec.ts tests/auth-legacy.spec.ts`

Expected: FAIL，技能 store 与上传者身份尚不存在。

- [x] **Step 3: 实现独立技能状态与名称锁**

```ts
export type SkillRevisionSummary = {
  name: string
  revision: number
  description: string
  whenToUse?: string
  publisher: string
  digest: string
  size: number
  updatedAt: string
}

export interface SkillState {
  schemaVersion: 1
  lastMutation?: { requestId: string; action: string; at: string }
  skills: Record<string, SkillSeries>
}

export interface SkillPublishInput {
  name: string
  publisher: string
  digest: string
  description: string
  whenToUse?: string
  archive: Buffer
  expectedRevision: number | undefined
  requestId: string
  createdAt: string
}
```

`SkillStore.open(dataDir)` 使用 `${dataDir}/skills/state.json` 和 `${dataDir}/skills/archives/<name>/<revision>.tar.gz`；调用方传服务根 `dataDir`，不得再自行拼接 `skills`。每个名称一个写队列；在锁内先判断最新 revision 同 publisher + 同 digest 的幂等成功，再判断 owner、expected revision 和新建冲突。归档路径由服务端生成，不接受客户端路径。`SkillRevisionSummary` 是 API 投影，不包含内部 `archivePath`。

归档与状态落盘沿用 `store.ts` 的 `writeState` 样本：同目录临时文件 → 写入 → fsync → rename，先归档后状态，状态提交后条目才可见；不得把损坏文件清空后当空目录。

分页 cursor 固定为 `base64url(JSON.stringify({ name: lastReturnedName }))`；服务端解码后按 name 严格大于 cursor 继续，非法 cursor 返回 400 `invalid-cursor`。

- [x] **Step 4: 增加可选上传者配置**

```ts
export interface AgentCatalogConfig {
  skillUploaders: Readonly<Record<string, string>>
}

export function authenticateSkillPublisher(
  config: AgentCatalogConfig,
  presented: string,
): string | undefined
```

`AGENT_CATALOG_SKILL_UPLOADERS` 缺省为 `{}`，非法 JSON、非法 id、短 token、重复 token 或与 read/publish/admin token 重复时启动失败。发布者 id 正则固定为 `^[a-z0-9][a-z0-9._-]{0,63}$`（规格 §7.3）；token 至少 32 字符。token 比较沿用 `auth.ts` 的 `tokenMatches` 样本：先 SHA-256 摘要再 `timingSafeEqual`，**全部 token 比完再判定**，不因命中提前返回；错误信息不回显 token。现有三角色智能体 API 行为不变。

列表 `limit` 默认 100、合法范围 1–100（规格 §7.1），非法值返回 400。损坏状态沿用 fail-closed：`SkillStore.open` 在 `createAgentCatalogRuntime` 中打开失败时进程退出码 1，智能体目录一并不可用（规格 §11.2 已写明该连带后果），不做技能单独降级。

- [x] **Step 5: 跑服务端测试**

Run: `corepack yarn workspace agent-catalog-server check`

Expected: PASS，既有智能体目录测试不回归。

- [x] **Step 6: 提交技能存储与身份**

```bash
git add agent-catalog-server/src/skill-types.ts agent-catalog-server/src/skill-store.ts agent-catalog-server/src/config.ts agent-catalog-server/src/auth.ts agent-catalog-server/tests/skill-store.spec.ts agent-catalog-server/tests/auth-legacy.spec.ts
git commit -m "feat(skill-catalog): add revisioned storage and publisher identities"
```

---

### Task 5: 上传即发布的技能 HTTP API 与独立审计

**Files:**
- Create: `agent-catalog-server/src/skills.ts`
- Create: `agent-catalog-server/src/http-body.ts`
- Create: `agent-catalog-server/tests/skills.spec.ts`
- Modify: `agent-catalog-server/src/server.ts`
- Modify: `agent-catalog-server/src/audit.ts`
- Modify: `agent-catalog-server/src/index.ts`
- Modify: `agent-catalog-server/src/submissions.ts`
- Modify: `agent-catalog-server/tests/helpers.ts`

**Interfaces:**
- Consumes: Task 4 store/auth；Task 1 `inspectSkillArchive`。
- Produces: `GET /v1/skills`、`GET /v1/skills/{name}/{revision}`、`GET /v1/skills/{name}/{revision}/archive`、`POST /v1/skills/{name}`。

- [x] **Step 1: 写真实 HTTP 失败测试**

```ts
test('publishes immediately and serves the exact revision archive', async () => {
  const archive = await buildSkillArchive(validFiles)
  const published = await request('/v1/skills/demo', {
    method: 'POST', token: aliceToken, raw: archive,
    headers: { 'content-type': 'application/gzip' },
  })
  assert.equal(published.status, 201)
  assert.equal(published.body.skill.revision, 1)
  const listed = await request('/v1/skills', { token: readToken })
  assert.deepEqual(listed.body.items.map((item: { name: string }) => item.name), ['demo'])
  const downloaded = await request('/v1/skills/demo/1/archive', { token: readToken })
  assert.equal(downloaded.status, 200)
})
```

另覆盖 read token 不能上传、上传 token 不能审批智能体包、错误 revision、非 owner、无 expected 的首次重试幂等、400 归档错误、409 冲突、分页 cursor、静态路由不被动态 name 吞掉、技能审计 intent/result、技能 store 崩溃恢复不清空智能体 audit intents。

- [x] **Step 2: 运行 HTTP 测试确认失败**

Run: `corepack yarn workspace agent-catalog-server exec vitest run tests/skills.spec.ts`

Expected: FAIL，`/v1/skills` 返回 404。

- [x] **Step 3: 实现技能 handler 和 capped body**

```ts
export interface SkillHandlerContext {
  request: IncomingMessage
  store: SkillStore
  publisher: string
  requestId: string
}

export async function publishSkill(
  ctx: SkillHandlerContext,
  name: string,
): Promise<HandlerResult>
```

从 `submissions.ts` 抽出通用 capped body reader/drain 到 `http-body.ts`，智能体与技能 handler 共同导入。技能 handler 读取最多 5 MiB body，调用 `inspectSkillArchive`，检查 URL name 与 `SKILL.md` name 一致，再提交 store；不创建 submission，不读取 keyring。

- [x] **Step 4: 接入路由与独立技能审计**

`AgentCatalogRuntime` 增加 `skillStore` 和 `skillAudit`。运行时使用 `SkillStore.open(config.dataDir)` 与 `AuditLog.open(join(config.dataDir, 'skills'), allSecrets)`；技能 audit 只恢复技能 store 的 intents，现有智能体 audit 只恢复智能体 store。把 `AuditLog.reconcile` 参数收窄为结构类型 `{ lastMutation?: { requestId: string; action: string; at: string } }`，两种 state 都满足。路由定义增加 `audit: 'agent' | 'skill'`，写前可用性检查、intent 和 `finish` 结果落盘都按该字段选择 audit；`finish` 显式接收选中的 `AuditLog`，不得继续固定读取 `runtime.audit`。

```ts
const identity = presented === undefined ? null : authenticateToken(config, presented)
const publisher = presented === undefined ? undefined : authenticateSkillPublisher(config, presented)
const principal = identity ?? (publisher === undefined ? null : 'skill-publish')
```

两个认证函数都必须执行，不能因已有角色命中而跳过 uploader token 比较。定义 `type CatalogPrincipal = AgentCatalogRole | 'skill-publish'`，路由 `roles` 与 `DispatchContext.role` 使用该类型；技能 POST 的 `DispatchContext.publisher` 必填，GET 仍只允许 read。

审计按裁定复用现有坐标：技能路由把 `name` 写入 `slug`、`String(revision)` 写入 `version`，不新增 `name/revision/digest` 审计字段。`secretList(config)` 扩展为 `[readToken, publishToken, adminToken, ...Object.values(config.skillUploaders)]`，`runtime.audit`、`runtime.skillAudit` 与 HTTP 异常脱敏共用。`handleRequest` 统一 `const targetAudit = route?.audit === 'skill' ? runtime.skillAudit : runtime.audit`，覆盖 403/405、审计不可用、writeIntent、handler catch 与 finish；未匹配路由的 401/404 归入 `runtime.audit`。补充技能审计 intent/result、token 脱敏和 pre-dispatch 分流断言。

- [x] **Step 5: 跑服务端完整检查**

Run: `corepack yarn workspace agent-catalog-server check`

Expected: PASS；技能发布无审核状态，既有智能体审核/签名测试全部保持通过。

- [x] **Step 6: 提交技能 API**

```bash
git add agent-catalog-server/src/skills.ts agent-catalog-server/src/http-body.ts agent-catalog-server/src/server.ts agent-catalog-server/src/audit.ts agent-catalog-server/src/index.ts agent-catalog-server/src/submissions.ts agent-catalog-server/tests/skills.spec.ts agent-catalog-server/tests/helpers.ts
git commit -m "feat(skill-catalog): publish and download skills over the intranet API"
```

---

### Task 6: 桌面目录传输、设置与中心离线投影

**Files:**
- Create: `dsh-plugin-huaanwork/src/huaanwork-host/catalog-transport.ts`
- Create: `dsh-plugin-huaanwork/src/huaanwork-host/skill-catalog-client.ts`
- Create: `dsh-plugin-huaanwork/src/huaanwork-host/skill-center.ts`
- Create: `dsh-plugin-huaanwork/tests/huaanwork-host/skill-catalog-client.spec.ts`
- Create: `dsh-plugin-huaanwork/tests/huaanwork-host/skill-center.spec.ts`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/agent-package/catalog-client.ts`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/settings.ts`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/index.ts`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/routes.ts`
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/api.ts`
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/rpc-types.ts`
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/QualitySection.tsx`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-migration/settings.ts`
- Modify: `dsh-plugin-huaanwork/tests/huaanwork-host/routes.spec.ts`
- Modify: `dsh-plugin-huaanwork/tests/huaanwork-host/route-contract.spec.ts`
- Modify: `dsh-plugin-huaanwork/tests/client-huaanwork/api.spec.ts`
- Modify: `dsh-plugin-huaanwork/tests/huaanwork-host/market-routes.spec.ts`（ROUTE_TABLE 总数同步）
- Modify: `dsh-plugin-huaanwork/tests/huaanwork-host/settings.spec.ts`
- Modify: `dsh-plugin-huaanwork/tests/huaanwork-host/agent-package-catalog-install.spec.ts`
- Modify: `dsh-plugin-huaanwork/tests/huaanwork-host/agent-package-catalog-publish.spec.ts`
- Modify: `dsh-plugin-huaanwork/tests/huaanwork-host/agent-package-catalog-security.spec.ts`
- Modify: `dsh-plugin-huaanwork/tests/client-huaanwork/settings-quality.spec.ts`

**Interfaces:**
- Consumes: Task 5 HTTP API；Task 2 本地状态。
- Produces: `SkillRevisionSummary` 客户端镜像、`CenterSkillInfo`、`InvocableSkillInfo`、`configureSkillCatalog`、`listSharedSkills`、`getSkillRevision`、`downloadSkillArchive`、`listSkillCenter`、`skill.centerList`、`skill.mineList`、`skill.invocableList`。

- [x] **Step 1: 写传输与离线中心失败测试**

使用真实 loopback HTTP server，不 mock `fetch` 成功路径。断言：公网地址拒绝、跨 origin bundle URL 拒绝、302 拒绝、超时、JSON 1 MiB 和归档 5 MiB 上限、分页必须完整、空 token 只禁用上传、远端失败时中心仍返回内置和完整缓存、我的/可调用列表不发远端请求。

```ts
const profileDir = makeHome()
const result = await listSkillCenter(profileDir)
expect(result.catalogError).toBe('共享技能库不可用，当前显示内置技能与已缓存内容')
expect(result.skills.some(skill => skill.source === 'bundled')).toBe(true)
expect(result.skills.some(skill => skill.source === 'catalog')).toBe(true)
```

`catalogError` 文案必须与规格 §5.4 原文逐字一致（TDD 会把该句钉进实现）。另补一条 `listSkillCenter` 投影判定测试，逐一钉死五个 `downloadState`：无本地副本 → `available`；同来源同摘要 → `downloaded`；同来源旧 revision 且本地未改 → `update-available`；同名但来源不同或本地已改 → `local-conflict`；系统技能 → `not-applicable`。只断言来源存在不足以挡住投影算错。

- [x] **Step 2: 运行测试确认失败**

Run: `corepack yarn workspace dsh-plugin-huaanwork exec vitest run tests/huaanwork-host/skill-catalog-client.spec.ts tests/huaanwork-host/skill-center.spec.ts`

Expected: FAIL，桌面技能 client 与中心投影尚不存在。

- [x] **Step 3: 抽取通用传输并实现技能 client**

从现有 `agent-package/catalog-client.ts` 抽取无签名语义的同源 URL、Authorization、timeout、manual redirect、capped JSON 和 capped buffer 逻辑到 `catalog-transport.ts`；智能体 client 改为消费同一传输，既有签名/安装逻辑不动。

```ts
export type SkillRevisionSummary = {
  name: string
  revision: number
  description: string
  whenToUse?: string
  publisher: string
  digest: string
  size: number
  updatedAt: string
}

export interface SkillCatalogClient {
  listSharedSkills(): Promise<SkillRevisionSummary[]>
  getSkillRevision(name: string, revision: number): Promise<SkillRevisionSummary>
  downloadSkillArchive(name: string, revision: number): Promise<Buffer>
}
```

配置复用 `agents_host/agents_port/agents_catalog_token`；新增 `agents_skill_upload_token: ''`，同步默认值、解析、合并、设置迁移和 QualitySection 的“技能上传口令”输入。每次请求重新读取 settings，保存后无需重启 Host。`listSharedSkills` 逐页读取直到无 `nextCursor`，最多 1000 页；超过上限抛目录错误，不返回截断列表。`SkillSource` 本任务先增加 `catalog`，旧 `external` 成员保留到 Task 9 统一删除，保证中间提交可 typecheck。

- [x] **Step 4: 实现中心合并和完整缓存**

在 `rpc-types.ts` 定义中心投影，字段与规格 §6.1 一致：

```ts
export type SkillDownloadState =
  | 'available'
  | 'downloaded'
  | 'update-available'
  | 'local-conflict'
  | 'not-applicable'

export type CenterSkillInfo = {
  name: string
  description: string
  source: 'bundled' | 'catalog'
  whenToUse?: string
  revision?: number
  publisher?: string
  digest?: string
  updatedAt?: string
  downloadState: SkillDownloadState
}

export type InvocableSkillInfo = {
  name: string
  description: string
  source: 'bundled' | 'user'
  enabled: true
  originKind?: SkillOrigin['kind']
}

export type SkillCenterListResult = {
  skills: CenterSkillInfo[]
  catalogError?: string
  migrationWarnings?: string[]
}
```

`listSkillCenter` 合并内置与共享列表，内置列表继续过滤 `INTERNAL_BUNDLED_SKILLS`，读取本地状态计算 `available/downloaded/update-available/local-conflict/not-applicable`。完整分页成功后原子写 `<profileDir>/skill-catalog-cache.json`，缓存文档为 `{ schemaVersion: 1, updatedAt: string, items: SkillRevisionSummary[] }`；失败只读缓存并返回 `catalogError`。内置条目计算内容摘要；系统技能为 `not-applicable`。

扩展 `skill.get`：`source='catalog'` 时必须携带正整数 `revision`，Host 调 `getSkillRevision` 与 `downloadSkillArchive`，用 `inspectSkillArchive` 生成只读 `SkillDetail`，不得写本地目录或启用状态；`source='bundled'|'user'` 保持本地读取。中心共享“查看”因此不依赖已下载副本。

`skill.invocableList` 只返回系统技能与 `enabled=true` 的本地技能，不按 `userInvocable` 过滤。Task 6 新增三个只读 RPC，路由总数 **72 → 75**；`settings.get/settings.set` 必选键 **13 → 14**（新增 `agents_skill_upload_token`）。`route-contract.spec.ts`、`routes.spec.ts`、`api.spec.ts`、`market-routes.spec.ts` 必须同步维护精确路由数、`ALL_METHODS`、`EXPECTED_ROUTES` 与设置键集合。`market-routes.spec.ts:236` 的 `ROUTE_TABLE.toHaveLength(72)` 随 Task 6→7→8→9 依次改为 75→76→77→77；该文件不在各任务聚焦命令默认范围，但全量 `test/check` 会跑，漏改必在 Task 11 全量门禁失败。

本任务在 `CLIENT_REQUIRED_KEYS` 与 `SERVER_EXPECTED_KEYS` 成对登记：`skill.centerList` 必选 `['skills']`、可选 `['catalogError', 'migrationWarnings']`；`skill.mineList` 必选 `['skills']`；`skill.invocableList` 必选 `['skills']`。暂保留旧 `skill.list` 直到 Task 9 切换所有消费者：

```ts
'skill.centerList': get('/huaanwork/skill/center/list')
'skill.mineList': get('/huaanwork/skill/mine/list')
'skill.invocableList': get('/huaanwork/skill/invocable/list')
```

- [x] **Step 5: 跑桌面传输、路由与既有智能体目录回归**

Run: `corepack yarn workspace dsh-plugin-huaanwork exec vitest run tests/huaanwork-host/skill-catalog-client.spec.ts tests/huaanwork-host/skill-center.spec.ts tests/huaanwork-host/routes.spec.ts tests/huaanwork-host/route-contract.spec.ts tests/client-huaanwork/api.spec.ts tests/huaanwork-host/settings.spec.ts tests/client-huaanwork/settings-quality.spec.ts tests/huaanwork-host/agent-package-catalog-install.spec.ts tests/huaanwork-host/agent-package-catalog-publish.spec.ts tests/huaanwork-host/agent-package-catalog-security.spec.ts tests/huaanwork-host/market-routes.spec.ts`

Expected: PASS；传输抽取不得改变智能体目录安装、发布或安全测试。

- [x] **Step 6: 提交桌面目录读取面**

```bash
git add dsh-plugin-huaanwork/src/huaanwork-host/catalog-transport.ts dsh-plugin-huaanwork/src/huaanwork-host/skill-catalog-client.ts dsh-plugin-huaanwork/src/huaanwork-host/skill-center.ts dsh-plugin-huaanwork/src/huaanwork-host/agent-package/catalog-client.ts dsh-plugin-huaanwork/src/huaanwork-host/settings.ts dsh-plugin-huaanwork/src/huaanwork-host/index.ts dsh-plugin-huaanwork/src/huaanwork-host/routes.ts dsh-plugin-huaanwork/src/client-huaanwork/api.ts dsh-plugin-huaanwork/src/client-huaanwork/rpc-types.ts dsh-plugin-huaanwork/src/client-huaanwork/QualitySection.tsx dsh-plugin-huaanwork/src/huaanwork-migration/settings.ts dsh-plugin-huaanwork/tests/huaanwork-host/skill-catalog-client.spec.ts dsh-plugin-huaanwork/tests/huaanwork-host/skill-center.spec.ts dsh-plugin-huaanwork/tests/huaanwork-host/routes.spec.ts dsh-plugin-huaanwork/tests/huaanwork-host/route-contract.spec.ts dsh-plugin-huaanwork/tests/client-huaanwork/api.spec.ts dsh-plugin-huaanwork/tests/huaanwork-host/settings.spec.ts dsh-plugin-huaanwork/tests/huaanwork-host/agent-package-catalog-install.spec.ts dsh-plugin-huaanwork/tests/huaanwork-host/agent-package-catalog-publish.spec.ts dsh-plugin-huaanwork/tests/huaanwork-host/agent-package-catalog-security.spec.ts dsh-plugin-huaanwork/tests/client-huaanwork/settings-quality.spec.ts dsh-plugin-huaanwork/tests/huaanwork-host/market-routes.spec.ts
git commit -m "feat(skills): add intranet catalog transport and offline center projection"
```

---

### Task 7: 中心下载到我的技能

**Files:**
- Create: `dsh-plugin-huaanwork/src/huaanwork-host/skill-catalog-download.ts`
- Create: `dsh-plugin-huaanwork/tests/huaanwork-host/skill-catalog-download.spec.ts`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/routes.ts`
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/api.ts`
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/rpc-types.ts`
- Modify: `dsh-plugin-huaanwork/tests/huaanwork-host/routes.spec.ts`
- Modify: `dsh-plugin-huaanwork/tests/huaanwork-host/route-contract.spec.ts`
- Modify: `dsh-plugin-huaanwork/tests/client-huaanwork/api.spec.ts`
- Modify: `dsh-plugin-huaanwork/tests/huaanwork-host/market-routes.spec.ts`（ROUTE_TABLE 总数同步）

**Interfaces:**
- Consumes: Task 1 归档检查；Task 2 本地状态；Task 6 client/中心投影。
- Produces: `downloadSkillToMine(profileDir, { source, name, revision? })` 与 `skill.download`。

- [x] **Step 1: 写下载失败测试**

```ts
test('downloads a shared skill as a disabled local catalog copy', async () => {
  const profileDir = makeHome()
  const result = await downloadSkillToMine(profileDir, {
    source: 'catalog', name: 'demo', revision: 1,
  })
  expect(result.skill.enabled).toBe(false)
  expect(result.skill.origin).toMatchObject({ kind: 'catalog', name: 'demo', revision: 1 })
  expect(readUserSkillToggles(profileDir).demo).toBeUndefined()
})
```

另覆盖内置离线下载、完整资源复制、同摘要幂等、显式更新、更新保留启用、下载默认禁用、同名创建/导入冲突、下载副本有修改时拒绝覆盖、网络中断无半目录、摘要不符不落盘、符号链接归档拒绝、系统技能不可下载、同技能并发只执行一次。

- [x] **Step 2: 运行下载测试确认失败**

Run: `corepack yarn workspace dsh-plugin-huaanwork exec vitest run tests/huaanwork-host/skill-catalog-download.spec.ts`

Expected: FAIL，下载模块尚不存在。

- [x] **Step 3: 实现下载事务**

```ts
export type DownloadSkillRequest =
  | { source: 'bundled'; name: string }
  | { source: 'catalog'; name: string; revision: number }

export async function downloadSkillToMine(
  profileDir: string,
  request: DownloadSkillRequest,
): Promise<{ skill: LocalSkillInfo; created: boolean; updated: boolean }>
```

按 `source:name` 使用生命周期锁。内置从 `findBundledEntry` 读取；共享先取精确 metadata，再下载同源 archive。`inspectSkillArchive` 后必须同时校验名称、预算和 `inspected.digest === metadata.digest`，再写入 `profileDir` 下 staging，原子 rename 到用户技能根，最后写本地来源和摘要。任何失败清理 staging，不写启用键。

同名规则在 Host 内判定，不信任 UI：同来源同摘要返回 `created:false`；同来源旧 revision 且本地未修改允许显式更新；其他同名返回 `local-skill-conflict`。

- [x] **Step 4: 接线 RPC 并返回本地投影**

```ts
'skill.download': post('/huaanwork/skill/download')
```

路由只接受 source/name/revision，拒绝客户端 path 和 URL；成功返回 `{ skill, created, updated }`，冲突返回结构化 `local-skill-conflict`。Task 7 路由总数 **75 → 76**；`route-contract.spec.ts` 成对登记 `skill.download` 必选 `['skill', 'created', 'updated']`，`routes.spec.ts` 与 `api.spec.ts` 同步数量和方法表。幂等命中为 `created:false, updated:false`，显式更新为 `created:false, updated:true`。

- [x] **Step 5: 跑下载与路由测试**

Run: `corepack yarn workspace dsh-plugin-huaanwork exec vitest run tests/huaanwork-host/skill-catalog-download.spec.ts tests/huaanwork-host/routes.spec.ts tests/huaanwork-host/route-contract.spec.ts tests/client-huaanwork/api.spec.ts tests/huaanwork-host/market-routes.spec.ts`

Expected: PASS。

- [x] **Step 6: 提交下载能力**

```bash
git add dsh-plugin-huaanwork/src/huaanwork-host/skill-catalog-download.ts dsh-plugin-huaanwork/tests/huaanwork-host/skill-catalog-download.spec.ts dsh-plugin-huaanwork/src/huaanwork-host/routes.ts dsh-plugin-huaanwork/src/client-huaanwork/api.ts dsh-plugin-huaanwork/src/client-huaanwork/rpc-types.ts dsh-plugin-huaanwork/tests/huaanwork-host/routes.spec.ts dsh-plugin-huaanwork/tests/huaanwork-host/route-contract.spec.ts dsh-plugin-huaanwork/tests/client-huaanwork/api.spec.ts dsh-plugin-huaanwork/tests/huaanwork-host/market-routes.spec.ts
git commit -m "feat(skills): download center skills as disabled local copies"
```

---

### Task 8: 我的技能上传即发布

**Files:**
- Create: `dsh-plugin-huaanwork/src/huaanwork-host/skill-catalog-upload.ts`
- Create: `dsh-plugin-huaanwork/tests/huaanwork-host/skill-catalog-upload.spec.ts`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/skill-catalog-client.ts`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/routes.ts`
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/api.ts`
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/rpc-types.ts`
- Modify: `dsh-plugin-huaanwork/tests/huaanwork-host/skill-catalog-client.spec.ts`
- Modify: `dsh-plugin-huaanwork/tests/huaanwork-host/routes.spec.ts`
- Modify: `dsh-plugin-huaanwork/tests/huaanwork-host/route-contract.spec.ts`
- Modify: `dsh-plugin-huaanwork/tests/client-huaanwork/api.spec.ts`
- Modify: `dsh-plugin-huaanwork/tests/huaanwork-host/market-routes.spec.ts`（ROUTE_TABLE 总数同步）

**Interfaces:**
- Consumes: Task 1 归档；Task 2 本地状态；Task 6 settings/client；Task 5 POST API。
- Produces: `uploadLocalSkill(profileDir, name)`、`SkillCatalogClient.publishSkill`、`skill.upload`。

- [x] **Step 1: 写上传失败测试**

```ts
test('uploads a local snapshot without changing its enable state', async () => {
  const profileDir = makeHome()
  writeLocalSkill(profileDir, 'demo', '正文')
  setUserSkillToggle(profileDir, 'demo', true)
  const result = await uploadLocalSkill(profileDir, 'demo')
  expect(result.skill.publishedRevision).toBe(1)
  expect(result.skill.publishState).toBe('published')
  expect(readUserSkillToggles(profileDir).demo).toBe(true)
})
```

另覆盖完整资源上传、外部磁盘修改重算摘要、首次发布、同摘要重试、原作者更新、非 owner 冲突、expected revision 过期、上传期间继续编辑后显示 modified、空上传 token、与当前内置同名的首次发布拒绝、客户端不能提交任意 path、上传失败不改本地发布状态。

- [x] **Step 2: 运行上传测试确认失败**

Run: `corepack yarn workspace dsh-plugin-huaanwork exec vitest run tests/huaanwork-host/skill-catalog-upload.spec.ts tests/huaanwork-host/skill-catalog-client.spec.ts -t "upload|publish"`

Expected: FAIL，上传模块与 client 方法尚不存在。

- [x] **Step 3: 实现本地快照和发布**

```ts
export async function uploadLocalSkill(
  profileDir: string,
  name: string,
): Promise<{ skill: LocalSkillInfo; created: boolean }>

publishSkill(
  name: string,
  archive: Buffer,
  expectedRevision: number | undefined,
): Promise<{ skill: SkillRevisionSummary; created: boolean }>
```

Host 只按 name 在用户根定位技能，读取完整目录并重新计算摘要；若磁盘摘要变化，先刷新本地 `contentDigest`。首次上传不带 expected revision；已有 `publishedRevision` 时带该值，而不是盲目使用服务器最新值。上传 token 只从 settings 读取，不进 RPC 参数。

- [x] **Step 4: 接线上传结果和状态**

```ts
'skill.upload': post('/huaanwork/skill/upload')
```

成功后写 `publishedRevision/publishedDigest`，再与上传后磁盘摘要比较：相同为 `published`，不同为 `modified`。Task 8 路由总数 **76 → 77**；`route-contract.spec.ts` 成对登记 `skill.upload` 必选 `['skill', 'created']`，`routes.spec.ts` 与 `api.spec.ts` 同步数量和方法表。服务端冲突原样映射为 `skill-already-exists/skill-name-conflict/skill-revision-conflict`；不得回显 token 或原始服务端 body。

- [x] **Step 5: 跑上传、下载与目录回归**

Run: `corepack yarn workspace dsh-plugin-huaanwork exec vitest run tests/huaanwork-host/skill-catalog-upload.spec.ts tests/huaanwork-host/skill-catalog-client.spec.ts tests/huaanwork-host/skill-catalog-download.spec.ts tests/huaanwork-host/routes.spec.ts tests/huaanwork-host/route-contract.spec.ts tests/client-huaanwork/api.spec.ts tests/huaanwork-host/market-routes.spec.ts`

Expected: PASS。

- [x] **Step 6: 提交上传能力**

```bash
git add dsh-plugin-huaanwork/src/huaanwork-host/skill-catalog-upload.ts dsh-plugin-huaanwork/src/huaanwork-host/skill-catalog-client.ts dsh-plugin-huaanwork/tests/huaanwork-host/skill-catalog-upload.spec.ts dsh-plugin-huaanwork/tests/huaanwork-host/skill-catalog-client.spec.ts dsh-plugin-huaanwork/src/huaanwork-host/routes.ts dsh-plugin-huaanwork/src/client-huaanwork/api.ts dsh-plugin-huaanwork/src/client-huaanwork/rpc-types.ts dsh-plugin-huaanwork/tests/huaanwork-host/routes.spec.ts dsh-plugin-huaanwork/tests/huaanwork-host/route-contract.spec.ts dsh-plugin-huaanwork/tests/client-huaanwork/api.spec.ts dsh-plugin-huaanwork/tests/huaanwork-host/market-routes.spec.ts
git commit -m "feat(skills): publish local skills to the intranet center"
```

---

### Task 9: 两标签 UI、按钮状态与 `/` 目录切换

**Files:**
- Create: `dsh-plugin-huaanwork/src/huaanwork-host/skill-duplicate.ts`
- Create: `dsh-plugin-huaanwork/tests/huaanwork-host/skill-duplicate.spec.ts`
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/SkillsView.tsx`
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/logic/skillsLogic.ts`
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/App.tsx`
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/SlashSkillMenu.tsx`
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/api.ts`
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/rpc-types.ts`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/routes.ts`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/skills-host.ts`（详情/预览/写结果投影闭合）
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/skill-invoke.ts`（详情类型同步）
- Modify: `dsh-plugin-huaanwork/tests/client-huaanwork/skillsLogic.spec.ts`
- Modify: `dsh-plugin-huaanwork/tests/client-huaanwork/api.spec.ts`
- Modify: `dsh-plugin-huaanwork/tests/huaanwork-host/market-routes.spec.ts`（ROUTE_TABLE 总数同步）
- Modify: `dsh-plugin-huaanwork/tests/huaanwork-host/route-contract.spec.ts`
- Modify: `dsh-plugin-huaanwork/tests/huaanwork-host/routes.spec.ts`
- Modify: `dsh-plugin-huaanwork/tests/huaanwork-host/agent-package-creation.spec.ts`

**Interfaces:**
- Consumes: Task 6 三个读 RPC；Task 7 下载；Task 8 上传；Task 2 用户启停与本地投影。
- Produces: `SkillTab = "center" | "mine"`、`SKILL_TABS`、`filterCenterSkills`、`filterLocalSkills`、`centerActionLabel`、`uploadActionLabel`、`originLabel`、`SkillDetail` 读模型、`duplicateLocalSkill`、`skill.duplicate`、只消费 `skill.invocableList` 的斜杠菜单。

- [x] **Step 1: 写 UI 纯逻辑失败测试**

```ts
test('only center and mine tabs remain', () => {
  assert.deepEqual(SKILL_TABS, ['center', 'mine'])
  assert.equal(tabLabel('center'), '技能中心')
  assert.equal(tabLabel('mine'), '我的技能')
})

test('download and upload labels are independent from enablement', () => {
  assert.equal(centerActionLabel('available'), '下载')
  assert.equal(centerActionLabel('downloaded'), '已下载')
  assert.equal(centerActionLabel('update-available'), '更新')
  assert.equal(centerActionLabel('local-conflict'), '本地有修改')
  assert.equal(centerActionLabel('not-applicable'), '系统技能·始终启用')
  assert.equal(uploadActionLabel('not-published'), '上传')
  assert.equal(uploadActionLabel('published'), '已上传')
  assert.equal(uploadActionLabel('modified'), '更新上传')
})
```

另覆盖页内搜索、中心不含 user、我的不含 catalog、系统技能无下载、中心无启用按钮、用户技能有启停和上传、导入/创建只在 mine、busy key 为 `source:name`；内置同名副本上传禁用/冲突提示与“另存为新技能”入口；`SlashSkillMenu` 空态指向“我的技能”。文案与渲染断言按规格原文：创建/导入/下载成功为“请在“我的技能”中启用”，系统技能状态为“系统技能·始终启用”，`originLabel` 四个徽标为“创建/导入/内置副本/共享副本”，我的技能空态保留创建入口并给导入指引，共享卡展示发布者/revision/更新时间，中心有“刷新”动作。

- [x] **Step 2: 运行客户端逻辑测试确认失败**

Run: `corepack yarn workspace dsh-plugin-huaanwork exec vitest run tests/client-huaanwork/skillsLogic.spec.ts`

Expected: FAIL，旧四标签和 bundled-only 开关仍存在。

- [x] **Step 3: 改造 SkillsView 与状态投影**

```ts
export const SKILL_TABS = ['center', 'mine'] as const
const [tab, setTab] = useState<SkillTab>('center')
const [centerSkills, setCenterSkills] = useState<CenterSkillInfo[]>([])
const [localSkills, setLocalSkills] = useState<LocalSkillInfo[]>([])
const [centerSearch, setCenterSearch] = useState('')
const [localSearch, setLocalSearch] = useState('')
```

中心调用 `skill.centerList`，我的调用 `skill.mineList`；下载/上传/启停成功后只刷新受影响数据。移除中心普通 bundled 启用按钮和 external 分支；顶部本地入口文案改为“导入技能”。保留 view/create/edit/delete/import 的现有表单校验与错误回显。纯函数签名固定为：

```ts
export function filterCenterSkills(skills: readonly CenterSkillInfo[], query: string): CenterSkillInfo[]
export function filterLocalSkills(skills: readonly LocalSkillInfo[], query: string): LocalSkillInfo[]
export function centerActionLabel(state: SkillDownloadState): string
export function uploadActionLabel(state: LocalSkillInfo['publishState']): string
export function originLabel(origin: SkillOrigin): string
```

`sourceLabel` 只用于中心来源徽标：`bundled='内置'`、`catalog='共享'`、`user='我的技能'`；本地卡片的创建/导入/副本徽标由 `originLabel` 提供。创建/导入表单的 `takenNames` 只传本地名称与系统/内部保留名，Host 仍做权威复检。

`SkillFormModal` 移除“禁止用户手动调用”复选框，`SkillFormValues` 删除 `userInvocable`，创建/更新 RPC 不再提交该字段；`disableModelInvocation` 复选框保留。查看/编辑回填可继续携带 `SkillDetail.userInvocable` 作为原始元数据，但 UI 不展示为可编辑开关，Host 更新时按 Task 2 规则保留原 frontmatter。

`App.tsx` 给 `<SkillsView refreshSignal={agentChangeSignal} onInvocableChanged={refreshSlashCatalog} />` 接线：设置保存后技能中心重拉 `skill.centerList`；下载/启停/删除/另存为成功后即时刷新 `slashCatalog`，不依赖视图切换。若引入 SSE 分支，必须放在 `agent/changed` 处理块之后，不插入 `appWiring.spec.ts` 的 `agent/notice`→`agent/changed` 切片区。`SlashSkillMenu` 的 `skills` prop 改为 `InvocableSkillInfo[]`，空态文案改为“没有已启用的技能。到‘我的技能’打开开关。”

全部反馈文案改用规格 §5.4 原文，逐字一致：创建“已保存技能 <name>，请在“我的技能”中启用”、导入“已导入技能 <name>，请在“我的技能”中启用”、下载“已下载技能 <name>，请在“我的技能”中启用”、启用“已启用技能 <name>，可在对话框输入 / 调用”、禁用“已禁用技能 <name>”、上传“已发布技能 <name>（revision <n>）”。表单副标题不得再写“新会话即可使用”；启停提示不得再写“新会话生效”（现有 `SkillsView.tsx:121` 即此句，必须一并替换）。内置同名本地副本的上传按钮禁用并提示“与内置技能同名，请另存为新技能后上传”；卡片/编辑弹窗提供“另存为新技能”，调用 `skill.duplicate` 复制完整正文与资源，新副本 `origin.kind='created'`、默认未启用。

渲染与入口要求（规格 §5.1–§5.3）：共享卡展示发布者、revision、更新时间三项；技能中心提供“刷新”动作，重拉 `skill.centerList`；`originLabel` 钉死四个徽标“创建/导入/内置副本/共享副本”；我的技能无条目且无搜索词时保留创建入口并增加导入指引。重写卡片时保留现有 `` key={`${skill.source}:${skill.name}` `` 的复合 key，不得退化为只按名称，避免同名内置卡与共享卡叠成一张。

- [x] **Step 4: 切换 `/` 目录并删除旧聚合接口**

`App.tsx` 改为调用 `skill.invocableList`；`slashSkills` 只负责查询和排序，不再把 user/external 视为默认可调用。删除 `skill.list` 的客户端 ROUTES、Host ROUTE_TABLE、RpcRequest 成员和旧三源合并 handler；删除 `SkillSource.external`、`canToggleSkill`、`isSkillInvocable` 的旧语义及其测试。共享中心查看传递 `source:'catalog'` 与 `revision`。

用独立读模型替换旧 `SkillInfo/SkillDetail`，避免 Host 详情被迫携带列表 UI 状态：

```ts
export type SkillDetail = {
  name: string
  description: string
  source: SkillSource
  whenToUse?: string
  content: string
  disableModelInvocation?: boolean
  userInvocable?: boolean
  origin?: SkillOrigin
  enabled?: boolean
}

export type SkillWriteResult =
  | { ok: true; skill: LocalSkillInfo }
  | { ok: false; fieldErrors: SkillFieldError[] }
```

`SkillImportPreview` 继续使用 `SkillDetail`，但导入结果来源固定为 user；所有旧 `SkillInfo` 消费者同步改为具体投影。`SkillDetail.userInvocable` 仅作为原始 frontmatter 元数据保留，不进入表单，也不参与 `skill.invocableList` 或 `resolveInvocableSkill` 判定。

同步闭合 Host 读路径：`skills-host.ts` 的 `getSkill`、`previewSkillImport`、`listUserSkills` 与写结果按上述类型返回；`skill-invoke.ts` 的 `InvocableSkill.skill` 使用 `SkillDetail`；`getSkill` 不计算 `downloadState/publishState`。新增 `duplicateLocalSkill(profileDir, sourceName, targetName)`：校验目标名、复制完整目录/扁平文件、写 `origin.kind='created'` 与摘要、不写启用键。新增 RPC：

```ts
'skill.duplicate': post('/huaanwork/skill/duplicate')
```

Task 9 删除 `skill.list` 并新增 `skill.duplicate`，路由总数 **77 → 77**；`route-contract.spec.ts` 成对登记 `skill.duplicate` 必选 `['skill']`。旧 `skill.list` 测试必须迁移：`agent-package-creation.spec.ts` 的内部技能隐藏改测 `skill.centerList/skill.invocableList`；`api.spec.ts` 的 HTTP 405 用例改用 `skill.mineList`；`routes.spec.ts` 的 ENOTDIR 用例改用 `skill.mineList/skill.centerList`；`routes.spec.ts:1041-1075` 的“skill 域 list 三源合并”集成用例改测 `skill.centerList`（内置带 downloadState）与 `skill.mineList`（本地带 enabled），删除对 `/huaanwork/skill/list` 的直接 fetch。

- [x] **Step 5: 跑客户端与路由契约测试**

Run: `corepack yarn workspace dsh-plugin-huaanwork exec vitest run tests/client-huaanwork/skillsLogic.spec.ts tests/client-huaanwork/api.spec.ts tests/huaanwork-host/route-contract.spec.ts tests/huaanwork-host/routes.spec.ts tests/huaanwork-host/skill-duplicate.spec.ts tests/huaanwork-host/agent-package-creation.spec.ts tests/huaanwork-host/market-routes.spec.ts`

Run: `corepack yarn workspace dsh-plugin-huaanwork typecheck`

Expected: PASS，旧 `all/external` 标签与 `skill.list` 在活跃源码和测试中无消费者；Host 详情/预览/写结果类型闭合。

- [x] **Step 6: 提交两标签 UI**

```bash
git add dsh-plugin-huaanwork/src/huaanwork-host/skill-duplicate.ts dsh-plugin-huaanwork/tests/huaanwork-host/skill-duplicate.spec.ts dsh-plugin-huaanwork/src/client-huaanwork/SkillsView.tsx dsh-plugin-huaanwork/src/client-huaanwork/logic/skillsLogic.ts dsh-plugin-huaanwork/src/client-huaanwork/App.tsx dsh-plugin-huaanwork/src/client-huaanwork/SlashSkillMenu.tsx dsh-plugin-huaanwork/src/client-huaanwork/api.ts dsh-plugin-huaanwork/src/client-huaanwork/rpc-types.ts dsh-plugin-huaanwork/src/huaanwork-host/routes.ts dsh-plugin-huaanwork/src/huaanwork-host/skills-host.ts dsh-plugin-huaanwork/src/huaanwork-host/skill-invoke.ts dsh-plugin-huaanwork/tests/client-huaanwork/skillsLogic.spec.ts dsh-plugin-huaanwork/tests/client-huaanwork/api.spec.ts dsh-plugin-huaanwork/tests/huaanwork-host/route-contract.spec.ts dsh-plugin-huaanwork/tests/huaanwork-host/routes.spec.ts dsh-plugin-huaanwork/tests/huaanwork-host/agent-package-creation.spec.ts dsh-plugin-huaanwork/tests/huaanwork-host/market-routes.spec.ts
git commit -m "feat(skills): consolidate the skill center and my skills tabs"
```

---

### Task 10: 用户与部署文档同步

**Files:**
- Modify: `docs/user-guide.md`
- Modify: `docs/user-guide.en.md`
- Create: `docs/skill-center.md`
- Create: `docs/skill-center.en.md`
- Create: `docs/skill-center.i18n.yaml`

**Interfaces:**
- Consumes: Task 9 最终 UI 文案；Task 5 服务端环境变量与 API。
- Produces: 用户操作说明、服务端部署/备份说明和双语文档一致性。

- [x] **Step 1: 写文档事实检查清单并确认旧文档缺口**

清单逐项覆盖：两标签、默认中心、下载后默认禁用、启用后 `/` 可见、外部导入、上传即发布、独立上传口令、owner/revision 冲突、离线行为、`<dataDir>/skills/` 备份、无审核/签名承诺。

Run: `corepack yarn check:bilingual-docs`

Expected: PASS，先确认文档基线健康；若基线已失败，停止并记录既有阻断，不把既有失败归因于本任务。

- [x] **Step 2: 更新中文用户指南**

在用户指南增加技能中心章节，明确“导入技能”和“上传”不是同一动作；给出下载→启用→`/` 调用和创建→上传→他人下载两条流程。说明系统技能始终启用、外部旧文件不会删除、中心不可用不影响本地。

- [x] **Step 3: 写服务端部署说明并同步英文**

`docs/skill-center.md` 与 `.en.md` 记录：

```bash
AGENT_CATALOG_SKILL_UPLOADERS="{\"alice\":\"${ALICE_SKILL_TOKEN}\",\"bob\":\"${BOB_SKILL_TOKEN}\"}"
```

文档要求运维先生成并注入 `ALICE_SKILL_TOKEN`、`BOB_SKILL_TOKEN`，每个至少 32 字符且互不相同；示例不写真实 token。说明 read token 复用、上传 token 与智能体 publish token 隔离、token 丢失轮换、技能状态/归档/审计备份和损坏状态 fail-closed。

生成并提交 `docs/skill-center.i18n.yaml`，把 `docs/skill-center.md/.en.md` 纳入 `check:bilingual-docs`。`docs/user-guide.md/.en.md` 当前未被 `*.i18n.yaml` 纳管，本轮只同步内容并在文档中写明该历史范围；若要把用户指南整体纳管，另立任务。

- [x] **Step 4: 跑双语文档门禁**

`bilingual-docs.mjs` 用 `git ls-files` 扫描 `*.i18n.yaml`，未暂存的新文件会被跳过导致假绿。运行门禁前先暂存新配对记录：

Run: `git add -N docs/skill-center.i18n.yaml docs/skill-center.md docs/skill-center.en.md`

Run: `corepack yarn check:bilingual-docs`

Expected: PASS，且确认门禁实际校验了 `skill-center` 配对（记录 recordCount/documentCount 非零增量）。

- [x] **Step 5: 提交文档**

```bash
git add docs/user-guide.md docs/user-guide.en.md docs/skill-center.md docs/skill-center.en.md docs/skill-center.i18n.yaml
git commit -m "docs(skills): document the shared skill center workflow"
```

---

### Task 11: 全量门禁、双客户端真机验收与证据收口

**Files:**
- Create: `docs/evidence/2026-11-14-skill-center-catalog.md`
- Modify: `docs/superpowers/specs/2026-11-14-skill-center-catalog-design.md`（仅在验收完成后更新状态与证据指针）
- Modify: `docs/superpowers/plans/2026-11-14-skill-center-catalog.md`（勾选已完成步骤）

**Interfaces:**
- Consumes: Task 1–10 的最终代码树与文档。
- Produces: 可复核的命令退出码、自动化结果、真机矩阵、BLOCKED 项和最终状态。

- [x] **Step 1: 执行最终工作区门禁并记录原始退出码**

```bash
corepack yarn typecheck
corepack yarn test
corepack yarn check
```

每条命令单独记录开始时间、结束时间、退出码和关键计数；不得用较早任务的通过结果替代最终树结果。若 `verify:aa` 触发已知并发竞争，先停止并行门禁，再单独重跑该步骤并记录原因，不跳过检查。

- [ ] **Step 2: 启动隔离的内网目录服务与两个桌面 Profile**

使用测试数据目录和两个不同上传者 token，不连接生产 profile，不替换 `/Applications`。服务端配置 `alice`、`bob` 两个技能上传者；客户端 A 使用 alice token，客户端 B 使用 bob token，read token 相同。记录服务地址、Profile 路径和构建提交。

- [ ] **Step 3: 执行双向流转与防绕过验收**

按规格 §14.2 逐项执行并保存证据：A 上传 revision 1；A/B 中心可见；B 下载后默认禁用；手工 `/demo` 被 Host 拒绝；B 启用后 `/` 可见且资源目录正确；禁用后再次拒绝；A 更新 revision 2；B 不自动更新；B 更新 A 的名称得到冲突；内置同名副本经“另存为新技能”后可上传；外部导入后启用才可用；断网后本地调用仍可用；设置保存后技能中心刷新，启停后 `/` 目录即时刷新。

同时验证三种 preset 不再扫描真实 `~/.agents/skills`，智能体包 `allowSkills` 不能调用未启用本地技能。

- [ ] **Step 4: 执行平台与升级验收**

macOS 验证真实 UI、目录选择、下载资源、启停、重启恢复和迁移。Windows 有主机时重复同一矩阵；没有主机时在证据中标记 `BLOCKED: no Windows host`，不得写成通过。用隔离 fixture 验证旧用户技能、旧启用内置、同名冲突和外部文件保留。

- [x] **Step 5: 自审规格覆盖与残留**

逐项把规格 R1–R6、§5–§14 映射到实现任务和证据；检查活跃源码无 `all/external` 技能标签、无旧 `skill.list` 消费、无外部 resolver 回退、无普通 bundled 启停恢复。检查文档没有把摘要写成签名、没有把 CI 写成 Windows 真机通过。

- [ ] **Step 6: 更新状态并提交证据**

只有所有必需验收完成或明确记录经 owner 接受的 waiver 后，才把规格状态改为“已实施”。证据文件记录每项 PASS/BLOCKED/waiver、命令退出码和产物位置。

```bash
git add docs/evidence/2026-11-14-skill-center-catalog.md docs/superpowers/specs/2026-11-14-skill-center-catalog-design.md docs/superpowers/plans/2026-11-14-skill-center-catalog.md
git commit -m "docs(skills): record skill center implementation acceptance"
```

## Execution Notes

- 执行前使用 `superpowers:using-git-worktrees` 建立隔离工作区；不要覆盖当前工作树中已有的 `.gitignore` 修改。
- Task 1–5 是后续桌面功能的基础；Task 6–8 必须按顺序执行；Task 9 依赖前八项；Task 10 可与 Task 9 后的浏览器验收并行准备，但最终门禁必须在所有代码改动之后执行。
- 每个任务完成后先做规格符合性审查，再做代码质量审查；发现阻断问题时在同一任务内修复并重新验证。
- 本计划中的提交步骤属于未来实施流程；编写本计划时不执行这些提交。


## Execution Status (2026-11-14)

- Task 1–10 implemented and reviewed (per-task review artifacts under `.superpowers/sdd/2026-11-14-skill-center-catalog/`); final tree gates recorded in `docs/evidence/2026-11-14-skill-center-catalog.md`.
- Task 11 Steps 1 and 5 completed; Step 1 recorded a single pre-existing timing flake in `agent-package-runtime.spec.ts` (isolated rerun green, same suite green inside `yarn check`) with both exit codes retained.
- Task 11 Steps 2–4 (macOS) executed on 2026-11-15 against an isolated catalog server and two sequential profiles (alice/bob identities); the matrix results live in the evidence file §3. Windows remains **BLOCKED** (no host). A controlled legacy-migration fixture and a real-machine `allowSkills` round were added on 2026-11-15 and passed (evidence §3). Step 6 therefore keeps the spec status at “待实施”, not “已实施”, until Windows is verified or the owner accepts a waiver.
