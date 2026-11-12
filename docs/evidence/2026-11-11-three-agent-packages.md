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

- **Task 11（独立评审）**：runtime/holders/host/skills/policy + Task 0 maxDepth 注入 diff 与回归钉的评审结论（经反证校准、严重度）、P0/P1 修复 commit 与重跑退出码、N-3 探针（lane 存活期 vs 10 分钟清理预算）结论。
- **Task 12（CDP 真机走查 + 最终门禁）**：`huaanwork-accept-three-packages.mjs` 脚本与执行事实（maxDepth ≥ 2 预检、guard_mode=smart、三张中文卡、详情对话框真实 DOM 披露断言、双盲身份链判据、N-3 实测、截图指针）；**最终代码树的 `typecheck`/`test`/`check` 在 Step 5 重跑，最终证据以那次为准**。
- **Task 13（备份 + 延后删除登记）**：`~/Downloads/cursor/agent-dirs-backup-2026-11-11.tar.gz` 的防覆盖门、`tar -tzf` 完整校验、sha256、删除范围与触发条件（本里程碑不删除）。
- **Task 14（生产上架 runbook 指引）**：`docs/huaanwork-three-agent-packages-release.md` 与证据指针；生产签名/上架仍为 owner 运维动作。

### 10.8 工作树状态与 scratch

- 门禁实测 HEAD：`736ede7742`（本提交之前）；本节以独立 commit 追加。`deepseek-harness` pin `1600d8a1e140dcde43a1a0941940a0480712c011` 未变；除本文件与空白修复提交外工作树干净。
- scratch（未提交）：`/tmp/task10-typecheck.log`、`/tmp/task10-build.log`、`/tmp/task10-hw-build.log`、`/tmp/task10-test.log`、`/tmp/task10-check{,-2,-3}.log`、`/tmp/plaza-verify-report-task10.json`、`/tmp/task10-plaza-{stdout.json,stderr.log}`。
