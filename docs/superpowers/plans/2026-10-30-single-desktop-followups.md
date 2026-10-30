# HuaAnWork 单桌面后续任务（F1–F13）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按 P0 → P1 → P2 → P3 关闭 `docs/evidence/2026-10-30-single-desktop-followups.md` 登记的 F1–F13：先恢复 root 日常命令（F1）并留下 F2 的核验证据，再清扫 P1 的注释/测试/证据/notices/历史标记，按产品裁定改写用户文档（F8），最后做 P3 门禁硬化并落全量验收证据。

**Architecture:** F1 是唯一的依赖升级 + Yarn patch 重做项（`dshmarket` 1.70.2 → 执行时 npm latest，计划编写时为 1.73.5）；F2 只核验 GitHub 分支保护/ruleset 并留证，不改仓库设置；P1 任务都是互不依赖的文本/断言清扫；F8 只改四份用户文档；P3 任务只补门禁断言与小脚本行为。除 F1 外不新增依赖、不改 lockfile。完整 root 门禁只在 F1 验收与最终验收各跑一次。

**Tech Stack:** Node.js `^22.19.0` / `>=24.0.0`、Corepack Yarn `4.18.0`、ESM `.mjs`、TypeScript/Vitest、node:test、GitHub Actions、electron-builder/`@electron/asar`；不新增依赖。

## 需求来源与裁定

- 需求登记表：`docs/evidence/2026-10-30-single-desktop-followups.md`（F1–F13 的现状、范围、验收、边界）。本计划不改变其意图，只把它变成可执行任务。
- 没有独立设计 spec：登记表 + 本计划 + 现有门禁是执行权威；任何偏离登记表的决定必须写进 ledger 的 `Ruling:`。
- 2026-10-30 用户裁定：F2 **只记录证据，不配置分支保护/ruleset**；F8 **改写为 HuaAnWork 单产品用户文档**。
- 计划编写时的实测基线：`dshmarket` latest = `1.73.5`；`corepack yarn market:check` 现为红（`dshmarket latest is 1.73.5; run corepack yarn market:prepare (dsh-plugin-huaanwork)`）；master 无分支保护、无 ruleset；F12 的 `--onboarding` 分支已在 `cbd392fbc7` 删除（当前脚本忽略所有 argv）。

## Global Constraints

- 分支固定为 `refactor/huaanwork-followups`，基线为 `refactor/huaanwork-single-desktop-maintenance` 的 HEAD `f5c85215a8`。每个任务的第一个 shell 都自行执行 `git branch --show-current` 与 `git rev-parse HEAD`，不依赖前一任务的环境变量。
- 不推 master、不自动合并、不触发发布、不 force-push。F2 不修改仓库设置（用户裁定 2026-10-30）。推送与 PR 由人类在验收后决定。
- lockfile 只能由包管理器重解；禁止手工拼装 `yarn.lock`。`package.json`/patch 文件可以手工编辑，随后必须 `corepack yarn install` 重解。
- 所有 root 门禁串行执行，不并行跑 `check` / `test` / `verify:aa`（既有 AA 服务冲突竞态）。
- 门禁中的文本搜索用 `grep` / `git grep`；不得用 `rg ... || true` 的 fail-open 形态。
- market、AA、runtime 检查保持 fail-closed；不得用离线旧制品、跳过校验、跳过 patch 或手工改坏 peer range 换取绿色。
- 不提交开工前已有的未跟踪 `.gstack/`；所有 `git add` 使用显式路径。
- 不修改 `deepseek-harness/` 子模组；不推进其 pin。
- `dshmarket` 目标版本 = 任务开始时 npm `latest`（计划编写时 `1.73.5`）。若执行时 latest 已前进，以新版本为准，并同步所有 pin、断言、证据中的版本号；不得钉回旧版本。
- F1 的 Desktop patch 必须保留以下 **7 类行为**（行号/字面量可随上游漂移，语义不得丢）：
  1. `client/client.js` 的 `selfName` / `self` 判据在 `installed["dshmarket"]` 缺失但 `updates["dshmarket"]` 存在时仍识别为 `dshmarket`。
  2. `lib/routes.js` 的 `updateCheckInputs().channelFor` 恒包含 `'dshmarket'`（host 提供、profile 未声明时也要走 HuaAnWork 通道）。
  3. `lib/routes.js` 所有 `checkUpdates(...)` 调用都传 `hostProvidedNpmVersions: new Map([['dshmarket', marketVersion()]])`。
  4. `lib/routes.js` 的安装 spec 在 profile manifest 缺 `dshmarket` 时回落到 `marketVersion()`。
  5. `lib/routes.js` 的 `readInstalledVersion` 读点（更新校验与 `beforeVersion`）在缺声明时回落到 `marketVersion()`（否则显示“未知版本”）。
  6. `lib/routes.js` 的更新试验以更新前 `trialValidate` 结果为基线，只把**新增** trial 错误判为失败（不得因 Profile 既有错误拒掉合法更新）。
  7. `lib/updates.js` 的 `checkUpdates` 支持 `options.hostProvidedNpmVersions`：注入 installed、参与 cacheKey、`readInstalledVersion` 回落到提供值。
- `dsh-plugin-huaanwork/tests/dshmarket-compat.spec.ts` 是上述行为的回归钉；升级后该文件必须全绿。允许为新的依赖布局调整 mock（例如 `undici` 的嵌套路径），但不得削弱“版本查询不能逃到真实 registry”的意图。
- F8 只改 `docs/user-guide.md`、`docs/user-guide.en.md`、`docs/faq.md`、`docs/faq.en.md` 四份文件；不改 `src/product-identity.ts`、迁移字符串、历史文档、`THIRD_PARTY_NOTICES.md`、README。文档事实必须能从代码/构建配置推导（产品名 `HuaAnWork`、bin `huaanwork`、默认更新 origin `http://update.intranet.lan:8790`、安装器 productName `HuaAnWork`）；**不得发明新 URL 或新路径**，无法从代码确认的细节保持中性表述并在任务报告中列出。
- 证据文档记录被验证代码的完整 SHA；证据提交不得夹带代码变化。失败停留在当前任务，不用后续删除掩盖。
- 每个 P1/P3 任务收尾时把该 F# 的“改了什么 + 跑了什么 + 结果”写进任务报告文件；最终验收任务统一汇总进 `docs/evidence/2026-10-30-single-desktop-followups-acceptance.md`。

## 预检：任务交叉与冲突表

| 共享面 | 涉及任务 | 判定 / 顺序 |
| --- | --- | --- |
| `dsh-plugin-huaanwork/tests/package.spec.ts` | Task 1（dshmarket pin 断言 :156-172）、Task 5（测试标题 :1099/:1724、`dist:win` 子串 :1113）、Task 11（CI job :1136-1219） | 同文件不同区域，串行执行；Task 1 必须先做，Task 5 在其后 |
| `scripts/active-topology.test.mjs` | Task 4（:11 断言消息）、Task 11（upstream.json 键集合、`*.reference.mjs` glob） | Task 4 先改文案，Task 11 再加断言 |
| `docs/evidence/2026-10-30-single-desktop-followups-acceptance.md` | Task 3 创建 F2 段、Task 13 汇总 F1–F13 | 串行；Task 13 保留 Task 3 的 F2 原文 |
| `dsh-plugin-huaanwork/THIRD_PARTY_NOTICES.md` | Task 7（F6 regenerated） | 必须在 Task 1 之后：依赖图已变 |
| `scripts/prepare-dsh-market.test.mjs` | Task 5（标题）、Task 1（不改） | 无代码冲突 |
| `scripts/verify-layout.mjs` | Task 4（activeChannel 收窄）、Task 11（不触碰） | 无冲突 |
| `docs/release-checklist.md` | Task 12（F13 新增 AA 流程段） | 独立 |
| `yarn.lock` / `package.json` / patch | Task 1 独占 | 其他任务不得改 lockfile |
| 用户文档四份 | Task 9 独占 | F8 裁定已定 |

自查：每个任务的“Files”与其 Step 中实际编辑的文件一致；Task 2 依赖 Task 1 的 HEAD；Task 13 依赖 Task 1–12 全部完成。无任务要求与 Global Constraints 相反的内容。

## File Structure

- `.yarn/patches/dshmarket-desktop.patch`：Desktop marketplace 的 7 类行为补丁，重做到目标版本。
- `package.json`、`dsh-plugin-huaanwork/package.json`、`yarn.lock`：dshmarket pin、resolution、依赖闭包。
- `dsh-plugin-huaanwork/tests/package.spec.ts`：dshmarket pin（Task 1）、标题与精确断言（Task 5）、CI job 形状（Task 11）。
- `scripts/prepare-dsh-market.test.mjs`：标题（Task 5）。
- `scripts/active-topology.test.mjs`、`scripts/verify-layout.mjs`、`scripts/verify-market-dependency-direction.mjs`、`scripts/market-dependency-direction.mjs`、`scripts/sync-vendored-runtime.mjs`、`scripts/agents-anywhere-release-policy.mjs`、`dsh-plugin-huaanwork/src/settings-bridge.ts`：去多桌面化注释/门禁（Task 4）。
- `docs/evidence/2026-10-29-single-desktop-runtime-consumers.md`、`docs/evidence/2026-10-29-single-desktop-rules-triage.md`、`docs/evidence/2026-10-29-single-desktop-upstream-shelf.md`、`docs/evidence/2026-10-29-single-desktop-phase-a.md`、`docs/upstream-sync.md`、`.github/workflows/release.yml`：事实与行号订正（Task 6）。
- `dsh-plugin-huaanwork/THIRD_PARTY_NOTICES.md`：notices 版本刷新（Task 7）。
- `assets/app-icons.source.json`、`plans/lock-advanced-window-mode.md`：历史标记（Task 8）。
- `docs/user-guide.md`、`docs/user-guide.en.md`、`docs/faq.md`、`docs/faq.en.md`：F8 单产品改写（Task 9）。
- `scripts/upstream-sync-dashboard.mjs`、`scripts/upstream-sync-dashboard.test.mjs`、`desktop-upstream.json`：dashboard 硬化（Task 10）。
- `dsh-community-market/tests/contracts.spec.ts`、`scripts/expected-root-gate-scripts.test.mjs`、`package.json`（`check:whitespace` / `check:readme-versions` 接线）、`scripts/active-topology.test.mjs`、`dsh-plugin-huaanwork/tests/package.spec.ts`：架构门补强（Task 11）。
- `scripts/agents-anywhere-connector.test.mjs`、`dsh-plugin-huaanwork/scripts/verify-profile-boot.mjs`、`docs/release-checklist.md`：P3 小项（Task 12）。
- `docs/evidence/2026-10-30-dshmarket-<VERSION>-upgrade.md`、`docs/evidence/2026-10-30-single-desktop-followups-acceptance.md`、`docs/evidence/2026-10-30-single-desktop-followups.md`、`AGENTS.md`：证据与登记状态（Task 2、3、13）。

---

### Task 1: F1 dshmarket 升级与 Desktop patch 重做（代码）

**Files:**
- Modify: `package.json`（`resolutions` 的 dshmarket 键）
- Modify: `dsh-plugin-huaanwork/package.json`（`dependencies.dshmarket`）
- Modify: `yarn.lock`（只由 `corepack yarn install` 重解）
- Modify: `.yarn/patches/dshmarket-desktop.patch`（重做到目标版本）
- Modify: `dsh-plugin-huaanwork/tests/package.spec.ts`（:156-172 的 dshmarket pin 断言）

**Interfaces:**
- Consumes: 无（本任务不依赖前序任务）。
- Produces: 目标版本 `dshmarket` 已安装且带 7 类 Desktop 补丁；`corepack yarn market:check` 通过；Task 2 在此 HEAD 上跑全量门禁。

- [ ] **Step 1: 确定目标版本并记录基线**

```bash
cd /Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop
git branch --show-current   # 必须是 refactor/huaanwork-followups
git rev-parse HEAD
npm view dshmarket version  # TARGET；计划编写时为 1.73.5
```

把 `TARGET` 写入任务报告。若 latest 已前进，全文以新值为准。

- [ ] **Step 2: 对比上游，逐类裁定 7 行为**

```bash
cd /tmp && rm -rf dshmarket-upgrade && mkdir dshmarket-upgrade && cd dshmarket-upgrade
npm pack dshmarket@1.70.2 --silent >/dev/null 2>&1 && mkdir old && tar xzf dshmarket-1.70.2.tgz -C old
npm pack dshmarket@TARGET --silent >/dev/null 2>&1 && mkdir new && tar xzf dshmarket-TARGET.tgz -C new
diff -u old/package/lib/updates.js new/package/lib/updates.js
diff -u old/package/lib/routes.js new/package/lib/routes.js | grep -n 'checkUpdates\|channelFor\|readInstalledVersion\|trialValidate\|marketVersion'
diff -u old/package/client/client.js new/package/client/client.js | grep -n 'selfName\|dshmarket'
```

在报告里给出 7 行表：行为 / 目标版本对应位置 / 上游是否已吸收 / 本任务处置（保留补丁 / 改写 / 已无需补丁 / 因上游破坏而需调整）。上游若已实现某行为，补丁不得重复叠加，改为测试钉住上游行为。

- [ ] **Step 3: 先升到目标版本（无补丁），再生成新 patch**

```bash
# 备份由 git 兜底：失败时 git checkout -- package.json dsh-plugin-huaanwork/package.json yarn.lock
# 1) 从 root package.json 删除 dshmarket@npm:1.70.2 的 resolution
# 2) 把 dsh-plugin-huaanwork/package.json 的 dshmarket 依赖改为 TARGET
YARN_ENABLE_IMMUTABLE_INSTALLS=false corepack yarn install
corepack yarn patch dshmarket        # 打印临时目录，例如 /private/tmp/.../dshmarket-...
```

在临时目录内按 Step 2 的处置重写 7 类行为，然后：

```bash
corepack yarn patch-commit -s <临时目录>
# patch-commit 会生成 .yarn/patches/<generated>.patch 并在 root resolutions 写入一个键
# 把生成的 patch 文件重命名为 .yarn/patches/dshmarket-desktop.patch
# 把 root resolutions 归一为唯一一项：
#   "dshmarket@npm:TARGET": "patch:dshmarket@npm%3ATARGET#./.yarn/patches/dshmarket-desktop.patch"
# 删除任何其他 dshmarket@ 键
YARN_ENABLE_IMMUTABLE_INSTALLS=false corepack yarn install
```

验收点：`node_modules/dshmarket/package.json` 的 `version` 为 `TARGET`；`node_modules/dshmarket` 的三个文件是补丁后的内容。

- [ ] **Step 4: 用标记验证 7 类行为都在已安装包内**

```bash
grep -c 'hostProvidedNpmVersions' node_modules/dshmarket/lib/routes.js node_modules/dshmarket/lib/updates.js
grep -c 'updates\["dshmarket"\] !== void 0' node_modules/dshmarket/client/client.js     # 2
grep -c "new Set(\[...Object.keys(installed), 'dshmarket'\])" node_modules/dshmarket/lib/routes.js  # 1
grep -c 'trialBefore\|introducedErrors' node_modules/dshmarket/lib/routes.js            # >= 2
grep -c 'name === .dshmarket. ? marketVersion()' node_modules/dshmarket/lib/routes.js  # 3（spec / installedVersion / beforeVersion）
node -e "const s=require('fs').readFileSync('node_modules/dshmarket/lib/updates.js','utf8'); console.log(s.includes('hostProvidedNpmVersions') && s.includes('installed[name] = version'))"
```

字面量可随上游漂移；若某个 grep 不再是有效判据，改用等价的语义断言并在报告中说明。**7 类行为一个都不能少**。

- [ ] **Step 5: 更新 `package.spec.ts` 的 pin 断言**

把 :167 / :169 / :170-171 的 `1.70.2` 全部改为 `TARGET`，断言形状不变：

```ts
expect(dshmarketResolutions[0]).toBe('dshmarket@npm:TARGET')
expect(manifest.dependencies?.dshmarket).toBe('TARGET')
expect(workspaceManifest.resolutions?.['dshmarket@npm:TARGET']).toBe(
  'patch:dshmarket@npm%3ATARGET#./.yarn/patches/dshmarket-desktop.patch',
)
```

- [ ] **Step 6: 目标测试**

```bash
corepack yarn workspace dsh-plugin-huaanwork exec vitest run tests/dshmarket-compat.spec.ts tests/package.spec.ts
```

`dshmarket-compat.spec.ts` 若因新版依赖布局（如 `undici` 提升/嵌套变化）失败，调整 mock 路径但保留“registry 查询不得逃逸”的断言；不得删除用例或放宽断言。

- [ ] **Step 7: market 命令与 lockfile 一致性**

```bash
corepack yarn market:prepare   # 期望 exit 0 且无文件变化
corepack yarn market:check     # 期望 exit 0
corepack yarn install --immutable
git diff --stat               # 只应包含本任务 Files 列出的文件
```

- [ ] **Step 8: 提交（显式路径）**

```bash
git add package.json dsh-plugin-huaanwork/package.json yarn.lock .yarn/patches/dshmarket-desktop.patch dsh-plugin-huaanwork/tests/package.spec.ts
git commit -m "chore(market): upgrade dshmarket and rebase the desktop patch"
```

**验收：** `market:check` exit 0；7 类行为在安装包内可验证；`dshmarket-compat` 与 `package.spec` 绿；`install --immutable` 绿；工作树只含预期文件。

---

### Task 2: F1 全量门禁、macOS smoke 与升级证据

**Files:**
- Create: `docs/evidence/2026-10-30-dshmarket-<TARGET>-upgrade.md`

**Interfaces:**
- Consumes: Task 1 的 HEAD（记录其完整 SHA 为 `CODE_SHA`）。
- Produces: F1 的收口证据；Task 13 引用该文件。

- [ ] **Step 1: 记录被验证代码**

```bash
git branch --show-current   # refactor/huaanwork-followups
CODE_SHA="$(git rev-parse HEAD)"; echo "$CODE_SHA"
git status --short          # 必须只含 .gstack/ 未跟踪
```

- [ ] **Step 2: 串行跑 root 四门禁**

```bash
corepack yarn market:check
corepack yarn build
corepack yarn typecheck
corepack yarn test
corepack yarn check
```

一次一条，前一条非零即停止。把每条命令、exit code、耗时与关键尾部输出记入报告与证据文档。已知 `check` 内含 `verify:aa`，不得与其他门禁并行。

- [ ] **Step 3: macOS smoke 并验证打包产物内的 patch**

```bash
corepack yarn dist:mac-smoke:huaanwork
find dsh-plugin-huaanwork/dist/mac-smoke -name app.asar
```

用仓库已有的 `@electron/asar`（devDependency 3.4.1）从 `app.asar` 提取并检查：

```bash
node -e "
const asar = require('./dsh-plugin-huaanwork/node_modules/@electron/asar');
const asarPath = process.argv[1];
const a = asar.extractFile(asarPath, 'node_modules/dshmarket/lib/routes.js').toString();
const b = asar.extractFile(asarPath, 'node_modules/dshmarket/lib/updates.js').toString();
const c = asar.extractFile(asarPath, 'node_modules/dshmarket/client/client.js').toString();
console.log({ routes: a.includes('hostProvidedNpmVersions'), updates: b.includes('hostProvidedNpmVersions'), client: c.includes('updates[\"dshmarket\"]') });
" <app.asar 路径>
```

若 asar 内路径与该布局不同（例如依赖被提升），先 `asar.listPackage()` 定位再提取。若产物无法定位，明确记录“打包产物内 patch 验证不可得”并说明原因，不得写成已验证。

- [ ] **Step 4: 写证据文档**

`docs/evidence/2026-10-30-dshmarket-<TARGET>-upgrade.md` 必须包含：

- 目标版本与来源（npm latest 查询时间）、上游 1.70.2 → TARGET 的触点变化摘要。
- 7 类行为处置表（保留 / 上游已吸收 / 改写）。
- `CODE_SHA` 完整 SHA；四门禁与 smoke 的命令、exit code、关键输出。
- 打包产物内 patch 验证结果（或不可得的诚实说明）。
- 边界：未跑 Windows 打包；未推送，CI 未运行；`market:check` 的通过依赖执行时 latest 仍为 TARGET。

- [ ] **Step 5: 提交证据（仅文档）**

```bash
git add docs/evidence/2026-10-30-dshmarket-<TARGET>-upgrade.md
git commit -m "docs: record the dshmarket upgrade acceptance"
```

**验收：** 四门禁 + smoke 全绿；证据文档可按 `CODE_SHA` 复现；提交只含文档。

---

### Task 3: F2 required checks 核验（仅证据，不改设置）

**Files:**
- Create: `docs/evidence/2026-10-30-single-desktop-followups-acceptance.md`（先写 F2 段）

**Interfaces:**
- Consumes: 无。
- Produces: F2 的核验记录；Task 13 在同一文件中补齐 F1–F13。

- [ ] **Step 1: 核验仓库设置（只读）**

```bash
gh api repos/kawaiininja/HuaAnWork-Desktop/branches/master/protection   # 期望 404 Branch not protected
gh api repos/kawaiininja/HuaAnWork-Desktop/rulesets                     # 期望 []
gh api repos/kawaiininja/HuaAnWork-Desktop --jq '.default_branch'
```

记录原始输出。若分支保护或 ruleset 实际存在，**不要修改**：把 required checks 清单与六个 job 逐一比对，把差异写进证据并交给人类处置。

- [ ] **Step 2: 核验六个 job 名单**

```bash
grep -n '^  [a-z0-9-]*:$' .github/workflows/ci.yml
```

期望 `changes`、`check`、`desktop-windows`、`desktop-macos`、`gitleaks`、`upstream-command-windows` 六个；记录实际名单。

- [ ] **Step 3: 写 F2 段**

在 `docs/evidence/2026-10-30-single-desktop-followups-acceptance.md` 写：

- 核验日期、命令、原始输出摘要。
- 结论：master 无分支保护、无 ruleset ⇒ 当前 required checks 为空，不存在“旧 `desktop-linux`/三桌面 cell 导致永久 pending”的结构性阻塞。
- 用户裁定（2026-10-30）：不修改仓库设置；若未来启用保护，required checks 应恰为上述六个 job。
- 边界：本项未验证 GitHub 组织级 ruleset（个人仓库无组织层）；未创建 PR 验证 pending 行为。

- [ ] **Step 4: 提交**

```bash
git add docs/evidence/2026-10-30-single-desktop-followups-acceptance.md
git commit -m "docs: record the required-checks verification for F2"
```

**验收：** 证据含命令与原始输出；仓库设置零变更；F2 结论可复核。

---

### Task 4: F3 活跃源码/脚本注释去多桌面化

**Files:**
- Modify: `dsh-plugin-huaanwork/src/settings-bridge.ts`（:5、:13 注释）
- Modify: `scripts/market-dependency-direction.mjs`（:14-17 注释）
- Modify: `scripts/sync-vendored-runtime.mjs`（:64 注释）
- Modify: `scripts/agents-anywhere-release-policy.mjs`（:13 注释）
- Modify: `scripts/verify-layout.mjs`（:22 `activeChannel` 判据）
- Modify: `scripts/verify-market-dependency-direction.mjs`（:14 输出文案）
- Modify: `scripts/active-topology.test.mjs`（:11 断言消息）

**Interfaces:**
- Consumes: Task 11 会在 `active-topology.test.mjs` 追加断言，本任务先改文案。
- Produces: 活跃指引不再描述 Stable/Beta 多桌面；`verify-layout` 只接受 `huaanwork`。

- [ ] **Step 1: 改注释与门禁文案**

- `settings-bridge.ts`：删除 “Both Desktop editions ride dsh 0.1.7” 与 `scripts/verify-desktop-variants.mjs` 字节比较的句子，改写为 HuaAnWork 单树事实（设置面适配器 + 单一桌面实现，无跨树字节比较）。
- `market-dependency-direction.mjs`：删除“只作为参考保留 / 即将删除”的 Stable/Beta 叙述，保留“受检根 = 活跃拓扑；包名禁令不变”的事实。
- `sync-vendored-runtime.mjs`：`loads in every desktop channel` → `loads in HuaAnWork`（或等价单通道表述）。
- `agents-anywhere-release-policy.mjs`：`pins every channel to one artifact` → `pins HuaAnWork to one artifact`。
- `verify-market-dependency-direction.mjs`：删除 “a registered upstream-sync exception”，改为 root fixture 读取属仓库内部约定、由各自守卫覆盖。
- `active-topology.test.mjs`：`must not run in Phase A` → `must not run in the single-desktop root test glob`。

- [ ] **Step 2: 收窄 `verify-layout.mjs`**

```js
if (upstream.activeChannel !== 'huaanwork') fail('the pinned upstream checkout must follow the huaanwork channel')
```

若 `upstream.json` 有历史通道键，保留数据、只收窄活跃值判据；不要删除 `channels` 历史元数据。

- [ ] **Step 3: 验证**

```bash
corepack yarn check:layout
corepack yarn test:architecture-gates
corepack yarn workspace dsh-plugin-huaanwork typecheck
git grep -nE 'Both Desktop editions|verify-desktop-variants|loads in every desktop channel|pins every channel|registered upstream-sync exception|must not run in Phase A' -- dsh-plugin-huaanwork/src scripts
```

最后一条期望零命中（历史文档/证据中的命中不算，命令范围已限定在 `src` 与 `scripts`）。

- [ ] **Step 4: 提交**

```bash
git add dsh-plugin-huaanwork/src/settings-bridge.ts scripts/market-dependency-direction.mjs scripts/sync-vendored-runtime.mjs scripts/agents-anywhere-release-policy.mjs scripts/verify-layout.mjs scripts/verify-market-dependency-direction.mjs scripts/active-topology.test.mjs
git commit -m "refactor: remove multi-desktop guidance from active sources and gates"
```

**验收：** 上述 grep 零命中；`check:layout` 与 `test:architecture-gates` 绿；未触碰 `DESKTOP_RELEASE_IDENTITIES`、迁移字符串、上游 npm contract。

---

### Task 5: F4 测试标题与子串断言卫生

**Files:**
- Modify: `dsh-plugin-huaanwork/tests/package.spec.ts`（:1099 标题、:1108 注释、:1113 断言、:1717 描述、:1724 标题）
- Modify: `scripts/prepare-dsh-market.test.mjs`（:34 标题）

**Interfaces:**
- Consumes: Task 1 已更新同文件的 dshmarket pin 区。
- Produces: 标题与单产品行为一致；`dist:win` 断言不再被 `dist:win-portable` 前缀假通过。

- [ ] **Step 1: 改标题与注释**

- `:1099` → `it('exposes the HuaAnWork distribution entry points', ...)`。
- `:1108` 注释 `与 stable/beta 同构:...` → `每条都先跑 aa:prepare-release 再构建 community-market`。
- `:1717` describe → `describe('huaanwork product identity', ...)`（去掉已完成的 M6 时点叙述）。
- `:1724` → `it('keeps the historical upstream identities intact', ...)`（实际只断言常量，不声称字节级）。
- `prepare-dsh-market.test.mjs:34` → `test('refreshes the active HuaAnWork workspace and rechecks the tag on every invocation', ...)`。

- [ ] **Step 2: 收紧 `dist:win` 断言**

把

```ts
expect(script).toContain('yarn workspace dsh-plugin-huaanwork dist:win')
```

改为精确命中命令结尾或带分隔符的断言，例如：

```ts
expect(script.endsWith('yarn workspace dsh-plugin-huaanwork dist:win')).toBe(true)
```

`dist:win-portable:huaanwork` 对应断言同理（`dist:win-portable` 结尾），确保互不匹配。

- [ ] **Step 3: 验证**

```bash
corepack yarn workspace dsh-plugin-huaanwork exec vitest run tests/package.spec.ts
node --test scripts/prepare-dsh-market.test.mjs
git grep -nE 'same distribution entry points as the upstream editions|two upstream editions|refreshes all editions' -- dsh-plugin-huaanwork/tests scripts
```

最后一条零命中。

- [ ] **Step 4: 提交**

```bash
git add dsh-plugin-huaanwork/tests/package.spec.ts scripts/prepare-dsh-market.test.mjs
git commit -m "test: align titles and assertions with the single desktop product"
```

**验收：** 标题与断言意图一致；两条目标测试绿；grep 零命中；未改变测试覆盖。

---

### Task 6: F5 证据文档与行号订正

**Files:**
- Modify: `docs/evidence/2026-10-29-single-desktop-runtime-consumers.md`（:172、:453、:470）
- Modify: `docs/evidence/2026-10-29-single-desktop-rules-triage.md`（:108-121）
- Modify: `docs/evidence/2026-10-29-single-desktop-upstream-shelf.md`（5 条 `ALREADY`）
- Modify: `docs/evidence/2026-10-29-single-desktop-phase-a.md`（:168）
- Modify: `docs/upstream-sync.md`（:83）
- Modify: `.github/workflows/release.yml`（:5 注释引用）

**Interfaces:**
- Consumes: 无（文档任务）。
- Produces: 每条数字/行号可在 HEAD 复现；历史原意不变。

- [ ] **Step 1: 逐条复测，不照抄登记值**

- `runtime-consumers.md:172` 的 `yarn.lock +1776/−9107`：用 `git show --stat` / `git diff --numstat` 对相应提交重算**只含 yarn.lock** 的数字。登记值称实为 `1762/9070`，必须以复测为准。
- `:453`：确认 vendor 行数口径是否包含 `manifest.json`；按实际口径改写句子。
- `:470`：`docs` 命中数在 HEAD 用 `git grep -c`（或 `grep -rc` 限定范围）重算；登记值 `41` 是写入本节前的值、HEAD 为 `47`，以复测为准。
- `rules-triage.md:108-121` §3：登记的 8 条“允许保留”现只应剩 `docs/architecture.md:56` 与 `.en.md:56`；逐条 `git grep` 验证后改为实际条数。
- `upstream-shelf.md` 的 5 条 `ALREADY`：为每条补 HuaAnWork 侧的本地等价路径 + 符号名（参考树已删除，不能再指向旧文件）。
- `phase-a.md:168`：把 provisioning 豁免描述补成“守卫由本地显式命令与 `check` job 覆盖”，避免被读成 CI smoke 在执行守卫。
- `upstream-sync.md:83`：把“离线必然失败”改为“本地已有 `upstream/master` ref 时可离线工作；否则需要可解析的 upstream ref”。
- `.github/workflows/release.yml:5`：`ci.yml:150-153` 已过期；改为当前 macOS job 的实际起始行（用 `grep -n '^  desktop-macos:' .github/workflows/ci.yml` 取数）。

- [ ] **Step 2: 验证**

```bash
# 每条数字用对应命令重算并记录命令与结果
corepack yarn check:whitespace
git diff --stat
```

文档提交不得包含代码、CI 行为或 lockfile 变化（`release.yml` 只改注释行）。

- [ ] **Step 3: 提交**

```bash
git add docs/evidence/2026-10-29-single-desktop-runtime-consumers.md docs/evidence/2026-10-29-single-desktop-rules-triage.md docs/evidence/2026-10-29-single-desktop-upstream-shelf.md docs/evidence/2026-10-29-single-desktop-phase-a.md docs/upstream-sync.md .github/workflows/release.yml
git commit -m "docs: correct single-desktop evidence numbers and references"
```

**验收：** 每条订正附复测命令；无代码/行为变化；`check:whitespace` 绿。

---

### Task 7: F6 AA notices 版本刷新

**Files:**
- Modify: `dsh-plugin-huaanwork/THIRD_PARTY_NOTICES.md`（由脚本生成）

**Interfaces:**
- Consumes: Task 1 的 dshmarket 升级（依赖图已变）。
- Produces: notices 与 `vendor/agents-anywhere/provenance.json` 和当前依赖闭包一致。

- [ ] **Step 1: 重新生成 notices**

```bash
corepack yarn workspace dsh-plugin-huaanwork verify:notices
git diff -- dsh-plugin-huaanwork/THIRD_PARTY_NOTICES.md | head -60
```

确认 `@agents-anywhere/dsh-bridge-next` 行版本变为 `2.1.0-desktop.c64c3f67ee3b2.r7f334f77`（以 `vendor/agents-anywhere/provenance.json` 的 `desktopVersion` 为准），并确认 dshmarket 相关条目版本随 Task 1 更新。

- [ ] **Step 2: 幂等与许可校验**

```bash
corepack yarn workspace dsh-plugin-huaanwork verify:notices   # 第二次不应再产生 diff
corepack yarn workspace dsh-plugin-huaanwork verify:licenses
```

若生成器只校验不写文件，先确认命令语义（`--notices` 是否重写）；若只校验失败，按脚本提示重新生成，仍不得手工改版本行。

- [ ] **Step 3: 提交**

```bash
git add dsh-plugin-huaanwork/THIRD_PARTY_NOTICES.md
git commit -m "chore(notices): refresh third-party notices after the AA and market updates"
```

**验收：** notices 版本与 provenance/依赖闭包一致；二次运行无 diff；`verify:licenses` 绿。

---

### Task 8: F7 历史文件加“历史”标记

**Files:**
- Modify: `assets/app-icons.source.json`
- Modify: `plans/lock-advanced-window-mode.md`

**Interfaces:**
- Consumes: 无。
- Produces: 两个历史文件不会被误当作当前可执行指引；文件本身保留。

- [ ] **Step 1: 查消费方，避免加键破坏解析**

```bash
git grep -n 'app-icons.source.json'
git grep -n 'lock-advanced-window-mode'
```

若 JSON 有严格 schema/键集合校验，改用顶层 `"_historical"` 允许的形态或仅改注释性字符串；不得删除历史条目。

- [ ] **Step 2: 加标记**

- `assets/app-icons.source.json`：加显式历史标记（例如 `"_historical": "References the retired stable/beta/next trees and the removed icons:* commands. Not executable; kept for historical identity."`），并在受影响的 `:7-8,14-15,34-35` 条目旁注明不可执行（若 JSON 无注释，用字段表达）。
- `plans/lock-advanced-window-mode.md`：顶部加横幅”历史计划（2026 年 X 月）；`verify-desktop-variants` / `check:desktop-variants` 已删除，本文件不再可执行“。

- [ ] **Step 3: 验证**

```bash
node -e "JSON.parse(require('fs').readFileSync('assets/app-icons.source.json','utf8')); console.log('json ok')"
corepack yarn workspace dsh-plugin-huaanwork exec vitest run tests/package.spec.ts
corepack yarn check:whitespace
```

- [ ] **Step 4: 提交**

```bash
git add assets/app-icons.source.json plans/lock-advanced-window-mode.md
git commit -m "docs: mark retired icon sources and variant plans as historical"
```

**验收：** JSON 可解析；相关测试绿；两文件明确标注历史且未被删除。

---

### Task 9: F8 用户文档改写为 HuaAnWork 单产品

**Files:**
- Modify: `docs/user-guide.md`、`docs/user-guide.en.md`
- Modify: `docs/faq.md`、`docs/faq.en.md`

**Interfaces:**
- Consumes: 用户裁定（2026-10-30）：改写为单产品。
- Produces: 四份文档只描述 HuaAnWork 单产品、单通道；zh/en 内容一致。

- [ ] **Step 1: 从代码取事实，列事实表**

至少核对：

```bash
sed -n '1,45p' dsh-plugin-huaanwork/src/product-identity.ts
node -e "const p=require('./dsh-plugin-huaanwork/package.json'); console.log(p.build?.productName, p.build?.appId, p.bin)"
sed -n '1,60p' dsh-plugin-huaanwork/src/update-checker.ts
```

事实表（写进报告）：产品名 `HuaAnWork`；CLI/bin `huaanwork`；安装器 productName `HuaAnWork`；默认更新 origin `http://update.intranet.lan:8790`，路径 `/api/desktop/version`；无 Linux 发行线；单通道（不再有稳定/Beta 双通道）。

- [ ] **Step 2: 改写四份文档**

- 产品名：描述本应用处 `DSH Desktop` → `HuaAnWork`；`DeepSeek Harness`/`DSH` 作为底层运行时保留。
- 命令行：`dsh-desktop <文件夹>` / `dsh-desktop-beta <文件夹>` → `huaanwork <文件夹>`；诊断命令同理。
- 更新：删除“稳定版只接收稳定更新，Beta 只接收 Beta 更新”与“Beta 还提供安装稳定版…”；改为单通道描述。更新地址按代码事实改写（默认内网 origin + `/api/desktop/version`，或中性表述“构建配置的更新服务”），**禁止**保留 `https://www.dshdesktop.cn/api/desktop/version` 作为 HuaAnWork 的事实。
- FAQ：删除/替换 `current stable release`、上游 `deepseek-harness-desktop` 的 Release/Issue 链接与下载页链接；改为“产品分发渠道/内部维护渠道”，不发明新 URL。
- Windows 安装路径按 `productName` 推导（`%LOCALAPPDATA%\Programs\HuaAnWork\HuaAnWork.exe`）；若无仓库内证据，保留“默认安装位置”的中性说法并在报告列出不确定项。
- 保留仍真实的排查内容（托盘、诊断 zip、profile、终端）；删除 Beta/稳定版并列操作。

- [ ] **Step 3: 校验**

```bash
corepack yarn check:bilingual-docs
corepack yarn check:readme-versions
git grep -nE '稳定版|Beta|DSH Desktop|dsh-desktop|current stable release|deepseek-harness-desktop' -- docs/user-guide.md docs/user-guide.en.md docs/faq.md docs/faq.en.md
```

最后一条应只剩确实需要保留的历史/上游语义（例如“DeepSeek Harness”不算命中；若有命中逐条解释）。另用 `git diff` 自查没有新增外部 URL：

```bash
git diff -U0 -- docs/user-guide.md docs/user-guide.en.md docs/faq.md docs/faq.en.md | grep -E '^\+.*https?://' || true
```

（此 grep 只用于报告，不作为门禁。）

- [ ] **Step 4: 提交**

```bash
git add docs/user-guide.md docs/user-guide.en.md docs/faq.md docs/faq.en.md
git commit -m "docs: rewrite user documentation for the HuaAnWork single product"
```

**验收：** 四份文档 zh/en 一致；无稳定版/Beta 双通道叙述；无发明 URL；事实可追溯到代码；两项文档门禁绿。

---

### Task 10: F9 Dashboard 硬化

**Files:**
- Modify: `scripts/upstream-sync-dashboard.mjs`
- Modify: `scripts/upstream-sync-dashboard.test.mjs`
- Modify: `desktop-upstream.json`（仅当存在目录型条目缺 `/` 时）

**Interfaces:**
- Consumes: 无。
- Produces: 非 ASCII 路径正确分类；目录型 `watchedPaths` 缺 `/` 时 fail-closed；dashboard 仍非门禁。

- [ ] **Step 1: 修 `core.quotePath` 影响**

在 `scripts/upstream-sync-dashboard.mjs` 的 `diff-tree` 调用处二选一：

```js
git(['-c', 'core.quotePath=false', 'diff-tree', '--no-commit-id', '--name-only', '-r', '--root', sha])
```

或改用 `-z` 并在调用侧按 `\0` 切分（注意 `git()` helper 的 `.trim()` 与 NUL 交互）。选择 `-z` 时需同时处理空输出。

- [ ] **Step 2: 目录型 `watchedPaths` 校验**

在 `collectUpstreamReview` 读取配置后、遍历提交前校验：不以 `/` 结尾的条目必须能由 `git cat-file -e <reviewedCommit>:<path>` 解析为文件；解析失败即返回 `ok:false` 并指名条目（错误信息提示目录型条目以 `/` 结尾）。不要静默接受目录。

- [ ] **Step 3: 测试**

- 删除 `upstream-sync-dashboard.test.mjs:3` 未使用的 `readFileSync` 导入。
- 新增用例：fixture 提交包含非 ASCII 路径（例如 `docs/中文.md`），断言它进入 `watched` 而非 `unwatched`。
- 新增用例：`watchedPaths: ['docs']`（目录但缺 `/`）→ `ok:false` 且错误指名 `docs`。
- 保留现有 hermetic 测试（临时 git 仓库，不访问网络）。

```bash
corepack yarn test:architecture-gates
node scripts/upstream-sync-dashboard.mjs | head -20   # 只读报告，仍需可用
```

- [ ] **Step 4: 提交**

```bash
git add scripts/upstream-sync-dashboard.mjs scripts/upstream-sync-dashboard.test.mjs desktop-upstream.json
git commit -m "fix(dashboard): classify non-ASCII paths and validate watched directories"
```

（`desktop-upstream.json` 无改动时不要加入暂存。）

**验收：** 两个新用例绿；非 ASCII 分类正确；配置错误 fail-closed；dashboard 未接入门禁。

---

### Task 11: F10 架构门/配置断言补强

**Files:**
- Modify: `scripts/active-topology.test.mjs`（`upstream.json` 键集合 + `*.reference.mjs` glob）
- Modify: `dsh-community-market/tests/contracts.spec.ts`（`activeChannel` 运行时断言）
- Modify: `scripts/expected-root-gate-scripts.test.mjs`（测试文件覆盖守卫）
- Modify: `package.json`（`check:whitespace` / `check:readme-versions` 接线两个孤儿测试）
- Modify: `dsh-plugin-huaanwork/tests/package.spec.ts`（`splitWorkflowJobs` 文案、CI job 集合、`check` job 形状）

**Interfaces:**
- Consumes: Task 4 已改 `active-topology.test.mjs` 的文案；Task 1/5 已改 `package.spec.ts` 其他区域。
- Produces: 新增/改名测试或 job 时门禁能失败；每个 `scripts/*.test.mjs` 都被门禁执行一次。

- [ ] **Step 1: `upstream.json` 顶层键与 reference glob**

在 `scripts/active-topology.test.mjs` 增加：

```js
test('upstream.json carries exactly the supported top-level keys', () => {
  const upstream = JSON.parse(readFileSync(new URL('../upstream.json', import.meta.url), 'utf8'))
  assert.deepEqual(Object.keys(upstream).sort(), ['activeChannel', 'channels', 'marketPeerPolicy', 'repository'])
  assert.equal(upstream.activeChannel, 'huaanwork')
})

test('no reference-only script survives', () => {
  assert.deepEqual(readdirSync(new URL('./', import.meta.url)).filter(name => name.endsWith('.reference.mjs')), [])
})
```

（按现有 import 风格补 `readFileSync`。）

- [ ] **Step 2: contracts 断言 `activeChannel` 值**

在 `dsh-community-market/tests/contracts.spec.ts` 的 `package integration contract` describe 内加：

```ts
expect(upstream.activeChannel).toBe('huaanwork')
```

- [ ] **Step 3: 接线两个孤儿测试**

当前 `scripts/check-whitespace.test.mjs` 与 `scripts/verify-readme-versions.test.mjs` 不在任何门禁。把：

```json
"check:whitespace": "node scripts/check-whitespace.mjs"
"check:readme-versions": "node scripts/verify-readme-versions.mjs"
```

改为先跑各自的 `node --test` 再跑校验脚本（保持门禁名不变）。

- [ ] **Step 4: 测试文件覆盖守卫**

在 `scripts/expected-root-gate-scripts.test.mjs` 增加：

- 枚举 `scripts/*.test.mjs`。
- 从 root `package.json` 的 scripts 建立“被显式引用”的集合（排除 `test:scripts` 的 glob 字面量）。
- 解析 `check` 的引用闭包（`yarn <script>` 递归解析，`check` → `check:layout` → `test:*` / `check:*`），断言每个测试文件至少被闭包内某个脚本显式引用；未被引用即列出并失败。

这样新增 `scripts/foo.test.mjs` 而未接入门禁时 `check:layout` 直接红，且不会与 `test:scripts` 重复执行。

- [ ] **Step 5: CI job 断言**

在 `dsh-plugin-huaanwork/tests/package.spec.ts`：

- `splitWorkflowJobs` 的报错文案 `release.yml must have...` → `the workflow must have a top-level jobs: key`。
- 用 job 集合断言替代仅按名字否定的 `desktop-linux` 检查：

```ts
expect(Object.keys(jobs).sort()).toEqual([
  'changes', 'check', 'desktop-macos', 'desktop-windows', 'gitleaks', 'upstream-command-windows',
])
```

- 钉 `check` job 的正面形状：

```ts
expect(jobs.check).toContain('run: yarn check')
expect(jobs.check).not.toMatch(/chromium|playwright install/iu)
```

- [ ] **Step 6: 验证**

```bash
corepack yarn test:architecture-gates
corepack yarn workspace dsh-community-market exec vitest run tests/contracts.spec.ts
corepack yarn test:gate-scripts
corepack yarn check:whitespace
corepack yarn workspace dsh-plugin-huaanwork exec vitest run tests/package.spec.ts
```

再验证守卫真的会失败：临时新建 `scripts/__probe.test.mjs`（不提交），跑 `corepack yarn test:gate-scripts` 应红；删除后恢复绿。

- [ ] **Step 7: 提交**

```bash
git add scripts/active-topology.test.mjs dsh-community-market/tests/contracts.spec.ts scripts/expected-root-gate-scripts.test.mjs package.json dsh-plugin-huaanwork/tests/package.spec.ts
git commit -m "test: harden architecture gates and CI shape assertions"
```

**验收：** 所有目标门禁绿；探针测试能被守卫抓住；无重复跑测试；现有门禁语义不变（只增加断言）。

---

### Task 12: F11/F12/F13 P3 小项

**Files:**
- Modify: `scripts/agents-anywhere-connector.test.mjs`
- Modify: `dsh-plugin-huaanwork/scripts/verify-profile-boot.mjs`
- Modify: `docs/release-checklist.md`

**Interfaces:**
- Consumes: 无。
- Produces: `UV_INDEX` 断言真正覆盖丢弃规则；`verify-profile-boot` 对未知参数报错；发布清单写明 AA main 移动目标的处理。

- [ ] **Step 1: F11 强化断言**

在 `agents-anywhere-connector.test.mjs` 的 connector 环境 fixture 中预置一个继承的 `UV_INDEX`（例如 `UV_INDEX: 'https://inherit.example/simple'`），保留：

```js
assert.ok(!('UV_INDEX' in launched.env))
```

并在断言的失败消息里说明期望：connector 丢弃继承的 `UV_INDEX`、只写 `UV_INDEX_URL` 等显式键。确认 fixture 的期望 env 快照（`assert.deepEqual(env, original)` 之类）同步更新。

```bash
node --test scripts/agents-anywhere-connector.test.mjs
```

- [ ] **Step 2: F12 严格参数**

`dsh-plugin-huaanwork/scripts/verify-profile-boot.mjs` 当前没有任何 argv 解析，`--onboarding` 被静默忽略。加：

```js
if (process.argv.length > 2) {
  console.error('verify-profile-boot: unknown arguments: ' + process.argv.slice(2).join(' '))
  process.exit(2)
}
```

位置必须在任何副作用（profile 准备、boot）之前。确认调用方无参数：

```bash
git grep -n 'verify-profile-boot' -- package.json dsh-plugin-huaanwork/package.json .github/workflows
```

`verify:profile` / `verify:aa` 均为无参调用。

- [ ] **Step 3: F13 发布清单**

在 `docs/release-checklist.md` 的 §0 后新增小节“AA 制品与 main 移动目标”，写明：

- `aa:check` 始终解析 Agents Anywhere `main` 最新提交；当前归档制品 provenance 为 `c64c3f67ee3b2.r7f334f77`（以文件为准）。
- 打包前若 AA `main` 已前进：先重跑 `corepack yarn aa:prepare-release`，再重跑 `corepack yarn test:aa-connector` 与 `corepack yarn test:aa-release`，然后重新打包。
- `aa:check` 红时应先判断是 main 前进而非回归；不得跳过校验发版。

- [ ] **Step 4: 验证**

```bash
node --test scripts/agents-anywhere-connector.test.mjs
node dsh-plugin-huaanwork/scripts/verify-profile-boot.mjs --onboarding; echo "exit=$?"   # 期望非零且无副作用
corepack yarn check:bilingual-docs
```

最后一项确认文档配对（若 release-checklist 无 i18n 记录，命令仍应绿）。

- [ ] **Step 5: 提交**

```bash
git add scripts/agents-anywhere-connector.test.mjs dsh-plugin-huaanwork/scripts/verify-profile-boot.mjs docs/release-checklist.md
git commit -m "chore: tighten connector, profile-boot and release checklist edges"
```

**验收：** connector 测试在预置 `UV_INDEX` 下仍绿（证明丢弃）；`--onboarding` 明确失败；清单写明 AA main 流程。

---

### Task 13: F1–F13 全量验收、登记状态与证据汇总

**Files:**
- Modify: `docs/evidence/2026-10-30-single-desktop-followups-acceptance.md`（F2 段之外补齐）
- Modify: `docs/evidence/2026-10-30-single-desktop-followups.md`（关闭记录）
- Modify: `AGENTS.md`（F1/F2 行与“单桌面改造后续任务清单”行状态）

**Interfaces:**
- Consumes: Task 1–12 全部完成；各任务报告文件（`.superpowers/sdd/<plan>/task-N-report.md`）。
- Produces: 可直接复核的 F1–F13 收口证据；登记表与 AGENTS 债务表状态一致。

- [ ] **Step 1: 记录最终代码 SHA 并跑全量门禁**

```bash
git branch --show-current   # refactor/huaanwork-followups
FINAL_SHA="$(git rev-parse HEAD)"; echo "$FINAL_SHA"
corepack yarn market:check
corepack yarn build
corepack yarn typecheck
corepack yarn test
corepack yarn check
corepack yarn workspace dsh-plugin-huaanwork verify:notices
```

串行；记录每条 exit code。若门禁暴露前面任务的回归，修在该任务的文件上并在报告中说明（不许跳过）。

- [ ] **Step 2: 写验收文档**

在 `docs/evidence/2026-10-30-single-desktop-followups-acceptance.md` 保留 Task 3 的 F2 段，补齐：

- 顶部：分支、`FINAL_SHA`、日期、需求登记表路径。
- 表格：F1–F13 每行 = 优先级 / 结论（完成/已核验/裁定）/ 代码提交 / 验证命令与结果 / 边界。
- F1：引用 `2026-10-30-dshmarket-<TARGET>-upgrade.md`，写目标版本与四门禁 + smoke 结果。
- F8：写四份文档、事实来源（product-identity / update-checker / build 配置）与 zh/en 校验结果。
- 全局边界：未推送、未跑分支 CI、未做 Windows 打包、F2 未改仓库设置；`market:check` 的通过依赖执行时 npm latest 未前进。

- [ ] **Step 3: 更新登记表与 AGENTS**

- `docs/evidence/2026-10-30-single-desktop-followups.md`：在总表加“状态”列或新增“关闭记录”段，逐条写关闭提交与证据指针；写明 F12 的登记现状（`--onboarding` 分支已在 `cbd392fbc7` 删除，本计划只补严格参数）。
- `AGENTS.md`：把 F1、F2 行的里程碑改为已关闭/已核验并指向验收文档；把“单桌面改造后续任务清单（F1–F13）”行改为已关闭（保留历史描述）。

- [ ] **Step 4: 提交证据（仅文档）**

```bash
git add docs/evidence/2026-10-30-single-desktop-followups-acceptance.md docs/evidence/2026-10-30-single-desktop-followups.md AGENTS.md
git commit -m "docs: record the single-desktop follow-up closure"
```

**验收：** 全量门禁绿；F1–F13 每条都有结论、提交号与验证命令；登记表与 AGENTS 不再把已完成项列为待办；证据提交无代码变化。

---

## 收尾

- Task 13 之后跑最终全分支评审（whole-branch review），评审范围 = `f5c85215a8..HEAD`；评审发现的问题只做一轮修复 + 一次范围化复核。
- 推送、开 PR、触发 CI、发布均不在本计划授权内；由人类在验收后决定。
- 已知遗留（不在本计划范围）：`THIRD_PARTY_NOTICES.md` 的 “DSH Desktop distributes” 抬头仍属命名残留债；`AGENTS.md` 中 M7/M9 历史行、`docs/superpowers/specs/` 历史文档不改写。
