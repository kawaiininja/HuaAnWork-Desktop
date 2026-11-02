# 聊天工具面板（chat tool panel）验证证据（Task 10 root 门禁 + Task 11 真实图形界面）

记录时间：§1–§10（Task 10）为 2026-11-02 20:13–20:29；〈Task 11〉一节分两段，11A 为 22:16–22:42、11B 为 23:00–23:15（均为本地 UTC+8，各节开头另有记录）。仓库：`/Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop`。主机：macOS 27.0.1（26A434），arm64。

本文件记录两轮实际执行的结果：(a) **Task 10（Root 完整门禁与可审计证据）**——串行运行三条 root 命令，逐条记录真实 exit code 与汇总，并核对工作树（§1–§10）；(b) **Task 11（真实图形界面与受控异常验收）**——真实 GUI 走查、受控模拟、D1 复验与裁决（〈Task 11 — 真实图形界面与受控异常验收〉起至文末）。**本文件只记录实际执行过的内容**；未执行的条目见 11A §4 与 11B §6 的未执行清单，不得视为通过。

本次运行**没有任何 commit / add / stash / 分支操作**（用户明确要求本轮不提交）；所有功能改动仍为未提交的工作树变更。

## 1. 结论摘要

| # | 命令 | Exit code | 耗时（墙钟） | 汇总 |
|---|---|---|---|---|
| 1 | `corepack yarn test` | **0** | ~83 s（20:14:03 → 20:15:26） | 12 个 workspace 全部执行：vitest 4303 passed / 14 skipped；node:test 162 passed / 2 skipped；**0 failed** |
| 2 | `corepack yarn typecheck` | **0** | 23.6 s（20:19:25 → 20:19:48） | 8 个 workspace 类型检查通过；唯一输出 `contract-types: 4 generated type files are current` |
| 3 | `corepack yarn check` | **0** | 160.2 s（20:20:02 → 20:22:42，`time` 报 `2:40.19 total`） | 完整链路走完并退出 0：`check:whitespace` → `check:layout` → `test:aa-connector` → 9 个 workspace `check`（含 build/typecheck/test/verify:*） |

三条命令**串行**执行，互不重叠，期间未运行其他门禁（仓库已知 `verify:aa` 并发进程竞态，见 `AGENTS.md` 技术债表）。没有出现网络、npm/registry、AA、market 环境失败；三条命令本身也**不包含** `market:check` / `aa:check` 的远端新鲜度查询（见 §8）。

## 2. 环境与被验证的代码

| 字段 | 值 |
|---|---|
| 执行日期 | 2026-11-02（本地 UTC+8） |
| Node.js | `v22.23.2`（满足 `^22.19.0 \|\| >=24.0.0`） |
| Yarn | `4.18.0`（Corepack） |
| 测试运行器 | vitest `4.1.8`（5 个 workspace）+ `node --test`（7 个 workspace） |
| 主机 | macOS 27.0.1（26A434），arm64 |
| HEAD | `ff897f713cddeec9bb516db8823aba5dc887de7a`（`docs: close tool panel goal completion gap`） |
| Harness pin（`HEAD:deepseek-harness`） | `1600d8a1e140dcde43a1a0941940a0480712c011`（`dsh-v0.2.1-rc.1`） |
| 工作树快照（`dsh-plugin-huaanwork` + `docs`） | `7dd42511899e5470073e4495736a35c909619d96`——与 Task 9 收尾树一致，证明三条门禁未改动受版本控制的功能文件 |

快照的取法（与 `.superpowers/sdd/2026-11-02-chat-tool-panel/snapshot.sh` 相同，但索引放在 `/tmp`，不触碰仓库内 `scratch-index`）：

```bash
GIT_INDEX_FILE=/tmp/huaanwork-task10/scratch-index git read-tree HEAD
GIT_INDEX_FILE=/tmp/huaanwork-task10/scratch-index git add -A -- dsh-plugin-huaanwork docs
GIT_INDEX_FILE=/tmp/huaanwork-task10/scratch-index git write-tree
# 7dd42511899e5470073e4495736a35c909619d96
```

## 3. 执行顺序

严格串行，前一条退出后才启动下一条：

1. 20:14:03 `corepack yarn test` → 20:15:26 结束，exit 0
2. 20:19:25 `corepack yarn typecheck` → 20:19:48 结束，exit 0
3. 20:20:02 `corepack yarn check` → 20:22:42 结束，exit 0

（门禁之间只做了日志读取，没有并发进程。）

## 4. Gate 1：`corepack yarn test`

```bash
corepack yarn test
```

**Exit code：`0`**（日志末行 `EXIT_CODE=0`）。命令按 root `package.json` 的 `test` 脚本依次运行 12 个 workspace：

### 4.1 vitest workspace

| workspace | 文件 | 用例 |
|---|---|---|
| `dsh-plugin-huaanwork` | 270 passed \| 4 skipped（274） | 3588 passed \| 14 skipped（3602） |
| `dsh-community-market` | 13 passed | 303 passed |
| `market-server` | 14 passed | 244 passed |
| `update-server` | 5 passed | 88 passed |
| `agent-catalog-server` | 5 passed | 80 passed |

### 4.2 `node --test` workspace

| workspace | 用例 |
|---|---|
| `@huaanwork/policy` | 64（62 pass / 2 skip） |
| `@huaanwork/model` | 10 passed |
| `@huaanwork/git-tools` | 8 passed |
| `@huaanwork/web-tools` | 19 passed |
| `@huaanwork/catalog-signing` | 13 passed |
| `@huaanwork/agent-package-format` | 35 passed |
| `agent-catalog-admin` | 15 passed |

合计：vitest **4303 passed / 14 skipped**，node:test **162 passed / 2 skipped**，总计 **4465 passed / 16 skipped / 0 failed**。日志中 `not ok` 计数 = 0，`FAIL` 计数 = 0。

### 4.3 本功能定向用例确实在 root 面执行

- `tests/client-huaanwork/ToolPanelComponent.spec.ts (4 tests)`——`✓ 41ms`
- `tests/client-huaanwork/toolPanel.spec.ts (16 tests)`——`✓ 4ms`

### 4.4 14 个跳过用例

与 Task 9 记录的基线一致（4 个整文件跳 + 5 个部分跳，全部是 Windows 平台门、`LIVE` 环境门或本机缺 `fish` 的环境门），逐条归因见 `.superpowers/sdd/2026-11-02-chat-tool-panel/task-9-report.md` §Step 3a。本轮跳过数与基线相同（14），无新增跳过。

### 4.5 日志中的预期噪音

`renderer failed to load (-105/-102)`、`renderer boot failed`、`renderer process gone`、`Confirmed restart failed: shutdown coordinator is not ready` 等行来自负例 fixture（`tests/electron-runtime.spec.ts` 等），与既有基线一致，不是失败。

## 5. Gate 2：`corepack yarn typecheck`

```bash
corepack yarn typecheck
```

**Exit code：`0`**，耗时 `23.607 total`。完整输出仅一行：

```text
contract-types: 4 generated type files are current
```

root `typecheck` 脚本覆盖 8 个 workspace：`dsh-plugin-huaanwork`、`dsh-community-market`、`market-server`、`update-server`、`@huaanwork/catalog-signing`、`@huaanwork/agent-package-format`、`agent-catalog-server`、`agent-catalog-admin`。`dsh-plugin-huaanwork` 的五套 tsconfig（含 `tsconfig.tests.client.json`，覆盖本功能新增的 `ToolPanel.tsx` / `logic/toolPanel.ts` / 两个 spec）在本步中无诊断输出。

## 6. Gate 3：`corepack yarn check`

```bash
corepack yarn check
```

**Exit code：`0`**，`time` 输出 `corepack yarn check  212.07s user 40.14s system 157% cpu 2:40.19 total`。链路**全部走完**，最后一阶段为 `agent-catalog-admin`（15 个 node:test 用例全过），随后 `EXIT_CODE=0`。

### 6.1 阶段与实测输出

| 阶段 | 实测输出（原文摘录） |
|---|---|
| `check:whitespace` | `check-whitespace` 自测 7 passed；实际 whitespace 检查无输出（干净） |
| `test:market-release` | 6 passed |
| `test:aa-release` | 14 passed |
| `check:bilingual-docs` | 4 passed；`verify-bilingual-docs: 50 records and 100 documents are consistent` |
| `check:architecture` | 25 passed；`verify-market-dependency-direction: 441 tracked source files respect the market dependency direction …; 8 market wrapper files carry no registry bypass of the signed manifest …` |
| `check:vendored-runtime` | `sync-vendored-runtime: huaanwork 341 packages from 1600d8a1e1 are verified` |
| `verify-layout` | `verify-layout: HuaAnWork and retained workspaces are consistent with upstream 1600d8a1e1` |
| `test:gate-scripts` | 3 passed |
| `check:readme-versions` | 6 passed；`verify-readme-versions: 4 hardcoded artifact version string(s) in 1 scoped package(s) (dsh-plugin-huaanwork) match their own package.json` |
| `test:aa-connector` | 3 passed |
| `dsh-community-fabric` check | `verify-fabric-docs: 20 Markdown files and 10 bilingual pairs are consistent` |
| `dsh-community-market` check | `verify-market-docs: 12 Markdown files, 6 bilingual pairs, and 4 schemas are consistent`；build `✓`；`verify-package-exports: 4 type exports exist`；`verify-market-client-loader: dsh-community-market registered one client module`；`tsc -p tsconfig.tests.json --noEmit` 通过；test 13 files / 303 passed |
| `dsh-plugin-huaanwork` check | build `✓`（tsdown：ESM `186 files, total: 5.76 MB` / preload `4 files` / bin `2 files`；vite client `✓ built in 211ms`、native-ui `✓ built in 155ms`）；typecheck 通过；test 270+4 files / 3588+14 tests（与 Gate 1 相同，含两个 ToolPanel spec）；`verify-runtime-closure: 316 first-party nodes form a closed reachable runtime graph.`；`verify-bundled-runtime: 131 files checked; 9 bundled packages are inlined; tar is compiled into lib`；`verify:cli` 无输出（链继续）；`verify:loader` 无输出（链继续）；`verify-profile-boot: minimal preset, plugin manager, and disabled hmr lock passed`；`verify:host` 35 passed；`verify:aa` → 再次 `verify-profile-boot: minimal preset, plugin manager, and disabled hmr lock passed`；`verify-licenses: 636 packages checked (9 bundled); 2 use notice-required licenses (LGPL-3.0-or-later)`；`verify-operation-reliability: 7 operations and 18 fault contracts verified.` |
| `market-server` check | typecheck 通过；test 14 files / 244 passed |
| `update-server` check | typecheck 通过；test 5 files / 88 passed |
| `@huaanwork/catalog-signing` check | test 13 passed；typecheck 通过 |
| `@huaanwork/agent-package-format` check | test 35 passed；typecheck 通过 |
| `agent-catalog-server` check | typecheck 通过；test 5 files / 80 passed |
| `agent-catalog-admin` check | typecheck 通过；test 15 passed（链的最后一阶段） |

`verify:cli` / `verify:loader` 成功时不打印内容；它们各自未产生输出，整体 `check` exit 0 说明 `&&` 链上每一步（含二者）都返回 0——本轮**没有单独观察**二者的独立 exit code。

### 6.2 gate 内 vitest 汇总

与 Gate 1 相同：`dsh-plugin-huaanwork` 3588 passed / 14 skipped（270 + 4 files），`dsh-community-market` 303，`market-server` 244，`update-server` 88，`agent-catalog-server` 80；`ToolPanelComponent.spec.ts (4 tests)` 与 `toolPanel.spec.ts (16 tests)` 在本 gate 中同样全绿。

### 6.3 预期噪音与既有告警（非失败）

- `dsh-plugin-desktop-profile-smoke: warning: 2 entries did not activate` + `web-fetch-http … pending (waiting for service: web)`、`job-controller … pending (waiting for service: jobs)`：由 M3 guardrail 关闭 jobs/web 行导致，见 `docs/huaanwork-dev-launch.md:58` 与 `docs/evidence/2026-10-29-single-desktop-phase-b.md:59`，`verify:profile` / `verify:aa` 均照常 exit 0。
- `dsh-plugin-huaanwork-host-loop-smoke: warning: 2 entries did not activate`（同一对 pending 项）出现于 `verify:host` 的 TAP 头。
- 负例 fixture 输出同 §4.5；`Error: crash here` / `audit write failed: EISDIR|ENOENT` 等行来自故障注入用例。
- `contract-types: 4 generated type files written`（注意是 written，Gate 2 为 current）：`check` 内重新生成契约类型；运行后工作树无新增改动（§7）。
- 日志中 `not ok` 计数 = 0，`FAIL` 计数 = 0。

## 7. 工作树核对（Step 4）

```bash
git status --short
git diff --check
```

### 7.1 门禁前（20:13，三条命令启动前）

27 条记录：**17 个已修改文件 + 10 个未跟踪条目**。

已修改（17，均为本功能及其设计文档）：`docs/superpowers/specs/2026-11-01-chat-tool-panel-design.md`、`dsh-plugin-huaanwork/src/client-huaanwork/{App.tsx,logic/commandOutcome.ts,logic/sessionChannel.ts,logic/turnStatus.ts,rpc-types.ts,styles.css,styles.generated.ts}`、`dsh-plugin-huaanwork/src/huaanwork-guardrails/bridge.ts`、`dsh-plugin-huaanwork/src/huaanwork-host/session-view.ts`、7 个测试文件（`tests/client-huaanwork/{appWiring,commandOutcome,outcomeCheck,sessionChannel,turnStatus}.spec.ts`、`tests/huaanwork-guardrails/bridge.spec.ts`、`tests/huaanwork-host/session-view.spec.ts`）。

未跟踪（10）：

| 条目 | 归属 |
|---|---|
| `.gstack/`、`.qoder/` | 用户原有工具/会话目录，**不属于本功能**，不得加入功能提交 |
| `docs/superpowers/plans/2026-10-31-single-desktop-maintenance-code-review.md` | 既有设计评审文件，**不属于本功能** |
| `docs/superpowers/plans/2026-11-02-chat-tool-panel-plan-review.md`、`docs/superpowers/plans/2026-11-02-chat-tool-panel.md`、`docs/superpowers/specs/2026-11-01-chat-tool-panel-design-review.md` | 本功能的计划/评审工件（用户策略下不提交） |
| `dsh-plugin-huaanwork/src/client-huaanwork/ToolPanel.tsx`、`dsh-plugin-huaanwork/src/client-huaanwork/logic/toolPanel.ts`、`dsh-plugin-huaanwork/tests/client-huaanwork/ToolPanelComponent.spec.ts`、`dsh-plugin-huaanwork/tests/client-huaanwork/toolPanel.spec.ts` | 本功能新增源码/测试（因不提交而保持未跟踪） |

### 7.2 门禁后（写本文件之前）

- `git status --short`：与门禁前**逐条相同**（仍为 17 + 10），门禁未产生受版本控制的改动。
- 工作树快照 `7dd4251…`（§2）与 Task 9 收尾树一致。
- `git diff --check`：**无输出，exit 0**。

### 7.3 写入本文件之后（最终核对）

`git status --short` 在上述 27 条基础上新增且仅新增一条：

```text
?? docs/evidence/2026-11-02-chat-tool-panel-verification.md
```

`git diff --check` 仍**无输出，exit 0**（`git diff --check` 只检查已跟踪文件的改动，不覆盖未跟踪文件；这与仓库 `check:whitespace` 的口径一致）。

## 8. 未执行 / 未验证项

| 项 | 状态 |
|---|---|
| **Task 11 真机/受控模拟：Task 10 执行时未执行** | 图形应用启动与 GUI 走查属 Task 11，Task 10 明确不执行。Task 11 的实际执行结果、受控模拟与未执行项见下文〈Task 11 — 真实图形界面与受控异常验收〉（含〈11B 复验与裁决〉§6 未执行清单）；本节只描述 Task 10 的范围 |
| 图形应用启动（`corepack yarn dev` / `start`） | 未执行（root 门禁全部 headless） |
| 打包（`dist:mac`、`dist:mac-smoke`、`dist:win`、`dist:win-portable`）与安装器/发行制品校验 | 未执行（不在本任务范围） |
| CI（GitHub Actions） | 未执行（本轮为本地门禁） |
| `corepack yarn market:check` / `corepack yarn aa:check` 远端新鲜度 | 未执行；三条命令不包含它们，故「市场/AA 远端最新」未被本轮证明。本轮也未出现任何 registry/网络失败 |
| Windows 平台用例 | 按基线跳过（14 个 vitest 跳过项的归因见 §4.4），本机 darwin 无法执行 |
| 提交 | 按用户策略**未提交**，工作树改动保持未跟踪/已修改状态 |

## 9. 日志指针

完整原始日志（临时目录，重启后可能被清理；命令与摘录足以重放）：

| 文件 | 内容 | 行数 |
|---|---|---|
| `/tmp/huaanwork-task10/yarn-test.log` | Gate 1 完整输出（末行 `EXIT_CODE=0`） | 1870 |
| `/tmp/huaanwork-task10/yarn-typecheck.log` | Gate 2 完整输出（含 `time`，末行 `EXIT_CODE=0`） | 3 |
| `/tmp/huaanwork-task10/yarn-check.log` | Gate 3 完整输出（含 ANSI 颜色，末行 `EXIT_CODE=0`） | 2380 |
| `/tmp/huaanwork-task10/yarn-check.clean.log` | Gate 3 去除 ANSI 的可读副本 | 2380 |
| `/tmp/huaanwork-task10/env.log` | 日期/Node/Yarn/OS/HEAD/harness pin | 8 |
| `/tmp/huaanwork-task10/git-status-short-final.log` | 最终 `git status --short`（28 条记录 + `STATUS_EXIT=0`） | 29 |
| `/tmp/huaanwork-task10/git-diff-check-final.log` | 最终 `git diff --check`（空输出 + `DIFFCHECK_EXIT=0`） | 1 |

## 10. 诚实性说明

- 所有 exit code 均为实际观察值（三个日志末行）。`check` 的**整体** exit 0 是直接观察；链内单步 exit code 未逐一捕获，只记录了可观察的阶段输出。
- 未复现任何由本功能引起的失败；未修改源码、测试或断言，未放宽任何期望。
- 门禁产生幂等产物（`lib/` 构建、契约类型重写），运行后工作树逐条核对无差异。
- 计算工作树快照时 `git add` 打印了 4 条 `nuwa-skill` 文件的 CRLF 警告（既有文件，非门禁步骤，非失败）。

## Task 11 — 真实图形界面与受控异常验收

本节分两段记录：**11A**（§1–§6，2026-11-02 22:16–22:42，D1 修复前的首轮走查）与 **11B**（文末〈11B 复验与裁决〉，D1 修复后的复验、D2/D5 裁决、6.4/6.5 收口与清理）。**11A 的观察文本大部分保留，但多个单元格已被 11B 编辑或补充，判定单元格整体更新为 11B 收口后的结论**：4.2、5.1、5.2、5.4 的「判定」列写的是 11B 的结论（观察列以「**【11B …】**」追加），5.2/5.4(b) 的判定与 D1/D2/D5 的严重度列被改写，若干单元格补入了证据强度说明（「stdout 未留存」「见 11B §7」），并就地订正了错误的截图引用（Step 2.1、5.1 中的 `shots/12`、`14`）。因此本节的表格**不是** 11A 当时的判定快照：11A 当时的判定只能通过保留下来的 11A 原文（「11A：…」句子与被标注为 11A 的观察）以及 11A §4 未执行清单追溯；凡与 11B 结论冲突处，以 11B 为准。

**11A 走查（D1 修复前）**

记录时间：2026-11-02 22:16–22:42（本地 UTC+8）。图形应用**已在运行**且未被重启：隔离 `DSH_HOME=/tmp/huaanwork-tool-panel-6ccPS8`（自生产数据复制、独立 userData），CDP 端口 9333，模型 `deepseek-chat`。未触碰 `~/.huaanwork` 与 `~/Library/Application Support/HuaAnWork`，未提交任何改动，未修改源码/测试。

工件目录（仓库外）：`/Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/.superpowers/sdd/2026-11-02-chat-tool-panel/task11-artifacts/`——`cdp.mjs`（CDP 驱动）、`evals/`（可复用 eval 脚本）、`disconnect.mjs` / `disconnect-flow.mjs`（受控断连）、`shots/`（截图）、`fixtures-original/`（被修复前的两份历史 fixture 原始文件）。

11A 范围：重拍特殊卡、历史恢复、受控断连模拟，并为 Step 2–4 给出基于既有工件 02–06 与本轮复核的判定。目标顺序（Step 6 第 4/5 条）与最终汇总留给 11B。

### 1. 判定总表

| 计划项 | 判定 | 实际观察 / 证据 |
|---|---|---|
| Step 2.1 同回合多次调用只出一个面板，无散落工具行 | 真实 UI（面板数与聚合有截图；「无散落行」为 DOM-only） | 首回合 read+grep+bash 只有一个面板「工具 · 已完成 · 3 项调用」，三个条目同属一块（`shots/02-expanded-details.png` 顶部即该面板标题，下面依次是 grep、bash 两个条目）；`.chat-log` 直接子节点只有气泡/面板/note、无 `.tool-row` 散行来自 11A 的 DOM 读取，**stdout 未留存**（证据强度见 11B §7）。11A 曾在此引用 `shots/12-real-history-results.png`，该引用**是错的**：shot 12 拍到的是后续回合（子代理被提前停止）的画面，不显示首回合面板 |
| Step 2.2 展开单项：参数/结果对应、长输出面板内滚动、自动换行 | 真实 UI | `shots/02-expanded-details.png`：grep 项展开显示参数 `{"pattern":"beta","path":"…/src"}` 与「Found 2 matches」结果，上方 read 长输出在面板体内溢出滚动（同图可见面板内滚动条）；本轮再次展开 goal 面板两项（`shots/11-goal-history-entries.png`） |
| Step 2.3 Tab 聚焦标题，Enter/Space 与 `aria-expanded` 一致 | 真实 UI（本轮键盘复核；DOM-only） | `tool-panel-title` 聚焦后 Enter：`aria-expanded` true→false 且面板体移除；Space：false→true 且面板体出现。该结论来自 `evals/after-key.js` 的 DOM 读取，**stdout 未留存**，无截图，不可重放（证据强度见 11B §7） |
| Step 2.4 状态区只播报状态迁移 | 部分未执行 | 可访问性树中面板标题为 `button`，带 `expanded`/`controls`（`node cdp.mjs ax`）；未用读屏验证「只播报迁移、不重复播报」 |
| Step 3.1 无正文默认展开、正文出现后收起 | 真实 UI | request_input 回合：正文未出现时面板「执行中」展开并含条目（`shots/15-request-input-card.png`）；回答后助手文本出现，面板变为「已完成」且可见区域内不再有条目（`shots/16-request-input-answered.png`，收起态目视可见；「条目不在 DOM」这一更强表述来自 DOM 读取，stdout 未留存） |
| Step 3.2 手动展开后切换标签返回仍展开 | 真实 UI（DOM-only） | 首面板手动展开 → 切到「自动化」→ 返回同一任务，`aria-expanded=true`、面板体仍在。来自 `evals/back-and-focus.js` 的 DOM 读取，**stdout 未留存**，无截图（证据强度见 11B §7） |
| Step 3.3 自动化运行回复折叠为附件时默认收起 | 未执行 | 隔离环境未重跑该流程 |
| Step 3.4 连续两回合各留独立面板；后台标签结束不影响当前标签 | 部分（DOM-only） | 14–19 个用户回合计 14–19 个独立面板（每回合一个），来自 DOM 计数（**stdout 未留存**，见 11B §7）；「后台标签结束事件」未单独构造 |
| Step 4.1 工具失败仅该工具与摘要显示失败 | 真实 UI | `shots/04-failed-tool.png`（bash `exit 3`，标题「含失败调用 · 2 项调用」）；`shots/22-todo-without-panel.png`（todo_write 参数缺失） |
| Step 4.2 运行中取消：未结束工具显示已中断 | 真实 UI，按 11B 裁定关闭（D5） | `shots/05-cancelled.png` 与本轮复跑 `shots/27-cancel-running-tool.png`：取消后该工具显示 **失败**，结果文本为 `Error: tool call aborted`（shot 27 只展开到「参数」行，标题/状态可见、结果文本被下沿截断）；回合 note「已停止」只在点击瞬间截图 `shots/34-cancel-immediate.png` 中可见（05/27 两图不含该 note）；不是「已中断」（见缺陷 D5）。**【11B】** 点击停止后每 60 ms 采样 45 次（2.744 s）：`dt=0`（点击后同帧）仍为「运行中」，`dt=63 ms` 起稳定为「含失败调用」；**「已中断」在全部 45 次采样中未出现**（`everInterrupted:false`），即 60 ms 采样粒度下未观察到渲染过推断态的窗口（采样输出未留存，见 11B §7；`shots/34-cancel-immediate.png` 为点击瞬间截图，面板已收起、标题已是「含失败调用」且带「已停止」note）。最终失败态是真实终态结果，与 spec line 211 一致 ⇒ 按裁定不作为缺陷 |
| Step 4.3 全部工具结束后取消/失败/final 默认收起 | 部分 | 失败（22）与正常 final（16/25）均收起；「取消后的 final」未单独截图 |
| Step 4.4 审批（批准与拒绝） | 部分 | 批准：`shots/06-approval-card.png`、`06-approval-approved.png`（「已批准」+ 后续工具面板 + 脚注「命令未通过」）；**拒绝未执行** |
| Step 4.4 request_input：底部回答与取消 | 真实 UI | 回答：`shots/15`→`16`（卡片「已回答：7」，助手「已收到你的答案」）；取消：`shots/17`、`18`（卡片「问题已关闭，不再等待回答」，面板「含失败调用」，条目「request_input 失败」+ `Error: 用户取消了这个问题`） |
| Step 4.4 todo_write：非空/空 todos | 真实 UI | 非空：`shots/21-todo-with-card.png`（「待办 / 待做 检查 README / 搜索 beta / 统计行数」）；空：`shots/22-todo-without-panel.png`（面板内「todo_write 失败」+ `missing required property "todos"`） |
| Step 4.4 显式子代理运行卡更新 | 真实 UI（DOM-only；运行卡外观有截图） | `@code-reviewer` 提及后 0.5 s 出现运行卡（DOM：「启动中 @code-reviewer v1.0.0 终止 启动中」），数秒后同一卡变「已完成 @code-reviewer v1.0.0 已完成 00:02」；`shots/19-subagent-run-card.png`、`shots/20-subagent-run-card-done.png`——**两图 MD5 相同**（`cc3bfc70…`，356 528 B），是同一帧的两次保存，只证明「已完成」那一帧，不证明「启动中→已完成」的迁移；该迁移只有 DOM 读取、**stdout 未留存**（证据强度见 11B §7） |
| Step 4.5 特殊卡不进入面板；无 todos 的 todo_write 作为普通工具进面板 | 真实 UI（DOM-only） | 实测 `.tool-panel .ask-card = 0`、`.tool-panel .todo-card = 0`、`.tool-panel .subagent-run-card = 0`；无 todos 的 todo_write 面板数 16→17 并含失败条目。来自 `evals/card-isolation.js` 与面板计数的 DOM 读取，**stdout 未留存**，无截图（证据强度见 11B §7）；不过 `shots/21-todo-with-card.png` 目视可见该 todo 回合只有待办卡、没有工具面板（可作旁证，但 `.tool-panel` 计数本身仍是 DOM-only）；无 todos 的失败条文案有截图：`shots/22-todo-without-panel.png` |
| Step 5.1 历史恢复：面板默认收起；成功/失败/空/截断结果可展开 | 真实 UI，**11B 复验通过（D1 已修复）**；入口为侧边栏 `selectSubtask` 替代路径（计划字面的「从只读历史页选择『继续此会话』」入口未执行） | 11A：首任务 14 个面板全部 `aria-expanded=false`；展开三项：read/grep/bash 全部显示「完成 / 结果 无输出」；`exit 3` 的失败调用在历史里也显示「完成」（11A 曾引 `shots/12`、`14`，**该引用是错的**：两图拍到的是后续回合的子代理被停止画面，不显示这些面板）——见缺陷 D1。**【11B 复验（Task 12 修复后重建）】** 22 个面板全部 `aria-expanded=false`（DOM 计数，`evals/11b-open-first.js`，**stdout 未留存**，见 11B §7）；read 恢复真实文本含 `TOOLPANEL-SANDBOX-7Q2`（`shots/28-history-results-reverified.png`，该图只显示 read 一项展开，grep/bash 两项在面板内滚动区外、未入画）；`exit 3` 恢复为「bash **失败**」+ `(no output) [exit code: 3]`（`shots/29-history-failure-reverified.png`）；空输出 `sleep 20` 为「完成 / `(no output)`」（仅 DOM 读取 `evals/11b-empty-success.js`，**无截图**）；`seq 1 20000` 为「完成 **已截断**」，结果 32 902 字符、保留头尾（`shots/32-history-truncated-reverified.png`）。**入口口径**：本环境唯一的「继续此会话」入口是侧边栏子任务点击（`selectSubtask`，先 `session.resume` 再 `session.open`），不是计划字面的只读页入口；判定保留在「侧边栏路径」上，只读页入口见 11B §6 未执行清单 |
| Step 5.2 旧历史只有调用无结果：标题与单项「结果未记录」，结果区「历史记录未保存结果」 | 未通过（11B 裁决：D2 路径限制） | `shots/13-history-missing-result.png`：标题「工具 · 已完成 · 1 项调用」、条目「完成」、结果「无输出」；未出现「结果未记录」/「历史记录未保存结果」（见 D1/D2）。**【11B 复验（D1 修复后）】** `shots/33-missing-result-reverified.png`：同一 fixture 仍先 `session.resume` 再 `session.open`，宿主把未结束尾部修补成一条中断结果 ⇒ 面板显示「含失败调用」+ 结果文本 "The tool call was interrupted after it was recorded, but no result was durably recorded. Its outcome is unknown…"。11A 的「完成 + 无输出」（误导性）已消失，但计划字面文案在该侧边栏路径上仍**不可达**；只读（先 open 不 resume）路径本环境无可达会话日志，未执行 |
| Step 5.3 子任务恢复 / 运行记录回填的历史语义 | 未执行 | 隔离环境无可达且日志完整的对应路径（运行记录会话在临时 DSH_HOME 中不存在） |
| Step 5.4（a）goal 续轮恢复：续轮 note、仍只有一个默认收起面板 | 真实 UI，11B 复验通过 | `shots/09-goal-history.png`：唯一 note「正在按目标继续，第 2/4 轮，这还不是验收结果」+ 单个 `aria-expanded=false` 面板「工具 · 已完成 · 2 项调用」；展开后 2 项（`10`、`11`）。原始 goal 用户消息未作为新 user 气泡出现。**【11B 复验（D1 修复后）】** `shots/30-goal-history-reverified.png`：日志子节点可见 `bubble user`「开始整理 src 目录」+ 单个折叠面板 + 唯一 note（折叠为目视可见；`aria-expanded=false` 与「直接子节点只有这三类」来自 DOM 读取，`stdout` 未留存，见 11B §7）；`shots/31-goal-history-expanded-reverified.png`：展开后 read 结果 `# Task 11 scratch workspace` 为真实文本；同面板 bash 条目只到**参数行**（`{"command":"wc -l src/long.txt"}`），结果被面板下沿截断——该行真实结果 `200 src/long.txt` 只在 DOM 中读到、**无截图** |
| Step 5.4（b）只读历史页仍逐条显示 goal 原始用户消息 | **未执行** | 只读 `HistoryDetailPane` 在本环境唯一可达的入口（自动化 → 运行记录 → 运行行）显示 `session … was not found`（`shots/26-readonly-history-pane.png`），无逐条日志可观察 ⇒ 本款未执行、不得视为通过（已列入 11B §6 未执行清单）。11A 一度把整条 5.4 记为「真实 UI，11B 复验通过」，这是**过度声明**：通过范围只有（a） |
| Step 5.5 只读 `HistoryDetailPane` 仍逐条显示 tool-call/tool-result | 未执行 | 面板可达（自动化 → 运行记录 → 运行行，`shots/26-readonly-history-pane.png`，无「继续此会话」按钮），但显示「session … was not found」，无逐条日志可观察 |
| Step 6.1 断连后标题/单项/回合条「状态未确认」，无正在执行/正在思考，完成/失败事实保留 | 受控模拟 | 关闭页面全部 WebSocket 后 120 ms：面板「工具 · 状态未确认 · 1 项调用」、条目「…bash 状态未确认」、回合条「工具状态未确认」，日志中无「正在执行工具/正在思考」，此前「已完成」面板不变（`shots/23-disconnect-immediate.png`） |
| Step 6.2 ready 后恢复真实执行、迟到 tool/end 按 callId 更新、连接恢复不补成功 | 受控模拟 | 2.6 s 后同一面板回到「执行中 / 运行中」（`shots/24-disconnect-reconnected.png`）；`sleep 20` 的真实结束事件到达后同一卡变「完成」——`shots/25-disconnect-late-result.png` 只显示该卡标题「bash 完成」与参数行（`{"command":"sleep 20",…}`），**结果 `(no output)` 与「恢复瞬间未标成功」来自同轮 DOM 读取，无截图、stdout 未留存**（见 11B §7） |
| Step 6.3 `hostPhase=suspect/stoppable` 且套接字未断：只显示探活横幅 | 未执行 | 无强制 `hostPhase` 的界面/CDP 入口，未尝试 |
| Step 6.4/6.5 目标 `active` 中间 `session/end` 与 `endFirst` 顺序 | 未执行（11B 最终） | 按 11A/11B 拆分留给 11B。**【11B 收口】** 真实 UI 无创建目标的入口（目标由模型工具 `create_goal` 产生，本环境无可复用的进行中目标会话），无法低成本到达「`goal/state active` 中间 `session/end`」与 `endFirst` 场景 ⇒ 维持**未执行，不视为通过**；自动化覆盖见 `tests/client-huaanwork/toolPanel.spec.ts:273`（"real goal actions settle completeFirst and endFirst without requiring a second session end"，两种顺序 + 重复 complete）与 `tests/client-huaanwork/appWiring.spec.ts:528`（"only the real complete outcome settles endFirst"） |

### 2. 关键观察细节

**历史恢复的入口形态（真实 UI）**：从侧边栏子任务进入时没有「继续此会话」按钮——`selectSubtask` 直接 `session.resume`（`App.tsx:809`）+ `session.open`（`App.tsx:810`）后恢复为可聊标签（`App.tsx:806` 的注释「有会话：resume 恢复完整上下文 + 载入历史，直接可聊。」亦如此写；`selectSubtask` 函数体起于 `App.tsx:760`）。只读 `HistoryDetailPane` 只出现在 `openFreeSession` 失败或自动化运行记录详情；本环境唯一可达的运行记录详情所引用的会话日志不在临时 DSH_HOME 中。

> 行号订正说明：Task 11 复核曾要求把本节原引的 `App.tsx:817-826` 改为 `:807`（resume）/`:810`（open）。按当前工作树实测，`session.resume` 在 `:809`、`session.open` 在 `:810`，`:807` 是 `const sessionId = task.sessionId;`，`:806` 才是注释行；本节按实测行号书写。

**goal 续轮 note 与实时一致**：恢复得到的 note 与实时 `goalRoundLabel` 文案相同；续轮前的工具与续轮后的工具聚合在同一面板（2 项），没有为 goal 用户消息新增 `user` 条目。

**断连时的附带文案（观察）**：关闭 WebSocket 后回合内会出现 note「执行进程已结束。结果可能不完整。」，输入框变为禁用且占位文案「sidecar 已退出」；自动重连后输入框恢复，但该 note 不消失（本会话累计 2 条）。这条文案把瞬时连接丢失表述成进程结束，见 D3。

**键盘与持久化（DOM-only）**：手动展开状态随标签保留（切到其他视图再回来仍展开）；Enter/Space 均只改变 `aria-expanded` 与面板体，不触发回合动作。均来自 DOM 读取，stdout 未留存（见 11B §7）。

### 3. 缺陷与观察（登记；D1 由 Task 12 修复，其余未修复）

| # | 严重度 | 现象 | 证据 |
|---|---|---|---|
| D1 | 高 → **已修复（Task 12）/ 11B 复验通过** | **历史恢复丢失全部工具结果与失败事实**：`dsh-plugin-huaanwork/src/huaanwork-host/session-view.ts:235-266` 只在 `message.content` 中找 `{type:'tool-result', content:[…]}` 块，而本运行时 v4 日志把结果写成 `message.content=[{type:'text'…}]` + `message.toolCallId` + `message.isError`。真实历史会话中 read（259 字符）、grep（97）、bash（22）三项全部恢复为「结果 无输出」；`exit 3` 的失败调用恢复为「完成」。同名问题使历史里的 `truncated` 永远不置位。Step 5.1/5.2 因此不可满足。**【11B：Task 12 已按真实 v4 形状修复并保留旧嵌套形状兼容；重建 `lib/` 后真机复验：成功文本 / 失败 / 空输出 / 已截断四类均正确，见 `shots/28`、`29`、`32`】** | **修复前**:11A 的实时 DOM 观察（三项展开后结果全为「无输出」、`exit 3` 显示「完成」）+ 控制者对真实 v4 日志形状的核对（`progress.md` Task 11A 行：`data.message.content=[{type:"text"}]`、`toolCallId`/`isError` 在顶层）。**该形态没有留存截图**——11A 一度引用的 `shots/12-real-history-results.png`、`shots/14-history-failure-panel.png` 实际拍到的是后续回合「子代理被提前停止」的画面，不显示这些面板（两图文件不同、MD5 不同，但画面目视一致：419 303 B / 419 305 B）。**修复后**：`shots/28-history-results-reverified.png`（read 真实文本）、`shots/29-history-failure-reverified.png`（失败 + `[exit code: 3]`）、`shots/32-history-truncated-reverified.png`（已截断）。真实日志原在 `/tmp/huaanwork-tool-panel-6ccPS8/.huaanwork/sessions/…`（临时根已按 11B 清理删除） |
| D2 | 中 → **11B 裁决：侧边栏路径限制**（不得扩大为「非本功能缺陷」） | **「只有调用无结果」的旧历史不再呈现「结果未记录」**：`App.tsx:809`（`session.resume`）在 `App.tsx:810`（`session.open`）之前，宿主把未结束尾部修补为一条中断 `tool/result`（并写 `turn/end interrupted`、`session/end-seed`），随后 `session.open` 看到的结果是「已完成 + 无输出」。即使 D1 修复，该顺序也会让「结果未记录」在任务侧边栏路径上结构性不可达。**【11B】** 裁决（不重新讨论）：`selectSubtask` 先 resume 后 open 属既有 resume 行为，不是本功能记录解析契约；D1 修复后同一 fixture 变为真实的「失败 + 未保存结果」文案（`shots/33`），误导性的「完成 / 无输出」已消除。**口径收窄**：该判定只覆盖侧边栏（先 resume 后 open）路径；只读（先 open 不 resume）路径**未执行**，因此不能断言「非本功能缺陷」在全路径成立 | `shots/13-history-missing-result.png`（修复前：标题「已完成」、条目「完成」、结果「无输出」）、`shots/33-missing-result-reverified.png`（修复后：失败 + 宿主修补句）；修复后 fixture 被 resume 追加记录后的日志（seq 5 `interrupted-tool-result-call-missing-1-5`） |
| D3 | 低 | 瞬时事件通道断开会被写成回合 note「执行进程已结束。结果可能不完整。」，自动重连并成功结束后仍保留（同日累计 2 条），表述与事实不符 | `shots/23`、`24`、`25` |
| D4 | 低 | 失败工具的结果文本尾部重复：`Error: invalid arguments: …"todos"invalid arguments: …"todos"`、`Error: 用户取消了这个问题用户取消了这个问题`、`Error: tool call abortedtool call aborted` | 重复文本有截图的两例：`shots/22-todo-without-panel.png`（`…missing required property "todos"invalid…`，下沿截断但重复起点可见）、`shots/18-request-input-cancelled-expanded.png`（`Error: 用户取消了这个问题用户取消了这个问题`）。`aborted` 一例只有 shot 27，而 shot 27 **只展开到「参数」行**（「含失败调用 / bash 失败」可见，结果文本被下沿截断）⇒ 该例来自同轮 DOM 读取、**无截图**（见 11B §7） |
| D5 | 低 → **11B 裁定关闭（非缺陷）** | 运行中取消后工具显示 **失败** 而非计划要求的「已中断」（宿主以 `isError` 结果收尾时按真实终态渲染）。是否应保留真实失败语义需计划裁定。**【11B】** 即时态实测：点击停止后每 60 ms 采样 45 次（2.744 s），`dt=0`（点击后同帧）仍为「运行中」，`dt=63 ms` 起稳定为「含失败调用」；**「已中断」在全部 45 次采样中未出现**（即 60 ms 采样粒度下未观察到渲染过「已中断」）——终止事件在 ≤63 ms 内到达。裁定（记录，不再讨论）：spec line 211 规定 `interrupted`/`unconfirmed` 是可被真实终态清除的推断标记，取消时宿主返回的是真实 `isError` 终态 ⇒ 最终「失败」与 spec 一致；在 60 ms 采样粒度下未观察到可渲染推断态的窗口（**不声称「不存在窗口」**，只声称采样未命中）。计划字面「显示已中断」因此**在本真机采样下不可观察**，保留为计划文本与实现的语义差记录 | `shots/05-cancelled.png`、`shots/27-cancel-running-tool.png`（面板/条目终态：「含失败调用」「bash 失败」，结果文本被下沿截断；两图**不含**回合 note）；**只有** `shots/34-cancel-immediate.png` 显示「已停止」回合 note（点击瞬间：折叠面板标题已是「含失败调用」+ note「已停止」）；采样输出由 `11b-cancel-sample.mjs` 现场打印但**stdout 未留存**（见 11B §7） |
| D6 | 低（可访问性观察；DOM-only） | 运行中的「停止」控件复用发送按钮，可访问名仍为「发送」 | 本轮 DOM 读取：`stopLabel="发送"`；**stdout 未留存、无截图**（证据强度见 11B §7）。shot 23 的输入框占位「sidecar 已退出」只旁证该按钮存在，不显示可访问名 |
| D7 | 过程问题（非产品） | **上一轮实施者留下的两份历史 fixture 不是合法 v4 日志**：缺少 `assistant/message` 的 `surfaceOp`/`stream`、`tool/result` 的 `toolCallId`，且整文件压缩成单帧（读取器要求首帧只含 header）。最初看到的「历史会话恢复失败」由 fixture 造成，不是产品缺陷。本轮只修复 `/tmp` 内验收数据（原始文件备份在 `fixtures-original/`，生成脚本 `make-fixtures.py`），未改仓库源码/测试 | 备份两份 `.zstd`；`make-fixtures.py` |

### 4. 未执行清单（不得视为通过）

| 项 | 原因 |
|---|---|
| Step 2.4 读屏播报行为 | 无读屏；只做了可访问性树结构观察 |
| Step 3.3 自动化回复折叠为附件 | 未构造 |
| Step 3.4 后台标签结束事件 | 未构造 |
| Step 4.3 取消后的 final 收起 | 未单独截图（失败/final 已观察） |
| Step 4.4 审批「拒绝」 | 本轮未重跑，既有工件只有批准 |
| Step 4.4 子代理「终止」 | 运行卡更新已验证，终止流程未触发 |
| Step 5.3 子任务恢复 / 运行记录回填 | 隔离环境无可达且日志完整的路径 |
| Step 5.5 只读面板逐条日志 | 面板可达但会话日志缺失（`session … was not found`） |
| Step 6.3 `hostPhase=suspect/stoppable` | 无强制相位入口 |
| Step 6.4/6.5 目标顺序 | 11B |

上表为 11A 当时的记录，保留原样；11B 收口后的完整未执行清单见〈11B 复验与裁决〉§6。

### 5. 本轮使用的命令（可重放）

```bash
cd /Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop/.superpowers/sdd/2026-11-02-chat-tool-panel/task11-artifacts
node cdp.mjs eval evals/open-goal-task.js      # 历史：goal 续轮
node cdp.mjs eval evals/open-task2.js          # 首任务历史（14 面板）
node cdp.mjs eval evals/expand-entries.js      # 展开面板条目
node cdp.mjs shot shots/13-history-missing-result.png
node cdp.mjs eval evals/start-sleep-turn.js    # 起一个运行中的 bash
node disconnect-flow.mjs                       # 关闭页面 WebSocket + 立即取状态/截图 + 2.6s 后复查
node cdp.mjs key Enter                          # 键盘切换（先 eval 聚焦标题）
python3 make-fixtures.py                       # 重建 /tmp 内两份合法 v4 fixture（多帧 zstd）
```

截图索引（11A）：`shots/02`–`06`（上一轮留存的详情/失败/取消/审批）、`09`–`11`（goal 历史）、`12`/`14`（**后续回合「子代理被提前停止」画面**，不是历史结果面板；两文件 MD5 不同但画面目视一致）、`13`（无结果历史）、`15`–`18`（request_input 回答/取消）、`19`/`20`（子代理运行卡；**两图 MD5 相同**，是同一完成帧）、`21`/`22`（todo 有/无 todos）、`23`–`25`（断连/重连/迟到结果）、`26`（只读历史面板）、`27`（运行中取消）。全部为非空截图，但大小与尺寸并不统一：整窗截图 26 张、均为 2560×1680，文件 178 302 B–419 305 B；局部裁切 9 张、宽 1260–1350、高 84–1098，文件 918 B–209 794 B。裁切清单与两个例外：`02`–`06` 是上一轮留存的面板/卡片局部裁切，其中 `06-approval-card.png` 只有 16 532 B（1260×190 的窄裁切）、`06-approval-approved.png` 是 1350×1098 与 209 794 B（比其余裁切都大）；`15b` 是 11A 现场拍的 closeup（1260×236，17 071 B）；`07`/`08` 为近空白裁切（1260×190 的 1 196 B、1260×84 的 918 B）。裁切只能证明裁切框内的内容，`07`/`08` 内容不足以判定，未用于任何判定，后续由 `15`/`15b` 与 `19`/`20` 取代；`03-entry-keyboard.gif.png` 与 `03-entry-keyboard.png` 字节完全相同（MD5 一致，各 69 988 B）。

截图索引（11B 新增）：`28`（历史成功结果，仅 read 项入画）、`29`（历史失败 + `[exit code: 3]`）、`30`（goal 续轮折叠态）、`31`（goal 展开，bash 只到参数行）、`32`（历史已截断）、`33`（无结果 fixture 修复后：失败 + 宿主修补句）、`34`（取消点击瞬间，折叠面板已「含失败调用」+ 「已停止」）。同样为 2560×1680 非空截图。

### 6. 诚实性说明

- 所有「真实 UI」判定都来自本轮实际点击/输入与 DOM 读取，或上一轮留存的非空截图（02–06）；未出现在本节的项没有判定为通过。**凡只有 DOM 读取、没有留存 stdout 也没有截图的判定，单元格里已标注「DOM-only」，完整清单见 11B §7**；不要把这些数字当成可重放的测量结果。
- 断连一节明确是**受控模拟**（关闭页面 WebSocket），不是网络故障注入；`hostPhase` 相关项未执行。
- 两份历史 fixture 是本轮修复的验收数据（D7），修复前后的差异与原因均已记录；修复只发生在 `/tmp/huaanwork-tool-panel-6ccPS8`，未触碰生产目录。
- 应用保持运行（CDP 9333），供 11B 继续；未创建提交。

### 11B 复验与裁决

记录时间：2026-11-02 23:00–23:15（本地 UTC+8）。同一隔离数据（`/tmp/huaanwork-tool-panel-6ccPS8`），重建含 Task 12 修复的 `lib/` 后重启应用（CDP 9333，模型 `deepseek-chat`）。未改源码/测试，未提交，未触碰 `~/.huaanwork` 与 `~/Library/Application Support/HuaAnWork`。

#### 1. 重建与重启事实

| 步骤 | 命令 | 结果 |
|---|---|---|
| 停旧应用 | `pkill -f 'user-data-dir=/tmp/huaanwork-tool-panel-6ccPS8'` | 进程退出（复查 0 个匹配进程），CDP 9333 端口关闭 |
| 重建 | `corepack yarn workspace dsh-plugin-huaanwork build` | `BUILD_EXIT=0`；宿主产物 `lib/sessions-BVNMNyrf.js` 于 23:00 重写，含新解析路径（`ownText`/`legacyText`） |
| 原生依赖 | `corepack yarn workspace dsh-plugin-huaanwork prepare:electron-native` | `NATIVE_EXIT=0`；`fs-ext` 按 Electron 44.0.0 / darwin-arm64 / ABI 149 重编 |
| 重启 | Electron + `--user-data-dir=…/userData --remote-debugging-port=9333`，`DSH_HOME=…/.huaanwork`，剥离 `ELECTRON_RUN_AS_NODE`/`NODE_OPTIONS` | 页面目标恢复（`http://127.0.0.1:43120`），`cdp.mjs` 重连成功 |
| 启动日志 | 复制到 `task11-artifacts/temp-logs/app-11b.log`、`build-11b.log` | 应用日志 10 行：无构建/解析/会话错误；只有既有噪音（2 个 `pending` 插件、agent-catalog 目录不可达、迁移文案） |

#### 2. D1 复验（Step 5.1 / 5.4a；5.4b 只读页未执行）

| 检查点 | 实际观察 | 证据 |
|---|---|---|
| 面板默认收起 | 首任务历史 22 个面板全部 `aria-expanded=false` | DOM 读取 `evals/11b-open-first.js`；**stdout 未留存，无截图**（见 §7） |
| 成功结果（read） | read `<path>…/README.md</path> … TOOLPANEL-SANDBOX-7Q2` 为历史真实文本 | `shots/28-history-results-reverified.png`（**只显示 read 一项展开**；grep/bash 在面板内滚动区外，未入画） |
| 成功结果（grep / bash） | grep `Found 2 matches`、bash `200 src/long.txt` 同为历史真实文本 | **仅 DOM 读取，无截图、stdout 未留存**（见 §7） |
| 失败结果 | `exit 3` → 条目「正在运行命令 bash **失败**」、结果 `(no output) [exit code: 3]`；同面板另一 read 仍「完成」 | `shots/29-history-failure-reverified.png` |
| 空输出结果 | `sleep 20` → 「bash 完成 / 结果 `(no output)`」 | DOM 读取 `evals/11b-empty-success.js`（命中面板 18/19/4）；**stdout 未留存，无截图**（见 §7） |
| 截断结果 | 历史里「bash 完成 **已截断**」，结果 32 902 字符，保留头尾（原始 `seq 1 20000`） | `shots/32-history-truncated-reverified.png`（条目「已截断」徽标 + 结果起点「201…」可见，后续行在面板内滚动） |
| goal 续轮（5.4a） | 唯一 note「正在按目标继续，第 2/4 轮，这还不是验收结果」+ 单个默认收起面板「工具 · 已完成 · 2 项调用」；展开后 read 结果为真实文本 | `shots/30-goal-history-reverified.png`（折叠态 + note + `bubble user`）、`shots/31-goal-history-expanded-reverified.png`（read 结果可见；**bash 只到参数行**，其结果 `200 src/long.txt` 仅 DOM 读过） |
| 只读历史页 goal 原始消息（5.4b） | **未执行**：只读入口不可达（`session … was not found`） | `shots/26-readonly-history-pane.png` |

> 证据强度：上表「面板默认收起（22 个）」「grep/bash 成功文本」「空输出（`(no output)`）」三行只有 CDP eval 的 DOM 读取，脚本仍保存在 `task11-artifacts/evals/`（`11b-open-first.js`、`11b-show-panel.js`、`11b-empty-success.js` 等），但**运行时的 stdout 未保存**，临时环境（`/tmp/huaanwork-tool-panel-6ccPS8`）已按 11B §8「清理确认」删除 ⇒ 这些数字与文案**不可重放**，只能作为当次观察的叙述性记录。

截断用例是本轮**新建**的：11A 的历史会话没有超过 32 KiB 帽的输出。做法先在实时回合跑 `seq 1 20000`（实时面板即显示「完成 已截断」），再切走/切回触发 `session.open`，确认历史解析路径同样得到 `truncated`。原始输出 20 000 行在写入日志时已被宿主自身的输出落盘/截断处理，客户端 32 KiB 帽与宿主层截断在 UI 上不可区分，本节只按 UI 事实（已截断 + 头尾保留）记录。

#### 3. D2 / Step 5.2（路径限制，只读路径未执行）

- 裁决（记录，不重新讨论）：`selectSubtask` 在 `session.open` 前先 `session.resume`，宿主修补了未结束尾部；这是既有 resume 行为，不是本功能的历史解析契约。
- 复验（D1 修复后，同一 fixture `历史：只有调用无结果`）：面板「工具 · 含失败调用 · 1 项调用」，条目「read 失败」，结果文本为宿主修补句 "The tool call was interrupted after it was recorded, but no result was durably recorded. Its outcome is unknown…"；「结果未记录」/「历史记录未保存结果」仍不出现（`shots/33-missing-result-reverified.png`）。11A 的「完成 + 无输出」（误导性）已消失，这是 D1 修复的附带收益；计划字面文案在该侧边栏路径上仍不可达。
- 只读（先 open 不 resume）路径：本环境唯一可达的只读入口仍是「自动化 → 运行记录 → `HistoryDetailPane`」，其引用的会话日志不在临时 DSH_HOME 中（`session … was not found`），无低成本可达路径 ⇒ **未执行**。

#### 4. D5 / Step 4.2 即时态

- 方法：`11b-cancel-sample.mjs`（双 CDP 连接）——发送「bash 执行 `sleep 20`」回合，等到条目标题出现「运行中」后点击停止；页内每 60 ms 采样面板标题/条目标题/回合文案共 45 次（跨度 2.744 s），另一条连接在点击瞬间截图。脚本仍在 `task11-artifacts/11b-cancel-sample.mjs`，**当次 stdout 未保存**（临时环境已删除 ⇒ 采样序列不可重放，见 §7）。
- 结果：点击前「工具 · 执行中 · 1 项调用 / 正在运行命令 bash 运行中」；`dt=0`（点击后同帧）仍为运行中；`dt=63 ms` 起稳定为「工具 · 含失败调用 · 1 项调用」，回合 note「已停止」。「已中断」**在全部 45 次采样中未出现**（`everInterrupted: false`），即：**60 ms 采样粒度下未观察到「已中断」**，不能读成「任何时刻都不可能渲染」。点击瞬间截图 `shots/34-cancel-immediate.png` 显示面板已收起、标题已是「含失败调用」并带「已停止」note。
- 裁定（记录，不再讨论）：spec line 211 规定 `interrupted`/`unconfirmed` 是可被真实终态清除的推断标记；取消时宿主返回的是真实 `isError` 终态结果，故最终「失败」与 spec 一致。补充事实：终止事件在 ≤63 ms 内到达，本采样下未命中推断态；计划字面「当前回合未结束工具显示已中断」在该采样粒度下**不可观察**。D5 按裁定**关闭**（非产品缺陷），差异保留在缺陷表。
- 停止控件可访问名仍为「发送」（D6 观察不变，未新登记；该结论为 DOM 读取，stdout 未留存，见 §7）。

#### 5. Step 6.4/6.5（目标顺序）

未执行。真实 UI 没有创建目标的入口（目标由模型工具 `create_goal` 产生，临时 DSH_HOME 中也没有进行中的目标会话可复用），无法低成本构造「`goal/state active` 中间 `session/end`」与 `endFirst`。自动化覆盖：`tests/client-huaanwork/toolPanel.spec.ts:273`（两种顺序 + 重复 complete）、`tests/client-huaanwork/appWiring.spec.ts:528`、`tests/client-huaanwork/goalRound.spec.ts:96`。**不得视为真实 UI 通过。**

#### 6. 未执行清单（11B 收口后）

11A §4 的清单原样保留；收口后的完整未执行项如下（均不得视为通过）：

| 项 | 原因 |
|---|---|
| Step 2.4 读屏播报行为 | 无读屏；只有可访问性树结构观察（`cdp.mjs ax`） |
| Step 3.3 自动化回复折叠为附件 | 未构造 |
| Step 3.4 后台标签结束事件 | 未构造 |
| Step 4.3 取消后的 final 收起 | 未单独截图（失败/final 已观察） |
| Step 4.4 审批「拒绝」 | 未重跑；既有工件只有批准 |
| Step 4.4 子代理「终止」 | 运行卡更新已验证，终止流程未触发 |
| Step 5.1 只读历史页的「继续此会话」入口 | 环境中没有该入口：只读 `HistoryDetailPane` 可达但会话日志缺失（`session … was not found`），判定改由侧边栏 `selectSubtask`（先 resume 后 open）替代，见 §2 |
| Step 5.2 只读（先 open 不 resume）路径 | 无可达且日志完整的只读入口 |
| Step 5.3 子任务恢复 / 运行记录回填 | 隔离环境无可达且日志完整的路径 |
| Step 5.4（b）只读历史页仍逐条显示 goal 原始用户消息 | 只读入口不可达（`shots/26-readonly-history-pane.png` 显示 `session … was not found`）；5.4 的通过只覆盖（a）goal 续轮 note + 单一折叠面板 |
| Step 5.5 只读面板逐条日志 | 复用 11A `shots/26-readonly-history-pane.png`（面板可达但显示 `session … was not found`，无逐条日志）；本轮未重走 |
| Step 6.3 `hostPhase=suspect/stoppable` | 无强制相位入口 |
| Step 6.4/6.5 目标顺序 | 无创建目标入口；转为自动化覆盖（见上） |

#### 7. 证据强度：DOM-only 观测与非可重放证据

本轮的 DOM 观测都是 `task11-artifacts/cdp.mjs … eval` 与 `evals/*.js` 现场打印的，**没有把 stdout 重定向到文件**。`task11-artifacts/` 里留存下来的只有：`cdp.mjs`、`evals/`（脚本本身）、`11b-cancel-sample.mjs`、`disconnect*.mjs`、`make-fixtures.py`、`fixtures-original/`、`shots/`（编号 02–34 的截图；另有 `03-entry-keyboard.gif.png`——与 `03-entry-keyboard.png` 字节完全相同的副本，以及 `15b-request-input-card-closeup.png`——11A 现场拍的 closeup（mtime 22:30），**不是**上一轮工件的副本；`07`、`08` 为近空白裁切、未用于任何判定）、`temp-logs/`（只有 `app-11b.log`、`build-11b.log`），以及工件根目录下的 `app.log`（1 192 B）、`build.log`（41 727 B）、`tmpdir.txt`（41 B）。临时根 `/tmp/huaanwork-tool-panel-6ccPS8` 已删除（见 11B §8），应用未再启动 ⇒ 下列数字与文案**不可重放**：

| 只有 DOM 观测的结论 | 出现在 |
|---|---|
| 首任务历史 22 个面板全部 `aria-expanded=false` | 11A §1 Step 5.1、11B §2 |
| 空输出 `(no output)`（`sleep 20`） | 11A §1 Step 5.1、11B §2 |
| grep `Found 2 matches` / bash `200 src/long.txt` 历史文本 | 11B §2（shot 28 只含 read） |
| goal 续轮 `aria-expanded=false` 与 `chat-log` 直接子节点枚举 | 11A §1 Step 5.4(a)、11B §2 |
| bash `200 src/long.txt`（`shots/31` 只到参数行） | 11A §1 Step 5.4(a) |
| 迟到 `(no output)` 与「恢复瞬间未标成功」 | 11A §1 Step 6.2（shot 25 只到参数行） |
| 每 60 ms × 45 次取消采样与 `everInterrupted:false` | 11A §1 Step 4.2、缺陷 D5、11B §4 |
| `stopLabel="发送"`（D6） | 缺陷 D6 |
| Enter / Space 与 `aria-expanded` 联动、不触发回合动作 | 11A §1 Step 2.3 |
| 切标签返回后仍展开 | 11A §1 Step 3.2 |
| `.tool-panel .ask-card/.todo-card/.subagent-run-card = 0`、面板数 16→17 | 11A §1 Step 4.5 |
| `.chat-log` 无 `.tool-row` 散行 | 11A §1 Step 2.1 |
| 14–19 个用户回合 = 14–19 个面板 | 11A §1 Step 3.4 |
| 运行卡「启动中 → 已完成」迁移 | 11A §1 Step 4.4（shots 19/20 是同一完成帧） |
| `Error: tool call abortedtool call aborted` 重复文本 | 缺陷 D4（shot 27 只到参数行） |
| 修复前的历史结果全为空、`exit 3` 显示「完成」 | 缺陷 D1（shots 12/14 拍到的是别的回合） |

处理方式：以上条目在各自表格里标注「DOM-only」，并在此集中登记。**没有补造日志、没有补造截图、也没有把叙述改写成可重放的测量**；若要可重放证据，只能在新隔离环境重跑（本轮环境已按 11B §8 销毁）。

#### 8. 清理确认

- 应用已终止：`pkill -f 'user-data-dir=/tmp/huaanwork-tool-panel-6ccPS8'` 后复查无匹配进程，CDP 9333 不再响应。
- 先归档日志到 `task11-artifacts/temp-logs/`（`app-11b.log`、`build-11b.log`），再 `rm -rf /tmp/huaanwork-tool-panel-6ccPS8` 并复查目录不存在；两份修复后的 v4 fixture 随临时根删除（可由 `task11-artifacts/make-fixtures.py` 重建，原始文件仍在 `fixtures-original/`）。
- `git status --short` 为 28 条，与 Task 10 记录的行数一致（全部是功能本身的既有改动与未跟踪新文件）；本轮**未新增/修改任何源码或测试**，`lib/` 构建产物未进入 git 状态，**未创建提交**。
- 全程未触碰生产 `~/.huaanwork` 与 `~/Library/Application Support/HuaAnWork`（启动参数与 `DSH_HOME` 均指向 `/tmp`）。

## Task 14 — 最终树 root 门禁复跑

记录时间：三条门禁实际执行于 **2026-11-02 23:54:43–23:59:40（本地 UTC+8）**，本节撰写于 2026-11-03 00:00–00:10（跨零点，故日期记两日）。仓库：`/Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop`。主机：macOS 27.0.1（26A434），arm64。

**与 Task 10 的关系（本节的取代范围）**：Task 10 的三条门禁运行于 2026-11-02 20:14–20:22，针对快照 `7dd4251`（Task 9 收尾树；写证据文档后该区域的树为 `8a8eece`，`7dd4251..8a8eece` 的差异只有本证据文档本身，无代码变化）。其后的 **Task 12 修改了 `dsh-plugin-huaanwork/src/huaanwork-host/session-view.ts` 与其 spec**（解析器修复），Task 13 又改写了本证据文档。因此 **Task 10 的门禁结果早于 Task 12 的解析器修复，不覆盖最终树**；本节在最终树 `c57e3b9` 上复跑同样三条命令，**就最终树而言取代 Task 10 §1–§9 的门禁结论**。Task 10 的历史执行记录与诚实性说明保留不动（其数字仍是当时树上的真实读数）。

### 14.1 环境与最终树快照

| 字段 | 值 |
|---|---|
| 执行日期/时间 | 2026-11-02 23:54:43 → 23:59:40（本地 UTC+8） |
| Node.js | `v22.23.2`（满足 `^22.19.0 \|\| >=24.0.0`） |
| Yarn | `4.18.0`（Corepack） |
| 主机 | macOS 27.0.1（26A434），arm64 |
| HEAD | `ff897f713cddeec9bb516db8823aba5dc887de7a` |
| Harness pin（`HEAD:deepseek-harness`） | `1600d8a1e140dcde43a1a0941940a0480712c011`（`dsh-v0.2.1-rc.1`） |
| 最终树快照（`dsh-plugin-huaanwork` + `docs`） | `c57e3b9af5cc773f890459a8a4b50a2b415aed43`——门禁**前**与门禁**后**（写本节之前）各计算一次，两次相同 |

快照取法（索引放在 `/tmp`，不触碰工作树）：

```bash
rm -f /tmp/huaanwork-task14/scratch-index
GIT_INDEX_FILE=/tmp/huaanwork-task14/scratch-index git read-tree HEAD
GIT_INDEX_FILE=/tmp/huaanwork-task14/scratch-index git add -A -- dsh-plugin-huaanwork docs
GIT_INDEX_FILE=/tmp/huaanwork-task14/scratch-index git write-tree
# c57e3b9af5cc773f890459a8a4b50a2b415aed43（门禁前后一致）
```

门禁前后两次 `git add` 均打印同一组 4 条既有 `nuwa-skill` CRLF 警告（`LICENSE`、`SKILL.md`、`assets/banner.svg`、`scripts/download_subtitles.sh`），与 Task 10 相同，非门禁步骤、非失败。`c57e3b9` 相对 `8a8eece` 的代码差异只有 `session-view.ts` + `session-view.spec.ts`（Task 12）与本证据文档（Task 13），即最终树就是含 Task 12 修复的树。

### 14.2 三条命令（严格串行）

| # | 命令 | 开始–结束（本地） | Exit | 墙钟 | 结果摘要 |
|---|---|---|---|---|---|
| 1 | `corepack yarn test` | 23:54:43 → 23:56:07 | **0** | 84 s | 12 workspace 全执行；vitest 4305 passed / 14 skipped；node:test 162 passed / 2 skipped；0 failed |
| 2 | `corepack yarn typecheck` | 23:56:35 → 23:56:57 | **0** | 22 s | 8 workspace 类型检查通过；唯一输出 `contract-types: 4 generated type files are current` |
| 3 | `corepack yarn check` | 23:57:01 → 23:59:40 | **0** | 159 s | 全链路走完；最后阶段 `agent-catalog-admin`（15 tests）后 `EXIT_CODE=0` |

执行方式：Gate 1、Gate 3 用后台进程 + `/tmp` 日志等待完成（未 kill、未并行）；Gate 2 前台执行。Gate 1→2 间隔 28 s、Gate 2→3 间隔 4 s，期间只读取日志，没有运行任何其他门禁（规避 `verify:aa` 已知并发竞态，见 `AGENTS.md` 技术债表）。三条命令的 exit code 均取自日志末行 `EXIT_CODE=…`。

### 14.3 Gate 1：`corepack yarn test`

- **Exit code `0`**，84 s（23:54:43 → 23:56:07）。
- vitest（5 个 workspace）：`dsh-plugin-huaanwork` 270 passed | 4 skipped 文件 / **3590 passed | 14 skipped** 用例；`dsh-community-market` 13 / 303；`market-server` 14 / 244；`update-server` 5 / 88；`agent-catalog-server` 5 / 80。
- node:test（7 个 workspace）：policy 64（62 pass / 2 skip）、model 10、git-tools 8、web-tools 19、catalog-signing 13、agent-package-format 35、agent-catalog-admin 15。
- 合计 **4467 passed / 16 skipped / 0 failed**（vitest 4305 + node:test 162）；日志中 `not ok` = 0、`FAIL` = 0。
- 与 Task 10（20:14 那轮：3588 passed / 14 skipped，总数 3602）相比：**vitest 增加 2 个通过用例**（3590 vs 3588，3604 vs 3602），来源是 Task 12 的 spec——`tests/huaanwork-host/session-view.spec.ts` 现为 **24 tests**（`✓ 175ms`）；跳过数不变（14），无新增跳过。
- 本功能两个定向 spec 在 root 面命中：`ToolPanelComponent.spec.ts (4 tests) 43ms`、`toolPanel.spec.ts (16 tests) 4ms`。
- 日志噪音与 Task 10 §4.5 相同（`renderer failed to load (-105/-102)`、`renderer boot failed`、`renderer process gone`、`Confirmed restart failed…` 等负例 fixture 输出），非失败。

### 14.4 Gate 2：`corepack yarn typecheck`

- **Exit code `0`**，22 s（23:56:35 → 23:56:57）。完整输出仅一行：

```text
contract-types: 4 generated type files are current
```

- root `typecheck` 覆盖 8 个 workspace（`dsh-plugin-huaanwork`、`dsh-community-market`、`market-server`、`update-server`、`@huaanwork/catalog-signing`、`@huaanwork/agent-package-format`、`agent-catalog-server`、`agent-catalog-admin`），无诊断输出；`dsh-plugin-huaanwork` 的五套 tsconfig（含 `tsconfig.tests.client.json`）在本步无错误。

### 14.5 Gate 3：`corepack yarn check`

- **Exit code `0`**，159 s（23:57:01 → 23:59:40）。链路全部走完，最后阶段为 `agent-catalog-admin`（15 个 node:test 用例全过）。
- 实测阶段输出（原文摘录）：
  - `check:whitespace` 7 tests；`test:market-release` 6；`test:aa-release` 14；
  - `verify-bilingual-docs: 50 records and 100 documents are consistent`；`check:architecture` 25 tests + `verify-market-dependency-direction: 441 tracked source files …; 8 market wrapper files …`；
  - `sync-vendored-runtime: huaanwork 341 packages from 1600d8a1e1 are verified`；`verify-layout: … consistent with upstream 1600d8a1e1`；`test:gate-scripts` 3；`verify-readme-versions: 4 hardcoded artifact version string(s) …`；
  - `test:aa-connector` 3；fabric `20 Markdown files and 10 bilingual pairs`；community-market `12 Markdown files, 6 bilingual pairs, and 4 schemas`、build `✓`、`4 type exports exist`、`registered one client module`、13 files / 303 passed；
  - huaanwork：build `✓`、typecheck 通过、`Test Files 270 passed | 4 skipped (274)` / `Tests 3590 passed | 14 skipped (3604)`（含两个 ToolPanel spec）、`verify-runtime-closure: 316 first-party nodes …`（其自身 4 个 node:test 通过）、`verify-bundled-runtime: 131 files checked; 9 bundled packages are inlined`（11 个 node:test 通过）、`verify:cli` / `verify:loader` 无输出、`verify-profile-boot: minimal preset, plugin manager, and disabled hmr lock passed`、`verify:host` 35 passed、`verify:aa` 再次 profile boot passed、`verify-licenses: 636 packages checked (9 bundled)`、`verify-operation-reliability: 7 operations and 18 fault contracts verified.`；
  - `market-server` 14 files / 244 passed；`update-server` 5 / 88；`@huaanwork/catalog-signing` 13；`@huaanwork/agent-package-format` 35；`agent-catalog-server` 5 / 80；`agent-catalog-admin` 15。
- 既有非致命告警照旧：`warning: 2 entries did not activate`（`web-fetch-http` 等 web、`job-controller` 等 jobs；见 `docs/huaanwork-dev-launch.md:58`、`docs/evidence/2026-10-29-single-desktop-phase-b.md:59`），`verify:profile` / `verify:aa` 两处 profile boot 仍打印 `passed`。
- `contract-types: 4 generated type files written`（注意是 written，Gate 2 为 current）：`check` 内重新生成契约类型；运行后工作树经快照核对无差异（§14.7）。
- `verify:cli` / `verify:loader` 成功时不打印内容，其独立 exit code 未被单独捕获；整体 `check` exit 0 说明 `&&` 链上每一步（含二者）都返回 0。
- 日志中 `not ok` = 0、`FAIL` = 0。

### 14.6 失败输出

无。三条日志均无 `not ok` / `FAIL`；`Error: crash here`、`audit write failed: EISDIR|ENOENT`、`update-server: channel record … is corrupt` 等行均为负例 fixture 的预期输出。

### 14.7 工作树核对（门禁后）

```bash
git status --short
git diff --check
```

- `git status --short`：**28 条 = 17 个已修改 + 11 个未跟踪**（`STATUS_EXIT=0`），与 Task 13 收尾记录逐条一致：
  - 已修改 17：`docs/superpowers/specs/2026-11-01-chat-tool-panel-design.md`、`dsh-plugin-huaanwork/src/client-huaanwork/{App.tsx,logic/commandOutcome.ts,logic/sessionChannel.ts,logic/turnStatus.ts,rpc-types.ts,styles.css,styles.generated.ts}`、`dsh-plugin-huaanwork/src/huaanwork-guardrails/bridge.ts`、`dsh-plugin-huaanwork/src/huaanwork-host/session-view.ts`、7 个测试文件（`tests/client-huaanwork/{appWiring,commandOutcome,outcomeCheck,sessionChannel,turnStatus}.spec.ts`、`tests/huaanwork-guardrails/bridge.spec.ts`、`tests/huaanwork-host/session-view.spec.ts`）。
  - 未跟踪 11：`.gstack/`、`.qoder/`、`docs/evidence/2026-11-02-chat-tool-panel-verification.md`、`docs/superpowers/plans/2026-10-31-single-desktop-maintenance-code-review.md`、`docs/superpowers/plans/2026-11-02-chat-tool-panel{,-plan-review}.md`、`docs/superpowers/specs/2026-11-01-chat-tool-panel-design-review.md`、`dsh-plugin-huaanwork/src/client-huaanwork/{ToolPanel.tsx,logic/toolPanel.ts}`、`dsh-plugin-huaanwork/tests/client-huaanwork/{ToolPanelComponent.spec.ts,toolPanel.spec.ts}`。
  - 门禁**没有新增、删除或修改任何受版本控制的条目**；`.superpowers/` 由 `.git/info/exclude` 排除，本任务的 workspace 报告不出现在状态里。
- `git diff --check`：**无输出，exit 0**（`DIFFCHECK_EXIT=0`；该命令只覆盖已跟踪文件，与仓库 `check:whitespace` 口径一致）。
- 门禁后、写本节之前的快照仍为 `c57e3b9…`（§14.1），证明 `lib/` 构建与契约类型重写等幂等产物未进入受版本控制的工作树。**追加本节之后**，唯一变化是本未跟踪证据文件自身（`docs/evidence/2026-11-02-chat-tool-panel-verification.md`），不再重算快照。

### 14.8 日志指针

| 文件 | 内容 | 行数 |
|---|---|---|
| `/tmp/huaanwork-task14/yarn-test.log` | Gate 1 完整输出（首行 `START`、末行 `EXIT_CODE=0`） | 1872 |
| `/tmp/huaanwork-task14/yarn-typecheck.log` | Gate 2 完整输出（末行 `EXIT_CODE=0`） | 5 |
| `/tmp/huaanwork-task14/yarn-check.log` | Gate 3 完整输出（含 ANSI，末行 `EXIT_CODE=0`） | 2378 |
| `/tmp/huaanwork-task14/yarn-check.clean.log` | Gate 3 去除 ANSI 的可读副本 | 2378 |
| `/tmp/huaanwork-task14/env.log` | 日期/Node/Yarn/OS/HEAD/harness pin/快照 id | 7 |
| `/tmp/huaanwork-task14/git-status-short-final.log` | 最终 `git status --short`（28 条 + `STATUS_EXIT=0`） | 30 |
| `/tmp/huaanwork-task14/git-diff-check-final.log` | 最终 `git diff --check`（空输出 + `DIFFCHECK_EXIT=0`） | 2 |
| `/tmp/huaanwork-task14/snapshot-add-warnings.log`、`snapshot-add-post-warnings.log` | 两次快照 `git add` 的 4 条既有 CRLF 警告 | 各 4 |

临时目录，重启后可能被清理；命令与摘录足以重放。

### 14.9 诚实性说明

- 所有 exit code 均为实际观察值（三个日志末行 `EXIT_CODE=0`）；`check` 的**整体** exit 0 是直接观察，链内单步 exit code 未逐一捕获，只记录了可观察的阶段输出。
- 未修改任何源码、测试、断言或配置；未放宽任何期望；未创建提交；未启动图形应用；未执行 `market:check` / `aa:check` / CI / 打包。
- Task 10 的门禁数字（3588 等）仍如实保留在其小节中；它们与本节（3590 等）的差异已归因于 Task 12 的 spec 变化，而不是同一棵树上的重跑差异。
- 本节撰写跨过零点：命令执行日期为 2026-11-02，撰写时间为 2026-11-03 00:00–00:10（本地 UTC+8）。

## Task 15 — 最终评审修复与复验

记录时间：2026-11-03 00:11–00:23（本地 UTC+8）。仓库与主机同前。本节记录整支评审（whole-branch review，结论为「With fixes」）要求的一轮修复：I1 投影守卫（必需项）+ 四个零风险 minor + 可核对的证据引用订正。**未创建提交、未启动图形应用、未触碰生产数据与 `/tmp` 验收根**（该根已按 11B §8 删除）。

### 15.1 I1 — 投影守卫（必需）

- `dsh-plugin-huaanwork/src/client-huaanwork/logic/toolPanel.ts:339`：`hasVisibleAssistant` 原先对**每个** segment 计算（含终态历史回合），而该值只在 `!segment.final` 分支被消费（`:370`）。改为 `segment.final ? false : options.contentItems.some(...)`，终态回合不再做逐条正文探测。
- 行为等价：终态 segment 的 `!segment.final` 恒为 false，赋 `false` 不改变 `expanded` 结果。既有「visible body / turnFinal / 历史 / 手动切换」用例仍全绿。

### 15.2 零风险 minor（同一批热文件）

1. `logic/toolPanel.ts:176`：`if (wasFinal && items === tab.items) return …` → `if (wasFinal) return …`——`wasFinal` 为真时 `items` 必然是 `tab.items`，条件冗余。
2. `logic/toolPanel.ts:317`：segment-push 条件删除死分支 `|| userId !== undefined`（下一个 user 的下标恒大于 `start`）。
3. `ToolPanel.tsx:29,38,54`：`aria-controls` 只在被指元素真实渲染时输出——面板标题用 `panel.expanded ? bodyId : undefined`，条目用 `expanded ? detailId : undefined`；新增组件断言 `ToolPanelComponent.spec.ts`「never points aria-controls at an element that is not rendered」：在「面板展开 / 面板收起 / 条目展开」三种状态下校验每个 `aria-controls` 都解析到现存元素，且折叠态该属性为 `null`。
4. `toolPanel.spec.ts` 新增「a real goal round-limit settles turnFinal through the goal-stopped action」：经真实 `reduceGoalTurn`（`goal-round-limit` → action `goal-stopped`，`round = GOAL_ROUND_LIMIT`）→ `reduceTurnFinal` 得 `true`，再按 App 的接线形状调用 `applyTurnFinalToTabs`，断言写入 `turnFinalByUserId`、未结束工具标 `unconfirmed`、同一动作重复投递不再结算；同一用例断言 `none` action 不结算，使「round-limit 退化为 no-op」时用例会红。

### 15.3 文档订正

- `docs/superpowers/specs/2026-11-01-chat-tool-panel-design.md:292`：组件 spec 文件名改为 `tests/client-huaanwork/ToolPanelComponent.spec.ts`，并加一行订正说明（计划原名与纯逻辑 spec `toolPanel.spec.ts` 在本仓库大小写不敏感 APFS 上是同一文件；ledger Task 7 裁定）。
- `docs/evidence/2026-11-02-chat-tool-panel-verification.md`：
  - `:3`/`:5`：Task 10 记录范围 `§1–§9` → `§1–§10`（该记录实际延续到 §10 诚实性说明）。
  - `:229`：把「11A 的观察文本原样保留」改为精确表述——大部分保留，但多个单元格被 11B 编辑或补充，判定列整体更新为 11B 结论。
  - `:252`（Step 4.2 行）与 `:290`（D5 行）：删除把「已停止」回合 note 归给 `shots/05`、`27` 的引用——按实际截图，只有 `shots/34-cancel-immediate.png` 有该 note，05/27 只显示面板/条目终态且结果文本被下沿截断（`05`/`27`/`34` 已目检；`:252` 属同一处错引，一并订正，否则与修正后的 D5 行自相矛盾）。
  - `:325`：删除失实的尺寸/大小区间（原「17 KB–420 KB」「宽 1260–1270，高 190–730」），改为实测口径：整窗截图 26 张均为 2560×1680（178 302 B–419 305 B）；局部裁切 9 张、宽 1260–1350、高 84–1098（918 B–209 794 B），并列出两个例外 `06-approval-card.png`（16 532 B）与 `06-approval-approved.png`（1350×1098、209 794 B）；`15b` 注明为 11A 现场 closeup。
  - `:406`：工件清单补入工件根目录的 `app.log`（1 192 B）、`build.log`（41 727 B）、`tmpdir.txt`（41 B）；`15b-request-input-card-closeup.png` 记为 11A 现场 closeup（mtime 22:30）而非上一轮副本；`03-entry-keyboard.gif.png` 记为与 `03-entry-keyboard.png` 字节相同的副本。

上述数字来自本节写作时对 `task11-artifacts/`、`shots/` 的 `stat -f%z`、`sips -g pixelWidth -g pixelHeight`、`md5` 实测，以及 `shots/05`、`27`、`34` 的目检；未重跑任何 GUI 步骤，也未据此改动任何 11A/11B 的判定结论。

### 15.4 复验（严格串行，真实读数）

| # | 命令 | Exit | 结束时刻（本地） | 结果摘要 |
|---|---|---|---|---|
| 1 | `corepack yarn workspace dsh-plugin-huaanwork vitest run tests/client-huaanwork/{toolPanel,ToolPanelComponent,appWiring,goalRound,turnStatus,outcomeCheck}.spec.ts` | **0** | 00:17:57 | 6 files / **92 tests passed**：`toolPanel` 17、`ToolPanelComponent` 5、`appWiring` 25、`goalRound` 16、`outcomeCheck` 26、`turnStatus` 3；无失败、无跳过；vitest 自报 Duration 425 ms |
| 2 | `corepack yarn workspace dsh-plugin-huaanwork typecheck` | **0** | 00:18:12 | 五套 tsconfig（含 `tsconfig.tests.client.json`）全部通过，无诊断输出 |
| 3 | `corepack yarn check` | **0** | 00:20:47 | 链路全部走完，最后阶段 `agent-catalog-admin`（`1..15`，`# pass 15`、`# fail 0`）；`dsh-plugin-huaanwork` `Test Files 270 passed \| 4 skipped (274)` / `Tests 3592 passed \| 14 skipped (3606)`（比 Task 14 的 3590 多 2，即本轮新增的两个用例），两个 ToolPanel spec 命中且全绿；`dsh-community-market` 303、`market-server` 244、`update-server` 88、`agent-catalog-server` 80；node:test 14 个 TAP 段合计 `# pass` 181、`# fail` 0；日志 `not ok` = 0、`FAIL` = 0 |

`check` 关键阶段输出（原文摘录）：`verify-bilingual-docs: 50 records and 100 documents are consistent`、`sync-vendored-runtime: huaanwork 341 packages from 1600d8a1e1 are verified`、`verify-layout: … consistent with upstream 1600d8a1e1`、`verify-runtime-closure: 316 first-party nodes …`、`verify-bundled-runtime: 131 files checked; 9 bundled packages are inlined`、`verify-profile-boot: minimal preset, plugin manager, and disabled hmr lock passed`（两处）、`verify:host` 35 passed、`verify-licenses: 636 packages checked (9 bundled)`、`verify-operation-reliability: 7 operations and 18 fault contracts verified.`。既有非致命告警（`warning: 2 entries did not activate`）与负例 fixture 噪音同 Task 10 §6.3 / Task 14 §14.5，不构成失败。

日志：`/tmp/huaanwork-task15/{focused-vitest,typecheck,check}.log`（末行为 `EXIT_CODE=0`；临时目录，可能被清理）。

### 15.5 工作树与诚实性说明

- `git status --short` 仍为 **28 条 = 17 个已修改 + 11 个未跟踪**，与 Task 14 §14.7 逐条一致：本轮只改了 `ToolPanel.tsx`、`logic/toolPanel.ts`、两个 spec（本来即为未跟踪新文件）与两份文档（一份已修改、一份未跟踪），未新增文件、未删除文件、**未创建提交**。
- `git diff --check` 无输出、exit 0；另对 4 个代码/测试文件与 2 份文档做了行尾空白/制表符扫描（0 命中）——`git diff --check` 不覆盖未跟踪文件，故补这一步。
- **未放宽任何既有断言**：本轮只新增断言与用例；`toolRowIcon` / `.tool-row` CSS 未触碰（仍按债保留）。
- 三条命令**串行**执行，期间未运行其他门禁（规避 `verify:aa` 已知并发竞态）；未执行 `market:check` / `aa:check` / CI / 打包，未启动图形应用，未触碰生产数据。
- 顺序诚实说明：三条门禁跑在**最终代码树**上；其后只追加/订正了本节所在的未跟踪证据文档（`:325` 一处措辞在 `check` 之后才修），因此 `check` 不覆盖该文档的最后一次编辑。为此在文档定稿后补跑了文档守卫 `corepack yarn check:bilingual-docs`：exit **0**，`verify-bilingual-docs: 50 records and 100 documents are consistent`（本文件为中文单语证据，不在该守卫的 50 组双语记录内；未跟踪文件也不在 `check:whitespace` 的 `git ls-files` 范围内）。
- `check` 的整体 exit 0 为直接观察；链内单步 exit code 未逐一捕获，只记录了可观察的阶段输出（与 Task 10/14 同口径）。

