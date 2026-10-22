# 会话内新建智能体(对话触发 + 侧栏管理 + 目录发布)设计

日期:2026-10-22
状态:设计已确认(头脑风暴四节均过),待实施计划

## 1. 背景与目标

用户期望:在会话框输入「帮我新建一个智能体」「帮我建一个数字员工」类自然语言,即在会话页启动新建智能体流程;通过 grill-me 式逐问澄清需求;澄清完成后构建智能体;建好的智能体出现在左侧边栏「智能体」区块下,展示名称与能力简介,并提供启用/关闭/发布按钮;点发布后上传至公共目录,其他人可见可用。

典型场景(头脑风暴已确认):**个人效率助手** —— 员工为自己搭助手(合同审查员、周报生成器),自己建、自己用,发布是顺带分享给同事。治理从简。

## 2. 已确认的关键裁定

| 裁定 | 结论 |
|------|------|
| 智能体本质 | persona + 挂载能力(技能 + 工具条目 http/mcp);知识库首期不做 |
| 能力选择方式 | LLM 根据澄清出的用途从实时目录推荐,用户确认 |
| 触发方式 | LLM 技能触发(内置技能 whenToUse 自触发),`/create-agent` 硬触发兜底 |
| 落库机制 | host 工具调用(复用 call_host_tool 接线),不解析 LLM 自由输出 |
| UI 落位 | 侧栏新区块直接展示:名称 + 一行简介 + 启用/关闭/发布按钮 |
| 发布目的地 | 公用机 agents 目录服务(AgentsView 发现页同源) |
| 发布鉴权 | 与读同一个 Bearer(`AGENT_CATALOG_TOKEN`),内网信任模型 |
| 远端生命周期 | 更新(同名再发,version 单调增)+ 下架(DELETE)都做 |
| 总体方案 | 方案 A:技能驱动访谈 + host 工具落地 |

## 3. 现状地形(探索结论,实施前需复核行号)

- 侧栏为 `dsh-plugin-huaanwork/src/client-huaanwork/App.tsx` 硬编码 JSX(约 :2344 起);「智能体」导航项(:2372)打开整页 `AgentsView.tsx`,侧栏无智能体列表;`ProjectsPanel.tsx` 是侧栏 section 的仿写样板。
- 发送链路拦截先例:`parseSchedulePhrase`(App.tsx:1711 附近)把 NL 短语客户端重路由;`parseSlashInvoke`/`parseAtInvoke` 处理 `/` 与 `@` 硬调用;`rpcCall("session.send", …)` 在 App.tsx:1885 附近。
- 智能体数据模型:`huaanwork-host/agents-host.ts`(685 行),`AgentListItem`/`AgentDetail` 定义于 `logic/agentsLogic.ts:5-29`;本地条目存 profile 目录 `agents-endpoints.json` + `agents-enabled.json`(agents-host.ts:82-165);**现状本地条目只支持 `kind:"tool"`(AgentsView.tsx:539-543)**。
- `@名字` 调用:`agent` kind → 载入 persona → `ctx.subagents.start("spawn", …)`(`agent-invoke.ts:149-201`);`tool` kind → `<tool-invoke>` 信封(agent-invoke.ts:83-144)。
- 技能体系:`dsh-plugin-huaanwork/skills/`(24 个内置,含 `grill-me`);`skills-host.ts` 负责扫描/CRUD/启用态,`invokeSkillText`(`skill-invoke.ts:64`)为 `/name` 硬调用路径。
- 目录服务端:M-A0 规划的零依赖 Node 服务,`GET /v1/catalog` + `GET /v1/catalog/<name>`,entries/ 目录现读,Bearer(timing-safe),LAN 绑定,`AGENT_CATALOG_TOKEN`(见 `2026-10-13-agents-catalog-integration-design.md` §3.4)。**所有仓库现无生产目录服务端**;参照物 `HuaAnWork/scripts/agent-catalog-mock.mjs`。
- market-server 的签名清单/双槽钥/fail-closed 体系与本特性无关(发布不走 market-server)。

## 4. 架构与数据流

```
[会话页] 用户: "帮我新建一个智能体"
   │  LLM 命中内置技能 create-agent(whenToUse 自触发 / /create-agent 硬触发)
   ▼
[grill-me 访谈] LLM 按技能协议逐问澄清:用途 → 名称 → 推荐挂载能力(技能+工具)
   │  LLM 上下文里带「可用能力清单」(host 注入:启用的技能 + 已配工具条目)
   ▼
[确认卡] LLM 汇总定义,用户答「可以」
   ▼
[host 工具] create_local_agent({name, description, whenToUse, persona, mounts[]})
   │  复用 call_host_tool 接线 → agents-host 新增本地 agent 条目写入
   ▼
[侧栏新区块「智能体」] 列出本地创建条目:名称 + 一行简介 + 启用/关闭/发布
   │
   ├─ 启用/关闭 → 现有 agent.setEnabled 路径
   └─ 发布 → host POST {catalog}/v1/catalog(同 Bearer)→ 他人发现页可见
       取消发布 → DELETE {catalog}/v1/catalog/<name>;再发 = 覆盖更新(version 单调增)
```

三条链路可独立测试、独立交付:**创建链路**(技能+工具+agents-host)→ **管理面**(侧栏区块)→ **发布链路**(目录服务端写接口+发布客户端)。创建链路不依赖目录服务端落地。

## 5. 数据模型

本地智能体条目(profile 目录 `agents-endpoints.json`,与本地工具条目同文件,靠 `kind` 区分):

```jsonc
{
  "name": "周报小助手",            // 唯一键;中英文皆可;与目录条目同名校验
  "source": "local",
  "kind": "agent",                 // 本次放开:现状本地只允许 "tool"
  "description": "一句话能力简介",
  "whenToUse": "什么时候该叫它",
  "persona": "角色设定全文",
  "mounts": [                      // 新字段:挂载能力
    { "type": "skill", "name": "explore" },
    { "type": "tool",  "name": "jira-http" }
  ],
  "enabled": true,
  "version": 1,
  "published": { "at": "2026-10-22T…", "version": 3 } | null
}
```

目录服务端条目:entries/ 目录每名一个 JSON 文件,形状 = 现有 catalog 条目契约 + `mounts`。发现页客户端无需改动即可展示(persona 本就下发)。`mounts` 对他人是**声明式引用**:启用他人智能体时,缺失的挂载在详情里标出,不自动安装(MVP 不做依赖分发)。

约束:name 本地唯一;发布时客户端携带本地 `version`,与远端同名即更新、服务端要求该 version 严格大于远端现存(拒绝即 409,客户端引导用户本地升版后重发);`mounts` 引用名在创建时必须存在(host 工具校验,防 LLM 幻觉挂名)。本地 `version` 的递增时机 = 每次修改 persona/mounts 等实质字段时 host 侧自增;首次发布前恒为 1。

YAGNI(刻意不做):挂载能力的依赖闭包分发;agent 的 argumentsSchema/entrypoint(纯 persona 不需要);知识库挂载;market-server 方向的发布。

## 6. 组件改动细目

| # | 组件 | 位置 | 改动 |
|---|------|------|------|
| 1 | create-agent 技能 | `dsh-plugin-huaanwork/skills/create-agent/SKILL.md`(新增) | 内置技能,userInvocable + 模型可触发;技能体 = grill-me 访谈协议(逐问、一轮一问)+ 落库前必须给出确认摘要 + 确认后调用 `create_local_agent` 工具的指令 |
| 2 | host 工具接线 | `huaanwork-host/`(复用 call-host-tool 体系,见 2026-10-14 设计) | 新工具 `create_local_agent`:入参即 §5 条目(不含 enabled/published);校验 name 唯一、mounts 引用存在、字段长度上限;写 `agents-endpoints.json` 并即时 `enabled=true` |
| 3 | agents-host 放开本地 agent | `agents-host.ts` + `AgentsView.tsx:539` | 本地条目允许 `kind:"agent"`;`@名字` 路由与 spawn 路径对 local agent 与 catalog agent 同形处理 |
| 4 | 侧栏「智能体」区块 | `client-huaanwork/App.tsx`(仿 `ProjectsPanel` 加 `AgentsPanel`) | 位于「任务」「项目」两 section 之间;每行:名称 + 一行简介 + 启用/关闭切换 + 发布/取消发布按钮;点击行 → 跳 AgentsView 对应条目;新 RPC:`agent.publish` / `agent.unpublish`(落库只经 host 工具,客户端不开第二条写路径);host 工具落库成功后由 host 通知客户端重拉 `agent.list` 刷新侧栏 |
| 5 | 目录服务端写接口 | 目录服务(M-A0 服务,随本次同期实现) | `POST /v1/catalog`(同 Bearer,timing-safe;同名要求 version 单调增)、`DELETE /v1/catalog/<name>`;写 = entries/ 目录落/删文件,原子写(tmp+rename);schema 校验 + 大小上限 |
| 6 | 发布客户端 | `agents-host.ts` 新增 publish/unpublish | 带 Bearer POST 本地条目(剔除 enabled/published 本地态);失败分类 TRANSPORT/TIMEOUT/AUTH/CONFLICT,UI 诚实报错 |

## 7. 错误处理

| 场景 | 行为 |
|------|------|
| LLM 幻觉挂载不存在的技能/工具 | host 工具校验拒绝,错误信息列出有效名字,LLM 可自纠一轮 |
| 同名本地条目已存在 | 工具返回 CONFLICT,提示改名或先删除,不覆盖 |
| 访谈中途用户放弃 | 技能协议允许任何时刻退出,未调工具即零写入 |
| 目录服务不可达/超时 | 发布报 TRANSPORT/TIMEOUT,本地条目不受影响,可重试 |
| 发布 version 不增 | 服务端 409 CONFLICT,提示「已有人发布同名,请升版或换名」 |
| Bearer 错误 | 401 AUTH,UI 指向目录 token 配置 |
| 写盘失败 | 原子写(tmp+rename),失败不留残件 |
| 启用挂载缺失的他人智能体 | 启用前标出缺失挂载名;允许启用,@ 调用时提示缺哪项 |

## 8. 测试

全部 headless(符合仓库「图形启动显式化」纪律):

1. agents-host 单测:本地 `kind:"agent"` 条目 CRUD、启用态持久化、name 唯一、mounts 引用校验、原子写。
2. host 工具单测:`create_local_agent` 入参校验矩阵(缺字段/超长/幻觉挂载/重名)。
3. 目录服务端单测(M-A0 同型):POST 创建/同名低版本 409/同名高版本覆盖、DELETE、schema 拒绝、timing-safe Bearer、并发写。
4. 发布客户端单测:mock catalog server,覆盖 TRANSPORT/TIMEOUT/AUTH/CONFLICT 四分支与 published 状态回写。
5. 访谈技能契约测试:frontmatter 合法、含工具调用指令;不测 LLM 行为本身。
6. 侧栏区块组件级测试:行渲染、三按钮回调、发布态显示(沿用现有 client 测试模式)。
7. 回归:`corepack yarn test` + `check:desktop-variants`(本设计不动三包共享文件,预期零白名单成本)。

## 9. 依赖与风险

- **依赖 M-A0 目录服务端**:发布链路(组件 5/6)需要目录服务端存在;创建链路与管理面不依赖,可先交付。
- **LLM 访谈不确定性**:靠技能协议约束 + 落库前确认卡 + host 工具硬校验三层兜底;不测 LLM 行为,只测校验与接线。
- **同名抢注**:内网同 token 开放发布,A 的「周报助手」可能被 B 的发布覆盖——靠 version 单调增只能防降级不能防抢注;个人助手场景下接受,组织级治理留待后续。
- **zero-touch 纪律**:全部改动落在 `dsh-plugin-huaanwork` 与(新)目录服务仓库/目录,不动 `dsh-plugin-desktop/`、`dsh-plugin-desktop-beta/`。
