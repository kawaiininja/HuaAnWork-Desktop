# M9-A 桌面侧合并 upstream/master + vendor runtime 刷新(含 A1 删行 / cordis 升版)

> GitHub issue: [kawaiininja/HuaAnWork-Desktop#4](https://github.com/kawaiininja/HuaAnWork-Desktop/issues/4)
> Epic:[#3](./2026-10-17-m9-upstream-sync-epic.md) | 后续:[#5 M9-B](./2026-10-17-m9-b-runtime-patches-rc1.md)

## Context

Epic:M9 上游同步(#3)。本卡是第一步:把 fork 的 outer repo 合并到 upstream/master,钉子模组 rc.1,刷新 beta/huaanwork 的 vendored runtime,并处理两个硬阻断项(A1 删包、A3 cordis 错位)。不做本卡,后续 21 补丁重做(M9-B)没有构建产物可作靶子。

## Current State(2026-10-17 核实)

- merge-base `origin/master...upstream/master` = `ca52ce2cd9`;fork 侧独有 346 提交,上游侧 116 提交
- 预期冲突点 1:sidebar-browser 双份修复——fork PR #1(`dsh-desktop-next/scripts/verify-sidebar-browser.mjs` 补 no-op `attachInput`)vs 上游 `75ad518423`(pass attachInput disposer),同一根因两种写法
- 预期冲突点 2:CI 矩阵 hunk(fork 三格矩阵含 `dsh-plugin-huaanwork`,历史口径 6 类 × 28 文件,本轮还会涨)
- 子模组 pin `5badb15009`(alpha.1)→ 目标 `1600d8a1e14`(dsh-v0.2.1-rc.1)
- driver 行:beta `dsh-plugin-desktop-beta/package.json:279`、huaanwork `dsh-plugin-huaanwork/package.json:329` 各有 `"@deepseek-ai/dsh-subagent-in-process-driver": "0.2.1-alpha.1"`;desktop `:278`(0.2.0-rc.2)与 next `:164` 保留(R-M9-2)
- cordis 家族四包钉 `4.0.5-alpha.1` 系;rc.1 vendor 全面 `-alpha.2` 系(cordis 4.0.5-alpha.2、group 1.0.5-α.2、include 1.0.10-α.2、loader 1.0.6-α.2、timer 1.1.7-α.2、cosmokit 1.8.6-α.2)

## Proposed Change

1. 建独立 worktree(参照 M8 `HuaAnWork-Desktop-sync` 先例)
2. 合并 `upstream/master` → fork,逐冲突消解并把每处取舍记录落 `docs/evidence/`(sidebar-browser 建议裁定:保留上游写法,fork PR #1 的 no-op 被上游 disposer 版覆盖;CI 矩阵保留 fork 三格)
3. 子模组 pin → `1600d8a1e14`,**单独一个提交**,无其他文件混入
4. A1(R-M9-2):删 beta、huaanwork 两行 driver 依赖;desktop/next 不动
5. A3:cordis 家族五包 + cosmokit 外层钉版升 `-alpha.2` 系;`dsh-community-market` peers 区间同步
6. `corepack yarn upstream:prepare-runtime`(install→build:official→pack:dsh)验证上游侧可打包(rc.1 起含 on-demand bundle 前置校验)
7. `node scripts/sync-vendored-runtime.mjs --write --channel beta` 及 huaanwork:生成 `vendor/dsh-runtime/0.2.1-rc.1/`、改写根 resolutions 与四包 dsh 依赖版本;**注意**:此时 `patches/` 仍全是 `@0.2.1-alpha.1.patch`,sync 会静默按无补丁解析——这是预期中间态,补丁重做是 M9-B,本卡 DoD 不含补丁层
8. `check:vendored-runtime` 绿

## Acceptance Criteria

1. worktree 内 `git merge-base --is-ancestor upstream/master HEAD` 为真;冲突消解记录落 `docs/evidence/2026-10-m9-merge-decisions.md`(每个冲突 hunk 一行:文件、两侧写法、取舍、理由)
2. pin 提交只含 `deepseek-harness` gitlink 一行改动(`git show --stat` 验证)
3. `grep -c 'dsh-subagent-in-process-driver' dsh-plugin-desktop-beta/package.json dsh-plugin-huaanwork/package.json` = 0;`dsh-plugin-desktop/package.json` 与 `dsh-desktop-next/package.json` 的行保留
4. cordis 家族钉版与 rc.1 vendor manifest 一致;`corepack yarn install --immutable` 后 `yarn why @deepseek-ai/cordis` 单份
5. `vendor/dsh-runtime/0.2.1-rc.1/` 存在且 `check:vendored-runtime` 绿(beta/huaanwork/stable 三通道)
6. 合并后 `corepack yarn typecheck` 在补丁缺失中间态下的失败清单落记录(预期有 fallout,交给 M9-B 消;失败清单本身不挡本卡)
7. 每条验证命令报告命令原文 + 退出码 + 关键输出行;未跑过的命令不得出现在报告里

## Testing Plan

| Layer | What | Count |
|-------------|------------------------------------|-------|
| Gate | `check:vendored-runtime`、`check:desktop-variants`、`verify-layout` | 各 1 跑 |
| Install | `corepack yarn install --immutable` + cordis 单份检查 | 1 跑 |
| 记录 | 冲突消解表、typecheck fallout 清单 | 2 份工件 |

## Rollback Plan

worktree 整支丢弃;已进 master 的部分按提交逆序 revert(pin 提交独立,可单独 revert)。

## Effort Estimate

3–5 人日(合并冲突 1–2 + A1/A3 0.5 + prepare-runtime/sync 1 + 验证与记录 1–1.5)。

## Out of Scope

- 21 个补丁重做(M9-B)
- 补丁缺失导致的 typecheck/test 失败修复(记录即可,M9-B 消)
- stable 通道 vendor(0.2.0-rc.2 不动)

## Related

- Epic:#3;后续:#5
- 处置清单 §5:`docs/evidence/2026-10-17-runtime-patches-alpha5-disposition.md`
- M8 合并先例:`docs/evidence/2026-10-m8-merge-decisions.md`、`2026-10-m8-merge-spike-refresh.md`
