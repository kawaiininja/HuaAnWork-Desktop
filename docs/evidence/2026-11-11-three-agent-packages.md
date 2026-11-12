# 三智能体包入驻广场 —— 实测证据（2026-11-11 计划）

本文件由 Task 0 创建；Task 10 起逐任务追加后续节。本任务只提交「Task 0 spike」节，scratch 脚本一律留在 `/tmp/typo-plaza-spike/`，不随提交分发。

| 项 | 值 |
| --- | --- |
| 分支 / worktree | `feat/three-agent-packages-plaza` / `.worktrees/three-agent-packages-plaza` |
| 基线 HEAD | `739fac204f` |
| Node / Yarn | `v22.23.2` / `4.18.0`（Corepack） |
| 平台 | macOS `27.0.1`，`arm64` |
| Harness pin | `1600d8a1e140dcde43a1a0941940a0480712c011`（`git submodule status`；开始时本 worktree 的子模组**未检出**，已用 `git -c protocol.file.allow=always submodule update --init --recursive` 从本地共享库检出同一 pin，子模组 `git status` 干净） |
| 运行时包版本 | `@deepseek-ai/dsh-subagent@0.2.1-rc.1`（`dsh-plugin-huaanwork/node_modules`，包入口重导出 `resolveChildDepth`/`delegationDepthOf`/`SubagentDepthError`） |
| 上游子模组改动 | 0（只做只读 grep 读源码；未编辑任何文件） |

---

## Task 0 spike（R8：产品默认 `maxDepth: 2` 注入）

### 0.1 N-1 深度机制实测（真实上游函数，非 fake 逻辑）

命令（cwd = worktree 根；脚本经 `/tmp/typo-plaza-spike/depth-probe.mjs` 传入 `-e`）：

```bash
corepack yarn workspace dsh-plugin-huaanwork exec node --input-type=module -e "$(cat /tmp/typo-plaza-spike/depth-probe.mjs)"
```

脚本与任务书 Step 1 逐字一致（最小 parent 形态 `{ options: { subagentDepth: 1 }, session: { header: {} } }`）。输出：

```
depth mechanism verified
EXIT=0
```

断言结论（真实 `@deepseek-ai/dsh-subagent` 运行时包）：

- `delegationDepthOf(pkgChild)` = 1（包子会话深度 1）。
- `resolveChildDepth(pkgChild, 1)` 抛 `SubagentDepthError(attemptedDepth=2, maxDepth=1)` ⇒ **上游默认 cap=1 结构性拒绝 lane 派发**（N-1）。
- `resolveChildDepth(pkgChild, 2)` = 2 ⇒ cap=2 放行 lane。
- `resolveChildDepth(lane, 2)` 抛 `SubagentDepthError(attemptedDepth=3)` ⇒ 同一 cap 天然封死曾孙嵌套。

三条 grep 证据：

| # | 命令 | 结果 |
| --- | --- | --- |
| ① | `grep -n -A5 "id: tool-subagent$" dsh-plugin-huaanwork/node_modules/@deepseek-ai/dsh-base/cordis.patch.yml` | `:380-384` 只有 `provider: spawn` / `toolName: subagent`，**无 maxDepth**；同文件 `grep -c "maxDepth"` = **0**。服务本体行 `:359-360`（`id: subagent` / `@deepseek-ai/dsh-subagent`）也无 config |
| ② | `grep -rn "maxDepth" dsh-plugin-huaanwork/src` | 本任务前 = **0 命中**；本任务后 = 2 行，均在 `src/profile.ts`（`:113` 注释、`:1540` 产品默认行） |
| ③ | `sed -n '194,198p' deepseek-harness/packages/subagent/subagent/src/index.ts` | `:196` `maxDepth: z.number()…default(1).volatile()`（`SubagentRuntime.Config`） |

### 0.2 注入点：实测候选后选定「bundle 之后、用户层之前」的产品默认层

候选按任务书优先级核查，结论如下（**以真实 `prepareDesktopProfile` + `composeEntries` + `SubagentRuntime.Config` 实测，不是按代码猜**）：

| 候选 | 生效机制 | 侵入性 | 结论 |
| --- | --- | --- | --- |
| 1a 末尾 `patches` 数组直接追加 `{ id: 'subagent', config: { maxDepth: 2 } }`（任务书字面位置） | launcher 层最后 compose，**覆盖**用户 profile patch 层 | 只改 `profile.ts`，但会**遮蔽**用户值 | **否**：见 §0.3 测量 C/D，违反 P2 保留门，且会让设置写入报错 |
| 1b 同一行，改置于 `ordinary` 的 bundle 层之后、`filteredProfile`/`filteredHome` 之前（**最终采用**） | 产品默认作为最弱层；用户 profile patch 层（设置写入处）与 machine-wide patch 层都在其后，`applyEntryPatches` 按整条 `config` 替换 ⇒ 用户值胜出 | 只改 `profile.ts`（同一行 + 常量）；不写用户数据、不碰 node_modules、不碰上游 | **采用** |
| 2 Host 设置存储默认值（初始化时写 `subagent.maxDepth: 2` 进 profile） | 落成用户数据 | 写用户 profile 文档；默认值与用户值不可区分；旧 profile 需迁移 | 不需要（1b 的 volatile 实测成立） |
| 3 tool-subagent 工具级 `maxDepth`（`resolveMaxDepth` 直接返回、绕过 Host 设置） | 工具级固定上限 | 绕过用户设置 | 不需要；按任务书不得静默当默认值 |

选定实现（`dsh-plugin-huaanwork/src/profile.ts`）：

- `:121` 模块内常量 `DESKTOP_SUBAGENT_MAX_DEPTH = 2`（JSDoc 写清「包子会话深度 1 派 lane 深度 2、上游默认 1 会拒绝」与层级理由；不导出——回归钉断言组合产物而不是常量本身，避免同义反复）。
- `:1540` 在 `prepareDesktopProfile` 的 `ordinary` 组合里、`filteredBundles.patches` 之后插入 `{ id: 'subagent', config: { maxDepth: DESKTOP_SUBAGENT_MAX_DEPTH } }`；`filteredProfile.patches`、`filteredHome.patches` 与 launcher 自己的 `patches` 都在其后。

层级依据（源码实测）：`app-boot` 的 `applyEntryPatches`（`node_modules/@deepseek-ai/dsh-app-boot/lib/index.js:61-110`）对非 insert patch 执行 `target[key] = value` ⇒ **整条 `config` 替换而非逐字段合并**。因此「产品默认放在用户层之后」不是默认值而是强制覆盖。

### 0.3 volatile 语义与用户设置保留实测

`maxDepth` 是 schemastery volatile 字段（§0.1 ③）：Loader 用组合产物里的 `subagent.config` 解析 `SubagentRuntime.Config`，得到活单元格；Host 的 `resolveMaxDepth()`（`subagent/src/index.ts:242-248`）读 `this.config.maxDepth.get()`。

**实现前**（`/tmp/typo-plaza-spike/injection-probe.mjs`，真实 `prepareDesktopProfile` + 临时 home）：

```
A no-user-row: null
B user=3 composed: {"maxDepth":3}
C user=3 + late default: {"maxDepth":2}
D pending editor compose: {"maxDepth":3}
D + late default (editor check target): {"maxDepth":2}
E Config({maxDepth:2}).maxDepth.get() = 2
E Config({}).maxDepth.get() = 1
```

- C 证明字面「末尾追加」会把用户保存的 3 覆盖成 2（用户值被静默遮蔽）。
- D 复刻 config editor 的写入校验（`dsh-config-editor/lib/index.js:122`：组合结果 ≠ 待写值即抛 `Configuration for "<id>" is overridden by a home patch or command-line overlay`）：用户写 3、组合得 2 ⇒ **用户在设置面根本无法保存 maxDepth**。
- E 证明 volatile 单元格确实由组合产物播种：传 2 得 2，缺席回落 schema 默认 1。

**实现后**（`/tmp/typo-plaza-spike/injection-probe-2.mjs`，同一真实链路）：

```
A absent -> {"name":"@deepseek-ai/dsh-subagent","config":{"maxDepth":2},"get":2}
B user=3 -> {"config":{"maxDepth":3},"get":3}
C user=maxActiveSubagents only -> {"config":{"maxActiveSubagents":4},"get":1}
D pending write maxDepth=3 -> {"config":{"maxDepth":3},"get":3}
E machine-wide=4 -> {"config":{"maxDepth":4},"get":4}
```

- A：设置缺席 ⇒ 运行时有效值 **2**（开箱即用）。
- B：用户值 3 ⇒ 保留 **3**（P2 保留门成立）。
- D：设置面写入 maxDepth=3 的校验组合 = 3 ⇒ 写入不会被判「被覆盖」。
- E：machine-wide `cordis.patch.yml` 的值同样优先于产品默认（管理员层不被遮蔽）。
- C：**已知边界（如实登记；产品 UI 可触达）**：patch 行对 `config` 是**整条替换**而不是逐字段合并，所以用户行一旦不含 `maxDepth`，有效值回落到 schema 默认 1 而不是产品默认 2。触发面按写操作分成两类：
  - **`set` 类不触发**：`SettingsFormModel.plan()`（`dsh-client-ui-primitives/lib/index.js:7448`）为普通编辑发 `{op:'set', path:[field], value}`（`:7481-7487`）；`dsh-settings` 的 `mutate()`（`dsh-settings/lib/index.js:488-500`）把它应用到「当前**有效** config 的投影」（`entry.options.config`）上，故 `maxDepth` 与同族字段一并落盘。
  - **`unset`/清空类触发**：卡片的 `resetField`（`dsh-client-ui-primitives/lib/index.js:7384-7389`，plan 在 `:7462-7468`，仅当该字段在用户层存在时）与「把输入框清空再保存」（`:7474-7480`；`spec.parse` 对空串返回 `{kind:'clear'}`，`:7261`/`:7282`）都发 `{op:'unset', path:[field]}`。`mutate()` 的 `unset` 分支（`dsh-settings/lib/index.js:488-500`）先到 config editor 给的 `inherited` 层找可回落的继承值；该层由 `inherited()`（`dsh-config-editor/lib/index.js:54-63`）只重组合磁盘层（bundle + home），**不含 launcher 内存里的产品默认行**，而本仓 bundle 的 `subagent` 行无 config ⇒ inherited = `{}` ⇒ 找不到继承值，`applyPathOp` 的非数组分支执行**删键**（`dsh-settings/lib/index.js:189-214`，删除在 `:204`）。随后 `write()` 落盘 `mergeLayers(strip(raw, form), next)`（`:501-536`，`strip` 在 `:524-533`、`mergeLayers` 在 `:534`）；`subagent` 两个字段都是 volatile（`deepseek-harness/packages/subagent/subagent/src/index.ts:196-197`），`strip(raw, form)` = `{}`，所以落盘行恰好等于 `next`。
  - **具体后果**：用户先存过同族字段（如 `maxActiveSubagents: 4`），再点 `maxDepth` 的清除/重置（或清空后保存）⇒ 落盘行 = `{maxActiveSubagents: 4}` ⇒ 下次组合整条替换 ⇒ 开箱默认 2 静默变回 1，R8 要防的包子会话派 lane 失败复现。反过来，`set` 路径落盘行会带上生效的 `maxDepth`，故普通编辑不受影响。
  - **处理与裁定**：本任务不引入字段级合并（那是 patch 语义/产品决定，改动面超出 R8 注入），边界按「登记 + 钉住」交付：回归钉 `drops the product default when a user row carries only a sibling field`（`tests/profile.spec.ts`，经 `profilePatches` 组合 `{ id: 'subagent', config: { maxActiveSubagents: 4 } }` ⇒ 有效 `maxDepth` = 1）。是否做字段级合并、或在设置卡片层规避清空路径，作为显式产品决定留给后续任务（与 Task 11/12 的实测一并复核），不属本任务静默扩大的范围。

### 0.4 N-2 ask 档 bash 判定实测（真实 `@huaanwork/policy`）

命令（与任务书 Step 3 逐字一致）：

```bash
corepack yarn workspace dsh-plugin-huaanwork exec node --input-type=module -e "$(cat /tmp/typo-plaza-spike/ask-tier-probe.mjs)"
```

输出：

```
ask-tier bash policy verified
EXIT=0
```

判定事实（macOS，工具名 `bash`、参数 `command`）：

| 场景 | preExecute | guard | 依据 |
| --- | --- | --- | --- |
| ask 档单命令 `textutil -convert txt -output …` | `ask` | `deny` / `REASON_NEEDS_APPROVAL` | 包子会话没有审批界面 ⇒ 交互 ask 必被拒 |
| ask 档复合命令（`&&` 连接） | — | `deny` / `REASON_SHELL_METACHAR` | 元字符集 `| & ; $` 与反引号；`>` 不在集合内 |
| smart 档同一 `textutil` 命令 | `allow` | `allow` | R9 已裁定 Task 12 显式写 `guard_mode: "smart"` |

「包子会话没有审批界面」为仓库既有事实：`src/huaanwork-guardrails/policy.ts:234` 与 `src/huaanwork-host/holders.ts:46` 注释；packageRuntime 豁免只覆盖 `mcp__*`。**判定层实测；真机确认留 Task 12**（本任务未启动图形应用）。

### 0.5 回归钉（先红后绿）

测试落在既有 `dsh-plugin-huaanwork/tests/profile.spec.ts`（追加 4 个 `it`：实现轮 3 条 + 修复轮 1 条；复用该 spec 的临时 home 与真实 `prepareDesktopProfile`）：

1. `ships a two-level delegation cap so a package child can dispatch its lane subagents` —— 组合行的 `subagent.config` = `{ maxDepth: 2 }`，且经 **运行时同一读取路径** `SubagentRuntime.Config(行 config).maxDepth.get()` = 2。
2. `pins the depth arithmetic the shipped packages rely on` —— 用真实 `resolveChildDepth`/`SubagentDepthError`：cap=1 时 parent 深度 1 派 lane 抛错（N-1）；从组合产物读出的 cap 放行 child 深度 2；parent 深度 2 再派抛错（深度 3 > cap）。
3. `preserves a saved maxDepth instead of shadowing it with the product default` —— 缺席 ⇒ 2；profile patch 写 3 ⇒ 3；config editor 的 pending 写入组合 ⇒ 3。
4. `drops the product default when a user row carries only a sibling field`（修复轮）—— 组合 `{ id: 'subagent', config: { maxActiveSubagents: 4 } }` ⇒ 有效 `maxDepth` = 1，钉住 §0.3 C 的整条替换边界。

RED（实现先 `git stash` 掉 `src/profile.ts`；实现轮 3 条钉）：

```bash
corepack yarn workspace dsh-plugin-huaanwork exec vitest run tests/profile.spec.ts -t "delegation cap|depth arithmetic|saved maxDepth"
# Test Files  1 failed (1)
# Tests  3 failed | 59 skipped (62)
# 失败原文（摘要）：
#   1) ObjectContaining {"config":{"maxDepth":2}} vs received {"id":"subagent","name":"@deepseek-ai/dsh-subagent"}
#   2) SubagentDepthError: subagent depth 2 exceeds maxDepth 1（在第 172 行 cap 读取处）
#   3) expected 1 to be 2
```

GREEN（恢复实现；实现轮 3 条钉）：

```bash
corepack yarn workspace dsh-plugin-huaanwork exec vitest run tests/profile.spec.ts -t "delegation cap|depth arithmetic|saved maxDepth"
# EXIT=0 ; Tests  3 passed | 59 skipped (62)
corepack yarn workspace dsh-plugin-huaanwork exec vitest run tests/profile.spec.ts
# EXIT=0 ; Tests  62 passed (62)
```

修复轮（新增第 4 条钉后的复跑；两个命令均 EXIT=0）：

```bash
corepack yarn workspace dsh-plugin-huaanwork exec vitest run tests/profile.spec.ts -t "delegation cap|depth arithmetic|saved maxDepth|sibling"
# Tests  4 passed | 59 skipped (63)
corepack yarn workspace dsh-plugin-huaanwork exec vitest run tests/profile.spec.ts
# Tests  63 passed (63)
```

类型检查（改动文件所属工程）：

```bash
corepack yarn exec tsc --noEmit -p tsconfig.json        # EXIT=0（host 工程，含 src/profile.ts）
corepack yarn exec tsc --noEmit -p tsconfig.tests.json   # EXIT=0（含 tests/profile.spec.ts）
```

注：首次跑 `tsconfig.json` 时 `Cannot find module 'dsh-community-market/contracts'`（2 条，与本改动无关）——该包 `lib/` 未构建。按仓库既有前置（`check:mac-package:platform` 同样先 `yarn workspace dsh-community-market build`）构建后两条错误消失，上面记录的是构建后的结果；构建产物为 git-ignored，不在提交内。

附：环境前置对包内测试的影响（**计数面必须先分清**：vitest 的 `Test Files … failed` 与 `Tests … failed` 不是同一个数——收集期失败的 spec 计 1 个失败文件、0 条失败测试，`verify-packaged-runtime` 即 `Tests no tests` 的形态）。实现轮的记录形如 `3852 passed / 5 failed（6 文件）`，但当时列出的 6 个文件名无法与「5 条失败测试」对齐（文件数与测试数混写，故不可核对）。**修复轮复核（2026-11-11）**：Electron 二进制此刻已就位，单跑这 6 个文件 ⇒ `Test Files 4 failed | 2 passed (6)`、`Tests 4 failed | 105 passed | 1 skipped (110)`；`huaanwork-market-provider` 与 `host-process` 通过；余下失败 = 缺 `lib/` 的三项（`verify-packaged-runtime` 收集期 `ENOENT: … scandir …/lib`、`package.spec` 缺 `lib/client.js`、`recovery-plugin-uninstall` 缺 `lib/desktop-cli.js`）与 `host-process-integration` ×2（隔离 host 启动 60s 超时）。与本改动无关；Task 10/12 的完整门禁会先 `build`，届时以那次的退出码为准。

### 0.6 真机抽查：BLOCKED（按任务书口径转交 Task 12）

未执行 `open-latest-huaanwork` 图形启动，也未在真实 Electron 实例里读取有效值。原因如实登记：

- 仓库规则要求图形启动显式化，本任务未获图形启动授权；
- 本任务确认的读取路径是**组合层**（`prepareDesktopProfile` → `composeEntries` → `SubagentRuntime.Config(…).maxDepth.get()`），与 Host 进程内 `ctx.subagents.config.maxDepth.get()` 同源；GUI 启动本身不提供脚本可读的额外断言，且需要先整包构建。

承接方式：Task 12 的 `requireMaxDepth()` 前置断言按 §0.8 的读取路径执行，读不到或 `< 2` ⇒ `BLOCKED exit 3`，不会静默放行。

### 0.7 N-3 探针的源码层面证据（留 Task 11/12 实测）

- **正常时序**：上游 `deepseek-harness/packages/subagent/subagent/src/manager.ts:1081-1091` 的 `settlementState()` 在 `activation.ownedChildren.size > 0` 时返回 `'wait'`；`watchLocalSettlement()`（函数体 `:1024-1073`，前一行 `:1023` 是它的 JSDoc）收到 `'wait'` 后 `await idleObservation.promise` 再继续。`ownedChildren` 的删除有两个点，按 pin `1600d8a1e1` 实测：正常路径是 `releaseOwnership()`（`:1010-1014`，`delete` 在 `:1012`），失败路径是 `holdOwnership()` 的 releaser（`:661-668`，`delete` 在 `:668`，`:669` 是该闭包的收尾大括号）。⇒ 有存活 owned child 的父 activation **不会结算关闭**，血缘条目在 lane 回传结果与仲裁期间保持存活。
- **残余边缘**：`dsh-plugin-huaanwork/src/huaanwork-host/agent-package/host.ts:309` 的 `ACTIVATION_CLEANUP_TIMEOUT_MS = 600_000`（10 分钟清理预算）。真实路径在 `:804-817`：`settleWithin(currentActivation.result, cleanupTimeoutMs)` 竞速取消门，超时后只记清理预算（`subagentRuns.noteCleanupBudget`）并打一条 `console.error`，随后 `disposeActivation` 释放 activation——该分支**不**写 `cleanupFailures`（`:809-812` 注释明说 result 晚结算不是清理失败；`cleanupFailures` 由 `disposeActivation`/`stopTurnRuntime` 的失败与超时写）。`:664-673` 是验收注入缝（`acceptanceDisposeFailure() === 'hang'` 时的 `cleanupTimeoutMs` 等待），不是真实超时路径。⇒ 若 lane 在该预算内未结束，血缘条目可能在仲裁仍待结果时被清理。该边缘的真实时序留 Task 11/12 实测，不在本任务下结论。

### 0.8 有效 maxDepth 读取路径（Task 12 `requireMaxDepth()` 按此实现）

**运行时（Host 进程内，权威）**：Loader 用组合产物的 `subagent` 行 `config` 解析 `SubagentRuntime.Config`（schemastery，`maxDepth` 为 volatile），插件实例上的读取是 `ctx.subagents.config.maxDepth.get()`；业务方法 `SubagentRuntime.resolveMaxDepth()`（`deepseek-harness/packages/subagent/subagent/src/index.ts:242-248`）在工具未显式给上限时返回同一 `get()` 值。

**预检（Task 12 的脚本，启动前，只有 `profileDir`）**：与 launcher 同一条组合代码，不读 `settings.json`：

```js
import { dirname } from 'node:path'
import { composeEntries } from '@deepseek-ai/dsh-app-boot'
import { SubagentRuntime } from '@deepseek-ai/dsh-subagent'
import { prepareDesktopProfile } from '../lib/profile.js'   // 构建产物；或见下方 import 模式说明

const home = dirname(dirname(profileDir))                    // <home>/profiles/desktop → <home>
const prepared = prepareDesktopProfile(undefined, home)      // 与 main.ts 同一函数；参数默认值足够
const row = composeEntries([prepared.patches]).find(entry => entry.id === 'subagent')
const maxDepth = SubagentRuntime.Config(row?.config ?? {}).maxDepth.get()
if (!(maxDepth >= 2)) process.exit(3)                        // BLOCKED
```

**import 模式（重要，别踩坑）**：`src/profile.ts` 的依赖链包含参数属性语法（如 `src/desktop-plugins.ts:141` 的 `readonly code`），**纯 `node` 直接 import `.ts` 会 `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`（已实测复现）**。二选一：

- `import('../lib/profile.js')`：需先 `yarn workspace dsh-plugin-huaanwork build`（Task 12 反正要为启动构建；若 `requireMaxDepth()` 必须在构建前执行，则把预检挪到 build 之后，或走下一条）；
- 以 `NODE_OPTIONS=--experimental-transform-types`（Node 22.23 实测可用，本任务三个探针即此模式）运行脚本并 `import('../src/profile.ts')`，无需构建。

要点：

- 读取处是 `dsh-plugin-huaanwork/src/profile.ts` 的 `prepareDesktopProfile` 返回值 `.patches`，经 `composeEntries` 合成后 `subagent` 行的 `config.maxDepth`；这就是 `main.ts` 交给 `boot(BIN_NAME, rootConfig, prepared.patches, …)` 的同一份列表。
- 必须经 `SubagentRuntime.Config(...).maxDepth.get()` 解析，而不是直接读 `row.config.maxDepth`：前者与运行时同一 schema（含默认值与 volatile 播种），后者只是原始配置。
- `prepareDesktopProfile` 的副作用（写空 `cordis.yml`、pnpm workspace 校正、settings 一次性导入迁移）都是应用启动本来就会做的事；Task 12 在自己的隔离 home 上调用即可。market selection / AA hooks 不影响 `subagent` 行（本任务实测 A–E 均用默认 snapshot）；如需与启动完全同参，把 Task 12 实际使用的 `marketSelection`/`hooks` 传入。
- 禁止读 `profileDir/settings.json` 或 `dirname(homeDir)/settings.json`（那是模型地址与密钥，且不含 maxDepth）。

### 0.9 改动面与 scratch

| 文件 | 变更 |
| --- | --- |
| `dsh-plugin-huaanwork/src/profile.ts` | +`DESKTOP_SUBAGENT_MAX_DEPTH`（`:121`，JSDoc 注明该行整条替换 bundle 级 `subagent` config）；`prepareDesktopProfile` 的 `ordinary` 组合插入产品默认行（`:1540`） |
| `dsh-plugin-huaanwork/tests/profile.spec.ts` | 新增 4 条回归钉 + 2 个 helper（`effectiveSubagentMaxDepth`、`agentAtDepth`） |
| `docs/evidence/2026-11-11-three-agent-packages.md` | 本文件（Task 0 节） |

scratch（未提交）：`/tmp/typo-plaza-spike/{depth-probe.mjs,ask-tier-probe.mjs,injection-probe.mjs,injection-probe-2.mjs}`。

---

## Task 10 中间门禁与证据汇总（2026-11-12/13 本地跨午夜实测）

> **本节是中间门禁，不是最终门禁。** 实测树为 `736ede7742`（Task 9 之后、Task 11/12 之前）。其后 Task 11 可能按独立评审修安全代码、Task 12 新增 CDP 真机脚本，最终代码树的 `typecheck`/`test`/`check` 在 Task 12 Step 5 重跑，**最终证据以那一次为准**；本节不得被引用为最终门禁结论。

### 10.1 运行时扩展 C1–C5：commit / 测试 / 退出码

| 能力 | commit | 生产文件 | 覆盖测试 | 任务报告记录的聚焦绿跑（exit 0） | 本节全量门禁实测 |
| --- | --- | --- | --- | --- | --- |
| R8 产品默认 `maxDepth: 2`（Task 0） | `2f2ae65c0f` + fix `67fc1a88c2` | `src/profile.ts`（`DESKTOP_SUBAGENT_MAX_DEPTH`，`prepareDesktopProfile` 产品默认层） | `tests/profile.spec.ts`（4 条回归钉 + 2 helper） | `63 passed (63)` | `tests/profile.spec.ts (63 tests)` 绿 |
| C1 allow list 加 `subagent` | `d5e3a2d8e4` | `src/huaanwork-host/agent-package/runtime.ts` | `tests/huaanwork-host/agent-package-runtime.spec.ts`（`follows the declared modes and never exposes host tools`、`includes subagent for both platform shells`） | 全文件 `55 passed` | 全文件本轮 `57 tests` 绿 |
| C2 血缘 holder | `a6b3ba0310` | `src/huaanwork-host/holders.ts` | 同上 + `tests/huaanwork-guardrails/agent-package-tools.spec.ts`（幂等清理场景加 map 断言） | runtime spec `56 passed` | `agent-package-tools.spec.ts (63 tests)` 绿 |
| C3 bind / 按引用释放 | `a6b3ba0310` | `src/huaanwork-host/agent-package/host.ts` | `agent-package-runtime.spec.ts`（`binds the turn allow reference for children and clears by reference on cleanup` + 取消/会话 id 复用场景扩展） | runtime spec `56 passed` | runtime spec `57 tests` 绿 |
| C4 孙代收窄（传递绑定） | `e804df9cde` | `src/huaanwork-guardrails/skills.ts` | `tests/huaanwork-guardrails/package-subagent-lineage.spec.ts`（9 条矩阵：收窄、首步工具表、曾孙传递、无血缘不触发、legacy 优先、包请求优先、legacy wrapper、`tools/change` 保持、双包隔离） | 本 spec `9 passed` + `skills.spec.ts` 39 = `48 passed` | 本 spec `9 tests` 绿 |
| C5 执行期拒绝 | `52ed4c5901` | `src/huaanwork-guardrails/policy.ts` | `tests/huaanwork-guardrails/policy.cordis.spec.ts`（`lineage sessions are denied out-of-allow tools at execute time even before schema narrowing`） | 全文件 `34 passed` | 全文件 `34 tests` 绿 |

聚焦绿跑的退出码来自各任务报告（`.superpowers/sdd/2026-11-11-three-agent-packages-plaza/task-{0,1,2,3,4}-report.md`）；「本节全量门禁实测」来自下节 `corepack yarn test` 的同一份日志（`/tmp/task10-test.log`）。对 spec §4.4 的映射：C1 = 第 1 项；C4 的 9 条 = 第 2、3 项与跨包隔离/legacy/主会话/`tools/change` 不回归（第 5、7、8 项）；C5 = 第 4 项；第 6 项清理（回合结束/取消后 map 无残留、id 复用不继承）由 C2/C3 在 `agent-package-runtime.spec.ts` 与 `agent-package-tools.spec.ts` 的场景覆盖。

### 10.2 三包源文件：manifest 字段与预算实测

三包共同字段（`parseAgentPackageManifest` 全部通过；`tests/huaanwork-host/agent-package-sources.spec.ts` 9 tests 逐字段精确断言，全量门禁绿）：`schemaVersion: 1`、`version: "1.0.0"`、`persona: "persona.md"`、`skill.entry: "skill/SKILL.md"`、`tools: { mode: "none" }`、`allowSkills: []`。`draftId`/`createdAt`/`updatedAt` 为固定占位，播种脚本（Task 8）写入前重新生成。

| slug | displayName | description（字符/UTF-8 字节） | manifest 规范化 JSON B | persona B | SKILL.md B | `agentPackageBytes` 整包 B | 上限 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `typo-check` | 错别字检测 | 83 / 211 | 677（源文件 `agent.json` 661 B） | 536 | 8433 | 9646 | persona/SKILL 各 32768；整包 5242880 |
| `code-review` | 代码审查 | 76 / 200 | 674（源文件 658 B） | 432 | 2771 | 3877 | 同上 |
| `task-orch` | 任务编排 | 95 / 231 | 694（源文件 678 B） | 477 | 4156 | 5327 | 同上 |

测量方法（本节实测，exit 0）：`agent-package-sources.spec.ts` 的 `stays within store budgets` 只断言 ≤ 上限、不打印数值；本表字节用 `src/huaanwork-host/agent-package/store.ts` 的 `agentPackageBytes()`（`JSON.stringify(manifest, null, 2) + "\n"` + persona + skill）与 `parseAgentPackageManifest()` 对 `dsh-plugin-huaanwork/agent-packages/{slug}/` 逐包实测。上表 manifest 列即该函数使用的规范化字节数（源文件 B 数另列，二者差在 JSON 重排与尾换行）。上限常量：`MAX_PERSONA_BYTES = MAX_SKILL_BYTES = 32768`、`MAX_PACKAGE_BYTES = 5242880`（`store.ts:37-43`）。三包整包分别占上限 0.18% / 0.07% / 0.10%，persona 与 SKILL.md 均在各自 32 KiB 内（SKILL.md 最紧的是 typo-check，25.7%）。与 Task 8 报告记录的 9646 / 3877 / 5327 一致。

### 10.3 播种与广场发布验证

**播种（Task 8）**：`tests/huaanwork-host/seed-agent-packages.spec.ts` 在 `corepack yarn test` 中 `2 tests` 绿（`/tmp/task10-test.log`；Task 8 报告的聚焦复跑同为 2/2、exit 0）。两条覆盖：① happy path（三包写入隔离 profile、stdout `{seeded,details}` 字节数与 §10.2 一致、`agents-state.json` 精确四字段）；② `rejects an oversized third source before writing any package`（预检覆盖写时校验，第三包 persona 超限 ⇒ 非零退出且 profile 目录为空，无部分写入；Task 8 修复报告记录了 mutation 证据）。本任务未单独手跑播种 CLI，测试内部真实 spawn 该脚本。

**广场发布验证（Task 9）**：本任务在中间树上重跑（2026-11-13 00:03 本地，`--out` 落到 `/tmp/plaza-verify-report-task10.json`）：

```bash
cd dsh-plugin-huaanwork
corepack yarn exec node --experimental-transform-types scripts/verify-agent-packages-plaza.mjs \
  --out /tmp/plaza-verify-report-task10.json
# EXIT=0；stdout 报告 outcome=PASS
```

脱敏摘要（报告文件已按 Task 9 的 redaction 深度脱敏；复核 `plaza-probe-read-/publish-/admin-` 与 `PRIVATE KEY`/`BEGIN` 命中均为 0）：

- `legacyConflict`: `PASS (409 for all three slugs)` —— typo-check / code-review / task-orch 三条同名 kind:"tool" fixture 均返回 HTTP 409，且未记录假 pending。
- 三个提交 id：`ea25305b…` / `f0ec8f8d…` / `baad5b64…`（每运行现场生成）；`reviewedAndSigned.keyId` = `80f7c5cf…57842`（每运行一次性开发密钥，非生产）。
- `plazaBeforeInstall`: 3 张卡 `installed:false`，displayName = 代码审查 / 任务编排 / 错别字检测。
- `installedAndVerified`: 三包安装并独立复验 keyId + digest 通过；`plazaAfterInstall`: `installed slugs excluded`；`enabled`: 三包 `enabled:true`。
- 本次非 `--keep-catalog` 运行未留临时根（Task 9 的 `--keep-catalog` 记录根 `/var/folders/…/huaanwork-plaza-verify-9XaJJq` 仍在，含一次性私钥、权限 0600，留给 Task 12 使用/清理）。
- Task 9 的原始 PASS 报告 `/tmp/plaza-verify-report.json` 仍在（2026-11-12 23:45，outcome PASS，结论一致）。

### 10.4 门禁：三条命令与退出码

| # | 命令 | exit | 说明 |
| --- | --- | --- | --- |
| 前置 | `corepack yarn build` | **1** | 仅作测试前置尝试：`market:prepare` 在 `dshmarket` 桌面补丁上失败（npm latest 已到 `1.73.19`，仓库 pin `1.73.7` 与 `.yarn/patches/dshmarket-desktop.patch` 不匹配，`Cannot apply hunk #2`），按设计 fail-closed。该 pin 与 patch 在本分支零改动（`git diff master -- dsh-plugin-huaanwork/package.json yarn.lock .yarn/patches/` 为空），属外部漂移而非本分支引入；失败后脚本自行恢复 manifests/lockfile，`git status` 干净。 |
| 前置 | `corepack yarn workspace dsh-plugin-huaanwork build` | **0** | 初始树缺 `dsh-plugin-huaanwork/lib/`（测试的既有构建产物前置；Task 0 节已记录缺 lib 会让 `package.spec`/`verify-packaged-runtime`/`recovery-plugin-uninstall` 误红）。该包 build 不经过 `market:prepare`，补齐后测试可跑。`market-server`/`update-server`/`agent-catalog-server`/`agent-catalog-admin` 的 build 为 no-op（源码直跑），无需产物。 |
| 1 | `corepack yarn typecheck` | **0** | 八个 workspace 的 typecheck 全部通过；日志 `/tmp/task10-typecheck.log`（末行 `EXIT=0`）。 |
| 2 | `corepack yarn test` | **0** | 日志 `/tmp/task10-test.log`。分 workspace：dsh-plugin-huaanwork `284 passed / 4 skipped`（288 文件；3971 passed / 15 skipped / 3986 tests）、dsh-community-market 13 文件 303 tests、@huaanwork/policy 64（62 过 2 跳过）、model 10、git-tools 8、web-tools 19、market-server 14 文件 244 tests、update-server 5 文件 88 tests、catalog-signing 13、agent-package-format 35、agent-catalog-server 5 文件 80 tests、agent-catalog-admin 15；0 失败。本节相关 spec 全绿：`agent-package-runtime` 57、`agent-package-tools` 63、`package-subagent-lineage` 9、`policy.cordis` 34、`profile` 63、`agent-package-sources` 9、`seed-agent-packages` 2、`typo-check-pwsh-extract` 2（1 跳过，见 §10.6）。 |
| 3 | `corepack yarn check` | **0** | 日志 `/tmp/task10-check-3.log`（末行 `EXIT=0`）；完整链含 `check:whitespace`、`check:layout`、`test:aa-connector`、各 workspace check（community-market build+test、huaanwork build+typecheck+test+verify:closure/bundled/cli/loader/profile/host/**aa**/licenses/operations 等）。`verify:aa` 在本轮 **in-check 直接通过，未出现并发竞态**（日志两次 `verify-profile-boot: minimal preset, plugin manager, and disabled hmr lock passed`，分别为 verify:profile 与 verify:aa；无 AA Host services conflict），因此本任务没有隔离重跑。 |

`check` 从红到绿的两次环境/分支修正（如实登记，均不改变产品行为）：

1. **分支引入的尾随空格**：`check` 首跑在 `test:whitespace` 失败（7 条中 2 条红），`git diff --check` 指向 `docs/superpowers/plans/2026-11-11-three-agent-packages-plaza-plan-review.md:42,62` 的两个两空格空行（该文件由本分支 docs 提交引入）。最小修复为删除两处尾随空格，**单独提交 `736ede7742`**（只改该文档），随后 `node scripts/check-whitespace.mjs` exit 0、其单测 7/7 通过。
2. **worktree 子模组 origin 形态**：第二跑在 `verify-layout` 失败：`deepseek-harness origin differs from upstream.json`。原因是本 worktree 的子模组按 Task 0 记录从本地共享库检出，`origin` 指向父 checkout 的本地路径，而 `upstream.json` 要求 `https://github.com/deepseek-ai/deepseek-harness.git`。修复为 `git -C deepseek-harness remote set-url origin https://github.com/deepseek-ai/deepseek-harness.git`（仅本地 git config；子模组 pin `1600d8a1e1` 与工作树内容零改动，`git status --porcelain` 仍空）。修复后 `node scripts/verify-layout.mjs` exit 0，第三跑全绿。

外部漂移的边界（不属本分支、未被绕过）：`corepack yarn build`/`dev`/`dist:*` 的 `market:prepare` 在当前 npm latest（`1.73.19`）下仍 fail-closed；根 `check` 不调用 `market:prepare`，故不影响本门禁。Task 12 若通过根 `dev` 或 `open-latest-huaanwork` 的 market 刷新路径构建，会先撞同一外部漂移；可改用包内 `build` + `prepare:electron-native` + `node lib/bin.js`（不经 market:prepare）。此项登记为 Task 12 的前置风险，不得在 Task 12 里静默跳过或改写 patch 了事。

### 10.5 能力披露口径订正（spec §5.0/§7.3）

签名广场包**没有安装/启用确认对话框**：安装 = 广场卡直接「下载」按钮，启用 = 「我的智能体」页直接「启用」开关。披露面是**详情对话框**（`dsh-plugin-huaanwork/src/client-huaanwork/AgentPackagesPanel.tsx`）：

- **未安装**（`summaryDetail` 分支）：包信息（版本 / @slug / 描述 / 包大小 / 更新时间 / 迁移来源）+ 签名节只显示 `INSTALL_DETAIL_NOTICE`（`logic/agentPackagesLogic.ts:51`，文案「安装后可查看签名与文件清单」）；不伪造签名或文件清单。
- **已安装**（`packageDetail` 分支）：发布状态 + 签名（keyId / 签名时间 / 槽位 / **验签结果：通过**，或「未通过 + 原因」）+ 人设 + 技能 + 工具 + 文件 digest 清单；`tools.mode:"none"` 经 `packageToolsLabel()` 显示为 **「无」**（`agentPackagesLogic.ts:446-449`）。对话框底部固定显示 `PACKAGE_SANDBOX_WARNING`（`agentPackagesLogic.ts:24`，文案「脚本在本机沙箱中运行；沙箱只限制写，读取文件和网络不受限制。」）。
- 广场卡（`catalogPackageCard`）只显示 displayName/description/version/size，**没有 capabilities 字段**；允许名单（read/read_file/glob/grep/bash（win32 为 pwsh）/subagent）不在 UI 逐项展示，能力边界如实写在 description 与 SKILL.md，由 C4/C5 在运行时收窄与拒绝。

spec §5.0/§7.3 已于 2026-11-12 同步订正；本里程碑**不伪造对话框测试**，真实 DOM 断言归 Task 12。上表 10.3 的脚本断言的是同一套 logic（`plazaCards`/`packageActionLabel`），不含 DOM。

### 10.6 Windows：单元覆盖与 BLOCKED 项

- **win32 allow 形态（已覆盖）**：`tests/huaanwork-host/agent-package-runtime.spec.ts` 的 `includes subagent for both platform shells` 强制 `process.platform` 为 `darwin` 与 `win32`，断言两种 allow 数组分别以 `bash`/`pwsh` 后接 `subagent`；全量门禁绿。
- **pwsh 提取行为（本机 BLOCKED）**：`tests/huaanwork-host/typo-check-pwsh-extract.spec.ts` 共 2 条；本机 `2 tests | 1 skipped` —— 提取行为用例因 `spawnSync('pwsh', ['-Version'])` 返回 `ENOENT`（`powershell` 亦不存在）如实跳过并打印原因；另一条 fixture 完整性用例在两平台实际执行并通过。即：`System.IO.Compression` + `HtmlDecode` + UTF-8 无 BOM 的提取处方**在本机从未被执行**，不得声称已验证。
- **真机项 BLOCKED（R-ACCEPT-1 豁免先例）**：无第二台 Windows 机器，不声称跨机器/跨 OS 通过。Windows CI 的 `check:win-package:platform` 测试清单（`dsh-plugin-huaanwork/package.json`）不含上述 pwsh 提取 spec，故该行为目前**没有任何 Windows 执行证据**。触发条件：有 pwsh 的主机显式运行该 spec；获得第二台 Windows 机器时按 R-ACCEPT-1 证据 §4 四步补跑。

### 10.7 待补（后续任务完成后回填）

- **Task 11（独立评审）**：runtime/holders/host/skills/policy + Task 0 maxDepth 注入 diff 与回归钉的评审结论（经反证校准、严重度）、P0/P1 修复 commit 与重跑退出码、N-3 探针（lane 存活期 vs 10 分钟清理预算）结论 ⇒ 见文末〈Task 11 独立评审〉。
- **Task 12（CDP 真机走查 + 最终门禁）**：`huaanwork-accept-three-packages.mjs` 脚本与执行事实（maxDepth ≥ 2 预检、guard_mode=smart、三张中文卡、详情对话框真实 DOM 披露断言、双盲身份链判据、N-3 实测、截图指针）；**最终代码树的 `typecheck`/`test`/`check` 在 Step 5 重跑，最终证据以那次为准**。
- **Task 13（备份 + 延后删除登记）**：`~/Downloads/cursor/agent-dirs-backup-2026-11-11.tar.gz` 的防覆盖门、`tar -tzf` 完整校验、sha256、删除范围与触发条件（本里程碑不删除）。
- **Task 14（生产上架 runbook 指引）**：`docs/huaanwork-three-agent-packages-release.md` 与证据指针；生产签名/上架仍为 owner 运维动作。

### 10.8 工作树状态与 scratch

- 门禁实测 HEAD：`736ede7742`（本提交之前）；本节以独立 commit 追加。`deepseek-harness` pin `1600d8a1e140dcde43a1a0941940a0480712c011` 未变；除本文件与空白修复提交外工作树干净。
- scratch（未提交）：`/tmp/task10-typecheck.log`、`/tmp/task10-build.log`、`/tmp/task10-hw-build.log`、`/tmp/task10-test.log`、`/tmp/task10-check{,-2,-3}.log`、`/tmp/plaza-verify-report-task10.json`、`/tmp/task10-plaza-{stdout.json,stderr.log}`。

---

## Task 11 独立评审（2026-11-13，修复落地记录）

本节记录**评审结论**与**修复落地**；评审与修复为两个角色，本节作者只做修复。

### 11.1 评审范围与基线

- 被评审代码：Task 0 的产品默认 `maxDepth` 注入（`2f2ae65c0f`，含订正 `67fc1a88c2`）与运行时扩展 C1–C5（`d5e3a2d8e4`→`52ed4c5901`），基线 HEAD `bb40e30724`。
- 评审面：`src/huaanwork-guardrails/{skills,policy}.ts`、`src/huaanwork-host/agent-package/host.ts`、holders 装配、`src/profile.ts` 注入点，及其回归钉。
- 校准：下列严重度与「不算缺陷」的反证来自 Task 11 评审结论（controller 校准），修复侧逐条照办，未扩大范围。

### 11.2 发现清单与处置

| ID | 严重度 | 内容 | 校准 / 处置 |
| --- | --- | --- | --- |
| I1 | Important | 产品默认 `maxDepth: 2` 是**全局**放宽（所有会话可到深度 2，不只包子会话） | **反证不成立缺陷**：spec §4.6 已披露该全局放宽。作为已披露的产品决定保留，不改 |
| I2 | Important（真实但休眠） | `start` 旧签名包装的血缘分支挂在 `!current` 上，而 `current` 是**进程级** legacy marker：另一会话有在途 `@agent` 回合时，血缘派发会被那个回合的 `allow` 收窄、且不写血缘条目 ⇒ C5 不覆盖 | **已修**：`parentFromCall`/`inherited` 提前到 `await` 之前取快照；血缘条目对本次派发权威，legacy 人设校验与 `current.allow ∩ schemas` 只在 `current` 在场**且**无血缘条目时生效；血缘分支弃掉 `!current` 条件（与 activation 路径同形）。新增回归钉见 11.5 |
| I3 | Important（登记） | 产品默认 `maxDepth` 与设置面清除/重置的兄弟字段边界（§0.3 C 实证：落盘行只剩 `maxActiveSubagents` ⇒ 有效值回落 schema 默认 1 ⇒ 派 lane 失败且无产品信号） | **登记为债**（`agents.md` 新增行），不实现字段级合并；延后决定：字段级合并 vs. 规避清空路径 |
| M1 | Minor | 用例标题「grandchild first model request…」言过其实：真实首条模型请求可能在 activation 包装之前组装 | **已修**：改名为「a grandchild's tool table after activation…」，并注明该窗口由 **C5 执行期拒绝**封住、不是 schema 层 |
| M2 | Minor | C5 是名字集合判定；上游 schema 层会豁免 scope 自己注册的本地工具（如 `structured_output`） | **已加注释**（`policy.ts` 两处 lineage 检查各一行），行为不变 |
| M3 | Minor | `bindChild` 在 `turnAllow` 未就绪时静默跳过写入 ⇒ 血缘表与 C5 一起缺席 | **已修**：改为内部 `Error('智能体包回合 allow 未就绪即绑定子会话')`，顺序回归立刻失败。现值 `turnAllow` 在两次 `bindChild` 之前赋值，全部既有用例绿 |
| M4 | Minor | 证据文档缺评审结论 | 本节 |
| M6 | Minor（观察） | writer/reader 会话 id 推导不对称 | 记录，不修（见 11.4） |
| M7 | Minor（观察） | provider 忽略预留 childId 的包 fallback 继承既有 M1 残余 | 记录，不修（见 11.4） |

### 11.3 N-3 探针结论（lane 存活期 vs 10 分钟清理预算）

- **正常路径：血缘条目存活。** 上游 `subagent/manager` 的 `settlementState()` 在 `activation.ownedChildren.size > 0` 时返回 `'wait'`，`watchLocalSettlement()` 继续等待；`ownedChildren` 只在 `releaseOwnership()`（正常路径）与 `holdOwnership()` 的 releaser（失败路径）里删除。因此有存活 owned child 的父 activation **不会结算关闭**，而 host 清理里 `Promise.race([settleWithin(activation.result, 10 min), cancelGate])` 在 lane 正常回传结果时不会超时 —— 血缘条目在 lane 回传结果与仲裁期间保持存活。
- **残余：只有两个预算都耗尽才发生。** 清理先等 result 至多 10 分钟（`ACTIVATION_CLEANUP_TIMEOUT_MS = 600_000`，超时只 `noteCleanupBudget` + 一行 `console.error`，不入 `cleanupFailures`），随后 `disposeActivation` 再等至多 10 分钟。两段都超时（合计 20 分钟以上、子会话既不算完也拒绝释放）时，清理按引用删掉血缘条目并释放 activation，而子会话仍在运行。
- **降级形状（如实登记）**：20 分钟后 **C5 执行期拒绝对该子会话缺席**，而 restrict 层不撤销 ⇒ **schema 收窄仍在**；它此后派生的孙代也不再继承血缘收窄。已登记为债（`agents.md` N-3 行），非阻断。
- 边界：本节为源码级结论（上游 manager 与 host 清理的读码 + 既有用例），**不声称真机时序验证**；Task 12 走查可实测。

### 11.4 未修的观察项

- **M6（writer/reader 会话 id 推导不对称）**：写入侧 `skills.ts` 用 `sessionIdOf(agent.session?.header ?? agent) ?? sessionIdOf(agent)`（可读到 `header.id`，且跳过字面量 `huaanwork`），读取侧 `policy.ts` 的 `sessionIdOfAgentRef` 只读 `session?.id ?? id`。两侧通常一致；若某 provider 只填 `header.id` 而 agent 上没有 `session.id`，写入命中而 C5 读取不命中 ⇒ C5 对该会话静默缺席（schema 收窄仍在）。这是观察项，未修。
- **M7（provider 忽略预留 childId）**：`host.ts` 在 activation 返回后对实际 id 补挂附件并 `bindChild`，但 `skills.ts` 的包 lane `restrict`/`refreshAgentRestrict` 只在 `pkg.childId === childSessionId` 时接线 ⇒ 实际子会话跳过包 restrict/refresh。该缺口继承既有 M1 残余（`agents.md`「智能体包 M1 残余小项」行），本任务不重复登记。
- **I3** 的产品决定（字段级合并 vs. 规避清空路径）与 **N-3** 修复都留待后续，本轮只登记。

### 11.5 修复的测试命令与退出码（本修复自测，非最终门禁）

| 命令 | 退出码 / 计数 |
| --- | --- |
| `corepack yarn workspace dsh-plugin-huaanwork exec vitest run tests/huaanwork-guardrails tests/huaanwork-host/agent-package-runtime.spec.ts tests/profile.spec.ts` | `EXIT=0`；`Test Files 22 passed (22)`；`Tests 438 passed (438)` |
| `corepack yarn workspace dsh-plugin-huaanwork exec vitest run tests/huaanwork-guardrails/package-subagent-lineage.spec.ts` | `EXIT=0`；`Tests 10 passed (10)`（新增 I2 用例后由 9 → 10） |
| mutation 反向验证（临时把 `legacyApplies` 退回 `current !== undefined`） | 同一文件 `1 failed \| 9 passed` ⇒ 新用例确实钉住 I2；还原后 `10 passed (10)` |
| `corepack yarn workspace dsh-plugin-huaanwork exec tsc -p tsconfig.json --noEmit` | `EXIT=0` |
| `corepack yarn workspace dsh-plugin-huaanwork exec tsc -p tsconfig.tests.json --noEmit` | `EXIT=0` |

- 零改动且绿的既有面：`tests/huaanwork-guardrails/skills.spec.ts`（39）、`policy.cordis.spec.ts`（34）、`agent-package-tools.spec.ts`（63）、`tests/huaanwork-host/agent-package-runtime.spec.ts`（57）、`tests/profile.spec.ts`（63）。
- **本节不声称最终门禁**：最终 `typecheck`/`test`/`check` 由 Task 12 Step 5 在最终代码树上重跑，以那次为准。
- 改动文件（仅此六个，另有 Task 11 报告文件）：`dsh-plugin-huaanwork/src/huaanwork-guardrails/skills.ts`、`dsh-plugin-huaanwork/src/huaanwork-guardrails/policy.ts`、`dsh-plugin-huaanwork/src/huaanwork-host/agent-package/host.ts`、`dsh-plugin-huaanwork/tests/huaanwork-guardrails/package-subagent-lineage.spec.ts`、`agents.md`、本文件。

---

## Task 12 真机走查、根因裁定与最终门禁（2026-11-13）

### 12.1 根因与 owner 裁定

首次真机走查（诊断件 `.superpowers/sdd/2026-11-11-three-agent-packages-plaza/task-12-diagnosis.md`）把失败根因定在**组合层**而不是 allow 层：

- web-app overlay 关闭宿主平面的委派行（`deepseek-harness/packages/bundle/web-app/cordis.patch.yml:552-561` 的 `tool-subagent-control` / `tool-subagent-list-agents` / `tool-subagent` / `tool-subagent-fork`）。
- HuaAnWork profile 的 L1/L2 复挂块只翻回 `tool-fs`、`tool-bash`、`plan-mode`、`tool-todo`、`tool-goal`、`tool-result-pruner`、`compaction-basic`，**没有** `tool-subagent`。
- 委派组只随 standard preset 提供，而桌面会话创建 agent 时不挂 preset（`dsh-plugin-huaanwork/src/huaanwork-host/sessions.ts:432`，父会话与包子会话的 session header 都没有 `agentPreset`）。

结果是 `subagent` 这个名字在父会话与包子会话的 `request/header` 工具表里都不存在（诊断实测：父子均为 22 个宿主平面工具），`pkg.allow ∩ tools.schemas()` 自然把它丢掉；包子会话「工具集仅 bash / glob / grep / read」与 lane 缺失都是这一层的下游表现，不是 `maxDepth`、策略拒绝或 prompt 抑制。

**Owner 裁定**：在桌面 profile 复挂该行。改动 `dsh-plugin-huaanwork/src/profile.ts:1596-1600`：

```ts
{ id: 'tool-subagent', disabled: false },
```

只翻回 `subagent`，**不**翻回 `tool-subagent-fork` / `tool-subagent-control` / `tool-subagent-list-agents`。同批把该行登记进运行时的锁行断言表（`src/huaanwork-host/row-assertions.ts`，`HUAANWORK_ROW_ASSERTIONS` 增 `{ id: 'tool-subagent', intent: 'override' }`）与组合顺序守卫的锁行枚举（`tests/market-composition-order.spec.ts` 的 `GUARDRAIL_LOCK_IDS`，锁层保持连续）。

**后果（显式）**：主会话也获得 `subagent` 委派能力。它被产品默认 `maxDepth: 2`（Task 0/R8）约束在同一深度上限，工具面其余部分（approval `ask`、native 模式、血缘收窄）不变。spec §4.3 的不变量「主会话模型自主 subagent 行为零变化（无血缘条目 ⇒ 基线）」**由本 owner 裁定取代**，不再是本里程碑的有效不变量；无血缘条目时主会话仍走基线策略，只是工具目录里多了 `subagent` 一行。

### 12.2 回归钉（先红后绿）

`dsh-plugin-huaanwork/tests/profile.spec.ts`（新用例「re-enables the model-facing subagent tool the Web overlay disables」）：

| 命令 | 结果 |
| --- | --- |
| 改动前 `vitest run tests/profile.spec.ts` | **红**：`1 failed \| 63 passed (64)`，`expected true not to be true`（`tool-subagent` 组合行 `disabled: true`） |
| 改动后同一命令 | **绿**：`64 passed (64)` |
| 锁行同步后 `vitest run tests/market-composition-order.spec.ts tests/profile.spec.ts tests/huaanwork-rowids.spec.ts` | `3 passed (3)`；`83 passed (83)` |

用例同时钉住 `subagent` 服务行仍为 `config: { maxDepth: 2 }`。

### 12.3 走查命令与退出码

| 命令 | 退出码 | 备注 |
| --- | --- | --- |
| `corepack yarn workspace dsh-plugin-huaanwork build` | **0** | 两次（走查前与最终树各一次），日志 `/tmp/task12-build-final.log`。**未跑 root build**：本次源码改动全部在 `dsh-plugin-huaanwork` 内，root build 会触发 `market:prepare` 的外部依赖刷新（已知 dshmarket 漂移面），与走查无关 |
| `corepack yarn workspace dsh-plugin-huaanwork exec node --experimental-transform-types scripts/verify-agent-packages-plaza.mjs --keep-catalog` | **0** | Task 9 脚本；三次运行各起一次，连接文件分别在 `…/huaanwork-plaza-verify-{2rTxxP,fLwKEr,g2ahfr}/catalog-connection.json` |
| 走查 run 1：`corepack yarn workspace dsh-plugin-huaanwork exec node scripts/huaanwork-accept-three-packages.mjs --connection <2rTxxP> --out /tmp/three-packages-accept-2` | **0 PASS** | run 1 使用的是**未提交的 profile 修复内容**（该内容随后成为 `edc932f1fe`）；`facts.environment.headSha = 3a2c507aad`（当时 profile 修复尚未提交）。产物 `/tmp/three-packages-accept-2-run1` |
| 走查 run 2（最终树重跑） | **1 FAIL** | 机制全通过，仅文本断言假阳性；产物 `/tmp/three-packages-accept-2-run2`，见 12.7 |
| 断言修正后走查 run 3（最终树） | **0 PASS** | 产物 `/tmp/three-packages-accept-2`；`facts.environment.headSha = 4fbd73d1a2`，`lib` 新于全部 `src`（`libMainMtime 21:52:31Z > newestSourceMtime 21:52:06Z`）；其后只有脚本断言提交 `a48e71a47c`（`.mjs`，不参与构建）与本证据文档 |

**cleanup 契约（2026-11-13 评审订正，取代原「临时根均已删除」的表述）**：

- (a) 走查脚本现在**自己删除它用过的 `--keep-catalog` 根**：`shutdown()` 先向连接文件给定的 catalog pid 发 SIGTERM、等待进程退出，再在「根位于 OS 临时目录下**且**目录名匹配 `huaanwork-plaza-verify-`」时 `rmSync(dirname(connection.path), { recursive: true, force: true })`；结果写入 `facts.catalogRootCleanup`（`signalled`/`exited`/`deleted`/`status`）。
- (b) 上述删除**无法执行时**（SIGTERM 失败、15 秒内未退出、路径不在临时目录或前缀不符），脚本只记录 `status: "manual-delete-required"` 与 `command: "rm -rf '<root>'"`，由操作者手工删除；脚本**不删除没有被本次运行使用的根**（`usedByThisRun: false` ⇒ 只记手工删除指令）。
- (c) **为什么必须由脚本删**：Task 9 的 `--keep-catalog` 在写出连接文件后收到 SIGTERM 时会**有意保留**临时根（连接文件是交接物），这是 Task 9 的设计行为，不是泄漏缺陷；因此删除责任落在走查脚本/操作者。
- **历史事实订正**：原文「所有 `--keep-catalog` 临时根……均已删除」**不实** —— 本节三轮的 `…-2rTxxP`、`…-fLwKEr`、`…-g2ahfr` 当时仍在（含 dev 私钥与 per-run catalog token），已于 2026-11-13 由 controller 手工删除。修复轮（§12.11）的 catalog 根由脚本自身删除，并在 facts 与文件系统中双重验证。

诊断期保留的 `/var/folders/.../huaanwork-three-packages-Ag1QX2` 已删除；走查的隔离临时根由脚本删除（`isolatedCleanup: "removed"`）。

### 12.4 走查 facts 摘要（run 3，`/tmp/three-packages-accept-2/facts.json`）

- **前置检查**：`subagent.maxDepth = 2`，`guard_mode = smart`（脚本显式写入，非生产值），`allowNetwork = true`；模型来自生产 active 条目（id `default`，provider `deepseek`），解析后的模型串为 **`deepseek-flash`**（`facts.precheck.model.model`；本节 run 3 未加 `--model` 覆盖，修复轮已改用 `deepseek-chat`，见 §12.11）。
- **广场卡（安装前）**：`code-review / 代码审查`、`task-orch / 任务编排`、`typo-check / 错别字检测`——首次运行的 `facts.plaza: []` 是脚本先 `facts.plaza = progress.plaza`（引用快照）后在 `drive` 里**整体替换** `progress.plaza` 造成的；现改为原地 `splice`，并把选择器收紧到 `.agent-plaza-panel .skill-card[data-slug]`，缺卡 / 重名 / 名称不符即 FAIL。
- **安装 / 启用 / 已装详情**：三包各一次下载、一次启用；已装详情 `验签结果：通过`、工具「无」、文件清单 3 条、标题 `智能体详情：{错别字检测,代码审查,任务编排}`。
- **运行卡**：三包均 `terminalPhase = completed`、状态「已完成」，父会话回复均被观测到。
- **应用日志**：3 个日志文件，`cleanupBudgetTrips = 0`，`packageErrors = 0`，`catalogErrors = 0`。

### 12.5 双盲身份链（typo-check）

- 父会话 `huaanwork-889b6d510b401bfd-744ddc3a` → 包子会话 `6f9c392e-12ba-4c6d-b865-a5e9846726bf`（`origin: "subagent"`，`delegationDepth = 1`）。
- 包子会话内两条 `subagent` 派发，callId 不同且结果非错误：
  - `40106a00-f081-4913-889e-d24cb4b1966b` → `started subagent 220c73a0-6346-4b73-ae72-528e11d39f3c`；
  - `92f845ca-7597-4522-8e9d-51fd157f4f47` → `started subagent 3c4c94a7-b9bc-4ac2-8e5a-eb707d9620ca`。
- lane 会话两条，均 `delegationDepth = 2`：`220c73a0…`（4383 ms，收尾 1172 字）与 `3c4c94a7…`（10470 ms，收尾 1193 字）；两条都收到 `subagent-settled` 投递（`agent/inbox/spliced` + `user/message` 各一条，共 4 条 delivery），均无 “left no closing message”。
- 计数：`distinctCallIdCount = 2`、`goodCallCount = 2`、`errorCallCount = 0`、`missingCallCount = 0`；`arbitrationAfterLastDelivery = true`；`honestDegradation = false`；`dualBlindOk = true`。
- 包子会话仲裁文本为逐条回读原文的 A/B 对照报告（7 条发现，双路一致），不是深度降级叙述。

### 12.6 N-3 时序结论（可观测部分）

- 运行卡完成时包子会话已存活 `76,251 ms`；清理预算常量 `600,000 ms`（10 分钟）。应用日志里 `cleanupBudgetTrips = 0`，无「分钟内未结束」行，因此本轮**未触发**任何清理预算超时。
- 仲裁发生在两条 lane 的 delivery 之后（`arbitrationAfterLastDelivery = true`），与 §11.3 的源码级结论一致：lanes 存活期间血缘条目不会被清理。
- 20 分钟双预算耗尽后的残余分支（`agents.md` N-3 行）本轮不可观测，仍按登记保留。

### 12.7 走查暴露并修复的断言缺陷（run 2 → run 3）

run 2 在同一最终树上把**全部机制判据**跑通（两条 depth 2 lane、两个不同 callId 且非错误、两条 delivery），却因 `honestDegradation` 文本正则命中包子会话健康路径报告里的「**未**降级为单会话自审」而 FAIL——正则只认动词、不认否定。这不是产品缺陷，是走查断言的精度缺陷：

- 修法：`scripts/huaanwork-accept-three-packages.mjs` 新增 `reportsDepthDegradation()`，先剥离「未 / 并未 / 没有 / 不会 / 不能 / 无 / 不（发生|出现|进行|被）…降级」与「…深度不足」的否定式提及，再匹配肯定式短语（`递归深度不足`、`单会话多轮自审`、`maxDepth`、`SubagentDepthError`、`已降级`、`降级为`）。
- 验证：6 条样例（4 条否定 / 健康 + 2 条肯定，含 `SubagentDepthError` 原文）全部判对；run 3 通过。**肯定式的深度降级仍然判 FAIL**，断言没有放宽。

### 12.8 截图、人工复核边界与 Windows

- 截图 13 张（`/tmp/three-packages-accept-2`，`facts.json` 记 bytes + sha256 前 16 位）：`00-app-ready`、`01-plaza`、`02-detail-pre-{typo-check,code-review,task-orch}`、`03-after-install`、`04-enabled`、`05-detail-post-{…}`、`06-run-{…}`；`01-plaza.png` 为 `180641 B / 1d77faead76006b8`，与首次运行同图（广场卡稳定）。
- 模型输出长度（run 3）：typo-check 1092 字、code-review 1796 字、task-orch 291 字；摘录见 `facts.modelOutputs`。
- **自动 PASS 只证明机制**（卡片、签名、安装、启用、委派、lane、投递、仲裁时序）；模型输出质量（检出是否准确、报告是否可用）**需人工复核**，本节不作质量结论。
- **Windows：BLOCKED**。走查依赖 `textutil` 与 macOS 上的 Electron CDP，本机为 darwin；无 Windows 真机产物与走查证据，未做任何 Windows 声明。

### 12.9 最终门禁（原始轮：代码树 `a48e71a47c` + 本证据文档未提交）

> 这是**评审修复轮之前**的门禁记录，保留为历史。修复轮（脚本 + 本证据文档）在最终树上重跑的门禁见 §12.11.6。

| 命令 | 退出码 | 摘要 |
| --- | --- | --- |
| `corepack yarn typecheck` | **0** | 日志 `/tmp/task12-final-typecheck.log` |
| `corepack yarn test` | **0** | 根 workspace `3973 passed \| 15 skipped (3988)`，`284 passed \| 4 skipped (288)` 文件；其余 4 个 workspace `303 / 244 / 88 / 80 passed`；日志 `/tmp/task12-final-test.log` |
| `corepack yarn check` | **0** | 首次运行即绿（含 `verify:aa`），无需隔离重跑；日志 `/tmp/task12-final-check.log` |

首次 `yarn test`（锁行同步前）红在 `tests/market-composition-order.spec.ts` 三例：新增锁行插进了 `GUARDRAIL_LOCK_IDS` 的连续锁层，守卫按设计报「interleaved or truncated」。处置 = 同步锁行枚举 + 运行时断言表（提交 `43dac0d0c6`，格式订正 `4fbd73d1a2`），不是放宽守卫。

### 12.10 本轮提交

- `6b8e28839b feat(scripts): CDP acceptance walkthrough for three plaza agent packages`
- `edc932f1fe fix(profile): re-enable the model-facing subagent tool for package lane dispatch`
- `43dac0d0c6 fix(huaanwork-host): assert the re-enabled subagent tool row at boot`
- `4fbd73d1a2 style(tests): restore one lock id per line in the enumeration`
- `a48e71a47c fix(scripts): ignore negated depth-degradation claims in the lane assertion`
- 本证据文档独立提交。

---

## 12.11 Task 12 评审修复轮（2026-11-13）

本节只修 Task 12 评审发现与 controller 要求，**不改产品行为**；脚本仍是同一个文件，最终证据以本轮复跑（§12.11.3 run C）与本轮门禁（§12.11.7）为准。

### 12.11.1 修复清单（逐条对应评审发现）

| # | 发现 | 处置 |
| --- | --- | --- |
| I1 | 「`--keep-catalog` 临时根已全部删除」不实 | 见 §12.3 的 cleanup 契约：脚本现在停止它被给定的 catalog pid 并删除该根，结果写入 `facts.catalogRootCleanup`；条件不满足只记 `manual-delete-required` + 手工命令。历史空白由 controller 手工删除，已如实订正 |
| C2/C6 | 走查须用 `deepseek-chat`；facts 记解析后的模型串 | 新增 `--model <name>`：只改生产 active 条目的模型名，`base_url`/`api_key` 原样保留；facts 记 `precheck.model.{model,productionModel,modelOverride,modelSource}`。本轮 `model = deepseek-chat`（§12.11.4–12.11.5） |
| C3 | Step 6 人工核对结论 | `facts.modelOutputs` 现为**包子会话终态文本**（深度 1，最多 16 KB）+ 父会话终态文本；结论见 §12.11.6（标注「实施者人工核对（owner 可复核）」） |
| M4 | run 1 的构建点 provenance | §12.3 订正为「run 1 使用未提交的 profile 修复内容（随后成为 `edc932f1fe`），`facts.headSha = 3a2c507aad`」 |
| M5 | 报告称 run 1 `facts.plaza: []` | 报告订正：空 plaza 是更早的**诊断期** `/tmp/three-packages-accept` 运行，不是 `-run1`（后者 plaza 三卡齐全） |
| M6 | 证据只写「active model id default」 | §12.4 与 §12.11.4 记解析后的模型串 |
| M7 | 脚本未使用标识符 | 删除 `randomUUID`、`cpSync`、`basename`/`sep`（改为 cleanup 需要时才使用）、`TERMINAL_PHASES` |
| M8 | app 输出可能带密钥 | `app-stdout.log` 与 console 都经**按行缓冲**的 `redactSecrets`（跨 chunk 的密钥不会漏出） |
| M9 | 日志缺失时静默报 0 | `scanAppLogs` 记 `cleanupBudgetScan: "scanned"` 或 `"no-log-files"`；files = 0 时直接 FAIL（`app log scan is invalid`） |
| M10 | `reportsDepthDegradation` 过宽 | 保留否定式剥离，肯定式集合收紧为**深度/双盲短语**（`深度不足`/`单会话多轮自审`/`非双盲`/`SubagentDepthError`/`降级为单会话`/`深度降级`），裸 `maxDepth` 与跨厂商「交叉验证已降级」（R1 披露）不再算降级 |
| M11 | `prepare:electron-native` 前置 | 启动前检查 `node_modules/fs-ext/prebuilds/<platform>-<arch>/electron.abi*.node`；缺失即 BLOCKED 并给出 `corepack yarn workspace dsh-plugin-huaanwork prepare:electron-native`；facts 记 `appEntry.nativeBinding` |
| M12 | 报告 header HEAD sha | 报告 header 改为本轮最终提交 |

另外记录：`request/header` 的 `model` 是 **`local`**、provider 为 `deepseek-official`（`src/profile.ts:1588` 的 agent-loop 哨兵值），不是实际模型串；实际串只由 `precheck.model` 与端点探针证明（§12.11.5）。

### 12.11.2 catalog 根清理（脚本行为）

- `stopAndCleanCatalog()`：先 SIGTERM `connection.pid` → 最多等 15 秒退出 → 校验「根位于 `os.tmpdir()` 下」且「目录名匹配 `huaanwork-plaza-verify-`」→ `rmSync(root, { recursive: true, force: true })`。
- 失败/不满足条件/本次运行未使用该连接 ⇒ `status: "manual-delete-required"`、`reason`、`command: "rm -rf '<root>'"`，**不删除**。
- `--keep-catalog-root` 保留根（诊断用，根内有 dev 私钥）。
- 本轮三次运行的 facts 中 `catalogRootCleanup.status` 均为 `"deleted"`，事后 `ls` 三个根都不存在（§12.11.8）。

### 12.11.3 `deepseek-chat` 复跑（三次，含一次诚实 FAIL）

| 运行 | 产物 | 退出码 / 结果 | 说明 |
| --- | --- | --- | --- |
| A | `/tmp/three-packages-accept-3-run1` | **0 PASS** | 首次加 `--model deepseek-chat`；机制与人工核对素材完整，但 `modelOutputs` 只有 4 KB 摘录 |
| B | `/tmp/three-packages-accept-3-run2` | **1 FAIL** | 摘录上限提到 16 KB 后复跑；**机制全绿**（2 个不同 callId、2 条 depth 2 lane、4 条 delivery、仲裁在 delivery 之后），失败原因是文本断言把 R1 的「交叉验证已降级」当成深度降级（见下） |
| C | `/tmp/three-packages-accept-3` | **0 PASS** | 收紧降级短语集合后的最终运行；`facts.environment.headSha = e62a30866a` |

run B 的失败是**断言精度缺陷**，不是产品/机制失败，也不是把 FAIL 洗成 PASS：

- 包子会话报告写「原 DeepSeek+Kimi 交叉验证已降级，同一模型同源盲区仍存在」——这是 R1 裁定的**跨厂商**降级披露，包本身每次都会写。
- 同段还写「本次双盲派发成功，未触发深度降级」——否定式。
- 旧集合里的裸 `已降级` 命中了前者。修法：肯定式集合只保留深度/双盲短语，并对 `未触发…降级` 增加否定剥离；`SubagentDepthError`、`递归深度不足`、`单会话多轮自审`、`非双盲`、`降级为单会话` 仍判 FAIL。
- 12 条样例（含 run B 的真实文本、R1 披露、否定式、4 条肯定式）全部判对；脚本 `node --check` 通过。

### 12.11.4 最终 facts 摘要（run C，`/tmp/three-packages-accept-3/facts.json`）

- `outcome = PASS`，`errors: []`，`startedAt 22:29:33Z` / `finishedAt 22:31:41Z`；`headSha = e62a30866afcbb93b24509c2bb9a673aff745491`（`feat/three-agent-packages-plaza`）。run C 运行时脚本修复**尚未提交**，`facts.headSha` 因此是上一个提交点（`e62a30866a`）；run C 实际使用的脚本内容随后成为 `4ac5eccbab`（`.mjs`，不参与构建，`lib` 不变）。
- **模型**：`precheck.model.model = deepseek-chat`，`productionModel = deepseek-flash`，`modelOverride = deepseek-chat`，`modelSource = "--model deepseek-chat applied to the production active entry (base_url/api_key unchanged)"`，provider `deepseek`，`baseUrl https://api.deepseek.com`，`apiKeyPresent = true`（从不打印）。
- `subagent.maxDepth = 2`；`guard_mode = smart`（脚本显式写入）。
- `appEntry.nativeBinding`：`node_modules/fs-ext/prebuilds/darwin-arm64/electron.abi149.node`（存在，`prepare:electron-native` 产物）。
- 广场三卡、安装/启用各三次、已装详情三份均 `验签结果：通过` / 工具「无」/ 文件清单 3 条 / 标题正确；三包运行卡 `completed`。
- `appLogs`：3 个文件，`cleanupBudgetScan = "scanned"`，`cleanupBudgetTrips = 0`，`packageErrors = 0`，`catalogErrors = 0`。
- `catalogRootCleanup.status = "deleted"`（root `…/huaanwork-plaza-verify-rWgmmB`，pid 47152，`signalled/exited/deleted = true`）；`isolatedCleanup = "removed"`。
- 双盲身份链：父 `huaanwork-5be541f32f339457-21998d24` → 包子会话 `e4483c52-64c0-445e-b065-40474b84d30f`（depth 1）。
  - 两个不同 callId、结果非错误：`17dcb09e-54cf-4e10-9c22-6946a46c7087` → lane `ad9307a1-bd84-4f3c-abb5-76be70856b69`；`5a1cda14-4cc8-46b5-9f3a-18c712a7a777` → lane `2a3063a0-5eac-4d99-b07c-b58dab99d682`。
  - 两条 depth 2 lane 均收到 settlement 投递（`finalTextLength` 1209 / 1192，无 “left no closing message”）；`distinctCallIdCount = 2`、`goodCallCount = 2`、`errorCallCount = 0`、`missingCallCount = 0`；`arbitrationAfterLastDelivery = true`；`honestDegradation = false`；`dualBlindOk = true`。
  - N-3：运行卡完成时包子会话存活 69,236 ms，清理预算 600,000 ms；`cleanupBudgetTrips = 0`。20 分钟双预算分支仍未观测（登记债）。
- 截图 13 张（同前命名），关键图：`01-plaza.png`（180,660 B / `e33df7c11b9784fb`）、`06-run-task-orch.png`（252,729 B / `88cad1fa34149a37`）。

### 12.11.5 模型串与端点行为（诚实记录）

- 生产 `huaanwork-settings.json` 只有两条 `models` 条目：`default`（deepseek，`deepseek-flash`）与 `kimi`（`k3.1-pro`）；**没有 `deepseek-chat` 条目**。
- 因此本轮按 controller 允许的第 2 条路线处理：在**同一 provider 条目**上把模型名设为 `deepseek-chat`，保留 `base_url`/`api_key`；这记为显式 `--model` 覆盖，不是「生产里存在 deepseek-chat」。
- 端点探针（2026-11-13，未打印凭据）：`GET /models` 返回 `deepseek-flash`、`deepseek-v4-pro`；`POST /chat/completions` 传 `model: deepseek-chat` 返回 **200，响应体 `model` 字段为 `deepseek-flash`** —— 该端点把 `deepseek-chat` 别名到 `deepseek-flash`。走查的模型串事实以 `precheck.model.model = deepseek-chat`（请求名）为准；服务端实际回报的模型名是 `deepseek-flash`，两者都如实记录。
- 计划约束「全链路用 deepseek-chat」在请求侧已满足；**该端点的别名行为不属本任务可控范围**，也不把它写成「跑在另一个模型上」。

### 12.11.6 人工核对结论（**实施者人工核对（owner 可复核）**）

依据：`facts.modelOutputs` 的包子会话终态文本（typo-check 1,986 字、code-review 3,333 字、task-orch 7,581 字；每条另存父会话终态文本），以及 §12.11.4 的截图。**不声称自动化的内容质量证明**。

- **typo-check**：7 处植入错误**全部命中**（按装→安装、帐户→账户、市市场→市场、我们将我们→我们将、Managment→Management、２０２５→2025、在次→再次），每条带「双路一致」置信度标签；仲裁记录指出 L4 两路边界差异并按原文回读裁定；报告主动披露「两条 lane 同一宿主模型，不等同于跨厂商交叉验证（R1 降级）」。引用：`facts.modelOutputs['typo-check'].finalTextExcerpt`、`06-run-typo-check.png`。
- **code-review**：命中**硬编码密钥**（`sample-review.js:1`，指出还经 `module.exports` 导出、建议轮换与 env 注入）与 **`eval`**（`:3`，判 RCE/CWE-95，给出移除与受限解析替代），并按严重度分级。引用：`facts.modelOutputs['code-review'].finalTextExcerpt`、`06-run-code-review.png`。
- **task-orch**：计划**包含依赖与验收标准**——子任务 DAG 逐条 `dependsOn`（T0→T1→{T2,T3}→T4→{T6,T8}→T7→T9），每步给出输入/产出/可判定验收/超时/重试/幂等，并给并行与调度建议。**限制**：本次包子会话声明无法读取仓库（工作区策略拒绝 glob/bash，计划中的代码事实均标【待核实】并明确「没有编造项目事实」）；因此本轮只能核对「计划结构是否包含依赖与验收标准」，不能核对计划是否贴合真实代码。引用：`facts.modelOutputs['task-orch'].finalTextExcerpt`、`06-run-task-orch.png`。

### 12.11.7 最终门禁（最终树，本轮脚本 + 本证据文档）

| 命令 | 退出码 | 摘要 |
| --- | --- | --- |
| `corepack yarn typecheck` | **0** | 日志 `/tmp/task12fix-final-typecheck.log` |
| `corepack yarn test` | **0** | 根 workspace `3973 passed \| 15 skipped (3988)`，`284 passed \| 4 skipped (288)` 文件；其余 4 个 workspace `303 / 244 / 88 / 80 passed`；日志 `/tmp/task12fix-final-test.log` |
| `corepack yarn check` | **0** | 含 `build`、`verify:*` 与 `verify:aa`，计数同上；日志 `/tmp/task12fix-final-check.log` |

门禁在**脚本提交 `4ac5eccbab` 之后的同一代码树**上运行（当时本证据文档已写完、未提交，`git status` 只有该文档）。此后只有本证据文档的文字补充（含本条 provenance 说明），代码树与门禁时逐字节一致；`.mjs` 未参与构建，`lib/` 不变。

### 12.11.8 清理验证

- 本轮 catalog 根 `…/huaanwork-plaza-verify-{qTuVPf,Wiz3Qh,rWgmmB}` 均由脚本删除（三份 facts 的 `catalogRootCleanup.status = "deleted"`）；运行后 `ls -d …/huaanwork-plaza-verify-*` 无匹配。
- 三次运行的隔离临时根均为 `isolatedCleanup = "removed"`；无残留 Electron / catalog / 走查进程（`pgrep` 无命中）。
- 原三轮遗留根（`2rTxxP`/`fLwKEr`/`g2ahfr`）由 controller 于 2026-11-13 手工删除；本节的 cleanup 契约保证此后不再依赖人工收尾。

### 12.11.9 残余与边界

- **task-orch 读取权限差异**：run C 的包子会话读不到仓库（上一轮 run 1 的包子会话能读到真实代码）。这是模型/工作区策略层面的运行差异，Task 12 的机制判据（卡片、安装、委派、lane、投递、仲裁）不受影响；计划内容质量只按 §12.11.6 的边界记录，不宣称「计划已对照真实代码验证」。
- **`deepseek-chat` 别名**：端点把它解析为 `deepseek-flash`（§12.11.5），本任务不做模型能力结论。
- **Windows：BLOCKED**（同 §12.8），本轮未改变。
- **自动 PASS 的边界**：只证明机制；内容质量结论仅来自 §12.11.6 的人工核对。
