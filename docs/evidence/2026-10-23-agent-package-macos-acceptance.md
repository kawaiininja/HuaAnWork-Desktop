# 智能体包 M1 macOS 交互验收（2026-10-23）

- 环境：macOS 26（darwin arm64），HuaAnWork 当前分支构建（Electron 44），独立 userData 副本；Host profile 使用真实
  `~/.huaanwork/profiles/desktop` 的模型与公用机配置，验收结束后已恢复默认模型 `deepseek-flash`。
- 模型：完整交互链路使用 `deepseek-chat`；修复工具名白名单后，用默认 `deepseek-flash` 复测到
  `agent_propose` 批准框（见“默认模型复测”）。
- 结论：**核心链路 PASS，M1 仍未完成**。创建/确认/提交/启用/`@` 运行/更新/重启持久化/关闭/详情均已在真实
  macOS 应用与真实模型上验证；验收过程中发现并修复 5 个真实接线缺陷 + 1 个验收修复引入的回归。HTTP/MCP
  实机运行、catalog-legacy 实机运行与 Windows 真机仍未验收。

## 1. 通过项

| 步骤 | 结果 |
|---|---|
| 创建入口与访谈 | 说“帮我新建一个智能体”进入 grill-me 访谈；模型逐问确认用途、显示名/@、简介、人设、技能包、工具 |
| 结构化确认卡 | 宿主卡片渲染名称/slug/简介/人设/技能/工具与固定沙箱提示；无“创建”按钮 |
| 同意与提交 | 回复“可以”→ `agent_commit`（smart 模式需批准）→ 包落盘；新建默认关闭，版本 `1.0.0` |
| 我的智能体 | 三页签为 `智能体广场 / 我的智能体 / 我的工具包`；本地卡片显示“本地创建”、`v1.0.0`、`@weekly-report`、启用/关闭、更新提示 |
| 启用 | 启用后 `agents-state.json` 为 `enabled:true`；按钮变为“关闭” |
| `@` 运行 | `@weekly-report` 启动子代理；返回结构化周报；回合结束子进程停止 |
| 更新 | `/create-agent update weekly-report` → 确认卡标题为“更新”，提示“启用状态保持不变，版本号 patch+1”；提交后 `version:1.0.1`、`enabled:true` 保留 |
| 重启持久化 | 重启应用后卡片仍为 `v1.0.1`，启用态保留 |
| 关闭 | 关闭后 `enabled:false`，按钮恢复“启用” |
| 详情 | 显示人设/技能/工具/文件清单与固定提示“脚本在本机沙箱中运行；沙箱只限制写，读取文件和网络不受限制。” |
| catalog-legacy 空态/错误 | 公用机目录不可达时广场显示错误横幅与空态，不崩溃 |

## 2. 验收中发现并修复的缺陷

| # | 现象 | 根因 | 修复 |
|---|---|---|---|
| 1 | 模型只输出思考，`NO_ACTION`/`EMPTY_RESPONSE`，`agent_propose` 不执行 | 自定义模型适配器 `isRegisteredToolName` 未放行 `agent_propose`/`agent_commit`/`agent_skill_run`/`agent_http`，tool call 被静默过滤 | 白名单补齐四个名字并加测试（`e3dc7eb7d1`） |
| 2 | 启用本地智能体报 `agent.packageSetEnabled requires object body` | `client-huaanwork/api.ts` 把该 POST 写成裸 `{http,path}`，没有 `post()` 的 body 函数，`rpcCall` 不发请求体 | 改用 `post()` 并加 body 形状测试（`d2ffc658f1`） |
| 3 | `@weekly-report` 报 `current dsh runtime does not support subagents` | Host 直接读 `ctx.subagents`；服务实际通过 `ctx.get('subagents')` 暴露 | 增加 direct/get 回落解析（`baae21a24b`） |
| 4 | 同上，回落仍失败 | rc.1 `SubagentRuntime` 只有 `startActivation(spec)`，没有 `start(provider, request)`；且 activation spec 无 `persona` 字段 | 包运行迁移到 `startActivation`：`provider:'spawn'`、live parent、label、signal、`delivery:'parent'`；persona 以分隔前缀注入子代理 prompt（`00e730c623`） |
| 5 | 验收修复后全量测试 3 个失败：guardrail lock 层不连续 | 不必要的 `subagent`/`subagent-spawn-in-process` 复挂插断了 lock 层；服务本已激活 | 回退该复挂（`36abfbc905`）；保留 startActivation 迁移 |

> 说明：`agent_commit` 成功后模型又重复调用一次已卸载的 `agent_commit`，返回 `unknown tool`，模型据此误报“提交失败”；
> 实际上包已成功写入（文件与 state 均存在）。这是模型侧后续消息的误导，宿主事件与落盘正确。作为 UX 观察项记录。

## 3. 落盘证据（验收时）

```text
agents/weekly-report/agent.json
  schemaVersion: 1, slug: weekly-report, version: 1.0.0 -> 1.0.1,
  tools: { mode: "none" }, skill: null, allowSkills: []
agents-state.json
  local:weekly-report { source: "local", enabled: false -> true -> false, installedVersion: "1.0.0" -> "1.0.1" }
```

## 4. 默认模型复测

修复 #1 后，用默认 `deepseek-flash` 在隔离 profile 中重新发送创建指令，模型正确发出 `agent_propose` 并出现
批准框；此前同一模型的失败确系工具名过滤，不是模型不支持工具调用。该次提案被拒绝，测试草稿已清理。

## 5. 未验收 / 阻断

- **HTTP/MCP 实机运行**：本轮只验证了 `tools:none` 的包；HTTP/MCP 进程、`agent_http`、MCP 空工具等由自动化测试与
  Task 1 沙箱探针覆盖，未在真实 UI 中跑“带 HTTP 的 fixture 智能体”。
- **catalog-legacy 实机运行**：公用机目录 `10.130.209.76:18080` 在验收时超时，广场显示目录错误；legacy 兼容由
  `agent-package-legacy.spec.ts` 覆盖，未做真实目录实机验收。
- **Windows 真机**：无 Windows 机器，Task 1/9 仍为 BLOCKED。
- **完整 headless 门禁**：验收修复后已跑 `dsh-plugin-huaanwork` 全量（3127 passed / 14 skipped）、typecheck
  （0）、`check:desktop-variants`（0）；根 `corepack yarn check` 未在最终树重跑（此前在最终评审前为绿）。
- **M1 完成声明**：不作出。上述实机项与 Windows 未完成。

## 6. 清理

验收产生的测试智能体、`agents-state.json`、测试会话与任务条目已清理/隔离到
`/tmp/huaanwork-accept-quarantine/sessions/`；真实 profile 的模型已恢复为 `deepseek-flash`。隔离副本
`/tmp/huaanwork-accept-*` 为临时数据，可删除。
