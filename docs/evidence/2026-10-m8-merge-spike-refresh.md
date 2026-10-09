# 2026-10 M8 上游试 Merge 探测与冲突清单刷新报告 (Task 0.2)

> **声明：本 spike 不落地：主工作树零改动、无 merge 提交**。
> 所有探测操作均在隔离的临时 worktree 内完成，主工作树保持绝对干净，未产生任何实际代码合入。

---

## 1. 探测元数据与 As-Of 基准

- **执行时间窗口**：`2026-10-09T01:05:06.936Z` ～ `2026-10-09T01:05:11.214Z`（UTC）/ `2026-10-09T09:05:06+08:00`
- **执行环境**：临时 Worktree（`mkdtempSync`，前缀 `zz-m7-merge-spike-`）
- **探测命令**：`git merge --no-commit --no-ff upstream/master`
- **Target Ref**：`upstream/master`
- **Target Commit**：`ca52ce2cd9ac872358e9a9464902e3c7ee4d494f`（2026-10-08T12:44:38+08:00）
- **Fork HEAD**：`c5737e51eb08e358db208e6736f04a37fd36683a`（2026-10-09T09:02:47+08:00）
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
| `take-upstream` | 上游侧改动，fork 无实质增量；M8 直接采用上游版本（如第三方协议声明） | **2** |
| `replay-fork` | fork 侧有实质增量，上游同区演进；M8 需以最新上游为基底重放 fork 增量配置（绝不逐行手合） | **22** |
| `fork-owned-override` | 属于 `docs/upstream-sync.md` §6 列出的永久 fork-owned 文件；M8 整体保留 fork 版并坚决压制上游覆盖 | **5** |
| `modify-delete` | 一侧删除、另一侧修改；需逐条裁定处置 | **0** |
| `matrix-preserve` | CI 矩阵与包矩阵断言；合并时保留 fork 侧三格矩阵（包含 `dsh-plugin-huaanwork`） | **4** |
| `needs-ruling` | 内核/运行时逻辑与更新链路分叉；必须交由 M8 计划逐条裁定，构成 15–25 人日工作量的主要不确定项 | **30** |
| **总计 (Total)** | **全量冲突面** | **63** |

> **机械校验核验**：
> 六类分项之和：$2 (\text{take-upstream}) + 22 (\text{replay-fork}) + 5 (\text{fork-owned-override}) + 0 (\text{modify-delete}) + 4 (\text{matrix-preserve}) + 30 (\text{needs-ruling}) = 63$。
> 刷新清单总 Hunk 数与六类分项之和严格相等。

---

## 3. 全量冲突文件与分项清单（共 28 文件 / 63 Hunks）

### 3.1 `take-upstream`（共 2 处）
1. `dsh-plugin-desktop/THIRD_PARTY_NOTICES.md #1`：上游第三方依赖协议信息演进，fork 无专有修改，直接采用上游。
2. `dsh-plugin-desktop-beta/THIRD_PARTY_NOTICES.md #1`：同上，直接采用上游。

### 3.2 `replay-fork`（共 22 处）
1. `.gitignore #1`：上游忽略规则更新；fork 侧包含 `market-server`、构建缓存等忽略项。处置：以上游为基底，追加 fork 专属忽略规则（§7.9）。
2. `dsh-plugin-desktop-beta/package.json #1`：上游脚本及依赖升级；fork 侧包含专属脚本。处置：重放 fork 脚本配置。
3. `dsh-plugin-desktop/package.json #1`：上游依赖与脚本演进；处置：重放 fork 脚本配置。
4. `dsh-plugin-desktop/package.json #2`：打包白名单 `x64ArchFiles`；上游新增 `@dataiku/uv-darwin-*/**`，fork 包含 10 条白名单条目。处置：合并两端集合（并集重放）。
5. `package.json #1`：根 `scripts` 命令定义；处置：重放 fork 专有市场与桌面构建脚本。
6. `package.json #2`：`workspaces` 声明；上游包含 `dsh-desktop-next`，fork 包含 `dsh-plugin-huaanwork`、`packages/huaanwork-*`、`market-server` 等。处置：重放 fork 工作区列表。
7. `package.json #3`：根开发依赖与构建脚本；处置：重放 fork 依赖。
8. `package.json #4`：`dev:beta` 等启动指令；处置：重放 fork 管道指令。
9. `scripts/verify-layout.mjs #1`：读取 `huaanworkPlugin` 对比上游 `nextDesktop`；处置：上游基底 + fork 专属机制增量重放。
10. `scripts/verify-layout.mjs #2`：工作区列表校验；处置：重放 `packages/huaanwork-*` 及 huaanwork 插件校验。
11. `scripts/verify-layout.mjs #3`：Yarn 版本继承校验；处置：重放 huaanwork 插件项。
12. `scripts/verify-layout.mjs #4`：遗留 pnpm 锁文件校验；处置：重放 huaanwork 检查项。
13. `scripts/verify-layout.mjs #5`：依赖边界检查遍历；处置：重放 huaanwork desktop 检查。
14. `scripts/verify-layout.mjs #6`：终端输出与 Next 私有包断言；处置：重放三通道一致性输出与 huaanwork 守卫。
15. `yarn.lock #1`：`@agents-anywhere/dsh-bridge-next` 解析；处置：以最新上游基底重跑 `yarn install` 重建。
16. `yarn.lock #2`：`@deepseek-ai/cordis` 版本；处置：由 lockfile 自动重算。
17. `yarn.lock #3`：`@types/ws` 等类型包解析；处置：lockfile 自动重算。
18. `yarn.lock #4`：bridge-next 文件路径解析；处置：lockfile 自动重算。
19. `yarn.lock #5`：bridge-next 依赖解析；处置：lockfile 自动重算。
20. `yarn.lock #6`：`dsh-plugin-huaanwork` 工作区引用 vs 上游 `dshmarket` 依赖（上游已由 1.66.7 升级至 1.66.11）；处置：重放 fork 工作区依赖。
21. `yarn.lock #7`：`market-server` 工作区引用；处置：重放 fork 依赖。
22. `yarn.lock #8`：`update-server` 工作区引用；处置：重放 fork 依赖。

### 3.3 `fork-owned-override`（共 5 处）
1. `dsh-plugin-desktop/tests/package.spec.ts #1`：根 `readFileSync` 断言；处置：坚决保留 fork 侧断言，压制上游。
2. `dsh-plugin-desktop-beta/tests/package.spec.ts #1`：根 `readFileSync` 断言；处置：坚决保留 fork 侧断言，压制上游。
3. `scripts/verify-desktop-variants.mjs #1`：`PAIRS` 导出与 `oneSidedPaths` 声明；处置：坚决保留 fork 侧全量守卫逻辑，压制上游精简版。
4. `scripts/verify-desktop-variants.mjs #2`：`verifyDesktopVariants` 变体守卫函数；处置：保留 fork 完整校验。
5. `scripts/verify-desktop-variants.mjs #3`：变体检查输出与断言；处置：保留 fork 输出。

### 3.4 `modify-delete`（共 0 处）
- 无此类冲突。

### 3.5 `matrix-preserve`（共 4 处）
1. `dsh-plugin-desktop/tests/package.spec.ts #2`：Windows CI 矩阵断言；处置：保留包含 `dsh-plugin-huaanwork` 的三格矩阵断言。
2. `dsh-plugin-desktop/tests/package.spec.ts #3`：macOS CI 矩阵断言；处置：保留三格矩阵断言。
3. `dsh-plugin-desktop-beta/tests/package.spec.ts #2`：Windows CI 矩阵断言；处置：保留三格矩阵断言。
4. `dsh-plugin-desktop-beta/tests/package.spec.ts #3`：macOS CI 矩阵断言；处置：保留三格矩阵断言。

---

## 4. `needs-ruling` 待裁定冲突逐条清单（共 30 处）

下列 30 处 Hunk 是 M8 实施中需要逐项业务裁决的核心逻辑对撞点，包含 HEAD 与 UPSTREAM 两侧的代码摘要与裁定要点：

1. **`.github/workflows/ci.yml #1`**：
   - **HEAD**: `# R-M7-8:smoke 路径现在也跑 provisioning 守卫(与三条发行命令一致),但 CI 按环境变量豁免 HUAANWORK_ALLOW_UNPROVISIONED_SMOKE: '1'`
   - **UPSTREAM**: `# The universal merge alone takes 9-17 minutes, so pull requests ... DSH_MAC_SMOKE_ARCH`
   - **裁定要点**: 合并上游 PR 级 Mac 架构构建加速逻辑，同时保留 fork 侧 R-M7-8 smoke provisioning CI 豁免环境变量。

2. **`dsh-plugin-desktop-beta/src/electron-runtime.ts #1`**：
   - **HEAD**: `downloadAndOpen: (version, signal, channel, expectedSha256) => this.downloadAndOpenUpdate(version, signal, channel, expectedSha256)`
   - **UPSTREAM**: `downloadAndOpen: (version, signal, channel, installerSha256) => this.downloadAndOpenUpdate(version, signal, channel, installerSha256)`
   - **裁定要点**: 参数名对撞（`expectedSha256` vs `installerSha256`）；需统一运行时适配器接口命名规范。

3. **`dsh-plugin-desktop-beta/src/electron-runtime.ts #2`**：
   - **HEAD**: `expectedSha256?: Readonly<Record<string, string>>,`
   - **UPSTREAM**: `installerSha256?: Readonly<Partial<Record<'win32' | 'darwin', string>>>,`
   - **裁定要点**: 类型签名分歧；上游限定平台 key 为 `'win32' | 'darwin'`，fork 兼容全平台通道记法；需统一类型定义。

4. **`dsh-plugin-desktop-beta/src/notifications.ts #1`**：
   - **HEAD**: `import { DESKTOP_PRODUCT_NAME } from './product-identity.ts'`
   - **UPSTREAM**: `import { observeDesktopJobOutcomes, type DesktopJobOutcome } from './jobs-bridge.ts'`
   - **裁定要点**: 模块导入对撞；采纳上游 job 状态流导入，同时保留 fork 的产品名解耦模块导入。

5. **`dsh-plugin-desktop-beta/src/notifications.ts #2`**：
   - **HEAD**: `'job-failed': { title: 'Background Job Failed', body: \`A background job could not finish. Open \${DESKTOP_PRODUCT_NAME} for details.\` }`
   - **UPSTREAM**: `'job-failed': { title: 'Background Job Failed', body: 'A background job could not finish. Open DSH Desktop for details.' }`
   - **裁定要点**: 英文通知文案；采纳上游 job-failed 通知类型，但文案插值必须保留 fork 的 `${DESKTOP_PRODUCT_NAME}` 解耦。

6. **`dsh-plugin-desktop-beta/src/notifications.ts #3`**：
   - **HEAD**: `'job-failed': { title: '后台任务失败', body: \`一个后台任务未能完成，请打开 \${DESKTOP_PRODUCT_NAME} 查看详情。\` }`
   - **UPSTREAM**: `'job-failed': { title: '后台任务失败', body: '一个后台任务未能完成，请打开 DSH Desktop 查看详情。' }`
   - **裁定要点**: 中文通知文案；同样保留 `${DESKTOP_PRODUCT_NAME}` 产品名解耦。

7. **`dsh-plugin-desktop-beta/src/recovery-copy.ts #1`**：
   - **HEAD**: `confirmRollbackBody: capturedAt => \`This immediately restores the current Profile plus the checkpointed settings.yaml and...\``
   - **UPSTREAM**: `confirmRollbackBody: capturedAt => \`This immediately restores the current Profile plus the checkpointed settings.yaml and...\``
   - **裁定要点**: 英文回滚提示文案；上游演进了配置描述，需将上游新语义与 fork 的品牌参数化融合。

8. **`dsh-plugin-desktop-beta/src/recovery-copy.ts #2`**：
   - **HEAD**: `confirmRollbackBody: capturedAt => \`将立即恢复 \${capturedAt} 创建的检查点中的 Profile、共享设置文件 settings.yaml 与 DSH 数据目录补丁；重启后，\${DESKTOP_PRODUCT_NAME}...\``
   - **UPSTREAM**: `confirmRollbackBody: capturedAt => \`将立即恢复 \${capturedAt} 创建的检查点中的 Profile、共享设置文件 settings.yaml 与 DSH 数据目录补丁（包括插件的启用状态）；重启后...\``
   - **裁定要点**: 中文回滚提示；采纳上游新增的「（包括插件的启用状态）」语义，保留 `${DESKTOP_PRODUCT_NAME}`。

9. **`dsh-plugin-desktop-beta/src/runtime.ts #1`**：
   - **HEAD**: `/** Download and hand one confirmed update to the platform installer; \`expectedSha256\` carries the...`
   - **UPSTREAM**: `/** Download and hand one confirmed update to the platform installer; \`installerSha256\` carries...`
   - **裁定要点**: JSDoc 签名注释；与更新摘要参数命名保持一致。

10. **`dsh-plugin-desktop-beta/src/update-checker.ts #1`**：
    - **HEAD**: `readonly sha256?: Readonly<Record<string, string>>`
    - **UPSTREAM**: `/** Optional per-platform SHA256 digests... readonly installerSha256?: ...`
    - **裁定要点**: 更新检查器结果类型字段定义（`sha256` vs `installerSha256`）；裁定统一数据契约。

11. **`dsh-plugin-desktop-beta/src/update-checker.ts #2`**：
    - **HEAD**: `...(latest.sha256 === undefined ? {} : { sha256: latest.sha256 }),`
    - **UPSTREAM**: `...(digests === undefined ? {} : { installerSha256: digests }),`
    - **裁定要点**: 检查器返回值属性组装；同上保持契约一致。

12. **`dsh-plugin-desktop-beta/src/update-lifecycle.ts #1`**：
    - **HEAD**: `// D-M6-23: thread the confirmed channel record's per-platform sha256 pins into the adapter`
    - **UPSTREAM**: `// An omitted digest must not surface as a trailing undefined argument:`
    - **裁定要点**: 更新生命周期透传；结合上游对末尾 undefined 参数的安全保护与 fork 的平台 sha256 贯穿。

13. **`dsh-plugin-desktop/src/electron-runtime.ts #1`**：
    - **HEAD**: 同 beta #1（`downloadAndOpen` 参数名）
    - **UPSTREAM**: 同 beta #1
    - **裁定要点**: 三包同形面，与 beta #1 同步裁定。

14. **`dsh-plugin-desktop/src/electron-runtime.ts #2`**：
    - **HEAD**: 同 beta #2（类型签名）
    - **UPSTREAM**: 同 beta #2
    - **裁定要点**: 三包同形面，与 beta #2 同步裁定。

15. **`dsh-plugin-desktop/src/notifications.ts #1`**：
    - **HEAD**: 同 beta #1（import）
    - **UPSTREAM**: 同 beta #1
    - **裁定要点**: 三包同形面，与 beta #1 同步裁定。

16. **`dsh-plugin-desktop/src/notifications.ts #2`**：
    - **HEAD**: 同 beta #2（英文 job-failed 文案）
    - **UPSTREAM**: 同 beta #2
    - **裁定要点**: 三包同形面，与 beta #2 同步裁定。

17. **`dsh-plugin-desktop/src/notifications.ts #3`**：
    - **HEAD**: 同 beta #3（中文 job-failed 文案）
    - **UPSTREAM**: 同 beta #3
    - **裁定要点**: 三包同形面，与 beta #3 同步裁定。

18. **`dsh-plugin-desktop/src/recovery-copy.ts #1`**：
    - **HEAD**: 同 beta #1（英文回滚文案）
    - **UPSTREAM**: 同 beta #1
    - **裁定要点**: 三包同形面，与 beta #1 同步裁定。

19. **`dsh-plugin-desktop/src/recovery-copy.ts #2`**：
    - **HEAD**: 同 beta #2（中文回滚文案）
    - **UPSTREAM**: 同 beta #2
    - **裁定要点**: 三包同形面，与 beta #2 同步裁定。

20. **`dsh-plugin-desktop/src/runtime.ts #1`**：
    - **HEAD**: 同 beta #1（JSDoc 注释）
    - **UPSTREAM**: 同 beta #1
    - **裁定要点**: 三包同形面，与 beta #1 同步裁定。

21. **`dsh-plugin-desktop/src/update-checker.ts #1`**：
    - **HEAD**: 同 beta #1（检查器类型）
    - **UPSTREAM**: 同 beta #1
    - **裁定要点**: 三包同形面，与 beta #1 同步裁定。

22. **`dsh-plugin-desktop/src/update-checker.ts #2`**：
    - **HEAD**: 同 beta #2（检查器返回值字段）
    - **UPSTREAM**: 同 beta #2
    - **裁定要点**: 三包同形面，与 beta #2 同步裁定。

23. **`dsh-plugin-desktop/src/update-lifecycle.ts #1`**：
    - **HEAD**: 同 beta #1（透传生命周期）
    - **UPSTREAM**: 同 beta #1
    - **裁定要点**: 三包同形面，与 beta #1 同步裁定。

24. **`dsh-plugin-desktop/tests/updates.spec.ts #1`**：
    - **HEAD**: `readonly downloadAndOpen?: (version: string, signal: AbortSignal, channel?: 'stable' | 'beta', expectedSha256?: Readonly<Record<string, string>>)`
    - **UPSTREAM**: `readonly downloadAndOpen?: (version: string, signal: AbortSignal, channel?: 'stable' | 'beta', installerSha256?: ...)`
    - **裁定要点**: 单元测试桩接口签名；与主代码统一参数命名及类型。

25. **`dsh-plugin-desktop/tests/updates.spec.ts #2`**：
    - **HEAD**: `it('threads the channel record sha256 pins into the adapter download (D-M6-23)', async () => {`
    - **UPSTREAM**: `it('passes the rechecked installer digests to the download adapter', async () => {`
    - **裁定要点**: 更新测试用例断言；同时覆盖上游 digest 传递和 fork 平台 sha256 pin 透传。

26. **`scripts/prepare-agents-anywhere-release.mjs #1`**：
    - **HEAD**: `// Desktop variant manifests pinning the vendored bridge (stable, beta, huaanwork);`
    - **UPSTREAM**: `// The official AA source does not publish its local yarn.lock. Its devDependencies`
    - **裁定要点**: 变体列表与 AA 发布处理注释；保留 huaanwork 变体定义。

27. **`scripts/prepare-agents-anywhere-release.mjs #2`**：
    - **HEAD**: `const values = new Map(peerPackages.map(name => [name, new Set()]))`
    - **UPSTREAM**: `return readRuntimePeerRanges(root)`
    - **裁定要点**: 依赖范围解析实现；采纳上游 `readRuntimePeerRanges` 函数封装，但其扫描范围需涵盖三变体。

28. **`scripts/prepare-agents-anywhere-release.mjs #3`**：
    - **HEAD**: `const packagePaths = desktopPackagePaths`
    - **UPSTREAM**: `const packagePaths = AA_WORKSPACES.map(workspace => \`\${workspace}/package.json\`)`
    - **裁定要点**: 目标工作区包路径集合；合并上游 `AA_WORKSPACES` 与 fork 的 huaanwork 变体路径。

29. **`scripts/sync-vendored-runtime.mjs #1`**：
    - **HEAD**: `(empty)`（空实现或未启用）
    - **UPSTREAM**: `const otherChannel = channel === 'stable' ? 'beta' : 'stable'`
    - **裁定要点**: 运行时同步脚本通道切换；裁定是否引入三通道（`stable` / `beta` / `huaanwork`）同步逻辑。

30. **`vendor/agents-anywhere/provenance.json #1`**：
    - **HEAD**: `"commit": "3e269a46a8322dcb9fc25913560f18826e6c508a"`
    - **UPSTREAM**: `"commit": "7df5b31f3fe23d4be92ccd5ae5e0aeb6a3744c0e"`
    - **裁定要点**: Agents-Anywhere 子模块上游提交推进；裁定 M8 是否整体升级 submodule 提交并重编译产物。

---

## 5. 与 As-Of 2026-10-06 基准的逐类对账

对账双方基准：
- **历史基准（2026-10-06 / M7 报告）**：上游 commit `a1ff68b296`，Fork HEAD `8032112753`，Merge-Base `a934d98861`。
- **当前刷新（2026-10-09 / M8 报告）**：上游 commit `ca52ce2cd9`，Fork HEAD `c5737e51eb`，Merge-Base `a934d98861`。

### 5.1 逐类 Hunk 数量增减对账表

| 分类标签 | 2026-10-06 基准 | 2026-10-09 刷新 | 净增减 ($\Delta$) | 变动说明 |
|---|---|---|---|---|
| `take-upstream` | 2 | 2 | 0 | 保持不变（两个第三方协议声明文件） |
| `replay-fork` | 22 | 22 | 0 | 数量持平；内部有 1 处语义演进（见下文 5.2） |
| `fork-owned-override` | 5 | 5 | 0 | 保持不变（变体守卫 3 处 + 两个 spec 根断言各 1 处） |
| `modify-delete` | 0 | 0 | 0 | 保持不变（零发生） |
| `matrix-preserve` | 4 | 4 | 0 | 保持不变（两个 spec CI 矩阵断言各 2 处） |
| `needs-ruling` | 30 | 30 | 0 | 保持不变（内核、文案、更新、AA 发布冲突面完全稳定） |
| **总计 (Total)** | **63** | **63** | **0** | **总冲突 Hunk 数保持 0 膨胀** |

### 5.2 内部变动登记（改动登记）
在上游净增 6 个提交（`a1ff68b2` $\to$ `ca52ce2cd9`）中，唯一对冲突 Hunk 内容产生实际行级变化的是上游 commit `9f4cd66370`（PR #1316 *update bundled Market to 1.66.11*）：
- **文件**：`yarn.lock`
- **Hunk**：第 6 处 Hunk
- **原基准（2026-10-06）**：上游首行为 `"dshmarket@npm:1.66.7":`
- **现刷新（2026-10-09）**：上游首行更新为 `"dshmarket@npm:1.66.11":`
- **分类属性**：仍归为 `replay-fork`，不影响分类标签分布，重放消解策略为重新运行 `yarn install` 重新解析依赖。

---

## 6. Fork 专属机制新冲突面显式归类与重放纪律（评审 B1 佐证义务）

评审实测指出：**上游演进会不断把 fork 专属校验文件拖进冲突面**。
典型代表即为 `scripts/verify-layout.mjs`：
- **上游重构版**：上游为了试验私有分支，引入了 `dsh-desktop-next` 包及其专属依赖和 private 属性校验，并移除了原先的部分通道检查，完全没有 `huaanwork` 概念。
- **Fork 现行版**：fork 版强制要求三通道（`stable`、`beta`、`huaanwork`）一致性，强制校验 `packages/huaanwork-policy`、`packages/huaanwork-model`、`packages/huaanwork-git-tools` 等 10 个工作区。

### 6.1 核心消解纪律
> **消解纪律 = 上游基底 + Fork 专属语义增量重放**
> **两严禁**：
> 1. **严禁整体采上游**：若盲目取上游，`huaanwork` 通道与全套 `packages/huaanwork-*` 门禁将彻底被抹杀，导致重大退化。
> 2. **严禁盲目保 fork 旧版**：若整体保 fork 旧版，将丢失上游引入的 Next 试验分支校验、子模块状态检查重构等基底升级，导致上游新架构机制失效。

### 6.2 关键文件的显式归类与重放要点登记

| 文件路径 | 冲突 Hunk 数 | 归类标签 | 重放要点（上游基底 + Fork 专属语义增量） |
|---|---|---|---|
| `scripts/verify-layout.mjs` | 6 | `replay-fork` | **Hunk 1**: 在上游读取 `nextDesktop` 之上，增量恢复读取 `huaanworkPlugin`；<br>**Hunk 2**: 在上游 workspaces 校验数组中，增量恢复 `dsh-plugin-huaanwork` 及三个 `packages/huaanwork-*` 工作区；<br>**Hunk 3**: 循环校验继承 root Yarn release 中增量纳入 huaanwork；<br>**Hunk 4**: legacy pnpm 文件校验中增量保留 huaanwork 的禁止检查；<br>**Hunk 5**: 边界检查数组增量保留 `['huaanwork desktop', huaanworkPlugin]`；<br>**Hunk 6**: 终端输出保留三通道与 upstream commit 一致性，同时并存 Next 私有包断言。 |
| `.gitignore` | 1 | `replay-fork` | 遵循 **§7.9 裁定**：采纳上游演进的全局忽略规则作为基底，增量重放 fork 专有的 `market-server/` 编译产物、本地调试临时目录及缓存忽略规则，严禁二选一覆盖。 |
| `dsh-plugin-desktop/package.json` (`x64ArchFiles`) | 1 (Hunk 2) | `replay-fork` | 遵循 **§7.9 裁定**：上游新将 `@dataiku/uv-darwin-*/**` 纳入白名单（扩展至 11 项）；fork 维护着 10 条严格架构白名单。重放时实行**集合并集合并（Union Replay）**，保留 fork 的 10 项白名单并纳准上游新加入的架构文件规则。 |
| `dsh-plugin-desktop/THIRD_PARTY_NOTICES.md` & `dsh-plugin-desktop-beta/THIRD_PARTY_NOTICES.md` | 各 1 | `take-upstream` | 遵循 **§7.9 裁定**：直接采纳上游更新版本；fork 侧对上游官方发行包无专有协议定制，huaanwork 变体的三方协议由专属打包流程独立生成。 |

---

## 7. Task 0.3 膨胀评估结论与放行判定

依据 M8 实施规范与架构门禁规则，Task 0.3 需对同步冲突膨胀情况进行严格的量化门禁评估：
- **触发回报重裁规则**：刷新后若 ① Hunk 总量较基准 63 增幅 > 20%（即 > 75.6），或 ② `needs-ruling` 较基准 30 新增 > 10（即 > 40），或 ③ 出现 `modify-delete` 类非零（> 0）—— 必须立即停表回报 R5 重裁人日与范围，未获重裁前严禁进入 Phase 1。
- **出口判定机制**：若三项指标均未超标，则出具未膨胀结论，正式放行进入 Phase 1。

### 7.1 三项核心阈值逐项核对表

| 评估指标 | 历史基准 (2026-10-06) | 实测读数 (2026-10-09) | 变动量 ($\Delta$) | 触发重裁阈值 | 判定结果 |
|---|---|---|---|---|---|
| **Hunk 总量** | 63 | 63 | 增幅 0% | 增幅 > 20% (总量 > 75.6) | **未超标** (安全) |
| **`needs-ruling` 数量** | 30 | 30 | 新增 0 | 新增 > 10 (总量 > 40) | **未超标** (安全) |
| **`modify-delete` 出现情况** | 0 | 0 | 0 | 出现非零 (> 0) | **未超标** (安全) |

*辅助指标参考*：冲突涉及文件数保持为 28，变动 $\Delta = 0$。

### 7.2 逐项读数核验明细

1. **Hunk 总量评估**：
   - 基准值：63
   - 实测读数：63
   - 增幅计算：$\frac{63 - 63}{63} \times 100\% = 0\%$
   - 阈值线：增幅 > 20%（对应阈值线 > 75.6 Hunks）
   - 结果：**未超标**。总冲突体量未发生任何扩增。

2. **`needs-ruling` 评估**：
   - 基准值：30
   - 实测读数：30
   - 新增量：$30 - 30 = 0$
   - 阈值线：新增 > 10（对应阈值线 > 40）
   - 结果：**未超标**。涉及核心架构、文案规范与发布体系的待裁定面完全稳定。

3. **`modify-delete` 评估**：
   - 实测读数：0
   - 阈值线：非零（$> 0$）
   - 结果：**未超标**。未发生任何“一方修改另一方删除”的破坏性冲突。

### 7.3 出口放行结论

> **评估结论：未膨胀。无需回报重裁，正式放行进入 Phase 1。**

本次上游刷新（上游推进 6 个提交至 `ca52ce2cd9`，Fork 推进 20 个提交至 `c5737e51eb`）冲突面完全收敛，所有冲突分类与 Hunk 分布与 2026-10-06 基准完全一致，未触发任何上浮熔断机制。本门禁评估正式关闭，研发团队可按计划无缝推进 Phase 1 的各项工作。
