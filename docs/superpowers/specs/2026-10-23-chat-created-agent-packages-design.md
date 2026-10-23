# 会话内创建智能体包（融合设计：M1 本地版 / M2 发布版）

- 日期：2026-10-23
- 状态：设计已确认；2026-10-23 范围裁定：M1 只做本地创建/运行/启停，发布+消费整条链路移入 M2。
- 范围：M1 覆盖 macOS 与 Windows 的会话创建、本地智能体包、AgentsView 三页签、`@` 运行与启停；M2 覆盖审查/签名发布、目录包下载/安装/更新/下架/撤销（§8 只作为 M2 设计保留，不计入 M1）。
- 不改：`dsh-plugin-desktop/`、`dsh-plugin-desktop-beta/`、`dsh-desktop-next/`、`deepseek-harness/`、`dsh-community-market/`。M1 不改 `market-server/`；M2 若采用签名原语共享，仅做 §8.1 的代码抽取，不改其运行时路由、配置或行为。
- 来源与取代关系：本规格融合并取代 `2026-10-22-chat-created-agents-design.md`（A）与 `2026-10-22-conversation-create-employee-design.md`（B）作为实施依据。A 提供“一个智能体模型 + 侧栏/页面治理 + 公用机发布”的产品闭环；B 提供“宿主校验草稿 + 明确同意 + 原子落盘 + 包运行时 + 完整校验”的工程纪律。两份草案保留为历史设计输入。

## 1. 背景与目标

用户在华安工作台的会话框输入“帮我新建一个智能体”“帮我建一个数字员工”或相近说法时，会话进入创建流程；助手以 grill-me 式逐问澄清用途、名称、能力简介、人设边界、技能包与工具选择；用户确认后，宿主在本机写入一个智能体包。建好的智能体出现在左侧「智能体」页面的「我的智能体」页签，展示名称与能力简介，M1 提供启用、关闭；M2 再提供发布。M2 的发布经过管理员审查与 Ed25519 签名后进入公用机目录，其他同事可在「智能体广场」下载、验签、启用并通过 `@标识` 调用。

典型场景仍是**个人效率助手**：员工为自己搭建合同审查员、周报生成器等助手，自己建、自己用；发布是顺带分享（M2）。管理员审查与签名是分享链路的治理门槛。

**M1 成功标准**（本地版）：

1. 会话内两种规范说法与 `/create-agent` 能稳定进入创建流程；澄清一次只问一个问题。
2. 建成的智能体出现在「我的智能体」，显示名称与能力简介；启用/关闭即时生效。
3. 选中 HTTP/MCP 的智能体在 `@` 回合里真的能调用其脚本；回合结束进程停止。
4. macOS 与 Windows 都完成本地创建/运行/启停真机验收；失败时诚实报错，不静默降级。
5. 旧目录已启用智能体不丢：继续以 `catalog-legacy` 路径可用，界面标“待迁移”。

**M2 成功标准**（发布版，见 §8）：本地包提交审查；管理员签名后发布；另一台机器下载、验签、安装、启用并运行；下架/撤销生效。M1 验收不得声称“发布已交付”。

## 2. 已确认裁定

| 编号 | 裁定 |
|---|---|
| R1 | 智能体与数字员工是同一个实体：**智能体包**；“数字员工”只是口语称呼 |
| R2 | 保留 B 的完整生成脚本能力：专属技能包 + 可生成并本机执行的 HTTP/MCP `server.mjs` |
| R3 | **M2**：发布必须经过管理员审查 + Ed25519 签名，整包分发；消费端验签后才安装/运行 |
| R4 | 运行时使用现有 DSH sandbox；**只保证写限制**，读文件与网络不隔离；审查/签名是来源控制，不是运行时隔离 |
| R5 | AgentsView 三个页签：**智能体广场 / 我的智能体 / 我的工具包**；取消独立“已启用”页签 |
| R6 | M1 同时覆盖 macOS 与 Windows；Windows 沙箱 `partial` 是已接受事实，必须有真机验收 |
| R7 | **M2**：发布链路三个凭据：读 token、发布 token、admin token；桌面端不持有 admin token 与签名私钥 |
| R8 | **M2**：包含撤销列表；下架只影响广场分发，撤销才禁用已安装副本 |
| R9 | **M2**：审查与签名通过管理员 CLI 完成；不做审查 UI |
| R10 | 新建默认关闭；同 slug 更新纳入 M1，版本由宿主 patch+1 |
| R11 | M1 脚本无跨轮状态；不做“以此身份开新会话”、知识库、跨智能体依赖分发、多密钥轮换 UI |
| R12 | **M1 仅本地**：创建、本地包、运行、启停、三页签、macOS+Windows；发布+消费整条链路移入 M2；M1 验收不得声称发布已交付 |

## 3. 现状与约束（已核实）

本节是设计的约束来源；实施前需复核行号。

| 现状 | 位置 | 对本设计的约束 |
|---|---|---|
| 侧栏「智能体」导航打开整页 `AgentsView`；当前页签为发现/已启用/本地入口 | `client-huaanwork/App.tsx:2372`、`AgentsView.tsx:21-25` | 改为三页签；现有“已启用”分类被「我的智能体」取代 |
| 本地入口只允许 `kind:"tool"`；`addEndpoint` 对 `kind:"agent"` 直接拒绝 | `huaanwork-host/agents-host.ts:567-573`、`AgentsView.tsx:539-543` | 智能体包不走 `addEndpoint`，使用独立包存储 |
| 本地 `get` 不返回 persona/allow，`enabled` 硬编码 true | `agents-host.ts:372-389` | 包智能体需要独立的详情/状态读取 |
| 本地入口的 `setEnabled` 直接抛错 | `agents-host.ts:538-540` | 包智能体的启停必须新增路径 |
| 本地入口记录必须有 `entrypoint.url`，否则读路径跳过 | `agents-host.ts:111-160` | 包目录不能塞进 `agents-endpoints.json` |
| `kind:"agent"` 的 `@` 路径只传 persona，`allow` 经 `filterAgentAllow` 过滤 | `agent-invoke.ts:149-200`、`packages/huaanwork-policy/src/agent-catalog.ts:53-67` | 包智能体走新的运行时；不能复用该过滤 |
| `filterAgentAllow` 剔除 `call_host_tool` 与 `mcp__*` | `agent-catalog.ts:53-67` | 包运行时工具名单由宿主显式拼出 |
| 内置技能缺省不启用；启动只恢复 `skill-toggles.json` 中为 true 的项 | `huaanwork-guardrails/skills.ts:435-448`、`skills-host.ts:432-444` | `create-agent` 不依赖全局技能目录，由宿主在命中入口时注入 |
| 模型目录不渲染 `whenToUse`，路由只看名称与截断后的 description | `deepseek-harness/packages/skill/tool-skill/README.md:244` | 不能把“whenToUse 自触发”作为入口机制 |
| `read`/`read_file`/`glob`/`grep`/`edit`/`write` 对工作区外路径直接拒绝 | `packages/huaanwork-policy/src/decide.ts:78-88`、`paths.ts:12-35` | 子代理不能直接读 `profileDir` 下的包文件；persona/skill 由宿主注入，脚本经宿主工具运行 |
| DSH sandbox 的策略词汇只有文件效果；Windows 后端 `partial`，读与网络不受限 | `packages/sandbox/sandbox-local/README.md:53`、`sandbox-windows-acl/README.md:125` | 接受 R4；UI 与规格必须诚实说明 |
| 目录客户端只有 `GET /v1/catalog` 与 `GET /v1/catalog/<name>`；仓库无生产目录服务端 | `agents-host.ts:191-360`、`docs/superpowers/specs/2026-10-13-agents-catalog-integration-design.md:149-159` | **M2**：新增 agent-catalog 服务端与包接口；M1 不需要 |
| market-server 已有 `canonicalJson`/Ed25519 sign/verify 与双槽 keyId 校验 | `market-server/src/signing.ts:193-410` | **M2**：抽取共享签名原语；M1 不改 market-server |
| 现有本地入口页签只渲染“删除” | `AgentsView.tsx:330-357` | 新 UI 需要按来源与状态重写卡片动作 |

标 M2 的行只约束二期；M1 不实现 §8、不需要签名包/目录包/撤销/三 token。M1 的目录读取仍是现有 GET 目录（legacy）与本地工具入口。

## 4. 总体架构

```text
[会话页]
  用户: "帮我新建一个智能体" / "帮我建一个数字员工" / /create-agent
     │
     ▼ 宿主命中入口（无需模型自触发）
[create-agent 技能注入] grill-me 逐问：用途 → 名称/@ → 简介 → 人设边界 → 技能包 → 工具
     │ 模型调用 agent_propose
     ▼
[宿主校验 + 结构化确认卡]
     │ 用户下一轮明确同意
     ▼ 模型调用 agent_commit（宿主核对原句与 draftId）
[本机智能体包] {profileDir}/agents/{slug}/
     │
     ├─ 我的智能体：启用/关闭；@ 调用；本地更新（M1）
     │
     ├─ M2：发布：包 → 提交审查 → 管理员审查/签名 → agent-catalog 包仓库
     │
     └─ M2：消费：广场下载 → 验签/解包/哈希 → 原子安装 → 启用 → @ 运行

[运行时] agent-package-runtime
   persona + SKILL.md + allowSkills 正文 → subagents.start("spawn")
   HTTP/MCP 脚本 → 沙箱子进程 → 回环端口 → agent_http / mountSessionMcp
   回合结束 → SIGTERM/SIGKILL → 清理
```

信任边界：

- **创建者（M1）**：本机写包；默认关闭；包只在本地使用，不进入目录。
- **审查/签名者（M2）**：离线私钥 + admin CLI；服务端只持有公钥。
- **目录服务（M2）**：存储已签名包与撤销/下架元数据；读 token 分发。
- **消费端（M2）**：安装时验签；每次运行前复验哈希与签名；撤销即禁用。
- **沙箱（M1）**：限制写；不限制读与网络（R4）。

M1 只实现创建、本地包、运行、启停与三页签；发布/消费分支不接线、不出现在 M1 UI，也不计入 M1 验收。

## 5. 数据模型

**M1 只使用 `source: local` 与 `catalog-legacy`；`.signature/`、`source: catalog`、`publishStatus`/`publishedVersion` 的发布语义属于 M2。** M1 的本地包没有签名文件，版本号保留给 M2 发布使用。

### 5.1 包目录

```text
{profileDir}/agents/{slug}/
  agent.json                     # manifest，签名覆盖
  persona.md
  skill/SKILL.md                 # 可选
  skill/scripts/...              # 可选，≤20 个
  tools/http/server.mjs          # tools 含 http 时必有
  tools/mcp/server.mjs           # tools 含 mcp 时必有
  .signature/package-digest.json # M2：仅从广场安装的包
  .signature/signature.json      # M2：仅从广场安装的包
```

草稿：`{profileDir}/agents/.drafts/{sessionId}.json`。
状态：`{profileDir}/agents-state.json`。
旧启用表：`{profileDir}/agents-enabled.json` 保持只读，迁移完成后删除对应 `catalog:` 键。
旧工具入口：`{profileDir}/agents-endpoints.json` 不动，归「我的工具包」。

`.signature/` 属于 M2，不参与 digest 的文件清单；安装时额外允许且只允许这两个文件。包目录本身是签名覆盖内容的唯一权威；启用/发布状态不写进包。

### 5.2 `agent.json`

| 字段 | 约束 |
|---|---|
| `schemaVersion` | 固定 `1` |
| `slug` | `AGENT_NAME_RE`，1–32；在“本地包 + 已安装目录包 + 本地工具包 + 广场智能体/工具条目”范围内全局唯一 |
| `displayName` | 去首尾空白后 1–40 个 UTF-16 码元；可重复 |
| `description` | 去首尾空白后 1–200 个 UTF-16 码元 |
| `version` | semver；宿主维护，新建 `1.0.0`，同 slug 更新 patch+1 |
| `draftId` | 宿主写入的 UUID；仅用于 commit 幂等核对，不参与业务语义 |
| `createdAt` / `updatedAt` | 宿主写入的 ISO 时间 |
| `persona` | 固定 `persona.md`；非空，UTF-8 ≤ 32 KiB |
| `skill` | `{ entry: "skill/SKILL.md", summary: "..." }` 或 `null`；SKILL.md ≤ 32 KiB，frontmatter `name` 必须等于 `slug` |
| `tools` | `{ mode: "none"｜"http"｜"mcp"｜"both", http?: { entry: "tools/http/server.mjs", argumentsSchema?: {...} }, mcp?: { entry: "tools/mcp/server.mjs" } }`；选中项必须有文件，未选中项不得有文件；`argumentsSchema` 序列化后 ≤1024 字符 |
| `allowSkills` | 允许附加正文的已有技能名；每项必须是当前可找到且已启用的技能，不能是 `create-agent` |

包总大小 ≤ 5 MiB；脚本路径匹配 `^[A-Za-z0-9._/-]+$`、不含 `..`、不允许符号链接；单脚本 ≤ 256 KiB；HTTP/MCP 入口 ≤ 256 KiB。persona + SKILL.md + `allowSkills` 正文合并后 ≤ 64 KiB，超出在 `propose` 拒绝。

`source`、`enabled`、`published` 不是 `agent.json` 字段：来源与状态属于安装/使用事实，不能写进被签名的内容。

### 5.3 `agents-state.json`

```jsonc
{
  "local:weekly-report": {
    "source": "local",
    "enabled": true,
    "installedVersion": "1.0.1"
  },
  // M2：从广场安装的签名包
  "catalog:typo-check": {
    "source": "catalog",
    "enabled": true,
    "installedVersion": "0.1.0",
    "publishStatus": "installed"
  }
}
```

M1 的本地条目只读写 `source`/`enabled`/`installedVersion`；`publishStatus`/`publishedVersion` 是 M2 字段，M1 可省略。

过渡期条目示例（旧目录 persona 条目尚未迁移）：

```jsonc
{
  "catalog:legacy-assistant": {
    "source": "catalog-legacy",
    "enabled": true,
    "publishStatus": "installed"
  }
}
```

`publishStatus` 取值：`none`、`pending-review`、`published`、`rejected`、`delisted`、`installed`，属于 M2。`source` 取值 `local`、`catalog`、`catalog-legacy`；**M1 只使用 `local` 与 `catalog-legacy`，`catalog` 属于 M2**。`catalog-legacy` 只用于尚未迁移为签名包的旧目录 persona 条目，它仍走旧 `kind:"agent"` 路径，不进入包运行时，也不参与发布。启用态与已发布状态分离；签名包的 manifest 永远不被修改。

### 5.4 版本、更新与迁移

- 新建：`version = 1.0.0`，默认 `enabled:false`。
- 同 slug 更新（仅本地包）：`mode:"update"` 走同一 propose/commit；宿主把 patch 位 +1。M1 不维护发布状态；M2 接入发布后，内容变化再把 `publishStatus` 置回 `none` 并要求重新提交审查。
- 广场包更新（M2）：只能下载更高版本；安装前校验签名与撤销列表；保留 `enabled`。
- 旧数据迁移（M1）：`agents-enabled.json` 中 `catalog:<name>` 为 true 的条目保留旧键与旧 `kind:"agent"` 路径，标为 `catalog-legacy`，界面显示“待迁移”；**M1 不下载、不物化、不伪造签名包**，目录不可达也不让已启用项消失。M2 服务端完成后，客户端再下载同 slug 签名包并保持启用，成功后删旧键。现有本地工具入口原样留在「我的工具包」。

## 6. 创建链路

### 6.1 入口

去掉首尾空白后，以下情况进入创建流程：

- 整段等于 `/create-agent`，或以 `/create-agent` 加空白开头；`/create-agent update <slug>` 进入更新模式。
- 匹配保守正则：`^(帮我)?(新建|创建|建)(一个|个)?(智能体|数字员工|助手)`；开头说法后面的文字当作已提供的信息。
- 已有草稿时，后续说法继续同一份草稿，不另开。

不匹配的近似说法不会自动进入；用户可用 `/create-agent` 或改写。`create-agent` 不注册进全局技能目录，由宿主在命中入口时把技能正文注入本轮，因此不受 `skill-toggles` 默认关闭影响。管理端是否允许关闭该入口留到 M2。

### 6.2 访谈与提案

宿主在创建流程中挂载两个模型工具：`agent_propose`、`agent_commit`；commit 或取消后立即卸下。技能正文由宿主读取 `skills/create-agent/SKILL.md` 注入本轮，不注册进全局技能目录。技能正文要求：

1. 一次只问一个问题，先给建议答案。
2. 固定顺序：用途 → 显示名与 `@` 标识 → 能力简介 → 人设边界 → 技能包 → 工具选择。
3. 只通过 `agent_propose` 提交草稿，禁止用终端创建目录。
4. 确认卡由宿主生成；模型不得改写。宿主同时向会话写入一张结构化确认卡，客户端优先渲染它。

`agent_propose` 入参：

| 字段 | 说明 |
|---|---|
| `displayName` / `slug` / `description` | 见 §5.2 约束；slug 冲突、为空、超长都拒绝 |
| `persona` | `persona.md` 全文 |
| `personaSummary` / `skillSummary` | 确认卡要点，各 1–200 |
| `skill` | `{ summary, markdown, scripts: [{ path, content }] }` 或 `null` |
| `allowSkills` | 已有技能名数组 |
| `tools` | `none` / `http` / `mcp` / `both` |
| `httpServer` / `mcpServer` | 对应入口文件全文；未选中项必须省略 |
| `mode` | `create` 或 `update`；`update` 必须指向已存在的本地包 |

任一约束失败，`propose` 拒绝、不创建目录、返回失败字段；技能回到对应步骤重问。`propose` 生成 `draftId`，一个会话一份草稿；再次 propose 覆盖。

### 6.3 同意、取消与提交

- 同意：去首尾空白、去掉结尾一个 `。！!？?` 后，整句等于 `可以`、`确认`、`同意`、`就这样`、`按这个建`。夹带修改的“可以，但名字改成周报”不算同意。
- 取消：同样规范化后等于 `取消` 或 `先不要`；有草稿时宿主在交给模型前丢弃草稿并回复“已取消创建，没有写入智能体”。
- `agent_commit` 同时满足：当前用户原句是同意、`draftId` 匹配、这一轮没有先 propose。任一不满足都拒绝且不写盘。
- 原子落盘：先写 `agents/.tmp-{slug}-{random}/`，文件齐了再 rename 到 `agents/{slug}/`。更新同 slug 时先把旧目录 rename 为 `.old-{slug}-{random}`，新目录就位后删旧目录；失败回滚。启动时清理 `.tmp-*`；若正式目录缺失且存在 `.old-*`，恢复旧目录。
- 幂等：同一 `draftId` 再次 commit，若包内 `agent.json.draftId` 相同，返回已有卡片，不覆盖；成功后删除草稿。
- 落盘成功发 `agent.changed` 事件；客户端刷新「我的智能体」。新建默认关闭。

确认卡文案：

```text
请确认是否创建这名智能体：
显示名：{displayName}
@标识：{slug}
能力简介：{description}
人设要点：{personaSummary}
技能包：{skillSummary}
工具：{工具标签}
脚本将在本机沙箱中运行；沙箱只限制写，读取文件和网络不受限制。
回复「可以」创建（默认关闭）；回复「取消」放弃。
```

## 7. 运行链路

### 7.1 `@` 分流与前置检查

`@slug` 仍由 `agent-invoke.ts:54-63` 解析。`kind:"agent"` 且来源是本地包/目录包时进入 `agent-package-runtime`；旧目录 persona 智能体（`catalog-legacy`）与工具入口保持原路径。`@` 补全只列已启用的已安装包、已启用的 `catalog-legacy` 条目和已启用的工具；广场中未安装的包不出现在补全里。

进入运行时前依次拒绝：

- 不在「我的智能体」、未启用、已损坏；
- `agent.json` 缺失/无法解析、persona/skill/入口文件缺失；
- 下载包的 `.signature/` 缺失、文件哈希或签名不匹配；
- `tools.mode` 与实际文件不一致；
- 沙箱 `SANDBOX_UNAVAILABLE`（不静默无沙箱运行）。

### 7.2 子代理人设与技能

- persona = `persona.md` + `SKILL.md` 正文 + `allowSkills` 每个技能正文；合并后注入 `subagents.start("spawn")` 的 persona。
- 子代理 `cwd` = 当前会话工作区；不把 `skill/` 当 `resourceBase`——`SubagentStartRequest` 没有该字段。
- 包目录绝对路径写入 persona 末尾；但子代理不能用 `read`/`glob`/`grep` 读它（工作区外路径被策略拒绝）。所有包内文本由宿主读取后注入。

### 7.3 工具合成

| 来源 | 暴露给子代理的工具 |
|---|---|
| 基础 | `read`、`read_file`、`glob`、`grep`、当前平台 shell（`bash`/`pwsh`） |
| 技能脚本 | 宿主工具 `agent_skill_run`：只运行 manifest 声明的 `skill/scripts/*`，宿主解析并校验路径，不接受模型传任意路径 |
| HTTP | 宿主工具 `agent_http`：POST `http://127.0.0.1:{port}/invoke`，复用 60s 默认/150s 硬顶、1 MiB 响应帽、32 KiB 输出帽 |
| MCP | `mountSessionMcp` 返回的 `mcp__{slug}__*` 工具名 |

HTTP 不复用 `call_host_tool`：后者绑定目录快照与 attached 判定，把运行时端点塞进目录快照会污染目录语义。MCP 复用现有 `mountSessionMcp`。工具名单由宿主显式拼出，再对子代理 `tools.restrict({ allow })`；不经过 `filterAgentAllow`。`agent_http` 的工具描述包含包的 displayName、description 与可选 argumentsSchema；`agent_skill_run` 的描述列出 manifest 声明的脚本路径。

`agent_skill_run` 契约：

- 入参 `{ script, args }`；`script` 必须精确命中 manifest 声明的脚本路径；宿主用 `realpath` 复检包含关系。
- 进程用 argv 启动，不拼 shell 字符串；cwd = 当前工作区；env 白名单；`AGENT_SCRIPT_ARGS` 为 JSON；输出按 32 KiB 截断；非 0 退出返回 stderr 前 500 字符。
- M1 脚本无跨轮状态；本轮私有临时目录 `AGENT_STATE_DIR`，回合结束即删。持久结果由脚本写入当前工作区。

### 7.4 HTTP / MCP 子进程

- 宿主在 `127.0.0.1` 选空闲端口；脚本监听 `AGENT_HTTP_HOST`/`AGENT_HTTP_PORT` 或 `AGENT_MCP_HOST`/`AGENT_MCP_PORT`；端口占用最多重试 3 次。
- HTTP 健康 = 5 秒内 TCP 可连接；MCP 健康 = 5 秒内可连接且 `mountSessionMcp` 至少返回一个工具；否则本轮失败。
- 两者都选时任一失败即停掉已拉起进程，不启动子代理。
- 进程提前退出：立即失败，stderr 前 500 字符进错误；停止顺序 `SIGTERM` → 2 秒后 `SIGKILL`；Windows 用进程组/Job 对象；应用退出统一清理。
- env 白名单：`PATH`、`PATHEXT`、`SystemRoot`、`TEMP`/`TMPDIR`、`AGENT_*`；不注入目录 token、模型密钥或 `HUAANWORK_*` 配置。
- 沙箱使用现有 `sandbox-local` 后端，`workspace-write`。它只约束写；读与网络不约束（R4）。
- 脚本使用与 Host 相同的 Electron/Node 运行时（`process.execPath` + `ELECTRON_RUN_AS_NODE=1` 或等价的 Node 路径），M1.0 spike 验证；脚本始终以子进程运行，不加载进桌面进程。
- HTTP 响应契约：`200 {"ok":true,"result":...}` 或 `200 {"ok":false,"error":"..."}`；非 2xx 视为传输失败；`ok:false` 以工具错误交给模型；响应体读入 ≤1 MiB，工具输出 ≤32 KiB。

### 7.5 生命周期与并发

- 每个 `@` 回合独立拉起、`afterIdle` 停止；不跨轮常驻。
- 同一会话同时只允许一个包智能体回合；第二个 `@` 由现有 followup 队列等待，第一轮结束后重新拉起，不复用进程。
- 回合失败清理全部子进程；下一句重新拉起。

## 8. M2：发布、签名、消费

本节只属于 M2，不进入 M1 验收；M1 不实现签名、目录包、管理员 CLI、三 token、审计、撤销，也不改 market-server。保留本节是为了二期可以直接接续，不再重新设计。

### 8.1 包与签名格式

```text
agent-package-{slug}-{version}.tgz   # 包文件 + .signature/
package-digest.json                  # 规范化清单（也在 .signature/ 内）
signature.json                       # Ed25519 签名（在 .signature/ 内）
```

`package-digest.json`：

```jsonc
{
  "schemaVersion": 1,
  "slug": "weekly-report",
  "version": "1.0.1",
  "manifestSha256": "<agent.json 的 sha256>",
  "files": [
    { "path": "agent.json", "size": 1234, "sha256": "..." },
    { "path": "persona.md", "size": 2345, "sha256": "..." }
  ]
}
```

- 文件按 UTF-8 路径升序；`canonicalJson` 递归排序对象键、无多余空白；签名对象是 `canonicalJson(package-digest.json)` 的 UTF-8 字节。
- `signature.json`：`{ version, algorithm: "Ed25519", keyId, slot, signedAt, signature }`。
- 不签压缩包字节；文件哈希绑定内容，客户端解包后逐文件复算。
- **共享签名原语**：`canonicalJson`、Ed25519 sign/verify、keyId/双槽校验已存在于 `market-server/src/signing.ts:193-410`。本规格要求把这些通用原语抽到共享模块（如 `packages/catalog-signing/`），`market-server` 改为从共享模块导入，`agent-catalog-server` 与桌面端共用同一实现；这是对“不改 market-server”边界的唯一显式例外，仅限代码抽取与 import 变化，不改其路由、配置或行为，现有 market-server 测试必须保持通过。若该例外不被接受，退路是在 agent-catalog-server 内复制这三个函数，并用同一 fixture 对 canonicalJson 做逐字节一致性测试；不推荐。
- 信任根：私钥只在离线签名机；服务端只持公钥。桌面端从 IT 管理的 profile 配置读取 keyring（`keyId` + raw 32-byte hex 公钥 + 可选 `retiredAt`），不在用户设置界面暴露编辑。服务端从部署配置读取同一 keyring 的公钥槽；管理员 CLI 从本地路径读取私钥；二者不共享私钥文件。M2 一个 active key；代码支持双槽轮换，轮换流程走配置/发版，轮换 UI 留到后续。
- 安装时验签；**每次 `@` 运行前复验文件哈希与签名**；失败标损坏并拒绝运行。

### 8.2 角色、凭据与状态机

| 角色 | 凭据 | 能力 |
|---|---|---|
| 使用者 | `agents_catalog_token`（读 token） | 浏览广场、下载、检查撤销列表 |
| 创建者 | `agents_catalog_publish_token`（发布 token） | 提交本地包、查看自己的提交、申请下架 |
| 审查/签名者 | admin CLI + `AGENT_CATALOG_ADMIN_TOKEN` + 离线私钥 | 审查、签名、批准/拒绝、下架、撤销 |

桌面端不保存 admin token 与私钥。

```text
none ──提交──> pending-review ──批准/签名──> published ──下架──> delisted
                    │
                    └──拒绝──> rejected ──修改后重新提交──> pending-review
```

发布按钮的真实动作是“提交审查”。审批通过后 `publishStatus=published`；本地内容再变化则回到 `none`。

### 8.3 服务端接口

与现有 M-A0 目录服务同进程扩展；现有 `/v1/catalog` 继续服务 persona 型目录条目和工具条目。新增：

| 方法 | 路径 | 权限 |
|---|---|---|
| GET | `/v1/agent-packages` | 读 token；列表 + 最新版本 + 状态 + 大小 |
| GET | `/v1/agent-packages/{slug}/{version}` | 读 token；digest + signature + 下载地址 |
| GET | `/v1/agent-packages/{slug}/{version}/bundle` | 读 token；bundle 字节 |
| POST | `/v1/agent-packages/submissions` | 发布 token；创建 pending |
| GET | `/v1/agent-packages/submissions/{id}` | 发布 token；查看状态 |
| GET | `/v1/agent-packages/submissions?status=pending` | admin token |
| POST | `/v1/agent-packages/submissions/{id}/approve` | admin token；带签名 |
| POST | `/v1/agent-packages/submissions/{id}/reject` | admin token |
| POST | `/v1/agent-packages/{slug}/{version}/delist-requests` | 发布 token；创建下架申请 |
| GET | `/v1/agent-packages/delist-requests?status=pending` | admin token |
| POST | `/v1/agent-packages/delist-requests/{id}/approve` | admin token |
| POST | `/v1/agent-packages/delist-requests/{id}/reject` | admin token |
| POST | `/v1/agent-packages/{slug}/{version}/revoke` | admin token |
| GET | `/v1/agent-packages/revocations` | 读 token；撤销列表 |

服务端重新解包并重算 digest，不信任客户端提交的 digest。所有写路径 tmp+rename 原子写，按 slug/version 加锁，拒绝重复版本与并发提交；包大小 ≤ 5 MiB；token 比较 timing-safe。提交/批准时校验 slug 不与现有工具条目、`catalog-legacy` 条目或其他包冲突，同名即拒绝；同一目录同源条目的迁移替换除外。

### 8.4 审查/签名流程

1. 桌面端校验本地包，生成 bundle；`POST /submissions`（发布 token）。
2. 服务端重算 digest，存 pending，返回 `submissionId`。
3. 管理员 CLI 列出 pending，下载 bundle，独立重算 digest 与服务端 digest 对比；打印 manifest、文件清单、大小/哈希、与上一已发布版本的 diff；可选在沙箱跑冒烟。
4. 管理员确认后，CLI 对服务端 digest 签名，`POST /approve`（admin token）。
5. 服务端用 pin 的公钥验签，通过后移入 `agent-packages/{slug}/{version}/` 并标记 published；桌面端刷新后状态更新。
6. 拒绝写 `rejected` + 原因；修改后重新走同一流程。未变更内容可复用被拒版本号；内容变化由宿主 patch+1。

管理员 CLI 还提供旧目录 persona 条目的迁移命令：把条目转成 `agent.json` + `persona.md` 的最小包，走同一审查/签名流程；迁移完成前客户端保留 `catalog-legacy` 路径，已有启用项不丢。

### 8.5 消费端安装、更新、下架、撤销

安装（广场点“下载”）：

1. 读 token 拉元数据；slug 与本地包/工具包冲突即拒绝；若同 slug 是待迁移的 `catalog-legacy` 条目且包来自同一目录，视为迁移替换，允许安装并保持启用。
2. 下载 bundle 到临时文件，≤5 MiB。
3. 解压到 `{profileDir}/agents/.install-{slug}-{random}/`；拒绝绝对路径、`..`、符号链接、硬链接、重复条目、digest 之外的额外文件（只额外允许 `.signature/package-digest.json` 与 `.signature/signature.json`）、解压总大小超帽。
4. 逐文件复算 size/sha256；`agent.json` 哈希等于 `manifestSha256`；slug/version 一致。
5. 用 pin 公钥验 `signature.json`；未知 key/退休 key 拒绝。
6. 原子 rename 到 `agents/{slug}/`；写入/更新 `agents-state.json`；首次安装默认关闭，`catalog-legacy` 迁移替换保持原启用态。
7. 任何一步失败删除临时目录，不出现半装状态。

广场包更新：仅当目录版本 > 已安装版本且未撤销；停掉正在运行的包运行时，按同一流程安装新版本，保留 `enabled`；下一轮 `@` 使用新版本。本地包更新走会话内的 `/create-agent update <slug>`，不经过广场。

下架：广场不再展示，已安装副本仍可使用；卡片显示“已下架”。下架不是安全处置。

撤销：管理员标某 slug/version 不安全；客户端刷新撤销列表后，已安装副本标损坏、禁止启用、正在运行的回合停止；广场不再提供下载。撤销列表在应用启动、进入智能体页以及页面打开期间每 60 秒刷新；目录不可达时使用上次已知列表并显示警告；离线期间被撤销的包可能继续运行到下次刷新，这是已接受风险。M2 不提供 unrevoke UI。

移除：仅对从广场下载的包提供本地“移除”（删包目录 + state），不删除本地创建的包。

### 8.6 审计

服务端所有成功与失败写 `audit.jsonl`：时间、actor（token 哈希前缀，不写 token）、动作、slug/version、submissionId、原因。桌面端发布/安装/更新/移除动作写宿主日志；下架与撤销由服务端审计记录。签名私钥与 token 永不进日志。

## 9. UI

### 9.1 三页签

| 页签 | 内容 | 主要动作 |
|---|---|---|
| 智能体广场（M1） | 现有公用机目录条目（legacy persona，标“待迁移”）；M2 再加入签名包摘要 | 查看详情；旧条目沿用启用/关闭走旧路径；M1 无下载/更新 |
| 我的智能体（M1） | 本地创建的包 + 已启用的 `catalog-legacy` 条目；M2 再加入从广场安装的签名包 | 启用/关闭；本地包更新（会话 `/create-agent update <slug>`）；查看详情；M1 无发布/下架/移除 |
| 我的工具包（M1） | 现有本地工具入口 + 公用机目录中的工具条目（分组显示） | 本地工具保持添加/删除；公用机工具沿用启用/禁用，不改调用路径 |

M1 不渲染发布、下载、安装、更新广场包、申请下架、移除下载包、撤销状态；这些在 M2 接入。「我的智能体」卡片在 M1 显示显示名、能力简介、`@slug`、版本、来源徽标（本地创建/旧目录）、启用态；发布态在 M2 再加入。损坏状态下禁用启用与更新。

详情页：名称、`@slug`、简介、版本、来源、启用态、人设摘要、技能摘要、工具模式、文件清单与大小；发布态与签名信息（keyId/签名时间/验签结果）在 M2 再加入。固定提示：**“脚本在本机沙箱中运行；沙箱只限制写，读取文件和网络不受限制。”**

空态：

- 广场：`暂无可用智能体；请先配置公用机目录。`
- 我的智能体：`还没有智能体。在会话里说「帮我新建一个智能体」即可创建。`
- 我的工具包：沿用现有本地入口空态。

### 9.2 宿主 RPC 与事件

| RPC | 用途 |
|---|---|
| `agent.packageList`（M1） | 返回本地包、`catalog-legacy` 条目、现有目录条目与目录错误；M2 再加广场签名包；「智能体广场」与「我的智能体」的数据源 |
| `agent.packageDetail`（M1） | 本地包/条目的详情；M2 再加签名验签结果 |
| `agent.packageSetEnabled`（M1） | 本地包/`catalog-legacy` 的启用/关闭 |
| `agent.invocableList`（M1） | `@` 补全：已启用本地包 + `catalog-legacy` + 工具 |
| `agent.list`（M1） | 保留现有契约；「我的工具包」的本地工具与公用机工具、旧目录条目继续使用 |
| `agent.setEnabled`（M1，现有） | 广场现有目录条目的启用/关闭；`agent.packageSetEnabled` 负责本地包与 `catalog-legacy` |
| `agent.packagePublish`（M2） | 提交审查，返回 `submissionId` |
| `agent.packagePublishStatus`（M2） | 查询审查/发布状态 |
| `agent.packageRequestDelist`（M2） | 提交下架申请 |
| `agent.packageInstall`（M2） | 从广场安装签名包 |
| `agent.packageUpdate`（M2） | 更新已安装目录包（本地包更新走会话） |
| `agent.packageRemove`（M2） | 移除已安装的目录包 |
| `agent.packageRefresh`（M2） | 刷新目录包与撤销列表 |

`agent.changed` 事件在创建提交、启停、本地更新后触发；M2 再加入安装、更新、移除、发布状态变化。M1 不新增设置项；M2 才新增 `agents_catalog_publish_token` 与 IT 管理的 keyring。

### 9.3 发布状态与动作（M2）

下表只属于 M2；M1 的「我的智能体」卡片只有启用/关闭、本地更新（会话）与查看详情，不显示发布、下载、更新广场包、申请下架或移除下载包。

| 状态 | 卡片 | 动作 |
|---|---|---|
| 本地，未发布 | “本地创建” | 启用/关闭、发布、详情 |
| 待审查 | “待审查” | 查看状态、详情 |
| 已发布 | “已发布 vX” | 启用/关闭、申请下架、详情 |
| 被拒 | “审查未通过：原因” | 重新提交、详情 |
| 已安装的广场包 | “来自广场” | 启用/关闭、更新、移除、详情 |
| 已启用的旧目录条目 | “旧目录智能体（待迁移）” | 启用/关闭、详情 |
| 已下架但已安装 | “已下架” | 启用/关闭、移除、详情 |
| 已撤销 | “已撤销：原因” | 详情、移除 |
| 已损坏 | “已损坏：原因” | 详情、移除（下载包） |

发布动作弹窗说明“提交后需管理员审查与签名，不会立即上架”。提交成功后显示 `待审查`；审批由管理员 CLI 完成，客户端通过刷新/重新进入页签获取状态。M2 不做后台推送。

## 10. 错误处理

标 M2 的错误只在二期出现；M1 的本地包没有签名、安装、撤销与下架。

| 场景 | 行为/文案 |
|---|---|
| 未启用/不存在 | `智能体「X」未启用或不存在` |
| 已损坏 | `智能体「X」已损坏：{reason}` |
| 签名/哈希失败（M2） | `包校验失败，未安装或未运行。请联系管理员` |
| 版本冲突/降级（M2） | `版本低于已安装版本，已拒绝更新` |
| 审查拒绝（M2） | `审查未通过：{reason}` |
| 沙箱不可用 | `当前系统无法启动沙箱，智能体未运行` |
| 脚本启动失败 | `脚本启动失败：{stderr 前 500 字符}` |
| 已撤销（M2） | `该版本已被管理员撤销：{reason}` |
| 已下架（M2） | `已下架，不再提供下载；已安装副本仍可使用` |
| slug 冲突 | `@标识与本地包或工具包冲突，请换一个名称` |
| 包结构非法 | `包结构非法，已拒绝安装` |
| 认证失败 | `目录口令错误或权限不足` |
| 超时/网络 | `目录不可达，请稍后重试；本地智能体不受影响` |

## 11. 测试与验收

### 11.1 测试矩阵

| 层 | 覆盖 |
|---|---|
| 单元（M1） | manifest 校验；草稿/确认状态机；触发正则；本地状态/启用；本地更新版本；路径与文件约束 |
| 宿主集成（M1） | propose/commit/取消/幂等；原子写与崩溃恢复；slug 冲突；`catalog-legacy` 迁移；`@` 分流；`agent_skill_run`；`agent_http`；MCP 空工具；工具白名单；进程清理；沙箱不可用 fail-closed；启用/关闭/更新 |
| UI/契约（M1） | 三页签渲染；我的智能体卡片；空态；`@` 补全只列已启用项；错误文案 |
| 单元（M2） | canonicalJson 与 market-server 逐字节一致；签名/双槽 keyId；digest；解包路径/symlink/重复/额外文件/zip bomb；审计 |
| 服务端集成（M2） | 三 token 分离；提交/批准/拒绝；重复版本；并发；下架申请；撤销；审计；包大小帽 |
| E2E（M1，headless + 真机） | 创建 → 本地包 → 启用 → `@` 调用 → 关闭；旧 `catalog-legacy` 不丢 |
| E2E（M2） | 创建 → 提交 → CLI 审查/签名 → 发布 → 第二台机器下载/验签/启用 → `@` 调用 → 更新 → 撤销 |
| 安全负例（M1） | 路径穿越；声明外脚本；slug 冲突；沙箱不可用 |
| 安全负例（M2） | 未签名；篡改文件；错误 key；未知 key；撤销版本；降级；重放旧版本；错误 token；额外文件 |
| 回归 | `corepack yarn test`、`corepack yarn typecheck`、`corepack yarn check`、`corepack yarn check:desktop-variants` |

### 11.2 真机验收

- M1：macOS 与 Windows 各跑完整创建 → 本地包 → 启用 → `@` 调用 → 关闭链路。
- M2：macOS 与 Windows 各跑发布 → 下载/验签/安装 → 启用 → 更新 → 撤销链路。
- Windows 记录 sandbox `partial` 执行事实、读/网络边界、安装路径与退出后的进程清理。
- Windows 安装器/发行面当前证据弱；没有真机则不能宣布 M1 完成。
- M2 测试签名密钥与 fixture 包只用于测试；生产私钥不进 CI、不进仓库。

## 12. 里程碑与工作量

| 阶段 | 内容 | 粗略人日 |
|---|---|---|
| M1.0 可行性 spike | 沙箱能否启动长驻 Node HTTP/MCP 进程（macOS + Windows）；Electron/Node 启动路径；宿主拦截与技能注入 | 3–5 |
| M1.1 包模型与创建 | manifest；草稿/propose/commit/原子写；状态存储；`catalog-legacy` 迁移；三页签；会话创建与确认卡；启用/关闭 | 5–7 |
| M1.2 运行链路 | `agent_skill_run`；`agent_http`；MCP 挂载；沙箱 runner；工具白名单；生命周期与清理 | 8–12 |
| M1.3 发布与消费 | **移入 M2，不计入 M1** | 0 |
| M1.4 硬化与验收 | 本地包与运行时负例；macOS/Windows 真机；迁移验收；全量门禁 | 3–5 |

**M1 合计约 19–29 人日**，不含 Windows 真机不可用造成的阻塞。M1.0 结论可能改变 M1.2 估算。

**M2（发布+消费整条链路）约 12–18 人日**：agent-catalog 包接口、签名模块抽取、管理员 CLI、三 token、审计、安装/更新/下架/撤销、签名与安装负例、双平台发布/消费验收。M2 是独立安全项目，可与 M1 分开排期。

## 13. 实施边界

| 模块 | 职责 |
|---|---|
| `dsh-plugin-huaanwork/src/huaanwork-host/agent-package-*`（M1） | 本地包存储、manifest、草稿/提交、状态、`catalog-legacy` 迁移、本地更新 |
| `dsh-plugin-huaanwork/src/huaanwork-host/agent-package-runtime.ts`（M1） | 子代理人设合成、工具名单、HTTP/MCP 进程、沙箱、生命周期 |
| `dsh-plugin-huaanwork/src/huaanwork-guardrails/agent-skill-tool.ts`、`agent-http-tool.ts`（M1） | 两个模型侧宿主工具 |
| `dsh-plugin-huaanwork/src/huaanwork-host/sessions.ts`（M1） | 入口识别、技能注入、`@` 分流、确认原句核对 |
| `dsh-plugin-huaanwork/src/client-huaanwork/AgentsView.tsx` 等（M1） | 三页签、本地包卡片、启停/本地更新交互；M2 再加发布/安装/更新/移除 |
| `skills/create-agent/SKILL.md`（M1） | grill-me 访谈协议、只调用宿主接口、确认卡原样转述 |
| `agent-catalog-server/`（M2） | 目录读、包提交/审批/签名验证、下架申请、撤销、审计 |
| `agent-catalog-admin/` 或同仓 CLI（M2） | pending 列表、bundle 下载、digest 复算、签名、批准/拒绝、下架/撤销 |
| `packages/catalog-signing/`（M2） | canonicalJson、Ed25519 sign/verify、key slot/keyId；market-server 改为引用 |

zero-touch：Stable/Beta 不新增 variant 白名单；所有桌面改动落在 `dsh-plugin-huaanwork/`。M1 不创建 agent-catalog-server/admin/shared signing，也不改 market-server。M2 的新增目录服务与共享签名模块独立于三包；若共享签名抽取改动 market-server，仅限 import/代码位置，不改运行时行为。

## 14. 已接受风险与明确不做

### 14.1 已接受风险

**M1（本地版）**

- 运行时读与网络不隔离；本地包脚本可读取用户文件、发起外联。UI 固定提示，用户启用即知情。
- Windows sandbox `partial`：只保证写限制；读/网络不保证。
- 沙箱 runner 能否启动长驻进程未在代码中验证，M1.0 spike 是硬门槛；不通过则 M1.2 需要改设计，不允许无沙箱运行。
- 生成脚本是模型产物，质量由创建者负责；M1 没有发布审查，脚本只在本机运行。
- 本地包 M1 不提供删除；损坏时用同 slug 更新修复。
- M1 不发布、不分享；本地包只在当前 profile 使用。

**M2（发布版）**

- 审查是人工的，不做恶意代码扫描；签名只证明“谁审过”。
- 一个签名密钥；泄露需撤销版本并轮换，双槽轮换只保留能力不做 UI。
- 信任目录服务的列表/下架/撤销元数据；被攻陷的服务端可以隐瞒更新或继续提供旧的合法签名版本。签名索引 + 防回滚不在 M2 范围。
- 读/发布 token 共享，没有按用户身份区分；审计只能到 token 级别。
- 签名包仍可读取用户文件、发起外联；审查/签名不是运行时隔离。
- 下架不删除已安装副本；撤销才禁用。

### 14.2 M2 之后仍不做

发布+消费整条链路是 M2 的既定范围，不在本节；以下条目在 M2 之后仍不做。

- “以此身份开新会话”与跨轮状态。
- 知识库挂载。
- 跨智能体依赖闭包分发。
- 多密钥轮换 UI、撤销撤销、签名索引/防回滚。
- 审查 UI、自动恶意代码扫描、按用户身份授权。
- 本地创建包的删除；已签名包的就地编辑（更新通过新版本完成）。
- market-server 集成（签名原语共享除外）、插件市场发布。
- Linux 发行。

## 15. 修订记录

- 2026-10-23：融合 A（会话创建 + 侧栏治理 + 目录发布）与 B（宿主门禁 + 包运行时 + 校验）为统一智能体包设计；确定完整脚本能力、审查/签名发布、三页签、macOS+Windows、现有沙箱的真实边界（只限写）。
- 2026-10-23（范围裁定）：M1 只做本地创建/运行/启停与三页签；发布+消费整条链路移入 M2。M1 估算 19–29 人日，M2 估算 12–18 人日。§8 作为 M2 设计保留，不计入 M1 验收。
