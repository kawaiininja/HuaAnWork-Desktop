# 任务结果 Artifact 用户验收证据（规格 §12.2）

- 分支：`feat/task-result-artifacts-impl`
- 提交：`8950c258c5`（门禁 `EXIT=0` 的当前 HEAD）
- 规格：`docs/superpowers/specs/2026-11-15-task-result-artifacts-design.md` §12.2
- 环境：macOS 27.0.0 / arm64；Node v24.22.1；执行时间 2026-11-20 02:19–02:31 CST
- 实例：临时 `DSH_HOME=/tmp/art-accept/run/.huaanwork`（生产 `~/.huaanwork` 的副本），
  `--user-data-dir=/tmp/art-accept/run/userData`，`--remote-debugging-port=9333`，
  `HUAANWORK_ACCEPTANCE_HOOKS=1`（固定 Web `43120`）

## 0. 状态声明

本轮实际启动了桌面实例并逐步执行 §12.2，结论**部分通过、一项发现产品缺陷、一项未完成**：

- 已执行并通过（真实 UI + 真实存储）：第 3 步、第 5 步、第 6 步的刷新/重开部分、第 2 步的 Markdown 与跨会话切换部分。
- 夹具辅助（`result_present` 工具生成未发生，Artifact 经受控脚本调用真实宿主存储
  `createArtifact` 写入）：第 1 步的“结果卡唯一展示”、第 2 步的卡片/预览入口、第 6 步的未定位分组。
- 未通过 / 阻塞：第 4 步（HTML 交互与隔离）——预览与全屏的 HTML frame 从未装填正文，
  见 §5 缺陷 D1；第 1 步的工具生成（模型未调用 `result_present`）。
- 未完成：第 7 步（自动化新旧协议并存）——未写入运行夹具，未核对自动化运行界面。
- Electron 沙箱探针：一次重试后仍超时，记录为 NOT PASSED（已知非阻断遗留项）。

任何一步都没有用单元测试、探针或夹具冒充真机结果；未观测到的行为一律记为未通过/未完成。

## 1. 门禁与探针（实际执行）

| 项目 | 命令 | 结果 |
| --- | --- | --- |
| 根门禁 | `corepack yarn check` | `EXIT=0`（`.superpowers/sdd/2026-11-15-task-result-artifacts/final-check-2.log` 末行 `EXIT=0`；本轮未重跑） |
| Electron 探针（唯一一次重试） | `corepack yarn workspace dsh-plugin-huaanwork test:artifact-sandbox` | `EXIT=1`；`Tests 1 failed (1)`，`Test timed out in 30000ms`，用时 30.35 s |

探针两次历史超时（本轮之前）加本轮一次重试，均在同一处挂起；本轮遗留探针 Electron
（PID 91857）已按 PID 终止。探针状态：**NOT PASSED**，不能作为 §12.1 第 9 条或 §12.2 第 4 条
的渲染器隔离证据。

## 2. 实例与夹具（实际执行）

启动（后台）后 `http://127.0.0.1:9333/json/list` 出现唯一 `43120` 页面目标，标题
`DeepSeek Harness`，URL 含 `dsh-desktop-mode=advanced&...`。应用内完成：

1. 新建会话 A 并发送一条用户消息，模型真实回复“收到”（会话
   `huaanwork-5a4497056ab88f0d-d573c1d2`，用户消息 id `32d00f46-c775-401b-8395-dfba1645165f`，
   即该回合的 `clientMessageId`）。
2. 新建会话 B 并发送一条用户消息，模型回复“好的”（会话
   `huaanwork-5a4497056ab88f0d-49342e7e`，`clientMessageId=7d798e87-ac9c-4caf-9ec9-1cf11749cdb1`）。
3. 用 Node 直接导入 `src/huaanwork-host/artifacts-host.ts` 的真实存储 API `createArtifact`
   （同一 `profileDir`、同一两阶段写入与目录布局），写入四个 Artifact：

| Artifact | 会话 | 锚点 | 标题/格式 | 大小 |
| --- | --- | --- | --- | --- |
| `50a1e395-…` | A | `clientMessageId=32d00f46-…` | 验收报告 / markdown | 431 B |
| `f91d8aca-…` | A | `clientMessageId=775d7241-…`（第二回合） | 交互图表 / html | 3.1 KB |
| `df7107dd-…` | A | `{kind:"turn"}`（无 `clientMessageId`） | 历史结果（无锚点）/ markdown | 107 B |
| `9cdef403-…` | B | `clientMessageId=7d798e87-…` | 第二会话结果 / markdown | 94 B |

落盘校验：`artifacts/<sessionId>/<artifactId>/{manifest.json,content.md|content.html}`，清单
`sha256` 与正文一致。生产 `~/.huaanwork` 仅被读取复制，未被写入。

另在 `127.0.0.1:45999` 启动本地接收端并记录 `/tmp/art-accept/leak-requests.log`，用于
HTML 隔离观察（见第 4 步）。

## 3. 规格 §12.2 六项 UI 结论（逐条，含证据）

截图目录：`docs/evidence/assets/task-result-artifacts-2026-11-20/`。

### 第 1 步 Markdown 与 HTML 的唯一展示 — 生成 BLOCKED / 夹具部分执行

- 真实模型尝试：在会话 A 第二回合要求“调用 result_present 提交 Markdown 结果页”。
  该回合的 `request/header` 工具列表确实包含 `result_present`（同时含 `bash`、`write`、
  `screenshot` 等，模型 `deepseek-official/local`），证明工具已挂载到模型面。
- 结果：连续 5 次 `assistant/attempt` 只产出 reasoning，没有 `tool-call`；日志
  `[dsh-agent-error] ... [NO_ACTION]: 模型只返回了思考，没有调用工具，也没有给出结果。`。
  因此**没有**任何 Artifact 由工具生成；生成结论 **BLOCKED**（端点可用、工具可见、
  模型未按指令调用）。
- 夹具路径：上面四个 Artifact 经真实存储写入后，会话 A 历史中每个 Artifact 只出现一张卡
  （`card artifact-card`：验收报告、交互图表、历史结果（无锚点）），卡上正文摘要
  “431 B / 3.1 KB” 与存储一致；因不存在 `result_present` 工具调用，工具参数卡里没有重复
  正文，旧附件预览也没有重复（无工具调用可折叠）。因此“唯一展示”只在夹具数据上成立，
  不能替代真实生成路径。

### 第 2 步 卡片点击与右侧预览 — Markdown 通过 / HTML 未通过

- Markdown：点击“验收报告”卡后右栏展开、标题“验收报告”、`预览` 页签为选中态，
  正文按 Markdown 渲染（标题、两项列表、两列表格、中文段落完整）。截图
  `01-md-preview.png`。结论：**EXECUTED PASS**。
- 跨会话一致性：切到会话 B 后右栏预览标题为“第二会话结果”，切回会话 A 后为“验收报告”，
  无串页。结论：**EXECUTED PASS**。
- HTML：点击“交互图表”卡后右栏标题正确，但 `<iframe class="artifact-frame"
  sandbox="allow-scripts">` 始终没有 `srcdoc`、没有正文、也没有错误提示（截图
  `02-html-preview-empty.png`）。结论：**NOT PASSED**，缺陷见 §5 D1。

### 第 3 步 独立全屏窗口 — 通过

- 从 Markdown 预览点“全屏”后出现第二个 CDP 页面目标，URL 为
  `.../artifactWindow=1&sessionId=huaanwork-5a4497056ab88f0d-d573c1d2&artifactId=50a1e395-6178-4714-90ac-2839d65337f4`，
  窗口内正文完整渲染，按钮为“关闭”“下载”（截图 `03-fullscreen-md.png`）。
- 复用：切到会话 B 打开其结果并点“全屏”，**同一页面目标 id**
  `15BB7633FD535BAD1D0EFFD468BEB43B` 的 URL 变为 `sessionId=…-49342e7e&artifactId=9cdef403-…`，
  正文变为“第二会话结果”。结论：同一 WebContents 两次读取正确双 ID。
- 关闭：点“关闭”后该目标消失；再次打开后发送 `Escape` 键，目标同样消失，主窗口
  (`574B343A…`) 不变。随之在主窗口调用 `artifact.list` 返回 HTTP 200（1 条），
  主会话布局与消息未变。结论：**EXECUTED PASS**。
  “独占 session 的鉴权/访问头记录”未直接读取窗口请求头，此处只验证了双 ID 与 RPC 归属校验。

### 第 4 步 HTML 交互与隔离 — 未通过（被 D1 阻塞）

- 两个真实入口（右栏预览、全屏窗口）都只显示标题/按钮，frame 正文为空，无法操作内联图表
  交互（无按钮、无滑块），因此**没有交互成功截图**。
- 因正文从未装填，本地接收端 `127.0.0.1:45999` 在整个过程记录到 **0** 条请求；这不能归因于
  沙箱防护，因为模型 HTML 从未进入 frame。父应用/网络/弹窗/表单/顶层导航的不可达性
  未能在应用内观测。结论：**NOT PASSED**（不引用 Task 6 探针结果替代）。
- 可作参考的旁证（不属于本步骤的应用内证据）：以当前 frame 名手工调用
  `POST /huaanwork/artifact/prepareFrame` 立即返回 `{"prepared":true}`（HTTP 200，2 ms），
  说明原生防护登记本身可用，问题在客户端 `onLoad → prepareFrame` 的接线从未触发（D1）。

### 第 5 步 下载另存为 — 通过

- 在 Markdown 预览点“下载”，弹出系统保存面板，默认文件名“验收报告.md”（含中文，
  截图已记录于 /tmp/art-accept/screen-dialog.png），用 System Events `Cmd+Shift+G`
  输入目录后 `Return` 保存。
- 保存文件 `downloads/验收报告.md`，431 字节，`sha256=9b6fa877…d9a4`，与
  `artifacts/huaanwork-5a4497056ab88f0d-d573c1d2/50a1e395-…/content.md` 的 sha256 及
  manifest 的 `sha256` 完全一致；正文含中文标题、中文表格单元格与 `2026-11-20 <>&`。
- 再次点“下载”后在面板按 `Escape` 取消，目标目录仍只有这一个文件（无新文件）。
  结论：**EXECUTED PASS**。

### 第 6 步 刷新与历史重开 — 通过（渲染器刷新；未做整应用重启）

- 在页面内执行 `location.reload()`（渲染器刷新）后重新打开会话 A：三张卡仍在，
  未定位的“历史结果（无锚点）”位于尾部“未定位的历史结果”分组内。
- 随后切到会话 B 再切回会话 A（重开历史会话）：卡片、右栏预览与“下载”入口均可用
  （第 5 步的保存与取消都是在刷新之后完成）。结论：**EXECUTED PASS**。
- 边界说明：本轮只做渲染器刷新，没有退出并重启整个应用（Host 未重建）；该更强条件
  未验证。

### 第 7 步 自动化新旧协议并存 — 未完成

- 未写入 `automations/<autoId>.runs.jsonl` 的 RunSummary 夹具，也未在自动化页核对
  “新运行一张卡 / 旧运行双附件 / 脚本 32 KiB 截断”。本轮预算用于前面步骤后剩余不足，
  未执行，结论为 **NOT COMPLETED**（不是通过，也不是产品失败）。

## 4. 汇总

| # | 步骤 | 结论 | 类别 |
| --- | --- | --- | --- |
| 1 | Markdown/HTML 唯一展示 | 工具生成 BLOCKED；夹具下唯一展示成立 | BLOCKED + FIXTURE-FACILITATED |
| 2 | 卡片点击与右侧预览 | Markdown 与跨会话通过；HTML 未通过（D1） | EXECUTED（部分） |
| 3 | 独立全屏窗口 | 双 ID、同窗复用、按钮/Esc 关闭、主窗口 RPC 正常 | EXECUTED |
| 4 | HTML 交互与隔离 | frame 未装填，交互与隔离均未观测 | NOT PASSED（D1 阻塞） |
| 5 | 下载另存为 | 哈希/字节一致（含非 ASCII）；取消无新文件 | EXECUTED |
| 6 | 刷新与历史重开 | 刷新后卡片/预览/下载可用；未定位分组正确 | EXECUTED（渲染器刷新） |
| 7 | 自动化新旧协议并存 | 未执行夹具与界面核对 | NOT COMPLETED |

统计：3 项执行通过（3、5、6），1 项部分执行（2），1 项夹具辅助（1 的 UI 部分），
1 项未通过（4），1 项未完成（7）；探针 NOT PASSED。

## 5. 发现的产品缺陷（未修复）

**D1：HTML Artifact 在右栏预览与全屏窗口中都不会装填正文，且无错误提示。**

- 现象：点击 HTML 结果卡后，右栏出现 `iframe.artifact-frame[name^="huaanwork-artifact-"]`，
  `sandbox="allow-scripts"`，但始终没有 `srcdoc` 属性，正文与交互均不可见，也没有
  `role="alert"` 错误或重试入口（截图 `02-html-preview-empty.png`、
  `04-fullscreen-html-empty.png`）。全屏窗口同样只剩“关闭”“下载”。
- 客户端行为：在页面内包装 `window.fetch` 后重复点击 HTML 卡（含一次冷启动后首次点击），
  只看到 `artifact.get` 与 `artifact.content`，**从未** 出现 `artifact.prepareFrame`；
  等待 30 s 以上也无错误提示（`ArtifactHtmlView` 的失败分支没有被触发）。
- 原生侧对照：用该 frame 的完整名称手工 `POST /huaanwork/artifact/prepareFrame`
  返回 HTTP 200 `{"prepared":true}`（2 ms），说明防护登记与路由可用。
- 结论：`ArtifactHtmlView` 的空 frame `onLoad`（用于触发 `prepareFrame` 并武装正文）
  在真实 Electron 中没有走到回调；在页面内用同样 `sandbox`/`about:blank` 的 iframe
  先挂 `load` 监听再插入时 `load` 会触发，因此高度怀疑 React 插入 iframe 的时机与该
  `about:blank` 同步 load 之间存在竞态。未修复，未改源码/测试。

## 6. 未执行的操作与残留

- 未由 `result_present` 工具生成任何 Artifact；第 1 步的“唯一展示”只对应夹具。
- 未做整应用退出/重启后的恢复验收；第 7 步没有运行夹具或查看自动化界面。
- 未直接读取全屏窗口的请求头/access header，只验证双 ID 与 RPC 归属。
- Electron 沙箱探针仍挂起并遗留孤儿进程（本轮已清理）；建议补启动超时，避免 CI/人工
  验收被 30 s 超时和残留进程拖住。
- 未修改产品源码、测试或共享夹具；临时实例与本机接收端已在结束时关闭。

## 7. 结论

- 门禁：`EXIT=0`（`final-check-2.log`）。
- 探针：NOT PASSED（超时，一次重试后仍挂起；孤儿已清理）。
- §12.2：Markdown 展示、全屏窗口、下载另存为、刷新/重开与未定位分组在真实应用中得到验证；
  HTML 预览/全屏被缺陷 D1 挡住（第 2、4 步未通过）；工具生成被模型行为挡住（第 1 步
  BLOCKED）；第 7 步未完成。本文件不声称整体验收通过。
