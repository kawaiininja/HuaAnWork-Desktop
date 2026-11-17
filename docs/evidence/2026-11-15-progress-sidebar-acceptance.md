# 复杂任务与子 agent 右侧进度面板 — 实施证据（2026-11-17 ~ 2026-11-18）

- 分支：`feat/progress-sidebar`（基线 `3dd3b182bc8c28671d5f712a7ae2da23dab463bd`）
- 规格：`docs/superpowers/specs/2026-11-15-task-progress-sidebar-design.md`
- 计划：`docs/superpowers/plans/2026-11-15-progress-sidebar.md`
- 评审：`docs/superpowers/plans/2026-11-15-implementation-plans-review.md`（§16–§18 计划层闭环 0 Critical / 0 Important / 0 Minor）
- 环境：macOS darwin 27.0.0 / arm64；验收进程 Node v22.23.2；Electron 44.0.0；桌面 0.1.8；DSH 0.2.1-rc.1；harness pin `1600d8a1e140dcde43a1a0941940a0480712c011`；zstd 1.5.7

## 0. 状态声明

- 规格 §14.2 / 计划 Task 5 Step 7 的七项 agent 真机走查自动化测试**已实际执行**：工作区构建 Electron（`lib/main.js`）、隔离临时 `DSH_HOME` + `--user-data-dir` + `--remote-debugging-port` + `HUAANWORK_ACCEPTANCE_HOOKS=1`；模型配置从本机 `~/.huaanwork/profiles/desktop/huaanwork-settings.json` 只读复制（`api_key` 未打印、未入库），隔离根退出时删除。
- **最终结果（2026-11-18 复核重跑；工作区 = HEAD `ae95893b9f` + 本轮评审修复）：exit `1`（FAIL），7 项中 5 项通过。** `switch-history-restart` 与 `dual-entry-system-skills` 失败；失败原因是实机暴露的产品行为（§5 F1/F2），不是脚本缺失或条件跳过。上一轮同一脚本因 F1 先行抛出 `BlockedError`（exit 3），会把 `switch-history-restart` 的真实 FAIL 掩蔽为 BLOCKED；本轮退出码优先级已修正——只有唯一失败项为 `dual-entry-system-skills` 且原因只有 model-skill 不可构造时才记 BLOCKED（exit 3），其他失败一律 FAIL（exit 1）。本轮 `facts.blocked` 仍保留 F1 明细，供 owner 裁定。
- 单元测试、类型检查与根门禁（§1）均已通过，但它们**不替代** §3/§4 的真机结论。

## 1. 自动化门禁（实际执行）

| 命令 | 执行方 | 退出码 | 结果 |
| --- | --- | --- | --- |
| `node --test dsh-plugin-huaanwork/scripts/huaanwork-host-progress-sidebar-acceptance.spec.mjs` | 控制器 | 0 | 18/18 pass（判据纯函数：header schema 提取、三阶段对比含空 before 拒绝、身份链、Host 重启接力、单次取消、最新轮次活动覆盖） |
| `corepack yarn workspace dsh-plugin-huaanwork vitest run tests/huaanwork-guardrails/skills.spec.ts` | 控制器 | 0 | 63/63 pass（清理 promise 回链修复后的独立运行） |
| `corepack yarn workspace dsh-plugin-huaanwork vitest run tests/huaanwork-guardrails/skills.spec.ts tests/client-huaanwork/appWiring.spec.ts tests/client-huaanwork/progressPanel.spec.ts tests/client-huaanwork/ProgressPanelComponent.spec.ts` | 控制器 | 0 | 191/191 pass（含新增全新标签首发的锚匹配测试） |
| `corepack yarn workspace @huaanwork/policy check` | 控制器 | 0 | 65 pass / 2 skipped |
| `corepack yarn workspace dsh-plugin-huaanwork run verify:host` | 控制器 | 0 | 53/53 pass（含新增 18 条走查判据） |
| `corepack yarn check` | 控制器 | 0 | 见下方复跑记录；桌面包全量通过 |

根门禁复跑记录（最终评审修复后）：

```text
corepack yarn check → exit 0
桌面包 4357 passed / 15 skipped；verify:profile-boot 通过；
agent-catalog 303、market-server 244、update-server 88、agent-catalog-server 112 全通过
```

首轮复跑在 update-server 的 `artifact-validate.spec.ts` 遇到一次宿主瞬时失败（`hdiutil create` 失败）；该包隔离复跑 88/88、随后整门禁复跑 exit 0，不计为产品回归。

## 2. 提交链

| 提交 | 内容 |
| --- | --- |
| `4612515a62` | 共享回合锚点 store 与 UUID 发送/宿主接线（Task 1） |
| `cfef58bc8b` | `subagent` 默认隐藏、包血缘附件与系统技能租约、`tools/execute` ALS（Task 2） |
| `0a563f7af7` | `system-skill` 运行进入 registry、共享清理 helper 与严格停止仲裁（Task 3） |
| `18efa846d7` | todo 实时归属与历史待办投影、R-12 闭环（Task 4） |
| `a7d1d12857` | ProgressPanel 选择器、组件与右栏接线（Task 5A） |
| `4bc0f47358` | 右栏窄列子 agent 卡样式作用域修复（Task 5A fix） |
| `01c150b26a` | 走查脚本、判据单测与本文档（Task 5B） |
| 本文件上一轮提交 | 评审修复波：证据摘录、最新轮次活动覆盖、同会话上一回合待办、主流工具卡唯一、空 before 拒绝、取消 RPC 等待、`@task-orch` 重启运行 |
| 本文件所在提交 | 最终评审修复波：清理 promise 回链、全新标签首发的早到待办按锚匹配、FAIL/BLOCKED 退出码优先级、证据重跑与 `AGENTS.md` 债务行 |

## 3. 走查命令与退出码

```bash
corepack yarn workspace dsh-plugin-huaanwork build
corepack yarn workspace dsh-plugin-huaanwork exec node scripts/huaanwork-accept-progress-sidebar.mjs --out /tmp/progress-sidebar-accept-final
# exit 1 (FAIL)
```

脚本返回码约定：`0` PASS / `1` FAIL / `3` BLOCKED。本轮 `switch-history-restart` 与 `dual-entry-system-skills` 同时失败，按退出码优先级以 FAIL 收尾（`facts.blocked` 保留 F1 明细）；上一轮仅因 F1 先行判 BLOCKED（exit 3），本轮修正后不再掩蔽另一项真实 FAIL。截图、DOM 快照与事实 JSON 备份在仓库外（§6），仓库仅提交脚本、判据单测与本脱敏文档。

## 4. 七项结果（最终全量运行，facts 摘要）

| # | 场景 | 判据 | 结果 |
| --- | --- | --- | --- |
| 1 | 复杂任务进度 | 4 个 Task、顶部 `已完成 4/4`、当前项高亮、主流待办卡唯一、日志含 4 次 `todo_write` | ✅ |
| 2 | 活动无虚构百分比 | 无百分比文本/进度条、计数保持 `X/Y`、右栏活动工具名 ⊆ 当前回合会话工具名（`bash` ⊆ `bash,read,write`），且最新非 todo 轮次 `bash` 已呈现 | ✅ |
| 3 | 普通父会话不可自主派发 | 普通回合 `request/header` 22 个工具无 `subagent`；显式 `@typo-check` 卡出现且定向取消收敛 | ✅ |
| 4 | explore/test-fix 双入口双技能 | 模型 `skill` 入口不可构造（§5 F1）；显式 `/explore` 卡与取消通过；`/test-fix` 卡出现但定向取消 60 秒未收敛（§5 F2），Host 本轮未报“会话已失败”；后续普通回合未产生 request/header 快照 | ❌（F1+F2） |
| 5 | 包 lane 深度 2 | 外层包运行 `completed`；身份链 1 个 child（depth 1）+ 2 条 lane（depth 2）；两条 lane 收尾文本非空、settlement 均送达；右栏无独立 lane 行，仅外层聚合摘要 | ✅ |
| 6 | 切换/重连/历史/Host 重启 | 新标签空任务；切回 4 tasks；同会话新普通回合 0 tasks（上一回合 todo 未冒充）；重载历史 4 tasks；断连/重连横幅出现；Host 重启旧/新 pid 更换（66873 → 67977）且 renderer 文档同一 canary，但重启运行在重启前失去活跃态，未产生 stale 卡 | ❌（F2：同场景单独运行时通过） |
| 7 | 兄弟并发与单次取消隔离 | 两个并发 `system-skill` explore 运行；两步确认只发送 1 条命中目标 `runId` 的 `subagent.cancel`；目标 `stopped`、兄弟 `completed`、settlement 送达；主流工具卡唯一（5 个 panel id 无重复） | ✅ |

### 4.1 证据摘录（最终全量运行 / 诊断复跑）

**三阶段 `request/header.tools`（场景 4）**

```json
{
  "before": ["bash","call_host_tool","create_goal","edit","exit_plan_mode","get_goal","git_branch","git_checkout","git_commit","git_diff","git_push","git_status","glob","grep","propose_plan","read","request_input","screenshot","todo_write","update_goal","web_fetch","write"],
  "during": ["agent_commit","agent_http","agent_propose","agent_skill_run","bash","call_host_tool","create_goal","edit","exit_plan_mode","get_goal","git_branch","git_checkout","git_commit","git_diff","git_push","git_status","glob","grep","propose_plan","read","read_image","request_input","screenshot","skill_commit","skill_propose","subagent","todo_write","update_goal","web_fetch","working_directory","write"],
  "after": []
}
```

`before` 证明普通回合无 `subagent`；`during` 出现 `subagent`；`after` 为空是因为 `/test-fix` 运行未收敛（定向取消 60 秒超时）且后续普通回合未再发出请求——该空窗由判据判红（§5 F2），不是伪造通过。另：`skill` 工具在三阶段均不存在（F1 的 schema 证据）。

**单次取消 RPC（场景 7）**

```json
{
  "targetRunId": "db91d132-7805-4651-8a26-27761ccc82d9",
  "siblingRunId": "59dab7ec-b0ef-481a-8698-ae960da6d110",
  "cancelRpc": { "cancelRequestCount": 1, "targetRunIdCount": 1, "otherRunIdCount": 0,
                 "runIds": ["db91d132-7805-4651-8a26-27761ccc82d9"] },
  "cancelConverged": true, "siblingCompleted": true, "siblingSettlementSeen": true,
  "mainToolPanelsUnique": true, "mainToolPanelCount": 5
}
```

**Host 重启（场景 6，判红部分）**

```json
{
  "attempted": true, "asserted": false,
  "oldPid": 66873, "newPid": 67977, "sameDocument": true,
  "reconnectBannerSeen": true,
  "mainRunCountBefore": 1, "mainRunCountAfter": 1,
  "staleCardCount": 0, "staleCards": []
}
```

renderer 文档 canary 与 origin/timeOrigin 未变、Host pid 已更换、断连/重连横幅已出现，但重启前的活跃运行在重启前失去活跃态，重启后没有任何 stale 卡，`assertHostRestartEvidence` 因此拒绝（§5 F2）。

**F2 诊断（调试运行；临时隔离根已删除，以下为当时解压会话日志的事件摘录）**

```text
child session header: { id: "4a939b03-…", parentSession: "huaanwork-2262661e22e1d330-783df351", origin: "subagent", delegationDepth: 1 }
child event types: session, subagent/descriptor, sandbox/mode, approval/policy, working-directory/change, agent/inbox/spliced ×2
（无 turn/start；同一模式下共 5 个 child 会话均如此）
parent tool/result (subagent call 84a830b1-9e9e-40e9-89c2-6340c9552609):
Error: cannot create effect on inactive contextcannot create effect on inactive context
```

复现矩阵：全新会话中两个并发系统技能运行均启动成功（场景 7）；同一会话中先序子运行结束/被取消后，后续模型面 `subagent` 调用产生上述 child 无首轮启动；临时关闭轨道取消后仍复现。

**F1 生产日志抽样**

近期多份 `~/.huaanwork/sessions/*/*/session.v4.jsonl.zstd` 的 `request/header` 工具名并集（以 `zstd -dc` 解压后解析）均不含 `skill`；隔离运行父回合的 22 个工具名同样不含 `skill`。

## 5. 产品级发现（待 owner 裁定）

### F1：模型面 `skill` 工具未在 shipped profile 暴露（fail-closed 的阻断理由）

- 隔离运行中，父会话 `request/header` 工具 schema 共 22 个（`bash`、`read`、`edit`、`write`、`todo_write`、`subagent` 等），**无 `skill`**；`huaanwork-accept-progress-sidebar.mjs` 据此把 `model-skill` 入口记为不可构造。退出码由全部失败项决定：本轮 `switch-history-restart` 同时失败，因此是 exit 1（FAIL）并在 `facts.blocked` 保留本条明细；若它是唯一失败则 exit 3（BLOCKED）。
- 本机近期生产会话日志同样未出现 `skill` 工具。
- 影响：规格 R2 / §7.2 的“模型调用 `skill` 工具”入口在当前产品组合下不可达；显式 `/explore`、`/test-fix` 入口不受影响。需要 owner 决定是补齐 profile 的工具装载，还是调整规格把模型入口标记为暂不可用。

### F2：子运行结束后，同会话后续子 agent 派发间歇失败（模型工具与 Host `@` 均受影响）

- 复现矩阵（真实 Electron + 真实模型）：
  - 全新会话中两个并发系统技能派发：均启动成功（本轮最终运行场景 7）；
  - 同一会话中第一个子运行结束/被取消后的下一次 `subagent` 工具调用：子会话被创建（`origin: subagent`、`delegationDepth: 1`、提示已注入），但**没有 `turn/start`**；工具结果为 `Error: cannot create effect on inactive context`；
  - 临时关闭 explore 的轨道取消后仍复现，因此不是取消控件触发；
  - 16:01 的全量运行中，`single-cancel-isolation` 的两条系统技能派发产生 0 个受管运行（16:25、16:40 与 2026-11-18 01:10 的本轮运行均通过），说明该缺陷是**间歇性**的；
  - 本轮最终运行（2026-11-18 01:08–01:14）中，`switch-history-restart` 的重启运行（Host 显式 `@task-orch` 派发）在重启前失去活跃态（pid 66873 → 67977，文档未替换），未产生 stale 卡；同一场景单独运行时以 `@task-orch` 通过并产生 2 张 stale 卡——说明缺陷不限于模型工具路径；
  - 本轮最终运行中，`/test-fix` 卡在主流程与右栏均出现（`runSeenInMain/Rail = true`），但定向终止 60 秒未收敛（`active rail card test-fix timed out after 60000ms`），随后的普通 follow-up 也未再产生 `request/header` 快照——缺陷同时阻断场景 4 的取消与 `subagent` 回收断言（本轮 Host 未报“会话已失败”）。
- 直接后果：在部分运行中 `/test-fix` 派生的 `system-skill` 运行卡在 00:00 变为 `失败 · 执行出错`，无法执行定向终止（本轮表现为定向终止 60 秒未收敛）；Host 重启失效场景在部分运行中无法构造 stale 卡。规格 §14.2 第 4、6 项的完整通过因此被阻断。16:01 的调试运行中第 7 项也曾因同一缺陷产生 0 个受管运行，但 16:25、16:40 与最终全量运行的场景 7 均通过（见 §4），故第 7 项不计入阻断范围。
- 建议：由 owner 裁定缺陷归属与修复任务（上游 subagent provider 的上下文生命周期，或本计划 Task 2/3 包装与释放路径的相互作用）。修复后重跑本脚本应可把场景 4/6 转为通过；若 F1 同时裁定补齐，最终退出码才会是 `0`。本轮退出码为 `1`（FAIL），BLOCKED 不再掩蔽 `switch-history-restart` 的真实 FAIL。

## 6. 证据备份与清理

- 截图、DOM 失败快照、`facts.json` 与 `walkthrough.log` 备份：`~/huaanwork-progress-sidebar-accept-evidence-2026-11-18/`（仓库外，已用本轮运行产物覆盖；不含密钥）。
- 隔离临时根（含只读复制的模型配置与会话日志）在运行结束时删除（`facts.isolatedCleanup = removed`）；调试期间保留的 `/tmp/psb-*` 调试输出与日志已删除。
- 仓库未提交截图、fixture 或任何含密钥临时目录。

## 7. 结论

- 七项真机走查自动化脚本已落地、可重复执行，判据单测纳入 `verify:host`；本轮最终全量运行（2026-11-18）中场景 1/2/3/5/7 通过。
- 场景 4/6 暴露出 F1/F2 两项产品级问题；本轮按退出码优先级记录为 `FAIL`（exit 1），`facts.blocked` 保留 F1 明细，未以单测或门禁通过替代真机结论。
- 后续：F1/F2 的修复或裁定落地后，重跑 `huaanwork-accept-progress-sidebar.mjs`；通过时以 exit 0 的完整 facts 替换本节结论并更新本文件。
