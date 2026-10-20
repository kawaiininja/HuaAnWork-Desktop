# HuaAnWork 会话能力桌面验收记录

- 日期：2026-10-21
- 分支：`feat/huaanwork-conversation-capabilities`
- 验收时 HEAD：`24b5c28c5d`（含验收中发现的两处修复；本文件随后提交）
- 环境：macOS 26 / Electron 44.0.0 / Node 24.18.1 / 显式 advanced 模式
- 模型：Host profile `~/.huaanwork/profiles/desktop/huaanwork-settings.json` 中的真实端点 `https://api.deepseek.com`，模型 `deepseek-flash`（不是桩模型）
- 驱动方式：用 `--remote-debugging-port=9222` 启动 worktree 的 `lib/main.js`，通过 CDP `Runtime.evaluate` 操作页面、`Page.captureScreenshot` 截图。用户数据、profile 和会话均未重置。
- 截图目录：`docs/evidence/2026-10-20-conversation-capabilities-screens/`

## 验收中发现并修复的问题

| 修复 | 提交 | 证据 |
| --- | --- | --- |
| Host 启动审计把“还没有 agent”当成致命错误，真实启动失败、无窗口 | `e0f952279e` | 首轮启动日志：`conversation surface audit failed: no agent is available...`；修复后 `verify:profile` 通过，应用正常进入 advanced 首页 |
| `propose_plan` 描述未说明计划正文必须经 `exit_plan_mode` 提交；真实模型把计划写成普通正文，计划卡和评审不出现 | `24b5c28c5d` | 首轮计划轮：`propose_plan` 后再无 `exit_plan_mode`，计划正文出现在助手气泡，并出现“缺少文件：acceptance-report.md”；修复后同一提示走 `propose_plan → exit_plan_mode`，出现计划卡并执行 |

修复后同一复杂请求的行为：`propose_plan` → `exit_plan_mode` → 计划卡（固定说明 + “按当前护栏自动继续”）→ `read`/`write`/自检 → `已完成：自动核对 3 项均通过`。见 `huaanwork-plan2-18.png`。

## B 项结果

| ID | 结果 | 证据与说明 |
| --- | --- | --- |
| B01 | **PASS** | 真实模型流：约 1s 出现展开的“思考 · 进行中”并跟随 reasoning；正文开始时收成一行“思考 · 已生成”。`huaanwork-poll-10.png` |
| B02 | PASS（单测） | `thinkingPanel.spec.ts` 的 `<think>` 兜底；本轮未用真实模型制造纯 `<think>` 输出 |
| B03 | PASS（单测） | reasoning 非空时整段抑制第 2 路；`thinkingPanel.spec.ts` |
| B04 | PASS（单测） | `bridge.spec.ts` 的 purpose 过滤（compaction/title） |
| B05 | **PASS** | 重开“查询上海一周天气预报”会话，出现 3 个默认收起的“思考”面板；展开可见真实 reasoning 原文。`huaanwork-session.png` |
| B06 | **PASS（带说明）** | `huaanwork:thinking-language` 的注册由单测钉住；真实模型本轮仍用英文思考，面板按设计照实显示英文原文，未翻译 |
| B07 | **FAIL（字面）/ PASS（纯知识问答）** | 真实模型对“现在几点？请用一句话回答。”调用了 `bash date`，没有走“不调工具”的 answer 路径。`huaanwork-b07-done.png`。对“1+1等于几？”直接回答、无工具无计划卡，answer 路径本身可用。`huaanwork-b07-knowledge.png`。**这是设计预期与现实的冲突**：当前时间不在模型知识内，按 R1“不用操作环境就能回答”它属于 direct 而非 answer；B07 把“现在几点”写成不调工具，建议设计裁决（接受 direct，或提供时钟上下文）。 |
| B08 | **PASS** | 真实模型调用 `glob` + `read` 读取 `acceptance-note.md`，回答标题和 token `BLUE-HARBOR-731`；无计划卡。`huaanwork-poll-10.png` |
| B09 | **PASS（计划卡/报告）/ 部分** | 计划卡出现，固定说明“计划确认前，模型仍可能读取工作区；写入和命令继续走现有权限。”，`acceptance-report.md` 真实存在；报告路径与内容已核对。ask 档的“等待点击”未单独切换档位执行；同一评审卡的按钮路径由 B10 与 `question-answerer` 单测覆盖。 |
| B10 | **PASS** | 真实模型对含 `git push` 的计划调用 `exit_plan_mode`，出现“按这个计划执行 / 继续改计划”评审卡；点击“继续改计划”后未执行推送。`huaanwork-b10-settled.png`。未点击“按这个计划执行”，避免对用户仓库执行真实 push；工具级询问仍由 policy 单测覆盖。 |
| B11 | **PASS** | 真实模型因缺少远端信息调用 `request_input`，出现输入卡；提交答案后卡片变为“已回答：…”，答案作为同一工具结果回到模型，回合继续，没有新用户消息。`huaanwork-b11-answered.png`。取消路径也验证：取消后“回合已结束，这个问题不再等待回答”。 |
| B12 | **PASS** | 模型只回复“已完成：no-such-report-731.md”且未创建文件；回合结果写“缺少文件：no-such-report-731.md”，没有“已完成”。`huaanwork-b12.png` |
| B13 | **PASS（行为观察）** | 发送后界面立即进入“正在思考/停止”状态，模型继续流式输出；发送连接没有等到 idle。未做 RPC 级别的精确计时。 |
| B14 | 未执行（单测） | 5 分钟阈值由 `turnStatus.spec.ts` 钉住；真实等待 5 分钟成本高，未执行 |
| B15 | PASS（单测） | `sessions.spec.ts` 的 sibling 取消用例 |
| B16 | **PARTIAL** | 独立 Host 上挂起主循环后约 15 秒出现“执行进程无响应”，恢复后消失（`huaanwork-b16-suspect.png`）。60 秒“结束进程”确认**未验证**：62 秒观察时 Host 已被随后的测试清理命令（`pkill`）终止，界面出现的是 Host 崩溃/恢复框，而不是可归因于 liveness 的 kill 确认，因此该次 62 秒观察不作为结论。Windows 未验证。 |
| B17 | **PASS** | `seq 1 20000` 的真实工具结果在对话中标记“已截断”，保留尾部与 spill 路径；模型仍正确回答最后一行 20000。`huaanwork-b17.png` |
| B18 | 不适用 | 发送解耦已先于 `tool-goal` 启用；HEAD 上无法重建“启用前”状态。顺序约束由提交顺序与 `sessions.spec.ts` 覆盖。 |
| B19 | 未执行 | 目标续轮是设计 §4 第 7 步，单独验收；本轮未创建真实 goal 跑满 4 轮 |
| B20 | **PASS** | advanced 首页正常；官方 `ui-plan`/`ui-trajectory`/`ui-user-questions` 不在页面；`jobs`/web/hmr 等锁由 `profile.spec.ts`/`row-assertions` 与应用启动验证。`huaanwork-main.png` |
| B21 | 未执行（单测） | `noteInvalidRoute` 的两次计数由单测覆盖；真实模型不会故意产生两次坏参数，未用桩 profile 重配端点 |
| B22 | **PASS** | 点击“继续改计划”后 `exit_plan_mode` 以拒绝结算，计划模式保持，模型通过 `request_input` 请求修订方向，未执行计划中的写入/命令。`huaanwork-b22.png` |
| B23 | **PASS** | 流式回合中点击停止，思考面板标题变为“思考 · 已中断”，展开后保留 2,466 字符 reasoning；对话追加“已停止”。`huaanwork-b23-stop.png` |
| B24 | **PASS** | 计划模式中常备“退出计划模式”可点；点击后出现“已退出计划模式”，按钮消失，未执行计划中的写入/命令。`huaanwork-exit-plan.png` |
| B25 | PASS（单测） | `route-tools.spec.ts`/`model.spec.ts` 的控制工具优先与兄弟调用丢弃 |
| B26 | **PASS** | smart 档下计划卡显示“按当前护栏自动继续”，未要求为用户计划本身点击；随后的写入仍走工具级 policy。`huaanwork-plan2-18.png` |

## 自动化门禁

Task 8 的全量 headless 记录（在 e0f952279e/24b5c28c5d 两处验收修复之前）：

- `corepack yarn workspace dsh-plugin-huaanwork test`：**2804 passed / 13 skipped / 1 failed**；唯一失败是 `tests/mac-entitlements.spec.ts` 读取未初始化的 `deepseek-harness` 子模组，属环境限制，不是分支失败。
- `typecheck`：exit 0。
- `check:desktop-variants`：11/11，allowlist 64 / oneSidedPrefixes 6 不变。
- `build`：exit 0；`lib/bin.js` 与新增模块已刷新。
- 八个 `verify:*` 步骤全部通过。

验收修复后的最终全量门禁（HEAD 含 `e0f952279e`、`24b5c28c5d`）：

- `test`：**2811 passed / 13 skipped / 1 failed**；唯一失败仍是上述 `mac-entitlements.spec.ts` 的环境缺失，没有任何分支失败。
- `typecheck`：exit 0。
- `check:desktop-variants`：exit 0（11/11，allowlist 64 / oneSidedPrefixes 6）。
- 最终构建已在两处验收修复后执行；应用从该构建启动并通过上述桌面检查。

## 残余风险与说明

- 启动日志仍有一条 **advisory**：`huaanwork-gates` 是可选 entry，boot 时没有 agent，无法验证主 agent 的 `restrict()`；Host 侧 post-boot audit 已保证 service/全局工具缺失会中止启动。该 warning 不阻塞启动。
- `查询上海一周天气预报` 的旧会话日志被 `dsh-session` 报告 `first frame is not exactly one header line`；UI 的只读历史仍能显示（B05 用的就是它），但 agent 恢复该旧会话会失败。这是既有数据问题，不是本分支写入路径造成的。
- B07 的字面失败是设计预期与真实模型能力的冲突；需要在设计层裁决，详见上表。
- B14/B15/B18/B19/B21/B25 中，B14/B15/B21/B25 以单测为准；B19 是独立的目标续轮验收；B18 是顺序回归。B16 的 60 秒 kill 与 Windows 未验证。
- 真实模型调用消耗了用户配置的 DeepSeek 额度；验收文件 `acceptance-note.md` 与 `acceptance-report.md` 留在 workspace，可按需删除。

## 复跑方式

1. 启动真实模型端点，确认 Host profile 的 `base_url`/`model` 可访问。
2. 在 worktree 构建并启动：
   `corepack yarn workspace dsh-plugin-huaanwork build`
   `node_modules/electron/dist/Electron.app/Contents/MacOS/Electron --remote-debugging-port=9222 lib/main.js`
3. 打开 `http://127.0.0.1:9222/json` 取得页面 WebSocket，按上表逐项执行。
4. B16 60 秒 kill：挂起 Host 的 `node.mojom.NodeService` 进程，等 60 秒，确认框出现后只点“取消”，不要对用户仓库执行真实 push。
