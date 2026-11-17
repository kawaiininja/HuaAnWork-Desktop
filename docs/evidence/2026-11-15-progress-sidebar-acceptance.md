# 复杂任务与子 agent 右侧进度面板 — 实施证据（2026-11-17 ~ 2026-11-18）

- 分支：`feat/progress-sidebar`（基线 `3dd3b182bc8c28671d5f712a7ae2da23dab463bd`）
- 规格：`docs/superpowers/specs/2026-11-15-task-progress-sidebar-design.md`
- 计划：`docs/superpowers/plans/2026-11-15-progress-sidebar.md`
- 评审：`docs/superpowers/plans/2026-11-15-implementation-plans-review.md`（§16–§18 计划层闭环 0 Critical / 0 Important / 0 Minor）
- 环境：macOS darwin 27.0.0 / arm64；验收进程 Node v22.23.2；Electron 44.0.0；桌面 0.1.8；DSH 0.2.1-rc.1；harness pin `1600d8a1e140dcde43a1a0941940a0480712c011`；zstd 1.5.7

## 0. 状态声明

- 规格 §14.2 / 计划 Task 5 Step 7 的七项 agent 真机走查自动化测试**已实际执行**：工作区构建 Electron（`lib/main.js`）、隔离临时 `DSH_HOME` + `--user-data-dir` + `--remote-debugging-port` + `HUAANWORK_ACCEPTANCE_HOOKS=1`；模型配置从本机 `~/.huaanwork/profiles/desktop/huaanwork-settings.json` 只读复制（`api_key` 未打印、未入库），隔离根退出时删除。
- **最终结果：exit `3`（BLOCKED），7 项中 5 项通过。** 失败项不是脚本缺失，而是实机暴露的产品行为（§5）；按计划 fail-closed 记录 BLOCKED 原因，不声称 PASS。
- 单元测试、类型检查与根门禁（§1）均已通过，但它们**不替代** §3/§4 的真机结论。

## 1. 自动化门禁（实际执行）

| 命令 | 执行方 | 退出码 | 结果 |
| --- | --- | --- | --- |
| `node --test dsh-plugin-huaanwork/scripts/huaanwork-host-progress-sidebar-acceptance.spec.mjs` | 控制器 | 0 | 16/16 pass（判据纯函数：header schema 提取、三阶段对比、身份链、Host 重启接力、单次取消） |
| `corepack yarn workspace dsh-plugin-huaanwork vitest run tests/client-huaanwork/progressPanel.spec.ts tests/client-huaanwork/ProgressPanelComponent.spec.ts` | 控制器 | 0 | 30/30 pass |
| `corepack yarn workspace @huaanwork/policy check` | 控制器 | 0 | 65 pass / 2 skipped |
| `corepack yarn workspace dsh-plugin-huaanwork run verify:host` | 控制器 | 0 | 51/51 pass（含新增 16 条走查判据） |
| `corepack yarn check` | 控制器 | 0 | 桌面包 `4356 passed / 15 skipped`；`verify:profile-boot` 通过；`agent-catalog` 303、`market-server` 244、`update-server` 88、`agent-catalog-server` 112 全通过；无 `verify:aa` 并发竞争 |

## 2. 提交链

| 提交 | 内容 |
| --- | --- |
| `4612515a62` | 共享回合锚点 store 与 UUID 发送/宿主接线（Task 1） |
| `cfef58bc8b` | `subagent` 默认隐藏、包血缘附件与系统技能租约、`tools/execute` ALS（Task 2） |
| `0a563f7af7` | `system-skill` 运行进入 registry、共享清理 helper 与严格停止仲裁（Task 3） |
| `18efa846d7` | todo 实时归属与历史待办投影、R-12 闭环（Task 4） |
| `a7d1d12857` | ProgressPanel 选择器、组件与右栏接线（Task 5A） |
| `4bc0f47358` | 右栏窄列子 agent 卡样式作用域修复（Task 5A fix） |
| 本文件所在提交 | 走查脚本、判据单测与本文档（Task 5B） |

## 3. 走查命令与退出码

```bash
corepack yarn workspace dsh-plugin-huaanwork build
corepack yarn workspace dsh-plugin-huaanwork exec node scripts/huaanwork-accept-progress-sidebar.mjs --out /tmp/progress-sidebar-accept-final
# exit 3 (BLOCKED)
```

脚本返回码约定：`0` PASS / `1` FAIL / `3` BLOCKED。截图、DOM 快照与事实 JSON 备份在仓库外（§6），仓库仅提交脚本、判据单测与本脱敏文档。

## 4. 七项结果（最终全量运行，facts 摘要）

| # | 场景 | 判据 | 结果 |
| --- | --- | --- | --- |
| 1 | 复杂任务进度 | 4 个 Task、顶部 `已完成 4/4`、当前项高亮、主流待办卡唯一、日志含 4 次 `todo_write` | ✅ |
| 2 | 活动无虚构百分比 | 无百分比文本/进度条、计数保持 `X/Y`、右栏活动工具名 ⊆ 当前回合会话工具名（`bash` ⊆ `bash,grep,read`，无外来名） | ✅ |
| 3 | 普通父会话不可自主派发 | 普通回合 `request/header` 22 个工具无 `subagent`；显式 `@typo-check` 卡出现且定向取消收敛 | ✅ |
| 4 | explore/test-fix 双入口双技能 | 模型 `skill` 入口不可构造（§5 F1）；显式 `/explore` 卡与取消通过；`/test-fix` 派生运行失败（§5 F2） | ❌（F1+F2） |
| 5 | 包 lane 深度 2 | 外层包运行 `completed`；身份链 1 个 child（depth 1）+ 2 条 lane（depth 2）；两条 lane 收尾文本 400/398、settlement 均送达；右栏无独立 lane 行，仅外层聚合摘要 | ✅ |
| 6 | 切换/重连/历史/Host 重启 | 新标签空任务；切回 4 tasks；重载历史 4 tasks；断连/重连横幅出现；Host 重启 old pid 96244 → new pid 97516、renderer 文档同一 canary、2 张 stale 卡呈现 `状态不可恢复 · Host 已重启，结果未确认`、终止禁用、耗时冻结 | ✅ |
| 7 | 兄弟并发与单次取消隔离 | 最终全量运行中，先序场景的子运行结束后，同一稳定会话的两次系统技能派发产生 0 个受管运行（§5 F2），无法构造取消窗口 | ❌（F2） |

补充（调试证据，非发布证据）：在**全新稳定会话**中单独运行 `--only tasks,siblings` 时，该场景通过——两个并发 `system-skill` explore 运行、一次两步确认终止发送 1 条命中目标 `runId` 的 `subagent.cancel`、目标 `stopped`、兄弟 `completed`、卡片唯一。该对照把最终运行的失败定位到“会话已有子运行结束”这一条件，而不是取消控件或脚本流程。

## 5. 产品级发现（待 owner 裁定）

### F1：模型面 `skill` 工具未在 shipped profile 暴露（BLOCKED 的 fail-closed 原因）

- 隔离运行中，父会话 `request/header` 工具 schema 共 22 个（`bash`、`read`、`edit`、`write`、`todo_write`、`subagent` 等），**无 `skill`**；`huaanwork-accept-progress-sidebar.mjs` 据此把 `model-skill` 入口记为不可构造并 exit 3。
- 本机近期生产会话日志同样未出现 `skill` 工具（抽查多份 `session.v4.jsonl.zstd` 的 `request/header` 并集均无 `skill`）。
- 影响：规格 R2 / §7.2 的“模型调用 `skill` 工具”入口在当前产品组合下不可达；显式 `/explore`、`/test-fix` 入口不受影响。需要 owner 决定是补齐 profile 的工具装载，还是调整规格把模型入口标记为暂不可用。

### F2：子运行结束后，同会话后续模型面 `subagent` 派发失败

- 复现矩阵（均为真实 Electron + 真实模型）：
  - 全新会话中两个并发系统技能派发：均启动成功（§4 补充）；
  - 同一会话中第一个子运行结束/被取消后的下一次 `subagent` 工具调用：子会话被创建（`origin: subagent`、`delegationDepth: 1`、提示已注入 `agent/inbox/spliced`），但**没有 `turn/start`**；工具结果为 `Error: cannot create effect on inactive context`；
  - 临时关闭 explore 的轨道取消后仍复现，因此不是取消控件触发；
  - 最终全量运行中，先序场景（`@typo-check`、包 lane）的子运行结束后，`single-cancel-isolation` 的两条系统技能派发直接产生 0 个受管运行。
- 直接后果：`/test-fix` 派生的 `system-skill` 运行卡在 00:00 变为 `失败 · 执行出错`，无法执行定向终止；规格 §7.3 / §14.2 第 4、7 项的 `test-fix` 纳管与单次取消断言不成立。Host 显式 `@` 派发不受影响（场景 6 的 `@code-review` 正常运行）。
- 建议：由 owner 裁定缺陷归属与修复任务（上游 subagent provider 的上下文生命周期，或本计划 Task 2/3 包装与释放路径的相互作用）。修复后重跑本脚本应可把场景 4/7 转为通过，并把最终退出码从 `3` 变为 `0`（若 F1 同时裁定补齐）。

## 6. 证据备份与清理

- 截图、DOM 失败快照、`facts.json` 与 `walkthrough.log` 备份：`~/huaanwork-progress-sidebar-accept-evidence-2026-11-18/`（仓库外；不含密钥）。
- 隔离临时根（含只读复制的模型配置与会话日志）在运行结束时删除（`facts.isolatedCleanup = removed`）；调试期间的 `--only` 隔离根均已手工删除。
- 仓库未提交截图、fixture 或任何含密钥临时目录。

## 7. 结论

- 七项真机走查自动化脚本已落地、可重复执行，判据单测纳入 `verify:host`；场景 1/2/3/5/6 在最终全量运行中通过。
- 场景 4/7 暴露出 F1/F2 两项产品级问题，最终运行按规则记录为 `BLOCKED`（exit 3），未以单测或门禁通过替代真机结论。
- 后续：F1/F2 的修复或裁定落地后，重跑 `huaanwork-accept-progress-sidebar.mjs`；通过时以 exit 0 的完整 facts 替换本节结论并更新本文件。
