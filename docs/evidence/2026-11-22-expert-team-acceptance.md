# 专家团多智能体协作验收证据（Task 18）

当前结论：**自动化 headless gate PASS（`0a465ed361`）；macOS 真机 Electron 验收已完成（真实云端模型 7/7 PASS + 真实 Electron 本地 OpenAI 兼容 SSE 确定性边界/故障 13/13 PASS，两项架构不可注入子项与打包产物验收如实保留开放/单测边界）**。

本文件严格区分三类证据，绝不混淆口径：

- **自动化证据（已执行）**：`corepack yarn check` 全部通过（`EXIT=0`），包含单元/契约测试、真实组合场景与编译产物 Loader smoke。
- **真机 Electron 验收 — 真实云端模型（Phase A，已执行）**：在本机 macOS arm64 启动编译后的真实 Electron 应用（`dsh-plugin-huaanwork/lib/main.js`）、隔离 profile（只读复制生产 DeepSeek 模型配置并固定为 `deepseek-chat`，不触碰 `~/.huaanwork`）、真实本地智能体包（HTTP / MCP / `skill/scripts/echo.mjs`）、真实项目工作区与真实 macOS 原生保存对话框，通过 CDP/Playwright 驱动真实 GUI 交互完成 **7/7 PASS**。
- **真机 Electron 验收 — 本地 OpenAI 兼容 SSE 确定性故障/边界（Phase B，已执行）**：同一编译后的真实 Electron 应用 + 真实 Host/Renderer + 生产 `HuaAnWorkAdapter` HTTP/SSE 链路，仅将隔离 profile 的 `base_url` 指向本机 `127.0.0.1` OpenAI 兼容 SSE 测试端点，在真实 UI 中完成取消、停用、超限、断连、重连、goal 续拍与终态淘汰等 **13/13 PASS**。
- **未在真机实时注入的子项（如实保留）**：
  1. `mixed image/file → unsupported-output`：生产 `HuaAnWorkAdapter`（`src/huaanwork-guardrails/model.ts`）仅解析 OpenAI Chat Completions 文本/`reasoning_content`/`tool_calls` SSE，无法经该适配器输出 `image`/`file` 块，保留由 Host 单元测试 `expert-team-text-protocol.spec.ts` 证明；
  2. `artifactLinkError`（落盘成功但运行关联失败）：属 Host 内部防御不变量，无生产 Electron 故障注入入口，保留由 Host/Client 单元测试（`expert-team-runs.spec.ts`、`ExpertTeamRunCard.spec.ts`）证明；
  3. 中文输入法采用 CDP `Input.imeSetComposition` 驱动 Chromium 原生 `CompositionEvent`（`isComposing=true`）而非物理键盘系统候选窗手工敲击；
  4. 打包签名产物（macOS 签名包待凭据、Windows 安装包待 Windows 宿主机）仍为开放项。

## 1. 运行环境

| 项 | 值 |
| --- | --- |
| 日期 | 2026-11-23 |
| 机器架构 | arm64（Apple Silicon） |
| OS | macOS 27.0.1 |
| Node | v22.23.2 |
| 包管理器 | Corepack Yarn 4.18.0 |
| 分支 | `feat/expert-team-impl` |
| 实现基线 | `e786ae8bd4` |
| 门禁与真机验收代码 HEAD | `0a465ed361`（`fix(expert-team): resolve calibrated Argon code review findings`） |
| 提交数 | 44（`e786ae8bd4..0a465ed361`） |
| 生产配置保护 | 真机运行全程使用临时隔离 `HOME` / `HUAANWORK_HOME` / `HUAANWORK_PROFILE_DIR` / `--user-data-dir`，结束后校验 `~/.huaanwork/profiles/desktop/huaanwork-settings.json` mtime 未变（`productionSettingsUntouched: true`），且无残留 Electron 进程 |

## 2. 自动化门禁命令与结果

```bash
corepack yarn check
```

结果：**`EXIT=0`**（在代码 HEAD `0a465ed361` 上独立运行，未与其它含 `verify:aa` 的命令并发）。

门禁关键输出：

| 项目 | 输出 |
| --- | --- |
| Vitest 主分组（`dsh-plugin-huaanwork`） | `329 passed \| 4 skipped` 文件，`Tests 4808 passed \| 15 skipped (4823)`（含 `expert-team-composition.spec.ts` 5/5、`styles-generated.spec.ts` 2/2） |
| Vitest 其余分组（用例数） | 303、244、88、112 |
| Vitest 合计 | **5555 passed / 15 skipped**（分组 4808+303+244+88+112） |
| Profile 启动 | `verify-profile-boot: minimal preset, plugin manager, and disabled hmr lock passed` |
| 专家团编译产物 smoke | `expert-team smoke: tool present, list=200 (0 teams), invocable=200 (0 teams)` |

`dsh-plugin-huaanwork` 的 `check` 脚本将 `verify:expert-team` 置于 `verify:host` 与 `verify:aa` 之间，已进入完整门禁链：

```text
... && yarn run verify:profile && yarn run verify:host && yarn run verify:expert-team && yarn run verify:aa && ...
```

## 3. 自动化证据（已执行）

### 3.1 完整门禁与 Argon 审查校准修复（`0a465ed361`）

`0a465ed361` 在 `eca2ceb5b0` 基础上全部落地了 Argon 代码审查（`docs/superpowers/plans/2026-11-23-expert-team-code-review.md`）校准后的 11 项修复（I-1、I-2、M-1..M-5、N-1..N-4），涵盖成员清理失败告警在聚合卡上的展示与断连冻结、星型失败重试在入口校验与终态结算间共享解析集合、`update` 保留清空 `scenarios` 并归一空白字段、取消确认在 `stopping` 时同步禁用与收起、显式 `@team:` 隐藏普通智能体、`mountSessionMcp` 取消竞态非阻塞清理等，并同步重新生成 `styles.generated.ts`。随后运行全仓 `corepack yarn check` 以 `EXIT=0` 通过（**5555 passed / 15 skipped**）；普通 `@agent` 的 `dispatch()` 零改动，`deepseek-harness/` 子模块与锁文件零改动。

### 3.2 单元与契约测试

专家团相关测试文件（全部包含在 §2 的 **5555 passed / 15 skipped** 内）：

- Host 侧（`dsh-plugin-huaanwork/tests/huaanwork-host/`）：`expert-team-store.spec.ts`、`expert-team-runs.spec.ts`、`expert-team-routes.spec.ts`、`expert-team-text-protocol.spec.ts`、`expert-team-orchestration.spec.ts`、`expert-team-dispatch.spec.ts`、`expert-team-coordinator.spec.ts`、`expert-team-observer.spec.ts`、`expert-team-session.spec.ts`、`expert-team-composition.spec.ts`、`sessions.spec.ts`。
- Guardrail 侧（`dsh-plugin-huaanwork/tests/huaanwork-guardrails/`）：`expert-team-dispatch.spec.ts`、`policy.cordis.spec.ts`。
- Client 侧（`dsh-plugin-huaanwork/tests/client-huaanwork/`）：`expertTeamsLogic.spec.ts`、`ExpertTeamsView.spec.ts`、`expertTeamRuns.spec.ts`、`ExpertTeamRunCard.spec.ts`、`appWiring.spec.ts`。

### 3.3 真实组合场景（Task 17）与编译产物 Loader smoke

- `expert-team-composition.spec.ts`（5/5 PASS）：真实 `prepareDesktopProfile`/`boot`、真实 `session.send`、包 runtime、MCP 与 Artifact 存储下的脚本化 provider 组合回归。
- `verify:expert-team`（`dsh-plugin-huaanwork/scripts/huaanwork-expert-team-smoke.mjs`）：真实 Loader 启动后验证 `expert_team_dispatch` 已注册且 `/huaanwork/expert-team/list` 与 `/huaanwork/expert-team/invocable` 返回 200。

## 4. 真机验收（Task 18 Step 3，9 项逐条核验）

本轮真机验收在代码 HEAD `0a465ed361` 编译产物上分两阶段执行（均不改动产品源码），全部 18 张真机截图保存在 `docs/evidence/assets/expert-team-2026-11-23/` 并已逐张目视核验：

- **Phase A（真实 Electron GUI + 真实云端模型 `deepseek-chat`）**：`EXIT=0`，`step1 / step9a / step2 / step4 / step5a / step7ab / step8a` **7/7 PASS**。
- **Phase B（真实 Electron GUI + 真实 Host/Renderer + 本机 OpenAI 兼容 SSE 确定性端点）**：`EXIT=0`，`B1..B13` **13/13 PASS**。

以下按 Task 18 Step 3 原清单逐项记录勾选状态、执行层级、客观事实与截图路径：

- [x] **1. 新建“合规审查小分队”：两名执行成员、一名审查成员，默认统一审查和 Markdown 主 Artifact；检查成员包原生脚本/HTTP/MCP 能力。**
  - **执行层级**：**真机 Electron GUI + 真实云端模型 `deepseek-chat`（Phase A `step1` & `step2`）**。
  - **核验事实**：在“专家团”管理页通过真实表单交互创建 `合规审查小分队`（`@team:compliance-team`），添加 `contract-extractor`（HTTP + `skill/scripts/echo.mjs`）、`payment-checker`（MCP `echo`）为执行成员、`compliance-reviewer`（HTTP + MCP + `skill/scripts/echo.mjs`）为审查成员；默认表单即为 `unified` 统一审查、`markdown` 主 Artifact、`maxParallel=2`，编辑器能力标签显示 HTTP / MCP / 技能脚本，保存后列表卡片显示 `可调用` 与 `定义与成员均有效`。运行后直接解析子会话 `session.v4.jsonl`，确认真实调用工具集合含 `["agent_skill_run", "agent_http", "read", "bash", "mcp__payment-checker__97a4a4f4__echo"]`，且审查员 `compliance-reviewer` 完整保留原生工具（`hasSkill: true, hasHttp: true, hasMcp: true`），父会话无任何 `mcp__*` 工具（`parentHasMcpTools: false`）。
  - **截图**：`01-step1-editor-capabilities.png`、`02-step1-team-list.png`。

- [x] **2. 中文检索并调用 `@team`，确认真实独立成员 run、包版本、最多两路并行、动态补派和统一审查一次返修后全员复审。**
  - **执行层级**：**真机 Electron GUI + 真实云端模型 `deepseek-chat`（Phase A `step9a` & `step2`）** + **真实 Electron 本地 SSE 双审查员全员并行复审补充（Phase B `B1`）**。
  - **核验事实**：
    - Phase A 输入 `@合规` 检索到 `智能体` 与 `专家团` 分组，键盘 `ArrowDown + Enter` 选中 `@team:compliance-team ` 并显示草稿摘要横幅；绑定项目 `合同验收项目` 发送任务后，主流与右栏 `进度` 面板同步显示 `合规审查小分队`（`mainTeamCards: 1, railTeamCards: 1, mainStandaloneSubagentCards: 0, railStandaloneSubagentCards: 0`），两执行成员真实并行启动（`进行中 2`，均显示 `v1.0.0`）。整轮完成 5 次真实独立成员 run（5 个独立 `memberRunId`）：`contract-extractor`（execute）+ `payment-checker`（execute）→ `compliance-reviewer`（review：`[VERDICT: REVISE]`）→ `contract-extractor`（revision，携带 `supersedesResultId: f276cd53-...`）→ `compliance-reviewer`（review：`[VERDICT: PASS]`），`unifiedRevisionRounds: 1`，终态 `completed`。
    - Phase B `B1` 在双执行 + 双审查（`rev-1`、`rev-2`）团队下确认返修后两审查员均并行复审通过（7 条结果、`unifiedRevisionRounds: 1`、`completed`）。
  - **截图**：`03-step9-chinese-mention-menu.png`、`04-step2-running-progress.png`、`05-step2-completed-team-card.png`。

- [ ] **3. 验证 `reasoning + text` 正常执行，纯 `reasoning` 显示 `empty-output`，混合 `image/file` 显示 `unsupported-output`。**（**部分真机 PASS，1 项适配器不可达子项保留单测边界**）
  - **执行层级**：**真机 Electron 本地 OpenAI 兼容 SSE（Phase B `B2`）** + **Host 单元测试（`unsupported-output`）**。
  - **核验事实**：
    - 真机 Phase B `B2` PASS：`reasoning_content + content`（>40 字）成员以 `completed` 结束，输出仅保留正文（未泄漏 `SECRET_REASONING_CHAIN_XYZ`）；仅空白 `content` 与纯 `reasoning_content`（`content: ""`）两条成员均以 `failed` 结束，并在展开后的真实 UI 成员行上显示红色 `empty-output`。
    - **保留未真机触发项**：`mixed image/file → unsupported-output` 无法通过生产 `HuaAnWorkAdapter` OpenAI Chat Completions 文本 SSE 产生，仍由单元测试 `dsh-plugin-huaanwork/tests/huaanwork-host/expert-team-text-protocol.spec.ts` 覆盖（因此本条目保持未全勾选以诚实反映边界）。
  - **截图**：`11-step3-reasoning-empty-output.png`。

- [x] **4. 验证一份主 Artifact、正文工具卡抑制、预览、全屏和原字节下载；主报告后派工封闭。**
  - **执行层级**：**真机 Electron GUI + 真实云端模型 `deepseek-chat`（Phase A `step4`）** + **真实 Electron 本地 SSE 主报告后派工封闭（Phase B `B1`）**。
  - **核验事实**：
    - Phase A `step4` PASS：整轮生成唯一一份 Markdown 主 Artifact（`合规审查报告`，`artifactCardCount: 1`，10,918 字节），工具面板未泄漏报告正文（`hasResultPresentBodyLeak: false`）；点击聚合卡 `查看主报告` 在右栏预览正常渲染；点击 `全屏` 打开独立 Electron 全屏窗口（`artifactWindow=1`）渲染完整表格与章节，按 `Escape` 正常关闭；点击预览区真实 UI `下载` 按钮拉起 macOS 原生保存面板并保存，落盘文件与存储 `content.md` 逐字节一致（`savedSize: 10918 === storedSize: 10918`，`savedByteEqual: true`，`manifest.sha256 === storedSha === savedSha === 278eeec28cdbcbcb052c512a37fcc3127cce82e29d267e5bac7b709463c5bf4d`）；再次点击 `下载` 在原生保存面板按 `Escape` 取消返回 `saved: false`。
    - Phase B `B1` PASS：主报告 `result_present` 提交封闭交付后，同回合再次调用 `expert_team_dispatch` 被 Host 拒绝并返回 `expert-team-terminal`，成员结果数不变。
  - **截图**：`06-step4-artifact-preview.png`、`07-step4-artifact-fullscreen.png`。

- [x] **5. 验证仅会话模式：派工前过渡语不算最终汇总，最后 `tool/result` 后文本才算。**
  - **执行层级**：**真机 Electron GUI + 真实云端模型 `deepseek-chat`（Phase A `step5a`）** + **真实 Electron 本地 SSE 负例（Phase B `B3`）**。
  - **核验事实**：
    - Phase A `step5a` PASS：真实云端模型执行 `message-team`（`delivery: "message"`），读取 `contract.md` 并在派工后输出最终汇总，终态 `completed`、`artifactStatus: "not-required"`、0 张 Artifact 卡，且父会话 `session.v4.jsonl` 的 `request/header` 工具列表中不含 `result_present`（`parentHadResultPresent: false`）。
    - Phase B `B3` PASS：团长在 `expert_team_dispatch` 之前输出过渡语（`"我先派发执行成员处理，这是派工前的过渡语，不算最终汇总。"`），并在最后一次 `tool/result` 之后仅输出空白，真实 UI 与 Host 均按 `finalSummaryPresent = false` 结算为 **`partial`**（`部分完成 · 交付不完整`）。
  - **截图**：`08-step5-message-only.png`、`12-step5b-message-partial.png`。

- [x] **6. 分别验证成员中途失效、无效审查标记、单成员取消、整团取消、父会话停止、24 次预算耗尽后的部分 Artifact。**
  - **执行层级**：**真机 Electron GUI + 真实 Host/Renderer + 本机 OpenAI 兼容 SSE（Phase B `B4`–`B9`，全部 6 项在真实 UI 与真实 Host 中执行）**。
  - **核验事实**：
    - **单成员取消（`B4`）**：点击慢速成员行 `终止成员` → 出现行内确认 `确认终止成员` → 点击确认后成员以 `stopped`（`expert-team-member-cancelled`）结束，已完成的同团成员保留，整团结算 `partial`。
    - **整团取消（`B5`）**：点击聚合卡 `终止专家团` → 点击 `确认终止专家团` → 整团与在途成员均收敛至 `stopped`（`已停止`），团长回合中止。
    - **父会话停止（`B6`）**：点击输入框 `停止` 按钮触发 `session.cancel` → 专家团与成员同步收敛至 `stopped`。
    - **成员中途失效（`B7`）**：在 `broadcast` 团队完成首名成员后，经 `/huaanwork/agent/package/setEnabled` 实时停用第二名成员包，随后派工被 Host 拒绝（`expert-team-member-disabled`），整团结算 `partial`。
    - **无效审查标记（`B8`）**：审查员未按规范输出结尾 `[VERDICT: ...]`，展开后的真实 UI 成员行红色显示 `审查标记无效（invalid-verdict）`，整团结算 `partial`（而非 `completed_with_issues`）。
    - **24 次预算耗尽 + 部分 Artifact（`B9`）**：完成 24 次派工后第 25 次派工被拒（`expert-team-dispatch-budget`），卡片显示 `调用 25/24 · 派工 24` 与失败调用条，预算豁免允许在缺必审时经 `result_present` 生成部分主报告（`primaryArtifactId` 已关联、`查看主报告` 可见），整团结算 `partial`。
  - **截图**：`13-step6a-member-cancel.png`、`14-step6b-team-cancel.png`、`15-step6e-invalid-verdict.png`、`16-step6f-budget-24-partial.png`。

- [x] **7. 验证同会话双 MCP 成员并行、普通 `@智能体` 行为、goal 续拍不能迟到派工。**
  - **执行层级**：**真机 Electron GUI + 真实云端模型 `deepseek-chat`（Phase A `step7ab`）** + **真实 Electron 本地 SSE `create_goal` 续拍（Phase B `B10`）**。
  - **核验事实**：
    - Phase A `step7ab` PASS：同一会话中 `dual-mcp-team` 并行派发 `payment-checker` 与 `invoice-mcp` 两名 MCP 成员均 `completed`，父会话 `request/header` 零 MCP 泄漏（`dualParentHasMcp: false`）；随后发送普通 `@plain-helper` 呈现独立 `SubagentRunCard` 并 `completed` 正常读取 `contract.md` 输出总结。
    - Phase B `B10` PASS：团长回合内调用真实 `create_goal`（`max_goal_rounds: 1`）并完成派工与最终汇总，团队在 `turn/end` 结算 `completed`；上游自动触发 goal 续拍轮次时，实测模型入参 `tools` 已剥离 `expert_team_dispatch`（`goalRoundHadExpertTeamDispatch: false`），强行发起迟到调用被 `huaanwork-policy` 拒绝（`工具 expert_team_dispatch 未附加到当前会话`），已结算团队保持 `resultsCount: 1` 未被改写。
  - **截图**：`09-step7-ordinary-at-agent.png`。

- [ ] **8. 验证 Host 重启后团队卡不恢复，消息和 Artifact 卡仍在；验证 Artifact 写失败（如超 5 MiB 或写盘异常）后保持 `pending`、可同回合重试且未重试结 `partial`；关联失败时 Artifact 可见但团队 `pending`/`partial`。**（**前两项真机 PASS，最后 1 项内部关联故障保留单测边界**）
  - **执行层级**：**真机 Electron GUI 真实 Host 重启（Phase A `step8a`）** + **真实 Electron 本地 SSE 超 5 MiB 写失败与同回合重试（Phase B `B11`）** + **Host/Client 单元测试（`artifactLinkError`）**。
  - **核验事实**：
    - Phase A `step8a` PASS：在 Session A 触发真实 Host 重启（`window.huaanworkAcceptance.restartHost()`，`oldPid: 93098 → newPid: 93686`），确认同一 renderer 文档未重载（`canary` 与 `performance.timeOrigin` 严格相等），新 generation 对账后旧 `ExpertTeamRunCard` 清空（`teamCards: 1 → 0`），用户消息（`1 → 1`）与 `ResultArtifactCard`（`1 → 1`）均保留且点击 Artifact 卡仍可正常加载右栏预览（`4194` 字符）。（注：Host 进程意外退出时顶部显示既有 `会话已失败` 横幅属 `App.tsx` `onSidecarExit` 既有崩溃提示逻辑，不影响消息与 Artifact 保留。）
    - Phase B `B11` PASS：
      - `B11a`：首次调用 `result_present` 传入 >5 MiB 正文被拒绝（`artifact-too-large`），同回合中实时查询 `expertTeam.runList` 确认保持 `artifactStatus: "pending"`、`deliverySealed: false`；同一回合精简正文重试 `result_present` 成功，终态 `completed` 且 `primaryArtifactId` 已关联。
      - `B11b`：超 5 MiB 写失败后不重试直接结束回合，终态结算 `partial` 且 `artifactStatus: "pending"`、`primaryArtifactId: undefined`。
    - **保留未真机注入项**：`artifactLinkError`（落盘成功但 `noteSessionArtifact` 关联失败）无生产 Electron 故障注入开关，保留由单元测试 `expert-team-runs.spec.ts` 与 `ExpertTeamRunCard.spec.ts` 覆盖（因此本条目保持未全勾选以诚实反映边界）。
  - **截图**：`10-step8-after-host-restart.png`。

- [x] **9. 验证中文输入法组合态、键盘选择、断连冻结、重连对账和终态淘汰。**
  - **执行层级**：**真机 Electron GUI + CDP 原生组合态与键盘事件（Phase A `step9a`）** + **真实 Electron `/huaanwork/events` WS 代理断连/同代重连与 21 轮终态淘汰（Phase B `B12` & `B13`）**。
  - **核验事实**：
    - **中文输入法组合态与键盘选择（Phase A `step9a`）**：经 CDP `Input.imeSetComposition` 输入 `@合规` 处于 `isComposing=true` 时按 `Enter` 不误选菜单也不触发发送（`duringImeMsgCount: 0`）；组合提交后菜单同时呈现 `智能体` 与 `专家团` 分组；输入 `@team:compliance` 时隐藏普通智能体仅留专家团（1 项）；回到 `@合规` 通过键盘 `ArrowDown + Enter` 选中并插入 `@team:compliance-team `，草稿摘要横幅显示完整团队摘要。（注：组合态由 CDP `Input.imeSetComposition` 驱动 Chromium 原生 `CompositionEvent` 链路，非人工系统拼音候选窗敲击。）
    - **断连冻结与同代重连对账（Phase B `B12`）**：运行中切断 `/huaanwork/events` WebSocket 并暂阻重连，聚合卡立即进入 `data-frozen="true"`，展示 `连接已断开，运行状态与操作已冻结，重连对账后恢复`，`终止专家团` 按钮禁用（`terminateDisabled: true`），间隔 2.2s 两次采样耗时均冻结在 `00:01`；放行重连后在同一 Host generation 下经 `expertTeam.runList` 对账解冻，释放成员后顺利收敛至 `completed`。
    - **终态淘汰（Phase B `B13`）**：同一会话连续执行 21 轮 `t-msg-only` 团队回合，第 21 轮结束后 Host `expertTeam.runList` 返回 20 条且首轮 `teamRunId`（`5f0a3a25-4f06-4919-a1a3-87561c991511`）已淘汰，DOM 聚合卡数量稳定在 20（首卡移除），21 条用户消息气泡全部保留。
  - **截图**：`03-step9-chinese-mention-menu.png`、`17-step9b-ws-disconnect-frozen.png`、`18-step9c-terminal-eviction.png`。

## 5. 范围与限制

- **未执行打包产物验收**：Windows 安装包与 macOS 签名/分发包验收仍为开放项（按 `AGENTS.md`，macOS 签名等待正式凭据，Windows 需 Windows 宿主机）。
- **两项架构不可在生产 Electron 实时注入的子项**：`unsupported-output`（`HuaAnWorkAdapter` 文本 SSE 无法生成 `image`/`file` 块）与 `artifactLinkError`（Host 内部关联故障），两者均已有自动化单元测试覆盖，本文件未将其写成真机实测通过。
- **中文输入法说明**：Phase A 使用 CDP `Input.imeSetComposition` 触发浏览器原生 `CompositionEvent` 与 `isComposing=true` 状态机；若需覆盖 macOS 系统输入法候选窗与操作系统焦点细节，仍可在发版前补充人工手敲抽检。
- **`verify:aa` 并发约束**：完整门禁不得与其它含 `verify:aa` 的任务并发执行。

## 6. 结论汇总

| 项目 | 结论 |
| --- | --- |
| 自动化 headless gate（`corepack yarn check` @ `0a465ed361`，`EXIT=0`） | **PASS** |
| Vitest 合计（`5555 passed / 15 skipped`） | **PASS** |
| 编译产物专家团 Loader/HTTP smoke（`verify:expert-team`） | **PASS** |
| 真机 Electron — Phase A 真实云端模型 `deepseek-chat`（7/7） | **PASS** |
| 真机 Electron — Phase B 本地 OpenAI 兼容 SSE 边界/故障（13/13） | **PASS** |
| Task 18 Step 3 清单（9 项） | **7 项全项真机 PASS；第 3、8 项主体真机 PASS，各自 1 项不可实时注入子项保留单测边界** |
| Windows / macOS 签名打包产物验收 | **开放** |
