# 复杂任务与子 agent 右侧进度面板 — 实施证据（2026-11-17 ~ 2026-11-19）

- 分支：`feat/progress-sidebar`（基线 `3dd3b182bc8c28671d5f712a7ae2da23dab463bd`）
- 规格：`docs/superpowers/specs/2026-11-15-task-progress-sidebar-design.md`
- 计划：`docs/superpowers/plans/2026-11-15-progress-sidebar.md`
- 评审：`docs/superpowers/plans/2026-11-15-implementation-plans-review.md`（§16–§18 计划层闭环 0 Critical / 0 Important / 0 Minor）
- 代码评审：[docs/superpowers/plans/2026-11-18-progress-sidebar-code-review.md](../superpowers/plans/2026-11-18-progress-sidebar-code-review.md)（首轮 0 Critical / 3 Important / 4 Minor 修复于 `2cfe785f3a` + `dd6e837e60`；`qwen4` 复审 §7 所列 6 Important `Q4-I1`–`Q4-I6` + 1 Minor `Q4-M1` 经复核后已于 2026-11-19 全部修复并复跑闭环，见该文档 §8 与本文档 §2.6）
- 环境：macOS darwin 27.0.0 / arm64；验收进程 Node v22.23.2；Electron 44.0.0；桌面 0.1.8；DSH 0.2.1-rc.1；harness pin `1600d8a1e140dcde43a1a0941940a0480712c011`；zstd 1.5.7

## 0. 状态声明

- 规格 §14.2 / 计划 Task 5 Step 7 的七项 agent 真机走查自动化测试**已实际执行**：工作区构建 Electron（`lib/main.js`）、隔离临时 `DSH_HOME` + `--user-data-dir` + `--remote-debugging-port` + `HUAANWORK_ACCEPTANCE_HOOKS=1`；模型配置从本机 `~/.huaanwork/profiles/desktop/huaanwork-settings.json` 只读复制（`api_key` 未打印、未入库），隔离根退出时删除。
- **最终结果：exit `0`（PASS），7/7 通过（含 F1/F2 修复轮、2026-11-18 评审修复轮，以及 2026-11-19 `qwen4` 复审修复轮；后者加强了真机身份/归属与失效仲裁判据，为最终权威运行，见 §2.6/§4）。** 验收用的模型条目在隔离 profile 中固定为 `deepseek-chat`（§2 说明）。
- 单元测试、类型检查与根门禁（§1/§2.6）均通过，且与真机结果一致。

## 1. 自动化门禁（实际执行）

| 命令 | 执行方 | 退出码 | 结果 |
| --- | --- | --- | --- |
| `node --test dsh-plugin-huaanwork/scripts/huaanwork-host-progress-sidebar-acceptance.spec.mjs` | 控制器 | 0 | 18/18 pass |
| `corepack yarn workspace dsh-plugin-huaanwork vitest run tests/huaanwork-guardrails/skills.spec.ts tests/huaanwork-guardrails/present-as.cordis.spec.ts tests/profile.spec.ts tests/huaanwork-guardrails/bridge.spec.ts tests/huaanwork-guardrails/package-subagent-lineage.spec.ts tests/huaanwork-host/agent-package-runtime.spec.ts tests/huaanwork-guardrails/policy.cordis.spec.ts tests/market-composition-order.spec.ts tests/huaanwork-host/test-port-mapping.spec.ts` | 控制器 | 0 | 298/298 pass |
| `corepack yarn workspace dsh-plugin-huaanwork typecheck` | 控制器 | 0 | 无输出 |
| `corepack yarn workspace @huaanwork/policy check` | 控制器 | 0 | 65 pass / 2 skipped |
| `corepack yarn workspace dsh-plugin-huaanwork run verify:host` | 控制器 | 0 | 53/53 pass |
| `corepack yarn check` | 控制器 | 0 | 桌面包全量通过；`verify:profile-boot` 通过；其余 workspace 全通过 |

> 上表为 F1/F2 修复轮记录；2026-11-18 代码评审修复后的门禁复跑结果见 §2.5（policy 65/0、typecheck 0 错、`corepack yarn check` GATE_EXIT=0、判据单测 18/18）。

## 2. 本次修复（对应 F1/F2）

1. **F1（模型入口）**：`profile.ts` 为不走 preset 的桌面父会话显式启用宿主平面 `skill-filesystem` / `tool-skill`，`agentsHome` 仍指向空目录；`present-as.ts` 仅对无人值守自动化与 legacy/system-skill 儿童隐藏 `skill`，普通父会话可用。
2. **F2（顺序派发失败）**：`skills.ts` 在 `agent/disposed` 时从 `tracked`/`kinds`/`lifted` 移除已释放子代理，并对 `cannot create effect on inactive context` 竞态兜底；`holders.ts` 在创建 `huaanworkSystemSkillLeases` 后调用 `huaanworkRegisterSystemSkillLeaseInvalidation`，修复「租约 store 晚于 skills apply 创建时 `onInvalidate` 未注册」导致的旧技能类型残留。
3. **走查可靠性**：双入口场景使用第一个系统技能回合作为执行窗口起点（避免把上一系统技能回合误当普通回合），并增加一次显式 `subagent` 重试；隔离 profile 的活跃模型固定为 `deepseek-chat`（`deepseek-flash` 会自述没有 `subagent`，实测不可靠）。
4. **组合顺序与 smoke 兼容**：`skill-filesystem`/`tool-skill` 放在 `llm-deepseek` 锁层锚点之前，保持 guardrail 锁层连续；`test-port-mapping.ts` 的证据行号同步到新增测试后的真实行号；`huaanwork-host-loop.spec.mjs` 的 `/ls/` 匹配收紧为 `/\bls\b/`，避免把 `skills`/`tools` 误判为 `ls` 命令。

## 2.5 2026-11-18 代码评审修复与真机复跑

1. **修复内容**：按 [代码评审](../superpowers/plans/2026-11-18-progress-sidebar-code-review.md) 复核结论修复 Important #1（§8.1 总进度条 + `正在等待任务拆解`/`暂无任务拆解` 文案 + CDP 判据拆分为单步域/总进度条域）、Important #3（`confirmingTarget {runId, surface}` 确认表面作用域 + `ToolPanel idPrefix`）、Minor #1–#4（创建期 `header.parentSession` 判别、`rememberSubagentSpawn` 会话登记、`during` 窗口延长至 `/test-fix`、证据笔误与行号同步）。落提交 `2cfe785f3a` + `dd6e837e60`；工作区重建后门禁复跑全绿（policy 65/0、typecheck 0 错、`corepack yarn check` GATE_EXIT=0，vitest 304 文件/4367 通过、verify:host 53）。
2. **复跑过程**：重建产物（含修复）后先跑一轮全量走查——6/7 通过，唯一失败 `no-fabricated-percentage` 为**脚本侧判据选择器 bug**（总进度条按 `.progress-section-head` 后代查询，而组件将其渲染为 head 的兄弟节点，`.progress-total-bar` 计数恒 0），非产品缺陷；该轮同时证实 `dual-entry`（延长后的 during 窗口）与 `single-cancel-isolation`（新确认表面作用域）真机通过。修正选择器为直接查询 `.progress-total-bar` 后完整复跑。
3. **当轮结果**：`exit 0`（PASS），7/7 通过；判据单测 18/18、`node --check` 通过。`no-fabricated-percentage` 实测：39 个采样 `taskPercentTexts=0`、`taskProgressBarCount=0`、`totalProgressBarCount=1`、`totalBarMatchesCount=true`、`countFormatAlwaysXY=true`。

## 2.6 2026-11-19 `qwen4` 评审修复与真机复跑（最终权威运行）

1. **修复内容**：按 [代码评审 §7–§8](../superpowers/plans/2026-11-18-progress-sidebar-code-review.md) 完成 `Q4-I1`–`Q4-I6` 与 `Q4-M1` 全部修复并重建产物：
   - **产品与接线**：`upsertTodoItem` 反向定位当前回合最新 todo 快照（`Q4-I1`）；`skills.ts` 为兼容 `pendingSpawn` 增加 `parentSessionId` 归属校验与 `startHostManaged` ALS 屏蔽 Host 托管 `startActivation`（`Q4-I2`）；`App.tsx` 与 `sessionChannel.ts` 为早到普通 `tool/start`/`tool/end`、以及 `queue-start` 窗内 `session/end`/`goal/*` 增加精确缓冲回放（`Q4-I3`/`Q4-I4`）；视图节点补充只读 `data-call-id`、`data-round-key`、`data-turn-anchor`、`data-run-id` 属性。
   - **走查工装与判据加强**：`resolveBlockedOrFailedOutcome` 禁止前置失败后由 `BlockedError` 降格为 `BLOCKED`（`Q4-I5`）；`cleanupIsolatedRoot` / `resolveFinalExitCode` 在 `shutdown()` 后 Fail-Closed 裁定退出码（`Q4-I6`）；加强活动 `turnAnchor`/`callId`/`roundKey`、本地 `@legacy-reviewer` (`kind="legacy"`) 独立路径、`PSB-DUAL-WARM`/`PSB-MID1`/`PSB-MID2` 独立回合与 per-entry 检查、`MutationObserver` 外层工具作用域断言、以及点击即绑 `data-run-id` + 结算后全窗口 `cancelRpc` 与逐 `runId` 唯一断言（`Q4-M1`）。
2. **全量门禁复跑（全部通过）**：`build` exit `0`；真实 Electron CDP 走查 `--out /tmp/progress-sidebar-accept-qwen4-r2` exit `0`（`verdict PASS`，7/7 全通过，`isolatedCleanup: "removed"`）；`huaanwork-host-progress-sidebar-acceptance.spec.mjs` 21/21 pass；`@huaanwork/policy check` 65 pass / 2 skipped；`typecheck` 0 错；`verify:host` 56/56 pass；`dsh-plugin-huaanwork test` 304 passed / 4 skipped (308) 文件、4371 passed / 15 skipped (4386) 用例；`corepack yarn check` exit `0`。

## 3. 走查命令与退出码

最终权威运行（2026-11-19 `qwen4` 评审修复轮）：

```bash
corepack yarn workspace dsh-plugin-huaanwork build
corepack yarn workspace dsh-plugin-huaanwork exec node scripts/huaanwork-accept-progress-sidebar.mjs --out /tmp/progress-sidebar-accept-qwen4-r2
# exit 0 (PASS), 7/7, isolatedCleanup: "removed"
```

此前记录：F1/F2 修复轮（11-17 ~ 11-18 午前）`--out /tmp/progress-sidebar-accept-final` exit 0（PASS）；首轮代码评审修复 `--out /tmp/progress-sidebar-accept-rerun2` exit 0（PASS）。

脚本返回码约定：`0` PASS / `1` FAIL / `3` BLOCKED。截图、DOM 快照与事实 JSON 备份在仓库外（§6），仓库仅提交脚本、判据单测与本脱敏文档。

## 4. 七项结果（最终全量运行，facts 摘要）

> 下表为 **2026-11-19 `qwen4` 评审修复轮**（最终权威运行）。

| # | 场景 | 判据 | 结果 |
| --- | --- | --- | --- |
| 1 | 复杂任务进度 | 4 个 Task、顶部 `已完成 4/4`、当前项高亮、主流待办卡唯一、日志含 4 次 `todo_write` | ✅ |
| 2 | 活动无虚构百分比 | 33 采样：单步无百分比文本/进度条（`taskProgressBarCount=0`）、总进度条恰一枚且与 `X/Y` 互锁（`totalBarMatchesCount=true`）、`activityAnchor === expectedTurnAnchor`、5 条活动条目与回合日志 `{ name, callId, roundKey }` 逐项对齐、`foreignActivityCalls=[]` | ✅ |
| 3 | 普通父会话不可自主派发 | 普通回合 `request/header` 无 `subagent`；本地 catalog 遗留 `@legacy-reviewer`（`kind="legacy"`）与包 `@typo-check` 均独立出卡且定向取消收敛 | ✅ |
| 4 | explore/test-fix 双入口双技能 | 独立暖场 `PSB-DUAL-WARM` 与 `PSB-MID1`/`PSB-MID2` 隔离开关窗；3 入口均记录 `runKind="system-skill"`、`anchorMatched=true`、`headerHasSubagent=true`、`model-skill` 调用 `skill("explore")`；显式 `/explore` 与 `/test-fix` 定向取消收敛；`PSB-AFTER` 后 `subagent` 收回 | ✅ |
| 5 | 包 lane 深度 2 | 外层包 `@typo-check`（`00:34`）`completed`；身份链 1 个 child（depth 1）+ 2 条 lane（depth 2）；右栏 lane 行数 0；`MutationObserver` 捕获外层摘要工具 `["bash","glob","subagent"]` ⊆ `outerChildToolNames`，无泄漏 | ✅ |
| 6 | 切换/重连/历史/Host 重启 | 新标签空任务；切回 4 tasks；同会话新普通回合 0 tasks；重载历史 4 tasks；断连/重连横幅出现；Host 重启旧 pid `28487` → 新 pid `29325`、同 canary、2 张 stale 卡呈 `状态不可恢复 · Host 已重启，结果未确认`、终止禁用、耗时冻结 `00:01` | ✅ |
| 7 | 兄弟并发与单次取消隔离 | 两个并发 `system-skill` explore 运行；点击时预绑定目标 `runId` (`5f3a37b8-...`)，结算后全窗口仅 1 条命中的 `subagent.cancel`；目标 `stopped`、兄弟 `completed` 且 settlement 送达；`mainCardCounts` 与 `railCardCounts` 均为 `{ target: 1, sibling: 1 }`、`perRunCardUnique=true`、4 面板 ID 唯一 | ✅ |

### 4.1 证据摘录（最终全量运行，2026-11-19 `qwen4` 评审修复轮）

**双入口三阶段 `request/header.tools`**

```json
{
  "beforeHasSubagent": false,
  "duringHasSubagent": true,
  "afterHasSubagent": false,
  "added": ["subagent"],
  "removed": ["subagent"]
}
```

**单次取消 RPC（场景 7）**

```json
{
  "targetRunId": "5f3a37b8-3655-488f-bebb-17d32b4cc4c8",
  "cancelRpc": { "cancelRequestCount": 1, "targetRunIdCount": 1, "otherRunIdCount": 0,
                 "runIds": ["5f3a37b8-3655-488f-bebb-17d32b4cc4c8"] },
  "cancelConverged": true, "siblingCompleted": true, "siblingSettlementSeen": true,
  "mainCardCounts": { "target": 1, "sibling": 1 }, "railCardCounts": { "target": 1, "sibling": 1 },
  "perRunCardUnique": true, "mainToolPanelsUnique": true, "mainToolPanelCount": 4
}
```

**Host 重启接力（场景 6）**

```json
{ "oldPid": 28487, "newPid": 29325, "sameDocument": true, "staleCardCount": 2, "asserted": true }
```

**双入口 entries（场景 4）**

```json
[
  { "entry": "model-skill", "skill": "explore", "runKind": "system-skill", "anchorMatched": true, "headerHasSubagent": true, "skillToolCalled": true, "runSeenInMain": true, "runSeenInRail": true, "cancelled": false },
  { "entry": "explicit-slash", "skill": "explore", "runKind": "system-skill", "anchorMatched": true, "headerHasSubagent": true, "runSeenInMain": true, "runSeenInRail": true, "cancelled": true },
  { "entry": "explicit-slash", "skill": "test-fix", "runKind": "system-skill", "anchorMatched": true, "headerHasSubagent": true, "runSeenInMain": true, "runSeenInRail": true, "cancelled": true }
]
```

## 5. F1/F2 闭环说明

- **F1**：原因为桌面父会话不走 preset，宿主平面 `tool-skill` 被 web-app overlay 关闭，导致 `request/header` 从不声明 `skill`。方案 B 已实施，模型入口可用。
- **F2**：`skills.ts` 的 `tracked` 集合在子代理释放后未清理，后续 `tools/change` 对已 DISPOSED 子代理重复 `tools.restrict`，抛出 `cannot create effect on inactive context`；同时 `onInvalidate` 因租约 store 创建晚于 `applySkills` 而未注册，导致显式 `/test-fix` 仍沿用 `explore`。两处均已修复，顺序派发与显式双技能恢复正常。
- `AGENTS.md` 中 F1/F2 的活跃债行已随本次修复移除；本文件保留为闭环证据。

## 6. 证据备份与清理

- 2026-11-19 `qwen4` 评审修复轮（最终权威运行）截图、`facts.json` 与 `walkthrough.log` 备份：`~/huaanwork-progress-sidebar-accept-evidence-2026-11-18-qwen4/`（仓库外；不含密钥）；此前轮次在 `~/huaanwork-progress-sidebar-accept-evidence-2026-11-18-rerun/` 与 `~/huaanwork-progress-sidebar-accept-evidence-2026-11-18/`。
- 隔离临时根（含只读复制的模型配置与会话日志）在运行结束时删除（`facts.isolatedCleanup = removed`）；调试期间的 `--only` 隔离根均已手工删除。
- 仓库未提交截图、fixture 或任何含密钥临时目录。

## 7. 结论

- 七项真机走查自动化脚本与判据单测已落地并纳入 `verify:host`（56/56 pass）；`qwen4` 评审修复后最终全量运行 7/7 通过（§2.6/§4），同时完成 `Q4-I1`–`Q4-I6` 与 `Q4-M1` 全部修复与回归验证。
- 所有已发现评审缺陷均已修复闭环；未以单测或门禁通过替代真机结论。分支 `feat/progress-sidebar` 达到合入 `master` 标准。
