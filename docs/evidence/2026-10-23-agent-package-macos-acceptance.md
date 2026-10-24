# 智能体包 M1 macOS 交互验收（2026-10-23）

- 环境：macOS 26（darwin arm64），HuaAnWork 当前分支构建（Electron 44），独立 userData 副本；Host profile 使用真实
  `~/.huaanwork/profiles/desktop` 的模型与公用机配置，验收结束后已恢复默认模型 `deepseek-flash`。
- 模型：完整交互链路使用 `deepseek-chat`；修复工具名白名单后，用默认 `deepseek-flash` 复测到
  `agent_propose` 批准框（见“默认模型复测”）。
- 结论：**核心链路 PASS，M1 仍未完成**。创建/确认/提交/启用/`@` 运行/更新/重启持久化/关闭/详情均已在真实
  macOS 应用与真实模型上验证；验收过程中发现并修复 9 个真实接线缺陷 + 1 个验收修复引入的回归，随后 HTTP、
  MCP、catalog-legacy（本地 fixture）与 legacy `@agent` 实机均通过（§7、§8）。真实内网 catalog 与 Windows
  真机仍未验收。
- **2026-10-24 裁定**：本文件的代理驱动实机验收作为 Task 9 Step 4 的 macOS 证据；真人交互复核列为
  可选/独立项。同日后续裁定把 Windows Step 5 改为 GHA 无界面探针（`PASS（GHA Windows 探针）`），GUI 与真实模型为可选项；见 `docs/huaanwork-agent-packages-m1.md` §11。上文「Windows 真机仍未验收」是这次 macOS 会话当时的范围。

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
| HTTP/MCP 实机 | `http-echo` 的 `agent_http` 返回 `{"echo":{"hello":"world"},"at":"http-echo"}`；`mcp-echo` 的子会话调用 `mcp__mcp-echo__echo` 返回 `{"hello":"mcp"}`（§7） |

## 2. 验收中发现并修复的缺陷

| # | 现象 | 根因 | 修复 |
|---|---|---|---|
| 1 | 模型只输出思考，`NO_ACTION`/`EMPTY_RESPONSE`，`agent_propose` 不执行 | 自定义模型适配器 `isRegisteredToolName` 未放行 `agent_propose`/`agent_commit`/`agent_skill_run`/`agent_http`，tool call 被静默过滤 | 白名单补齐四个名字并加测试（`e3dc7eb7d1`） |
| 2 | 启用本地智能体报 `agent.packageSetEnabled requires object body` | `client-huaanwork/api.ts` 把该 POST 写成裸 `{http,path}`，没有 `post()` 的 body 函数，`rpcCall` 不发请求体 | 改用 `post()` 并加 body 形状测试（`d2ffc658f1`） |
| 3 | `@weekly-report` 报 `current dsh runtime does not support subagents` | Host 直接读 `ctx.subagents`；服务实际通过 `ctx.get('subagents')` 暴露 | 增加 direct/get 回落解析（`baae21a24b`） |
| 4 | 同上，回落仍失败 | rc.1 `SubagentRuntime` 只有 `startActivation(spec)`，没有 `start(provider, request)`；且 activation spec 无 `persona` 字段 | 包运行迁移到 `startActivation`：`provider:'spawn'`、live parent、label、signal、`delivery:'parent'`；persona 以分隔前缀注入子代理 prompt（`00e730c623`） |
| 5 | 验收修复后全量测试 3 个失败：guardrail lock 层不连续 | 不必要的 `subagent`/`subagent-spawn-in-process` 复挂插断了 lock 层；服务本已激活 | 回退该复挂（`36abfbc905`）；保留 startActivation 迁移 |
| 6 | legacy `@agent` 在 rc.1 上报 `current dsh runtime does not support subagents` | 仍调用 rc.1 已删除的 `start`；persona 是旧原生字段 | 迁移到 `startActivation`，persona 接入首条 prompt，子会话 allow 限制（`7da171dd62`） |

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

- **真实内网 catalog**：公用机目录 `10.130.209.76:18080` 在验收时仍超时。改用本地 fixture catalog
  （127.0.0.1:18080，`legacy-assistant`）完成 catalog-legacy 实机（§8）；真实内网目录的 payload/认证仍需在有网时补验。
- **legacy `@agent` 残余**：已迁移到 `startActivation` 并在本地 fixture catalog 上通过（§8）：`@legacy-assistant`
  启动子会话，收到 persona 前缀并返回四段周报。残余：子会话**首轮**工具清单仍可能先拿到完整工具集（wrapper 的
  allow restrict 在 activation 之后），与包路径的预留 childId 预挂载不同；当前不影响运行与 persona 注入，记为
  后续硬化项。legacy 分支不挂智能体包工具或注册表。
- **子代理清理上限 10 分钟**：`afterIdle` 等子会话落定的上限是 `600_000` ms。父回合的 `whenIdle` 可能先于长子会话
  到达（HTTP/MCP 回合本来就会跑过父回合空闲点），原 10 s 会把仍在工作的子代理截断。超时后宿主记一条错误、释放
  activation（发布后的取消归 `dispose()`，不再 abort 发布前 signal）并照常停止子进程；`agent-package-tools.spec.ts`
  用假定时器钉住 599,999 ms 内仍在等待、600,000 ms 触发清理。
- **Windows**：2026-10-23 本次 macOS 验收没有 Windows 机器，当时记为 BLOCKED。2026-10-24 后续裁定把 Step 5 改为 GitHub Actions 无界面探针，口径为 `PASS（GHA Windows 探针）`；GUI 与真实模型交互为可选项。见 `docs/huaanwork-agent-packages-m1.md` §11 与 `docs/evidence/2026-10-24-agent-package-windows-gha-acceptance.md`。macOS Task 9 Step 4 已按同日裁定收口。
- **完整 headless 门禁**：验收修复后已跑 `dsh-plugin-huaanwork` 全量（3150 passed / 14 skipped）、typecheck
  （0）、`check:desktop-variants`（0）；根 `corepack yarn check` 未在最终树重跑（此前在最终评审前为绿）。
- **M1 完成声明**：macOS Task 9 Step 4 已按 2026-10-24 裁定收口。Windows Step 5 的验收面随后改为 GHA 探针（见上一条）；真实内网 catalog 的 payload/认证在本文件记录时仍未验收。本文件不引用 Windows workflow run URL。

## 6. 清理

验收产生的测试智能体、`agents-state.json`、测试会话与任务条目已清理/隔离到
`/tmp/huaanwork-accept-quarantine/sessions/`；真实 profile 的模型已恢复为 `deepseek-flash`。隔离副本
`/tmp/huaanwork-accept-*` 为临时数据，可删除。

## 7. HTTP/MCP 实机补充（2026-10-23 晚）

### HTTP 实机（PASS）

创建 `http-echo`（`tools.mode: "http"`，`tools/http/server.mjs` 回显 `{arguments}`）→ 启用 → 输入
`@http-echo 请回显 {"hello":"world"}。调用 agent_http，arguments 传 {"hello":"world"}。`；子代理实际调用
`agent_http`，返回：

```json
{"echo":{"hello":"world"},"at":"http-echo"}
```

宿主 `@` 回合在真实 UI 中显示该结果。HTTP 进程在回合结束后停止。

### MCP 实机（PASS，含 UX 观察）

创建 `mcp-echo`（`tools.mode: "mcp"`，fixture streamable-HTTP server，`echo` 工具）→ 启用 → 在单标签会话中
发送 `@mcp-echo`。子会话实际调用：

```text
tool/call mcp__mcp-echo__echo {"hello":"mcp"}
tool/result {"hello":"mcp"}
```

MCP server 由运行时拉起到 `127.0.0.1:53182`，子会话拿到回显 `{"hello":"mcp"}`，回合正常结束。UI 中父会话
显示了该结果，但父模型同时用 bash/curl 自查了一遍（父会话本来就不持有包子会话的 MCP 工具），所以文案较啰嗦；
这是 UX/模型行为观察，不影响“MCP 工具调用成功”的结论。

归因补充：本次通过的运行使用单标签会话，MCP server 的 `cwd` 为
`~/.huaanwork/profiles/desktop/workspace`，对应子会话目录
`--Users-amonmiao-.huaanwork-profiles-desktop-workspace--`，二者一致；此前“项目/标签不匹配”的现象未复现，
仍按操作导航观察记录（未确认为产品路由缺陷）。

复现注记：新开单标签应用会话，直接在同一个标签完成创建/启用/`@`，不要中途切换项目或标签；MCP server 的
`cwd` 应与该会话的 Host workspace 一致。

### HTTP/MCP 验收新增修复

| 现象 | 根因 | 修复 |
|---|---|---|
| 子代理首轮请求看不到 `agent_http`，直接判定“没有工具” | 子会话首轮模型请求早于 after-start 的 attachment/restrict | 用预留 `childId` 在 `startActivation` 前预挂包工具（`5e278de464`） |
| 子代理调用 `agent_http` 被策略拒绝（子会话无审批 UI） | attached 运行时工具走 `ask`，auto-deny | `agent_http`/`agent_skill_run` attached 时放行；propose/commit 仍 ask（`6a35263f5c`，注释订正 `06d230584d`） |
| MCP 包子会话同样无法调用 `mcp__*` | attached MCP 在 smart 模式 ask | holder 标记 package child，attached `mcp__*` 对包子会话放行，普通会话行为不变（`ebbdab6f92`） |
| `@mcp-echo` 报 `cannot get property "mcpClientImpl" without inject` | `mountSessionMcp` 直接读 `ctx.mcpClientImpl`，Cordis 未 inject 属性访问抛错 | 改为显式 option → `ctx.get('mcpClientImpl')`（try/catch）→ 默认客户端（`2152580e36`） |
| `@mcp-echo` 报 `cannot get property "tools" without inject` | `mountSessionMcp` 直接读 `ctx.tools?.schemas`，Host 上下文未 inject tools | 改为 direct（try/catch）→ `ctx.get('tools')` 解析（`01a3d2771c`） |

### 更新后的门禁

`dsh-plugin-huaanwork` 全量 **3150 passed / 14 skipped**；typecheck 0；`check:desktop-variants` 0（7/64，前缀 6）。
根 `corepack yarn check` 仍未在最终树重跑。

### 仍未完成

- 真实内网 catalog 实机（`10.130.209.76:18080` 仍不可达；本地 fixture 已通过，见 §8）
- Windows 真机
- 根 `check` 最终树复跑

legacy `@agent` 已迁移并在本地 fixture catalog 上通过（§8）；残余“子会话首轮工具清单未受 allow 限制”记入 §5/债务表。

测试包 `http-echo`/`mcp-echo`、`agents-state.json`、测试会话与任务条目已清理/隔离；MCP/HTTP 测试进程已停止。

## 8. catalog-legacy 与 legacy `@agent` 实机（本地 fixture）

真实内网 `10.130.209.76:18080` 在验收时仍超时，因此使用本地 fixture catalog（127.0.0.1:18080）走真实 UI：

- `GET /v1/catalog` 返回 `legacy-assistant`（`kind:"agent"`，`permissions:["read"]`）；
- `GET /v1/catalog/legacy-assistant` 返回 persona 与 `allow:["read","grep"]`；
- 广场显示「公用机 / v1.0.0 / @legacy-assistant」；启用时弹出权限确认（read）；确认后
  `agents-enabled.json` 写入 `catalog:legacy-assistant: true`；
- 「我的智能体」显示卡片「旧目录智能体」；未创建 `agents/legacy-assistant/`；
- `@legacy-assistant 请把本周工作整理成周报：完成 M1 实现、修复验收缺陷、准备周会。` 启动子会话；子会话首条
  user message 为旧目录 persona + 用户请求，最终返回「本周进展 / 关键结果 / 问题与风险 / 下周计划」四段周报；
- 关闭后 `agents-enabled.json` 删除 `catalog:legacy-assistant`，保留原有 3 个用户条目。

结论：catalog-legacy 的列表/启用/关闭/未物化与 legacy `@agent` 的 rc.1 运行通过。残余：legacy 子会话**首轮**
工具清单仍可能先拿到完整工具集（wrapper 的 allow restrict 在 activation 之后）；不影响 persona 注入与运行，
记为后续硬化项；真实内网 catalog 的认证/payload 仍需有网时补验。测试 fixture 会话已隔离，profile 的
`agents_host`/`agents_port` 已恢复为 `10.130.209.76:18080`。

### 最终代码复跑（并发归属修复后）

并发归属修复 `1e8389be9a` 后，在最终构建上再次用本地 fixture catalog 复跑 `@legacy-assistant`：子会话仍收到
persona 前缀并返回周报，legacy 路径通过。实机中该回合的**父会话**写入了 workspace 的 `周报_2026W43.md`；父会话本就拥有完整工具集，这次写不能单独归因于
子会话的首轮 allow 残余。文件已用会话日志中写入前的 `read` 原文恢复（2630 bytes / 48 lines，
sha256 `0f38c2e061f0bdb0c832f90d7a93dec659eb0e048339af2c4a404a886de310c2`）。子会话首轮工具清单未受限的证据是
子会话请求头的完整 TOOLS 列表（见 §5 与复跑日志），该写只是同一回合的父会话行为。

最终门禁：`dsh-plugin-huaanwork` 3150 passed / 14 skipped；typecheck 0；`check:desktop-variants` 0；whitespace 0。
