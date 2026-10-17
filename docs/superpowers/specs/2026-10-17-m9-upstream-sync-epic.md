# M9 上游同步:钉 dsh-v0.2.1-rc.1、vendor runtime 刷新与 21 补丁重做(Epic)

> GitHub issue:[kawaiininja/HuaAnWork-Desktop#3](https://github.com/kawaiininja/HuaAnWork-Desktop/issues/3)
> 跟踪壳 issue:#4(M9-A)、#5(M9-B)、#6(M9-C)——仅作逐卡跟踪与 /ship 自动 Closes 用,**文档单一真相源是本文**,三卡独有内容已并入「阶段明细」三节
> 状态:2026-10-17 已确认草稿(/spec Phase 4);外部质量门 codex 不可用,建议 GLM 复审;2026-10-17 文档结构裁定:4 文档并为 1 份(方案 B)

## Context

M8(2026-10-10 收口)后 upstream(anywhere-labs/dsh-desktop)又推进 **116 提交**(2026-10-08→10-17,速率 ≈13/天);子模组 `deepseek-harness` 从当前 pin 的 alpha.1 到 rc.1 跨越 4 个 alpha(1646 提交)。`patches/` 下 21 个 Desktop 兼容补丁全部钉死 `@0.2.1-alpha.1`,升级后 `scripts/sync-vendored-runtime.mjs` **静默回落为无补丁解析**(check 模式亦不报错),整个 Desktop compatibility patch 层会无声丢失。M9 已于 2026-10-17 立项,四项裁定 R-M9-1…R-M9-4 落 `AGENTS.md` 债表「上游新一轮落后」行。

受影响方:内网 HuaAnWork 桌面用户(运行时行为与补丁层能力)+ fork 维护团队(窗口越大合并越贵)。

## Current State(2026-10-17 核实)

| 项 | 现状 | 证据 |
|---|---|---|
| 子模组 pin | `5badb15009`(dsh-v0.2.1-alpha.1) | `git submodule status` |
| vendored runtime | `vendor/dsh-runtime/0.2.1-alpha.1/`,321 包 | manifest |
| 补丁 | `patches/` 21 个 `*@0.2.1-alpha.1.patch` | `docs/evidence/2026-10-17-runtime-patches-alpha5-disposition.md` |
| driver 行 | desktop `package.json:278`(0.2.0-rc.2)、beta `:279`、huaanwork `:329`、next `:164`(0.2.1-alpha.1) | grep 实测 |
| cordis 钉版 | `4.0.5-alpha.1` 系,公网 npm 解析,不受 vendored runtime 约束 | 四包 package.json |
| outer repo 落后 | merge-base `ca52ce2cd9`,落后 116 提交(75 非合并) | `git rev-list --left-right --count` |
| rc.1 目标 | `1600d8a1e14` = alpha.5 + 4 提交/355 文件纯版本号行 | tag 实测 |

## Proposed Change(R-M9-1 范围)

在独立 worktree 上:合并 `upstream/master` → fork;子模组 pin → `dsh-v0.2.1-rc.1`(**单独一个提交**);beta/huaanwork vendor runtime 刷新;A1 删行(R-M9-2);cordis 家族升 `-alpha.2` 系;21 补丁按处置清单重做;#12(optionalBundles)/#17(sandbox-windows-acl)登记为「与上游明示取向相左」的永久 fork 差。

## Out of Scope

- stable 通道:钉 0.2.0-rc.2,driver 行与 vendor 均不动
- `dsh-desktop-next`:本轮不升 runtime,driver 行保留
- A10 托盘图标修复:独立缺陷行(R-M9-4:不挡开工、挡收口)
- A20–A28 环境阻塞项(凭据/Windows 主机/旧树/7 天等待/内网机)
- Windows 制品校验(已有独立债行)、dshmarket 刷新(随构建自动)

## 阶段划分

| 阶段 | 跟踪 issue | 内容 | 人日 | 依赖 |
|---|---|---|---|---|
| M9-A | #4 | 桌面侧合并 + vendor runtime 刷新(含 A1 删行 / cordis 升版) | 3–5 | — |
| M9-B | #5 | 21 个兼容补丁 rc.1 重做 | 7–9 | A |
| M9-C | #6 | 验证链 + 新制品 A1–A19 重跑与收口 | 3–5 | B |

```
M9-A ──> M9-B ──> M9-C
```

顺序理由:补丁打在 vendor 构建产物上,A 不完成 B 无靶子;C 的制品必须含 B 的补丁层,否则 A1–A19 白跑。

## 阶段明细:M9-A(合并 + vendor 刷新,跟踪 #4)

**预期冲突点**:① sidebar-browser 双份修复——fork PR #1(`verify-sidebar-browser.mjs` 补 no-op `attachInput`)vs 上游 `75ad518423`(pass attachInput disposer),同一根因两种写法,建议裁定保留上游写法;② CI 矩阵 hunk(fork 三格矩阵含 `dsh-plugin-huaanwork`,历史口径 6 类 × 28 文件,本轮还会涨)。

**步骤**:① 建独立 worktree(参照 M8 `HuaAnWork-Desktop-sync` 先例)→ ② 合并 `upstream/master`,逐冲突消解并逐 hunk 记录(文件、两侧写法、取舍、理由)→ ③ 子模组 pin → `1600d8a1e14`,单独一个提交 → ④ A1:删 beta、huaanwork 两行 driver 依赖(desktop/next 不动)→ ⑤ A3:cordis 五包 + cosmokit 升 `-alpha.2` 系(cordis 4.0.5-alpha.2、group 1.0.5-α.2、include 1.0.10-α.2、loader 1.0.6-α.2、timer 1.1.7-α.2、cosmokit 1.8.6-α.2),`dsh-community-market` peers 区间同步 → ⑥ `corepack yarn upstream:prepare-runtime` 验证上游侧可打包(rc.1 起含 on-demand bundle 前置校验)→ ⑦ `sync-vendored-runtime --write`(beta + huaanwork)→ ⑧ `check:vendored-runtime` 绿。**预期中间态**:⑦之后 `patches/` 仍全是 `@0.2.1-alpha.1.patch`,sync 按无补丁解析——这是设计内的,补丁重做是 M9-B。

**验收**:merge-base 祖先检查为真;冲突消解记录落 `docs/evidence/2026-10-m9-merge-decisions.md`;pin 提交 `git show --stat` 只含 gitlink 一行;beta/huaanwork driver 行 `grep -c` = 0、desktop/next 保留;cordis `yarn why` 单份;`check:vendored-runtime` 三通道绿;补丁缺失中间态的 `typecheck` 失败清单落记录(不挡本卡,交 M9-B 消)。

**回滚**:worktree 整支丢弃;已进 master 按提交逆序 revert(pin 提交独立)。

## 阶段明细:M9-B(21 补丁重做,跟踪 #5)

**权威依据**:`docs/evidence/2026-10-17-runtime-patches-alpha5-disposition.md`(GLM 三轮评审订正后版本)。21/21 需重做、0 吸收、0 放弃;难度 16 小/3 中/2 中-大。rc.1 = alpha.5 + 版本号行,清单结论成立,动手时以 rc.1 构建产物为最终对照。

**顺序**:先 2 个中-大(plugin-manager、settings-account)→ dsh 核心 + hmr + ptc → 16 小批量过。每个补丁:在 rc.1 vendor 产物上重打 → 核对清单「备注」栏陷阱 → 命名 `*@0.2.1-rc.1.patch` 并删旧 alpha.1 文件 → 每批跑 `check:vendored-runtime` + 受影响包测试。

**关键陷阱(逐条必须核对)**:dsh-hmr 补 `hasEsmCache` 空值守卫 + 类型放宽(`mainJob()` 前置解引用);dsh-ptc-runtime-node `index.ts:224-227` 与 `persistent.ts:192-196` **两现场同补**;dsh 核心 `ProfileContext` 全 readonly,新字段写 `readonly readPatches?`;settings-shell 以 `order: 40` 为基底;host-directory-picker-browse 保留既有 abort 重抛;plugin-manager 隐藏集合挂上游新 more/official 过滤链;settings-account 锚点全搬迁、ctx 回退需改签名。**R-M9-3(已裁定)**:directory-picker-browse(#4)继续 bridge;#10 browse host 补丁保留。

**验收**:`*@0.2.1-rc.1.patch` = 21、`*@0.2.1-alpha.1.patch` = 0;sync `--check` 绿且 21 补丁逐条列出实际命中(非静默跳过);清单 21 行逐条销号(重打完成+证据 / 裁定替换+记录);两个中-大各附「上游新结构 → 补丁映射」说明落 `docs/evidence/`;hmr 守卫与 ptc 双现场 grep 证据;#12/#17 永久 fork 差登记落盘;`typecheck`/`test` 转绿(M9-A fallout 清单逐条消除或经裁定转移)。

**回滚**:补丁粒度——删单个 rc.1 patch 即回退该补丁。

## 阶段明细:M9-C(验证与收口,跟踪 #6)

**关键裁定(R-M9-4)**:托盘 A10(macOS 26 模板图零渲染)**不挡开工、挡收口**;仍不通过时单独决定能否发,结论写入债表托盘行。2026-10-07 的 A1–A19 旧记录(17 通过、A10 不通过、A19 负例通过)在制品换过后全部作废,须在新制品上重跑。

**步骤**:① 无头验证链 `install --immutable` → `check` → `typecheck` → `test` → ② 真机冒烟四项:登录凭据优先级反转(stored > env)、市场重复安装改 `already-installed` 报错语义、迁移幂等对 rc.1 persistence 新增 7 项、`verify-profile-boot.mjs` 断言与 guardrails 锁 → ③ 构建并安装新制品(macOS)→ ④ A1–A19 重跑(人机混合),记录落 `docs/huaanwork-m9-human-verification-<date>.md` → ⑤ A10 单独裁决 → ⑥ 推送 + CI 对账(按 M8 Phase 6 先例,落 `docs/evidence/2026-10-m9-ci-reconciliation.md`)。

**验收**:四条无头命令全绿(命令原文 + 退出码 + 关键输出);四项冒烟各有结论 + 证据;A1–A19 记录落盘(通过/不通过/阻塞 + 证据);推送 SHA 与 CI 逐格对账落盘;债表 M9 行推进为收口(或「除 A10 外挂起」附裁决);R-M9-4 遵守声明。

**回滚**:按失败层回退(补丁级 → vendor 级 → 合并级);已推送按提交逆序 revert。

## Definition of Done

1. `origin/master` 含 `upstream/master`(基点 ≥ `2e7a9a44d9`),冲突消解记录落 `docs/evidence/`
2. 子模组 pin = `1600d8a1e14`,独立提交,无其他文件混入
3. beta/huaanwork `package.json` 无 `dsh-subagent-in-process-driver` 行;desktop/next 行保留(全仓 `grep -c` = 2)
4. `vendor/dsh-runtime/0.2.1-rc.1/` 建立,`check:vendored-runtime` 绿
5. cordis 家族外层钉版 = rc.1 vendor 版本,安装结果单份 cordis
6. `patches/` 21 个 `*@0.2.1-rc.1.patch` 落地(或经裁定替换),sync 无静默回落
7. `corepack yarn check` / `typecheck` / `test` 全绿
8. #12/#17 永久 fork 差登记落盘
9. 新制品 A1–A19 重跑记录落盘(本机、人机混合);A10 单独裁决,结论写入债表托盘行
10. R-M9-4 遵守:全程未先修 A10

## Rules for the implementing agent

1. Acceptance criteria are the `protects / fails_when / no_claim` profile of each test: the observable it protects, the wrong result it rejects, and what green does not prove. Never "make the tests pass".
2. Real code and real tests land in the same change; a placeholder, a stub assertion or a test deferred to a follow-up is not done.
3. Any change to a test, validator, CI step, timeout, tolerance, threshold, snapshot or suppression pragma is reported on its own line in your summary with its justification, before any other result.
4. A reported command names the command and its observed result (exit status, counts, the failing line); a command you did not run is not reported, and stderr is never silenced in a command you cite.
5. Your report is a claim until the parent re-executes it: say what you verified, what you reused, and what you could not check.

## Rollback Plan

worktree 整支丢弃;pin 提交单独 revert。vendor/ 与 patches/ 的变更不进 master 前均可放弃;进 master 后按提交逆序 revert(pin 提交独立,回滚干净)。

## Effort Estimate

13–19 人日(A 3–5 + B 7–9 + C 3–5),缓冲至 M8 级 15–25。

## Files Reference

| File | Change |
|------|--------|
| `upstream.json` | beta/huaanwork 通道 commit → rc.1 |
| `deepseek-harness/`(gitlink) | pin `5badb15009` → `1600d8a1e14`,单独提交 |
| `vendor/dsh-runtime/0.2.1-rc.1/` | 新建(sync 脚本产出) |
| `patches/` | 21 个 `*@0.2.1-alpha.1.patch` → `*@0.2.1-rc.1.patch` 重做 |
| `dsh-plugin-desktop-beta/package.json:279` | 删 driver 行 |
| `dsh-plugin-huaanwork/package.json:329` | 删 driver 行 |
| 四包 `package.json` cordis 钉版 | `4.0.5-alpha.1` 系 → `-alpha.2` 系 |
| `dsh-community-market` peers 区间 | `"4.0.4 \|\| 4.0.5-alpha.1"` 同步升版 |
| `AGENTS.md` 债表 | #12/#17 永久 fork 差登记;M9 行状态推进 |

## Related

- 处置清单:`docs/evidence/2026-10-17-runtime-patches-alpha5-disposition.md`(GLM 三轮评审订正后版本)
- M8 先例:`docs/evidence/2026-10-m8-push.md`、`docs/evidence/2026-10-m8-ci-reconciliation.md`、`docs/evidence/2026-10-m8-merge-decisions.md`
- 裁定原文:`AGENTS.md` 债表「上游新一轮落后」行 R-M9-1…R-M9-4
- M4 核对基线:`docs/huaanwork-m4-human-verification-2026-10-07.md`
