# 在会话里创建华安数字员工

- 日期：2026-10-22
- 状态：待用户审阅规格
- 范围：华安工作台（`dsh-plugin-huaanwork`）的会话创建流程、本机员工目录、侧栏「我的员工」，以及 `@` 与「以此身份开新会话」两种调用。包含专属技能包，以及按员工选择的本机 HTTP 工具和会话级 MCP。
- 不改：`dsh-plugin-desktop/`、`dsh-plugin-desktop-beta/`、`dsh-desktop-next/`、`deepseek-harness/`、`market-server/`、`dsh-community-market/`。

## 1. 目标

用户在华安工作台的会话里说「帮我新建一个智能体」或「帮我建一个数字员工」时，当前会话进入创建流程。技能一次问清一件事。用户在确认单上同意之后，宿主才把这名数字员工写到本机。卡片出现在左侧「智能体」下，显示名称和能力简介，并提供启用、关闭。启用之后可以用 `@标识` 干一轮，也可以以此身份开一条新会话。

| 编号 | 决定 | 行为 |
| --- | --- | --- |
| D1 | 只做华安工作台 | 会话页、智能体侧栏和本规格的技能都在 `dsh-plugin-huaanwork`。Stable 与 Beta 不增加这条流程 |
| D2 | 本地人设 | 员工是本机目录里的一份定义：显示名、能力简介、人设、专属技能包、允许使用的已有技能。不另起长期服务 |
| D3 | 两种调用 | 启用后，`@标识` 在当前会话干一轮；卡片可以开一条绑住人设的顶层新会话 |
| D4 | 可执行工作流 | 每名员工都有专属技能包。工具按员工选择：不要、只 HTTP、只 MCP，或两者都要 |
| D5 | 工具形态 | HTTP 是按次或按会话拉起的本机回环脚本。MCP 是同一约定下的 streamable HTTP，经现有 `mountSessionMcp` 挂上。生成代码以子进程运行 |
| D6 | 确认后写入 | 宿主校验草稿并出示确认单。下一轮的明确同意才落盘。新建为关闭 |
| D7 | 发布另立 | 本规格没有「发布」按钮，不上传公共市场。员工目录是以后整包带走的根 |

## 2. 不在本轮

- 不把员工上传到公共市场，也不在卡片上放发布、编辑、删除。
- 不带私有知识库，不做定时任务。
- 不把生成的脚本加载进桌面进程。
- 不把专属技能包注册进全局技能列表，普通会话不能用 `/` 调用它。
- 不改公用机目录、本地入口，以及现有小工具的启用方式。
- 宿主不理解「帮我做个助手」这类近似说法。强制进入创建流程的只有第 4 节列出的两个说法和 `/create-employee`。

写坏的员工先关闭，再用新的 `@` 标识重建。

## 3. 已核实的现状

| 现状 | 位置 | 对本规格的约束 |
| --- | --- | --- |
| 侧栏「智能体」有发现、已启用、本地入口。卡片有名称、描述、启用或删除 | `AgentsView.tsx` | 「我的员工」是新增页签，不塞进本地入口 |
| 本地入口拒绝 `kind=agent`，原因是本机没有人设来源 | `agents-host.ts` 的 `addEndpoint` | 员工不走 `addEndpoint`。人设来自员工目录里的 `persona.md` |
| `@标识` 在 `kind=agent` 时把 `persona` 交给 `subagents.start("spawn")`，并按 `allow` 限制工具 | `agent-invoke.ts` | `@` 一轮复用这条子代理路径。`@` 名字遵守 `AGENT_NAME_RE` |
| 名称规则是 `/^[a-z0-9]+(?:-[a-z0-9]+)*$/`，本地入口最长 64；MCP 入口名最长 32 | `agents-host.ts`、`agentsLogic.ts` | 员工 `@` 标识最长 32，以便直接作为 MCP `serverName` |
| 描述最长 200，按 JavaScript 字符串 `length` 计 | `agents-host.ts` | 能力简介使用同一上限 |
| MCP 挂载只有 `transport: "streamable-http"` 加 URL，工具名前缀 `mcp__{serverName}__` | `agent-mcp.ts` 的 `mountSessionMcp` | 员工 MCP 由宿主拉起后，以 `http://127.0.0.1:{port}/mcp` 挂上 |
| HTTP 小工具走 `call_host_tool`，默认超时 60 秒，硬顶 150 秒 | `agent-tool.ts` | 员工的 HTTP 工具沿用这顶超时和现有响应体上限 |
| 内置技能缺省不启用。`skill-toggles.json` 缺失或损坏时视为全部关闭。`explore` 与 `test-fix` 例外 | `skills.ts` 的 `readSkillToggles`、`SYSTEM_SKILLS` | `create-employee` 不进 `SYSTEM_SKILLS`。宿主只在缺少这个键时把它写成启用 |
| 显式 `/技能名` 会改写这一轮的提示 | `sessions.ts`、`skill-invoke.ts` | 两个触发说法走同一条技能进入路径 |

## 4. 创建流程

### 4.1 何时进入

去掉首尾空白后，下面三种进入创建流程：

- 整段等于 `/create-employee`，或以 `/create-employee` 加空白开头。
- 以「帮我新建一个智能体」开头。
- 以「帮我建一个数字员工」开头。

这一会话已有未确认草稿时，不另开一份，后面的话继续改这份草稿。开头说法后面的文字当作已经提供的信息，例如「帮我新建一个智能体，专门写周报」。

`create-employee` 在技能开关里被关掉时，上述入口不开始追问，回复「创建数字员工已关闭。在技能里启用 create-employee 后再试。」已建成的员工仍可按启用状态调用。

宿主在启动时若 `skill-toggles.json` 缺失，或能解析成对象但没有 `create-employee` 这个键，就把该键写成 `true`，其他已有的键保持不变。文件存在但无法解析时不改写，创建入口按已关闭处理。用户已经把该键写成关闭的，保持关闭。

### 4.2 技能怎么问

内置技能 `create-employee` 一次只问一个问题，并先给出建议答案。顺序固定：

1. 这名员工专门做哪一件事。
2. 显示名，以及建议的 `@` 标识。
3. 能力简介。
4. 人设边界：它做什么、不做什么。
5. 专属技能包：可以调用哪些已有技能，工作流需要哪些脚本。
6. 工具选择：不要、只 HTTP、只 MCP，或两者。需要稳定入参和出参时用 HTTP。需要一套会话工具协议时用 MCP。一次性步骤留在技能包脚本里。

技能正文要求模型只通过第 5 节的接口提交草稿和落盘，禁止用终端创建 `employees/` 目录。

### 4.3 同意与取消

同意是去掉首尾空白、再去掉结尾一个 `。`、`！`、`!`、`？` 或 `?` 之后，整句等于下面之一：`可以`、`确认`、`同意`、`就这样`、`按这个建`。

「可以，但名字改成周报」不算同意。技能按修改重新提交草稿。

取消是用同一规则规范化之后，整句等于 `取消` 或 `先不要`。这条会话有草稿时，宿主在把这句话交给模型之前丢弃草稿，并回复「已取消创建，没有写入数字员工。」没有草稿时，这两句按普通对话处理。

## 5. 草稿与落盘

### 5.1 接口

三个宿主接口，都要求当前会话 id：

| 接口 | 作用 |
| --- | --- |
| `employee.propose` | 校验并覆盖这一会话的草稿，返回确认单正文和 `draftId` |
| `employee.commit` | 核对这一轮用户原句是同意、且 `draftId` 对得上，然后落盘 |
| `employee.cancel` | 仅当这一轮用户原句是取消时丢弃草稿。宿主对取消说法的提前丢弃与这里同一结果 |

同一轮里调用了 `propose` 之后，这一轮的 `commit` 拒绝，草稿保留。

### 5.2 草稿内容

草稿写在 `{profileDir}/employees/.drafts/{sessionId}.json`。`sessionId` 只能是单个路径段，含 `/`、`\` 或 `..` 的不写文件并返回错误。一个会话只有一份草稿，再次 `propose` 覆盖它。重启后文件还在。删除会话时删除对应草稿。

`propose` 的字段：

| 字段 | 约束 |
| --- | --- |
| `displayName` | 去掉首尾空白后 1–40 个 UTF-16 码元 |
| `slug` | 匹配 `AGENT_NAME_RE`，长度 1–32，且不与已有员工、公用机条目、本地入口重名 |
| `description` | 去掉首尾空白后 1–200 个 UTF-16 码元 |
| `personaSummary` | 确认单上的人设要点，1–200 个码元 |
| `persona` | 写入 `persona.md` 的正文，非空，UTF-8 不超过 32 KiB |
| `skillSummary` | 确认单上的技能包要点，1–200 个码元 |
| `skillMarkdown` | `skill/SKILL.md` 全文，非空，UTF-8 不超过 32 KiB，frontmatter 的 `name` 等于 `slug` |
| `scripts` | 0–20 个文件。路径匹配 `^[A-Za-z0-9._/-]+$`，不含 `..`，落在 `skill/scripts/` 下。单文件 UTF-8 不超过 256 KiB |
| `allow` | 要附到人设后面的已有技能名。每项必须是当前能找到的技能，且不是 `create-employee`。它不决定子代理能调用哪些工具 |
| `tools` | `none`、`http`、`mcp`、`both` 之一 |
| `httpServer` | `tools` 为 `http` 或 `both` 时必填，是 `tools/http/server.mjs` 的全文，UTF-8 不超过 256 KiB。否则必须省略 |
| `mcpServer` | `tools` 为 `mcp` 或 `both` 时必填，是 `tools/mcp/server.mjs` 的全文，UTF-8 不超过 256 KiB。否则必须省略 |

任一约束失败时 `propose` 拒绝，不创建 `employees/{slug}/`，并把失败字段返回给技能，由技能回到对应那一步重问。

宿主生成 `draftId`。确认单正文由宿主生成，模型必须原样贴回会话，不得改写：

```text
请确认是否创建这名数字员工：
显示名：{displayName}
@标识：{slug}
能力简介：{description}
人设要点：{personaSummary}
技能包：{skillSummary}
工具：{工具标签}
回复「可以」后才会创建，创建后为关闭。回复「取消」则丢弃。
```

工具标签依次是 `不要`、`HTTP`、`MCP`、`HTTP 和 MCP`。

### 5.3 落盘

`commit` 再校验一次草稿。用户原句不是同意、`draftId` 不匹配、或这一轮已经 `propose` 过，则拒绝且不写员工目录。

通过后写入 `{profileDir}/employees/.tmp-{slug}-{random}/`，文件齐了再改名为 `employees/{slug}/`。改名失败或中途写失败时删除临时目录，侧栏不出现卡片，草稿保留。

建成后的目录：

```text
employees/{slug}/
  employee.json
  persona.md
  skill/SKILL.md
  skill/scripts/...        有脚本时才有
  tools/http/server.mjs    选择了 HTTP 时才有
  tools/mcp/server.mjs     选择了 MCP 时才有
```

`employee.json` 由宿主写成，含 `schemaVersion: 1`、`draftId`、`slug`、`displayName`、`description`、`enabled: false`、`allow`、`tools` 和 `createdAt`。里面不写绝对路径。`persona.md` 与技能、工具文件来自草稿。专属技能不复制到 `skills/`。

落盘成功后删除这份草稿。同一个 `draftId` 再次 `commit` 时，若 `employee.json` 里的 `draftId` 相同，返回这张卡片，不覆盖文件。草稿和员工都不存在时，`commit` 返回「没有待确认的草稿」。

## 6. 侧栏

「智能体」增加页签「我的员工」，数据来自 `employee.list`，不混进 `agent.list`。

卡片显示显示名和能力简介。关闭时只有「启用」。启用时有「关闭」和「以此身份开新会话」。没有「发布」。

列表为空时显示：还没有数字员工。在会话里说「帮我新建一个智能体」即可创建。

`persona.md` 缺失，或 `employee.json` 无法按第 5.3 节读出时，卡片标为已损坏并写明原因，不能启用，也不能调用。

后来新增的公用机条目或本地入口若与某员工 `slug` 相同，卡片增加提示「与已有入口同名，@ 将使用这名数字员工」。启用状态下的 `@` 仍进入这名员工。

## 7. 调用

### 7.1 启用

`employee.setEnabled` 把 `employee.json` 的 `enabled` 写成 `true` 或 `false`。已损坏的员工拒绝启用。启用本身不启动子进程。

关闭期间，员工不出现在 `@` 补全里。直接 `@` 得到「数字员工未启用」。`employee.openSession` 同样拒绝。已经发出的那一轮让它跑完，子进程在这一轮结束后停掉；再下一句被拒绝。会话还留在列表里。

### 7.2 `@` 一轮

启用且未损坏的员工进入 `@` 补全。补全行显示显示名和 `slug`，点名用 `slug`。

这一轮复用 `kind=agent` 的子代理路径。人设是 `persona.md` 全文，后面附上专属 `SKILL.md`，以及 `allow` 里每个已有技能的正文。子代理的资源目录是该员工的 `skill/`。员工不注册成全局本地入口。

子代理的工具名单由宿主拼出，不经过 `filterAgentAllow`。该函数会去掉 `call_host_tool` 和 `mcp__` 前缀，员工的 HTTP 与 MCP 会因此消失。名单是：

- 固定包含 `read`、`read_file`、`glob`、`grep`，以及当前平台的 shell。Windows 用 `pwsh`，其他平台用 `bash`。shell 仍走现有命令策略。
- 选择了 HTTP 时再加上 `call_host_tool`。这一轮只挂名为 `employee-http` 的宿主工具，其他 `call_host_tool` 名称拒绝。
- 选择了 MCP 时再加上本轮 `mountSessionMcp` 返回的工具名。

子代理的工作目录与当前会话相同。人设末尾写明 `employees/{slug}/` 的绝对路径。技能脚本通过上面的 shell 执行，并受现有命令策略和工作区边界约束。

选择了 HTTP 时，宿主在子代理开始前执行第 7.4 节，本轮结束即停。选择了 MCP 时，只挂在这一轮，结束即卸。两者都要时，两个都健康才开始子代理；任何一个失败都停掉已拉起的进程，这一轮失败。这一轮结束后，宿主把子会话最后一条助手正文追加到当前会话。正文为空时记「数字员工没有返回正文。」子会话不出现在会话列表。

脚本按无状态编写。跨轮要留下的内容写在 `employees/{slug}/state/`。宿主不解释这个目录。

### 7.3 以此身份开新会话

只有启用且未损坏时，`employee.openSession` 创建一条顶层会话，并在会话头记下 `employeeSlug`。它的 `origin` 不是 `subagent`，因此出现在会话列表里。

这条会话里的每一句都不经过桌面助手。宿主对这一句调用 `subagents.start("spawn")`，父级锚在这条会话上，工具名单与第 7.2 节相同。子代理结束后，宿主读取该子会话记录里最后一条助手正文，追加到这条顶层会话。正文为空时，顶层会话记「数字员工没有返回正文。」子会话不出现在会话列表。

HTTP 与 MCP 跟着这条会话：第一条消息前拉起，会话结束或员工被关闭且进行中的一轮已经结束时停掉。进程中途退出时，下一句重新拉起；仍然失败则这一句失败并说明原因。进程内存只在这条会话内有效。跨会话状态仍写在 `state/`。

### 7.4 子进程

HTTP 与 MCP 都只绑定宿主指定的地址和端口：

- HTTP：`EMPLOYEE_HTTP_HOST=127.0.0.1`，`EMPLOYEE_HTTP_PORT` 为宿主选中的空闲端口。脚本必须监听这里，并接受 `POST /invoke`，请求体为 `{"arguments": {...}}`。宿主以工具名 `employee-http` 走现有 `call_host_tool`。超时沿用默认 60 秒、硬顶 150 秒。
- MCP：`EMPLOYEE_MCP_HOST=127.0.0.1`，`EMPLOYEE_MCP_PORT` 为另一个空闲端口。脚本必须在 `http://127.0.0.1:{port}/mcp` 提供 streamable HTTP。宿主用 `serverName = slug` 调用 `mountSessionMcp`。它未提供任何工具时，这一轮失败。

宿主在 5 秒内能对相应端口建立 TCP 连接，才算健康。进程提前退出时立即失败，并把标准错误的前 500 个字符写进失败原因。失败时发送 `SIGTERM`，2 秒后仍在则 `SIGKILL`。

确认单被同意，就是同意这些脚本在本机以子进程执行。

## 8. 测试

测试只加在 `dsh-plugin-huaanwork`，随该包现有的无界面测试运行。新源码放在 `src/client-huaanwork/`、`src/huaanwork-host/` 和 `skills/create-employee/`。`check:desktop-variants` 不因此新增 `allowedDifferences`。

宿主测试：

- 非法标识、重名、空字段、简介超过 200 字、缺少 `SKILL.md`、选了工具却没有入口文件、`allow` 中有不存在的技能，`propose` 都拒绝，且不出现 `employees/{slug}/`。
- `none`、`http`、`mcp`、`both` 四种合法草稿可以通过校验。
- 五个同意句可以 `commit`。同意里夹着修改、或同一轮里又 `propose` 又 `commit`，都不写入。
- 落盘先写临时目录。失败时临时目录被删除，列表仍为空，草稿仍在。
- 同一个 `draftId` 再次 `commit` 不覆盖已建成的文件。
- 新建为关闭。关闭时不在 `@` 补全里，直接 `@` 得到未启用。启用后的 `@` 注入 `persona.md` 和专属技能包。工具名单含读文件和 shell；选择 HTTP 时含 `call_host_tool`，且只接受 `employee-http`；选择 MCP 时含 `mountSessionMcp` 返回的名字。名单不经过 `filterAgentAllow`。
- HTTP 在 `@` 一轮开始前拉起、结束后停掉。健康检查失败时这一轮失败，且不留子进程。MCP 只挂在这一轮或这条员工会话上。
- 未启用时 `openSession` 失败。员工会话的下一句使用该人设，桌面助手的人设不进入这一句。
- 关闭时进行中的一轮可以跑完，再下一句被拒绝。
- 两个触发说法和 `/create-employee` 进入创建流程。已有草稿时继续那一份。「取消」和「先不要」之后草稿文件消失。
- 开关文件缺失或能解析但没有 `create-employee` 键时，宿主把该键写成 `true`。该键已是 `false`，或开关文件无法解析时，触发说法不进入追问，文件内容不被覆盖。
- `persona.md` 缺失时卡片为已损坏，启用和调用都拒绝。

侧栏测试：卡片有显示名和能力简介；关闭时只有「启用」；启用时有「关闭」和「以此身份开新会话」；没有「发布」；空列表使用第 6 节的提示文案。

技能文件测试：`create-employee` 要求一次只问一个问题，并且只通过 `employee.propose` 和 `employee.commit` 落盘。

## 9. 实现边界

| 模块 | 职责 |
| --- | --- |
| `skills/create-employee/SKILL.md` | 六步追问、原样转述确认单、只调用宿主接口 |
| `employees-host` | 草稿、校验、临时目录落盘、列表、启停、损坏判定 |
| `employee-runtime` | 拉起和停止 HTTP 与 MCP，挂载 `employee-http` 和 `mountSessionMcp` |
| 会话发送路径 | 触发说法、取消提前丢弃、`@` 分流、员工会话每句走子代理并把最终回复写回顶层记录 |
| `AgentsView` 的「我的员工」 | 卡片、启停、开新会话 |

员工目录与草稿都在 `profileDir` 下。变体守卫比较 Stable、Beta 与华安的源码差异；本规格不修改那两个桌面包。
