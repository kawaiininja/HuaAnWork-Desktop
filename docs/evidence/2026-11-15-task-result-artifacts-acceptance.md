# 任务结果 Artifact 用户验收证据（规格 §12.2）

- 分支：`feat/task-result-artifacts-impl`
- 规格：`docs/superpowers/specs/2026-11-15-task-result-artifacts-design.md` §12.2
- 环境：macOS 27.0.0 / arm64；Node v22.23.2（Corepack Yarn 4.18.0）；Electron 44.0.0；本轮执行时间 2026-11-20 13:55–14:27 CST
- 构建：`corepack yarn workspace dsh-plugin-huaanwork build` + 根门禁 `corepack yarn check`（**EXIT=0**，含 D1–D5 全部修复）
- 探针：`corepack yarn workspace dsh-plugin-huaanwork test:artifact-sandbox`（**EXIT=0**，1 passed / 673 ms）
- 实例：干净临时副本 `DSH_HOME=/tmp/art-accept-v5/run/.huaanwork`、`--user-data-dir=/tmp/art-accept-v5/run/userData`、
  `--remote-debugging-port=9333`、`HUAANWORK_ACCEPTANCE_HOOKS=1`（固定 Web `43120`）。
  生产 `~/.huaanwork` 只被读取复制，未被写入（复核 mtime 未变，无 `artifacts/` 目录）。

## 0. 状态声明

本轮针对第 3 轮真机验收中的全部未通过/阻塞项执行根因排查、TDD 修复与全量实机复核（见 §5 D2–D5）：

- **根门禁与 Electron 探针**：`corepack yarn check` **EXIT=0**；`test:artifact-sandbox` **EXECUTED PASS**（修复 D3 顶层 await 死锁、动态 import 与 CDP frame URL 后 673 ms 通过，无孤儿 Electron 进程）。
- **第 1 步（Markdown / HTML 真实模型生成与唯一展示）**：**EXECUTED PASS**——修复 D2（`result_present` 漏入 `isRegisteredToolName`）后，真实模型 `deepseek-flash` 经 `result_present` 一次性生成 Markdown 报告与 HTML 交互图表，各仅一张 `ResultArtifactCard`，零工具参数卡/旧附件重复；修复 D4 后思考面板正常收起为「思考 · 已生成」。
- **第 2 步（卡片点击、右侧预览与跨会话一致性）**：**EXECUTED PASS**——两类真实 Artifact 在右栏「预览」正确渲染；`prepareFrame` 在 `srcdoc` 释放前单次完成；跨真实会话 A/B 切换无串页。
- **第 3 步（独立全屏窗口、跨会话复用、独占 session/访问头与关闭）**：**EXECUTED PASS**——同 WebContents 跨会话复用双 ID、CDP `Network.requestWillBeSentExtraInfo` 实测携带 `x-dsh-desktop-renderer`（43 字节，已脱敏）与独占 session `Cookie`、外部无头请求返回 HTTP 403、`localStorage` 与主窗口隔离、无业务 preload、`关闭` 按钮与 `Escape` 均干净关闭，主窗口与 RPC 不受影响。
- **第 4 步（HTML 交互与全量隔离）**：**EXECUTED PASS**——右栏预览（`surface="main"`）与全屏窗口（`surface="artifact"`）双入口均完成真实按钮/滑块交互截图，且均通过全部权限/网络（`fetch`/`XHR`/`WebSocket` CSP 违规）/弹窗/表单/顶层导航测试与生产 `installArtifactFrameGuard` 全部 5 类导航拦截（脚本自导航、链接、meta refresh、改名后导航、302 重定向入口），本地控制可达接收端 `127.0.0.1:45999` 均记录 **0** 请求；专用 Electron 探针同样 **PASS**。
- **第 5 步（下载另存为与取消）**：**EXECUTED PASS**——原生 macOS 保存面板保存真实生成的含中文与 `2026-11-20 <>&` 的 `验收报告.md`，落盘 496 字节与存储 `content.md` 及 `manifest.json` 的 SHA-256 逐字节一致；再次触发后取消返回 `{saved:false}` 且目录无新文件。
- **第 6 步（刷新、整应用退出重启、历史重开与未定位分组）**：**EXECUTED PASS**——修复 D5（整应用重启后 `work-1` 空预绑定标签阻止默认工作区会话回填历史）后，渲染器 `location.reload()` 与整应用退出重启（PID `28006` → `28857`，Host 完整重建）均恢复全部真实会话卡片、HTML `prepareFrame` 预览与下载；按规格 §12.2 #6 人为构造的无 `clientMessageId` 旧结果进入尾部「未定位的历史结果」分组。
- **第 7 步（自动化新旧协议并存与脚本 32 KiB 截断）**：**EXECUTED PASS**——新协议 Agent 自动化（真实创建并由真实模型运行产出 `<task-result-contract>` 封套）与脚本自动化（真实运行 40,000 字节 stdout 截断为 `32768 + "…（已截断）"`）均为真实执行；旧历史自动化运行（无 `artifactOutcome`、助手正文为 JSON 对象）为符合旧版落盘格式的构造历史样本，验证仍按旧双附件 `结果.md`/`结果.html` 展示并预览。

## 1. 构建、门禁与探针（实际执行）

| 项目 | 命令 | 结果 |
| --- | --- | --- |
| 全量根门禁 | `corepack yarn check` | **EXIT=0**（含 `dsh-plugin-huaanwork` 314 passed / 4 skipped，4619 passed / 15 skipped；全部 workspace 与 `verify:*` / `verify:aa` 通过） |
| 真实 Electron 沙箱探针 | `corepack yarn workspace dsh-plugin-huaanwork test:artifact-sandbox` | **EXIT=0**（1 passed / 1，耗时 673 ms；连续复跑 3 次稳定通过，零残留 Electron 进程） |

## 2. 实例、真实会话与边界样本

启动后 `http://127.0.0.1:9333/json/list` 出现主窗口 `43120`（`dsh-desktop-mode=advanced`）。本地接收端运行于 `127.0.0.1:45999`（支持 HTTP、WebSocket 与 `/redirect` 302 → `/received`，每次隔离测试前先验证外部控制请求可达再清零日志）。

- **真实会话 A** `huaanwork-4e79e226e5f3c1ad`（默认工作区会话）：
  - 回合 1（`clientMessageId=5d33f046-9649-48ba-bbce-a7e92c1b4ceb`）：真实模型调用 `result_present`（`callId=9789f21b-12d1-46f8-8877-575160a1e455`）生成 `9a4a4b80-11d6-40b3-8cff-e3b0932fa2b3`（`验收报告` / `markdown` / `496 B` / `sha256=b493d1e3a045e0816faf2bf689b157d18ee201f177dcb100ec82acebb7ac806d`）。
  - 回合 2（`clientMessageId=54ec0cfa-5669-460b-ac8f-a075fb20e30c`）：真实模型调用 `result_present`（`callId=db52a6ef-9faf-4652-a2db-8e9d18f5da9c`）生成 `b849b045-3239-497b-a0d4-699019924fa5`（`交互图表` / `html` / `4425 B` / `sha256=b0c8226510d3be890d24e5774e7c71b2a603f8c6a26ab752846663ff2bda783c`）。
  - 无锚点旧结果（按规格 §12.2 #6 经真实 `createArtifact` 构造）：`5ebd0289-f6fa-4c7f-b6a1-9b199f2df97e`（`历史结果（无锚点）` / `markdown` / `153 B` / `anchor={kind:"turn"}`）。
- **真实会话 B** `huaanwork-4e79e226e5f3c1ad-227aec93`（经「新建任务」创建）：
  - 回合 1（`clientMessageId=77b7cc47-4034-49ed-8f3d-adf2f5e99a45`）：真实模型调用 `result_present`（`callId=603c4715-4f0b-43b1-8d87-b3c6cc317eb2`）生成 `eb55a09c-1c39-4214-9dc4-80e0754ee6d3`（`第二会话结果` / `markdown` / `515 B`）。
- **真实自动化与历史兼容样本**：
  - 新协议 Agent 自动化（真实创建并运行）：`8f78de6c-64f2-44a8-9b30-9fa48e73f1e5`，运行 `7e1328a1-2e20-4076-a772-d780768befd3`，会话 `huaanwork-auto-8f78de6c-…`，任务 `4c1e1ed1-…`，模型真实输出 `<task-result-contract>` JSON 封套并生成 Artifact `80411f98-d35d-4fa2-b91e-4d1a1028d249`（`自动化实时验收报告` / `markdown` / `290 B`）。
  - 脚本自动化（真实创建并运行）：`f5e4a581-a6cb-4c89-93d3-40e13a150809`，运行 `da4aa687-addb-43b8-9a3c-9af7c77d5166`，命令 `python3 -c "import sys; sys.stdout.write(chr(65)*40000)"`。
  - 旧历史自动化样本（构造的改版前数据：无 `artifactOutcome`、单条助手消息为 JSON 对象、`session.v4.jsonl.zstd` 落盘）：自动化 `7a3c7dfb-…`、运行 `d12a22a7-…`、会话 `huaanwork-legacy-auto-782910f7`。

## 3. 规格 §12.2 逐项结果与证据

截图目录：`docs/evidence/assets/task-result-artifacts-2026-11-20/`（本轮新增 `12-*` 至 `21-*`；历史对比图 `01-*` 至 `11-*` 保留）。

### 第 1 步 Markdown 与 HTML 的唯一展示 — EXECUTED PASS

- 会话导出核对（`session.v4.jsonl.zstd` 37 条记录）：
  - Turn 1：`user/message (5d33f046-…)` → `assistant/message`（`reasoning` + `tool-call result_present`, `argsLen=286`）→ `tool/result`（`已生成结果页“验收报告”。artifactId: 9a4a4b80-…`）→ `assistant/message`（简短说明）→ `turn/end completed`。
  - Turn 2：`user/message (54ec0cfa-…)` → `assistant/message`（`reasoning` + `tool-call result_present`, `argsLen=4602`）→ `tool/result`（`已生成结果页“交互图表”。artifactId: b849b045-…`）→ `assistant/message`（简短说明）→ `turn/end completed`。
- 界面核对：会话 A 中仅两张 `ResultArtifactCard`（`验收报告 Markdown 496 B`、`交互图表 HTML 4.3 KB`），`toolCards=[]`、`legacyBtns=[]`，两轮思考面板均收起为「思考 · 已生成」，无正文重复铺开。
- 截图：`12-step1-real-generated-cards.png`。

### 第 2 步 卡片点击与右侧预览 — EXECUTED PASS

- Markdown：点击「验收报告」卡后右栏展开、`预览` 页签激活，渲染二级标题「验收摘要」、三项列表、两列表格及含 `2026-11-20 <>&` 说明段。截图：`13-step2-md-preview.png`。
- HTML：点击「交互图表」卡后，页面 `fetch` 追踪记录到 `artifact.get` → `artifact.content` → `POST /huaanwork/artifact/prepareFrame`（请求与响应时 `srcdocLen=0`，单次登记不重复），确认后装填 `srcdoc`（长度 `4623`、`hasCspFirst=true`、`sandbox="allow-scripts"`、`src=null`），正文渲染四根季度柱、按钮与滑块。截图：`14-step2-html-preview.png`。
- 跨会话一致性：切至真实会话 B 点击「第二会话结果」，右栏标题与正文切换为「第二会话结果」；切回会话 A 点击「交互图表」，重新触发 `prepareFrame` 并渲染 `srcdocLen=4623`，无串页。

### 第 3 步 独立全屏窗口 — EXECUTED PASS

- HTML 全屏：点击「全屏」打开目标 `2D76FD0693E382053FAE3E3C53B5F84A`，URL 含双 ID `artifactWindow=1&sessionId=huaanwork-4e79e226e5f3c1ad&artifactId=b849b045-3239-497b-a0d4-699019924fa5`；`performance` 含 `artifact/get`、`artifact/content`、`artifact/prepareFrame`；`iframe.artifact-frame` 具备 `sandbox="allow-scripts"`、`src=null`、`srcdocLen=4623`、`hasCspFirst=true`。
- 独占 session 与访问头：
  - 主窗口写入 `localStorage.__main_canary__` 后，全屏窗口读取为 `null`，确认非持久独占 partition 隔离；`window.huaanworkAcceptance` / `window.dshDesktop` 均不存在（无业务 preload）。
  - CDP `Network.enable` + `Network.requestWillBeSentExtraInfo` 实测全屏窗口请求携带 `x-dsh-desktop-renderer: <redacted len=43>` 与 `Cookie: <redacted len=226>`，窗口内同源 `artifact.get` 返回 HTTP `200`；外部无头无 Cookie 请求同一 URL 返回 HTTP `403`。
- 跨会话复用：保持全屏窗口打开，切至会话 B 对「第二会话结果」点击「全屏」，**同一 WebContents 目标 ID** `2D76FD0693E382053FAE3E3C53B5F84A` 复用，URL 更新为 `sessionId=huaanwork-4e79e226e5f3c1ad-227aec93&artifactId=eb55a09c-1c39-4214-9dc4-80e0754ee6d3`，正文切换为「第二会话结果」。截图：`15-step3-fullscreen-reuse-md.png`。
- 关闭与主窗口完好：点击「关闭」按钮后全屏目标数归 0；再次打开后发送 `Escape` 键，全屏目标数归 0；主窗口目标 ID 未变，主窗口调用 `artifact.list` 返回 HTTP `200`（`count=2`），布局与会话消息不变。

### 第 4 步 HTML 交互与隔离 — EXECUTED PASS（双入口实机 + 专用 Electron 探针）

- 双入口交互：
  - 右栏预览 OOPIF：真实鼠标点击 `#bump` 两次（Q1 `12 → 18`），拖动 `#scale` 至 `2.0×`。截图：`16-step4-right-interaction.png`。
  - 全屏窗口 OOPIF：真实鼠标点击 `#bump`（Q1 `12 → 15`），拖动 `#scale` 至 `2.0×`。截图：`17-step4-fullscreen-interaction.png`。
- 双入口全量隔离（每次测试前均验证 `http://127.0.0.1:45999/control-<surface>` 可达并写入日志，再 `/__reset` 清零）：
  - **右栏预览（`surface="main"`）**：`requireDenied=true`、`processDenied=true`、`openerDenied=true`、`parentDenied=true`、`topNavDenied=true`、`popupDenied=true`、`fetchDenied=true`、`xhrDenied=true`、`wsProbe={denied:true, violation:"ws://127.0.0.1:45999/ws-main"}`、`formStayed=true`；5 类生产 `installArtifactFrameGuard` 导航尝试（`script`、`link`、`meta`、`renamed`、`redirect`）全部停留在 `about:srcdoc`（`hasBump=true`），本地接收端记录 **0** 条请求。
  - **全屏窗口（`surface="artifact"`）**：同套检查全部通过（`wsProbe.violation="ws://127.0.0.1:45999/ws-artifact"`），5 类导航尝试全部停留在 `about:srcdoc`（`hasBump=true`），本地接收端记录 **0** 条请求。
- 专用 Electron 探针：`corepack yarn workspace dsh-plugin-huaanwork test:artifact-sandbox` **EXIT=0**（673 ms），验证 HTTP/WS control 正例、`connect-src` WebSocket 违规、无特权、表单/弹窗/顶层导航拒绝及 5 类 `will-frame-navigate` 真实 `preventDefault` 零请求。

### 第 5 步 下载另存为 — EXECUTED PASS

- 对真实生成的 Markdown 结果「验收报告」点击「下载」，通过原生 macOS 保存对话框保存到 `/private/tmp/art-accept-v5/downloads-post-restart/验收报告.md`，RPC 返回 `{"saved":true,"path":"/private/tmp/art-accept-v5/downloads-post-restart/验收报告.md"}`。
- 字节与哈希核对：保存文件 `496` 字节，与存储 `content.md` 逐字节相等（`byteEqual=true`），SHA-256 `b493d1e3a045e0816faf2bf689b157d18ee201f177dcb100ec82acebb7ac806d` 与 `content.md` 及 `manifest.json` 完全一致，含中文与 `2026-11-20 <>&`。
- 取消验证：再次点击「下载」并在保存面板按 `Escape`，RPC 返回 `{"saved":false}`，目标目录仍只有 `验收报告.md` 1 个文件（无新文件生成）。

### 第 6 步 刷新与历史重开 — EXECUTED PASS（渲染器刷新 + 整应用退出重启）

- 整应用退出与重启：终止 Electron 与 Host（PID `28006`），确认 `9333` 端口关闭后全新启动（PID `28857`，Host 完整重建）。
- 重开默认工作区会话 A（触发 D5 修复路径）：空白预绑定 `work-1` 标签原地回填全部历史与 3 张卡片（回合 1 `验收报告`、回合 2 `交互图表`，以及尾部「未定位的历史结果」分组下的 `历史结果（无锚点）` 153 B）；点击「交互图表」后重新 `prepareFrame` 并装填 `srcdocLen=4623`；点击「验收报告」执行上述第 5 步下载与取消均成功。截图：`18-step6-full-restart-reopen.png`。
- 渲染器刷新（`location.reload()`）：刷新后重开会话 A，3 张卡片、「未定位的历史结果」分组与 HTML `srcdocLen=4623` 仍完整可用。
- 重开历史会话 B：重新打开会话 B，显示「第二会话结果 Markdown 515 B」卡片，无串页、无告警。

### 第 7 步 自动化新旧协议并存 — EXECUTED PASS

- 新协议 Agent 自动化（**真实执行**）：`automation.create` + `automation.run` 触发真实模型产出 `<task-result-contract>` 封套，落盘 `RunSummary` 带 `artifactOutcome="created"`、`artifactId="80411f98-…"`；从「运行记录」打开该运行后，思考面板收起为「思考 · 已生成」（D4 修复生效），正文仅显示 1 张「自动化实时验收报告 Markdown 290 B」Artifact 卡，无原始 JSON 封套、无旧双附件；点击卡片在右栏正确渲染 Markdown。截图：`19-step7-real-agent-run.png`。
- 旧历史自动化运行（**构造旧版历史样本**）：无 `artifactOutcome`、单条 JSON 助手消息，打开后按旧折叠显示 `结果.md` 与 `结果.html` 两个附件按钮、零 Artifact 卡；点击 `结果.md` 在右栏预览将 JSON 渲染为 Markdown。截图：`20-step7-legacy-attachments.png`。
- 脚本运行（**真实执行**）：`automation.create` + `automation.run` 输出 40,000 字节 `'A'`，落盘 `runs.jsonl` 记录 `status="ok"`、`output.length=32774`（`32768 × 'A' + "…（已截断）"`）、无 `artifactOutcome` 字段；「运行记录」列表显示「成功 真机验收脚本 32KiB 截断 · 1s 脚本运行无会话」。截图：`21-step7-run-history.png`。

## 4. 汇总

| # | 步骤 | 结论 | 类别 |
| --- | --- | --- | --- |
| 1 | Markdown/HTML 唯一展示 | 真实模型经 `result_present` 生成两类结果，各仅 1 卡、零重复、思考正常收起 | EXECUTED PASS |
| 2 | 卡片点击与右侧预览 | Markdown/HTML 渲染、`prepareFrame` 先于 `srcdoc`、跨真实会话无串页 | EXECUTED PASS |
| 3 | 独立全屏窗口 | 同 WebContents 复用双 ID、实测 `x-dsh-desktop-renderer` 与独占 session、关闭/Esc 与主窗口完好 | EXECUTED PASS |
| 4 | HTML 交互与隔离 | 双入口真实交互、全量权限/网络/5 类导航零请求 + 专用 Electron 探针 PASS | EXECUTED PASS |
| 5 | 下载另存为 | 原生保存框落盘 496 B 字节与 SHA-256 一致（含非 ASCII），取消零新文件 | EXECUTED PASS |
| 6 | 刷新与历史重开 | 渲染器刷新与整应用退出重启均恢复卡片/预览/下载，无锚点结果归入「未定位的历史结果」 | EXECUTED PASS |
| 7 | 自动化新旧协议并存 | 新协议 Agent 与 32 KiB 脚本真实运行通过；旧历史样本双附件兼容通过 | EXECUTED PASS |

## 5. 真机验收发现并修复的缺陷清单（D1–D5）

1. **D1（第 2–3 轮已修复，`e594527042`）**：HTML Artifact 空 `about:blank` iframe 的 `load` 早于 React 挂监听导致 `prepareFrame` 永不触发。已在 `ArtifactHtmlView` 的 effect 中主动触发带 one-shot guard 的 `requestPrepare`。
2. **D2（本轮修复，`src/huaanwork-guardrails/model.ts`）**：**第 1 步真实模型调用 `result_present` 失败（`EMPTY_RESPONSE` / `NO_ACTION`）**。
   - **根因**：`result_present` 已注册并在 `policy.ts` / `decide.ts` 放行，但遗漏在 `HuaAnWorkAdapter` 的静态工具名白名单 `isRegisteredToolName()` 之外。模型在思考后发起原生 `result_present` SSE `tool_calls` 时，被 `parseSseToolCalls(..., isRegisteredToolName)` 静默丢弃，适配器误判为只输出了思考或空响应并重试直至 `NO_ACTION`。
   - **修复与回归测试**：将 `result_present` 加入 `isRegisteredToolName()`，并在 `tests/huaanwork-guardrails/model.spec.ts` 新增流式思考 + `result_present` 调用的端到端适配器回归测试。
3. **D3（本轮修复，`tests/electron/artifact-sandbox-main.mjs`、`tests/electron/artifact-sandbox-probe.electron.ts`）**：**专用 Electron 沙箱探针 30s 超时并泄漏孤儿进程**。
   - **根因**：① 主入口 `artifact-sandbox-main.mjs` 顶层使用 `await app.whenReady()`，在 Electron 44 ESM 主模块加载中造成启动死锁，DevTools 端口永不就绪导致 `electron.launch()` 挂死；② `app.evaluate()` 中执行动态 `import(input.mainUrl)` 在 Electron 44 `Runtime.evaluate` 上下文抛 `TypeError: A dynamic import callback was not specified`；③ 断言 `frame.url()` 受 Chromium CDP 对 sandboxed `srcdoc` frame 保留 `about:blank` 的影响，未读取 frame 内真实 `location.href`。
   - **修复**：改为 `app.whenReady().then(...)` 异步初始化并通过 `globalThis.__huaanworkArtifactSandboxProbe` 暴露探针句柄；为 `electron.launch` 配置 `timeout: 15_000` 防止孤儿进程；断言 `frame.evaluate(() => ({ href: location.href, ran: Reflect.get(window, "ran") }))` 等于 `{ href: "about:srcdoc", ran: true }`。探针 673 ms 稳定通过。
4. **D4（本轮修复，`src/client-huaanwork/logic/thinkingPanel.ts`）**：**真实模型经 `result_present` 或新协议自动化产出结果卡后，思考面板滞留在「思考 · 进行中」不收起**。
   - **根因**：`hasAssistantTextAfter()` 扫描本轮可见产出时只认 `assistant`（且 `roundKey` 不同会提前终止），未将 `artifact` / `artifact-error` 视为本步可见结果（不同于旧 `attachment` 被映射成 `assistant`）。
   - **修复与回归测试**：在 `hasAssistantTextAfter()` 中把 `artifact` 与 `artifact-error` 计为可见产出（排除 `artifact-group` 与 `artifact-loading`），并在 `tests/client-huaanwork/thinkingPanel.spec.ts` 补齐单测。
5. **D5（本轮修复，`src/client-huaanwork/App.tsx`）**：**整应用退出重启后，点击侧栏重开默认工作区会话停留在空白欢迎页，历史与 Artifact 无法打开**。
   - **根因**：启动期 `bindDefaultTabSessions()` 会把空欢迎标签 `work-1`（`items: []`）预绑定到默认工作区稳定会话 ID；用户点击侧栏重开该会话时，`resumeFromView()` 只按 `tab.sessionId === sessionId` 命中该空标签并跳过 `historyItemsWithArtifacts(view)`；同时 WS ready 时的 `reconcileBoundArtifacts()` 若不跳过空标签，会把旧 Artifact 倾倒进空白欢迎页。
   - **修复与回归测试**：`resumeFromView()` 仅将 `items.length > 0` 的已有标签视为权威运行态，空预绑定标签走历史回填分支原地填充记录与 Artifact；`reconcileBoundArtifacts()` 跳过空标签。在 `tests/client-huaanwork/appWiring.spec.ts` 新增回归测试。

## 6. 清理与未触碰说明

- 临时 Electron 进程与 `127.0.0.1:45999` 接收端均已关闭，复核 `9333`、`43120`、`45999` 端口全部释放。
- 生产 `~/.huaanwork` 未被写入；`deepseek-harness/` 子模块零修改。
- 历史遗留日志 `initial Session restoration failed: ... waiting for jobs / web` 来自 `profile.ts` 硬禁用上游 `tool-jobs` / `tool-web` 插件时的上游默认恢复尝试，与 Artifact 链路无关，不影响全部 7 步实机功能。

## 7. 结论

- 构建与根门禁：`corepack yarn check` **EXIT=0**。
- Electron 沙箱探针：`corepack yarn workspace dsh-plugin-huaanwork test:artifact-sandbox` **EXIT=0**（673 ms）。
- 规格 §12.2 全部 7 项用户验收步骤在修复 D2–D5 后均已真实执行通过（仅规格要求的旧无锚点结果与旧无 `artifactOutcome` 历史运行按既有落盘格式构造）。
