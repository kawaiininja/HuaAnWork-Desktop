# 2026-10 M7 上游试 Merge 探测与 Hunk 级冲突报告 (M17.3 / M22)

> **声明：本 spike 不落地：主工作树零改动、无 merge 提交**。
> 所有探测操作均在隔离的临时 worktree 内完成，主工作树保持绝对干净，未产生任何实际代码合入。

---

## 1. 探测元数据与 As-Of 基准

- **执行时间窗口**：`2026-10-06T23:21:24.819Z` ～ `2026-10-06T23:21:28.917Z`（UTC）/ `2026-10-07T07:21:24+08:00`
- **执行环境**：临时 Worktree（`mkdtempSync`，前缀 `zz-m7-merge-spike-`）
- **探测命令**：`git merge --no-commit --no-ff upstream/master`
- **Target Ref**：`upstream/master`
- **Target Commit**：`a1ff68b2960753ab1f6c90565bf3d9e3f3b7ae91`（2026-10-03T17:44:59+08:00）
- **Fork HEAD**：`803211275310606903f8698c63f2f7c8e0640dc4`（2026-10-07T07:10:20+08:00）
- **Dynamic Merge-Base**：`a934d988610605078001d7c22bbaa2435cbeb385`（2026-09-18T09:10:55+08:00）
- **隔离还原证据**：
  - `preStatusLines`: 0
  - `postStatusLines`: 0
  - `preWorktreeCount`: 1
  - `postWorktreeCount`: 1
  - `.git/worktrees/` 残留目录数: 0

---

## 2. 冲突总览与六类标签统计

试 merge 过程中，Git 共在 **28 个文件** 中报告冲突，展开为 **63 处 Hunk**。
依据实施计划规定的 6 类标签口径，统计分布如下：

| 分类标签 | 含义与 M8 处置策略 | 实测 Hunk 数量 |
|---|---|---|
| `take-upstream` | 上游侧改动，fork 无实质增量；M8 直接采用上游版本 | **2** |
| `replay-fork` | fork 侧有实质增量，上游同区演进；M8 需以最新上游为基底重放 fork 增量配置（绝不逐行手合） | **22** |
| `fork-owned-override` | 属于 `docs/upstream-sync.md` §6 列出的永久 fork-owned 文件；M8 整体保留 fork 版并坚决压制上游覆盖 | **5** |
| `modify-delete` | 一侧删除、另一侧修改；需逐条裁定处置 | **0** |
| `matrix-preserve` | CI 矩阵与包矩阵断言；合并时保留 fork 侧三格矩阵（包含 `dsh-plugin-huaanwork`） | **4** |
| `needs-ruling` | 内核/运行时逻辑与更新链路分叉；必须交由 M8 计划逐条裁定，构成 15–25 人日工作量的主要不确定项 | **30** |
| **总计 (Total)** | **全量冲突面** | **63** |

---

## 3. `needs-ruling` 待裁定冲突逐条清单（共 30 处）

下列 30 处 Hunk 是 M8 大同步（15–25 人日）中「huaanwork 对新内核适配 5–10 人日」的主要不确定性来源，必须随 M8 计划逐项裁决：

1. `.github/workflows/ci.yml #1`：
   - HEAD: R-M7-8 smoke 路径显式豁免环境变量 `HUAANWORK_ALLOW_UNPROVISIONED_SMOKE: '1'`
   - UPSTREAM: `DSH_MAC_SMOKE_ARCH` 条件判定（PR 仅打包 arm64，master 打包 universal）
2. `dsh-plugin-desktop-beta/src/electron-runtime.ts #1`：
   - HEAD: `downloadAndOpen` 传参 `expectedSha256`（D-M6-23 通道记录摘要）
   - UPSTREAM: `downloadAndOpen` 传参 `installerSha256`（上游自研更新摘要）
3. `dsh-plugin-desktop-beta/src/electron-runtime.ts #2`：
   - HEAD: 类型 `expectedSha256?: Readonly<Record<string, string>>`
   - UPSTREAM: 类型 `installerSha256?: Readonly<Partial<Record<'win32' | 'darwin', string>>>`
4. `dsh-plugin-desktop-beta/src/notifications.ts #1`：
   - HEAD: import `DESKTOP_PRODUCT_NAME`（Task 3.2 文案解耦）
   - UPSTREAM: import `observeDesktopJobOutcomes, type DesktopJobOutcome`（上游任务状态流）
5. `dsh-plugin-desktop-beta/src/notifications.ts #2`：
   - HEAD: `job-failed` 英文文案使用 `${DESKTOP_PRODUCT_NAME}` 模板
   - UPSTREAM: `job-failed` 英文文案硬编码 `DSH Desktop`
6. `dsh-plugin-desktop-beta/src/notifications.ts #3`：
   - HEAD: `job-failed` 中文文案使用 `${DESKTOP_PRODUCT_NAME}` 模板
   - UPSTREAM: `job-failed` 中文文案硬编码 `DSH Desktop`
7. `dsh-plugin-desktop-beta/src/recovery-copy.ts #1`：
   - HEAD: `confirmRollbackBody` 英文文案参数化
   - UPSTREAM: `confirmRollbackBody` 英文文案上游演进版本
8. `dsh-plugin-desktop-beta/src/recovery-copy.ts #2`：
   - HEAD: `confirmRollbackBody` 中文文案使用 `${DESKTOP_PRODUCT_NAME}`
   - UPSTREAM: `confirmRollbackBody` 中文文案上游新增插件状态恢复描述
9. `dsh-plugin-desktop-beta/src/runtime.ts #1`：
   - HEAD: `expectedSha256` JSDoc 注释
   - UPSTREAM: `installerSha256` JSDoc 注释
10. `dsh-plugin-desktop-beta/src/update-checker.ts #1`：
    - HEAD: 声明 `sha256?: Readonly<Record<string, string>>` 字段
    - UPSTREAM: 上游改写检查器返回类型
11. `dsh-plugin-desktop-beta/src/update-checker.ts #2`：
    - HEAD: 透传 `sha256: latest.sha256`
    - UPSTREAM: 透传 `installerSha256: digests`
12. `dsh-plugin-desktop-beta/src/update-lifecycle.ts #1`：
    - HEAD: D-M6-23 平台 sha256 贯穿
    - UPSTREAM: 上游 digest 贯穿与缺省保护
13. `dsh-plugin-desktop/src/electron-runtime.ts #1`：
    - 同 beta #1（三包同形同步面）
14. `dsh-plugin-desktop/src/electron-runtime.ts #2`：
    - 同 beta #2（三包同形同步面）
15. `dsh-plugin-desktop/src/notifications.ts #1`：
    - 同 beta #1（三包同形同步面）
16. `dsh-plugin-desktop/src/notifications.ts #2`：
    - 同 beta #2（三包同形同步面）
17. `dsh-plugin-desktop/src/notifications.ts #3`：
    - 同 beta #3（三包同形同步面）
18. `dsh-plugin-desktop/src/recovery-copy.ts #1`：
    - 同 beta #1（三包同形同步面）
19. `dsh-plugin-desktop/src/recovery-copy.ts #2`：
    - 同 beta #2（三包同形同步面）
20. `dsh-plugin-desktop/src/runtime.ts #1`：
    - 同 beta #1（三包同形同步面）
21. `dsh-plugin-desktop/src/update-checker.ts #1`：
    - 同 beta #1（三包同形同步面）
22. `dsh-plugin-desktop/src/update-checker.ts #2`：
    - 同 beta #2（三包同形同步面）
23. `dsh-plugin-desktop/src/update-lifecycle.ts #1`：
    - 同 beta #1（三包同形同步面）
24. `dsh-plugin-desktop/tests/updates.spec.ts #1`：
    - HEAD: 测试用例打桩 `expectedSha256`
    - UPSTREAM: 上游测试用例传参改动
25. `dsh-plugin-desktop/tests/updates.spec.ts #2`：
    - HEAD: 测试 D-M6-23 sha256 pins 透传
    - UPSTREAM: 测试上游 installer digests 透传
26. `scripts/prepare-agents-anywhere-release.mjs #1`：
    - HEAD: AA release 脚本支持三变体（包含 huaanwork）
    - UPSTREAM: 上游 AA release 重构依赖范围解析
27. `scripts/prepare-agents-anywhere-release.mjs #2`：
    - HEAD: peerRanges values 集合计算
    - UPSTREAM: 上游读取 runtime peer ranges 函数调用
28. `scripts/prepare-agents-anywhere-release.mjs #3`：
    - HEAD: `desktopPackagePaths`
    - UPSTREAM: `AA_WORKSPACES.map(...)`
29. `scripts/sync-vendored-runtime.mjs #1`：
    - HEAD: 保留空实现
    - UPSTREAM: 上游 `otherChannel = channel === 'stable' ? 'beta' : 'stable'`
30. `vendor/agents-anywhere/provenance.json #1`：
    - HEAD: submodule commit `3e269a46a8...`
    - UPSTREAM: submodule commit `7df5b31f3f...`

---

## 4. 与 Task 6.2 三个重叠口径的对照解释

Task 6.2 的只读看板脚本基于 `git diff --name-only <mergeBase> <upstreamRef>` 评估了潜在被上游触及的文件，与本 spike 实际测得的 Git 三方合并冲突面的对照与差异原因如下：

1. **白名单面（Scope A）**：
   - 看板计算：分母 36，命中 21。
   - 实际冲突：涉及白名单的 21 个文件中，仅 6 个文件在同区发生三方冲突（`electron-runtime.ts`、`notifications.ts`、`recovery-copy.ts`、`runtime.ts`、`update-checker.ts`、`verify-desktop-variants.mjs`）。
   - **差异原因**：看板口径统计的是「上游改过的白名单文件」，而 Git 三方合并只在两端修改了**相同代码行或重叠区域**时才会产生冲突 hunk。其余 15 个文件上游改动与 fork 改动处于完全不相交的函数或代码段，Git 实现了无冲突自动合入。
2. **三包同形面（Scope B）**：
   - 看板计算：分母 162，命中 45。
   - 实际冲突：45 个文件中仅 6 个文件发生真实冲突（共 10 处 hunk）。
   - **差异原因**：其余 39 个三包同形文件在 fork 侧从未被单独修改过（两端完全基于公共 merge-base 演进），Git 执行了单向的 Fast-forward 内容应用，未发生对撞。发生冲突的 6 个文件（如 `update-checker.ts`、`electron-runtime.ts`）恰好是 fork 侧为了承载 D-M6-23 更新验签与文案解耦而实质修改的公共核心。
3. **永久 Override 面（Scope C）**：
   - 看板计算：分母 8，命中 3。
   - 实际冲突：3 个文件全部产生冲突（共 9 处 hunk：`verify-desktop-variants.mjs` 3 处、两个 `package.spec.ts` 各 3 处）。
   - **差异原因**：吻合度 100%。上游大幅重写了 `verify-desktop-variants.mjs` 并修改了两个 package.spec.ts，而 fork 维护着全量门禁逻辑，属于典型的结构性对撞。M8 必须对这 3 个文件整体保留 fork 版本并彻底压制上游。

---

## 5. P21 冲突项核验与 Hunk 3（CI 矩阵）状态

对架构债表 `AGENTS.md:49` 登记的 P21 进行逐条实测核验：

1. **Hunk 1 & 2（`package.spec.ts` 跨边界读取与根脚本断言）**：
   - `dsh-plugin-desktop/tests/package.spec.ts` 与 `dsh-plugin-desktop-beta/tests/package.spec.ts` 中，各自 1 处测试根命令 `readFileSync` 的断言发生冲突（上游加入了 `dsh-desktop-next` 或修改了命令断言）。
2. **Hunk 3（CI 矩阵 `workspace: [...]`）**：
   - 在两个 `package.spec.ts` 中各有 2 处断言（windowsJob 与 macosJob 矩阵）对撞（合计 4 处 hunk，归入 `matrix-preserve`）。
   - **关键状态说明**：在 `.github/workflows/ci.yml` 的实际工作流文件中，`:121`（windows 矩阵）与 `:162`（macos 矩阵）**早已包含** `dsh-plugin-huaanwork`。
   - **消解动作定性**：合并时并非在 CI 矩阵中「新增」huaanwork，而是**保留 fork 侧已有的三格矩阵**，严防误取上游版本导致 huaanwork 从发版矩阵中悄然消失而测试虚假全绿。

---

## 6. Phase 1/4 新增冲突面的实测核验

1. **`scripts/verify-desktop-variants.mjs`**：
   - Task 1.2 导出了 `PAIRS`，Task 1.3 扩大了 stable↔beta 基线守卫。上游将该文件极简缩减至 36 行并引入了 `normalizeIdentity`。实测产生 3 处 hunk 对撞，分类为 `fork-owned-override`。
2. **`scripts/market-manifest-byte-budget.json` 与其跨边界读者**：
   - Task 4.1 新增该 fixture，上游无该文件（Git 无冲突）。
   - 其 4 处读者中，`market-server/src/manifest-prepare.ts` 和 `dsh-plugin-huaanwork/tests/huaanwork-host/market-verify.spec.ts` 均位于 fork 专有包中，上游无对侧文件，**零冲突**；另两个 `package.spec.ts` 的冲突已如实归入 P21。
3. **`dsh-plugin-desktop/package.json` 的 `x64ArchFiles`**：
   - Task 0.3 将其修复为 10 条白名单条目。
   - 上游在此期间演进并加入了 `@dataiku/uv-darwin-*/**`，使得上游列表扩充为 11 项。
   - 实测在 `package.json #2` 产生冲突，分类为 `replay-fork`（M8 需合并两者的白名单集合）。
4. **stable/beta README 版本字符串（Task 5.1 / M28）**：
   - 上游在 `README.md` 中有演进修改。
   - 因为 Task 5.1 严格执行了 M28 纪律（未在 fork 侧修改 stable/beta README 中的版本串），Git 对其顺利自动合并，**未产生人工冲突**，证实了 M28 决策的有效性。
