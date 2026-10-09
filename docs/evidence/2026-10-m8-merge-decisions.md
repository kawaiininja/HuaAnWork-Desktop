# 2026-10 M8 上游重同步 — 消解决策表

> Phase 2 消解留痕（Global Constraint §5）。本文件由 **Task 2.5** 创建，仅登记
> **A 组（更新链 digest 语义，14 hunks）** 与 **E2⑤ 观察**。其余 49 hunks 由
> **Task 2.9** 回填全表，本文件不代偿。
>
> - 分支：`sync/upstream-2.0.x`，worktree `../HuaAnWork-Desktop-sync`
> - 基准 HEAD（as-of 2026-10-09）：`fbdf834185`
> - MERGE_BASE（动态解析，禁硬编码）：`git merge-base origin/master HEAD` → `8cd74f5e9b`（as-of）
> - 本任务改动文件：`dsh-plugin-huaanwork/src/update-checker.ts`（唯一）

---

## 1. A 组本质与处方（任务简报摘要）

fork 的 `expectedSha256`（**D-M6-23**：市场/更新链通道记录摘要，D1 hotfix `246bd2a59d`
接线到生产下载路径）与上游 `installerSha256`（自更新摘要 + 平台分形
`Partial<Record<'win32'|'darwin', string>>`）是**趋同功能**，不是互斥设计。

三轴测量结论：

| 语义轴 | 上游 stable/beta | fork huaanwork（合并前） | 可否取并集 |
|---|---|---|---|
| **摘要来源** | 版本响应 `sha256:{windows\|win32, mac\|darwin}` | 同一响应 `sha256:{...}`（任意平台键） | 是，键空间上游 ⊆ fork |
| **校验点（硬门）** | `installerSha256[platform]` → electron-runtime → `expectedSha256` → `assertInstallerDigest`（下载落盘前） | **完全相同**（同一 hotfix 接线，electron-runtime:934 / update-download:209 逐字节一致） | 是，同一机制 |
| **fail-closed** | 单字段 malformed → 丢该平台，版本检查仍成功（lenient-drop） | 任一字段 malformed → 整个版本检查返回 `null`（**fail-closed，更严**） | 是，取更严者（fork） |
| **平台分形** | 收敛为 `{win32, darwin}` 两形态 | 透传全部 artifact 键（多 artifact 通道记录形态） | 是，上游 ⊆ fork，fork 额外保留 |

**无根本不兼容 → 不触发 R5 mini-ruling。** 两机制在「校验点」上本就同一；差异只在
fork 多出两条上游未覆盖的语义（fail-closed 整体拒绝、多 artifact 透传），且 fork 在
每一轴上**不弱于**上游。

## 2. 采用的消解形态（union）

按处方「上游已覆盖者采上游形态消减增量；未覆盖者在上游基底上重放 fork 语义」：

- **覆盖部分（采上游形态）**：`installerSha256`（`win32`/`darwin`）的提取改用上游**逐字节
  相同**的共享提取器 `parseInstallerDigestResponse`（case-normalize + `win32|windows` /
  `darwin|mac` 映射），替换 fork 原先在 `checkForDesktopUpdate` 内联的手写 spread。
  这是降低后续同步冲突面的「消减 fork 增量」。
- **未覆盖部分（在上游基底上重放 fork）**：
  1. **D-M6-23 fail-closed 完整性门**：`parseVersionResponse` 保留 fork 的严格校验——
     `sha256` 存在即必须是对象，每个条目**先按上游共享提取器相同方式归一化（`trim` +
     `toLowerCase`）再严格校验**：归一化后仍非 64 位 hex 才整检查 `return null`
     （`update-checker.ts:332-343`）。这样大写 / 两端空白但本体合法的签名摘要被接受并归一，
     不再被误拒（fix round 1 修正；上游 `dsh-plugin-desktop/tests/update-checker.spec.ts:140-153`
     正是该归一化语义），仅归一化后仍非法者触发 fail-closed。
  2. **多 artifact 通道记录透传**：`UpdateCheckResult.sha256`（全平台键原样 hex-validated
     passthrough，`update-checker.ts:127`）保留，上游只建模两桌面平台无法承载该形态。
- **D-M6-23 回归钉未被替换**：hotfix `246bd2a59d` 的生产接线（`electron-runtime.ts:934`
  `expectedSha256: installerSha256[platform]` → `update-download.ts:209`
  `assertInstallerDigest`）**原封未动**；fork 回归钉测试
  `tests/update-checker.spec.ts`「carries valid sha256 …(D-M6-23)」「refuses … invalid
  sha256 payload (D-M6-23)」**保持绿**。无需等价钉替换，因为钉本身未动。

**第三变体裁定出口**：huaanwork 现与 stable/beta 携带**同等（且在 fail-closed 轴上更强）**
的 digest 校验强度。残留差异全部是**身份常量**（channel 枚举 `huaanwork`、更新端点
`resolveUpdateOrigin` 内网 origin、`SUPPORTED_RELEASE_CHANNELS`、`matchesReleaseChannelVersionShape`
的通道形态开关）——允许保留。无弱化、无未校验路径。

## 3. A 组逐 hunk 决策表（14 条）

> hunk 编号沿用合并冲突清单（任务简报登记：beta #2/#3/#9/#10/#11/#12 + stable
> #13/#14/#20–#23 + tests #24/#25），按简报的文件归组。stable↔beta 侧在合并中已
> 收口为**逐字节相同**（§7.3），故这些 hunk 的「取哪侧」= 上游合并形态；huaanwork
> 侧的处置 = 第 2 节的 union。

> 归类取值：`covered`（上游已覆盖，采上游形态）/ `uncovered`（上游未覆盖，在上游基底
> 重放 fork）/ `covered+uncovered`（union 行，两者并存）/ `identity`（身份常量）/ `no-op`
> （huaanwork 该文件已与 stable 逐字节相同，无需改）。「重放内容」给出具体落点/内容，
> 无重放则写 `无`。全部行号基于 fix round 1 后的 `dsh-plugin-huaanwork/src/update-checker.ts`。

| # | 文件 | 该侧语义（摘要来源 / 校验点 / fail-closed / 平台形态） | 归类 | 取哪侧 | 重放内容（落点/内容 或 无） | 理由 |
|---|---|---|---|---|---|---|
| beta #2 | `electron-runtime.ts` | downloadAndOpen 透传签名新增第 4 参 `installerSha256` | `covered` / `no-op` | 上游（stable/beta 已逐字节相同） | 无（huaanwork `electron-runtime.ts:240` 与 stable `:235` 逐字节相同） | 校验点接线，上游=fork 同形；无 fork 增量 |
| beta #3 | `electron-runtime.ts` | `installerSha256?.[platform]` → `expectedSha256` 下载参数类型 | `covered` / `no-op` | 上游 | 无（`electron-runtime.ts:934` 与 stable `:879` 逐字节相同；hotfix 246bd2a59d 落点未改） | 同一硬门接线，采上游 |
| beta #9 | `update-checker.ts` | `UpdateCheckResult.installerSha256` 字段形态 `Partial<Record<'win32'|'darwin'>>` | `covered` | 上游形态 | 无（`update-checker.ts:134` 字段形态与 stable 一致，JSDoc 亦同） | 覆盖部分采上游；huaanwork 字段同形 |
| beta #10 | `update-checker.ts` | 版本响应 digest 提取（来源轴） | `covered` | 上游提取器 `parseInstallerDigestResponse` | 无（`update-checker.ts:385-397` 为上游提取器逐字节副本，替换 fork 内联 spread） | 「采上游形态消减增量」 |
| beta #11 | `update-checker.ts` | digest 透传进结果（透传轴） | `covered+uncovered` | 上游 + 重放 fork | 重放 raw `sha256` 多 artifact 透传：字段 `update-checker.ts:127` + 组装 `:237` `...(latest.sha256 === undefined ? {} : { sha256 })` | installerSha256 采上游；raw passthrough 上游不建模 |
| beta #12 | `update-lifecycle.ts` | digest 贯穿生命周期（仅穿参，无语义改写） | `no-op` | 上游（stable/beta 逐字节相同） | 无（huaanwork `update-lifecycle.ts` 与 stable 逐字节相同） | 无需改 |
| stable #13 | `electron-runtime.ts` | 传参与类型（与 beta #2/#3 对侧收口） | `covered` / `no-op` | 上游 | 无（同 beta #2/#3，逐字节相同） | stable↔beta 已逐字节相同 |
| stable #14 | `runtime.ts` | digest 字段 JSDoc（文档轴） | `covered` / `no-op` | 上游 | 无（huaanwork `runtime.ts` 与 stable 逐字节相同） | 文档轴，无差异 |
| stable #20 | `update-checker.ts` | 来源轴（与 beta #10 对侧） | `covered` | 上游提取器 | 无（同 beta #10：`parseInstallerDigestResponse` @ `:385`） | 同 beta #10 |
| stable #21 | `update-checker.ts` | 校验点轴：硬门 `installerSha256` 发布即强制 | `covered` / `no-op` | 上游 | 无（硬门接线未改：`electron-runtime.ts:934` → `update-download.ts:209 assertInstallerDigest`） | fork 同一硬门 |
| stable #22 | `update-checker.ts` | fail-closed 轴：上游 lenient-drop | `uncovered` | **重放 fork（更严）** | 重放 fail-closed 门：`parseVersionResponse` `update-checker.ts:332-343`（每条先 `trim+lowercase` 归一，归一后仍非 64 位 hex ⇒ 整检查 `return null`） | fork fail-closed 不弱于上游，D-M6-23 要求保留 |
| stable #23 | `update-checker.ts` | 平台形态轴：上游收敛 win32/darwin | `covered+uncovered` | 上游 + 重放 fork raw passthrough | 两桌面平台采上游（`installerSha256` @ `:238`）；多 artifact 记录重放 raw `sha256`（`:127` / `:237`） | 两平台采上游；多 artifact 重放 fork |
| tests #24 | `updates.spec.ts` | digest 用例（happy-path win/mac→win32/darwin、omit-none） | `covered` / `no-op` | 上游（三变体逐字节相同） | 无（共享 spec，huaanwork union 下仍全绿） | 共享 spec |
| tests #25 | `updates.spec.ts` | digest recheck/omit 用例 | `covered` + `uncovered`(钉) | 上游 | 共享 spec 本体无重放（逐字节相同）；fork D-M6-23 回归钉重放于 `tests/update-checker.spec.ts`:「carries valid … (D-M6-23)」「accepts uppercase and whitespace-padded … (D-M6-23)」「refuses … invalid sha256 payload (D-M6-23)」 | 共享 spec + fork 专属钉并存 |

> 校验：`updates.spec.ts` 三变体合并后逐字节相同（stable↔beta↔huaanwork `diff` 空），
> 符合 §7.3；fork 的 D-M6-23 专属回归在 `tests/update-checker.spec.ts`，与共享 spec 并存。

## 4. E2⑤ 观察登记（评审 N7）

- **登记项**：`update-download.ts` 下载器 `redirect: 'follow'`（M7 交付 §7 第 6 条）。
- **本组必经文件面核验点**：
  - huaanwork `dsh-plugin-huaanwork/src/update-download.ts:171` → `redirect: 'follow'`
  - stable `dsh-plugin-desktop/src/update-download.ts:155` → `redirect: 'follow'`
  - 版本检查侧 `update-checker.ts:201` → `redirect: 'error'`（下载/检查两点语义分离）
- **结论：未触及。** 上游 350 提交未改动下载器 redirect / 网络配置语义：stable↔beta
  `update-download.ts` 合并后逐字节相同（`diff` 空），且 stable↔huaanwork 的
  `update-download.ts` 差异 **不含 redirect 行**（差异仅为身份/origin：`desktopDownloadUrls`
  内网 origin、`assertSecureDownloadUrl(expectedOrigin)` 端口放行、产品名 `HuaAnWork`、
  N-review「honest-downgrade」告警）。`redirect: 'follow'`（下载）与 `redirect: 'error'`
  （检查）两处语义随合并原样保留，无无声漂移。

## 5. 测试证据（sync worktree, corepack yarn）

- 聚焦：`vitest run tests/update-checker.spec.ts tests/update-download.spec.ts
  tests/electron-runtime.spec.ts tests/updates.spec.ts` → **251 passed (4 files)**
  （含两条 D-M6-23 回归钉与共享 updates.spec happy-path）。
- `tsc -p tsconfig.json --noEmit` 与 `tsc -p tsconfig.tests.json --noEmit` 均通过。
- `corepack yarn check:whitespace` → exit 0。
- `node scripts/verify-desktop-variants.mjs` → 仅冻结的十条 drift，无新增（`update-checker.ts`
  未进入 drift 列表）。
- 未触碰 stable / beta `src/`（`git status` 仅 `dsh-plugin-huaanwork/src/update-checker.ts`），
  故无需复跑其 spec。

---

# B 组（needs-ruling：文案模板，10 hunks）— Task 2.6

> 本节由 **Task 2.6** 追加；A 组（§1–§5）未改动。MERGE_BASE（动态解析）：
> `git merge-base origin/master HEAD` → `8cd74f5e9b`（as-of 2026-10-09）；基准 HEAD `ba30ead710`。
> 本任务**未改任何源码**：仅追加本节（见 §6.3 的零改动论证）。

## 6.1 本质与处方

上游 350 提交给 `notifications.ts` / `recovery-copy.ts` 带来**新功能 + 新文案**，同时把产品名
**硬编码**为 `DSH Desktop`（`git show upstream/master:dsh-plugin-desktop/src/{notifications,recovery-copy}.ts`
可见 `Open DSH Desktop for details.`、`DSH Desktop Recovery Assistant`、`confirmDisableBody … DSH Desktop simply will not load it …`
等）。fork 在 M3/M7 已把运行时文案收口为 `DESKTOP_PRODUCT_NAME`（`product-identity.ts`）。处方 = **采上游新功能与新文案 +
把上游硬编码 `DSH Desktop` 换成 `${DESKTOP_PRODUCT_NAME}` 模板**（M7 Task 3.2 路线 (b)，重放极薄）。

## 6.2 逐 hunk 决策表（10 条）

> 简报对 hunk 仅登记编号与文件（notifications ×6：beta #4/#5/#6 + stable #15/#16/#17；recovery-copy ×4：
> beta #7/#8 + stable #18/#19），未附逐 hunk 内容。本表按 `git diff 8cd74f5e9b HEAD` 对每个文件的**三个/两个
> 语义区域**对位：notifications = ① 设置/导入面 ② 文案表 + schedule 结局 + 回合来源追踪 ③ job 观察 + `apply`；
> recovery-copy = ④ 禁用/启用插件文案与接口 ⑤ bundle-selection 失败文案与阶段标签。区域↔编号按简报排列顺序对位
> （beta #4→①、#5→②、#6→③、#7→④、#8→⑤；stable #15→①、#16→②、#17→③、#18→④、#19→⑤）。
> 三包 `src/notifications.ts`、`src/recovery-copy.ts` 现**互相逐字节相同**（`diff` 空 ×4），故「取哪侧」一律为上游合并形态。
> 归类：`covered`（上游已覆盖，采上游）/ `template-replay`（上游硬编码产品名 → 模板重放）/ `no-op`（无需重放）。

| # | 文件 | 侧 | 区域 | 归类 | 采纳内容 | 重放内容 | 理由 |
|---|---|---|---|---|---|---|---|
| beta #4 | `dsh-plugin-desktop-beta/src/notifications.ts` | beta | ① 导入/设置面 | `covered` | 上游：设置 schema/类型迁至 `settings-bridge.ts`（`bindDesktopNotificationSettings`、`DEFAULT_NOTIFICATION_SETTINGS`、`DESKTOP_NOTIFICATIONS_SETTINGS_ENTRY_ID`），新增 `observeDesktopJobOutcomes`/`DesktopJobOutcome` 导入；`DESKTOP_NOTIFICATIONS_SETTINGS_NAMESPACE` 取 bridge 常量 | 无 | 纯功能搬迁，无产品名字面量；`jobs-bridge.ts`/`settings-bridge.ts` 三包均已存在 |
| beta #5 | `dsh-plugin-desktop-beta/src/notifications.ts` | beta | ② 文案表 + schedule + 回合来源 | `template-replay` | 上游新增 `schedule-completed/-failed` 文案与 `OpenTurn.source: 'user'\|'schedule'` 追踪、`notifyOnSchedule*` 分流；EN/ZH 失败文案 | 上游 6 处硬编码 `DSH Desktop` → `${DESKTOP_PRODUCT_NAME}`（`turn-failed`/`job-failed`/`schedule-failed` × EN/ZH，`notifications.ts:37,39,41,45,47,49`）；import 位于 `:6` | 上游字面量是 stable 产品名；beta/huaanwork 需各自身份。该模板形态早于本任务已在位（M7 3.2 (b)） |
| beta #6 | `dsh-plugin-desktop-beta/src/notifications.ts` | beta | ③ job 观察 + `apply` | `covered` | 上游：`notifyJob` 改吃 `DesktopJobOutcome`，`apply(ctx, config)` 以 `ctx.effect(bindDesktopNotificationSettings…)` 绑定设置，`observeDesktopJobOutcomes(jobsCtx, …)`（`:127`） | 无 | 无产品名字面量；effect 标签 `dsh-plugin-desktop: …` 为内部诊断标识（插件包名），非面向用户的产品名文案 |
| stable #15 | `dsh-plugin-desktop/src/notifications.ts` | stable | ① 导入/设置面 | `covered` | 同 beta #4 | 无 | 同 beta #4 |
| stable #16 | `dsh-plugin-desktop/src/notifications.ts` | stable | ② 文案表 + schedule + 回合来源 | `template-replay` | 同 beta #5 | 同 beta #5：6 处 `DSH Desktop` → `${DESKTOP_PRODUCT_NAME}`；stable 下该常量解析为 `DSH Desktop`，**用户可见文案与上游字节等价** | 与上游相比 stable 的**唯一**差异就是这 6 行模板化（`git diff upstream/master HEAD` 仅含 import + 6 行） |
| stable #17 | `dsh-plugin-desktop/src/notifications.ts` | stable | ③ job 观察 + `apply` | `covered` | 同 beta #6 | 无 | 同 beta #6 |
| beta #7 | `dsh-plugin-desktop-beta/src/recovery-copy.ts` | beta | ④ 禁用/启用插件 | `template-replay` | 上游新接口/文案：`disable`/`enable`/`disabledHint`、`confirmDisable*`/`confirmEnable*`、`disabledSuccess`/`enabledSuccess`、`pluginsBody` 新措辞、`confirmRollbackBody`「including which plugins are enabled」（EN/ZH） | 上游含产品名的新文案全部模板化：`confirmDisableBody`（`:290`）、`confirmEnableBody`（`:293`）、`confirmRollbackBody`（`:296`/`:453`）、`disabledSuccess`（`:299`/`:456`）、`enabledSuccess`（`:300`/`:457`）→ `${DESKTOP_PRODUCT_NAME}` | 上游字面量 `DSH Desktop`；ZH 的 `confirmDisableBody`/`confirmEnableBody` 本身不含产品名，无需处理 |
| beta #8 | `dsh-plugin-desktop-beta/src/recovery-copy.ts` | beta | ⑤ bundle-selection | `covered` | 上游：`bundleSelectionFailedTitle/Message` 与阶段标签 `'bundle-selection'`（EN/ZH） | 无 | 新增 5 条文案均不含产品名，无字面量可替换 |
| stable #18 | `dsh-plugin-desktop/src/recovery-copy.ts` | stable | ④ 禁用/启用插件 | `template-replay` | 同 beta #7 | 同 beta #7；stable 下常量=`DSH Desktop`，与上游用户可见文案等价 | 与上游 diff 仅为产品名模板化 |
| stable #19 | `dsh-plugin-desktop/src/recovery-copy.ts` | stable | ⑤ bundle-selection | `covered` | 同 beta #8 | 无 | 同 beta #8 |

> huaanwork（`dsh-plugin-huaanwork/src/{notifications,recovery-copy}.ts`）为第三变体：与 stable/beta **逐字节相同**，
> 其 `DESKTOP_PRODUCT_NAME` 由其 `product-identity.ts` 解析为 `HuaAnWork`；无任何独立重放。

## 6.3 出口判据（机械）核验

1. **「零改动」论证（主动验证控制器 grep，而非沿用）**：
   - `rg -i "DSH Desktop|HuaAnWork|华安" src/notifications.ts src/recovery-copy.ts`（三包）→ **无匹配**（硬编码产品名 0 处）。
   - `git diff -U0 8cd74f5e9b HEAD -- <两文件>` 的**新增行**再 grep 产品名字面量 → 三包均 `(none)`。
   - `git diff upstream/master HEAD -- dsh-plugin-desktop/src/notifications.ts` 仅余 `+import { DESKTOP_PRODUCT_NAME }`
     与 6 行模板化，证明上游所有 `DSH Desktop` 字面量均已被替换，无遗漏。
   - 三包均含 `observeDesktopJobOutcomes`（`notifications.ts:7,127`，`jobs-bridge.ts:31`）、`recovery-copy.ts` 的 disable/enable/
     bundle-selection 新文案、`DESKTOP_PRODUCT_NAME` 导入。→ 没有真实缺口，**不重写**。
2. **残留 `DSH` 字样盘点（非产品名，按「采上游」保留）**：`DSH data directory`/`DSH 数据目录`（数据目录术语，
   与 `DESKTOP_HOME_DIRECTORY_NAME` 同属数据面命名）、`Open DSH Terminal`、`DSH plugin uninstall`。这些均为合并前
   基线已存在的文案（不在上游新增段内），也非 `DSH Desktop` 产品名；其品牌化属另案（数据目录/终端品牌），本任务**不吞并**，
   在此显式登记。
3. **测试**（三包，`corepack yarn vitest run tests/<spec>`）：`notifications`（11）、`notifications-live`（1，stable/beta）、
   `desktop-copy`（9）、`recovery-native-ui`（7）、`recovery-navigation`（6）→ 全绿（huaanwork 无 `notifications-live.spec.ts`）。
4. `corepack yarn check:whitespace` → exit 0。
5. `node scripts/verify-desktop-variants.mjs` → 漂移列表仍恰为冻结的十条（`src/bin.ts`、`src/safe-mode.ts`、
   `scripts/package-mac.ts`、`scripts/package-win.ts`、`scripts/verify-cli-runtime.mjs`、`scripts/verify-electron-fuses.ts`、
   `scripts/verify-licenses.mjs`、`scripts/verify-mac-entitlements.ts`、`scripts/verify-mac-release.ts`、
   `scripts/verify-mac-smoke.ts`），无新增、无白名单。
