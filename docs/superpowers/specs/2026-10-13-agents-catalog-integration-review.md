# 《三个智能体接入侧边栏「智能体」模块》设计文档评审意见

- **评审对象**:`docs/superpowers/specs/2026-10-13-agents-catalog-integration-design.md`(方案 A)
- **评审日期**:2026-10-14
- **评审方式**:对抗性审查——逐条证伪 §2「只读事实」、推演异步协议与平台硬约束的相容性、攻击安全假设、拷问工作量边界,全部结论附代码级出处
- **评审结论**:~~待评审~~ → **有条件通过**(P0 澄清 + P1 修订后可直接实施,无需整体重审)
- **复审**:2026-10-14 通过,遗留 1 项 P2 级澄清(R2-1,见 §九)——不阻塞按修订稿开工
- **实施计划评审**:2026-10-14 **达到开工标准**,2 处 P2 开工前顺手修订(F1/F2,见 §十),其余 P3 随实施消化

---

## 一、事实核查结果(§2「只读事实」逐条比对)

| # | 文档声称 | 核查结果 | 出处 |
|---|---------|---------|------|
| 1 | 目录条目字段(name 小写 slug / description ≤1024 / whenToUse / argumentsSchema / permissions / timeoutMs) | ✅ 一致 | `packages/huaanwork-policy/src/agent-catalog.ts:25,95,149-158` |
| 2 | 调用链:@name → `<tool-invoke>` 信封 → 第一动作 `call_host_tool(name, arguments)` | ✅ 一致 | `dsh-plugin-huaanwork/src/huaanwork-host/agent-invoke.ts:94` |
| 3 | POST `entrypoint.url`,body `{"arguments": {...}}`,`content-type: application/json`,按配置附 Bearer | ✅ 一致 | `dsh-plugin-huaanwork/src/huaanwork-guardrails/agent-tool.ts:186-199` |
| 4 | 单次超时 `clampTimeoutMs` 默认 60s、硬顶 150s 不可超 | ✅ 一致 | `agent-catalog.ts:46-51` |
| 5 | 工具输出上限 32KiB,超出截断 | ✅ 一致 | `packages/huaanwork-policy/src/truncate.ts:1`;`agent-tool.ts:218-219` |
| 6 | 非 2xx 视为失败,状态码 + 前 500 字符交模型 | ✅ 一致 | `agent-tool.ts:201-215` |
| 7 | **「桌面端不解析该形状,ok/error 是给模型读的」** | ❌ **不符——桌面端实际解析** | `agent-tool.ts:233-256` |
| 8 | (§5)「桌面端 150s 超时 → ABORTED」 | ❌ 超时标签为 **TIMEOUT**,ABORTED 专指用户取消 | `agent-tool.ts:267-282` |

**核查中发现的、文档未记载但影响设计的补充事实**:

- 响应体**读入上限为 1MiB**(`packages/huaanwork-policy/src/http-cap.ts:1` `CATALOG_BODY_LIMIT`),32KiB 截断发生在读入之后。对分页设计无影响,但意味着 >32KiB 的响应不会被拒绝而是被截断成**不合法 JSON**,桌面端回落为纯文本仍然"成功"返回(`agent-tool.ts:222-231` 的 JSON.parse 双重失败路径)——分页纪律必须真正守住,不能指望平台兜底报错。
- `argumentsSchema` 序列化注入模型上下文的上限是 **1024 字符**,超出截断(`agent-tool.ts:76` `SCHEMA_HINT_LIMIT`)。task-orch 有 8 个 action,条目 schema 要刻意精简(见 P3-4)。
- **本地入口(联调路径)的 `timeoutMs` 硬编码 60s、无 whenToUse 字段**(`dsh-plugin-huaanwork/src/huaanwork-host/agents-host.ts:387,677`)。与目录条目 `timeoutMs: 60000` 默认一致,故联调与正式目录行为等价,设计兼容——但联调时**无法实测上调超时的效果**。
- `call_host_tool` 执行期读的运行时快照完整携带 `entrypoint.url`/`timeoutMs`/`argumentsSchema`(目录与本地入口皆然,`agents-host.ts:642-682`),@点名 → HTTP 工具全链路对两类条目均已走通。「桌面端零改动」的调用面主张成立。
- 每条目解析时 `entrypoint.url` 强制校验为**局域网或本机地址**(`agent-catalog.ts:118-127`,`isLanEndpoint`)——§3.4 的 `http://<公用机>:<port>` 形态满足,但条目 URL 不得出现公网地址,部署时注意。
- 本地入口存在(「发现 / 已启用 / 本地入口」三页签 + 「＋ 添加入口」表单,`AgentsView.tsx:21-25,449-611`),表单支持 name / http URL / description / argumentsSchema,不支持 timeoutMs / whenToUse——§4.3 的联调路径真实可用。

**三个智能体现状核对**(§1/§3.3 的事实主张):

- code-review:同步串行 + busy 锁、`MAX_INCLUDE=3`、`MAX_TASK_LEN=2000`、`CODE_REVIEW_MOCK=1` 均属实(`server.mjs:27-33,101,193-206`)。
- task-orch:HTTP 服务为**只读**看板 + `/health` + token 认证,`run/pause/resume/show` 目前仅存在于 CLI 通道;`DASHBOARD_TOKEN` 与 1s 防抖(防抖状态持久化在 DB,跨进程生效)属实(`src/server.ts`;`src/cli.ts:72-113,78`)。
- typo-check:typoguard 为纯 Python 库(python-docx + openai),`eval/` 与 M1-M3 验收脚本、`scripts/_resume_drill.py` 均存在;另有 `TYPOGUARD_VERIFIER_MOCK` 假车道(`src/typoguard/config.py:52`)——但注意它只 mock 校验器,smoke 全链是否够用见 P3-8。

---

## 二、必须澄清(P0)

### P0-1 目录服务的实现与运维归属未写明

桌面端只实现了目录**客户端**:`GET {root}/v1/catalog`(列表)+ `GET {root}/v1/catalog/<name>`(详情),均带 Bearer(`agents-host.ts:278,418-422`)。§3.4 说条目是「公用机目录侧配置,非桌面仓库文件」,§4.2 说「沿用既有纪律」——但**本仓与三个智能体仓库中均无 `/v1/catalog` 服务端实现**。

- 若公用机已有现成目录服务(此前部署成果),请在 §3.4/§4 中指明其实现位置、运维归属、条目发布流程(谁改、谁审、怎么生效);
- 若尚不存在——三个智能体即是目录的**首批条目**——则 M-A4 缺少「目录服务端」整块工作量(哪怕是静态 JSON 文件服务 + Bearer 校验),5-6 天估算不成立,需单列里程碑。

这是方案 A 主路径(目录下发)的核心依赖,联调虽然可走本地入口绕开它,§7 第 4 步(切目录)绕不开。**必须在合入前澄清。**

---

## 三、必须修订(P1)

### P1-1 §2 事实错误:「桌面端不解析该形状」必须更正

`agent-tool.ts:233-256` 实际解析响应形状:

- `{"ok": false, "error": ...}` → 工具结果标记 **`isError: true`**,错误文案交模型(§5「模型可自我修正后重试」依然成立,行为无恙);
- `{"ok": true, "result": ...}` → 结果携带提取后的 `result` 字段。

「只读事实」章节出现与代码相反的断言,会误导实现者把 `ok:false` 当作"不产生错误语义的正常通道"使用(例如用它表达流程分支)。设计本身的响应约定**无需改动**(与桌面端解析行为恰好是配套的,`server.mjs:5-7` 的注释也印证了这一点),但文档表述必须修正为:「桌面端会解析 ok/error:ok:false 将作为工具错误(isError)呈现给模型,故 ok:false 只用于失败与拒绝语义;正常流程态(如排队中、运行中)一律走 ok:true + state 字段」。顺带:文档对两个 TS 文件的定位写法宜补全为 `src/huaanwork-host/agent-invoke.ts` 与 `src/huaanwork-guardrails/agent-tool.ts`。

### P1-2 typo-check 的 `path` 参数构成公用机任意 docx 读取面,必须加服务端根目录约束

`submit` 的 `path` 是「公用机本地绝对路径」,由模型代用户组参,服务端会读取全文并送 LLM。当前设计只校验「存在性 + 后缀」——等价于向**所有持有目录口令的聊天用户**开放整机 .docx 读取。§3.3.1 的括号注释「(公用机共享目录)」是意愿,不是约束。修订要求:

1. 服务端配置允许根目录(共享目录),`path` 必须落在根之下;
2. 校验前先 `realpath` 归一化,再做前缀判断(防 `../` 与符号链接穿越);
3. 越界返回 `ok:false`,文案中文指明「仅支持共享目录内的文档」。

code-review 的 `root` 攻击面更宽,但其产品用途就是审查机上任意工作副本,且 `include` 已限一级目录名(`server.mjs:71-75`),建议在 §5 登记为已接受风险即可,不强制收窄。

### P1-3 §5 错误表标签修正

- 「桌面端 150s 超时」行:表现为 **TIMEOUT**(「公用机小工具「X」调用超时(TIMEOUT)」,`agent-tool.ts:277`),ABORTED 专指用户主动取消(`agent-tool.ts:175,269`);
- 「口令错误/缺失」行:模型收到的是 `HTTP 401: <响应体前 500 字符>`;task-orch 现行 401 响应体为 `{"error":"unauthorized"}`(`server.ts:84`),文案对模型可读性一般,三服务统一时建议给中文文案(顺手项,不强制)。

---

## 四、建议修订(P2)

### P2-1 分片余量按「序列化后字节」计算,不按 text 字符数

§3.2 约定「每片 text ≤ 24KiB」。但 32KiB 帽作用在**整个 JSON 响应文本**上(`capToolOutput` 按 UTF-8 字节计),而 `JSON.stringify` 会把换行、引号、反斜杠各膨胀为 2 字节。Markdown 报告换行密度高:24KiB 的分片中若 30% 是换行,序列化后约 31KiB,已贴 32KiB 帽;一旦超帽,响应被截断成**不合法 JSON**,桌面端回落纯文本(见 §一 补充事实),`hasMore/offset` 可能恰好被截掉,模型无法续拉。修订:包装层以 `JSON.stringify(response)` 的 UTF-8 字节数 ≤ 24KiB(或收紧 text 切片到 20KiB)为准。

### P2-2 task-orch `run` 的调度语义未指定,两案权衡不同

CLI 现状是**每次新建临时 Scheduler** 触发,显式注释「CLI 单任务触发不受全局并发上限影响;并发上限仅后台调度生效」(`cli.ts:80`)。HTTP 适配路由可选:

- **复用守护进程自身的 Scheduler**(受全局并发上限约束,与后台调度一致——建议采用并写明);
- 临时 Scheduler(绕开上限,与 CLI 语义一致)。

两案均保留 1s 防抖(防抖已持久化在 DB,`cli.ts:78`)。设计文档应写死选型,避免实现期随手选了与守护调度相抵触的一案。

### P2-3 防模型连续轮询的引导写入目录条目

`<tool-invoke>` 信封只约束**第一动作**(`agent-invoke.ts:94`);`status` 返回 running 时,模型可能在一个回合内连续轮询空转。三个条目的 `description`(或 `whenToUse`)应明确:「status 返回 running 时,直接告知用户预计时长与 jobId、请稍后再来查询,不要连续轮询」。顺带建议 description 提示模型**把 jobId 显著复述给用户**——用户跨会话回来取结果时全靠它。

### P2-4 作业结果跨用户可见性:登记为已接受风险

目录口令全局一把,服务端无法区分用户;jobId 会出现在各用户的聊天记录中。任何口令持有者可对**任意已知 jobId** 调 `status/result`。内网信任边界下可接受,但属于 §5 错误处理表未覆盖的信任假设,应显式记账(一行即可)。

### P2-5 task-orch 的 LAN 绑定是对其既有安全姿态的显式放宽,应记账

其源码自我要求「强制绑定回环地址,避免公网暴露管理端口(P0-H1)」(`server.ts:33`),且非回环绑定时 query-token 自动关闭(`server.ts:28-31`)。§4.1 的 LAN 绑定是有意放宽,文档应把这三点写为接受的姿态变化:LAN 绑定 + query-token 关闭 + 双 token 隔离(DASHBOARD_TOKEN / 目录口令互不相干),而不是静默改约束。

---

## 五、可选改进(P3)

1. **`expired` 状态枚举无可达路径**:§3.2 说 24h 后清理、`status` 返回「不存在或已过期」的 ok:false——那 `state: "expired"` 永远不会被返回。要么从枚举删除,要么定义返回时机(如:清理前最后 1 小时返回 expired 提示)。
2. **M-A1 范围点名三项**:server.mjs 现状无任何鉴权、`HOST` 硬编码 `127.0.0.1`、不校验请求路径(`server.mjs:28,159-163`)。作业化重构应明确含:Bearer 校验、HOST 可配置、`/invoke` 路径匹配——避免 1-1.5 天估算被隐性需求击穿。
3. **目录条目补 `version` 字段**:面板展示 version,parse 端容忍缺失,但首版条目带上版本号是零成本的规范。
4. **task-orch schema 注入上限**:8 个 action 的 schema 序列化后须 < 1024 字符(`agent-tool.ts:76`),否则截断处可能落在 `required` 上,模型看不到必填约束。逐字段写短 description,别写长句。
5. **runs/alerts 50 条上限的尺寸兜底**:50 条含长 error 字段的执行记录序列化后可能逼近 32KiB。组装响应时对序列化字节数做兜底(超限自动降 limit)。
6. **Bearer 比较建议 timing-safe**(三个新包装服务);给出三服务端口分配表;目录口令的环境变量名统一约定(如 `AGENT_CATALOG_TOKEN`)。
7. **§7 单测清单补「24h 过期清理」**;作业存储的并发写(SQLite WAL 或写锁)在单测中覆盖。
8. **typo-check smoke 车道核实**:`TYPOGUARD_VERIFIER_MOCK` 只覆盖校验器;若全链 mock 需要更多桩,M-A2 的 2-2.5 天要计入(或按文档所说退到「最短 fixture 文档走真车道」,但那样单次质检耗时不可忽略)。

---

## 六、设计亮点(审查中确认站得住的部分)

1. **方案 A 与平台契约严丝合缝**:150s 硬顶逼出的 submit/status/result 统一词汇,是对不可协商约束的正确回应;三智能体共用一套异步协议,模型只需学一次。
2. **只分页、不搞「摘要 + 落盘」双风格**——少一个分支少一类漂移,YAGNI 清单(§9)边界清晰。
3. **interrupted 诚实标记**与 task-orch 既有状态词汇(`server.ts:13`)一致;断点续扫克制地登记为实现期核实项而非承诺。
4. **本地入口先行联调**是聪明的降险设计:绕开 P0-1 的目录依赖,且与正式路径行为等价(超时同为 60s),还天然成为回归工具。
5. 24h 保留、jobId base62×12(约 71 bit 不可枚举)、busy 不排队——边界条件都替模型与用户想好了。
6. M-A1/A2/A3 三线并行结构成立,互相无依赖。

---

## 七、评审结论

**有条件通过。**

- **合入前必须完成**:P0-1 澄清(目录服务归属/工作量)、P1-1 与 P1-3 事实修订、P1-2 根目录约束写入 §3.3.1;
- **建议随修订一并落**:P2-1 ~ P2-5;
- P1 修订均为文档/设计条目级改动,不推翻方案骨架;修订后**无需整体重审**,P0-1 的答复若引出新工作量(目录服务端),该部分单独立项评审即可。

—— 完 ——

---

## 九、复审记录(2026-10-14,针对修订稿)

**复审对象**:设计文档 v2(状态行「评审修订完成」、§10 修订记录)

### 9.1 处置核对:16/16 条发现全部落入,且经抽查核实非表面应付

- **P0-1** → 新增 §3.4「目录服务端(本次新建)」+ M-A0(1–1.5 天),总估算修正为 6.5–7.5 天,并诚实标注 M-A4「切目录」验收绕不开 M-A0。✅
- **P1-1** → §2 改为「桌面端会解析该形状」,补齐 `ok:false → isError`、「正常流程态走 ok:true + state」的行为准则,行号引用(`agent-tool.ts:233-256,269,277,282`)经核实全部准确。✅
- **P1-2** → §3.3.1 根目录约束(realpath 归一化 + 前缀判断 + 中文拒绝文案),code-review `root` 移入 §5 已接受风险 1。✅
- **P1-3 / P2-1~P2-5 / P3-1~P3-8** → 逐条核对,均以可实施的具体形态写入(TIMEOUT/ABORTED/TRANSPORT 三分、序列化字节 ≤24KiB 且 text 切片 ≤20KiB、复用守护 Scheduler、防轮询与 jobId 复述进 description、三条已接受风险、expired 删除、M-A1 三件套、version、schema<1024、runs/alerts 兜底、timing-safe + `AGENT_CATALOG_TOKEN` + 端口表、测试补项、smoke 车道计入 M-A2)。✅
- 修订稿主动补充了我未要求的准确事实:本地入口 timeoutMs 硬编码与目录默认等价(故条目不写 timeoutMs 的推导成立)、目录服务自身地址不受 LAN 校验约束(与 `agent-catalog.ts:31-41` 一致)、「超帽响应回落纯文本成功」(与 `agent-tool.ts:222-231` 一致)。均为真。

### 9.2 新增内容的对抗性核查

- **`HuaAnWork/scripts/agent-catalog-mock.mjs` 参照物主张:属实。** 文件存在,18080 端口,`GET /v1/catalog` → `{"items":[...]}`、`GET /v1/catalog/<name>` → 单条目,无鉴权、绑定 127.0.0.1、条目内存硬编码——「可直接参考形状、不能当生产服务」的定性准确。生产服务端照 §3.4 重写(加 Bearer/timing-safe、entries/ 现读、LAN 绑定)是对的方向。
- **§2 补充事实(1MiB 读入帽、1024 schema 注入帽、isLanEndpoint)**:全部与代码一致。

### 9.3 复审新发现

**R2-1(P2):task-orch `run` 的响应语义未定义,与「全部秒回」自相矛盾。**
修订稿选定「复用守护进程自身的 Scheduler」(正确,消除了 CLI 临时 Scheduler 绕并发上限的分歧),但 `runNow → runTask → await executeTask` 是**等待任务执行完毕才返回**(`scheduler.ts:92,174`);执行器每次尝试等待 `task.timeout_ms`、含 `retry.max` 次重试与退避(`executor.ts:89-130`)——监控目标不可达时 `run` 的最坏延迟是 (max+1)×timeout_ms+退避,可达数十秒,不是秒回。§3.3.3「全部秒回,同步返回」对 `run` 不成立,实现时会被迫临场发挥。修订要求(一句话级,二选一并写进 §3.3.3):
- **建议**:触发即回——不 `await` 执行完成,响应只带「已触发 + execution 记录已建,用 runs/show 查结果」,与设计自身「能秒回的同步返回」原则及既有 runs/show 词汇自洽(注意浮动 promise 的错误兜底,勿重蹈 cli.ts P0-H2 的教训);
- 或:明确「`run` 等待执行,最长 X 秒,超 X 秒回触发中」并给面板/模型可预期的话术。
不阻塞其余三条线开工,M-A3 实施前写死即可。

**R2-2(P3):description 兼任面板 UI 文案。** 防轮询/jobId 复述引导写给模型看,但 `description` 同时渲染在「发现」页条目列表里,终端用户会看到「不要连续轮询」这类指令性文字。可接受(没有其他模型侧注入通道),知悉即可;介意观感可把指令部分压短。

**R2-3(P3):「改文件即生效」是服务端视角。** 桌面端目录缓存 TTL 60 秒(`agents-host.ts:35` `CATALOG_CACHE_TTL_MS`),发布条目后客户端最迟 60s 或手动刷新才见。runbook 发布流程里补一句,免得验收时误判「没生效」。

### 9.4 复审结论

**通过。** 修订质量高:16 条处置全部为实质修订而非话术应付,新增 §3.4 经对抗核查成立,工作量与依赖关系诚实。遗留 R2-1 一项(P2)需在 M-A3 实施前以一句话写死 `run` 的响应语义;R2-2/R2-3 随实施顺手处理。**无需第三轮整体复审。**

—— 复审完 ——

---

## 十、实施计划评审(2026-10-14,针对 `plans/2026-10-14-agents-catalog-integration.md`)

**评审问题:是否达到开工标准。评审方式:对计划的「现状关键事实(已核实)」逐条抽查真伪(13 项承重事实抽验 13),再核设计承接完整性、任务可执行性与缺口。**

### 10.1 事实抽查:13 抽 12 实,行号精确——计划真读过代码

| 计划声称 | 抽查结果 | 出处 |
|---|---|---|
| server.mjs 218 行、零鉴权、HOST 硬编码、`MAX_REPORT_CHARS=28*1024`、`CODE_REVIEW_MOCK=1` | ✅ | `server.mjs:27-33,101` |
| 真实单份报告可达 40KB(`reports_typo/_.md`) | ✅ 40738 字节 | 实测 |
| code-review CLI 部分子文件夹失败**退出码 0**(`src/index.ts:129-132`) | ✅ 逐子文件夹 catch 继续 | `src/index.ts:129-132` |
| typo-check 无「传路径返结果」入口,系 inbox 轮询守护;`tick()` 取件 | ✅ | `orchestrator.py:272,305` |
| 进度唯一外露 = `queue_status.json`(`{current:{blocks_done,blocks_total,eta_s}}`) | ✅ 且在 data_dir 下 | `status/queue_status.py:17,39-42` |
| `TYPOGUARD_DATA_DIR` 可覆盖数据目录 | ✅ | `config.py:57` |
| `Orchestrator(cfg)` 单参构造 | ✅ 构造器自带 QueueStatusWriter,进度免费 | `orchestrator.py:77,101` |
| M1 冒烟 = tick 循环直到 pending_human 非空 | ✅ **计划的 runner 形态逐字踩在已验证的仓内先例上** | `run_m1_acceptance.sh:23-38` |
| task-orch `startServer` 不传 scheduler、`runNow` await 全链、`execId` 先生成、tick fire-and-forget、alerter 异步推送 | ✅ 全部精确 | `index.ts:76-79`;`scheduler.ts:54-56,86-94,149-169`;`alerter.ts:55-57` |
| `.graph/probe4-web.mjs` dist 探测先例 | ✅ 文件存在 | 实测 |
| `Store.getExecution` 等六方法齐备 | ✅ | `db.ts:139,153,231,238,328` |
| **「同一文档重新提交会因 lane_cache 命中而省 LLM,免费附带收益」** | ❌ **不成立** | `orchestrator.py:202`(`lane_cache=task_dir/"lane_cache"`,随 per-job 数据目录隔离) |

### 10.2 承接核对:两轮评审的要求全部有落点

R2-1(triggerNow + onStarted 回调触发即回,浮动 promise 有 `.catch` 落 console.error,复用 tick 的既有 fire-and-forget 先例)✅;P0 目录服务端成 Part M-A0 且 TDD 到测试代码级 ✅;P1 根目录约束成 A2-2 `resolve_under_root`(resolve + is_relative_to)✅;序列化字节守帽成了 `slicePage` 的回归测试(用换行密集文本钉住 JSON 膨胀,把 P2-1 的数学推演做成了测试)✅;R2-2(description 压短)、R2-3(60s TTL 进 README 与 A4-2 步骤)✅;A0-4 条目 action 枚举与三端实现交叉引用 ✅;`AGENT_CATALOG_TOKEN` 统一 ✅。task-orch 缺口令不拒启(503)与其余三服务拒启的差异**有理由且记录在案**——这是正确的差异化设计。

### 10.3 发现的问题

**F1(P2,事实/自洽):lane_cache 附带收益声明错误。** `lane_cache` 位于任务目录内(`orchestrator.py:202`),而 M-A2 给每个作业独立 `TYPOGUARD_DATA_DIR` ⇒ 重新提交同名文档得到全新空数据目录,**cache 不跨作业命中**;`mark_superseded` 同理不跨作业。该句会在验收时制造错误预期(以为重交会快)。修法:改为「lane_cache 仅在同作业目录内 recover 时生效,跨作业不复用」或直接删除。

**F2(P2,实现缺口):typo-check runner 的 env 组装缺 `load_dotenv('.env')`。** 仓内先例是 `{**load_dotenv('.env'), **os.environ}`(`run_m1_acceptance.sh:30`),密钥按惯例放 .env;计划的 `real_runner` 只写 `{**os.environ, "TYPOGUARD_DATA_DIR": …}` ⇒ 若公用机按仓惯例用 .env,`load_config` 启动即抛 `StartupError`(缺 `TYPOGUARD_LLM_API_KEY`,`config.py:60-61`)。修法:runner 组装 `{**load_dotenv(<repo>/.env), **os.environ, …}`,或在 A2-4 README/A4 部署清单里明确「全部经 launchd/systemd 环境变量注入,不读 .env」。

**F3(P3,一致性):`estimatedMinutes` 静默消失。** 设计 §3.2 submit 示例与条目 description 都承诺「预计时长」,但 A1-3/A2-3 的 submit 响应只有 `{jobId,state}`——模型无数据可告知。补字段(typo-check 可按 blocks 估算/写死;code-review 允许省略)或删措辞。

**F4(P3,偏差登记):code-review 不报 progress。** 设计 §3.3.2 说「progress 可报『正在审查 subB(2/3)』」,A1-3 status 无 progress。设计允许「给不了就省略」故合规,但应把偏差写进自查记录(低成本实现:runner 数 outDir 已落 .md 数对比 include 数)。

**F5(P3,诚实性):CLI 部分子文件夹失败(退出码 0)→ 作业 done 但报告静默缺角。** 计划正确记录了该事实但 runner 未处置。低成本修法:收集 CLI 汇总行「成功/失败:n/m」,失败>0 时在作业记 note 并拼进 result 首片——与「interrupted 诚实标记」同一精神。

**F6(P3,部署缺口):launchd/systemd unit 无任务承载。** M-A4 把「四服务已部署」列为前置但计划不产出部署工件。补一份部署 runbook/unit 清单任务,或明确声明为用户手工操作并在 A4 加核查步骤。

**F7(P3,措辞):杂项。** A2-3 status 读 `queue_status.json` 还需处理 `current` 为空对象的情况(idle 时非缺文件而是空态);「探针资产移义不改」应为「保留不改」;A3-3 引用「AGENTS.md:75」行号宜符号化;A4 质检口径应提一句真车道需要 LLM key + verifier(异厂商)或 `TYPOGUARD_VERIFIER_MOCK=true`,否则现场撞 `StartupError`(`config.py:62-68` 还有「verifier 不得与 A/B 同厂商」的校验)。

### 10.4 结论

**达到开工标准。** 判定依据:①承重事实 13 抽 12 实且行号可复核——这份计划真的读过代码;②两轮评审的全部要求有具体落点,R2-1 的 triggerNow 方案与仓内既有先例同形;③任务粒度(TDD 失败测试先行 + 接口签名 + 命令 + commit)可直接交给子代理执行。

**开工前顺手修订 F1/F2(均为一两句话的改动)**:F1 删一句错误声明,F2 补 env 组装或部署口径。F3–F7 不阻塞,随对应 Task 实施时消化即可,无需第三轮评审。

—— 实施计划评审完 ——

### 10.5 F1/F2 修订复核(2026-10-14,第二轮):**修订未落盘**

用户告知已按 §10.3 修订 F1/F2,对 `plans/2026-10-14-agents-catalog-integration.md` 磁盘内容复核:

- **F1 未修**:`:758` 仍原文保留「同一文档重新提交会因 lane_cache 命中而省 LLM 调用,这是免费的附带收益,不写进契约」——与 §10.3 F1 指出的错误声明逐字一致;
- **F2 未修**:`:813` 的 runner env 组装仍为 `load_config({**os.environ, "TYPOGUARD_DATA_DIR": …})`,全文件检索 `load_dotenv` 零命中;A2-4/A4 亦未出现「全部经 launchd/systemd 环境变量注入」的替代口径;
- **旁证**:该文件 mtime 为 10-14 09:17,早于本评审 §十 的落盘时间(10-14 10:09)——即自我评审后该文件从未被修改;plans/ 与 specs/ 下亦无其他副本。

**判定:声称的修订未生效**(编辑未保存、改错文件、或未执行只报告完成)。本轮复核无通过可言——复核对象与已评审版本逐字节相同。F1/F2 的处置文本见 §10.3,落盘后按原结论即通过,无需扩大复审。

—— F1/F2 复核完 ——

### 10.6 修订复核(2026-10-14,第三轮):**修订已落盘,F1/F3–F7 全部确认;F2 补丁自身引入一处新事实错误,一句话修正后即最终通过**

对修订稿逐条核验(文件 mtime 10-14 10:19,875 行新增「计划修订记录」):

- **F1 ✅**(`:759`):错误声明已替换为准确表述——「lane_cache 位于任务目录内(orchestrator.py:202),每作业独立数据目录 ⇒ cache 只在同作业目录内 recover 时生效,跨作业不复用;不要预期重交同文档会变快」。
- **F2 ⚠️**(`:814`):`load_dotenv` 已补、引用 `config.py:72` 既有实现与 M1 先例——核心修复正确;**但括号里的兼容性声明与代码不符**:「.env 不存在时 load_dotenv 返回空 dict,两口径兼容」为假——`config.py:75` 的 `Path(path).read_text()` 对缺失文件**抛 `FileNotFoundError`**,launchd/systemd-only 部署(无 .env)下 runner 每个作业都会崩。修正(一句话):runner 组装改为 `.env` 存在才读入(`Path(<repo>/.env").exists()` 守卫或 try/except FileNotFoundError→`{}`),或 A4-0 runbook 明确「.env 必须存在,可为空文件」。
- **F3 ✅**(`:814/:664`):typo-check submit 返回 `estimatedMinutes:40`(附理由与演进路径);code-review 显式省略并注明「设计允许」——与各自条目 description 的承诺/不承诺精确对齐。
- **F4 ✅**(`:665`):code-review status 补低成本 progress(数 outDir 已落 .md 份数对比 include 个数,「已产出 N/M 份报告」)。
- **F5 ✅**(`:666`):部分失败诚实化——解析 CLI 汇总行,失败>0 写 note 并拼进 result 首片。
- **F6 ✅**(`:840-847`):新增 Task A4-0 部署 runbook + 四服务 unit 模板 + 端口表 + 各服务专属 env,列为其余 A4 任务前置。
- **F7 ✅**(`:814/:692/:748/:859`):queue_status 空 `current` 态处置、「保留不改」措辞、`AGENTS.md` 改「路由面登记」节名符号引用、A4 质检补 LLM key/verifier 异厂商前提与 `TYPOGUARD_VERIFIER_MOCK` 降级口径。

**判定:除 814 行一句外,全部通过。** 该句为修正文本自身的新引入错误(非原问题回潮),给出替换文本后按既定结论即最终通过,无需第四轮。

**2026-10-14 后续:该句已由评审方直接修正落地**——runner 组装式并入 `.env` 存在性守卫(`Path(...).exists()` 存在才读入,不存在用空 dict),计划「计划修订记录」同步补一行。**F1–F7 全部闭环,实施计划最终通过,可开工。**

—— 修订复核完 ——
