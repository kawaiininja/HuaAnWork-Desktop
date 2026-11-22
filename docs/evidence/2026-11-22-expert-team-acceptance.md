# 专家团多智能体协作验收证据（Task 18）

当前结论：**自动化 headless gate PASS；真机人工验收未执行（BLOCKED，无交互 GUI/IME/真机环境）**。

本文件严格区分两类证据：

- **自动化证据（已执行）**：`corepack yarn check` 全部通过，包含单元/契约测试、真实组合场景
  与编译产物 Loader smoke。
- **真机人工验收（未执行）**：Task 18 Step 3 的 9 项真机步骤全部保持未勾选，状态为
  `BLOCKED — 未执行`。

单元测试与组合测试（即使使用真实 `prepareDesktopProfile`/`boot`、真实 `session.send`、包
runtime、MCP 与 Artifact 存储）只证明代码路径与自动化断言，**不构成真机结论**，不能替代
交互 GUI、真实中文输入法、真实模型、真实 Host 重启与真实取消操作的人工验收。

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
| 门禁时代码 HEAD | `e259a2664f`（`test(expert-team): harden composed scenario assertions`） |
| 提交数 | 36（`e786ae8bd4..e259a2664f`） |
| 门禁时工作树 | 干净 |
| 执行者 | 控制器会话；本文件在完整门禁之后整理，未再次运行完整门禁 |

## 2. 命令与结果

```bash
corepack yarn check
```

结果：**`EXIT=0`**。按计划约束，该命令不得与其它含 `verify:aa` 的命令并发；本证据只记录
控制器执行的这一次完整门禁运行。

门禁关键输出：

| 项目 | 输出 |
| --- | --- |
| Vitest 主分组 | `Test Files 329 passed \| 4 skipped (333)`；`Tests 4793 passed \| 15 skipped (4808)` |
| Vitest 其余分组（文件数/用例数） | 13/303、14/244、5/88、7/112 |
| Vitest 合计 | **5540 passed / 15 skipped** |
| Profile 启动 | `verify-profile-boot: minimal preset, plugin manager, and disabled hmr lock passed`（输出中出现两次） |
| 专家团编译产物 smoke | `expert-team smoke: tool present, list=200 (0 teams), invocable=200 (0 teams)` |

`dsh-plugin-huaanwork` 的 `check` 脚本把新 smoke 放在 `verify:host` 与 `verify:aa` 之间：

```text
... && yarn run verify:profile && yarn run verify:host && yarn run verify:expert-team && yarn run verify:aa && ...
```

因此 `verify:expert-team` 已经进入完整门禁链，而非单独手工命令。该 smoke 在临时 profile 中
没有团队定义（`0 teams`），它证明的是编译产物经真实 Loader 启动后工具已注册、两条团队 GET
路由在真实 HTTP 服务上返回 200；它不证明团队 CRUD、派工或 UI 行为。

Task 18 Step 2（最终差异与格式检查）在最终修复波次重跑并记录：

```bash
git diff --check      # EXIT=0，无输出：无 whitespace 错误
git status --short    # 仅列出本轮专家团修复文件，无 deepseek-harness/、锁文件、无关 CI 或二进制
```

`git status --short` 的 13 个条目全部属于专家团实现：`coordinator.ts`、`index.ts`、
`expertTeamsLogic.ts`、`ExpertTeamRunCard.tsx`、`App.tsx`、对应 Host/Guardrail/Client
测试、组合 driver、计划文件。工作树在该步之前没有未跟踪的意外文件；证据文档本身是随后
新增的文档提交。

## 3. 自动化证据（已执行）

### 3.1 完整门禁

`corepack yarn check` 在代码 HEAD `e259a2664f` 的干净工作树上以 `EXIT=0` 完成，覆盖根级
布局/文档/连通性门禁、各 workspace 的 build/typecheck/test 与 `dsh-plugin-huaanwork` 的
`verify:closure`、`verify:bundled`、`verify:cli`、`verify:loader`、`verify:profile`、
`verify:host`、`verify:expert-team`、`verify:aa`、`verify:licenses`、`verify:operations`。

### 3.2 单元与契约测试

专家团相关的主要自动化测试文件：

- Host 侧（`dsh-plugin-huaanwork/tests/huaanwork-host/`）：`expert-team-store.spec.ts`、
  `expert-team-runs.spec.ts`、`expert-team-routes.spec.ts`、`expert-team-text-protocol.spec.ts`、
  `expert-team-orchestration.spec.ts`、`expert-team-dispatch.spec.ts`、
  `expert-team-coordinator.spec.ts`、`expert-team-observer.spec.ts`、
  `expert-team-session.spec.ts`、`expert-team-composition.spec.ts`、`sessions.spec.ts`
  （团队发送与观察链）。
- Guardrail 侧（`dsh-plugin-huaanwork/tests/huaanwork-guardrails/`）：`expert-team-dispatch.spec.ts`
  （工具注册与团队回合附件）与 `policy.cordis.spec.ts`（`result_present` /
  `expert_team_dispatch` 的挂载 allow、未挂载双闸 deny）。
- Client 侧（`dsh-plugin-huaanwork/tests/client-huaanwork/`）：`expertTeamsLogic.spec.ts`、
  `ExpertTeamsView.spec.ts`、`expertTeamRuns.spec.ts`、`ExpertTeamRunCard.spec.ts`、
  `appWiring.spec.ts`（团队运行卡对账、取消确认与视图清理）。

这些测试全部包含在 §2 的 Vitest 合计中。

### 3.3 真实组合场景（Task 17）

`expert-team-composition.spec.ts` 是自动化组合证据：真实 `prepareDesktopProfile`/`boot`、
真实 `session.send`、真实包 runtime、MCP 与 Artifact 存储，模型经 `llm/stream` 脚本化，
不触网、不需要真实 API key。已覆盖：

1. 两名执行成员 + 一名统一审查成员，默认统一审查、一次返修后复审、单一主 Artifact；
   双 MCP 成员、父会话无 MCP 泄漏、成员 MCP server 名长度受限；成员 run 真实独立。
2. 两名审查成员时返修后全员并行复审；父会话 `maxParallelToolCalls=1` 时团队串行池生效。
   组合 driver 以与执行成员相同的波次 barrier 记录真实审查流并发 `maxReviewConcurrency`：
   两审查成员的复审波次断言为 2，串行池断言为 1。
3. 24 次预算耗尽后产出 partial Artifact；Artifact 写失败后保持 `pending` 且团队结算
   `partial`。
4. 仅会话模式只取最后 `tool/result` 之后的最终文本；goal 续拍不能再派工
   （`expert-team-terminal`）。
5. 同一 profile 重启 Host 后团队运行投影清空，消息与 Artifact 仍在。

再次强调：以上均为**脚本化 provider 下的自动化断言**，不是真实模型、真实 GUI 或真实中文
输入法的人工验收。

### 3.4 编译产物 Loader smoke

`verify:expert-team`（`dsh-plugin-huaanwork/scripts/huaanwork-expert-team-smoke.mjs`）复用
`verify-profile-boot.mjs` 的真实 Loader 启动序列与 profile patch 组合，断言
`expert_team_dispatch` 进入真实 ToolRegistry，并通过真实 HTTP（renderer 头换 cookie、同源
`Origin`）访问 `/huaanwork/expert-team/list` 与 `/huaanwork/expert-team/invocable`，两者均
返回 200 且 payload 含 `teams` 数组。本次输出为 `list=200 (0 teams), invocable=200 (0 teams)`。

## 4. 真机人工验收（未执行）

以下 9 项来自计划 Task 18 Step 3。本实现会话没有交互 GUI、没有真实中文输入法、没有真实
模型调用，也没有手动 Host 重启会话，因此全部未执行、全部未勾选；没有任何一项标记为通过。

- [ ] 新建“合规审查小分队”：两名执行成员、一名审查成员，默认统一审查和 Markdown 主
  Artifact；检查成员包原生脚本/HTTP/MCP 能力。**BLOCKED — 未执行**：未启动真实 Electron
  应用，未安装并运行真实成员包，无法人工检查包原生脚本/HTTP/MCP 能力。
- [ ] 中文检索并调用 `@team`，确认真实独立成员 run、包版本、最多两路并行、动态补派和统一
  审查一次返修后全员复审。**BLOCKED — 未执行**：无交互 GUI、无中文输入法、无真实模型，
  无法执行真实 `@team` 检索与调用。
- [ ] 验证 reasoning + text 正常执行，纯 reasoning 显示 empty-output，混合 image/file 显示
  unsupported-output。**BLOCKED — 未执行**：模型流在自动化中为脚本化 provider，未观察真实
  UI 对 reasoning/empty-output/unsupported-output 的呈现。
- [ ] 验证一份主 Artifact、正文工具卡抑制、预览、全屏和原字节下载；主报告后派工封闭。
  **BLOCKED — 未执行**：无 GUI，无法人工验证预览、全屏与字节级下载，也无法观察正文工具卡
  抑制。
- [ ] 验证仅会话模式：派工前过渡语不算最终汇总，最后 tool/result 后文本才算。
  **BLOCKED — 未执行**：无交互会话界面，未执行人工发送与最终汇总观察；自动化组合用例只覆盖
  脚本化场景。
- [ ] 分别验证成员中途失效、无效审查标记、单成员取消、整团取消、父会话停止、24 次预算耗尽
  后的部分 Artifact。**BLOCKED — 未执行**：未在真实应用执行取消/失效/预算耗尽操作；协调器
  与组合用例的自动化断言不构成真机结论。
- [ ] 验证同会话双 MCP 成员并行、普通 `@智能体` 行为、goal 续拍不能迟到派工。
  **BLOCKED — 未执行**：未执行真实同会话双 MCP 并行与普通 `@智能体` 实机回归；goal 续拍仅
  有脚本化自动化覆盖。
- [ ] 验证 Host 重启后团队卡不恢复，消息和 Artifact 卡仍在；验证 Artifact 写失败（如超
  5 MiB 或写盘异常）后保持 pending、可同回合重试且未重试结 partial；关联失败时 Artifact
  可见但团队 pending/partial。**BLOCKED — 未执行**：未执行手动 Host 重启，也未制造真实写盘
  异常；组合用例的重启与写失败均为自动化注入。
- [ ] 验证中文输入法组合态、键盘选择、断连冻结、重连对账和终态淘汰。**BLOCKED — 未执行**：
  未打开中文输入法，无法验证组合态与键盘选择；无 GUI 可执行断连/重连人工观察。

## 5. 范围与限制

- 自动化测试**不使用真实 API key，也不访问外部网络**；模型调用由脚本化流替代。
- **未执行打包产物验收**：Windows 安装包、macOS 签名/安装产物均未在本轮验证，仍为开放项。
- **中文输入法、Host 重启、真实取消清理、Artifact 预览/全屏/原字节下载**必须真机人工
  验收，仍为开放项；本文件不将其标为通过。
- 本文件的提交只新增/更新文档，不改变代码 HEAD `e259a2664f` 的产品代码；该证据提交是门禁
  代码提交之后的独立提交。
- `verify:aa` 的已知并发 flake 仍有效：完整门禁结果只在单次独立运行下成立，不得与其它含
  `verify:aa` 的命令并发复跑。

## 6. 结论汇总

| 项目 | 结论 |
| --- | --- |
| 自动化 headless gate（`corepack yarn check`，EXIT=0） | **PASS** |
| Vitest（5540 passed / 15 skipped） | **PASS** |
| 编译产物专家团 Loader/HTTP smoke | **PASS** |
| Task 18 Step 3 真机人工验收（9 项） | **BLOCKED — 未执行（0 项通过）** |
| Windows/macOS 打包产物验收、中文输入法、Host 重启 | **开放** |
