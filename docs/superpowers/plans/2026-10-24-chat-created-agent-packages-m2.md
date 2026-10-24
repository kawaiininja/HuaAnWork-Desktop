# 会话内创建智能体包 M2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 M1 本地智能体包接入管理员审查、Ed25519 签名发布、目录下载/验签/安装/更新，以及下架申请和撤销闭环，并保持旧目录智能体与工具兼容。

**Architecture:** 仓外 M-A0 目录服务迁入 `agent-catalog-server/`，保持 `GET /v1/catalog` 契约并新增包、审查、下架和撤销接口；离线 `agent-catalog-admin` 独立复算 digest 后签名，服务端只持公钥。桌面端经共享包格式模块创建/验证 bundle，原子安装到 M1 包目录；每次 `@` 前复验，撤销刷新会中止在途回合。

**Tech Stack:** TypeScript、Node.js 22/24 `node:http`/`node:crypto`、Yarn 4.18.0、Vitest 4.1.8、React 19、现有 `tar@7.5.22`、Cordis、M1 agent-package host/runtime。

**Spec:** `docs/superpowers/specs/2026-10-23-chat-created-agent-packages-design.md` §8–§12

**Baseline:** M1 已合并；本计划核对基线为 `168637e189adf3720d4afcf86e9f7cfded336784`，现有 62 个 RPC。仓外 M-A0 服务位于 `../../agent-catalog-server/`（相对仓库根解析后为 `/Users/amonmiao/Downloads/cursor/agent-catalog-server/`），实施时先复制其 `entries/*.json` 为部署输入，不直接修改仓外目录。

## Global Constraints

- 只改 `packages/catalog-signing/`、`packages/agent-package-format/`、`agent-catalog-server/`、`agent-catalog-admin/`、`dsh-plugin-huaanwork/`、根 workspace/门禁清单（含 `scripts/verify-layout.mjs` 与 `scripts/expected-root-gate-scripts.json`）和本计划指定文档；禁止改 `dsh-plugin-desktop/`、`dsh-plugin-desktop-beta/`、`dsh-desktop-next/`、`deepseek-harness/`、`dsh-community-market/`。
- `market-server/` 只允许抽取签名原语及 import/依赖变化；路由、配置、信封、清单和运行时行为不变，现有测试必须原样通过，且不得获得 `tar` 间接依赖。
- 三个凭据严格分离：桌面读 token=`agents_catalog_token`、发布 token=`agents_catalog_publish_token`；服务端沿用读 token 环境变量 `AGENT_CATALOG_TOKEN`，新增 `AGENT_CATALOG_PUBLISH_TOKEN` 与 `AGENT_CATALOG_ADMIN_TOKEN`。桌面不得保存 admin token 或签名私钥。
- 私钥只进入管理员 CLI；服务端与桌面只读 raw 32-byte hex 公钥 keyring。生产私钥、生产 token 不进仓库、CI、日志或测试 fixture。
- `canonicalJson` 与 market-server 当前实现逐字节一致；签名对象是 `canonicalJson(package-digest.json)` 的 UTF-8 字节，不签 tgz 字节。未知 key、已退休 key、错误签名、哈希不符均 fail-closed。
- bundle 与解包后文件总量各自 ≤5 MiB；每个归档的 File/Directory 条目合计 ≤1024，每条规范化路径 UTF-8 ≤512 字节，超限立即中止，不得以 0 字节条目绕过内存预算。拒绝绝对路径、盘符路径、反斜杠、`..`、NUL、符号链接、硬链接、重复条目、digest 外额外文件和解压超帽。`.signature/` 只允许 `package-digest.json` 与 `signature.json`。
- 安装和每次 `@` 运行前都复算所有文件 size/SHA-256 并验签；下架只停止新分发，撤销才禁用已安装副本并中止在途回合。离线使用上次撤销列表并显示警告；不提供 unrevoke。
- 广场更新只允许更高 semver；更新/移除/撤销先中止对应运行时。首次安装默认关闭；同目录 `catalog-legacy` 迁移保持启用态，成功后删除旧 `catalog:<slug>` 键。
- 本地包内容每次 commit 变化后 `publishStatus` 回到 `none`；本地包不可删除，目录包才可移除。发布按钮的真实动作是“提交审查”，不做审查 UI、后台审批推送或自动恶意代码扫描。
- M1 的 `local:` 状态与 `agents-enabled.json` 旧键保持兼容；签名 manifest 不写 `source`、`enabled`、`published`。Stable/Beta/Next 零改动，桌面 variant 白名单维持 7/64、前缀 6，不新增名额。
- 全部自动化测试 headless；最终运行 `corepack yarn test`、`corepack yarn typecheck`、`corepack yarn check`、`corepack yarn check:desktop-variants`。macOS 与 Windows 分别完成发布→第二 Profile 下载/验签/启用/运行→更新→撤销证据；另至少做一次 macOS 创建者机器→Windows 消费机器的跨机器验收，不能用同机双 Profile 替代“另一台机器”成功标准。未完成不得宣布 M2 收口。
- 新共享签名包零运行时依赖；包格式包固定使用仓库已有 `tar@7.5.22`，不升级其他依赖。所有目录写状态用 tmp+rename；同 slug/version 写操作串行，重复版本和并发提交必须有一致失败结果。

## File Structure

**Create**

| 文件 | 职责 |
|---|---|
| `packages/catalog-signing/package.json`, `tsconfig.json`, `src/index.ts` | 零依赖 canonical JSON、Ed25519、keyId/双槽/keyring、digest 签名原语 |
| `packages/catalog-signing/tests/signing.test.ts` | market 字节兼容、签名、错误 key、退休 key、双槽测试 |
| `packages/agent-package-format/package.json`, `tsconfig.json` | M2 包格式 workspace；依赖 signing、policy、`tar@7.5.22` |
| `packages/agent-package-format/src/manifest.ts` | 从 M1 抽取的 manifest 类型/校验与 semver 比较 |
| `packages/agent-package-format/src/digest.ts` | 条目/路径预算、文件枚举、digest 生成/复算、目录验签 |
| `packages/agent-package-format/src/bundle.ts` | 内存安全解包、unsigned/signed bundle 创建与检查 |
| `packages/agent-package-format/src/index.ts` | 包格式公共出口 |
| `packages/agent-package-format/tests/{digest,bundle}.test.ts`, `tests/helpers.ts` | 完整 manifest fixture、digest、路径/链接/重复/额外文件/炸弹/签名负例 |
| `agent-catalog-server/package.json`, `tsconfig.json` | 仓内目录服务 workspace 与启动/检查命令 |
| `agent-catalog-server/src/{config,auth,store,audit,legacy,types}.ts` | fail-closed 配置、三 token、原子状态、审计、M-A0 entries 兼容 |
| `agent-catalog-server/src/{submissions,governance}.ts` | 审查发布、下架申请、撤销领域逻辑 |
| `agent-catalog-server/src/{server,index}.ts` | 路由与进程入口 |
| `agent-catalog-server/tests/{auth-legacy,submissions,governance}.spec.ts` | 真实 HTTP 集成测试 |
| `agent-catalog-server/tests/helpers.ts` | 临时目录、动态测试密钥、起服、bundle helper |
| `agent-catalog-admin/package.json`, `tsconfig.json` | 离线管理员 CLI workspace |
| `agent-catalog-admin/src/{cli,client,review}.ts` | pending 审查/diff、签名批准、拒绝、下架、撤销、legacy 迁移 |
| `agent-catalog-admin/tests/cli.spec.ts` | 真实 CLI+服务端流程与私钥泄漏负例 |
| `dsh-plugin-huaanwork/src/huaanwork-host/agent-package/catalog-client.ts` | 读/发布请求、5 MiB/JSON 上限、超时与错误分类 |
| `dsh-plugin-huaanwork/src/huaanwork-host/agent-package/catalog-publish.ts` | 本地包提交、状态同步、下架申请、本地变更状态复位 |
| `dsh-plugin-huaanwork/src/huaanwork-host/agent-package/catalog-install.ts` | 验签安装、更新、移除、legacy 迁移与回滚、已安装 delisted metadata 同步 |
| `dsh-plugin-huaanwork/src/huaanwork-host/agent-package/catalog-security.ts` | keyring、撤销缓存/刷新、active turn 取消委托、运行前复验、撤销执行 |
| `dsh-plugin-huaanwork/tests/huaanwork-host/agent-package-catalog-{publish,install,security}.spec.ts` | 桌面发布/消费/撤销测试 |
| `dsh-plugin-huaanwork/scripts/huaanwork-agent-package-m2-acceptance.mjs` | 双 Profile 发布消费验收探针 |
| `docs/huaanwork-agent-packages-m2.md` | 部署、离线签名、运维、迁移与排障 runbook |
| `docs/evidence/2026-10-24-agent-package-m2-{macos,windows}-acceptance.md` | 双平台验收事实记录 |

**Modify**

| 文件 | 改动 |
|---|---|
| `package.json`, `scripts/expected-root-gate-scripts.json`, `scripts/verify-layout.mjs`, `yarn.lock` | 注册四个 workspace 并同步 verify-layout 的最终 16 项清单；最终接入 root build/typecheck/test/check 并同步计数 fixture |
| `market-server/src/signing.ts`, `market-server/package.json` | 通用原语改从 `@huaanwork/catalog-signing` import/re-export；其余逻辑不动 |
| `dsh-plugin-huaanwork/package.json` | 声明 agent-package-format 与 catalog-signing 直接依赖，供 host 使用；不进入 renderer bundle |
| `dsh-plugin-huaanwork/src/huaanwork-host/agent-package/{types,manifest,store,drafts,host,runtime}.ts` | 复用共享 manifest；扩 state/source/发布字段；安装恢复；运行取消与按 slug 停止 |
| `dsh-plugin-huaanwork/src/huaanwork-host/{settings,index,holders,routes,sessions}.ts` | publish token、M2 服务装配、7 个 RPC、取消/撤销接线 |
| `dsh-plugin-huaanwork/src/client-huaanwork/{rpc-types,api}.ts` | M2 类型和 7 个路由映射；RPC 62→69 |
| `dsh-plugin-huaanwork/tests/client-huaanwork/api.spec.ts`, `tests/huaanwork-host/route-contract.spec.ts` | 全量方法表、路径、必含键和 62→69 计数 |
| `dsh-plugin-huaanwork/src/client-huaanwork/{AgentsView,AgentsPlazaPanel,AgentPackagesPanel}.tsx` | publish token、签名包广场、发布/下载/更新/下架/移除、60 秒撤销刷新 |
| `dsh-plugin-huaanwork/src/client-huaanwork/logic/agentPackagesLogic.ts`, `styles.css` | 状态标签/动作纯函数与最小样式 |
| `dsh-plugin-huaanwork/tests/client-huaanwork/agent-packages-panel.spec.ts` | M2 卡片动作、状态、错误和轮询清理测试 |
| `.github/workflows/windows-agent-package-acceptance.yml` | 追加 M2 headless 双 Profile 探针与报告 artifact，不改既有 M1 步骤 |

---

### Task 1: 抽取零依赖共享签名原语

**Files:**
- Create: `packages/catalog-signing/package.json`
- Create: `packages/catalog-signing/tsconfig.json`
- Create: `packages/catalog-signing/src/index.ts`
- Test: `packages/catalog-signing/tests/signing.test.ts`
- Modify: `market-server/src/signing.ts:190-291,417-440`
- Modify: `market-server/package.json`
- Modify: `package.json`, `scripts/verify-layout.mjs`, `yarn.lock`

**Interfaces:**
- Produces: `canonicalJson(value: unknown): string`、`generateKeyPair()`、`fingerprintPublicKeyHex(hex)`、`extractRawPublicKeyHex(publicKey)`、`publicKeyFromHex(hex)`、`signCanonical(canonical, privateKeyPem)`、`verifyCanonical(canonical, signatureBase64, publicKeyHex)`。
- Produces: `CatalogKeySlot = 1 | 2`、`CatalogKeyringEntry = { keyId: string; publicKeyHex: string; slot: CatalogKeySlot; retiredAt?: string }`、`CatalogSignature = { version: 1; algorithm: 'Ed25519'; keyId: string; slot: CatalogKeySlot; signedAt: string; signature: string }`。
- Produces: `signAgentPackageDigest(digest: unknown, options: { privateKeyPem: string; slot: CatalogKeySlot; signedAt: string }): CatalogSignature`、`verifyAgentPackageDigestSignature(digest: unknown, signature: unknown, keyring: readonly CatalogKeyringEntry[], now?: number): { ok: true; slot: CatalogKeySlot } | { ok: false; reason: 'unknown-key' | 'slot-retired' | 'invalid-signature' | 'invalid-timestamp' }`、`parseCatalogKeyring(raw: unknown): CatalogKeyringEntry[]`。
- Consumes: `market-server/src/signing.ts` 当前 canonical/Ed25519 代码；market 的 envelope 与 `verifyWithKeySlots` 仍归 market-server。

- [ ] **Step 1: 写字节兼容和双槽失败测试**

```ts
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  canonicalJson, generateKeyPair, signAgentPackageDigest,
  verifyAgentPackageDigestSignature,
} from '../src/index.ts'

test('canonicalJson preserves market byte ordering', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: 2, c: 3 }, z: [true, null] }), '{"a":{"c":3,"d":2},"b":1,"z":[true,null]}')
  assert.throws(() => canonicalJson({ bad: Number.NaN }), /non-finite number/)
})

test('signs digest and rejects wrong, unknown, and retired keys', () => {
  const key = generateKeyPair()
  const digest = { schemaVersion: 1, slug: 'weekly-report', version: '1.0.0', files: [] }
  const signature = signAgentPackageDigest(digest, {
    privateKeyPem: key.privateKeyPem, slot: 1, signedAt: '2026-10-24T00:00:00.000Z',
  })
  const entry = { keyId: signature.keyId, publicKeyHex: key.publicKeyHex, slot: 1 as const }
  assert.deepEqual(verifyAgentPackageDigestSignature(digest, signature, [entry], 1), { ok: true, slot: 1 })
  assert.equal(verifyAgentPackageDigestSignature({ ...digest, version: '1.0.1' }, signature, [entry], 1).ok, false)
  assert.deepEqual(verifyAgentPackageDigestSignature(digest, signature, [], 1), { ok: false, reason: 'unknown-key' })
  assert.deepEqual(
    verifyAgentPackageDigestSignature(digest, signature, [{ ...entry, retiredAt: '1970-01-01T00:00:00.000Z' }], 1),
    { ok: false, reason: 'slot-retired' },
  )
})
```

另从 `market-server/tests/fixtures/signing-vectors.json` 逐字段读取 canonical 向量，保留 `fixtureVersion:3` 断言；不得重新生成该 fixture。

- [ ] **Step 2: 运行测试确认失败**

Run: `corepack yarn workspace @huaanwork/catalog-signing test`
Expected: FAIL，workspace/模块尚不存在。

- [ ] **Step 3: 建立 workspace 并移动通用原语**

`package.json` 使用 name=`@huaanwork/catalog-signing`、private=true、type=module、exports=`{ ".": "./src/index.ts" }`；scripts 为 `test: node --experimental-strip-types --test tests/*.test.ts`、`typecheck: tsc --noEmit`、`check: yarn test && yarn typecheck`。devDependencies 固定 `@types/node:^22.20.0`、`typescript:6.0.3`，无 dependencies。tsconfig 复制 market-server 的严格 NodeNext 选项并把 include 改为 `src/**/*.ts`、`tests/**/*.ts`。

把 `market-server/src/signing.ts` 的 canonical/Ed25519 实现原样移入共享包，再增加：

```ts
export function signAgentPackageDigest(digest: unknown, options: {
  privateKeyPem: string; slot: CatalogKeySlot; signedAt: string
}): CatalogSignature {
  const publicKeyHex = extractRawPublicKeyHex(createPublicKey(createPrivateKey(options.privateKeyPem)))
  return {
    version: 1, algorithm: 'Ed25519', keyId: fingerprintPublicKeyHex(publicKeyHex),
    slot: options.slot, signedAt: options.signedAt,
    signature: signCanonical(canonicalJson(digest), options.privateKeyPem),
  }
}
```

验签先在全部 slot 中按 keyId 找 key，声明 slot 只作元数据；任何槽的 `retiredAt` 到点均拒绝。`parseCatalogKeyring` 接受 `{schemaVersion:1,keys:[...]}`，要求 keyId 等于公钥 fingerprint、公钥为 64 位 hex、恰一个 slot=1、至多一个 slot=2、keyId 不重复、retiredAt 可解析；否则抛 `CatalogKeyringError`。

根 `workspaces` 在 `update-server` 后追加 `packages/catalog-signing`，同步把 `scripts/verify-layout.mjs` 的硬编码期望清单改为对应 13 项；执行 `corepack yarn install` 更新 lockfile。后续 Task 2、4、7 依次在同一位置追加 `packages/agent-package-format`、`agent-catalog-server`、`agent-catalog-admin`，并在同一任务同步 verify-layout，最终恰为 16 项；两侧顺序必须一致。

- [ ] **Step 4: market-server 改为共享 import 并跑回归**

`market-server/package.json` 增加 `"@huaanwork/catalog-signing": "workspace:*"`。`market-server/src/signing.ts` 对通用函数只 import/re-export，保留 market 自有类型、常量、envelope、`verifyWithKeySlots`、`signManifest` 的签名和 reason 字符串。不得给共享包加入 `tar` 或 market 类型依赖。

Run:

```bash
corepack yarn workspace @huaanwork/catalog-signing check
corepack yarn workspace market-server check
node scripts/verify-layout.mjs
```

Expected: 全部 PASS，尤其 signing vectors、publish-gate vectors、workspace-dependencies；verify-layout 接受 13 项 workspace。

- [ ] **Step 5: 提交**

```bash
git add packages/catalog-signing market-server/src/signing.ts market-server/package.json package.json scripts/verify-layout.mjs yarn.lock
git commit -m "refactor: share canonical Ed25519 signing primitives"
```

---

### Task 2: 共享 manifest、文件 digest 与目录验签

**Files:**
- Create: `packages/agent-package-format/package.json`, `tsconfig.json`, `src/index.ts`
- Create: `packages/agent-package-format/src/manifest.ts`
- Create: `packages/agent-package-format/src/digest.ts`
- Test: `packages/agent-package-format/tests/digest.test.ts`
- Test: `packages/agent-package-format/tests/helpers.ts`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/agent-package/{types,manifest}.ts`
- Modify: `dsh-plugin-huaanwork/package.json`
- Modify: `package.json`, `scripts/verify-layout.mjs`, `yarn.lock`

**Interfaces:**
- Consumes: Task 1 的 `canonicalJson`、`CatalogKeyringEntry`、`CatalogSignature`、`verifyAgentPackageDigestSignature`。
- Produces: M1 原有 `AgentPackageManifest`、`AgentPackageToolsMode`、`AGENT_PACKAGE_SCHEMA_VERSION`、`parseAgentPackageManifest(raw)`，以及 `compareAgentPackageVersions(a,b): -1|0|1`。
- Produces: `AgentPackageFile = { path: string; data: Buffer }`、`AgentPackageDigest = { schemaVersion:1; slug:string; version:string; manifestSha256:string; files:Array<{path:string;size:number;sha256:string}> }`。
- Produces: `readUnsignedPackageFiles(packageDir:string): AgentPackageFile[]`、`createAgentPackageDigest(manifest, files): AgentPackageDigest`、`verifyAgentPackageDigest(manifest, files, digest): void`、`verifyAgentPackageDirectory(packageDir,keyring,now?): { manifest; digest; signature }`。
- Produces 常量 `MAX_AGENT_PACKAGE_ENTRIES = 1024`、`MAX_AGENT_PACKAGE_PATH_BYTES = 512`，目录枚举与 Task 3 归档解包共用同一份预算。

- [ ] **Step 1: 写 digest、排序、篡改和 semver 测试**

```ts
import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import {
  compareAgentPackageVersions, createAgentPackageDigest,
  readUnsignedPackageFiles, verifyAgentPackageDigest,
} from '../src/index.ts'
import { VALID_MANIFEST } from './helpers.ts'

const manifest = { ...VALID_MANIFEST }
const files = [
  { path: 'persona.md', data: Buffer.from('你是周报助手') },
  { path: 'agent.json', data: Buffer.from(JSON.stringify(manifest)) },
]

test('digest binds sorted paths, sizes, and content hashes', () => {
  const digest = createAgentPackageDigest(manifest, files)
  assert.deepEqual(digest.files.map((file) => file.path), ['agent.json', 'persona.md'])
  assert.equal(digest.manifestSha256, createHash('sha256').update(files[1]!.data).digest('hex'))
  assert.doesNotThrow(() => verifyAgentPackageDigest(manifest, files, digest))
  files[0]!.data = Buffer.from('tampered')
  assert.throws(() => verifyAgentPackageDigest(manifest, files, digest), /包校验失败/)
})

test('semver update comparison includes prerelease and ignores build metadata', () => {
  assert.equal(compareAgentPackageVersions('1.0.1', '1.0.0'), 1)
  assert.equal(compareAgentPackageVersions('1.0.0', '1.0.0+build.2'), 0)
  assert.equal(compareAgentPackageVersions('1.0.0-beta.2', '1.0.0'), -1)
  assert.equal(compareAgentPackageVersions('1.0.0-beta.10', '1.0.0-beta.2'), 1)
})
```

`tests/helpers.ts` 导出完整 `VALID_MANIFEST`：schemaVersion=1、slug=weekly-report、displayName=周报小助手、description=把一周工作整理成周报、version=1.0.0、draftId=00000000-0000-4000-8000-000000000001、createdAt/updatedAt=2026-10-24T00:00:00.000Z、persona=persona.md、skill=null、tools={mode:'none'}、allowSkills=[]。

另写目录枚举预算负例：helper 分别生成含 1025 个 File/Directory 条目且文件内容均为 0 字节的目录，以及含嵌套后总长度 513 字节相对路径的目录；分别用 `assert.throws(() => readUnsignedPackageFiles(tooManyDir), /条目数超过1024/)` 与 `assert.throws(() => readUnsignedPackageFiles(longPathDir), /路径超过512字节/)` 钉住同步拒绝，并确认第 1024 个条目和 512 字节路径仍可通过。

- [ ] **Step 2: 运行测试确认失败**

Run: `corepack yarn workspace @huaanwork/agent-package-format test`
Expected: FAIL，workspace/模块尚不存在。

- [ ] **Step 3: 抽取 M1 manifest，保持现有导入兼容**

新包 name=`@huaanwork/agent-package-format`，exports 为 `.`、`./manifest`、`./digest`、`./bundle`；dependencies 固定：

```json
{
  "@huaanwork/catalog-signing": "workspace:*",
  "@huaanwork/policy": "workspace:*",
  "tar": "7.5.22"
}
```

devDependencies/scripts/tsconfig 与 Task 1 同形。根 workspaces 按 Task 1 约定追加 `packages/agent-package-format`，同步 `scripts/verify-layout.mjs` 为 14 项；`dsh-plugin-huaanwork/package.json` dependencies 加 `"@huaanwork/agent-package-format":"*"`（沿用该包现有 `@huaanwork/*` 内部依赖协议，禁止写成 verify-layout 拒绝的 `workspace:*`），然后运行 `corepack yarn install`。

将 M1 `manifest.ts` 和对应类型/常量原样移到共享 `manifest.ts`。桌面 `agent-package/manifest.ts` 仅 `export { parseAgentPackageManifest } from '@huaanwork/agent-package-format/manifest'`；`types.ts` 保留其他 M1 类型，并 re-export 共享 manifest 类型与常量。不得把 `source/enabled/publishStatus` 加进 manifest。`compareAgentPackageVersions` 使用同一官方 semver 正则，逐段比较 major/minor/patch 与 prerelease，build metadata 不参与先后。

- [ ] **Step 4: 实现文件枚举和 digest 复算**

`readUnsignedPackageFiles` 用 `lstat` 拒绝任何 symlink，递归只收普通文件，拒绝 `.signature/`、`.tmp-*`、`.old-*`、`.install-*`、绝对/反斜杠/`..`/NUL 路径；路径必须匹配 `^[A-Za-z0-9._/-]+$`。遍历时对 File/Directory 条目统一计数，超过 `MAX_AGENT_PACKAGE_ENTRIES` 立即停止递归；每个规范化相对路径先算 `Buffer.byteLength(path,'utf8')`，超过 `MAX_AGENT_PACKAGE_PATH_BYTES` 立即抛错，不得等到文件全部入数组后才检查。内部另有 `readPackageFiles(packageDir,{ignoreSignature:true})` 供签名目录复验使用：只忽略 `.signature/package-digest.json` 与 `.signature/signature.json`，其他 `.signature/` 内容仍拒绝；公开 unsigned 入口不开放该选项。解析 `agent.json` 后复用 `parseAgentPackageManifest`，检查 persona/skill/入口声明、脚本数≤20、persona/SKILL≤32 KiB、脚本和入口≤256 KiB、总量≤5 MiB。

```ts
export function createAgentPackageDigest(manifest: AgentPackageManifest, files: AgentPackageFile[]): AgentPackageDigest {
  const sorted = [...files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  if (new Set(sorted.map((file) => file.path)).size !== sorted.length) throw new Error('包结构非法：重复文件')
  const rows = sorted.map((file) => ({
    path: file.path, size: file.data.byteLength,
    sha256: createHash('sha256').update(file.data).digest('hex'),
  }))
  const manifestRow = rows.find((file) => file.path === 'agent.json')
  if (!manifestRow) throw new Error('包结构非法：缺少 agent.json')
  return { schemaVersion: 1, slug: manifest.slug, version: manifest.version, manifestSha256: manifestRow.sha256, files: rows }
}
```

`verifyAgentPackageDigest` 对重新生成的 digest 与输入 digest 做 `canonicalJson` 字节比较；`verifyAgentPackageDirectory` 只额外读取 `.signature/package-digest.json` 和 `.signature/signature.json`，先验文件 digest，再验签名，任何额外文件或失败统一抛 `包校验失败，未安装或未运行。请联系管理员`。

- [ ] **Step 5: 跑共享与 M1 回归并提交**

Run:

```bash
corepack yarn workspace @huaanwork/agent-package-format check
corepack yarn workspace dsh-plugin-huaanwork test tests/huaanwork-host/agent-package-store.spec.ts tests/huaanwork-host/agent-package-drafts.spec.ts
corepack yarn workspace dsh-plugin-huaanwork typecheck
node scripts/verify-layout.mjs
```

Expected: PASS，M1 manifest 行为无变化；verify-layout 接受 14 项 workspace 和 huaanwork 的 `"*"` 内部依赖。

```bash
git add packages/agent-package-format dsh-plugin-huaanwork/src/huaanwork-host/agent-package/{types,manifest}.ts dsh-plugin-huaanwork/package.json package.json scripts/verify-layout.mjs yarn.lock
git commit -m "feat: add signed agent package digest format"
```

---

### Task 3: 安全创建和解包 unsigned/signed bundle

**Files:**
- Create: `packages/agent-package-format/src/bundle.ts`
- Test: `packages/agent-package-format/tests/bundle.test.ts`
- Modify: `packages/agent-package-format/src/index.ts`

**Interfaces:**
- Consumes: Task 2 的 `AgentPackageFile`、`AgentPackageDigest`、`createAgentPackageDigest`、`verifyAgentPackageDigest`、`MAX_AGENT_PACKAGE_ENTRIES`、`MAX_AGENT_PACKAGE_PATH_BYTES`；Task 1 的签名类型和验签。
- Produces: `buildUnsignedAgentPackageBundle(files): Promise<Buffer>`、`inspectUnsignedAgentPackageBundle(bundle): Promise<{ manifest; files; digest }>`、`buildSignedAgentPackageBundle(files,digest,signature): Promise<Buffer>`、`inspectSignedAgentPackageBundle(bundle,keyring,now?): Promise<{ manifest; files; digest; signature }>`。四个 API 均为 async；调用方必须 await，禁止用同步 `doesNotThrow` 验证异步验签。
- Produces 常量 `MAX_AGENT_PACKAGE_BUNDLE_BYTES = 5 * 1024 * 1024`。

- [ ] **Step 1: 写恶意归档失败测试**

用 `tar@7.5.22` 的 `Pack` 构造测试输入，不用系统 tar。测试表逐项构造并断言拒绝：

```ts
for (const entry of [
  { name: '../escape', type: 'File' },
  { name: '/absolute', type: 'File' },
  { name: 'C:/windows', type: 'File' },
  { name: 'skill\\script.mjs', type: 'File' },
  { name: 'skill/link', type: 'SymbolicLink', linkpath: '/etc/passwd' },
  { name: 'skill/hardlink', type: 'Link', linkpath: 'agent.json' },
]) {
  await assert.rejects(
    inspectUnsignedAgentPackageBundle(await makeArchive([entry, validAgentJson, validPersona])),
    /包结构非法/,
  )
}
await assert.rejects(
  inspectUnsignedAgentPackageBundle(await makeArchive([validAgentJson, validAgentJson, validPersona])),
  /重复/,
)
await assert.rejects(inspectUnsignedAgentPackageBundle(Buffer.alloc(6 * 1024 * 1024)), /5 MiB|包结构非法/)
```

`makeArchive` 在测试中把每个 entry 的 name/type/linkpath/content 显式写入 `Pack`，gzip 后返回 Buffer；`validAgentJson.content=JSON.stringify(VALID_MANIFEST)`、`validPersona.content='你是周报助手'`。再增加 gzip 内声明 6 MiB 普通文件的用例，断言累计解压超过 5 MiB 即中止，而非等待完整解压。

另构造三组条目预算负例：1025 个 0 字节 File、1025 个 0 字节 Directory、嵌套/PAX 规范化后 513 字节的路径；File/Directory 两组用 `await assert.rejects(inspectUnsignedAgentPackageBundle(await makeArchive(entries)), /条目数超过1024/)`，长路径组用 `await assert.rejects(inspectUnsignedAgentPackageBundle(await makeArchive(entries)), /路径超过512字节/)`。超帽归档在第 1025 条后再放一个 `/absolute`，断言仍得到条目数错误而非后续路径错误，以证明未继续解析；实现必须在当前条目进入 `AgentPackageFile[]` 前 `destroy`。1024 条和 512 字节路径各保留一个边界通过用例。

- [ ] **Step 2: 运行测试确认失败**

Run: `corepack yarn workspace @huaanwork/agent-package-format test tests/bundle.test.ts`
Expected: FAIL，`bundle.ts` 尚不存在。

- [ ] **Step 3: 实现流式打包和 capped 内存解包**

打包用临时 staging 目录写普通文件，`tar.c({ cwd, gzip:true, portable:true, noMtime:true }, sortedPaths)` 返回流；`buildUnsignedAgentPackageBundle` 与 `buildSignedAgentPackageBundle` 都声明 `async`，用 Promise 等待 `end/error` 并逐 chunk 收集，超过 5 MiB 立即 destroy 且 reject，最终 `Promise<Buffer>` 只在流成功后 resolve。unsigned 不包含 `.signature/`；signed 额外写 digest 的 canonical UTF-8 字节和 `JSON.stringify(signature)`，等待两个签名文件写入 staging 后再启动打包。

解包用 `Readable.from([bundle]).pipe(tar.t({ gzip:true, onentry }))`，不把不可信条目直接写盘；内部 `unpackCapped` 同样返回 Promise，在 parser `end` 时 resolve、流或 parser `error` 时 reject。`onentry` 只接受 File/Directory；每次回调先把条目计数加一，超过 `MAX_AGENT_PACKAGE_ENTRIES` 立即 `parser.destroy(new Error('包结构非法：条目数超过1024'))`，再为当前条目分配内容缓冲。文件路径归一 `./` 前缀后再做绝对/盘符/反斜杠/`..`/NUL/重复检查，并计算规范化路径的 UTF-8 字节数，超过 `MAX_AGENT_PACKAGE_PATH_BYTES` 立即 destroy。每个文件按 entry.size 预扣总预算，data 累计再核对实际字节；超过 5 MiB 调用 parser.destroy(error)。完成后拒绝空文件集合、目录/文件前缀冲突和重复目录转文件。

```ts
export async function inspectUnsignedAgentPackageBundle(bundle: Buffer): Promise<UnsignedInspection> {
  const files = await unpackCapped(bundle)
  if (files.some((file) => file.path.startsWith('.signature/'))) throw new Error('包结构非法：提交包不得包含签名')
  const manifest = parseManifestFromFiles(files)
  validateUnsignedFiles(manifest, files)
  return { manifest, files, digest: createAgentPackageDigest(manifest, files) }
}
```

signed inspection 只允许 digest 清单外加两个签名文件；先 await 解包并逐文件复算，再以 Task 1 keyring 验签。所有结构错误不得包含服务器路径或 bundle 内容。

- [ ] **Step 4: 验证 round-trip、额外文件和签名负例**

增加并运行以下断言：await unsigned build→digest→签名→await signed build→await signed inspection 的 round-trip 返回原文件；signed 多一个 `extra.txt`、少一个 persona、digest 改一个 hash、signature 改一个字符、未知 key 均用 `await assert.rejects(...)` 拒绝；签名文件本身不计入 digest.files。最后跑整个包测试。

Run: `corepack yarn workspace @huaanwork/agent-package-format check`
Expected: PASS；被测解包不得保留超过 5 MiB 的文件内容或超过 1024 个条目，0 字节条目不能绕过预算；market-server `check` 仍 PASS 且无 `tar` 依赖。

- [ ] **Step 5: 提交**

```bash
git add packages/agent-package-format
git commit -m "feat: safely pack and inspect agent package bundles"
```

---

### Task 4: 仓内目录服务、M-A0 兼容、三 token 与审计

**Files:**
- Create: `agent-catalog-server/package.json`, `tsconfig.json`
- Create: `agent-catalog-server/src/{types,config,auth,store,audit,legacy,server,index}.ts`
- Test: `agent-catalog-server/tests/helpers.ts`, `tests/auth-legacy.spec.ts`
- Modify: `package.json`, `scripts/verify-layout.mjs`, `yarn.lock`

**Interfaces:**
- Produces: `loadAgentCatalogConfig(env): AgentCatalogConfig`、`createAgentCatalogServer(config): http.Server`、`CatalogStore`、`writeAudit(entry)`。
- Config: `host` 默认 127.0.0.1、`port` 默认 18080、`entriesDir`、`dataDir`、`readToken`、`publishToken`、`adminToken`、`keyring`；env 分别为 `HOST`、`PORT`、`AGENT_CATALOG_ENTRIES_DIR`、`AGENT_CATALOG_DATA_DIR`、`AGENT_CATALOG_TOKEN`、`AGENT_CATALOG_PUBLISH_TOKEN`、`AGENT_CATALOG_ADMIN_TOKEN`、`AGENT_CATALOG_KEYRING_PATH`。
- Legacy contract: `GET /v1/catalog`→`{items:[...]}`；`GET /v1/catalog/{name}`→单条目或 404 `{"error":"条目不存在"}`；401=`{"error":"口令错误"}`。

- [ ] **Step 1: 写 M-A0 契约和三 token 隔离测试**

`tests/helpers.ts` 创建临时 entries/data/keyring，三条 token 固定为测试字符串 `test-read-token-012345678901234567890123456789`、`test-publish-token-012345678901234567890123456789`、`test-admin-token-012345678901234567890123456789`，在随机端口起服并返回 `baseUrl`、`request(path,{token,method,body})`、cleanup。

```ts
test('keeps M-A0 catalog contract and separates roles', async () => {
  assert.equal((await request('/v1/catalog', { token: 'test-read-token-012345678901234567890123456789' })).status, 200)
  assert.deepEqual((await request('/v1/catalog', {})).body, { error: '口令错误' })
  assert.equal((await request('/v1/catalog/typo-check', { token: 'test-read-token-012345678901234567890123456789' })).body.name, 'typo-check')
  assert.equal((await request('/v1/catalog/%E0%A4%A', { token: 'test-read-token-012345678901234567890123456789' })).status, 404)
  assert.equal((await request('/v1/agent-packages/submissions', { token: 'test-read-token-012345678901234567890123456789', method: 'POST', body: Buffer.alloc(1) })).status, 403)
  assert.equal((await request('/v1/agent-packages/submissions?status=pending', { token: 'test-publish-token-012345678901234567890123456789' })).status, 403)
})
```

审计断言：成功读、401、403 均在 `audit.jsonl` 留下 timestamp/actor/action/outcome；actor 是 token SHA-256 前 12 hex，文件不包含任何原 token。

- [ ] **Step 2: 运行测试确认失败**

Run: `corepack yarn workspace agent-catalog-server test`
Expected: FAIL，workspace 尚不存在。

- [ ] **Step 3: 实现配置、鉴权、legacy 和原子 store**

新 workspace scripts 同 market-server：`start=node --experimental-strip-types src/index.ts`、build=no-op 文案、typecheck、vitest、check；dependencies 为两个 `@huaanwork/*` 共享包，devDependencies 固定 Node types/TS6/Vitest 4.1.8。根 workspaces 按 Task 1 约定追加 `agent-catalog-server`，同步 `scripts/verify-layout.mjs` 为 15 项并 `corepack yarn install`。

配置缺失任一路径/token/keyring 即拒绝启动，三 token 必须互不相同且各≥32 字符；测试 helper 用满足长度的常量。`auth.ts` 对 Bearer 字节先 SHA-256 再 `timingSafeEqual`，权限矩阵：

| 路由面 | read | publish | admin |
|---|---|---|---|
| `/v1/catalog*`、`/v1/agent-packages` GET、bundle、revocations | 允许 | 拒绝 | 拒绝 |
| 创建/查看自己的 submission、申请 delist | 拒绝 | 允许 | 拒绝 |
| pending 列表、审查 bundle、approve/reject、delist 审批、revoke | 拒绝 | 拒绝 | 允许 |

`legacy.ts` 每请求读取 `entriesDir/*.json`，保留原“坏文件跳过并警告、目录缺失返回空”的行为；路由 decode 失败返回同一 404。

`store.ts` 定义单一 `CatalogState`：

```ts
type CatalogState = {
  schemaVersion: 1
  submissions: Record<string, Submission>
  packages: Record<string, PublishedPackage>
  delistRequests: Record<string, DelistRequest>
  revocations: Record<string, Revocation>
}
```

key 分别为 submission id、`${slug}/${version}`、request id、`${slug}/${version}`。初始全部空对象。`update(mutator)` 在进程内全局写队列中深拷贝当前状态，写 `${dataDir}/state.json.tmp-<pid>-<random>`、fsync、rename；`withPackageLock(slug,version,fn)` 提供按版本串行锁。启动只删自己的 state 临时文件，不删除 bundle 恢复证据。

- [ ] **Step 4: 实现全请求审计与错误响应**

`audit.ts` 用同一异步写队列串行执行“读取现有 `audit.jsonl`→追加一行完整 JSON→写临时文件→fsync→rename”，不能用单次 rename 覆盖历史行；记录 `timestamp`、`actor`、`action`、`outcome`、`status`、`slug?`、`version?`、`submissionId?`、`reason?`。actor 仅 token hash 前 12 hex，无 token 时为 `anonymous`。`redactSecrets` 在写 reason/错误前替换三个已配置 token 的所有出现值及 `-----BEGIN ... PRIVATE KEY-----` 整块，测试要把 token 故意放进 reason 并断言仍不落盘。所有请求（含 GET、认证失败、未知路由）在响应前完成审计；审计写失败返回 500，不能静默无审计继续写操作。

统一错误体 `{error:string,code?:string}`，JSON 响应≤1 MiB，未知路由 404，错误方法 405；server 不记录 Authorization header。启动时读取并验证 keyring，但不读取任何私钥路径。

- [ ] **Step 5: 运行测试并提交**

Run: `corepack yarn workspace agent-catalog-server check && node scripts/verify-layout.mjs`
Expected: PASS；verify-layout 接受 15 项 workspace；用仓外三个 entries fixture 跑时，`GET /v1/catalog` 与原服务条目逐字段相同。

```bash
git add agent-catalog-server package.json scripts/verify-layout.mjs yarn.lock
git commit -m "feat: add authenticated agent catalog server foundation"
```

---

### Task 5: 提交审查、独立 digest 与签名批准发布

**Files:**
- Create: `agent-catalog-server/src/submissions.ts`
- Modify: `agent-catalog-server/src/{types,server}.ts`
- Test: `agent-catalog-server/tests/submissions.spec.ts`

**Interfaces:**
- Consumes: Task 3 unsigned/signed bundle；Task 4 store/auth/keyring。
- Produces: `POST /v1/agent-packages/submissions`、`GET /v1/agent-packages/submissions/{id}`、`GET /v1/agent-packages/submissions?status=pending`、`GET /v1/agent-packages/submissions/{id}/bundle`（admin 审查下载）、approve/reject。
- Produces read routes: `GET /v1/agent-packages`、`GET /v1/agent-packages/{slug}/{version}`、`GET /v1/agent-packages/{slug}/{version}/bundle`。
- Submission status: `pending-review | published | rejected`；响应包含 `submissionId,slug,version,status,submittedAt,updatedAt,digest,reason?`。admin 查看时还包含服务端实时计算的 `previousVersion?:string` 与 `previousDigest?:AgentPackageDigest`，供 CLI diff，不要求 admin token 拥有公共读权限。
- Published metadata 增加可选 `migrationFrom?:string`；只有合法 `X-Agent-Catalog-Migration` 的批准才写同 slug 值，普通发布不得伪造。

- [ ] **Step 1: 写提交、批准、重复版本和并发测试**

```ts
test('publishes only after a valid admin signature', async () => {
  const submitted = await request('/v1/agent-packages/submissions', {
    method: 'POST', token: publishToken, body: unsignedBundle,
  })
  assert.equal(submitted.status, 201)
  const id = submitted.body.submissionId
  const before = await request(`/v1/agent-packages/${slug}/1.0.0/bundle`, { token: readToken })
  assert.equal(before.status, 404)
  const approved = await request(`/v1/agent-packages/submissions/${id}/approve`, {
    method: 'POST', token: adminToken, body: { signature: signDigest(submitted.body.digest) },
  })
  assert.equal(approved.status, 200)
  const downloaded = await request(`/v1/agent-packages/${slug}/1.0.0/bundle`, { token: readToken })
  await assert.doesNotReject(() => inspectSignedAgentPackageBundle(downloaded.buffer, keyring))
})
```

另断言：publish token 不能 approve；服务端 digest 不信任客户端头；错误签名/未知 key/退休 key 不发布；pending/published 重复版本 409；两个并发同版本提交恰一个 201、一个 409；rejected 同版本同 digest 可重新提交，不同 digest 409；普通提交与 legacy agent/tool 或另一包 slug 冲突 409。

- [ ] **Step 2: 运行测试确认失败**

Run: `corepack yarn workspace agent-catalog-server test tests/submissions.spec.ts`
Expected: FAIL，路由不存在。

- [ ] **Step 3: 实现 raw tgz 提交与冲突规则**

POST submissions 只接受 `Content-Type: application/gzip`，body 在 5 MiB+1 处中止；`await inspectUnsignedAgentPackageBundle` 重算 digest，忽略并不接受客户端 digest。保存到 `submissions/{id}/bundle.tgz.tmp-*`→rename，再原子更新 state；响应 201。

迁移例外使用显式 header `X-Agent-Catalog-Migration: <slug>`：仅当值等于 manifest.slug、entriesDir 中存在同名 `kind:"agent"` 条目时允许 legacy 冲突；tool 永不允许。无该 header 时同名 legacy 一律冲突。批准时再次检查冲突，防止 pending 期间新增占用。普通发布和迁移都仍需管理员签名，没有特权直通。

- [ ] **Step 4: 实现审查下载、approve/reject 和原子可见性**

admin GET pending 返回全部 pending；GET submission/{id} 允许 admin 或创建该提交的 publish actor，admin 响应动态附 `previousVersion/previousDigest`（取当时最高已签名发布记录，包含 delisted/revoked，供审查 diff）；admin GET submission/{id}/bundle 返回 unsigned tgz。reject body=`{reason:string}`，trim 后 1–500，状态变 rejected。

approve body 只含 `{signature}`。服务端用存储 digest 和 pin keyring 验签，`await buildSignedAgentPackageBundle(files,digest,signature)` 后再 `await inspectSignedAgentPackageBundle` 自验，写 `packages/{slug}/{version}/bundle.tgz` 临时文件并 rename，最后一次性更新 state：package.status=published、submission.status=published；合法迁移另写 `package.migrationFrom=slug`。`PublishedPackage` 固定为 `{slug,version,manifest,digest,signature,status:'published'|'delisted'|'revoked',size,updatedAt,actor,migrationFrom?}`，其中 size 是最终 signed bundle 字节数，list/detail 不再读不可信客户端字段。state 未提交前 bundle 不可见；若最终路径已存在且 state 未发布，只有 digest 完全相同才允许恢复性重试，否则 409。

read 列表只返回 status=published 且未 delisted/revoked 的每个 slug 最高 semver：

```ts
type AgentPackageSummary = {
  slug: string; displayName: string; description: string;
  version: string; size: number; status: 'published'; updatedAt: string;
  migrationFrom?: string
}
```

metadata 对已安装客户端仍返回 delisted/revoked 状态，但只有 published 才含 `bundleUrl`；bundle 路由对 delisted/revoked 返回 410，对未知版本 404。路由表先匹配 `/submissions`、`/delist-requests`、`/revocations` 等静态段，再匹配 `/{slug}/{version}`，防止 admin/read API 被动态 slug 路由吞掉。

- [ ] **Step 5: 运行全部服务端测试并提交**

Run: `corepack yarn workspace agent-catalog-server check`
Expected: PASS；audit 同时含提交成功、签名失败、重复版本、批准成功，且无 token/私钥。

```bash
git add agent-catalog-server
git commit -m "feat: implement reviewed and signed agent package publishing"
```

---

### Task 6: 下架申请、撤销列表与分发状态机

**Files:**
- Create: `agent-catalog-server/src/governance.ts`
- Modify: `agent-catalog-server/src/{types,server}.ts`
- Test: `agent-catalog-server/tests/governance.spec.ts`

**Interfaces:**
- Produces: `POST /v1/agent-packages/{slug}/{version}/delist-requests`、`GET /v1/agent-packages/delist-requests?status=pending`、`POST /v1/agent-packages/delist-requests/{id}/approve|reject`。
- Produces: `POST /v1/agent-packages/{slug}/{version}/revoke`、`GET /v1/agent-packages/revocations`。
- Types: `DelistRequest={id,slug,version,status:'pending'|'approved'|'rejected',reason,actor,createdAt,resolvedAt?}`；`Revocation={slug,version,reason,revokedAt,actor}`。

- [ ] **Step 1: 写下架与撤销语义测试**

先经 Task 5 helper 发布 1.0.0。断言：创建者申请下架后仍 pending 且可下载；admin 批准后列表隐藏、bundle 410、metadata=delisted；已安装客户端仍能读取 metadata 的 digest/signature。拒绝下架保持 published。重复 pending 申请返回同一 request id，已 resolved 请求不可再次审批。

撤销后列表隐藏、bundle 410、metadata=revoked；revocations 返回精确 slug/version/reason/revokedAt；下架版本也可撤销。重复撤销保持首次 reason/revokedAt 并返回 200 幂等；不存在版本 404；read/publish token 不能 revoke；不提供 unrevoke 路由（404）。

- [ ] **Step 2: 运行测试确认失败**

Run: `corepack yarn workspace agent-catalog-server test tests/governance.spec.ts`
Expected: FAIL。

- [ ] **Step 3: 实现下架申请与审批**

申请 body=`{reason:string}`，1–500；仅已发布版本的创建 actor 可申请。使用 package lock 防止 approve 与 revoke/delist 竞争。approve 将 package.status=delisted、request.status=approved 一次 state 提交；reject 只改 request，不改 package。所有响应和审计含 request id，不写 token。

- [ ] **Step 4: 实现撤销与读取过滤**

revoke body=`{reason:string}`，1–500；写入 revocation 并把 package.status=revoked。`GET /revocations` 返回 `{items: Revocation[]}`，按 revokedAt 再 slug/version 稳定排序。列表、metadata、bundle 的过滤共用 `packageDistributionStatus(record)`，禁止三条路由各自漂移。

- [ ] **Step 5: 运行测试并提交**

Run: `corepack yarn workspace agent-catalog-server check`
Expected: PASS；并发 delist/revoke 最终只能是 revoked，且两次操作均有审计。

```bash
git add agent-catalog-server
git commit -m "feat: add agent package delisting and revocations"
```

---

### Task 7: 离线管理员审查、签名与迁移 CLI

**Files:**
- Create: `agent-catalog-admin/package.json`, `tsconfig.json`
- Create: `agent-catalog-admin/src/{client,review,cli}.ts`
- Test: `agent-catalog-admin/tests/cli.spec.ts`
- Modify: `package.json`, `scripts/verify-layout.mjs`, `yarn.lock`

**Interfaces:**
- Consumes: Task 5/6 admin APIs、Task 1 签名、Task 3 bundle inspection。
- Commands: `review <submissionId> --out <dir>`、`approve <submissionId> --review <dir>/review.json --private-key <path> --slot 1|2 --yes`、`reject <submissionId> --reason <text>`、`delist-requests`、`delist-approve <id>`、`delist-reject <id> --reason <text>`、`revoke <slug> <version> --reason <text>`、`migrate-legacy <slug> --submit`。
- Env: `AGENT_CATALOG_URL`、`AGENT_CATALOG_ADMIN_TOKEN`；`migrate-legacy` 读取旧条目另需 `AGENT_CATALOG_TOKEN`，`migrate-legacy --submit` 另需 `AGENT_CATALOG_PUBLISH_TOKEN`。私钥只从 `--private-key` 指定文件读取。

- [ ] **Step 1: 写 CLI 审查门禁和全流程测试**

测试用动态测试私钥文件（mkdtemp、mode 0600）和真实临时服务，spawn：

```ts
const review = runCli(['review', submissionId, '--out', reviewDir])
assert.equal(review.status, 0)
assert.match(review.stdout, /weekly-report/)
assert.match(review.stdout, /agent\.json/)
assert.match(review.stdout, /上一版本/)
const early = runCli(['approve', submissionId, '--review', join(reviewDir, 'review.json'), '--private-key', keyPath, '--slot', '1', '--yes'], {
  AGENT_CATALOG_URL: tamperedServerUrl,
})
assert.notEqual(early.status, 0)
const approved = runCli(['approve', submissionId, '--review', join(reviewDir, 'review.json'), '--private-key', keyPath, '--slot', '1', '--yes'])
assert.equal(approved.status, 0)
await assert.doesNotReject(() => inspectSignedAgentPackageBundle(downloadPublished(), keyring))
```

再覆盖：没有 `--yes` 不签名；review 后服务端 digest 改变即拒绝；reject/delist approve+reject/revoke 各走真实接口；迁移生成最小包后仍是 pending，未经 approve 不可下载；stdout/stderr/audit 不含私钥 PEM 和 token。

- [ ] **Step 2: 运行测试确认失败**

Run: `corepack yarn workspace agent-catalog-admin test`
Expected: FAIL，workspace 尚不存在。

- [ ] **Step 3: 实现 review 和 approve，不绕过人工确认**

新 workspace scripts=`start: node --experimental-strip-types src/cli.ts`、no-op build、test/typecheck/check，dependencies 为两个共享包，根 workspaces 按 Task 1 约定追加 `agent-catalog-admin`，同步 `scripts/verify-layout.mjs` 为最终 16 项并 install。参数用 `node:util.parseArgs` 和显式 subcommand switch，不引入 CLI 框架。

`review` 经 admin token 下载 submission metadata+bundle，独立 `await inspectUnsignedAgentPackageBundle`，与服务器 `canonicalJson(digest)` 逐字节比较；列出 manifest、每个 path/size/sha256。使用 admin metadata 的 `previousVersion/previousDigest`，按 path 输出 `added/removed/changed` 及前后 hash；无上一版时打印 `上一版本：无`。不得用 admin token 调公共只读路由，也不需要为 review 配置 read token。写：

```ts
type ReviewReceipt = {
  schemaVersion: 1
  submissionId: string
  digest: AgentPackageDigest
  digestSha256: string
  reviewedAt: string
}
```

`approve` 重新 GET submission，比较当前 digest 与 receipt，再复算 `sha256(canonicalJson(digest))` 对照 `digestSha256`；要求 `--yes`，然后才读取私钥、调用 `signAgentPackageDigest`、POST approve。任何一步失败退出非 0，且不打印私钥。

- [ ] **Step 4: 实现治理命令和 legacy 迁移**

治理命令只调用 Task 6 API，reason 原样 trim 校验 1–500。`migrate-legacy` 从 `AGENT_CATALOG_URL/v1/catalog/{slug}` 用 read token（env `AGENT_CATALOG_TOKEN`）读取 persona 条目：优先使用内联 `persona`；否则对 `personaUrl` 强制 LAN 校验，携带同一 read token、5 秒超时获取，若响应 JSON 含字符串 persona 则取该字段，否则取原文；最终 persona trim 后非空且 UTF-8≤32 KiB，否则拒绝迁移。随后生成 version=1.0.0、随机 draftId、当前 createdAt/updatedAt、persona.md、skill=null、tools.mode=none、allowSkills=[]；displayName 取 `displayName || name`，description 取原 description，禁止迁移 tool 条目。生成后必须经共享 manifest 全量校验，`await buildUnsignedAgentPackageBundle` 后再 `await inspectUnsignedAgentPackageBundle` 自检，description>200 等旧数据问题直接报错，不静默截断。`--submit` 用 publish token 和 `X-Agent-Catalog-Migration: <slug>` 提交同一份 unsigned bundle；不自动 approve。

- [ ] **Step 5: 运行 CLI 与服务端回归并提交**

Run:

```bash
corepack yarn workspace agent-catalog-admin check
corepack yarn workspace agent-catalog-server check
node scripts/verify-layout.mjs
```

Expected: PASS；review receipt 变化、错误 key、未确认均没有 published 状态；verify-layout 接受最终 16 项 workspace。

```bash
git add agent-catalog-admin package.json scripts/verify-layout.mjs yarn.lock
git commit -m "feat: add offline agent catalog review and signing CLI"
```

---

### Task 8: 桌面发布 token、目录客户端与本地发布状态

**Files:**
- Create: `dsh-plugin-huaanwork/src/huaanwork-host/agent-package/catalog-client.ts`
- Create: `dsh-plugin-huaanwork/src/huaanwork-host/agent-package/catalog-publish.ts`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/{settings,index,holders}.ts`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/agent-package/{types,store,drafts,host}.ts`
- Test: `dsh-plugin-huaanwork/tests/huaanwork-host/agent-package-catalog-publish.spec.ts`
- Modify: `dsh-plugin-huaanwork/tests/huaanwork-host/settings.spec.ts`

**Interfaces:**
- Consumes: Task 5/6 HTTP API、Task 2/3 bundle、M1 store/drafts。
- Produces: `AgentCatalogClient`（listPackages/getPackage/downloadBundleToFile(slug,version,destination)/getRevocations/submit/getSubmission/requestDelist）、`refreshCatalogPackageCache()`、`readCachedCatalogPackageSlugs():string[]`；下载先写调用方指定的临时文件，5 MiB+1 即中止并删除。客户端不调用 admin-only 的 delist-requests 列表。
- Produces: `publishLocalAgentPackage(slug): Promise<{submissionId:string}>`、`refreshLocalAgentPackagePublishStatus(slug)`、`requestLocalAgentPackageDelist(slug,reason)`；`logAgentPackageAction(logger,action,fields)` 只记录 action/slug/version/submissionId/outcome/reason，不接收 token 或私钥参数。
- State 新增：`source:'local'|'catalog'`；可选 `publishStatus:'none'|'pending-review'|'published'|'rejected'|'delisted'|'installed'`、`publishedVersion`、`submissionId`、`reviewReason`、`delistRequestId`、`revoked?:AgentPackageRevocation`。导出 `AgentPackageRevocation={slug:string;version:string;reason:string;revokedAt:string}`，与服务端 Revocation 的客户端字段一致（不含仅用于审计的 `actor`），类型留在桌面。

- [ ] **Step 1: 写发布状态与三 token 使用测试**

用真实 `writeAgentPackageAtomically` 创建本地包和临时 HTTP 服务：

```ts
test('submit stores pending status and never uses read/admin credentials', async () => {
  const result = await publishLocalAgentPackage('weekly-report')
  assert.match(result.submissionId, /^[0-9a-f-]{36}$/)
  assert.equal(readAgentPackageState(profileDir)['local:weekly-report']?.publishStatus, 'pending-review')
  assert.equal(seenAuthorization, `Bearer ${publishToken}`)
  assert.equal(seenContentType, 'application/gzip')
  assert.equal(seenBody.includes('private'), false)
})

test('local content commit resets publication but preserves enabled', async () => {
  seedState('local:weekly-report', { enabled: true, publishStatus: 'published', publishedVersion: '1.0.0' })
  await commitExistingUpdate(profileDir, 'weekly-report')
  const state = readAgentPackageState(profileDir)['local:weekly-report']
  assert.equal(state?.enabled, true)
  assert.equal(state?.publishStatus, 'none')
  assert.equal(state?.submissionId, undefined)
})
```

另覆盖 rejected reason、approved→published/publishedVersion、delisted、无 publish token 报 `目录口令错误或权限不足`、网络失败不改旧状态、重复 pending 不重复提交、缓存中的签名广场 slug 被 takenSlugs 拒绝、跨 origin 下载地址被拒绝且不发送 token。再补 state 回归：local/catalog 两种条目启停后均保留 `publishStatus/submissionId/reviewReason/delistRequestId/revoked`，catalog 不生成第二个 `local:` 键，list/detail 的 source 与 enabled 来自同一实际 state key；带签名目录缺少 catalog state 时不得按 local 放行。

- [ ] **Step 2: 运行测试确认失败**

Run: `corepack yarn workspace dsh-plugin-huaanwork test tests/huaanwork-host/agent-package-catalog-publish.spec.ts`
Expected: FAIL，客户端/发布模块不存在。

- [ ] **Step 3: 扩展设置、state 和客户端**

`AppSettings`、defaults、parse、merge 增加 `agents_catalog_publish_token:string`，缺省空并 trim；settings 测试断言旧设置无该键仍兼容、settings.set 可保存、日志不输出 token。 holders 的 Context 声明与 `HUAANWORK_CONTEXT_PROPS` 同步增加 `huaanworkAgentCatalogClient`、`huaanworkAgentCatalogSecurity`。

state 读取白名单改为 `local:` 且 source=local，或 `catalog:` 且 source=catalog；按字段白名单保留 M2 可选字段，未知字段丢弃，缺省本地 `publishStatus:'none'`、目录新装 `installed`。`readAgentPackageFromDir`/list/detail 必须按实际 `local:`/`catalog:` 键得出 source 与 enabled；带 `.signature` 的目录没有合法 catalog state 时按 catalog broken 处理，不得回退成 local。`setAgentPackageEnabled` 写回同一个 key，并以 `...state[key]` 保留发布、下架和撤销字段，禁止再用整值覆写清掉它们或给 catalog 另写 `local:` 键；两个 key 同时存在时先报状态损坏，不猜测来源。store 写状态保持 tmp+rename。

client 从现有 `agents_host/agents_port` 构造同一 LAN root URL；read 操作用 read token，submit/delist 用 publish token。请求 5 秒超时、JSON≤1 MiB、bundle≤5 MiB；bundleUrl 只允许解析为目录 root 的同源 `/v1/agent-packages/{slug}/{version}/bundle` 路径，redirect=manual，禁止把 Authorization 发往其他 origin。401/403 映射 `目录口令错误或权限不足`，网络/超时映射 `目录不可达，请稍后重试；本地智能体不受影响`，错误不附带 Authorization。

`refreshCatalogPackageCache` 在启动和每次 packageRefresh 拉取签名广场列表，写 `{profileDir}/agent-catalog-packages-cache.json`（tmp+rename）；失败保留上次缓存。index 的 `takenSlugs` 合并原有 local/legacy/tool 名称与 `readCachedCatalogPackageSlugs()`，因此新建/更新能拒绝已知签名广场 slug；服务端仍在提交/批准时做权威冲突检查，离线无缓存不得声称已完成全局唯一性验证。

- [ ] **Step 4: 实现提交、状态刷新、下架和本地变更复位**

提交时只允许 source=local、非 broken、非 pending；`readUnsignedPackageFiles`→`await buildUnsignedAgentPackageBundle`→client.submit，成功才写 pending+submissionId 并发 `agent/changed`。状态刷新按 submissionId 查询，映射 rejected/published；published 同时写 `publishedVersion=当前 manifest.version`。下架要求本地 `publishStatus=published` 和 publishedVersion，提交 reason 后保存 delistRequestId；刷新 metadata=delisted 时状态改 delisted。

在 `commitAgentPackage` 成功写入且非 `alreadyCommitted` 后调用 `resetLocalAgentPackagePublication(profileDir,slug)`：只清 `publishStatus/submissionId/reviewReason/delistRequestId/revoked` 并置 none，保留 enabled、installedVersion、publishedVersion 作为历史。该调用必须在 setEnabled 之后且发 changed 之前完成。

index 注入 `routeCtx.logger`；发布提交、发布状态变化、下架申请的成功与失败都调用 `logAgentPackageAction`。Task 9 的安装/更新/移除复用同一函数。日志字段白名单只含 action/slug/version/submissionId/outcome/reason，测试读取 logger 文案并断言不含三个 token、Authorization 或私钥。

- [ ] **Step 5: 运行测试并提交**

Run:

```bash
corepack yarn workspace dsh-plugin-huaanwork test tests/huaanwork-host/agent-package-catalog-publish.spec.ts tests/huaanwork-host/settings.spec.ts tests/huaanwork-host/agent-package-drafts.spec.ts
corepack yarn workspace dsh-plugin-huaanwork typecheck
```

Expected: PASS；M1 新建状态仍可省略 M2 字段。

```bash
git add dsh-plugin-huaanwork/src dsh-plugin-huaanwork/tests
git commit -m "feat: submit local agent packages for signed review"
```

---

### Task 9: 验签安装、更新、移除与 legacy 迁移

**Files:**
- Create: `dsh-plugin-huaanwork/src/huaanwork-host/agent-package/catalog-install.ts`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/agent-package/{store,host}.ts`
- Test: `dsh-plugin-huaanwork/tests/huaanwork-host/agent-package-catalog-install.spec.ts`

**Interfaces:**
- Consumes: Task 3 的异步 `inspectSignedAgentPackageBundle`、Task 8 client/state、M1 agentsHost legacy setEnabled。Task 10 的真实 `stopAgentPackageTurnsForSlug` 只按下述 `AgentPackageTurnStopper` 结构注入；本任务不得 import 尚未创建的 `catalog-security.ts`，测试注入 fake。
- Produces: `AgentPackageTurnStopper = (slug:string, reason:'revoke'|'update'|'remove') => Promise<void>`。
- Produces: `installCatalogAgentPackage(slug,version)`、`updateCatalogAgentPackage(slug,stopTurns:AgentPackageTurnStopper)`、`removeCatalogAgentPackage(slug,stopTurns:AgentPackageTurnStopper)`、`recoverCatalogPackageInstalls(profileDir)`、`refreshInstalledCatalogPackageStatuses():Promise<{warning?:string;changed:boolean}>`。
- Produces `VerifiedCatalogInstall`：`{ manifest, files, digest, signature }`，state key 固定 `catalog:<slug>`。

- [ ] **Step 1: 写安装冲突、迁移、升级和回滚测试**

```ts
test('first install is disabled and a legacy migration preserves enabled', async () => {
  await installCatalogAgentPackage('weekly-report', '1.0.0')
  assert.equal(readAgentPackageState(profileDir)['catalog:weekly-report']?.enabled, false)
  seedLegacyEnabled('catalog:legacy-assistant', true)
  await installCatalogAgentPackage('legacy-assistant', '1.0.0')
  assert.equal(readAgentPackageState(profileDir)['catalog:legacy-assistant']?.enabled, true)
  assert.equal(readLegacyEnabled('catalog:legacy-assistant'), undefined)
})

test('update requires a higher version and preserves enabled', async () => {
  const stopCalls: string[] = []
  const stopTurns: AgentPackageTurnStopper = async (slug, reason) => {
    stopCalls.push(`${slug}:${reason}`)
  }
  seedInstalled('weekly-report', '1.0.0', true)
  await assert.rejects(updateCatalogAgentPackage('weekly-report', stopTurns), /没有更高版本|版本低于已安装版本/)
  offerVersion('1.0.1')
  await updateCatalogAgentPackage('weekly-report', stopTurns)
  assert.equal(readAgentPackageState(profileDir)['catalog:weekly-report']?.enabled, true)
  assert.deepEqual(stopCalls, ['weekly-report:update'])
})
```

另覆盖：本地包/本地工具/普通 legacy 同名冲突；错误签名、篡改、额外文件、撤销版本不安装；非更高版本、降级和重放旧版本拒绝；更新和移除分别通过注入 fake 断言在目录改名前调用 `stopTurns(slug,'update'|'remove')`；失败清理 `.install-*` 且旧目录/state 字节不变；移除只允许 source=catalog。状态同步测试让已安装版本的 metadata 返回 delisted，断言 `refreshInstalledCatalogPackageStatuses` 只把 `publishStatus` 改为 delisted，保留 enabled 且不写 broken；网络失败保留原状态并返回 warning。崩溃注入覆盖“旧目录已 rename、新 formal 未就位”和“迁移新 state 已提交、legacy 旧键尚未删除”两个窗口，重启恢复后不得出现正式目录缺失或 legacy/catalog 重复补全。

- [ ] **Step 2: 运行测试确认失败**

Run: `corepack yarn workspace dsh-plugin-huaanwork test tests/huaanwork-host/agent-package-catalog-install.spec.ts`
Expected: FAIL。

- [ ] **Step 3: 实现安全暂存、冲突检查和原子安装**

下载前先读取目录列表：首次安装/迁移也只能选择该 slug 当前最高 published 版本，直接请求较旧版本按重放拒绝；更新同样只选择最高版本。同 slug 是 legacy agent 且服务器 metadata `migrationFrom===slug` 时允许迁移替换；旧 `catalog:<slug>` 键为 true 则保持启用，未启用则首次安装默认关闭。该字段由 approve 在迁移 header 合法时写入 published metadata；普通 legacy 冲突不自动迁移。随后创建 `agents/.install-{slug}-{random}/`，其下只设事务暂存区和一个 `package/` 新包目录；由 `downloadBundleToFile` 将 bundle 流式写入暂存区根部的 `bundle.tgz`，超过 5 MiB 即中止并删除临时目录。读取该 capped 文件并 `await inspectSignedAgentPackageBundle`，强制 inspection.manifest.slug/version 分别等于请求的 slug/version，再查 revocations，撤销版本报 `该版本已被管理员撤销：{reason}`。

文件写入 `agents/.install-{slug}-{random}/package/`，每级用 lstat 防 symlink，只写 inspection 返回的 unsigned files 与两个 `.signature` 文件；暂存区根部另写不参与最终包的 `transaction.json={slug,targetVersion,previousState?,migrationFrom?}`，`bundle.tgz` 也留在暂存区根部。首次正式目录必须不存在；更新先将旧目录 rename 为 `.old-{slug}-{random}`，再把暂存区内的 `package/` rename 到 formal，暂存区根部及 transaction 保留到提交完成，随后写 state；任一失败恢复旧目录和旧 state。成功后删 old 与整个暂存区，formal 不得混入 `bundle.tgz` 或 `transaction.json`。

`recoverCatalogPackageInstalls` 在启动和列表前按 transaction.json 恢复，且必须先于 M1 的通用 `.old-*` 清理：暂存仍在且 state 已到 targetVersion，先处理迁移对账再删除暂存/old；暂存仍在、state 未到 targetVersion 且 formal 已是新版本，删除新 formal 并恢复 old；formal 缺失且 old 存在（旧目录已 rename、新 formal 未就位时崩溃），先 rename old 回 formal，确认旧 state 后清暂存；formal 仍是旧版本且 state 未到 targetVersion（尚未 rename old）只清暂存并保留旧目录/state；首次安装未写 state 则删除新 formal；没有 transaction 的 `.install-*` 只清临时目录。迁移事务若 state 已到 targetVersion 而 legacy `catalog:<slug>` 键仍存在，必须先通过 agentsHost 旧路径补删，成功后才清 transaction/old；补删失败则按本次运行的失败语义回滚新 formal/state 并保留 legacy，不得直接按成功清理而留下 legacy/catalog 双份补全。这样崩溃不会留下“磁盘新版本 + state 旧版本”或迁移双启用。

首次 state=`{source:'catalog',enabled:false,installedVersion:version,publishStatus:'installed'}`；普通更新保留 enabled 和其他 M2 状态字段，只更新 installedVersion；迁移 enabled 取旧键，随后通过 agentsHost 的旧路径原子删 `catalog:<slug>`。若旧键删除失败，回滚新目录和 state，不返回成功。

- [ ] **Step 4: 实现更新、下架限制和移除**

update 调 listPackages 选同 slug 最高版本；`compareAgentPackageVersions(candidate,installed) <= 0` 抛 `版本低于已安装版本，已拒绝更新`；目录最新为 delisted/revoked 或无更高版本则不下载。确认存在可升级版本后、任何目录 rename 前 `await stopTurns(slug,'update')`，停止失败则不触碰旧目录/state。下架已安装包可继续运行但不提供更新/重新下载。

`refreshInstalledCatalogPackageStatuses` 枚举 state 中 source=catalog 的已安装项，按精确 `{slug,installedVersion}` 调 `client.getPackage`：metadata=delisted 时仅把该项 `publishStatus` 改为 delisted，metadata=published 时保持/恢复 installed；均保留 enabled、revoked 和其他 M2 字段，不写 broken。metadata=revoked 不在此函数清除或伪造状态，交由 Task 10 的 revocations 应用精确禁用；404、超时或网络失败保留旧状态并返回 warning，不把“列表中消失”当作 delisted。只有实际状态变化才写 state，并以 `changed` 返回是否发生任何变化；本函数不自行发事件，Task 11 在 changed=true 时统一发一次 `agent/changed`。

remove 先验证 state source=catalog，任何目录 rename 前 `await stopTurns(slug,'remove')`，再将目录 rename 到 `.remove-{slug}-{random}`，删除 state 后删目录；stop 失败直接中止且不触碰目录/state，state 删除失败时 rename 回滚。启动恢复时，`.remove-*` 对应 state 仍存在且 formal 缺失则 rename 回滚，state 已删除则清理 `.remove-*`。local 一律报 `本地创建的智能体不能通过广场移除`。安装、更新、移除的成功与失败均调用 Task 8 的 `logAgentPackageAction`，不得记录下载 URL 的 Authorization、token 或 bundle 内容。

- [ ] **Step 5: 运行安装与 M1 store 回归并提交**

Run:

```bash
corepack yarn workspace dsh-plugin-huaanwork test tests/huaanwork-host/agent-package-catalog-install.spec.ts tests/huaanwork-host/agent-package-store.spec.ts tests/huaanwork-host/agent-package-legacy.spec.ts
corepack yarn workspace dsh-plugin-huaanwork typecheck
```

Expected: PASS。

```bash
git add dsh-plugin-huaanwork/src/huaanwork-host/agent-package dsh-plugin-huaanwork/tests/huaanwork-host/agent-package-catalog-install.spec.ts
git commit -m "feat: install and update verified catalog agent packages"
```

---

### Task 10: 撤销缓存、运行前复验与在途回合中止

**Files:**
- Create: `dsh-plugin-huaanwork/src/huaanwork-host/agent-package/catalog-security.ts`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/agent-package/{host,runtime}.ts`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/{index,sessions}.ts`
- Modify: `dsh-plugin-huaanwork/package.json`
- Test: `dsh-plugin-huaanwork/tests/huaanwork-host/agent-package-catalog-security.spec.ts`
- Modify: `dsh-plugin-huaanwork/tests/huaanwork-host/agent-package-runtime.spec.ts`

**Interfaces:**
- Consumes: Task 9 的 `AgentPackageTurnStopper`；Task 11 将本任务真实的 `security.stopAgentPackageTurnsForSlug` 按该结构传给 Task 9 update/remove，Task 9 不反向 import 本模块。
- Produces: `AgentPackageTurnCancelReason='cancel'|'revoke'|'update'|'remove'|'dispose'`、`AgentPackageActiveTurnRecord={sessionId:string;slug:string;version:string;controller:AbortController;runtime?:AgentPackageTurnRuntime;activation?:SubagentActivationHandle;cancel(reason:AgentPackageTurnCancelReason):Promise<void>}`。
- Produces: `AgentPackageActiveTurnRegistry={register(record:AgentPackageActiveTurnRecord):()=>void;cancelBySessionId(sessionId:string,reason:AgentPackageTurnCancelReason):Promise<void>;cancelBySlug(slug:string,reason:AgentPackageTurnCancelReason):Promise<void>;cancelAll(reason:AgentPackageTurnCancelReason):Promise<void>}`，以及 `host.ts` 导出的 `createAgentPackageActiveTurnRegistry():AgentPackageActiveTurnRegistry`；register/unregister 幂等，index 创建同一实例并注入 host、catalog-security 与 sessions。
- Produces: `AgentCatalogSecurity`：`loadCachedRevocations()`、`refreshRevocations():Promise<{warning?:string}>`、`verifyInstalled(slug):Promise<AgentPackageVerification>`、`assertRunnable(slug,version):Promise<void>`、`stopAgentPackageTurnsForSlug(slug,reason:'revoke'|'update'|'remove'):Promise<void>`；最后一个方法仅委托 registry.cancelBySlug，类型与 Task 9 `AgentPackageTurnStopper` 相同。`AgentPackageVerification={ok:true;digest:AgentPackageDigest;signature:CatalogSignature}|{ok:false;reason:string}`。
- Runtime registry 扩展：取消可 abort 启动期 signal、dispose 已运行 activation、停止 HTTP/MCP/skill 进程并等待 cleanup；普通 enabled=false 仍不中止 M1 在途回合。
- Revocation cache: `{profileDir}/agent-catalog-revocations.json`，shape=`{schemaVersion:1,fetchedAt:string,items:AgentPackageRevocation[]}`，tmp+rename。

- [ ] **Step 1: 写篡改、离线缓存与竞态测试**

```ts
test('every catalog dispatch re-verifies and revocation aborts an active turn', async () => {
  await installEnabledCatalogPackage('weekly-report', '1.0.0')
  const running = host.dispatch(dispatchInput)
  await waitForRuntimeStart()
  await refreshWithRevocation({ slug: 'weekly-report', version: '1.0.0', reason: '不安全脚本' })
  await assert.rejects(running, /该版本已被管理员撤销：不安全脚本/)
  assert.equal(fakeStopCalls, 1)
  assert.equal(fakeActivationDisposeCalls, 1)
  assert.equal(readAgentPackageState(profileDir)['catalog:weekly-report']?.enabled, false)
  await assert.rejects(host.dispatch(dispatchInput), /该版本已被管理员撤销/)
})

test('offline refresh uses cached revocations and reports a warning', async () => {
  seedRevocationCache('weekly-report', '1.0.0', '缓存撤销')
  failCatalogNetwork()
  const result = await security.refreshRevocations()
  assert.match(result.warning ?? '', /目录不可达/)
  await assert.rejects(security.assertRunnable('weekly-report', '1.0.0'), /缓存撤销/)
})
```

再覆盖：修改 persona 后 `@` 拒绝；local 包不需要签名；delisted 不中止且仍可运行；撤销刷新与 dispatch 并发时，在进程启动前再次检查 revocation generation，不能漏启动。取消测试必须持有带未完成 `result` 的 fake activation，证明不是仅靠 abort signal：撤销时已运行 activation 的 `dispose` 恰调用一次、cleanup 不先等 graceful result、runtime/绑定/pendingTurns 均释放；启动期取消发生在 runtime/activation 赋值前时，晚到 runtime 必须停止、晚到 activation 必须立即 dispose，且每次 spawn 前 signal.aborted 能阻止新进程。`sessions.cancelAgent` 走同一 registry 后，同 session 可开始新回合，证明没有占位泄漏。

- [ ] **Step 2: 运行测试确认失败**

Run: `corepack yarn workspace dsh-plugin-huaanwork test tests/huaanwork-host/agent-package-catalog-security.spec.ts`
Expected: FAIL。

- [ ] **Step 3: 实现缓存、验签和撤销状态应用**

`dsh-plugin-huaanwork/package.json` 增加直接依赖 `"@huaanwork/catalog-signing":"*"` 并运行 `corepack yarn install`；与 Task 2 一样，不得使用 `workspace:*`。启动从 `{profileDir}/agent-catalog-keyring.json` 读取 IT 下发配置并用 Task 1 `parseCatalogKeyring` 校验；该文件不在用户设置界面暴露编辑。缺失/非法时只让 catalog 包安装与运行 fail-closed，并显示 `包校验失败，未安装或未运行。请联系管理员`，本地包与 legacy 不受影响。随后读取撤销缓存并应用，再异步刷新；解析失败备份为 `.corrupt-<timestamp>` 并显示警告，不把坏缓存当空列表静默放行。刷新成功替换缓存并应用；失败保留缓存和 warning。

`applyRevocations` 对每个精确 `catalog:<slug>` + installedVersion 匹配项写 `enabled:false` 与 `revoked`，列表/详情由 `revoked` 派生 `broken.reason`，再调用 stop；delisted 只改 publishStatus，不写 broken。`verifyInstalled` 每次从磁盘调用 `verifyAgentPackageDirectory`，成功返回 `{ok:true,digest,signature}`，失败返回 `{ok:false,reason}`；`assertRunnable` 将失败转成 `包校验失败，未安装或未运行。请联系管理员`，详情页则显示原始 reason 分类而不泄露本地路径。

- [ ] **Step 4: 给在途回合真实 AbortController 并关闭启动竞态**

index 只创建一个 `AgentPackageActiveTurnRegistry`，注入 host、catalog-security 和 sessions；不得让 catalog-security 反向访问 dispatch 闭包。host.dispatch 先声明 runtime/activation/cancelPromise/cancelling，再把永不触发的 `new AbortController().signal` 改为实际保存的 controller。pendingTurns 占位后，先同步定义 cleanup 与 record.cancel 并登记 `{sessionId,slug,version,controller,cancel}` 可变 record，再进行任何 `security.assertRunnable` await；后续把 runtime 与 activation 写到同一 record；unregister 与 cleanup 都必须幂等，unregister 仅在 map 当前值仍是该 record 时删除；cancelBySlug 遍历并等待全部同 slug record，不能只取消第一个。

`record.cancel(reason)` 在 dispatch 闭包内实现：先记录 cancelling 与 abort reason、调用 `controller.abort(reason)`；若 activation 已存在，立即 `await activation.dispose()`，不得先等其 graceful `result`；再停止当前 runtime 并等待 cleanup。cleanup 发现 cancelling 时跳过 M1 的“先等 activation.result”顺序，但仍解绑工具、停 HTTP/MCP/skill、清 request/child 标记并释放 pendingTurns；并发 cancel 共享同一 cancelPromise，dispose/cancel 重入不得双停或删除新回合登记。撤销刷新先增加 revocation generation，再调 registry.cancelBySlug；update/remove 则由 Task 11 以 `(slug,reason)=>security.stopAgentPackageTurnsForSlug(slug,reason)` 作为 Task 9 的 stopTurns 传入。

登记后、调用 `createRuntime` 前先 `await security.assertRunnable`；同一个 signal 传入 createRuntime 和 startActivation，其每次 spawn/materialize 前必须检查 `signal.aborted`。`await createRuntime` 返回后先把 runtime 写入 record，再 `await security.assertRunnable` 并检查 cancelling/signal.aborted；若已取消，立即停掉这个晚到的 runtime、cleanup 并抛出原取消原因，禁止继续 startActivation。若取消发生在 `await startActivation` 期间，activation 返回后先写入 record，再检查 cancelling/signal.aborted；已取消则立即 dispose 新 activation、cleanup 并抛出原取消原因，不得留下“取消时还没 activation，所以永远不 dispose”的活回合。若撤销发生在最后一次检查和 spawn 之间，aborted signal 必须阻止 spawn。

`sessions.cancelAgent` 按 sessionId 调 registry.cancelBySessionId，使用同一 record.cancel，确保取消释放 pendingTurns，不只等 afterIdle。`host.findInvocable/listWithLegacy` 合并目录包时执行 verify/revoked/broken 过滤；`dispatch` 对 source=catalog 每次调用 verify，对 local 保持 M1 路径。index 初始化 security 和缓存，dispose 先 `await registry.cancelAll('dispose')`，再 await `stopAllAgentPackageProcesses()`，不引入后台推送。

- [ ] **Step 5: 运行安全与运行时回归并提交**

Run:

```bash
corepack yarn workspace dsh-plugin-huaanwork test tests/huaanwork-host/agent-package-catalog-security.spec.ts tests/huaanwork-host/agent-package-runtime.spec.ts tests/huaanwork-host/sessions.spec.ts
corepack yarn workspace dsh-plugin-huaanwork typecheck
node scripts/verify-layout.mjs
```

Expected: PASS；撤销后 activation 已 dispose、无活动进程、无 `@` 补全项、无法再启用，pendingTurns 无残留；verify-layout 接受 huaanwork 的 `"*"` 签名依赖。

```bash
git add dsh-plugin-huaanwork/src dsh-plugin-huaanwork/tests dsh-plugin-huaanwork/package.json yarn.lock
git commit -m "feat: enforce signed package verification and revocation at runtime"
```

---

### Task 11: 七个 M2 RPC、客户端 API 与 62→69 契约

**Files:**
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/routes.ts`
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/{rpc-types,api}.ts`
- Test: `dsh-plugin-huaanwork/tests/huaanwork-host/agent-package-routes.spec.ts`
- Modify: `dsh-plugin-huaanwork/tests/client-huaanwork/api.spec.ts`
- Modify: `dsh-plugin-huaanwork/tests/huaanwork-host/route-contract.spec.ts`

**Interfaces:**
- Produces RPC: `agent.packagePublish`、`agent.packagePublishStatus`、`agent.packageRequestDelist`、`agent.packageInstall`、`agent.packageUpdate`、`agent.packageRemove`、`agent.packageRefresh`。
- Consumes: Task 8 publish、Task 9 install/update/remove/`refreshInstalledCatalogPackageStatuses`、Task 10 security。
- Events 继续只用 `agent/changed`；成功安装/更新/移除/发布状态变化均触发，不新增点式事件。

- [ ] **Step 1: 写七条路由和错误测试**

在现有 routes spec 用 fake host/client/security 覆盖每条的 method/body、成功返回和 changed 次数：publish `{slug}`→submissionId；publishStatus `{slug}`→状态；requestDelist `{slug,reason}`→requestId；install `{slug,version}`→状态；update/remove `{slug}` 必须把 `(slug,reason)=>security.stopAgentPackageTurnsForSlug(slug,reason)` 传给 Task 9，并分别收到 update/remove 原因；refresh 同时刷新目录包、本地发布状态、已安装 catalog metadata 状态和 revocations，fake 返回一个 delisted 已安装项时响应卡片必须带 `publishStatus:'delisted'`，离线仍返回本地 packages+catalogError。

安全断言：install 缺少 version 400；requestDelist reason 空白 400；packageSetEnabled 对 revoked/broken catalog 启用拒绝、关闭允许且保留 revoked/publishStatus/submissionId 等 M2 字段；local 包 remove 400；任何 handler 不接收 admin token/privateKey 字段，含这些字段即 400。

- [ ] **Step 2: 实现 ROUTE_TABLE 七行**

路径固定为：

```ts
const M2_ROUTES = [
  ['agent.packagePublish', 'POST', '/huaanwork/agent/package/publish'],
  ['agent.packagePublishStatus', 'GET', '/huaanwork/agent/package/publish/status'],
  ['agent.packageRequestDelist', 'POST', '/huaanwork/agent/package/delist-request'],
  ['agent.packageInstall', 'POST', '/huaanwork/agent/package/install'],
  ['agent.packageUpdate', 'POST', '/huaanwork/agent/package/update'],
  ['agent.packageRemove', 'POST', '/huaanwork/agent/package/remove'],
  ['agent.packageRefresh', 'POST', '/huaanwork/agent/package/refresh'],
] as const
```

展开为现有 route object，不保留一个未被 ROUTE_TABLE 使用的常量。GET status 用 queryParam slug；其余校验 object body 和字符串字段。update/remove 调 Task 9 时显式传入 security stopper 闭包。refresh 顺序为 legacy refresh、`refreshCatalogPackageCache`、本地发布状态刷新、Task 9 `refreshInstalledCatalogPackageStatuses`（逐已安装 slug/version 拉 metadata，不能用列表消失代替）、revocations apply，若 installed metadata 刷新返回 changed=true 则统一发一次 `agent/changed`（其他模块沿用各自既有发射点，不重复），再返回 `listWithLegacy`；单项失败按错误类型保留本地结果和 warning，安全刷新失败不得清缓存。

- [ ] **Step 3: 扩展 RPC 类型和客户端 ROUTES**

客户端 `AgentPackageListResult` 增加 `catalogPackages: AgentPackageSummary[]` 与 `revocationWarning?:string`；`AgentPackageListItem.source` 增加 catalog 及 Task 8 状态字段，并增加 `latestVersion?:string`、`updateAvailable?:boolean`（host 用 Task 2 `compareAgentPackageVersions` 计算，renderer 不导入 Node-only 包格式模块）。客户端自行镜像声明，不从 server/host import：

```ts
export type AgentPackageSummary = {
  slug: string
  displayName: string
  description: string
  version: string
  size: number
  status: 'published'
  updatedAt: string
  migrationFrom?: string
}
```

detail 增加：

```ts
export type AgentPackageSignatureInfo = {
  keyId: string
  signedAt: string
  slot: 1 | 2
  verification: 'valid' | 'invalid' | 'not-applicable'
  reason?: string
}
```

`RpcRequest.method` 加七项；api.ts ROUTES 加上表同七行；GET publishStatus 走 objectQuery，其余 POST 走 body。api.ts 头注释 62→69。

- [ ] **Step 4: 更新全量契约计数与必含键**

`tests/client-huaanwork/api.spec.ts` 的 EXPECTED_ROUTES 加七行、测试标题和 `toHaveLength(62)` 改 69。`tests/huaanwork-host/route-contract.spec.ts` 所有 62 计数/注释改 69，并给七条补 HTTP/path/必含键断言；运行 `rg -n '\b62\b' <这两个测试和 api.ts>`，剩余命中只能是无关历史文本，不得留下旧路由计数。

- [ ] **Step 5: 运行契约测试并提交**

Run:

```bash
corepack yarn workspace dsh-plugin-huaanwork test tests/huaanwork-host/agent-package-routes.spec.ts tests/client-huaanwork/api.spec.ts tests/huaanwork-host/route-contract.spec.ts
corepack yarn workspace dsh-plugin-huaanwork typecheck
```

Expected: PASS，双端方法集合恰为 69。

```bash
git add dsh-plugin-huaanwork/src dsh-plugin-huaanwork/tests
git commit -m "feat: expose signed agent package lifecycle RPCs"
```

---

### Task 12: 广场与我的智能体 M2 交互、发布 token 和撤销轮询

**Files:**
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/{AgentsView,AgentsPlazaPanel,AgentPackagesPanel}.tsx`
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/logic/agentPackagesLogic.ts`
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/styles.css`
- Test: `dsh-plugin-huaanwork/tests/client-huaanwork/agent-packages-panel.spec.ts`
- Create: `dsh-plugin-huaanwork/tests/client-huaanwork/agents-plaza-m2.spec.ts`

**Interfaces:**
- Consumes: Task 11 七 RPC 和签名/状态类型。
- Produces: 发布确认弹窗、待审查/被拒/已发布/已下架/已撤销/已损坏卡片，下载/更新/移除/申请下架动作，签名详情与离线撤销警告。

- [ ] **Step 1: 写状态动作纯函数和 UI 失败测试**

新增纯函数。`AgentPackageCard` 增加可选 `installed?: boolean`：仅广场未安装签名卡置 `false`，其余卡省略（已安装目录卡、本地卡、legacy 卡均不写该字段，等价"非未安装"）。未安装判别只认 `installed === false`，不得用 `publishStatus` 或 `enabled` 推断：

```ts
export function packageActions(card: AgentPackageCard): Array<
  'enable' | 'disable' | 'publish' | 'publish-status' | 'request-delist' |
  'install' | 'update' | 'remove' | 'detail'
> {
  if (card.revoked || (card.broken && card.source === 'catalog')) return ['remove', 'detail']
  if (card.source === 'catalog-legacy') return [card.enabled ? 'disable' : 'enable', 'detail']
  if (card.broken) return [...(card.enabled ? ['disable' as const] : []), 'detail']
  if (card.source === 'catalog' && card.installed === false) return ['install', 'detail']
  if (card.source === 'catalog' && card.publishStatus === 'delisted') {
    return [card.enabled ? 'disable' : 'enable', 'remove', 'detail']
  }
  if (card.source === 'catalog') return [
    card.enabled ? 'disable' : 'enable',
    ...(card.updateAvailable ? ['update' as const] : []),
    'remove', 'detail',
  ]
  if (card.publishStatus === 'pending-review') return ['publish-status', 'detail']
  if (card.publishStatus === 'rejected') return ['publish', 'detail']
  if (card.publishStatus === 'published') return [card.enabled ? 'disable' : 'enable', 'request-delist', 'detail']
  if (card.publishStatus === 'delisted') return [card.enabled ? 'disable' : 'enable', 'detail']
  return [card.enabled ? 'disable' : 'enable', 'publish', 'detail']
}
```

本地 broken 只允许 disable/detail，不能 publish；delisted local 不允许重新上架；catalog 未安装广场卡（`installed:false`）严格只有 install/detail，不得落入已安装 catalog 分支出现启停/更新/移除，下载对应 install。rejected 严格只有 publish/detail 两个动作，publish 在该状态渲染为“重新提交”，不得落入默认分支额外出现启停。UI 测试逐状态断言按钮和文案，点击 publish 先出现“提交后需管理员审查与签名，不会立即上架”，确认才调用 RPC；下载/更新/移除/下架各调用正确参数，错误显示规格中文。

- [ ] **Step 2: 接入 publish token 和页面刷新周期**

AgentsView 增加第二个 password input：aria-label=`发布口令`、placeholder=`发布口令（创建者）`，settings.get 读取 `agents_catalog_publish_token`，保存时与 host/port/read token 一起 settings.set。无 keyring 输入框。

进入 AgentsView 和手动刷新先 `agent.packageRefresh` 再 `agent.refresh`；挂载期间 `window.setInterval(...,60_000)` 只调 packageRefresh，卸载 clearInterval，前后两次调用不重叠。测试用 fake timers 验证 60 秒一次、卸载后不再调用、失败显示 `目录不可达，请稍后重试；本地智能体不受影响` 且本地卡不消失。

- [ ] **Step 3: 实现广场签名包和迁移去重**

`plazaCards` 合并签名 `catalogPackages` 与 legacy `catalogAgents`。同 slug 且签名 metadata `migrationFrom===slug` 时，签名包卡优先并标“签名迁移包”，legacy 不重复显示；非同源冲突由服务端拒绝。签名未安装卡合成 `source:'catalog'`、`installed:false`（动作判别见 Step 1），显示名称/简介/版本/大小和“下载”；legacy 保持查看详情与启用/关闭，不伪造下载。

`mineCards` 合并 local、已安装 catalog、已启用 legacy。目录卡显示“来自广场”，已下架显示“已下架”，已撤销显示“已撤销：原因”，损坏显示“已损坏：原因”。catalogError/revocationWarning 在页面顶部显示，本地包保持可用。

- [ ] **Step 4: 实现卡片动作、详情和 per-slug 在飞守卫**

所有动作按 slug 记录 busy，异步期间只禁用该卡，不把其他卡点击静默丢弃；同卡重复点击直接忽略。rejected 卡的 publish 按钮文案固定为“重新提交”，其他本地卡为“发布”（确认动作仍是提交审查）。发布/下架使用确认对话框；下架文案为“下架后广场不再提供下载，已安装副本仍可使用；安全处置请由管理员撤销。”移除只针对 catalog，确认后调用 packageRemove。

详情增加版本、来源、publishStatus/publishedVersion、digest 文件清单与大小；catalog 显示 keyId、signedAt、slot 和验签结果，local 显示“本地创建，未签名”。固定沙箱原话不变。错误文案使用：`审查未通过：{reason}`、`已下架，不再提供下载；已安装副本仍可使用`、`该版本已被管理员撤销：{reason}`、`包校验失败，未安装或未运行。请联系管理员`。

- [ ] **Step 5: 运行 UI 测试并提交**

Run:

```bash
corepack yarn workspace dsh-plugin-huaanwork test tests/client-huaanwork/agent-packages-panel.spec.ts tests/client-huaanwork/agents-plaza-m2.spec.ts tests/client-huaanwork/agentPackagesLogic.spec.ts
corepack yarn workspace dsh-plugin-huaanwork typecheck
```

Expected: PASS；没有 admin token、私钥或 unrevoke 控件。

```bash
git add dsh-plugin-huaanwork/src/client-huaanwork dsh-plugin-huaanwork/tests/client-huaanwork
git commit -m "feat: add signed agent package publishing and catalog UI"
```

---

### Task 13: 双 Profile E2E、安全负例、双平台证据与全量门禁

**Files:**
- Create: `dsh-plugin-huaanwork/scripts/huaanwork-agent-package-m2-acceptance.mjs`
- Modify: `.github/workflows/windows-agent-package-acceptance.yml`
- Create: `docs/huaanwork-agent-packages-m2.md`
- Create: `docs/evidence/2026-10-24-agent-package-m2-macos-acceptance.md`
- Create: `docs/evidence/2026-10-24-agent-package-m2-windows-acceptance.md`
- Modify: `package.json`, `scripts/expected-root-gate-scripts.json`

**Interfaces:**
- Consumes: Task 1–12 全部公共 API。
- Produces: 可重复双 Profile 验收探针、运维 runbook、macOS/Windows 证据和 root 全量门禁。

- [ ] **Step 1: 写端到端探针并覆盖安全负例**

探针在临时目录起真实 agent-catalog-server，生成动态 Ed25519 测试 key，建立 creator/consumer 两个 profileDir，执行并逐项打印 JSON：

```json
{
  "submitted": true,
  "reviewedAndSigned": true,
  "secondProfileInstalled": true,
  "signatureVerified": true,
  "enabledAndHttpRan": true,
  "updatedPreservingEnabled": true,
  "delistedInstalledStillRan": true,
  "delistedStatusVisible": true,
  "revocationStoppedActiveTurn": true,
  "revokedEnableRejected": true,
  "residualProcesses": 0
}
```

流程必须是：本地 fixture 创建→publish→CLI review/approve→第二 Profile install→enable→真实 HTTP fixture dispatch→发布 1.0.1→update→delist→packageRefresh 确认已安装卡 publishStatus=delisted 且仍可运行→启动一个长回合→revoke→refresh 后 activation dispose/abort、无进程。负例在同一探针或集成测试覆盖未签名、篡改、错误/未知/退休 key、额外文件、1025 个 0 字节条目、513 字节规范化路径、降级、重放、错误 token、撤销版本；任何失败退出非 0，不用跳过冒充通过。

- [ ] **Step 2: 接入 Windows workflow 并运行 macOS 探针**

在现有 workflow 追加独立 step `Windows agent-package M2 acceptance probe`，命令：

```bash
node dsh-plugin-huaanwork/scripts/huaanwork-agent-package-m2-acceptance.mjs --platform win32 --out windows-agent-package-m2-acceptance.json
```

artifact 增加该 JSON；保留 M1 步骤、workflow_dispatch、timeout 和 verdict self-check，不设 continue-on-error。macOS 本地运行：

```bash
node dsh-plugin-huaanwork/scripts/huaanwork-agent-package-m2-acceptance.mjs --platform darwin --out /tmp/agent-package-m2-darwin.json
```

Expected: 上述字段全 true、residualProcesses=0。Windows 通过 workflow_dispatch 绿跑取证；未跑或失败就在证据文件写 BLOCKED/FAIL，不写 PASS。

另做一组跨机器验收：macOS 创建者用独立测试 Profile 提交 1.0.0，离线管理员完成 review/approve；Windows 消费机配置同一测试目录与 keyring，在独立测试 Profile 下载、启用并 `@` 运行，再按同一流程升级 1.0.1 和接收撤销。两台机器各保存原始探针/界面证据和进程清单；同机双 Profile 只算集成测试，不能替代这组验收。

- [ ] **Step 3: 写部署与离线签名 runbook**

`docs/huaanwork-agent-packages-m2.md` 必须给出可复制的配置示例（值用明显测试占位名，不给生产秘密）：迁移仓外 entries、启动三个 token 均不同的服务、IT 下发 `{profileDir}/agent-catalog-keyring.json`、桌面填写读/发布 token、CLI review/approve/reject/delist/revoke 命令、审计位置、增长监控、手工归档/轮换与备份恢复、撤销离线风险。审计轮换不新增自动日志框架，runbook 固定为“停服→完整备份→移走旧 audit.jsonl→启动重建”，恢复时不得用旧备份覆盖较新的审计或 state；容量阈值以实际条目增长和备份窗口记录，不把“内网规模可接受”写成已实测结论。

明确写：私钥只在离线机；keyId=raw public key SHA-256；双槽轮换经配置/发版，无 UI；bundle/解包内容各 ≤5 MiB、归档与目录枚举 ≤1024 条目、规范化路径 ≤512 字节及对应排障文案；下架不是安全处置；目录不可达用上次撤销列表；离线期间撤销可能延迟；Windows sandbox=partial、读/网络不隔离；测试 key 与生产 key 不共用。legacy 迁移使用 `migrate-legacy <slug> --submit` 后仍需审查，客户端成功安装才删旧键。

- [ ] **Step 4: 接入 root 门禁并跑全量回归**

root workspaces 最终含四个新目录、合计 16 项，`scripts/verify-layout.mjs` 已在 Task 1/2/4/7 逐次同步为同一顺序；本步先核对该断言及 huaanwork 两个 `"*"` 内部依赖，不再允许把布局修复留到全量门禁之后。root `typecheck/test/check` 链追加四个 workspace 对应命令；build 链追加 `agent-catalog-server` 和 `agent-catalog-admin` 的 no-op build。同步 `scripts/expected-root-gate-scripts.json` 的 build/typecheck/test/check 完整字符串，不改 fixtureVersion。

Run:

```bash
node scripts/verify-layout.mjs
corepack yarn test
corepack yarn typecheck
corepack yarn check:desktop-variants
corepack yarn check
```

Expected: 全部 exit 0；variant 仍 7/64、前缀 6；market-server signing/envelope 测试全绿；M1 agent-package 测试无回归。若既有 `verify:aa` 并发债务复现，单独重跑失败 workspace 并如实记录，禁止删步骤。

- [ ] **Step 5: 写验收证据并提交**

两份证据文件记录 commit、机器/OS、命令、原始 JSON、服务/Profile 均为临时测试环境、进程清理结果、已知边界；Windows 记录 GHA run URL 和 exit code。runbook 状态必须与证据一致，只有 macOS 与 Windows 都通过才写“M2 双平台验收 PASS”。

```bash
git add dsh-plugin-huaanwork/scripts .github/workflows/windows-agent-package-acceptance.yml docs/huaanwork-agent-packages-m2.md docs/evidence package.json scripts/expected-root-gate-scripts.json scripts/verify-layout.mjs yarn.lock
git commit -m "test: verify signed agent package lifecycle across platforms"
```

---

## Self-Review

**1. Spec coverage**

| 规格要求 | 任务 |
|---|---|
| §8.1 canonicalJson、Ed25519、双槽、market-server 仅抽取 | Task 1 |
| §8.1 digest、条目/路径/大小预算、签名 bundle、安装与运行前验签 | Task 2、3、9、10 |
| §8.2 三 token、发布状态机、本地变化回 none | Task 4、5、8 |
| §8.3 M-A0 同进程扩展、包/审查/下架/撤销 API、锁、大小帽、冲突 | Task 4、5、6 |
| §8.4 管理员 pending、bundle、独立 digest、diff、签名、拒绝、迁移 | Task 5、7 |
| §8.5 安装、原子恢复、更新、legacy 替换、下架 metadata 同步、撤销、移除 | Task 9、10、11 |
| §8.6 成功/失败审计、桌面动作日志、秘密不进日志 | Task 4、7、8、13 |
| §9.2 七个 RPC、changed 事件、publish token/keyring | Task 8、11、12 |
| §9.3 发布/下载/更新/下架/撤销/损坏 UI 与已安装状态数据源 | Task 9、11、12 |
| §10 错误文案 | Task 8–12 |
| §11 单元、服务集成、安全负例、E2E、双平台、全量门禁 | Task 1–13 |
| §12/13 独立服务、CLI、共享签名、zero-touch | Global Constraints、Task 1–13 |

实施补充的必要契约：admin 审查下载 `GET /v1/agent-packages/submissions/{id}/bundle`；admin submission metadata 带 `previousVersion/previousDigest` 供 diff；迁移批准 metadata 增加 `migrationFrom`。这些是 §8.4/§8.5 的可执行接线，不赋予管理员绕过签名能力，也不要求 admin token 拥有公共读权限，且不改变旧 `/v1/catalog`。

实施补充的安全收紧：bundle 与目录枚举共用 1024 条目、512 字节规范化路径上限，防止 0 字节条目绕过内容字节预算；四个 bundle build/inspect API 统一 async；已安装 catalog 用精确 metadata 刷新 delisted，不以列表消失推断；rejected 动作按规格收紧为“重新提交、详情”；未安装广场签名卡用 `installed:false` 判别，严格只 install/detail，不进已安装 catalog 分支。这些均不改变签名 manifest 或既有 `/v1/catalog` 契约。

**2. Placeholder scan**

计划没有 TBD/TODO/FIXME、“稍后实现”或无代码步骤的“补测试”。测试 helper 的输入、状态字段、路由、环境变量、错误分支和命令均已给出；Task 13 证据只允许记录实际执行结果。

**3. Type consistency**

- `AgentPackageManifest` 由 Task 2 共享，Task 3/5/7/8/9 使用同一类型；manifest 不含状态字段。
- `AgentPackageDigest`、`CatalogSignature`、`CatalogKeyringEntry` 在 Task 1/2 定义，服务端、CLI、桌面共用。
- unsigned inspection→服务端 digest→CLI 独立 digest→signed bundle→桌面 inspection 的数据流一致；`buildUnsignedAgentPackageBundle/buildSignedAgentPackageBundle/inspectUnsignedAgentPackageBundle/inspectSignedAgentPackageBundle` 全部返回 Promise，Task 3/5/7/8/9 均 await，成功断言用 `doesNotReject` 或直接 await，不用同步 `doesNotThrow`。
- `publishStatus` 固定为 `none|pending-review|published|rejected|delisted|installed`；目录撤销另用 `revoked`，不伪造第七种 publishStatus。
- RPC 固定七项，62→69；事件固定 `agent/changed`；旧 `agents-enabled.json` 只由 legacy 路径管理。
- `AgentPackageTurnStopper` 由 Task 9 定义并被 update/remove 以参数消费；Task 10 的 `security.stopAgentPackageTurnsForSlug` 与其结构相同，由 Task 11 闭包注入，不存在 Task 9→Task 10 模块 import。active turn record 显式持有 controller、可选 runtime/activation 和 dispatch 自己的 cancel/cleanup 通路；同一 registry 供撤销、update/remove、sessions.cancelAgent 与 dispose 使用。
- root workspaces 按 Task 1/2/4/7 从 12→13→14→15→16 同步 `scripts/verify-layout.mjs`；huaanwork 对两个新共享包只用 `"*"`，market-server 与新共享包自身的 `workspace:*` 不受该 owner 禁则误伤。
- rejected 分支固定 `['publish','detail']`，按钮文案“重新提交”；delisted 已安装卡由 Task 9 metadata 刷新提供状态，Task 11 聚合，Task 12 只消费。
