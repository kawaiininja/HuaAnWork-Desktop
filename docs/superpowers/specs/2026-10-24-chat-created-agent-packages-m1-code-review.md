# 会话内创建智能体包 M1 实施代码评审

- **评审日期**：2026-10-24
- **评审分支**：`feat/chat-created-agent-packages-m1`
- **评审基线**：`5f2ed71feb111503beb6ebb1df11cbc83ad5ded6`（`docs/chat-created-agents-design` merge-base）
- **评审 HEAD**：`df9976d334135d25af9ada335d8611c088baa39b`
- **变更规模**：41 个提交，70 个文件，约 +14,019 / −550 行
- **需求依据**：
  - `docs/superpowers/specs/2026-10-23-chat-created-agent-packages-design.md`
  - `docs/superpowers/plans/2026-10-23-chat-created-agent-packages-m1.md`
- **辅助核对材料**：`docs/huaanwork-agent-packages-m1.md`、`docs/evidence/2026-10-23-agent-package-macos-acceptance.md`、`docs/evidence/2026-10-23-agent-package-sandbox-probe.md`
- **评审方式**：独立代码评审子代理通读规格、计划、实现、测试与验收材料；主会话复核关键发现的原文、代码路径和行号，并在目标 worktree 补跑全量 headless 门禁。本文行号均以上述 HEAD 为准。

## 总结论

**代码合并建议：With fixes；M1 完成判定：BLOCKED。**

M1 功能面基本实现，未发现经核实的 Critical 级代码缺陷；创建、包存储、运行时、工具策略、旧 `@agent` 兼容、Host/RPC 和三页签 UI 均已落地，自动化测试与全量 headless 门禁通过。

但计划明确要求 Windows 真机探针与完整交互验收，且规定没有 Windows 真机不得宣布 M1 完成。因此当前准确状态是：

> **代码功能面基本完成，验收尚未完成；Windows BLOCKED，macOS 验收口径待统一。**

代码合并与 M1 完成应分开判定：合并前至少修复跨标签事件归属并统一验收文档口径；无论是否合并，Windows 真机验收完成前均不得宣布 M1 完成。

---

## 一、做得较好的部分

1. **测试验证真实行为，而非仅验证 mock 调用。**
   - 运行时测试真实 spawn 子进程、启动 HTTP/MCP fixture、执行端口健康检查并断言进程清理。
   - store 测试使用真实文件系统覆盖 `.tmp-*` 清理、`.old-*` 中断恢复、损坏包与状态上限。
   - 沙箱缺失和 `SANDBOX_UNAVAILABLE` 均有 fail-closed 负例：`dsh-plugin-huaanwork/tests/huaanwork-host/agent-package-runtime.spec.ts:881`。

2. **创建同意门禁覆盖完整。**
   - 同轮 propose→commit、非同意句、`draftId` 不匹配、过期同意和重复 commit 均有防护与测试。
   - 重复 commit 通过 `draftId` 返回既有确认结果，不覆盖已落盘包。
   - 相关测试锚点：`dsh-plugin-huaanwork/tests/huaanwork-host/agent-package-creation.spec.ts:444`。

3. **并发与运行时生命周期处理较扎实。**
   - 同会话 `@` 回合在第一个 await 之前同步占位，避免双发运行时和子会话：`dsh-plugin-huaanwork/src/huaanwork-host/agent-package/host.ts:284`。
   - 预留 childId 预挂载包工具，覆盖子代理首轮模型请求早于 after-start 的时序问题。
   - 进程提前退出、启动失败、空闲后停止和清理路径均有测试。

4. **工具策略与沙箱边界符合 M1 设计。**
   - 包工具按 attached 状态判定；包运行工具的放行与创建工具的确认要求分离。
   - 子进程环境变量采用白名单；沙箱不可用时拒绝运行，而非无沙箱降级。
   - 确认卡和详情页明确说明“只限制写，读取文件和网络不受限制”，未夸大隔离能力。

5. **catalog-legacy 与变体纪律处理良好。**
   - 旧条目继续走旧启用表和旧 `kind:"agent"` 路径，不下载、不复制、不物化。
   - 目录不可达时保留已知状态并显示 `catalogError`。
   - `check:desktop-variants` 通过，stable↔beta 7 项、beta↔huaanwork 64 项、`oneSidedPrefixes` 6 项，未新增白名单。

---

## 二、问题清单

### Critical（Must Fix）

**无经独立核实的 Critical 级代码缺陷。**

Windows 真机验收缺失是计划级完成阻断项，列入 Important-1；不将其伪装成已经证实的代码 bug。

### Important（Should Fix）

#### I-1　Windows 真机验收缺失，按计划直接阻断 M1 完成

**要求来源：**

- Task 1 Step 3 要求 Windows 真机运行探针，没有真机即记录 BLOCKED：`docs/superpowers/plans/2026-10-23-chat-created-agent-packages-m1.md:129`
- Task 9 Step 5 要求重复完整交互验收，没有 Windows 真机不得宣布完成：`docs/superpowers/plans/2026-10-23-chat-created-agent-packages-m1.md:1016`

**当前状态：**验收文档已诚实记录 Windows BLOCKED；单元测试、macOS 实机证据和 headless 门禁均不能替代该项。

**未验证面包括：**

- `pwsh` 工具白名单分支：`dsh-plugin-huaanwork/src/huaanwork-host/agent-package/runtime.ts:163`
- Windows `taskkill` 停止路径：`dsh-plugin-huaanwork/src/huaanwork-host/agent-package/runtime.ts:699`
- `taskkill` 失败当前被吞没：`dsh-plugin-huaanwork/src/huaanwork-host/agent-package/runtime.ts:724`
- `enforcement:partial`、读/网络不隔离的实际表现。
- 安装、退出和回合结束后的进程清理。

**处置建议：**在 Windows 真机完成探针与 Task 9 Step 4 同等的完整流程，保存原始 JSON、`enforcement`、读/网络观察和进程清理证据。完成前保持 M1 状态为 BLOCKED。

#### I-2　多标签场景下，确认卡和提示会写入错误会话标签

**位置：**

- 已提取事件会话 ID：`dsh-plugin-huaanwork/src/client-huaanwork/App.tsx:1129`
- 但 `agent/notice` 与 `agent/confirm` 仍使用当前 live 标签：`dsh-plugin-huaanwork/src/client-huaanwork/App.tsx:1138`

**问题：**事件本身携带 `sessionId`，客户端却没有用它路由，而是始终写入 `liveChatRef.current`。

**失败场景：**会话 A 发起创建，在等待模型响应时切换到标签 B；随后 A 的确认卡会出现在 B，而 A 中没有确认卡。草稿与同意门禁仍属于 A，因此 B 中显示的卡片也无法自然完成对应确认，造成明显的会话上下文错位。

**测试缺口：**客户端测试中未找到 `agent/confirm` / `agent/notice` 的跨标签归属覆盖。

**处置建议：**按 `event.sessionId` 使用既有标签路由机制，而不是 `liveChatRef.current`；补“两个标签并发或切换后事件不错位”的回归测试。**建议合并前修复。**

#### I-3　已启用包一旦损坏，就无法再通过 UI 或 Host 关闭

**位置：**

- Host 对 broken 包的所有 `setEnabled` 调用一律抛错：`dsh-plugin-huaanwork/src/huaanwork-host/agent-package/host.ts:240`
- 卡片按钮同时对 broken 包禁用：`dsh-plugin-huaanwork/src/client-huaanwork/AgentPackagesPanel.tsx:124`

**失败场景：**包在启用后发生 manifest 解析失败、persona/技能/入口文件缺失等损坏，状态仍是 `enabled:true`；用户既不能运行，也不能通过产品界面将其关闭。

**处置建议：**只阻止 broken 包的启用、更新和运行，允许 `setEnabled(slug, false)`；面板允许执行“关闭”，并补 Host、路由和面板回归测试。

**登记状态：**该项已作为非阻断残余登记于 `CLAUDE.md:73`，不是本次新发现。本次评审确认其真实存在，并建议提高处置优先级；若仍维持非阻断裁定，应在合并记录中明确保留，而不是视为已解决。

#### I-4　macOS 验收的完成口径尚未统一

**材料：**

- runbook 将“真人交互验收”标为 BLOCKED：`docs/huaanwork-agent-packages-m1.md:5`
- 验收证据将代理驱动的真实 macOS 应用、真实模型全链路记为 PASS：`docs/evidence/2026-10-23-agent-package-macos-acceptance.md:7`

**问题：**两种证据可以同时成立，但当前没有明确“代理驱动的真实应用验收是否足以替代计划中的 macOS 交互验收”。因此不能简单把 Task 9 的 macOS 项标为完成，也不能否认已有实机证据。

**处置建议：**明确裁定并统一文档口径：

1. 若接受代理驱动的真实应用验收，则将 runbook 改为引用该证据，并把真人复核标为建议项或独立剩余项；
2. 若仍要求真人流，则保留 macOS BLOCKED，并将现有证据准确命名为“代理驱动实机验收通过”。

**建议合并前完成该文档口径裁定。**

### Minor（Nice to Have）

#### M-1　存在永远不会 abort 的 `AbortController`

- `dsh-plugin-huaanwork/src/huaanwork-host/agent-package/host.ts:467`
- `dsh-plugin-huaanwork/src/huaanwork-host/agent-invoke.ts:237`

两处都创建 `new AbortController().signal`，但没有保留 controller，信号永远不会触发。实际清理由 cleanup/dispose 完成。建议接入真实取消源，或删除该死代码及误导性注释。

#### M-2　非超时 MCP 挂载错误与 runbook 的错误分类不一致

`dsh-plugin-huaanwork/src/huaanwork-host/agent-package/runtime.ts:431` 中，只有超时分支明确带“脚本启动失败：”前缀；其他 MCP 挂载错误直接抛出。建议统一错误分类或调整 runbook，避免排障文档与真实输出不一致。

#### M-3　计划中的 `manifest.skill.scripts` 是与规格不一致的旧表述

- 计划 Task 6 写到按 `manifest.skill.scripts` 精确匹配：`docs/superpowers/plans/2026-10-23-chat-created-agent-packages-m1.md:767`
- 规格 §5.2 的 manifest `skill` 只有 `entry` 与 `summary`：`docs/superpowers/specs/2026-10-23-chat-created-agent-packages-design.md:139`
- 实现类型遵循规格：`dsh-plugin-huaanwork/src/huaanwork-host/agent-package/types.ts:15`
- 运行时从 `skill/scripts/**` 枚举声明：`dsh-plugin-huaanwork/src/huaanwork-host/agent-package/runtime.ts:647`

**判定：实现遵循了规格，这是计划文本缺陷，不应据此反向修改实现。** 建议修订计划旧表述，并保持 persona 展示与工具执行共用同一脚本枚举源。

#### M-4　同意门禁存在一个值得补测试的 skill 边界（未作为已确认漏洞）

`dsh-plugin-huaanwork/src/huaanwork-host/sessions.ts:133` 在每轮先记录用户原句；带其他 `skill` 参数的回合不会进入创建提示注入，而此前挂载的创建工具会跨轮保留。若该回合原文恰为“可以”，且模型仍能取得 `draftId` 并调用 `agent_commit`，现有门禁只凭原句、draftId 和同轮 propose 状态仍可能接受。

该路径尚未做端到端复现，且用户原文本身确实是同意短语，因此**不列为已确认安全漏洞**。建议补定向测试，并评估是否将 commit 进一步限定为“本轮命中创建/继续创建流程”的会话状态。

### 已登记残余不得误记为已关闭

`CLAUDE.md:73` 登记的 M1 残余本次复核仍存在，包括：

- legacy `@agent` 子会话首轮工具清单未受 allow 限制；
- provider 忽略预留 childId 时，fallback 会跳过实际子会话的 restrict/refresh；
- `readOnDiskManifest` 的软链守卫缺口；
- update 播种对非 UTF-8 脚本有损；
- `enforcement:partial` 未上报/未记日志；
- `@` 补全不匹配 displayName；
- 在途 toggle 丢弃其他卡片点击等。

这些项目按既有登记为非阻断，但全量测试转绿不代表它们已经关闭。

---

## 三、Task 1–9 完成度

| 计划任务 | 评审状态 | 说明 |
|---|---|---|
| Task 1：M1.0 可行性 spike | **部分完成** | macOS 探针有证据；Windows 真机 BLOCKED |
| Task 2：manifest、store、状态与 catalog-legacy | 完成 | 原子写、恢复、损坏卡、状态与旧条目兼容均有实现和测试 |
| Task 3：草稿、propose/commit/cancel、更新与幂等 | 完成 | 同轮门禁、同意句、patch+1、启用态保留和重复 commit 已覆盖 |
| Task 4：创建入口、create-agent 技能、宿主工具 | 完成 | 入口注入、工具挂载、确认卡与创建/更新流程已接线 |
| Task 5：运行时进程、沙箱与 persona 合成 | 代码完成 | 真实进程生命周期已测试；Windows 专属路径未实机验证 |
| Task 6：工具合成与 `@` 分发 | 完成 | HTTP/MCP/技能脚本、legacy 分流、并发与失败清理已覆盖 |
| Task 7：Host 路由、RPC 类型与客户端 API | 完成 | 62 个 RPC 的计数与契约已同步 |
| Task 8：AgentsView 三页签与客户端交互 | 已实现，有缺陷 | 三页签和结构化确认卡已完成；I-2 跨标签归属需修 |
| Task 9：硬化、兼容验收、双平台与 runbook | **部分完成** | 全量门禁本次通过；macOS 口径待统一；Windows BLOCKED |

**总体定性：代码功能面基本完成；验收层面 M1 未完成。** 不使用缺乏统一分母的虚假完成百分比。

---

## 四、本次实际验证

以下命令均在目标 worktree 执行；未启动图形应用，未修改实现代码。

| 命令 / 检查 | 结果 |
|---|---|
| `corepack yarn workspace dsh-plugin-huaanwork test` | **PASS**：3150 passed，14 skipped；254 个测试文件通过，4 个跳过 |
| `corepack yarn workspace dsh-plugin-huaanwork typecheck` | **PASS** |
| `corepack yarn test` | **PASS** |
| `corepack yarn typecheck` | **PASS** |
| `corepack yarn check:desktop-variants` | **PASS**：11/11；7/64，前缀 6；未新增白名单 |
| `corepack yarn check` | **PASS，exit 0**；本次评审在最终 HEAD 补跑 |
| `git diff --check 5f2ed71feb..df9976d334` | **PASS** |
| Windows 真机探针与交互验收 | **未执行，无 Windows 真机** |

补充说明：验收材料此前记录“根 `corepack yarn check` 未在最终树重跑”；本次评审已经补跑并通过，消除了该自动化门禁缺口。由于原评审要求只读，本次结果未回写那些验收材料；后续可在不伪造历史记录的前提下追加本次评审证据指针。

评审后目标 worktree 与主工作树均保持干净。

---

## 五、合并与收口建议

### 代码合并前

1. **修复 I-2**：`agent/confirm` / `agent/notice` 按 `sessionId` 归属标签，并补多标签回归测试。
2. **统一 I-4**：明确代理驱动 macOS 实机验收与真人交互验收的关系，消除状态口径歧义。
3. **建议同批修复 I-3**：允许损坏包关闭；若继续沿用既有非阻断裁定，需明确保留债务及触发条件。
4. Minor 项可后续处理，但 M-3 的计划文本订正成本很低，建议随文档收口一并完成。

### 宣布 M1 完成前

1. 在 Windows 真机完成 Task 1 探针与 Task 9 完整交互验收，落实 I-1 所需全部证据。
2. 明确 macOS 验收是否已通过，并保持 runbook、证据文档和里程碑状态一致。
3. 确保合并后的最终提交再次通过 `corepack yarn check`；若代码继续变化，不能把本次对 `df9976d334` 的结果自动视为新提交的结果。
4. 继续保持 M1 不包含发布、签名、下载、安装、广场更新、下架和撤销的边界，不以本地创建链路冒充 M2 已交付。

**最终评审意见：With fixes 可考虑代码合并；M1 当前不得宣布完成。**
