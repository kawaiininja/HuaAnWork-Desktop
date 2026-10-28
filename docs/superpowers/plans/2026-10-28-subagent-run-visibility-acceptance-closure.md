# 子代理运行卡验收收口执行清单（2026-10-28）

> 状态：可执行草案；T4 的五条 owner 裁定已落实（2026-10-28），其余任务未开始执行。
> 分支：`refactor/huaanwork-single-desktop`；基线 `5f22809122`；Harness pin `1600d8a1e140dcde43a1a0941940a0480712c011`。
> 依据：设计 §10.1、`docs/evidence/2026-10-26-subagent-run-visibility-verification.md`〈验收判定订正（2026-10-28）〉与〈验收裁定（2026-10-28，owner）〉。
> 目标：把 A–D 的 14 个未通过项收口到 PASS，并保持 E-01～E-05 已通过、E-06 如实记录；只有满足 §10.1 的「A–D 全部通过、E-01～E-05 通过」才勾选复选框。

## 1. 现状

- 49 项：**45 PASS（含 R-ACC-1/2/3 的自动化充分裁定）、1 部分（E-06）、3 豁免（A-11、A-16、C-08）、0 Blocked**。
- A–D 条目已全部 PASS 或经 owner 豁免；**E-06 是平台证据诚实项**，Windows 按 R-ACC-8 待 GitHub 虚拟机验收，真实内网目录仍未验证。
- **E-01～E-05 已全部 PASS**；E-05 的五个子项（多 tab、同名并发、父 idle、WS 重连、清理未确认）均已有真机证据。
- **豁免不等于 PASS**：A-11/A-16（R-ACC-6）、C-08（R-ACC-7）只表示 owner 接受残余风险，§10.1 复选框对豁免项仍不勾选；整体状态记为 **complete with waiver**。
- 现有验收钩子：`HUAANWORK_ACCEPTANCE_HOOKS=1` 总开关，已支持 cleanup timeout、dispose failure、finalizing/end hold、package delay、工具注入、终态原因、工具失败与额外告警；默认惰性，不属产品配置。
- 本清单只处理剩余项，不重做已完成项，不新增产品功能。

## 1.1 执行状态（2026-10-28）

- **T0 文档订正**：完成。
- **T4 裁定**：完成（R-ACC-1～R-ACC-5）。
- **T1/T2 钩子实现**：完成。新增 `HOLD_FINALIZING` / `HOLD_END` / `PACKAGE_DELAY` / `INJECT_TOOL_NAME` / `TERMINAL_REASON` / `TOOL_FAILURE` / `EXTRA_WARNINGS` 七组环境变量，默认惰性，`acceptance-hooks.spec.ts` 8 条回归钉通过。
- **T1/T2 真机场景**：**已完成 14 项**（T1.1、T1.2、T1.3、T1.4、T1.6、T1.8、T1.9、T2.1、T2.2），证据见 `.superpowers/acceptance-closure/logs/`；**T1.5 读屏与 T1.7 全局 200 已由 owner 豁免**（R-ACC-6/R-ACC-7，非 PASS）。
- **T3.1 D-03**：完成证据边界说明（外层鉴权拒绝 ≠ 路由级 origin 拒绝；以 `routes.spec.ts:314` 为证据）。
- **T3.2 真实内网目录**：仍未验证；**T3.3 Windows**：按 R-ACC-8 改在 GitHub 虚拟机验收，当前未执行。
- **T5 门禁**：`typecheck`、huaanwork `test`（3542/14）、`check:desktop-variants`（11/11）、`check`（hdiutil flake 后整条重跑 exit 0）均通过。

详细执行记录见 `docs/evidence/2026-10-26-subagent-run-visibility-verification.md`〈验收收口执行记录（2026-10-28）〉、〈验收收口场景执行结果（2026-10-28）〉与〈验收豁免与 Windows 验收路径（2026-10-28，owner）〉。

## 2. 剩余项与收口路线

| 条目 | 现状 | 路线 | 预计 |
| --- | --- | --- | --- |
| A-03 finalizing 文案 | 部分 | T1.1 钩子保持 finalizing 窗口 | 0.5d |
| A-14 文案与提醒 | 部分 | T1.1 finalizing + T1.9 其余子项 | 1.5d |
| A-05 终态映射诚实 | 部分 | T1.2 max-tokens/refusal + T1.9 unknown/单工具失败 | 1d |
| A-07 5 分钟提醒 | 部分 | T1.3 真实长静默子运行 | 0.5d + 5min 等待 |
| A-04 并发工具 | 部分 | T1.4 并发工具注入/夹具 | 1d |
| A-12 视觉层级与工具展示 | 部分 | T1.4 并发工具前 2 + `+N` 与展开 | 与 A-04 同批 |
| A-11 真实读屏 | 豁免（R-ACC-6，非 PASS） | 获 AT 环境后按 T1.5 补做 | 豁免 |
| A-16 真实读屏 | 豁免（R-ACC-6，非 PASS） | 同上 | — |
| A-13 展开不被重置 | 部分 | T1.6 展开后注入后续事件 | 0.5d |
| C-05 停止未确认 run 重连保留 | 部分 | T1.8 停止未确认状态下断连/重连 | 0.5d |
| C-08 全局 200 上限 | 豁免（R-ACC-7，非 PASS） | 出现低成本批量通道后按 T1.7 补做 | 豁免 |
| B-04 确切在途点 | 部分 | T2.1 包内 await 点延迟钩子 | 1d |
| B-07 cancel/end 竞态 | Blocked | T2.2 end 发布延迟钩子（R-ACC-4 不可 waiver） | 0.5d |
| D-03 路由级 origin | 部分 | T3.1 路由级集成或裁定 | 0.5d |
| E-06 平台证据诚实 | 部分 | T3.2/T3.3 如实记录 Windows/内网目录（R-ACC-5） | 记录项，非 blocker |

表中预计仅用于排序，不逐行相加；A-14 与 A-03/A-05 共用 T1.1/T1.2/T1.9，A-12 与 A-04 同批。

## 3. 原则

1. 不降级 §10.1 口径：单测、CI、另一平台结果不能写成真机 PASS。
2. **真实 `@` 场景不能用 waiver 变成 PASS**，只能补做；waiver 最多记录发布风险，不改验收状态。
3. **自动化充分性裁定只适用于无 GUI 维度的条目**；本次已由 owner 对 C-02/C-03/D-02/D-07/D-08 作出 R-ACC-1/2/3 裁定，其他条目必须补真机证据。
4. 新增钩子必须 master-gated、默认惰性、有默认关闭回归钉；不得成为产品设置或用户可见入口。
5. 注入故障只证明「该语义在注入下被观察」，不写成生产自然失败。
6. 每项证据落盘：环境、Desktop SHA、Harness pin、构建类型、测试人、命令、退出码、截图/WS 帧/日志。
7. 门禁严格串行；不并行跑 `verify:aa`。
8. 只有 A–D 全部通过（含 R-ACC-1/2/3 的裁定）+ E-01～E-05 通过 + E-06 如实记录，才勾选 §10.1；部分项不得勾选。

## 4. 任务

### T0 文档订正（0.5 人日；已完成）

- A-01 改为 PASS；A-12/C-05 降为部分；E-05 改为 PASS；A-13 剩余子项收窄为「手动展开不被后续事件重置」；B-07 补回剩余清单。
- 证据文档与设计文档各追加〈验收判定订正（2026-10-28）〉；§10.1 仍不勾选。
- 通过判据：两份文档的剩余清单一致，计数可逐条复核；A-05/A-14 的剩余子项完整列出。

### T1 可诱发项（约 5.5 人日 + 读屏人工）

#### T1.1 A-03 / A-14 finalizing 文案

- 目的：目视卡片「正在确认执行结果」文案，而不是只抓到 WS 的 `phase: "finalizing"`。
- 方法：新增 `HUAANWORK_ACCEPTANCE_HOLD_FINALIZING_MS`（默认 0），在 child idle 置 `finalizing` 后、发布终态前等待 N ms；钩子关闭时行为不变。
- 文件：`dsh-plugin-huaanwork/src/huaanwork-host/subagent-runs.ts`（相位切换）或 `huaanwork-guardrails/bridge.ts`（child idle → finalizing）、`acceptance-hooks.ts`、对应 spec。
- 通过判据：卡在 finalizing 窗口保持「正在确认执行结果」，随后进入终态；钩子关闭时原有测试全绿。
- 证据：截图 + WS 帧（`phase: finalizing`）+ 钩子默认关闭的回归钉。

#### T1.2 A-05 / A-14 max-tokens / refusal 文案

- 目的：观察 `max-tokens` 与 `refusal` 终态的卡片文案，确认不显示成功。
- 方法：优先用真实模型设置/提示词诱发（临时 profile 降低输出上限、使用安全的拒答提示）；若不可控，新增 master-gated 终端原因注入（经真实 registry 路径，不直接改 DOM）。
- 文件：临时 profile；若注入，`acceptance-hooks.ts` 与结果构造点。
- 通过判据：两种终态分别显示失败文案；`completed` 不出现；告警不篡改终态。
- 证据：截图 + WS 帧中的 `reason`；若注入，注明是注入而非自然失败。

#### T1.3 A-07 5 分钟无活动提醒

- 目的：观察「5 分钟无活动」提醒，确认不自动停止、不写成超时。
- 方法：让子运行执行一个长静默工具（如 `sleep 330`），父回合 idle，等待超过 5 分钟；记录提醒出现时间与卡片状态。
- 文件：无源码改动；使用既有 bash 工具。
- 通过判据：提醒在阈值后出现且只一条；卡片仍活跃、终止可用、耗时继续；无自动停止。
- 证据：两个时间点的截图/时间戳 + 卡片 DOM/WS 状态。

#### T1.4 A-04 / A-12 并发工具与 `+N`

- 目的：观察并发工具按 `callId` 独立记录、一个 `tool/end` 不清除其他仍在执行的工具，以及默认前 2 + `+N`、可展开完整在途列表。
- 方法：优先用会同时发起两个工具的测试包/夹具；若模型仍串行，新增 master-gated 的两条 `tool/start`（不同 `callId`）+ 单条 `tool/end` 注入，经真实 run 投影路径。
- 文件：测试包夹具或 `acceptance-hooks.ts` + `bridge.ts`/`subagent-runs.ts` 的工具活动投影、对应 spec。
- 通过判据：卡同时显示两个工具（或 2 + `+N`）；结束一个后另一个仍在；展开显示完整在途列表。
- 证据：截图 + 两条 `tool/start` 与一条 `tool/end` 的 WS 帧。

#### T1.5 A-11 / A-16 真实读屏

- 目的：用真实辅助技术确认播报语义，而不是只看 CDP AX 树。
- 方法：macOS VoiceOver 人工会话，键盘导航到运行卡；核对终止按钮可访问名、状态区礼貌播报、计时不播报、相位/工具变化播报、清理失败只 alert 一次、更新不抢焦点。
- 文件：无源码改动。
- 通过判据：上述六项逐条记录实际播报文本；不符合即开缺陷，不以 AX 树代替。
- 证据：录屏/录音、VoiceOver 日志、测试人与时间。

#### T1.6 A-13 手动展开不被后续事件重置

- 目的：补 A-13 唯一剩余子项。
- 方法：用清理告警卡（截图 30 形态）或带告警/详情的卡，展开后注入更高 revision 的后续事件（或终态告警），观察展开状态是否保持。
- 文件：无源码改动；复用验收钩子构造告警与后续帧。
- 通过判据：展开后 `aria-expanded` 与内容保持，不被后续事件收起或重置。
- 证据：展开前后截图 + DOM `aria-expanded` + 注入帧。

#### T1.7 C-08 全局 200 上限

- 目的：触发全局 200 条终态历史上限，验证活跃与 stopping 不被淘汰，淘汰后可由 snapshot 对账。
- 方法：用现有 CDP 驱动或小脚本连续发起 201 条快速 legacy run，**分散在至少 11 个父会话**（每父 20 上限先于全局触发）；记录每个父的 `subagent.list` 与客户端各 tab 卡数，按父聚合验证全局 200。
- 注意：`subagent-runs.ts:684-689` 的 snapshot 按 `parentSessionId` 过滤，**单个 snapshot 不能证明全局 200**；不得把单父快照当成全局证据。
- 文件：验收脚本放在 `.superpowers/sdd/2026-10-26-subagent-run-visibility/` 下，或扩展同目录既有驱动；不改产品代码。
- 通过判据：跨父聚合后客户端与 Host 均为全局 200；活跃/stopping 不被淘汰；每父 20 上限仍成立；无重复卡或错位。
- 证据：脚本日志 + 各父 `subagent.list` 聚合 + 客户端计数截图。

#### T1.8 C-05 停止未确认 run 的重连保留

- 目的：补 C-05 的「停止未确认 run 不丢失」子项。
- 方法：用 dispose 超时钩子制造 stopping/cleanup-unconfirmed run，随后用 CDP 关闭事件 WebSocket 并等待自动重连；观察卡片在断连期间与重连后是否仍为 stopping/清理未确认、是否被快照错误清除或写成 stopped。
- 文件：无源码改动；复用 `HUAANWORK_ACCEPTANCE_DISPOSE_FAILURE` 与既有 WS 断连方法。
- 通过判据：断连期间冻结且终止禁用；重连后该 run 仍在、状态不被改写为 stopped；快照对账不丢失。
- 证据：断连/重连两段截图 + `subagent.list` 前后对比 + WS 帧。

#### T1.9 A-05 / A-14 其余子项

- A-05 `unknown`：注入或诱发未知终态原因，确认不显示成功；单工具失败：让一个工具失败而 run 继续，确认不直接决定整个 run 失败（自动化已有 `bridge.spec.ts:592`，真机补观察）。
- A-14 stopReason 文案：覆盖 targeted-cancel、aborted、cleanup-budget 等既有 stopReason 的固定文案，确认不出现自创文案。
- A-14 提醒优先级/单条/可展开：制造多条告警同时存在，确认只显示一条提醒且可展开全部。
- A-14 60 秒重连不重置：让 stopping run 跨越 60 秒并期间断连/重连一次，确认提醒时间取自 Host `stopRequestedAt`，不因重连归零。
- A-14 非琥珀结构化样式：读取告警区计算样式，确认不使用琥珀色，且样式由 warning code/severity 决定。
- 方法：优先复用/扩展 master-gated 验收钩子；真实可诱发的场景优先真实诱发。
- 文件：`acceptance-hooks.ts`、告警/提醒展示路径、对应 spec。
- 通过判据：上述每个子项都有独立观察记录；缺一项则 A-05/A-14 仍为部分。
- 证据：逐项截图/WS 帧/计算样式 + 场景说明。

### T2 Host/时序项（约 1.5 人日）

#### T2.1 B-04 package 启动中终止的确切在途点

- 目的：分别命中 `createRuntime` 与 `startActivation` 在途。
- 方法：新增两个独立变量 `HUAANWORK_ACCEPTANCE_PACKAGE_DELAY_POINT=createRuntime|startActivation` 与 `HUAANWORK_ACCEPTANCE_PACKAGE_DELAY_MS`（默认不延迟），在对应 await 点等待；等待期间从卡片取消；观察晚到 runtime/activation 是否按所有权 dispose、是否继续执行。
- 文件：`dsh-plugin-huaanwork/src/huaanwork-host/agent-package/host.ts`、`acceptance-hooks.ts`、对应 spec。
- 通过判据：两个点各一次；取消后不继续执行；晚到资源被 dispose；父/兄弟不受影响；卡最终 `stopped` 或清理未确认。
- 证据：Host 日志（相位、cancel accepted、dispose）+ 截图 + 钩子默认关闭回归钉。

#### T2.2 B-07 cancel/end 竞态

- 目的：构造 cancel 先受理与 end 先完成两种顺序。**按 R-ACC-4，这是真实 `@` 场景，不能用 waiver 代替执行。**
- 方法：新增 `HUAANWORK_ACCEPTANCE_HOLD_END_MS`（默认 0），在自然结果发布前等待；测试两种顺序：
  1. 等待期间取消，再释放 end：卡保持 stopping/stopped，end 只留诊断，不复活、不覆盖停止意图。
  2. 先释放 end，再取消：返回 `already-terminal`，不制造新状态。
- 文件：`dsh-plugin-huaanwork/src/huaanwork-host/subagent-runs.ts` / `bridge.ts`、`acceptance-hooks.ts`、对应 spec。
- 通过判据：两种顺序各一次；无终态复活、无重复终态、无重复清理。
- 证据：WS 帧顺序 + 卡片截图 + 单测。

#### T2.3 C-02 / C-03（已按 R-ACC-1 关闭）

- owner 已裁定：Host 内部时序以 registry 单测为充分证据，不再要求真机注入。
- 无需新增 Host 注入 IPC；保留既有 `subagent-runs.spec.ts` 等自动化证据。

#### T2.4 D-02（已按 R-ACC-2 关闭）

- owner 已裁定：以 `skills.spec.ts:1177`、`:1236` 的单测为充分证据，且不新增可伪造 parent 的 Host IPC。
- 无需额外任务。

### T3 环境/平台项（外部依赖）

#### T3.1 D-03 路由级 origin 检查

- 现状：GUI 中所有非页面/伪造 Origin 请求都被拒绝，但 webserver 外层鉴权连 same-origin curl 也拒绝，路由级 origin 检查无法隔离。
- 方法：路由级集成测试直接调用 handler，分别用回环别名、非回环、伪造 Origin、跨父参数，断言 403/400/零副作用；把「GUI 外层鉴权先行」写进证据，不把外层拒绝冒充路由检查。
- 文件：`dsh-plugin-huaanwork/tests/huaanwork-host/routes.spec.ts`（已有 `routes.spec.ts:314` 的覆盖，补隔离说明）。
- 通过判据：路由级测试全绿；证据明确区分「外层鉴权拒绝」与「路由级 origin 拒绝」。
- 证据：测试输出 + 证据文档说明。

#### T3.2 真实内网目录（E-06 环境记录，R-ACC-5）

- 现状：`10.130.209.76:18080` 从开发机不可达；legacy 用本地 spec-valid 夹具验证了执行链，但不是内网目录。
- 方法：取得内网网络路径或内网机器，用真实目录跑一次 legacy `@agent` 完成与取消；记录条目名/版本、Desktop SHA、Harness pin、构建类型、测试人。
- 回退：在 E-06 如实记录「wire contract 与 legacy 执行链已用本地夹具验证；内网目录可用性/条目内容未验证」。这不是 waiver 后的 PASS，也不用来压低 E-05。
- 文件：无源码改动。
- 通过判据：真实目录证据，或 E-06 的诚实环境记录。
- 证据：截图/日志 + 环境信息，或记录文本。

#### T3.3 Windows（E-06 平台证据诚实，R-ACC-5）

- 方法：在 Windows 机器上跑构建产物，执行 package/legacy `@` 完成与取消，观察卡片、焦点与清理；记录平台、构建类型、测试人。
- 回退：在 E-06 标注「Windows 未验证」。参照智能体包 M2 的 `R-ACCEPT-1` 模式，可用 Windows GHA 作为构建/打包证据，但必须写明不是真机验收；不得据此把 Windows 记为 PASS，也不得用 waiver 勾选 §10.1。
- 文件：无源码改动。
- 通过判据：Windows 真机证据，或 E-06 的诚实「未验证」记录。
- 证据：截图/录屏 + 环境信息，或记录文本。

### T4 裁定项（0.5 人日；已于 2026-10-28 完成）

owner 已批准并落盘以下五条裁定，记录在证据文档〈验收裁定（2026-10-28，owner）〉：

1. **R-ACC-1（C-02 / C-03）**：Host 内部时序以 registry 单测为充分证据，不再要求真机注入。
2. **R-ACC-2（D-02）**：以单测为充分证据，且不新增可伪造 parent 的 Host IPC。
3. **R-ACC-3（D-07 / D-08）**：以代码/变体守卫审计为充分证据。
4. **R-ACC-4（B-07）**：不可 waiver；B-06 的双 cancel 幂等不等于 cancel/end 竞态，必须执行 T2.2。
5. **R-ACC-5（Windows / 真实内网目录）**：仅作 E-06 环境记录，未执行标注未验证；不作为 waiver 或勾选 §10.1 的依据。

### T5 门禁与证据（0.5 人日）

- 每批代码改动后严格串行跑：定向测试 → `corepack yarn typecheck` → `corepack yarn test` → `corepack yarn check:desktop-variants` → `corepack yarn check`；保留日志与退出码。
- 涉及 UI/构建的改动补本机 `corepack yarn dist:mac-smoke:huaanwork`。
- 每项完成后更新证据文档的对应行；不得把「部分」留在汇总里不解释。
- 最终报告逐项列出 PASS / 自动化充分性裁定 / E-06 环境记录，并给出证据指针；只有此时才勾选 §10.1。

## 5. 顺序与依赖

1. **T4 已完成**：C-02/C-03/D-02/D-07/D-08 已按 R-ACC-1/2/3 关闭；B-07 按 R-ACC-4 直接排 T2.2。
2. **再做 T1/T2 钩子**：一次性加齐默认惰性的验收钩子，减少重复构建；每项单独取证。
3. **T3 环境项可与 T1/T2 并行**：内网/Windows/读屏不依赖代码改动；E-06 只做诚实记录，不做 waiver。
4. **最后 T5 门禁与证据**：在最终 SHA 上串行跑完整门禁，更新计数与复选框。

## 6. 完成定义

- A–D 条目已全部 PASS 或经 owner 豁免：14 个缺口逐项 PASS（C-02/C-03/D-02/D-07/D-08 已由 R-ACC-1/2/3 关闭），A-11/A-16 与 C-08 由 R-ACC-6/R-ACC-7 豁免。
- E-01～E-05 保持通过；E-06 如实记录：Windows 按 R-ACC-8 待 GitHub 虚拟机验收，真实内网目录未验证。
- **整体状态为 complete with waiver，不是 49/49 全量 PASS**；豁免项不勾选 §10.1，Windows 待 GHA 验收完成后才可在 E-06 更新为已验证。
- 证据文档与设计文档的剩余清单一致，计数可逐条复核；不再有笼统的「其他部分项」。
- 最终 SHA 上 `install --immutable`、`check`、`typecheck`、`test` 全绿；UI 改动补 mac smoke。
- 未直接推 master、未自动合并、未发布；§10.1 复选框只在满足上述条件后勾选，waiver 不得作为勾选依据。

## 7. 不做

- 不新增用户可见的 Host 重启按钮、自动崩溃重启或通用 Host 控制面。
- 不持久化控制面，不做嵌套子代理树。
- 不放宽工具 allow、policy、sandbox 或智能体包安全复验。
- 不为了通过验收降级 §10.1 口径，不把单测/CI/另一平台写成真机 PASS。
- 不把验收钩子暴露为产品设置；钩子必须默认惰性。
- 不为 D-02 新增可伪造 parent 的生产 IPC；安全面不划算（R-ACC-2 已明确）。
- 不用 waiver 把真实 `@` 场景或未执行的 Windows/内网目录标成 PASS。

## 8. 工作量

| 阶段 | 预计 | 备注 |
| --- | --- | --- |
| T0 文档订正 | 0.5d | 已完成 |
| T1 可诱发项 | 5.5d | 含 5 分钟等待、201 条循环、停止未确认重连、A-05/A-14 子项与读屏人工 |
| T2 Host/时序项 | 1.5d | C-02/C-03/D-02 已由裁定关闭，仅剩 B-04/B-07 |
| T3 环境/平台项 | 2–3d | 不含等待内网/Windows 机器 |
| T4 裁定 | 0.5d | 已完成（2026-10-28） |
| T5 门禁与证据 | 0.5d | 串行门禁 |
| 合计 | 约 10.5–11.5 人日 | 含已完成的 T0/T4；外部环境等待另计 |

以上为估算，不是承诺；实际以每项证据是否可采为准。
