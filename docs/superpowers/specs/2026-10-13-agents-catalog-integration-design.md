# 三个智能体接入侧边栏「智能体」模块 — 设计文档

日期:2026-10-13
状态:两轮评审通过(首轮「有条件通过」16 条已落;复审「通过」,遗留 R2-1 已写死、R2-2/R2-3 已落),待用户终审
方案:方案 A(HTTP 小工具包装,公用机目录下发,@点名调用)

## 1. 背景与目标

把 `/cursor/` 下三个独立智能体整合进 HuaAnWork 桌面端侧边栏的「智能体」模块:

| 智能体 | 仓库 | 形态 | 单次任务时长 |
| ------ | ------ | ------ | ------ |
| 错别字检测 | `/cursor/错别字检测智能体` | Python 包(typoguard),仅 CLI/库 | 常超 40 分钟 |
| 代码审查 | `/cursor/代码审查智能体` | Node CLI + `server.mjs`(已按 HuaAnWork 契约写的同步 HTTP 包装) | 超 150s |
| 任务编排 | `/cursor/任务编排智能体` | Node 常驻守护,自带 :8787 **只读** HTTP 看板/健康检查(变更操作 run/pause/resume 目前仅在 CLI) | API 操作秒回 |

**目标**:用户在智能体面板配置公用机地址后,能在「发现」页看到三个智能体、启用、并在聊天输入框 `@点名` 调用。

**已确认的边界**(与用户对齐):

- 运行形态:三个智能体部署在**公用机**,经**目录(catalog)下发**;桌面端不托管进程。
- 调用方式:**仅 @点名**,不开发面板运行按钮等新 UI。
- 桌面端(`HuaAnWork-Desktop` 仓库)**零改动**——目录、启用、@调用、Bearer、超时、截断机制全部现成。本设计的工作全部落在三个智能体仓库与公用机部署上。

## 2. 现有机制(桌面侧,只读事实)

以下来自 `dsh-plugin-huaanwork/src/` 与 `packages/huaanwork-policy/src/`,是本次设计依赖的既有契约,不需要改:

- **目录条目**:`kind=tool` + `entrypoint.kind=http` 的小工具,字段含 `name`(小写 slug)、`version`、`description`、`whenToUse`、`argumentsSchema`(仅注入模型上下文做组参提示,不做运行时校验)、`permissions`、`timeoutMs`。`entrypoint.url` 在条目解析时强制校验为**局域网或本机地址**(`agent-catalog.ts:122-123` 的 `isLanEndpoint`),公网地址会被标记为 broken。
- **调用链**:用户 `@name 文本` → `src/huaanwork-host/agent-invoke.ts` 生成 `<tool-invoke>` 信封 → 模型第一动作必须 `call_host_tool(name, arguments)` → `src/huaanwork-guardrails/agent-tool.ts` 向 `entrypoint.url` 发 `POST`,body `{"arguments": {...}}`,头 `content-type: application/json`,若配置了目录口令则带 `Authorization: Bearer <token>`。
- **硬约束**(`agent-catalog.ts:46-51` 与 `agent-tool.ts`):
  - 单次 HTTP 调用超时 `clampTimeoutMs`:默认 60s,**硬顶 150s**,不可配置超过;
  - 响应体读入上限 **1MiB**(`http-cap.ts:1` 的 `CATALOG_BODY_LIMIT`),读入后工具输出再截到 **32KiB**;超帽响应会被截成**不合法 JSON**,桌面端双重 `JSON.parse` 失败后回落为纯文本「成功」——服务端必须自己守住尺寸,不能指望平台报错兜底;
  - `argumentsSchema` 序列化注入模型上下文的上限 **1024 字符**(`agent-tool.ts:76` `SCHEMA_HINT_LIMIT`),超出截断——schema 必须精简,长 schema 可能在 `required` 字段处被截掉;
  - 非 2xx 视为失败,状态码 + 响应体前 500 字符交给模型。
- **响应体约定**(沿用 `代码审查智能体/server.mjs` 已建立的惯例):逻辑成功 `200 {"ok": true, "result": ...}`;逻辑失败 `200 {"ok": false, "error": "中文原因"}`;非 2xx 只用于传输级失败(401 未授权 / 413 过大 / 500 崩溃)。**桌面端会解析该形状**(`agent-tool.ts:233-256`):`ok:false` 会以工具错误(`isError`)呈现给模型,`ok:true` 会提取 `result` 字段——因此 **`ok:false` 只用于失败与拒绝语义;正常流程态(排队中、运行中)一律走 `ok:true` + `state` 字段**。错误标签分三类:用户取消 `ABORTED`、超时 `TIMEOUT`、网络失败 `TRANSPORT`(`agent-tool.ts:269,277,282`)。

## 3. 总体设计

### 3.1 统一交互词汇

150s 硬顶下,三个智能体分成两类,但**对模型暴露的 action 词汇统一**:

| 智能体 | 形态 | actions |
| ------ | ------ | ------ |
| 错别字检测(`typo-check`) | 异步作业 | `submit` / `status` / `result` |
| 代码审查(`code-review`) | 异步作业 | `submit` / `status` / `result` |
| 任务编排(`task-orch`) | 同步快操作 | `run` / `list` / `runs` / `show` / `pause` / `resume` / `alerts` / `health` |

原则:**能秒回的同步返回;秒回不了的一律 `submit → status → result`**。每个 `argumentsSchema` 把 action 枚举和参数写清楚,模型据此组参。

### 3.2 异步作业协议(typo-check 与 code-review 共用)

**submit**

```json
请求:{"arguments": {"action": "submit", ...任务参数}}
响应:{"ok": true, "result": {"jobId": "jr_xxx", "state": "queued", "estimatedMinutes": 40}}
```

- 秒回。包装层校验参数后落一条作业记录,后台开工。
- 并发超限:`{"ok": false, "error": "当前有 N 个任务在跑,请稍后再提交"}`(模型会把这话转述给用户)。

**status**

```json
请求:{"arguments": {"action": "status", "jobId": "jr_xxx"}}
响应:{"ok": true, "result": {"jobId": "jr_xxx", "state": "running", "progress": "已扫描 12/40 章", "elapsedSeconds": 600}}
```

- `state` 枚举:`queued` / `running` / `done` / `failed` / `interrupted`。
- jobId 不存在或已过保留期:`{"ok": false, "error": "作业不存在或已过期"}`(过期即删除,不设 `expired` 状态——清理后无记录可返,该枚举永不可达)。
- `progress` 为自由文本,包装层能给多少给多少,给不了就省略该字段。

**result**

```json
请求:{"arguments": {"action": "result", "jobId": "jr_xxx", "offset": 0}}
响应:{"ok": true, "result": {"state": "done", "text": "……报告片段……", "offset": 0, "totalChars": 98000, "hasMore": true}}
```

- 分片纪律按**序列化后字节**计,不按 text 字符数:32KiB 帽作用在整个 JSON 响应文本上,`JSON.stringify` 会把换行/引号/反斜杠膨胀为 2 字节,Markdown 报告换行密度高,24KiB 的 text 序列化后可贴帽,超帽即被平台截成不合法 JSON,`hasMore/offset` 恰好被截掉则模型无法续拉。约定:**text 切片 ≤ 20KiB,且包装层在组装后校验 `JSON.stringify(响应)` 的 UTF-8 字节数 ≤ 24KiB,超出则自动缩短本片**。`hasMore=true` 时模型可继续带 `offset` 拉取。
- 作业未完成:`{"ok": false, "error": "作业尚未完成,当前状态:running"}`。
- 约定**只用分页一种风格**,不搞「摘要 + 落盘路径」第二套(两个智能体保持一致)。

**作业生命周期**

- 状态机:`queued → running → done / failed`;服务重启时 `queued/running → interrupted`(诚实标记,引导用户重新提交,与任务编排的既有策略一致)。
- 保留:终态作业(`done/failed/interrupted`)保留 **24 小时**,之后清理,status 返回「不存在或已过期」。
- jobId 格式:`jr_` + 12 位随机(base62),不可枚举。
- **断点续扫**:错别字仓库存在 `_resume_drill.py`,实现时核实其续扫能力是否可产品化;若可用作为后续增强,**本设计不依赖它**,默认 interrupted 后重新提交。

### 3.3 各智能体端点设计

#### 3.3.1 错别字检测(`typo-check`)

新写 HTTP 包装服务(建议 FastAPI + uvicorn,仓库已依赖 openai/python-docx,加两个轻依赖),单端点 `POST /invoke`:

**submit 参数**:

| 字段 | 类型 | 必填 | 说明 |
| ------ | ------ | ------ | ------ |
| `action` | `"submit"` | 是 | |
| `path` | string | 是 | 待检测文档的**公用机共享目录内**绝对路径(.docx) |

- **根目录约束(安全必做)**:服务端配置允许根目录(共享目录),`path` 必须落在根之下——先 `realpath` 归一化再前缀判断(防 `../` 与符号链接穿越),越界返回 `ok:false`,文案中文指明「仅支持共享目录内的文档」。不设此约束等于向所有持目录口令的用户开放整机 .docx 读取。路径不存在/后缀不支持 → submit 即 `ok:false`。
- 并发:**2**(作业相互独立、无共享状态),超出返回 busy。

**status/result**:按 §3.2。

**质检**:仓库有 `eval/` 与验收脚本传统;新增 `scripts/smoke_http.sh` 跑通 submit→status→result 全链。注意 `TYPOGUARD_VERIFIER_MOCK` 只 mock 校验器(`config.py:52`),不覆盖全链——smoke 若需更多桩,工作量计入 M-A2;否则退到「最短 fixture 文档走真车道」,接受单次质检耗时。

#### 3.3.2 代码审查(`code-review`)

重构既有 `server.mjs`(现为同步串行 + busy 锁)为作业模式,保持单端点。重构范围明确含三件事(现状均无,避免估算被隐性需求击穿):**Bearer 校验**(现状零鉴权)、**HOST 可配置**(现状硬编码 `127.0.0.1`)、**`/invoke` 路径匹配**(现状只查 method 不查路径)。

**submit 参数**(沿用现有 `validateArgs` 规则):

| 字段 | 类型 | 必填 | 说明 |
| ------ | ------ | ------ | ------ |
| `action` | `"submit"` | 是 | |
| `root` | string | 是 | 待审查父目录绝对路径(公用机本地) |
| `include` | string | 是 | 逗号分隔子文件夹名,沿用现有上限单次最多 3 个(作业模式下该上限不再是超时所迫,但保留以控制单次成本;放宽属后续增强,不在本设计内) |
| `task` | string | 否 | 本次审查重点(≤2000 字) |

- 并发:**1**(继承现状的串行约束),有作业在跑时新 submit 返回 busy。
- 现有约束保留:超时/截断拼装逻辑从「单次响应」平移到「result 分页」;`CODE_REVIEW_MOCK=1` 继续有效,供质检。

**status/result**:按 §3.2。`progress` 可报「正在审查 subB(2/3)」。

#### 3.3.3 任务编排(`task-orch`)

其 HTTP 服务现状是**只读**(`/api/runs` `/api/tasks` `/api/alerts` `/health` + 状态页),`run/pause/resume/show` 只存在于 CLI 通道——因此适配不是「转发既有 HTTP 端点」,而是在守护进程内新增一条 `POST /agent-invoke` 路由,直接调用 `Store`/`Scheduler`:

| action | 参数 | 映射 |
| ------ | ------ | ------ |
| `list` | — | `store.listTasks()` |
| `run` | `taskId` | **触发即回**:复用守护进程自身的 `Scheduler`(受全局并发上限约束,与后台调度语义一致;不采用 CLI 的临时 Scheduler 路线——CLI 注释明示其绕开上限,`cli.ts:80`),但**不 await 执行完成**——`runNow → runTask` 会等 `executeTask` 跑完(含 `retry.max` 次重试与退避,最坏 (max+1)×timeout_ms,可达数十秒,`scheduler.ts:92,174`、`executor.ts:89-130`),与「秒回」原则冲突。响应只带「已触发 + execId(或 `debounced`),用 runs/show 查结果」,执行结果经 runs/show/alerts 既有词汇获取。实现注意:① `startServer` 现仅接收 `store`,需把 scheduler 句柄传入;② 浮动 promise 必须挂 `.catch` 落日志,勿重蹈 cli.ts P0-H2(进程退出丢弃 fire-and-forget)的教训 |
| `runs` | `taskId?`, `limit?` | `store.listExecutions(limit)` |
| `show` | `execId` | 执行详情 |
| `pause` / `resume` | `taskId` | `store.setTaskEnabled(id, …)` |
| `alerts` | `limit?` | `store.listAlerts(limit)` |
| `health` | — | 同 `/health` |

- 全部秒回,同步返回,不走作业协议。
- 适配路由校验目录 Bearer;服务自身的 `DASHBOARD_TOKEN` 体系不动(两条认证通道互不相干)。
- 返回体尺寸兜底:`runs/alerts` 默认 `limit=10`,上限 50;**组装响应时按 `JSON.stringify` 字节数兜底,逼近 24KiB 自动降 limit**(50 条含长 error 字段的记录可能贴 32KiB 帽)。

### 3.4 目录服务端(本次新建,P0)

桌面端只实现了目录**客户端**(`GET {root}/v1/catalog` 列表 + `GET {root}/v1/catalog/<name>` 详情,均带 Bearer,`agents-host.ts:278,418`);**所有仓库均无生产目录服务端**,三个智能体将是目录的首批条目。参照物:旧仓 `HuaAnWork/scripts/agent-catalog-mock.mjs`(18080 端口的开发 mock,条目形状可直接参考,但不能当生产服务)。

**形态**:独立极简 Node 服务(零三方依赖,`node:http`),部署在公用机:

- **路由**:`GET /v1/catalog` → `{"items": [...]}`;`GET /v1/catalog/<name>` → 单个条目详情(含 `argumentsSchema` 等完整字段);形状以桌面端解析器(`agent-catalog.ts` 的 parse)与 mock 为契约真相源。
- **条目存储**:磁盘上一个 `entries/` 目录,每条目一个 JSON 文件;**每次请求现读**(不缓存)——发布/修改条目 = 改文件即生效,零重载机制。
- **认证**:`Authorization: Bearer <目录口令>` 必检,timing-safe 比较;口令经环境变量 `AGENT_CATALOG_TOKEN` 注入(与三个智能体服务的校验口径统一)。
- **绑定**:公用机 LAN 地址(桌面端只要求条目 `entrypoint.url` 是 LAN,目录服务自身地址由客户端「智能体」面板配置,无该约束,但同属内网纪律)。
- **发布纪律**:条目文件由运维在公用机上编辑,质检通过后才加入 `entries/`;沿用「质检后下发」的既有纪律。

**三个首批条目草稿**(name 须小写 slug;`version` 字段首版即带上,面板展示用):

```json
{
  "name": "typo-check",
  "version": "0.1.0",
  "kind": "tool",
  "entrypoint": {"kind": "http", "url": "http://<公用机>:<port>/invoke"},
  "description": "检测 docx 文档错别字,异步作业:submit 提交(文档须在公用机共享目录)→ status 查进度 → result 分页取报告。submit 后把 jobId 显著复述给用户;status 返回 running 时直接告知预计时长与 jobId、请用户稍后再查,不要连续轮询。",
  "whenToUse": "用户要检查一份文档的错别字、用词错误时。",
  "argumentsSchema": {"type": "object", "properties": {"action": {"type": "string", "enum": ["submit", "status", "result"]}, "path": {"type": "string"}, "jobId": {"type": "string"}, "offset": {"type": "number"}}, "required": ["action"]},
  "permissions": ["读取共享目录内的文档", "调用大模型"]
}
```

`code-review`、`task-orch` 同构(按 §3.3 填写)。注意:

- **不写 `timeoutMs`**:本地入口硬编码 60s、目录条目默认也是 60s,两条路径行为等价;所有 action 均设计为秒回,无需上调(本地入口联调路径也无法实测上调效果)。
- **task-orch 的 schema 必须精简**:8 个 action 序列化后须 < 1024 字符注入上限,逐字段写短 description,别写长句,防止截断落在 `required` 上。
- description 里的**防轮询引导**(上面的「不要连续轮询」「jobId 显著复述」)是刻意的:`<tool-invoke>` 信封只约束模型第一动作,`status` 返回 running 后模型可能在同一回合空转轮询;jobId 是用户跨会话取结果的唯一凭据。**知悉项**:`description` 同时渲染在「发现」页条目列表里,终端用户会看到这类指令性文字——没有其他模型侧注入通道,接受此兼任,指令部分压短即可。
- **「改文件即生效」是服务端视角**:桌面端目录缓存 TTL 60 秒(`agents-host.ts:35` `CATALOG_CACHE_TTL_MS`),发布/修改条目后客户端最迟 60s 或手动「刷新」才可见——runbook 发布流程里写明,免得验收误判「没生效」。

## 4. 公用机部署与质检

1. **四个服务**作为常驻进程部署(launchd/systemd,随机器启动),绑定公用机 LAN 地址,端口分配(建议值,部署时定死并写进 runbook):目录服务 18080、typo-check 18081、code-review 18082、task-orch 8787(沿用)。统一校验 `Authorization: Bearer <目录口令>`,口令经环境变量 **`AGENT_CATALOG_TOKEN`** 注入,比较用 timing-safe 实现;与客户端「智能体」面板里配置的口令一致。
2. **task-orch 的安全姿态变化(显式记账)**:其源码自我要求强制回环绑定(`server.ts:33` 的 P0-H1),且非回环时 query-token 自动关闭。本次 LAN 绑定是**有意放宽**,接受的姿态变化 = LAN 绑定 + query-token 关闭(仅 Bearer)+ 双 token 隔离(`DASHBOARD_TOKEN` 管看板,目录口令管适配路由,互不相干)。
3. 质检流程(沿用「公用机完成质检后下发目录」的既有纪律):每个服务提供 smoke 脚本(mock/最短路径),质检记录留档;质检通过才把条目文件放进目录服务的 `entries/`。
4. **上架前先经桌面端「本地入口」联调**:开发机在智能体面板「＋ 添加入口」直接登记 `http://<公用机>:<port>/invoke`,@点名跑通全链路;确认无误后再写入正式目录。这条路无需等质检,也用于回归验证。注意本地入口 `timeoutMs` 硬编码 60s 且无 `whenToUse` 字段(`agents-host.ts:387,677`)——与目录条目默认 60s 行为等价,但联调时无法实测上调超时的效果(本设计也不需要)。
5. 监控:四个服务写访问日志;作业型服务的作业记录落盘(SQLite 或 JSON 文件,并发写用 WAL 或写锁),重启按 §3.2 标记 interrupted。

## 5. 错误处理与已接受风险

| 场景 | 表现 | 设计 |
| ------ | ------ | ------ |
| 口令错误/缺失 | 401,模型收到 `HTTP 401: <响应体前 500 字符>` | 三个新服务统一给中文响应体(如「口令错误」),提升模型可读性;用户检查面板口令配置 |
| 参数校验失败 | 200 `ok:false`(工具错误 isError) | 中文错误信息具体到字段,模型可自我修正后重试 |
| 并发超限 | 200 `ok:false` | 提示稍后重试;不排队 |
| 作业超时/崩溃 | 作业态 `failed` | status 可见,result 返回错误摘要 |
| 服务重启 | `interrupted` | status 告知,引导重新 submit |
| 响应超 32KiB | 平台截断为不合法 JSON、静默回落纯文本 | result 分片按序列化字节 ≤24KiB 守住(§3.2),不依赖平台兜底 |
| 桌面端 150s 超时 | 模型收到「调用超时(TIMEOUT)」 | 只可能发生在服务异常卡死时;所有 action 设计为秒回(ABORTED 专指用户取消,TRANSPORT 指网络失败) |

**已接受风险(显式记账)**:

1. **code-review 的 `root` 任意路径读**:其产品用途就是审查机上任意工作副本,且 `include` 已限一级目录名(`server.mjs:71-75` 拒绝路径分隔符与 `..`),不再收窄;typo-check 则必须有根目录约束(§3.3.1),因为它没有这个历史约束且文档面更宽。
2. **作业结果跨用户可见**:目录口令全局一把,服务端无法区分用户;任何口令持有者可对已知 jobId 调 `status/result`。内网信任边界下接受。
3. **task-orch LAN 绑定**:对其回环绑定自我约束的有意放宽,见 §4 第 2 条。

## 6. 桌面端改动

**零改动。** 本设计不触碰 `HuaAnWork-Desktop` 仓库任何文件(本设计文档本身除外)。联调走「本地入口」,正式走「公用机目录」,两条都是既有功能。若联调中发现桌面侧缺陷,另行登记,不在本设计范围内顺手改。

## 7. 测试与验收

各仓库(含目录服务端):

- 适配层单元测试:参数校验(缺字段/坏路径/坏 action)、busy、分片边界(offset 越界、**序列化后单片 ≤24KiB**)、作业状态机(含重启 → interrupted、**24h 过期清理**)、Bearer 校验(timing-safe、缺失/错误)、**作业存储并发写**(SQLite WAL 或写锁)、目录服务的条目读取与详情路由。
- smoke 脚本:mock 模式全链路 submit→status→result / 各同步 action(typo-check 的 smoke 车道覆盖范围见 §3.3.1 的核实项)。

端到端(人工,真机):

1. 「本地入口」登记三个服务,@点名各跑一遍真实任务(错别字用一份真 docx,代码审查用一个小仓库,任务编排跑 examples 任务);
2. 启用/禁用/删除入口在面板表现正常;
3. 报告分页拉取完整;
4. 质检通过后切到目录下发,删掉本地入口,重跑一遍确认目录路径同样可用。

## 8. 工作量与里程碑

| 里程碑 | 内容 | 估算 |
| ------ | ------ | ------ |
| M-A0 | **目录服务端**(新建):零依赖 Node 服务,`GET /v1/catalog` + `GET /v1/catalog/<name>`,entries/ 目录现读,Bearer(timing-safe),LAN 绑定,单测 | 1–1.5 天 |
| M-A1 | `code-review`:server.mjs 作业化重构(**含 Bearer 校验、HOST 可配置、`/invoke` 路径匹配**,现状均无)+ 单测 | 1–1.5 天 |
| M-A2 | `typo-check`:FastAPI 包装服务(含作业管理、根目录约束)+ 单测 + smoke(车道覆盖为核实项,见 §3.3.1) | 2–2.5 天 |
| M-A3 | `task-orch`:`/agent-invoke` 适配路由(复用守护 Scheduler,startServer 需传入 scheduler 句柄)+ 单测 | 1 天 |
| M-A4 | 三个首批目录条目 + 本地入口联调 + 真机验收 | 1 天 |

合计约 **6.5–7.5 天**。M-A0/A1/A2/A3 互不依赖,可并行;M-A4 依赖前四者(M-A0 缺失时仍可先用本地入口完成大部分联调,但「切目录」验收绕不开 M-A0)。

## 9. 明确不做(YAGNI)

- 面板「运行」按钮与参数表单 UI;
- MCP 化(方案 B)与人设型下发(方案 C);
- 桌面端任何代码改动;
- 断点续扫(仅登记为实现期核实项,见 §3.2);
- 作业排队(超并发直接 busy,不引入队列状态);
- 目录服务端的条目缓存、管理 UI、多租户鉴权(目录口令全局一把,见 §5 已接受风险 2)。

## 10. 修订记录

- 2026-10-14:按对抗性评审(`2026-10-13-agents-catalog-integration-review.md`,结论「有条件通过」)修订——P0-1 目录服务端新建(新增 §3.4 与 M-A0);P1-1 更正「桌面端不解析 ok/error」为「会解析,ok:false 仅用于失败/拒绝语义」;P1-2 typo-check 增加根目录约束;P1-3 错误标签修正(TIMEOUT/ABORTED/TRANSPORT);P2-1 分片改按序列化字节;P2-2 task-orch 复用守护 Scheduler;P2-3 目录条目写入防轮询与 jobId 复述引导;P2-4/P2-5/P1-2-code-review 记入 §5 已接受风险;P3-1 删除不可达的 `expired` 状态;P3-2 M-A1 范围点名 Bearer/HOST/路径匹配;P3-3 条目补 `version`;P3-4 schema <1024 字符约束;P3-5 runs/alerts 序列化字节兜底;P3-6 timing-safe Bearer + 端口分配 + `AGENT_CATALOG_TOKEN`;P3-7 测试补过期清理与并发写;P3-8 typo smoke 车道覆盖计入 M-A2。
- 2026-10-14(复审,结论「通过」):R2-1 写死 `run` 为「触发即回」(不 await 执行完成,响应带 execId/debounced,浮动 promise 挂 catch——原「全部秒回」与 `runNow` 等待执行的现实矛盾);R2-2 登记 description 兼任面板 UI 文案为知悉项、指令压短;R2-3 补桌面端目录缓存 60s TTL 对「改文件即生效」的限定。复审确认首轮 16 条处置全部实质落入、行号引用抽查准确。
