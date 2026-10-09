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
     `sha256` 存在即必须是对象、每个条目必须是 64 位小写 hex，否则整检查
     `return null`（`update-checker.ts:327-338`）。
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

| # | 文件 | 该侧语义（摘要来源 / 校验点 / fail-closed / 平台形态） | 取哪侧 | 理由 |
|---|---|---|---|---|
| beta #2 | `electron-runtime.ts` | downloadAndOpen 透传签名新增第 4 参 `installerSha256` | 上游（stable/beta 已逐字节相同） | 校验点接线，上游=fork 同形；无 fork 增量 |
| beta #3 | `electron-runtime.ts` | `installerSha256?.[platform]` → `expectedSha256` 下载参数类型 | 上游 | 同一硬门接线（hotfix 246bd2a59d 落点），采上游 |
| beta #9 | `update-checker.ts` | `UpdateCheckResult.installerSha256` 字段形态 `Partial<Record<'win32'|'darwin'>>` | 上游形态 | 覆盖部分采上游；huaanwork 字段同形 |
| beta #10 | `update-checker.ts` | 版本响应 digest 提取（来源轴） | 上游提取器 `parseInstallerDigestResponse` | 「采上游形态消减增量」；替换 fork 内联 spread |
| beta #11 | `update-checker.ts` | digest 透传进结果（透传轴） | 上游 + 重放 fork | installerSha256 采上游；raw `sha256` 重放 fork 多 artifact |
| beta #12 | `update-lifecycle.ts` | digest 贯穿生命周期（无语义改写，仅穿参） | 上游（stable/beta 逐字节相同） | huaanwork 已与 stable 逐字节相同，无需改 |
| stable #13 | `electron-runtime.ts` | 传参与类型（与 beta #2/#3 对侧收口） | 上游 | stable↔beta 已逐字节相同 |
| stable #14 | `runtime.ts` | digest 字段 JSDoc（文档轴） | 上游 | huaanwork `runtime.ts` 与 stable 逐字节相同 |
| stable #20 | `update-checker.ts` | 来源轴（与 beta #10 对侧） | 上游提取器 | 同 beta #10 |
| stable #21 | `update-checker.ts` | 校验点轴：硬门语义 `installerSha256` 发布即强制 | 上游 | fork 同一硬门，采上游 JSDoc/字段形态 |
| stable #22 | `update-checker.ts` | fail-closed 轴：上游 lenient-drop | **重放 fork（更严）** | fork fail-closed 不弱于上游，D-M6-23 要求保留 |
| stable #23 | `update-checker.ts` | 平台形态轴：上游收敛 win32/darwin | 上游 + 重放 fork raw passthrough | 两桌面平台采上游；多 artifact 记录重放 fork |
| tests #24 | `updates.spec.ts` | digest 用例（happy-path win/mac→win32/darwin、omit-none） | 上游（三变体逐字节相同） | 共享 spec，huaanwork union 下仍全绿 |
| tests #25 | `updates.spec.ts` | digest recheck/omit 用例 | 上游 | 同 #24；另 fork 专属 `tests/update-checker.spec.ts` 的 D-M6-23 钉保持绿 |

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
