# M9 上游同步:钉 dsh-v0.2.1-rc.1、vendor runtime 刷新与 21 补丁重做(Epic)

> GitHub issue:[kawaiininja/HuaAnWork-Desktop#3](https://github.com/kawaiininja/HuaAnWork-Desktop/issues/3)
> 跟踪壳 issue:#4(M9-A)、#5(M9-B)、#6(M9-C)——仅作逐卡跟踪与 /ship 自动 Closes 用,**文档单一真相源是本文**,三卡独有内容已并入「阶段明细」三节
> 状态:2026-10-17 已确认草稿(/spec Phase 4);外部质量门 codex 不可用,建议 GLM 复审;2026-10-17 文档结构裁定:4 文档并为 1 份(方案 B)
> 复审:2026-10-17 GLM 背靠背复审**有条件通过**(评审落 `2026-10-17-m9-upstream-sync-epic-review.md`),P1-1/2/3(A3 cordis 家族目标版本与范围)、P2-1/2(DoD 3 口径、Context 数字时效)、P3-1…4 修订已并入本文;评审中 P3-2 的「verify-official-bundle-catalog 未接线进 CI」一条经复核失准(已接线进 run-gates 门禁链),采纳时已订正
> 修订:2026-10-17 补三处执行口径,未再送 GLM。① Next 与 beta/huaanwork 共用 `@npm:0.2.1-alpha.1` 这套解析:两次 `--write` 之后放回整段 alpha.1 resolution,保留 `vendor/dsh-runtime/0.2.1-alpha.1/` 和 21 个 `*@0.2.1-alpha.1.patch`,market 的 cordis / DSH / schemastery peer 继续盖住 alpha.1。② 合并提交带上的子模组第一跳是上游 pin `1517a4dbca`(alpha.5);单独 pin 提交只做 `1517a4dbca` → `1600d8a1e14`。③ `yarn.lock` 与根 `package.json` 按 `docs/upstream-sync.md` §5 重放;出包时 `market:prepare` 若打不上最新 dshmarket,用锁文件里已安装的版本,不把刷新失败算进 M9。
> plan-review 修订(2026-10-17):GLM 对照本 Epic 复核实施计划,发现**合并 theirs-wins 会静默推进 beta/next/market 的 dsh/cordis/schemastery 依赖行、击穿「next 冻结 alpha.1」**(P1:实测 next 162 个 lane 值被推进、driver 行被删、上游新增 17 个 lane 依赖;market 整文件零 fork 改动被全量推进)——修法已落 plan(Task 2 Step 5 恢复 next 冻结通道;Task 4/5/8 改前值与检查命令订正),本文 Files Reference 已同步;详见 `docs/superpowers/plans/2026-10-17-m9-upstream-sync-plan-review.md`

## Context

M8(2026-10-10 收口)后 upstream(anywhere-labs/dsh-desktop)又推进 **116 提交**(75 非合并;As-Of 2026-10-17 落笔,实测当日已前移至 119/77,tip `44084bdae0` —— M9-A 开工时以实际 tip 重述,速率 ≈13/天);子模组 `deepseek-harness` 从当前 pin 的 alpha.1 到 rc.1 跨越 4 个 alpha(**1650 提交**;1646 是到 alpha.5 的口径)。`patches/` 下 21 个 Desktop 兼容补丁全部钉死 `@0.2.1-alpha.1`,升级后 `scripts/sync-vendored-runtime.mjs` **静默回落为无补丁解析**(check 模式亦不报错),整个 Desktop compatibility patch 层会无声丢失。M9 已于 2026-10-17 立项,四项裁定 R-M9-1…R-M9-4 落 `AGENTS.md` 债表「上游新一轮落后」行。

受影响方:内网 HuaAnWork 桌面用户(运行时行为与补丁层能力)+ fork 维护团队(窗口越大合并越贵)。

## Current State(2026-10-17 核实)

| 项 | 现状 | 证据 |
|---|---|---|
| 子模组 pin | `5badb15009`(dsh-v0.2.1-alpha.1) | `git submodule status` |
| vendored runtime | `vendor/dsh-runtime/0.2.1-alpha.1/`,321 包 | manifest |
| 补丁 | `patches/` 21 个 `*@0.2.1-alpha.1.patch` | `docs/evidence/2026-10-17-runtime-patches-alpha5-disposition.md` |
| driver 行 | desktop `package.json:278`(0.2.0-rc.2)、beta `:279`、huaanwork `:329`、next `:164`(0.2.1-alpha.1) | grep 实测 |
| cordis 钉版 | `4.0.5-alpha.1` 系,公网 npm 解析,不受 vendored runtime 约束 | 四包 package.json |
| outer repo 落后 | merge-base `ca52ce2cd9`,落后 116 提交(75 非合并) | `git rev-list --left-right --count` |
| rc.1 目标 | `1600d8a1e14` = alpha.5 + 4 提交/355 文件纯版本号行 | tag 实测 |

## Proposed Change(R-M9-1 范围)

在独立 worktree 上:合并 `upstream/master` → fork;子模组 pin → `dsh-v0.2.1-rc.1`(合并提交只带到上游现 pin alpha.5 `1517a4dbca`,**再单独一个提交**到 rc.1);beta/huaanwork vendor runtime 刷新,同时留下 Next 仍在使用的 alpha.1 vendor、resolution 与补丁文件;A1 删行(R-M9-2);cordis 家族与 schemastery 外层钉版升 **rc.1 稳定系**(cordis 4.0.5 / group 1.0.5 / include 1.0.10 / loader 1.0.6 / timer 1.1.7 / schemastery 3.18.5——rc.1 vendor 发布提交 `d9c04d6cc6` 已把全家族从 alpha.5 的 `-alpha.2` 系转入稳定系);21 补丁按处置清单重做成 `*@0.2.1-rc.1.patch`,alpha.1 那 21 个文件不删;#12(optionalBundles)/#17(sandbox-windows-acl)登记为「与上游明示取向相左」的永久 fork 差。

## Out of Scope

- stable 通道:钉 0.2.0-rc.2,driver 行与 vendor 均不动
- `dsh-desktop-next`:本轮不升 runtime,`package.json` 的依赖字符串与 driver 行保留。它没有单独的 runtime 通道,安装靠根 resolutions 里的 `@npm:0.2.1-alpha.1`、目录 `vendor/dsh-runtime/0.2.1-alpha.1/` 和现有 `*@0.2.1-alpha.1.patch`。这三样在 M9-A 步骤⑦之后按原样留住
- A10 托盘图标修复:独立缺陷行(R-M9-4:不挡开工、挡收口)
- A20–A28 环境阻塞项(凭据/Windows 主机/旧树/7 天等待/内网机)
- Windows 制品校验(已有独立债行)
- dshmarket 版本升级。出包命令会先跑 `market:prepare`(`scripts/prepare-dsh-market.mjs` 追 npm `latest`,并套 `.yarn/patches/dshmarket-desktop.patch`;打不上就还原 manifest 与 lockfile 后失败)。2026-10-17 实测 latest `1.66.32` 在 hunk #7 打不上(同日稍后 latest 已移至 `1.66.35`,hunk #7 在默认 fuzz 下仍 FAILED——打不上这一事实持续成立,版本号为 as-of)。M9-C 出包前若仍然打不上,用锁文件里已经装上的 dshmarket 构建,不提交市场版本变动,这次失败不算 M9 的红

## 阶段划分

| 阶段 | 跟踪 issue | 内容 | 人日 | 依赖 |
|---|---|---|---|---|
| M9-A | #4 | 桌面侧合并 + vendor runtime 刷新(含 A1 删行 / cordis 升版) | 3–5 | — |
| M9-B | #5 | 21 个兼容补丁 rc.1 重做 | 7–9 | A |
| M9-C | #6 | 验证链 + 新制品 A1–A19 重跑与收口 | 3–5 | B |

```
M9-A ──> M9-B ──> M9-C
```

顺序理由:补丁打在 vendor 构建产物上,A 不完成 B 无靶子;C 的制品必须含 B 的补丁层,否则 A1–A19 白跑。

## 阶段明细:M9-A(合并 + vendor 刷新,跟踪 #4)

**预期冲突点**:① sidebar-browser 双份修复——fork PR #1(`verify-sidebar-browser.mjs` 补 no-op `attachInput`)vs 上游 `75ad518423`,**同一根因同一写法**(两侧均为 `guests.bind(window, () => () => {})`),上游仅多一个 `uncaughtException` 兜底;裁定保留上游写法即涵盖 fork 侧,预期为平凡冲突;② CI 矩阵 hunk(fork 三格矩阵含 `dsh-plugin-huaanwork`,历史口径 6 类 × 28 文件,本轮还会涨);③ `yarn.lock` 与根 `package.json` 不逐 hunk 三方合并。按 `docs/upstream-sync.md` §5,以上游对应文件为基底,重放 fork 的 resolution、补丁路径和通道钉版,再重装生成锁文件;④ 永久 override 保留 fork 侧,文件以同文 §6 为准:`scripts/verify-desktop-variants.mjs`、`scripts/expected-root-gate-scripts.json`、`scripts/market-manifest-byte-budget.json`、`dsh-plugin-desktop/tests/package.spec.ts`、`dsh-plugin-desktop-beta/tests/package.spec.ts`、`dsh-plugin-huaanwork/tests/package.spec.ts`、`market-server/src/manifest-prepare.ts`、`dsh-plugin-huaanwork/tests/huaanwork-host/market-verify.spec.ts`。下文 Files Reference 里的行号是合并前 as-of(2026-10-17),合并后按包名定位,不按行号改。

**步骤**:① 建独立 worktree(参照 M8 `HuaAnWork-Desktop-sync` 先例)→ ② 合并 `upstream/master`。源码冲突逐 hunk 记录(文件、两侧写法、取舍、理由);`yarn.lock` 与根 `package.json` 走上面「预期冲突点」③的重放,不进逐 hunk。2026-10-17 `git ls-tree upstream/master deepseek-harness` 是 `1517a4dbca`(dsh-v0.2.1-alpha.5)。这一跳留在合并提交里 → ③ 再单独一个提交把 gitlink 从 `1517a4dbca` 改到 `1600d8a1e14`(rc.1)。该提交 `git show --stat` 只有 gitlink 一行。提交后 `git submodule update` 把工作区子模组检出到 rc.1;步骤⑥必须用这次检出,不能用合并提交里的 alpha.5 → ④ A1:删 beta、huaanwork 两行 driver 依赖(desktop/next 不动)→ ⑤ A3:cordis 家族 + schemastery 外层钉版升 **rc.1 稳定系**——**升版范围 = beta + huaanwork 的 dependencies 钉版 + market 的 cordis devDep;next 的 cordis 五成员保持 `4.0.5-alpha.1` 系(运行时 dependencies,与冻结的 `dsh@0.2.1-alpha.1` 强耦合),desktop 保持 4.0.4 系不动**。具体:cordis `4.0.5`、group `1.0.5`、include `1.0.10`、loader `1.0.6`、timer `1.1.7`(rc.1 vendor 实测值,发布提交 `d9c04d6cc6`);schemastery 的 beta/huaanwork devDep **caret 字符串保持** `^3.18.5-alpha.1`,只把 lockfile 重解到 `3.18.5` 稳定版(该 caret 容纳稳定版;lockfile 现解析在 `-alpha.1` 实例。desktop 的 `^3.18.4` 已覆盖 3.18.5。Next、market 的 schemastery devDep 与 beta/huaanwork 是同一个 caret,yarn 会把这个 range 解成一个实例;重解到 `3.18.5` 时 Next 的安装实例可以跟着变成 `3.18.5`,声明行仍是 `^3.18.5-alpha.1`,这不算升 Next 的钉版)。`dsh-community-market` 的 cordis devDep → `4.0.5`。cordis peer 从 `"4.0.4 || 4.0.5-alpha.1"` 改为 `"4.0.4 || 4.0.5-alpha.1 || 4.0.5"`:前两支分别是 stable 与 Next 的现钉,第三支是 beta/huaanwork 的新钉;精确版本 `4.0.5-alpha.1` 不等于 `4.0.5`,少写一支就会有一个宿主不满足 peer。schemastery peer **保持** `"^3.18.4 || ^3.18.5-alpha.1"`:`^3.18.4` 已包含 `3.18.5` 稳定版,`^3.18.5` 不含 prerelease,删掉 `-alpha.1` 这一支后 Next 当前的 `3.18.5-alpha.1` 不再满足 peer。market 自己的 schemastery devDep 现为 `^3.18.5-alpha.1`(`devDependencies`,不是 peer);`sync-vendored-runtime` 不改它(`@deepseek-ai/schemastery` 不是 `@deepseek-ai/dsh` / `dsh-`),caret 保持,不要改成不含 prerelease 的区间。fork 侧有钉版的家族成员仅 cordis/group/include/loader/timer(+schemastery);cosmokit、hmr、logger-console 在 fork 无钉版,无动作。**警示**:npm 上 `4.0.5-alpha.2` 与 `4.0.5` 并存,钉错版本安装不报错、双 cordis 单例会掩盖到运行时——升版后必须跑 `yarn why` 验证 beta/huaanwork 侧各一份 → ⑥ `corepack yarn upstream:prepare-runtime` 验证上游侧可打包(rc.1 起的 on-demand bundle 校验载体:`release:pack` 经 `scripts/release/families.ts` 将 ON_DEMAND_BUNDLES 纳入发布序并校验 peer 边,提交 `8ed0b530ed`;`verify-official-bundle-catalog` 在子模组 `run-gates` 门禁链里、不在 build/pack)→ ⑦ 先把 `upstream.json` 里 beta 与 huaanwork 的 `commit` 设为 `1600d8a1e14`,`sourceVersion` 与 `runtimePackageVersion` 设为 `0.2.1-rc.1`;stable 通道不动。`--write` 用文件里的 `sourceVersion` 决定 vendor 目录和 resolution 版本,不会自己把 alpha.1 改成 rc.1;`--check` 还要求 manifest 的 `commit` 等于该通道的 `commit`。接着改 `scripts/sync-vendored-runtime.mjs` 的 `marketPeerRange`,再跑 `--write`。改法:在 `['stable', 'beta']` 的 sourceVersion 后面再拼 Next 冻结的 `0.2.1-alpha.1`,Set 去重,顺序固定为 stable、beta、这个冻结版本。`--check` 对 market 的 dsh peer 做整串相等(`range !== expected` 即失败),所以这串必须由脚本写出来,不能写完再手改。Next 离开 alpha.1 时删掉第三支。然后 `sync-vendored-runtime --write`,先 `--channel beta` 再 `--channel huaanwork`。脚本把本通道的 dsh resolution 滤成「非 dsh,或版本属于其他通道的 sourceVersion」。两个通道的 sourceVersion 都写成 rc.1 之后,alpha.1 不再属于任何通道,根 `package.json` 里 `@npm:0.2.1-alpha.1` 与 `@npm:^0.2.1-alpha.1` 的整段 dsh resolution 会被删掉,不只是 driver 那两行。脚本不删除 `vendor/dsh-runtime/0.2.1-alpha.1/`,也不改 `dsh-desktop-next/package.json`。`--write --channel beta` 把 market 里每个在新清单中的 dsh peer 写成 `"0.2.0-rc.2 || 0.2.1-rc.1 || 0.2.1-alpha.1"`;huaanwork 这一次不写 market。写完后、⑧之前只恢复一件:把写之前的整段 alpha.1 resolution 放回根 `package.json`。`--check` 只把「选择子以本通道版本结尾」的 resolution 当作本通道项,多留的 alpha.1 resolution 不会让三通道变红 → ⑧ `check:vendored-runtime` 三通道绿。**预期中间态**:此时还没有 `*@0.2.1-rc.1.patch`,所以 beta/huaanwork 的 rc.1 resolution 是无补丁 tarball,这是设计内的,rc.1 补丁在 M9-B。alpha.1 的 21 个补丁文件还在,放回的 alpha.1 resolution 仍指向它们。

**验收**:合并后的 `upstream/master` tip 是 `origin/master` 的祖先(`git merge-base --is-ancestor`;tip 取 M9-A 开工时的 `upstream/master`,本文 as-of 为 `44084bdae0`)。冲突消解记录落 `docs/evidence/2026-10-m9-merge-decisions.md`。rc.1 那一个 pin 提交 `git show --stat` 只含 gitlink 一行,父提交里的 gitlink 是 `1517a4dbca`。beta/huaanwork 的 driver 依赖行 `grep -c` = 0,desktop 与 next 的 driver 行还在(四个 `package.json` 里该字符串合计 2)。根 resolutions 同时含 `@npm:0.2.0-rc.2`、`@npm:0.2.1-alpha.1`、`@npm:0.2.1-rc.1` 三套 dsh 选择子。market 的 dsh peer 为 `"0.2.0-rc.2 || 0.2.1-rc.1 || 0.2.1-alpha.1"`,cordis peer 为 `"4.0.4 || 4.0.5-alpha.1 || 4.0.5"`,schemastery peer 仍为 `"^3.18.4 || ^3.18.5-alpha.1"`。`yarn why` 在 beta/huaanwork 侧对 cordis 与 schemastery 各一份;workspace 根上 desktop 的 4.0.4 与 next 的 `4.0.5-alpha.1` 继续共存,不算失败。`check:vendored-runtime` 三通道绿。`vendor/dsh-runtime/0.2.1-alpha.1/` 仍在。rc.1 补丁尚未存在时的 `typecheck` 失败清单落记录(不挡本卡,交 M9-B 消)。

**回滚**:worktree 整支丢弃;已进 master 按提交逆序 revert(pin 提交独立)。

## 阶段明细:M9-B(21 补丁重做,跟踪 #5)

**权威依据**:`docs/evidence/2026-10-17-runtime-patches-alpha5-disposition.md`(GLM 三轮评审订正后版本)。21/21 需重做、0 吸收、0 放弃;难度 16 小/3 中/2 中-大。rc.1 = alpha.5 + 版本号行,清单结论成立,动手时以 rc.1 构建产物为最终对照。

**顺序**:先 2 个中-大(plugin-manager、settings-account)→ dsh 核心 + hmr + ptc → 16 小批量过。每个补丁:在 rc.1 vendor 产物上重打 → 核对清单「备注」栏陷阱 → 另存为 `*@0.2.1-rc.1.patch`。不删除 `*@0.2.1-alpha.1.patch`:放回的 alpha.1 resolution 仍引用它们。也不要动 `*@0.2.0-rc.2.patch` 以及更早代的补丁文件。每批跑 `check:vendored-runtime` + 受影响包测试。

**关键陷阱(逐条必须核对)**:dsh-hmr 补 `hasEsmCache` 空值守卫 + 类型放宽(`mainJob()` 前置解引用);dsh-ptc-runtime-node `index.ts:224-227` 与 `persistent.ts:192-196` **两现场同补**;dsh 核心 `ProfileContext` 全 readonly,新字段写 `readonly readPatches?`;settings-shell 以 `order: 40` 为基底;host-directory-picker-browse 保留既有 abort 重抛;plugin-manager 隐藏集合挂上游新 more/official 过滤链;settings-account 锚点全搬迁、ctx 回退需改签名。**R-M9-3(已裁定)**:directory-picker-browse(#4)继续 bridge;#10 browse host 补丁保留。

**验收**:`*@0.2.1-rc.1.patch` = 21,且 `*@0.2.1-alpha.1.patch` 仍 = 21。sync `--check` 绿。根 `package.json` 里,选择子以 `@npm:0.2.1-rc.1` 或 `@npm:^0.2.1-rc.1` 结尾的 resolution 中,`./patches/*@0.2.1-rc.1.patch` 的唯一路径数 = 21(现行形态为每补丁 2 行条目 = 42 行);选择子以 `@npm:0.2.1-alpha.1` 或 `@npm:^0.2.1-alpha.1` 结尾的 resolution 中,`./patches/*@0.2.1-alpha.1.patch` 的唯一路径数仍 = 21。两套都按选择子结尾计数,不按行号。sync 脚本没有「逐条列出」机制,这两组计数就是「rc.1 没有静默跳过、alpha.1 也没有被拆掉」的判据。清单 21 行逐条销号(重打完成+证据 / 裁定替换+记录);两个中-大各附「上游新结构 → 补丁映射」说明落 `docs/evidence/`;hmr 守卫与 ptc 双现场 grep 证据;#12/#17 永久 fork 差登记落盘;`typecheck`/`test` 转绿(M9-A fallout 清单逐条消除或经裁定转移)。

**回滚**:补丁粒度——删单个 rc.1 patch 后须同步恢复该包的两条 rc.1 resolution 为无补丁 tarball 形态(重跑 `sync-vendored-runtime --write` ×2 + alpha.1 段恢复脚本即可一并完成),否则 `check:vendored-runtime` 会因「补丁文件缺失但 resolution 引用 patch:」变红。

## 阶段明细:M9-C(验证与收口,跟踪 #6)

**关键裁定(R-M9-4)**:托盘 A10(macOS 26 模板图零渲染)**不挡开工、挡收口**;仍不通过时单独决定能否发,结论写入债表托盘行。2026-10-07 的 A1–A19 旧记录(17 通过、A10 不通过、A19 负例通过)在制品换过后全部作废,须在新制品上重跑。

**步骤**:① 无头验证链 `install --immutable` → `check` → `typecheck` → `test` → ② 真机冒烟四项:登录凭据优先级反转(stored > env)、市场重复安装改 `already-installed` 报错语义、迁移幂等对 rc.1 persistence 新增 7 项(逐条销号:`2026-09-13-working-directory`、`2026-09-19-external-subagent-catalog`、`2026-09-30-job-session-lifecycle`、`2026-10-05-ptc-operation-metadata`、`2026-10-05-working-directory-attribution`、`2026-10-07-title-reasoning-effort`、`2026-10-13-user-rpc-principal`)、`verify-profile-boot.mjs` 断言与 guardrails 锁 → ③ 构建并安装 macOS 制品,命令是 `dist:mac:huaanwork`。它会先跑 `market:prepare`。若最新 dshmarket 仍套不上 `.yarn/patches/dshmarket-desktop.patch`,按 Out of Scope 用锁文件里已安装的 dshmarket 出包,不提交市场版本变动 → ④ A1–A19 重跑(人机混合),记录落 `docs/huaanwork-m9-human-verification-<date>.md` → ⑤ A10 单独裁决 → ⑥ 推送 + CI 对账(按 M8 Phase 6 先例,落 `docs/evidence/2026-10-m9-ci-reconciliation.md`)。

**验收**:四条无头命令全绿(命令原文 + 退出码 + 关键输出);四项冒烟各有结论 + 证据;A1–A19 记录落盘(通过/不通过/阻塞 + 证据);推送 SHA 与 CI 逐格对账落盘;债表 M9 行推进为收口(或「除 A10 外挂起」附裁决);R-M9-4 遵守声明。

**回滚**:按失败层回退(补丁级 → vendor 级 → 合并级);已推送按提交逆序 revert。

## Definition of Done

1. M9-A 开工时的 `upstream/master` tip 是 `origin/master` 的祖先(`git merge-base --is-ancestor`)。本文 as-of 的 tip 是 `44084bdae0`,`2e7a9a44d9` 只是更早的一次 tip,不作大小比较。冲突消解记录落 `docs/evidence/`
2. 子模组 pin = `1600d8a1e14`。合并提交里的 gitlink 是上游的 `1517a4dbca`;其后单独一个提交只把 gitlink 改到 rc.1,该提交无其他文件
3. 四个插件/应用包的 `package.json` 依赖行中,beta/huaanwork 无 `dsh-subagent-in-process-driver` 行;desktop 与 next 保留(四个文件里该字符串 `grep -c` 合计 = 2,不按行号)。根 resolutions 同时保留 `@npm:0.2.0-rc.2`(stable)、整段 `@npm:0.2.1-alpha.1`(next,含 driver)和 `@npm:0.2.1-rc.1`(beta/huaanwork)
4. `vendor/dsh-runtime/0.2.1-rc.1/` 建立,`vendor/dsh-runtime/0.2.1-alpha.1/` 仍在,`check:vendored-runtime` 绿
5. beta/huaanwork 的 cordis 五成员钉版 = rc.1 稳定系(cordis 4.0.5 / group 1.0.5 / include 1.0.10 / loader 1.0.6 / timer 1.1.7);二者的 schemastery devDep 字符串仍是 `^3.18.5-alpha.1`,lockfile 解析到 `3.18.5`。desktop 保持 4.0.4 系与 `^3.18.4`,next 的声明行保持 `-alpha.1` 系。market 的 cordis devDep = `4.0.5`,cordis peer = `"4.0.4 || 4.0.5-alpha.1 || 4.0.5"`,schemastery peer 仍是 `"^3.18.4 || ^3.18.5-alpha.1"`,dsh peer = `"0.2.0-rc.2 || 0.2.1-rc.1 || 0.2.1-alpha.1"`。`yarn why` 只要求 beta/huaanwork 侧 cordis 与 schemastery 各一份
6. `patches/` 有 21 个 `*@0.2.1-rc.1.patch`(或经裁定替换),并且原来的 21 个 `*@0.2.1-alpha.1.patch` 还在。rc.1 与 alpha.1 两套 resolution 各自的唯一补丁路径数都是 21,sync 对 rc.1 无静默回落
7. `corepack yarn check` / `typecheck` / `test` 全绿
8. #12/#17 永久 fork 差登记落盘
9. 新制品 A1–A19 重跑记录落盘(本机、人机混合);A10 单独裁决,结论写入债表托盘行
10. R-M9-4 遵守:全程未先修 A10

## Rules for the implementing agent

1. Acceptance criteria are the `protects / fails_when / no_claim` profile of each test: the observable it protects, the wrong result it rejects, and what green does not prove. Never "make the tests pass".
2. Real code and real tests land in the same change; a placeholder, a stub assertion or a test deferred to a follow-up is not done.
3. Any change to a test, validator, CI step, timeout, tolerance, threshold, snapshot or suppression pragma is reported on its own line in your summary with its justification, before any other result.
4. A reported command names the command and its observed result (exit status, counts, the failing line); a command you did not run is not reported, and stderr is never silenced in a command you cite.
5. Your report is a claim until the parent re-executes it: say what you verified, what you reused, and what you could not check.

## Rollback Plan

worktree 整支丢弃;pin 提交单独 revert。vendor/ 与 patches/ 的变更不进 master 前均可放弃;进 master 后按提交逆序 revert(pin 提交独立,回滚干净)。

## Effort Estimate

13–19 人日(A 3–5 + B 7–9 + C 3–5),缓冲至 M8 级 15–25。

## Files Reference

| File | Change |
|------|--------|
| `upstream.json` | beta/huaanwork 的 `commit` → `1600d8a1e14`,`sourceVersion` 与 `runtimePackageVersion` → `0.2.1-rc.1`。stable 不动。`--write` 不改 `sourceVersion` |
| `deepseek-harness/`(gitlink) | 合并提交 `5badb15009` → `1517a4dbca`;其后单独提交 `1517a4dbca` → `1600d8a1e14` |
| `vendor/dsh-runtime/0.2.1-rc.1/` | 新建(sync 脚本产出) |
| `vendor/dsh-runtime/0.2.1-alpha.1/` | 保留。脚本不删它,人也不删 |
| `patches/` | 新增 21 个 `*@0.2.1-rc.1.patch`。现有 21 个 `*@0.2.1-alpha.1.patch` 以及 `0.2.0-rc.2` 和更早代的补丁文件不动 |
| `dsh-plugin-desktop-beta/package.json`、`dsh-plugin-huaanwork/package.json` 的 `@deepseek-ai/dsh-subagent-in-process-driver` 依赖 | 删这两处。desktop 与 next 的同名行不动。合并前行号 beta `:279`、huaanwork `:329`、desktop `:278`、next `:164`,合并后按包名找 |
| beta、huaanwork 的 cordis 五成员 dependencies | `4.0.5-alpha.1` 系 → rc.1 稳定系(`4.0.5` / `1.0.5` / `1.0.10` / `1.0.6` / `1.1.7`)。合并前 beta `:152-156`、huaanwork `:207-211` |
| beta、huaanwork 的 `@deepseek-ai/schemastery` devDep | caret 保持 `^3.18.5-alpha.1`,lockfile 重解到 `3.18.5`。合并前 beta `:311`、huaanwork `:361` |
| `scripts/sync-vendored-runtime.mjs` 的 `marketPeerRange` | 在 stable、beta 的 sourceVersion 之后拼上 `0.2.1-alpha.1`,再跑 `--write`。check 按整串相等,不能写完再手改 peer |
| `dsh-community-market/package.json` | cordis devDep → `4.0.5`(合并前 `:215`)。cordis peer → `"4.0.4 \|\| 4.0.5-alpha.1 \|\| 4.0.5"`(合并前 `:88`)。schemastery peer 保持 `"^3.18.4 \|\| ^3.18.5-alpha.1"`(合并前 `:131`)。schemastery devDep 保持 `^3.18.5-alpha.1`。dsh peer 由改过的 `marketPeerRange` 写成 `"0.2.0-rc.2 \|\| 0.2.1-rc.1 \|\| 0.2.1-alpha.1"` |
| `dsh-desktop-next/package.json` | 依赖字符串**合并后显式恢复为 fork 侧值**(合并 theirs-wins 会静默推进到上游 alpha.5/-alpha.2、删 driver 行、新增 17 个 lane 依赖——plan Task 2 Step 5 执行恢复,2026-10-17 plan-review P1) |
| 根 `package.json` resolutions | `--write` 会删掉整段 `@npm:0.2.1-alpha.1`。步骤⑦之后整段放回。另有 `@npm:0.2.0-rc.2` 与新建的 `@npm:0.2.1-rc.1`。合并前 driver 的 alpha.1 两条在 `:920/:921`,验收不使用这两个行号 |
| `AGENTS.md` 债表 | #12/#17 永久 fork 差登记;M9 行状态推进 |

## Related

- GLM 复审:`docs/superpowers/specs/2026-10-17-m9-upstream-sync-epic-review.md`(有条件通过,P1/P2/P3 修订已并入本文)
- 处置清单:`docs/evidence/2026-10-17-runtime-patches-alpha5-disposition.md`(GLM 三轮评审订正后版本)
- M8 先例:`docs/evidence/2026-10-m8-push.md`、`docs/evidence/2026-10-m8-ci-reconciliation.md`、`docs/evidence/2026-10-m8-merge-decisions.md`
- 裁定原文:`AGENTS.md` 债表「上游新一轮落后」行 R-M9-1…R-M9-4
- M4 核对基线:`docs/huaanwork-m4-human-verification-2026-10-07.md`
