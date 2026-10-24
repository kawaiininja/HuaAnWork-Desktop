# 修复智能体包生命周期观察项

## TL;DR
> **Summary**: 修复两个已定位的确定性问题：`ptc` preset 的 `tool-presentation` 行启动时仍被 HuaAnWork 防线拒绝，以及无附件表的验收/清理上下文仍调用 `refreshAgentRestrict`。`agent_commit` 成功后的模型误报与父会话自查行为保留为 P3，不阻塞本轮。
> **Deliverables**: 本方案文档；后续实现改 `profile.ts`、嵌套 preset 断言、`present-as.ts` 的刷新早退与对应回归测试。
> **Effort**: Short
> **Parallel**: YES - 两个修复任务并行，汇总验证收尾
> **Critical Path**: Task 1 与 Task 2 可并行；Task 3 汇总验证在二者之后。

> **实施订正（2026-10-24）**：Task 1 原处方「嵌套 `tool-presentation` 设为 native」不成立——preset scope 下 native 会触发上游 `presentAs() requires a scoped context`。实际实现改为**禁用**该嵌套 row，由全局 `tools.mode: native` 提供 presentation；`profile.spec` 与嵌套 row 断言按 disabled 落地，真实 boot 已确认无 `presentAs("ptc")` 与 scoped-context 错误。Task 2 按原方案实施。

## Context
### Original Request
用户要求核查 2026-10-23/24 智能体包验收留下的三个观察项，判断是否需要修，并给出具体修复方案：

1. `tool-presentation` 启动时仍记录 `tools.presentAs("ptc") is disabled` 的 mount 错误；P1 只去掉了会误伤 UI 的全局事件。
2. `refreshAgentRestrict: restrict state not found` 残余仍在。
3. `agent_commit` 成功后的模型 `unknown tool` 文案、父会话 `call_host_tool` 误判子代理结果，属 P3 模型/UX，不在本轮代码修复内。

### Investigation Summary
本轮只做源码与证据核查，未修改实现代码。

- `tools` 全局配置 `mode: 'native'` 只是默认值；`ptc` preset 内的 scoped `tool-presentation` 行仍按 `mode: ptc` 调用 `presentAs('ptc')`，再被 `huaanwork-guardrails/present-as.ts` 拒绝。只改全局默认值不会命中嵌套 preset row。
- Windows 探针的 `refreshAgentRestrict` 日志来自一个未装载 `present-as`、也没有 `huaanworkAttachments` 的 fixture 上下文。附件表缺席时，没有需要合入 restrict 的 session 级工具名，刷新调用本身应跳过。
- `agent_commit` 成功后宿主已经发 `agent/notice`、`agent/changed` 并落盘。模型随后再调已卸载工具，得到 `unknown tool` 并误述失败。上游工具执行已有 `exec.concludeTurn()`，可作为后续 P3 修复，不应通过吞掉 `unknown tool` 来掩盖装配错误。
- 父会话收到的是上游 settlement notice，不是结果路由丢失；验收记录的 bash/curl 自查是模型行为啰嗦。

## Work Objectives
### Core Objective
启动组合里不再产生 `presentAs("ptc")` mount 失败；没有附件表的上下文不再打印 `restrict state not found`。保留这两类错误的真实告警路径，避免把装配问题消音。

### Deliverables
- `dsh-plugin-huaanwork/src/profile.ts` 对 `preset-ptc` 的完整 config override，把嵌套 `tool-presentation` 固定为 `native`。
- `dsh-plugin-huaanwork/src/huaanwork-host/row-assertions.ts` 与相关 profile 测试，防止嵌套 preset 配置漂移。
- `dsh-plugin-huaanwork/src/huaanwork-guardrails/present-as.ts` 的无附件表早退与回归测试。
- 测试与汇总验证记录。

### Definition of Done (verifiable conditions with commands)
- `corepack yarn workspace dsh-plugin-huaanwork vitest run tests/profile.spec.ts tests/huaanwork-rowids.spec.ts tests/huaanwork-guardrails/present-as.cordis.spec.ts tests/huaanwork-guardrails/agent-mcp.cordis.spec.ts tests/huaanwork-guardrails/agent-package-tools.spec.ts` 通过。
- 组合后的 `preset-ptc` 中，嵌套 `tool-presentation` 为 enabled 且 `config.mode === 'native'`；其他 preset 字段与兄弟插件未丢失。
- 无 `huaanworkAttachments` 且无 state 的上下文调用 `refreshAgentRestrict` 不打印 missing-state 错误；有附件表但无 state 时仍打印错误。
- 真实组合 boot 选择 `ptc` preset 时，不再出现 `tools.presentAs("ptc") is disabled by HuaAnWork` mount 错误。

### Must Have
- 保留 `present-as.ts` 对动态 `presentAs('ptc' | 'both')` 的拒绝，作为运行时防线。
- `preset-ptc` 的 override 必须包含该 preset 原有完整 config，尤其是 `id`、`order` 与全部 `plugins`；不能只覆盖一个嵌套字段。
- `refreshAgentRestrict` 只在 `ctx.huaanworkAttachments` 缺席时早退；附件表存在但 state 缺席仍 loud。
- 文档和测试都区分「无附件表无需刷新」与「附件已变但未刷新」。

### Must NOT Have (guardrails, scope boundaries)
- 不改 `dsh-plugin-desktop/src/` 或 `dsh-plugin-desktop-beta/src/`；不碰 zero-touch 规则。
- 不删除 `tool-presentation` row；不直接加 `{ id: 'tool-presentation', config: { mode: 'native' } }` 的普通补丁，因为该 row 在 `preset-ptc.config.plugins` 内，普通 patch 不递归该字段。
- 不删除、不降级 `restrict state not found` 对真实 missing-state 的日志。
- 不把 `unknown tool` 全局改写或吞掉。
- 不把 P3 的 `concludeTurn` 或父会话提示改入本轮实现。
- 不提交 git，除非用户另外要求。

## Verification Strategy
> ZERO HUMAN INTERVENTION - all verification is agent-executed.
- Test decision: 更新现有 vitest / node:test，与实现放在同一任务；先按本方案写失败测试，再改实现。
- QA policy: 每个任务含可执行场景；关键断言覆盖静态组合与真实 mount 边界。
- Evidence: 实现后可在 `plans/evidence/agent-package-lifecycle-observations/` 下放命令输出摘录。

## Execution Strategy
### Parallel Execution Waves
Wave 1: Task 1、Task 2（profile 组合与 restrict 刷新互不重叠）
Wave 2: Task 3 汇总验证

### Dependency Matrix (full, all tasks)
| Task | Blocks | Blocked By |
| --- | --- | --- |
| 1 固定 preset presentation 为 native | 3 | 无 |
| 2 无附件表时跳过 restrict 刷新 | 3 | 无 |
| 3 汇总验证 | 无 | 1, 2 |

## TODOs

- [ ] 1. 把 `ptc` preset 的嵌套 `tool-presentation` 固定为 native

  **What to do**:
  - 在 `dsh-plugin-huaanwork/src/profile.ts` 的 guardrail 锁层生成处（约 1535 行 `patches.push` 之前）先组合当前 `patches`。
  - 找到 `id === 'preset-ptc'` 且 `name === '@deepseek-ai/dsh-agent-preset'` 的 row；克隆完整 `config` 与 `config.plugins`。
  - 在嵌套 `plugins` 中只定位 `id === 'tool-presentation'` 且 `name === '@deepseek-ai/dsh-agent-tool-presentation'` 的 row，改成 `{ ...row, disabled: false, config: { mode: 'native' } }`。
  - 追加 `{ id: 'preset-ptc', name: '@deepseek-ai/dsh-agent-preset', config: nextPresetConfig }`，让后续 `composeEntries([patches])` 用完整 config 覆盖原 preset。不要覆盖 `disabled` 字段。
  - 上游把 preset row 改名、删除或删掉嵌套 `tool-presentation` 时，组合阶段抛错；不要静默跳过。
  - 在 `dsh-plugin-huaanwork/src/huaanwork-host/row-assertions.ts` 增加嵌套断言：`preset-ptc` 存在且未禁用；其嵌套 `tool-presentation` 存在、未禁用且 `config.mode === 'native'`。
  - 更新 `tests/profile.spec.ts` 与 `tests/huaanwork-rowids.spec.ts`，覆盖：嵌套 row 被改成 native、其他 preset 字段与兄弟插件保留、嵌套 row 缺失或漂移时抛错。

  **Must NOT do**: 不用普通 `tool-presentation` patch；不删除上游 preset row；不修改 `dsh-plugin-huaanwork/src/huaanwork-guardrails/present-as.ts` 的动态拦截。

  **Parallelization**: Can Parallel: YES | Wave 1 | Blocks: 3 | Blocked By: 无

  **References**:
  - Global default: `dsh-plugin-huaanwork/src/profile.ts:1538` 只设置 `tools.config.mode = 'native'`。
  - Upstream nested row: `deepseek-harness/packages/bundle/web-app/presets/ptc.patch.yml:123-126` 声明 `tool-presentation` 的 `mode: ptc`。
  - Scoped mode wins: `deepseek-harness/packages/core/tools/src/index.ts:925-935` 最近 scope 的 declaration 覆盖 deployment default。
  - Patch recursion: `dsh-plugin-huaanwork/node_modules/@deepseek-ai/cordis-plugin-include/src/index.ts:65-72` 只递归 `group + config` entry 列表，不会递归 `preset-ptc.config.plugins`。
  - Runtime defense: `dsh-plugin-huaanwork/src/huaanwork-guardrails/present-as.ts:104-114`。

  **Acceptance Criteria**:
  - [ ] 组合结果中 `preset-ptc.config.plugins` 的 `tool-presentation` 是 enabled/native。
  - [ ] 同一 preset 的 `id`、`order` 与所有兄弟插件仍在，测试能发现不完整覆盖。
  - [ ] 直接调用 `presentAs('ptc')` 的既有拒绝测试仍通过。

  **QA Scenarios**:
  ```
  Scenario: ptc preset 不再尝试 PTC presentation
    Tool: bash
    Steps: 调用 prepareDesktopProfile 后 composeEntries([prepared.patches])，读取 preset-ptc 的嵌套 tool-presentation。
    Expected: 该 row disabled !== true 且 config.mode === 'native'。
    Evidence: plans/evidence/agent-package-lifecycle-observations/task-1-preset.txt

  Scenario: preset override 不能丢兄弟配置
    Tool: bash
    Steps: 比较覆盖前后 preset-ptc.config 的顶层字段、plugins id/name 列表。
    Expected: 顶层 id/order 与全部兄弟插件不变，只有 tool-presentation 的 mode 变化。
    Evidence: plans/evidence/agent-package-lifecycle-observations/task-1-siblings.txt
  ```

  **Commit**: NO | 不提交 | Files: `dsh-plugin-huaanwork/src/profile.ts`, `dsh-plugin-huaanwork/src/huaanwork-host/row-assertions.ts`, `dsh-plugin-huaanwork/tests/profile.spec.ts`, `dsh-plugin-huaanwork/tests/huaanwork-rowids.spec.ts`

- [ ] 2. 无附件表时跳过 `refreshAgentRestrict`

  **What to do**:
  - 在 `dsh-plugin-huaanwork/src/huaanwork-guardrails/present-as.ts` 的 `refreshAgentRestrict` 开头，读取 `ctx.huaanworkAttachments` 之前先把它视作可选字段；缺席时直接 `return`。
  - 保留现有 state 查找顺序；附件表存在时继续查 ctx、WeakMap、ctx.root 与 root WeakMap。
  - 保留 missing-state 的 `console.error`，它只在附件表存在但 present-as 未注册时出现。
  - 更新 `tests/huaanwork-guardrails/agent-mcp.cordis.spec.ts`：无附件表、无 state 的 mount/dispose 不打 missing-state 错误。
  - 更新 `tests/huaanwork-guardrails/present-as.cordis.spec.ts`：有附件表且有 state 仍刷新；有附件表但无 state 仍打错误。
  - 必要时在 `tests/huaanwork-guardrails/agent-package-tools.spec.ts` 或 Windows 探针单测中证明清理路径不再产生该 stderr。

  **Must NOT do**: 不在每个调用点散加判断；不把 missing-state 全部降为 debug；不改变 `tools/change → restrictAll()` 对普通工具注册变化的刷新。

  **Parallelization**: Can Parallel: YES | Wave 1 | Blocks: 3 | Blocked By: 无

  **References**:
  - Missing-state log: `dsh-plugin-huaanwork/src/huaanwork-guardrails/present-as.ts:86-102`。
  - Attachment merge: `dsh-plugin-huaanwork/src/huaanwork-guardrails/present-as.ts:126-132` 只从 `sessionAgentTools` 读取增量。
  - MCP refresh callers: `dsh-plugin-huaanwork/src/huaanwork-guardrails/agent-mcp.ts:131-145`。
  - Package cleanup callers: `dsh-plugin-huaanwork/src/huaanwork-host/agent-package/host.ts:450-457`。
  - Windows fixture context: `dsh-plugin-huaanwork/scripts/huaanwork-agent-package-windows-acceptance.mjs:384-403` 无 `huaanworkAttachments`。
  - Windows evidence: `docs/evidence/2026-10-24-agent-package-windows-gha-acceptance.md:36` 记录该日志不是退出码原因。

  **Acceptance Criteria**:
  - [ ] 无附件表调用 `refreshAgentRestrict` 不调用 restrict，也不打印 `restrict state not found`。
  - [ ] 有附件表且有 state 时仍调用 `restrictSession(sessionId)`。
  - [ ] 有附件表但无 state 时仍打印错误。

  **QA Scenarios**:
  ```
  Scenario: Windows acceptance fixture 不再产生 missing-state 日志
    Tool: bash
    Steps: 构造无 huaanworkAttachments、无 root state 的 ctx，执行 mount/dispose 或包 afterIdle 清理。
    Expected: restrictCalls 为空，console.error 不含 restrict state not found。
    Evidence: plans/evidence/agent-package-lifecycle-observations/task-2-no-attachments.txt

  Scenario: 真实附件变更缺少 state 时仍 loud
    Tool: bash
    Steps: 构造有 huaanworkAttachments、无 root state 的 ctx，调用 refreshAgentRestrict。
    Expected: console.error 记录 restrict state not found。
    Evidence: plans/evidence/agent-package-lifecycle-observations/task-2-loud.txt
  ```

  **Commit**: NO | 不提交 | Files: `dsh-plugin-huaanwork/src/huaanwork-guardrails/present-as.ts`, `dsh-plugin-huaanwork/tests/huaanwork-guardrails/present-as.cordis.spec.ts`, `dsh-plugin-huaanwork/tests/huaanwork-guardrails/agent-mcp.cordis.spec.ts`

- [ ] 3. 汇总验证与 P3 边界确认

  **What to do**:
  - 跑 Definition of Done 中的测试命令。
  - 跑一次真实组合 boot 验证（优先复用现有 `scripts/verify-profile-boot.mjs` 或最小新增 smoke），确认 `ptc` preset mount 不再报告 `presentAs('ptc')` 拒绝。
  - 核对本轮 diff 不含 `agent-package-tools.ts`、`agent-invoke.ts` 或父会话 prompt 改动；这些属于 P3 后续。
  - 核对 `corepack yarn check:desktop-variants`；本方案只改 huaanwork 侧已有分叉文件与测试，不应新增 beta↔huaanwork 白名单需求。若守卫出现新路径，先收回越界改动，不新增白名单。

  **Must NOT do**: 不把真实模型复测当成本轮完成条件；不改 Windows acceptance workflow；不重打安装包。

  **Parallelization**: Can Parallel: NO | Wave 2 | Blocks: 无 | Blocked By: 1, 2

  **References**:
  - Existing boot smoke: `dsh-plugin-huaanwork/scripts/verify-profile-boot.mjs`。
  - Variant guard: `scripts/verify-desktop-variants.mjs`。
  - P3 commit boundary: `dsh-plugin-huaanwork/src/huaanwork-guardrails/agent-package-tools.ts:184-197` 暂不改。
  - Parent delivery evidence: `dsh-plugin-huaanwork/src/huaanwork-host/agent-package/host.ts:483-498` 暂不改。

  **Acceptance Criteria**:
  - [ ] Definition of Done 命令退出码 0。
  - [ ] boot 验证中没有 `tools.presentAs("ptc") is disabled by HuaAnWork` mount 错误。
  - [ ] diff 不包含 P3 文件改动，也不新增白名单。

  **QA Scenarios**:
  ```
  Scenario: 组合验证
    Tool: bash
    Steps: 跑 Definition of Done 的 vitest 列表。
    Expected: 退出码 0。
    Evidence: plans/evidence/agent-package-lifecycle-observations/task-3-tests.txt

  Scenario: 变体边界
    Tool: bash
    Steps: corepack yarn check:desktop-variants。
    Expected: 不出现本方案未列出的新增 huaanwork 文件漂移；不新增 allowedDifferences。
    Evidence: plans/evidence/agent-package-lifecycle-observations/task-3-variants.txt
  ```

  **Commit**: NO | 不提交 | Files: `plans/evidence/agent-package-lifecycle-observations/*`

## P3 Follow-up (not in this implementation round)

### `agent_commit` 成功后结束回合
在 `commitTool` 成功分支完成 `agent/notice`、`agent/changed` 与 `detachCreationTools` 后调用 `exec.concludeTurn()`，再返回成功文本。覆盖测试：

- 成功后调用 `concludeTurn`。
- `host.commit` 拒绝或抛错时不调用。
- 真实组合中工具结果仍落 session log，且不发起下一次模型请求。
- UI 仍显示权威成功通知。

不要吞掉或改写 `unknown tool`。它是真实工具装配/可见性问题的重要信号。

### 父会话等待子代理结果
在 `@slug` 注入文本中明确：子代理结果会自动送回父会话；等待期间不要通过 `call_host_tool`、bash/curl 或 MCP 重做同一任务；收到 settlement notice 后只整理并呈现结果。需要真实模型复测，避免提示修改反而压低结果质量。

## Final Verification Wave (MANDATORY - after ALL implementation tasks)
- [ ] F1. Plan Compliance Audit：对照 Must Have / Must NOT Have，确认 nested override 完整、刷新早退集中、P3 未越界。
- [ ] F2. Code Quality Review：确认没有消音真实 missing-state，没有删除 presentAs 防线。
- [ ] F3. Automated QA：Definition of Done 命令全部通过；boot 验证无 PTC mount 错误。
- [ ] F4. Scope Fidelity Check：diff 只触及本方案列出的 huaanwork 文件、测试与 evidence；没有 stable/beta 改动。

## Commit Strategy
不提交。实现完成后把 diff 留给用户决定。

## Success Criteria
- `ptc` preset 在本变体中固定以 native presentation 挂载，启动不再触发拒绝日志。
- 无附件表上下文不再产生 `restrict state not found`；真实附件变更缺 state 时仍 loud。
- 运行时 `presentAs('ptc' | 'both')` 防线仍在。
- P3 模型/UX 项保留为明确的后续任务，不混入本轮代码修复。
