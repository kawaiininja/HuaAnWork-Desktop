# HuaAnWork 单桌面、单代码维护 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 分两阶段让 `dsh-plugin-huaanwork/` 成为唯一活跃、最终唯一自有的桌面源码树，同时把 outer Desktop 上游同步改成可审计的选择性移植。

**Architecture:** 阶段 A 只改 workspace、命令、工具链、CI 和活文档，三个参考树保持 tracked 内容不变；完整本地与分支 CI 证据落盘后，阶段 B 才裁定 market peer 政策、清理运行时资产、删除参考树。outer Desktop 上游以 `desktop-upstream.json` 的 `reviewedCommit` 为基线，dashboard 只读 Git ref 和 JSON，逐提交报告待处置文件，不再扫描三包源码或计算 merge-base 落后量。

**Tech Stack:** Node.js `^22.19.0` / `>=24.0.0`、Yarn `4.18.0`、ESM `.mjs`、TypeScript/Vitest、GitHub Actions、Electron 打包；不新增依赖。

## Global Constraints

- 执行真相源：`docs/superpowers/specs/2026-10-26-single-desktop-maintenance-design.md` 与本计划。设计评审和计划评审已随分支基线提交，执行所需结论已全部固化在本计划；两份文档的 SHA-256 分别为 `4745292b7dc81bc90a0c465e439ee255310456ef5e987d03ef6035fd2d21d1ef`、`abbbbce2a768c70d46da410990a5c038b2c54da24623342646ac02cd511367e1`。计划基线为 `b5ef3e84a7951941480b50a8749fe6714b8c9fc7`，开工时必须重钉。
- 新分支固定为 `refactor/huaanwork-single-desktop-maintenance`；不直接推 master、不自动合并、不触发发布、不 force-push。设计 §2 已明确授权本分支提交、推送和 `workflow_dispatch`。
- 阶段 A 中 `dsh-plugin-desktop/`、`dsh-plugin-desktop-beta/`、`dsh-desktop-next/` 的 tracked 内容必须零改动；只有 Task 8 的完整硬门禁通过并落盘后才能开始 Task 9。
- 使用 Corepack Yarn `4.18.0`；lockfile 只能由包管理器重解，禁止手工拼装。所有根门禁串行执行，不并行跑 `check` / `test`，避免既有 AA/lib 竞态。
- 门禁中的文本搜索使用 `grep`/`git grep`，不得用 `rg ... || true` 的 fail-open 形态；`rg` 只用于非门禁扫描。执行前用 `command -v rg` 确认，缺失时把扫描改为 `grep -nE`。
- 不推进 `deepseek-harness` pin（基线 `1600d8a1e140dcde43a1a0941940a0480712c011`），不修改子模组文件；outer Desktop 选择性移植和 Harness runtime 更新是两条独立证据链。
- 不改变 HuaAnWork 产品功能、界面、数据格式或更新协议；不清洗历史产品 ID、迁移字符串、不可变 bundle 识别和历史文档。
- market、AA、runtime 检查保持 fail-closed；不得用离线旧制品、跳过校验或手工改坏 peer range 来换取绿色门禁。
- HuaAnWork 没有 Linux 发行线；删除 Stable 根 Linux 命令和 Stable/Beta Linux CI，不新增 HuaAnWork Linux 验证。
- 阶段 B 在删除 Stable/Beta 通道元数据或执行任何 `sync-vendored-runtime.mjs --write` 之前，必须完成 Task 9 的消费方扫描和用户裁定。
- macOS 证据只写 unsigned smoke；只有 provisioning 守卫确有缺项时才允许 `HUAANWORK_ALLOW_UNPROVISIONED_SMOKE=1`，并写 unsigned/unprovisioned smoke。Windows 证据只写 CI 打包与运行时检查，不写真实第二台机器或跨机器验收。
- Task 1 创建分支后以及每个后续任务的第一个 shell，都自行执行 `BASE_SHA="$(git rev-parse master)"`、`BRANCH="$(git branch --show-current)"` 并校验 `BRANCH=refactor/huaanwork-single-desktop-maintenance`；不得依赖前一任务的环境变量。若 Task 1 已重钉基线，以重钉后的 master 为准。
- 不提交开工前已有的未跟踪 `.gstack/`；两份评审文档已随分支基线提交（见评审修订记录）。所有暂存使用显式路径。保留已有 tracked 设计修订和 CI provisioning 注释修订。
- 证据文档记录被验证代码的完整 SHA；随后提交证据时，证据提交不得夹带代码变化。任何失败停留在当前阶段，不用后续删除掩盖问题。

### 评审修订记录（2026-10-29）

本计划按计划评审及 Claude 复核意见修订：P0-1 `gh --repo`、P0-2 参考目录残留清理、P0-3 `README.i18n.yaml`、P1-1 活文档三分类、P1-2 Task 9 实际计数与清理顺序（按复核定为证据完整性项，非高严重度删除错误）、P2-1 `active-topology` 接入 `test:architecture-gates`、P2-2 §6 退役（按复核定为明确化建议）、P3-1/P3-2 行号、P3-3 activeChannel 时序、P3-4 评审文档 hash 与 CI 注释提交说明。2026-10-29 GLM 第二轮复评追加：B-1 `git ls-tree` 断言改为 `git rev-parse`，B-2 净树豁免覆盖两份 review 文档并重钉 plan-review hash，9.5-1 `.gitignore` 死条目清理，9.5-2 `assets/app-icons.source.json` 历史登记，9.5-3 门禁改用 `grep`/禁用 `rg ... || true` fail-open。2026-10-29 分支基线提交：设计、实施计划、两份 review 与 CI provisioning 注释已随 `refactor/huaanwork-single-desktop-maintenance` 的基线提交落盘；Task 1 Step 1 已完成，Task 6 只做 CI 收窄。设计两阶段和 DoD 不变。

---

## File Structure

**根拓扑与门禁**
- `package.json`、`yarn.lock`：单活跃 workspace、命令和最终依赖闭包；Task 5 的 `test:architecture-gates` 把 `active-topology.test.mjs` 接入 `check:architecture`。
- `scripts/expected-root-gate-scripts.json` 及 `.test.mjs`：`fixtureVersion: 3` 的根命令契约。
- `scripts/verify-layout.mjs`：只读取活跃 HuaAnWork 和保留的非桌面 workspace。
- `scripts/active-topology.test.mjs`：根测试 glob、退役工具和最终目录消失的结构钉。
- `scripts/market-dependency-direction.mjs` 及 `.test.mjs`：活跃源码扫描根收窄；历史 import 禁止规则保留。

**market / AA / runtime**
- `scripts/prepare-dsh-market.mjs` 及 `.test.mjs`：只刷新 HuaAnWork。
- `scripts/agents-anywhere-release-policy.mjs` 及 `.test.mjs`、`scripts/prepare-agents-anywhere-release.mjs`：只读取 HuaAnWork 的 AA runtime peers。
- `vendor/agents-anywhere/`、`dsh-plugin-huaanwork/package.json`：由既有 AA prepare 原子再生 artifact、provenance 和 manifest 引用。
- `scripts/vendored-runtime-policy.mjs` 及 `.test.mjs`：可单测的 market runtime 所有权和 peer range 政策。
- `scripts/sync-vendored-runtime.mjs`、`upstream.json`、`dsh-community-market/package.json` 及 `tests/contracts.spec.ts`：HuaAnWork runtime 校验与显式历史 peer 政策。
- `vendor/dsh-runtime/`、`patches/`：只保留有活跃消费方的 `0.2.1-rc.1` 资产。

**CI、测试和文档**
- `.github/workflows/ci.yml`：只保留 HuaAnWork 和共享检查；保留既有 `workflow_dispatch`。
- `dsh-plugin-huaanwork/tests/package.spec.ts`：单产品拓扑、CI、图标、runtime 和最终结构断言。
- `AGENTS.md`、`README.md`、`README.en.md`、`README.i18n.yaml`、`CONTRIBUTING.md`/`.en.md`、`docs/architecture.md`/`.en.md`、`docs/README.md`/`.en.md`、`docs/plugin-development.md`/`.en.md` 及其 `.i18n.yaml`、`docs/why-desktop.md`/`.en.md`、`dsh-community-market/README.md`/`.zh.md` 及其 `.i18n.yaml`、`docs/upstream-sync.md`：活规则、活文档和同步纪律；历史设计/评审/证据不改写。
- `docs/evidence/2026-10-29-single-desktop-rules-triage.md`：活规则和债表逐行“关闭 / 改写 / 保留”清点。
- `docs/evidence/2026-10-29-single-desktop-runtime-consumers.md`：peer 政策裁定与资产消费方证据。
- `docs/evidence/2026-10-29-single-desktop-phase-a.md`、`2026-10-29-single-desktop-phase-b.md`：两阶段硬门禁证据。

**选择性上游移植**
- `desktop-upstream.json`：outer Desktop 仓库、ref、reviewedCommit、主对照包和 watchedPaths。
- `scripts/upstream-sync-dashboard.mjs` 及 `.test.mjs`：hermetic 的 `reviewedCommit..ref` 报告。
- `docs/evidence/2026-10-29-single-desktop-upstream-shelf.md`：首期 56 个提交、逐直接文件的移植/不移植裁定。

**阶段 B 删除**
- `dsh-plugin-desktop/`、`dsh-plugin-desktop-beta/`、`dsh-desktop-next/`。
- `scripts/verify-desktop-variants.mjs`、`classify-variant-tests-drift.mjs`、`export-app-icons.mjs`、`upstream-merge-spike.mjs`、`verify-desktop-onboarding-browser.mjs` 及已改名为 `.reference.mjs` 的参考测试。

---

### Task 1: 单活跃根拓扑与命令契约

**Files:**
- Modify: `package.json:10-27,2035-2096`
- Modify: `scripts/verify-layout.mjs`
- Modify: `scripts/expected-root-gate-scripts.json`
- Modify: `scripts/expected-root-gate-scripts.test.mjs:9-15`
- Modify: `scripts/prepare-dsh-market.test.mjs:73-78`
- Modify: `dsh-plugin-huaanwork/tests/package.spec.ts:77-178,1097-1131,1261-1266`
- Modify: `yarn.lock`
- Modify: `docs/superpowers/specs/2026-10-26-single-desktop-maintenance-design.md:3-5`

**Interfaces:**
- Consumes: 当前 16-workspace 根拓扑和 `fixtureVersion: 2`。
- Produces: 13-workspace 根拓扑；无后缀桌面命令指向 HuaAnWork；`fixtureVersion: 3`；Task 2-6 依赖的单活跃根命令。

- [x] **Step 1: 分支基线提交（已完成）**

本分支创建时已提交设计、实施计划、两份 review 与 CI provisioning 注释修订；开工时只重钉基线并复核参考树/计划文件未漂移，不重复创建分支或提交同一批 docs：

```bash
BASE_SHA="$(git rev-parse master)"
BRANCH="$(git branch --show-current)"
test "$BRANCH" = 'refactor/huaanwork-single-desktop-maintenance'
test -z "$(git diff --name-only "$BASE_SHA" -- dsh-plugin-desktop dsh-plugin-desktop-beta dsh-desktop-next)"
git rev-parse "$BASE_SHA":deepseek-harness
git log -2 --oneline
```

若 `BASE_SHA` 不是 `b5ef3e84a7951941480b50a8749fe6714b8c9fc7`，先把设计头部基线改为实际值，并重新核对本计划涉及文件是否漂移；有漂移则停止并修订计划。基线的 docs/ci 提交已包含设计与计划，不再重复 `git add`/`git commit`。

- [ ] **Step 2: 先改根契约和单产品测试，确认失败**

把 `expected-root-gate-scripts.json` 改为 `fixtureVersion: 3`，四个命令严格等于下值；把 `expected-root-gate-scripts.test.mjs:10` 和 `package.spec.ts` 两处版本钉同步改为 `3`：

```json
{
  "fixtureVersion": 3,
  "build": "yarn market:prepare && yarn workspace dsh-community-market build && yarn workspace dsh-plugin-huaanwork build && yarn workspace market-server build && yarn workspace update-server build && yarn workspace agent-catalog-server build && yarn workspace agent-catalog-admin build",
  "typecheck": "yarn workspace dsh-plugin-huaanwork typecheck && yarn workspace dsh-community-market typecheck && yarn workspace market-server typecheck && yarn workspace update-server typecheck && yarn workspace @huaanwork/catalog-signing typecheck && yarn workspace @huaanwork/agent-package-format typecheck && yarn workspace agent-catalog-server typecheck && yarn workspace agent-catalog-admin typecheck",
  "test": "yarn workspace dsh-plugin-huaanwork test && yarn workspace dsh-community-market test && yarn workspace @huaanwork/policy test && yarn workspace @huaanwork/model test && yarn workspace @huaanwork/git-tools test && yarn workspace @huaanwork/web-tools test && yarn workspace market-server test && yarn workspace update-server test && yarn workspace @huaanwork/catalog-signing test && yarn workspace @huaanwork/agent-package-format test && yarn workspace agent-catalog-server test && yarn workspace agent-catalog-admin test",
  "check": "yarn check:whitespace && yarn check:layout && yarn test:aa-connector && yarn workspace dsh-community-fabric check && yarn workspace dsh-community-market check && yarn workspace dsh-plugin-huaanwork check && yarn workspace market-server check && yarn workspace update-server check && yarn workspace @huaanwork/catalog-signing check && yarn workspace @huaanwork/agent-package-format check && yarn workspace agent-catalog-server check && yarn workspace agent-catalog-admin check"
}
```

`package.spec.ts` 用根 `upstream.json` 取代 Stable manifest 读取，并改单产品断言；把 `EXPECTED_WORKSPACES` 提到 `describe` 外的文件级常量，供 Task 14 的最终结构测试复用：

```ts
const upstreamMetadata = JSON.parse(readFileSync(
  new URL('upstream.json', workspaceRoot), 'utf8',
)) as { channels: { stable: { runtimePackageVersion: string } } }
const stableRuntimeVersion = upstreamMetadata.channels.stable.runtimePackageVersion

const EXPECTED_WORKSPACES = [
  'dsh-plugin-huaanwork',
  'dsh-community-fabric',
  'dsh-community-market',
  'packages/huaanwork-policy',
  'packages/huaanwork-model',
  'packages/huaanwork-git-tools',
  'packages/huaanwork-web-tools',
  'market-server',
  'update-server',
  'packages/catalog-signing',
  'packages/agent-package-format',
  'agent-catalog-server',
  'agent-catalog-admin',
]
expect(workspaceManifest.workspaces).toEqual(EXPECTED_WORKSPACES)
expect(workspaceManifest.scripts?.['check:layout']).toBe(
  'yarn test:market-release && yarn test:aa-release && yarn check:bilingual-docs && yarn check:architecture && yarn check:vendored-runtime && node scripts/verify-layout.mjs && yarn test:gate-scripts && yarn check:readme-versions',
)
expect(manifest.dependencies?.dshmarket).toBe('1.70.2')
expect(workspaceManifest.resolutions?.['dshmarket@npm:1.70.2']).toBe(
  'patch:dshmarket@npm%3A1.70.2#./.yarn/patches/dshmarket-desktop.patch',
)
```

新增命令行为钉，删除 Stable manifest 和 Beta 图标读取；用新的 hash 测试替换 `dsh-plugin-huaanwork/tests/package.spec.ts:1261-1266` 的 `ships HuaAnWork-branded icons rather than the upstream artwork`（该测试读取 `../dsh-plugin-desktop-beta/build/app-icon.png`），图标使用当前 HuaAnWork 资产哈希：

```ts
it('maps unsuffixed desktop entry points only to HuaAnWork', () => {
  const scripts = workspaceManifest.scripts ?? {}
  for (const [plain, suffixed] of Object.entries({
    dev: 'dev:huaanwork',
    'package:dir': 'package:dir:huaanwork',
    'dist:mac': 'dist:mac:huaanwork',
    'dist:mac-smoke': 'dist:mac-smoke:huaanwork',
    'dist:win': 'dist:win:huaanwork',
    'dist:win-portable': 'dist:win-portable:huaanwork',
  })) expect(scripts[plain]).toBe(scripts[suffixed])
  expect(scripts.start).toBe('yarn market:prepare && yarn workspace dsh-plugin-huaanwork start')
  expect(scripts['check:vendored-runtime']).toBe('node scripts/sync-vendored-runtime.mjs --check --channel huaanwork')
  for (const name of [
    'dist:linux', 'dev:beta', 'start:beta', 'package:dir:beta', 'dist:mac:beta',
    'dist:mac-smoke:beta', 'dist:win:beta', 'dist:win-portable:beta',
    'dev:next', 'start:next', 'check:next', 'package:dir:next', 'dist:mac:next',
    'dist:mac-smoke:next', 'dist:win:next', 'test:desktop-variants',
    'check:desktop-variants', 'icons:export', 'icons:check', 'test:inspector-compat',
  ]) expect(scripts[name], name).toBeUndefined()
})

it('ships the recorded HuaAnWork-branded icon', () => {
  const ours = readFileSync(new URL('build/app-icon.png', packageRoot))
  expect(createHash('sha256').update(ours).digest('hex'))
    .toBe('532052effd6ad27a3dc3be0b0504d2d6a2e33be98a6c95971153dcb6153c5e47')
})
```

`prepare-dsh-market.test.mjs` 的 entrypoint 测试改为精确集合，不再用 `>= 18`：

```js
const entrypoints = Object.entries(scripts).filter(([name]) => /^(build$|dev(?::|$)|start(?::|$)|package:dir|dist:)/.test(name))
assert.deepEqual(entrypoints.map(([name]) => name).sort(), [
  'build', 'dev', 'dev:huaanwork', 'dev:update-server', 'start',
  'package:dir', 'package:dir:huaanwork',
  'dist:mac', 'dist:mac-smoke', 'dist:mac:huaanwork', 'dist:mac-smoke:huaanwork',
  'dist:win', 'dist:win-portable', 'dist:win:huaanwork', 'dist:win-portable:huaanwork', 'dist:win-sign:huaanwork',
].sort())
for (const [name, command] of entrypoints) assert.ok(command.startsWith('yarn market:prepare && '), name)
```

- [ ] **Step 3: 运行测试并确认因旧根实现失败**

```bash
corepack yarn test:gate-scripts
corepack yarn workspace dsh-plugin-huaanwork vitest run tests/package.spec.ts
corepack yarn test:market-release
```

Expected: FAIL；根 manifest 仍有 16 workspaces、旧命令和 `fixtureVersion: 2`。

- [ ] **Step 4: 改根 manifest 与 layout 实现**

`package.json` workspaces 精确使用 Step 2 的 13 项；`build/typecheck/test/check` 使用 fixture 的四个字符串。无后缀命令分别复制对应 `:huaanwork` 值；`start` 使用 Step 2 精确值。删除 Step 2 列出的退役命令。`check:layout` 使用 Step 2 精确字符串，`check:vendored-runtime` 只保留 huaanwork。

`verify-layout.mjs` 做以下完整收窄：
- 删除 Stable/Beta/Next manifest 和 `upstream-reference.json` 读取及其名称、Next 私有包检查。
- workspaces 精确比较 Step 2 的 13 项。
- packageManager 继承、发布边界检查只遍历 root、huaanwork、fabric、market。
- legacy pnpm 文件清单删除三个参考树路径，保留根、HuaAnWork、fabric、market。
- runtime 依赖循环只保留 `[['huaanwork', huaanworkPlugin]]`；不得读取参考包来获得其他通道版本。
- **activeChannel 时序**：本任务保持 `upstream.json.activeChannel` 为 `beta`，`verify-layout.mjs:28` 的三通道白名单（stable/beta/huaanwork）不得提前收窄为仅 huaanwork；Task 4 才切换 activeChannel。否则 Task 1 Step 5 的 `node scripts/verify-layout.mjs` 会因 beta 失败。
- 成功输出改为 `verify-layout: HuaAnWork and retained workspaces are consistent with upstream <commit>` 的同一 commit 计算形式。

运行 `corepack yarn install` 重解 lockfile，不手编 `yarn.lock`。

- [ ] **Step 5: 验证单任务门禁和参考树零改动**

```bash
corepack yarn install --immutable
corepack yarn test:gate-scripts
corepack yarn workspace dsh-plugin-huaanwork vitest run tests/package.spec.ts
corepack yarn test:market-release
node scripts/verify-layout.mjs
git diff --check
test -z "$(git diff --name-only "$BASE_SHA" -- dsh-plugin-desktop dsh-plugin-desktop-beta dsh-desktop-next)"
```

Expected: 全部 PASS，layout 不再读取参考包。

- [ ] **Step 6: Commit**

```bash
git add package.json yarn.lock scripts/verify-layout.mjs scripts/expected-root-gate-scripts.json scripts/expected-root-gate-scripts.test.mjs scripts/prepare-dsh-market.test.mjs dsh-plugin-huaanwork/tests/package.spec.ts
git commit -m "refactor(root): make HuaAnWork the only active desktop workspace"
```

---

### Task 2: market 只刷新 HuaAnWork

**Files:**
- Modify: `scripts/prepare-dsh-market.mjs:1-8,87-92`
- Modify: `scripts/prepare-dsh-market.test.mjs:30-53`

**Interfaces:**
- Consumes: Task 1 的单活跃根命令。
- Produces: `MARKET_WORKSPACES = ['dsh-plugin-huaanwork']`；snapshot、rollback、check 都只触达 HuaAnWork。

- [ ] **Step 1: 写失败测试**

在 `prepare-dsh-market.test.mjs` 增加，并把 stale installed 路径和错误断言从 `dsh-desktop-next` 改为 `dsh-plugin-huaanwork`：

```js
test('targets only the active HuaAnWork workspace', () => {
  assert.deepEqual(MARKET_WORKSPACES, ['dsh-plugin-huaanwork'])
})
```

- [ ] **Step 2: 运行并确认失败**

Run: `corepack yarn test:market-release`
Expected: FAIL，实际数组仍含四个桌面。

- [ ] **Step 3: 最小实现**

```js
export const MARKET_WORKSPACES = ['dsh-plugin-huaanwork']
```

文件头注释改为 `Refresh HuaAnWork's bundled market...`，CLI 成功输出改为：

```js
console.log(`dshmarket latest verified: ${version} in HuaAnWork`)
```

- [ ] **Step 4: 验证在线 check 和回滚测试**

```bash
corepack yarn test:market-release
corepack yarn market:check
test -z "$(git diff --name-only "$BASE_SHA" -- dsh-plugin-desktop dsh-plugin-desktop-beta dsh-desktop-next)"
```

Expected: PASS；`market:check` 必须在线确认 latest，离线或 patch 不兼容时停止，不运行 prepare 掩盖。

- [ ] **Step 5: Commit**

```bash
git add scripts/prepare-dsh-market.mjs scripts/prepare-dsh-market.test.mjs
git commit -m "refactor(market): refresh only the HuaAnWork desktop"
```

---

### Task 3: AA 单通道 peers、artifact 与 provenance 原子再生

**Files:**
- Modify: `scripts/agents-anywhere-release-policy.mjs:1-8`
- Modify: `scripts/agents-anywhere-release-policy.test.mjs`
- Modify: `scripts/prepare-agents-anywhere-release.mjs:160`
- Modify: `vendor/agents-anywhere/provenance.json`
- Create: `vendor/agents-anywhere/` 中由 prepare 计算文件名的新 `.tgz`
- Modify: `dsh-plugin-huaanwork/package.json`
- Modify: `package.json`
- Modify: `yarn.lock`

**Interfaces:**
- Consumes: 现有 `runtimePeerRanges(root)`、`assertPreparedAaRelease(root, expectedCommit)` 和 `versionForCommit()`。
- Produces: `AA_WORKSPACES = ['dsh-plugin-huaanwork']`；三个 AA peer range 均只取 HuaAnWork；新 artifact 哈希与 provenance 一致。

- [ ] **Step 1: 改测试以钉住单通道并确认失败**

在 policy 测试顶部增加：

```js
test('targets only HuaAnWork runtime peers', () => {
  assert.deepEqual(AA_WORKSPACES, ['dsh-plugin-huaanwork'])
})
```

fixture 的 `runtimePeers` 改成每个 peer 都是 `'0.1.5-rc.2'`，workspace 依赖不再按 index 生成第二腿；所有负例路径统一为 `dsh-plugin-huaanwork`。删除重复的 Next stale-manifest 用例，保留一个 manifest 旧 artifact 负例、一个 installed 旧版本负例和一个 runtime peer 改变负例。测试标题中的 “Stable, Beta and Next” / “both Desktop runtime peer ranges” 改为 “HuaAnWork” / “the active runtime peer range”。

Run: `corepack yarn test:aa-release`
Expected: FAIL，数组仍含四个 workspace。

- [ ] **Step 2: 收窄实现并跑单元测试**

```js
/** Validate the AA artifact selected by HuaAnWork. */
export const AA_WORKSPACES = ['dsh-plugin-huaanwork']
```

`prepare-agents-anywhere-release.mjs` 只有 `:160` 一处 “all Desktop channels”，改为 “HuaAnWork”；另一处测试标题在 `scripts/agents-anywhere-release-policy.test.mjs:47` 与 `:71`，已在 Step 1 改。然后：

Run: `corepack yarn test:aa-release`
Expected: PASS。

- [ ] **Step 3: 用既有 prepare 原子再生所有 AA 关联物**

```bash
corepack yarn aa:prepare-release
```

Expected: `runtimePeerRanges` 从双通道 union 收窄为 HuaAnWork 的 `0.2.1-rc.1`，`versionForCommit` 生成新哈希；artifact、provenance、根 resolution、HuaAnWork manifest 和 lockfile 同次更新。不得手工编辑这些生成值，不得删除旧 AA tgz 来减少 diff。

检查 `git status --short`；若任何参考树 manifest 被写入，停止并修复清单后再重新 prepare。

- [ ] **Step 4: 验证 freshness、安装版本和 connector**

```bash
corepack yarn aa:check
corepack yarn test:aa-connector
corepack yarn test:aa-release
corepack yarn install --immutable
test -z "$(git diff --name-only "$BASE_SHA" -- dsh-plugin-desktop dsh-plugin-desktop-beta dsh-desktop-next)"
```

Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add scripts/agents-anywhere-release-policy.mjs scripts/agents-anywhere-release-policy.test.mjs scripts/prepare-agents-anywhere-release.mjs vendor/agents-anywhere dsh-plugin-huaanwork/package.json package.json yarn.lock
git commit -m "refactor(aa): prepare the connector only for HuaAnWork"
```

---

### Task 4: vendored runtime 归 HuaAnWork，保留阶段 A peer 值

**Files:**
- Create: `scripts/vendored-runtime-policy.mjs`
- Create: `scripts/vendored-runtime-policy.test.mjs`
- Modify: `scripts/sync-vendored-runtime.mjs:56-69`
- Modify: `upstream.json:3`

**Interfaces:**
- Consumes: 三通道 `upstream.json`；beta/huaanwork 都是 `0.2.1-rc.1`。
- Produces: `ownsMarketRuntime(channel: string): boolean`、`marketPeerRange(document): string`；阶段 A peer 精确为 `0.2.0-rc.2 || 0.2.1-rc.1 || 0.2.1-alpha.1`。

- [ ] **Step 1: 写失败测试**

```js
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { marketPeerRange, ownsMarketRuntime } from './vendored-runtime-policy.mjs'

const document = JSON.parse(readFileSync(new URL('../upstream.json', import.meta.url), 'utf8'))

test('HuaAnWork owns market runtime checks without changing the Phase A peer range', () => {
  assert.equal(document.activeChannel, 'huaanwork')
  assert.deepEqual(Object.keys(document.channels).sort(), ['beta', 'huaanwork', 'stable'])
  assert.equal(ownsMarketRuntime('huaanwork'), true)
  assert.equal(ownsMarketRuntime('beta'), false)
  assert.equal(ownsMarketRuntime('stable'), false)
  assert.equal(marketPeerRange(document), '0.2.0-rc.2 || 0.2.1-rc.1 || 0.2.1-alpha.1')
})
```

Run: `node --test scripts/vendored-runtime-policy.test.mjs`
Expected: FAIL，模块不存在。

- [ ] **Step 2: 实现纯函数并接线**

`vendored-runtime-policy.mjs`：

```js
export function ownsMarketRuntime(channel) {
  return channel === 'huaanwork'
}

export function marketPeerRange(upstreamDocument) {
  return [...new Set([
    ...['stable', 'beta'].map(name => upstreamDocument.channels?.[name]?.sourceVersion),
    '0.2.1-alpha.1',
  ])].join(' || ')
}
```

`sync-vendored-runtime.mjs` import 两个函数，`pluginPaths` 使用 `...(ownsMarketRuntime(channel) ? [marketPath] : [])`，删除本地 `marketPeerRange` 表达式并调用纯函数。注释改为 HuaAnWork 拥有 market DSH 依赖校验；不得改 peer 构造的通道、顺序或值。`upstream.json` 只把 `activeChannel` 改为 `huaanwork`，channels 全部保留。

- [ ] **Step 3: 验证纯函数、真实 runtime 和 layout**

```bash
node --test scripts/vendored-runtime-policy.test.mjs
corepack yarn check:vendored-runtime
node scripts/verify-layout.mjs
test -z "$(git diff --name-only "$BASE_SHA" -- dsh-plugin-desktop dsh-plugin-desktop-beta dsh-desktop-next)"
```

Expected: PASS；check 是只读 `--check`，不得运行 `--write`。

- [ ] **Step 4: Commit**

```bash
git add scripts/vendored-runtime-policy.mjs scripts/vendored-runtime-policy.test.mjs scripts/sync-vendored-runtime.mjs upstream.json
git commit -m "refactor(runtime): assign market runtime checks to HuaAnWork"
```

---

### Task 5: 参考工具退出根测试 glob 和活跃架构门

**Files:**
- Create: `scripts/active-topology.test.mjs`
- Rename: `scripts/verify-desktop-variants.test.mjs` → `scripts/verify-desktop-variants.reference.mjs`
- Rename: `scripts/export-app-icons.test.mjs` → `scripts/export-app-icons.reference.mjs`
- Rename: `scripts/inspector-compat.test.mjs` → `scripts/inspector-compat.reference.mjs`
- Rename: `scripts/upstream-sync-dashboard.test.mjs` → `scripts/upstream-sync-dashboard.reference.mjs`
- Modify: `scripts/market-dependency-direction.mjs:14-26`
- Modify: `scripts/market-dependency-direction.test.mjs:180-196`
- Modify: `package.json`（`test:architecture-gates`；Task 1 已改过该文件，按脚本符号定位，不用固定行号）

**Interfaces:**
- Consumes: Task 2-4 已单化的 market/AA/runtime 测试。
- Produces: `test:scripts` 不再直接执行 variant/icons/Next inspector/旧 dashboard；架构扫描只读 HuaAnWork 与 `@huaanwork/*` 源码；`active-topology.test.mjs` 经 `test:architecture-gates` 进入 `check:architecture`，持续执行。

- [ ] **Step 1: 写 glob 和扫描根失败测试**

`active-topology.test.mjs`：

```js
import assert from 'node:assert/strict'
import { readdirSync } from 'node:fs'
import { test } from 'node:test'

test('reference-only desktop tools do not re-enter the root test glob', () => {
  const tests = readdirSync(new URL('./', import.meta.url)).filter(name => name.endsWith('.test.mjs'))
  for (const retired of [
    'verify-desktop-variants.test.mjs',
    'export-app-icons.test.mjs',
    'inspector-compat.test.mjs',
    'upstream-sync-dashboard.test.mjs',
  ]) assert.equal(tests.includes(retired), false, `${retired} must not run in Phase A`)
})
```

把 market-direction 最后一条结构测试改为：必须包含 `dsh-plugin-huaanwork/src` 与四个 `packages/huaanwork-*/src`，必须不包含 `dsh-plugin-desktop/src` 和 `dsh-plugin-desktop-beta/src`。合成 import 负例中的历史包名保留，它们验证禁止规则而不是文件系统依赖。

- [ ] **Step 2: 运行并确认失败**

```bash
node --test scripts/active-topology.test.mjs scripts/market-dependency-direction.test.mjs
```

Expected: FAIL，旧 `.test.mjs` 文件和参考扫描根仍存在。

- [ ] **Step 3: 改名退出 glob 并收窄扫描根**

```bash
git mv scripts/verify-desktop-variants.test.mjs scripts/verify-desktop-variants.reference.mjs
git mv scripts/export-app-icons.test.mjs scripts/export-app-icons.reference.mjs
git mv scripts/inspector-compat.test.mjs scripts/inspector-compat.reference.mjs
git mv scripts/upstream-sync-dashboard.test.mjs scripts/upstream-sync-dashboard.reference.mjs
```

`DESKTOP_SOURCE_ROOTS` 删除 Stable/Beta 两行，保留 HuaAnWork 与四个 packages 根。保留 `DESKTOP_MODULE` 对旧包名的禁止，避免未来 market 代码引用历史实现。

把根 `package.json` 的 `test:architecture-gates` 从 `node --test scripts/market-dependency-direction.test.mjs` 改为 `node --test scripts/market-dependency-direction.test.mjs scripts/active-topology.test.mjs`，使 `check:architecture`（已挂在 `check:layout`/`check`）持续执行该结构钉。`check:architecture` 本身、`expected-root-gate-scripts.json` 和 `check:layout` 字符串不变；当前没有测试断言旧 `test:architecture-gates` 值（已确认）。

- [ ] **Step 4: 跑完整根脚本测试**

```bash
node --test scripts/active-topology.test.mjs scripts/market-dependency-direction.test.mjs
corepack yarn test:scripts
corepack yarn check:architecture
test -z "$(git diff --name-only "$BASE_SHA" -- dsh-plugin-desktop dsh-plugin-desktop-beta dsh-desktop-next)"
```

Expected: PASS；旧 dashboard 不再通过 glob 间接导入 `PAIRS` 或扫描参考树。

- [ ] **Step 5: Commit**

```bash
git add package.json scripts/active-topology.test.mjs scripts/verify-desktop-variants.reference.mjs scripts/export-app-icons.reference.mjs scripts/inspector-compat.reference.mjs scripts/upstream-sync-dashboard.reference.mjs scripts/verify-desktop-variants.test.mjs scripts/export-app-icons.test.mjs scripts/inspector-compat.test.mjs scripts/upstream-sync-dashboard.test.mjs scripts/market-dependency-direction.mjs scripts/market-dependency-direction.test.mjs
git commit -m "refactor(gates): retire multi-desktop reference checks"
```

---

### Task 6: CI 只构建 HuaAnWork

**Files:**
- Modify: `.github/workflows/ci.yml:94-164,170-316`
- Modify: `dsh-plugin-huaanwork/tests/package.spec.ts:1133-1170`

**Interfaces:**
- Consumes: Task 1 根命令和现有 `workflow_dispatch`。
- Produces: Windows/macOS 单格 HuaAnWork 矩阵、无 `desktop-linux`、无 Next 专项步骤、AA-skip 只改 HuaAnWork。

- [ ] **Step 1: 改 CI 行为测试并确认失败**

用 `splitWorkflowJobs(ciWorkflow)` 取代依赖 `desktop-linux` 边界的切片，核心断言改为：

```ts
const jobs = splitWorkflowJobs(ciWorkflow)
const windowsJob = jobs['desktop-windows']!
const macosJob = jobs['desktop-macos']!
expect(jobs['desktop-linux']).toBeUndefined()
expect(windowsJob).toContain('workspace: [dsh-plugin-huaanwork]')
expect(windowsJob).toContain('- run: yarn workspace ${{ matrix.workspace }} check:win-package:platform')
expect(windowsJob).toContain("if: matrix.workspace == 'dsh-plugin-huaanwork'")
expect(windowsJob).toContain('yarn workspace dsh-plugin-huaanwork test:host-liveness-win')
expect(macosJob).toContain('workspace: [dsh-plugin-huaanwork]')
expect(macosJob).toContain('- run: yarn workspace ${{ matrix.workspace }} check:mac-package:platform')
expect(macosJob).toContain("HUAANWORK_ALLOW_UNPROVISIONED_SMOKE: '1'")
expect(ciWorkflow).toContain("for (const workspace of ['dsh-plugin-huaanwork'])")
expect(ciWorkflow).not.toMatch(/dsh-plugin-desktop(?:-beta)?/u)
expect(ciWorkflow).not.toContain('dsh-desktop-next')
expect(ciWorkflow).not.toContain('Verify Next window controls')
```

保留现有 Windows portable、compression、Host liveness、macOS smoke arch 和 provisioning env 断言。

Run: `corepack yarn workspace dsh-plugin-huaanwork vitest run tests/package.spec.ts`
Expected: FAIL，CI 仍是三桌面矩阵。

- [ ] **Step 2: 修改 workflow**

- AA-skip 循环只含 `dsh-plugin-huaanwork`，删除 Stable PR 特判和不再使用的 `EVENT_NAME` env。
- 删除 Playwright cache、Chromium install、Next verify 和 sidebar-browser artifact 步骤。
- Windows/macOS `workspace` 矩阵改为 `[dsh-plugin-huaanwork]`；保留 matrix 形式的缓存路径和打包步骤。
- 删除整个 `desktop-linux` job 及上方 Linux 注释，不创建 HuaAnWork Linux job。
- provisioning 注释修订已随分支基线提交（见 Task 1 Step 1）；本任务只保留现有注释和 `HUAANWORK_ALLOW_UNPROVISIONED_SMOKE: '1'`，不改触发器。

- [ ] **Step 3: 验证结构与 YAML diff**

```bash
corepack yarn workspace dsh-plugin-huaanwork vitest run tests/package.spec.ts
git diff --check
test -z "$(git diff --name-only "$BASE_SHA" -- dsh-plugin-desktop dsh-plugin-desktop-beta dsh-desktop-next)"
```

Expected: PASS；真实 workflow 语义由 Task 8 的 dispatch 验证。

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/ci.yml dsh-plugin-huaanwork/tests/package.spec.ts
git commit -m "ci(huaanwork): narrow desktop jobs"
```

---

### Task 7: 阶段 A 活规则和 README 清点

**Files:**
- Modify: `AGENTS.md:15-41,49-72`
- Modify: `README.md:75-180`
- Modify: `README.en.md:75-180`
- Modify: `README.i18n.yaml`
- Modify: `CONTRIBUTING.md:38,49`
- Modify: `CONTRIBUTING.en.md:38,45`
- Modify: `docs/architecture.md:56-75`
- Modify: `docs/architecture.en.md:56-75`
- Modify: `docs/README.md:33-44`
- Modify: `docs/README.en.md:33-44`
- Modify: `docs/plugin-development.md:16,25-26,99-101,200`
- Modify: `docs/plugin-development.en.md:16,25-26,99-101,200`
- Modify: `docs/plugin-development.i18n.yaml`
- Modify: `docs/why-desktop.md:48-49`
- Modify: `docs/why-desktop.en.md:48-49`
- Modify: `dsh-community-market/README.md:64`
- Modify: `dsh-community-market/README.zh.md:64`
- Modify: `dsh-community-market/README.i18n.yaml`
- Modify: `docs/upstream-sync.md:1-6`
- Create: `docs/evidence/2026-10-29-single-desktop-rules-triage.md`

**Interfaces:**
- Consumes: Task 1-6 已退役的真实命令和目录保护边界。
- Produces: 无退役命令的阶段 A 活规则；zero-touch 仍保留到阶段 B；AGENTS 债表与活文档的逐行三分类证据；被改双语文档的 `.i18n.yaml` 记录同步更新。

- [ ] **Step 1: 写规则三分类记录**

在 triage 文档写入基线 SHA、分支和以下逐行处置；每行附“关闭 / 改写 / 保留”及原因，不能用一条“其余同理”替代：

| AGENTS 行/条目 | 阶段 A 处置 | 阶段 B 处置 |
| --- | --- | --- |
| `:15` market freshness | 改写：只刷新 HuaAnWork | 保留 |
| `:16` AA freshness | 改写：只准备 HuaAnWork | 保留 |
| `:20` Next dev/check | 关闭：命令已删除 | 保持关闭 |
| `:21` beta-first + variant gate | 关闭：活跃命令和守卫已退役 | 保持关闭 |
| `:23` upstream 指针 | 改写：指向过渡说明 | 改写为 selective port |
| `:26-27` Stable/Next ownership | 改写：只读参考树 | 关闭：目录删除 |
| `:39` Beta 衍生事实 | 保留：历史身份事实 | 保留 |
| `:40` zero-touch | 改写：保护三个完整参考树，不再指向 variant 命令 | 关闭 |
| `:41` market runtime ownership | 改写：归 HuaAnWork | 按 peer 裁定更新 |
| 债表 `verify:aa` 行 | 改写：文件和并发描述归 HuaAnWork | 保留 |
| 债表 wrapper N-11 已解决行 | 保留：历史处置，不重开 | 保留 |
| 债表上游同步例外行 | 改写：只剩 HuaAnWork/market-server 的 root fixture 读取 | 关闭整仓冲突例外 |
| 债表 variant 结构清单行 | 关闭：守卫退出活跃门禁 | 删除对应文件 |
| 债表 DSH 命名残留行 | 改写：保留实际残留，删除三包同形/白名单成本口径 | 保留实际残留 |
| 债表三包 tests 漂移行 | 关闭：三包同形不再是维护目标 | 保持关闭 |
| 债表 M8 大同步已收口行 | 保留：历史事实 | 由 selective 模型承接未来工作 |
| 债表 R-M8-2 Next 基座观察 | 改写：阶段 A 休眠，不再触发活跃 Next 工作 | 关闭 |
| 债表 variant 守卫既有红已解决行 | 关闭：守卫退役 | 保持关闭 |
| 债表 Next sidebar-browser 已解决行 | 关闭：Next 不再是活跃产品 | 保持关闭 |
| 债表 M9 上游同步已收口行 | 保留：历史事实和当前 peer 背景 | 按 Task 9-10 裁定改写 |
| 债表 huaanwork 未吸收 2.1 行 | 改写：15 新增 + 25 合并只作存量背景，不再用守卫计数推进 | 改由 reviewedCommit 货架和人工裁定承接 |
| 其他债项 | 保留：与本改造无直接关系 | 保留原触发条件 |

另追加一张活文档表：按 Step 2 的三分类逐文件登记当前引用、处置和允许保留的上游/历史命中。另登记历史/死条目：`assets/app-icons.source.json` 的 `artwork.stable/next`、`previews.stable/next/beta` 指向将删除的参考树，`exportCommand`/`verifyCommand` 指向已删除的 `icons:*` 命令；全仓无代码引用，作为历史溯源保留，不改内容。

- [ ] **Step 2: 改活规则与根 README**

`AGENTS.md` 按上表落地。阶段 A 的参考树规则精确写为：三个目录不是 workspace，不参与日常构建、测试、打包或版本刷新，tracked 内容仍禁止修改；HuaAnWork 改动直接落在 `dsh-plugin-huaanwork/`。删除 `dev:next`、`check:next`、`check:desktop-variants` 和 beta-first 的活命令。market runtime 句改为“由 huaanwork 通道同步与校验”。

根中英文 README：
- 开发段写 `dsh-plugin-huaanwork/` 是唯一活跃桌面树，三个参考目录仅暂存作只读对照且不是 workspace。
- 插件 API 和包级 README 链接分别指向 `dsh-plugin-huaanwork/docs/plugin-services[.zh].md` 与 `dsh-plugin-huaanwork/README[.zh].md`。
- macOS 权限段改为 HuaAnWork 主应用和 Helper 使用 pinned Harness entitlements；不写 Stable/Beta/Next 活跃签名线。
- 自动更新通道的当前产品说明写 `huaanwork`，不保留 Stable/Beta 活跃更新协议描述；实际协议代码不变。

活文档三分类（不得机械替换；逐文件登记进 triage 文档）：

| 类别 | 文档 | 处置 |
| --- | --- | --- |
| 当前产品 | `CONTRIBUTING.md/.en.md`、`docs/architecture.md/.en.md`、`docs/README.md/.en.md`、`docs/plugin-development.md/.en.md`、`docs/why-desktop.md/.en.md`、`dsh-community-market/README.md/.zh.md` | 当前产品、本地路径、命令和链接改指 `dsh-plugin-huaanwork/`。`CONTRIBUTING` 的 `verify:notices` 改为 `yarn workspace dsh-plugin-huaanwork verify:notices`，notices 路径改为 `dsh-plugin-huaanwork/THIRD_PARTY_NOTICES.md` |
| 上游 npm contract / 历史身份 | `dsh-plugin-desktop/profile-service`、`dsh-plugin-desktop-beta/*`、`DESKTOP_RELEASE_IDENTITIES.stable/beta`、迁移字符串、`.agents/notes` | 保留；必要时改指 outer upstream URL，或保留 npm 包名并注明性质/历史身份。不得为了路径零命中把它们改成 HuaAnWork |
| 历史设计/评审/证据 | `docs/superpowers/{specs,plans,evidence}` | 原样保留 |

同一文件内同时存在“当前产品”和“上游 npm contract / 历史身份”时，按上下文分别处理，不要求整文件统一替换；无法判断性质的命中保留原文并在 triage 文档说明。

改完任何有 `.i18n.yaml` 记录的双语文档后，用与守卫相同的形态更新记录；至少包括 `README.i18n.yaml`、`docs/plugin-development.i18n.yaml`、`dsh-community-market/README.i18n.yaml`：

```bash
git hash-object --path=README.md -- README.md
git hash-object --path=README.en.md -- README.en.md
git hash-object --path=docs/plugin-development.md -- docs/plugin-development.md
git hash-object --path=docs/plugin-development.en.md -- docs/plugin-development.en.md
git hash-object --path=dsh-community-market/README.md -- dsh-community-market/README.md
git hash-object --path=dsh-community-market/README.zh.md -- dsh-community-market/README.zh.md
```

`docs/upstream-sync.md` 顶部只新增过渡横幅：§§1-7 是整仓合并时代规则，阶段 A 活跃产品已单化，阶段 B 将由 `desktop-upstream.json` 和 selective review 取代；不重写 §8 的历史快照。

- [ ] **Step 3: 验证无双语文档和死命令**

```bash
corepack yarn check:bilingual-docs
corepack yarn check:readme-versions
! grep -nE 'dev:next|check:next|dev:beta|dist:mac:beta|check:desktop-variants|icons:check' AGENTS.md
rg -n 'dsh-plugin-desktop' CONTRIBUTING.md CONTRIBUTING.en.md docs/architecture.md docs/architecture.en.md docs/README.md docs/README.en.md docs/plugin-development.md docs/plugin-development.en.md docs/why-desktop.md docs/why-desktop.en.md dsh-community-market/README.md dsh-community-market/README.zh.md
# 不要求零命中；所有剩余命中必须属于 triage 文档“上游 npm contract / 历史身份”清单，否则改指向。
git diff --check
test -z "$(git diff --name-only "$BASE_SHA" -- dsh-plugin-desktop dsh-plugin-desktop-beta dsh-desktop-next)"
```

Expected: 全部 PASS；AGENTS 的死命令 `rg` 无输出；活文档 `rg` 的每条命中都在 triage 文档的“保留上游 contract/历史身份”清单中。

- [ ] **Step 4: Commit**

```bash
git add AGENTS.md README.md README.en.md README.i18n.yaml CONTRIBUTING.md CONTRIBUTING.en.md docs/architecture.md docs/architecture.en.md docs/README.md docs/README.en.md docs/plugin-development.md docs/plugin-development.en.md docs/plugin-development.i18n.yaml docs/why-desktop.md docs/why-desktop.en.md dsh-community-market/README.md dsh-community-market/README.zh.md dsh-community-market/README.i18n.yaml docs/upstream-sync.md docs/evidence/2026-10-29-single-desktop-rules-triage.md
git commit -m "docs: record the single-active-desktop transition"
```

---

### Task 8: 阶段 A 本地、macOS smoke 与分支 CI 硬门禁

**Files:**
- Create: `docs/evidence/2026-10-29-single-desktop-phase-a.md`

**Interfaces:**
- Consumes: Task 1-7 的最终阶段 A 代码 SHA。
- Produces: 精确代码 SHA、四个本地门禁、provisioning/smoke、完整 CI run URL 和参考树零改动证据；只有本任务完成后才允许 Task 9。

- [ ] **Step 1: 固定被验证代码 SHA 并运行四个串行门禁**

```bash
git diff --check
test -z "$(git status --porcelain | grep -vE '^\?\? (\.gstack/|docs/superpowers/(specs|plans)/2026-10-29-single-desktop-maintenance-(design|plan)-review\.md)$' || true)"
PHASE_A_SHA="$(git rev-parse HEAD)"
printf '%s\n' "$PHASE_A_SHA"
corepack yarn install --immutable
corepack yarn check
corepack yarn typecheck
corepack yarn test
```

Expected: 全部 exit 0。任一失败就停止，不进入阶段 B。

- [ ] **Step 2: 先记录 provisioning 守卫，再跑本机 unsigned smoke**

```bash
node dsh-plugin-huaanwork/scripts/huaanwork-verify-provisioning.mjs --smoke
corepack yarn dist:mac-smoke:huaanwork
```

若且仅若第一条因实际 provisioning 缺项退出非零，记录完整缺项后使用：

```bash
HUAANWORK_ALLOW_UNPROVISIONED_SMOKE=1 corepack yarn dist:mac-smoke:huaanwork
```

证据只能写 unsigned smoke；使用豁免时写 unsigned/unprovisioned smoke 和缺项。静态守卫通过不等于部署交付或 origin 可达。

- [ ] **Step 3: 确保 smoke 未产生未处置生成物，然后推送精确 SHA**

```bash
test -z "$(git status --porcelain | grep -vE '^\?\? (\.gstack/|docs/superpowers/(specs|plans)/2026-10-29-single-desktop-maintenance-(design|plan)-review\.md)$' || true)"
test -z "$(git diff --name-only "$BASE_SHA" -- dsh-plugin-desktop dsh-plugin-desktop-beta dsh-desktop-next)"
test "$(git rev-parse "$PHASE_A_SHA":deepseek-harness)" = '1600d8a1e140dcde43a1a0941940a0480712c011'
git push -u origin "$BRANCH"
```

若 market/AA prepare 产生 diff，停止；处置并提交生成物后从 Step 1 重新验证新 SHA。

- [ ] **Step 4: dispatch 并等待同一 SHA 的完整 CI**

```bash
gh workflow run ci.yml --ref "$BRANCH" --repo kawaiininja/HuaAnWork-Desktop
RUN_ID=''
for attempt in {1..30}; do
  RUN_ID="$(gh run list --workflow ci.yml --branch "$BRANCH" --event workflow_dispatch --limit 20 --json databaseId,headSha --repo kawaiininja/HuaAnWork-Desktop | jq -r --arg sha "$PHASE_A_SHA" 'first(.[] | select(.headSha == $sha) | .databaseId)')"
  if [[ "$RUN_ID" =~ ^[0-9]+$ ]]; then break; fi
  sleep 2
done
test "$RUN_ID" != 'null' && test -n "$RUN_ID"
gh run watch "$RUN_ID" --exit-status --repo kawaiininja/HuaAnWork-Desktop
gh run view "$RUN_ID" --repo kawaiininja/HuaAnWork-Desktop --json headSha,status,conclusion,url,jobs
```

Expected: `headSha == PHASE_A_SHA`、`conclusion == success`；Windows installer/portable、Host liveness、macOS smoke 和保留共享 job 全成功。Windows 不声称第二台机器验收，macOS 不声称签名或公证。

- [ ] **Step 5: 落盘证据并提交，仅允许证据文件变化**

证据文档记录：基线、`PHASE_A_SHA`、四条本地命令及结果、provisioning 输出和是否豁免、smoke 性质、CI run ID/URL、每个保留 job 结果、参考树零 diff、Harness pin、未直接推 master/未发布声明。

```bash
git add docs/evidence/2026-10-29-single-desktop-phase-a.md
git commit -m "docs: record phase A single-desktop acceptance"
test -z "$(git diff --name-only "$PHASE_A_SHA"..HEAD -- . ':!docs/evidence/2026-10-29-single-desktop-phase-a.md')"
git push origin "$BRANCH"
```

只有此步成功才能开始 Task 9。阶段 A 的代码 SHA 是恢复点；证据提交是其直接后代且只含证据。

---

### Task 9: 阶段 B 消费方扫描与 market peer 政策裁定

**Files:**
- Create: `docs/evidence/2026-10-29-single-desktop-runtime-consumers.md`

**Interfaces:**
- Consumes: 已通过 Task 8 的阶段 A 恢复点、仍存在可供调查的参考树。
- Produces: `stableHistorical` 与 `dormantAlpha1` 两个独立裁定、旧 resolutions/vendor/patches 消费方清单；未获明确裁定前不得执行 Task 10 或任何 `--write`。

- [ ] **Step 1: 实测 market bundle 和旧 runtime 消费方**

```bash
rg -n 'dsh-community-market|dshmarket' dsh-plugin-desktop/src dsh-plugin-desktop-beta/src dsh-desktop-next/src dsh-plugin-huaanwork/src --glob '*.ts' --glob '*.tsx'
node --input-type=module <<'NODE'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
const root = JSON.parse(readFileSync('package.json', 'utf8'))
const selectors = Object.keys(root.resolutions ?? {})
const lockText = readFileSync('yarn.lock', 'utf8')
const versions = new Set(readdirSync('vendor/dsh-runtime'))
for (const name of readdirSync('patches')) {
  if (name.startsWith('dsh')) versions.add(name.match(/@([^@]+)\.patch$/u)?.[1])
}
for (const version of [...versions].filter(Boolean).sort()) {
  const resolutions = selectors.filter(selector => selector.endsWith(`@npm:${version}`) || selector.endsWith(`@npm:^${version}`)).length
  const lockReferences = lockText.split(`vendor/dsh-runtime/${version}/`).length - 1
  const patches = readdirSync('patches').filter(name => name.endsWith(`@${version}.patch`)).length
  console.log(`${version}\tvendor=${existsSync(`vendor/dsh-runtime/${version}`)}\tresolutions=${resolutions}\tlockReferences=${lockReferences}\tpatches=${patches}`)
}
NODE
git grep -l -E 'vendor/dsh-runtime/(0\.1\.7-alpha\.2|0\.1\.7-rc\.1|0\.1\.7-rc\.2|0\.2\.0-rc\.1|0\.2\.0-rc\.2|0\.2\.1-alpha\.1)' -- ':!docs' ':!dsh-plugin-desktop' ':!dsh-plugin-desktop-beta' ':!dsh-desktop-next' ':!vendor' ':!yarn.lock' ':!package.json' ':!AGENTS.md'
```

把实际输出写入证据。当前计划的实测基线（按本任务脚本的 `lockText.split(...)` 口径）是：

| lane | resolutions | lock 引用 | patches | 处置 |
| --- | ---: | ---: | ---: | --- |
| `0.1.5-rc.2` | 0 | 0 | 12 | 无 vendor/resolution/lock 消费；删 patch |
| `0.1.7-alpha.2` | 0 | 0 | 18 | 删 vendor/patch |
| `0.1.7-rc.1` | 0 | 0 | 19 | 删 vendor/patch |
| `0.1.7-rc.2` | 0 | 0 | 21 | 删 vendor/patch |
| `0.2.0-rc.1` | 0 | 0 | 21 | 删 vendor/patch |
| `0.2.0-rc.2` | 636 | 900 | 22 | **仍有消费面**；Task 10 `--write` + `yarn install` 清 resolutions/lock，Task 11 才删 vendor/patch |
| `0.2.1-alpha.1` | 642 | 0 | 21 | dormant peer lane；Task 10 清 resolutions，Task 11 删资产 |
| `0.2.1-rc.1` | 682 | 966 | 22 | 活跃 lane，保留 |

`grep -c` 的行数口径会小于 split 口径（rc.2 为 600、rc.1 为 644），但都证明 rc.2 的 lock 引用非零。不得把“rc.2 无消费方”写进证据；`stableHistorical: retain` 只保留 peer 腿，不等于保留 Stable vendor runtime。

- [ ] **Step 2: 向用户提交两个独立政策问题并等待明确回答**

推荐并说明证据：
- `stableHistorical: "retain"`：Stable 的 `desktop-market.ts`、`desktop-plugins.ts` 和 profile 有真实 Community Market 加载先例；无法从删除源码推断历史安装实例不存在，保留腿不要求保留 Stable vendor runtime。
- `dormantAlpha1: "retire"`：Next 已迁到 rc.1，alpha.1 无 lock 消费且只是 dormant lane；退役 peer 腿与删除无消费方资产一致。

本计划的默认最终 range 是 `0.2.0-rc.2 || 0.2.1-rc.1`。**必须得到用户对两个字段的明确回答后才继续；若回答不同，先修改 Task 10 的精确 JSON、四种政策测试的预期、market contract 断言和 Task 15 的结构验收值，不得静默改政策。**

- [ ] **Step 3: 记录裁定和删除边界并提交**

证据必须列出两个字段的精确值、用户裁定日期、市场加载证据、各 lane 计数、允许删除的 vendor/patch 版本集合，以及“Stable peer 历史腿不等于 Stable runtime 消费方”的边界。各 lane 计数必须来自 Step 1 的实际输出（包含 `0.2.0-rc.2` 的 636 resolutions / 900 lock 引用和 `0.2.1-alpha.1` 的 642 resolutions），并注明 Task 10 `--write` + `yarn install` 清理 resolutions/lock 后 Task 11 才删除资产。此任务不得运行 `sync-vendored-runtime.mjs --write`，不得删除通道或目录。

```bash
git add docs/evidence/2026-10-29-single-desktop-runtime-consumers.md
git commit -m "docs: rule on market peer history and runtime consumers"
```

---

### Task 10: 显式 peer 政策、单通道元数据与 lockfile 重解

**Files:**
- Modify: `scripts/vendored-runtime-policy.mjs`
- Modify: `scripts/vendored-runtime-policy.test.mjs`
- Modify: `scripts/sync-vendored-runtime.mjs:21-38`
- Modify: `upstream.json`
- Modify: `dsh-community-market/package.json`
- Modify: `dsh-community-market/tests/contracts.spec.ts:31-64`
- Modify: `dsh-plugin-huaanwork/tests/package.spec.ts:86-90,419-450`
- Modify: `package.json`
- Modify: `yarn.lock`

**Interfaces:**
- Consumes: Task 9 的默认裁定 `stableHistorical: "retain"`、`dormantAlpha1: "retire"`；Task 4 同名纯函数。
- Produces: `marketPeerRange(document)` 只从 active HuaAnWork + 显式政策构造；`upstream.json.channels` 只有 huaanwork；最终 peer 为 `0.2.0-rc.2 || 0.2.1-rc.1`。

- [ ] **Step 1: 写四种政策和真实 manifest 失败测试**

`vendored-runtime-policy.test.mjs` 改为使用合成配置覆盖四种组合，并保留真实文件断言：

```js
function policyDocument(stableHistorical, dormantAlpha1) {
  return {
    activeChannel: 'huaanwork',
    marketPeerPolicy: { stableHistorical, dormantAlpha1 },
    channels: { huaanwork: { sourceVersion: '0.2.1-rc.1' } },
  }
}

test('constructs the peer range only from HuaAnWork and explicit historical policy', () => {
  assert.equal(marketPeerRange(policyDocument('retain', 'retain')), '0.2.0-rc.2 || 0.2.1-rc.1 || 0.2.1-alpha.1')
  assert.equal(marketPeerRange(policyDocument('retain', 'retire')), '0.2.0-rc.2 || 0.2.1-rc.1')
  assert.equal(marketPeerRange(policyDocument('retire', 'retain')), '0.2.1-rc.1 || 0.2.1-alpha.1')
  assert.equal(marketPeerRange(policyDocument('retire', 'retire')), '0.2.1-rc.1')
  assert.throws(() => marketPeerRange(policyDocument('unknown', 'retire')), /marketPeerPolicy/u)
  assert.throws(() => marketPeerRange({ activeChannel: 'huaanwork', channels: {} }), /HuaAnWork/u)
})

test('the real metadata has only HuaAnWork and the ruled peer policy', () => {
  const document = JSON.parse(readFileSync(new URL('../upstream.json', import.meta.url), 'utf8'))
  assert.deepEqual(Object.keys(document.channels), ['huaanwork'])
  assert.deepEqual(document.marketPeerPolicy, { stableHistorical: 'retain', dormantAlpha1: 'retire' })
  assert.equal(ownsMarketRuntime(document.activeChannel), true)
  assert.equal(marketPeerRange(document), '0.2.0-rc.2 || 0.2.1-rc.1')
})
```

`contracts.spec.ts` 从 `../../upstream.json` 读取显式政策并构造 `expectedPeerRange`，遍历所有 `@deepseek-ai/dsh*` peer 都等于该值；默认裁定下精确为 `0.2.0-rc.2 || 0.2.1-rc.1`。删除三腿硬编码：

```ts
const manifest = readJson('../package.json') as {
  dsh?: { client?: { inject?: string[] } }
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
}
const upstream = readJson('../../upstream.json') as {
  activeChannel: 'huaanwork'
  marketPeerPolicy: { stableHistorical: 'retain' | 'retire'; dormantAlpha1: 'retain' | 'retire' }
  channels: { huaanwork: { sourceVersion: string } }
}
const expectedPeerRange = [
  ...(upstream.marketPeerPolicy.stableHistorical === 'retain' ? ['0.2.0-rc.2'] : []),
  upstream.channels.huaanwork.sourceVersion,
  ...(upstream.marketPeerPolicy.dormantAlpha1 === 'retain' ? ['0.2.1-alpha.1'] : []),
].join(' || ')
const dshPeers = Object.entries(manifest.peerDependencies ?? {})
  .filter(([name]) => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-'))
expect(dshPeers.length).toBeGreaterThan(0)
for (const [name, range] of dshPeers) expect(range, name).toBe(expectedPeerRange)
```

把这段放在 `package integration contract` describe 顶部，并删除两个原有测试内的局部 `manifest` 声明；`expectedPeerRange` 在 describe 作用域只计算一次。

`package.spec.ts` 删除 `stableRuntimeVersion` 和 stable/beta/alpha.1 分区测试，改为：

```ts
it('resolves every DSH package only through the active HuaAnWork runtime', () => {
  const dshResolutions = Object.entries(workspaceManifest.resolutions ?? {})
    .filter(([selector]) => /^@deepseek-ai\/dsh(?:@|-)/u.test(selector))
  expect(dshResolutions.length).toBeGreaterThan(0)
  for (const [selector, resolution] of dshResolutions) {
    expect([runtimeVersion, `^${runtimeVersion}`], selector)
      .toContain(selector.split('@npm:')[1])
    expect(String(resolution), selector).toContain(`vendor/dsh-runtime/${runtimeVersion}/`)
  }
})
```

- [ ] **Step 2: 运行并确认失败**

```bash
node --test scripts/vendored-runtime-policy.test.mjs
corepack yarn workspace dsh-community-market vitest run tests/contracts.spec.ts
corepack yarn workspace dsh-plugin-huaanwork vitest run tests/package.spec.ts
```

Expected: FAIL；真实配置仍含三通道，政策函数仍从 Stable/Beta 推导。

- [ ] **Step 3: 实现显式政策并先改元数据**

`vendored-runtime-policy.mjs` 保留 `ownsMarketRuntime`，将 `marketPeerRange` 改为：

```js
export function marketPeerRange(upstreamDocument) {
  const active = upstreamDocument.channels?.[upstreamDocument.activeChannel]?.sourceVersion
  if (upstreamDocument.activeChannel !== 'huaanwork' || typeof active !== 'string' || active.length === 0) {
    throw new Error('HuaAnWork active sourceVersion is required')
  }
  const policy = upstreamDocument.marketPeerPolicy
  for (const field of ['stableHistorical', 'dormantAlpha1']) {
    if (!['retain', 'retire'].includes(policy?.[field])) {
      throw new Error(`marketPeerPolicy.${field} must be retain or retire`)
    }
  }
  return [...new Set([
    ...(policy.stableHistorical === 'retain' ? ['0.2.0-rc.2'] : []),
    active,
    ...(policy.dormantAlpha1 === 'retain' ? ['0.2.1-alpha.1'] : []),
  ])].join(' || ')
}
```

`upstream.json` 精确保留 `repository`、`activeChannel: "huaanwork"`、上述 `marketPeerPolicy` 和 huaanwork channel；删除 stable/beta channel。`sync-vendored-runtime.mjs` usage 和 channel 白名单只接受 huaanwork。

- [ ] **Step 4: 在裁定完成后才运行 write，并由 Yarn 重解 lockfile**

```bash
node scripts/sync-vendored-runtime.mjs --write --channel huaanwork
corepack yarn install
```

Expected: 使用现有 rc.1 vendor manifest，不重建或推进 Harness；根 DSH resolutions 只剩 rc.1，market peers 按政策更新，HuaAnWork manifest 的 DSH 版本不变。不得手工修改 lockfile。

- [ ] **Step 5: 验证 market、AA、HuaAnWork 闭包**

```bash
node --test scripts/vendored-runtime-policy.test.mjs
corepack yarn workspace dsh-community-market vitest run tests/contracts.spec.ts
corepack yarn workspace dsh-plugin-huaanwork vitest run tests/package.spec.ts
corepack yarn check:vendored-runtime
corepack yarn aa:check
corepack yarn install --immutable
node scripts/verify-layout.mjs
```

Expected: 全部 PASS；无 `undefined`、空腿或 ` || 0.2.1-alpha.1` 形式的 range。

- [ ] **Step 6: Commit**

```bash
git add scripts/vendored-runtime-policy.mjs scripts/vendored-runtime-policy.test.mjs scripts/sync-vendored-runtime.mjs upstream.json dsh-community-market/package.json dsh-community-market/tests/contracts.spec.ts dsh-plugin-huaanwork/tests/package.spec.ts dsh-plugin-huaanwork/package.json package.json yarn.lock
git commit -m "refactor(runtime): make market peer history an explicit policy"
```

---

### Task 11: 删除已证明无消费方的 runtime 资产

**Files:**
- Modify: `dsh-plugin-huaanwork/tests/package.spec.ts`
- Modify: `docs/evidence/2026-10-29-single-desktop-runtime-consumers.md`
- Delete: `vendor/dsh-runtime/0.1.7-alpha.2/`
- Delete: `vendor/dsh-runtime/0.1.7-rc.1/`
- Delete: `vendor/dsh-runtime/0.1.7-rc.2/`
- Delete: `vendor/dsh-runtime/0.2.0-rc.1/`
- Delete: `vendor/dsh-runtime/0.2.0-rc.2/`
- Delete: `vendor/dsh-runtime/0.2.1-alpha.1/`
- Delete: `patches/*@{0.1.5-rc.2,0.1.7-alpha.2,0.1.7-rc.1,0.1.7-rc.2,0.2.0-rc.1,0.2.0-rc.2,0.2.1-alpha.1}.patch`

**Interfaces:**
- Consumes: Task 10 已只含 rc.1 的 resolutions/lockfile 和 Task 9 的消费方证据。
- Produces: `vendor/dsh-runtime/` 只有 `0.2.1-rc.1`；DSH patches 只有 `0.2.1-rc.1`；非 DSH patches 不动。

- [ ] **Step 1: 写资产消失失败测试**

`package.spec.ts` 从 `node:fs` 增 import `readdirSync`，加入：

```ts
it('keeps only the active DSH runtime vendor lane and patch family', () => {
  expect(readdirSync(new URL('vendor/dsh-runtime', workspaceRoot))).toEqual([runtimeVersion])
  const dshPatchVersions = readdirSync(new URL('patches', workspaceRoot))
    .filter(name => name.startsWith('dsh'))
    .map(name => name.match(/@([^@]+)\.patch$/u)?.[1])
  expect(new Set(dshPatchVersions)).toEqual(new Set([runtimeVersion]))
})
```

Run: `corepack yarn workspace dsh-plugin-huaanwork vitest run tests/package.spec.ts`
Expected: FAIL，六个旧 vendor lane 和七组旧 patches 仍存在。

- [ ] **Step 2: 按已记录版本精确删除**

```bash
git rm -r vendor/dsh-runtime/0.1.7-alpha.2 vendor/dsh-runtime/0.1.7-rc.1 vendor/dsh-runtime/0.1.7-rc.2 vendor/dsh-runtime/0.2.0-rc.1 vendor/dsh-runtime/0.2.0-rc.2 vendor/dsh-runtime/0.2.1-alpha.1
for version in 0.1.5-rc.2 0.1.7-alpha.2 0.1.7-rc.1 0.1.7-rc.2 0.2.0-rc.1 0.2.0-rc.2 0.2.1-alpha.1; do
  git rm patches/*@"$version".patch
done
```

不得删除 `.yarn/patches/dshmarket-desktop.patch`、`open`、`pnpm` 或其他非 DSH patch；不得删除旧 AA artifact。

- [ ] **Step 3: 复核消费方、更新证据并验证**

把实际删除目录、patch 数量、保留 lane 和 `git grep` 复核结果追加到 runtime-consumers 证据。

```bash
corepack yarn workspace dsh-plugin-huaanwork vitest run tests/package.spec.ts
corepack yarn check:vendored-runtime
corepack yarn aa:check
corepack yarn install --immutable
find vendor/dsh-runtime -mindepth 1 -maxdepth 1 -type d -print
```

Expected: 全部 PASS；find 只输出 `vendor/dsh-runtime/0.2.1-rc.1`。

- [ ] **Step 4: Commit**

```bash
git add dsh-plugin-huaanwork/tests/package.spec.ts docs/evidence/2026-10-29-single-desktop-runtime-consumers.md
git commit -m "chore(runtime): remove unused vendored runtime lanes"
```

---

### Task 12: selective upstream 配置与 hermetic dashboard

**Files:**
- Create: `desktop-upstream.json`
- Modify: `scripts/upstream-sync-dashboard.mjs`
- Rename: `scripts/upstream-sync-dashboard.reference.mjs` → `scripts/upstream-sync-dashboard.test.mjs`
- Modify: `scripts/upstream-sync-dashboard.test.mjs`
- Modify: `scripts/active-topology.test.mjs`
- Modify: `docs/upstream-sync.md:1-132`

**Interfaces:**
- Consumes: 现有 outer `upstream` remote；不再使用 `PAIRS`、merge-base 或参考目录磁盘扫描。
- Produces: `collectUpstreamReview({ root, upstreamRef, configPath })`、`formatDashboard(result)`；成功结果含 `ok/asOf/repository/ref/upstreamSha/upstreamCommitDate/reviewedCommit/sourcePackage/pendingCount/commits`，每个 commit 含 `sha/date/subject/files:{watched,unwatched}`。

- [ ] **Step 1: 重算并证明初始 reviewedCommit**

```bash
node --input-type=module <<'NODE'
import { execFileSync } from 'node:child_process'
const git = args => execFileSync('git', args, { encoding: 'utf8' }).trim()
let found
for (const line of git(['rev-list', '--merges', '--parents', 'HEAD']).split('\n')) {
  const [, ...parents] = line.split(' ')
  for (const parent of parents.slice(1)) {
    try {
      execFileSync('git', ['merge-base', '--is-ancestor', parent, 'upstream/master'], { stdio: 'ignore' })
      found = parent
      break
    } catch { /* This second parent is not an upstream commit. */ }
  }
  if (found) break
}
if (!found) throw new Error('No full outer-upstream merge found in HEAD')
console.log(git(['show', '-s', '--format=%H %cI %s', found]))
NODE
```

Expected 当前基线输出 `44084bdae0d44cac56948a223048d9c31541d0d0`。它是最后完整合并的 upstream SHA，不是最新 tip。若基线变化导致结果不同，以实际计算值创建配置，并重新实测首期货架。

- [ ] **Step 2: 写 hermetic 失败测试**

将旧 reference 测试改名回 `.test.mjs` 后完全替换。以下 helper 只使用临时 Git 仓库，不访问网络、不创建任何参考桌面目录；它生成两个普通待审提交、一个空 side 提交和一个零 direct-file merge 容器：

```js
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { test } from 'node:test'
import { collectUpstreamReview, formatDashboard } from './upstream-sync-dashboard.mjs'

const REPOSITORY = 'https://github.com/anywhere-labs/dsh-desktop.git'
function writeConfig(root, reviewedCommit, path = 'desktop-upstream.json') {
  writeFileSync(isAbsolute(path) ? path : join(root, path), `${JSON.stringify({
    schemaVersion: 1,
    repository: REPOSITORY,
    ref: 'upstream/master',
    reviewedCommit,
    sourcePackage: 'dsh-plugin-desktop-beta',
    watchedPaths: ['scripts/'],
  }, null, 2)}\n`)
}

function dashboardFixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'single-desktop-upstream-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
  const write = (path, text) => {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  const commit = (path, text, subject) => {
    write(path, text)
    git(['add', path])
    git(['commit', '-m', subject])
  }
  git(['init', '-b', 'master'])
  git(['config', 'user.name', 'Dashboard Test'])
  git(['config', 'user.email', 'dashboard@example.invalid'])
  git(['remote', 'add', 'upstream', REPOSITORY])
  commit('README.md', 'base\n', 'base')
  const reviewedCommit = git(['rev-parse', 'HEAD'])
  writeConfig(root, reviewedCommit)
  git(['checkout', '-b', 'side', reviewedCommit])
  git(['commit', '--allow-empty', '-m', 'side'])
  git(['checkout', 'master'])
  commit('scripts/change.mjs', 'export const value = 1\n', 'watched change')
  commit('docs/note.md', 'note\n', 'unwatched change')
  git(['merge', '--no-ff', 'side', '-m', 'merge container'])
  const tip = git(['rev-parse', 'HEAD'])
  git(['update-ref', 'refs/remotes/upstream/master', tip])
  return { root, git, reviewedCommit, tip }
}

test('reports every pending commit and classifies every direct file exactly once', t => {
  const { root, reviewedCommit, tip } = dashboardFixture(t)
  const result = collectUpstreamReview({ root })
  assert.equal(result.ok, true, result.error)
  assert.equal(result.reviewedCommit, reviewedCommit)
  assert.equal(result.upstreamSha, tip)
  assert.equal(result.pendingCount, 4)
  assert.match(result.asOf, /^\d{4}-\d{2}-\d{2}T/u)
  const commits = new Map(result.commits.map(commit => [commit.subject, commit]))
  assert.deepEqual(commits.get('watched change').files, { watched: ['scripts/change.mjs'], unwatched: [] })
  assert.deepEqual(commits.get('unwatched change').files, { watched: [], unwatched: ['docs/note.md'] })
  assert.deepEqual(commits.get('side').files, { watched: [], unwatched: [] })
  assert.deepEqual(commits.get('merge container').files, { watched: [], unwatched: [] })
  assert.equal('mergeBase' in result, false)
  assert.equal('overlap' in result, false)
})

test('fails loudly for a missing ref, config, or non-ancestor reviewedCommit', t => {
  const { root, git } = dashboardFixture(t)
  assert.match(collectUpstreamReview({ root, upstreamRef: 'upstream/missing' }).error, /docs\/upstream-sync\.md/u)
  const empty = mkdtempSync(join(tmpdir(), 'single-desktop-no-config-'))
  t.after(() => rmSync(empty, { recursive: true, force: true }))
  assert.match(collectUpstreamReview({ root: empty }).error, /desktop-upstream\.json/u)
  const tree = git(['rev-parse', 'HEAD^{tree}'])
  const unrelated = git(['commit-tree', tree, '-m', 'unrelated'])
  const configPath = join(root, 'unrelated.json')
  writeConfig(root, unrelated, configPath)
  assert.match(collectUpstreamReview({ root, configPath }).error, /ancestor/u)
})

test('formats full SHAs and does not truncate files or require reference trees', t => {
  const { root, reviewedCommit, tip } = dashboardFixture(t)
  const text = formatDashboard(collectUpstreamReview({ root }))
  assert.match(text, new RegExp(reviewedCommit))
  assert.match(text, new RegExp(tip))
  assert.match(text, /scripts\/change\.mjs/u)
  assert.match(text, /docs\/note\.md/u)
})
```

同时把 `active-topology.test.mjs` 的 Phase A 退役清单缩回 variant/icons/inspector 三项，并增加 `assert.equal(tests.includes('upstream-sync-dashboard.test.mjs'), true)`，明确新 dashboard 测试重新进入根 glob。

Run: `node --test scripts/active-topology.test.mjs scripts/upstream-sync-dashboard.test.mjs`
Expected: FAIL，`collectUpstreamReview` 尚不存在。

- [ ] **Step 3: 创建初始配置**

```json
{
  "schemaVersion": 1,
  "repository": "https://github.com/anywhere-labs/dsh-desktop.git",
  "ref": "upstream/master",
  "reviewedCommit": "44084bdae0d44cac56948a223048d9c31541d0d0",
  "sourcePackage": "dsh-plugin-desktop-beta",
  "watchedPaths": [
    "package.json",
    "yarn.lock",
    "upstream.json",
    ".yarnrc.yml",
    ".yarn/",
    ".gitmodules",
    ".gitignore",
    ".github/",
    "scripts/",
    "patches/",
    "vendor/",
    "assets/",
    "deepseek-harness",
    "dsh-community-market/",
    "dsh-community-fabric/",
    "dsh-plugin-desktop/",
    "dsh-plugin-desktop-beta/",
    "dsh-desktop-next/"
  ]
}
```

- [ ] **Step 4: 完整替换 dashboard 实现**

实现必须遵守以下算法，不保留旧 Scope A/B/C。文件顶部使用：

```js
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = resolve(import.meta.dirname, '..')
```

算法：
1. 读取并校验 `desktop-upstream.json`；缺文件、字段或非法 SHA 返回 `{ok:false,error}`。
2. 验证 `git remote get-url upstream` 等于配置仓库，验证 `upstreamRef` 和 reviewedCommit 都是 commit；错误指向 `docs/upstream-sync.md`。
3. 用 `git merge-base --is-ancestor reviewedCommit upstreamSha` 验证基线祖先关系；失败不得输出零。
4. 用 `git rev-list --reverse --topo-order reviewedCommit..upstreamSha` 枚举全部待审提交。
5. 每个提交用 `git show -s --format=%cI%x00%s` 读日期/主题，用 `git diff-tree --no-commit-id --name-only -r --root <sha>` 读 direct files；merge 不用 `-m`，因此不重复子提交文件。
6. 目录型 watchedPath 以 `/` 结尾并匹配前缀，文件型精确匹配；每个 direct file 只进入 `watched` 或 `unwatched` 一边。
7. 文本和 `--json` 都输出全部提交/文件、as-of 和完整 SHA；不得接进 package.json scripts 或 gate。

核心分类代码：

```js
export function collectUpstreamReview({ root = repoRoot, upstreamRef, configPath } = {}) {
  let config
  try {
    config = JSON.parse(readFileSync(configPath ?? join(root, 'desktop-upstream.json'), 'utf8'))
    if (config.schemaVersion !== 1 || typeof config.repository !== 'string'
      || typeof config.ref !== 'string' || !/^[0-9a-f]{40}$/u.test(config.reviewedCommit)
      || typeof config.sourcePackage !== 'string' || !Array.isArray(config.watchedPaths)
      || config.watchedPaths.length === 0 || config.watchedPaths.some(path => typeof path !== 'string' || path.length === 0)) {
      throw new Error('invalid desktop-upstream.json schema')
    }
  } catch (error) {
    return { ok: false, error: `cannot load desktop-upstream.json: ${String(error)}; see docs/upstream-sync.md` }
  }
  const ref = upstreamRef ?? config.ref
  const git = args => execFileSync('git', args, {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
  let upstreamSha
  try {
    if (git(['remote', 'get-url', 'upstream']) !== config.repository) throw new Error('upstream remote URL differs from desktop-upstream.json')
    upstreamSha = git(['rev-parse', '--verify', `${ref}^{commit}`])
    git(['rev-parse', '--verify', `${config.reviewedCommit}^{commit}`])
    execFileSync('git', ['merge-base', '--is-ancestor', config.reviewedCommit, upstreamSha], { cwd: root, stdio: 'ignore' })
  } catch (error) {
    return { ok: false, error: `upstream ref is unavailable, or reviewedCommit is not an ancestor: ${String(error)}; see docs/upstream-sync.md` }
  }
  const lines = value => value ? value.split('\n').filter(Boolean) : []
  const shas = lines(git(['rev-list', '--reverse', '--topo-order', `${config.reviewedCommit}..${upstreamSha}`]))
  const isWatched = file => config.watchedPaths.some(path => path.endsWith('/') ? file.startsWith(path) : file === path)
  const commits = shas.map(sha => {
    const [date, subject] = git(['show', '-s', '--format=%cI%x00%s', sha]).split('\0')
    const files = lines(git(['diff-tree', '--no-commit-id', '--name-only', '-r', '--root', sha]))
    return {
      sha, date, subject,
      files: {
        watched: files.filter(isWatched),
        unwatched: files.filter(file => !isWatched(file)),
      },
    }
  })
  return {
    ok: true,
    asOf: new Date().toISOString(),
    repository: config.repository,
    ref,
    upstreamSha,
    upstreamCommitDate: git(['show', '-s', '--format=%cI', upstreamSha]),
    reviewedCommit: config.reviewedCommit,
    sourcePackage: config.sourcePackage,
    pendingCount: commits.length,
    commits,
  }
}
```

`formatDashboard` 和 CLI 使用以下完整形态；输出不截断：

```js
export function formatDashboard(result) {
  if (!result.ok) return `upstream-sync-dashboard: error: ${result.error}\n`
  const lines = [
    `upstream-sync-dashboard: as-of ${result.asOf} / upstream commit ${result.upstreamCommitDate}`,
    `  ref      = ${result.ref} @ ${result.upstreamSha}`,
    `  reviewed = ${result.reviewedCommit}`,
    `  source   = ${result.sourcePackage}`,
    `  pending  = ${String(result.pendingCount)} commits`,
  ]
  for (const commit of result.commits) {
    lines.push(`  ${commit.sha} ${commit.date} ${commit.subject}`)
    for (const file of commit.files.watched) lines.push(`    watched: ${file}`)
    for (const file of commit.files.unwatched) lines.push(`    unwatched: ${file}`)
    if (commit.files.watched.length + commit.files.unwatched.length === 0) lines.push('    (zero direct files)')
  }
  lines.push('  note: read-only; not a gate. Re-run after git fetch upstream and record as-of plus full SHAs.')
  return `${lines.join('\n')}\n`
}

const isDirectExecution = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (isDirectExecution) {
  const args = process.argv.slice(2)
  if (args.some(arg => arg !== '--json') || args.length > 1) throw new Error('usage: node scripts/upstream-sync-dashboard.mjs [--json]')
  const result = collectUpstreamReview({ root: repoRoot })
  if (!result.ok) {
    process.stderr.write(formatDashboard(result))
    process.exit(1)
  }
  process.stdout.write(args.includes('--json') ? `${JSON.stringify(result, null, 2)}\n` : formatDashboard(result))
}
```

- [ ] **Step 5: 跑 hermetic 与真实货架测试，改写同步文档**

```bash
node --test scripts/active-topology.test.mjs scripts/upstream-sync-dashboard.test.mjs
node scripts/upstream-sync-dashboard.mjs --json > /tmp/single-desktop-upstream-report.json
node --input-type=module <<'NODE'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
const report = JSON.parse(readFileSync('/tmp/single-desktop-upstream-report.json', 'utf8'))
const direct = Number(execFileSync('git', ['rev-list', '--count', `${report.reviewedCommit}..${report.upstreamSha}`], { encoding: 'utf8' }).trim())
if (report.pendingCount !== direct) throw new Error(`pending ${report.pendingCount} != ${direct}`)
console.log(`verified pendingCount=${direct} at ${report.upstreamSha}`)
NODE
```

Expected 当前 pinned ref 为 56。`docs/upstream-sync.md` §§1-7 改为 selective 模型：reviewedCommit 语义、remote 设置、as-of/full SHA、逐提交/逐文件处置、整批完成才推进、Harness pin 独立；明确“三包机器同形核对已经消失，watchedPaths + 证据只提供覆盖与分诊，不验证移植完整性或等价性，不得误补三包守卫”。**§6 的永久 Fork-Owned Override 清单同步退役/重写**：删除 `verify-desktop-variants.mjs` 与 Stable/Beta `package.spec.ts` 条目；保留仍有消费方的 `expected-root-gate-scripts.json`、`market-manifest-byte-budget.json` 等条目；§8 及之后历史快照原样保留，允许出现旧文件名但必须标注为历史。检查：`rg -n 'verify-desktop-variants|dsh-plugin-desktop/tests/package.spec.ts|dsh-plugin-desktop-beta/tests/package.spec.ts' docs/upstream-sync.md` 的命中只允许在 §8 之后；§1-7 不得再引用已删除文件。

- [ ] **Step 6: Commit**

```bash
git add desktop-upstream.json scripts/upstream-sync-dashboard.mjs scripts/upstream-sync-dashboard.test.mjs scripts/upstream-sync-dashboard.reference.mjs scripts/active-topology.test.mjs docs/upstream-sync.md
git commit -m "feat(upstream): report the selective review backlog"
```

---

### Task 13: 首期 56 提交逐文件处置并推进 reviewedCommit

**Files:**
- Create: `docs/evidence/2026-10-29-single-desktop-upstream-shelf.md`
- Modify: `desktop-upstream.json`
- Modify: `docs/upstream-sync.md`

**Interfaces:**
- Consumes: Task 12 的 `collectUpstreamReview`；固定货架 `44084bdae0d44cac56948a223048d9c31541d0d0..092e2ecef750d10db43cedbab8e81fd48c8de38e`。
- Produces: 56 个提交及每个 direct file 的 `SKIP` / `ALREADY` 证据；无 `PORT`；`reviewedCommit` 推进到 `092e2ecef750d10db43cedbab8e81fd48c8de38e`。

- [ ] **Step 1: 用完整裁定表生成逐文件证据**

以下命令的 commit-default 覆盖该提交每个 direct file；`FILE_OVERRIDES` 只覆盖明确已有等价/更新实现的文件。`7b3cddd2fe` 的 sidebar-browser 行为修复因本计划禁止产品行为变化而明确 SKIP，并转入既有 2.1 功能对齐债，不得夹带移植。运行命令生成完整逐文件 Markdown：

```bash
node --input-type=module <<'NODE'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { collectUpstreamReview } from './scripts/upstream-sync-dashboard.mjs'

const BASE = '44084bdae0d44cac56948a223048d9c31541d0d0'
const TIP = '092e2ecef750d10db43cedbab8e81fd48c8de38e'
const RULINGS = {
  c756ae722973dc4032026cdbfc80284000519a14: ['SKIP', 'rc.2 runtime train；Harness pin 和 runtime 更新不属于本维护计划'],
  e19f7cfa896a028a14147c5d8d044e9ad985f948: ['SKIP', 'rc.2 适配和旧产品树；fork 保持 rc.1'],
  '3c0bb5aabb2b51981deeda4751a8100640cb7702': ['SKIP', 'merge 容器；子提交已独立裁定'],
  a5ef6494ad1e90e59c8d170aa2c1744e1b3a8f5a: ['SKIP', 'Stable/Beta/Next 版本发布变更，不映射 HuaAnWork 版本'],
  '54779f32b93080328deafc73db93d570d7671e0b': ['SKIP', 'merge 容器；子提交已独立裁定'],
  '153f0df03478857d82e89cef0dd1b286e4ab74e1': ['SKIP', 'Next 市场 UI 功能，非维护范围'],
  '28fa181ec61b5d2f064130ba8fa3a2bdf534b011': ['SKIP', 'merge 容器；子提交已独立裁定'],
  '7b3cddd2fe4a403528f357f65b07832cb279ea9d': ['SKIP', '跨 Profile 默认启用 browser 属产品行为变化；登记到既有 2.1 功能对齐债，本计划不移植'],
  '796e92bfb3ed4189a27bde2f348834fe2cf629f9': ['SKIP', 'merge 容器；子提交已独立裁定'],
  '23257966a4d450721cc9c204c9a88c5d23d6f304': ['SKIP', 'plugin controls/HMR 功能对齐波次，HuaAnWork 有自己的市场 UI'],
  d9c40826ad36dd4db13a836cc0b45b31361f4b5e: ['SKIP', 'merge 容器；子提交已独立裁定'],
  cc521f959dc416c1844aebefeabc7cc24b6aa867: ['SKIP', 'Stable/Beta/Next 市场 UI 文案与布局功能'],
  '3e6fc93fd5f438f622770005104b84d708a2d089': ['SKIP', 'merge 容器；子提交已独立裁定'],
  '6c223c2c0441b344b981ed9bce04d7bb1e542add': ['SKIP', 'official market onboarding 功能；HuaAnWork 市场联合类型和向导不同'],
  c0b4250d9ef41179e4f347dd56830acb2be101df: ['SKIP', 'merge 容器；子提交已独立裁定'],
  '05dfeef22d985824d0d5a82cd10c1cdb4dfa7a46': ['SKIP', 'plugin-controls 是参考产品 UI，HuaAnWork 无该组件'],
  d5589338a7850b4cfac2c7d5773deb6161deb897: ['SKIP', 'merge 容器；子提交已独立裁定'],
  '4096f20bf981f253b36f2c40f3706bd870645546': ['SKIP', 'Next drag region 与 rc.2 patch 组合，不适用当前 HuaAnWork'],
  f35893965c12a209f46408a376759850ff128bbd: ['SKIP', 'merge 容器；子提交已独立裁定'],
  cd11e12395ff776653fd5c175688e5c8fe420049: ['SKIP', 'Stable 向 Next 过渡及更新协议变化，HuaAnWork 协议保持不变'],
  '4122ef3457c77a62a1d5e05632b077ade8a2bdce': ['SKIP', 'Next 文档翻译'],
  '65321d32a3409e3d02e41eadce21b5f69c85a1ff': ['SKIP', 'merge 容器；子提交已独立裁定'],
  '6a63b9730b82cf4e858b9a11ac9783da9a5a0c3a': ['SKIP', '旧 AA artifact/测试覆盖变化；fork 已有 Schemastery 支持且 AA artifact 更新'],
  a859a4791f8b86355f956746841e83b6dbd3d65a: ['SKIP', '上游团队介绍链接，不属于单桌面维护'],
  a5c914ce0aee4e80eed77ae1856dab7e642fd10e: ['SKIP', 'merge 容器；子提交已独立裁定'],
  ebaa739d5f4d363d9b7ba3fa66871cc26a22fd0d: ['SKIP', 'Next renderer recovery 功能与旧 AA pin；HuaAnWork 保持现有恢复行为'],
  '16d4d97ba6fc02a6526dbcc57036fbd9cbb7f1a9': ['SKIP', '旧 AA artifact 重钉；fork 已吸收 connector 修复且使用更新 artifact'],
  dc44bf0091e1b8b2f4cc1cdea832d0d5f44414a6: ['SKIP', 'Next renderer health 功能，非 HuaAnWork 维护范围'],
  '1d40b5724a4f7bb5fc05b87fe384f02cfa67b2e5': ['SKIP', 'Next 设置导航滚动 UI 功能'],
  e8fda1919ece81d63fc23581339870341ce79d79: ['SKIP', 'Next pre-Host onboarding 功能'],
  '580984e920f364b5d9b3b3063925cc7e29cb9c0b': ['SKIP', 'dshmarket 1.66.45 patch 适配；fork 已有 1.70.2 的更新适配'],
  '2f6e721d475910a26665397616fd3798adc5d0fb': ['SKIP', '上游 CI 硬化不整批移植；safe-mode Windows 清理测试修复登记为后续独立测试任务'],
  '0cf20e6ebf5e0ab20daa1a9ece7eb63c1172930e': ['SKIP', 'Linux 与 rc.2 office runtime 打包；HuaAnWork 无 Linux 线且保持 rc.1'],
  eef3a8873ef057d5bd5c5f04a60c2e00a979e33d: ['SKIP', '上游 CI 性能优化，不是单桌面正确性维护；本计划独立收窄 CI'],
  '6f987d94d6cfc86fc6e20c814f1c6e0fa0551879': ['SKIP', 'Next 设置 UI 功能'],
  '779968651e705fd81aef984ac8852fc081110ebb': ['SKIP', 'rc.2 hotfix 批次；Electron 44.7.0 工具链升级另案评估，本计划保持 rc.1 和现有产品行为'],
  '0f72133c150dc7a0ae673558703ea4e6b3dc18e3': ['SKIP', 'Next pre-Host onboarding UI 功能'],
  f6271d7bf7710cdd6291fa5f37ea01d91e1ac9a8: ['SKIP', 'Next 启动性能优化，未证明适用于 HuaAnWork 当前架构'],
  '9caca3f6219218e5bf270ba87c478e226b688995': ['SKIP', 'Next recovery bundle 依赖和 toggle UI 行为变化'],
  '271cc526e493a2e0fb427671cc44644ad5d32508': ['SKIP', 'rc.2 依赖批次不移植；Windows EACCES retry 与 hide-before-destroy 是后续独立行为修复候选'],
  '62723fdc43710f44ef9b804b44f57cc0c5c308c7': ['SKIP', 'Next staged update shutdown 行为，HuaAnWork 更新协议不变'],
  '88b9bbdbe7f2bc9012336912c55436adec08ed92': ['SKIP', 'Next Linux 更新 UI；HuaAnWork 无 Linux 发行线'],
  '584fb4909352d744be6b0f020db9151126796f4e': ['SKIP', 'Next sidebar footer 与布局设置功能'],
  '06446375d9e2b6fcbe468a902d45696893de26fd': ['SKIP', 'Next packaging 性能和版本资产批次，非单桌面维护所需'],
  '38379b77176949ccb8eda3b5b96c5179b2c14a29': ['SKIP', 'Next computer-use 功能'],
  ba41476b1038e38a56b90626a9dfb30ece870110: ['SKIP', 'Beta 向 Next 框架迁移及全部关联文件；HuaAnWork 不做基座迁移'],
  '9b0eaefc84b57c05affff58e3b80620928b2cb14': ['SKIP', 'rc.3 runtime train；Harness pin 独立且本轮不变'],
  '7a884a519b7001dfee63b7a49187169a83791d79': ['SKIP', 'rc.3 适配；HuaAnWork 保持 rc.1'],
  '013e494cf552cd6b4482abf7550c6a746ccc65e2': ['SKIP', 'merge 容器；子提交已独立裁定'],
  bc297e7a95d56a5edec7d7dd65bc174c0ec14a8c: ['SKIP', 'Next 框架迁移后的 packaging/landlock 修复，不适用于当前 HuaAnWork 工具链'],
  '678aa209b2842c8388c9d76b268b0774d7a04572': ['SKIP', 'CI/Next 性能优化；非单桌面正确性维护，留待后续独立评估'],
  '077241ce7dad2c78bba89a3c1c9d175c961ebea4': ['SKIP', 'Beta AA-skip 去重已由 HuaAnWork 单格 CI 重写取代'],
  '7cd28c1c598694b204e7311e3f609b44d0fbeba9': ['SKIP', '上游 beta-only CI 不适用于 HuaAnWork；本计划已有独立单产品 CI'],
  '9847a9bb633dbf17e6d6050b0706b2ab2cbda9bb': ['SKIP', 'merge 容器；子提交已独立裁定'],
  bc6ae423eda7c21f121a2c41b83b8274499b2485: ['ALREADY', 'fork 已是 dshmarket 1.70.2 及更新 patch，上游 1.70.1 被更新实现覆盖'],
  '092e2ecef750d10db43cedbab8e81fd48c8de38e': ['SKIP', 'merge 容器；子提交已独立裁定'],
}
const FILE_OVERRIDES = {
  '6a63b9730b82cf4e858b9a11ac9783da9a5a0c3a:scripts/prepare-agents-anywhere-release.mjs': ['ALREADY', 'fork 已有 Schemastery 3.18.5 → cosmokit 1.8.6 映射'],
  'ebaa739d5f4d363d9b7ba3fa66871cc26a22fd0d:scripts/agents-anywhere-connector.test.mjs': ['ALREADY', 'fork connector 测试已适配更新 AA artifact 和 mesh 边界'],
  'ebaa739d5f4d363d9b7ba3fa66871cc26a22fd0d:patches/agents-anywhere-connector-httpx.patch': ['ALREADY', 'fork 已删除该 patch，等价修复已被上游 AA 吸收'],
  '16d4d97ba6fc02a6526dbcc57036fbd9cbb7f1a9:scripts/agents-anywhere-release-policy.mjs': ['ALREADY', 'fork 的 aaConnectorResolution 已返回无 patch 的 file: 制品'],
  '16d4d97ba6fc02a6526dbcc57036fbd9cbb7f1a9:scripts/prepare-agents-anywhere-release.mjs': ['ALREADY', 'fork prepare 已使用无 patch 的 file: 制品语义'],
  '16d4d97ba6fc02a6526dbcc57036fbd9cbb7f1a9:patches/agents-anywhere-connector-httpx.patch': ['ALREADY', 'fork 已删除该 patch'],
  'bc297e7a95d56a5edec7d7dd65bc174c0ec14a8c:dsh-desktop-next/scripts/packaging-command.ts': ['ALREADY', 'fork 现有 mapping 使用不同的 dsh-plugin-desktop-beta 替换顺序，不具该 replaceAll 缺陷'],
  '2f6e721d475910a26665397616fd3798adc5d0fb:dsh-plugin-desktop/package.json': ['ALREADY', 'fork 已把 meshcall-router-darwin-* 纳入 mac x64ArchFiles'],
  '2f6e721d475910a26665397616fd3798adc5d0fb:dsh-plugin-desktop-beta/package.json': ['ALREADY', 'fork 已把 meshcall-router-darwin-* 纳入 mac x64ArchFiles'],
  '2f6e721d475910a26665397616fd3798adc5d0fb:dsh-plugin-desktop/scripts/verify-profile-boot.mjs': ['ALREADY', 'fork 已读取 AA 2.1.0 manager-lock 租约'],
  '2f6e721d475910a26665397616fd3798adc5d0fb:dsh-plugin-desktop-beta/scripts/verify-profile-boot.mjs': ['ALREADY', 'fork 已读取 AA 2.1.0 manager-lock 租约'],
  'eef3a8873ef057d5bd5c5f04a60c2e00a979e33d:dsh-plugin-desktop/scripts/package-win.ts': ['ALREADY', 'fork 已有 windowsCompressionOverride，CI 已使用 store'],
  'eef3a8873ef057d5bd5c5f04a60c2e00a979e33d:dsh-plugin-desktop-beta/scripts/package-win.ts': ['ALREADY', 'fork 已有 windowsCompressionOverride，CI 已使用 store'],
  '580984e920f364b5d9b3b3063925cc7e29cb9c0b:.yarn/patches/dshmarket-desktop.patch': ['ALREADY', 'fork 的 1.70.2 patch 已包含等价 hostProvidedNpmVersions/holdYoungReleases 修复'],
  'bc6ae423eda7c21f121a2c41b83b8274499b2485:.yarn/patches/dshmarket-desktop.patch': ['ALREADY', 'fork 1.70.2 patch 已保留等价自更新与 channel 修复'],
}

const report = collectUpstreamReview({ root: process.cwd(), upstreamRef: TIP })
assert.equal(report.ok, true, report.error)
assert.equal(report.reviewedCommit, BASE)
assert.equal(report.pendingCount, 56)
assert.deepEqual(Object.keys(RULINGS).sort(), report.commits.map(commit => commit.sha).sort())
const usedOverrides = new Set()
const lines = [
  '# Single Desktop 首期 outer upstream 逐文件处置',
  '',
  `- as-of: ${new Date().toISOString()}`,
  `- range: \`${BASE}..${TIP}\`（56 commits）`,
  '- 规则：每个 direct file 继承 commit-default；FILE_OVERRIDES 只记录已有等价/更新实现。SKIP 是明确不移植，不是未审。merge direct files 为空，不重复子提交。',
  '- 本货架无 PORT；7b3cddd2fe 的 browser 行为变化进入既有功能对齐债，不在本维护计划实施。',
  '',
  '| upstream SHA | direct file | 裁定 | 理由 |',
  '| --- | --- | --- | --- |',
]
for (const commit of report.commits) {
  const files = [...commit.files.watched, ...commit.files.unwatched]
  if (files.length === 0) {
    const [action, reason] = RULINGS[commit.sha]
    lines.push(`| ${commit.sha} | (merge container, zero direct files) | ${action} | ${reason} |`)
    continue
  }
  for (const file of files) {
    const overrideKey = `${commit.sha}:${file}`
    const override = FILE_OVERRIDES[overrideKey]
    if (override) usedOverrides.add(overrideKey)
    const [action, reason] = override ?? RULINGS[commit.sha]
    assert.notEqual(action, 'PORT', `Unfinished port: ${commit.sha}:${file}`)
    lines.push(`| ${commit.sha} | ${file} | ${action} | ${reason} |`)
  }
}
assert.deepEqual([...usedOverrides].sort(), Object.keys(FILE_OVERRIDES).sort())
writeFileSync('docs/evidence/2026-10-29-single-desktop-upstream-shelf.md', `${lines.join('\n')}\n`)
console.log(`wrote ${report.pendingCount} commit dispositions with every direct file`)
NODE
```

- [ ] **Step 2: 核对完整性后才推进基线**

```bash
! grep -nE '\| (PORT|undefined|unreviewed) \|' docs/evidence/2026-10-29-single-desktop-upstream-shelf.md
node --input-type=module <<'NODE'
import { readFileSync, writeFileSync } from 'node:fs'
const path = 'desktop-upstream.json'
const config = JSON.parse(readFileSync(path, 'utf8'))
if (config.reviewedCommit !== '44084bdae0d44cac56948a223048d9c31541d0d0') throw new Error('unexpected initial reviewedCommit')
config.reviewedCommit = '092e2ecef750d10db43cedbab8e81fd48c8de38e'
writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`)
NODE
```

`rg` 预期无输出；若出现 PORT/undefined/unreviewed，停止且不得推进。`docs/upstream-sync.md` 登记首期 56 提交证据链接和新 reviewedCommit；若 `upstream/master` 已前进，多出的提交继续显示为 pending，不得随旧货架一起标记已审。

- [ ] **Step 3: 复现 dashboard 报告并提交**

```bash
node --test scripts/upstream-sync-dashboard.test.mjs
node --input-type=module <<'NODE'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { collectUpstreamReview } from './scripts/upstream-sync-dashboard.mjs'
const report = collectUpstreamReview({ root: process.cwd() })
assert.equal(report.ok, true, report.error)
const direct = Number(execFileSync('git', ['rev-list', '--count', `${report.reviewedCommit}..${report.upstreamSha}`], { encoding: 'utf8' }).trim())
assert.equal(report.pendingCount, direct)
console.log(`reviewed=${report.reviewedCommit} upstream=${report.upstreamSha} pending=${direct}`)
NODE
```

```bash
git add desktop-upstream.json docs/upstream-sync.md docs/evidence/2026-10-29-single-desktop-upstream-shelf.md
git commit -m "docs: disposition the initial selective upstream shelf"
```

---

### Task 14: 物理删除参考树与最终单桌面文档

**Files:**
- Modify: `dsh-plugin-huaanwork/tests/package.spec.ts`
- Modify: `scripts/active-topology.test.mjs`
- Modify: `scripts/verify-readme-versions.mjs`
- Modify: `scripts/verify-readme-versions.test.mjs`
- Modify: `AGENTS.md`
- Modify: `README.md`
- Modify: `README.en.md`
- Modify: `README.i18n.yaml`
- Modify: `.gitignore`
- Modify（仅当 Step 3/4 复核触发时）: `CONTRIBUTING.md`, `CONTRIBUTING.en.md`, `docs/architecture.md`, `docs/architecture.en.md`, `docs/README.md`, `docs/README.en.md`, `docs/plugin-development.md`, `docs/plugin-development.en.md`, `docs/plugin-development.i18n.yaml`, `docs/why-desktop.md`, `docs/why-desktop.en.md`, `dsh-community-market/README.md`, `dsh-community-market/README.zh.md`, `dsh-community-market/README.i18n.yaml`
- Delete: `dsh-plugin-desktop/`
- Delete: `dsh-plugin-desktop-beta/`
- Delete: `dsh-desktop-next/`
- Delete: `scripts/verify-desktop-variants.mjs`
- Delete: `scripts/classify-variant-tests-drift.mjs`
- Delete: `scripts/export-app-icons.mjs`
- Delete: `scripts/upstream-merge-spike.mjs`
- Delete: `scripts/verify-desktop-onboarding-browser.mjs`
- Delete: `scripts/*.reference.mjs`

**Interfaces:**
- Consumes: Task 12 已不依赖 `PAIRS` 的 dashboard、Task 13 已落盘的 selective 基线。
- Produces: 只有 HuaAnWork 一个自有可编辑桌面树；zero-touch 和参考目录规则关闭；历史身份字符串保留。

- [ ] **Step 1: 写最终结构失败测试**

`package.spec.ts` 增加：

```ts
it('has one owned desktop source tree and no active reference-workspace dependency', () => {
  for (const directory of ['dsh-plugin-desktop', 'dsh-plugin-desktop-beta', 'dsh-desktop-next']) {
    expect(existsSync(new URL(directory, workspaceRoot)), directory).toBe(false)
  }
  const scripts = Object.values(workspaceManifest.scripts ?? {}).join('\n')
  expect(scripts).not.toMatch(/dsh-plugin-desktop|dsh-desktop-next/u)
  expect(workspaceManifest.workspaces).toEqual(EXPECTED_WORKSPACES)
})
```

`active-topology.test.mjs` 从 `node:fs` 增 import `existsSync`，并加入：

```js
test('reference desktop implementations and their dedicated tools are gone', () => {
  for (const path of [
    'verify-desktop-variants.mjs',
    'classify-variant-tests-drift.mjs',
    'export-app-icons.mjs',
    'upstream-merge-spike.mjs',
    'verify-desktop-onboarding-browser.mjs',
    'verify-desktop-variants.reference.mjs',
    'export-app-icons.reference.mjs',
    'inspector-compat.reference.mjs',
    'upstream-sync-dashboard.reference.mjs',
  ]) assert.equal(existsSync(new URL(path, import.meta.url)), false, path)
})
```

`verify-readme-versions.test.mjs` 改钉 `outOfScopeRegistered: []`，CLI 不再输出 M28 或 Stable/Beta README。

运行：

```bash
node --test scripts/active-topology.test.mjs scripts/verify-readme-versions.test.mjs
corepack yarn workspace dsh-plugin-huaanwork vitest run tests/package.spec.ts
```

Expected: FAIL，三个目录和参考工具仍存在。

- [ ] **Step 2: 物理删除目录与专用工具**

```bash
# 先把当前 ignored 残留记入 Task 15 的阶段 B 证据；预期包括 .DS_Store、lib/、node_modules/。
git status --porcelain --ignored -- dsh-plugin-desktop dsh-plugin-desktop-beta dsh-desktop-next
git rm -r dsh-plugin-desktop dsh-plugin-desktop-beta dsh-desktop-next
for d in dsh-plugin-desktop dsh-plugin-desktop-beta dsh-desktop-next; do
  # git rm 只处理 tracked 文件。确认没有 tracked 或意外 untracked 文件后，
  # 再按已批准的物理删除边界清掉上面登记的 ignored 残留。
  test -z "$(git ls-files -- "$d")"
  test -z "$(git ls-files --others --exclude-standard -- "$d")"
  rm -rf -- "$d"
  test ! -e "$d"
done
git rm scripts/verify-desktop-variants.mjs scripts/classify-variant-tests-drift.mjs scripts/export-app-icons.mjs scripts/upstream-merge-spike.mjs scripts/verify-desktop-onboarding-browser.mjs
git rm scripts/verify-desktop-variants.reference.mjs scripts/export-app-icons.reference.mjs scripts/inspector-compat.reference.mjs
```

不得删除 `desktop-upstream.json` 中同名 watchedPaths；它们指向 outer upstream，不是本地实现。

- [ ] **Step 3: 收口 README、AGENTS 和 readme 守卫**

- `README*.md` 删除“参考目录暂存”的过渡句，保留 HuaAnWork 唯一桌面树、Yarn/pnpm 分工和已改好的 HuaAnWork 文档链接。
- `AGENTS.md` 删除 zero-touch 和 Stable/Next ownership 规则；按 Task 7 triage 关闭参考目录、Next 基座、variant 和整仓冲突例外条目。保留历史身份、迁移兼容、实际命名残留和其他债项。将 2.1 功能对齐债改为 selective 货架处置，并登记四个已审但不在本计划实施的后续候选：`7b3cddd2fe` 的 browser Profile 行为、`271cc526e4` 的 Windows EACCES retry 与 hide-before-destroy、`2f6e721d47` 的 safe-mode Windows 测试清理、`779968651e` 的 Electron 44.7.0 工具链评估。每项都须另立允许相应行为/测试/工具链变化的任务，不得在本计划顺手移植。
- `verify-readme-versions.mjs` 将 `outOfScopeRegistered` 设为空数组；CLI 只在数组非空时追加 out-of-scope 文本，删除 Stable/Beta M28 注释。
- 删除根 `.gitignore` 中已随参考树删除的 8 条条目（`dsh-plugin-desktop/{dist,lib,.desktop-build}/`、`dsh-plugin-desktop-beta/.desktop-build/`、`dsh-desktop-next/{lib,dist,.desktop-next,.desktop-build}/`）；保留 HuaAnWork 和通用条目。
- 删除参考树后，按 Task 7 的活文档三分类复核 `CONTRIBUTING`、`docs/architecture`、`docs/README`、`docs/plugin-development`、`docs/why-desktop`、`dsh-community-market/README` 是否仍有指向 `dsh-plugin-desktop/` 的本地链接；有则改指 `dsh-plugin-huaanwork/` 或标注为 outer upstream npm contract，不得机械替换历史身份。
- 改完 root README 或任何双语文档后，更新 `README.i18n.yaml`（以及 `docs/plugin-development.i18n.yaml`、`dsh-community-market/README.i18n.yaml`，如被改）的 git blob hash；`check:bilingual-docs` 必须通过。

- [ ] **Step 4: 验证物理拓扑、文档和活跃脚本**

```bash
node --test scripts/active-topology.test.mjs scripts/verify-readme-versions.test.mjs scripts/upstream-sync-dashboard.test.mjs
corepack yarn workspace dsh-plugin-huaanwork vitest run tests/package.spec.ts
corepack yarn check:bilingual-docs
corepack yarn check:architecture
corepack yarn test:scripts
corepack yarn install --immutable
node scripts/verify-layout.mjs
node scripts/upstream-sync-dashboard.mjs --json > /tmp/single-desktop-final-topology-report.json
rg -n 'dsh-plugin-desktop' CONTRIBUTING.md CONTRIBUTING.en.md docs/architecture.md docs/architecture.en.md docs/README.md docs/README.en.md docs/plugin-development.md docs/plugin-development.en.md docs/why-desktop.md docs/why-desktop.en.md dsh-community-market/README.md dsh-community-market/README.zh.md
# 命中必须全部属于 Task 7 triage 的“上游 npm contract / 历史身份”清单。
```

Expected: 全部 PASS；测试和 layout 不需要已删除目录，dashboard 不读取三包源码；活文档无未登记的旧本地链接。

- [ ] **Step 5: Commit**

删除已由 `git rm` 暂存，只显式添加剩余文件：

```bash
git add dsh-plugin-huaanwork/tests/package.spec.ts scripts/active-topology.test.mjs scripts/verify-readme-versions.mjs scripts/verify-readme-versions.test.mjs AGENTS.md README.md README.en.md README.i18n.yaml .gitignore
# 若 Step 3/4 还改了活文档或它们的 i18n 记录，按实际路径追加。
git commit -m "refactor: remove inactive desktop source trees"
```

---

### Task 15: 阶段 B 完整验证、结构验收与分支 CI

**Files:**
- Create: `docs/evidence/2026-10-29-single-desktop-phase-b.md`

**Interfaces:**
- Consumes: Task 9-14 的最终代码 SHA、Task 8 的阶段 A 恢复点。
- Produces: 最终本地/CI/结构证据；单桌面 DoD 可审计完成，不推 master、不合并、不发布。

- [ ] **Step 1: 固定最终代码 SHA 并重复完整本地门禁**

```bash
git diff --check
test -z "$(git status --porcelain | grep -vE '^\?\? (\.gstack/|docs/superpowers/(specs|plans)/2026-10-29-single-desktop-maintenance-(design|plan)-review\.md)$' || true)"
PHASE_B_SHA="$(git rev-parse HEAD)"
printf '%s\n' "$PHASE_B_SHA"
corepack yarn install --immutable
corepack yarn check
corepack yarn typecheck
corepack yarn test
```

Expected: 全部 exit 0；任何失败都不得宣告最终单套完成。

- [ ] **Step 2: 重复 provisioning 与 unsigned macOS smoke**

```bash
node dsh-plugin-huaanwork/scripts/huaanwork-verify-provisioning.mjs --smoke
corepack yarn dist:mac-smoke:huaanwork
```

若且仅若守卫实际报告缺项，记录缺项后使用 `HUAANWORK_ALLOW_UNPROVISIONED_SMOKE=1 corepack yarn dist:mac-smoke:huaanwork`，证据写 unsigned/unprovisioned smoke。随后：

```bash
test -z "$(git status --porcelain | grep -vE '^\?\? (\.gstack/|docs/superpowers/(specs|plans)/2026-10-29-single-desktop-maintenance-(design|plan)-review\.md)$' || true)"
test "$(git rev-parse "$PHASE_B_SHA":deepseek-harness)" = '1600d8a1e140dcde43a1a0941940a0480712c011'
```

若生成物变化，停止并从 Step 1 重新验证新 SHA。

- [ ] **Step 3: 执行六项结构验收**

```bash
test ! -e dsh-plugin-desktop
test ! -e dsh-plugin-desktop-beta
test ! -e dsh-desktop-next
node --input-type=module <<'NODE'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { collectUpstreamReview } from './scripts/upstream-sync-dashboard.mjs'
const root = JSON.parse(readFileSync('package.json', 'utf8'))
assert.deepEqual(root.workspaces.filter(name => ['dsh-plugin-desktop', 'dsh-plugin-desktop-beta', 'dsh-desktop-next'].includes(name)), [])
assert.equal(Object.values(root.scripts).join('\n').match(/dsh-plugin-desktop|dsh-desktop-next/u), null)
const upstream = JSON.parse(readFileSync('upstream.json', 'utf8'))
assert.deepEqual(Object.keys(upstream.channels), ['huaanwork'])
assert.deepEqual(upstream.marketPeerPolicy, { stableHistorical: 'retain', dormantAlpha1: 'retire' })
const market = JSON.parse(readFileSync('dsh-community-market/package.json', 'utf8'))
for (const [name, range] of Object.entries(market.peerDependencies ?? {})) {
  if (name.startsWith('@deepseek-ai/dsh')) assert.equal(range, '0.2.0-rc.2 || 0.2.1-rc.1', name)
}
assert.deepEqual(readdirSync('vendor/dsh-runtime'), ['0.2.1-rc.1'])
const report = collectUpstreamReview({ root: process.cwd() })
assert.equal(report.ok, true, report.error)
const direct = Number(execFileSync('git', ['rev-list', '--count', `${report.reviewedCommit}..${report.upstreamSha}`], { encoding: 'utf8' }).trim())
assert.equal(report.pendingCount, direct)
assert.equal(existsSync('dsh-plugin-huaanwork/src/product-identity.ts'), true)
console.log(`structure verified; upstream ${report.upstreamSha}; pending=${direct}`)
NODE
corepack yarn check:vendored-runtime
corepack yarn aa:check
```

Expected: 三个目录不存在、workspaces/脚本无参考依赖、peer 与裁定一致、只有 rc.1 资产、dashboard 可由本地 ref 复现；历史身份字符串不参与误报。

- [ ] **Step 4: 推送并 dispatch 最终 SHA 的完整 CI**

```bash
git push origin "$BRANCH"
gh workflow run ci.yml --ref "$BRANCH" --repo kawaiininja/HuaAnWork-Desktop
RUN_ID=''
for attempt in {1..30}; do
  RUN_ID="$(gh run list --workflow ci.yml --branch "$BRANCH" --event workflow_dispatch --limit 20 --json databaseId,headSha --repo kawaiininja/HuaAnWork-Desktop | jq -r --arg sha "$PHASE_B_SHA" 'first(.[] | select(.headSha == $sha) | .databaseId)')"
  if [[ "$RUN_ID" =~ ^[0-9]+$ ]]; then break; fi
  sleep 2
done
test "$RUN_ID" != 'null' && test -n "$RUN_ID"
gh run watch "$RUN_ID" --exit-status --repo kawaiininja/HuaAnWork-Desktop
gh run view "$RUN_ID" --repo kawaiininja/HuaAnWork-Desktop --json headSha,status,conclusion,url,jobs
```

Expected: `headSha == PHASE_B_SHA`、所有保留 job success；只写 Windows CI 打包证据和 macOS unsigned smoke，不写签名、公证或真实多机验收。

- [ ] **Step 5: 落盘最终证据并提交**

证据包含：阶段 A 代码 SHA/CI 链接、阶段 B 代码 SHA、四条本地门禁、provisioning 与豁免状态、macOS smoke、结构验收、参考目录 ignored 残留清单与物理清理结果、CI run ID/URL 和 jobs、peer 裁定链接、首期货架链接、Harness pin、未推 master/未合并/未发布声明。

```bash
git add docs/evidence/2026-10-29-single-desktop-phase-b.md
git commit -m "docs: record phase B single-desktop acceptance"
test -z "$(git diff --name-only "$PHASE_B_SHA"..HEAD -- . ':!docs/evidence/2026-10-29-single-desktop-phase-b.md')"
git push origin "$BRANCH"
```

最终证据提交只能包含该证据文件；不自动创建 PR、不合并、不发布。
