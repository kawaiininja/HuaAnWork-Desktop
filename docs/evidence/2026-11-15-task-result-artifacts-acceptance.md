# 任务结果 Artifact 用户验收证据（规格 §12.2）

- 分支：`feat/task-result-artifacts-impl`
- 提交：`e594527042`（D1 修复；本文件与复核截图随后续 docs 提交记录）
- 规格：`docs/superpowers/specs/2026-11-15-task-result-artifacts-design.md` §12.2
- 环境：macOS 27.0.0 / arm64；Node v24.22.1；本轮执行时间 2026-11-20 02:33–02:41 CST
- 构建：`corepack yarn workspace dsh-plugin-huaanwork build`（EXECUTED，成功，`lib/` 含 D1 修复）
- 实例：临时 `DSH_HOME=/tmp/art-accept/run/.huaanwork`、`--user-data-dir=/tmp/art-accept/run/userData`、
  `--remote-debugging-port=9333`、`HUAANWORK_ACCEPTANCE_HOOKS=1`（固定 Web `43120`），
  与第 2 轮同一 `launch.mjs` 配方。临时 home 沿用第 2 轮副本（会话与四个 Artifact 原样保留），
  生产 `~/.huaanwork` 只被读取复制，未被写入。

## 0. 状态声明

本轮是缺陷 D1 修复（`e594527042`：about:blank 的 load 早于 React 监听）后的实机复核：

- HTML 右栏预览：**EXECUTED PASS**——`artifact.prepareFrame` 到达，iframe 离开 about:blank
  并渲染模型 HTML，按钮与滑块交互成功。
- HTML 全屏窗口：**EXECUTED PASS**——双 ID URL 不变，窗口内同样完成 prepareFrame 与交互。
- 刷新重开：**EXECUTED PASS**——渲染器刷新后重新 arm。
- 隔离：只记录应用内实际观测（父窗口/顶层导航 SecurityError、CSP 拦截 fetch、sandbox
  拦截弹窗与表单、本地接收端 0 请求）。**专用 Electron 探针本轮未重跑，仍为 NOT PASSED**，
  不引用探针结果作为隔离证据。
- 第 1 步真实生成：**BLOCKED**——本轮未再尝试模型生成；第 2 轮已确认工具在模型面可见，
  但模型未调用 `result_present`。
- 第 7 步：脚本运行 **EXECUTED**（真实创建并运行）；新/旧协议运行 **FIXTURE-FACILITATED**
  （运行摘要、任务、会话与 Artifact 为夹具，客户端投影代码为真实运行）。

Markdown 预览、Markdown 全屏复用、下载另存为与跨会话切换已在第 2 轮（`8950c258c5`）
验证通过；D1 修复只新增 HTML 视图的 arm 路径，未改动这些路径，本轮未重跑
（HTML Artifact 的跨会话切换例外，见第 2 步）。

## 1. 构建、门禁与探针（实际执行）

| 项目 | 命令 | 结果 |
| --- | --- | --- |
| 构建 | `corepack yarn workspace dsh-plugin-huaanwork build` | 成功，`lib/` 输出重建，含 D1 修复 |
| 根门禁 | `corepack yarn check` | **EXIT=0**（D1 修复提交 `e5945270` 之后由控制者重跑，日志 `.superpowers/sdd/2026-11-15-task-result-artifacts/final-check-3.log`）；上一轮 `final-check-2.log` 也是 EXIT=0 |
| Electron 探针 | `corepack yarn workspace dsh-plugin-huaanwork test:artifact-sandbox` | 本轮未重跑；历史两轮均 `Test timed out in 30000ms`，状态保持 **NOT PASSED** |

## 2. 实例与夹具（实际执行）

启动后 `http://127.0.0.1:9333/json/list` 出现唯一 `43120` 页面目标，标题
`DeepSeek Harness`，URL 含 `dsh-desktop-mode=advanced&...`。临时 home 中保留第 2 轮会话：

- 会话 A `huaanwork-5a4497056ab88f0d-d573c1d2`：Artifact `50a1e395-…`（验收报告 /
  markdown / 431 B）、`f91d8aca-…`（交互图表 / html / 3.1 KB）、`df7107dd-…`
  （历史结果（无锚点）/ markdown / 107 B）。
- 会话 B `huaanwork-5a4497056ab88f0d-49342e7e`：Artifact `9cdef403-…`
  （第二会话结果 / markdown / 94 B）。

四个 Artifact 均经第 2 轮的真实存储 `createArtifact` 写入，落盘结构与清单 sha256 不变。
第 7 步新增夹具（全部位于 `/tmp/art-accept/run`，写入前备份 `*.pre-step7.bak`）：

- 新协议运行：会话 `huaanwork-fixture-step7-new`、自动化 `f6f89314-…`、运行
  `064d094e-…`、任务 `fc93ff3d-…`、Artifact `4de3a207-…`（自动化结果页 / markdown / 73 B，
  锚点 `automation-run`）；运行摘要带 `artifactOutcome: "created"` 与 `artifactId`。
- 旧协议运行：会话 `huaanwork-fixture-step7-legacy`、自动化 `c0af867e-…`、运行
  `1f9e7214-…`、任务 `1e066d70-…`；会话助手正文为 JSON 对象，运行摘要无 `artifactOutcome`。
- 两个夹具会话由会话 B 日志克隆并改写会话 id/cwd（纯文本 JSONL），侧栏标题因此继承为
  “全屏窗口跨会话复用验证”；任务/运行摘要/自动化注册表为手写 JSON。客户端投影代码本身
  未被替换或 mock。
- 脚本运行：经页面内真实 RPC `automation.create` + `automation.run` 创建并执行
  （自动化 `b01428b0-f852-4645-94fa-a620f50e9f64`，运行
  `8c539f4a-1b9c-47a2-9eaf-f6c2a4652ca6`），命令
  `python3 -c "import sys; sys.stdout.write(chr(65)*40000)"`。

另在 `127.0.0.1:45999` 启动本地接收端记录 `/tmp/art-accept/leak-requests.log`，用于
HTML 隔离观察。

## 3. 规格 §12.2 逐项结果与证据

截图目录：`docs/evidence/assets/task-result-artifacts-2026-11-20/`。

### 第 1 步 Markdown 与 HTML 的唯一展示 — 生成 BLOCKED / 夹具唯一展示成立

- 真实生成：**BLOCKED**。第 2 轮已证明该回合 `request/header` 工具列表包含
  `result_present`（provider `deepseek-official`，model `local`），但连续 5 次
  `assistant/attempt` 只有 reasoning、没有 `tool-call`，日志为
  `[dsh-agent-error] ... [NO_ACTION]: 模型只返回了思考，没有调用工具，也没有给出结果。`
  本轮未再尝试，仍未由工具生成任何 Artifact。
- 夹具路径（**FIXTURE-FACILITATED**）：本轮重新打开会话 A，历史中恰好三张结果卡
  （验收报告 / 交互图表 / 历史结果（无锚点）），一张卡对应一个 Artifact，大小与存储一致；
  没有工具参数卡或旧附件重复正文。`df7107dd-…` 位于尾部“未定位的历史结果”分组。

### 第 2 步 卡片点击与右侧预览 — HTML 修复后通过

- Markdown（第 2 轮 **EXECUTED PASS**，本轮未重跑）：右栏展开、`预览` 页签选中、正文完整，
  截图 `01-md-preview.png`。
- HTML（本轮 **EXECUTED PASS**）：点击“交互图表”卡后，页面 `fetch` 包装记录到
  `artifact.get`、`artifact.content`，随后出现
  `POST /huaanwork/artifact/prepareFrame`，body 为
  `{"sessionId":"huaanwork-5a4497056ab88f0d-d573c1d2","artifactId":"f91d8aca-b5f6-4b9b-934b-97f0cff26352","surface":"main","frameName":"huaanwork-artifact-eb22f481-84b5-485b-9023-13ea75269b74"}`
  ——第 2 轮缺失的 prepareFrame 现已到达。`iframe.artifact-frame` 的 `srcdoc` 长度 3418，
  `sandbox="allow-scripts"`，正文渲染出“季度交互图表”、四根柱、滑块与“增加 Q1”按钮，
  无 `role="alert"`。截图 `05-html-preview-fixed.png`。
- 单次登记：`srcdoc` 自身 load 之后 prepareFrame 仍只有 **1** 次（one-shot guard 生效），
  没有重复请求。
- 跨会话（本轮 **EXECUTED PASS**）：切到会话 B 点击“第二会话结果”，右栏标题与正文为
  “第二会话结果”；切回会话 A 点击 HTML 卡，右栏标题“交互图表”，再次出现 prepareFrame
  （新 frame `huaanwork-artifact-00be7e87-…`），`srcdoc` 长度 3418。
- 结论：**EXECUTED PASS**（Markdown 与 HTML 均可用；跨会话无串页）。

### 第 3 步 独立全屏窗口 — HTML 全屏通过

- HTML 全屏（本轮 **EXECUTED PASS**）：点击“全屏”后出现第二个页面目标，
  URL 为
  `.../artifactWindow=1&sessionId=huaanwork-5a4497056ab88f0d-d573c1d2&artifactId=f91d8aca-b5f6-4b9b-934b-97f0cff26352`
  （双 ID 完整）。窗口 `performance.getEntriesByType("resource")` 记录到
  `artifact/get`、`artifact/content` 与 `artifact/prepareFrame`；`iframe.artifact-frame`
  的 `name=huaanwork-artifact-5238a003-…`、`srcdoc` 长度 3418、`src=null`、`sandbox=allow-scripts`。
  窗口内真实鼠标点击“增加 Q1”，Q1 从 12 变为 15，`data-bumps=1`。截图
  `07-fullscreen-html-fixed.png`。
- 关闭：点击“关闭”后该页面目标消失，主窗口 `E2ED2596…` 不变，主页面预览仍在。
- Markdown 全屏复用（第 2 轮 **EXECUTED PASS**，本轮未重跑）：同一 WebContents 两次读取
  正确双 ID，URL 从会话 A 切换到会话 B 后正文更新；`关闭` 与 `Escape` 均可返回。

### 第 4 步 HTML 交互与隔离 — 交互通过 / 隔离只记录应用内观测

- 交互（本轮 **EXECUTED PASS**，两个真实入口）：右栏预览内 CDP 真实鼠标点击
  “增加 Q1”后 `data-bumps` 1→2、Q1 12→15→18；滑块 `value=2` 触发 `input` 后柱高
  90/114/48/90 → 180/228/96/180。全屏窗口内同样点击成功（Q1 12→15）。截图
  `06-html-interaction.png`、`07-fullscreen-html-fixed.png`。
- 隔离（应用内观测，**EXECUTED**，不等于探针证据）：HTML 自带探针在 frame 内输出
  `interactive-ready / frames.length=0 /
  parent.document.title=blocked:SecurityError / top.location.href=blocked:SecurityError /
  cookie=blocked / window.open=null / form.submit=called / meta.refresh=inserted /
  top.navigate=threw:SecurityError / fetch=rejected:TypeError`。
  Electron 控制台在 HTML 装填期间（右栏、全屏与刷新后的重装，`02:35:19`/`02:36:48`/`02:41:31`）
  多次记录到 CSP 与 sandbox 拦截：
  `Connecting to 'http://127.0.0.1:45999/artifact-leak' violates ... "connect-src 'none'"`
  、`Blocked opening 'http://127.0.0.1:45999/artifact-popup' ... 'allow-popups' permission is not set`
  、`Blocked form submission to 'http://127.0.0.1:45999/artifact-form' ... 'allow-forms' permission is not set`。
  本地接收端 `127.0.0.1:45999` 在两次装填与交互过程中记录 **0** 条请求。动态插入的
  meta refresh 未使 frame 离开 `about:srcdoc`（正文与探针一直可见），也未产生监听端请求。
- 专用 Electron 探针：**NOT PASSED**（本轮未重跑；历史超时未消除），不作为本步骤证据。
- 结论：交互 **PASS**；隔离为**应用内可观测行为的通过记录**，探针级隔离仍 **NOT PASSED**。

### 第 5 步 下载另存为 — 通过（第 2 轮，本轮未重跑）

- 第 2 轮：系统保存面板默认名“验收报告.md”，保存文件 431 字节，
  `sha256=9b6fa877…d9a4` 与 `content.md` 和 manifest 一致，正文含中文与 `2026-11-20 <>&`；
  再次下载后取消，目录无新文件。结论 **EXECUTED PASS**，下载路径未被 D1 修复改动。

### 第 6 步 刷新与历史重开 — 刷新后 HTML 仍可装填

- 本轮在页面内执行 `location.reload()`，重新打开会话 A 后再点“交互图表”卡：重新出现
  `POST /huaanwork/artifact/prepareFrame`（新 frame `huaanwork-artifact-cba3fc10-…`），
  `srcdoc` 长度 3418，OOPIF 中正文与探针输出完整；三张卡与“未定位的历史结果”分组仍在。
  截图 `08-refresh-html-armed.png`。
- 边界：本轮仍只做渲染器刷新，没有退出并重启整个应用（Host 未重建）；该更强条件未验证。
- 结论：**EXECUTED PASS**（渲染器刷新）。

### 第 7 步 自动化新旧协议并存 — 脚本真实执行 / 新旧运行为夹具

- 新协议（**FIXTURE-FACILITATED**）：打开夹具任务“验收新协议运行”，运行骨架按持久化
  `RunSummary.artifactOutcome="created"` + `artifactId` 投影，正文只显示一张
  “自动化结果页”Artifact 卡（73 B），没有助手封套正文，也没有旧附件；随后是运行脚注
  “自动化运行完成”。截图 `09-run-new-protocol-card.png`。
- 旧历史运行（**FIXTURE-FACILITATED**）：打开夹具任务“验收旧协议运行”，运行摘要无
  `artifactOutcome`，会话助手正文为 JSON 对象，界面按旧折叠展示两个附件按钮
  `结果.md`、`结果.html`，没有 Artifact 卡；点击 `结果.md` 后右栏预览标题“结果.md”，
  JSON 被渲染为 Markdown 标题/段落/列表。截图 `10-run-legacy-attachments.png`。
- 脚本运行（**EXECUTED**，真实）：`automation.run` 立即返回 `queued:true`；落盘
  `automations/b01428b0-f852-4645-94fa-a620f50e9f64.runs.jsonl` 一行，
  `status:"ok"`、`output` 长度 **32774** 字符 = 32768 个 `A` + `…（已截断）`，即
  `OUTPUT_MAX_CHARS = 32 KiB` 截断行为不变；自动化页“运行记录”显示
  “今天 02:38 成功 验收脚本截断 · 1s · 脚本运行无会话”。截图 `11-script-run-history.png`。
- 结论：脚本运行记录与 32 KiB 截断 **PASS（真实）**；新旧协议展示 **PASS（夹具）**。

## 4. 汇总

| # | 步骤 | 结论 | 类别 |
| --- | --- | --- | --- |
| 1 | Markdown/HTML 唯一展示 | 工具生成 BLOCKED；夹具下唯一展示成立 | BLOCKED + FIXTURE-FACILITATED |
| 2 | 卡片点击与右侧预览 | Markdown 与跨会话通过；HTML 修复后通过 | EXECUTED |
| 3 | 独立全屏窗口 | HTML 全屏双 ID、prepareFrame、交互、关闭通过；Markdown 复用沿用第 2 轮 | EXECUTED |
| 4 | HTML 交互与隔离 | 两个入口交互通过；隔离仅应用内观测；探针 NOT PASSED | EXECUTED + 探针 NOT PASSED |
| 5 | 下载另存为 | 哈希/字节一致（含非 ASCII）；取消无新文件（第 2 轮） | EXECUTED |
| 6 | 刷新与历史重开 | 渲染器刷新后 HTML 重新 arm；卡片与未定位分组在 | EXECUTED（渲染器刷新） |
| 7 | 自动化新旧协议并存 | 脚本运行与 32 KiB 截断真实通过；新旧协议展示夹具通过 | EXECUTED + FIXTURE-FACILITATED |

## 5. 缺陷 D1 的修复与复核

**D1（已修复）：HTML Artifact 在右栏预览与全屏窗口中都不会装填正文。**

- 第 2 轮现象：`iframe.artifact-frame` 始终没有 `srcdoc`，没有错误提示；页面只出现
  `artifact.get` / `artifact.content`，从未出现 `artifact.prepareFrame`；手工调用
  `POST /huaanwork/artifact/prepareFrame` 却能立即返回 `{"prepared":true}`。
- 根因与修复：空 `about:blank` frame 的 load 可能在 React 挂上合成 `onLoad` 之前完成，
  该事件不会重放。`e594527042` 在 `ArtifactHtmlView` 的 frame 就绪 effect 中主动调用与
  `onLoad` 相同的 `requestPrepare`，保留 one-shot guard；`onLoad` 只兜底更晚的装载。
- 本轮复核：两个入口都观测到 prepareFrame、`srcdoc` 装填与真实交互，且 prepareFrame
  每个 frame 恰好一次。修复前截图 `02-html-preview-empty.png`、`04-fullscreen-html-empty.png`
  保留为历史对照。

## 6. 未执行与残留

- 未由 `result_present` 工具生成任何 Artifact；第 1 步生成仍为 BLOCKED。
- 未做整应用退出/重启后的恢复验收；第 6 步只做渲染器刷新。
- Electron 探针本轮未重跑，仍为 NOT PASSED；不得引用为渲染器隔离证据。
- 第 7 步新旧协议运行使用夹具（手写任务/运行摘要与克隆会话），只证明客户端投影行为；
  夹具会话的侧栏标题继承自克隆源，不是产品缺陷。
- 启动期日志出现 `initial Session restoration failed: ... waiting for jobs`（02:33:53、
  02:35:10、02:36:37），不影响本轮各步骤，未追查来源。
- 未修改产品源码或测试；临时实例与本地接收端已按 PID 关闭，生产 `~/.huaanwork` 未被写入。

## 7. 结论

- 构建：`corepack yarn workspace dsh-plugin-huaanwork build` 成功。
- 门禁：D1 修复提交之后 `corepack yarn check` 实跑 **EXIT=0**（`final-check-3.log`）。
- 探针：NOT PASSED（未重跑；历史超时仍在）。
- §12.2：HTML 预览、全屏、刷新与交互在真实应用中复核通过；隔离只记录应用内可观测行为；
  工具生成仍 BLOCKED；第 7 步脚本运行真实通过、新旧协议展示为夹具通过。
  本文件不声称整体验收或探针级隔离通过。
