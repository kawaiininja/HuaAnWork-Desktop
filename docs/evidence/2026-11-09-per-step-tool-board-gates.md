# 逐 step 工具看板 — Task 8 文档订正与全量门禁证据（2026-11-09）

- 分支：`feat/per-step-tool-board`
- 门禁时 HEAD：`fd49700d9c15916a3a37d046562daa10135be419`（Task 7 收尾）；Task 8 的文档改动为工作树未提交内容
- 环境：macOS（darwin）、Node `v22.23.2`、Yarn `4.18.0`（经 Corepack）、`nodeLinker: node-modules`
- 计划：`docs/superpowers/plans/2026-11-09-per-step-tool-board.md` Task 8
- 范围：Task 8 只改文档与债务表，**不改源码、不改测试**；因此本次门禁与提交前同一份代码状态，等价于同时覆盖 Task 1–7 的实现
- 未启动图形应用；未打包；未触碰 `deepseek-harness/`

## 1. 文档改动（五项）

| # | 文件 | 改动 | 性质 |
| --- | --- | --- | --- |
| 1 | `docs/superpowers/specs/2026-11-01-chat-tool-panel-design.md` | §2 决策表在「聚合范围 / 每个用户回合一个面板」行之后追加一行「聚合范围（2026-11-09 重裁）」 | 追加；原行保留为历史 |
| 2 | 同上 | `:13`（§1 首条目标）、`:103-104`（§5.1「后续工具只更新同一个回合面板」所在的两条）、`:123`（§5.1「仍属于同一个用户回合和同一个工具面板」一段）之后各追加一条同文块引用历史标记 | 追加，不改原文 |
| 3 | `docs/superpowers/plans/2026-11-02-chat-tool-panel-plan-review.md` | m-4 段落末尾追加 `**处置（2026-11-09）**…`，记录 R-1 / R-7 关闭 goal 续轮面板碎裂，并把 `todo_write` 实时/历史差异明确登记为残余债、要求不得写成「完全一致」 | 追加 |
| 4 | `docs/evidence/2026-11-02-chat-tool-panel-verification.md` | 判定总表之后、§2 之前追加 `> 历史标记（2026-11-09，Step 2.1）…` | 追加，原始记录不动 |
| 5 | `AGENTS.md` | Known tech debt 表末尾追加两行：R-5 轮次推断降级、R-12 `todo_write` 实时/历史差异 | 追加 |

历史标记文本（三处同文，逐字取自计划）：

```
> 2026-11-09 重裁：本段的「每用户回合一个面板 / 后续工具只更新同一回合面板」语义已失效，改为同一 step 内更新该 step 的看板、跨 step 新建看板。见 `2026-11-09-per-step-tool-board-design.md` R-1 / §6。
```

### 落位偏差（第 4 项，Step 3）

计划的指定位置是「`:243` 的 Step 2.1 标题后追加一行」。`:243` 是「### 1. 判定总表」这张 GFM 表格的**第 1 个数据行**，其后还有 20 余行（Step 2.2–6.5）。块引用一旦插在表格行之间就会终止表格，使后续行退化为纯文本管道符段落——那等于改写原始记录，与「不改写原始记录」的约束直接冲突。

因此标记放在**该表结束后、§2 之前**，并在标记内以 `Step 2.1` 命名限定范围（「历史标记（2026-11-09，Step 2.1）」），其余文字与计划一致。仓库既有文档中没有「块引用紧跟表格行」的先例（`docs/` 全域扫描命中 0），此落位与既有排版惯例一致。

## 2. 全量门禁

命令（原文，未加任何参数）：

```bash
corepack yarn check > /tmp/per-step-tool-board-check.log 2>&1; echo "exit=$?"
```

输出：`exit=0`。日志：`/tmp/per-step-tool-board-check.log`（2407 行，160 576 B），运行约 2026-11-09 16:53–16:56 CST（约 3 分钟）。

**单次运行即通过，没有重跑，也没有任何子命令红过。** 根 `check` 是 12 条子命令的串行 `&&` 链，命令名与证据如下（`Test Files` / `Tests` 行逐字取自日志）。

| # | 子命令 | 证据 |
| --- | --- | --- |
| 1 | `check:whitespace` | TAP `1..7`，`# pass 7`，`# fail 0` |
| 2 | `check:layout` | TAP `1..6`，`# pass 6`，`# fail 0` |
| 3 | `test:aa-connector` | TAP `1..14`，`# pass 14`，`# fail 0` |
| 4 | `workspace dsh-community-fabric check` | TAP `1..4`，`# pass 4`；`verify-bilingual-docs: 50 records and 100 documents are consistent` |
| 5 | `workspace dsh-community-market check` | TAP `1..25` / `1..3` / `1..6` / `1..3` 四段全 pass；`verify-market-dependency-direction: 447 tracked source files …`；`verify-layout: HuaAnWork and retained workspaces are consistent with upstream 1600d8a1e1`；`verify-market-docs: 12 Markdown files, 6 bilingual pairs, and 4 schemas are consistent`；`verify-package-exports: 4 type exports exist`；`verify-market-client-loader: dsh-community-market registered one client module`；vitest `Test Files 13 passed (13)`、`Tests 303 passed (303)` |
| 6 | `workspace dsh-plugin-huaanwork check` | `build` ✓；`typecheck` 静默通过；vitest `Test Files 277 passed \| 4 skipped (281)`、`Tests 3865 passed \| 14 skipped (3879)`；`verify:closure` TAP `1..4` + `verify-runtime-closure: 316 first-party nodes form a closed reachable runtime graph.`；`verify:bundled` → `verify-bundled-runtime: 134 files checked; 9 bundled packages are inlined`；`verify:cli`、`verify:loader` 静默通过；`verify:profile` → `verify-profile-boot: minimal preset, plugin manager, and disabled hmr lock passed`；`verify:host` TAP `1..11`；`verify:aa` TAP `1..35`，`# fail 0`；`verify:licenses: 636 packages checked (9 bundled); 2 use notice-required licenses (LGPL-3.0-or-later)`；`verify:operations` → `verify-operation-reliability: 7 operations and 18 fault contracts verified.` |
| 7 | `workspace market-server check` | `typecheck` 静默通过；vitest `Test Files 14 passed (14)`、`Tests 244 passed (244)` |
| 8 | `workspace update-server check` | `typecheck` 静默通过；vitest `Test Files 5 passed (5)`、`Tests 88 passed (88)` |
| 9 | `workspace @huaanwork/catalog-signing check` | TAP `1..13`，`# pass 13`，`# fail 0` |
| 10 | `workspace @huaanwork/agent-package-format check` | TAP `1..35`，`# pass 35`，`# fail 0` |
| 11 | `workspace agent-catalog-server check` | `typecheck` 静默通过；vitest `Test Files 5 passed (5)`、`Tests 80 passed (80)` |
| 12 | `workspace agent-catalog-admin check` | TAP `1..15`，`# pass 15`，`# fail 0` |

### 2.1 测试总数

| 套件 | 文件 | 用例 |
| --- | --- | --- |
| `dsh-plugin-huaanwork`（vitest） | 277 passed / 4 skipped（281） | **3865 passed / 14 skipped（3879）** |
| `dsh-community-market`（vitest） | 13 passed | 303 passed |
| `market-server`（vitest） | 14 passed | 244 passed |
| `update-server`（vitest） | 5 passed | 88 passed |
| `agent-catalog-server`（vitest） | 5 passed | 80 passed |
| 其余 `node --test` 套件（whitespace 7、layout 6、aa-connector 14、fabric 4、market 25+3+6+3、closure 4、host 11、aa 35、signing 13、format 35、catalog-admin 15） | — | 181 passed |
| **合计** | — | **4761 passed / 14 skipped / 0 failed（4775 用例）** |

`dsh-plugin-huaanwork` 的 4 个 skipped 文件 / 14 个 skipped 用例是既有跳过，不是本次新增。

### 2.2 逐段子命令原文（除根 `check` 外，未单独重跑任何步骤）

根 `check` 一条命令覆盖上表全部 12 步，没有把任何步骤摘出来单跑。命令原文即 2 节的单行。

### 2.3 `check:whitespace` 的覆盖范围与提交后补跑

`check:whitespace` 跑的是 `git diff --check <merge-base>..HEAD`，只覆盖**已提交**的改动；门禁时 Task 8 的全部 5 个文件（§1 表中的 4 个文件，加上本证据文档自身）都还在工作树（未提交 / untracked），故该步骤**对这 5 个文件零覆盖**——上文「没有重跑」只描述门禁当时的全量运行，并非指这些文件已受检。提交后在 HEAD `fd710a8865` 上单独补跑 `corepack yarn check:whitespace`：退出码 `0`，TAP `1..7`、`# pass 7`、`# fail 0`，日志 `/tmp/per-step-tool-board-whitespace-postcommit.log`。这是提交后对该步骤的补充覆盖，不改变 2 节记录的 `exit=0` 与第 2.1 节的测试总数。

## 3. 新增测试

Task 1–7 共新增 **30** 个用例（`git diff b9ecdd2289..HEAD -- dsh-plugin-huaanwork/tests` 中新增的 `it(` / `test(` 行计数 = 30，与各任务报告逐项相加一致）。计数命令原文与退出码：

```bash
git diff b9ecdd2289..HEAD -- dsh-plugin-huaanwork/tests | grep -E '^\+' | grep -cE "^\+\s*(it|test)(\.each\(.*\))?\(" ; echo "exit=$?"
```

输出：`30`，`exit=0`。

| 任务 | 文件 | 新增 |
| --- | --- | --- |
| Task 1 | 无（仅类型声明） | 0 |
| Task 2 | `tests/huaanwork-host/session-view.spec.ts` | 2 |
| Task 3 | `tests/client-huaanwork/sessionChannel.spec.ts` | 1 |
| Task 4 | `tests/client-huaanwork/toolPanel.spec.ts` | 12 |
| Task 5 | `tests/huaanwork-guardrails/bridge.spec.ts` | 3 |
| Task 6 | `tests/client-huaanwork/appWiring.spec.ts` | 6 |
| Task 7 | `tests/client-huaanwork/thinkingPanel.spec.ts` +1（`appWiring.spec.ts`） | 5 + 1 |
| **合计** | — | **30** |

回归对照：Task 5 首次全量跑时为 `3867` 用例（含当时已落的 18 个新用例：Task 2/3/4/5 的 2+1+12+3），Task 6 后 `3873`，本次门禁 `3879`；与「3849 基线 + 30 新增」吻合。

## 4. `verify:aa` 是否重跑

**没有重跑。** 原因：`verify:aa` 在本次单次 `corepack yarn check` 内已经真实执行并通过——`node ../scripts/prepare-agents-anywhere-runtime.mjs && DSH_VERIFY_AA=1 node scripts/verify-profile-boot.mjs` 的 TAP 段 `1..35`、`# fail 0`，其中包含 AA 宿主服务用例（如「文本回合:token 帧 + session/end ok + 会话列表标题非空」）。根 `AGENTS.md` 债表首行的 `verify:aa` 并发 race 只在**同时**跑另一个含 `verify:aa` 的门禁时出现；本次只有一条门禁在跑，不存在并发。因此没有第二次结果需要对照，也没有「一次全绿」之外的口径需要声明——本次确实是单次全绿。

## 5. 已知 flake 观察

`tests/huaanwork-host/agent-package-runtime.spec.ts` 的 `hang-state.txt` ENOENT（两写竞态，Task 5 登记）在 Task 5 的全量跑中曾出现一次，当时单独跑 54/54 通过、全量重跑也通过。**本次门禁未复现**（277 个文件通过、4 个跳过、0 失败）。

## 6. 未运行项（明确未覆盖）

- **Windows 打包与制品校验**：未运行 `corepack yarn dist:win` / `verify-win-installer.ts`，未产出或复验任何安装包。
- **真机验收（Task 9）**：未启动图形应用，设计 §10 的 A1–A10 全部未执行；本文档不含任何真机结论。`lib/` 由 `check` 内的 `build` 重建，但那只是构建产物，不是验收。
- **CI**：未推送、未运行 GitHub Actions；本文档的门禁结果全部来自本机。
- **`corepack yarn market:check` / `aa:check` / 独立 `verify:aa` 重跑**：未运行（不在 Task 8 范围内，且 `check` 内已含 `prepare-agents-anywhere-runtime.mjs` 与 `test:aa-connector`）。

## 7. 判定

Task 8 的文档订正与债务登记已完成；`corepack yarn check` 单次 `exit=0`，4761 通过 / 14 跳过 / 0 失败，`verify:aa` 35/35 在位。本里程碑仍缺真机验收（Task 9），不得据此宣称功能已验收。
