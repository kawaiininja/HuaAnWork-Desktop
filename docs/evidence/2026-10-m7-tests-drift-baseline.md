# 2026-10 M7 三包 Tests 漂移基线分类与收敛规划报告 (M23)

> **声明：本 Task 不建守卫**。
> 依据管理层裁定 R-M7-7 与架构债表 `AGENTS.md:51`，M23 守卫延后，本轮仅批 2–3 人日开展**基线分类**与**收敛规划**，产出存量债务清单与最小可行方案设计。

---

## 1. 复跑基线数据与口径说明 (Step 1 对账)

- **评估时刻 (As-Of)**：`2026-10-06T23:34:31.720Z` (UTC) / `2026-10-07T07:34:31+08:00`
- **漂移统计口径**：`DRIFT = differ + onlyLeft + onlyRight`（与 Task 1.3 对 `scripts/` 的口径严格一致）。

### 实测复跑结果对照表

| 统计项 | 历史登记基线 (2026-10-03) | 裸文本比较实测值 | 守卫归一化比较实测值 | 差异与原因说明 |
|---|---|---|---|---|
| **stable ↔ beta tests/ 漂移** | 30 条 | **36 条** | **28 条** | 历史登记值（30）未注明是否经过 `normalize`。裸文本比较下，有 34 differ + 2 onlyLeft = 36 条；经 `PAIRS[0].normalize` 归一化包名与产品名后，有 8 个仅含标识符差异的测试对齐，实测收敛为 **26 differ + 2 onlyLeft = 28 条**。 |
| **beta ↔ huaanwork tests/ 漂移** | 41 条 | **105 条** | **105 条** | 从 41 增至 105 条，**增长 64 条**。完全由 M6/M7 在 Phase 2/3/4/5 的系列安全强化导致：为 huaanwork 专有测试新增了 `huaanwork-migration/session-v0-extension.spec.ts`、`release-smoke-guard.spec.ts`、`inprocess-gc-retention.spec.ts` 及一系列客户端认证测试，全部属合法单侧测试（onlyRight 从 22 增至 86）。 |
| **三包 tests/ 漂移总和** | 71 条 | **141 条** | **133 条** | 归一化口径下为 133 条（28 + 105）。 |
| **三包 package.json 行数** | 422 / 427 / 496 行 | **423 / 428 / 497 行** | - | 各增加 1 行（格式化尾换行/微调），结构与依赖集完全稳定。 |
| **跟踪的 lib/ 与 dist/ 产物** | 0 项 | **0 项** | - | 三包均无任何编译产物入库风险，正面证据稳固。 |

---

## 2. 四类分类统计与全量清单 (Step 2 & 3)

通过 `scripts/classify-variant-tests-drift.mjs` 对归一化后的 133 个漂移项进行逐项定性，分布如下：

- **`legit-one-sided`（合法单侧）**：**88 项**（stable 2 项，huaanwork 86 项）
- **`legit-divergent`（合法有意差异）**：**39 项**（stable↔beta 20 项，beta↔huaanwork 19 项）
- **`should-be-identical`（应同形但漂移，存量债务）**：**6 项**（全部分布在 stable↔beta）
- **`unclassifiable`（无法归类）**：**0 项**

### 2.1 `legit-one-sided`（合法单侧，共 88 项）
- **stable 独有（2 项）**：
  1. `windows-nsis-ab.spec.ts`：测试 stable 专有的 NSIS A/B 升级器逻辑。
  2. `launch-environment.spec.ts`：测试 stable 专有的启动环境参数。
- **huaanwork 独有（86 项）**：
  - `tests/client-huaanwork/*`（20 个测试）：企业级客户端认证路由、账号状态、UI 控制等。
  - `tests/huaanwork-host/*`（35 个测试）：华安专有市场鉴权、自动化调度、沙箱桥接、同进程 GC 留存测试等。
  - `tests/huaanwork-migration/*`（12 个测试）：旧 Tauri 数据向 Electron 目录的一次性迁移、帧协议回归及测试助手。
  - `tests/huaanwork-guardrails/*`（10 个测试）：企业合规与安全护栏。
  - `tests/` 根目录单侧 spec（9 个测试）：包含 Task 5.2 引入的 `release-smoke-guard.spec.ts` 等。
- **处置建议**：**不纳入常规双向同形比较**。未来建守卫时应通过 `oneSidedPrefixes` 隔离。

### 2.2 `legit-divergent`（合法有意差异，共 39 项）
- **stable ↔ beta（20 项）**：
  `bin.spec.ts`、`client-directory-picker-browse-patch.spec.ts`、`desktop-plugins.spec.ts`、`market-pnpm-integration.spec.ts`、`package.spec.ts`、`plugin.spec.ts`、`pnpm.spec.ts`、`profile-manager.spec.ts`、`profile.spec.ts`、`request-inventory-resolution.spec.ts`、`setup-wizard-settings.spec.ts`、`setup-wizard-state.spec.ts`、`startup-recovery-controller.spec.ts`、`update-checker.spec.ts`、`update-download.spec.ts`、`verify-electron-fuses.spec.ts`、`verify-mac-release.spec.ts`、`verify-mac-smoke.spec.ts`、`verify-win-installer.spec.ts`、`verify-win-portable.spec.ts`。
  - **差异原因**：基座内核版本差异（0.1.5-rc.2 vs 0.1.6-alpha.2）、Cordis 升级（patchReload 移除/hmr 接管）、通道标识（'stable' vs 'beta'）、安装包 slug 命名。
- **beta ↔ huaanwork（19 项）**：
  `desktop-channel-home.spec.ts`、`desktop-plugins.spec.ts`、`electron-runtime.spec.ts`、`host-runtime-bridge.spec.ts`、`installer-messages.spec.ts`、`package.spec.ts`、`plugin.spec.ts`、`profile-channel-admission.spec.ts`、`profile-checkpoint.spec.ts`、`profile-manager.spec.ts`、`profile.spec.ts`、`release-preflight.spec.ts`、`startup-recovery-controller.spec.ts`、`update-checker.spec.ts`、`update-download.spec.ts`、`verify-mac-release.spec.ts`、`verify-mac-smoke.spec.ts`、`verify-win-installer.spec.ts`、`verify-win-portable.spec.ts`。
  - **差异原因**：产品身份命名（`HuaAnWork`）、第四市场源提供者（`huaanwork-market`）、原生重启确认回传、用户目录隔离（`~/.huaanwork`）、发布构建参数。
- **处置建议**：**不纳入强制同形守卫**，逐条登记豁免理由。

---

## 3. `should-be-identical` 存量债务清单（核心交付）

本次分析在 `stable ↔ beta` 间精确筛选出 **6 项应同形但未对齐的存量债务**。
这 6 项差异是典型的「一处修改、漏改另一份」的历史遗留。在 Task 3.2 中，beta 与 huaanwork 侧重构了运行时文案并统一改用 `DESKTOP_PRODUCT_NAME` 常量，而 stable 侧对应测试保留了旧的字面量断言：

| 债务文件 | 差异行数 | 差异细节与成因 | 修复方案（纳入守卫前必修） |
|---|---|---|---|
| `desktop-copy.spec.ts` | 3 行 | beta 断言使用 ``${DESKTOP_PRODUCT_NAME} 2.1.0 已可用。``，stable 断言硬编码 `'DSH Desktop 2.1.0 已可用。'` | 在 stable 侧引入 `DESKTOP_PRODUCT_NAME`，使两端测试源码逐字相同。 |
| `electron-runtime.spec.ts` | 9 行 | beta 弹窗按键断言使用 ``Open ${DESKTOP_PRODUCT_NAME} Terminal``，stable 使用 `'Open DSH Terminal'` | 同步在 stable 引入常量模板，两端完全对齐。 |
| `notifications.spec.ts` | 9 行 | beta 任务失败通知文案读常量，stable 硬编码 `'DSH Desktop'` | 同步在 stable 引入常量模板。 |
| `profile-selection-window.spec.ts` | 5 行 | 重启对话框提示文案读常量 vs 硬编码 | 同步在 stable 引入常量模板。 |
| `startup-recovery-window.spec.ts` | 7 行 | 安全模式对话框提示文案读常量 vs 硬编码 | 同步在 stable 引入常量模板。 |
| `updates.spec.ts` | 21 行 | 更新弹窗标题与正文模板读常量 vs 硬编码 | 同步在 stable 引入常量模板。 |

> **关键价值**：
> 这 6 个文件在语义上没有任何分叉意图（stable 的 `DESKTOP_PRODUCT_NAME` 也是 `'DSH Desktop'`，使用模板后断言结果 100% 相同）。修齐这 6 个文件将直接消除 6 条无意义的跨通道认知负荷。

---

## 4. 最小可行守卫方案设计（给后续 M23 的移交输入）

未来若要在 `verify-desktop-variants.mjs` 中正式将 `tests/` 纳入守卫，需具备以下前置条件与最小可行方案：

1. **守卫架构限制修复（Task 1.3 发现）**：
   - 当前守卫的 `oneSidedPrefixes`（`verify-desktop-variants.mjs:180-181`）在底层逻辑上**仅支持单侧位于 right 端**（即「beta 相对 stable 独有」或「huaanwork 相对 beta 独有」）。
   - 实测 stable 端拥有 `launch-environment.spec.ts` 与 `windows-nsis-ab.spec.ts` 两个**仅存在于 left 端**的文件。如果直接把 `tests` 加入 `dirs`，守卫会因无法声明 left-sided 而直接报错变红。
   - **必需的机制扩展**：必须先在守卫中支持 `oneSidedLeftPaths` 或 `oneSidedLeftPrefixes` 机制。
2. **逐步纳入推进策略**：
   - **第 1 阶段**：先修复上述 6 个 `should-be-identical` 存量文件，使其在 stable 与 beta 间逐字节对齐。
   - **第 2 阶段**：在 `PAIRS[1]`（beta ↔ huaanwork）率先将 `tests` 纳入 `dirs`，并在 `oneSidedPrefixes` 中注册 `tests/client-huaanwork/`、`tests/huaanwork-`、`tests/release-smoke-guard.spec.ts` 等前缀。此阶段不存在 left-sided 阻碍，可行性最高。
   - **第 3 阶段**：扩展守卫支持 left-sided 后，再在 `PAIRS[0]`（stable ↔ beta）纳入 `tests`，并登记 20 项合法有意差异。
