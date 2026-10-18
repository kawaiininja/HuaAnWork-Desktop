# M9 上游同步实施计划(钉 dsh-v0.2.1-rc.1、vendor runtime 刷新、21 补丁重做)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 fork 合并到 upstream/master 新 tip、子模组 pin 到 `dsh-v0.2.1-rc.1`、beta/huaanwork vendor runtime 刷新到 rc.1、21 个 Desktop 兼容补丁重做为 `@0.2.1-rc.1`,并在新制品上重跑 A1–A19 人类核对后收口。

**Architecture:** 三阶段串行(Epic R-M9-1):M9-A 桌面侧合并 + vendor 刷新(补丁打在 vendor 产物上,A 不完成 B 无靶子)→ M9-B 21 补丁重做 → M9-C 验证链 + 新制品核对收口。全程在独立 worktree,子模组 pin 单独一个提交。

**Tech Stack:** Yarn 4.18.0(Corepack, nodeLinker: node-modules)+ 子模组 pnpm;`scripts/sync-vendored-runtime.mjs` 三通道 vendor 管理;补丁以 yarn `patch:` 协议打在 vendored tgz 解包产物上。

**Spec:** `docs/superpowers/specs/2026-10-17-m9-upstream-sync-epic.md`(已通过 GLM + grok 两轮复审;单一真相源是 Epic,本计划是其任务化展开)
**补丁权威依据:** `docs/evidence/2026-10-17-runtime-patches-alpha5-disposition.md`(下称「处置清单」。注意其 §5 A3 行的「-alpha.2 系」是过期口径,以 Epic 步骤⑤的 rc.1 稳定系为准)
**评审:** GLM plan-review(`docs/superpowers/plans/2026-10-17-m9-upstream-sync-plan-review.md`)的 P1 + P2-1 已由其落盘;P2-2/3/4 与 P3 三项 nit 已于 2026-10-17 全部采纳并入本文(补丁生成改临时 git 仓 `git diff`——`--no-index` 实测会带双层前缀 `a/a/`,弃用;Task 6 不设 tgz 固定数;重放口径两套;合并提交排除证据文档、可变 install 挪到全部消解后;Epic M9-B 回滚句补 resolution 同步要求)。开工前补齐(同日):合并提交用 `git commit --no-edit`;`ci.yml` 只保住三处 `dsh-plugin-huaanwork`,不对整文件 `checkout --ours`;schemastery 用根 resolution 把 `^3.18.5-alpha.1` 钉到 `3.18.5`,`yarn install` / `yarn up` 都不做这件事。

## Global Constraints

- 子模组目标 pin = `1600d8a1e140dcde43a1a0941940a0480712c011`(dsh-v0.2.1-rc.1),**单独一个提交**,`git show --stat` 只含 gitlink 一行;合并提交带上的第一跳是上游 pin `1517a4dbca`(alpha.5),属合并提交、不拆。
- **`deepseek-harness/` 是 pin 住的子模组,绝不编辑其中文件**;上游命令只经 root `upstream:*` 脚本。
- Zero-touch 规则:不为 huaanwork 工作编辑 `dsh-plugin-desktop/src/` 或 `dsh-plugin-desktop-beta/src/`。
- A1(R-M9-2):只删 beta、huaanwork 两包的 `@deepseek-ai/dsh-subagent-in-process-driver` 依赖行;desktop、next 的同名行保留。
- A3 目标值(rc.1 稳定系,已实测):cordis `4.0.5`、group `1.0.5`、include `1.0.10`、loader `1.0.6`、timer `1.1.7`;schemastery 声明行 caret **不动**。`^3.18.5-alpha.1` 同时容纳 `3.18.5-alpha.2` 和 `3.18.5`,合并后的锁若停在 alpha.2,`yarn install` 不会把它抬上去。用根 resolution `"@deepseek-ai/schemastery@npm:^3.18.5-alpha.1": "3.18.5"` 钉死(与本仓 `koffi@npm:^3.1.0` → `3.1.5` 同形)。不要用 `yarn up`(会改 manifest 里的 range)或 `yarn up -R`(会解到该 range 的最高版本,不必是 `3.18.5`)。Next、market、beta、huaanwork 共用这个 caret,安装实例一起变成 `3.18.5`,声明行仍是 `^3.18.5-alpha.1`,不算升 Next 的钉版。desktop 的 `^3.18.4` 是另一条 descriptor,不在这条 resolution 里。**next 的 cordis 五成员与 desktop 的 4.0.4 系一律不动。** npm 上 `-alpha.2` 与稳定版并存,钉错版本安装不报错——升版后必须 `yarn why` 验证。
- `vendor/dsh-runtime/0.2.1-alpha.1/`、21 个 `*@0.2.1-alpha.1.patch`、根 resolutions 整段 `@npm:0.2.1-alpha.1`(642 行,含 driver 2 行)是 **next 的解析通道,全程保留**。`*@0.2.0-rc.2.patch` 及更早代补丁也不动。**合并陷阱(2026-10-17 plan-review P1)**:fork 侧自 merge-base 对 beta/next/market 的 dsh/cordis/schemastery/driver 依赖行零改动而上游已改 ⇒ 三方合并 theirs-wins **静默推进**到上游 alpha.5/-alpha.2 值、driver 行被上游删除、上游新增 17 个 lane 依赖——next 的冻结通道依赖行必须在合并后显式恢复(Task 2 Step 5),否则本条、DoD 3 的 next 计数与 Task 8 的 642 行恢复理由全部失效。
- 永久 override(`docs/upstream-sync.md` §6,8 个文件)合并时保留 fork 侧:`scripts/verify-desktop-variants.mjs`、`scripts/expected-root-gate-scripts.json`、`scripts/market-manifest-byte-budget.json`、三包 `tests/package.spec.ts`、`market-server/src/manifest-prepare.ts`、`dsh-plugin-huaanwork/tests/huaanwork-host/market-verify.spec.ts`。
- `yarn.lock` 与根 `package.json` **不逐 hunk 三方合并**:按 `docs/upstream-sync.md` §5,取上游版为基底、重放 fork 增量、重装生成锁文件。
- dshmarket:`dist:mac:huaanwork` 先跑 `market:prepare`;若最新 dshmarket 套不上 `.yarn/patches/dshmarket-desktop.patch`(2026-10-17 实测 latest 1.66.32/1.66.35 均 hunk #7 FAILED),用锁文件里已安装的版本出包,不提交市场版本变动,不算 M9 的红。
- R-M9-4:托盘 A10 **不挡开工、挡收口**;全程不先修 A10;制品换过后 A1–A19 全部重跑。
- 每个验收命令必须记录:命令原文 + 退出码 + 关键输出;没跑过的命令不汇报。
- 合并逐冲突 hunk 记录(文件、两侧写法、取舍、理由)落 `docs/evidence/2026-10-m9-merge-decisions.md`。

---

## 阶段 M9-A:合并 + vendor 刷新(跟踪 issue #4)

### Task 1: 隔离 worktree 与 upstream remote

**Files:**
- Create: worktree `../HuaAnWork-Desktop-sync-m9`(分支 `sync/upstream-2.1.x`)

**Interfaces:**
- Produces: 后续所有任务的工作目录 = `../HuaAnWork-Desktop-sync-m9`;as-of lag 数字写入合并记录头部。

- [ ] **Step 1: 主工作树干净性检查**

```bash
cd /Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop
git status --porcelain
```

Expected: 除已知的 docs 改动外无未提交代码改动;若有,先提交或 stash。docs(spec/plan)改动先提交:`git add docs/superpowers/ AGENTS.md && git commit -m "docs(specs): M9 Epic 复审修订并入(P1-1/2/3、P2、P3)+ grok/glm 执行口径;AGENTS.md 债表 A3 订正"`。

- [ ] **Step 2: 建 worktree(参照 M8 `../HuaAnWork-Desktop-sync` 先例)**

```bash
git worktree add ../HuaAnWork-Desktop-sync-m9 -b sync/upstream-2.1.x master
cd ../HuaAnWork-Desktop-sync-m9
```

- [ ] **Step 3: upstream remote 与拉取(`docs/upstream-sync.md`:每台机/每个 worktree 的一次性前置)**

```bash
git remote -v | grep upstream || git remote add upstream https://github.com/anywhere-labs/dsh-desktop.git
git fetch upstream --tags
git submodule update --init --recursive
```

- [ ] **Step 4: 记录 as-of 基线(写进合并记录文档头部)**

```bash
git rev-list --count HEAD..upstream/master
git rev-list --no-merges --count HEAD..upstream/master
git log -1 --format='%h %ci' upstream/master
git ls-tree upstream/master deepseek-harness   # 期望: 1517a4dbca...
```

Expected: 落笔时 119/77、tip `44084bdae0`;实测值以命令输出为准并记录。gitlink 必须是 `1517a4dbca0a2789ff1d41ba439600f8547d23fa`。

- [ ] **Step 5: Commit**

无代码改动,不提交;基线数字先记在工作笔记,Task 2 写入证据文档。

### Task 2: 合并 upstream/master,逐 hunk 记录

**Files:**
- Modify: 合并触及的全部文件
- Modify: `dsh-desktop-next/package.json`(Step 5:冻结通道依赖行恢复,plan-review P1)
- Create: `docs/evidence/2026-10-m9-merge-decisions.md`

**Interfaces:**
- Consumes: Task 1 的 worktree 与 as-of 基线
- Produces: 合并提交(其 gitlink = `1517a4dbca`,属本提交、不拆);next 冻结通道恢复提交;冲突消解记录文档,供 M9-A 验收与后续里程碑引用

- [ ] **Step 1: 发起合并**

```bash
cd ../HuaAnWork-Desktop-sync-m9
git merge upstream/master
```

Expected: 出现冲突。已知预期冲突点:① `dsh-desktop-next/scripts/verify-sidebar-browser.mjs`(fork PR #1 vs 上游 `75ad518423`,同一根因同一写法);② `.github/workflows/ci.yml` 矩阵 hunk;③ `yarn.lock` + 根 `package.json`;④ §6 的 8 个永久 override 文件。

- [ ] **Step 2: 按裁定规则消解四类已知冲突**

- sidebar-browser:**取上游写法**(两侧同为 `guests.bind(window, () => () => {})`,上游多 `uncaughtException` 兜底,取上游即涵盖 fork 侧,平凡冲突)。
- `ci.yml`:**不要** `git checkout --ours` 整文件。以合并结果里的上游改动为底,只保住 fork 现在这三处 `dsh-plugin-huaanwork`(合并前行号会漂,按任务名找):`check` 里暂时跳过 `verify:aa` 的 workspace 循环、`desktop-windows` 的 matrix、`desktop-macos` 的 matrix。`desktop-linux` 的 matrix 现在只有 desktop 与 beta,huaanwork 没有 Linux 发行流水线,不要给它加上第三格。漏掉前三处会让 huaanwork 从发版矩阵消失而测试仍绿。
- §6 永久 override 8 文件(清单见 Global Constraints):**保留 fork 侧**(`git checkout --ours -- <path>` 后逐文件核对 fork 内容完整)。
- `yarn.lock` 与根 `package.json`:取上游版为基底(`git checkout --theirs -- yarn.lock package.json`),然后重放 fork 增量——根 `package.json` 需重放:`workspaces` 的 fork 包(market-server、update-server、dsh-plugin-huaanwork 等)、全部 fork `resolutions`(**两套** dsh vendor 选择子:stable `0.2.0-rc.2` + 冻结的 `0.2.1-alpha.1`;rc.1 套是 Task 8 `--write` 的产物,重放时刻尚不存在 + dshmarket patch resolution + 其他 fork 钉版)、fork 门禁 `scripts`、各包特有字段。**禁止逐 hunk 手工三方合并这两个文件。**`yarn.lock` 的可变重装不在本步做——Step 3 的源码冲突可能再动其他包的 `package.json`,统一挪到 Step 4 全部消解后一次重生。

- [ ] **Step 3: 其余源码冲突逐 hunk 消解并记录**

每处冲突在 `docs/evidence/2026-10-m9-merge-decisions.md` 追加一行:文件、hunk 主题、两侧写法、取舍、理由(参照 M8 `2026-10-m8-merge-decisions.md` 的 replay 表格式)。拿不准取舍的 hunk 停下来问,不猜。

- [ ] **Step 4: 完成合并并验证**

```bash
corepack yarn install        # 可变:全部冲突消解完后一次性重生 yarn.lock
git add -A -- ':!docs/evidence/2026-10-m9-merge-decisions.md' && git commit --no-edit   # 合并提交,用默认 MERGE_MSG,不打开编辑器;证据文档留到 Step 6 单独提交
git ls-tree HEAD deepseek-harness   # 期望 gitlink = 1517a4dbca...
corepack yarn install --immutable 2>&1 | tail -5   # 终检:锁文件与清单一致
```

Expected: 合并提交落成(不含证据文档);gitlink 是 alpha.5(下一任务才到 rc.1);可变 install 绿且 `--immutable` 终检绿。若红,先修重放遗漏再回到本步。**设计内中间态(plan-review P1)**:beta/market 的 dsh 依赖此时已被合并静默推进到上游 alpha.5(公网 npm 解析;Task 8 的 `--write` 自愈为 vendored rc.1),install 走公网属预期;next 的恢复在下一步。

- [ ] **Step 5: 恢复 next 的冻结通道依赖行(plan-review P1 修法,2026-10-17)**

合并把 next 的 dsh/cordis/schemastery 依赖行静默推进到上游值,并删掉了 driver 行(fork 侧自 merge-base 未动这些行 ⇒ theirs-wins;实测:162 个 lane 值被推进、driver 删除、上游新增 17 个 lane 依赖)。恢复为 pre-merge fork 值——**严格冻结**:上游新增的 17 个 lane 依赖一并移除(它们没有 alpha.1 版本,留着会把 next 的树混入 npm alpha.5 传递闭包):

```bash
cd ../HuaAnWork-Desktop-sync-m9
git show master:dsh-desktop-next/package.json > /tmp/m9-next-premerge.json
node -e '
const fs = require("fs");
const pre = JSON.parse(fs.readFileSync("/tmp/m9-next-premerge.json", "utf8"));
const cur = JSON.parse(fs.readFileSync("dsh-desktop-next/package.json", "utf8"));
const isLane = k => k === "@deepseek-ai/dsh" || k.startsWith("@deepseek-ai/dsh-")
  || k === "@deepseek-ai/cordis" || k.startsWith("@deepseek-ai/cordis-plugin-")
  || k === "@deepseek-ai/schemastery";
let restored = 0, removed = [];
for (const field of ["dependencies", "devDependencies"]) {
  const preField = pre[field] ?? {}, curField = cur[field] ?? {};
  for (const [k, v] of Object.entries(preField)) {
    if (isLane(k) && curField[k] !== v) { cur[field][k] = v; restored++; }
  }
  for (const k of Object.keys(curField)) {
    if (isLane(k) && !(k in preField)) { delete cur[field][k]; removed.push(k); }
  }
}
fs.writeFileSync("dsh-desktop-next/package.json", JSON.stringify(cur, null, 2) + "\n");
console.log(`restored ${restored} lane deps; removed upstream-added: ${removed.length}`);
console.log(removed.join("\n"));
'
corepack yarn install
```

Expected: `restored 162`(dependencies 159 含 driver 恢复 + devDependencies 3);`removed upstream-added: 17`——17 条清单落合并记录文档。install 后 next 的树回到纯 alpha.1 vendored+patched。**era-mismatch 裁定路径**:若后续 typecheck(Task 8 Step 5 的 fallout 清单)爆出合并代码引用这 17 个被移除的依赖,停下裁定「next 相关源码也回退 fork 侧」或「接受该依赖随上游(须同步改 DoD 3/5 与本步)」,不静默放行。

> **执行订正 2026-10-18(用户裁定 R-M9-R1)**:本步对 next 的「严格冻结 alpha.1」已被 Task 13 取代。合并带入的 next 源码是 alpha.5/rc.1 时代,冻结通道使 next 的 `typecheck`/`test` 结构性无法转绿(实测 114 tsc errors、5 test failures、`host-office.spec` 无法加载),且回退 pre-merge 仍会对 rc.1 beta 报 typecheck 错。按本 Epic 的 era-mismatch 条款「accept deps follow upstream + sync DoD 3/5」并经用户 2026-10-18 批准,next 升级到 `0.2.1-rc.1`(**Task 13 范围**)。本步脚本与 2026-10-17 的执行记录保留为历史,不得再对 next 执行;`vendor/dsh-runtime/0.2.1-alpha.1/`、21 个 `*@0.2.1-alpha.1.patch` 与根 resolutions 的 alpha.1 段仍原样保留(休眠)。

```bash
git add dsh-desktop-next/package.json yarn.lock
git commit -m "chore(next): restore frozen alpha.1 dependency lane after upstream merge (plan-review P1)"
```

- [ ] **Step 6: Commit 证据文档**

```bash
git add docs/evidence/2026-10-m9-merge-decisions.md
git commit -m "docs(evidence): M9 合并冲突逐 hunk 消解记录"
```

### Task 3: 子模组 pin 单独提交到 rc.1

**Files:**
- Modify: `deepseek-harness/`(gitlink only)

**Interfaces:**
- Consumes: Task 2 的合并提交
- Produces: pin 提交(验收:`git show --stat` 只含 gitlink 一行);工作区子模组检出 = rc.1,供 Task 6 打包

- [ ] **Step 1: 检出 rc.1 并提交 pin**

```bash
cd ../HuaAnWork-Desktop-sync-m9/deepseek-harness
git checkout 1600d8a1e140dcde43a1a0941940a0480712c011
cd ..
git add deepseek-harness
git commit -m "chore(upstream): pin deepseek-harness to dsh-v0.2.1-rc.1"
```

- [ ] **Step 2: 验证独立性**

```bash
git show --stat HEAD
git submodule update
cd deepseek-harness && git describe --tags && cd ..
```

Expected: `git show --stat` 只有 `deepseek-harness` 一行 gitlink 变更,父提交里的 gitlink 是 `1517a4dbca`;`git describe` 输出 `dsh-v0.2.1-rc.1`。

### Task 4: A1——删 beta/huaanwork 的 driver 依赖行(R-M9-2)

**Files:**
- Modify: `dsh-plugin-huaanwork/package.json`(合并前 `:329`;beta 的 `:279` 已被合并自动移除——上游删除、fork 未动 ⇒ theirs-wins,plan-review P1)

**Interfaces:**
- Produces: huaanwork 删一行;beta 的行已被合并自动移除;desktop `:278`、next `:164`(Task 2 Step 5 恢复)保留(M9-A 验收按字符串计数,不按行号)

- [ ] **Step 1: 删行(按包名定位,不按行号——行号是合并前 as-of)**

只需删 huaanwork 的这一行(注意去掉行尾逗号后的 JSON 合法性):

```json
    "@deepseek-ai/dsh-subagent-in-process-driver": "0.2.1-alpha.1",
```

- [ ] **Step 2: 验证计数**

```bash
grep -c 'dsh-subagent-in-process-driver' dsh-plugin-desktop/package.json dsh-plugin-desktop-beta/package.json dsh-plugin-huaanwork/package.json dsh-desktop-next/package.json
```

Expected: desktop=1、beta=0、huaanwork=0、next=1(合计 2)。

- [ ] **Step 3: Commit**

```bash
git add dsh-plugin-huaanwork/package.json
git commit -m "feat(huaanwork): drop removed dsh-subagent-in-process-driver dep (R-M9-2; beta line already removed by merge)"
```

### Task 5: A3——cordis 家族升 rc.1 稳定系 + schemastery 重解

**Files:**
- Modify: `dsh-plugin-desktop-beta/package.json`(cordis 五行,合并前 `:152-156`;schemastery devDep `:311` 恢复 caret)
- Modify: `dsh-plugin-huaanwork/package.json`(cordis 五行,合并前 `:207-211`)
- Modify: `dsh-community-market/package.json`(cordis devDep 合并前 `:215`、cordis peer `:88`、schemastery peer `:131` 与 devDep `:273` 恢复 fork 值)
- Modify: 根 `package.json` resolutions(新增一条 schemastery 钉版;Task 2 重放时还没有它)
- Modify: `yarn.lock`(重装重解)

**Interfaces:**
- Produces: beta/huaanwork cordis 五成员 = 稳定系;market cordis devDep = `4.0.5`、peer = 三支;schemastery 声明行不动,`^3.18.5-alpha.1` 这条 descriptor 的安装实例 = `3.18.5`;`yarn why` 证据

- [ ] **Step 1: 改 beta 与 huaanwork 的 cordis 五成员(两包同样五行)**

```json
    "@deepseek-ai/cordis": "4.0.5",
    "@deepseek-ai/cordis-plugin-group": "1.0.5",
    "@deepseek-ai/cordis-plugin-include": "1.0.10",
    "@deepseek-ai/cordis-plugin-loader": "1.0.6",
    "@deepseek-ai/cordis-plugin-timer": "1.1.7",
```

**改前值注意(plan-review P1 连带)**:合并已把 beta 侧的同五行静默推进到 `-alpha.2` 系、schemastery 行推进到 `^3.18.5-alpha.2`(huaanwork 是 fork-only 文件不受影响,改前值仍是 `-alpha.1` 系)。本步除五成员改稳定系外,**把 beta 的 schemastery 行恢复为 `^3.18.5-alpha.1`**(与 huaanwork/next/market 同 caret,满足 Epic DoD 5 的字符串口径)。**不动**:next 的同名五行(Task 2 Step 5 已恢复为 alpha.1 冻结值)、desktop 的 4.0.4 系、huaanwork 的 schemastery 声明行。

- [ ] **Step 2: 改 market 的 cordis devDep 与 peer,恢复 schemastery 两行为 fork 值**

`dsh-community-market/package.json`(market 自 merge-base 零 fork 改动 ⇒ 合并整文件 theirs-wins,**改前值是上游 alpha.5/-alpha.2 形态**,plan-review P1 订正):

- cordis devDep:`"4.0.5-alpha.2"` → `"4.0.5"`
- cordis peer:`"4.0.4 || 4.0.5-alpha.2"` → `"4.0.4 || 4.0.5-alpha.1 || 4.0.5"`
- schemastery peer:**恢复为 fork 值 `"^3.18.4 || ^3.18.5-alpha.1"`**(合并推进到 `^3.18.4 || ^3.18.5-alpha.2`——`^3.18.5-alpha.2` 不盖 next 的 `3.18.5-alpha.1`,必须恢复;`^3.18.4` 已含 3.18.5 稳定版,删 `-alpha.1` 支同样会破 next)
- schemastery devDep:恢复为 `"^3.18.5-alpha.1"`(与 beta/huaanwork/next 同 caret)

三支缺一不可:`4.0.4` = stable 宿主现钉,`4.0.5-alpha.1` = next 现钉(Task 2 Step 5 恢复后),`4.0.5` = beta/huaanwork 新钉;精确版本 `4.0.5-alpha.1` 不等于 `4.0.5`。market 的 dsh peers(`"0.2.0-rc.2 || 0.2.1-alpha.5"` 形态)不手改——Task 8 的 beta `--write` 会写成三支串。

- [ ] **Step 3: 用根 resolution 把该 caret 钉到 `3.18.5`,再重装**

在根 `package.json` 的 `resolutions` 增加这一条(键的形态与本仓 `koffi@npm:^3.1.0` 相同,值是版本号不是 range):

```json
    "@deepseek-ai/schemastery@npm:^3.18.5-alpha.1": "3.18.5"
```

不要改 beta/huaanwork/next/market 的 schemastery 声明行。不要跑 `yarn up`(会改那些声明)或 `yarn up -R`(会解到该 range 的最高版本,不必是 `3.18.5`)。`^3.18.5-alpha.1` 仍满足 `3.18.5-alpha.2`,所以只跑 `yarn install`、不写这条 resolution,锁会停在合并带入的 alpha.2。这条 resolution 不是 `@deepseek-ai/dsh` / `dsh-` 选择子,Task 8 的 `--write` 过滤不会删它;alpha.1 段恢复脚本只补缺失的 dsh 选择子,也不会动它。desktop 的 `^3.18.4` 是另一条 descriptor,不要给它加 resolution。

```bash
corepack yarn install
corepack yarn why @deepseek-ai/cordis
corepack yarn why @deepseek-ai/schemastery
```

Expected: 请求范围是 `^3.18.5-alpha.1` 的 schemastery 实例为 `3.18.5`(beta、huaanwork、next、market 的声明行仍是这个 caret,安装实例一起变成 `3.18.5`,不算升 Next 的钉版)。desktop 若仍因 `^3.18.4` 解到别的 3.18.x,不算失败。huaanwork 的 cordis 只有 `4.0.5` 一份;workspace 根上 desktop 的 `4.0.4` 与 next 的 `4.0.5-alpha.1` 继续共存,**不算失败**。**中间态注意(plan-review P1 连带)**:beta 的 dsh 依赖此间仍是合并带入的 npm alpha.5(Task 8 `--write` 才回 vendored rc.1),其传递闭包可能与新钉 `4.0.5` 并存两份 cordis——beta 侧若见两份,先记录不阻断,以 Task 8 Step 5 的终检为准;huaanwork 侧若两份则确系钉版漏改,停下排查,不继续。

- [ ] **Step 4: Commit**

```bash
git add package.json dsh-plugin-desktop-beta/package.json dsh-plugin-huaanwork/package.json dsh-community-market/package.json yarn.lock
git commit -m "feat(beta,huaanwork,market): bump cordis family to rc.1 stable line 4.0.5 (R-M9 A3)"
```

### Task 6: 上游侧打包 rc.1 runtime(`upstream:prepare-runtime`)

**Files:**
- Produces: `deepseek-harness/dist/npm/`(rc.1 vendored tgz + `publish-order.txt`;rc.1 已删 driver 包。tgz 数量**不设固定预期**:alpha.1→rc.1 窗口内子模组包目录 328→349,闭包净增,实际值将明显高于 321−1=320——记录实际值即可,有效断言是下一步的 driver 0 命中)

- [ ] **Step 1: 打包**

```bash
cd ../HuaAnWork-Desktop-sync-m9
corepack yarn upstream:prepare-runtime
```

Expected: `upstream:install` → `upstream:build:official` → `upstream:pack:dsh` 全绿。rc.1 起 `release:pack` 经 `scripts/release/families.ts` 纳入 ON_DEMAND_BUNDLES 发布序并校验 peer 边(提交 `8ed0b530ed`)——若此处报 on-demand bundle 校验错,是上游侧问题,停下记录,不要绕。子模组检出必须是 rc.1(Task 3 的 `git submodule update`),不是合并提交里的 alpha.5。

- [ ] **Step 2: 验证产物**

```bash
ls deepseek-harness/dist/npm/*.tgz | wc -l
ls deepseek-harness/dist/npm/ | grep -c 'subagent-in-process-driver' || true
```

Expected: 记录实际 tgz 数(将高于 320,闭包净增所致,不设上限断言);**driver 包 0 命中(上游已删)——这才是本步的有效断言**。

### Task 7: upstream.json 指 rc.1 + sync 脚本 marketPeerRange 改三支

**Files:**
- Modify: `upstream.json`(beta/huaanwork 两通道)
- Modify: `scripts/sync-vendored-runtime.mjs:66`

**Interfaces:**
- Consumes: Task 6 的 `dist/npm` 产物
- Produces: `--write` 的输入;market dsh peer 目标串 `"0.2.0-rc.2 || 0.2.1-rc.1 || 0.2.1-alpha.1"`

- [ ] **Step 1: 改 upstream.json(beta、huaanwork 两通道;stable 不动)**

```json
      "commit": "1600d8a1e140dcde43a1a0941940a0480712c011",
      "sourceVersion": "0.2.1-rc.1",
      "runtimePackageVersion": "0.2.1-rc.1",
```

(`runtimeSource` 由 `--write` 自写,不手改。`--write` 用 `sourceVersion` 决定 vendor 目录与 resolution 版本,不会自己把 alpha.1 改成 rc.1;`--check` 要求 manifest.commit 等于通道 commit,所以 commit 必须先指对。)

- [ ] **Step 2: 改 `marketPeerRange`(`scripts/sync-vendored-runtime.mjs:66`)**

```js
// 改前:
const marketPeerRange = [...new Set(['stable', 'beta'].map(name => upstreamDocument.channels?.[name]?.sourceVersion))].join(' || ')
// 改后(第三支是 Next 冻结的 runtime;Next 离开 alpha.1 时删掉这一支):
const marketPeerRange = [...new Set([...['stable', 'beta'].map(name => upstreamDocument.channels?.[name]?.sourceVersion), '0.2.1-alpha.1'])].join(' || ')
```

`--check` 对 market 的 dsh peer 做整串相等(`range !== expected` 即失败),所以这串必须由脚本写出,不能写完再手改。

- [ ] **Step 3: Commit**

```bash
git add upstream.json scripts/sync-vendored-runtime.mjs
git commit -m "feat(sync): point beta/huaanwork at dsh 0.2.1-rc.1; market peers cover frozen next runtime"
```

### Task 8: sync `--write` ×2 + alpha.1 resolution 整段放回 + 三通道 check

**Files:**
- Modify: 根 `package.json` resolutions、`vendor/dsh-runtime/0.2.1-rc.1/`(新建)、`dsh-plugin-desktop-beta/package.json`、`dsh-plugin-huaanwork/package.json`、`dsh-community-market/package.json` 的 dsh 依赖区间

**Interfaces:**
- Consumes: Task 7 的 upstream.json 与脚本
- Produces: `vendor/dsh-runtime/0.2.1-rc.1/` 与 rc.1 resolution 集合;alpha.1 三件套(vendor 目录 + 642 行 resolution + 21 补丁文件)完好;`check:vendored-runtime` 三通道绿

**预期中间态(设计内,不挡本卡)**:此时 `patches/` 还没有 `*@0.2.1-rc.1.patch`,rc.1 resolution 是无补丁 tarball;补丁重做是 M9-B。rc.1 缺失补丁导致的 `typecheck` 失败清单落记录,交 M9-B 消。

- [ ] **Step 1: 备份根 package.json 的 alpha.1 resolution 段**

```bash
cd ../HuaAnWork-Desktop-sync-m9
cp package.json /tmp/m9-root-package.backup.json
grep -c '@npm:\^*0\.2\.1-alpha\.1"' package.json   # 期望 642(321 包 × 2,含 driver 2 行)
```

- [ ] **Step 2: 跑两次 `--write`(先 beta 后 huaanwork)**

```bash
node scripts/sync-vendored-runtime.mjs --write --channel beta
node scripts/sync-vendored-runtime.mjs --write --channel huaanwork
```

Expected: 两通道 sourceVersion 都已是 rc.1,alpha.1 不属于任何通道 ⇒ 根 `package.json` 里整段 `@npm:0.2.1-alpha.1` / `@npm:^0.2.1-alpha.1` resolution(全部 642 行,不只是 driver 2 行)被删掉;`vendor/dsh-runtime/0.2.1-rc.1/` 新建;market 的 dsh peer 被写成 `"0.2.0-rc.2 || 0.2.1-rc.1 || 0.2.1-alpha.1"`(仅 beta 这次写 market;脚本对 huaanwork 通道跳过 market);脚本不删 `vendor/dsh-runtime/0.2.1-alpha.1/`、不改 `dsh-desktop-next/package.json`。

- [ ] **Step 3: 整段放回 alpha.1 resolution(next 的解析通道)**

```bash
node -e '
const fs = require("fs");
const backup = JSON.parse(fs.readFileSync("/tmp/m9-root-package.backup.json", "utf8"));
const current = JSON.parse(fs.readFileSync("package.json", "utf8"));
let restored = 0;
for (const [selector, value] of Object.entries(backup.resolutions ?? {})) {
  if ((selector.endsWith("@npm:0.2.1-alpha.1") || selector.endsWith("@npm:^0.2.1-alpha.1")) && !(selector in current.resolutions)) {
    current.resolutions[selector] = value;
    restored++;
  }
}
fs.writeFileSync("package.json", JSON.stringify(current, null, 2) + "\n");
console.log(`restored ${restored} alpha.1 resolutions`);
'
```

Expected: `restored 642`。`--check` 只把「选择子以本通道版本结尾」的 resolution 当本通道项,多留的 alpha.1 段不会让三通道变红(已读码核实)。

- [ ] **Step 4: 重装 + 三通道 check**

```bash
corepack yarn install
corepack yarn check:vendored-runtime
```

Expected: install 绿;`check:vendored-runtime` = stable/beta/huaanwork 三通道依次绿。

- [ ] **Step 5: M9-A 验收项核查并落记录**

```bash
git merge-base --is-ancestor upstream/master HEAD && echo MERGE-OK
git show --stat HEAD~N   # pin 提交只含 gitlink 一行(N = pin 提交距 HEAD 的距离)
grep -c 'dsh-subagent-in-process-driver' dsh-plugin-desktop/package.json dsh-plugin-desktop-beta/package.json dsh-plugin-huaanwork/package.json dsh-desktop-next/package.json
ls vendor/dsh-runtime/0.2.1-alpha.1/manifest.json vendor/dsh-runtime/0.2.1-rc.1/manifest.json
grep -c '"0\.2\.0-rc\.2 || 0\.2\.1-rc\.1 || 0\.2\.1-alpha\.1"' dsh-community-market/package.json
corepack yarn why @deepseek-ai/cordis
corepack yarn why @deepseek-ai/schemastery
corepack yarn typecheck 2>&1 | tail -30
```

Expected: MERGE-OK;driver 计数 1/0/0/1(next 的 1 来自 Task 2 Step 5 的恢复行);两个 vendor 目录都在;market dsh peer 三支串计数 = 44(全部 dsh peer;plan-review P2-1:原 `grep '"@deepseek-ai/dsh@npm'` 对 market 的 package.json 匹配零行——`@npm:` 选择子只存在于根 resolutions——已订正为本命令);根 resolutions 仍有 `"@deepseek-ai/schemastery@npm:^3.18.5-alpha.1": "3.18.5"`。`yarn why` 终检:beta/huaanwork 的 cordis 为 `4.0.5`;`^3.18.5-alpha.1` 这条 schemastery descriptor 为 `3.18.5`(beta 此刻已回 vendored rc.1,Task 5 Step 3 的 cordis 中间态顾虑在此消除;desktop 另一条 `^3.18.4` 不算失败)。`typecheck` 此时**预期有失败**(rc.1 无补丁)——把失败清单完整落进 `docs/evidence/2026-10-m9-merge-decisions.md` 末尾的「M9-A fallout(交 M9-B)」节,不挡本卡;**若 next 的失败源于合并代码引用 Task 2 Step 5 移除的 17 个上游新增 lane 依赖(era mismatch),按该步的裁定路径处理,不静默放行**。

- [ ] **Step 6: Commit + 关闭跟踪壳**

```bash
git add -A
git commit -m "feat(vendor): sync rc.1 vendored runtime for beta/huaanwork; keep alpha.1 lane for next"
```

在 issue #4 评论验收证据(命令 + 退出码 + 关键输出),由收口时统一 Closes。

---

## 阶段 M9-B:21 补丁重做(跟踪 issue #5)

**通用重做规程(每个补丁都走这五步):**

```bash
PKG=<包短名>   # 如 dsh-hmr
REPO=<仓库路径>
cd /tmp && rm -rf m9p-$PKG && mkdir m9p-$PKG && cd m9p-$PKG
tar xzf $REPO/vendor/dsh-runtime/0.2.1-rc.1/deepseek-ai-$PKG-0.2.1-rc.1.tgz
cd package && git init -q && git add -A && git -c user.email=m9@m9 -c user.name=m9 commit -qm base
# 参照 $REPO/patches/$PKG@0.2.1-alpha.1.patch 与处置清单备注,在工作树里逐 hunk 重打(锚点定位,不用行号)
# 用 git diff 产出 git 头格式(仓内全部既有补丁均为 diff --git 头 + a/ b/ 相对包根路径;
# 裸 diff -ruN 或 git diff --no-index 产出的路径形态都不是这个,后者会带双层前缀 a/a/...,不要用)
git diff > $REPO/patches/$PKG@0.2.1-rc.1.patch
# 自验:干净解包 + 干跑必须全 hunk 通过
cd /tmp/m9p-$PKG && mkdir t && tar xzf $REPO/vendor/dsh-runtime/0.2.1-rc.1/deepseek-ai-$PKG-0.2.1-rc.1.tgz -C t
patch -p1 -d t/package --dry-run < $REPO/patches/$PKG@0.2.1-rc.1.patch
```

(最终的真实应用验证由「每批落地固定动作」里的 `corepack yarn install` 完成——yarn 会对 vendored tgz 实际应用补丁,自验干跑只是第一道。)

**每批(或每补丁)落地后让 resolution 生效的固定动作**(`--write` 会重写 rc.1 resolution 指向补丁,同时再次删掉 alpha.1 段,所以恢复脚本必须跟着重跑;脚本是幂等的):

```bash
cd ../HuaAnWork-Desktop-sync-m9
node scripts/sync-vendored-runtime.mjs --write --channel beta
node scripts/sync-vendored-runtime.mjs --write --channel huaanwork
node -e '
const fs = require("fs");
const backup = JSON.parse(fs.readFileSync("/tmp/m9-root-package.backup.json", "utf8"));
const current = JSON.parse(fs.readFileSync("package.json", "utf8"));
let restored = 0;
for (const [selector, value] of Object.entries(backup.resolutions ?? {})) {
  if ((selector.endsWith("@npm:0.2.1-alpha.1") || selector.endsWith("@npm:^0.2.1-alpha.1")) && !(selector in current.resolutions)) {
    current.resolutions[selector] = value;
    restored++;
  }
}
fs.writeFileSync("package.json", JSON.stringify(current, null, 2) + "\n");
console.log(`restored ${restored} alpha.1 resolutions`);
'
corepack yarn install
corepack yarn check:vendored-runtime
```

**纪律**:不删 `*@0.2.1-alpha.1.patch`(放回的 alpha.1 resolution 仍引用它们);不动 `*@0.2.0-rc.2.patch` 及更早代;处置清单「备注」栏逐条核对;每个补丁命名 `*@0.2.1-rc.1.patch`。

### Task 9: 两个中-大补丁(plugin-manager、settings-account)

**Files:**
- Create: `patches/dsh-client-ui-plugin-manager@0.2.1-rc.1.patch`
- Create: `patches/dsh-client-ui-settings-account@0.2.1-rc.1.patch`
- Create: `docs/evidence/2026-10-m9-patch-mapping-plugin-manager.md`、`docs/evidence/2026-10-m9-patch-mapping-settings-account.md`(「上游新结构 → 补丁映射」说明)

- [ ] **Step 1: plugin-manager(23 hunk,lib/client.js 16)**

意图:5 个桌面 slot(`plugins.header.leading`/`plugins.overview`/`plugins.bundle.hidden`/`plugins.item.hidden`/`plugins.bundle.actions`)+ `renderComponents` 复合渲染 + 隐藏集合进 ConfigLedger。rc.1 结构:Installed/More 双 tab,`listed` 过滤从 `optional` 改为 `official`,`ordered/pinned/more` 三段拆分(上游 `60328899e5`/`b227127d62`/`3de3a977e0`)——**补丁「双列表」语义被新结构覆盖,隐藏集合挂到新的 more/official 过滤链**;`PluginSidebarControl`/`data-plugin-page-header` 插入点对窄宽重排(`ee558c82d7`)重新定位。映射说明落证据文档。

- [ ] **Step 2: settings-account(7 hunk,lib/client.js 6)**

意图:`dshDesktopSetup` 扩展——onboarding 组件抽取 + `onboarding.desktop.before` slot + `readOnboardingApiKeyPresence` 无 bridge 回退 + `openDesktopLogin`。rc.1 结构:包大改(55 文件),锚点全搬迁;`DesktopOnboardingEntry` 签名已改(`setVisible` + hooks 注入);`readOnboardingApiKeyPresence` 拆到 `onboarding-credentials.ts:7`。ctx 回退需改签名并在调用点包闭包(`index.ts:261` 以无参函数传入 controller);须与上游凭据刷新失效机制(`credentials/reference-updated`)及 Web 账号登录(`8ee22c3668`)共存。映射说明落证据文档。

- [ ] **Step 3: 干跑自验 + 批次落地**

两个补丁各跑通用规程的自验;然后跑「每批落地固定动作」,`check:vendored-runtime` 绿。

- [ ] **Step 4: Commit**

```bash
git add patches/ package.json yarn.lock docs/evidence/2026-10-m9-patch-mapping-*.md
git commit -m "feat(patches): rebase plugin-manager & settings-account desktop patches onto 0.2.1-rc.1"
```

### Task 10: 三个中档补丁(dsh 核心、dsh-hmr、dsh-ptc-runtime-node)

**Files:**
- Create: `patches/dsh@0.2.1-rc.1.patch`、`patches/dsh-hmr@0.2.1-rc.1.patch`、`patches/dsh-ptc-runtime-node@0.2.1-rc.1.patch`

- [ ] **Step 1: dsh 核心(3 hunk)**

hunk① `manageDesktopProfile` 跳过 `rejectElectronProfile`:`apps/cli/src/args.ts:183` 仍裸调用,早退插顶部;上游 `apps/desktop-host/src/cli.ts:16` 同向演进,未来可能被吸收,重打时留意。hunks②③ `readPatches` 透传:`ResolvedProfileRuntime` 加 `readPatches?: ProfileContext['readPatches']`;`profileContext` 字面量(`profile-boot.ts:314-322`)加条件展开,位置在 packageManager 展开项之后、dir 之前;`ProfileContext` 接口(`profile-context.ts:15-33`)已改**全 readonly**,新字段必须写 `readonly readPatches?`;d.ts 同步。

- [ ] **Step 2: dsh-hmr**

alpha.5+ `Service.init` 头部新增 `const mainJob = this.mainJob()`(`index.ts:349`),`mainJob() → esmJob() → hasEsmCache() → Reflect.get(this.internal, ...)` 在 `this.internal === undefined` 时直接 TypeError——旧两 hunk 方案不再够用。重做:`mainJob`/`hasEsmCache` 加空值守卫(或 init 头部跳过)+ `private internal: ModuleLoader`(`:231`)类型放宽(否则 TS 收窄报错)。

- [ ] **Step 3: dsh-ptc-runtime-node(两现场同补)**

`src/index.ts:224-227` 与 `src/persistent.ts:192-196` **两个同构 env 过滤块必须同补**(`persistent.ts` 是 alpha.1 不存在的本轮增量)——漏一个持久 PTC 起不来。

- [ ] **Step 4: 干跑自验 + 批次落地 + grep 证据**

通用规程自验;「每批落地固定动作」;hmr 守卫与 ptc 双现场的 grep 证据落合并记录附录:

```bash
grep -n 'ELECTRON_RUN_AS_NODE' patches/dsh-ptc-runtime-node@0.2.1-rc.1.patch   # 期望两处现场
grep -n 'hasEsmCache\|internal' patches/dsh-hmr@0.2.1-rc.1.patch | head
```

- [ ] **Step 5: Commit**

```bash
git add patches/ package.json yarn.lock
git commit -m "feat(patches): rebase dsh core/hmr/ptc-runtime-node patches onto 0.2.1-rc.1"
```

### Task 11: 十六个小补丁批量重打

**Files:**
- Create: 其余 16 个 `patches/*@0.2.1-rc.1.patch`

**Interfaces:**
- Consumes: 处置清单 §2 逐条备注;Task 9/10 的批次落地动作

- [ ] **Step 1: 按处置清单 §2 逐条重打(锚点定位,不用行号)**

| # | 补丁 | 关键备注(全表见处置清单 §2) |
|---|---|---|
| 1 | dsh-app-boot | `profile-context.ts:74` `readProfilePatches` 函数体已重写(经 `readBundlePatches`),早退插函数顶部;`compatibility-preflight.ts:29` `manifestOf` 同形,`bare` 提前声明按新版面重排;d.ts 重新生成 |
| 2 | dsh-client-modules | alpha.5 拆了 Node/browser 双构建(`e137ebaaa1`),两条产物路径都要验证 |
| 3 | dsh-client-ui-conversation | `ConversationHeader.tsx:18-23`、`ConversationSession.tsx:69` 加定位属性 |
| 4 | dsh-client-ui-directory-picker-browse | **R-M9-3:继续 bridge,Windows 仍走 browse**;i18n 字典已精简(`c7d61ecc11`) |
| 5 | dsh-client-ui-primitives | `MarkdownText.module.css:208-217` 逐字相同 |
| 6 | dsh-client-ui-settings-general | `SettingsRoot.tsx:36` 附近重加 `if (id === 'desktop')` 分支 |
| 7 | dsh-client-ui-settings-shell | **以 `order: 40` 为基底,勿回退成 10** |
| 8 | dsh-client-ui-sidebar | `HeaderLeadingControls.tsx:30` 一行属性 |
| 9 | dsh-experimental-computer-use-cua-driver-native | 确认桌面侧 `desktopPermissions` 服务注册键名未变 |
| 10 | dsh-host-directory-picker-browse | **保留既有 abort 重抛** |
| 11 | dsh-host-open-in-app | 只改 `src/resolver.ts` 一处(两 hunk 是两份构建出口);`...options.env` 展开顺序不动 |
| 12 | dsh-plugin-manager | 符号锚定勿用行号(行号已漂移);**#12 永久 fork 差,Task 12 登记** |
| 13 | dsh-plugin-package-inventory-deepseek | `src/index.ts:74-84` 逐字相同 |
| 14 | dsh-subprocess-local | `runner-launch.ts:66-84` 逐字相同 |
| 15 | dsh-web-app | hunk② 原位平移;hunk① 上下文用新文本 |
| 16 | dsh-sandbox-windows-acl | 包 src 零改动;**#17 永久 fork 差,Task 12 登记** |

- [ ] **Step 2: 逐补丁干跑自验,分批(建议 4×4)跑落地动作 + `check:vendored-runtime`**

- [ ] **Step 3: 全量验收计数**

```bash
ls patches/ | grep -c '@0.2.1-rc.1.patch'        # 期望 21
ls patches/ | grep -c '@0.2.1-alpha.1.patch'     # 期望仍 21
grep -o 'patches/[a-z-]*@0\.2\.1-rc\.1\.patch' package.json | sort -u | wc -l    # 期望 21
grep -o 'patches/[a-z-]*@0\.2\.1-alpha\.1\.patch' package.json | sort -u | wc -l # 期望 21
```

- [ ] **Step 4: Commit(可按批多个提交)**

```bash
git add patches/ package.json yarn.lock
git commit -m "feat(patches): rebase remaining 16 desktop patches onto 0.2.1-rc.1"
```

### Task 12: #12/#17 永久 fork 差登记 + M9-B 收口验收

**Files:**
- Modify: `AGENTS.md` 债表「上游新一轮落后」行

**Interfaces:**
- Consumes: Task 9–11 的全部补丁
- Produces: 永久 fork 差登记;`typecheck`/`test` 转绿;M9-A fallout 清单逐条消除或经裁定转移

- [ ] **Step 1: 登记两条永久 fork 差(「与上游明示取向相左」,勿静默重打)**

在 `AGENTS.md` 债表 M9 行补记:① #12 `dsh.optionalBundles` 清单形态——上游 agent note `2026-09-15-shipped-optional-bundles.md` 明载「清单形态是 first form,maintainers keep product decisions in code」;② #17 sandbox-windows-acl 自愈——上游 README:130 明示 loud failure + 诊断 skill。两者是经裁定的永久 fork 差,未来同步反复冲突时以本登记为准。

- [ ] **Step 2: 消 M9-A fallout**

取出 Task 8 Step 5 落的 `typecheck` 失败清单,逐条确认已由补丁层消除;消不掉的写明原因并经裁定转移(记录进合并记录文档)。

- [ ] **Step 3: 全量闸门**

```bash
corepack yarn install --immutable
corepack yarn typecheck
corepack yarn test
corepack yarn check
```

Expected: 全绿。记录命令原文 + 退出码 + 关键输出。21 补丁在处置清单逐行销号(重打完成+证据 / 裁定替换+记录)。

- [ ] **Step 4: Commit**

```bash
git add AGENTS.md docs/evidence/
git commit -m "docs(agents): register #12/#17 as permanent fork diffs; close M9-B fallout"
```

在 issue #5 评论验收证据。

---

## 阶段 M9-C:验证与收口(跟踪 issue #6)

### Task 13: 无头验证链

- [ ] **Step 1: 四条命令全绿并留证据**

```bash
cd ../HuaAnWork-Desktop-sync-m9
corepack yarn install --immutable
corepack yarn check
corepack yarn typecheck
corepack yarn test
```

Expected: 全绿;每条的命令原文 + 退出码 + 关键输出记入收口记录。`verify:aa` 并发竞争是既有 flake(各工作区单跑通过);若撞上,单跑复验并在记录中注明,不改测试。

### Task 14: 真机冒烟四项

**Files:**
- Create: `docs/huaanwork-m9-human-verification-<date>.md`(本任务先开文档,Task 15 继续写)

- [ ] **Step 1: 登录凭据优先级反转(stored > env)**

按 M4 基线文档(`docs/huaanwork-m4-human-verification-2026-10-07.md`)对应条目重跑;结论 + 证据落新文档。

- [ ] **Step 2: 市场重复安装 → `already-installed` 报错语义**

同上;确认语义是改后的 `already-installed` 而非旧行为。

- [ ] **Step 3: 迁移幂等 × rc.1 persistence 新增 7 项(逐条销号)**

`2026-09-13-working-directory`、`2026-09-19-external-subagent-catalog`、`2026-09-30-job-session-lifecycle`、`2026-10-05-ptc-operation-metadata`、`2026-10-05-working-directory-attribution`、`2026-10-07-title-reasoning-effort`、`2026-10-13-user-rpc-principal`——逐条确认迁移幂等重跑跳过已有项、不破坏新格式;每条一行结论 + 证据。

- [ ] **Step 4: `verify-profile-boot.mjs` 断言与 guardrails 锁**

```bash
corepack yarn workspace dsh-plugin-huaanwork run verify:profile 2>&1 | tail -20
```

键名是 `verify:profile`(`dsh-plugin-huaanwork/package.json` 的 scripts;它执行 `scripts/verify-profile-boot.mjs`)。没有 `verify:profile-boot` 这个脚本键。Expected: advanced Web 图断言、hmr 锁等既有断言全过。

### Task 15: 构建新制品 + A1–A19 重跑

- [ ] **Step 1: 构建 macOS 制品**

```bash
cd ../HuaAnWork-Desktop-sync-m9
corepack yarn dist:mac:huaanwork
```

该命令先跑 `market:prepare`。**若 dshmarket 补丁仍打不上**(latest 1.66.32/1.66.35 均实测 hunk #7 FAILED):`market:prepare` 会还原 manifest 与 lockfile 后失败,确认 `git status` 无市场文件残留,然后跳过它手动接剩余链:

```bash
corepack yarn aa:prepare-release && node dsh-plugin-huaanwork/scripts/huaanwork-verify-provisioning.mjs && corepack yarn workspace dsh-community-market build && corepack yarn workspace dsh-plugin-huaanwork dist:mac
```

不提交市场版本变动,此失败不算 M9 的红(已在 Out of Scope 裁定)。

- [ ] **Step 2: 安装新制品,A1–A19 全项重跑**

2026-10-07 旧记录(17 通过、A10 不通过、A19 负例通过)**全部作废**。按 M4 基线文档逐项重跑(人机混合),每项记「通过/不通过/阻塞 + 证据」落 `docs/huaanwork-m9-human-verification-<date>.md`。

- [ ] **Step 3: A10 单独裁决**

托盘图标渲染:A10 仍不通过时单独决定能否发,结论写入 `AGENTS.md` 债表托盘行。R-M9-4:全程未先修 A10——收口记录里写遵守声明。

### Task 16: 推送 + CI 对账 + 收口

- [ ] **Step 1: 推送(参照 M8 Phase 6 先例,无 force)**

```bash
cd ../HuaAnWork-Desktop-sync-m9
git push origin sync/upstream-2.1.x
# 开 PR 或按仓库惯例合入 master;子模组 pin 提交已在链中,不单独推子模组
```

- [ ] **Step 2: CI 逐格对账**

合并后 master 的 CI run 逐格记录(任务名 + 结论),落 `docs/evidence/2026-10-m9-ci-reconciliation.md`(参照 `2026-10-m8-ci-reconciliation.md`);有红格先记录初态,再追修复 PR,不以「后续会修」跳过登记。`git merge-base --is-ancestor <合并后SHA> origin/master` 验证推送生效。

- [ ] **Step 3: 债表收口**

`AGENTS.md` 债表 M9 行状态推进为收口(或「除 A10 外挂起」附裁决);M9-A/B/C 三跟踪壳(#4/#5/#6)与 Epic 本体(#3)评论证据并关闭。

- [ ] **Step 4: 清理 worktree**

```bash
cd /Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop
git worktree remove ../HuaAnWork-Desktop-sync-m9
```

(确认全部提交已进 `origin/master` 后再删。)

---

## Self-Review 记录

- **Spec 覆盖**:Epic 的 M9-A 步骤①–⑧ → Task 1–8;M9-B(顺序、陷阱、验收)→ Task 9–12;M9-C 步骤①–⑥ → Task 13–16;DoD 1–10 逐条映射到各 Task 验收步(DoD 1→Task 2/16,2→Task 3,3→Task 4/8,4→Task 8,5→Task 5,6→Task 11/12,7→Task 13,8→Task 12,9→Task 15,10→Task 15 Step 3)。
- **占位符扫描**:无 TBD/TODO;冲突消解这类无法预写代码的步骤给出了裁定规则与取舍清单,非「适当处理」式占位。
- **一致性**:补丁命名 `*@0.2.1-rc.1.patch`、恢复脚本、`--write` 顺序(beta→huaanwork)、marketPeerRange 三支行在 Task 7/8/9/10/11 间一致;行号全部标注「合并前 as-of,按包名/符号定位」。
