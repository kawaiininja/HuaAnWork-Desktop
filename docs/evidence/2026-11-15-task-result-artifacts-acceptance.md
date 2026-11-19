# 任务结果 Artifact 用户验收证据（规格 §12.2）

- 分支：`feat/task-result-artifacts-impl`
- 提交：`48c36b134ed7aaf9f9a237f641ffa90eed1aa33c`
- 规格：`docs/superpowers/specs/2026-11-15-task-result-artifacts-design.md` §12.2
- 环境：macOS 27.0.0 / arm64；Node v24.22.1；执行时间 2026-11-20 02:09–02:12 CST

## 0. 状态声明

**本轮验收未执行：BLOCKED。** 验收前置条件“完整根门禁 `corepack yarn check` 通过”未满足（`EXIT=1`），
按计划 Task 9 的硬性约束在门禁失败时停止验收。七项用户验收步骤全部为 **NOT RUN**；
本文件不声称任何一步通过，也不包含任何 UI 截图或模型生成的 Artifact。

本轮未启动桌面应用、未创建临时 `DSH_HOME`、未写入任何真实会话或生产数据，也未修改源码或测试。

## 1. 门禁结果（实际执行）

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `corepack yarn check` | **1** | 318 个测试文件：313 通过 / 1 失败 / 4 跳过；4630 个用例：4614 通过 / 1 失败 / 15 跳过；其余 workspace 无失败记录 |

日志：`.superpowers/sdd/2026-11-15-task-result-artifacts/final-check.log`（仓库外，末行 `EXIT=1`）。

唯一失败用例：

```text
FAIL  tests/huaanwork-host/test-port-mapping.spec.ts > legacy loop cases reconcile to 61 rows with a four-state label
AssertionError: two parallel script tasks do not lock workspace.open
  tests/huaanwork-host/automations-host.spec.ts:1271: expected '' not to be ''
```

### 1.1 失败原因（已定位）

- `tests/huaanwork-host/test-port-mapping.ts:274-279` 仍把该移植行的证据钉在
  `tests/huaanwork-host/automations-host.spec.ts:1271`，且行标题仍是旧名
  `two parallel script tasks do not lock workspace.open`（实际用例自 `10b1e35f01`
  起名为 `two parallel script tasks on different roots do not lock workspace.open`，
  现位于该文件第 1642 行）。
- 钉行断言只检查该行非空。Task 8 门禁通过的提交 `861d4c2117` 上，第 1271 行是非空内容；
  最终修复提交 `48c36b134e` 在文件前部新增 18 行（`@@ -54,6 +54,23 @@` 新增 17 行、
  `@@ -424,6 +441,7 @@` 新增 1 行），使第 1271 行变为空行，钉行断言因此失败。
- 该失败是**测试证据行号漂移**，不是产品行为回归；Task 8 的 `EXIT=0` 记录（同目录
  `task-8-check.log:1263` 该 spec 通过、`:2983` `EXIT=0`）只对应提交 `861d4c21`，
  对当前 HEAD 不再成立。
- 本轮范围只允许验收证据，不允许修改源码或测试，因此未修复该钉行。

### 1.2 对验收的影响

计划 Task 9 明确规定：根门禁出现非零退出码时记录结果并停止验收，不得在红色基线上执行
GUI 验收。因此 §12.2 的七项步骤未启动；任何“已走查/已截图”的表述都会失实。

## 2. Electron 沙箱探针（实际执行，未通过）

Task 6 的探针此前为 NOT RUN；本轮在图形会话中实际执行两次：

| 命令 | 时间 | 结果 |
| --- | --- | --- |
| `corepack yarn workspace dsh-plugin-huaanwork test:artifact-sandbox` | 02:11:21 | 1 个用例失败：`Test timed out in 30000ms`，耗时 30005 ms |
| `corepack yarn workspace dsh-plugin-huaanwork vitest run --config vitest.artifact-sandbox.config.ts --testTimeout=120000` | 02:12:02 | 同样在 30000 ms 超时（显式覆盖未生效），耗时 30006 ms |

两次运行都遗留了隐藏的探针 Electron 进程（PID 79553、79650，命令行均为
`electron ... tests/electron/artifact-sandbox-main.mjs`）；已按 PID 单独终止，未触碰其他进程。

结论：探针 **NOT PASSED（启动挂起/超时）**，与 Task 6 记录的非阻断遗留项
“probe launch hang leaves orphan Electron; add launch timeout”一致。该结果不能作为
规格 §12.1 第 9 条或 §12.2 第 4 条的真实 renderer 隔离证据。

## 3. 规格 §12.2 七项步骤逐条记录

| # | 步骤 | 结论 | 说明 |
| --- | --- | --- | --- |
| 1 | Markdown 报告与 HTML 交互结果的唯一展示 | NOT RUN（BLOCKED） | 未启动应用；门禁 `EXIT=1`。 |
| 2 | 卡片点击与右侧预览 | NOT RUN（BLOCKED） | 同上；未创建卡片或预览截图。 |
| 3 | 独立全屏窗口 | NOT RUN（BLOCKED） | 同上；未创建全屏窗口，未采集双 ID/鉴权/access header 记录。 |
| 4 | HTML 交互与隔离 | NOT RUN（BLOCKED） | 同上；§2 的独立探针也未通过，不能替代该步骤。 |
| 5 | 下载另存为 | NOT RUN（BLOCKED） | 同上；未打开系统保存对话框。 |
| 6 | 刷新与历史重开 | NOT RUN（BLOCKED） | 同上；未构造“未定位的历史结果”分组。 |
| 7 | 自动化新旧协议并存 | NOT RUN（BLOCKED） | 同上；未运行自动化或写入 RunSummary 夹具。 |

每步的证据（执行环境、命令、输出/截图、结论）按要求记录：本轮只有执行环境与阻塞原因，
没有可引用的操作输出或截图，因此按 NOT RUN 记录，不补造证据。

## 4. 未执行的操作

- 未启动工作区 Electron，也未复制 `~/.huaanwork` 到临时实例；生产数据未被触碰。
- 未创建或种子化任何 Artifact、会话、自动化运行记录。
- 未截取任何截图，未调用 `artifact.*` RPC。
- 未修改产品源码、测试或共享夹具。

## 5. 解除阻塞所需步骤（后续任务）

1. 修正 `tests/huaanwork-host/test-port-mapping.ts` 中该行的证据行号（并同步过时标题），
   使钉行重新指向真实用例行。
2. 在修复提交上重新运行 `corepack yarn check`，确认 `EXIT=0`。
3. 再按计划 Task 9 的 CDP 临时实例配方执行 §12.2 七项走查并更新本文件；
   在门禁恢复绿色之前，本文件的七项结论保持 NOT RUN。

## 6. 结论

- 门禁：`corepack yarn check` `EXIT=1`（1 个测试证据钉行失败，已定位到 `48c36b134e`
  的测试行插入与 `test-port-mapping.ts` 的过时行号）。
- Electron 探针：启动超时，未通过；两枚遗留进程已清理。
- 规格 §12.2：0 项通过、0 项夹具辅助、7 项未执行（BLOCKED）。
- 未以单测、探针或门禁结果替代真机验收；本轮不宣称任何用户验收通过。
