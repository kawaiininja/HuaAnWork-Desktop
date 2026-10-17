# M9 上游同步:钉 dsh-v0.2.1-rc.1、vendor runtime 刷新与 21 补丁重做(Epic)

> GitHub issue: [kawaiininja/HuaAnWork-Desktop#3](https://github.com/kawaiininja/HuaAnWork-Desktop/issues/3)
> 子卡:[#4 M9-A](./2026-10-17-m9-a-merge-and-vendor-refresh.md)、[#5 M9-B](./2026-10-17-m9-b-runtime-patches-rc1.md)、[#6 M9-C](./2026-10-17-m9-c-verification-and-acceptance.md)
> 状态:2026-10-17 已确认草稿(/spec Phase 4);外部质量门 codex 不可用,建议 GLM 复审

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

## Child Issues

| # | 标题 | 人日 | 依赖 |
|---|---|---|---|
| M9-A(#4) | 桌面侧合并 + vendor runtime 刷新(含 A1 删行 / cordis 升版) | 3–5 | — |
| M9-B(#5) | 21 个兼容补丁 rc.1 重做 | 7–9 | A |
| M9-C(#6) | 验证链 + 新制品 A1–A19 重跑与收口 | 3–5 | B |

```
M9-A ──> M9-B ──> M9-C
```

顺序理由:补丁打在 vendor 构建产物上,A 不完成 B 无靶子;C 的制品必须含 B 的补丁层,否则 A1–A19 白跑。

## Definition of Done

1. `origin/master` 含 `upstream/master`(基点 ≥ `2e7a9a44d9`),冲突消解记录落 `docs/evidence/`(预期冲突:sidebar-browser 双份修复 fork PR #1 vs 上游 `75ad518423`、CI 矩阵 hunk)
2. 子模组 pin = `1600d8a1e14`,独立提交,无其他文件混入
3. beta/huaanwork `package.json` 无 `dsh-subagent-in-process-driver` 行;desktop/next 行保留(全仓 `grep -c` = 2)
4. `vendor/dsh-runtime/0.2.1-rc.1/` 建立,`check:vendored-runtime` 绿
5. cordis 家族外层钉版 = rc.1 vendor 版本,安装结果单份 cordis(无双份单例)
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
- M8 先例:`docs/evidence/2026-10-m8-push.md`、`docs/evidence/2026-10-m8-ci-reconciliation.md`
- 裁定原文:`AGENTS.md` 债表「上游新一轮落后」行 R-M9-1…R-M9-4
