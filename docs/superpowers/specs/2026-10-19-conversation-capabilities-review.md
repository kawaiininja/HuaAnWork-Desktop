# 《HuaAnWork 会话分流、思考面板与长任务规格》评审意见

- **评审对象**：`docs/superpowers/specs/2026-10-19-conversation-capabilities-design.md`（草案，取代 2026-10-18 编排规格）
- **评审日期**：2026-10-19
- **对照的原始需求**（用户三条）：
  1. 每次会话模型先按 prompt 理解意图——简单意图直接调工具执行；复杂意图先任务拆解、制定执行计划、按计划调用工具，并确保计划正确完整执行、返回最终结果；
  2. 展示模型思考过程 / chain of thought，中文展示更友好直观；
  3. 复杂任务执行时间长时，解决进程卡死或超时问题。
- **评审方式**：背靠背核实——§3「已核实的现状」11 行逐条在源码、补丁文件与 vendored tgz 上复核；`dsh-plan-mode`、`dsh-user-questions`、`dsh-goal-round-driver` 三个关键包从 `vendor/dsh-runtime/0.2.1-rc.1/` 解包验读；`propose_plan`/`request_input` 两个工具名做**三处全量扫描**（vendored tgz 逐一流式 grep、子模组源码、华安包）；本文为第二轮复核稿，第一轮口头意见的每条结论均标注处置（维持/订正/撤回）
- **评审结论**：**有条件通过**——事实基础（§3 全部 11 行经复核**无一失实**）、顺序设计（§4 的两条依赖论证经独立验证成立）、需求覆盖与验收框架均成立；但 §5.1 分流器引用了两个在钉定运行时中**不存在**的工具名且该核心新组件在 §9 落点表缺行（P1×1，批准前必须裁定），另有 P2×4、P3×5 需文字级修订或登记为实施期开口项
- **修订复审（2026-10-19 同日第二轮）**：Grok 按本文全部 P1/P2/P3 修订设计稿（v2）。逐条复审结论见 §八——**P1 已消解**（路线 (a) 自建工具，可行性经 `call_host_tool` 生产先例核实）；P2×4 全部消解；三处「未采纳」均给出合理理由并核实成立（P2-2 的 ctx.planMode 直驱被拒、P3-2 重跑被读侧核对取代、P1-1 路线 (b) 被拒）。修订引入的新断言 `ctx.systemPrompt.section`、`PLAN_POLICY: 500`、present-as 白名单必要性**逐条核实为真**。复审新发现 **1 个 P2**（分流工具漏了 `model.ts isRegisteredToolName` 放行层——不补则控制工具调用会被静态过滤静默丢弃，分流失效且测试假绿）与 **P3×3**；均为文字级
- **第三轮复审（2026-10-19 同日，设计稿 v3）**：Grok 按 §8.3 修订。§8.5 终审——N-P2 与 N-P3×3 **全部消解**，§8.1 P2-5 的作废→退出顺序微残余也已显式化；v3 新断言 `parseSseToolCalls` 静默丢弃行为**核实为真**（`packages/huaanwork-model/src/parse.ts:45/:82-86`）。无剩余 P1/P2。**结论：通过，可批准进入实施计划**

---

## 一、事实核查（§3「已核实的现状」11 行逐条）

| # | 设计声称 | 结果 | 出处 |
|---|---------|------|------|
| 1 | 发送要等 `whenIdle` 才返回 | ✅ | `huaanwork-host/sessions.ts:92`（`sendToAgent` 定义）、`:165`（`await agent.whenIdle?.()`） |
| 2 | 适配器已产出 `reasoning-delta`，单次请求上限 600 秒 | ✅ | `huaanwork-guardrails/model.ts:173`（delta）、`:31`（`REQUEST_TIMEOUT_MS = 600_000`）、`:197-198`（block-end 携完整文本，§8.1 的「块结束时发一次完整文本」有现成信号源） |
| 3 | 桥只把 `text-delta` 发成 `token`，reasoning 不到界面；辅助调用不发 | ✅ | `huaanwork-guardrails/bridge.ts:117`（仅 `purpose === undefined && text-delta`）、`:194-196`（`purposeOfOptions`，compaction/session-title 有 purpose 即被滤除） |
| 4 | 对话条目只有 user/assistant/tool/ask/note；`` 从正文剥掉 | ✅ | `client-huaanwork/App.tsx:133`（`ChatItem`）、`:1951`（`stripThinking`） |
| 5 | 历史投影只还原 assistant 文本 | ✅ | `logic/sessionChannel.ts:102-116`（`HistoryRecord` 的 user/assistant/tool-call/isError 四类，无 reasoning） |
| 6 | 计划模式、待办、目标工具、压缩在官方 `standard` 预设；Web 包把宿主行关掉 | ✅ | `deepseek-harness`（rc.1 pin，见 §二 #9）`packages/bundle/web-app/presets/standard.patch.yml:41-44/51-52/66-78/112-113`；`web-app/cordis.patch.yml` 关 `command-goal`(:520-521)、`tool-goal`(:523-524)、`plan-mode`(:526-527)、`compaction-basic`(:536-537)、`tool-result-pruner`(:542-543)、`tool-todo`(:573-574) |
| 7 | 目标服务和 `goal-round-driver` 已在宿主上，模型入口没有 | ✅（且**双入口都关**：`tool-goal` 与 `command-goal` 均被 web 补丁关闭——设计只提模型入口，保守方向正确） | `packages/bundle/base/cordis.patch.yml:323-327`（`goal` + `goal-round-driver` 行存在且未被 web 补丁关，补丁注释明示「service and session driver stay on the host plane…Presets own the human command and model-facing tool」） |
| 8 | `user-questions` 被华安锁关；没有回答者时提问会失败或到点放行 | ✅ | `profile.ts:1541`（disabled）、`huaanwork-host/row-assertions.ts:36`（disable 断言）；`dsh-user-questions` 解包实证：`askTimed` 的限时等待到期以业务错误结算（lib `:308-345`），模型收到超时即继续——「失败或到点放行」表述准确 |
| 9 | `jobs`、工作流、Ralph、官方联网、`hmr`、官方模型行保持锁 | ✅ | `profile.ts:1517`（llm-deepseek）、`:1531`（hmr）、`:1536`（tool-web）；`row-assertions.ts:25-26/33-35` |
| 10 | 文件和命令工具已启用、后台执行参数关闭 | ✅ | `profile.ts:1526-1527`（tool-fs/search）、`:1529-1530`（tool-pwsh/bash，`enableRunInBackground: false`） |
| 11 | 护栏档位 `ask`/`smart`/`full` 已决定工具是否要问 | ✅（§5.2 smart 档判据引用的「现有会询问集合」类别真实存在） | `policy.ts:62-67`；`git.ts:68/156`（git_push）、`git.ts:121` + `policy.ts:192-196`（git_checkout 脏树判据） |

**唯一未复核项**：§3 行 6 的「2026-10-12 工具面实测 `agentPreset` 恒为 `null`」——引用既有实测记录，本轮未重跑，采信。

## 二、机制断言核查（超出 §3、支撑后续章节的关键依赖）

| # | 断言 | 结果 | 出处 |
|---|-----|------|------|
| 1 | `exit_plan_mode` 依赖提问服务，无通道时 fail-closed（⇒ §4「先接提问、再开计划模式」的顺序论证） | ✅ | plan-mode README：「Without a user-questions channel, `exit_plan_mode` cannot run」；lib `:258`（no channel 抛错）；服务重载后 pending review 亦 fail-closed |
| 2 | `goal-round-driver` 在会话空闲后自动再跑一轮（⇒ §5.4「发送解耦完成前禁止挂 `tool-goal`」的顺序论证） | ✅ | driver lib `:85`（`state.agent.status === "idle" && !state.competingQueued` 门）、`:107`（quiescence 后预留至多一轮）。该顺序约束在 whenIdle 解析时序的两种可能下均安全，论证稳健 |
| 3 | 官方计划模式不关工具、仅靠文本约束（⇒ §5.2 计划卡固定说明的诚实性） | ✅ | plan-mode README：「restrains through text rather than filtering capabilities」；standard.patch.yml `:59` 同义 |
| 4 | `plan-review` 意图存在且可由华安自绘（§6） | ✅ | plan-mode lib `:35`（`REVIEW_ID = 'plan-review'`）、`:272`（intent 形状） |
| 5 | **`propose_plan` 与 `request_input` 存在于运行时** | ❌ **三处零命中**：① `vendor/dsh-runtime/0.2.1-rc.1/` 全部 tgz 逐一流式 grep——0 命中；② harness 子模组源码（pin = `1600d8a1e14` = `dsh-v0.2.1-rc.1`，`git submodule status` 核实）——0 命中；③ 华安包全量——0 命中。官方实际对应名：`exit_plan_mode`（plan-mode lib `:34`）、`ask_user_question`（user-questions `lib/types/tool-names.js:18`） | 见 P1-1 |
| 6 | 计划模式可程序化进入（「只加在 planned 请求上」可实现） | ✅ 机制存在但设计未点名 | plan-mode README：「Entry points other than the command may drive `ctx.planMode` directly」 |
| 7 | `/plan off` 手动逃生口在华安壳内可用 | ❌ **不可达**（复核中新发现，见 P2-5） | `commands` 服务在 base 补丁已组合（base cordis.patch.yml `:317-318`），但华安客户端 slash 只路由技能（`skillsLogic.ts:64` `RESERVED_SLASH = "schedule"` 仅保留自动化；`:100-106` `parseSlashInvoke` 硬调用技能），`huaanwork-host/` 对 "commands" 零引用（grep 0）——DSH 斜杠命令经 Web 客户端中介，华安壳没有这层中介 |
| 8 | `DSH_DESKTOP_ISOLATED_HOST=0` 同进程模式为开发路径 | ✅ | `main.ts:1652` |
| 9 | Host RPC 期限 120 秒 | ✅ | `host-process.ts:62`、`host-process-entry.ts:27` |
| 10 | 子模组 pin 即设计基线 rc.1 | ✅ | `git submodule status`：`1600d8a1e140… (dsh-v0.2.1-alpha.2-981-g1600d8a1e1)`，即 M9 目标 `dsh-v0.2.1-rc.1` |

## 三、一致性抽查（通过的项，记录在案）

- §2「不把思考过程复制到会话日志以外的新账本」与 §8.2 的 fallback（「写入现有会话记录能带回的字段」）不矛盾——写会话日志本身不是新账本。✅
- §4 步骤序（提问→计划）与 §5.2「提问服务没接上时不启用计划模式」与 §二 #1 的 fail-closed 实证三方一致。✅
- §5.4 续轮门（4 轮）与 §11 默认值 6 与 B19 三处数值一致；§7.1 的 5 分钟、§7.2 的 15/60 秒与 §11 默认值 5、B14/B16 一致。✅
- §8.1 第 1 路要求的「块结束时发一次完整文本」：model adapter 已在 `model.ts:197-198` 产出 block-end 全文，bridge 转发即可，无新造信号。✅
- B18 的「发送解耦未完成时续轮不会开始」：复核中曾怀疑 `command-goal`（/goal 命令）未关会提前触发续轮——**该怀疑已被证据排除**（web 补丁 `:520-521` 明示 `command-goal` disabled，且华安壳无命令中介，见 §二 #7），B18 在现状下成立。记录在案防止后续评审者重复踩坑。✅
- re-enabling 机制可行性：设计「在宿主平面重新启用」经 profile 行实现——profile 已有 `disabled: false` 行先例（`profile.ts:1708-1709`），层级叠加允许后置补丁重开被 bundle 补丁关掉的行；§9 落点行「profile.ts 按序启用 user-questions、plan-mode、tool-todo、结果裁剪、压缩、tool-goal」与 row-assertions 同步更新的要求（§9 正文）方向正确。✅

## 四、与原始需求对照

| 需求 | 覆盖 | 备注 |
|-----|------|------|
| R1 意图→分流→计划→执行→核对→结果 | 基本覆盖 | 四路分流 + 官方计划模式 + 待办仅展示进度 + **程序侧产物核对**（§5.3：文件真实存在且能打开、约定命令以退出结果为准、对不上列缺项；B12 钉住）。「做完」的定义（规格 `:17`）可证伪、不采信模型自称/勾选/idle 三种弱信号——直接回应了「确保计划正确完整执行」。**一个需用户确认的解读**：设计把「确保」落实为**结果核对**而非**过程一致性**（不逐步验证执行是否偏离计划），这是务实选择，但与原始需求的字面强度有差，批准时应确认接受该解读 |
| R2 思考过程、中文展示 | 覆盖良好 | 消费既有 reasoning 流不新造通道（§3 #2/#3 实证）；``/`<thinking>` 兜底；系统提示要求简体中文但**不翻译**（模型仍英文则照实显示）——诚实且不引入第二次模型调用；面板交互、历史恢复（B05 两路径）、复制边界（§8.3）完整 |
| R3 卡死/超时 | 覆盖良好 | 发送解耦治连接层超时（根因修复，B13）；三态状态不用假百分比；5 分钟醒目提示 + 取消（B14）；Host 探活 15s/60s + 结束进程（B16）；长输出裁剪 + 长会话压缩（B17）；诚实地保留 600 秒单请求上限、不打开后台任务绕期限 |

## 五、问题清单

### P1-1 分流器引用不存在的工具名，且落点表缺整个组件（第一轮意见：维持，证据加固）

§5.1（`:74`）：「只暴露无副作用的 `propose_plan` 和 `request_input`」。**两个名字在钉定运行时 0.2.1-rc.1、harness 源码、华安包内三处零命中**（§二 #5）。官方实际工具名是 `exit_plan_mode` 与 `ask_user_question`。留下二选一，规格必须言明：

- **(a) 华安自建这两个工具** ⇒ §9 落点表必须补「分流器/受约束生成」整行：工具 schema、注册面、与 policy 的交互、以及**「按请求裁剪工具目录」这一机制如何构造**——DSH 的工具目录是 profile 行级组装的，不是请求级的，现无任何按请求收窄工具目录的机制先例；验收须补格式兜底用例（见 P3-3）；
- **(b) 改用官方工具名** ⇒ 语义错位需写明映射：`exit_plan_mode` 是「计划写完请审」，不是「这是复杂任务」的分流信号；`ask_user_question` 承担 clarify 可行（依赖提问服务已按 §4 步骤 3 就位，顺序自洽）。

另 §5.1 句内自相矛盾：「**只**暴露无副作用的 propose_plan 和 request_input」与「模型调用普通工具就是 direct」不能同时成立——只暴露两工具的生成里模型调不到普通工具。需重写该句（一种自洽读法：生成中暴露普通工具 + 两个分流专用工具，普通工具调用仍过 policy——但那是「受约束」的另一定义，须写死）。

### P2-2 smart/full 档「展示后执行」的机制未选型（第一轮意见：维持，表述订正）

官方流程里计划经 `exit_plan_mode` → `plan-review` 提问审批后退出。第一轮评审称「没有免审批的旁路」——**订正：不准确**。plan-mode README 明示 `ctx.planMode` 可被非命令入口直接驱动（§二 #6），程序化直驱退出是官方存在的路径。⇒ smart/full 档「展示后执行」有两条可行机制：**华安 answerer 按 guard_mode 自动批准 plan-review**，或**展示后由宿主代码直驱 `ctx.planMode` 退出**。设计必须选定其一，并写明与 §6 两条规则（「没有回答者时不得静默放行」「过期或已结束的提问不能沿用上一次的批准」）的交互方式。

### P2-3 两路思考去重无算法（第一轮意见：维持）

§8.1（`:163`）「第 2 路只用于补第 1 路没有覆盖的片段」——「覆盖」未定义，B03「同一段文字只出现一次」因此不可确定性测试。建议二选一：① 第 1 路（reasoning 流）本回合有任何产出即**整体抑制**第 2 路（最简、可测）；② 定义「覆盖」为精确子串包含（可测但脆）。现文实现时会退化为模糊匹配。

### P2-4 Host 探活信号未定义，结束进程的附带伤害未覆盖（第一轮意见：维持）

- §7.2（`:142`）「连续约 15 秒没有响应」——「响应」是什么未定义：进程存活 ≠ 响应能力；RPC ping、日志心跳、还是复用某条既有心跳，须定一个。
- B15 只钉「取消不伤其他会话」；**结束进程**天然命中同一 Host 上全部会话的在飞回合，B16 未覆盖跨会话附带伤害，也未要求确认界面写明影响面（「将终止 N 个会话的在飞任务」）。

### P2-5 计划模式逃生口缺口（**复核新增**，由第一轮 P3 备注升格，证据坐实）

§二 #7：`commands` 服务虽在 base 补丁组合，但华安壳没有 DSH 斜杠命令中介——客户端 slash 只路由技能（`skillsLogic.ts:64/:100-106`），宿主从不调用 commands 服务。⇒ 按设计重新启用 plan-mode 后：

- 官方手动逃生 `/plan off`（README：「after a service reload while the review is pending, the call fails closed and **`/plan off` remains the manual escape**」）**在华安壳内不可达**；
- 若回答者通道失联（answerer 异常、服务重载），模型停在计划状态，用户在界面上**无任何手段退出**。

设计 §5.2 必须补：常备 UI「退出计划模式」入口（经 `ctx.planMode` 直驱——官方明示允许的入口），并在 B 表补对应验收（计划卡失联逃生）。进入侧同理：应写明进入用 `ctx.planMode` 直驱而非 `/plan` 命令。

### P3（登记为实施期开口项，随批准一并确认）

1. **§9 落点表除 P1-1 的分流器行外**，「中文思考提示」具体注入缝未点名：§9 已包干给 guardrails（「huaanwork-guardrails 内新的短提示注册」），但经 system message 注入还是 prompt-section 服务须定；plan-mode 的 guidance 段占 first-party order 500 起（README `:147`），华安段与官方段的顺序需协调，避免与本规格的稳定性声明（「不随每个 token 变化」）冲突。
2. **§5.3 程序侧核对的重跑命令**：谁执行、过不过现有护栏、受不受执行器期限，未写。核对用重跑若本身是写操作，直接撞上「确认计划不等于批准被 policy 拒绝的调用」（§5.2 末行）的边界，须写明。
3. **验收缺项**：§5.1「格式错误只修一次→『没能理解这个请求』」兜底、§6「继续改计划」分支、§8.3 取消后思考保留并标「已中断」——三者均无 B 项；P2-5 逃生口亦需 B 项。
4. **分流延迟姿态未声明**：若分流是独立前置调用，每个简单请求 +1 次模型往返；§5.1「和第一个动作同一次受约束生成」的意图正是避免它，但机制未落地（回到 P1-1）。建议规格写明:步骤 4 落地前的过渡行为（现状 = 无分流直发）与分流失败时的降级路径。
5. **变体守卫流程注**：§9 落点含 `main.ts` 与 `host-process.ts`——两文件均已在 beta↔huaanwork `allowedDifferences` 内（`main.ts` 属既有名单、`host-process.ts` 属 M9 新登记 40 项名单），**无新增名额成本**；但按仓规提交前须跑 `corepack yarn check:desktop-variants`，§9 未提，补一句即可。其余落点（`client-huaanwork/`、`huaanwork-guardrails/`、`huaanwork-host/`）全部落在 oneSidedPrefixes 覆盖面内，无守卫成本。

## 六、第一轮意见的复核处置汇总

| 第一轮意见 | 处置 | 说明 |
|-----------|------|------|
| P1 分流器工具名不存在 + 落点缺行 | **维持，证据加固** | 零命中从单点扫描扩为三处（tgz 流式/子模组源码/华安包） |
| P2 smart/full 批准机制未写 | **维持，表述订正** | 「没有免审批旁路」不准确——`ctx.planMode` 直驱是官方路径，机制选型二选一须写死 |
| P2 去重无算法 | 维持 | — |
| P2 探活信号未定义 + 杀进程附带伤害 | 维持 | — |
| P3 落点缺行/注入缝/核对细节/验收缺项/延迟姿态 | 维持 | 全部经复核成立 |
| P3「/plan off 逃生口需确认」备注 | **升格为 P2-5** | 复核中取到硬证据：commands 服务已组合但华安壳无中介（`skillsLogic.ts:64/:100-106`、host 零引用） |
| （复核中产生又排除）`command-goal` 未关会破坏 B18 | **撤回，记录在案** | web 补丁 `:520-521` 明示 disabled；B18 在现状下成立 |

## 七、批准条件与建议

1. **P1-1 必须在批准前裁定**（自建工具并补落点行 + 验收，或改官方名并写映射）；这是 R1 的核心机制，不可带歧义进入实施计划。
2. **P2-2/P2-3/P2-5 建议随批准一并修订**——均为文字级（选型一句话、去重规则一句话、逃生口一段 + 一个 B 项），不动规格方向。
3. P2-4 可拆两半：探活信号定义随 §7.2 修订；杀进程跨会话确认并入 B16 场景描述。
4. P3×5 登记为实施期开口项，实施计划（下一步产物）逐条承接。
5. 骨架性肯定：§3 事实基础 11/11 成立（本轮全部复核）、两条顺序依赖论证经独立验证成立、§2 不做清单诚实、B16 的 Windows 未验证不冒充全平台、B20 锁回归——这版的强项值得在实施计划里保持。

---

**评审方法附注**：本评审全部断言的验证命令可复现——`mapTokens`/`sendToAgent`/`readModelStream` 等经源码 grep；三个官方包经 `tar -xzf vendor/dsh-runtime/0.2.1-rc.1/deepseek-ai-{dsh-plan-mode,dsh-user-questions,dsh-goal-round-driver}-*.tgz` 解包验读；工具名扫描经 `for f in *.tgz; do tar -xzOf "$f" | grep -l …; done` 流式全量；补丁文件行号经 `sed -n` 定位读段。子模组 pin 经 `git submodule status` 确认为 rc.1（`1600d8a1e14`）。

## 八、修订复审（2026-10-19 第二轮，设计稿 v2）

对 Grok 按本文修订后的设计稿逐条复审。三处「未采纳」均核实其理由成立；修订引入的新断言逐条核实；另发现新 P2×1、P3×3。

### 8.1 修订响应与处置

| 原意见 | 修订动作 | 复审判定 |
|-------|---------|---------|
| P1-1 分流器工具名不存在 + 落点缺行 | **选路线 (a)**：华安自建 `propose_plan`/`request_input`；§9 补「分流工具」行；补 B21 格式兜底；明确拒绝路线 (b)（不改用 `exit_plan_mode`/`ask_user_question` 充当分流信号）；新判定表补混合响应规则（控制工具优先、普通工具不执行） | **已消解**。路线 (a) 可行性核实：华安已有自建工具的**生产先例**——`call_host_tool` 经 `huaanwork-host/index.ts:141-161` 的 `ctx.plugin({inject:['tools']})` + `agent-tool.ts:135` `registerCallHostTool` 全局注册。修订还正确识别了 present-as 白名单是**必要集成**（见 §8.2 #3）。**残余**：① 控制工具 schema 未定义；② 漏第三层放行（见 **N-P2**） |
| P2-2 smart/full 批准机制未选型 | 选 **answerer 自动同意**（「按当前护栏自动继续」标签 + 不补记点击 + 不替代工具级审批）；**明确拒绝**「工具仍在等待时直驱 ctx.planMode」（理由：`exit_plan_mode` 会停住） | **已消解，拒绝理由成立**——plan-mode README「after a service reload while the review is pending, the call fails closed」：评审未结算而模式被外力改变 ⇒ 工具停等。与原文一致。残余见 N-P3-2 |
| P2-3 去重无算法 | 采纳建议方案①：reasoning 流非空则整段不用第 2 路；B03 改写为可判定的「面板只含 reasoning」 | **已消解** |
| P2-4 探活信号未定义 + 杀进程附带伤害 | 探活 = 独立短超时 IPC、Host 主事件循环 2 秒应答；明示三种假信号不算应答（进程在/端口开/stderr 有输出）；**明示不用空闲线程代发心跳**；结束前写明将终止的会话数；B16 更新 | **已消解**。「不用空闲线程」把「线程活着但主循环卡死」的假阳性也钉死了 |
| P2-5 计划模式逃生口缺口 | 常备「退出计划模式」（作废未回答的 `plan-review` + `ctx.planMode` 置退出）；B24；把 slash 不可达写进 §5.2 正文 | **已消解**。微残余：**作废→退出的先后**是隐含的（须先作废使 `exit_plan_mode` 拿到结算、再置退出——否则撞 P2-2 修订自己写的「否则会停住」），实施计划应写明顺序 |
| P3-1 提示注入缝未点名 | 点名 `ctx.systemPrompt.section`，order 不占 `PLAN_POLICY`(500)，官方段空↔文时华安段逐字不变 | **核实为真**，见 §8.2 #1/#2 |
| P3-2 核对重跑的执行细节 | **未采纳重跑读法**：改为只读回合内已返回的工具退出结果，程序不另起命令，没有即缺项 | **拒绝合理**——「谁执行/过不过护栏/受不受期限」三问整体消失，且更诚实。**代价须写进批准认知**：核对强度从「程序复验」降为「读侧比对」，模型可用形似命令制造退出码 0 的假证据；ask 档有人工点击兜底，smart/full 档接受此弱点（与「待办不是完成证据」的既有基线一致，可接受但应知情） |
| P3-3 验收缺项 | B21（格式兜底）/B22（继续改计划）/B23（思考已中断）/B24（逃生口）全部补齐 | **已消解**。残余见 N-P3-2 |
| P3-4 分流延迟姿态 + 过渡行为 | 「不为简单请求再前置一轮分类调用」（§5.1）+ 第 4 步前无分流的过渡行为（§5.1 末段） | **已消解** |
| P3-5 变体守卫注 | §9 补「已在允许差异里、不新增名额、提交前跑 check:desktop-variants」 | **已消解**，与本文 §五 P3-5 的事实核对一致 |
| §四 R1 解读待确认 | 「本轮不逐步证明执行没有偏离计划原文」显式写进 §1「做完」定义 | **已消解**——解读显式化，批准时确认即可 |

### 8.2 修订新断言核实

| # | 新断言 | 结果 | 出处 |
|---|-------|------|------|
| 1 | `ctx.systemPrompt.section` 注册 API 存在 | ✅ | `packages/core/system-prompt/src/index.ts`（`PromptSection`：name/order/text，重名注册抛错）；plan-mode 实际用法 `lib/index.js:170-177`：`ctx.systemPrompt.section({name:"plan:policy", order:getSectionOrder("PLAN_POLICY"), text: active?计划文:""})` |
| 2 | 官方 `PLAN_POLICY` 占 500 | ✅ | 同上 `:134`（`PLAN_POLICY: 500`，集中分配的段序位常量表）。「华安段逐字不变、官方段空↔文」与官方机制逐字吻合 |
| 3 | present-as 白名单必要性 | ✅ **必要且修订识别正确** | `present-as.ts:10-32` 的 `ALLOWED_TOOLS` 是华安自己的**工具允许清单限制器**（`tools.restrict({allow})`，`:120-127`）：新工具不加白名单就会被华安自己的 restrictor 从目录剥掉，模型根本看不到 |
| 4 | 华安可注册自建模型可见工具 | ✅ 有生产先例 | `call_host_tool`：`huaanwork-host/index.ts:141-161`（`ctx.plugin({inject:['tools']})` + `registerCallHostTool`，含目录变更重注册模式） |
| 5 | 分流工具只需过 present-as 白名单 | ❌ **漏一层**（见 N-P2） | `model.ts:49-55` `isRegisteredToolName`：dsh-base 静态白名单之外的工具名若不加入该谓词，模型的原生调用经**静态过滤静默丢弃**——`model.ts:45-46` 注释原话「静态过滤会把模型的这类原生调用静默丢弃，回合『正常结束但任务没做』」 |

### 8.3 复审新发现

**N-P2（P2，一句话可修）**：§9「分流工具」行只写了注册 + present-as 白名单 + 执行前消费，**漏了 `model.ts` 的 `isRegisteredToolName` 放行谓词层**（`model.ts:49-55`，`call_host_tool`/`web_fetch`/`screenshot`/`mcp__*` 都在此逐名放行）。不补这层：模型发出的 `propose_plan`/`request_input` 调用被静态过滤丢弃，分流退化为「模型正文即 answer」——**所有分流 B 项（B07–B11、B21）可能假绿**（answer 路径恰好仍成立，planned/clarify/direct 判定全部失灵）。修法：§9 分流工具行补「并加入 `model.ts` `isRegisteredToolName` 放行」。这正是本评审 §8.2 #4 先例的完整纵深（注册面 × present-as 可见性 × model 放行 × policy 执行门，四层华安已有一套，分流工具须全部走一遍）。

**N-P3-1**：控制工具 schema 未定义。`request_input` 至少有「问题文本」参数（§5.1 判定表可推）；`propose_plan` 的参数形状完全未说——是否携带计划草稿决定计划模式进入后模型是复用还是重写，实施计划须定义。

**N-P3-2**：两个新规则无验收钉：① 混合响应规则（§5.1 判定表末行「控制工具优先、普通工具不执行」）无 B 项；② smart 良性/full 档「按当前护栏自动继续」标签（§5.2）无 B 项。均一句话可补。

**N-P3-3**：`request_input` 的回答回路未写——用户答完，答案是经工具结果回填模型续跑，还是回合结束、等下一条用户消息？两种实现都能过 B11，但交互形态与测试口径不同，实施前须选定。

### 8.4 复审结论

**通过（附小修）**。P1 已消解且所选路线经生产先例核实可行；四处「未采纳/拒绝」（路线 (b)、ctx.planMode 直驱、核对重跑、目录裁剪机制）均给出理由且经本复审核实成立，属合理取舍而非回避。剩余问题 = N-P2（必改，一句话）+ N-P3×3（实施计划承接），全部文字级。**N-P2 补进设计稿后即可批准进入实施计划**；N-P3 三项建议随小修一并落（schema 与回路各一段，B 项两条），也可登记为实施计划开口项。

### 8.5 第三轮复审（设计稿 v3 终审，2026-10-19）

对 Grok 按 §8.3 修订的 v3 逐条复审。

| 复审项 | v3 修订动作 | 终审判定 |
|-------|------------|---------|
| N-P2 model.ts 放行层 | §5.1 补「两道已有的名字门」：`present-as` 的 `ALLOWED_TOOLS` + `model.ts` 的 `isRegisteredToolName`，并写明漏掉后的失效形态；§9 分流工具行同步纳入 `model.ts` | **消解**。新断言核实：`parseSseToolCalls` 真实存在且未过 `isRegisteredToolName` 的调用名在聚合后被**静默丢弃**（`packages/huaanwork-model/src/parse.ts:45` 函数、`:82-86` `knownToolCall(name, …, filter)` 过滤语义；`model.ts:130` 以 `isRegisteredToolName` 为谓词消费）——设计稿描述的「回合变成一段正文，分流不会发生」与代码逐字吻合 |
| N-P3-1 控制工具 schema | §5.1 新参数表：`propose_plan` = `objective`（必填非空，一句话目标，**不放计划正文**）；`request_input` = `question`（必填非空，只问一个问题）；「多出来的字段视为无法解析」；§11 #8 同步 | **消解**。设计选择合理：计划正文留到计划模式内经 `exit_plan_mode` 呈现，与官方流程（进入→引导段→写计划→exit 呈审）一致 |
| N-P3-2 两个规则无验收钉 | B25（混合响应：控制工具优先、`read`/`bash` 不执行）、B26（smart 良性 / full 无目标变化：「按当前护栏自动继续」标签、不为计划点击、工具级审批仍在）；§10 通过口径更新为 B01–B17 与 B21–B26 | **消解** |
| N-P3-3 request_input 回答回路 | 选定**工具结果回填**：「答案作为这次工具的结果回到同一回合，模型接着做。这不是一条新的用户消息，也不再走一次分流。用户取消则工具失败，回合停止」；B11 与 §11 #8 三处一致 | **消解**。与 §7.1 的三态等待提示 + 取消兼容（长等待会被「已 N 秒没有新结果」覆盖，取消即「工具失败，回合停止」）；等待无独立超时是产品选择，可接受 |
| §8.1 P2-5 微残余（作废→退出顺序） | §5.2 显式化：「**先**把尚未回答的 `plan-review` 作废，让等待中的 `exit_plan_mode` 得到拒绝结算，**再**把 `ctx.planMode` 设为退出」 | **消解**——先结算再退出，与 P2-2 修订的「否则会停住」自洽 |

**v3 新断言核实**：`parseSseToolCalls`（含静默丢弃语义）✅ `packages/huaanwork-model/src/parse.ts:45/:82-86`，消费点 `model.ts:130`。无其他新增事实断言。

**无新增问题**。v3 未引入新的事实断言错误；四处修订位置（§5.1 参数表/判定表、§5.2 逃生口、§9 落点行、B11/B25/B26、§11 #8）与本文全部先前核实结果无冲突。

**终审结论：通过**。三轮累计：第一轮 P1×1/P2×4/P3×5 → 第二轮复审 N-P2×1/N-P3×3 → 第三轮全部消解且新断言核实为真。设计稿可按现状批准进入实施计划；实施计划承接的非阻塞开口项：① 控制工具的 JSON Schema 细节；② `request_input` 等待与 §7.1 三态/取消的实现级衔接（等待无独立超时为既定产品选择）；③ §8.2 已核实的四层名字/执行纵深（注册 × present-as × model 放行 × 消费）按 §9 落点行逐层落测试。

## 九、实施计划评审（2026-10-19，`docs/superpowers/plans/2026-10-19-conversation-capabilities.md`）

- **评审方式**：计划全部可验证断言背靠背核实（源码 grep、vendored tgz 解包、补丁文件定位）；重点核查纯函数任务的**调用方是否存在**（任务完整性）与 TDD 用例是否会假绿。
- **结论**：**不通过，P1×2 修订后复审**。TDD 结构、每任务一提交、锁回归任务可取；关键机制断言大部分核实为真（含复挂钉先例与组合级断言能力）。致命伤：R1 运行时接线无主人 + Task 5 破坏 @ 生产路径。

### 9.1 核实为真的断言

| 断言 | 出处 |
| --- | --- |
| `sendToAgent` 返回 `{ queued: true, sessionId }`、经 `agent.followup` 发送、`await whenIdle` 在 :165 | sessions.ts:96/:159/:165/:170 ✓ |
| `cancelAgent` 现状取消所有非 primary agent | sessions.ts:219-223 ✓ |
| goal 三断言：`defaultMaxGoalRounds` 字段真实、缺省 256、请求值覆盖缺省 | dsh-goal types/index.js:166-169/:217/:224 ✓（模型面参数名实为 `max_goal_rounds`，tool-goal lib:295） |
| **复挂钉先例**：profile 行可翻回 web-app overlay 关闭的行（tool-fs 于 web patch:496-497 disabled，组合结果已启用）；profile.spec.ts:1289-1294 断言组合结果 ⇒ Tasks 11-15 的 profile 重启用机制有生产先例 + 组合级测试能力 | ✓ |
| profile.spec.ts:1271-1283 关闭清单存在（user-questions 在 :1280）；HistoryRecord 有 time 字段四 kind（sessionChannel.ts:85-89）；bridge emit/RpcEvent 机制（bridge.ts:7/:118/:179-180） | ✓ |
| HostRpc `handle`/`call(per-call timeout)` 支撑 2 秒探活 | host-rpc.ts:19/:24 ✓ |

### 9.2 P1-1：R1 运行时接线整体缺失

计划产出一批纯函数但没有任何任务把它们接进运行时：**(a)** 控制工具注册（schema + execute handler；先例 `huaanwork-host/index.ts:141-161` + `registerCallHostTool`）无任务——模型看不到工具就不会调用，Task 9 的两道名字门空转；**(b)** `classifyToolCalls` 无调用方——invalid 重修、混合响应压制（B25）、clarify 挂起、planned→planMode 的消费点无任务，Task 12 也不含设计 §9 指定的 sessions.ts 调用点；**(c)** answerer 注册进 user-questions 瀑布（uq lib:552/:679 无 answerer 即 NO_PROVIDER）无任务——不注册则 `exit_plan_mode` fail closed，B09/B10/B22/B24 全挂；**(d)** outcomeCheck 的输入提取无任务，且现有 tool-result 记录无 command/exitCode 字段（session-view.ts:226-232）；**(e)** B05 历史恢复选了没有机制的 fallback 路（bridge 只有 `huaanworkEmit` 实时事件，无日志写入 API），又跳过设计 §8.2 规定的「先核对日志有没有 reasoning 块」——实际有（session-view.ts:190-198 只取 text 块、reasoning 块被静默丢弃），**正解 = 扩展 session-view 提取 reasoning 块为主路**。修法：补「分流工具注册与消费接线」「answerer 注册」「session-view reasoning 投影」「outcome 输入提取」任务。

### 9.3 P1-2：Task 5 破坏 @ 小工具生产路径（假绿）

`afterIdle`（agent-invoke.ts:97-101）是 @ 调度 attachHostTool/detachHostTool 的生命周期钩子，「回合结束后解绑」靠 `await agent.whenIdle?.()`（sessions.ts:165）保证。按 Task 5「删 :165、followup 后执行既有 cleanup」会把 detach 提前到回合运行中 ⇒ `call_host_tool` unattached ⇒ policy deny ⇒ **@ 链路断裂**。Task 5 测试只走纯文本路径（无 afterIdle）——测试通过、生产断裂。修法：detach 改为 `agent.whenIdle?.().then(cleanup)` 挂起注册（不 await）或挂 session/end；补 @ 发送的解耦测试。

### 9.4 P2（3 项）

1. `ctx.planMode.set({ active: true })` API 形状错误——plan-mode 服务方法为 `set(agent, active)`（lib:367/:215），需 agent 引用；该调用无任何测试覆盖。
2. Task 1 `extractThinkBlocks` 相对现有 `stripThinking`（App.tsx:2593-2597 含未闭合尾随标签处理 `holdIncompleteThinkTag`）是回归——流式期间半截 `` 会泄漏进气泡（B01 中间态破功）且不进面板；须移植未闭合规则并把未闭合段抽进 thought。
3. Task 7 `parentSessionId` 只加类型没有来源——`ListedAgent`（sessions.ts:227-241）无此字段，无任务在 `subagents.start` 登记父会话；需父-子登记表否则 B15 的子代理取消无从实现。

### 9.5 P3（随修订一并处理）

① Task 6 `turnStatus` 状态三偏离设计（`thinking` 闩锁布尔使 reasoning 停流后仍显示「正在思考」至 5 分钟；设计要求「无新增量」即切「已 N 秒」）；② Task 12 smart 档 `changesTarget` 严于设计，须回写设计稿避免 B26 口径漂移；③ Task 16 真机清单缺 B06/B07/B08/B11/B17/B19/B21/B25，分流纯逻辑单测证明不了真模型行为，B07/B08/B11/B21 必须真机；④ Task 15 拦截参数名应为 `max_goal_rounds`；⑤ Task 10「执行侧」散文依赖 Task 11 的卡片机制，顺序上不可在 Task 10 落地（P1-1 修复后自然解决）；⑥ 设计 §4 验收口径与 Task 16 核对清单之间需「哪些 B 以单测为准、哪些必须真机」对照表。

### 9.6 计划 v2 复审（2026-10-19 第二轮，Grok 按 §9.2–§9.5 修订后）

**结论：有条件通过——P1-1 剩余一处补齐后即可执行。**

**消解确认**：P1-2（Task 5）完全消解——测试两段断言（50ms 返回 + idle 前 `detached === false`）、实现 `void agent.whenIdle?.().then(() => cleanup())`、finally 统一登记 ✓。P1-1 大部消解：Task 10b 用真实 API 注册工具（`defineTool`/`tools.register` 核实于 agent-tool.ts:129/:134）、Task 11 用真实瀑布事件挂回答者（`user-questions/request` 核实于 uq lib:681）、Task 3 按本文处方改为 session-view 主路（`detailRecords` 核实于 session-view.ts:174）✓。P2-2 完全消解（`holdIncompleteThinkTag` 移植 + 未闭合段进面板）✓。P2-3 完全消解（`child-sessions.ts` 登记表；「现有 subagent/start 监听」核实于 skills.ts:180、parent 解析核实于 agent-invoke.ts:179-183）✓。P2-1 形状已订正（`set(agent, active)`）✓。P3：turnStatus 语义已修（新微瑕见下）、smart 档已对齐设计（改计划不改设计，方向正确）、`max_goal_rounds` 已订正、单测/真机对照表已建 ✓。`huaanwork-model`/`huaanwork-present-as` insert 行核实于 profile.spec.ts:1298-1307 ✓。

**P1-1 剩余（唯一必改项）——Task 10b 的消费机制仍是散文**，四点无文件归属：
1. **混合响应压制无机制**：真实注册后 agent loop 按序执行整批，`read`（index 0）先于 `propose_plan` 执行，execute 层压不住兄弟调用。处方（经核实可行）：批次出口在 `finishModelStream`（model.ts:129-141）——`parseSseToolCalls` 之后、`emitToolCalls` 之前过滤，有控制工具时只保留控制调用；B25 在此落单测。
2. **`ctx.planMode.set(agent, true)` 无调用点归属**：Task 12 的 Files 全是渲染器/纯逻辑，planMode 是宿主侧服务。处方：写进 route-tool-plugin.ts 的 `propose_plan` execute（holder 模式取当前会话 agent，与 `call_host_tool` 读 `huaanworkAgentCatalog` holder 同构），补 execute→set 测试。
3. **clarify 双通道归属未写明**：Task 10b 说「等 Task 11 的回答者把答案写回 request_input」，但 Task 11 的回答者挂官方瀑布（服务 `ask_user_question`/`plan-review`），不经过 request_input 的 execute。须写明：request_input 等待 = 自有 execute 挂起；官方瀑布只服务 plan-review/ask_user_question。
4. **invalid 重修无机制**：execute 返回 isError 纠错文案→模型重发；每回合计数（holder）第二次→note「没能理解」+结束回合。B21 真机核对依赖它。

**新微瑕（P3）**：① Task 6 `quietMs === 0` 严格相等会在活跃流式期间抖动（增量间任意 tick quietMs>0 即闪「已 1 秒」），改短宽限窗（如 <2000ms 视为思考中）；② Task 16 对照表自相矛盾——注记说 B21 不能只用单测，真机列却无 B21，补一行。

### 9.7 计划 v3 终审（2026-10-19 第三轮）

**结论：差一行。P1 新发现一处（present-as 剥离面）补齐后即可开工。**

**§9.6 四点全部按处方落地** ✓：`preferControlCalls` 落 `finishModelStream` 两条 `emitToolCalls` 之前（SSE+文本协议，文本协议为 Grok 自补）；planMode 驱动归属 route-tool-plugin 的 `propose_plan` execute（holder 取 agent，无 agent 返工具错误，有测试），Task 12 明确渲染器不调 `set`；clarify 双通道两侧写死；invalid 经 `noteInvalidRoute` 按会话计数、第二次 note+取消、合法后清零，有测试。两个一行修落地 ✓：`THINKING_GRACE_MS = 2000`（边界钉死 1500/2000）；B21 进真机列且真机口径精确化。

**P1（新发现）——present-as 的 `ALLOWED_TOOLS` 剥离官方新启用插件的模型工具**：`present-as.ts:10-32` 实测名单无 `exit_plan_mode`、无 `get_goal`/`create_goal`/`update_goal`（tool-goal lib:265/:276/:302 经 `defineTool`+`ctx.tools.register` 注册），而限制器在 `tools/change` 重跑 `restrictAll()`（present-as.ts:181）。⇒ Task 12 后 `exit_plan_mode` 一注册即被剥离，模型看不到 ⇒ B09/B10/B22/B26 不可达；Task 15 后三个 goal 工具同理 ⇒ B19 不可达；且全部静默（profile.spec 行断言/组合断言/planNeedsConfirm 单测全绿，到 Task 16 桌面核对才暴露且难归因）。计划 Task 9 只给两个自建工具加白名单，漏官方三件套。修法：Task 12 加 `exit_plan_mode`、Task 15 加三个 goal 工具名（或 Task 9 一次加齐）进 `ALLOWED_TOOLS` + present-as.cordis.spec 断言；写明 `ask_user_question` 不加入是有意的。修法与上游意图一致（plan-mode README：exit 工具常驻目录、模式切换不动工具目录）。**责任归属诚实记录**：此洞源自设计稿 v3（§9 落点行只写两个自建工具进白名单），本文设计评审三轮亦未抓到——复挂钉先例验证了行重启用机制，但未检查新启用插件的工具能否存活 restrict 层；四层纵深框架第二轮已提出，但仅对自建工具点名。

**P3（随 P1 一并小修）**：① Task 10b Files 缺两处归属——`huaanworkRouteAgent` holder 写入方（prose「宿主在 followup 之前」，应为 sessions.ts，不在 Files 列表）与 invalid 第二次 note 发出方（prose「由 bridge 发」但 bridge.ts 不在该任务 Files；建议 route-tool-plugin 经 `ctx.huaanworkEmit` 自发）；② Task 16 Step 3 变体守卫语句语序混乱（默认动作安全，建议重写为一句明确规则）。

**判定**：P1 一行补齐 + P3 两条小修后达实施标准。除该处外，v3 在事实精度、接线归属、反假绿测试设计（Task 5 @ 双段断言、B21 真机口径、Task 15 前后置组合断言）上已达到本仓实施计划标准。

### 9.8 计划 v4 终审通过（2026-10-19 第四轮）

Grok 按清单补完，逐项复核：**P1 消解**——Task 12 把 `exit_plan_mode`、Task 15 把 `get_goal`/`create_goal`/`update_goal` 同时加入 `ALLOWED_TOOLS` 与 `isRegisteredToolName` 两道门并附 `present-as.cordis.spec` 断言（含机制说明「`tools/change` 上 `restrictAll` 剥掉」）；Task 9 写明前四个名字的**延后归属**（「随启用它们的任务再加」）与 `ask_user_question` 有意不加入（Task 12 重申「澄清继续走 request_input」）；Task 15 的 `todo_write` 防重复提醒经核实准确（present-as.ts:22 白名单 ✓、`packages/huaanwork-model/src/parse.ts:18` KNOWN_TOOL_NAMES ✓）。**P3×2 消解**——Task 10b Files 补 sessions.ts（`followup` 前写 `huaanworkRouteAgent.current`）；invalid 第二次的 note 改由 route-tool-plugin 经 `ctx.huaanworkEmit` 自发并明令「不要交给 bridge.ts」；Task 16 Step 3 重写为清晰三句规则（只改 main.ts/host-process.ts 应通过；其他文件失败停下报告，不扩白名单）。结构完整（17 任务无截断）；本轮新增内容全部引用已核实机制，无新未验断言。

**终审结论：通过。实施计划达到实施标准，可按 subagent-driven-development 流程开工。** 执行期如遇与本评审事实基础冲突的现场发现（API 形状、行号漂移），按计划自身的「行号以符号名为准」原则处理并在任务内记录。
