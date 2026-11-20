# 任务结果 Artifact（`feat/task-result-artifacts-impl`）Code Review — GLM 审核结论

> **审核方声明：本文档为 GLM 审核结论。** 评审由 GLM（CodeBuddy，模型 `glm-5.3`）完成：先以三个并行 GLM 评审代理分别覆盖 Host 数据层 / Electron 安全 / Client UI 三域，再由 GLM 主审对全部发现逐条做「去误报、消夸大、查漏报、校事实」的独立校准复核（第一节）。除标注「采信评审代理报告」的低风险 Nit 外，所有发现的源码证据均经主审直接读码核实。

- **日期：** 2026-11-20
- **审阅目标：** 分支 `feat/task-result-artifacts-impl`
  - 基线：`origin/master`（`a423eef9fc048fa6b50d8c8047dc188f32a8369b`）
  - 分支 `HEAD`：`cbb63e967356e27c3f6d389340e4664cc892e7d9`（25 个提交，106 个文件，`12447 insertions(+), 508 deletions(-)`）
  - 评审时工作树干净且检出该分支，全程只读，未修改任何文件
- **对照依据：**
  - 设计规格：[2026-11-15-task-result-artifacts-design.md](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/docs/superpowers/specs/2026-11-15-task-result-artifacts-design.md)（13 章 + 需求 R1-R10）
  - 实施计划：[2026-11-15-task-result-artifacts.md](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/docs/superpowers/plans/2026-11-15-task-result-artifacts.md)（9 个 Task，含实施状态更新）
  - 计划评审结论（2026-11-19）：2 Minor（§7.1 测试钉 / §7.2 渲染失败兜底）+ 3 Nit，当时判定「实施时随手补钉」
  - 验收证据：[2026-11-15-task-result-artifacts-acceptance.md](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/docs/evidence/2026-11-15-task-result-artifacts-acceptance.md)（真机七项 PASS、`yarn check` EXIT=0、D1-D5 修复记录）
- **最终判定：** **Approve with comments（0 Critical / 1 Important / 7 Minor / 8 Nit）。** 三域实现与规格 §5-§12、计划 Task 1-9 的对应关系经实证成立；合并前须处置 Important-1（规格 §7.2 渲染失败兜底未实现），其余发现不阻塞。

---

## 一、校准说明（Double-Check 结果）

三域初审完成后，主审对全部 16 项发现逐条反证复核，另对亮点声明做抽查、对未被初审覆盖的横切面做对抗性排查：

| 类别 | 初审结论 / 复核对象 | 复核事实与源码依据 | 校准处理 |
| --- | --- | --- | --- |
| **去误报（撤除 1 项子声明）** | Client Minor「ChatTab 注释与行为不一致」 | [App.tsx:379](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/App.tsx#L379) 注释原文为「**选择**记在标签上，换标签再回来沿用该标签上次的**选择**」——只承诺选择持久化，而 `previewArtifactId` 确实记在标签上（`App.tsx:382`），注释无虚假承诺 | 撤除「注释与行为不一致」子声明；该条收敛为纯 UX 缺口（Minor #2：切回后空态无重读入口） |
| **校事实（行号修正）** | Host Minor「content/download 双次 `loadRecord`」引用 `routes.ts:745-784` | 该行号段实为 settings/auth 路由。真实位置：[routes.ts:1765-1766](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/routes.ts#L1765-L1766)（`artifact.content`：`getArtifact` + `readArtifactContent` 各自独立 `loadRecord`）与 [routes.ts:1803-1804](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/routes.ts#L1803-L1804)（`artifact.download` 同款双读） | 发现本体成立（Minor #3），行号修正入档 |
| **表述精确化** | Electron Minor「`will-redirect` 无任何直接测试」 | 主窗口的 `will-redirect` **有**测试（[electron-runtime.spec.ts:1909-1935](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/tests/electron-runtime.spec.ts#L1909)，含同源放行/外源拦截/畸形 URL/iframe 放行四断言）；artifact 窗口的 `will-navigate` 与 `setWindowOpenHandler` 也有测试（[desktop-browser-access.spec.ts:677-701](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/tests/desktop-browser-access.spec.ts#L677-L701)）。缺口精确为：**artifact 窗口**的 `will-redirect` 处理器（[electron-runtime.ts:877-884](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/electron-runtime.ts#L877-L884)）无直接测试 | 发现成立（Minor #6），测试面描述精确化 |
| **消夸大检查** | Important-1「§7.2 未实现」、Host M-3「读侧无 realpath」 | Important-1 的「可达性低」限定核实成立：`MarkdownText`（react-markdown 封装）对任意文本基本不抛、`position` 守卫（[ArtifactMarkdownView.tsx:65](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/ArtifactMarkdownView.tsx#L65)）在 fromMarkdown 默认带 position 时实际不可触发；M-3 的威胁模型限定成立：构造 ID 无法穿越（单段校验 + traversal 测试钉死），植入 symlink 需同用户本地写权限，不跨特权边界 | 两项维持原级别，无夸大 |
| **查漏报（主审对抗性抽查）** | 未被初审显式覆盖的横切面 | ① CSP 防松动：`withArtifactContentSecurity` 把严格 CSP meta 前置于模型 HTML，多 CSP 取交集语义下模型无法用自带 meta 放宽（[ArtifactHtmlView.tsx:31-33](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/ArtifactHtmlView.tsx#L31-L33)）；② api.ts 超时豁免面：`INTERACTIVE_METHODS` 仅含 `artifact.download`（[api.ts:11,195](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/api.ts#L11)）；③ `artifact/created` 分支无右栏写入（[App.tsx:2161-2176](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/App.tsx#L2161-L2176)）；④ busy 竞态、armed-before-srcDoc 时序、暂存目录无启动清扫（`.artifacts-staging` 全仓仅 451/517 两处 `rm`） | **未发现新的 Critical/Important/Minor 级漏报** |
| **验证记录核实** | 三域评审代理报告的测试计数与 typecheck | 主审独立复跑 `corepack yarn workspace dsh-plugin-huaanwork run typecheck`：**EXIT=0**。三域定向测试计数（Electron 26+148、Host 566、Client 227+73）采信代理报告的运行输出 | 采信入档 |

**误报合计：1 项子声明撤除（不改变任何条目级别）；行号修正 2 处；表述精确化 1 处；无夸大；无新增漏报。**

---

## 二、架构与实现亮点（经主审抽查实证）

1. **Electron 安全三层防御（全部实证）**
   - 沙箱 iframe：`sandbox="allow-scripts"` 单 token，无 `allow-same-origin`/`allow-top-navigation`/`allow-popups`/`allow-forms`（[ArtifactHtmlView.tsx:112](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/ArtifactHtmlView.tsx#L112)）；opaque origin 下 `require`/`process` 不存在（探针 + 真机实测）。
   - CSP：`default-src 'none'`、`connect-src/object-src/frame-src/worker-src/form-action/base-uri 'none'`、`img/font data:`、`script/style 'unsafe-inline'`（[ArtifactHtmlView.tsx:12-24](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/ArtifactHtmlView.tsx#L12-L24)），meta 前置使模型无法放宽。
   - 原生 frame guard：按稳定 `frameTreeNodeId` 授权（改写 `window.name` 不解除防护），`inside()` 对 frame 与 initiator 双向检查；guard 在 `loadURL` 之前安装，无「先 load 后装 guard」窗口期；真实 Electron 探针加载**生产构建**产物，先验证控制信道可达再断言隔离（避免「断网当隔离成功」假阳性）。
   - 全屏窗口：`sandbox/contextIsolation/nodeIntegration:false/webSecurity:true` + 无业务 preload 有测试断言（[electron-runtime.spec.ts:3500-3516](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/tests/electron-runtime.spec.ts#L3500)）；窗口复用时 about:blank→撤旧 listener→重鉴权→装新 listener→loadURL 的 `callOrder` 时序钉死。
2. **Host 两阶段写入协议**：begin 同步登记 lease 不做 I/O；prepare 只写 profile 内隐藏暂存；commit 在 profile 锁内先重验 lease → 幂等 → 数量（上限 100，[artifacts-host.ts:28](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/artifacts-host.ts#L28)）→ 字节/摘要复验 → 原子 rename；读侧每次读取重新核对字节 + sha256，损坏 fail-closed。冻结点纪律（cancel 读取→summary 构建之间零 await）、五条删除路径的清理报告、symlink 逃逸实测（真实 symlink + `renameSync` 构造，外部数据完好断言）、run 级 no-scan 文件系统枚举证据，全部有真实磁盘/真实 agent-loop 测试。
3. **Guardrails fail-closed**：`result_present` 未进全局 `ALLOWED_TOOLS`；claimed 处理器同步、真实 `{agent,message}` payload；工具 parent-only 三层门禁 + 工具体复核 attached；`decide.ts` 挂载即 allow、未挂载全档 deny；model filter 放行 `result_present` 有真实 SSE 适配器测试（复现真机 D2）。
4. **Client 投影纯函数化**：五分支投影 + `applyRunEndProjection` 边界投影（读取摘要期间用户续聊不被误删，有对照反例测试）+ `shouldApplyArtifactResponse` 双 ID + 专用 epoch 拒答；markdown 远程图片过滤走 AST 偏移而非正则（引用式三形态、共享 definition、代码块/表格/数学全保留），`useMemo([content])` + `memo()` 双层防流式重解析。
5. **验收文档诚实性**：D1-D5 缺陷与根因（含第 3 轮失败项）如实记录，未粉饰；与本次评审的代码/测试证据互相印证。

---

## 三、问题清单（校准后）

### Critical（必须修复）

无。

### Important（合并前处置）

**I-1【规格偏差 + 测试缺口】规格 §7.2「渲染失败时显示错误和可用的原始下载入口」未实现**（计划评审遗留 Minor-2，计划要求 Task 6 实施时补钉，未闭环）

- **无渲染异常兜底**：`client-huaanwork` 全树无 ErrorBoundary/`componentDidCatch`/`getDerivedStateFromError`（grep 实证）。[ArtifactMarkdownView.tsx:65](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/ArtifactMarkdownView.tsx#L65) 的显式 `throw new Error("artifact-markdown-image-position-missing")` 经 `:83` 的 `useMemo` 在渲染期执行，一旦触发将冒泡卸载整棵 App/全屏树，既无错误显示也无下载入口。
- **错误态无原始下载入口**：[App.tsx:4566-4568](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/App.tsx#L4566-L4568) 的 `onFullscreen`/`onDownload`/`prepareHtmlFrame` 均以 `previewArtifactLoaded` 为条件；而 `artifact.download` 只需双 ID 不需正文（[App.tsx:3512-3523](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/App.tsx#L3512)），错误态完全可以提供。[ArtifactPreview.tsx:64-72](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/ArtifactPreview.tsx#L64-L72) 错误分支只有重试按钮。
- **测试缺口**：仅读取错误的 alert+重试有测试（[ArtifactPreview.spec.ts:309-334](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/tests/client-huaanwork/ArtifactPreview.spec.ts#L309-L334)），渲染异常与错误态下载入口均无测试。
- **定性依据**：实际可达性低（`MarkdownText` 对任意文本基本不抛、`position` 守卫实际不可触发），故 Important 而非 Critical；但这是规格明文要求（§7.2）且计划评审已预警，属「规格偏差」而非「可选加固」。
- **建议**：为 `ArtifactPreview` 包裹 error boundary（或把过滤挪出 `useMemo` 用 try/catch 收敛为 error 态）；错误态传入 `onDownload`；补一条渲染异常测试 + 一条错误态下载入口测试。

### Minor（建议处置，不阻塞）

**M-1【测试缺口】规格 §7.1「不为每个结果自动打开右栏」无显式测试钉**（计划评审遗留 Minor-1，未闭环）
行为合规已实证：`artifact/created` 分支（[App.tsx:2161-2176](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/App.tsx#L2161-L2176)）只做摘要暂存 + `insertArtifactIntoHistory`，唯一打开右栏的路径是用户点击 `handleOpenArtifact`（:3540）。但 `appWiring.spec.ts` 无「created/run-end 分支不写 `setRightCollapsed`/`setRightTab`」式源钉（grep 实证；仓库有同款先例可循：[appWiring.spec.ts:2312](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/tests/client-huaanwork/appWiring.spec.ts#L2312) 对后台 diff 的源钉）。建议随手补一条。

**M-2【UX 缺口】切回标签不恢复预览内容，空态无重读入口**
`artifactPreview` 是全局单例按 artifactId 匹配（[App.tsx:1183-1184](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/App.tsx#L1183-L1184)）：标签 A 打开 X → 切到 B 打开 Y → 切回 A 时 `previewArtifactLoaded` 为 undefined，右栏显示「结果尚未读取」（[ArtifactPreview.tsx:73-74](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/ArtifactPreview.tsx#L73-L74)），该空态无重读按钮（`onRetry` 只在 error 分支渲染）、也无自动重取（`handleOpenArtifact` 仅由用户点击 :4315 与错误重试 :4569 触发）。用户必须重新点卡。建议：切回时按选中 id 自动重读，或空态提供「读取」按钮。（注：`App.tsx:379` 注释只承诺选择持久化且已兑现，无文档失实——校准已撤除该子声明。）

**M-3【性能】artifact 读路径重复全量读 + 哈希，list 在上限场景开销放大**
单请求双读：`artifact.content`（[routes.ts:1765-1766](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/routes.ts#L1765-L1766)）与 `artifact.download`（:1803-1804）各自调用 `getArtifact` + `readArtifactContent`，每次都独立 `loadRecord`（读 manifest + 全量正文 + sha256），同一正文单请求读两次、哈希两次。list 放大：[listArtifacts](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/artifacts-host.ts#L565-L574) 对每条 manifest 调 `loadRecord`，100 条 × 5 MiB 上限（`MAX_ARTIFACTS_PER_SESSION=100`、`MAX_ARTIFACT_BYTES=5MiB`）时一次 list 约 500 MiB 读 + 哈希，仅为产出摘要。建议：content/download 合并为一次 `loadRecord`；list 改用 manifest 校验口径（读侧已有单点核哈希）或轻量列表。功能无错误，非阻塞。

**M-4【鲁棒性】真实 `rm` 失败后的暂存残余无回收路径**
[discardPreparedArtifact](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/artifacts-host.ts#L509-L526) 在 `:516` 先 `delete state.prepared` 再 `await rm(...)`（:517）；真实 `rm` 失败（EIO/EBUSY）时句柄已在 finally 释放并移出 `activeWrites`，之后同句柄重复 discard 直接 no-op，孤儿 `.artifacts-staging/<uuid>` 目录无任何回收路径（全仓无启动清扫，仅 prepare 自身 :451 与 discard :517 两处 rm）。计划 Task 3「恢复 I/O 后重复 discard 清理残余」仅在失败发生于真实调用之前才成立——现有测试 [automations-host.spec.ts:2747](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/tests/huaanwork-host/automations-host.spec.ts#L2747) 的失败注入在 mock 包装层（:86-91，先于 `real.discardPreparedArtifact` 抛出），未覆盖真实 rm 失败路径。影响为按失败次数累积的有界磁盘泄漏，不影响正确性。建议：后续加暂存根启动清扫，或 `rm` 失败时保留 `prepared` 至重试成功。

**M-5【安全纵深】读路径无 realpath 防护，与删除路径 symlink 防护不对称**
读侧 [resolveInside](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/artifacts-host.ts#L168-L173) 与 `loadRecord`（:262-290）为纯词法校验；`artifacts/<sessionId>` 或 artifact 目录被植入指向 profile 外的符号链接时，**读取**会跟随链接返回根外字节。删除侧有 [assertRemovalTargetInside](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/artifacts-host.ts#L652-L670)（realpath 双检）+ 真实 symlink 测试（含 `fs.rm` 不跟随末段链接实证）。威胁模型限定：构造 ID 无法穿越（单段校验 + traversal 测试钉死，规格 §11 满足）；植入 symlink 需同用户本地写权限，不跨特权边界——纵深缺口而非可利用漏洞。建议：与删除防护对齐，读侧 realpath 校验或拒绝 symlink 目录，列入下一次安全硬化波。

**M-6【代码质量 + 测试缺口】全屏窗口复用分支 partition 为死值；artifact 窗口 `will-redirect` 无直接测试**
① [electron-runtime.ts:830](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/electron-runtime.ts#L830) 每次调用生成新 `partition = huaanwork-artifact-${randomUUID()}`，但复用分支（:832 窗口存在）不会应用它——:856 `artifactWindowOptions(spec, target, partition).url` 只取 `.url`，partition 仅进 webPreferences 且被丢弃。复用路径上该值是死值，易误导读者以为每次切换换 session（实际不变且不变正确：非持久独占 partition 随窗口生命周期，符合 Task 7 Step 4）。建议把 partition 生成移进创建分支。
② artifact 窗口的 `will-redirect` 处理器（[electron-runtime.ts:877-884](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/electron-runtime.ts#L877-L884)，主帧同源约束）无直接测试——主窗口同款有测试（electron-runtime.spec.ts:1909），artifact 窗口的 `will-navigate`/`setWindowOpenHandler` 也有（desktop-browser-access.spec.ts:684-697），唯 `will-redirect` 缺。实现与主窗口同款逻辑、风险低，但属安全面，应有测试钉。建议补一条对 artifact 窗口 `will-redirect` 的同源拦截断言。

### Nit（低风险观察；N-1/N-3/N-4/N-5 经主审实证，N-2/N-7/N-8 采信评审代理报告）

**N-1** `findArtifactByRun` 无生产调用方（grep 实证：src 内仅定义处 [artifacts-host.ts:580](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/artifacts-host.ts#L580)），且是全 profile 扫描。计划 Task 1 接口清单列了它故合规；建议标注测试专用或收敛为有界扫描。
**N-2** 清理失败日志面不统一：automations-store.ts（:421-426/:679-686/:770-782）用 `console.warn`，automations-host 的 discard 失败用 `routeCtx.logger`。前者与该文件既有风格一致，可接受。
**N-3** `isArtifactIdSegment`（[host-runtime-bridge.ts:196-200](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/host-runtime-bridge.ts#L196-L200)）与 `isSinglePathSegment`（[artifacts-host.ts:104-109](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/huaanwork-host/artifacts-host.ts#L104-L109)）规则逐行等价（实证），建议导出复用。
**N-4** `artifactPreviewBusy` 是无 key 布尔（[App.tsx:663](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/App.tsx#L663)）：快速连点两张卡时先返回的请求在 :3567 无条件清 busy，第二张仍在读却闪现空态。代际 + 选择守卫（:3570）保证无数据串写，仅瞬态视觉问题。建议 busy 记 artifactId。
**N-5** `readTabItems` 在 setState 函数式 updater 内 resolve Promise（[App.tsx:1694-1700](file:///Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/dsh-plugin-huaanwork/src/client-huaanwork/App.tsx#L1694-L1700)，实证）：React 并发/StrictMode 下 updater 可能重放，靠 resolve 幂等兜住，现状可工作且有注释，属反模式，可改 ref 镜像。
**N-6** `deleteAutomationRun` 对缺 sessionId 的旧 RunSummary 一律报「清理不完整」，即使该 run 无 Artifact——保守过报，是规格 §9「必须报告」的字面实现，合规，仅 UX 上旧记录多报。
**N-7** `downloadName` 读取侧仅校验非空 string（artifacts-host.ts:235）；写入侧 sanitize（:362-378）+ 路由只传存储值 + bridge 校验构成完整链路（native 纯透传是有意设计并有测试钉死），manifest 被外部篡改注入 `../` 需先能写 profile 目录，属威胁模型之外；可考虑读取侧复检。
**N-8** `registerEmptyFrame` 依赖主进程 frame tree 已包含新插入的 iframe，DOM 插入到可见之间存在理论异步窗口，届时抛 `artifact-frame-unavailable` → 客户端显示错误 + 重试。fail-closed、可重试、真机验收未复现，0ed4df2159 选择显式暴露而非静默重试是合理裁定。

---

## 四、验证记录

| 验证项 | 执行方 | 结果 |
| --- | --- | --- |
| `corepack yarn workspace dsh-plugin-huaanwork run typecheck` | 主审独立复跑 | **EXIT=0**（5 个 tsconfig 全过） |
| Electron 域定向测试（artifact-frame-guard + artifact-window；desktop-browser-access + electron-runtime） | 评审代理 | 26 + 148 **passed** |
| Host 域定向测试（artifacts-host/lifecycle/automation-artifacts/artifact-routes；guardrails 5 文件；automations-host/store/script-error；sessions/routes/route-contract/market-routes） | 评审代理 | 65 + 138 + 171 + 192 = **566 passed** |
| `corepack yarn workspace @huaanwork/policy run check` | 评审代理 | 通过 |
| Client 域定向测试（artifactProjection/appWiring/ArtifactPreview/artifactWindow/sessionChannel/runTabsLogic/styles-generated/thinkingPanel；api/runResultAttachments/automations-runs-delete） | 评审代理 | 227 + 73 = **300 passed** |
| `test:artifact-sandbox`（需真实 Electron） | 未运行（headless 约束） | 采信验收文档真机记录：PASS 且连续复跑 3 次稳定 |
| 全量 `yarn check` 门禁 | 未在本评审中重跑 | 采信验收文档 2026-11-20 记录：EXIT=0 |
| 工作树状态 | 主审 | 全程只读，`git status --porcelain` 为空 |

---

## 五、处置建议

1. **合并前**：处置 I-1（error boundary 或 try/catch 收敛 + 错误态 `onDownload` + 渲染异常/错误态下载两条测试）；随手补 M-1 的 §7.1 源钉（一处断言即可）。
2. **后续安全硬化波**：M-5（读侧 realpath）与 M-6②（artifact 窗口 `will-redirect` 测试）可与既有硬化清单合并。
3. **后续 UI 加固波**：M-2（切回恢复/重读入口）、N-4（busy 记 id）、N-6（清理过报 UX）。
4. **后续性能/维护波**：M-3（读路径合并与 list 轻量化）、M-4（暂存清扫）、M-6①（partition 死值清理）、N-1/N-3（收敛重复与未用接口）。

---

## 六、评审方法附记

- 三域并行评审（Host 数据层 / Electron 安全与集成 / Client UI），每域独立对照规格 13 章与计划 9 Task，输出分级发现后由主审校准。
- 初审过程中 1 个 Client 评审代理因模型输出损坏（连续两次生成乱码）被弃用并重派，其结论未采信；本文 Client 域发现全部来自重派代理并经主审逐条读码复核。
- 全程未修改任何仓库文件；本文档为唯一产出。

---

## 七、二次确认与修复记录（Qoder，2026-11-20，标注追加）

> 本节为独立二次确认与修复执行记录，不改动上文 GLM 审核结论原文。

### 7.1 二次确认结论

**GLM 质检结论属实。** 对全部 16 项发现（1 Important / 6 Minor / 8 Nit，校准后口径）逐条读码反证，无误报，严重度校准合理。两处补充事实：

1. **I-1 缺口范围收窄**：全屏页 `ArtifactFullscreenPage.tsx:103` 的 `onDownload` 本就无条件传入，错误态下载已存在；实际缺口是主 App 右栏的错误态下载接线（`App.tsx` 旧 `onDownload={previewArtifactLoaded ? … : undefined}`，且 `downloadArtifact` 经 `previewArtifactTarget` 依赖已读取正文），以及主 App/全屏两棵树均无渲染异常边界。
2. **N-3 重复校验实为三处**：除报告点名的 `host-runtime-bridge.ts` 与 `artifacts-host.ts`，`artifact-window.ts:20-25` 还有第三份逐行等价拷贝（该模块禁 Node 依赖，不能直接复用 artifacts-host 导出）。

### 7.2 已修复项（8 项，语义不变或规格明文要求）

| 项 | 修复 | 证据 |
| --- | --- | --- |
| I-1 | `ArtifactPreview.tsx` 新增 `ArtifactRenderBoundary`（`getDerivedStateFromError` 收敛渲染期异常为 `role="alert"` 错误态 + 重试，`resetKey` 随内容变化复位），包裹 Markdown/HTML 两个渲染器，右栏与全屏共用；`App.tsx` `downloadArtifact` 双 ID 改取自当前选择（标签 sessionId + `previewArtifactId`），`onDownload` 不再以 `previewArtifactLoaded` 为条件 | `ArtifactPreview.spec.ts` 新增 3 条：渲染崩溃收敛（树不卸载、标题/下载保留、重试回调、新内容复位）、错误态下载入口、空态读取入口；`appWiring.spec.ts` 新增下载接线源钉 |
| M-1 | §7.1 源钉：`artifact/created` 分支块内不得出现 `setRightTab`/`setRightCollapsed` | `appWiring.spec.ts` "a new artifact never opens or switches the right pane"（沿用 diff 分支 `blockAfter` 先例） |
| M-2 | 未读取空态提供「读取」按钮（报告允许的最小选项，经 `onRetry` 复用 `handleOpenArtifact`）；`.artifact-empty` 修饰类沿用 `market-search-empty` 先例，`styles.generated.ts` 已重新生成 | `ArtifactPreview.spec.ts` 空态读取测试（含无回调不渲染按钮断言） |
| M-3（部分） | content/download 双读合并：新增 `readArtifactRecord`（单次 `loadRecord`），`artifact.content`/`artifact.download` 路由改用；`getArtifact`/`readArtifactContent` 保留供其余调用方 | `artifacts-host.spec.ts` 新增等价测试（摘要/字节与分离读取完全同值、跨会话与 traversal 拒绝），两条既有 fail-closed 测试扩展覆盖新入口；`artifact-routes.spec.ts` 既有行为测试全过 |
| M-6① | partition 生成移入建窗分支；复用加载改用新导出的 `artifactWindowUrl`（与建窗同一 URL 构建），死值消除 | `desktop-browser-access.spec.ts`/`electron-runtime.spec.ts`/`artifact-window.spec.ts` 既有建窗/复用/安全参数测试全过 |
| M-6② | artifact 窗口 `will-redirect` 补直接测试：主帧外源拦截、同源放行、畸形 URL 拦截、iframe 放行 | `desktop-browser-access.spec.ts` "keeps the top-level navigation constraint…" 扩展 4 断言 |
| N-3 | 三处单段校验收敛为 `src/path-segment.ts` 单一导出（纯函数、无 Node 依赖，artifact-window 的客户端共用约束不破坏） | 全量桌面测试套件（含 bridge/window/store 既有用例）回归通过 |
| N-4 | `artifactPreviewBusy` 改记 artifactId（`string \| null`），返回时函数式比较清除（先返回的请求不清后一张的 busy），渲染按 `busy === previewArtifactId` 判定 | `appWiring.spec.ts` busy 源钉；代际 + 选择守卫原样保留 |

### 7.3 不改 / 延期项（理由）

- **M-3 list 轻量化（延期，需 owner 裁定）**：会把「正文损坏在 list 时 fail-closed」放宽为「content/download 读取时才报错」，属安全语义取舍，不在本轮擅自变更。
- **M-4 暂存残余回收（延期，需 owner 裁定）**：启动清扫在 Host 交接期可能误删旧 Host 在途暂存；「rm 失败保留 prepared 至重试成功」与规格 §5.3「清理 I/O 失败仍在 finally 释放 lease」契约冲突。两条实现路径都需裁定。
- **M-5 读侧 realpath / N-7 downloadName 读侧复检（安全硬化波）**：与报告处置一致；威胁模型同为需 profile 本地写权限，需配套读侧 symlink 测试矩阵，归入下一次硬化波。
- **N-1（保留）**：`findArtifactByRun` 在计划 Task 1 接口清单在册，无生产调用方属合规现状。
- **N-2（不改）**：`console.warn` 与 automations-store 既有风格一致，报告判定可接受。
- **N-5（不改）**：`readTabItems` 依赖函数式 updater 的队列顺序语义，改 ref 镜像有引入时序回归的风险，现状可工作且有注释。
- **N-6（不改）**：规格 §12.1 第 12 条明文「缺 sessionId 报清理不完整」，过报是规格字面实现。
- **N-8（不改）**：fail-closed 显式暴露是既有裁定（0ed4df2159）。

以上延期项已登记 AGENTS.md 债务表（2026-11-20 行）。

### 7.4 验证记录（本轮实际执行）

| 验证项 | 结果 |
| --- | --- |
| `corepack yarn workspace dsh-plugin-huaanwork run typecheck` | **EXIT=0** |
| 定向套件（appWiring / ArtifactPreview / artifactWindow / desktop-browser-access / electron-runtime / artifacts-host / artifact-routes） | **332 passed**（修正一处源钉 needle 后全绿） |
| 完整 `corepack yarn check`（根门禁，串行单跑避免 AA 冲突） | **GATE_EXIT=0**；桌面工作区 **314 个测试文件 passed、4 skipped**（既有环境性跳过），build/typecheck/verify:closure/bundled/cli/loader/profile/host/aa/licenses/operations 全过；日志 `/tmp/huaanwork-check-artifacts-fix.log` |

**诚实边界**：本轮为 headless 门禁与 jsdom/真实磁盘测试证据；改动的预览 UI 路径（错误态下载、空态读取、渲染崩溃收敛、busy 瞬态）**尚未真机复验**，不声称真机验收通过。规格 §12.2 第 2/5 步相关路径应在下一次真机验收中复跑。

### 7.5 真机复验（Qoder，2026-11-20 21:04–21:20 CST，owner 指示「先做真机复验，通过后再提交」）

**实例**：干净临时副本 `DSH_HOME=/tmp/art-reverify/run/.huaanwork`（生产 `~/.huaanwork` 只读复制后清空会话/工作区/注册表）、`--user-data-dir=/tmp/art-reverify/run/userData`、`--remote-debugging-port=9333`、`HUAANWORK_ACCEPTANCE_HOOKS=1`（固定 Web 43120）；工作区构建（含本轮全部修复，根门禁同一次 build）+ `prepare:electron-native`，Electron 44.0.0。生产未被写入（复核无 `artifacts/` 目录）。

**夹具**：两个真实短回合会话（真实模型 `deepseek`，仅「收到/明白/好的」回复，零工具调用）——A `huaanwork-1ab84180689db423`（两回合）、B `huaanwork-1ab84180689db423-d946e498`（一回合）；停实例后经真实 `createArtifact` 按日志读出的真实 `clientMessageId` 锚定播种三个 Artifact：`d4709d1d-…`（复验报告/markdown/371 B/sha256 `2b9f30ff07f1f4397536efe246a998b758b0154b6530c716d21dd60f17336bfa`，含中文、`2026-11-20 <>&`、表格、远程图片与正常链接）、`f8ef62e9-…`（复验图表/html/722 B，内联脚本交互）、`1ef8ef7b-…`（第二会话复验结果/markdown/122 B）。重启后卡片经历史投影正常出现。

| # | 复验项 | 结果与证据 |
| --- | --- | --- |
| R1 | 预览回归（M-3 合并读 + 边界包裹） | **PASS**：A 两张卡唯一展示；Markdown 右栏渲染标题/表格/特殊字符，远程图片被过滤（占位「远程图片（已禁用）」、无 https img）、正常链接保留；HTML `prepareFrame` 确认后装填 `srcdoc`（990 字符、CSP 前置、`sandbox="allow-scripts"`、`src=null`）。截图 `22-01`–`22-03` |
| R2 | M-2 切回空态读取入口 | **PASS**：B 打开其结果后切回 A，右栏「结果尚未读取」+「读取」按钮（头部「下载」入口同在）；点「读取」按标签自身选择重读并武装 HTML frame。截图 `22-04`–`22-05` |
| R3 | I-1 错误态下载入口 | **PASS**：`chmod 000` 正文制造真实 EACCES 读失败 → `role="alert"` + 重试 + 头部「下载」入口（修复前错误态无此入口）；错误态点「下载」发起真实 RPC 并诚实报 EACCES（不伪装成功）；恢复权限后重试正常渲染。截图 `22-06`–`22-08` |
| R4 | 下载字节一致 + 取消零写入 | **PASS**：原生保存面板落盘 `复验报告.md` 371 B，与存储正文逐字节相等、SHA-256 与 manifest 一致；再次下载经面板「取消」关闭，目录无新文件、UI 无错误。截图 `22-09`。操作披露：面板「前往文件夹」键盘序列因焦点未生效，保存落在面板默认目录 `~/Documents`，字节核对后移入 `/tmp/art-reverify/downloads/`；首次 AX 全路径设值尝试产生的冒号转义 stray 文件已核对字节后删除；取消经 AX「取消」按钮（与 Escape 同一产品取消路径） |
| R5 | M-6① 全屏跨会话复用 | **PASS**：A 的 Markdown 全屏（双 ID 正确、无业务 preload）→ B 的结果全屏复用**同一 WebContents 目标** `46C6A0AFAD213B7DA013FAAFA66F2C20`，URL 更新为 B 双 ID、正文切换；「关闭」后全屏目标归零、主窗口预览完好。截图 `22-10`–`22-11` |
| R6 | N-4 连点 busy 瞬态 | **尽力观测 PASS**：25ms 页内采样下快速连点 md→html，右栏全程为最终选择「复验图表」，无「结果尚未读取」闪现；本地读取快于采样间隔，瞬态不可按需复现，逻辑由 `appWiring.spec.ts` busy 源钉与代际/选择守卫保证 |

**清理**：临时 Electron 已终止，9333/43120 端口释放；含 api_key 的临时 profile 与 userData 已删除；`~/Documents` 无残留；生产 `~/.huaanwork` 与 `deepseek-harness/` 零写入。

**结论**：本轮修复涉及的预览 UI 路径真机复验 **PASS**（R1–R5 实证、R6 尽力观测无回归）。这是对修复路径的定向复验与 §12.2 第 2/3/5 步相关回归，不替代 §12.2 全矩阵；第 4 步隔离与第 7 步自动化代码本轮未改动，沿用 2026-11-20 早先全量验收记录。渲染崩溃边界（I-1 的 boundary 本体）真机不可自然触发（position 守卫不可达），由 jsdom 渲染崩溃测试钉住。
