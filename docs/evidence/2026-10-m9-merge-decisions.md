# 2026-10 M9 上游重同步 — 冲突逐 Hunk 消解决策记录

> 依据 M9 Epic 规划与实施计划 Task 2，记录合并 `upstream/master`（commit `44084bdae0`）的过程、As-Of 基线度量数据、冲突逐 hunk 决策与消解理由，以及 Next 冻结通道依赖行恢复留痕（plan-review P1）。

---

## 1. As-Of 基线数据（Task 1 / Task 2 实测）

- **工作区路径**：`/Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop-sync-m9`
- **分支**：`sync/upstream-2.1.x`
- **评估时刻 (As-Of)**：2026-10-17
- **Fork 基线 HEAD**：`3434147880`（`3434147880120eb91bd3f51fbe4d05ae0f5bc1b7`）
- **合并目标 (upstream/master)**：`44084bdae0`（`44084bdae0d44cac56948a223048d9c31541d0d0`，2026-10-17 14:14:45 +0800，`chore(ci,test): prune obsolete tests and cache packaging downloads (#1399)`）
- **动态解析 MERGE_BASE**：`ca52ce2cd9`（`ca52ce2cd9ac872358e9a9464902e3c7ee4d494f`，2026-10-08 12:44:38 +0800）
- **落后提交量**：`git rev-list --count 3434147880..44084bdae0` = **119 提交**（非合并提交 `git rev-list --no-merges --count` = **77 提交**）
- **子模组 pin 跃迁**：
  - 合并提交（本任务产物）：`5badb15009` → `1517a4dbca`（`dsh-v0.2.1-alpha.5`，上游 pin）
  - 目标 rc.1 pin（Task 3 单独提交）：`1517a4dbca` → `1600d8a1e14`（`dsh-v0.2.1-rc.1`）
- **合并提交 SHA**：`78efd755aa`
- **Next 依赖通道恢复提交 SHA**：`e95c3ef912`

---

## 2. 冲突分类与逐 Hunk 消解决策表

合并过程触发冲突的文件共 15 个，消解策略严格遵循 Global Constraints §6、裁定 R-M9-1…R-M9-4 以及 plan-review P1 规定：

| # | 冲突文件 | 冲突主题 / Hunk | HEAD (Fork) 写法 | 44084bdae0 (Upstream) 写法 | 取舍 | 决策理由与处置细节 |
|---|---|---|---|---|---|---|
| 1 | `dsh-desktop-next/scripts/verify-sidebar-browser.mjs` | sidebar-browser 退出与异常守卫 | 监听 `render-process-gone`，注释 Production 传递 attachGuest，`guests.bind(window, () => () => {})` | 进程级捕获 `child-process-gone` 与 `uncaughtException` 并记日志退出，同为 `guests.bind(window, () => () => {})` | `theirs` (上游) | 平凡冲突。上游吸收了 PR #1 根因修复（空回调避免访客 dom-ready 抛未捕获 TypeError），且补充了进程级异常与子进程退出兜底，完全覆盖 fork 需求。 |
| 2 | `.github/workflows/ci.yml` (Hunk 1) | Next 验证步骤组织 | 串行执行 `verify:window-controls`、`verify:onboarding`、`verify:protocol`、`verify:sidebar-browser` 及独立日志上传 | 使用 `scripts/run-parallel.mjs` 并行执行上述 4 项验证，统一管理子进程 | `theirs` (上游) | 并行化脚本结构更紧凑，显著缩短 CI 运行时间，xvfb 环境参数均已正确配置。 |
| 3 | `.github/workflows/ci.yml` (Hunk 2) | `desktop-windows` 构建矩阵 | `workspace: [dsh-plugin-desktop, dsh-plugin-desktop-beta, dsh-plugin-huaanwork]` | `workspace: ${{ github.event_name == 'pull_request' && fromJSON('["dsh-plugin-desktop-beta"]') \|\| fromJSON('["dsh-plugin-desktop", "dsh-plugin-desktop-beta"]') }}` | `ours` (保留 fork 三格) | **严防静默脱落**：上游无 huaanwork 变体；若采上游选择子会让 huaanwork 从 Windows 发版/冒烟矩阵中消失而 CI 仍虚假全绿。 |
| 4 | `.github/workflows/ci.yml` (Hunk 3) | `desktop-macos` 构建矩阵 | `workspace: [dsh-plugin-desktop, dsh-plugin-desktop-beta, dsh-plugin-huaanwork]` | 同 Hunk 2，上游仅含 desktop / beta | `ours` (保留 fork 三格) | 同 Hunk 2，保留 huaanwork 在 macOS 产物打包与冒烟测试中的席位。 |
| 5 | `.gitignore` | 忽略规则新增 | 包含 `.worktrees/`、`market-server/keys/`（M5 离线签名私钥）、`WindowsApp/` | 包含 `dsh-desktop-next/.desktop-build/`、`dsh-plugin-desktop/.desktop-build/`、`dsh-plugin-desktop-beta/.desktop-build/` | `union` (并集) | 规则不互斥，合并双方条目，兼顾上游构建临时目录忽略与内网市场私钥防泄漏安全门禁。 |
| 6 | `.yarn/patches/dshmarket-desktop.patch` | 市场桌面兼容补丁重基线 | 针对 `dshmarket@1.66.22` 的行号与 hunk 上下文 | 上游针对 `dshmarket@1.66.28` 重新生成的补丁文件 | `theirs` (上游) | 上游已将 dshmarket 刷新至 1.66.28 并完成补丁重基线，fork 无分叉补丁逻辑，直接同步新基线补丁。 |
| 7 | `scripts/agents-anywhere-connector.test.mjs` | AA 桥切片注释 | 中文注释阐述 wellFormedJson 移入 types 区域 | 英文注释解释 types 承载 JSON helpers 与 lone-surrogate 归一化 | `theirs` (上游) | 代码切片逻辑逐字相同，上游英文注释为上游原厂表述。 |
| 8 | `vendor/agents-anywhere/provenance.json` | AA 桥制品版本与 Provenance | 钉 `2.1.0-desktop.c58d98da25a23.r7190cf39`，接受 peer `0.2.0-rc.2 \|\| 0.2.1-alpha.1` | 钉 `2.1.0-desktop.c58d98da25a23.r144209ac`，接受 peer `0.2.0-rc.2 \|\| 0.2.1-alpha.5` | `theirs` (上游) | 官方 AA 桥新构建产物 `r144209ac.tgz` 已随上游合并进入 `vendor/agents-anywhere/`，更新 provenance 记录。 |
| 9 | `dsh-plugin-desktop/scripts/verify-profile-boot.mjs` | AA 桥 endpoint 验证逻辑 | 仅断言 per-user endpoint 文件存在 | 新增 `agentsAnywhereRuntime` 状态为 `'ready'` 校验，且断言 endpoint 中的 pid 与当前进程一致（防运行中实例碰撞） | `theirs` (上游) | 上游吸收并大幅增强了 fork 原有的 endpoint 校验，有效防止孤儿进程/多开碰撞导致的偶发挂起。 |
| 10 | `dsh-plugin-desktop-beta/scripts/verify-profile-boot.mjs` | 同 #9 | 同 #9 | 同 #9 | `theirs` (上游) | 同 #9。同时保持 stable↔beta 在本脚本上的同形与允许差异。 |
| 11 | `dsh-plugin-desktop/tests/package.spec.ts` | 根脚本断言与 CI 矩阵断言 (§6 永久 override) | 跨边界读取 `expected-root-gate-scripts.json`，断言三变体 CI 矩阵 `workspace: [desktop, beta, huaanwork]` | 上游断言动态 matrixSelector，未感知 huaanwork 变体与根门禁 fixture | `ours` (保留 fork 侧) | **§6 永久 Override 文件**：必须压制上游，保障跨包单一真相源门禁与 huaanwork CI 覆盖断言不失效。 |
| 12 | `dsh-plugin-desktop-beta/tests/package.spec.ts` | 同 #11 (§6 永久 override) | 同 #11 | 同 #11 | `ours` (保留 fork 侧) | **§6 永久 Override 文件**：同 #11。 |
| 13 | `dsh-plugin-desktop/package.json` | 依赖版本升级 | `dshmarket: 1.66.22`，AA 桥 `r7190cf39` | `dshmarket: 1.66.28`，AA 桥 `r144209ac` | `theirs` (上游) | 纯依赖行升级，无 fork 专有改动，与上游主线对齐。 |
| 14 | `dsh-plugin-desktop-beta/package.json` | 依赖版本升级及 DSH 依赖通道 | `dshmarket: 1.66.22`，AA 桥 `r7190cf39`，DSH `@0.2.1-alpha.1` | `dshmarket: 1.66.28`，AA 桥 `r144209ac`，DSH `@0.2.1-alpha.5`，删除了已废弃的 driver 行 | `theirs` (上游) | 接受上游合并形态；beta 的 DSH 依赖暂时推进到 alpha.5（符合设计内中间态，Task 8 `--write` 自愈为 vendored rc.1）。 |
| 15 | `dsh-desktop-next/package.json` | Next 依赖行升级与通道漂移 | DSH 依赖严格冻结于 `@0.2.1-alpha.1` | DSH 依赖推进到 `@0.2.1-alpha.5`，删除 driver 行，并新增 17 个 lane 依赖 | `theirs` → `Step 5 显式恢复` | 合并暂取上游，随后在 Step 5 立即按 plan-review P1 恢复为冻结的 alpha.1 依赖行，并将 17 个未包含在 alpha.1 中的上游新增依赖移除。 |
| 16 | `package.json` (根目录) | Workspaces、Scripts 与 Resolutions 重放 | 12 个 workspaces，全套 fork 门禁 scripts，两套 DSH resolutions (rc.2 + alpha.1) | 5 个 workspaces，上游紧缩 scripts，两套 DSH resolutions (rc.2 + alpha.5) | `重放 fork 增量` | **严禁三方手工合并**。以 44084bdae0 为基底：1) 恢复 7 个 fork workspaces；2) 恢复 fork 全部门禁与构建脚本（保留上游新增的 `test:inspector-compat`）；3) 清除上游 `alpha.5` resolutions，重放 master 中的全部 642 条 `alpha.1` resolutions，保留 stable `rc.2`（636 条）与新版 patches。 |
| 17 | `yarn.lock` | 锁文件整体重解 | 合并产生全量文本冲突 | 合并产生全量文本冲突 | `yarn install 重生` | 依赖定义与 resolutions 调整完毕后，由 `corepack yarn install` 可变重解生成，并通过 `--immutable` 严格验证。 |

---

## 3. Step 5: Next 冻结通道依赖行恢复留痕（plan-review P1）

根据 M9 实施计划，`dsh-desktop-next` 作为实验性 shell，其运行时强绑定于 `dsh@0.2.1-alpha.1` 及其配套 21 个补丁，**严禁随合并静默升级至 alpha.5**。

### 恢复操作输出
- **Restored Lane Dependencies**: **162 项**（包含 dependencies 中 159 项 DSH/Cordis/Schemastery 依赖及 `@deepseek-ai/dsh-subagent-in-process-driver: 0.2.1-alpha.1` 恢复，devDependencies 中 3 项恢复）。
- **Removed Upstream-Added Dependencies**: **17 项**（上游在 alpha.2~alpha.5 窗口引入，但在 alpha.1 中不存在的包；若保留会导致 npm alpha.5 依赖泄入 next 闭包）：
  1. `@deepseek-ai/dsh-api-remote-access`
  2. `@deepseek-ai/dsh-client-ui-secret-mask`
  3. `@deepseek-ai/dsh-experimental-badge-skill-bundle`
  4. `@deepseek-ai/dsh-experimental-cot-translation-bundle`
  5. `@deepseek-ai/dsh-experimental-inspector`
  6. `@deepseek-ai/dsh-experimental-plugin-market-bundle`
  7. `@deepseek-ai/dsh-experimental-ralph-bundle`
  8. `@deepseek-ai/dsh-experimental-session-search`
  9. `@deepseek-ai/dsh-experimental-session-titles-bundle`
  10. `@deepseek-ai/dsh-experimental-terminal-bundle`
  11. `@deepseek-ai/dsh-experimental-tool-worktree`
  12. `@deepseek-ai/dsh-experimental-translator`
  13. `@deepseek-ai/dsh-experimental-worktree`
  14. `@deepseek-ai/dsh-harness-dev-context`
  15. `@deepseek-ai/dsh-skill-office`
  16. `@deepseek-ai/dsh-tool-workspace-dependencies`
  17. `@deepseek-ai/dsh-working-directory`

独立提交记录：`e95c3ef912 chore(next): restore frozen alpha.1 dependency lane after upstream merge (plan-review P1)`。

---

## 4. 验证与门禁核验证据

1. **Submodule Gitlink 验证**：
   - 合并提交 `78efd755aa`：`git ls-tree 78efd755aa deepseek-harness` 输出 `160000 commit 1517a4dbca0a2789ff1d41ba439600f8547d23fa deepseek-harness`（完全符合预期，第一跳到 alpha.5，不破坏历史拓扑）。
   - HEAD `e95c3ef912`：`git ls-tree HEAD deepseek-harness` 保持 `1517a4dbca0a2789ff1d41ba439600f8547d23fa`。
2. **Yarn 锁文件终检**：
   - `corepack yarn install --immutable` 运行返回 0，无任何锁文件漂移与解法冲突。
3. **根脚本一致性门禁**：
   - `node --test scripts/expected-root-gate-scripts.test.mjs` → `pass 1, fail 0`（断言 root package.json 的 build / typecheck / test / check 与 fixture 逐字吻合）。

---

## 5. M9-A 验收核查与 Vendored Runtime 落地证据 (Task 8)

### 5.1 验收项核查结果

1. **上游提交祖先关系**：
   - `git merge-base --is-ancestor 44084bdae0 HEAD` 返回 0 (`MERGE-OK`)，证实上游 master 提交 `44084bdae0` 已完整合并进分支。
2. **Submodule pin 独立提交**：
   - `git show --stat 800fa2f370` 仅包含 1 个文件改动（`deepseek-harness | 2 +-`，pin 至 `1600d8a1e1` 即 `dsh-v0.2.1-rc.1`）。
3. **Driver 废弃包清理状态**：
   - `grep -c 'dsh-subagent-in-process-driver'` 实测：
     - `dsh-plugin-desktop`: 1（stable 维持 0.2.0-rc.2）
     - `dsh-plugin-desktop-beta`: 0（上游 0.2.1-rc.1 已清理）
     - `dsh-plugin-huaanwork`: 0（Task 5/6 裁定 R-M9-2 清理）
     - `dsh-desktop-next`: 1（维持冻结 alpha.1 通道）
4. **Vendored Runtime 存续**：
   - `vendor/dsh-runtime/0.2.1-alpha.1/manifest.json`：存在（Next 独立通道）
   - `vendor/dsh-runtime/0.2.1-rc.1/manifest.json`：成功创建并打包 341 个 tarballs
5. **Market DSH peer 范围**：
   - `grep -c '"0\.2\.0-rc\.2 || 0\.2\.1-rc\.1 || 0\.2\.1-alpha\.1"' dsh-community-market/package.json` 返回 44 处匹配，覆盖所有 44 个 DSH peer 依赖。
6. **Vendored Runtime 三通道校验**：
   - `corepack yarn check:vendored-runtime` 全绿：
     - `stable 318 packages from 639ed01539 are verified`
     - `beta 341 packages from 1600d8a1e1 are verified`
     - `huaanwork 341 packages from 1600d8a1e1 are verified`
7. **Resolutions 完好性**：
   - alpha.1 对应的 642 条 resolutions 全部放回，确保 Next 依赖解析不受影响。
   - `@deepseek-ai/schemastery@npm:^3.18.5-alpha.1: 3.18.5` 保持在位。

---

## 6. M9-A fallout (交 M9-B)

在 M9-A 完成 runtime 升级和 resolutions 对齐后，由于 0.2.1-rc.1 运行时尚未打补丁（M9-B 任务），工作区 typecheck 暴露出的类型错误作为 M9-B 的输入清单记录如下：

### 6.1 各 Workspace Typecheck 状态概览

| 工作区 | 退出码 | 错误数 / 状态 | 归因说明 |
|---|---|---|---|
| `dsh-plugin-desktop` | 0 | 通过 | 运行于 stable 0.2.0-rc.2 runtime，不受 rc.1 升级影响 |
| `dsh-plugin-desktop-beta` | 2 | 10 处错误（2 文件） | unpatched 0.2.1-rc.1 runtime 客户端 slots 与 onboarding 类型漂移 |
| `dsh-plugin-huaanwork` | 2 | 12 处错误（6 文件） | unpatched 0.2.1-rc.1 API / 签名漂移（port 可空、present-as 类型、sessionPersistence） |
| `dsh-community-market` | 0 | 通过 | 自身类型检查通过（编译后输出 contracts d.ts） |
| `dsh-desktop-next` | 2 | 4 处错误（4 文件） | packaging 脚本 era-mismatch（依赖已从 next 依赖清单移除的 alpha.2+ 包） |
| `market-server` | 0 | 通过 | 依赖 `dsh-community-market` build 产物，契约类型对齐后全绿 |
| `update-server` | 0 | 通过 | 独立服务，全绿 |

### 6.2 详细错误分类与定位清单

#### 1. `dsh-plugin-desktop-beta` (10 errors, tsconfig.tests.client.json)
- **`src/client/desktop-settings.ts:118-119`**:
  - TS2345 / TS2769: Argument of type `'plugins.bundle.hidden'` is not assignable to slot parameter type.
- **`src/client/onboarding.tsx:9, 19, 20, 24`**:
  - TS2344 / TS2345 / TS2769: Type `'onboarding.desktop.before'` does not satisfy slot constraint.
  - TS2339: Properties `renderNavigation`, `renderSurface`, `renderLoading`, `renderNext`, `accountStatus`, `openLogin` do not exist on type `GlobalStandardProps & ...`.

#### 2. `dsh-plugin-huaanwork` (12 errors in 6 files)
- **`src/host-bootstrap.ts:225`**:
  - TS2345: Argument of type `number | undefined` is not assignable to parameter of type `number` (`desktopLoopbackBrowserUrl(hostCtx.webServer.port)`).
- **`src/huaanwork-guardrails/present-as.ts:93`**:
  - TS2367: Unintentional comparison because types `'native'` and `'both'` have no overlap (`mode === "ptc" || mode === "both"`).
- **`src/index.ts:204, 459`**:
  - TS2345: `ctx.webServer.port` has type `number | undefined`, expected `number`.
- **`src/main.ts:1838`**:
  - TS2345: `hostCtx.webServer.port` has type `number | undefined`, expected `number`.
- **`src/packaged-runtime-smoke.ts:48, 60, 73, 79`**:
  - TS2339: Property `'default'` does not exist on module `@deepseek-ai/dsh-session-persistence-jsonl`.
  - TS2339: Property `'sessionPersistence'` does not exist on type `'Context'`.
- **`src/profile-context.ts:27, 60`**:
  - TS2353: Object literal may only specify known properties, and `'resolvePackageManifest'` does not exist in type `'ProfileContext'`.
  - TS7006: Parameters `'packageName'` and `'profilePatches'` implicitly have `'any'` type.

#### 3. `dsh-desktop-next` (4 errors in 4 packaging scripts)
- **`scripts/prepare-runtime.ts(6,92)`**, **`scripts/primary-runtime.ts(12,112)`**, **`scripts/sign-runtime.ts(7,65)`**, **`scripts/verify-mac-runtime.ts(4,42)`**:
  - TS2307: `Cannot find module '@deepseek-ai/dsh-tool-workspace-dependencies' or its corresponding type declarations.`
  - **根因**：上游在 alpha.2~alpha.5 期间将 packaging 脚本重构为引入 `@deepseek-ai/dsh-tool-workspace-dependencies`。但在 Step 5 按 plan-review P1 将 next 的依赖通道冻结回 alpha.1 时，由于该包在 alpha.1 不存在，从 dependencies 中移除了该包，导致 packaging tsconfig（`tsconfig.packaging.json`）无法解析该模块。需在 M9-B 处理 next packaging 脚本的兼容性或提供对应的桩/适配。

