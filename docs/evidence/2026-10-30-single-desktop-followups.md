# 单桌面改造后续任务清单

- 日期：2026-10-30
- 分支：`refactor/huaanwork-single-desktop-maintenance`
- 快照 HEAD：`2b5fab3a16`（最终代码 SHA `4a6dbebe37`，最终 CI run `40994970656` success 6/6）
- 来源：`docs/superpowers/plans/2026-10-29-single-desktop-maintenance.md` 执行期逐任务评审、最终全分支评审，以及 `docs/evidence/2026-10-29-single-desktop-{phase-a,phase-b,runtime-consumers,upstream-shelf,rules-triage}.md`
- 性质：**登记清单，不是本计划的 DoD**。本文件不改代码；F1/F2 之外的条目不阻断当前分支合并。

优先级定义：
- **P0**：阻断日常 root 命令或仓库协作，需要独立里程碑/人工设置。
- **P1**：活文档、注释或证据中的事实性错误，低风险但应尽快清扫。
- **P2**：产品文案/品牌范围，需要产品裁定。
- **P3**：硬化、覆盖率与流程改进，非阻断。

## 总表

| ID | 优先级 | 任务 | 触发/顺序 |
| --- | --- | --- | --- |
| F1 | P0 | `dshmarket` 升级与 Desktop patch 适配 | 立即排期；master 同样红 |
| F2 | P0 | GitHub required checks 对齐六个当前 job | 合并前人工核对 |
| F3 | P1 | 活跃源码/脚本注释去多桌面化 | 下一文档清扫波次 |
| F4 | P1 | 测试标题与子串断言卫生 | 与 F3 同批 |
| F5 | P1 | 证据文档与行号订正 | 与 F3 同批 |
| F6 | P1 | AA notices 版本刷新 | 下一次 AA/市场刷新 |
| F7 | P1 | 历史文件加“历史”标记 | 与 F3 同批 |
| F8 | P2 | 用户文档仍描述 Stable/Beta 产品线 | 需产品裁定 |
| F9 | P3 | Dashboard 硬化 | 触摸 dashboard 时 |
| F10 | P3 | 架构门/配置断言补强 | 下一次门禁硬化 |
| F11 | P3 | Connector `UV_INDEX` 弱断言 | 下一次 connector 测试 |
| F12 | P3 | `verify-profile-boot --onboarding` 静默 no-op | 下一次脚本清理 |
| F13 | P3 | AA `main` 移动目标流程化 | 下一次发布清单更新 |

---

## F1（P0）`dshmarket` 升级与 Desktop patch 适配

**现状**：仓库钉 `dshmarket@1.70.2`；npm latest 已到 `1.73.5`。`corepack yarn market:check` 因最新版本与 pin 不一致而 fail-closed；root `dev`/`build`/`dist:*` 的 `market:prepare` 因 `.yarn/patches/dshmarket-desktop.patch` 无法应用到 `1.73.5` 而失败（Yarn `YN0066` hunk 错误）。这是 master 基线即存在的漂移，不是单桌面改造引入；本计划按 fail-closed 原则没有升级或跳过校验。

**范围**：
- 审查 `1.70.2 → 1.73.5` 的 host-provided npm versions、channel/self-update、hold-young-releases 等 Desktop patch 触点。
- 重做 `.yarn/patches/dshmarket-desktop.patch`；更新 `dsh-plugin-huaanwork/package.json` 的 `dshmarket` pin、root `resolutions` 与 `yarn.lock`（只由包管理器重解）。
- 同步 `dsh-plugin-huaanwork/tests/package.spec.ts` 的 `dshmarket@npm:1.70.2` 钉与相关断言。
- 跑 `corepack yarn market:prepare`、`corepack yarn market:check`、完整四门禁与 macOS smoke；重新打包验证 Desktop patch 仍生效。

**验收**：在线 `market:check` exit 0；root `dev`/`build`/`dist:*` 的 `market:prepare` 通过；无离线旧制品、跳过校验或手工改坏 peer range；CI 绿。

**备注**：这是清单中唯一需要另立实施计划的日常命令阻断项。

## F2（P0）GitHub required checks 对齐

**现状**：CI 只剩 `changes`、`check`、`desktop-windows`、`desktop-macos`、`gitleaks`、`upstream-command-windows` 六个 job；分支保护若仍按旧的 `desktop-linux` 或三桌面 cell 名配置，PR 会永久 pending。

**范围**：核对仓库 branch protection / ruleset 的 required status checks，改为现有六个 job；不修改 workflow。

**验收**：新 PR 的 required checks 只等待这六个 job，且全部可正常上报。

## F3（P1）活跃源码/脚本注释去多桌面化

**现状**（HEAD `2b5fab3a16`）：
- `dsh-plugin-huaanwork/src/settings-bridge.ts:5,13`：仍写 “Both Desktop editions ride dsh 0.1.7” 与 `scripts/verify-desktop-variants.mjs` 字节比较。
- `scripts/market-dependency-direction.mjs:14-17`：仍写 Stable/Beta 参考树“只作为参考保留”“即将删除”。
- `scripts/sync-vendored-runtime.mjs:64`：仍写 market “loads in every desktop channel”。
- `scripts/agents-anywhere-release-policy.mjs:13`：仍写 resolution “pins every channel”。
- `scripts/verify-layout.mjs:22`：仍允许 `activeChannel` 为 `stable`/`beta`，应收窄为 `huaanwork`。
- `scripts/verify-market-dependency-direction.mjs:14`：仍称 root fixture 读取是 “registered upstream-sync exception”，该例外已于阶段 B 关闭。
- `scripts/active-topology.test.mjs:11`：断言消息仍写 “must not run in Phase A”。

**验收**：上述文件不再出现多桌面时期的活指引；`grep` 命中只剩历史文档/历史身份；全部门禁绿。不要机械替换 `DESKTOP_RELEASE_IDENTITIES`、迁移字符串或上游 npm contract。

## F4（P1）测试标题与子串断言卫生

**现状**：
- `dsh-plugin-huaanwork/tests/package.spec.ts:1099`：“exposes the same distribution entry points as the upstream editions”。
- `dsh-plugin-huaanwork/tests/package.spec.ts:1724`：“keeps the two upstream editions byte-for-byte intact”（实际只断言身份常量）。
- `scripts/prepare-dsh-market.test.mjs:34`：“refreshes all editions”。
- `package.spec.ts` 的 `toContain('yarn workspace dsh-plugin-huaanwork dist:win')` 也会匹配 `dist:win-portable`，建议改成精确或分隔断言。

**验收**：标题与单产品行为一致；断言不会因共享前缀而假通过；不改变测试意图。

## F5（P1）证据文档与行号订正

**现状**：
- `docs/evidence/2026-10-29-single-desktop-runtime-consumers.md:172`：`yarn.lock +1776/−9107` 实为 `1762/9070`（原数字还包含 `package.json`）。
- 同文件 `:453`：称 vendor 行数不计，实际 `manifest.json` 行数被计入；`:470` 的 docs 命中数 `41` 是写入本节前的值（HEAD 为 47）。
- `docs/evidence/2026-10-29-single-desktop-rules-triage.md:108-121`：§3 仍列 8 条“允许保留”，实际只剩 `docs/architecture.md:56` 与 `.en.md:56` 两条。
- `docs/evidence/2026-10-29-single-desktop-upstream-shelf.md`：5 条 `ALREADY` 指向已删除的参考树文件，补本地 HuaAnWork 等价路径 + 符号名。
- `docs/evidence/2026-10-29-single-desktop-phase-a.md:168`：provisioning 豁免描述会被误读为 CI smoke 在执行守卫；补“守卫由本地显式命令与 `check` job 覆盖”。
- `docs/upstream-sync.md:83`：“离线必然失败”过强；本地已有 `upstream/master` ref 时可离线工作。
- `.github/workflows/release.yml:5`：引用 `ci.yml:150-153` 已过期，改为当前 macOS job 行。

**验收**：每条数字/行号可在 HEAD 复现；不改变历史记录原意；证据提交只含文档。

## F6（P1）AA notices 版本刷新

**现状**：`dsh-plugin-huaanwork/THIRD_PARTY_NOTICES.md:11` 仍记 `2.1.0-desktop.c4b4f6e51bca0.r57f6b0fe`，当前 provenance 为 `c64c3f67ee3b2.r7f334f77`。该漂移早于本次改造，但本次 AA 刷新是自然修复点。

**范围/验收**：运行 `yarn workspace dsh-plugin-huaanwork verify:notices` 重新生成/校验；notices 版本与 `vendor/agents-anywhere/provenance.json` 一致；纳入下一次 AA/市场刷新检查。

## F7（P1）历史文件加“历史”标记

**现状**：
- `assets/app-icons.source.json:7-8,14-15,34-35`：仍指向三棵已删除树与退役 `icons:export`/`icons:check`；已在 triage 登记为历史，但建议加显式 marker 或注明不可执行。
- `plans/lock-advanced-window-mode.md:20,29,49-50,59`：仍在指导已删除的 `verify-desktop-variants`/`check:desktop-variants`；建议加顶部历史横幅。

**验收**：不会被误当作当前可执行指引；不删除历史文件本身。

## F8（P2）用户文档仍描述已退役产品线

**现状**：
- `docs/user-guide.md:14,79,94` 及对应 `.en.md`：稳定版/Beta 命令、Beta 的“安装稳定版…”。
- `docs/faq.en.md:5,45` 及对应中文版：“current stable release”、上游 Release 链接。

**范围**：这是 pre-existing branding debt，计划未纳入活文档清单。需要先裁定：改写为 HuaAnWork 单产品，还是登记为命名残留债。不要机械替换历史身份。

**验收**：裁定记录 + 文档与单产品实际一致，或明确登记为债。

## F9（P3）Dashboard 硬化

**现状/范围**：
- `scripts/upstream-sync-dashboard.mjs:59`：`git diff-tree --name-only` 受 `core.quotePath` 影响，非 ASCII 路径会被转义并误入 `unwatched`；改用 `-z` 或 `-c core.quotePath=false`。
- `scripts/upstream-sync-dashboard.test.mjs:3`：未使用的 `readFileSync` 导入。
- `desktop-upstream.json` 未强制目录型 `watchedPaths` 以 `/` 结尾；建议在校验或测试中加约束。

**验收**：非 ASCII 路径测试覆盖正确分类；配置错误 fail-closed；dashboard 仍非门禁。

## F10（P3）架构门/配置断言补强

**范围**：
- 断言 `upstream.json` 顶层键集合恰为 `repository`/`activeChannel`/`marketPeerPolicy`/`channels`。
- `dsh-community-market/tests/contracts.spec.ts` 读了 `activeChannel` 但未断言其值为 `huaanwork`。
- `scripts/active-topology.test.mjs` 用九个精确文件名；增加 `scripts/*.reference.mjs` glob 断言，防止换名回归。
- `test:scripts` 已无“未覆盖的现有测试”（R9 已接入 policy/dashboard），但未来新增 `scripts/*.test.mjs` 不会自动进门禁；增加“每个 `scripts/*.test.mjs` 必须被某个 gate 引用”的守卫，或把 `test:scripts` 整体接入。
- `splitWorkflowJobs` 的报错文案仍写 `release.yml`；`desktop-linux` 只按名字精确断言；CI `check` job 的正面形状（含 `run: yarn check`、不含 Chromium）未钉。

**验收**：新增/改名测试或 job 时门禁能失败；无重复跑测试；不改变现有门禁语义。

## F11（P3）Connector `UV_INDEX` 弱断言

**现状**：`scripts/agents-anywhere-connector.test.mjs:132` 的 `assert.ok(!('UV_INDEX' in launched.env))` 在当前 fixture 下是构造性弱断言（fixture 本来就没有 `UV_INDEX`）。

**范围/验收**：在 fixture env 预置一个继承的 `UV_INDEX`，再断言被移除；断言真正覆盖 `withPackageIndexes` 的丢弃规则。

## F12（P3）`verify-profile-boot --onboarding` 静默 no-op

**现状**：Task 14 删除了唯一 import 后，`dsh-plugin-huaanwork/scripts/verify-profile-boot.mjs` 仍接受 `--onboarding` 但什么也不做。

**范围/验收**：未知 flag 直接报错，或从文档/调用面移除；传 `--onboarding` 要么明确失败，要么有明确替代路径。

## F13（P3）AA `main` 移动目标流程化

**现状**：`aa:check` 始终解析 AA `main` 最新提交；main 一前进，旧制品就会 fail-closed。当前归档制品为 `c64c3f67ee3b2`。

**范围/验收**：在发布清单写明“打包前若 AA main 已前进，先重跑 `aa:prepare-release` 并重跑 connector/aa 测试”，避免把 `aa:check` 红误判为回归。

---

## 已关闭 / 无需再开

- 三个参考树、退役脚本、旧 runtime lane 已物理删除，并有 `active-topology` 与 `package.spec.ts` 结构钉。
- AGENTS 中 `verify-desktop-variants.test.mjs` 活权威引用、`native-dialog-copy.ts:94/167` 行号、M9 alpha.1/0.2.0-rc.2 “仍保留”措辞已在 Task 14 订正。
- 首期货架的四个后续候选（`7b3cddd2fe`、`271cc526e4`、`2f6e721d47`、`779968651e`）已登记进 AGENTS 债表，需各自另立任务。
- `docs/upstream-sync.md` 的 `fixtureVersion: 2` 已随 Task 12 的 §§1-7 重写消失。
- `export-app-icons.mjs` 的 `icons:check` 提示随脚本删除消失。
- `scripts/vendored-runtime-policy.test.mjs` 与 `scripts/upstream-sync-dashboard.test.mjs` 已由 R9 接入 `test:architecture-gates`，不再是“未门禁”项。

## 边界

- 本清单不授权任何代码、依赖、版本、CI 或产品行为变更；F1/F2 需要独立计划或仓库设置操作。
- F8 需要产品裁定后才能改动用户文档。
- 所有后续任务完成时仍应遵守现有 fail-closed 纪律：不跳过 market/AA/runtime 校验、不手工拼装 lockfile、不 force-push、不自动发布。
