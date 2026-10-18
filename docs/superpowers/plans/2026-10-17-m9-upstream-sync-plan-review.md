# 《M9 上游同步实施计划》plan-review 评审意见

- **评审对象**:`docs/superpowers/plans/2026-10-17-m9-upstream-sync.md`(对照 Spec:`docs/superpowers/specs/2026-10-17-m9-upstream-sync-epic.md`[含 Grok 三口径]与处置清单 `docs/evidence/2026-10-17-runtime-patches-alpha5-disposition.md`)
- **评审日期**:2026-10-17
- **评审方式**:对照复核——计划的可验证断言(642 行计数、sync 脚本行为、dist 链、DoD 映射、marketPeerRange 推导)逐条机械验证;对「合并对依赖行的影响」做 base(`ca52ce2cd9`)/fork/upstream 三方实测;对「320 tgz」假设核对窗口内闭包净增
- **评审结论**:**有条件通过 → P1 修法已同日落盘本计划**(Task 2 新增 Step 5 + Task 4/5/8 订正 + Epic Files Reference 同步);P2-1 随 P1 一并订正;**P2-2/3/4 与 P3×3 已由修订方(Claude)于同日采纳落盘并经本文件复核确认**(见 §三/§四处置列与 §六)
- **自我订正**:本 P1 同时暴露 Epic review(`2026-10-17-m9-upstream-sync-epic-review.md`)§七 对 Grok 口径①复核的漏察——我当时验证了 sync 脚本行为与 market 依赖链,但未验证**合并本身**对 next `package.json` 的 theirs-wins 效果,「依赖字符串不动」的假设未经核实即被认可。教训:复核「保留/不动」类设计时,必须核对合并三方(base/fork/upstream)在该文件上的实际改动状态,而非只验证下游脚本行为。

---

## 一、事实核查(计划关键断言逐条)

| # | 计划断言 | 核查结果 | 出处 |
|---|---------|---------|------|
| 1 | 根 resolutions alpha.1 段 = 642 行(321 包 × 2,含 driver 2 行) | ✅ 实测精确 642 | `grep -c '@npm:\^*0\.2\.1-alpha\.1"' package.json` |
| 2 | 恢复脚本幂等;「每次 `--write` 都会再删 alpha.1 段」 | ✅ 读码核实(filter `:154-155` 只保非 dsh 与其他通道;check 对非本通道段不可见) | `scripts/sync-vendored-runtime.mjs` |
| 3 | `--write` 不改 `sourceVersion`;commit 必须先指对(check 校验 manifest.commit) | ✅ 读码核实(`:149-151` 只写 runtimePackageVersion/runtimeSource;`:180-181`) | 同上 |
| 4 | marketPeerRange 三支改法、Set 插入序 = `"0.2.0-rc.2 \|\| 0.2.1-rc.1 \|\| 0.2.1-alpha.1"`、check 整串相等不能手改 | ✅ 读码核实(`:66`/`:67`/`:227`) | 同上 |
| 5 | 仅 beta 这次 `--write` 写 market、huaanwork 通道跳过 | ✅(`pluginPaths` 的 `channel === 'beta'` 条件) | 同上 `:61` |
| 6 | `dist:mac:huaanwork` 先跑 `market:prepare`;兜底链尾段 | ✅ 与根 package.json 脚本定义**逐字吻合** | `package.json` scripts |
| 7 | 处置清单 §5 A3 的「-alpha.2 系」是过期口径,以 Epic 为准 | ✅ 计划第 12 行的标注正确且必要(跨文档失同步的妥善处理) | 处置清单 §5 |
| 8 | Self-Review 的 DoD 1–10 → Task 映射 | ✅ 逐条属实 | 计划 §Self-Review |
| 9 | desktop(stable)钉版三方一致,合并不动 stable 通道 | ✅ 实测 base/fork/upstream 均 0.2.0-rc.2 | 三方 `git show` |
| 10 | `verify:aa` 并发 flake 处置 | ✅ 与债表记载一致 | AGENTS.md 债表 |
| 11 | Task 6 期望 320 个 tgz(321−1) | ❌ **几乎必然偏低**:窗口内子模组净增约 20 个包目录(api/remote-access、boot/plugin-market、client/ui-plugin-market、client/ui-secret-mask 及一批 experimental bundle),上游 beta 声明的 dsh 依赖 154→171(+17)⇒ rc.1 vendored 闭包 > 320(P2-3) | 子模组 `git ls-tree` 对比 |
| 12 | Task 2 Step 2 重放「三套 dsh vendor 选择子」 | ❌ 重放时刻只有两套(stable + alpha.1),第三套是 Task 8 `--write` 产物(P2-4) | 计划文本 |
| 13 | Task 8 Step 5 `grep '"@deepseek-ai/dsh@npm' dsh-community-market/package.json` 验 market peer | ❌ **匹配零行**——`@npm:` 选择子只存在于根 resolutions,market 的 package.json 里是 `"@deepseek-ai/dsh-agent": "0.2.0-rc.2 \|\| …"` 形态(P2-1,已随 P1 订正) | market package.json 实测 |

---

## 二、P1(必须修订——修法已落盘)

### P1-1 合并 theirs-wins 静默击穿「next 冻结 alpha.1」;计划缺失恢复步骤

**机制(三方实测)**:fork 自 merge-base(`ca52ce2cd9`)对 beta/next/market 的 dsh/cordis/schemastery/driver 依赖行**零改动**(fork 侧仅改了 bridge tgz 路径、dshmarket 版本、next 的两个 script 行),而上游已改 ⇒ 三方合并 theirs-wins **静默采纳上游值,无冲突提示**:

| 依赖行 | base = fork | upstream/master | 合并结果 |
|---|---|---|---|
| beta/next 的 `@deepseek-ai/dsh` 及 dsh-* | 0.2.1-alpha.1 | 0.2.1-alpha.5 | 自动 → alpha.5(公网 npm,无 vendored) |
| beta/next 的 cordis 五成员 | -alpha.1 系 | **-alpha.2 系** | 自动 → -alpha.2 |
| beta/next 的 schemastery | `^3.18.5-alpha.1` | `^3.18.5-alpha.2` | 自动 → -alpha.2 |
| beta/next 的 driver 行 | 存在 | **上游已删** | **自动删除** |
| market 整文件 | fork 零改动 | alpha.5/-alpha.2 形态 | **整文件全量推进** |

**实测数字(next)**:lane 依赖(dependencies 153 dsh 含 driver + 5 cordis + 1 schemastery;devDependencies 3 dsh)中 **162 个值被推进、driver 行被删、上游新增 17 个 lane 依赖**(api-remote-access、client-ui-secret-mask、10 个 experimental bundle、harness-dev-context、skill-office、tool-workspace-dependencies、working-directory——均无 alpha.1 版本)。

**后果链**:
1. DoD 3 / Task 4 Step 2 的「next=1」不可能成立(driver 行被合并删掉);
2. Task 8 恢复的 642 行 alpha.1 段失去服务对象(next 被挪去 alpha.5、huaanwork 被 `--write` 重写到 rc.1)⇒ Grok 口径①的整套保留设计(642 行 + 21 补丁 + vendor 目录 + marketPeerRange 第三支)坍塌;
3. Task 5 的全部「改前值」过期(beta cordis 现为 -alpha.2;market cordis peer 现为 `4.0.4 \|\| 4.0.5-alpha.2`;market schemastery peer 现为 `^3.18.4 \|\| ^3.18.5-alpha.2`——**该形态不盖 next 的 3.18.5-alpha.1**,必须恢复 fork 值);
4. Task 5 Step 3 的 `yarn why` 落在「beta runtime = npm alpha.5」中间态,可能误报两份 cordis;
5. 深层 era-mismatch:恢复 next 依赖后,合并带入的上游 next 源码(alpha.5 时代)对 alpha.1 依赖编译可能失败。

**修法(已落盘本计划)**:
- **Task 2 新增 Step 5「恢复 next 的冻结通道依赖行」**:`git show master:dsh-desktop-next/package.json` 取 pre-merge fork 值 → node 脚本按 lane 前缀(`@deepseek-ai/dsh`/`dsh-`/cordis/cordis-plugin-*/schemastery)恢复 dependencies + devDependencies 两个字段,**严格冻结**(上游新增的 17 个 lane 依赖一并移除——留着会把 next 的树混入 npm alpha.5 传递闭包)→ `corepack yarn install` → 独立提交。Expected:restored 162 / removed 17。era-mismatch 裁定路径入文:若 typecheck 爆出对被移除依赖的引用,裁定「next 源码也回退 fork 侧」或「接受该依赖随上游并同步改 DoD」,不静默放行。
- **Task 4 订正**:beta 的 driver 行已被合并自动移除(theirs-wins),只需手删 huaanwork 的行;next 的 1 来自 Step 5 恢复行。
- **Task 5 订正**:改前值全面更新(beta cordis/schemastery 为 -alpha.2 形态;market 整文件 theirs-wins);market 的 schemastery peer/devDep 由「保持不动」改为「**恢复为 fork 值**」(`^3.18.5-alpha.2` 形态不盖 next);beta 的 schemastery 行恢复 `^3.18.5-alpha.1`(满足 Epic DoD 5 字符串口径);Step 3 的 Expected 加中间态注记、终检挪 Task 8。
- **Task 8 Step 5 订正**:补 `yarn why` 终检;next 计数的出处注明 Step 5;era-mismatch 提示。
- **Epic 同步**:Files Reference 的「`dsh-desktop-next/package.json` 依赖字符串不动」改为「合并后显式恢复为 fork 侧值」;header 增加 plan-review 修订行。

---

## 三、P2(应修订)

| # | 事项 | 处置 |
|---|---|---|
| P2-1 | Task 8 Step 5 的 market peer 检查命令匹配零行(`@npm:` 选择子只在根 resolutions) | **已随 P1 落盘订正**:`grep -c '"0\.2\.0-rc\.2 \|\| 0\.2\.1-rc\.1 \|\| 0\.2\.1-alpha\.1"' dsh-community-market/package.json`,期望 44 |
| P2-2 | 通用重做规程 `diff -ruN a b > patch` 产出非 git 头格式;仓内全部 21 个现有补丁与 dshmarket 补丁均为 `diff --git` 头(yarn patch: 协议在仓内被验证的形态都有 git 头)。`patch -p1 --dry-run` 两种格式都吃 ⇒ 自验会过而 yarn 应用未验证——静默分叉风险 | **已采纳(修订方方案,2026-10-17)**:改**临时 git 仓**(`package/` 内 `git init` + commit 基线 → 编辑 → `git diff > patch`),实测产出 `diff --git a/lib/x.js b/lib/x.js` 与既有补丁同形。~~待采纳:改 `git diff --no-index a b > patch`~~ **本文原建议有误(2026-10-17 订正)**:`--no-index` 经修订方与本文复核双确认产出**双层前缀 `a/a/lib/x.js`**,该命令弃用——本教训与 §五自我订正同款:**建议他人命令前先实测**。配套注记(真实应用验证由每批 `yarn install` 完成)一并落盘,正确解决格式风险。附 nit:规程注释称 `diff -ruN`「路径形态也不是」不准——其 `---`/`+++` 路径恰为单层 `a/`/`b/`,差异在缺 `diff --git` 头(即本条发现的本体);措辞层面,不影响结论 |
| P2-3 | Task 6「期望 320 个 tgz」偏低(闭包净增,见 §一 #11) | **已采纳**:Task 6 改「不设固定预期 + 记录实际值 + driver 0 命中才是有效断言」,并补实测数「子模组包目录 328→349(package.json 计数)」——**复核精确命中**(本文初测 492→507 系被组级 README 等非包两级前缀污染,以 package.json 计数为准) |
| P2-4 | Task 2 Step 2 重放清单「三套选择子」应为两套 | **已采纳**:改「**两套**(stable + 冻结的 alpha.1;rc.1 套是 Task 8 `--write` 的产物,重放时刻尚不存在)」 |

## 四、P3(nit)

1. Task 2 Step 4 的 `git add -A` 会把 Step 3 已写的 merge-decisions 文档卷进合并提交,其后的证据文档独立提交将 nothing-to-commit(建议先提交证据文档或选择性 add);→ **已采纳**:`git add -A -- ':!docs/evidence/2026-10-m9-merge-decisions.md'`(pathspec 排除,语法经复核正确);
2. `install --immutable` 位于可能改依赖行的冲突消解之后、而锁文件在 Step 2 已重放(建议可变 install 放全部消解后、--immutable 作终检);→ **已采纳**:Step 2 明注「可变重装挪到 Step 4」、Step 4 改「可变 install 一次重生 + `--immutable` 终检」;
3. M9-B 回滚「删单个 rc.1 patch 即回退」需同步改该包两条 resolution(承自 Epic 的既有 nit)。→ **已采纳(Epic 侧)**:Epic M9-B 回滚句改为「删单个 rc.1 patch 后须同步恢复该包的两条 rc.1 resolution 为无补丁 tarball 形态(重跑 `--write` ×2 + alpha.1 段恢复脚本即可一并完成),否则 `check:vendored-runtime` 会因补丁缺失而红」——机制经读码复核属实(expectedResolution 的 existsSync 回落逻辑)。

---

## 五、P1 修法落地记录(2026-10-17)

| 落点 | 编辑 |
|---|---|
| plan Global Constraints | alpha.1 通道条目追加「合并陷阱」警告(theirs-wins 机制 + 恢复指引) |
| plan Task 2 | Files/Interfaces 增 next 恢复;Step 4 Expected 增中间态注记(beta/market npm alpha.5 属设计内);**新增 Step 5**(恢复脚本 + 严格冻结语义 + era-mismatch 裁定路径 + 独立提交);原 Step 5 改号 Step 6 |
| plan Task 4 | beta 行已被合并自动移除,只删 huaanwork;Files/Interfaces/commit 订正 |
| plan Task 5 | Files 增 schemastery 行;Step 1 增改前值注意 + beta schemastery 恢复;Step 2 全面订正(market 改前值为上游形态、schemastery 两行恢复 fork 值);Step 3 Expected 中间态注记 + 终检挪 Task 8 |
| plan Task 8 Step 5 | market peer 检查命令订正(P2-1)+ `yarn why` 终检 + era-mismatch 提示 |
| Epic | Files Reference next 行改「合并后显式恢复」;header 增 plan-review 修订行 |

**复核声明**:修法中的新数字(162 恢复 / 17 移除 / 44 peer 计数)与机制断言(theirs-wins、market 零 fork 改动、`^3.18.5-alpha.2` 不盖 `3.18.5-alpha.1`)均经本评审实测;恢复脚本为设计文本、尚未执行(执行属 M9-A)。

---

## 六、修订方采纳跟进(2026-10-17)

修订方(Claude)按本文采纳 P2-2/3/4 与 P3×3,落盘后经本节逐条背靠背复核:

| # | 修订 | 复核结果 |
|---|---|---|
| P2-2 | 通用规程改**临时 git 仓**方案(`package/` 内 `git init` + commit 基线 → 编辑 → `git diff > patch`),并注记「真实应用验证由每批 `yarn install` 完成」 | ✅ 实测产出 `diff --git a/lib/x.js b/lib/x.js` 与既有补丁同形(多 `index` 行,dshmarket 补丁证明 yarn 接受该形态);**修订方的弃用理由实测成立**——`git diff --no-index a b` 产出双层前缀 `a/a/lib/x.js`,本文原建议的该命令有误、已在 §三订正。附带核实:21 个既有补丁零 new-file hunk,`git diff` 不显示未跟踪新文件的盲点对本任务无效 |
| P2-3 | Task 6 改「不设固定预期 + 记录实际值 + driver 0 命中为有效断言」,补「子模组包目录 328→349」 | ✅ **328→349 精确命中**(package.json 计数法实测;本文初测 492→507 系被组级 README 等非包两级前缀污染——计数口径教训:按 package.json 计,不按两级前缀粗计) |
| P2-4 | 重放清单改「两套」并注明 rc.1 套属 Task 8 产物 | ✅ 正确 |
| P3-1/2 | 合并提交以 `git add -A -- ':!docs/evidence/…'` 排除证据文档;可变 install 挪 Step 4 一次重生 + `--immutable` 终检 | ✅ pathspec 语法正确;顺序自洽 |
| P3-3 | Epic M9-B 回滚句补 resolution 同步要求(重跑 `--write` ×2 + 恢复脚本) | ✅ 机制读码复核属实(expectedResolution 的 existsSync 回落 → 存量 patch: resolution 与期望不等 → check 红) |

**本轮发现的残留并已处置**:修订方改了 plan 与 Epic 却未回写本文件(§三/§四仍标「待采纳」、header 结论行未更新)——处置清单 §6 教训 #2「改断言不做全文件扫尾」的复发,已由本节补同步;其中 P2-2 行原携带的错误命令(`git diff --no-index`)已就地删除线订正。

**教训(累计第 4 条,与前自我订正并列)**:本评审链上的四处自我订正——P3-2 run-gates 间接层漏察、§七 next 冻结合并漏察、P2-2 `--no-index` 命令未实测即推荐、初测包计数口径污染。共同根因:对「会怎样」的推断未经实测即落文档。**给建议的命令,先跑一遍。**

## 结论

计划的 Spec 覆盖度与内化质量优秀(DoD 映射逐条属实、Grok 三口径正确落地、642 行与脚本行为等细节精确);P1(合并 theirs-wins 击穿 next 冻结)经三方实测成立,修法已完整落盘并同步 Epic;P2 与 P3 全部采纳且经复核确认(其中 P2-2 的采纳方案纠正了本文原建议的实测缺陷)。**全部修订落盘,开工条件满足。**
