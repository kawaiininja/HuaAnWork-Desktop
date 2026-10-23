# 会话内创建智能体包:三轮评审记录(复核后)

- 日期:2026-10-23
- 评审人:Claude(应用户要求对 DeepSeek 产出做对抗性复核)
- 对象:
  - R1:`2026-10-22-chat-created-agents-design.md`(A,Claude 起草)vs `2026-10-23-chat-created-agent-packages-design.md`(DeepSeek 融合规格)
  - R2:融合规格的 2026-10-23 修订(M1 本地版 / M2 发布版切分,commit `962850e6d8`)
  - R3:`2026-10-23-chat-created-agent-packages-m1.md`(M1 实施计划,1006 行)
- 方法:R3 的全部代码锚点经三个并行探查核验(file:line 级),关键结论由主会话再复核;本文只收录复核后仍成立的发现。

---

## R1:A 版设计 vs DeepSeek 融合规格

**结论:DeepSeek 融合规格为实施依据。** 优势不是文风,是它核验出了 A 版的三处事实错误(全部实地复核属实):

| # | A 版断言 | 核验结果 | 证据 |
|---|---|---|---|
| 1 | 「LLM 技能触发」依赖 `whenToUse` 自触发 | **错误**。模型目录不渲染 `whenToUse`,路由只看名称 + 截断 description | `deepseek-harness/packages/skill/tool-skill/README.md` Known Limitations 首条 |
| 2 | persona 智能体条目存入 `agents-endpoints.json` | **错误**。读路径跳过无 `entrypoint.url` 的条目,读出即丢 | `dsh-plugin-huaanwork/src/huaanwork-host/agents-host.ts` `readEndpoints`(`if (!epUrl) continue`) |
| 3 | 启用/关闭「复用现有 `agent.setEnabled` 路径」 | **错误**(对本地条目)。本地条目 `setEnabled` 直接抛错「不能手动更改本地调试入口的启用状态」 | `agents-host.ts:538-540` |

A 版仍有的价值:轻治理与「个人效率助手」场景匹配、范围克制。这些已被融合规格的 M1/M2 切分吸收(见 R2)。A 版文件头已标注被取代,保留为历史输入。

## R2:融合规格的 M1/M2 切分修订

**结论:修订质量好,可作为实施依据。** 四处改对了:

1. 反夸大护栏:「M1 验收不得声称发布已交付」写进成功标准。
2. 数据模型分期干净:`publishStatus`/`publishedVersion`/`.signature/`/`source: catalog` 全部标 M2。
3. 迁移路径变安全:M1 只标 `catalog-legacy`,不下载不物化;「不得用未签名本地物化包冒充目录包」红线保留。
4. 估算诚实:M1 19–29 人日 + M2 12–18 人日分开计价。

三个留意点(已在评审时向用户声明,待确认):
- M1 没有发布按钮,原始需求中的「发布到公共市场」整体在 M2。
- UI 落位从 A 版头脑风暴裁定的「侧栏新区块」变为 AgentsView 三页签(R5),属未明示的裁定覆盖。
- M1 成本大头仍在 R2(脚本生成):M1.2 运行链路 8–12 人日 + M1.0 沙箱 spike 硬门槛。

## R3:M1 实施计划评审(锚点全量核验后)

**结论:ITERATE。** 锚点准确率远高于平均:`ctx.sandbox.confine`(签名吻合,实际返回还多 `denialSignatures`/`runnerFailureRules` 两字段)、`defineTool`、`attachAgentTools`/`detachAgentTools`、`refreshAgentRestrict`(present-as.ts:81-97)、`mountSessionMcp`(agent-mcp.ts:11-74)、`dispatchAt`(agent-invoke.ts:65-74)、`setAgentsDirectory` 模式(sessions.ts:459-468)、`ROUTE_TABLE`/`storeRoute`/`RouteError`(routes.ts:190/:154/:115)、`EnableConfirmModal`/`AddEndpointModal`(AgentsView.tsx:391/:449)、`noteTab`/`applyEvent`/`onSidecarEvent`(App.tsx:617/:1021,api.ts:212)、`market-view.spec.ts` 的 createRoot+act 形态、`AGENT_NAME_RE`(`@huaanwork/policy/agent-catalog`:25,与计划所给正则逐字符一致)、「present-as 无需白名单新增」(`ALLOWED_TOOLS` + `sessionAgentTools` 机制,present-as.ts:119-135)——全部属实。

复核后仍成立的发现如下(含复核中对初判的修正):

### P0-1 事件命名自相矛盾且违反仓库惯例(确认,需同时修规格)

- 计划文件内两种写法并存:斜杠式 `agent/changed`(:82、:86、:587、:803、:845、:911、:919)与点式 `agent.changed`(:433、:833、:841,后两处是路由代码块)。
- 仓库惯例:58 个 RPC 方法全点式、全部事件全斜杠式(`session/end`、`automation/run-start`、`sidecar/status`…),点式事件零先例。
- 失效模式:客户端 `applyEvent` 订阅 `agent/changed`,路由发出 `agent.changed` ⇒ 永不命中,侧栏/页签不刷新,**静默**。
- 修法:全部统一为 `agent/changed`;规格 §9.2 的 `agent.changed` 同步订正为 `agent/changed`。

### P0-2 新增 4 个 RPC 撞测试钉死的「58 方法」计数(复核后由 P1 升级为 P0)

- `dsh-plugin-huaanwork/tests/client-huaanwork/api.spec.ts:139-140` 断言 `Object.keys(ROUTES)` 恰好 58;:76 的期望表逐条对应 ROUTE_TABLE。
- `dsh-plugin-huaanwork/tests/huaanwork-host/route-contract.spec.ts:333-338` 断言双端方法总数恰好 58 且集合一致;:342 起还有逐方法 HTTP 动词/Path/必含键比对。
- 计划全文未提及这两个文件(grep 零命中)。新增 `agent.packageList`/`agent.packageDetail`/`agent.packageSetEnabled`/`agent.invocableList` 后,这两个测试**立即变红**,且期望表要逐条补 4 行,不是只改一个数字。`api.ts:13` 头注释「58 方法」同步更新。
- 修法:Task 7 增加一步「更新 api.spec.ts 期望表与 route-contract.spec.ts 的 58→62 及逐方法期望」。

### P0-3 catalog-legacy 启停状态的存放位置:规格与计划不一致(复核后重新定框)

- 规格 §5.3 的 `agents-state.json` 示例含 `"catalog:legacy-assistant": { source: "catalog-legacy", … }`,即 legacy 状态在新状态文件;§5.1 同时写「旧启用表 `agents-enabled.json` 保持只读」。
- 计划的选择相反:legacy 启停走旧路径 `agentsHost.setEnabled(name, enabled, true)`(写 `agents-enabled.json`),`AgentPackageState` 类型只含 `source: 'local'`(计划 :240),Task 9 测试也是 seed `agents-enabled.json`。
- 计划的做法(零状态迁移、复用旧路径)更简单更稳,**建议采纳计划、订正规格**:§5.3 示例移除 legacy 条目、§5.1「保持只读」改为「由旧路径独占读写,包代码不直接写」。若反过来采纳规格,则计划的类型必须扩 `source: 'local' | 'catalog-legacy'` 且 Task 7/9 改写。两者必择一,不能都留。

### P1-1 确认卡降级为纯文本 note,未声明(规格偏差)

- 规格 §6.2 第 4 条:「宿主同时向会话写入一张**结构化确认卡**,客户端优先渲染它」。
- 计划 Task 8:`agent/notice` → `noteTab` 追加纯文本 note,无结构化渲染。
- 裁剪本身可接受(M1),但需显式裁定:要么订正规格为「M1 确认卡以纯文本 note 呈现」,要么计划补结构化渲染。文案内容(宿主生成、模型不得改写)两版一致,无安全问题。

### P1-2 `restrict` 缺 schema 交集过滤(复核后由 P0 降为 P1,附理由)

- 既有 `subagents.start` 包装器在 restrict 前把 allow 与 `tools.schemas()` 求交集(skills.ts:230-236);计划 Task 6 Step 4 直接 `restrict({ allow: pkg.allow })`。
- 降级的理由:计划的 allow 名单来源(全局注册的 `agent_skill_run`/`agent_http`、`mountSessionMcp` 当轮返回的名字、基础工具)在理论上都存在于 schemas,不过滤不致立即出错。
- 仍建议镜像既有过滤:既有的过滤存在即说明上游对「allow 含不存在工具名」的行为不做保证;镜像成本一行。

### P1-3 `composeAgentPackagePersona` 签名前后不一致

- 计划 :665 测试用一参 `composeAgentPackagePersona(pkgDir)`;:683 实现定义为三参 `(packageDir, manifest, profileDir)`。统一为三参(测试补 manifest/profileDir)。

### P1-4 Task 9 Step 1 标题误用「迁移」

- :946「补 catalog-legacy 迁移测试」——修订后的 M1 明确不做迁移,该步内容是兼容(显示/启停/不丢)。改标题为「补 catalog-legacy 兼容测试」,防止实施者把迁移做回来。

### 复核后撤销的初判

- 初判 P0-2「`AgentPackageState` 类型收窄错误」:复核发现计划在 legacy 状态存放上**内部自洽**(全走旧路径),类型与计划自身不冲突;真正的问题是计划与规格 §5.3 的存放位置分歧,已重写为现 P0-3。
- 初判 P0-4「缺 schema 交集过滤」:降级为 P1-2,理由见上。

---

## 处置建议

1. P0-1/P0-2/P0-3 修订计划文件(P0-1、P0-3 还需同步订正规格),预计半小时内。
2. P1-1 提请用户裁定(纯文本 note vs 结构化卡)。
3. P1-2/P1-3/P1-4 随计划修订一并改。
4. 全部处置完成后,M1 计划可进入 subagent-driven-development 执行。

---

## 处置复核(2026-10-23,对 commit `c2551989ef` + `ea592e76f9`)

DeepSeek 按本评审修订后逐条复核,七项全部处置,复核新发现两个小项:

| 审阅项 | 复核结论 |
|---|---|
| P0-1 事件命名 | ✅ 计划内点式 `agent.changed` 零残留(grep 复核);规格 §6.3、§9.2 同步改为 `agent/changed`;新增 `agent/confirm` 亦为斜杠式 |
| P0-2 58→62 | ✅ Task 7 新增 Step 4,`EXPECTED_ROUTES`(api.spec.ts:77,命名属实)补四行、计数断言与 `api.ts` 头注释同步;⚠️ N-1 见下 |
| P0-3 legacy 状态位置 | ✅ 采纳计划路径;规格 §5.1 改「旧路径独占读写」、§5.3 移除 legacy 示例;计划路由的本地包判断由 `detail()` 改为 `listLocal().some()`,并记录了理由(损坏 manifest 不误走 legacy 分支)——优于原方案 |
| P1-1 确认卡 | ✅ 采用结构化卡:`AgentPackageConfirmCard` 类型 + `agent/confirm` 事件 + `AgentConfirmCard.tsx` + 专项测试(断言无可点击「创建」按钮,创建只能由会话同意句触发);规格估算 +0.5–1 人日已计入(20–30) |
| P1-2 restrict 交集 | ✅ 计划代码已镜像 skills.ts 的 schemas 交集过滤,且补了对应测试覆盖行 |
| P1-3 persona 签名 | ✅ 测试与实现统一为三参,测试补 imports 说明 |
| P1-4 「迁移」措辞 | ✅ 计划 Task 9 标题、规格测试矩阵/里程碑已改「兼容」;⚠️ N-2 见下 |

### 复核新发现(均为 nit 级,改完即闭环)

- **N-1**:`route-contract.spec.ts` 的「58」共 7 处(:8、:64、:67 注释,:333、:342 测试标题,:337、:338 断言),计划 Step 4 写「两处 58 改为 62(含测试标题)」计数不足;7 处都应改,否则注释成为陈旧谎言(本仓对文档诚实性有明确要求)。
- **N-2**:计划 Task 8 Step 2 引用的 `ChatRow` 组件在 App.tsx 中**不存在**——`ChatItem` 联合类型在 App.tsx:212-221(属实),但渲染是内联 JSX,无独立行组件;实施时应改为「扩展 ChatItem 联合 + 在内联渲染分支中加 `agent-confirm` 分支」。另规格 M1.4 里程碑行残留「迁移验收」一词(其余「迁移」已清)。

### 处置表中的保留意见

Review Disposition 表对 R2「UI 落位未明示」一项记「不采纳:用户已明确选择 AgentsView 三页签」。该用户裁定发生在 DeepSeek 侧会话,本评审无法独立核实;若用户确认属实,此项闭环,规格 R5 即为权威记录。

**结论:七项评审发现全部妥善处置,修订质量高(多处超出最低要求,如 P0-3 的 listLocal 改进)。修完 N-1/N-2 两处 nit 后,M1 计划达到可执行状态(OKAY)。**
