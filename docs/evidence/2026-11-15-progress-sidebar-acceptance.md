# 复杂任务与子 agent 右侧进度面板 — 实施证据（2026-11-17 ~ 2026-11-18）

- 分支：`feat/progress-sidebar`（基线 `3dd3b182bc8c28671d5f712a7ae2da23dab463bd`）
- 规格：`docs/superpowers/specs/2026-11-15-task-progress-sidebar-design.md`
- 计划：`docs/superpowers/plans/2026-11-15-progress-sidebar.md`
- 评审：`docs/superpowers/plans/2026-11-15-implementation-plans-review.md`（§16–§18 计划层闭环 0 Critical / 0 Important / 0 Minor）
- 环境：macOS darwin 27.0.0 / arm64；验收进程 Node v22.23.2；Electron 44.0.0；桌面 0.1.8；DSH 0.2.1-rc.1；harness pin `1600d8a1e140dcde43a1a0941940a0480712c011`；zstd 1.5.7

## 0. 状态声明

- 规格 §14.2 / 计划 Task 5 Step 7 的七项 agent 真机走查自动化测试**已实际执行**：工作区构建 Electron（`lib/main.js`）、隔离临时 `DSH_HOME` + `--user-data-dir` + `--remote-debugging-port` + `HUAANWORK_ACCEPTANCE_HOOKS=1`；模型配置从本机 `~/.huaanwork/profiles/desktop/huaanwork-settings.json` 只读复制（`api_key` 未打印、未入库），隔离根退出时删除。
- **最终结果：exit `0`（PASS），7/7 通过。** 之前的 F1/F2 阻断已修复并复跑通过，见 §2/§5；验收用的模型条目在隔离 profile 中固定为 `deepseek-chat`（§2 说明）。
- 单元测试、类型检查与根门禁（§1）均通过，且与真机结果一致。

## 1. 自动化门禁（实际执行）

| 命令 | 执行方 | 退出码 | 结果 |
| --- | --- | --- | --- |
| `node --test dsh-plugin-huaanwork/scripts/huaanwork-host-progress-sidebar-acceptance.spec.mjs` | 控制器 | 0 | 18/18 pass |
| `corepack yarn workspace dsh-plugin-huaanwork vitest run tests/huaanwork-guardrails/skills.spec.ts tests/huaanwork-guardrails/present-as.cordis.spec.ts tests/profile.spec.ts tests/huaanwork-guardrails/bridge.spec.ts tests/huaanwork-guardrails/package-subagent-lineage.spec.ts tests/huaanwork-host/agent-package-runtime.spec.ts tests/huaanwork-guardrails/policy.cordis.spec.ts tests/market-composition-order.spec.ts tests/huaanwork-host/test-port-mapping.spec.ts` | 控制器 | 0 | 298/298 pass |
| `corepack yarn workspace dsh-plugin-huaanwork typecheck` | 控制器 | 0 | 无输出 |
| `corepack yarn workspace @huaanwork/policy check` | 控制器 | 0 | 65 pass / 2 skipped |
| `corepack yarn workspace dsh-plugin-huaanwork run verify:host` | 控制器 | 0 | 53/53 pass |
| `corepack yarn check` | 控制器 | 0 | 桌面包全量通过；`verify:profile-boot` 通过；其余 workspace 全通过 |

## 2. 本次修复（对应 F1/F2）

1. **F1（模型入口）**：`profile.ts` 为不走 preset 的桌面父会话显式启用宿主平面 `skill-filesystem` / `tool-skill`，`agentsHome` 仍指向空目录；`present-as.ts` 仅对无人值守自动化与 legacy/system-skill 儿童隐藏 `skill`，普通父会话可用。
2. **F2（顺序派发失败）**：`skills.ts` 在 `agent/disposed` 时从 `tracked`/`kinds`/`lifted` 移除已释放子代理，并对 `cannot create effect on inactive context` 竞态兜底；`holders.ts` 在创建 `huaanworkSystemSkillLeases` 后调用 `huaanworkRegisterSystemSkillLeaseInvalidation`，修复「租约 store 晚于 skills apply 创建时 `onInvalidate` 未注册」导致的旧技能类型残留。
3. **走查可靠性**：双入口场景使用第一个系统技能回合作为执行窗口起点（避免把上一系统技能回合误当普通回合），并增加一次显式 `subagent` 重试；隔离 profile 的活跃模型固定为 `deepseek-chat`（`deepseek-flash` 会自述没有 `subagent`，实测不可靠）。
4. **组合顺序与 smoke 兼容**：`skill-filesystem`/`tool-skill` 放在 `llm-deepseek` 锁层锚点之前，保持 guardrail 锁层连续；`test-port-mapping.ts` 的证据行号同步到新增测试后的真实行号；`huaanwork-stub-llm.mjs` 的 `/ls/` 匹配收紧为 `/\bls\b/`，避免把 `skills`/`tools` 误判为 `ls` 命令。

## 3. 走查命令与退出码

```bash
corepack yarn workspace dsh-plugin-huaanwork build
corepack yarn workspace dsh-plugin-huaanwork exec node scripts/huaanwork-accept-progress-sidebar.mjs --out /tmp/progress-sidebar-accept-final
# exit 0 (PASS)
```

脚本返回码约定：`0` PASS / `1` FAIL / `3` BLOCKED。截图、DOM 快照与事实 JSON 备份在仓库外（§6），仓库仅提交脚本、判据单测与本脱敏文档。

## 4. 七项结果（最终全量运行，facts 摘要）

| # | 场景 | 判据 | 结果 |
| --- | --- | --- | --- |
| 1 | 复杂任务进度 | 4 个 Task、顶部 `已完成 4/4`、当前项高亮、主流待办卡唯一、日志含 `todo_write` | ✅ |
| 2 | 活动无虚构百分比 | 无百分比文本/进度条、计数保持 `X/Y`、右栏活动工具名 ⊆ 当前回合会话工具名（`bash,write` ⊆ `bash,read,write`），最新非 todo 轮次 `bash` 已呈现 | ✅ |
| 3 | 普通父会话不可自主派发 | 普通回合 `request/header` 无 `subagent`；显式 `@typo-check` 卡出现且定向取消收敛 | ✅ |
| 4 | explore/test-fix 双入口双技能 | 模型 `skill` 入口与显式 `/explore`、`/test-fix` 均产生 `system-skill` 运行卡；显式 `/explore` 与 `/test-fix` 定向取消收敛；三阶段 `request/header` 中 `subagent` 仅在执行期出现并收回 | ✅ |
| 5 | 包 lane 深度 2 | 外层包运行 `completed`；身份链 1 个 child（depth 1）+ 2 条 lane（depth 2）；两条 lane 收尾文本非空、settlement 均送达；右栏无独立 lane 行，仅外层聚合摘要 | ✅ |
| 6 | 切换/重连/历史/Host 重启 | 新标签空任务；切回 4 tasks；同会话新普通回合 0 tasks（上一回合 todo 未冒充）；重载历史 4 tasks；断连/重连横幅出现；Host 重启旧 pid 63729 → 新 pid 65838、renderer 文档同一 canary、2 张 stale 卡呈现 `状态不可恢复 · Host 已重启，结果未确认`、终止禁用、耗时冻结 | ✅ |
| 7 | 兄弟并发与单次取消隔离 | 两个并发 `system-skill` explore 运行；两步确认只发送 1 条命中目标 `runId` 的 `subagent.cancel`；目标 `stopped`、兄弟 `completed`、settlement 送达；主流工具卡唯一（4 个 panel id 无重复） | ✅ |

### 4.1 证据摘录（最终全量运行）

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
  "targetRunId": "d9637d45-f70f-4b41-9735-65e86e2585d3",
  "cancelRpc": { "cancelRequestCount": 1, "targetRunIdCount": 1, "otherRunIdCount": 0,
                 "runIds": ["d9637d45-f70f-4b41-9735-65e86e2585d3"] },
  "cancelConverged": true, "siblingCompleted": true, "siblingSettlementSeen": true,
  "mainToolPanelsUnique": true, "mainToolPanelCount": 4
}
```

**Host 重启接力（场景 6）**

```json
{ "oldPid": 63729, "newPid": 65838, "sameDocument": true, "staleCardCount": 2, "asserted": true }
```

**双入口 entries（场景 4）**

```json
[
  { "entry": "model-skill", "skill": "explore", "runSeenInMain": true, "runSeenInRail": true },
  { "entry": "explicit-slash", "skill": "explore", "runSeenInMain": true, "runSeenInRail": true, "cancelled": true },
  { "entry": "explicit-slash", "skill": "test-fix", "runSeenInMain": true, "runSeenInRail": true, "cancelled": true }
]
```

## 5. F1/F2 闭环说明

- **F1**：原因为桌面父会话不走 preset，宿主平面 `tool-skill` 被 web-app overlay 关闭，导致 `request/header` 从不声明 `skill`。方案 B 已实施，模型入口可用。
- **F2**：`skills.ts` 的 `tracked` 集合在子代理释放后未清理，后续 `tools/change` 对已 DISPOSED 子代理重复 `tools.restrict`，抛出 `cannot create effect on inactive context`；同时 `onInvalidate` 因租约 store 创建晚于 `applySkills` 而未注册，导致显式 `/test-fix` 仍沿用 `explore`。两处均已修复，顺序派发与显式双技能恢复正常。
- `AGENTS.md` 中 F1/F2 的活跃债行已随本次修复移除；本文件保留为闭环证据。

## 6. 证据备份与清理

- 截图、DOM 失败快照、`facts.json` 与 `walkthrough.log` 备份：`~/huaanwork-progress-sidebar-accept-evidence-2026-11-18/`（仓库外；不含密钥）。
- 隔离临时根（含只读复制的模型配置与会话日志）在运行结束时删除（`facts.isolatedCleanup = removed`）；调试期间的 `--only` 隔离根均已手工删除。
- 仓库未提交截图、fixture 或任何含密钥临时目录。

## 7. 结论

- 七项真机走查自动化脚本与判据单测已落地并纳入 `verify:host`；最终全量运行 7/7 通过。
- F1/F2 已修复并闭环，未以单测或门禁通过替代真机结论。
