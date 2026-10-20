# HuaAnWork 会话能力桌面验收记录

- 日期：2026-10-21
- 分支：`feat/huaanwork-conversation-capabilities`
- 验收时 HEAD：`24b5c28c5d`（含验收中发现的两处修复；本文件随后提交）
- 最终复核修复 HEAD：`0c140e8534`（最终整支 review 发现启动审计多等 10 秒；已移除）
- 环境：macOS 26 / Electron 44.0.0 / Node 24.18.1 / 显式 advanced 模式
- 模型：Host profile `~/.huaanwork/profiles/desktop/huaanwork-settings.json` 中的真实端点 `https://api.deepseek.com`，模型 `deepseek-flash`（不是桩模型）
- 驱动方式：用 `--remote-debugging-port=9222` 启动 worktree 的 `lib/main.js`，通过 CDP `Runtime.evaluate` 操作页面、`Page.captureScreenshot` 截图。用户数据、profile 和会话均未重置。
- 截图目录：`docs/evidence/2026-10-20-conversation-capabilities-screens/`

## 验收中发现并修复的问题

| 修复 | 提交 | 证据 |
| --- | --- | --- |
| Host 启动审计把“还没有 agent”当成致命错误，真实启动失败、无窗口 | `e0f952279e` | 首轮启动日志：`conversation surface audit failed: no agent is available...`；修复后 `verify:profile` 通过，应用正常进入 advanced 首页 |
| `propose_plan` 描述未说明计划正文必须经 `exit_plan_mode` 提交；真实模型把计划写成普通正文，计划卡和评审不出现 | `24b5c28c5d` | 首轮计划轮：`propose_plan` 后再无 `exit_plan_mode`，计划正文出现在助手气泡，并出现“缺少文件：acceptance-report.md”；修复后同一提示走 `propose_plan → exit_plan_mode`，出现计划卡并执行 |
| 最终整支 review 发现新启动审计每次都多等 10 秒 agent（gate + host audit 串行，启动约 20 秒）；移除启动路径的 agent 等待，保留服务/全局工具 fail-closed | `0c140e8534` | 修复后 `conversation-boot-audit` 的空 registry 测试在 1 秒内 resolve；`verify:host` 14/14、`verify:profile` exit 0（仍打印 gate 的 advisory no-agent warning） |
| 额外清理：stopped phase 清除残留的“执行进程已结束。结果可能不完整。”崩溃式 note；计划轮在扫工作区前先判定不核对 | `0c140e8534` | `hostStop.spec.ts` / `appWiring.spec.ts` / `outcomeCheck.spec.ts` |

修复后同一复杂请求的行为：`propose_plan` → `exit_plan_mode` → 计划卡（固定说明 + “按当前护栏自动继续”）→ `read`/`write`/自检 → `已完成：自动核对 3 项均通过`。`huaanwork-plan2-18.png` 截在计划执行中途；最终“已完成：自动核对 3 项均通过”来自同一回合的实时 DOM 观察。

## B 项结果

| ID | 结果 | 证据与说明 |
| --- | --- | --- |
| B01 | **PASS** | 真实模型流：约 1s 出现展开的“思考 · 进行中”并跟随 reasoning；正文开始时收成一行“思考 · 已生成”。`huaanwork-poll-10.png` |
| B02 | UNIT-ONLY（单测） | `thinkingPanel.spec.ts` 的 `<think>` 兜底；未用真实模型制造纯 `<think>` 输出，不能按设计 §10 当作真机 PASS |
| B03 | UNIT-ONLY（单测） | reasoning 非空时整段抑制第 2 路；`thinkingPanel.spec.ts`；未真机 |
| B04 | UNIT-ONLY（单测） | `bridge.spec.ts` 的 purpose 过滤（compaction/title）；未真机 |
| B05 | **PASS** | 重开“查询上海一周天气预报”会话，出现 3 个默认收起的“思考”面板；展开可见真实 reasoning 原文。`huaanwork-session.png` |
| B06 | **PASS（带说明）** | `huaanwork:thinking-language` 的注册由单测钉住；真实模型本轮仍用英文思考，面板按设计照实显示英文原文，未翻译 |
| B07 | **FAIL（字面）/ PASS（纯知识问答）** | 真实模型对“现在几点？请用一句话回答。”调用了 `bash date`，没有走“不调工具”的 answer 路径。`huaanwork-b07-done.png`。对“1+1等于几？”直接回答、无工具无计划卡，answer 路径本身可用。`huaanwork-b07-knowledge.png`。**这是设计预期与现实的冲突**：当前时间不在模型知识内，按 R1“不用操作环境就能回答”它属于 direct 而非 answer；B07 把“现在几点”写成不调工具，建议设计裁决（接受 direct，或提供时钟上下文）。 |
| B08 | **PASS** | 真实模型调用 `glob` + `read` 读取 `acceptance-note.md`，回答标题和 token `BLUE-HARBOR-731`；无计划卡。`huaanwork-poll-10.png` |
| B09 | **PASS（计划卡/报告）/ 部分** | 计划卡出现，固定说明“计划确认前，模型仍可能读取工作区；写入和命令继续走现有权限。”，`acceptance-report.md` 真实存在；报告路径与内容已核对。ask 档的“等待点击”未单独切换档位执行；同一评审卡的按钮路径由 B10 与 `question-answerer` 单测覆盖。 |
| B10 | **PASS** | 真实模型对含 `git push` 的计划调用 `exit_plan_mode`，出现“按这个计划执行 / 继续改计划”评审卡；点击“继续改计划”后未执行推送。`huaanwork-b10-settled.png`。未点击“按这个计划执行”，避免对用户仓库执行真实 push；工具级询问仍由 policy 单测覆盖。 |
| B11 | **PASS** | 真实模型因缺少远端信息调用 `request_input`，出现输入卡；提交答案后卡片变为“已回答：…”，答案作为同一工具结果回到模型，回合继续，没有新用户消息。`huaanwork-b11-answered.png`。取消路径在 B22 清理时验证（“回合已结束，这个问题不再等待回答”），没有单独截图。 |
| B12 | **PASS** | 模型只回复“已完成：no-such-report-731.md”且未创建文件；回合结果写“缺少文件：no-such-report-731.md”，没有“已完成”。`huaanwork-b12.png` |
| B13 | **PASS（行为观察）** | 发送后界面立即进入“正在思考/停止”状态，模型继续流式输出；发送连接没有等到 idle。未做 RPC 级别的精确计时。 |
| B14 | 未执行（单测） | 5 分钟阈值由 `turnStatus.spec.ts` 钉住；真实等待 5 分钟成本高，未执行 |
| B15 | UNIT-ONLY（单测） | `sessions.spec.ts` 的 sibling 取消用例；未真机 |
| B16 | **PASS（macOS）** | 挂起 Host 主循环后约 15 秒出现“执行进程无响应”；60 秒出现“结束进程”（`huaanwork-b16-60b.png`）。点击后 native 确认框有“终止 / 取消”，点“终止”后 Host 进程消失；界面显示“执行进程已按你的要求结束”，没有崩溃/恢复框（`huaanwork-b16-kill.png`）。确认框的会话数量文本未逐字读取；Windows 未验证。 |
| B17 | **PASS** | `seq 1 20000` 的真实工具结果在对话中标记“已截断”，保留尾部与 spill 路径；模型仍正确回答最后一行 20000。`huaanwork-b17.png` |
| B18 | 不适用 | 发送解耦已先于 `tool-goal` 启用；HEAD 上无法重建“启用前”状态。顺序约束由提交顺序与 `sessions.spec.ts` 覆盖。 |
| B19 | **PASS（macOS）** | 真实模型 `create_goal` 创建目标；UI 依次显示“正在按目标继续，第 1/4 轮”到“第 4/4 轮”；第 4 轮后显示“已停在第 4/4 轮。尚未核对：无”，没有第 5 轮自动续跑（`huaanwork-b19-final.png`）。目标保持 active/blocked(round-limit) 且未自行完成。随后用户明确说“完成”，模型用 revision 2 调 `update_goal complete`，最终 phase `complete`、revision 3、disarmed（`huaanwork-b19-complete.png`）。本轮目标只做文件读取/编辑，未触发工具级权限询问。 |
| B20 | **PASS** | advanced 首页正常；官方 `ui-plan`/`ui-trajectory`/`ui-user-questions` 不在页面；`jobs`/web/hmr 等锁由 `profile.spec.ts`/`row-assertions` 与应用启动验证。`huaanwork-main.png` |
| B21 | 未执行（单测） | `noteInvalidRoute` 的两次计数由单测覆盖；真实模型不会故意产生两次坏参数，未用桩 profile 重配端点 |
| B22 | **PASS** | 点击“继续改计划”后 `exit_plan_mode` 以拒绝结算，计划模式保持，模型通过 `request_input` 请求修订方向，未执行计划中的写入/命令。`huaanwork-b22.png` |
| B23 | **PASS** | 流式回合中点击停止，思考面板标题变为“思考 · 已中断”，展开后保留 2,466 字符 reasoning；对话追加“已停止”。`huaanwork-b23-stop.png` |
| B24 | **PASS** | 计划模式中常备“退出计划模式”可点；点击后出现“已退出计划模式”，按钮消失，未执行计划中的写入/命令。`huaanwork-exit-plan.png` |
| B25 | UNIT-ONLY（单测） | `route-tools.spec.ts`/`model.spec.ts` 的控制工具优先与兄弟调用丢弃；未真机 |
| B26 | **PASS** | smart 档下计划卡显示“按当前护栏自动继续”，未要求为用户计划本身点击；随后的写入仍走工具级 policy。`huaanwork-plan2-18.png` |

## 自动化门禁

Task 8 的全量 headless 记录（在 e0f952279e/24b5c28c5d 两处验收修复之前）：

- `corepack yarn workspace dsh-plugin-huaanwork test`：**2804 passed / 13 skipped / 1 failed**；唯一失败是 `tests/mac-entitlements.spec.ts` 读取未初始化的 `deepseek-harness` 子模组，属环境限制，不是分支失败。
- `typecheck`：exit 0。
- `check:desktop-variants`：11/11，allowlist 64 / oneSidedPrefixes 6 不变。
- `build`：exit 0；`lib/bin.js` 与新增模块已刷新。
- 八个 `verify:*` 步骤全部通过。

验收修复后的最终全量门禁（HEAD 含 `e0f952279e`、`24b5c28c5d`、`0c140e8534`）：

- `test`：**2815 passed / 13 skipped / 1 failed**；唯一失败仍是上述 `mac-entitlements.spec.ts` 的环境缺失，没有任何分支失败。
- `typecheck`：exit 0。
- `check:desktop-variants`：exit 0（11/11，allowlist 64 / oneSidedPrefixes 6）。
- 最终构建已在 `0c140e8534` 后执行；应用此前从 `24b5c28c5d` 构建启动并通过上述桌面检查，`0c140e8534` 的启动等待与 UI 清理由聚焦测试和构建覆盖。
- `0c140e8534` 后的 post-fix smokes：`verify:host` **14/14**、`verify:profile` **exit 0**（仍打印 gate 的 advisory no-agent warning，属预期）。
- 整支最终 review 发现并修复的启动等待：`0c140e8534` 移除了 Host/target 启动审计对按会话创建的 agent 的 10 秒等待；`conversation-boot-audit` 的空 registry 用例在 1 秒内 resolve，服务/全局工具仍 fail-closed。

## 残余风险与说明

- 启动日志仍有一条 **advisory**：`huaanwork-gates` 是可选 entry，boot 时没有 agent，无法验证主 agent 的 `restrict()`；Host 侧 post-boot audit 已保证 service/全局工具缺失会中止启动。该 warning 不阻塞启动；gate 自身只读一次 agent 列表并保留 advisory 报错，10 秒等待来自已移除的共享审计。
- `查询上海一周天气预报` 的旧会话日志被 `dsh-session` 报告 `first frame is not exactly one header line`；UI 的只读历史仍能显示（B05 用的就是它），但 agent 恢复该旧会话会失败。这是既有数据问题，不是本分支写入路径造成的。
- B07 的字面失败是设计预期与真实模型能力的冲突；需要在设计层裁决：建议把 B07 改为“不出现计划卡；允许一次有界只读工具”，或在系统提示里提供时钟。不要为此改路由器（当前时间不在模型知识内，`bash date` 属于 R1 的 direct）。
- B14/B21 以单测为准；B15/B25 标为 UNIT-ONLY；B19 本轮已在真实模型上跑满 4 轮并验证停止/完成；B18 是顺序回归。B16 在 macOS 上已验证 kill，Windows 未验证。
- 真实模型调用消耗了用户配置的 DeepSeek 额度；验收文件 `acceptance-note.md` 与 `acceptance-report.md` 留在 workspace，可按需删除。

## 最终 review 的剩余跟进项（不阻塞合并）

- `session.remove` 取消后异步日志 flush 可能在 unlink 后重建一个无 header 的文件；本次未复现，手工删除活跃会话时验证一次。
- `child.kill()` 返回 false 被忽略；Host 已标记 stopped 时仍可能命中原进程。
- git 快照 budget 是每次快照独立，多个并发会话可叠加 1.5 秒窗口。
- `appWiring.spec` 的 App 调用 pin 对格式敏感；`test-port-mapping` 行锚点仅检查非空。
- `formatArgs` 对 JSON 字符串参数会去掉外层引号；显示层小问题。
- 漏掉 goal `clear/complete` 时客户端可能保持 `phases=active` 到下一回合；重连后重新读 goal 可解。
- 无人值守的 session-less `request_input`/plan-review 归属语义在注释与实现之间有轻微不对称（测试形状均 fail-closed）。

## 复跑方式

1. 启动真实模型端点，确认 Host profile 的 `base_url`/`model` 可访问。
2. 在 worktree 构建并启动：
   `corepack yarn workspace dsh-plugin-huaanwork build`
   `node_modules/electron/dist/Electron.app/Contents/MacOS/Electron --remote-debugging-port=9222 lib/main.js`
3. 打开 `http://127.0.0.1:9222/json` 取得页面 WebSocket，按上表逐项执行。
4. B16 60 秒 kill：挂起 Host 的 `node.mojom.NodeService` 进程，等 60 秒，确认框出现后只点“取消”，不要对用户仓库执行真实 push。
