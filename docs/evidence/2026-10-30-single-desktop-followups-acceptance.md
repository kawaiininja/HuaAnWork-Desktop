# 单桌面改造后续任务验收证据

- 记录时间：2026-10-30（本地 UTC+8）
- 仓库：`/Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop`（`kawaiininja/HuaAnWork-Desktop`），分支 `refactor/huaanwork-followups`
- **`FINAL_SHA`（Task 13 全量门禁的被验证提交）**：`051a25763048d380ebb0ef35efc1879b08028278`（短 `051a257630`，`fix: address the final whole-branch review findings`）。上一轮 `FINAL_SHA` 为 `aa837f9124fec6ddfe820660150b2b8ea98a6706`（短 `aa837f9124`）；终审修复波次改动了测试文件 `dsh-plugin-huaanwork/tests/dshmarket-compat.spec.ts`，旧读数不再覆盖新 HEAD，已重跑并保留为〈Task 13 全量门禁〉下的历史读数
- 需求登记表：`docs/evidence/2026-10-30-single-desktop-followups.md`（F1–F13 的原始现状/范围/验收）；逐任务报告在 `.superpowers/sdd/2026-10-30-single-desktop-followups/task-N-report.md`（本地执行记录，不随仓库提交）
- 性质：F1–F13 的收口验收证据汇总。**§F2 为 Task 3 原件**（其记录时的快照 HEAD 为 `cb48083b51`，F1 的代码提交 `6547000e6a` 是其父提交），本次不改写；F1、F3–F13 的结论、提交、验证与边界见下方总表与分项，Task 13 的全量门禁见〈Task 13 全量门禁〉。
- 总则：本文件的每一项都是**记录**，不是新的实现变更。F2 按用户裁定（2026-10-30）不创建、不修改任何分支保护或 ruleset。

## 总表：F1–F13 收口状态

| ID | 优先级 | 结论 | 代码/证据提交 | 验证命令与结果 | 边界 |
| --- | --- | --- | --- | --- | --- |
| F1 | P0 | 完成（本地门禁 + unsigned macOS smoke） | 代码 `6547000e6a`；证据 `cb48083b51` | 见 §F1：`market:check`、`build`、`typecheck`、`test`、`check`、`dist:mac-smoke:huaanwork` 全部 exit 0 | 未跑 CI、未推送；未做 Windows 打包；`market:check` 依赖执行时 npm latest 未前进（当时 `1.73.5`） |
| F2 | P0 | **已核验（仅证据）** | `5c8116755b` / `b5b95e4af7` / `6c0eac45ec` | `gh api` 只读核验：master 无经典保护（404）、rulesets `[]`、六 job 名单与矩阵后缀 check 名；见 §F2 | **仓库设置零变更**（无 PUT/POST/PATCH/DELETE）；未创建 PR 验证 skipped required check 语义 |
| F3 | P1 | 完成 | `bdc56930ad` | `check:layout` 0；`test:architecture-gates` 16/16；workspace `typecheck` 0；`git grep -nE 'Both Desktop editions\|verify-desktop-variants\|loads in every desktop channel\|pins every channel\|registered upstream-sync exception\|must not run in Phase A' -- dsh-plugin-huaanwork/src scripts`（表格内 `\|` 是 Markdown 转义，实际命令用竖线）→ 3 命中，全为 `scripts/active-topology.test.mjs:18,28,33` 的守卫字面量；`dsh-plugin-huaanwork/src` 0 命中 | 含原登记未列的第 8 文件 `jobs-bridge.ts`（同句注释）；`active-topology.test.mjs` 的三处 `verify-desktop-variants` 字面量是守卫载荷，必须保留 |
| F4 | P1 | 完成 | `06bd5f0dfe` | `package.spec.ts` 76 passed / 1 skipped (77)；`prepare-dsh-market.test.mjs` 6/6；旧标题 grep 零命中 | 仅 2 文件；`AGENTS.md` 与本登记表引用的旧标题为登记期历史文本 |
| F5 | P1 | 完成（数字按实测订正） | `912e7ef238` / `fe5b1a5e69` / `9235b91c0c` | 每条数字/行号在 HEAD 复现（见证据文档）；`check:whitespace` / `check:bilingual-docs` / `check:readme-versions` 全 0 | docs 命中数经历 41→47→46→47 四次读数，shelf「5 条 `ALREADY`」实为 10 行；原文保留为历史记录 |
| F6 | P1 | 完成 | `38368e0d8a` | `verify:notices` 两次字节一致；`verify:licenses` 0；AA 行 = provenance `c64c3f67ee3b2.r7f334f77`，dshmarket 行 = `1.73.5` | 生成器按包名去重（`js-yaml`/`undici` 旧行）是既有行为，未改生成器 |
| F7 | P1 | 完成 | `e75c13f2c5` | JSON 解析通过；原键/值 0 缺失、0 变更；`package.spec.ts` 76/1；`check:whitespace` 0 | 历史文件保留，只加不可执行标记 |
| F8 | P2 | 完成（按 2026-10-30 产品裁定改写单产品） | `756a299920` | `check:bilingual-docs` 50 records / 100 docs；`check:readme-versions` 4 处；旧产品线 grep 零命中 | 事实来源与残留不确定性见 §F8；除代码内置更新源外未新增外部链接 |
| F9 | P3 | 完成 | `4d1efc6daa` + `31d23adf6b` | dashboard 测试 6/6；`test:architecture-gates` 19/19；真实 dashboard 只读运行 exit 0、`pending = 0` | dashboard 仍非门禁；`desktop-upstream.json` 未改（gitlink 按文件型条目接受） |
| F10 | P3 | 完成 | `48b622e9ca` | `test:architecture-gates` 21/21；`contracts.spec.ts` 20/20；`test:gate-scripts` 3/3；`check:whitespace` 7/7；`package.spec.ts` 76/1 | `check:whitespace` 新接入的测试依赖 `origin/master`；`test:scripts` 被明确排除在 `check` closure 外（比 brief 更严） |
| F11 | P3 | 完成 | `24720c229b` | `node --test scripts/agents-anywhere-connector.test.mjs` 3/3（`# fail 0`）；mutation 过程：备份并在已安装制品 `dsh-plugin-huaanwork/node_modules/@agents-anywhere/dsh-bridge-next/lib/index.js:2041` 把 `const { UV_INDEX: _inherited, ...rest } = environment;` 改为 `const { ...rest } = environment;`，同命令 → `# pass 2 / # fail 1`，`not ok 2 - dsh-plugin-huaanwork: Python gets a compatible bypass list and a writable project copy`，`AssertionError: connector must drop the inherited UV_INDEX …; got https://inherit.example/simple`；还原后 SHA-256 与备份一致（`ea6f1d612cfe82f16774ae2b555d9daa2a8dae3be9ccded12a6293d013a937a5`），同命令 3/3 绿 | 只改测试 fixture/断言；mutation 只落在 `node_modules`（未跟踪），已还原 |
| F12 | P3 | 完成（严格 argv） | `24720c229b` | `verify-profile-boot.mjs --onboarding` exit 2、stderr 精确；`verify:profile` 仍 exit 0 | 登记现状：`--onboarding` 分支本身已在 `cbd392fbc7` 删除，本计划只补严格 argv（见〈F12 登记现状〉） |
| F13 | P3 | 完成 | `24720c229b` + `aa837f9124` | `docs/release-checklist.md` §0.1；`check:bilingual-docs` 50/100；`check:whitespace` 0 | 「AA main 前进 → 重跑 prepare/测试/重打包」分支未端到端演练；`aa:check` 仍未接入 CI |

## F1（P0）`dshmarket` 升级与 Desktop patch 适配

- 目标版本 **`1.73.5`**：`npm view dshmarket version` 于 `2026-10-30T07:00:39Z` 返回 `1.73.5`；`dsh-plugin-huaanwork/package.json` pin、root `resolutions`、`yarn.lock` 与安装体一致。
- 上游 1.70.2 → 1.73.5 **未吸收** 7 类 Desktop 行为中的任何一类；`dshmarket-desktop.patch` 重做为 12 个 hunk（client 2 / routes 9 / updates 1），上下文锚定、不依赖行号。
- 被测代码 `6547000e6a`；证据提交 `cb48083b51`；证据文件 `docs/evidence/2026-10-30-dshmarket-1.73.5-upgrade.md`。

| 命令（在 `6547000e6a` 上串行） | Exit | 耗时 | 关键输出 |
| --- | --- | --- | --- |
| `corepack yarn market:check` | 0 | 1 s | `dshmarket latest verified: 1.73.5 in HuaAnWork` |
| `corepack yarn build` | 0 | 13 s | `market:prepare` 同首行；client/native-ui `✓ built`；四个 server workspace `TypeScript sources run directly; no build output` |
| `corepack yarn typecheck` | 0 | 23 s | `contract-types: 4 generated type files are current`；8 个 workspace 通过 |
| `corepack yarn test` | 0 | 85 s | huaanwork 267 passed / 4 skipped（271），3547 passed / 14 skipped（3561）；其余 workspace 303/244/88/80；node:test 162 passed / 2 skipped |
| `corepack yarn check` | 0 | 159 s | closure 316、bundled 131、licenses 636、operations 7/18、`verify:aa` 通过 |
| `corepack yarn dist:mac-smoke:huaanwork` | 0 | 439 s | unsigned universal DMG；`macOS DMG smoke verification passed` |

- 打包产物验证：`build.asar: false`，产品产物中没有 `app.asar`（既有设计，非产物缺失）；改以「安装体 / staging app / 挂载 DMG 内 app」三处 `routes.js`、`updates.js`、`client.js` 的 SHA-256 完全一致 + patch 标记命中（如 `hostProvidedNpmVersions` 4 次 / 3 行）作为补丁仍在制品内的证据。
- **边界**：本项收口只覆盖**本地门禁 + unsigned macOS smoke**。未跑 CI、未推送、未做 Windows 打包/发行制品校验、未签名或公证；「CI 绿」不是本项证据。

## F8（P2）用户文档改写为 HuaAnWork 单产品

- 四份文档：`docs/user-guide.md`、`docs/user-guide.en.md`、`docs/faq.md`、`docs/faq.en.md`；提交 `756a299920`。
- 事实来源（代码可复核）：产品名/应用 id/安装器名 `dsh-plugin-huaanwork/src/product-identity.ts:17-23`；更新源 `src/update-checker.ts:16`（`http://update.intranet.lan:8790` + `/api/desktop/version`）；本地端口 `src/desktop-port.ts:4`（`43120`）；发行目标 `dsh-plugin-huaanwork/package.json` 的 `build.*` 与 `scripts/package-win.ts` / `scripts/release-mac.ts`。
- 校验：`corepack yarn check:bilingual-docs` → `50 records and 100 documents are consistent`（exit 0）；`corepack yarn check:readme-versions` → 4 处一致（exit 0）；`git grep -nE '稳定版|Beta|DSH Desktop|dsh-desktop|current stable release|deepseek-harness-desktop'` 在四份文档零命中（exit 1）。
- 边界：zh/en 逐事实对齐；`DeepSeek Harness` / `DSH` 仅作为运行时概念保留；Windows 默认安装路径、任务栏拖放限制、首次登录的实际 provisioning 等 8 条不确定性按保守/中性措辞处理（见 Task 9 报告 §Uncertainties）。改写依据是 2026-10-30 产品裁定（改写为单产品），不是「命名残留债」登记。

## F12 登记现状（口径订正）

登记文本称「Task 14 删除唯一 import 后仍接受 `--onboarding` 但什么也不做」。该描述在当前 HEAD 已不成立：`--onboarding` 分支已在 `cbd392fbc7` 删除，脚本对未知参数此前是**静默忽略**。本计划（`24720c229b`）补的是严格 argv 守卫：`argv.length > 2` ⇒ `verify-profile-boot: unknown arguments: <args>` + `exit 2`，且守卫位于第一个副作用（临时 Profile home 的 `mkdtempSync`）之前。验证以「`--onboarding` exit 2、stderr 精确」与「临时 Profile home 数量前后不变（零副作用）」以及真实调用方 `verify:profile` exit 0 为依据。

## Task 13 全量门禁（`FINAL_SHA` = `051a257630`，终审修复后重跑）

终审（whole-branch review）修复提交 `051a25763048d380ebb0ef35efc1879b08028278`（`fix: address the final whole-branch review findings`）改动了测试文件 `dsh-plugin-huaanwork/tests/dshmarket-compat.spec.ts`，原 Task 13 在 `aa837f9124` 上的读数不再覆盖 HEAD，故在该提交上**原样重跑**六条命令。执行前 `npm view dshmarket version` → `1.73.5`（与 F1 目标一致）。六条命令**严格串行**（一次一条；`check` 内含 `verify:aa`，未与其他门禁并行）。工作树在每个门禁前后均只有未跟踪的 `?? .gstack/`；各门禁未改写任何受版本控制的文件（含 `market:prepare` 与会重写 notices 的 `verify:notices`）。

| # | 命令 | Exit | 耗时 | 关键输出 |
| --- | --- | --- | --- | --- |
| 1 | `corepack yarn market:check` | 0 | 2 s | `dshmarket latest verified: 1.73.5 in HuaAnWork` |
| 2 | `corepack yarn build` | 0 | 14 s | client/native-ui `✓ built`；四个 server workspace `TypeScript sources run directly; no build output` |
| 3 | `corepack yarn typecheck` | 0 | 23 s | `contract-types: 4 generated type files are current` |
| 4 | `corepack yarn test` | 0 | 83 s | huaanwork 267 passed / 4 skipped（271），3547 passed / 14 skipped（3561）；market 303、market-server 244、update-server 88、agent-catalog 80；node:test 7 块 `# fail 0` |
| 5 | `corepack yarn check` | 0 | 156 s | closure 316、bundled 131、licenses 636、operations 7/18、`verify:aa`（`verify-profile-boot … passed`）、bilingual 50/100、layout 对齐 `1600d8a1e1`、readme-versions 4 |
| 6 | `corepack yarn workspace dsh-plugin-huaanwork verify:notices` | 0 | 1 s | `verify-licenses: 636 packages checked (9 bundled); 2 use notice-required licenses (LGPL-3.0-or-later)`；生成后 `git diff` 为空（字节一致） |

- **unsigned macOS smoke 本轮未重跑**：本波只改测试文件、CI 注释、脚本头部注释与 Markdown，没有影响打包产物的代码变化（`dshmarket-compat.spec.ts` 不进入发行包）；F1 的 smoke 读数仍以其自身记录的 `6547000e6a` 为准，本轮不声称 smoke 覆盖 HEAD。
- 本轮未推送、未跑 CI；`market:check` 仍依赖执行时 npm latest 为 `1.73.5`。**`FINAL_SHA=051a257630` 之后唯一的改动（收口后补记）**：一次**行数中性**的 `.github/workflows/ci.yml` 注释压缩——`Build macOS smoke artifact` 步骤里关于 provisioning guard 的说明由 7 行压回 3 行（净 −4 行），env 行 `HUAANWORK_ALLOW_UNPROVISIONED_SMOKE: '1'` 本身未改，语义仍为「本步骤跑的是 workspace `dist:mac-smoke`（`node scripts/package-mac.ts`），不执行 guard；该 env 在此路径无读者，仅因 `tests/package.spec.ts` 钉住 job 形状而保留；guard 覆盖来自 root `dist:*` 链（**`dist:win-sign:huaanwork` 除外**，该链不前置 guard）以及显式的本地命令」。无行为变化，故上表六条门禁读数与 `FINAL_SHA` 保持不变；压缩由 `tests/package.spec.ts` 与 `check:whitespace` 复验。压缩后再逐条复核本文档与 phase-a / phase-b 引用的行号，全部落在最终文件上：`HUAANWORK_ALLOW_UNPROVISIONED_SMOKE` = `:218`、`DSH_MAC_SMOKE_ARCH` = `:222`、smoke 的 `run:` = `:223`、`upstream-command-windows` job 键 = `:255`、其 `if:` = `:257`（另 `desktop-macos` 的 `if:` = `:178`、`check:mac-package:platform` = `:211`、`Build macOS smoke artifact` 步骤名 = `:212`）。

### 历史读数（终审修复前，`FINAL_SHA` = `aa837f9124`）

Task 13 原收口在被验证提交 `aa837f9124fec6ddfe820660150b2b8ea98a6706`（`docs: separate AA network failures from stale-main triage`）上的读数保留如下，作为历史（当时测试文件尚未被终审修复改动）：

| # | 命令 | Exit | 耗时 | 关键输出 |
| --- | --- | --- | --- | --- |
| 1 | `corepack yarn market:check` | 0 | 2 s | `dshmarket latest verified: 1.73.5 in HuaAnWork` |
| 2 | `corepack yarn build` | 0 | 14 s | client/native-ui `✓ built`；四个 server workspace `TypeScript sources run directly; no build output` |
| 3 | `corepack yarn typecheck` | 0 | 24 s | `contract-types: 4 generated type files are current` |
| 4 | `corepack yarn test` | 0 | 86 s | huaanwork 267 passed / 4 skipped（271），3547 passed / 14 skipped（3561）；market 303、market-server 244、update-server 88、agent-catalog 80；node:test 7 块 `# fail 0` |
| 5 | `corepack yarn check` | 0 | 168 s | closure 316、bundled 131、licenses 636、operations 7/18、`verify:aa`（`verify-profile-boot … passed`）、bilingual 50/100、layout 对齐 `1600d8a1e1`、readme-versions 4 |
| 6 | `corepack yarn workspace dsh-plugin-huaanwork verify:notices` | 0 | 0 s | `verify-licenses: 636 packages checked (9 bundled); 2 use notice-required licenses (LGPL-3.0-or-later)`；生成后 `git diff` 为空（字节一致） |

## 全局边界

- **未推送、未合并、未 force-push、未触发发布**；**本分支 CI 未运行**——本地门禁绿不等于 CI 绿。
- **未做 Windows 打包/发行制品校验**；无第二台 Windows 机器，macOS → Windows 机器/OS 边界未验证。
- **F2 未改仓库设置**：全部 GitHub 交互为只读（GET / `gh auth status`），提交前后保护状态、ruleset、`protected` 字段均无漂移。
- `market:check` 的通过**依赖执行时 npm latest 未前进**（Task 13 执行时为 `1.73.5`，`2026-10-30` 复核）；latest 前进后按设计 fail-closed，需要重跑 `market:prepare`，这不是回归。
- macOS smoke 为 **unsigned**（R-6 口径）；签名、公证与安装器升级路径未验证。
- Task 13 的收口提交只改文档；终审修复提交 `051a257630` 另改了一个测试文件（`dshmarket-compat.spec.ts` 删除死 mock）、`ci.yml` 与 `scripts/upstream-sync-dashboard.mjs` 的注释；两轮均无 lockfile、依赖版本或子模组变化，`.gstack/` 未跟踪、未提交。

## F2（P0）GitHub required checks 对齐 —— 仅证据核验

对应登记：`docs/evidence/2026-10-30-single-desktop-followups.md` §F2「GitHub required checks 对齐」（现状：CI 只剩六个 job；分支保护若仍按旧的 `desktop-linux` 或三桌面 cell 名配置，PR 会永久 pending）。

### 1. 核验时间与对象

| 项 | 值 |
|---|---|
| 核验时间（UTC） | `2026-10-30T07:17:43Z` |
| 核验时间（本地） | `2026-10-30 15:17:43 CST`（UTC+8） |
| 仓库全名（API 返回 `full_name`） | `kawaiininja/HuaAnWork-Desktop` |
| 所有者类型 | `owner.type=User`（个人仓库，**无组织层**） |
| 可见性 | `visibility=public` |
| 默认分支 | `master` |
| 认证身份 | `gh auth status` → `Logged in to github.com account kawaiininja (keyring)`；scopes `gist, read:org, repo, workflow` |

GitHub 远端：`origin` = `https://github.com/kawaiininja/HuaAnWork-Desktop.git`，`upstream` = `https://github.com/anywhere-labs/dsh-desktop.git`（上游）。**本段所有 `gh` 命令都显式写全 `repos/kawaiininja/HuaAnWork-Desktop/...`**，不依赖默认仓库解析。

### 2. Step 1：仓库设置（只读）

以下命令与输出为 2026-10-30T07:17Z 本次实跑原文，不是规划期快照。

**命令 A —— master 分支保护**

```console
$ gh api repos/kawaiininja/HuaAnWork-Desktop/branches/master/protection
{"message":"Branch not protected","documentation_url":"https://docs.github.com/rest/branches/branch-protection#get-branch-protection","status":"404"}
gh: Branch not protected (HTTP 404)
# exit 1
```

补充同一事实的第二种读法（`branches/master` 对象的 `protected` 字段）：

```console
$ gh api repos/kawaiininja/HuaAnWork-Desktop/branches/master --jq '"protected=\(.protected)"'
protected=false
# exit 0
```

结论：**master 无经典分支保护规则**（404 `Branch not protected`），`protected=false` 独立复现同一事实。

**命令 B —— 仓库 rulesets**

```console
$ gh api repos/kawaiininja/HuaAnWork-Desktop/rulesets
[]
# exit 0
```

结论：**仓库无任何 ruleset**（返回空数组，非 404；即 ruleset 功能可用但未配置）。

**命令 C —— 默认分支**

```console
$ gh api repos/kawaiininja/HuaAnWork-Desktop --jq '.default_branch'
master
# exit 0
```

结论：默认分支为 `master`，与命令 A 查询的分支一致。

**命令 D —— 仓库身份字段（补充，用于判定是否存在组织层）**

```console
$ gh api repos/kawaiininja/HuaAnWork-Desktop --jq '"default_branch=\(.default_branch) visibility=\(.visibility) owner.type=\(.owner.type) owner.login=\(.owner.login) full_name=\(.full_name)"'
default_branch=master visibility=public owner.type=User owner.login=kawaiininja full_name=kawaiininja/HuaAnWork-Desktop
# exit 0
```

由于 `owner.type=User`，本仓库没有可继承规则的组织层：分支保护只能来自仓库级 branch protection 或仓库级 ruleset，而两者经命令 A/B 核实**均为空**。因此当前 **required status checks 集合为空**。

### 3. Step 2：CI job 名单

命令与输出原文：

```console
$ grep -n '^  [a-z0-9-]*:$' .github/workflows/ci.yml
6:  push:
23:  changes:
62:  check:
119:  desktop-windows:
176:  desktop-macos:
229:  gitleaks:
255:  upstream-command-windows:
# exit 0
```

`grep` 命中 7 行，其中 **`:6 push:` 不是 job** 而是 `on:` 触发器（`on:` 块在 `ci.yml:3-8`，`push.branches: [master]` 在 `:6-7`）；`jobs:` 键在 `ci.yml:20`。真正的 job 恰为六个：

| # | job id | 行号 | GitHub 上报的 check 名 | 运行条件（`if`） |
|---|---|---|---|---|
| 1 | `changes` | `:23` | `changes` | 无条件（永远运行，在 run 内分类变更路径） |
| 2 | `check` | `:62` | `check` | 无条件（`needs: changes`，但无 `if`） |
| 3 | `desktop-windows` | `:119` | `desktop-windows (dsh-plugin-huaanwork)` | `needs.changes.outputs.product == 'true'`（`:121`） |
| 4 | `desktop-macos` | `:176` | `desktop-macos (dsh-plugin-huaanwork)` | `needs.changes.outputs.product == 'true'`（`:178`） |
| 5 | `gitleaks` | `:229` | `gitleaks` | 无条件 |
| 6 | `upstream-command-windows` | `:255` | `upstream-command-windows` | `needs.changes.outputs.product == 'true'`（`:257`） |

**check 名的取法**：`ci.yml` 中没有 job 级 `name:` 键（`grep -n '^    name:' .github/workflows/ci.yml` 零命中），因此 check 名 = job id；但 `desktop-windows` / `desktop-macos` 有 `strategy.matrix`（`workspace: [dsh-plugin-huaanwork]`，`:127` / `:184`），矩阵展开的 check 名形如 `<job id> (<matrix 值>)`。这不是推断：见 §4 在 master HEAD 上直接观测到的 `desktop-macos (dsh-plugin-huaanwork)` 与 `desktop-windows (dsh-plugin-huaanwork)`。

本分支 `ci.yml` 已无 `desktop-linux`（`grep -c 'desktop-linux' .github/workflows/ci.yml` = `0`，exit 1），两处矩阵均只剩单 cell `dsh-plugin-huaanwork`。

### 4. 补充核验：GitHub 上实际存在的 check 名（只读）

为确认「required checks 该填哪个字符串」，读取 master HEAD 的 check runs（只读 GET）：

```console
$ SHA=$(gh api repos/kawaiininja/HuaAnWork-Desktop/commits/master --jq '.sha')
$ echo "$SHA"
b5ef3e84a7951941480b50a8749fe6714b8c9fc7
$ gh api "repos/kawaiininja/HuaAnWork-Desktop/commits/$SHA/check-runs?per_page=100" --jq '.check_runs[] | "\(.name)\t\(.status)\t\(.conclusion)"' | sort -u
changes	completed	success
check	completed	success
desktop-linux (dsh-plugin-desktop)	completed	success
desktop-linux (dsh-plugin-desktop-beta)	completed	success
desktop-macos (dsh-plugin-desktop)	completed	success
desktop-macos (dsh-plugin-desktop-beta)	completed	success
desktop-macos (dsh-plugin-huaanwork)	completed	success
desktop-windows (dsh-plugin-desktop)	completed	success
desktop-windows (dsh-plugin-desktop-beta)	completed	success
desktop-windows (dsh-plugin-huaanwork)	completed	success
gitleaks	completed	success
upstream-command-windows	completed	success
# exit 0
```

该 commit 的元数据：`b5ef3e84a7`，`2026-10-28T22:10:40Z`（`Merge pull request #20 ...`），check 运行起始 `2026-10-28T22:11:15Z`，`app=github-actions`。

两条必须记录的差异事实：

1. **`origin/master` 的 `ci.yml` 仍是三 workspace 矩阵**：`git show origin/master:.github/workflows/ci.yml` 在 `:178` 与 `:277` 两处为 `workspace: [dsh-plugin-desktop, dsh-plugin-desktop-beta, dsh-plugin-huaanwork]`，并另有 `desktop-linux` job（`origin/master` 的 `ci.yml:229`）。单桌面收窄（`ci.yml` −100/+7 行）只存在于本分支、尚未合并。ahead 计数按提交逐一复现（命令 `git rev-list --count origin/master..<提交>`；本文件每多一条 docs 提交，分支头部的计数就 +1）：`cb48083b51`（快照 HEAD）= **25**、`5c8116755b`（首条证据提交）= **26**、`b5b95e4af7`（ahead 计数订正提交）= **27**——2026-10-30 复核时在 `b5b95e4af7` 上实跑 `git rev-list --count origin/master..HEAD` 输出 `27`；引用任何数字都必须绑定提交，不写脱离提交的「当前 HEAD 计数」。上面 12 个 check 名里多出的 6 个旧名——`desktop-linux (dsh-plugin-desktop)`、`desktop-linux (dsh-plugin-desktop-beta)`、`desktop-macos (dsh-plugin-desktop)`、`desktop-macos (dsh-plugin-desktop-beta)`、`desktop-windows (dsh-plugin-desktop)`、`desktop-windows (dsh-plugin-desktop-beta)`——都是合并后将被删除的旧配置，但来源不同：其中 4 个 `desktop-{macos,windows} (dsh-plugin-desktop|dsh-plugin-desktop-beta)` 来自 master 的三 cell 矩阵（`origin/master` 的 `ci.yml:178` / `:277`，每个 job 3 个 cell，`dsh-plugin-huaanwork` cell 即现行名）；2 个 `desktop-linux (...)` 来自 master 独立的 `desktop-linux` job（`ci.yml:229`），其矩阵表达式按事件选择 cell——push 为 2 个 cell（`dsh-plugin-desktop` + `dsh-plugin-desktop-beta`），PR 为 1 个 cell（仅 `dsh-plugin-desktop-beta`，`ci.yml:237`）——并非三 cell 矩阵。
2. **六个目标 check 名当前全部可在 master 上直接观测到**：`changes`、`check`、`gitleaks`、`upstream-command-windows`（裸名）+ `desktop-macos (dsh-plugin-huaanwork)`、`desktop-windows (dsh-plugin-huaanwork)`（矩阵后缀名）。即：若在本分支合并前就按这六个名字启用保护，同样能被现有 workflow 产出，旧名只是额外的非必需 check；合并后旧名自然消失，不会留下永不上报的 required 名。反之，若用**裸 job id**（`desktop-windows` / `desktop-macos`）配置 required checks，则永远不会有同名 check 上报，必然永久 pending —— 这是 F2 真正的命名陷阱。

### 5. 结论

- **master 无经典分支保护（404 `Branch not protected`，`protected=false`），仓库无任何 ruleset（`[]`），默认分支 `master`，所有者为个人账号（`owner.type=User`）⇒ 当前 required status checks 集合为空。**
- 因此**当前不存在**「旧 `desktop-linux` / 三桌面 cell 名导致 PR 永久 pending」的**结构性阻塞**：没有任何 required-check 配置可被满足或悬空。F2 登记的「分支保护若仍按旧 cell 名配置 ⇒ 永久 pending」在本仓库目前是**未触发的条件句**，不是已发生的故障。
- 六个 job 名单经 `grep` 与 `jobs:` 结构核实为 `changes`、`check`、`desktop-windows`、`desktop-macos`、`gitleaks`、`upstream-command-windows`；作为 **required check 名**时应写 `changes`、`check`、`desktop-windows (dsh-plugin-huaanwork)`、`desktop-macos (dsh-plugin-huaanwork)`、`gitleaks`、`upstream-command-windows`（§4 已在 GitHub 侧直接观测到全部六个字符串）。
- 剩余风险不是「配置错误」，而是「**尚未启用任何保护**」：master 可被直接 push、无必需 review、无必需 status check。这是仓库设置的现状事实，按用户裁定不在本项处置。

### 6. 用户裁定（2026-10-30）

- **本项只记录证据，不创建、不修改任何 branch protection 或 ruleset**；不改 workflow。
- 若将来启用分支保护，required status checks 应**恰为上述六个 job**（按 §4 的完整 check 名配置，不用裸矩阵 job id）。
- 该裁定是 F2 的处置边界：本次交付**仓库设置零变更**，差异交给人类在设置面处置。

### 7. 边界（未验证项，不得读作已验证）

- **未验证组织级 / 企业级 ruleset**：`owner.type=User` 表示本仓库无组织层，故组织级 ruleset 不适用于本仓库；企业层（若存在）未查询，属设置面，超出本项。
- **未创建 PR 验证 pending 行为**：`desktop-windows`、`desktop-macos`、`upstream-command-windows` 三个 job 带 `if: needs.changes.outputs.product == 'true'`（`ci.yml:121`/`:178`/`:257`），文档-only 变更下会被 skip。GitHub 对「skipped 的 required check 是否视为满足」的行为**未实测**（无 PR、无保护配置可供测试）；`ci.yml:21-22` 的注释表明设计取向是在 run 内分类（`changes` job 永远运行）而非用 workflow path filter，但该设计是否足以让 required checks 结论性收敛，仍需在启用保护后用一条真实 PR 验证。
- **未验证第三方 / GitHub App 检查**（如安全扫描类外部集成）能否作为 required check；§4 只列出 `app=github-actions` 的 check。
- **未验证仓库其他分支**的保护状态；本项只查 `master`（默认分支）。
- **未验证**规则集 API 的其他子资源（如 `rulesets/{id}`、bypass 列表）；`rulesets` 返回 `[]` 已足以判定「无 ruleset」。

### 8. 仓库设置零变更声明

- 本项执行的 GitHub 交互都是**只读**的：`gh api` 一律 **GET**（`branches/master/protection`、`branches/master`、`rulesets`、仓库元数据、`commits/master`、`commits/{sha}/check-runs`），另有一次 `gh auth status`（§1，只读认证状态查询）。没有使用 `-X` / `--method` / `-f` / `--input`，没有任何 PUT/POST/PATCH/DELETE。
- 提交后复核：两条证据提交完成后再次查询，`branches/master/protection` 仍为 `404 Branch not protected`、`rulesets` 仍为 `[]`、`protected=false`；2026-10-30 本次修正复核时又复跑一次，结果相同 ⇒ 提交前后仓库设置零漂移。
- 未执行 `gh repo edit`、`gh api -X PUT .../protection`、`gh ruleset`（写子命令）等任何设置变更命令。
- 本地只做了只读 git 读取与一次 `git fetch origin master`（仅更新本地 remote-tracking ref，不改远端）。
- 工作树在核验前后均为「仅 `?? .gstack/`（未跟踪，不提交）」，本任务只提交本文件。
