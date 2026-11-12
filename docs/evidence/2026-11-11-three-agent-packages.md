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
