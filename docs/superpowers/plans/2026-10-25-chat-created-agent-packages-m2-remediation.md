# 会话内创建智能体包 M2 评审整改实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 关闭 2026-10-25 M2 代码评审中成立的 19 项 Important 与 7 项 Minor；把 I-20 保留为有触发条件的延后项；在最终 HEAD 重新完成 macOS/Windows 验收，跨机器验收未完成前不宣布 M2 收口。

**Architecture:** 按四条边界推进：① 包格式与目录服务的 fail-closed 解析/预算；② 桌面宿主的事务、生命周期与运行前验签；③ 发布、撤销与 UI 的一致性和可观察性；④ 许可证、验收与范围收口。每项先写回归测试再改实现，Task 之间只通过本计划〈Interfaces〉列出的签名耦合。

**Tech Stack:** Node.js 22/24、TypeScript、node:test / vitest、node-tar 7.5.22、Ed25519、Electron/React（仅 huaanwork 变体）。

**Spec:** 需求与边界以 [M2 实施计划](2026-10-24-chat-created-agent-packages-m2.md) 为准；整改项以 [M2 代码评审](../../specs/2026-10-25-chat-created-agent-packages-m2-code-review.md) 为清单；核实时对评审结论的校准见本计划〈决策门〉。

## Global Constraints

- 工作树：`.worktrees/m2-agent-packages`，分支 `feat/agent-packages-m2`，基线评审 HEAD `1235f0bae24348ceed766b37e30524dab86816e7`。
- 沿用 M2 计划 Global Constraints 全部条款：三凭据分离、私钥只进离线 CLI、服务端/桌面只读公钥 keyring、canonicalJson 与 market-server 逐字节一致、bundle 与解包内容各 ≤5 MiB、归档/目录条目 ≤1024、路径 ≤512 字节、`.signature/` 仅两个文件、未知 key/退休 key/错签/哈希不符 fail-closed。
- 不改 `dsh-plugin-desktop/`、`dsh-plugin-desktop-beta/`、`dsh-desktop-next/`、`deepseek-harness/`、`dsh-community-market/`。**唯一例外**是已经在 M2 diff 中出现的两份 `tests/package.spec.ts`，由决策门 R-M2-2 裁定保留或回退；不得再新增越界改动。
- 不新增第 8 个 RPC：M2 契约固定 `agent.packagePublish/PublishStatus/RequestDelist/Install/Update/Remove/Refresh` 七项，62→69 计数不变。
- 所有自动化测试 headless；不得 skip/todo；不得用 mock 结果冒充真实 HTTP/CLI/子进程链路。
- 错误文案不得包含本地绝对路径、token、私钥或 bundle 内容；新增日志字段必须走白名单或集中 redaction。
- 每个 Task 独立提交；提交前运行该 Task 指定的测试；全部完成后运行本计划〈最终门槛〉。
- I-20 不在本计划实现；`agent.packageDetail` 对未安装卡仍返回摘要详情。任何安装前签名 metadata 的路径需要新 RPC，必须先裁定 R-M2-3。
- 跨机器验收依赖第二台 Windows 机器；没有该机器时只能记录 `BLOCKED`，不得用同机双 Profile 替代。

## 决策门（执行前由用户确认）

| 编号 | 事项 | 推荐裁定 | 若否决 |
|---|---|---|---|
| R-M2-1 | I-5 审计原子性 | **Option A**：非 GET 请求先生成 `requestId` 并写 intent 审计；`store.mutate` 把 `lastMutation` 写进 state；重启时对未闭合 intent 追加对账记录。Option B（完整 durable journal + 自动状态重建）不在本轮。 | 只做 M-2/M-3，I-5 记为“已裁定接受窗口”，评审勾选必须写原因与触发条件。 |
| R-M2-2 | I-18 范围 | **保留**四文件并在 M2 计划追加〈范围裁定〉：两份 desktop `tests/package.spec.ts` 是 12→16 workspace 门禁同步；`market-server/Dockerfile` 与 `docs/market-server-deployment.md` 记录新增运行期依赖。 | 回退四文件会让 16-workspace 门禁变红；若坚持回退，必须同时裁定修改根门禁的替代方案。 |
| R-M2-3 | I-20 | **延后**：未安装卡不提供安装前签名 metadata；触发条件 = 产品明确要求安装前审查，或下一次 UI 功能波。 | 需要新增第 8 个 RPC，M2 的 62→69 契约与 route-contract 计数要同步改。 |
| R-M2-4 | I-4 打包形态 | 先做 Task 12 的 build spike：若 `tar` 被 tsdown 打进 `lib`，扩展 licenses/notices 覆盖 bundled 闭包；若被外置，把 `tar` 加进 huaanwork `dependencies` 并纳入许可证图。 | 不允许“既不在 dependencies 也不在 notices”的第三种状态。 |
| R-M2-5 | I-10 表述 | 保留 600 秒 `settleWithin` 上限；删除“dispose 无超时”的表述，改为“底层 dispose 不可取消且所有失败被吞”；修错误传播。 | 若要真正取消 dispose，需要上游 `SubagentActivationHandle` 提供 abort 语义，超出 M2。 |
| R-M2-6 | I-2 严重度 | 判定 **Medium**：反斜杠在各平台统一拒绝，但规范化后的 `..`/盘符仍被拒，不构成路径穿越；仍按 fail-closed 修复。 | 若坚持 Important，验收标准不变，只是优先级提前。 |

---

### Task 1: 包解析 fail-closed（I-1、I-2）

**Files:**
- Modify: `packages/agent-package-format/src/bundle.ts`
- Test: `packages/agent-package-format/tests/bundle.test.ts`
- Create: `packages/agent-package-format/tests/fixtures/windows-normalization-probe.ts`

**Interfaces:**
- Consumes: `tar` 的 `ReadEntry.header.path`（PAX 覆盖已在该字段生效）与 `ignoredEntry` 事件。
- Produces: `unpackCapped` 对未知 typeflag、解析 warning、坏 checksum、反斜杠原始路径统一拒绝；错误文案仍以 `包结构非法：` 开头。

- [ ] **Step 1: 写失败测试**

在 `bundle.test.ts` 的 `rejects malicious archive entries and duplicates` 后追加：

```ts
test('rejects unknown tar entry types instead of silently ignoring them', async () => {
  const archive = await makeArchive([
    validAgentJson,
    validPersona,
    { name: 'agent.json/extra', type: 'X' as never, content: 'unexpected' },
  ])
  await assert.rejects(
    inspectUnsignedAgentPackageBundle(archive),
    /包结构非法：.*(未知|不支持|忽略)/,
  )
})
```

在文件顶部加入坏 checksum helper 与测试：

```ts
/** Flip one byte in the first header's checksum field, then re-gzip. */
function corruptFirstHeaderChecksum(archive: Buffer): Buffer {
  const raw = gunzipSync(archive)
  // 512-byte header; checksum field is bytes 148..155. Flip one of its digits.
  raw[148] = raw[148] === 0x30 ? 0x31 : 0x30
  return gzipSync(raw)
}

test('rejects archives whose header checksum cannot be trusted', async () => {
  const archive = corruptFirstHeaderChecksum(await makeArchive([validAgentJson, validPersona]))
  await assert.rejects(inspectUnsignedAgentPackageBundle(archive), /包结构非法/)
})
```

Create `tests/fixtures/windows-normalization-probe.ts`：

```ts
/**
 * Run in a child process with TESTING_TAR_FAKE_PLATFORM=win32. If tar's
 * platform normalization happens before validation, the backslash path is
 * accepted and this process exits 1. The fixed implementation rejects it.
 */
import { Buffer } from 'node:buffer'
import { Header, Pack, ReadEntry } from 'tar'
import { inspectUnsignedAgentPackageBundle } from '../../src/index.ts'

const pack = new Pack({ gzip: true, portable: true, noMtime: true, preservePaths: true })
const chunks: Buffer[] = []
const ended = new Promise<Buffer>((resolve, reject) => {
  pack.on('data', (chunk: Buffer) => chunks.push(chunk))
  pack.on('error', reject)
  pack.on('end', () => resolve(Buffer.concat(chunks)))
})
for (const entry of [
  { path: 'agent.json', data: Buffer.from(JSON.stringify({
    schemaVersion: 1, slug: 'weekly-report', displayName: '周报小助手',
    description: '把一周工作整理成周报', version: '1.0.0',
    draftId: '00000000-0000-4000-8000-000000000001',
    createdAt: '2026-10-24T00:00:00.000Z', updatedAt: '2026-10-24T00:00:00.000Z',
    persona: 'persona.md', skill: null, tools: { mode: 'none' }, allowSkills: [],
  })) },
  { path: 'persona.md', data: Buffer.from('你是周报助手') },
  { path: 'skill\\script.mjs', data: Buffer.from('console.log(1)') },
]) {
  const header = new Header({ path: entry.path, type: 'File', size: entry.data.byteLength })
  const readEntry = new ReadEntry(header)
  readEntry.end(entry.data)
  pack.add(readEntry)
}
pack.end()
const archive = await ended
try {
  await inspectUnsignedAgentPackageBundle(archive)
  process.stderr.write('ACCEPTED\n')
  process.exit(1)
} catch (error) {
  if (!String((error as Error).message).includes('反斜杠')) {
    process.stderr.write(`WRONG_ERROR: ${String((error as Error).message)}\n`)
    process.exit(1)
  }
  process.stdout.write('REJECTED\n')
  process.exit(0)
}
```

在 `bundle.test.ts` 追加子进程测试：

```ts
test('rejects raw backslash paths on a Windows-normalizing tar', async () => {
  const result = spawnSync(
    process.execPath,
    ['--experimental-strip-types', 'tests/fixtures/windows-normalization-probe.ts'],
    { cwd: import.meta.dirname, env: { ...process.env, TESTING_TAR_FAKE_PLATFORM: 'win32' }, encoding: 'utf8' },
  )
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /REJECTED/)
})
```

需要 `import { spawnSync } from 'node:child_process'` 与 `import { gunzipSync, gzipSync } from 'node:zlib'`（已导入 `gzipSync`，补 `gunzipSync`）。

- [ ] **Step 2: 运行测试，确认失败**

```bash
cd packages/agent-package-format
node --experimental-strip-types --test tests/bundle.test.ts
```

Expected: 未知 typeflag 用例失败（当前被静默忽略）；坏 checksum 用例失败（当前只 emit warning）；Windows 子进程用例失败（`skill/script.mjs` 被接受）。

- [ ] **Step 3: 实现最小修复**

在 `bundle.ts` 的 `listArchive({...})` 选项中加入 `strict: true`，并在 `parser` 创建后、`source.pipe` 之前加入：

```ts
// Unknown typeflags are delivered as `ignoredEntry` (ReadEntry.ignore=true),
// never as `entry`; without this listener the archive is silently accepted.
parser.on('ignoredEntry', () => fail(structureError('归档包含未知或不支持的条目')))
// strict:true turns recoverable warnings into `error`; this listener is a
// defensive second path for tar versions that still emit `warn`.
parser.on('warn', (_code, message) => fail(structureError(`归档解析警告：${String(message)}`)))
```

在 `onentry` 里、`normalizeEntryPath(entry.path, ...)` 之前加入原始路径检查：

```ts
// tar normalizes `entry.path` on win32 BEFORE this callback; validate the raw
// header path (already PAX-overridden by Header) so a backslash is rejected on
// every platform, not silently rewritten into a POSIX separator.
const rawHeaderPath = (entry as { header?: { path?: unknown } }).header?.path
if (typeof rawHeaderPath === 'string') {
  if (rawHeaderPath.includes('\\')) {
    fail(structureError('路径不得包含反斜杠'))
    return
  }
  if (rawHeaderPath.includes('\0')) {
    fail(structureError('路径不得包含 NUL'))
    return
  }
}
```

注意：`fail()` 已处理 `settled` 与 parser.abort；`onentry` 后续不得继续执行，已有 `return`。

- [ ] **Step 4: 运行测试，确认通过**

```bash
cd packages/agent-package-format
node --experimental-strip-types --test tests/*.test.ts
```

Expected: 全部 PASS。若某个既有负例的期望文案从 `归档无法解析` 变为 warning 文案，只更新测试 regex，不得放宽为“接受”。

- [ ] **Step 5: 提交**

```bash
git add packages/agent-package-format/src/bundle.ts packages/agent-package-format/tests/bundle.test.ts packages/agent-package-format/tests/fixtures/windows-normalization-probe.ts
git commit -m "fix: reject ignored tar entries and raw backslash paths"
```

---

### Task 2: 统一条目预算与签名文档预算（I-3、M-1）

**Files:**
- Modify: `packages/agent-package-format/src/digest.ts`
- Modify: `packages/agent-package-format/src/bundle.ts`
- Modify: `agent-catalog-server/src/submissions.ts:900-930`
- Test: `packages/agent-package-format/tests/bundle.test.ts`
- Test: `packages/agent-package-format/tests/digest.test.ts`
- Test: `agent-catalog-server/tests/submissions.spec.ts`
- Test: `dsh-plugin-huaanwork/tests/huaanwork-host/agent-package-catalog-install.spec.ts`

**Interfaces:**
- Produces in `digest.ts`:
  - `countInstalledPackageEntries(files: readonly Pick<AgentPackageFile, 'path'>[]): number`
  - `countSignedInstalledEntries(files: readonly Pick<AgentPackageFile, 'path'>[]): number`
  - `assertInstalledEntryBudget(files: readonly Pick<AgentPackageFile, 'path'>[]): void`
  - `MAX_SIGNATURE_DOCUMENT_BYTES = 64 * 1024`
- Consumes: `MAX_AGENT_PACKAGE_ENTRIES = 1024` 仍是唯一条目上限。

- [ ] **Step 1: 写失败测试**

在 `packages/agent-package-format/tests/bundle.test.ts` 追加边界测试：

```ts
function contentFiles(count: number): AgentPackageFile[] {
  return [
    { path: 'agent.json', data: Buffer.from(JSON.stringify(VALID_MANIFEST)) },
    { path: 'persona.md', data: Buffer.from(VALID_PERSONA) },
    ...Array.from({ length: count - 2 }, (_, index) => ({
      path: `filler-${String(index).padStart(4, '0')}.md`,
      data: Buffer.alloc(0),
    })),
  ]
}

test('reserves the two signature files and the .signature directory in the 1024-entry budget', async () => {
  // 1022 content + 2 signature + .signature dir + root files = 1025 installed entries.
  const tooMany = await buildUnsignedAgentPackageBundle(contentFiles(1022))
  await assert.rejects(inspectUnsignedAgentPackageBundle(tooMany), /条目数超过1024/)

  // 1021 content + 3 installed entries = 1024: the signed projection is legal.
  const boundary = await buildUnsignedAgentPackageBundle(contentFiles(1021))
  const inspected = await inspectUnsignedAgentPackageBundle(boundary)
  const key = generateKeyPair()
  const signature = signAgentPackageDigest(inspected.digest, {
    privateKeyPem: key.privateKeyPem, slot: 1, signedAt: '2026-10-24T00:00:00.000Z',
  })
  const signed = await buildSignedAgentPackageBundle(
    inspected.files, inspected.digest, signature,
  )
  await assert.doesNotReject(inspectSignedAgentPackageBundle(signed, [
    { keyId: signature.keyId, publicKeyHex: key.publicKeyHex, slot: 1 },
  ]))
})

test('counts implicit parent directories before accepting a signed bundle', async () => {
  const files = [
    { path: 'agent.json', data: Buffer.from(JSON.stringify(VALID_MANIFEST)) },
    { path: 'persona.md', data: Buffer.from(VALID_PERSONA) },
    ...Array.from({ length: 600 }, (_, index) => ({
      path: `nested-${String(index).padStart(3, '0')}/file.md`,
      data: Buffer.alloc(0),
    })),
  ]
  // unsigned build 不预留签名位；拒绝发生在 submit 的 signed projection。
  await assert.rejects(
    inspectUnsignedAgentPackageBundle(await buildUnsignedAgentPackageBundle(files)),
    /条目数超过1024/,
  )
})
```

在 `digest.test.ts` 追加签名文档预算测试：

```ts
test('charges signature documents to the 5 MiB directory budget and caps one document', () => {
  const dir = createValidPackageDir()
  writePackageFiles(dir, {
    '.signature/package-digest.json': Buffer.alloc(1024 * 1024, 0x20),
    '.signature/signature.json': Buffer.from('{}'),
  })
  assert.throws(() => readPackageFiles(dir, { ignoreSignature: true }), /超过.*字节上限/)
  removeTempDir(dir)
})
```

在 `agent-catalog-server/tests/submissions.spec.ts` 追加：

```ts
test('rejects an unsigned submission that cannot fit the signed entry budget', async () => {
  const server = await bootTestAgentCatalog()
  // 使用本文件已有的 submit() helper（它会带 PUBLISH_TOKEN 与 gzip 头）。
  const response = await submit(server, await buildUnsignedAgentPackageBundle(contentFiles(1022)))
  assert.equal(response.status, 400)
  assert.equal(response.body.code, 'invalid-bundle')
  await server.close()
})
```

在 `agent-package-catalog-install.spec.ts` 追加一个 1022 内容文件的 signed bundle：断言 `installCatalogAgentPackage` 拒绝，且正式目录未写入。该测试可复用该文件已有的 `makeSignedBundle`/`publishMetadata` helper；若 helper 只构造两个文件，新增 `makeBundleWithFileCount(count)`。

- [ ] **Step 2: 运行测试，确认失败**

```bash
cd packages/agent-package-format && node --experimental-strip-types --test tests/*.test.ts
cd ../../agent-catalog-server && corepack yarn test -- submissions.spec.ts
cd ../dsh-plugin-huaanwork && corepack yarn test -- agent-package-catalog-install.spec.ts
```

Expected: 1022 内容当前被接受；嵌套 600 目录当前被接受；1 MiB 签名文档当前被读取。

- [ ] **Step 3: 实现**

在 `digest.ts` 增加：

```ts
/** 单份签名文档读取上限。digest/signature 都是小 JSON,64 KiB 足够且防止内存放大。 */
export const MAX_SIGNATURE_DOCUMENT_BYTES = 64 * 1024

/**
 * 安装后目录会被枚举到的全部条目:每个文件本身 + 所有唯一隐式父目录。
 * 传入的 files 必须是最终安装布局(签名包要包含 `.signature/` 两个文件)。
 */
export function countInstalledPackageEntries(
  files: readonly Pick<AgentPackageFile, 'path'>[],
): number {
  const entries = new Set<string>()
  for (const file of files) {
    const segments = file.path.split('/')
    for (let index = 1; index <= segments.length; index += 1) {
      entries.add(segments.slice(0, index).join('/'))
    }
  }
  return entries.size
}

/** unsigned 内容 + 两个签名文件组成的最终安装布局条目数。 */
export function countSignedInstalledEntries(
  files: readonly Pick<AgentPackageFile, 'path'>[],
): number {
  return countInstalledPackageEntries([
    ...files,
    { path: `${SIGNATURE_DIR}/package-digest.json` },
    { path: `${SIGNATURE_DIR}/signature.json` },
  ])
}

export function assertInstalledEntryBudget(
  files: readonly Pick<AgentPackageFile, 'path'>[],
): void {
  if (countInstalledPackageEntries(files) > MAX_AGENT_PACKAGE_ENTRIES) {
    throw structureError(`条目数超过${MAX_AGENT_PACKAGE_ENTRIES}`)
  }
}
```

在 `walkPackageDir` 的签名跳过分支之前计费：

```ts
if (options.ignoreSignature === true && SIGNATURE_FILES.has(relativePath)) {
  state.bytes += stat.size
  if (state.bytes > MAX_PACKAGE_BYTES) {
    throw structureError(`智能体包超过${MAX_PACKAGE_BYTES}字节上限`)
  }
  if (stat.size > MAX_SIGNATURE_DOCUMENT_BYTES) {
    throw structureError(`签名文档超过${MAX_SIGNATURE_DOCUMENT_BYTES}字节上限`)
  }
  continue
}
```

在 `readSignatureDocument` 前加 `statSync` 上限（导入 `statSync`），防御 lstat 与 read 之间的替换。

在 `bundle.ts`：
- `normalizeBuildFiles` 末尾（`assertNoFileAncestors` 之后）对 **signed** 输入调用 `assertInstalledEntryBudget(normalized)`。`allowSignatureFiles === true` 时 `normalized` 已包含两个签名文件；unsigned 输入不在此处预留，由 `inspectUnsigned` 的 signed projection 拒绝。
- `inspectUnsignedAgentPackageBundle` 在 `validateAgentPackageFiles` 之后调用 `assertInstalledEntryBudget([...archive.files, { path: DIGEST_PATH }, { path: SIGNATURE_PATH }])`。
- `inspectSignedAgentPackageBundle` 在拼出 `content` 后调用 `assertInstalledEntryBudget([...content, digestFile, signatureFile])`（digestFile/signatureFile 已非 undefined）。

在 `submissions.ts` 的 `approveSubmission` 里、`buildSignedAgentPackageBundle` 之前加 422 预检：

```ts
if (countSignedInstalledEntries(unsigned.files) > MAX_AGENT_PACKAGE_ENTRIES) {
  return result(422, errorBody('包条目数超过上限', 'package-too-many-entries'), {
    action,
    outcome: 'error',
    reason: `submission ${submissionId} cannot form a signed bundle within ${MAX_AGENT_PACKAGE_ENTRIES} entries`,
    slug,
    version,
    submissionId,
  })
}
```

导入 `countSignedInstalledEntries` 与 `MAX_AGENT_PACKAGE_ENTRIES`。`inspectUnsigned` 的提交拒绝自然走既有 400 `invalid-bundle`。

- [ ] **Step 4: 运行**

```bash
cd packages/agent-package-format && node --experimental-strip-types --test tests/*.test.ts
cd ../../agent-catalog-server && corepack yarn test -- submissions.spec.ts
cd ../dsh-plugin-huaanwork && corepack yarn test -- agent-package-catalog-install.spec.ts
```

Expected: 1021 边界通过；1022 在 submit 400、approve 422；嵌套目录被拒；签名文档超限在读取前被拒。

- [ ] **Step 5: 提交**

```bash
git add packages/agent-package-format/src/digest.ts packages/agent-package-format/src/bundle.ts \
  packages/agent-package-format/tests/digest.test.ts packages/agent-package-format/tests/bundle.test.ts \
  agent-catalog-server/src/submissions.ts agent-catalog-server/tests/submissions.spec.ts \
  dsh-plugin-huaanwork/tests/huaanwork-host/agent-package-catalog-install.spec.ts
git commit -m "fix: unify agent-package entry budgets across submit, sign and install"
```

---

### Task 3: legacy 同名项与解析日志（I-9、M-4）

**Files:**
- Modify: `agent-catalog-server/src/legacy.ts`
- Modify: `agent-catalog-server/src/submissions.ts:369-383,414,493`
- Modify: `agent-catalog-server/src/server.ts:530,547`
- Test: `agent-catalog-server/tests/submissions.spec.ts`
- Test: `agent-catalog-server/tests/auth-legacy.spec.ts`

**Interfaces:**
- Produces: `findEntries(dir, name): LegacyCatalogEntry[]`；`findEntry` 保持“第一个匹配”的旧读行为；`loadEntries(dir, redact?)` 与 `findEntry(dir, name, redact?)` 接受集中 redaction。
- `legacyConflict(entries: readonly LegacyCatalogEntry[], slug, migrationFrom)`：0 项不冲突；>1 项一律冲突；1 项仅 `kind==='agent' && migrationFrom===slug` 合法。

- [ ] **Step 1: 写失败测试**

在 `agent-catalog-server/tests/submissions.spec.ts` 追加表驱动测试：

```ts
test('checks every legacy entry with the same name, independent of file order', async () => {
  const cases = [
    { files: { 'a-agent.json': { name: 'weekly-report', kind: 'agent' }, 'z-tool.json': { name: 'weekly-report', kind: 'tool' } } },
    { files: { 'a-tool.json': { name: 'weekly-report', kind: 'tool' }, 'z-agent.json': { name: 'weekly-report', kind: 'agent' } } },
    { files: { 'a-one.json': { name: 'weekly-report', kind: 'agent' }, 'z-two.json': { name: 'weekly-report', kind: 'agent' } } },
    { files: { 'a-one.json': { name: 'weekly-report', kind: 'tool' }, 'z-two.json': { name: 'weekly-report', kind: 'tool' } } },
  ]
  for (const item of cases) {
    const server = await bootTestAgentCatalog()
    for (const [file, body] of Object.entries(item.files)) {
      await writeFile(join(server.entriesDir, file), JSON.stringify(body))
    }
    const bundle = await makeBundle()
    // 使用本文件已有的 submit() helper；迁移头是 MIGRATION_HEADER。
    const response = await submit(server, bundle.bundle, {
      headers: { 'x-agent-catalog-migration': 'weekly-report' },
    })
    assert.equal(response.status, 409)
    assert.equal(response.body.code, 'legacy-conflict')
    await server.close()
  }
})
```

在 `auth-legacy.spec.ts` 追加 redaction 测试：

```ts
test('redacts secrets in malformed legacy entry diagnostics', async () => {
  const token = 'sk-legacy-secret-0123456789abcdef'
  const pem = '-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----'
  const server = await bootTestAgentCatalog()
  await writeFile(join(server.entriesDir, `${token}.json`), `${token}\n${pem}`)
  const errors: string[] = []
  const spy = vi.spyOn(console, 'error').mockImplementation((...args) => {
    errors.push(args.map(String).join(' '))
  })
  try {
    await server.request('/v1/catalog', { token: READ_TOKEN })
    const joined = errors.join('\n')
    assert.equal(joined.includes(token), false)
    assert.equal(joined.includes('BEGIN PRIVATE KEY'), false)
    assert.match(joined, /\[REDACTED/)
  } finally {
    spy.mockRestore()
    await server.close()
  }
})
```

- [ ] **Step 2: 运行，确认失败**

```bash
cd agent-catalog-server && corepack yarn test -- submissions.spec.ts auth-legacy.spec.ts
```

Expected: agent-first/tool-second 用例被接受（当前只检查第一个）；日志包含 token/PEM。

- [ ] **Step 3: 实现**

`legacy.ts`：

```ts
export type LegacyRedactor = (text: string) => string

const identityRedactor: LegacyRedactor = (text) => text

export function loadEntries(
  dir: string,
  redact: LegacyRedactor = identityRedactor,
): LegacyCatalogEntry[] {
  // 既有逻辑不变；两处 console.error 改为：
  // console.error(redact(`条目文件解析失败,已跳过: ${path} (expected a JSON object)`))
  // console.error(redact(`条目文件解析失败,已跳过: ${path} (${(error as Error).message})`))
}

export function findEntries(
  dir: string,
  name: string,
  redact: LegacyRedactor = identityRedactor,
): LegacyCatalogEntry[] {
  return loadEntries(dir, redact).filter((item) => item.name === name)
}

export function findEntry(
  dir: string,
  name: string,
  redact: LegacyRedactor = identityRedactor,
): LegacyCatalogEntry | undefined {
  return loadEntries(dir, redact).find((item) => item.name === name)
}
```

`submissions.ts`：

```ts
function legacyConflict(
  entries: readonly LegacyCatalogEntry[],
  slug: string,
  migrationFrom: string | undefined,
): Conflict | null {
  if (entries.length === 0) return null
  if (entries.length > 1) {
    return {
      status: 409,
      error: `标识与目录条目冲突：${slug}`,
      code: 'legacy-conflict',
      reason: `${entries.length} legacy entries with the same name occupy ${slug}; the conflict is ambiguous`,
    }
  }
  const entry = entries[0]!
  if (migrationFrom === slug && entry.kind === 'agent') return null
  return {
    status: 409,
    error: `标识与目录条目冲突：${slug}`,
    code: 'legacy-conflict',
    reason: `legacy entry ${slug} (kind ${String(entry.kind)}) already occupies the slug`,
  }
}
```

`evaluateSubmission` 与 `findApproveConflict` 改为 `findEntries(config.entriesDir, slug, redactor)` 并传数组。`redactor` 在 submissions.ts 内由 config 的三个 token 构造：

```ts
const redactor = (text: string): string =>
  redactSecrets(text, [config.readToken, config.publishToken, config.adminToken])
```

导入 `findEntries` 与 `redactSecrets`（`./audit.ts`）。这样提交/批准路径加载 legacy 条目时，畸形文件的日志也不会泄漏秘密。

`server.ts` 的 `catalog.list` 与 legacy get 传 redactor：

```ts
const redact = (text: string): string => redactSecrets(text, secretList(config))
loadEntries(config.entriesDir, redact)
findEntry(config.entriesDir, name, redact)
```

- [ ] **Step 4: 运行**

```bash
cd agent-catalog-server && corepack yarn test -- submissions.spec.ts auth-legacy.spec.ts
```

Expected: 四种排列均 409；日志中 token/PEM 均被替换。

- [ ] **Step 5: 提交**

```bash
git add agent-catalog-server/src/legacy.ts agent-catalog-server/src/submissions.ts agent-catalog-server/src/server.ts \
  agent-catalog-server/tests/submissions.spec.ts agent-catalog-server/tests/auth-legacy.spec.ts
git commit -m "fix: reject ambiguous legacy slug conflicts and redact parser logs"
```

---

### Task 4: 审计原子性、审计 reason 与 state 深度校验（I-5、M-2、M-3）

**Files:**
- Modify: `agent-catalog-server/src/audit.ts`
- Modify: `agent-catalog-server/src/store.ts`
- Modify: `agent-catalog-server/src/types.ts`
- Modify: `agent-catalog-server/src/server.ts`
- Modify: `agent-catalog-server/src/submissions.ts`（所有 `store.update`）
- Modify: `agent-catalog-server/src/governance.ts`（所有 `store.update`）
- Test: `agent-catalog-server/tests/audit.spec.ts`（新建；若已有 audit 测试则并入）
- Test: `agent-catalog-server/tests/store.spec.ts`（新建）
- Test: `agent-catalog-server/tests/submissions.spec.ts`
- Test: `agent-catalog-server/tests/governance.spec.ts`

**Interfaces:**
- `AuditEvent` 新增 `requestId?: string`（结果行仍写 `audit.jsonl`，不改变 `AuditOutcome` 三值枚举）。
- `AuditLog.writeIntent(event: AuditIntent): Promise<void>` 写入独立的 `audit-intents.jsonl`；`AuditLog.reconcile(state: CatalogState): Promise<void>` 读取 intent 日志与结果日志，对未闭合 intent 追加一条结果行。
- `CatalogState` 新增 `lastMutation?: { requestId: string; action: string; at: string }`
- `CatalogStore.mutate<T>(requestId: string, action: string, mutator): Promise<T>`

**R-T4-1（controller ruling）:** intent 不写 `audit.jsonl`，而是写独立的 `audit-intents.jsonl`。原因：现有测试精确断言 `audit.jsonl` 的行数（如 `records.length === 6`），把 intent 混入同一文件会迫使 20 处测试过滤，且会把“每次写请求多一行”变成既有审计契约的变化。独立文件就是 durable intent journal，结果行仍带 `requestId` 供对账。代价：多一个数据文件；对账逻辑要读两个文件。

- [ ] **Step 1: 写失败测试**

`agent-catalog-server/tests/store.spec.ts`：

```ts
test('rejects syntactically valid state with semantic corruption and leaves the file untouched', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'catalog-store-'))
  const path = join(dir, 'state.json')
  const base = emptyCatalogState()
  const cases = [
    { ...base, submissions: { x: null } },
    { ...base, packages: { 'a/1.0.0': { ...publishedRecord(), status: 'unknown' } } },
    { ...base, revocations: { 'wrong/1.0.0': revocationRecord('actual', '1.0.0') } },
  ]
  for (const document of cases) {
    await writeFile(path, `${JSON.stringify(document)}\n`)
    await assert.rejects(CatalogStore.open(dir), StoreCorruptError)
    assert.equal(await readFile(path, 'utf8'), `${JSON.stringify(document)}\n`)
  }
})
```

`agent-catalog-server/tests/audit.spec.ts`：

```ts
test('reconciles an intent that committed before the result record was written', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'catalog-audit-'))
  const audit = await AuditLog.open(dir, [])
  const requestId = randomUUID()
  await audit.writeIntent({
    action: 'agentPackages.submissions.create',
    actor: 'anonymous',
    requestId,
  })
  const state = { ...emptyCatalogState(), lastMutation: { requestId, action: 'agentPackages.submissions.create', at: NOW } }
  await audit.reconcile(state)
  const lines = (await readFile(join(dir, AUDIT_FILE_NAME), 'utf8')).trim().split('\n').map(JSON.parse)
  const result = lines.find((line) => line.requestId === requestId)
  assert.equal(result.outcome, 'ok')
  assert.match(result.reason, /reconciled/)
  // The intent journal is a separate durable file.
  const intents = (await readFile(join(dir, AUDIT_INTENTS_FILE_NAME), 'utf8')).trim().split('\n').map(JSON.parse)
  assert.equal(intents.length, 1)
  assert.equal(intents[0].requestId, requestId)
})

test('reconciles an intent that did not commit as an error', async () => {
  // Same setup, but state.lastMutation.requestId is a different UUID.
  // Assert the appended result is outcome 'error', status 500.
})
```

M-2 断言加在既有 reject/delist 测试里：

```ts
assert.match(await readAuditLine(server.dataDir, 'agentPackages.submissions.reject'), /rejection reason: 证据不足/)
assert.match(await readAuditLine(server.dataDir, 'agentPackages.delistRequests.create'), /验收:演示下架/)
```

- [ ] **Step 2: 运行，确认失败**

```bash
cd agent-catalog-server && corepack yarn test -- store.spec.ts audit.spec.ts submissions.spec.ts governance.spec.ts
```

Expected: store 接受 null/未知 status；reconcile 不存在；reject/delist 审计无 reason。

- [ ] **Step 3: 实现**

`types.ts`：

```ts
export interface CatalogState {
  schemaVersion: 1
  lastMutation?: { requestId: string; action: string; at: string }
  submissions: Record<string, Submission>
  packages: Record<string, PublishedPackage>
  delistRequests: Record<string, DelistRequest>
  revocations: Record<string, Revocation>
}
```

`store.ts` 的 `parseState` 在四个集合的形状检查后逐条校验：

```ts
const submissionStatuses = new Set(['pending-review', 'published', 'rejected'])
const packageStatuses = new Set(['published', 'delisted', 'revoked'])
const delistStatuses = new Set(['pending', 'approved', 'rejected'])
const requireString = (value: unknown, field: string, nonEmpty = true): string => {
  if (typeof value !== 'string' || (nonEmpty && value.length === 0)) {
    throw new StoreCorruptError(path, new Error(`${field} must be a non-empty string`))
  }
  return value
}
const requireObject = (value: unknown, field: string): Record<string, unknown> => {
  if (!isPlainObject(value)) throw new StoreCorruptError(path, new Error(`${field} must be an object`))
  return value
}
for (const [key, record] of Object.entries(document.submissions)) {
  requireObject(record, `submissions.${key}`)
  requireString(record.id, `submissions.${key}.id`)
  requireString(record.slug, `submissions.${key}.slug`)
  requireString(record.version, `submissions.${key}.version`)
  requireString(record.submittedAt, `submissions.${key}.submittedAt`)
  requireString(record.updatedAt, `submissions.${key}.updatedAt`)
  requireString(record.actor, `submissions.${key}.actor`)
  if (!submissionStatuses.has(record.status as string)) throw new StoreCorruptError(path, new Error(`submissions.${key}.status is invalid`))
  requireObject(record.digest, `submissions.${key}.digest`)
}
// packages / delistRequests / revocations 同模式；packages 额外检查
// packageKey(record.slug, record.version) === key，revocations 同样；
// delistRequests 检查 id === key，packages 的 status 是 packageStatuses。
// lastMutation 若存在，校验 requestId/action/at 均为非空字符串。
```

`store.ts` 增加：

```ts
mutate<T>(requestId: string, action: string, mutator: (draft: CatalogState) => T | Promise<T>): Promise<T> {
  return this.update((draft) => {
    draft.lastMutation = { requestId, action, at: new Date().toISOString() }
    return mutator(draft)
  })
}
```

`audit.ts`：

```ts
export const AUDIT_INTENTS_FILE_NAME = 'audit-intents.jsonl'

/** 写请求的 durable intent；不含 outcome/status，结果由 audit.jsonl 的同一 requestId 闭合。 */
export interface AuditIntent {
  readonly action: string
  readonly actor: string
  readonly requestId: string
  readonly slug?: string
  readonly version?: string
  readonly submissionId?: string
  readonly delistRequestId?: string
}

export interface AuditEvent {
  // 既有字段...
  readonly requestId?: string
}
```

`sanitize` 把 `requestId` 写入结果记录（UUID 不是秘密；仍走 redactSecrets 无害）。`writeIntent(intent)` 复用与 `append` 相同的 read+append+tmp+fsync+rename 纪律，写入 `join(dataDir, AUDIT_INTENTS_FILE_NAME)`；其队列与 `writeAudit` 相互独立（两个文件各自串行）。

`AuditLog.reconcile(state)`：

```ts
async reconcile(state: CatalogState): Promise<void> {
  const readLines = async (path: string): Promise<string[]> => {
    try {
      return (await readFile(path, 'utf8')).split('\n').filter(Boolean)
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw cause
    }
  }
  const intentLines = await readLines(join(this.dataDir, AUDIT_INTENTS_FILE_NAME))
  const resultLines = await readLines(this.path)
  const intents = new Map<string, AuditIntent & { timestamp: string }>()
  const results = new Set<string>()
  for (const line of intentLines) {
    try {
      const intent = JSON.parse(line) as AuditIntent & { timestamp: string }
      if (typeof intent.requestId === 'string') intents.set(intent.requestId, intent)
    } catch { /* skip malformed */ }
  }
  for (const line of resultLines) {
    try {
      const record = JSON.parse(line) as AuditRecord
      if (typeof record.requestId === 'string') results.add(record.requestId)
    } catch { /* skip malformed */ }
  }
  for (const [requestId, intent] of intents) {
    if (results.has(requestId)) continue
    const committed = state.lastMutation?.requestId === requestId
    await this.writeAudit({
      action: intent.action,
      outcome: committed ? 'ok' : 'error',
      status: committed ? 200 : 500,
      actor: intent.actor,
      requestId,
      ...(intent.slug === undefined ? {} : { slug: intent.slug }),
      ...(intent.version === undefined ? {} : { version: intent.version }),
      ...(intent.submissionId === undefined ? {} : { submissionId: intent.submissionId }),
      ...(intent.delistRequestId === undefined ? {} : { delistRequestId: intent.delistRequestId }),
      reason: committed
        ? 'reconciled after restart: state.lastMutation matches the intent'
        : 'reconciled after restart: state.lastMutation does not name this intent (a later mutation may have overwritten it)',
    })
  }
}
```

`AuditLog` 需要保存 `dataDir`（构造器当前只保存 `path`；加 `private readonly dataDir` 或从 `dirname(this.path)` 推导）。

`server.ts`：
- `createAgentCatalogRuntime` 在打开 store/audit 后 `await audit.reconcile(store.read())`。
- `handleRequest` 在 audit unavailable gate 之后、`dispatch` 之前：

```ts
const requestId = randomUUID()
if (method !== 'GET' && method !== 'HEAD') {
  try {
    await runtime.audit.writeIntent({
      action: route.id,
      actor,
      requestId,
      ...routeAuditContext(route),
    })
  } catch {
    sendJson(response, 500, errorBody('审计写入失败', 'audit-write-failed'))
    return
  }
}
result = await dispatch(route, { request, runtime, config, role: identity, actor, requestId })
```

- `finish` 的 `AuditEvent` 带 `requestId`；所有请求生成 requestId（包括 GET），只有非 GET 写 intent。`finish` 的每个既有调用点都要传 `requestId`（auth/route/method 错误分支也传；它们没有 intent，reconcile 会忽略）。
- `DispatchContext` 与 handler context 增加 `requestId`；`submissionContext`/`governanceContext` 展开它。
- 把以下 7 处 `store.update(draft => ...)` 改为 `store.mutate(context.requestId, action, draft => ...)`：
  - `submissions.ts:620`（create）、`:965`（approve）、`:1059`（reject）
  - `governance.ts:304`（create delist）、`:423`（approve delist）、`:508`（reject delist）、`:575`（revoke）
  用 `grep -n "store.update" agent-catalog-server/src/{submissions,governance}.ts` 确认无遗漏；读 handler 不需要改。
- M-2：reject 成功审计加 `reason: \`rejection reason: ${reason}\``；delist `created` 分支加 `reason: outcome.request.reason`。确保 `reason` 已经过 `redactSecrets`（finish 的 sanitize 会做）。

- [ ] **Step 4: 运行**

```bash
cd agent-catalog-server && corepack yarn test
```

Expected: 全绿；新增 reconcile/state 测试通过；审计行包含 intent/result 与 reason。

- [ ] **Step 5: 提交**

```bash
git add agent-catalog-server/src/{audit,store,types,server,submissions,governance}.ts \
  agent-catalog-server/tests/{audit,store,submissions,governance}.spec.ts
git commit -m "fix: bind catalog mutations to durable audit intents and validate state"
```

---

### Task 5: 撤销分页、完整追平与畸形条目 fail-closed（I-6、I-12）

**Files:**
- Modify: `agent-catalog-server/src/types.ts`（`RevocationListBody.nextCursor?`）
- Modify: `agent-catalog-server/src/governance.ts:617-640`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/agent-package/catalog-client.ts`（`getRevocations` 分页循环）
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/agent-package/catalog-security.ts`（warning 已存在，补分页上限 warning）
- Test: `agent-catalog-server/tests/governance.spec.ts`
- Test: `dsh-plugin-huaanwork/tests/huaanwork-host/agent-package-catalog-security.spec.ts`

**Interfaces:**
- Server: `GET /v1/agent-packages/revocations?cursor=<opaque>&limit=<1..200>` → `{ items, nextCursor? }`；默认 200；无效 cursor/limit → 400 `invalid-cursor`/`invalid-limit`。
- Client: `getRevocations(): Promise<AgentPackageRevocation[]>` 自动追平所有页；单页失败/任一条目畸形 → 整体 reject；`refreshRevocations` 保留旧缓存并返回 warning。

- [ ] **Step 1: 写失败测试**

Server（governance.spec.ts）：

```ts
test('pages the revocation list and never exceeds the JSON cap', async () => {
  const server = await bootTestAgentCatalog()
  // 直接写 state：1500 条 800 字节 reason，总 JSON > 1 MiB。
  await seedRevocations(server.dataDir, 1500, 800)
  let cursor: string | undefined
  let total = 0
  for (let page = 0; page < 10; page += 1) {
    const query = `limit=200${cursor === undefined ? '' : `&cursor=${encodeURIComponent(cursor)}`}`
    const response = await server.request(`/v1/agent-packages/revocations?${query}`, { token: READ_TOKEN })
    assert.equal(response.status, 200)
    assert.ok(Buffer.byteLength(JSON.stringify(response.body)) < 1024 * 1024)
    total += response.body.items.length
    cursor = response.body.nextCursor
    if (cursor === undefined) break
  }
  assert.equal(total, 1500)
  await server.close()
})

test('rejects an invalid revocation cursor with 400', async () => {
  const server = await bootTestAgentCatalog()
  const response = await server.request('/v1/agent-packages/revocations?cursor=not-a-cursor', {
    token: READ_TOKEN,
  })
  assert.equal(response.status, 400)
  assert.equal(response.body.code, 'invalid-cursor')
  await server.close()
})
```

Client（agent-package-catalog-security.spec.ts）：

```ts
test('keeps the previous revocation cache when any page is malformed', async () => {
  // fake client: page 1 valid, page 2 has {slug:'x', version:1} (wrong type).
  // 先成功刷新一次写入缓存；再让 client 返回坏页；refreshRevocations 返回 warning。
  // 断言缓存字节与第一次完全相同，且 warning 可见。
})
```

- [ ] **Step 2: 运行，确认失败**

```bash
cd agent-catalog-server && corepack yarn test -- governance.spec.ts
cd ../dsh-plugin-huaanwork && corepack yarn test -- agent-package-catalog-security.spec.ts
```

Expected: 1500 条时单页响应超 1 MiB → 500；客户端畸形条目被 `continue` 后覆盖缓存。

- [ ] **Step 3: 实现**

Server `governance.ts`：

```ts
const REVOCATION_PAGE_DEFAULT = 200
const REVOCATION_PAGE_MAX = 200

function encodeRevocationCursor(record: RevocationListEntry): string {
  return Buffer.from(JSON.stringify({
    revokedAt: record.revokedAt, slug: record.slug, version: record.version,
  }), 'utf8').toString('base64url')
}

function decodeRevocationCursor(raw: string | null): { revokedAt: string; slug: string; version: string } | null {
  if (raw === null || raw === '') return null
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown
    if (!isRecord(parsed)) return null
    const { revokedAt, slug, version } = parsed
    if (typeof revokedAt !== 'string' || typeof slug !== 'string' || typeof version !== 'string') return null
    return { revokedAt, slug, version }
  } catch {
    return null
  }
}

export async function listRevocations(context: GovernanceHandlerContext): Promise<HandlerResult> {
  const action = ACTIONS.revocations
  const url = new URL(context.request.url ?? '/', 'http://localhost')
  const cursor = decodeRevocationCursor(url.searchParams.get('cursor'))
  if (url.searchParams.get('cursor') !== null && cursor === null) {
    return result(400, errorBody('撤销游标无效', 'invalid-cursor'), { action, outcome: 'error', reason: 'invalid revocation cursor' })
  }
  const rawLimit = url.searchParams.get('limit')
  const limit = rawLimit === null ? REVOCATION_PAGE_DEFAULT : Number(rawLimit)
  if (!Number.isInteger(limit) || limit < 1 || limit > REVOCATION_PAGE_MAX) {
    return result(400, errorBody('撤销分页大小无效', 'invalid-limit'), { action, outcome: 'error', reason: `invalid revocation limit: ${String(rawLimit)}` })
  }
  const sorted = Object.values(context.store.read().revocations)
    .sort(compareRevocations)
    .map(projectRevocation)
  const start = cursor === null
    ? 0
    : sorted.findIndex((item) => compareRevocationCursor(item, cursor) > 0)
  const page = sorted.slice(start === -1 ? sorted.length : start, (start === -1 ? sorted.length : start) + limit)
  const hasMore = (start === -1 ? sorted.length : start) + page.length < sorted.length
  return result(200, {
    items: page,
    ...(hasMore ? { nextCursor: encodeRevocationCursor(page[page.length - 1]!) } : {}),
  }, { action, outcome: 'ok' })
}
```

`compareRevocationCursor` 按 `(revokedAt, slug, version)` 字典序；`compareRevocations` 复用同一比较。保留既有 `actor` 投影。

分页上限只有在单条可控时才成立：在 `revokePackage` 的 reason 校验处增加

```ts
const MAX_REVOCATION_REASON_BYTES = 4096
if (Buffer.byteLength(reason, 'utf8') > MAX_REVOCATION_REASON_BYTES) {
  return result(400, errorBody('撤销原因过长', 'reason-too-long'), { action, outcome: 'error', ... })
}
```

200 条 × 4 KiB = 800 KiB，低于 1 MiB 响应帽；测试加一条 4097 字节 reason 的 400 用例。

Client `catalog-client.ts`：

```ts
const REVOCATION_PAGE_LIMIT = 200
const MAX_REVOCATION_PAGES = 500

async getRevocations(): Promise<AgentPackageRevocation[]> {
  const { rootUrl, settings } = await catalogRoot()
  const token = optionalToken(settings.agents_catalog_token)
  const all: AgentPackageRevocation[] = []
  let cursor: string | undefined
  for (let page = 0; page < MAX_REVOCATION_PAGES; page += 1) {
    const query = new URLSearchParams({ limit: String(REVOCATION_PAGE_LIMIT) })
    if (cursor !== undefined) query.set('cursor', cursor)
    const { body } = await requestJson(
      `${rootUrl}/v1/agent-packages/revocations?${query.toString()}`,
      token,
      { method: 'GET' },
    )
    const { items, nextCursor } = normalizeRevocationsPage(body)
    all.push(...items)
    cursor = nextCursor
    if (cursor === undefined) return all
  }
  throw new AgentCatalogClientError('撤销列表分页超过上限', 'invalid-response')
}
```

`normalizeRevocations` 改为：任一条目畸形即 `throw new AgentCatalogClientError('目录响应格式错误', 'invalid-response')`（不要 `continue`）；`normalizeRevocationsPage` 校验 `nextCursor` 为非空字符串或 undefined。

`catalog-security.ts`：`refreshRevocations` 的 catch 已保留缓存；分页失败会走该分支。无需额外改，补一条测试确认。

- [ ] **Step 4: 运行**

```bash
cd agent-catalog-server && corepack yarn test -- governance.spec.ts
cd ../dsh-plugin-huaanwork && corepack yarn test -- agent-package-catalog-security.spec.ts
```

Expected: 1500 条分页每页 <1 MiB 且总数一致；坏 cursor 400；畸形第二页保留旧缓存。

- [ ] **Step 5: 提交**

```bash
git add agent-catalog-server/src/{types,governance}.ts agent-catalog-server/tests/governance.spec.ts \
  dsh-plugin-huaanwork/src/huaanwork-host/agent-package/{catalog-client,catalog-security}.ts \
  dsh-plugin-huaanwork/tests/huaanwork-host/agent-package-catalog-security.spec.ts
git commit -m "fix: page revocation sync and fail closed on malformed entries"
```

---

### Task 6: 崩溃恢复时签名与 bundle 字节一致（I-7）

**Files:**
- Modify: `agent-catalog-server/src/submissions.ts:940-990`
- Test: `agent-catalog-server/tests/submissions.spec.ts`

**Interfaces:**
- `PublishedPackage.signature` 必须等于最终保留的 signed bundle 内实际验出的 `CatalogSignature`；采用既有 bundle 时使用 `inspected.signature`，不使用本次请求的签名。

- [ ] **Step 1: 写失败测试**

```ts
test('persists the adopted bundle signature, not the retried request signature', async () => {
  const server = await bootTestAgentCatalog()
  const made = await makeBundle()
  const submitted = await submit(server, made.bundle)
  const submissionId = submitted.body.submissionId as string
  const signatureA = sign(server, submitted.body.digest, { signedAt: '2026-10-24T00:00:00.000Z' })
  const inspectedA = await inspectUnsignedAgentPackageBundle(made.bundle)
  const bundleA = await buildSignedAgentPackageBundle(inspectedA.files, inspectedA.digest, signatureA)
  // 模拟 crashed after rename, before state commit: 手工把 A 的 signed bundle 放到 finalPath。
  await mkdir(join(server.dataDir, 'packages', made.manifest.slug, made.manifest.version), { recursive: true })
  await writeFile(
    packageBundlePath(server.dataDir, made.manifest.slug, made.manifest.version),
    bundleA,
  )
  // 用不同 signedAt 的 B 重试 approve。
  const signatureB = sign(server, submitted.body.digest, { signedAt: '2026-10-25T00:00:00.000Z' })
  const response = await approve(server, submissionId, signatureB)
  assert.equal(response.status, 200)
  const state = JSON.parse(await readFile(join(server.dataDir, 'state.json'), 'utf8'))
  assert.equal(
    state.packages[`${made.manifest.slug}/${made.manifest.version}`].signature.signedAt,
    '2026-10-24T00:00:00.000Z',
  )
  const downloaded = await server.request(
    `/v1/agent-packages/${made.manifest.slug}/${made.manifest.version}/bundle`,
    { token: READ_TOKEN },
  )
  const verified = await inspectSignedAgentPackageBundle(downloaded.buffer, server.keyringEntries)
  assert.equal(verified.signature.signedAt, '2026-10-24T00:00:00.000Z')
  await server.close()
})
```

- [ ] **Step 2: 运行，确认失败**

```bash
cd agent-catalog-server && corepack yarn test -- submissions.spec.ts
```

Expected: state 的 signature 是 B 的 `signedAt`，而 bundle 是 A。

- [ ] **Step 3: 实现**

`approveSubmission` 中：

```ts
let finalBundle: Buffer = signed
let effectiveSignature = signature
// ... existing 分支：
if (existing !== null) {
  let inspected: Awaited<ReturnType<typeof inspectSignedAgentPackageBundle>> | undefined
  try {
    inspected = await inspectSignedAgentPackageBundle(existing, context.config.keyring)
    identical = sameDigest(inspected.digest, current.digest)
  } catch {
    identical = false
  }
  if (!identical || inspected === undefined) return { kind: 'bundle-conflict' as const }
  finalBundle = existing
  effectiveSignature = inspected.signature
} else {
  await writeFileAtomic(finalPath, signed)
}
```

state 写入 `signature: effectiveSignature`。approve 的结果审计 reason 在 `existing !== null` 时附 `adopted existing signed bundle; signature ${effectiveSignature.keyId}`。

- [ ] **Step 4: 运行**

```bash
cd agent-catalog-server && corepack yarn test -- submissions.spec.ts
```

Expected: 下载 bundle 验签得到的 signature 与 state 完全相同。

- [ ] **Step 5: 提交**

```bash
git add agent-catalog-server/src/submissions.ts agent-catalog-server/tests/submissions.spec.ts
git commit -m "fix: keep published metadata bound to the adopted bundle signature"
```

---

### Task 7: CLI 与验收探针的集中 redaction（I-8）

**Files:**
- Create: `agent-catalog-admin/src/redaction.ts`
- Modify: `agent-catalog-admin/src/cli.ts:366-410`
- Modify: `dsh-plugin-huaanwork/scripts/huaanwork-agent-package-m2-acceptance.mjs:340-370,1228-1250`
- Test: `agent-catalog-admin/tests/cli.spec.ts`
- Test: `dsh-plugin-huaanwork/tests/huaanwork-host/agent-package-m2-redaction.spec.ts`（新建，纯函数测试）

**Interfaces:**
- `redactSecrets(text: string, secrets: readonly string[]): string`：最长优先替换、PEM/未闭合 PEM 全块替换；与 `agent-catalog-server/src/audit.ts` 的行为逐字一致。
- CLI `runCli` 在 `execute` 与所有错误分支使用 `safeIo`；探针的 `requireCliOk` 在抛出前先扫描，失败文本经 `redactSecrets`。

- [ ] **Step 1: 写失败测试**

`agent-catalog-admin/tests/cli.spec.ts` 追加：

```ts
test('redacts catalog tokens and PEM blocks from review output and errors', async () => {
  const token = 'test-publish-token-0123456789abcdef'
  const env = { ...baseEnv, AGENT_CATALOG_PUBLISH_TOKEN: token }
  // fixture 的 manifest.description 包含 token；远端错误正文也包含 token。
  const result = await runCliInProcess(['review', 'sub-1', '--out', dir], env)
  assert.equal(result.stdout.includes(token), false)
  assert.equal(result.stderr.includes(token), false)
  assert.match(result.stdout, /\[REDACTED\]/)

  const failing = await runCliInProcess(['reject', 'sub-1', '--reason', 'x'], {
    ...env, AGENT_CATALOG_URL: `http://127.0.0.1:1/${token}`,
  })
  assert.equal(failing.stderr.includes(token), false)
})
```

`agent-package-m2-redaction.spec.ts`：

```ts
import { redactSecrets } from '../../scripts/acceptance-redaction.mjs'

test('redacts tokens and PEM blocks before a failure report is written', () => {
  const secret = 'sk-live-0123456789abcdef'
  const pem = '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----'
  const text = redactSecrets(`failed ${secret} ${pem}`, [secret])
  assert.equal(text.includes(secret), false)
  assert.equal(text.includes('BEGIN PRIVATE KEY'), false)
  assert.match(text, /\[REDACTED/)
})
```

- [ ] **Step 2: 运行，确认失败**

```bash
cd agent-catalog-admin && corepack yarn test -- cli.spec.ts
cd ../dsh-plugin-huaanwork && corepack yarn test -- agent-package-m2-redaction.spec.ts
```

Expected: token 出现在 stdout/stderr；探针 helper 不存在。

- [ ] **Step 3: 实现**

`redaction.ts` 复制 `audit.ts` 的 `PRIVATE_KEY_BLOCK_PATTERN`、`UNTERMINATED_PRIVATE_KEY_PATTERN`、`redactSecrets`（注释写明与 server 版本保持逐字一致；两包不互相依赖）。

`cli.ts` 的 `runCli`：

```ts
const secrets = [env.AGENT_CATALOG_ADMIN_TOKEN, env.AGENT_CATALOG_TOKEN, env.AGENT_CATALOG_PUBLISH_TOKEN]
  .filter((value): value is string => typeof value === 'string' && value.length > 0)
const safeIo: CliIo = {
  stdout: (text) => io.stdout(redactSecrets(text, secrets)),
  stderr: (text) => io.stderr(redactSecrets(text, secrets)),
}
```

把 `execute(args, env, io)`、所有 `io.stderr(...)` 改成 `safeIo`；`execute` 内部的 `io` 参数也替换为 `safeIo`。这样 manifest、远端错误、路径、PEM 都在离开进程前 redact。

探针创建 `scripts/acceptance-redaction.mjs`（导出同一个 `redactSecrets`）。在 `runProbe` 开始时维护 `activeSecrets.push(...)`；`requireCliOk`：

```js
function requireCliOk(invocation, secrets) {
  if (invocation.exitCode !== 0) {
    const combined = `${invocation.stderr}\n${invocation.stdout}`
    if (secrets.some((secret) => secret.length >= 16 && combined.includes(secret))
      || /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.test(combined)) {
      throw new Error(`CLI ${invocation.args[0]} failed and its output contained a secret (redacted)`)
    }
    throw new Error(
      `CLI ${invocation.args[0]} exited ${String(invocation.exitCode)}: ` +
        redactSecrets(combined.trim(), secrets),
    )
  }
  // 成功路径保留既有扫描；再加 PEM 扫描。
  if (/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.test(invocation.stdout + invocation.stderr)) {
    throw new Error(`CLI ${invocation.args[0]} printed a private key`)
  }
  // 既有 token 扫描...
}
```

`report.error = redactSecrets(errorText(probeError), activeSecrets)`；`writeSummary` 不写自由文本，无需改。

- [ ] **Step 4: 运行**

```bash
cd agent-catalog-admin && corepack yarn test -- cli.spec.ts
cd ../dsh-plugin-huaanwork && corepack yarn test -- agent-package-m2-redaction.spec.ts
```

Expected: 所有输出无 token/PEM；成功路径扫描不变。

- [ ] **Step 5: 提交**

```bash
git add agent-catalog-admin/src/{redaction,cli}.ts agent-catalog-admin/tests/cli.spec.ts \
  dsh-plugin-huaanwork/scripts/{acceptance-redaction.mjs,huaanwork-agent-package-m2-acceptance.mjs} \
  dsh-plugin-huaanwork/tests/huaanwork-host/agent-package-m2-redaction.spec.ts
git commit -m "fix: redact secrets from CLI output and acceptance failure reports"
```

---

### Task 8: 取消/停止失败传播与 per-slug 生命周期门禁（I-10、I-11）

**Files:**
- Create: `dsh-plugin-huaanwork/src/huaanwork-host/agent-package/lifecycle.ts`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/agent-package/host.ts:94-160,280-300,555-576,623-712`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/agent-package/catalog-install.ts:154-240,380-440,650-700`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/agent-package/catalog-client.ts:292-330`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/index.ts:194-260`
- Test: `dsh-plugin-huaanwork/tests/huaanwork-host/agent-package-lifecycle.spec.ts`（新建）
- Test: `dsh-plugin-huaanwork/tests/huaanwork-host/host-runtime-dispose.spec.ts`

**Interfaces:**
- `createAgentPackageLifecycleLock(): AgentPackageLifecycleLock`，含 `isBusy(slug): boolean` 与 `run<T>(slug, label, fn): Promise<T>`。
- `AgentCatalogBinding.lifecycle: AgentPackageLifecycleLock`（`configureAgentCatalog` 未传时自建，生产在 `index.ts` 注入共享实例）。
- `CreateAgentPackageHostOptions` 新增 `lifecycle?: AgentPackageLifecycleLock` 与 `cleanupTimeoutMs?: number`（默认 `ACTIVATION_CLEANUP_TIMEOUT_MS`）。
- `cancelMatching` 在任一 record.cancel 失败时抛出聚合错误；`cleanup('cancel')` 在 dispose/stop 失败或超时时抛出；`cleanup('idle')` 只记录日志。

- [ ] **Step 1: 写失败测试**

`agent-package-lifecycle.spec.ts`：

```ts
test('a same-slug update blocks a new dispatch until the whole transaction finishes', async () => {
  const deferred = createDeferred<void>()
  const binding = configureTestCatalog() // 注入 lifecycle + fake client
  const lifecycle = binding.lifecycle
  let busyDuringStop = false
  const stopTurns: AgentPackageTurnStopper = async () => {
    busyDuringStop = lifecycle.isBusy('weekly-report')
    await deferred.promise
  }
  const update = updateCatalogAgentPackage('weekly-report', stopTurns)
  await Promise.resolve()
  assert.equal(busyDuringStop, true)
  await assert.rejects(
    host.dispatch({ ...dispatchInput('weekly-report'), pkg: installedPackage() }),
    /正在更新/,
  )
  deferred.resolve()
  await update
  assert.equal(lifecycle.isBusy('weekly-report'), false)
})

test('a rejected stopTurns aborts update before the directory is renamed', async () => {
  const before = snapshotTree(formalDir)
  await assert.rejects(
    updateCatalogAgentPackage('weekly-report', async () => { throw new Error('stop failed') }),
    /stop failed|停止/,
  )
  assert.deepEqual(snapshotTree(formalDir), before)
})
```

`host-runtime-dispose.spec.ts` 追加：

```ts
test('reports a dispose timeout from the cancel path instead of silently claiming cleanup succeeded', async () => {
  // R-T8-1: idle `afterIdle()` logs cleanup failures; only cancel/update/remove
  // propagate them to the caller, which is the path update/remove use.
  const activeTurns = createAgentPackageActiveTurnRegistry()
  createAgentPackageHost({
    ...options,
    activeTurns,
    cleanupTimeoutMs: 20,
    createRuntime: async () => runtimeWithActivationThatNeverDisposes(),
  })
  await host.dispatch(dispatchInputWithEnabledPackage())
  await assert.rejects(
    activeTurns.cancelBySlug('weekly-report', 'remove'),
    /清理失败|dispose/,
  )
})
```

- [ ] **Step 2: 运行，确认失败**

```bash
cd dsh-plugin-huaanwork && corepack yarn test -- agent-package-lifecycle.spec.ts host-runtime-dispose.spec.ts
```

Expected: 更新期间 dispatch 成功；stopTurns 失败仍 rename；dispose 超时被吞。

- [ ] **Step 3: 实现**

`lifecycle.ts`：

```ts
export type AgentPackageLifecycleLock = {
  isBusy(slug: string): boolean
  run<T>(slug: string, label: string, fn: () => Promise<T>): Promise<T>
}

export function createAgentPackageLifecycleLock(): AgentPackageLifecycleLock {
  const busy = new Map<string, string>()
  return {
    isBusy: (slug) => busy.has(slug),
    async run(slug, label, fn) {
      const current = busy.get(slug)
      if (current !== undefined) throw new Error(`智能体「${slug}」正在${current}，请稍后重试`)
      busy.set(slug, label)
      try { return await fn() } finally { if (busy.get(slug) === label) busy.delete(slug) }
    },
  }
}
```

`catalog-client.ts` 的 binding 增加 `lifecycle`；`configureAgentCatalog` 使用 `options.lifecycle ?? createAgentPackageLifecycleLock()`。`index.ts` 创建共享实例并同时传给 `configureAgentCatalog` 与 `createAgentPackageHost`。

`host.ts` 的 `dispatch` 在 `pendingTurns` 检查之前：

```ts
if (options.lifecycle?.isBusy(pkg.slug)) {
  throw new Error(`智能体「${pkg.slug}」正在更新或移除，请稍后重试`)
}
```

`catalog-install.ts`：把现有 `runCatalogInstall`/`runCatalogUpdate`/`runCatalogRemove` 的 body 原样移入 `runCatalogInstallLocked`/`runCatalogUpdateLocked`/`runCatalogRemoveLocked`，新包装：

```ts
async function runCatalogUpdate(binding, slug, stopTurns) {
  return binding.lifecycle.run(slug, '更新', () => runCatalogUpdateLocked(binding, slug, stopTurns))
}
```

install/remove 同理（label `安装`/`移除`）。门禁必须在 `stopTurns` 之前获取，并覆盖到 rename/state commit 完成。

`host.ts` 的 clean-up 失败传播：

```ts
const cleanupFailures: Error[] = []
const asError = (value: unknown): Error => value instanceof Error ? value : new Error(String(value))
const disposeActivation = (handle) => {
  disposePromise ??= (async () => {
    try { await handle.dispose() } catch (error) { cleanupFailures.push(asError(error)); throw error }
  })()
  return disposePromise
}
const stopTurnRuntime = (current) => {
  stopRuntimePromise ??= (async () => {
    try { await stopRuntime(current) } catch (error) { cleanupFailures.push(asError(error)); throw error }
  })()
  return stopRuntimePromise
}
```

`cleanup(mode: 'idle' | 'cancel')`：每次 `settleWithin(disposeActivation(...), timeout)` 返回 false 时 push `new Error('activation dispose timed out')`；`stopTurnRuntime` 同样。`finally unregister` 之后：

```ts
if (cleanupFailures.length > 0) {
  const error = new Error(`智能体「${pkg.slug}」清理失败（${cleanupFailures.length} 项）`)
  if (mode === 'cancel') throw error
  console.error(error.message)
}
```

`cancelTurn` 调 `cleanup('cancel')`；`afterIdle: () => cleanup('idle')`。`cancelMatching`：

```ts
const failures: Error[] = []
await Promise.all(matching.map(async (record) => {
  try { await record.cancel(reason) } catch (error) { failures.push(asError(error)) }
}))
if (failures.length > 0) throw new Error(`停止智能体回合失败（${failures.length} 个）`)
```

`refreshRevocations` 调用 `registry.cancelBySlug` 的三处包 try/catch：失败时 `parts.push('中止在途回合失败：…')`，不阻断缓存写入/应用。`cleanupTimeoutMs` 通过 `createAgentPackageHost` 选项贯穿所有 `settleWithin`。

- [ ] **Step 4: 运行**

```bash
cd dsh-plugin-huaanwork && corepack yarn test -- agent-package-lifecycle.spec.ts host-runtime-dispose.spec.ts \
  agent-package-catalog-install.spec.ts agent-package-catalog-security.spec.ts
```

Expected: 更新期间 dispatch 拒绝；stop 失败不 rename；dispose 超时/拒绝/多条记录均上报；撤销仍应用缓存但带 warning。

- [ ] **Step 5: 提交**

```bash
git add dsh-plugin-huaanwork/src/huaanwork-host/agent-package/{lifecycle.ts,host.ts,catalog-install.ts,catalog-client.ts} \
  dsh-plugin-huaanwork/src/huaanwork-host/index.ts \
  dsh-plugin-huaanwork/tests/huaanwork-host/{agent-package-lifecycle.spec.ts,host-runtime-dispose.spec.ts}
git commit -m "fix: serialize package transactions and propagate cleanup failures"
```

---

### Task 9: 运行前身份绑定、恢复守卫与损坏包判定（I-13、I-14、M-5）

**Files:**
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/agent-package/catalog-security.ts:73-166,300-315`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/agent-package/catalog-install.ts:720-800`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/agent-package/host.ts:418-450`
- Test: `dsh-plugin-huaanwork/tests/huaanwork-host/agent-package-catalog-security.spec.ts`
- Test: `dsh-plugin-huaanwork/tests/huaanwork-host/agent-package-catalog-install.spec.ts`
- Test: `dsh-plugin-huaanwork/tests/huaanwork-host/agent-package-runtime.spec.ts`

**Interfaces:**
- `AgentCatalogSecurity.verifyInstalledSync(slug): AgentPackageVerification`（使用真实 `verifyAgentPackageDirectory`，不经过测试 seam）。
- `assertRunnable(slug, version)` 在返回前核对 state 的 `installedVersion`、`digest.slug/version` 与再次验签的 digest 一致。
- `recoverInstall` 在没有有效 formal、stagingPackage、oldDir 时不删除 legacy/transaction。
- `setEnabled` 对 catalog 包启用前做同步验签；`invocableWithLegacy` 使用 `decorateCatalogItem`（异步验签）。

- [ ] **Step 1: 写失败测试**

`agent-package-catalog-security.spec.ts`：

```ts
test('refuses to run when the directory is a valid signed v2 but state says v1', async () => {
  // state: catalog:weekly-report.installedVersion = '1.0.0'
  // formal dir: valid signed 1.0.1 (keyring accepted)
  await assert.rejects(security.assertRunnable('weekly-report', '1.0.0'), /包校验失败/)
})

test('refuses to run when the verified digest changes between checks', async () => {
  // verify hook: first call returns v1, second call swaps the directory to v2.
  // assertRunnable must reject instead of returning ok.
})
```

`agent-package-catalog-install.spec.ts`：

```ts
test('keeps the legacy key and transaction when no package or backup can be restored', () => {
  // committed state + missing formal/stagingPackage/oldDirs + legacy key present.
  recoverCatalogPackageInstalls(profileDir)
  assert.equal(readLegacyEnabled(profileDir)['weekly-report'], true)
  assert.equal(existsSync(transactionPath), true)
})
```

`agent-package-runtime.spec.ts`：

```ts
test('does not enable or list a signature-invalid catalog package', async () => {
  // structurally valid package, tampered persona after signing, state disabled.
  assert.throws(() => host.setEnabled('weekly-report', true), /包校验失败/)
  const invocable = await host.invocableWithLegacy()
  assert.equal(invocable.items.some((item) => item.name === 'weekly-report'), false)
  // disabling a previously enabled broken package remains allowed.
})
```

- [ ] **Step 2: 运行，确认失败**

```bash
cd dsh-plugin-huaanwork && corepack yarn test -- agent-package-catalog-security.spec.ts \
  agent-package-catalog-install.spec.ts agent-package-runtime.spec.ts
```

Expected: v2 目录被运行；缺失包仍删 legacy；损坏包可启用/出现在补全。

- [ ] **Step 3: 实现**

`catalog-security.ts`：

```ts
const verifyInstalledSync = (slug: string): AgentPackageVerification => {
  if (keyring === undefined) return { ok: false, reason: AGENT_PACKAGE_VERIFY_FAILURE }
  try {
    const verified = verifyAgentPackageDirectory(agentPackageDir(profileDir, slug), keyring)
    return { ok: true, digest: verified.digest, signature: verified.signature }
  } catch {
    return { ok: false, reason: AGENT_PACKAGE_VERIFY_FAILURE }
  }
}
```

`assertRunnable`：

```ts
const entry = readAgentPackageState(profileDir)[`catalog:${slug}`]
if (entry === undefined || entry.source !== 'catalog' || entry.installedVersion !== version) {
  throw new Error(AGENT_PACKAGE_VERIFY_FAILURE)
}
for (let attempt = 0; attempt < MAX_ASSERT_ATTEMPTS; attempt += 1) {
  const snapshot = generation
  const revoked = revocationFor(slug, version)
  if (revoked !== undefined) throw new Error(agentPackageRevokedMessage(revoked))
  const verification = await verifyInstalled(slug)
  if (!verification.ok) throw new Error(AGENT_PACKAGE_VERIFY_FAILURE)
  if (verification.digest.slug !== slug || verification.digest.version !== version) {
    throw new Error(AGENT_PACKAGE_VERIFY_FAILURE)
  }
  const recheck = await verifyInstalled(slug)
  if (!recheck.ok || canonicalJson(recheck.digest) !== canonicalJson(verification.digest)) {
    throw new Error(AGENT_PACKAGE_VERIFY_FAILURE)
  }
  if (snapshot === generation) return
}
throw new Error(AGENT_PACKAGE_VERIFY_FAILURE)
```

把 `verifyInstalledSync` 加入返回对象与类型。导入 `canonicalJson`、`verifyAgentPackageDirectory` 已在文件中。

`catalog-install.ts` 的 `recoverInstall` committed 分支按“先恢复、后删证据”重排：

```ts
const formalVersion = pathExists(formal) ? readAgentPackageVersionFromDir(formal) : undefined
const formalValid = formalVersion === transaction.targetVersion

// 1) 正式目录缺失时先尝试重建：staging package 优先，其次 .old-*。
if (!formalValid) {
  if (pathExists(stagingPackage)) {
    try { renameSync(stagingPackage, formal) } catch { /* 保留证据 */ }
  } else if (oldDirs.length > 0) {
    try { renameSync(oldDirs[0]!, formal) } catch { /* 保留证据 */ }
  }
}

// 2) 仍无有效正式目录：保留 legacy、staging、old 与 transaction，供下次恢复。
const restoredVersion = pathExists(formal) ? readAgentPackageVersionFromDir(formal) : undefined
if (restoredVersion !== transaction.targetVersion) {
  logRecover('recover.missing', slug, new Error('no valid package and restore failed'))
  return
}

// 3) 只有到这里才允许删 legacy；失败仍走 rollbackCommittedInstall。
if (transaction.migrationFrom !== undefined) {
  deleteLegacyEnabledKey(profileDir, `${LEGACY_KEY_PREFIX}${transaction.migrationFrom}`)
}

// 4) 清理 staging/oldDirs（成功路径）。
removeQuietly(staging)
for (const oldDir of oldDirs) removeQuietly(oldDir)
```

若 `formal` 存在但版本不是 target（磁盘旧、state 新），保留既有 `restoreTransactionState` 分支；该分支之外不得清理旧的 `.old-*` 证据。

`host.ts` 的 `setEnabled`：

```ts
if (enabled && stored.source === 'catalog') {
  if (security === undefined) throw new Error(AGENT_PACKAGE_VERIFY_FAILURE)
  const verdict = security.verifyInstalledSync(slug)
  if (!verdict.ok) throw new Error(`智能体 @${slug} 已损坏:${verdict.reason}`)
}
```

`invocableWithLegacy` 改为：

```ts
const packages = await Promise.all(
  listLocalAgentPackages(profileDir).map((item) => decorateCatalogItem(item)),
)
const localItems = packages
  .filter((pkg) => pkg.enabled && pkg.broken === undefined)
  .map(toInvocableListItem)
```

`listLocal()`/`detail()` 保持同步（UI 需要展示损坏/启用态）；`@` 补全与 `findInvocable` 走验签路径。禁用操作不受影响。

- [ ] **Step 4: 运行**

```bash
cd dsh-plugin-huaanwork && corepack yarn test -- agent-package-catalog-security.spec.ts \
  agent-package-catalog-install.spec.ts agent-package-runtime.spec.ts
```

Expected: v2/state v1 拒绝；digest 变化拒绝；缺失包保留 legacy+transaction；损坏包不可启用/不在补全，仍可关闭。

- [ ] **Step 5: 提交**

```bash
git add dsh-plugin-huaanwork/src/huaanwork-host/agent-package/{catalog-security,catalog-install,host}.ts \
  dsh-plugin-huaanwork/tests/huaanwork-host/{agent-package-catalog-security,agent-package-catalog-install,agent-package-runtime}.spec.ts
git commit -m "fix: bind runtime verification to the installed identity and guard recovery"
```

---

### Task 10: 发布/提交一致性与幂等提交复位（I-15、I-16）

**Files:**
- Create: `dsh-plugin-huaanwork/src/huaanwork-host/agent-package/publish-lock.ts`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/agent-package/catalog-publish.ts:100-180`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/agent-package/drafts.ts:230-310`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/agent-package/catalog-client.ts:100-130,180-270`
- Modify: `agent-catalog-server/src/types.ts`（`Submission.idempotencyKey?`）
- Modify: `agent-catalog-server/src/submissions.ts:559-650`
- Test: `dsh-plugin-huaanwork/tests/huaanwork-host/agent-package-catalog-publish.spec.ts`
- Test: `dsh-plugin-huaanwork/tests/huaanwork-host/agent-package-drafts.spec.ts`
- Test: `agent-catalog-server/tests/submissions.spec.ts`

**Interfaces:**
- `AgentCatalogClient.submit(bundle, options?: { idempotencyKey?: string })`；请求头 `X-Agent-Catalog-Idempotency-Key`。
- 服务端 `POST /v1/agent-packages/submissions`：同一 key + 同 slug/version + 同 digest → 200 返回现有 submission；不同内容/版本 → 409 `idempotency-conflict`。
- 本地 sidecar `${profileDir}/agent-catalog-pending-submissions.json`：`{ [slug]: { submissionId: string; version: string; digestSha256: string; idempotencyKey: string; createdAt: string } }`。
- `createAgentPackagePublishLock()` 提供 `run<T>(profileDir, slug, fn)`，供 publish 与 commit 共用。

- [ ] **Step 1: 写失败测试**

Server：

```ts
test('replays a submission for the same idempotency key and content', async () => {
  const server = await bootTestAgentCatalog()
  const sameKey = '11111111-1111-4111-8111-111111111111'
  const firstBundle = await makeBundle()
  const otherBundle = await makeBundle({ version: '1.0.1' })
  const first = await submit(server, firstBundle.bundle, {
    headers: { 'x-agent-catalog-idempotency-key': sameKey },
  })
  const second = await submit(server, firstBundle.bundle, {
    headers: { 'x-agent-catalog-idempotency-key': sameKey },
  })
  assert.equal(first.status, 201)
  assert.equal(second.status, 200)
  assert.equal(second.body.submissionId, first.body.submissionId)
  const conflict = await submit(server, otherBundle.bundle, {
    headers: { 'x-agent-catalog-idempotency-key': sameKey },
  })
  assert.equal(conflict.status, 409)
  assert.equal(conflict.body.code, 'idempotency-conflict')
  await server.close()
})
```

Desktop publish：

```ts
test('records the remote submission before a local state failure and reuses it on retry', async () => {
  // client.submit records the id; writeAgentPackageState throws once;
  // publish rejects with the id in the sidecar; retry with the same content
  // returns the same submissionId and clears the sidecar.
})

test('does not submit twice when the content changes during upload', async () => {
  // deferred submit; commit new content while upload in flight; publish must
  // either wait for commit (lock) or persist the old submission and surface it.
})
```

Drafts：

```ts
test('an idempotent commit retry resets publication before deleting the draft', async () => {
  // write the package + state publishStatus 'published' + keep the draft;
  // commit with the same draftId; state.publishStatus === 'none',
  // submissionId cleared, draft removed.
})

test('keeps the draft when the publication reset fails', async () => {
  // fault-inject reset failure; commit refuses and the draft remains.
})
```

- [ ] **Step 2: 运行，确认失败**

```bash
cd agent-catalog-server && corepack yarn test -- submissions.spec.ts
cd ../dsh-plugin-huaanwork && corepack yarn test -- agent-package-catalog-publish.spec.ts agent-package-drafts.spec.ts
```

Expected: 重复 key 创建第二条 submission；状态写失败后 remote ID 丢失；commit 重试跳过 reset。

- [ ] **Step 3: 实现**

服务端：

```ts
const idempotencyKey = headerValue(request, 'x-agent-catalog-idempotency-key')
if (idempotencyKey !== undefined && !IDEMPOTENCY_KEY_RE.test(idempotencyKey)) {
  return result(400, errorBody('幂等键无效', 'invalid-idempotency-key'), { action, outcome: 'error' })
}
// 关键：这段查找必须在 store.withPackageLock(slug, version, ...) 内执行，
// 与创建记录同一个锁；锁外查找会与并发提交交错，产生两条记录。
const existing = Object.values(context.store.read().submissions).find(
  (record) => record.idempotencyKey === idempotencyKey,
)
if (existing !== undefined) {
  if (existing.slug === slug && existing.version === version && sameDigest(existing.digest, digest)) {
    return result(200, submissionBody(existing), { action, outcome: 'ok', slug, version, submissionId: existing.id, reason: 'idempotent replay' })
  }
  return result(409, errorBody('幂等键已被其他提交使用', 'idempotency-conflict'), { action, outcome: 'error', ... })
}
```

`Submission` 增加 `idempotencyKey?: string`，创建记录时写入。`sameDigest` 已在 submissions.ts。`headerValue` 取 string（Node 的 header 可能是 string[]；拒绝数组）。测试 helper 的 `submit` 增加 options。

`publish-lock.ts`：

```ts
export type AgentPackagePublishLock = { run<T>(profileDir: string, slug: string, fn: () => Promise<T>): Promise<T> }
export function createAgentPackagePublishLock(): AgentPackagePublishLock {
  const tails = new Map<string, Promise<unknown>>()
  return {
    async run(profileDir, slug, fn) {
      const key = `${profileDir}\0${slug}`
      const previous = tails.get(key) ?? Promise.resolve()
      const run = previous.then(fn, fn)
      tails.set(key, run.then(() => undefined, () => undefined))
      return run
    },
  }
}
```

`catalog-publish.ts` 与 `drafts.ts` 共用模块级 `const publishLock = createAgentPackagePublishLock()`（同进程；若测试需要隔离，提供 `resetPublishLockForTests()`）。

`publishLocalAgentPackage`：

1. `return publishLock.run(binding.profileDir, slug, async () => { ...existing body... })`。
2. 在 `buildUnsigned` 后计算 `digestSha256 = createHash('sha256').update(canonicalJson(digest)).digest('hex')`（或复用 `canonicalJson(digest)` 字符串的 hash）。
3. 读取 sidecar；若存在同 slug 且 `version/digestSha256` 相同，复用 `submissionId` 与 `idempotencyKey`，跳过 `submit`（或带同一 key 再提交以确认状态）；否则生成新 key，**先写 sidecar**，再 `client.submit(bundle, { idempotencyKey })`。
4. 收到 `submission` 后把 sidecar 的 `submissionId` 更新为实际值，再走现有 state 检查/写入；state 写成功后删除该 sidecar 条目。
5. 若 state 写失败，sidecar 保留；重试时复用。若内容已变化，`digestSha256` 不匹配，sidecar 保留并返回明确错误：`上一次提交 <id> 仍在对账，请先刷新状态`。
6. 对账入口：`refreshLocalAgentPackagePublishStatus(slug)` 若发现 sidecar 条目，用 `client.getSubmission(submissionId)`（该路由允许 publish token 读取自己的 submission）取回 status；pending/published 写回 state，网络失败保留 sidecar 并在结果 warning 中提示。若 sidecar 只有 `idempotencyKey` 没有 `submissionId`（201 丢失），下一次 `submit` 用同一 key 会拿回 200 + 原 ID，这是 201 丢失的恢复路径。

`commitAgentPackage`：

- 在 `findPackageByDraftId` 之前 `return publishLock.run(profileDir, draftSlug, async () => { ... })`。注意：draft slug 在 `loadAgentPackageDraft` 后才知道；先加载草稿再取锁，锁内重新加载草稿并校验 draftId。
- `alreadyCommitted` 分支：先 `resetLocalAgentPackagePublication(profileDir, alreadyCommitted.slug)`；失败返回 `refused('发布状态复位失败，请重试，草稿已保留')`（不删草稿）；成功后删草稿并返回。

`catalog-client.ts` 的 `submit`：

```ts
async submit(bundle: Buffer, options: { idempotencyKey?: string } = {}): Promise<...> {
  return this.request('POST', '/v1/agent-packages/submissions', {
    body: bundle,
    headers: {
      'content-type': 'application/gzip',
      ...(options.idempotencyKey === undefined ? {} : { 'x-agent-catalog-idempotency-key': options.idempotencyKey }),
    },
  })
}
```

- [ ] **Step 4: 运行**

```bash
cd agent-catalog-server && corepack yarn test -- submissions.spec.ts
cd ../dsh-plugin-huaanwork && corepack yarn test -- agent-package-catalog-publish.spec.ts agent-package-drafts.spec.ts
```

Expected: 同 key 200 同 ID；不同内容 409；状态写失败后 sidecar 可恢复；commit 重试先 reset；reset 失败保留草稿。

- [ ] **Step 5: 提交**

```bash
git add agent-catalog-server/src/{types,submissions}.ts agent-catalog-server/tests/submissions.spec.ts \
  dsh-plugin-huaanwork/src/huaanwork-host/agent-package/{publish-lock,catalog-publish,drafts,catalog-client}.ts \
  dsh-plugin-huaanwork/tests/huaanwork-host/{agent-package-catalog-publish,agent-package-drafts}.spec.ts
git commit -m "fix: make package publication idempotent across crashes and retries"
```

---

### Task 11: 广场同名冲突、broken legacy 与手动刷新（I-19、M-6、M-7）

**Files:**
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/logic/agentPackagesLogic.ts:29,135-142,350-370`
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/AgentPackagesPanel.tsx`（卡片冲突徽标）
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/AgentsPlazaPanel.tsx:160-175`
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/AgentsView.tsx:81-137`
- Test: `dsh-plugin-huaanwork/tests/client-huaanwork/agentPackagesLogic.spec.ts`
- Test: `dsh-plugin-huaanwork/tests/client-huaanwork/agents-plaza-m2.spec.ts`
- Test: `dsh-plugin-huaanwork/tests/client-huaanwork/agent-packages-panel.spec.ts`

**Interfaces:**
- `AgentPackageCard` 新增 `conflict?: 'local-slug'`。
- `plazaCards` 只让 `source === 'catalog'` 的已安装记录抑制摘要；本地同名摘要保留并标冲突。
- `packageActions` 对 `conflict === 'local-slug'` 只返回 `['detail']`；broken 分支移到 legacy 分支之前。
- `plazaEmptyText(result, cardCount, query)` 只在“所有摘要都是已安装 catalog 包”时返回 `PLAZA_ALL_INSTALLED_TEXT`。
- `runPackageRefresh(wait: boolean)`：周期 tick 用 `false`（在飞即跳过），手动/首次用 `true`（共享在飞 promise 后继续）。

- [ ] **Step 1: 写失败测试**

`agentPackagesLogic.spec.ts`：

```ts
test('keeps a remote summary when a local package has the same slug', () => {
  const cards = plazaCards({
    packages: [{ slug: 'weekly-report', source: 'local' /* ... */ }],
    catalogPackages: [summary('weekly-report')],
    catalogAgents: [],
  })
  const signed = cards.find((card) => card.source === 'catalog' && card.slug === 'weekly-report')
  assert.equal(signed?.installed, false)
  assert.equal(signed?.conflict, 'local-slug')
  assert.deepEqual(packageActions(signed!), ['detail'])
})

test('does not suppress a signed summary for an installed catalog package', () => {
  const cards = plazaCards({
    packages: [{ slug: 'weekly-report', source: 'catalog' /* ... */ }],
    catalogPackages: [summary('weekly-report')],
    catalogAgents: [],
  })
  assert.equal(cards.some((card) => card.source === 'catalog' && card.installed === false), false)
})

test('never says all installed when a local-slug conflict remains', () => {
  assert.equal(
    plazaEmptyText({ packages: [{ slug: 'weekly-report', source: 'local' }], catalogPackages: [summary('weekly-report')] }, 0, ''),
    PLAZA_EMPTY_TEXT,
  )
})

test('broken legacy is close-only even when disabled', () => {
  const broken = { ...legacyCard(), broken: { reason: '损坏' } }
  assert.deepEqual(packageActions({ ...broken, enabled: false }), ['detail'])
  assert.deepEqual(packageActions({ ...broken, enabled: true }), ['disable', 'detail'])
})
```

`agents-plaza-m2.spec.ts` / `agent-packages-panel.spec.ts`：渲染一张本地同名卡与一张远端摘要卡，断言摘要卡显示“与本地包同名”且没有“下载”按钮；broken legacy 卡不渲染“启用”按钮。

`AgentsView` 测试（fake timers）：

```ts
test('manual refresh waits for an in-flight periodic refresh instead of being swallowed', async () => {
  const pending = createDeferred<unknown>()
  rpcCall.mockImplementation((method) => {
    if (method === 'agent.packageRefresh') return pending.promise
    return Promise.resolve({})
  })
  render(<AgentsView />)
  await tick() // 首次 refresh 在飞
  await clickRefresh()
  pending.resolve({})
  await flush()
  assert.deepEqual(rpcCall.mock.calls.map(([method]) => method), [
    'agent.packageRefresh', 'agent.refresh',
  ])
  assert.match(screen.getByText(/已刷新智能体目录/).textContent, /已刷新/)
})
```

- [ ] **Step 2: 运行，确认失败**

```bash
cd dsh-plugin-huaanwork && corepack yarn test -- agentPackagesLogic.spec.ts agents-plaza-m2.spec.ts agent-packages-panel.spec.ts
```

Expected: 本地同名摘要被隐藏；broken legacy 显示启用；手动刷新在周期在飞时被吞。

- [ ] **Step 3: 实现**

`agentPackagesLogic.ts`：

```ts
export type AgentPackageCard = {
  // 既有字段...
  conflict?: 'local-slug'
}

export function packageActions(card: AgentPackageCard): AgentPackageAction[] {
  if (card.revoked || (card.broken && card.source === 'catalog')) return ['remove', 'detail']
  if (card.broken) return [...(card.enabled ? (['disable'] as const) : []), 'detail']
  if (card.conflict === 'local-slug') return ['detail']
  if (card.source === 'catalog-legacy') return [card.enabled ? 'disable' : 'enable', 'detail']
  // 其余既有分支...
}

export function plazaCards(result): AgentPackageCard[] {
  const installedCatalogSlugs = new Set(
    result.packages.filter((item) => item.source === 'catalog').map((item) => item.slug),
  )
  const localSlugs = new Set(
    result.packages.filter((item) => item.source === 'local').map((item) => item.slug),
  )
  const signed = result.catalogPackages
    .filter((summary) => !installedCatalogSlugs.has(summary.slug))
    .map((summary) => ({
      ...catalogPackageCard(summary),
      ...(localSlugs.has(summary.slug) ? { conflict: 'local-slug' as const } : {}),
    }))
  // claimed/legacy 逻辑不变
}

export function plazaEmptyText(
  result: Pick<AgentPackageListResult, 'catalogPackages' | 'packages'>,
  cardCount: number,
  query: string,
): string {
  if (query.trim().length > 0) return SEARCH_EMPTY_TEXT
  if (cardCount > 0) return ''
  const installedCatalogSlugs = new Set(
    result.packages.filter((item) => item.source === 'catalog').map((item) => item.slug),
  )
  const allInstalled = result.catalogPackages.length > 0
    && result.catalogPackages.every((summary) => installedCatalogSlugs.has(summary.slug))
  return allInstalled ? PLAZA_ALL_INSTALLED_TEXT : PLAZA_EMPTY_TEXT
}
```

`AgentPackagesPanel.tsx` 的卡片徽标区加：

```tsx
{card.conflict === 'local-slug' ? (
  <span className="badge">与本地包同名，无法安装</span>
) : null}
```

`AgentsPlazaPanel.tsx` 的空态改用 `plazaEmptyText(data, cards.length, search)`。

`AgentsView.tsx`：

```ts
const packageRefreshPromise = useRef<Promise<boolean> | null>(null)

const runPackageRefresh = useCallback(async (wait: boolean): Promise<boolean> => {
  if (packageRefreshPromise.current !== null) {
    return wait ? packageRefreshPromise.current : false
  }
  const run = (async (): Promise<boolean> => {
    try {
      await rpcCall('agent.packageRefresh')
      setError('')
      return true
    } catch (cause) {
      setError(catalogErrorMessage(cause))
      return false
    }
  })()
  packageRefreshPromise.current = run
  try { return await run } finally {
    if (packageRefreshPromise.current === run) packageRefreshPromise.current = null
  }
}, [])
```

首次 effect、周期 tick、`handleRefresh` 分别传 `true`、`false`、`true`；周期 tick 仍在 `refreshed` 时自增 `refreshToken`。

- [ ] **Step 4: 运行**

```bash
cd dsh-plugin-huaanwork && corepack yarn test -- agentPackagesLogic.spec.ts agents-plaza-m2.spec.ts \
  agent-packages-panel.spec.ts
```

Expected: 冲突卡可见且无下载；真正已安装的 catalog 包不重复；broken legacy 不显示启用；手动刷新与周期共享在飞请求后完成 `agent.refresh`。

- [ ] **Step 5: 提交**

```bash
git add dsh-plugin-huaanwork/src/client-huaanwork/{logic/agentPackagesLogic.ts,AgentPackagesPanel.tsx,AgentsPlazaPanel.tsx,AgentsView.tsx} \
  dsh-plugin-huaanwork/tests/client-huaanwork/{agentPackagesLogic,agents-plaza-m2,agent-packages-panel}.spec.ts
git commit -m "fix: surface local-slug conflicts and stop swallowing manual refresh"
```

---

### Task 12: 运行时许可证、notices 与打包边界（I-4）

**Files:**
- Modify: `dsh-plugin-huaanwork/tsdown.config.ts`
- Modify: `dsh-plugin-huaanwork/package.json`（scripts / 依赖，按 spike 结果）
- Modify: `dsh-plugin-huaanwork/scripts/verify-licenses.mjs`
- Create: `dsh-plugin-huaanwork/scripts/verify-bundled-runtime.mjs`
- Modify: `dsh-plugin-huaanwork/THIRD_PARTY_NOTICES.md`（由 `verify:notices` 生成）
- Test: `dsh-plugin-huaanwork/scripts/runtime-closure.spec.mjs` 或新建 `scripts/bundled-runtime.spec.mjs`

**Interfaces:**
- `verify-bundled-runtime.mjs` 读取 `lib/**/*.js`，断言不存在对 `@huaanwork/agent-package-format`、`@huaanwork/catalog-signing`、`@huaanwork/policy` 的外部 import；对 `tar` 断言“被打进 bundle”或“在 dependencies 且许可证图覆盖”二者之一。
- `verify-licenses.mjs` 增加 `BUNDLED_PACKAGES` 遍历：`@huaanwork/agent-package-format` → `@huaanwork/catalog-signing`/`@huaanwork/policy`/`tar`；`verify:notices` 生成包含 `tar` 的表。

- [ ] **Step 1: 先做 build spike（不改代码）**

```bash
cd dsh-plugin-huaanwork
corepack yarn build
rg -n 'from\s+"[^"]*(tar|@huaanwork/agent-package-format|@huaanwork/catalog-signing|@huaanwork/policy)' lib/huaanwork-host lib/*.js
rg -n 'TAR_BAD_ARCHIVE|ReadEntry|normalizeWindowsPath' lib/huaanwork-host | head
```

将实际结果写入本任务执行记录：
- 若 `lib` 内无外部 import 且出现 tar 代码 ⇒ **bundled**，走 Step 3 的 A 分支。
- 若 `lib` 内有 `from "tar"` ⇒ **external**，走 B 分支；对 `@huaanwork/*` 若出现外部 import，必须改为 bundled（它们导出原始 TS，不能作为运行期外部依赖）。
- 若两者都没有 tar 代码/import，说明 agent-package 入口未被打进该 build，必须修正 tsdown entry/config 后再继续。

- [ ] **Step 2: 写失败测试**

`scripts/bundled-runtime.spec.mjs`：

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const lib = join(import.meta.dirname, '../lib')
test('bundled runtime has no external @huaanwork package imports', () => {
  for (const file of readdirSync(lib, { recursive: true })) {
    if (!String(file).endsWith('.js')) continue
    const text = readFileSync(join(lib, String(file)), 'utf8')
    for (const name of ['@huaanwork/agent-package-format', '@huaanwork/catalog-signing', '@huaanwork/policy']) {
      assert.equal(text.includes(`from "${name}`) || text.includes(`from '${name}`), false, `${file} imports ${name}`)
    }
  }
})
```

`verify-licenses` 的测试（若没有则直接用命令验证）：`node scripts/verify-licenses.mjs` 必须列出 `tar` 且通过（BUNDLED_PACKAGES 默认加入，不需要额外 flag）。

- [ ] **Step 3: 实现（按 spike 结果二选一）**

**A. tar 被打包：**

- `tsdown.config.ts` 显式声明：
  ```ts
  deps: {
    alwaysBundle: ['@huaanwork/agent-package-format', '@huaanwork/catalog-signing', '@huaanwork/policy'],
  },
  ```
- `verify-licenses.mjs` 增加：
  ```js
  const BUNDLED_PACKAGES = [
    '@huaanwork/agent-package-format',
    '@huaanwork/catalog-signing',
    '@huaanwork/policy',
    'tar',
  ]
  // 初始 queue 追加 BUNDLED_PACKAGES 的 manifest，遍历其 dependencies/optionalDependencies。
  // 关键：tar 的 manifest 必须从 @huaanwork/agent-package-format 的 manifest 路径解析
  // （resolvePackageManifest('tar', agentPackageFormatManifestPath)），不能从 huaanwork
  // 根解析；工作区安装把 tar 放在 packages/agent-package-format/node_modules/tar。
  ```
- `package.json` 增加 `"verify:bundled": "node --test scripts/bundled-runtime.spec.mjs && node scripts/verify-bundled-runtime.mjs"`，并把 `verify:bundled` 加入本包 `check`（或并入 `verify:licenses`）。
- `node scripts/verify-licenses.mjs --notices THIRD_PARTY_NOTICES.md` 生成包含 `tar` 的 notices；提交 diff。

**B. tar 保持 external：**

- `dsh-plugin-huaanwork/package.json` 的 `dependencies` 增加 `"tar": "7.5.22"`；确认打包器把 `node_modules/tar` 放进安装包（现有 `verify:closure` 之外的打包检查需覆盖；在 `verify-bundled-runtime.mjs` 中断言 `tar` 在 dependencies 且 `require.resolve('tar')` 可解析）。
- `@huaanwork/*` 仍必须 bundled（Step 3 A 的 `deps.alwaysBundle` 保留）。
- `verify-licenses` 的 BUNDLED_PACKAGES 只列 `@huaanwork/*`；`tar` 走正常 production 图。

- [ ] **Step 4: 运行**

```bash
cd dsh-plugin-huaanwork
corepack yarn build
corepack yarn verify:licenses
corepack yarn verify:closure
corepack yarn verify:notices
corepack yarn verify:bundled
git diff --exit-code THIRD_PARTY_NOTICES.md || true   # 首次生成后提交；之后必须无漂移
```

Expected: licenses/closure/notices/bundled 全绿；`THIRD_PARTY_NOTICES.md` 包含 `tar`（A）或 `tar` 在 dependencies 且许可图覆盖（B）；无外部 `@huaanwork/*` import。

- [ ] **Step 5: 提交**

```bash
git add dsh-plugin-huaanwork/tsdown.config.ts dsh-plugin-huaanwork/package.json \
  dsh-plugin-huaanwork/scripts/verify-licenses.mjs dsh-plugin-huaanwork/scripts/verify-bundled-runtime.mjs \
  dsh-plugin-huaanwork/scripts/bundled-runtime.spec.mjs dsh-plugin-huaanwork/THIRD_PARTY_NOTICES.md
git commit -m "fix: bring bundled agent-package runtime into the license and notices graph"
```

---

### Task 13: 验收探针走真实 RPC 并重跑 macOS/Windows（I-17）

**Files:**
- Modify: `dsh-plugin-huaanwork/scripts/huaanwork-agent-package-m2-acceptance.mjs:74-100,740-1010`
- Modify: `docs/evidence/2026-10-24-agent-package-m2-macos-acceptance.md`
- Modify: `docs/evidence/2026-10-24-agent-package-m2-windows-acceptance.md`
- Test: 探针自身 + 真实运行

**Interfaces:**
- 探针用 `ROUTE_TABLE.find(entry => entry.method === 'agent.packageRefresh')` 调用真实 handler；`RouteContext.runtimeCtx.huaanworkAgentCatalogSecurity` 指向真实 security。
- `agent.packageList` 同样走 route；`host.listLocal()` 只作交叉核对，不再作为唯一证据。
- 证据记录最终 HEAD、run URL、exit code、原始 JSON、进程清单。

- [ ] **Step 1: 改探针（先失败断言）**

在探针顶部导入：

```js
import { ROUTE_TABLE } from '../src/huaanwork-host/routes.ts'
import { setAgentPackageHost, setAgentsDirectory } from '../src/huaanwork-host/sessions.ts'
import { createAgentsHost } from '../src/huaanwork-host/agents-host.ts'
```

在创建 `host`/`security` 后：

```js
const legacyHost = createAgentsHost({
  storageRoot: dirs.consumerProfile,
  readSettings: () => readSettingsFor(dirs.consumerProfile),
  onCatalogChange: () => undefined,
})
setAgentsDirectory(legacyHost)
setAgentPackageHost(host)
const routeCtx = {
  dshHome: dirs.consumerProfile,
  profileDir: dirs.consumerProfile,
  workspaceRoot: { current: dirs.workspace },
  emit: () => undefined,
  logger: (message) => log(message),
  runtimeCtx: { huaanworkAgentCatalogSecurity: security },
  requestRestart: async () => false,
}

async function callPackageRpc(method, request = { params: {}, body: {}, query: new URLSearchParams() }) {
  const entry = ROUTE_TABLE.find((candidate) => candidate.method === method)
  if (entry === undefined) throw new Error(`route ${method} not found`)
  return entry.handler(request, routeCtx)
}
```

把 Step 7 的 `await refreshInstalledCatalogPackageStatuses()` 改为：

```js
const refreshResult = await callPackageRpc('agent.packageRefresh')
const delistedCard = refreshResult.packages.find((item) => item.slug === SLUG && item.source === 'catalog')
if (delistedCard?.publishStatus !== 'delisted' || delistedCard.enabled !== true || delistedCard.broken !== undefined) {
  throw new Error(`packageRefresh card was ${JSON.stringify(delistedCard)}`)
}
steps.delistedStatusVisible.rpc = { method: 'agent.packageRefresh', card: delistedCard }
```

把 Step 9 的 `await security.refreshRevocations()` 改为：

```js
const revocationRefresh = await callPackageRpc('agent.packageRefresh')
const revokedCard = revocationRefresh.packages.find((item) => item.slug === SLUG && item.source === 'catalog')
if (revokedCard?.revoked?.version !== SECOND_VERSION || revokedCard.enabled !== false) {
  throw new Error(`revoked card was ${JSON.stringify(revokedCard)}`)
}
```

保留直接 `security.refreshRevocations()` 作为交叉核对时，必须在 `steps` 中标注 `primary: 'agent.packageRefresh'`、`crossCheck: 'security.refreshRevocations'`，且断言只在 RPC 结果上做。

- [ ] **Step 2: 运行探针（本机，预期先失败）**

```bash
cd dsh-plugin-huaanwork
node --experimental-strip-types scripts/huaanwork-agent-package-m2-acceptance.mjs \
  --platform darwin --out /tmp/agent-package-m2-darwin-remediation.json
echo "EXIT=$?"
```

Expected: 在 Step 7/9 因 `refreshResult.packages`/`revokedCard` 断言失败（当前探针没走 RPC，且 route 的 legacy host 未接线）。记录失败作为修复前证据。

- [ ] **Step 3: 完成接线并跑通**

补齐 `readSettingsFor(profileDir)`（复用 `readHuaanworkSettingsSync` 或探针现有 `configureConsumer` 的 settings 读取）；确保 `createAgentsHost` 的 `onCatalogChange` 空实现不触发副作用；`agent.packageRefresh` 的 `getAgentsDirectory().refresh()` 会访问测试目录服务的 `/v1/catalog`，探针的目录服务已有 fixture，必须成功。若 legacy refresh 返回 `catalogError`，探针应把它写进步骤而不是忽略。

- [ ] **Step 4: 重跑 macOS 并在最终 HEAD 归档**

```bash
git rev-parse HEAD
cd dsh-plugin-huaanwork
node --experimental-strip-types scripts/huaanwork-agent-package-m2-acceptance.mjs \
  --platform darwin --out /tmp/agent-package-m2-darwin-final.json
echo "EXIT=$?"
ps -ax -o pid=,command= | grep -F "$(mktemp -u /tmp/agent-package-m2-)" || true
```

把 HEAD、exit code、原始 JSON、进程清单写入 `docs/evidence/2026-10-24-agent-package-m2-macos-acceptance.md`；证据文件的提交必须是代码提交之后的独立提交，且记录代码提交 SHA。

- [ ] **Step 5: Windows GHA**

```bash
git push origin feat/agent-packages-m2
gh workflow run windows-agent-package-acceptance.yml \
  --ref feat/agent-packages-m2 --repo kawaiininja/HuaAnWork-Desktop
gh run list --workflow windows-agent-package-acceptance.yml \
  --repo kawaiininja/HuaAnWork-Desktop --limit 3
# 下载 artifact，填 docs/evidence/2026-10-24-agent-package-m2-windows-acceptance.md
```

若本机不能 push：证据文件保持 `BLOCKED`，记录原因与待执行命令；**不得**用 macOS 探针或同机双 Profile 冒充 Windows 验收。

- [ ] **Step 6: 跨机器验收**

按 Windows 证据文件 §4 的四步执行：macOS 创建者发布 → 离线管理员 review/approve → Windows 消费机安装/启用/运行/更新/撤销；两台机器各留原始 JSON/界面证据与进程清单。没有第二台 Windows 机器时保持 `BLOCKED`，M2 不宣布收口。

- [ ] **Step 7: 提交**

```bash
git add dsh-plugin-huaanwork/scripts/huaanwork-agent-package-m2-acceptance.mjs \
  docs/evidence/2026-10-24-agent-package-m2-{macos,windows}-acceptance.md
git commit -m "test: drive M2 acceptance through the real packageRefresh RPC"
```

---

### Task 14: 范围裁定与最终门槛（I-18）

**Files:**
- Create: `docs/evidence/2026-10-25-agent-package-m2-scope-ruling.md`
- Modify: `docs/superpowers/plans/2026-10-24-chat-created-agent-packages-m2.md:15-28,62-76`
- Modify: 评审清单 `docs/superpowers/specs/2026-10-25-chat-created-agent-packages-m2-code-review.md`（勾选 + 证据指针）
- Modify: `AGENTS.md`（变体守卫权威计数 64→65，R-T12-1/R-T14-1）

**Interfaces:**
- 范围裁定逐文件列出：`dsh-plugin-desktop/tests/package.spec.ts:113`、`dsh-plugin-desktop-beta/tests/package.spec.ts:123`、`market-server/Dockerfile:5`、`docs/market-server-deployment.md:87`；每项附 `git diff c411d12d89..<final-head> -- <file>` 的链接/摘录、理由、批准人、日期。
- M2 计划的 Global Constraints 与 File Structure 同步这四文件；若用户选择回退，裁定文档记录替代门禁方案，且最终 diff 不含这四文件。

- [ ] **Step 1: 写范围裁定**

```markdown
# M2 范围裁定（R-M2-2）

日期：2026-10-25
批准：<用户/负责人>
基线：c411d12d89
最终 HEAD：<填>

| 文件 | 改动 | 理由 | 证据 |
|---|---|---|---|
| dsh-plugin-desktop/tests/package.spec.ts:113 | workspace 12→16 | 四个新 workspace 进入根门禁；不同步则既有包测试失败 | `git diff ...` |
| dsh-plugin-desktop-beta/tests/package.spec.ts:123 | 同上 | 同上 | `git diff ...` |
| market-server/Dockerfile:5 | 注释说明新增运行期依赖 | `market-server/src/signing.ts` value import `@huaanwork/catalog-signing` | `git diff ...` |
| docs/market-server-deployment.md:87 | 部署闭包说明 | 同上；记录原始 TS 在 node_modules 下的类型剥离限制 | `git diff ...` |

结论：保留四文件；不新增其他越界改动。
```

同时修改 M2 计划的 Global Constraints 第 17 行，加入“本计划指定文档包含以上四文件（R-M2-2）”，并把四文件加入 Modify 表。

- [ ] **Step 2: 最终门槛（全部在最终 HEAD 执行）**

```bash
corepack yarn test
corepack yarn typecheck
corepack yarn check:desktop-variants
corepack yarn check
node scripts/verify-layout.mjs
cd dsh-plugin-huaanwork && corepack yarn verify:licenses && corepack yarn verify:closure && corepack yarn verify:notices && corepack yarn verify:bundled
cd ../..
git diff --check c411d12d89..HEAD
git status --porcelain
```

Expected: 全部 exit 0；`git status --porcelain` 为空；`THIRD_PARTY_NOTICES.md` 无漂移；variant 计数为 7/65/6（Task 12 的 R-T12-1 把 `scripts/verify-licenses.mjs` 计入 `beta↔huaanwork` 第 65 项）。

- [ ] **Step 3: 更新评审清单**

在评审文档中逐项勾选 I-1…I-19、M-1…M-7，并写 `整改提交 / 回归证据`；I-20 勾选“延后裁定 R-M2-3 + 触发条件”；I-10 的表述按 R-M2-5 订正。**不得**勾选 I-17 的 Windows/跨机器项，除非 Task 13 已有真实 PASS 证据。

- [ ] **Step 4: 提交**

```bash
git add docs/evidence/2026-10-25-agent-package-m2-scope-ruling.md \
  docs/superpowers/plans/2026-10-24-chat-created-agent-packages-m2.md \
  docs/superpowers/specs/2026-10-25-chat-created-agent-packages-m2-code-review.md
git commit -m "docs: record M2 scope ruling and remediation evidence"
```

---

## 最终门槛（与评审 §五一致）

- [ ] I-1～I-19 全部有代码、测试、复核证据；I-20 有 R-M2-3 延后裁定。
- [ ] M-1～M-7 全部修复或有明确延后裁定；无静默残余。
- [ ] 对整改后的新 HEAD 再做一次独立实现评审，无未处置 Critical/Important。
- [ ] `corepack yarn test`、`typecheck`、`check:desktop-variants`、`check`、`node scripts/verify-layout.mjs` 全绿。
- [ ] huaanwork `verify:licenses`、`verify:closure`、`verify:notices`、`verify:bundled` 全绿且 notices 无漂移。
- [ ] macOS 验收在最终 HEAD 通过，原始证据归档。
- [ ] Windows GHA 实际运行通过并归档 run URL/exit code/artifact；无运行则 `BLOCKED`。
- [ ] macOS 创建者 → Windows 消费机跨机器验收通过；不能用同机双 Profile 替代。
- [ ] 探针通过真实 `agent.packageRefresh` 验证下架/撤销卡片。
- [ ] 所有计划外文件均有 R-M2-2 裁定或已回退。
- [ ] `git diff --check <base>..<final-head>` 通过，最终工作区干净。

## 测试 helper 约定

计划里引用的测试 helper 若在现有文件中不存在，按下面定义补齐；不得用 mock 替代真实 HTTP/CLI/子进程链路。

```ts
// agent-catalog-server/tests/helpers.ts 或各 spec 内的局部 helper
export async function seedRevocations(dataDir: string, count: number, reasonBytes: number): Promise<void> {
  // 读 state.json（不存在则 emptyCatalogState），写 count 条合法 Revocation
  //（slug `revoked-${i}`、version '1.0.0'、reason 'r'.repeat(reasonBytes)、
  // revokedAt 递增、actor 'test'），tmp+rename 写回。
}

export async function readAuditLine(dataDir: string, action: string): Promise<string> {
  const lines = (await readFile(join(dataDir, 'audit.jsonl'), 'utf8')).trim().split('\n')
  const match = lines.map(JSON.parse).findLast((line) => line.action === action)
  return JSON.stringify(match)
}

// dsh-plugin-huaanwork 测试
export function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}
```

- Task 8 的 `configureTestCatalog()`：在 `configureAgentCatalog` 中注入 `lifecycle: createAgentPackageLifecycleLock()`、fake client 与临时 profile；`installedPackage()` 返回一个带 `enabled:true`、`source:'catalog'`、`version:'1.0.0'` 的 host dispatch 入参；`runtimeWithActivationThatNeverDisposes()` 的 `activation.dispose()` 返回 `new Promise(() => {})`；`dispatchInputWithEnabledPackage()` 复用现有 host 测试的 `dispatchInput` 构造器。
- Task 9 的 `readLegacyEnabled(profileDir)` 直接 `JSON.parse(readFileSync(agentsEnabledPath(profileDir)))`；`transactionPath` 是测试自己写入的 `.install-*` 目录下的 `transaction.json` 路径。
- Task 11 的 `summary(slug)` 返回一个完整 `AgentPackageSummary`（version '1.0.0'、displayName/description/size/updatedAt 固定）；`legacyCard()` 返回 `{slug, displayName, description, source:'catalog-legacy', enabled:false}`；`tick/flush` 用 `await Promise.resolve()` 与 `vi.runOnlyPendingTimersAsync()`；`clickRefresh` 用 RTL `userEvent.click(screen.getByRole('button', { name: /刷新/ }))`。
- Task 7 的 `runCliInProcess(argv, env)` 用 `runCli` 的 `io` 参数捕获 stdout/stderr；`baseEnv` 提供 `AGENT_CATALOG_URL`、三个 token 与临时 `--out` 目录。
- Task 6 的测试文件需 `import { packageBundlePath } from '../src/submissions.ts'` 与 `mkdir`。
- Task 2 的 `contentFiles(count)` 定义在 `bundle.test.ts`；`submissions.spec.ts` 内复制同一 helper（两个包各自有测试 fixture，不跨包 import）。
- Task 4 的 `store.spec.ts` 用 `publishedRecord()`/`revocationRecord(slug, version)` 生成完整合法记录：`publishedRecord()` 至少含 `slug/version/manifest/digest/signature/status:'published'/size/updatedAt/actor`；`revocationRecord(slug,version)` 含 `slug/version/reason/revokedAt/actor`。
- Task 10 的 publish spec 复用现有 `writeLocalPackage`/`writeSignedPackage`/`seedState`；drafts spec 复用 `makeRoot`/`createProposal`/`draftPath`/`readManifest`，并用 `writeAgentPackageAtomically` 直接模拟“包已写、reset 未跑”的中断态。
- Task 13 的 legacy host 用 `readHuaanworkSettingsSync(profileDir)` 作为 `readSettings`；若 `createAgentsHost` 需要 `agents_catalog_token`，从探针的 `configureConsumer` 同一 settings 来源读取。

## 自审（写作计划时执行）

- **Spec coverage:** I-1→Task 1；I-2→Task 1；I-3→Task 2；I-4→Task 12；I-5→Task 4；I-6→Task 5；I-7→Task 6；I-8→Task 7；I-9→Task 3；I-10→Task 8；I-11→Task 8；I-12→Task 5；I-13→Task 9；I-14→Task 9；I-15→Task 10；I-16→Task 10；I-17→Task 13；I-18→Task 14；I-19→Task 11；I-20→R-M2-3（不实现）；M-1→Task 2；M-2/M-3→Task 4；M-4→Task 3；M-5→Task 9；M-6/M-7→Task 11。无遗漏。
- **Placeholder scan:** 本计划没有 TBD/TODO/“稍后实现”；Task 12 的 A/B 分支是互斥的可执行路径，不是占位符；Task 13 的 `<用户/负责人>` 是必须由裁定记录的实名/角色字段，不是代码占位。
- **Type consistency:** `AgentPackageLifecycleLock.run` 的 `label` 在 host 与 install 使用一致；`countSignedInstalledEntries` 在 digest.ts 定义、submissions.ts 消费；`requestId` 在 `DispatchContext`、`SubmissionHandlerContext`、`GovernanceHandlerContext`、`CatalogStore.mutate`、`AuditEvent` 五处同名同类型；`conflict: 'local-slug'` 只在 `AgentPackageCard` 与 `packageActions`/`plazaCards` 使用。

## 执行交接

计划已保存到 `docs/superpowers/plans/2026-10-25-chat-created-agent-packages-m2-remediation.md`。两种执行方式：

1. **Subagent-Driven（推荐）**：每个 Task 派一个全新 subagent，Task 之间由主会话复核测试与 diff；适合本计划这种跨四个子系统的整改。
2. **Inline Execution**：在当前会话按 executing-plans 分批执行，每个 Task 结束设检查点。

执行前先确认 R-M2-1～R-M2-6 六项裁定；R-M2-2 未确认前不要动 `dsh-plugin-desktop*/tests`，R-M2-3 未确认前不要新增第 8 个 RPC。
