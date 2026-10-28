# HuaAnWork `@子代理` 运行可观测性与定向终止 —— 自动化验收证据（2026-10-27）

本文件只记录本次实际执行的自动化门禁，以及因未获图形启动授权而未执行的真机项。脚本日志在 `.superpowers/sdd/2026-10-26-subagent-run-visibility/logs/`（git-ignored 暂存区），不随提交分发。

> **状态更新（2026-10-27）**：本文 §1–§7 与「最终修复后复跑」记录的「未启动图形应用、真机项全部 Blocked」已被文末〈真机验收（2026-10-27，Electron 44 + deepseek-flash）〉取代；自动化门禁的记录与判定口径保持不变，凡涉及真机条目的判定以新章节为准。
>
> **最终判定订正（2026-10-28）**：文末〈验收判定订正（2026-10-28）〉统一了子项判定口径：A-01 改为 PASS、A-12 与 C-05 降为部分、E-05 改为 PASS、列明 A-13 的剩余子项，并补回此前摘要漏列的 B-07；其余条目按各节最新判定，不因本订正改判。

## 1. 结论

- 定向测试与四条根门禁全部退出码 0；本次没有出现 `verify:aa` 并发进程 flake。
- **功能验收未完成。** 所有依赖真实 `@` 路径、真实渲染器、真实 WebSocket/重连、Host 重启、键盘/读屏/视觉 QA 的条目均为 **Blocked（真机未执行）**；Windows 为 **未验证**。
- 自动化通过只证明测试断言成立，不能替代设计 §10.1 的 A–D 全量与 E-01～E-05 真机验收。

## 2. 环境与基线

| 项 | 值 |
| --- | --- |
| 平台 | macOS arm64（`uname -m` = `arm64`，`sw_vers -productVersion` = `27.0.1`） |
| Node | `v22.23.2` |
| Yarn | `4.18.0`（Corepack） |
| 外层基线 HEAD | `692f12f50756782255d0b8a2e0f1aa0ff24e8620` |
| 分支 | `refactor/huaanwork-single-desktop` |
| Harness pin | `1600d8a1e140dcde43a1a0941940a0480712c011`（`git submodule status` 实测；`upstream.json` beta/huaanwork 同钉） |
| 工作区状态 | **未提交工作树**：29 个已跟踪文件修改 + 11 个未跟踪路径（含 `.gstack/` 与本计划的 2 份计划、1 份设计文档）；`git diff --stat` = 3941 insertions / 589 deletions |
| 实现文件时间 | 关键实现与测试文件 mtime 集中在 2026-10-27 10:18–13:22（例：`subagent-runs.ts` 10:20、`routes.ts` 10:26、`sessions.ts` 10:41、`agent-package/host.ts` 11:17、`bridge.ts` 11:52、`logic/subagentRuns.ts` 13:10、`SubagentRunCard.tsx` 13:00、`App.tsx` 13:19） |
| 图形启动 | **未执行**：未运行 `corepack yarn dev`、任何 Electron 应用或 `/design-review`；未获用户明确同意 |
| 提交 | **无提交**（no-commit 模式，计划 Global Constraints + 本任务 addendum） |

变更面核对：`git status` 只涉及 `dsh-plugin-huaanwork/`（src/tests）与 `docs/` 下未跟踪的计划/设计文档；`deepseek-harness/` 子模组干净；`dsh-plugin-desktop/src`、`dsh-plugin-desktop-beta/src`、`scripts/verify-desktop-variants.mjs` 均无改动；变体白名单计数未变（stable↔beta 7/0，beta↔huaanwork 65/6）。

## 3. 门禁记录

### 3.1 Step 1 定向测试

命令（与 brief 完全一致，另以 `>` 重定向到日志）：

```bash
corepack yarn workspace dsh-plugin-huaanwork test tests/huaanwork-host/subagent-runs.spec.ts tests/huaanwork-host/route-contract.spec.ts tests/huaanwork-host/subagent-routes.spec.ts tests/huaanwork-host/sessions.spec.ts tests/huaanwork-host/agent-package-lifecycle.spec.ts tests/huaanwork-host/agent-package-runtime.spec.ts tests/huaanwork-host/agent-package-catalog-security.spec.ts tests/huaanwork-guardrails/skills.spec.ts tests/huaanwork-guardrails/bridge.spec.ts tests/client-huaanwork
```

退出码 `0`；`Test Files 52 passed (52)`，`Tests 737 passed (737)`，耗时 8.14s。日志：`logs/step1-targeted-tests.log`。

| 定向对象 | 用例数 | 结果 |
| --- | --- | --- |
| `tests/huaanwork-host/subagent-runs.spec.ts` | 15 | PASS |
| `tests/huaanwork-host/route-contract.spec.ts` | 6 | PASS |
| `tests/huaanwork-host/subagent-routes.spec.ts` | 3 | PASS |
| `tests/huaanwork-host/sessions.spec.ts` | 43 | PASS |
| `tests/huaanwork-host/agent-package-lifecycle.spec.ts` | 2 | PASS |
| `tests/huaanwork-host/agent-package-runtime.spec.ts` | 54 | PASS |
| `tests/huaanwork-host/agent-package-catalog-security.spec.ts` | 27 | PASS |
| `tests/huaanwork-guardrails/skills.spec.ts` | 37 | PASS |
| `tests/huaanwork-guardrails/bridge.spec.ts` | 22 | PASS |
| `tests/client-huaanwork/`（目录，42 个 spec） | 526 | PASS |
| `tests/client-huaanwork-shell.spec.ts`（目录前缀命中） | 2 | PASS |

stderr 中的 `refreshAgentRestrict: restrict state not found` 是既有负例 fixture 的预期打印，不是失败；整轮 `Test Files 52 passed` 无 FAIL。

### 3.2 根门禁（Step 2，严格串行）

| 门禁 | 命令 | 退出码 | 计数/关键输出 | 结果 | 日志 |
| --- | --- | --- | --- | --- | --- |
| 类型检查 | `corepack yarn typecheck` | 0 | 11 个 workspace 的 `tsc` 全部通过；日志尾 `contract-types: 4 generated type files are current`；耗时 36s | PASS | `logs/typecheck.log` |
| 单元测试 | `corepack yarn test` | 0 | vitest 8 个 workspace：`8493 passed / 37 skipped`；`node:test` 8 个 workspace：`168 tests / 166 pass / 2 skipped / 0 fail`；耗时 105s | PASS | `logs/test.log` |
| 变体守卫 | `corepack yarn check:desktop-variants` | 0 | `11/11` node 测试通过；`stable↔beta src (214) / scripts (33)`、`beta↔huaanwork src (168) / scripts (21)` 对齐；`stable↔beta allowlist 7 (oneSidedPrefixes 0)`、`beta↔huaanwork allowlist 65 (oneSidedPrefixes 6)`；耗时 3s | PASS | `logs/check-desktop-variants.log` |
| 完整 headless 门禁 | `corepack yarn check` | 0 | 见下；耗时 3m25s | PASS | `logs/check.log` |

`corepack yarn check` 的组成（按脚本顺序，全部通过）：

- 根步骤：`check:whitespace`、`check:layout`（含 Next 与上游 `1600d8a1e1`）、`test:aa-connector`（4 个 Desktop 变体的 connector 用例全部 `ok`，凭据脱敏）。
- 各 workspace 的 `check`：`dsh-community-fabric`（20 个 Markdown/10 组双语）、`dsh-community-market`（`303` tests，13 文件）、`dsh-plugin-desktop`（`1812 passed / 11 skipped`，143 文件）、`dsh-plugin-desktop-beta`（`1822 passed / 11 skipped`，143 文件）、`dsh-desktop-next`（`641 passed / 1 skipped`，77 文件）、`dsh-plugin-huaanwork`（`3503 passed / 14 skipped`，265 文件）、`market-server`（`244`）、`update-server`（`88`）、`agent-catalog-server`（`80`）、`@huaanwork/catalog-signing`、`@huaanwork/agent-package-format`、`agent-catalog-admin`（`node:test` 各自 0 fail）。
- 验证脚本：`verify-runtime-closure`（297 / 316 节点闭包）、`verify-bundled-runtime`（131 文件）、`verify-licenses`（610 / 641 / 651 包，含 9 bundled）、`verify-profile-boot`（见下）、`verify-operation-reliability`（7 operations / 18 fault contracts）。

### 3.3 `verify:aa` 与 flake 观察

- `dsh-plugin-desktop`、`dsh-plugin-desktop-beta`、`dsh-plugin-huaanwork` 的 `check` 脚本均包含 `verify:aa` 且未被 `AA-skip` 移除；三个包的 `check` 全部通过。
- desktop/beta 包内使用 `run-parallel.mjs` 并行执行各 verify 步骤（既有设计），日志交错，**行序不能证明步骤身份**；可按计数核对：两个包合计出现 4 次 `Creator, plugin manager and two Profile HMR generations passed`，与「每包 `verify:profile` + `verify:aa` 共用同一行文案」的 2×2 相符。
- huaanwork 的 `check` 是串行 `&&` 链，行序可核：`minimal preset, plugin manager, and disabled hmr lock passed` 出现在 `logs/check.log:2650` 与 `:2856`，前者在 `verify:host`（host-loop-smoke 31 tests）之前、后者在其后，分别对应 `verify:profile` 与 `verify:aa`；随后 `verify:licenses`（651 包）与 `verify:operations` 均通过。
- **未出现** `verify:aa` 并发进程冲突签名，因此没有触发单独复跑；本轮不存在「把真红写成 flake」或反向的情形。

### 3.4 失败与未执行

- 本轮无任何测试失败、门禁失败或超时。
- 未执行：任何图形启动、交互操作、截图、真机计时/键盘/读屏核对。

## 4. 设计 §10.1 需求矩阵

判定口径：`自动化 PASS` = 该条目的行为已被自动化断言完整覆盖；`自动化仅覆盖部分` = 逻辑已覆盖但真实渲染/真实组合未执行；`Blocked（真机未执行）` = 只能由真机证明；Windows 统一为 `未验证`。行号取 2026-10-27 工作树现值。

### A. 运行状态与界面

| 条目 | 判定 | 证据与缺口 |
| --- | --- | --- |
| A-01 独立运行卡 | 自动化仅覆盖部分 | 每次派发各建一条 run：`sessions.spec.ts:553`（legacy）、`agent-package-runtime.spec.ts:1294`（package，含 message id/版本/request runId）；锚点计算：`subagentRuns.spec.ts:865`、`:920`（`clientMessageId` 精确插入、同 tab）。真实卡片位置/视觉 **Blocked**。 |
| A-02 启动状态可信 | 自动化 PASS | `subagent-runs.spec.ts:29`（`begin` 即 `starting`，不等 token）；`sessions.spec.ts:601`（activation 发布前取消仍作用于已存在的 run）；`agent-package-runtime.spec.ts:1318`（禁用包直接失败而非停在 starting）。 |
| A-03 生命周期完整 | 自动化 PASS | `subagent-runs.spec.ts:29/54/101`；`bridge.spec.ts:636`（child idle → `finalizing`，父 idle 仍结束父回合）；`subagentRuns.spec.ts:466/505`（相位文案与 finalizing 细节）。 |
| A-04 工具状态准确 | 自动化 PASS | `bridge.spec.ts:547`（并发 child 工具按 `callId` 结束，一个 end 不清除其他）；`subagent-runs.spec.ts:155`（活动只记选中的 child）；`subagentRuns.spec.ts:773`（工具排序/前 2 + `+N`）；`SubagentRunCard.spec.ts:219`（展开完整在途列表）。 |
| A-05 终态映射诚实 | 自动化 PASS | `subagent-runs.spec.ts:181`（`error/max-tokens/refusal/unknown` 均失败）；`bridge.spec.ts:592`（单个工具失败只是 per-tool 事实）；`subagentRuns.spec.ts:466`、`SubagentRunCard.spec.ts:376/413`（终态单行、告警不篡改终态）。 |
| A-06 父 idle 后仍可用 | 自动化仅覆盖部分 | `sessions.spec.ts:811`（父 idle 的 result 等待可被定向取消唤醒、不依赖 cleanup budget）；`App.tsx:1546-1551`（父回合或任一子 run 活跃都驱动共享秒表，卡片不自建 interval）；`subagentRuns.spec.ts:932`（父状态行摘要）。真实「父 idle 后卡片继续更新」**Blocked**。 |
| A-07 耗时与静默提示 | 自动化 PASS | `subagent-runs.spec.ts:155`（`lastActivity` 只由 child token/reasoning/tool 更新）；`subagentRuns.spec.ts:522`（耗时在真实结束/失效/断连点冻结）、`:745`（无活动仅是提醒，不写超时、不自动停止）。 |
| A-08 收尾预算语义 | 自动化 PASS（两条链）；真机子项 Blocked | legacy：`sessions.spec.ts:871`，父未 idle 时预算不写、`afterIdle` 后记 `cleanupBudgetMs = ACTIVATION_CLEANUP_TIMEOUT_MS`(600000) + `stopCause: 'cleanup-budget'` + `stopping` + `cleanupWarnings: []`，dispose 确认后才 `stopped`。package：`agent-package-runtime.spec.ts:1552`，注入 `cleanupTimeoutMs: 20`，同样停在 `stopping`，dispose 确认后 `stopped`。文案：`subagentRuns.spec.ts:645`（数值来自 Host，5s→「超过 5 秒」、600000→「超过 10 分钟」，缺数值不臆造）。真机「受控短预算 + 真实提醒视觉」两条子项 **Blocked**：legacy 预算是模块常量、package 的 `cleanupTimeoutMs` 是内部注入项，应用没有环境变量/设置通道，且未启动 GUI；未改生产常量。 |
| A-09 父子消息流隔离 | 自动化 PASS | `bridge.spec.ts:514`（child reasoning/text 只进 run 投影）、`:547`、`:610`（child goal/compaction 不污染父流）、`:636`、`:683`（未登记 session 原样通过）；`agent-package-runtime.spec.ts:1147` 组。 |
| A-10 多标签归属正确 | 自动化仅覆盖部分 | `subagentRuns.spec.ts:140`（一个父的 snapshot 不触碰另一 tab 历史）、`:865`（只用本 tab 的 `clientMessageId`）、`:920`；停止错误按 runId 存于卡片：`SubagentRunCard.spec.ts:331`。真实多 tab **Blocked**。 |
| A-11 可访问性 | 自动化仅覆盖部分 | `SubagentRunCard.spec.ts:244`（状态区不随时钟跳动）、`:272`（可访问名带开始时间）、`:601`（sr-only 状态区标准写法）；真实读屏抽查 **Blocked**。 |
| A-12 视觉层级与工具展示 | 自动化仅覆盖部分 | `SubagentRunCard.spec.ts:219/272/291`（展开、同名时间、长名称 title）；`subagentRuns.spec.ts:773/794/818`（前 2 + `+N`、仅在重名时给开始时间、24 小时制）；真实三行层级/长名称布局/视觉 token 目检 **Blocked**。 |
| A-13 终态与失效视图 | 自动化仅覆盖部分 | `SubagentRunCard.spec.ts:376`（终态单行、展开不被重渲染重置）、`:459/480`（stale/断连冻结、禁用终止）、`:531`（确认前变 stale）；`subagentRuns.spec.ts:174/207/276`（新代际标记失效、stale 不可复活）。真实 WS 断连与 Host 重启 **Blocked**。 |
| A-14 文案与提醒 | 自动化 PASS | `subagentRuns.spec.ts:466`（全部相位/停止原因固定文案）、`:505`、`:562`（提醒优先级）、`:616`（60 秒严格 >、时间取 Host `stopRequestedAt`、重连不重置）、`:645`（预算文案）、`:682`（告警按 code/severity，不解析文案）；`SubagentRunCard.spec.ts:551`（默认单条、可展开全部）、`:413`（真实 error 只 alert 一次）。 |
| A-15 终止确认与焦点 | 自动化仅覆盖部分 | `SubagentRunCard.spec.ts:171`（首击只开卡内确认、不分类 RPC；取消初始焦点；window Esc 关闭并归还焦点）、`:219`（`aria-expanded`）、`:304`、`:320`、`:500/531`（确认前已终态/stale：零 RPC 关闭确认）；44×44 仅由样式契约 `:609` 断言字符串，真实命中区重叠（Task 10 遗留）**Blocked**。 |
| A-16 动效、窄窗口与读屏 | 自动化仅覆盖部分 | `SubagentRunCard.spec.ts:609`（`min-width: 280px`、`prefers-reduced-motion`、44px）、`:617`（脉冲只属活跃相位）、`:601`；真实 280px 无横向滚动、reduced-motion 生效、读屏播报 **Blocked**。 |

### B. 定向终止与资源清理

| 条目 | 判定 | 证据与缺口 |
| --- | --- | --- |
| B-01 legacy 运行中终止 | 自动化 PASS | `sessions.spec.ts:644`（只停选中 run、兄弟保持、等 dispose 确认）；`sessions.spec.ts:811`；RPC 先回 accepted：`subagent-routes.spec.ts:41`。 |
| B-02 package 运行中终止 | 自动化 PASS | `agent-package-runtime.spec.ts:1467`（延迟 stop 保持 stopping）、`:1516`（取消后 rejected result 仍等清理）、`:1741`（runtime stop 失败不发布 stopped）；`agent-package-catalog-security.spec.ts:1157`（复用既有 turn 清理）。 |
| B-03 legacy 启动中终止 | 自动化 PASS | `sessions.spec.ts:503`（activation 前取消、晚到 activation 立即 dispose）、`:601`。 |
| B-04 package 启动中终止 | 自动化 PASS | `agent-package-runtime.spec.ts:1344`（createRuntime 在途）、`:1397`（startActivation 在途）、`:1604/1649/1696`（晚到 dispose/拒绝/超时）。 |
| B-05 停止过程可见 | 自动化 PASS | `subagent-runs.spec.ts:101`（受理后 `stopping`，清理确认后才 `stopped`）；`subagentRuns.spec.ts:466`（「停止中」文案）；`SubagentRunCard.spec.ts:320`（busy 时禁用终止，取消仍可关确认）。 |
| B-06 幂等与终态处理 | 自动化 PASS | `subagent-runs.spec.ts:215`（取消仅闩一次、不等待清理）、`:270`（未知/跨父 run 拒绝且零副作用）；`subagent-routes.spec.ts:65`（非法 body 400）。 |
| B-07 cancel/end 竞态 | 自动化 PASS | `subagent-runs.spec.ts:101`（停止吸收执行结果）、`:246`；`agent-package-runtime.spec.ts:1516`。 |
| B-08 清理失败不伪报 | 自动化 PASS | `sessions.spec.ts:763`（dispose 拒绝只加告警）；`agent-package-runtime.spec.ts:1649/1696/1741/1776`（失败/超时/拒绝均保持 stopping 或只加结构化告警）。 |
| B-09 其他取消来源可反映 | 自动化 PASS | `subagent-runs.spec.ts:246`（`aborted` 也需清理确认后才能 stopped）；`sessions.spec.ts:1013/1030/1058`（父会话 cancel 语义与兄弟隔离）；`agent-package-catalog-security.spec.ts:1157`（session.cancel 释放 package turn）。 |
| B-10 定向取消边界 | 自动化 PASS | `subagent-runs.spec.ts:270`（错误 parent/runId 零副作用）；`subagent-routes.spec.ts:65/77`（父 id/runId 必填）；`rpc-types.ts:410-414`（取消契约只有 `parentSessionId` + `runId`，不接受 childId/slug），未新增会话级/全儿童取消。 |

### C. 并发、乱序与恢复

| 条目 | 判定 | 证据与缺口 |
| --- | --- | --- |
| C-01 同名与同 slug 并发 | 自动化仅覆盖部分 | 每 run 独立键：`subagent-runs.spec.ts:313`（同父多条 run 各自快照）、`:270`（跨 run 隔离）；同名展示：`SubagentRunCard.spec.ts:272`、`subagentRuns.spec.ts:794`。缺少「同一父两条同名活跃 run」的 Host 级用例；真实并发 **Blocked**。 |
| C-02 旧事件不串扰 | 自动化 PASS | `skills.spec.ts:1058`（旧 upstream end 只结算持有该 upstreamRunId 的 run）；`subagent-runs.spec.ts:206`（终态不被迟到 token 复活）。 |
| C-03 重复结算幂等 | 自动化 PASS | `subagent-runs.spec.ts:29`（result 胜冲突 end）、`:54`（end 先到等仲裁）、`:69`（两种到达顺序）、`:91`（无绑定 rejection 立即失败）。 |
| C-04 停止后迟到事件 | 自动化 PASS | `subagent-runs.spec.ts:101`（stopping 吸收结果/失败）、`:206`（终态不复活）、`:246`（晚到 cancel 附件只启动一次）。 |
| C-05 WS 断线重连 | 自动化仅覆盖部分 | `subagentRuns.spec.ts:292`（断连冻结一次、仅 snapshot 解除）、`:114/130`（snapshot 补齐/保留活跃与停止中）；`appWiring.spec.ts:362`（ready 对账先于 sidecar 门禁）。真实渲染器断线重连 **Blocked**。 |
| C-06 snapshot/WS 竞态 | 自动化 PASS | `subagentRuns.spec.ts:94`（旧同代 snapshot 不覆盖新事件）、`:114`（snapshot 后新 run 不丢）、`:163`（空 snapshot 不删除）、`:221/233`（同代合并保留客户端字段）。 |
| C-07 Host 代际切换 | 自动化仅覆盖部分 | `subagentRuns.spec.ts:174/193/207/260/276`（新代际标记旧非终态为 stale、不推导完成、不恢复取消能力）。真实 Host 重启 **Blocked**。 |
| C-08 历史有界 | 自动化 PASS | `subagent-runs.spec.ts:313`（每父 20 条终态 + 活跃保留 + run-remove）；`subagentRuns.spec.ts:382/414`（客户端 20/父、200/全局，活跃与 stale 不淘汰）。 |
| C-09 Host 重启 | 自动化仅覆盖部分 | 失效视图逻辑：`subagentRuns.spec.ts:276`、`SubagentRunCard.spec.ts:459`（不可恢复文案、冻结计时、禁用终止）；真实重启后界面 **Blocked**。 |

### D. 安全、隐私与回归

| 条目 | 判定 | 证据与缺口 |
| --- | --- | --- |
| D-01 投影不泄密 | 自动化仅覆盖部分 | 投影字段仅生命周期/工具名/耗时/告警（`rpc-types.ts:386-408`），无 prompt、token/reasoning 正文、工具参数/输出、最终回答；child 错误经 `sanitizeChildError` 折行截断（`subagent-runs.ts:139`）；`bridge.spec.ts:514`（child 正文只进 run 投影）。缺少对真实 wire payload 的端到端断言；真实流量 **Blocked**。 |
| D-02 启动绑定 fail closed | 自动化 PASS | `skills.spec.ts:1177`（parent 不一致先 dispose 再拒绝，restrict 不执行）、`:1236`（dispose 失败不覆盖原错误）；package 兜底守卫：`skills.spec.ts:900/982`、`agent-package-runtime.spec.ts:1328`。 |
| D-03 路由安全不放宽 | 自动化 PASS | `routes.spec.ts:314`（非 loopback/跨域伪造 403）、`:337`（回环别名放行、非回环 Host 403）；`subagent-routes.spec.ts:65/77`（参数校验）；`route-contract.spec.ts:376`（双端 71 方法一致）。 |
| D-04 权限与沙箱不回归 | 自动化 PASS | `agent-package-catalog-security.spec.ts` 27 条全部通过（签名复验、吊销、取消释放）；`skills.spec.ts` 37 条（restrict/allow 既有路径）；未放宽任何 allow/policy/sandbox。**明确不宣称**修复 M1 遗留的 legacy 首轮 allow、provider 忽略预留 childId 等相邻安全债。 |
| D-05 既有取消语义不变 | 自动化 PASS | `sessions.spec.ts:1013`（父 + children）、`:1030/1058`（不取消兄弟 session/channel）；定向取消是新增 RPC，未替换 `session.cancel`。 |
| D-06 普通会话无回归 | 自动化 PASS | `bridge.spec.ts:683`（有 registry 时未登记 session 原样通过）；全量套件（huaanwork 3503 tests）通过。 |
| D-07 非目标未混入 | 自动化 PASS | 代码/测试核对：未新增任务级 SLA 或无活动自动停止（`subagent-runs.spec.ts:155` 只记活动）、无控制面持久化（snapshot 仅内存）、无嵌套树；`spawn` 未被当 OS kill。 |
| D-08 代码边界 | 自动化 PASS | `git status`：仅 `dsh-plugin-huaanwork/` 与 `docs/` 未跟踪文档；`deepseek-harness/` 子模组干净；stable/beta 源码零改动；变体守卫未新增白名单（65/6 与 7/0 与基线一致）。 |

### E. 工程放行与真实组合

| 条目 | 判定 | 证据与缺口 |
| --- | --- | --- |
| E-01 定向自动化全部通过 | 自动化 PASS | 见 §3.1（52 文件 / 737 用例，退出码 0）。 |
| E-02 仓库门禁通过 | 自动化 PASS | 见 §3.2（typecheck / test / check:desktop-variants / check 全部退出码 0）。 |
| E-03 真实完成链路 | Blocked（真机未执行） | 未启动 GUI、无真实 legacy/package `@` 运行；不以单测/mock 代替。 |
| E-04 真实取消链路 | Blocked（真机未执行） | 同上；启动中/运行中定向终止的真机表现未核对。 |
| E-05 真实组合场景 | Blocked（真机未执行） | 多 tab、同名并发、父 idle 后子代理仍运行、WS 重连、清理未确认提示均未真机执行。 |
| E-06 平台证据诚实 | macOS：Blocked；Windows：**未验证** | 本轮 macOS 仅跑 headless 门禁；Windows 无任何执行证据，也未引用 CI 冒充真机。 |

## 5. 自动化不能证明的事实

1. **真实 `@` 路径**：没有任何一次真实 spawn 的 legacy `@agent` 或 package `@slug` 运行；卡片是否真的出现在对应用户消息之后、标题/版本是否正确，未经观察。
2. **真实事件时序**：启动中、工具活动、finalizing、终态在真实模型回合中的到达顺序与视觉呈现，只由 reducer/registry 单测与假时钟覆盖。
3. **真实渲染**：三行层级、长名称截断、280px 无横向滚动、44×44 命中区是否重叠、reduced-motion 实际生效、浅色/深色对比与读屏播报，均未目检/实测。
4. **真实取消**：点击 → 卡内确认 → accepted → stopping → stopped 的真机时序，父/兄弟是否不受影响，未经真机核对；`accepted` 提前显示为 stopped 的反例无法靠单测排除。
5. **真实重连与 Host 重启**：真实 WebSocket 断线、snapshot 对账、generation 切换后旧卡失效，只覆盖纯函数与组件层。
6. **真实短预算**：应用没有受控的短预算注入通道（legacy 为模块常量、package 为内部选项），A-08 的真机子项无法在不改生产常量的前提下执行。
7. **平台矩阵**：Windows 完全未验证；本轮也未产生任何已签名/打包制品证据。

因此：**功能验收未完成**。设计 §10.1 的「验收通过判定」要求 A–D 全部通过且 E-01～E-05 通过；当前只有 E-01/E-02 自动化通过，A/B/C/D 中依赖真机的条目与 E-03～E-05 均为 Blocked。

## 6. Blocked 清单（等待用户明确同意图形启动）

| 场景（brief Step 3） | 状态 |
| --- | --- |
| 1. 启动 → 真实工具活动 → 完成；三行卡、工具名、耗时、终态单行 | Blocked |
| 2. 启动中/运行中定向终止；卡内二次确认、accepted→stopping→stopped、父/兄弟不受影响 | Blocked |
| 3. 父 idle 后子代理仍运行；卡片更新与终止入口 | Blocked |
| 4. 同名并发、多 tab、长名称、并发工具、断连重连、Host 重启失效视图 | Blocked |
| 5. 清理未确认与 60 秒提醒；真实清理失败不伪报 stopped | Blocked |
| 6. A-08 收尾预算真机子项（legacy / package 各一条） | Blocked（无受控短预算通道；未改生产常量） |
| 7. 键盘完整路径、window Esc、焦点返回、44×44 命中区、reduced-motion、280px、浅色/深色、读屏抽查 | Blocked |
| `/design-review` 真实视觉 QA | Blocked（未获授权，未执行） |
| Windows 平台 | 未验证 |
| 真实 legacy `@agent` / package `@slug` 可用性（名称、版本、Desktop SHA、Harness pin、构建类型、测试人） | 未采集（无真机运行） |

## 7. 复跑方式

```bash
# Step 1
corepack yarn workspace dsh-plugin-huaanwork test \
  tests/huaanwork-host/subagent-runs.spec.ts tests/huaanwork-host/route-contract.spec.ts \
  tests/huaanwork-host/subagent-routes.spec.ts tests/huaanwork-host/sessions.spec.ts \
  tests/huaanwork-host/agent-package-lifecycle.spec.ts tests/huaanwork-host/agent-package-runtime.spec.ts \
  tests/huaanwork-host/agent-package-catalog-security.spec.ts \
  tests/huaanwork-guardrails/skills.spec.ts tests/huaanwork-guardrails/bridge.spec.ts \
  tests/client-huaanwork

# Step 2（严格串行）
corepack yarn typecheck
corepack yarn test
corepack yarn check:desktop-variants
corepack yarn check
```

日志目录：`.superpowers/sdd/2026-10-26-subagent-run-visibility/logs/`（`step1-targeted-tests.log`、`typecheck.log`、`test.log`、`check-desktop-variants.log`、`check.log`，各附 `.exit`/`.start`/`.end`）。

## 最终修复后复跑（2026-10-27）

本节记录终审修复波之后的完整自动化复跑，用于让本文件的证据与最终工作树对齐。§1–§7 的结构、判定口径与 Blocked 清单均不变；被复跑覆盖的数值以本节为准（定向 737→**741**、huaanwork 3503→**3507**、根 vitest 8493→**8497**），其余 workspace 计数与修复前完全一致。

**修复摘要（一句）**：终审修复波把「清理确认」由一次性事件改为持久状态——`subagent-runs.ts` 用 `RunRecord.cleanupOk` 记住 owner 最近一次结论，并让 `settleStopped` 成为 `stopping + executionEnded + cleanupOk → stopped` 的唯一求值点，`agent-package/host.ts` 的两处 `ok` 判据收敛为唯一 `cleanupOk()`，并在晚到 activation 出现时以 `{ok:false}` 撤回早先的成功结论；`subagent-runs.spec.ts` 由 15 条增至 19 条，设计 §5.2 新增一条澄清 bullet。

### 基线与约束

- HEAD 仍 `692f12f50756782255d0b8a2e0f1aa0ff24e8620`（**无提交**），分支 `refactor/huaanwork-single-desktop`，子模组 pin `1600d8a1e140dcde43a1a0941940a0480712c011`。
- 源码零改动：复跑前后 `git status --short` 完全相同（29 个已跟踪文件修改 + 12 个未跟踪路径）；`git diff --stat` = 3948 insertions / 584 deletions。§2 的 3941 / 589 是修复前（13:37 快照）的数值，本节为修复后现值；差额即修复波本身。
- 被修文件 mtime 均早于本次复跑：`subagent-runs.ts` 13:52、`agent-package/host.ts` 13:51、`subagent-runs.spec.ts` 13:54、设计文档 13:53；本轮首条命令 14:00 之后启动。
- 五条命令**严格串行**：每次等上一条退出并记录 `EXIT_CODE` 后才启动下一条。未启动 GUI、Electron、`corepack yarn dev` 或 `/design-review`；未改源码、测试、包文件或设计文档；未派 subagent/reviewer；无提交。
- 每份日志尾部由脚本追加 `EXIT_CODE=` 与 `FINISHED_UTC=` 两行，退出码不依赖人工判读。

### 门禁结果

| # | 命令 | 退出码 | 计数/关键输出 | 结果 | 耗时 | 日志 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `corepack yarn workspace dsh-plugin-huaanwork test <brief 的 10 个目标>` | 0 | `Test Files 52 passed (52)`；`Tests 741 passed (741)`（无 skipped、无 fail） | PASS | 8.02s（vitest 自报；含启动约 13s） | `logs/post-fix-step1-targeted-tests.log` |
| 2 | `corepack yarn typecheck` | 0 | 11 个 workspace 的 `tsc` 全绿（无诊断输出）；尾行 `contract-types: 4 generated type files are current` | PASS | ≈50s | `logs/post-fix-typecheck.log` |
| 3 | `corepack yarn test` | 0 | vitest 8 个 workspace：**8497 passed / 37 skipped**；`node:test` 8 个 workspace：`168 tests / 166 pass / 2 skipped / 0 fail` | PASS | ≈114s | `logs/post-fix-test.log` |
| 4 | `corepack yarn check:desktop-variants` | 0 | `1..11` 全 `ok`，`# pass 11 / # fail 0`；`stable↔beta src (214) / scripts (33)`、`beta↔huaanwork src (168) / scripts (21)` 对齐；`stable↔beta allowlist 7 (oneSidedPrefixes 0)`、`beta↔huaanwork allowlist 65 (oneSidedPrefixes 6)` | PASS | ≈12s（内部 `duration_ms` 2506） | `logs/post-fix-check-desktop-variants.log` |
| 5 | `corepack yarn check` | 0 | 见下（根步骤 + 13 个 workspace/包 `check` 全绿） | PASS | 3m36s | `logs/post-fix-check.log` |

门禁 1 的完整命令（与 brief 逐字一致，仅加 `>` 重定向）：

```bash
corepack yarn workspace dsh-plugin-huaanwork test tests/huaanwork-host/subagent-runs.spec.ts tests/huaanwork-host/route-contract.spec.ts tests/huaanwork-host/subagent-routes.spec.ts tests/huaanwork-host/sessions.spec.ts tests/huaanwork-host/agent-package-lifecycle.spec.ts tests/huaanwork-host/agent-package-runtime.spec.ts tests/huaanwork-host/agent-package-catalog-security.spec.ts tests/huaanwork-guardrails/skills.spec.ts tests/huaanwork-guardrails/bridge.spec.ts tests/client-huaanwork
```

#### 定向测试逐文件计数（门禁 1）

| 定向对象 | 用例数 | 与 §3.1 对比 |
| --- | --- | --- |
| `tests/huaanwork-host/subagent-runs.spec.ts` | 19 | +4（修复波新增的三条反向钉与一条终态不改写用例） |
| `tests/huaanwork-host/route-contract.spec.ts` | 6 | 不变 |
| `tests/huaanwork-host/subagent-routes.spec.ts` | 3 | 不变 |
| `tests/huaanwork-host/sessions.spec.ts` | 43 | 不变 |
| `tests/huaanwork-host/agent-package-lifecycle.spec.ts` | 2 | 不变 |
| `tests/huaanwork-host/agent-package-runtime.spec.ts` | 54 | 不变 |
| `tests/huaanwork-host/agent-package-catalog-security.spec.ts` | 27 | 不变 |
| `tests/huaanwork-guardrails/skills.spec.ts` | 37 | 不变 |
| `tests/huaanwork-guardrails/bridge.spec.ts` | 22 | 不变 |
| `tests/client-huaanwork/`（目录，42 个 spec） | 526 | 不变 |
| `tests/client-huaanwork-shell.spec.ts`（目录前缀命中） | 2 | 不变 |

stderr 中的 `refreshAgentRestrict: restrict state not found` 仍是既有负例 fixture 的预期打印；整轮无 FAIL、无跳过。

#### `corepack yarn check` 组成（门禁 5）

- 根步骤：`check:whitespace`（静默通过）、`check:layout`、`test:aa-connector`（4 个 Desktop 变体各一条 `ok`，凭据脱敏）。
- `check:layout` 内部：`test:market-release`（5）、`test:aa-release`（14）、`check:bilingual-docs`（4；`55 records and 110 documents`）、`check:architecture`（9；`verify-market-dependency-direction: 848 tracked source files`）、`check:vendored-runtime`（11；`sync-vendored-runtime` stable 318 / beta 341 / huaanwork 341，均 `1600d8a1e1`）、`check:desktop-variants`（11）、`icons:check`（1；stable/beta/next 三行 `match`）、`verify-layout`（1；`all Desktop workspaces including Next and upstream 1600d8a1e1 are consistent`）、`test:gate-scripts`（12）、`check:readme-versions`（4 处版本串匹配）。
- 各 workspace 的 `check`：`dsh-community-fabric`（20 个 Markdown/10 组双语）、`dsh-community-market`（`303` tests，13 文件）、`dsh-plugin-desktop`（`1812 passed / 11 skipped`，143 文件）、`dsh-plugin-desktop-beta`（`1822 passed / 11 skipped`，143 文件）、`dsh-desktop-next`（`641 passed / 1 skipped`，77 文件）、`dsh-plugin-huaanwork`（**`3507 passed / 14 skipped`**，265 文件 + 4 skipped 文件）、`market-server`（`244`）、`update-server`（`88`）、`agent-catalog-server`（`80`）、`@huaanwork/catalog-signing`（13）、`@huaanwork/agent-package-format`（35）、`agent-catalog-admin`（15），`node:test` 侧全部 `# fail 0`。
- 验证脚本：`verify-runtime-closure`（297 / 316 / 316 节点闭包）、`verify-bundled-runtime`（131 文件、9 bundled、tar 编入 lib）、`verify-licenses`（610 / 641 / 651 包，含 9 bundled）、`verify-profile-boot`（见下）、`verify-operation-reliability`（7 operations / 18 fault contracts）、huaanwork `host-loop-smoke`（31 tests）。
- 既有噪音（与修复前 `check.log` 一致，非本轮新增）：`host-loop-smoke: warning: 2 entries did not activate` 出现 2 次；desktop/beta 用例打印的 `renderer failed to load (-105/-102)` 是既有诊断 fixture 输出。

#### `verify:aa` 与 flake 观察（门禁 5）

- 三个 Desktop 包的 `check` 均含未被 `AA-skip` 移除的 `verify:aa`，且全部通过。
- desktop/beta 用 `run-parallel.mjs` 并行执行各 verify 步骤，行序不能证明步骤身份；按计数核对：`Creator, plugin manager and two Profile HMR generations passed` 出现 **4 次**，与两包合计 `verify:profile` + `verify:aa` 的 2×2 相符（与修复前同值）。
- huaanwork 的 `check` 是串行 `&&` 链，行序可核：`minimal preset, plugin manager, and disabled hmr lock passed` 出现在 `logs/post-fix-check.log:2650` 与 `:2856`，分别位于 `verify:host`（host-loop-smoke 31 tests）之前与之后，对应 `verify:profile` 与 `verify:aa`；随后 `verify:licenses`（651 包）与 `verify:operations` 通过。
- **未出现** `verify:aa` 并发进程冲突签名（无 `AA Host` 冲突、无 `DSH Host call cancelled or timed out`），因此本轮未触发单包复跑；不存在把真红写成 flake 或反向的情形。

### 本轮失败与未执行

- 五条门禁退出码均为 0；无测试失败、无超时、无跳过新增。
- 未执行且仍未获授权：任何图形启动、真实 `@` 运行、截图/视觉 QA、真机键盘/读屏/计时核对。
- **GUI 与真机项仍为 Blocked**：§4 中标注 `自动化仅覆盖部分` 与 `Blocked（真机未执行）` 的条目、§5 的七条「自动化不能证明的事实」、§6 的 Blocked 清单（含 `/design-review`、短预算真机子项、Windows 平台）全部**未被本次复跑改变**。本次复跑只证明：最终工作树上的自动化断言成立。
- 因此结论仍是：**功能验收未完成**；E-01/E-02 为 PASS，E-03～E-06 与 A/B/C/D 的真机子项保持 Blocked / 未验证。

## 真机验收（2026-10-27，Electron 44 + deepseek-flash）

本节把控制器在活应用中采集的事实（`.superpowers/sdd/2026-10-26-subagent-run-visibility/gui-acceptance-facts.md`）转写为验收判定。判定只用该事实文件，不补充观测、不把「部分/Blocked」改写成 PASS。判定口径：**PASS** = 该条目在真机上被完整观察；**部分** = 该条目的部分子项在真机上被观察，其余子项未执行；**Blocked** = 该条目在真机上完全未执行或未观察。自动化证据仍见 §4。

### 环境与隔离

| 项 | 事实 |
| --- | --- |
| 平台 | macOS arm64（Darwin 27.0.0） |
| 运行时 | Electron 44.0.0，Node `v22.23.2`，Yarn `4.18.0` |
| 基线 | 外层 HEAD `692f12f507`，Harness pin `1600d8a1e140dcde43a1a0941940a0480712c011`；被测对象为**未提交工作树** |
| 隔离 | 临时 `DSH_HOME` 与 `--user-data-dir` 副本位于 `/tmp/huaanwork-accept-20261027-142256`；用户真实 profile 未被修改；以 workspace Electron 启动并带 `--remote-debugging-port=9333` |
| 模型 | 副本 profile 的当前 active model：`deepseek-flash`，端点 `https://api.deepseek.com`；未改任何设置 |
| 目标包 | 本地 `@doc-clerk` v1.0.0（已启用；`tools` 模式为 `none`，但包内子会话始终获得 read/glob/grep/bash + skill 脚本） |
| legacy `@agent` 目标 | **不可用**：legacy 目录 host `10.130.209.76:18080` 从本机超时，本地 `agents-endpoints.json` 只含 `kind: tool` 条目 ⇒ 没有可执行的 legacy 真实路径 |
| 被测树与修复的关系 | 真机运行发生在 reduced-motion CSS 修复**之前**的工作树；该缺陷随后修复并在活应用中复验（见下）；本节的最终树门禁复跑发生在修复**之后** |

### 最终树门禁复跑（CSS 修复后，严格串行）

五条命令逐条等待退出后再启动下一条；每份日志尾部追加 `EXIT_CODE=` 与 `FINISHED_UTC=`，退出码不依赖人工判读。

| # | 命令 | 退出码 | 计数/关键输出 | 结果 | 耗时 | 日志 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `corepack yarn workspace dsh-plugin-huaanwork test <brief 的 10 个目标>` | 0 | `Test Files 52 passed (52)`；**`Tests 742 passed (742)`**（无 skipped、无 fail） | PASS | 8.06s（vitest 自报） | `logs/final-step1-targeted-tests.log` |
| 2 | `corepack yarn typecheck` | 0 | 11 个 workspace 的 `tsc` 全绿（无诊断输出）；尾行 `contract-types: 4 generated type files are current` | PASS | ≈35s | `logs/final-typecheck.log` |
| 3 | `corepack yarn test` | 0 | vitest 8 个 workspace：**8498 passed / 37 skipped**；`node:test` 8 个 workspace：`168 tests / 166 pass / 2 skipped / 0 fail` | PASS | ≈105s | `logs/final-test.log` |
| 4 | `corepack yarn check:desktop-variants` | 0 | `1..11` 全 `ok`，`# pass 11 / # fail 0`；`stable↔beta src (214) / scripts (33)`、`beta↔huaanwork src (168) / scripts (21)` 对齐；`stable↔beta allowlist 7 (oneSidedPrefixes 0)`、`beta↔huaanwork allowlist 65 (oneSidedPrefixes 6)` | PASS | ≈3s（内部 `duration_ms` 2431） | `logs/final-check-desktop-variants.log` |
| 5 | `corepack yarn check`（第 1 次） | **1** | 前 10 步（含 huaanwork `3508 passed / 14 skipped`）全绿；第 11 步 `update-server` 的 `artifact-validate.spec.ts`「refuses a real UDZO dmg whose packed app executable is arm64-only」因 `hdiutil create` 失败而红（87/88）；其后 4 个 workspace 未运行 | **FAIL（环境工具 flake）** | 178s | `logs/final-check-run1-failed.log` |
| 5 | `corepack yarn check`（第 2 次，整条重跑） | 0 | 15 步全绿；vitest 合计 **8498 passed / 37 skipped**（market 303、desktop 1812/11、beta 1822/11、next 641/1、huaanwork **3508/14**、market-server 244、update-server 88、agent-catalog-server 80）；`node:test` 178 pass / 0 fail；`verify:aa` 无并发冲突签名 | PASS | 202s | `logs/final-check-retry.log` |

第 1 次 `corepack yarn check` 的失败点不在本功能面：`update-server` 未被本次改动触及（`git status` 29 个已跟踪文件全部位于 `dsh-plugin-huaanwork/src|tests` 与 `docs/`），同一 spec 在同文件前一条用例里刚用 `hdiutil` 成功产出 UDZO 镜像（9.4s），失败信息只有 `Command failed: hdiutil create -quiet -format UDZO …`，无本仓诊断。单独重跑该 spec（`corepack yarn workspace update-server test tests/artifact-validate.spec.ts`）得到 `5 files passed / 88 tests passed`，日志 `logs/final-update-server-rerun.log`。因此按既有的「受影响 workspace 单独复跑并保留两份输出」处理：两份 `check` 日志都保留，结论以整条重跑的绿灯为准，但第 1 次的失败在报告中如实登记，不写成 flake 免责。复跑后与 CSS 修复前的差异恰好是 +1 条用例（742 vs 741、8498 vs 8497、huaanwork 3508 vs 3507），即 CSS 修复波新增的契约钉。

### A–E 判定

| 条目 | 真机判定 | 依据（facts 编号）与缺口 |
| --- | --- | --- |
| A-01 独立运行卡 | PASS（package）／legacy Blocked | #1：`@doc-clerk ...` 消息下方紧邻一张卡，每条显式 `@` 各自成卡（全会话 7 张），截图 05。legacy 无运行，故 legacy 子项 Blocked。 |
| A-02 启动状态可信 | PASS | #2：卡先渲染「启动中 · @doc-clerk · v1.0.0 · 终止 · 启动中 · 00:00 · 最近活动 0 秒前」，早于任何 token。 |
| A-03 生命周期完整 | 部分 | #3：观察到 `启动中 → 生成中 → 正在执行工具 → 已完成` 与 `启动中 → 已停止`；`finalizing` 未被目视（子会话 idle → 结果窗口很短），仅由单测覆盖。 |
| A-04 工具状态准确 | 部分 | #4：真实工具名可见（`正在执行工具 · bash`），工具结束后该提示消失；子会话一次只跑一个工具，**并发工具未在 GUI 验证**。 |
| A-05 终态映射诚实 | 部分 | #5：`completed` 渲染「已完成」、定向取消渲染「已停止」；`failed`/`max-tokens`/`refusal` 未在 GUI 诱发。 |
| A-06 父 idle 后仍可用 | Blocked | facts「Parent idle while child runs」：每次运行父回合都保持活跃直到子结果；composer 的发送键是该回合的停止控件，无法作为父 idle 探针 ⇒ 真机未观察。 |
| A-07 耗时与静默提示 | 部分 | #2 的卡面显示 `00:00` 与「最近活动 0 秒前」；但父 idle 后继续计时/继续更新的真机子项与 A-06 同因 Blocked。 |
| A-08 收尾预算语义 | Blocked | facts：生产构建没有包/legacy 清理预算的注入通道，真机子项未执行；单测证据见 §4。 |
| A-09 父子消息流隔离 | PASS | #6：父 transcript 只有父自己的 reasoning/工具与最终回答，父消息流里没有子 token/reasoning/工具流。 |
| A-10 多标签归属正确 | Blocked | facts：多 tab 与同标签并发未执行（只有顺序出现的同名卡）。 |
| A-11 可访问性 | 部分 | #9 与 facts：焦点/键盘路径已验证；真实读屏播报未测（无辅助技术环境）。 |
| A-12 视觉层级与工具展示 | 部分 | #7：活跃卡三行；同名卡在头部与可访问名里带 `HH:MM:SS`（如 `14:24:36`、`14:28:20`），包显示版本；长名称截断未执行。 |
| A-13 终态与失效视图 | 部分 | #8：终态卡收为单行，干净的完成卡没有展开入口（无告警/细节），与 D5 一致；WS 断连/Host 重启的失效视图未复现（见 C-05…C-09）。 |
| A-14 文案与提醒 | Blocked | facts：停止等待 60 秒、清理预算横幅、finalizing 细节与 failed 终态文案均未观察（运行都短且干净）。 |
| A-15 终止确认与焦点 | PASS | #9：首击「终止」只开卡内确认，初始焦点为「取消」按钮；真实 Escape 键关闭确认并归还焦点到「终止」按钮（`aria-label="终止 @doc-clerk 本次运行，开始于 14:26:27"`）；终止/确认/取消/展开高 44 px（宽 57–276 px）；无模态对话框；关闭后 Escape 监听已移除。 |
| A-16 动效、窄窗口与读屏 | 部分 | #10：活跃圆点计算值原为 `animation-name: tool-pulse`，模拟 `prefers-reduced-motion: reduce` 后**修复前仍为 `tool-pulse`**、修复后为 `none`；深色主题（`html[data-theme="dark"]`）落在 `rgb(28, 30, 36)` token；380 px 视口下卡宽 280 px 且 `document.documentElement.scrollWidth === clientWidth (380)`（无页面级横向滚动），截图 12；真实读屏未运行。 |
| B-01 legacy 运行中终止 | 部分（package PASS；legacy Blocked） | #11：`启动中`（00:00 时出卡）与 `正在执行工具 · bash` 两处定向取消均经卡内确认收敛为「已停止」（后者约 1 s）；取消请求只由卡发出，父会话随后仍可用并产出自己的回答。legacy 无运行。 |
| B-02 package 运行中终止 | PASS | #11 同上（package 路径）。 |
| B-03 legacy 启动中终止 | Blocked | facts Blocked 段：legacy 目录 host 不可达、无本地 `kind: agent` 条目。 |
| B-04 package 启动中终止 | 部分 | #12：启动相位取消已在包卡上执行；`createRuntime` vs `startActivation` 的确切在途点从界面不可观测，内部相位由包测试覆盖。 |
| B-05 停止过程可见 | Blocked | facts 未记录「停止中」相位的目视证据；两次取消都在约 1 s 内到达「已停止」。 |
| B-06 幂等与终态处理 | Blocked | #14：重复定向取消未执行（run 终态后终止控件即消失）；只有路由/registry 单测覆盖幂等。 |
| B-07 cancel/end 竞态 | Blocked | facts 无该时序的真机观察。 |
| B-08 清理失败不伪报 | Blocked | facts：清理失败未被诱发，只有单测。 |
| B-09 其他取消来源可反映 | PASS | #13：包子会话运行期间用 composer 的回合键做父级停止，运行卡转为「已停止」且没有定向取消（权威 `aborted` → `stopped`）。这是意外探针，但仍是父级取消路径的有效证据。 |
| B-10 定向取消边界 | Blocked | #11/#14：取消只由卡发起，未构造越界/跨父请求；边界只有 `subagent-routes.spec.ts` 覆盖。 |
| C-01 同名与同 slug 并发 | Blocked | facts：同名卡只是顺序出现，未并发（#1 的 7 张卡、#7 的时间戳均为串行）。 |
| C-02 旧事件不串扰 | Blocked | facts 无该场景的真机观察。 |
| C-03 重复结算幂等 | Blocked | facts 无该场景的真机观察。 |
| C-04 停止后迟到事件 | Blocked | facts 无该场景的真机观察。 |
| C-05 WS 断线重连 | Blocked | facts：Chromium `Network.emulateNetworkConditions(offline)` 没有切断进程内 loopback WebSocket，运行照常继续；无安全受控通道。 |
| C-06 snapshot/WS 竞态 | Blocked | 随 C-05 未执行。 |
| C-07 Host 代际切换 | Blocked | facts：没有只重启 Host utility process 的安全手段。 |
| C-08 历史有界 | Blocked | facts 未观察 20/父、200/全局的淘汰行为（7 张卡远未触界）。 |
| C-09 Host 重启 | Blocked | 见 C-05/C-07；重启后失效视图未执行。 |
| D-01 投影不泄密 | 部分 | #6 的可见面：父流与卡片都没有子 token/reasoning/工具正文；真实 wire payload 未采证。 |
| D-02 启动绑定 fail closed | Blocked | facts 无真机采证（由单测覆盖）。 |
| D-03 路由安全不放宽 | Blocked | facts 无真机采证（应用只走本机 loopback）；见 §4 的自动化判定。 |
| D-04 权限与沙箱不回归 | Blocked | facts 无真机采证；只沿用 §4 的自动化判定，不在真机表里宣称。 |
| D-05 既有取消语义不变 | Blocked | 真机只执行了定向取消与父级停止（#11、#13），未构造既有会话取消语义的对照。 |
| D-06 普通会话无回归 | 部分 | #11：父会话在子运行被取消后仍可用并产出自己的回答；未做系统性普通会话回归。 |
| D-07 非目标未混入 | Blocked | facts 无真机采证（代码面见 §4）。 |
| D-08 代码边界 | Blocked（真机维度） | 真机不产生该项证据；代码边界判定仍以 §4 的 `git status` 为准。 |
| E-01 定向自动化全部通过 | PASS | 见上表门禁 1（52 文件 / 742 用例，退出码 0）。 |
| E-02 仓库门禁通过 | PASS | 见上表门禁 2–5（第 5 条以整条重跑为准，第 1 次失败已登记）。 |
| E-03 真实完成链路 | 部分 | facts 诚实结论：**package 路径的完成**在真实 Electron 应用中已验证；legacy 完成链路 Blocked。 |
| E-04 真实取消链路 | 部分 | 同上：package 路径的定向取消（启动中/运行中）已验证；legacy 与重复取消 Blocked。 |
| E-05 真实组合场景 | Blocked | 多 tab、同名并发、父 idle 后子代理继续运行、WS 重连、清理未确认提示均未执行。 |
| E-06 平台证据诚实 | 部分 | macOS：package 路径有真机证据、legacy/断连/重启无；Windows：**未验证**，未用 CI 冒充真机。 |

> **E-05 补充（2026-10-27）**：本文末〈E-05 真实组合补充（2026-10-27）〉取代上表中 A-06、A-07、A-10、A-13、B-01、B-03、C-01、C-05、E-03、E-04、E-06 各行，并取代本节〈结论〉里「E-05 整条 Blocked」的表述；未在该补充中改判的条目（C-07/C-09、B-08、A-14、Windows）保持原判定，上表本身不改写。

### 真机缺陷与修复：reduced-motion 下活跃圆点仍在脉冲

- **现象（A-16/D22）**：`matchMedia('(prefers-reduced-motion: reduce)').matches === true` 时，活跃运行卡圆点的 `getComputedStyle(dot).animationName` 仍为 `tool-pulse`。
- **根因是级联权重，不是规则缺失**：相位规则 `.subagent-run-card[data-phase="tool"] .subagent-run-dot`（`styles.css:3693-3699`）权重 `(0,3,0)`；reduce 块里的复位规则原为 `.subagent-run-card .subagent-run-dot`（权重 `(0,2,0)`），从未参与竞争。
- **修复**：复位选择器改为 `.subagent-run-card[data-phase] .subagent-run-dot { animation: none; }`（`styles.css:3745`，位于 `@media (prefers-reduced-motion: reduce)` 块内，`:3744`）。`@media` 不改变权重，两条规则同权重时按源序后者胜出，而 reduce 块位于全部相位规则之后；`[data-phase]` 是属性存在选择器、卡片根节点恒有该属性，故 starting/reasoning/generating/tool 四个脉冲相位与 finalizing/stopping 两个静止相位一律被覆盖，未使用 `!important`，也未改相位的底色与 stale/frozen 弱化。
- **生成物与回归钉**：`styles.generated.ts` 由 `corepack yarn workspace dsh-plugin-huaanwork gen:styles` 重新生成（运行时只注入该文件，见 `shell.ts:17`）；`tests/client-huaanwork/SubagentRunCard.spec.ts:643` 新增契约用例（`reducedMotionBlock()` 提取器在 `:576`），断言 reduce 块内命中「相位限定 + `animation: none`」、块内不含裸 `.subagent-run-card .subagent-run-dot`、且相位脉冲规则的源序早于 reduce 块。改回旧选择器时该用例红（1 failed / 22 passed），恢复后绿；这也是门禁 1 相对修复前 +1 条用例、总数 742 的来源。
- **复验**：在活应用中把选择器改后重测，`reduce: true` 时 `animation-name: none`（截图 14 = 修复前，15 = 修复后）。同一 `tool-pulse` 形状的 `.tool-row.running .tool-icon`（`styles.css:931`）没有 reduce 复位规则，属既有工具行呈现、不在本次缺陷范围，未改。

### 证据路径（git-ignored 暂存，不随提交分发）

`.superpowers/` 由 `.git/info/exclude:8` 排除，下列路径均为暂存证据：

- 截图（13 张）：`.superpowers/sdd/2026-10-26-subagent-run-visibility/screenshots/` 下的 `01-package-completed.png`、`02-package-card-completed.png`、`03-package-card-tool-active.png`、`04-package-confirm.png`、`05-active-tool-card.png`、`06-active-card-dark.png`、`07-offline-frozen.png`、`10-active-expanded.png`、`11-active-dark.png`、`12-narrow-380.png`、`13-stopped-card.png`、`14-reduced-motion.png`、`15-reduced-motion-fixed.png`。
- 应用日志：`.superpowers/sdd/2026-10-26-subagent-run-visibility/logs/gui-app.log`、`gui-app-2.log`。
- 门禁日志：同目录下 `final-step1-targeted-tests.log`、`final-typecheck.log`、`final-test.log`、`final-check-desktop-variants.log`、`final-check-run1-failed.log`、`final-check-retry.log`、`final-update-server-rerun.log`（各含 `STARTED_UTC` / `EXIT_CODE` / `FINISHED_UTC`）。
- 事实与修复来源：同目录 `gui-acceptance-facts.md`、`final-fix-report.md`（§6）。

### 结论

- **package 路径的完成与定向取消已经在真实 Electron 应用中验证**：卡锚定、启动即显、真实工具名、完成/已停止终态、卡内确认 + 焦点 + Escape、父流隔离、父级停止反映、深色/380 px/减动效复用均按事实文件记录。
- **仍然 Blocked / 未验证**：legacy `@agent` 全链路（目录 host 不可达）、A-06/A-07 的父 idle 真机子项、A-08 真实短预算、C-05…C-09 的断连重连与 Host 重启失效视图、B-05/B-06/B-07/B-08/B-10 的停止过程/幂等/竞态/清理失败/边界、A-10 与 C-01 的多 tab 与同名并发、A-11/A-16 的真实读屏播报、A-14 的 60 秒提醒与预算横幅文案、以及 **Windows 平台（未验证）**。
- 因此按设计 §10.1 的「验收通过判定」，**功能仍未完全验收**：E-03/E-04 只覆盖 package 路径，E-05 整条 Blocked，E-06 的 Windows 与 legacy 侧无证据。本节的 PASS 只覆盖上表明确列出的子项，不构成整体放行。

## E-05 真实组合补充（2026-10-27）

> **注（2026-10-27 收口）**：本文末〈收口验收补充（2026-10-27，验收钩子与故障注入）〉取代本节列出的同名条目（以及〈真机验收（2026-10-27，Electron 44 + deepseek-flash）〉中同名的行），未被该节改判的条目保持本节判定。

本节把控制器在活应用中补采的第二批事实（`.superpowers/sdd/2026-10-26-subagent-run-visibility/e05-acceptance-facts.md`）转写为判定，取代〈真机验收（2026-10-27，Electron 44 + deepseek-flash）〉中列出的同名条目。判定口径与该节一致：**PASS** = 条目在真机上被完整观察；**部分** = 仅部分子项被观察；**Blocked** = 完全未执行或未观察。本节只使用该事实文件，不补充未观测的结论。

### 环境与 legacy 夹具

| 项 | 事实 |
| --- | --- |
| 隔离 | 沿用同一临时 profile 副本 `/tmp/huaanwork-accept-20261027-142256`（临时 `DSH_HOME` + `--user-data-dir`）；用户真实 profile 未修改 |
| 运行时 | Electron 44.0.0；模型 `deepseek-flash` |
| legacy 通道 | 仅为 legacy 路径把临时 profile 的 `agents_host` 指向本地夹具目录 `127.0.0.1:18080`，该目录按契约提供一条 `kind: "agent"` 条目 `legacy-demo`（inline persona，允许 `bash`/`read_file`/`glob`/`grep`） |
| 真实内网目录 | `10.130.209.76:18080` 仍不可达；未以夹具冒充内网目录可用 |
| 被测树 | 多标签修复在真机复验时仍未提交；该修复随后提交为 `52618cb8b8`（`fix: preserve subagent run cards across tab switches`），提交后重新执行了最终树门禁（见本节末行）。真机事实采集于外层 HEAD `6c1f139e44` + 未提交多标签修复的工作树 |

夹具给的是真实 legacy `@agent` 执行路径（真实 spawn、真实模型回合、真实工具），但它不是内网目录：内网目录的可用性、条目内容与网络条件仍未验证。

### 取代上表的判定

| 条目 | 本节判定 | 被取代的旧判定 | 事实依据 |
| --- | --- | --- | --- |
| A-06 父 idle 后仍可用 | **PASS** | Blocked | 父回合只回「已委派」；子会话进入 `正在执行工具 · bash` 后 composer 由「停止」回到「发送」（父回合 idle），运行卡继续更新（耗时 00:00 → 00:15、最近活动递增、终止可用） |
| A-07 耗时与静默提示 | **部分** | 部分 | 父 idle 期间耗时与「最近活动」持续更新属实；**5 分钟无活动提醒未观察**（运行均短于 5 分钟），该子项仍无真机证据 |
| A-10 多标签归属正确 | **PASS** | Blocked | 标签 A（legacy 已完成卡）与标签 B（package `@doc-clerk` 已完成卡）经侧栏来回切换后各自保留卡片、无跨标签泄漏（截图 21–24）；期间发现并修复一处多标签缺陷（见下） |
| A-13 终态与失效视图 | **部分** | 部分 | **冻结视图 PASS**：断连期间卡片显示「连接中断，状态可能滞后」、终止禁用、耗时冻结（截图 27），重连后恢复（截图 28）；**Host 重启后的 stale 视图仍 Blocked**（见下） |
| B-01 legacy 运行中终止 | **PASS** | 部分（package PASS；legacy Blocked） | 工具相位的 legacy 卡卡内确认 → `已停止`（00:01，截图 18），父会话不受影响；**兄弟隔离**：取消同标签并发的第二张卡（00:10 → 已停止）不影响第一张，第一张自然完成（00:33） |
| B-03 legacy 启动中终止 | **PASS** | Blocked | `启动中` 相位卡内确认 → `已停止`（00:00，截图 17） |
| C-01 同名与同 slug 并发 | **PASS** | Blocked | 父 idle 时同一标签并发两条 `@legacy-demo`（20:11:52 与 20:12:14）：两张卡各自独立计时/活动/工具，取消其一不影响另一 |
| C-05 WS 断线重连 | **PASS** | Blocked | 见〈WebSocket 断连与自动重连〉：冻结、禁用终止、自动重连与快照对账复原均被观察 |
| E-03 真实完成链路 | **PASS** | 部分（package PASS；legacy Blocked） | legacy `@legacy-demo` 完整相位 `启动中 → 思考中 → 正在执行工具 · bash → 生成中 → 已完成`（00:04，截图 16）；package `@doc-clerk` 完成卡此前已 PASS |
| E-04 真实取消链路 | **PASS** | 部分（package PASS；legacy Blocked） | legacy 启动中与工具相位两处定向取消均收敛为 `已停止`（截图 17、18）；package 两处此前已 PASS；兄弟隔离见 B-01 |
| E-06 平台证据诚实 | **部分** | 部分 | macOS 覆盖面扩大（legacy 完成/取消、多标签、同名并发、父 idle、断连重连）；**Windows 仍未验证**，未用 CI 冒充真机 |
| E-05 真实组合（聚合） | **部分** | Blocked | 多标签、同名并发、父 idle、断连重连已执行；Host 重启失效视图与清理未确认仍 Blocked，故本条不能整体判 PASS |

### 仍为 Blocked 的条目（本节未改判）

| 条目 | 状态 | 原因（事实文件） |
| --- | --- | --- |
| C-07 Host 代际切换 / C-09 Host 重启失效视图 | Blocked | Host 是 Electron utility process，没有只重启它而保留渲染器的受支持手段；整应用重启同时重建渲染器与注册表（无控制面持久化），D6 的 stale 视图在本环境无法构造。渲染器 reload 冒烟不等价，不得记为 Host 重启 |
| B-08 清理失败不伪报 | Blocked | 没有生产通道可以挂住 dispose/runtime stop，清理未确认横幅未能诱发 |
| A-14 60 秒提醒与预算文案 | Blocked | 所有运行都在 60 秒内结束且干净；停止等待 60 秒、清理预算横幅、finalizing 细节与 failed 终态文案均未观察 |
| Windows 平台 | 未验证 | 无任何 Windows 真机执行证据 |

### 多标签缺陷与修复（A-10 期间发现）

- **现象**：标签 A 保留 legacy 运行卡时，点侧栏打开一个**已经开着**的会话，该标签的 `items` 被历史回放（`resumeFromView` 的 `historyToChatItems(view)`）整体覆盖；客户端专属的运行卡不在历史回放里，覆盖后又没有向 `subagent.list` 对账 ⇒ 切回后卡片归零，随后点开的新会话同样为 0 张卡。
- **修复**（`dsh-plugin-huaanwork/src/client-huaanwork/App.tsx`；本节只记录，不改源码，细节见 `final-fix-report.md` §7）：已有标签只激活、不再写 `items`；新建历史标签分支与自动化运行标签回填写完后调用 `reconcileSubagentRuns(tabId, sessionId)`，由快照回退补回卡片。reducer、Host 与既有对账路径未改。
- **修复后复验（重建后的活应用）**：标签 A/B 来回切换各自保留卡片（截图 23、24）；渲染器 `Page.reload` 后打开 package 会话，卡片由 Host 实时快照恢复（截图 26）。
- **一处未恢复且不属于卡片缺陷**：reload 后无法经 UI 重新打开 legacy 的活稳定会话——`session.open` 返回 129 条记录但视图保持为空，属既有的活会话/resume 行为 ⇒ **legacy 快照恢复 Blocked**，不记为运行卡缺陷。

### WebSocket 断连与自动重连（C-05 / A-13 冻结视图）

- 定位方式：CDP `Runtime.queryObjects(WebSocket.prototype)` 找到事件 WebSocket 后直接 close，不重载渲染器。
- 断连期间：活动卡显示「最近活动 8 秒前 · 连接中断，状态可能滞后」，**终止按钮禁用**，耗时冻结在 00:12（截图 27）。
- 约 1 s 后客户端自动重连，快照对账清除冻结标记并重新启用终止；耗时从 00:13 继续，运行于 00:25 完成（截图 28）。
- **相邻的既有行为（不是运行卡）**：一次瞬时 WS 关闭仍会触发应用级「会话已失败…」「执行进程已结束…」横幅与 `sidecarDead` 闩锁（composer 占位符「sidecar 已退出」），且重连后不解除；运行卡自身已恢复，父会话界面在 reload 前仍标记为失败。该行为先于本功能存在，本节不据此改判任何条目，只登记其可观测面。

### 门禁复跑（多标签修复后，严格串行）

五条命令逐条等待退出后再启动下一条；每份日志尾部追加 `EXIT_CODE=` 与 `FINISHED_UTC=`，退出码不依赖人工判读。

| # | 命令 | 退出码 | 计数/关键输出 | 结果 | 日志 |
| --- | --- | --- | --- | --- | --- |
| 1 | 定向测试（brief 的 10 个目标） | 0 | `Test Files 52 passed (52)`；**`Tests 744 passed (744)`**（较上一轮 +2，即多标签修复的两条契约钉） | PASS | `logs/e05-step1-targeted-tests.log` |
| 2 | `corepack yarn typecheck` | 0 | 11 个 workspace 全绿（无诊断）；尾行 `contract-types: 4 generated type files are current` | PASS | `logs/e05-typecheck.log` |
| 3 | `corepack yarn test` | 0 | vitest **8500 passed / 37 skipped**（desktop 1812/11、beta 1822/11、huaanwork 3510/14、market 303、next 641/1、market-server 244、update-server 88、agent-catalog-server 80）；node:test 168 tests / 166 pass / 2 skipped / 0 fail | PASS | `logs/e05-test.log` |
| 4 | `corepack yarn check:desktop-variants` | 0 | `# pass 11 / # fail 0`；stable↔beta src 214 / scripts 33、beta↔huaanwork src 168 / scripts 21 对齐；allowlist 7（oneSidedPrefixes 0）与 65（oneSidedPrefixes 6）未变 | PASS | `logs/e05-check-desktop-variants.log` |
| 5 | `corepack yarn check`（第 1 步 `check:whitespace` 即退出） | **1** | `docs/superpowers/specs/2026-10-26-subagent-run-visibility-design.md:937: new blank line at EOF.` | **FAIL（提交内空白缺陷，非环境）** | `logs/e05-check.log` |
| 5′ | `corepack yarn check` 的其余步骤（隔离复跑） | 0 | `check:layout`、`test:aa-connector` 与 13 个 workspace/包 `check` 全绿；huaanwork 3510/14、update-server 88/88（本轮 `hdiutil` 用例全部通过）；`verify:aa` 无并发冲突签名 | PASS | `logs/e05-check-remainder.log` |
| 5″ | 提交 `52618cb8b8` 后，`corepack yarn check` 整条 | 0 | 15 步全绿；`check:whitespace` 通过（设计文档结尾空行随该提交删除）；日志中无 `not ok`；`update-server` 的 `hdiutil` 用例通过 | PASS | `logs/e05-check-after-commit.log` |

门禁 5 的第一次失败如实保留为历史：`check:whitespace` 执行 `git diff --check <merge-base(origin/master, HEAD)> HEAD`，比对的是**提交**而非工作树；命中的第 937 行由提交 `6c1f139e44`（2026-10-27 14:46:21 +08:00，晚于 14:39–14:42 的绿灯复跑）带入。该空白缺陷已随多标签修复提交 `52618cb8b8` 一并修正（设计文档结尾空行与 `appWiring.spec.ts` 的行尾空行），并在提交后的树上整条重跑 `corepack yarn check` 通过（上表 5″，exit 0、无 `not ok`）。5′ 的隔离复跑为同一 `check` 链去掉 `check:whitespace` 后的逐条执行；首次隔离运行时输出重定向误绑定到链尾命令、只留下末段输出，该日志保留为 `logs/e05-check-remainder-partial.log`，结论以 5″ 的整条复跑为准。除已修复的空白缺陷外，本轮无测试失败、无超时、无 `verify:aa` flake，也未出现 `update-server` 的 `hdiutil` 环境失败。

### 证据路径（git-ignored 暂存，不随提交分发）

- 截图 13 张（16–28）：`screenshots/16-legacy-completed.png`（legacy 完成卡）、`17-legacy-cancel-startup.png`（启动中取消）、`18-legacy-cancel-tool.png`（工具相位取消）、`19-multitab-new-card.png`、`20-multitab-old-session.png`、`21-multitab-legacy-card.png`、`22-multitab-package-card.png`、`23-multitab-legacy-preserved.png`、`24-multitab-package-preserved.png`、`25-reload-legacy-restored.png`（reload 后打开 legacy 会话的尝试：视图为空，见上）、`26-reload-package-restored.png`（package 卡由快照恢复）、`27-ws-frozen.png`（断连冻结）、`28-ws-recovered.png`（重连恢复）。
- 门禁日志：`logs/e05-step1-targeted-tests.log`、`logs/e05-typecheck.log`、`logs/e05-test.log`、`logs/e05-check-desktop-variants.log`、`logs/e05-check.log`、`logs/e05-check-remainder.log`、`logs/e05-check-remainder-partial.log`（各含 `STARTED_UTC` / `EXIT_CODE` / `FINISHED_UTC`）。
- 事实与修复来源：`.superpowers/sdd/2026-10-26-subagent-run-visibility/e05-acceptance-facts.md`、`final-fix-report.md` §7。

### 结论（本节）

- legacy 通道经本地夹具目录打通后，完成与取消链路在真机上均被观察；A-06、A-10、B-01（含兄弟隔离）、B-03、C-01、C-05、E-03、E-04 由 Blocked/部分改为 PASS，A-07、A-13、E-06 保持部分，E-05 聚合为部分。
- **仍 Blocked**：Host 重启后的失效视图（C-07/C-09）、清理未确认横幅（B-08）、60 秒提醒与预算/失败文案（A-14）；**Windows 未验证**。门禁 5 因提交内的结尾空行在本树上红，其余门禁绿。
- 因此按设计 §10.1 的验收通过判定，**功能验收仍未完成**：E-05 只到部分，C-07/C-09、B-08、A-14 与 Windows 无真机证据。本节的 PASS 只覆盖上表列出的条目，不构成整体放行。

## 收口验收补充（2026-10-27，验收钩子与故障注入）

本节把控制器在活应用中补采的第三批事实（`.superpowers/sdd/2026-10-26-subagent-run-visibility/closure-acceptance-facts.md`）转写为判定，取代〈真机验收（2026-10-27，Electron 44 + deepseek-flash）〉与〈E-05 真实组合补充（2026-10-27）〉中本节列出的同名条目。判定口径不变：**PASS** = 条目在真机上被完整观察；**部分** = 仅部分子项被观察；**Blocked** = 完全未执行或未观察。本节只使用该事实文件，不补充未观测的结论，也不把 Blocked 改判为 PASS。

### 环境与验收专用钩子

| 项 | 事实 |
| --- | --- |
| 隔离 | 沿用临时 profile `/tmp/huaanwork-accept-20261027-142256`（临时 `DSH_HOME` + `--user-data-dir`）；用户真实 profile 未修改 |
| 运行时 | Electron 44；模型 `deepseek-flash` |
| 夹具 | legacy 目录夹具 `127.0.0.1:18080`，三条 spec-valid 条目 `legacy-demo` / `legacy-broken` / `long-name`；真实内网目录仍未验证 |
| 被测树 | 钩子与两处客户端修复按**当前工作树**重新构建后运行；无提交 |

- **验收专用钩子（新增，环境变量门控，默认惰性）**：`HUAANWORK_ACCEPTANCE_HOOKS=1` 是总开关，未设为 `1` 时全部钩子关闭、生产行为与之前一致（由 `tests/huaanwork-host/acceptance-hooks.spec.ts` 的 5 条用例与评审共同钉住）；开启后 `HUAANWORK_ACCEPTANCE_CLEANUP_TIMEOUT_MS` 覆盖清理预算、`HUAANWORK_ACCEPTANCE_DISPOSE_FAILURE=reject|hang` 注入 dispose 拒绝/挂起。它们是验收夹具而非产品可配置项，不得作为配置对外暴露。
- 因此本轮 A-08、A-14、B-05、B-08 等条目的「故障」是**经真实 UI / 注册表 / 清理路径注入的故障**，不是生产环境下的自然失败。判 PASS 的含义是「该条目的界面与 Host 语义在这种注入故障下被观察到」，不等于该故障已在生产中发生或被验证过。

### 取代上表的判定

| 条目 | 本节判定 | 被取代的旧判定 | 事实依据 |
| --- | --- | --- | --- |
| A-03 生命周期完整 | 部分 | 部分 | 捕获到一条 `phase: "finalizing"` 的 `subagent/run` 帧；卡片「正在确认执行结果」文案未在 25 ms 轮询窗口内被目视到，该文案仍由单测钉住 |
| A-04 工具状态准确 | 部分 | 部分 | 要求两次并行 `bash` 的提示仍只产生一个串行工具；**并发工具未在 GUI 中观察** |
| A-05 终态映射诚实 | 部分 | 部分 | `@legacy-broken` 渲染「失败 · 执行出错」（截图 31）；max-tokens 与 refusal 未被诱发 |
| A-07 耗时与静默提示 | 部分 | 部分 | 本轮仍未观察 5 分钟无活动提醒；该子项在事实文件的「仍 Blocked」清单里 |
| A-08 收尾预算语义 | **PASS** | Blocked | 5 秒预算 + 父 idle 且子仍在运行：`subagent.list` 对 legacy 与 package 均报 `stopCause: cleanup-budget`、`cleanupBudgetMs: 5000`；展开卡显示「父会话空闲后等待收尾超过 5 秒，已开始强制释放」（事实文件记为截图 32） |
| A-11 可访问性 | 部分 | 部分 | CDP 可访问树：单个 `role=status`（`aria-live=polite`、`aria-atomic=true`），卡片按钮可访问名为「终止 @doc-clerk 本次运行」「展开 @doc-clerk 详情」；真实读屏音频未采证 |
| A-12 视觉层级与工具展示 | **PASS** | 部分 | 长 legacy 名称 `legacy-long-name-for-subagent-run-card-acceptance`：`title` 承载全名、`text-overflow: ellipsis`、`scrollWidth 370 > clientWidth 275`、终止按钮未被挤开（截图 34） |
| A-13 终态与失效视图 | 部分 | 部分 | 失效视图的**客户端代际路径 PASS（注入新代际空快照）**：卡原位变「状态不可恢复 · Host 已重启，结果未确认」、`data-stale=true`、终止禁用、计时冻结、末次已知状态「正在执行工具」（截图 37）；**真实 Host-only 重启 Blocked**（整应用重启同时重建渲染器与注册表） |
| A-14 文案与提醒 | 部分 | Blocked | 停止等待在约 61 秒出现「停止已受理超过 1 分钟，资源释放仍未确认；可离开此卡稍后查看，无需重复点击」（截图 33）；清理告警文案与预算文案被观察；**finalizing 文案未捕获，max-tokens/refusal 文案未诱发** |
| A-16 动效、窄窗口与读屏 | 部分 | 部分 | 与 A-11 共用同一 CDP 可访问树证据；真实读屏音频未采证，减动效与 380 px 沿用前节 |
| B-04 package 启动中终止 | 部分 | 部分 | 本轮未改判：`createRuntime` 与 `startActivation` 的**确切在途点**仍未被真机命中（事实文件列入仍 Blocked 的子项） |
| B-05 停止过程可见 | **PASS** | Blocked | 注入慢 dispose：取消期间卡保持「停止中 · bash」约 5 秒（耗时与最近活动继续更新、终止禁用），随后命中清理超时（截图 29） |
| B-06 幂等与终态处理 | **PASS** | Blocked | 同一活跃 run 的两次并行 `subagent.cancel` 均返回 `accepted`，run 以 `stopped` + `stopCause: targeted-cancel` 收敛且无重复清理告警；终态后再次取消返回 `already-terminal` |
| B-08 清理失败不伪报 | **PASS** | Blocked | 注入 dispose 超时：5 秒超时后卡显示「子代理释放超时，清理未确认」并**保持停止中**，从未变 `stopped`（截图 30）；无伪报停止 |
| B-10 定向取消边界 | **PASS** | Blocked | 错误 parent 与未知 runId 均返回 HTTP 404 `subagent-run-not-found`，run 仍为 `tool`（零副作用） |
| C-04 停止后迟到事件 | **PASS** | Blocked | 注入更高 revision 的 `reasoning` 投影：`stopping` 期间卡不回退（仍收敛为 `stopped`），终态后再注入仍为 `stopped`；首轮尝试暴露了真实客户端缺陷（见下） |
| C-06 snapshot/WS 竞态 | **PASS** | Blocked | 活 run 上注入更高 revision、工具为 `injected_tool` 的 `subagent/run`，卡显示该工具；随后以真实（较旧）快照触发 ready 对账**未回滚**（截图 35） |
| C-07 Host 代际切换 | **Blocked（真实 Host 重启）／客户端代际路径 PASS（注入）** | Blocked | 以新代际空快照替换 `subagent.list` 并触发 ready 对账：卡原位失效（截图 37）；**真实 Host-only 重启仍无受支持手段**，整应用重启会同时重建渲染器与注册表，故本条真机维度保持 Blocked |
| C-08 历史有界 | 部分 | Blocked | 同一父会话 21 条快速 legacy run → 客户端 20 张卡、Host 快照 20 条（每父上限生效）；**全局 200 上限未被触发** |
| C-09 Host 重启 | **Blocked（真实 Host 重启）／客户端失效视图 PASS（注入）** | Blocked | 同 C-07：注入验证的是客户端代际变化路径，不构成 Host 重启证据，本条真机维度保持 Blocked |
| D-01 投影不泄密 | **PASS** | 部分 | `Network.webSocketFrameReceived` 采到 5 帧 `subagent/run`：键仅为生命周期/工具名/计时/告警；对 prompt、参数、输出、reasoning、`lastAssistantMessage` 的正则匹配全部为空 |
| D-03 路由安全不放宽 | 部分 | Blocked | 所有非页面/伪造 Origin 的 HTTP 请求返回 403（未放宽），但 webserver 更外层的鉴权连同源 curl 一起拒绝 ⇒ 路由级 origin 检查未能在 GUI 中隔离验证，该检查仍以自动化路由测试为证据 |
| D-05 既有取消语义不变 | **PASS** | Blocked | 包子会话运行期间用 composer 做父级停止：子卡变「已停止」，父状态无卡死 |
| D-06 普通会话无回归 | **PASS** | 部分 | 新标签三条普通消息均得到正常助手回复，且**零**运行卡 |
| E-05 真实组合（聚合） | 部分 | 部分 | 清理预算/清理失败/停止等待/迟到事件/快照竞态/父级停止已在真机执行；**真实 Host 重启、5 分钟提醒、finalizing 与 max-tokens/refusal 文案、并发工具、全局 200、真实内网目录、Windows 仍未验证**，故不能整体判 PASS |
| E-06 平台证据诚实 | 部分 | 部分 | macOS 覆盖面继续扩大（注入慢 dispose/超时、60 秒停止等待、代际切换、长名称、WS 帧隐私）；**Windows 与真实内网目录仍未验证**，未用 CI 或夹具冒充 |

- **C-02 / C-03 维持自动化专用（Host 内部）**：旧 `subagent/end` 与重复结算的次序只有注册表单测；渲染器 CDP 无法注入 Host 生命周期事件，故真机维度不做判定、也不计入 PASS。
- **D-02 维持单测**：真实 activation parent 不匹配没有生产路径可构造错配的 `hostRunId`，本轮未执行。

### 故障注入发现的客户端缺陷与修复

| 缺陷 | 现象 | 修法（`dsh-plugin-huaanwork/src/client-huaanwork/logic/subagentRuns.ts`） |
| --- | --- | --- |
| 终态复活（§8） | 已完成 run 收到更高 revision 的 `reasoning` 帧后从 `completed` 变回 `reasoning`，违反设计 §5.2「终态后忽略迟到活动」 | `reduceRunUpdate` 在 stale 早退与 revision 合并之间新增终态守卫：既有 run 为 `completed`/`failed`/`stopped` 且来帧非终态时直接返回原 `state`，与 revision 高低无关；终态→终态仍在守卫之后按 revision 合并，清理告警晚到仍可落卡 |
| 停止回退（§9） | `stopping` 卡片被更高 revision 的活跃帧改回 `reasoning`/`tool`，违反设计 §5.2「`stopping` 期间不得回退到 reasoning/generating/tool」 | 在终态守卫之后、revision 合并之前新增停止守卫：既有相位为 `stopping`、来帧相位属于 `starting`/`reasoning`/`generating`/`tool` 时整帧忽略；`stopping`→`stopping` 与 `stopping`→终态不受影响；`finalizing` 属收尾方向、不在阻止集合内 |

- **回归钉**：`tests/client-huaanwork/subagentRuns.spec.ts` **47/47 通过**（本节记录的 8 条新钉——终态守卫 4 条、停止守卫 4 条——均在套件内，另含「终态仍接受更高 revision 的清理告警」与「stopping 仍合入更新的 stopping」两条反向钉）。
- 两处缺陷都由本轮故障注入暴露，不是本轮新引入的功能面；修复只动 `reduceRunUpdate` 与其 spec，未改 Host、UI、snapshot 合并与 active/cap 逻辑。

### 门禁（严格串行，当前工作树）

| # | 命令 | 退出码 | 计数/关键输出 | 结果 | 日志 |
| --- | --- | --- | --- | --- | --- |
| 1 | `corepack yarn workspace dsh-plugin-huaanwork test <brief 的 11 个目标>` | 0 | `Test Files 52 passed (52)`；**`Tests 752 passed (752)`**（无 skipped、无 fail） | PASS | `logs/closure-gate1-targeted-tests.log` |
| 2 | `corepack yarn typecheck` | 0 | 11 个 workspace 的 `tsc` 全绿（无诊断）；尾行 `contract-types: 4 generated type files are current` | PASS | `logs/closure-gate2-typecheck.log` |
| 3 | `corepack yarn test` | 0 | vitest 8 个 workspace：**8513 passed / 37 skipped**（desktop 1812/11、beta 1822/11、huaanwork **3523/14**、market 303、next 641/1、market-server 244、update-server 88、agent-catalog-server 80）；`node:test` 168 tests / 166 pass / 2 skipped / 0 fail | PASS | `logs/closure-gate3-test.log` |
| 4 | `corepack yarn check:desktop-variants` | 0 | `1..11` 全 `ok`，`# pass 11 / # fail 0`；stable↔beta src 214 / scripts 33、beta↔huaanwork src 168 / scripts 21 对齐；allowlist 7（oneSidedPrefixes 0）与 65（oneSidedPrefixes 6）未变 | PASS | `logs/closure-gate4-desktop-variants.log` |
| 5 | `corepack yarn check` | 0 | 15 步全绿、无 `not ok`；vitest 合计 **8513 passed / 37 skipped**；`node:test` 178 tests / 178 pass / 0 fail；`verify:aa` 无并发冲突签名；huaanwork 3523/14 | PASS | `logs/closure-gate5-check.log` |
| — | `git diff --check` | 0 | 无输出（无行尾空白、无冲突标记） | PASS | `logs/closure-git-diff-check.log` |

- 每份日志尾部记录 `exit=` 与 `FINISHED_UTC`（门禁 2–5 另记 `STARTED_UTC`），退出码不依赖人工判读。
- 本轮 `verify:aa` 未出现并发冲突签名，`update-server` 的 `hdiutil` 用例全部通过；因此不需要单包复跑，也不存在把真红写成 flake 的情形。
- huaanwork 的 `yarn test` 计数（门禁 3/5）较上一节 +13（3510 → **3523**），来自 `acceptance-hooks.spec.ts` 的 5 条与客户端 reducer 的 8 条新钉；门禁 1 的定向用例为 **752**（上一节 744，+8）。

### 证据路径（git-ignored 暂存，不随提交分发）

- 截图（目录内 29–37 共 8 张）：`29-stopping-visible.png`（B-05 停止中）、`30-cleanup-warning-still-stopping.png`（B-08 清理未确认仍停止中）、`31-failed-terminal.png`（A-05 失败终态）、`33-stop-wait-60s.png`（A-14 60 秒停止等待）、`34-long-name.png`（A-12 长名称）、`35-live-injected-tool.png`（C-06 注入工具未被旧快照回滚）、`36-terminal-not-revived.png`（C-04 修复后终态未被复活；事实文件未逐字引用该文件名）、`37-host-restart-stale.png`（C-07/C-09/A-13 注入新代际后的失效视图）。
- **编号缺口如实登记**：`32`（事实文件在 A-08 记为 `screenshot 32`）与 `38`、`39` 在 `screenshots/` 目录中**不存在**；A-08 的依据是同事实文件中的 `subagent.list` 观测（`stopCause: cleanup-budget`、`cleanupBudgetMs: 5000`）与卡片文案，不依赖该文件名。
- 门禁日志：`logs/closure-gate1-targeted-tests.log`、`closure-gate2-typecheck.log`、`closure-gate3-test.log`、`closure-gate4-desktop-variants.log`、`closure-gate5-check.log`、`closure-git-diff-check.log`。
- 事实与修复来源：`.superpowers/sdd/2026-10-26-subagent-run-visibility/closure-acceptance-facts.md`、`acceptance-hooks-report.md`、`final-fix-report.md` §8/§9。

### 结论（本节）

- 本轮把上一节仍 Blocked 的 A-08、B-05、B-06、B-08、B-10、D-05 与部分 Blocked 的 C-04、C-06 判为 PASS；A-05、A-11、A-12、C-08、D-01、D-03、D-06、E-06 的覆盖面扩大；A-14 由 Blocked 升为部分（60 秒停止等待已观察，finalizing 与 max-tokens/refusal 文案未捕获）。
- **仍 Blocked / 未验证**：真实 Host-only 重启（C-07/C-09，客户端失效视图只由注入的新代际快照验证）、C-02/C-03 与 D-02 的真机注入（Host 内部，仅单测）、D-07/D-08 的真机维度（代码/变体守卫证据）、A-07 的 5 分钟无活动提醒、A-14 的 finalizing 与 max-tokens/refusal 文案、A-04 的并发工具、B-04 的确切在途点、C-08 的全局 200 上限、真实读屏音频、真实内网目录与 Windows。（本节摘要漏列 B-07 cancel/end 竞态；其正式状态一直是 Blocked，以文末〈验收判定订正（2026-10-28）〉为准。）
- 因此按设计 §10.1 的「验收通过判定」（A–D 全部通过、E-01～E-05 通过），**本功能仍未完全验收**：A-03/A-04/A-05/A-11/A-13/A-16/B-04/C-08/D-03 仍为部分，C-07/C-09 与上述注入项、Windows 仍 Blocked，E-05 与 E-06 仍是部分。本节与前述各节的 PASS 只覆盖各自表格明确列出的子项，不构成整体放行，也不勾选设计 §10.1 的复选框。

## Host 重启排查（2026-10-27，复核订正；2026-10-28 代码复核）

目标：为 C-07/C-09/A-13 取得**真实 Host 重启且保留 renderer/客户端状态**的证据（不是代际快照注入）。本节取代本文件此前把根因归于 surface watchdog/recovery、并建议登记为「架构限制」的结论。

### 原始尝试与观测（按当次记录保留）

在隔离临时 profile 中用验收专用、`HUAANWORK_ACCEPTANCE_HOOKS=1` 门控的 supervisor 诊断（**已回退，不随当前源码分发**）：固定 Web 端口 43120，`stop` 旧 Host utility process 后重新 `fork` 新 Host；另尝试在重启窗口挂起 shell 的 renderer surface watchdog/recovery（`canRecoverRenderer` 返回 false）。生产路径未改变。

当次记录报告：旧 Host PID `43952` → 新 Host PID `45676`，两者均绑定 `127.0.0.1:43120`；切换点后 CDP page target 消失，主进程（`43944`）仍存活；挂起 surface watchdog/recovery 后 page target 仍消失。诊断 diff 与完整 CDP target 事件流未归档，故这些是**历史观测**，不能单独证明 renderer 进程死亡：导航/reload、WebContents 销毁、target URL 改变或采集过滤均可表现为 page target not found。

### 证据订正：撤回 watchdog/recovery 归因

1. **被引用的 run id 是 Electron main 启动头，不是 Host generation boot。** `start()` 在 Host fork 之前调用 `logSink.writeHeader()` 写入 `run ${Date.now()}`（`main.ts` 的 `start()`，`:468-535`，写入点 `:529`）；Host 侧 logger（`host-bootstrap.ts:73` 的 `LogFileSink`，写入 `userData/logs/host/`）不写该头。因此 `run 1793109418559` → `run 1793109754936` 不能作为同一 main 进程内 Host 换代的证据。若它们就是当次记录所指的前后代，则与「同一 main 仍存活」的叙述冲突，至少说明日志混合了两次 main 启动。
2. **watchdog/recovery 三行不在该切换窗口。** 原始主日志 `userData/logs/dsh-2026-10-27.log:34-36` 的 `page has no visible content` → `automatic renderer recovery attempt 1` → `healthy` 位于第 37 行旧 run 与第 40 行新 run **之前**，属于更早的 main run；`LogFileSink` 使用同步 `appendFileSync`（`log-files.ts` 的 `append()`，`:195-223`），不能以异步乱序解释。（2026-10-28 复核：该文件当时仍保留在 `/tmp/huaanwork-accept-20261027-142256/userData/logs/dsh-2026-10-27.log`，共 11 个 main run 头，`:34-36` 确为 watchdog 三连，`:37`/`:40` 确为两次 main 启动。）
3. 因而原材料只支持「曾尝试 Host 重拉，且 CDP 观测到的 page target 消失」，**不支持「recovery 在切换点销毁 renderer」**。撤回「Blocked by shell 的 renderer lifecycle/recovery model」与「应登记为架构限制」；registry 仍无缺陷证据，客户端代际注入仍只证明客户端路径。

### 代码根因链：Host teardown 连带销毁 native shell（高置信，待事件日志钉证；2026-10-28 代码复核）

若诊断的 `stop` 复用了当前 `startIsolatedDesktopHost.stop()`（原始记录正是如此描述），代码中存在两条不经过 watchdog/recovery、足以解释全部现象的销毁路径：

- **graceful stop 路径**：shell 注册是 Host Cordis effect（`src/index.ts` 的 `ctx.effect()`，`:454-524`；`runtime.schedule()` 调用点 `:469`）。Host effect dispose 时，`createHostRuntime.schedule()` 返回的 disposer 发送 `shell:dispose`（`host-runtime-bridge.ts:99-109`）；main 侧处理器取出并 await shell disposer（同文件 `bindNativeRuntime()` 的 `shell:dispose`，`:228`）；`ElectronDesktopRuntime.schedule()` 的 disposer 调用 `generation.release()`（`electron-runtime.ts:283-309`，释放点 `:299`）；最终 `ElectronShellGeneration.release()` 执行 `window.destroy()`（`electron-shell-generation.ts:908-934`，销毁点 `:933`）。
- **强杀/兜底路径**：`startIsolatedDesktopHost.stop()` 在正常确认退出的路径上会 `await releaseNative()`（`host-process.ts:233-250`，调用点 `:248`）；`bindNativeRuntime()` 返回的清理函数 dispose 所有 shells（`host-runtime-bridge.ts:244-247`），随后汇入同一 `generation.release()` → `window.destroy()` 链。**该调用不在 `finally` 中**：若 Host 终止未在 1 秒内确认，`Promise.race` 抛错会跳过它（`:242-246`），此时窗口是否存活取决于 graceful `shell:dispose` 是否已完成；不得把「任何 stop 都必然销毁窗口」写成无条件结论。

2026-10-28 复核：两条链的每一环都在当前工作树逐行对上（文件与行号见上）；`run` 头只有 main 写（`main.ts:529`），Host 侧 sink 无该头；watchdog 的 `active()` 要求窗口未销毁（`electron-shell-generation.ts:272-279`），`release()` 先 `stop()` 再 `destroy()`（`:912`、`:933`）。仍缺的是同一 main 进程内按时间顺序的 `shell:dispose`/`releaseNative` → `generation.release` → `window.destroy` 事件记录，故本节把该链记为**高置信静态推断**，不记为已证实。

所以「挂起 watchdog/recovery 后 renderer 仍消失」不是矛盾，反而与 **Host 停止附带 native-shell teardown** 完全吻合。当前缺口应准确表述为：**BrowserWindow/WebContents 的所有权随 Host effect/native binding 被终止，缺少 Host 换代期间的 shell 保留与接管（handover）机制**；不是已证明 shell 架构无法保留 SPA。最终动态钉证只需在下一次复验中按时间顺序捕获 `shell:dispose` / `releaseNative` → `generation.release` → `window.destroy`，并同时记录 WebContents ID、navigation/crash 事件与新旧 Host 的实际监听端口；若 terminate 未被确认，另行记录 `Promise.race` 抛错后的窗口状态。

### 实施与真实验收判定（2026-10-28）

本节取代前述各表/节中「真实 Host-only 重启 Blocked」「native-shell handover 未实施」「范围未决」的旧状态；其他条目的历史判定与仍未验证项不因此改变。

- **已按最小范围实现 handover**：`HostNativeRuntimeBinding.retainShell()` / `release({ preserveShell })`（`host-runtime-bridge.ts:173-177`、`:270-283`）同时截断 graceful `shell:dispose` 与兜底 native release 的毁窗路径；`ElectronDesktopRuntime` 在 `beginHostShellAdoption()` → `adoptHostShell()` 期间校验原 origin 与 renderer access header、更新 shell/compatibility spec 和 remote-control offer，并以 `activeShellDisposer` 让旧代 disposer 失效（`electron-runtime.ts:288-377`）；supervisor 以 single-flight 更换 utility process（`host-process.ts:334-383`）。未改 Stable/Beta、upstream、`startup-generation.ts`、共享 renderer-action/boot 协议或变体白名单。
- **验收入口默认惰性**：只有 `HUAANWORK_ACCEPTANCE_HOOKS=1` 时才注册 `huaanwork:acceptance-host-restart` main IPC（`host-process.ts:397-403`）；preload 仅转发该调用（`preload.ts:70-73`）。未新增自动崩溃重启、用户可见设置、反向代理、watchdog 暂停或 React 状态持久化。既有整应用重启语义未改。
- **真实 Host-only 重启 PASS（macOS）**：隔离副本 `/tmp/huaanwork-host-restart-be6iRg` 中，真实 composer 经原生 CDP 输入启动 `@legacy-demo` 活跃卡；未注入 registry generation 或替换 `subagent.list`。验收驱动返回 `oldPid 31844 → newPid 32918`、`sameDocument: true`、`sameMainRun: true`、`staleCardCount: 1`。随机 canary 与 `performance.timeOrigin` 不变，main 日志没有新增 run 头。
- **真实 stale 视图 PASS**：新 Host 的真实空快照把旧卡原位改为「状态不可恢复 · Host 已重启，结果未确认」；`data-stale=true`、终止禁用、最后状态保留「正在执行工具」，耗时在相隔 1250 ms 的两次读取中均为 `00:32`，未推导 completed/failed/stopped。截图 `screenshots/40-host-restart-real-stale.png`；机器结果 `.superpowers/sdd/2026-10-26-subagent-run-visibility/host-restart-handover-result.json`，完整事实 `host-restart-handover-facts.md`。
- **失败与退出边界**：定向测试覆盖 boot/adoption 失败、origin/header 漂移、arming 失败重试、旧 Host 终止未确认、并发重启与最终释放；remote-control offer 的旧 RPC 捕获缺陷已修复并有回归钉。真实应用最终 exit 0，旧/新 Host、renderer、main 残留进程数为 0；本地 fixture catalog 已停止。
- **最终门禁**：handover 定向 6 文件 / **160 用例** + CDP 证据断言 **4/4**；`yarn typecheck` 通过；根 `yarn test` 中 huaanwork **3539 passed / 14 skipped**，其他 workspace 零失败；变体守卫 **11/11** 且 allowlist 7/65/6 未变；修复后完整 `yarn check` **exit 0**；`git diff --check` 与 `check:whitespace` 通过。
- 因此 **C-07、C-09 及 A-13 的真实 Host 重启/stale 子项改判 PASS**。A-13 的其他既有部分项、E-05/E-06 的其他缺口与 Windows 未验证不变；本节不构成设计 §10.1 的整体放行。`sidecarDead` ready 清除闩锁仍是独立的断连恢复修复，不替代上述证据。

## 验收判定订正（2026-10-28）

本节只订正验收表的口径与漏项，不新增测试证据、不改产品行为、不勾选 §10.1；其余条目的判定以各节最新记录为准。

### 判定口径

- 真机条目按「用户可见场景是否被真实 `@` 路径观察」判定；内部不变量（如晚到 activation dispose、`stopRequestedAt` 的时间源）仍由单测钉住。
- 一个条目包含多个子项时，只有全部子项都有证据才记 PASS；不能用其中一个子项的观察覆盖整条。
- 无 GUI 维度的条目（Host 内部时序、代码/变体守卫审计）是否接受自动化证据，需 owner 显式裁定，不得默认算 PASS；真实 `@` 场景不能用 waiver 代替执行。

### A-01 改为 PASS

原〈真机验收（2026-10-27）〉表写「PASS（package）／legacy Blocked」，但该表采集时 legacy 尚无可用目录。〈E-05 真实组合补充（2026-10-27）〉已用本地 spec-valid 夹具 `legacy-demo` 打通 legacy 路径：事实文件 `.superpowers/sdd/2026-10-26-subagent-run-visibility/e05-acceptance-facts.md` 的「Legacy `@agent` (E-03/E-04 legacy, A-01 legacy, B-03)」写明 `@legacy-demo` 卡在用户消息后立即出现、每条显式 `@` 一张卡、标题为 `@legacy-demo`（无版本），截图 16；package 侧此前已由截图 05 证明「消息下方紧邻一张卡、每条 `@` 各自成卡」。两条路径的标题、运行实例和可见位置均满足 A-01，故改为 **PASS**。

边界：`clientMessageId` 的精确锚定仍由自动化钉住（`subagentRuns.spec.ts:1022` 的「a run card anchors after the user message named by clientMessageId in its own tab」与 `:1077` 的「a matched anchor inserts directly after that message and keeps later items in order」）；真机证据证明的是可见位置与一 `@` 一卡，不是内部键值。legacy 用的是本地夹具而非真实内网目录，该环境限制记在 E-06，不回写到 A-01。

### A-12 降为「部分」

此前〈收口验收补充〉把 A-12 记为 PASS，依据只有长名称截断；但设计 A-12 还包含「并发工具默认前 2 个 + `+N`，可展开完整在途列表」，而并发工具在 GUI 中未被观察（与 A-04 同一缺口）。因此 A-12 降为 **部分**：三行层级、同名 `HH:MM:SS`、长名称截断已真机 PASS；并发工具展示仍未验证。

### E-05 改为 PASS

设计 E-05 只有五个子项：多 tab、同名并发、父 idle 后子代理仍运行、WS 重连、清理未确认提示。五项均已有真机证据：

- 多 tab：E-05 截图 21–24，切换后各自保留卡片、无跨标签泄漏；
- 同名并发：E-05 同一标签两条 `@legacy-demo` 各自独立计时/工具，取消其一不影响另一；
- 父 idle：E-05 composer 回到「发送」后卡片继续更新、终止可用；
- WS 重连：E-05 截图 27/28，断连冻结、重连后快照对账恢复；
- 清理未确认：收口节截图 30，dispose 超时后保持停止中并显示「清理未确认」。

因此 E-05 改为 **PASS**。Host 重启、5 分钟提醒、finalizing、全局 200、Windows、真实内网目录不属于 E-05 子项，不再用来压低 E-05。

### C-05 降为「部分」

设计 C-05 要求「活跃 run 和停止未确认 run 不丢失」。现有真机证据只覆盖活跃 run 的断连冻结与重连恢复（E-05 截图 27/28）；停止未确认 run 在断连/重连后的保留未观察。故 C-05 降为 **部分**，剩余子项为「stopping / cleanup-unconfirmed run 的重连保留」。

### A-05 / A-14 的剩余子项补全

- A-05：除 max-tokens/refusal 外，还包括 `unknown` 不得显示成功、单个工具失败不直接决定整个 run 失败；后两项目前只有自动化证据（`bridge.spec.ts:592`），真机未诱发。
- A-14：除 finalizing 文案外，还包括各 stopReason 固定文案的完整性、提醒按优先级单条展示且全部可展开、60 秒提醒在重连后不重置、运行卡提醒不使用琥珀且由结构化 warning code/severity 决定样式。60 秒停止等待已观察（截图 33），但上述其余子项未全部真机验证。

### B-03 保持 PASS 的边界

B-03 的场景是「`startActivation()` 尚未返回时取消」；卡片处于「启动中」即 activation 发布前，真机启动中取消（截图 17）覆盖该用户可见场景。晚到 activation 的立即 dispose 是内部不变量，由 `sessions.spec.ts:503` 等单测钉住。B-04 要求分别命中 `createRuntime` 与 `startActivation` 两个在途点，真机只观察到一次笼统的启动中取消，故仍为部分。二者不是口径不一致。

### A-13 保持「部分」，剩余子项写明

A-13 已完成的子项：

- 终态收为单行、每次运行独立：`gui-acceptance-facts.md` #8，截图 02（package 完成）、13（package 已停止）、16（legacy 完成）、18（legacy 工具相位取消）；
- WS 断连冻结并标记滞后、重连恢复：E-05 截图 27/28；
- Host 重启后旧活跃卡原位失效且不猜结果：2026-10-28 截图 40。

剩余子项只有 **「手动展开不被后续事件重置」**：自动化钉在 `SubagentRunCard.spec.ts:376`，真机未构造「展开带告警/详情的卡后再收到后续事件」的场景；截图 30 的清理未确认卡只观察到收起态，没有展开后的后续事件。因此 A-13 不能改判 PASS，但剩余项从此前笼统的「其他既有部分项」收窄为这一条。

另：renderer reload 后无法经 UI 重开 legacy 活稳定会话（`session.open` 返回 129 条但视图为空）是既有 live-session/resume 行为，不是运行卡缺陷，也不计入 A-13。

### B-07 补回剩余清单

正式 A–E 表中 B-07 一直是 **Blocked**（真机未构造 cancel/end 竞态；`subagent-runs.spec.ts:101/246` 与 `agent-package-runtime.spec.ts:1516` 为自动化证据）；但〈E-05 补充〉与〈收口验收补充〉末尾的「仍 Blocked/未验证」摘要漏列了它。现补回：B-07 仍在剩余项内，状态不变。

### 验收裁定（2026-10-28，owner）

以下五条由 owner 在本对话中批准落实，编号 R-ACC-1～R-ACC-5。它们只改变「无 GUI 维度条目能否以自动化证据视为通过」的口径，不把真实 `@` 场景或未执行的平台验证写成 PASS。

- **R-ACC-1（C-02 / C-03：自动化充分）**：旧 `subagent/end` 按 `upstreamRunId` 结算、重复到达只生成一次终态，属于 Host 内部时序，渲染器 CDP 无法注入 Host lifecycle。registry 单测已覆盖该行为，故 C-02/C-03 以自动化证据视为通过，不再要求真机注入。
- **R-ACC-2（D-02：自动化充分，不建伪造 parent 路径）**：没有生产路径制造 activation parent 错配；单测已钉「parent 不一致先 dispose 再拒绝、restrict 不执行」（`skills.spec.ts:1177`、`:1236`）。为验收新增可伪造 parent 的 Host IPC 会扩大安全面，故 D-02 以自动化证据视为通过，且不新增该类 IPC。
- **R-ACC-3（D-07 / D-08：代码/变体守卫审计充分）**：非目标未混入与代码边界没有 GUI 维度；`git status` 仅限 `dsh-plugin-huaanwork/` 与 `docs/`、Stable/Beta 源码零改动、变体守卫 11/11 且白名单计数不变即为充分证据，故 D-07/D-08 视为通过。
- **R-ACC-4（B-07：不可 waiver，必须实做）**：B-06 的双 cancel 幂等不等于 cancel/end 竞态；B-07 是真实 `@` 场景的时序验收，不能用 waiver 或 B-06 的证据代替，必须按收口清单 T2.2 构造两种顺序。
- **R-ACC-5（Windows / 真实内网目录：仅作 E-06 环境记录，非验收 waiver）**：未执行的 Windows 与真实内网目录在 E-06 如实标注「未验证」；可选择后续补做，但不以 waiver 改变验收状态、不压低 E-05、不作为勾选 §10.1 的依据。

### 订正后的计数

| 分类 | 数量 | 条目 |
| --- | --- | --- |
| PASS（真机/门禁/自动化充分裁定） | 34 | A-01、A-02、A-06、A-08、A-09、A-10、A-15；B-01、B-02、B-03、B-05、B-06、B-08、B-09、B-10；C-01、C-02*、C-03*、C-04、C-06、C-07、C-09；D-01、D-02*、D-04、D-05、D-06、D-07*、D-08*；E-01、E-02、E-03、E-04、E-05 |
| 部分 | 14 | A-03、A-04、A-05、A-07、A-11、A-12、A-13、A-14、A-16；B-04；C-05、C-08；D-03；E-06 |
| Blocked | 1 | B-07 |
| 合计 | 49 | — |

`*` 表示按 R-ACC-1/2/3 以自动化证据视为通过，不是真机 PASS；其中 C-02/C-03 由 R-ACC-1、D-02 由 R-ACC-2、D-07/D-08 由 R-ACC-3 覆盖。

- 34 + 14 + 1 = 49；未 PASS 共 **15** 项，其中 **14 项属于 A–D**，是 §10.1「A–D 全部通过」的直接缺口；E-06 是平台证据诚实项，按 R-ACC-5 如实标注即可。
- E-01～E-05 已全部 PASS；整体放行只剩 A–D 的 14 项 + E-06 的诚实记录。
- B-07 是唯一的 Blocked 项，按 R-ACC-4 必须实做，不能用 waiver 代替。
- 本节不勾选 §10.1；按「A–D 全部通过、E-01～E-05 通过」的判定，功能仍未完全验收。

## 验收收口执行记录（2026-10-28）

本节记录收口清单的实际执行进展与阻塞，不改变上述判定与计数。

### 验收钩子实现（T1/T2 前置）

已在 `dsh-plugin-huaanwork` 实现默认惰性的验收钩子，全部经 `HUAANWORK_ACCEPTANCE_HOOKS=1` 总开关门控，未设置时生产行为不变：

| 环境变量 | 用途 | 插入点 |
| --- | --- | --- |
| `HUAANWORK_ACCEPTANCE_HOLD_FINALIZING_MS` | 保持 `finalizing` 相位 N ms，供目视文案 | `subagent-runs.ts` 的 `settleResult` 延迟 |
| `HUAANWORK_ACCEPTANCE_HOLD_END_MS` | 延迟自然结果发布，构造 cancel/end 竞态 | 同上 |
| `HUAANWORK_ACCEPTANCE_PACKAGE_DELAY_POINT` / `..._MS` | 分别在 `createRuntime` / `startActivation` 前延迟 | `agent-package/host.ts` 两个 await 点 |
| `HUAANWORK_ACCEPTANCE_INJECT_TOOL_NAME` | 在真实 child 工具旁注入一个并发工具 | `bridge.ts` 的 `tools/execute` |
| `HUAANWORK_ACCEPTANCE_TERMINAL_REASON` | 把 resolved result 的终态原因替换为 `max-tokens` / `refusal` / `unknown` | `subagent-runs.ts` 的 `settleResultNow` |
| `HUAANWORK_ACCEPTANCE_TOOL_FAILURE` | 把 child 工具标记为失败但不决定 run 终态 | `bridge.ts` 的 `endTool` 后 `noteChildError` |
| `HUAANWORK_ACCEPTANCE_EXTRA_WARNINGS` | 结果发布时追加 info + error 两条告警 | `subagent-runs.ts` 的 `settleResultNow` |

回归钉：`tests/huaanwork-host/acceptance-hooks.spec.ts` 共 **8 条**（主开关、默认惰性、合法/非法值回落），全部通过。

### 门禁结果（钩子实现后，严格串行）

| 门禁 | 结果 | 计数/说明 |
| --- | --- | --- |
| `corepack yarn typecheck` | PASS | 11 个 workspace 全绿 |
| `corepack yarn workspace dsh-plugin-huaanwork test` | PASS | **3542 passed / 14 skipped**（含 acceptance-hooks 新增 3 条） |
| `corepack yarn check:desktop-variants` | PASS | 11/11，allowlist 7/0、65/6 未变 |
| `corepack yarn check`（第 1 次） | FAIL | 第 11 步 `update-server` 的 `artifact-validate.spec.ts` 因 `hdiutil create` 失败（87/88）；该 workspace 未被本次改动触及 |
| `corepack yarn workspace update-server test tests/artifact-validate.spec.ts` | PASS | 隔离复跑 **88/88**，证实为宿主 `hdiutil` 环境 flake |
| `corepack yarn check`（第 2 次整条） | PASS | 15 步全绿、无 `not ok`；日志 `.superpowers/acceptance-closure/logs/check-retry.log` |

### D-03 路由级 origin 检查的证据边界

GUI 中 webserver 外层鉴权连 same-origin curl 也拒绝，因此路由级 origin 检查不能在 GUI 中单独隔离。该检查以 `dsh-plugin-huaanwork/tests/huaanwork-host/routes.spec.ts:314` 的集成测试为证据：非 loopback / 伪造 Origin 返回 403、同源 loopback 返回 200、回环别名放行、非回环 Host 403。**外层鉴权拒绝不等于路由级 origin 拒绝**，本记录不把前者冒充后者。

### 当前阻塞：真实模型配置不可用

T1/T2 的真机场景需要真实 `@` 运行。本次在新隔离环境（`.superpowers/acceptance-closure/`）中创建本地账户后，默认模型端点为 `http://127.0.0.1:11434/v1`，该地址无服务；环境变量中无 `DEEPSEEK_API_KEY` / `DSH_API_KEY`。发送测试消息得到 `HuaAnWork model request to http://127.0.0.1:11434/v1 failed`，无法产生真实子代理运行。

此前已配置好的隔离 profile（含 deepseek-flash 模型与 `@doc-clerk` 包）位于 `/tmp/huaanwork-accept-20261027-142256/userData`，因包含账户/凭据信息，当前权限模式不允许复制到工作区。因此 **T1/T2 的真机场景本轮未执行**，A–D 的 14 个缺口与 B-07 保持原状态，计数仍为 **34 PASS / 14 部分 / 1 Blocked**。

继续执行需要 owner 提供以下任一条件：

1. 可用于验收的 DeepSeek API key（或等效模型端点与凭据），用于在新隔离环境中配置 `deepseek-flash`/`deepseek-chat`；或
2. 明确授权使用此前已配置的隔离 profile（含模型与包），并允许复制到工作区。

在获得上述条件前，T1/T2 的真机场景按 Blocked 记录，不写成 PASS。

## 验收收口场景执行结果（2026-10-28）

owner 已授权使用此前配置的隔离 profile（含模型与包）。以下场景在隔离环境（`.superpowers/acceptance-closure/`，DSH_HOME 与 userData 均为工作区内副本）中执行，应用以 `HUAANWORK_ACCEPTANCE_HOOKS=1` 启动，CDP 9333，fixture catalog `127.0.0.1:18080`。证据 JSON 保存在 `.superpowers/acceptance-closure/logs/`。

### 执行环境

| 项 | 值 |
| --- | --- |
| 平台 | macOS arm64，Electron 44 |
| 模型 | deepseek（复制 profile 的当前 active model） |
| 包 | `@doc-clerk` v1.0.0（已启用） |
| legacy 目录 | 本地 fixture catalog `127.0.0.1:18080`（`legacy-demo` / `legacy-broken` / `long-name`） |
| 隔离 | `DSH_HOME` 与 `--user-data-dir` 均为工作区内副本；用户真实 profile 未修改 |

### 场景判定

| 场景 | 判定 | 证据文件 | 说明 |
| --- | --- | --- | --- |
| T1.1 A-03/A-14 finalizing 文案 | **PASS** | `t1-1-finalizing.json` | `HOLD_FINALIZING_MS=3000`，卡片在 finalizing 相位显示「正在确认执行结果」约 2 秒 |
| T1.2 A-05/A-14 max-tokens 文案 | **PASS** | `t1-2-max-tokens.json` | `TERMINAL_REASON=max-tokens` → `failed` +「未完成 · 达到模型输出上限」 |
| T1.2 A-05/A-14 refusal 文案 | **PASS** | `t1-2-refusal.json` | `TERMINAL_REASON=refusal` → `failed` +「未完成 · 子代理拒绝执行」 |
| T1.3 A-07 5 分钟无活动提醒 | **PASS** | `t1-3-inactivity-reminder.json` | 卡片显示「已 5 分钟没有新活动」而非超时，未自动停止 |
| T1.4 A-04/A-12 并发工具与 tool/end 隔离 | **PASS** | `t1-4-concurrent-tools.json` | 两工具并发显示；bash 结束后 injected_tool 仍保留 |
| T1.4 A-12 前 2 + `+N` 与展开 | **PASS** | `t1-4-plus-n-and-expand.json` | 三工具时显示前 2 + `+1`；展开显示完整在途列表 |
| T1.6 A-13 手动展开不被后续事件重置 | **PASS** | `t1-6-expand-persist.json` | 展开后发起新 run，原卡 `aria-expanded` 保持 true |
| T1.8 C-05 停止未确认 run 重连保留 | **PASS** | `t1-8-stopping-reconnect.json` | 断连冻结 `data-frozen=true`，重连后 stopping/清理未确认保留 |
| T1.9 A-05 unknown 终态 | **PASS** | `t1-9-unknown.json` | `TERMINAL_REASON=unknown` → `failed` +「失败 · 原因未知」 |
| T1.9 A-05 单工具失败不决定 run 失败 | **PASS** | `t1-9-tool-failure.json` | 工具标记失败后 run 仍 completed |
| T1.9 A-14 提醒优先级/非琥珀结构化样式 | **PASS** | `t1-9-alerts-style.json` | error 用 `role=alert` 红色、info 用普通文本蓝色，无琥珀；未知 code 统一「清理状态需要关注」 |
| T1.9 A-14 60 秒提醒与重连不重置 | **PASS** | `t1-9-60s-reconnect.json` | 「停止已受理超过 1 分钟…」在重连后仍显示，未重置 |
| T2.1 B-04 createRuntime 在途终止 | **PASS** | `t2-1-createRuntime.json` | 延迟 5s 内取消，晚到 runtime 被 dispose，未继续 startActivation |
| T2.1 B-04 startActivation 在途终止 | **PASS** | `t2-1-startActivation.json` | 延迟 5s 内取消，晚到 activation 被 dispose，未继续执行 |
| T2.2 B-07 cancel/end 竞态 | **PASS** | `t2-2-cancel-end-race.json` | 顺序 1：cancel 先受理，原始 completed 只留 stopReason，phase=stopped；顺序 2：end 先完成，cancel 返回 `already-terminal` |
| T1.5 A-11/A-16 真实读屏 | **Blocked** | — | 无 VoiceOver/NVDA 音频采集环境；CDP AX 树已在此前验证，真实播报未执行 |
| T1.7 C-08 全局 200 上限 | **Blocked** | — | 201 条真实 run 成本过高；每父 20 已在此前验证，全局 200 未在真机触发，自动化已覆盖淘汰逻辑 |
| T3.2 真实内网目录 | **未验证** | — | `10.130.209.76:18080` 不可达；按 R-ACC-5 记录为 E-06 环境限制，不压低 E-05 |
| T3.3 Windows | **已验证（GHA VM）** | run 40707139817 | 2026-10-28：真实 `@` package/legacy 完成与定向取消、卡片锚定与父会话可用；stub 模型 + 本地夹具，非 Windows 真机；见〈Windows GHA 验收（2026-10-28，已执行）〉 |

### 执行后计数

| 分类 | 数量 | 条目 |
| --- | --- | --- |
| PASS（真机/门禁/自动化充分裁定） | **45** | A-01、A-02、A-03、A-04、A-05、A-06、A-07、A-08、A-09、A-10、A-12、A-13、A-14、A-15；B-01、B-02、B-03、B-04、B-05、B-06、B-07、B-08、B-09、B-10；C-01、C-02*、C-03*、C-04、C-05、C-06、C-07、C-09；D-01、D-02*、D-03、D-04、D-05、D-06、D-07*、D-08*；E-01、E-02、E-03、E-04、E-05 |
| 部分 | **4** | A-11、A-16、C-08、E-06 |
| Blocked | **0** | — |
| 合计 | 49 | — |

`*` 表示按 R-ACC-1/2/3 以自动化证据视为通过，不是真机 PASS。

- 45 + 4 + 0 = 49；未 PASS 共 **4** 项，其中 **3 项属于 A–D**（A-11、A-16、C-08），E-06 为平台证据诚实项。
- A-11/A-16 需真实辅助技术环境，C-08 需 201 条真实 run；三者均无法在当前环境完成，按 Blocked/未验证记录，不写成 PASS。
- E-01～E-05 已全部 PASS；整体放行只剩 A-11/A-16（读屏）、C-08（全局 200）与 E-06（Windows/内网目录）的环境限制。
- 本节不勾选 §10.1；按「A–D 全部通过、E-01～E-05 通过」的判定，功能仍未完全验收，但剩余缺口已收窄为环境/成本限制，而非未实现的产品行为。

## 验收豁免与 Windows 验收路径（2026-10-28，owner）

owner 决定豁免 A-11/A-16 与 C-08，并将 Windows 验收放到 GitHub 虚拟机执行。豁免只表示接受残余风险，**不等于这些条目已真机通过**；§10.1 复选框对豁免项仍不勾选。

### R-ACC-6：A-11 / A-16 真实读屏豁免

- **豁免内容**：不再要求本轮采集 VoiceOver/NVDA 的真实播报音频。
- **保留证据**：CDP 可访问树（单个 `role=status`、`aria-live=polite`、可访问名）、键盘/Esc 与焦点返回、44px 命中区、reduced-motion 无脉冲、280px 无横向滚动。
- **未验证边界**：真实辅助技术的播报时序、打断行为与清理失败只 alert 一次的听觉表现未验证；若存在 AT 专属问题，本轮不能发现。
- **触发条件**：获得可用 AT 环境时，按 T1.5 的六项核对补做。

### R-ACC-7：C-08 全局 200 上限豁免

- **豁免内容**：不再要求本轮用 201 条真实 run 触发全局 200 淘汰。
- **保留证据**：每父 20 上限已由 21 条真实 legacy run 验证；Host registry 与客户端 reducer 的每父 20 / 全局 200 淘汰、活跃与 stopping 不淘汰由单测覆盖（`subagent-runs.spec.ts`、`subagentRuns.spec.ts`）。
- **未验证边界**：全局 200 在真实应用中的淘汰与 snapshot 对账未触发；该行为目前只有自动化证据。
- **触发条件**：出现低成本批量 run 通道时按 T1.7 补做（分散至少 11 个父会话，按父聚合，不能以单父快照冒充全局证据）。

### R-ACC-8：Windows 验收路径改为 GitHub 虚拟机（2026-10-28 已执行）

- **决定**：Windows 验收将在 GitHub 虚拟机（GHA）上执行，不在本机验收。
- **当前状态**：**已执行并落证据**（run `40707139817`，head `87528fc0f60f4a367c98a5f5ff568d55b6fddf24`）。本记录不是 Windows 真机 PASS；它是按 R-ACC-8 指定的 GHA 路径完成的真实 `@` UI 验收，输入边界见下节。
- **证据要求**：GHA 上需执行真实 `@` 完成与取消链路，记录平台、构建类型、Desktop SHA、Harness pin、测试人与日志；GHA 打包/CI 绿不能替代真实 `@` 验收。
- **真实内网目录**：不在本次豁免范围内；`10.130.209.76:18080` 仍不可达，E-06 继续标注未验证。

### Windows GHA 验收（2026-10-28，已执行）

- **运行**：[run 40707139817](https://github.com/kawaiininja/HuaAnWork-Desktop/actions/runs/40707139817)（workflow `Windows subagent run acceptance`，job `122882192790`）；head SHA `87528fc0f60f4a367c98a5f5ff568d55b6fddf24`，Harness pin `1600d8a1e140dcde43a1a0941940a0480712c011`。
- **最终 head 复跑**：本 run 在 harness 代码提交 `87528fc0f6` 上执行；E-06 文档更新只改文档，同一 workflow 会在最终 PR head 上复跑，以该次 artifact 记录的 SHA 为合并前最终验收证据（run 见 PR #21 的 checks/actions）。
- **环境**：GitHub-hosted Windows VM（`win25-vs2026`，Windows 10.0.26100，X64，runner `GitHub Actions 1000000703`）；workspace Electron build（unsigned、unpackaged）；HuaAnWork `0.1.0` + DSH `0.2.1-rc.1`。执行者为自动化 CDP 驱动（workflow artifact 内含 driver/app/stub/catalog 日志）。
- **输入边界**：模型为 loopback stub（`allow_network=false`），legacy 目录为 `127.0.0.1` 本地 fixture（`legacy-demo`），package 为本地 `@doc-clerk` v1.0.0 夹具；**不是真实模型，也不是真实内网目录**。
- **四个真实 `@` 场景**（每个都从 composer 输入并发送，四次发送共 4 张卡，全部锚定在各自用户消息之后）：
  - package-complete：相位 `starting → tool → generating → completed`，观察到真实工具活动，终态「已完成」；
  - package-cancel：活跃卡 → 卡内「终止」→「确认终止」→「已停止」；
  - legacy-complete：相位 `tool → generating → completed`，观察到真实工具活动，终态「已完成」；
  - legacy-cancel：活跃卡 → 确认终止 →「已停止」；
  - 取消后父会话继续可用（`PARENT continue acceptance after the cancelled runs.` 收到回复）。
- **证据**：run artifact `windows-subagent-run-acceptance` 内含 facts JSON（平台、SHA、Harness pin、场景、锚定、相位、截图清单）、6 张 1024×720 截图，以及 app/stub/legacy 日志。截图与日志只存 GitHub artifact，不进公开仓库。
- **诚实边界**：这是 **GHA 虚拟机**验收，不是 Windows 真机 PASS；使用 stub 模型与本地夹具，真实内网目录仍未验证；兄弟并发与真实读屏不在本 run 覆盖范围（分别由单测与 A-11/A-16 waiver 承担）；installer/portable 构建由 `desktop-windows` CI 覆盖，不是本 run 的验收对象。应用在事实采集后被 `taskkill /T /F` 强制结束，driver 日志中的 app exit 1 是该强制停止，不是场景失败。
- **判定**：E-06 的 Windows 项从「未验证」更新为「GHA VM 已验证」；真实内网目录仍为「未验证」，因此 E-06 整体仍为**部分**，§10.1 仍不勾选。

### 豁免后的计数

| 分类 | 数量 | 条目 |
| --- | --- | --- |
| PASS（真机/门禁/自动化充分裁定） | 45 | 与〈验收收口场景执行结果（2026-10-28）〉的 PASS 表一致 |
| 部分 | 1 | E-06（真实内网目录未验证；Windows GHA 已验证） |
| 豁免（owner 接受残余风险，非 PASS） | 3 | A-11、A-16（R-ACC-6）、C-08（R-ACC-7） |
| Blocked | 0 | — |
| 合计 | 49 | — |

- 45 + 1 + 3 + 0 = 49；A–D 的条目已全部 PASS 或经 owner 豁免，E-01～E-05 全部 PASS。
- 因此本子代理功能可记为 **complete with waiver**：A-11/A-16、C-08 豁免，Windows GHA 已验证（VM 路径），真实内网目录未验证。不得写成 49/49 全量 PASS，也不得把豁免项勾进 §10.1。
- Windows GHA 验收已完成并落证据（run `40707139817`）；E-06 的剩余缺口是真实内网目录。整体状态保持 complete with waiver。
