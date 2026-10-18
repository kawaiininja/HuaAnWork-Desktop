# 《M9 上游同步:钉 dsh-v0.2.1-rc.1、vendor runtime 刷新与 21 补丁重做(Epic)》评审意见

- **评审对象**:`docs/superpowers/specs/2026-10-17-m9-upstream-sync-epic.md`(GitHub issue kawaiininja/HuaAnWork-Desktop#3)
- **评审日期**:2026-10-17
- **评审方式**:背靠背核实——Epic 全部可验证断言在子模组(`git show/diff/rev-list/ls-tree/tag --contains`)、外仓(`git merge-base/rev-list`)、fork 工作区(`grep`/package.json)与 npm registry 上逐条复核;关键前提(rc.1 = alpha.5 + 纯版本号行)做逐行级验证
- **评审结论**:**有条件通过**——结构、分阶段、引用链、验收框架全部成立,无 P0;但 A3(cordis 家族升版)存在 3 处必须修订的 P1(目标版本与 rc.1 矛盾、家族清单漏 schemastery、范围歧义殃及 next),P1 修订后方可开工 M9-A
- **前置依赖**:`docs/evidence/2026-10-17-runtime-patches-alpha5-disposition.md`(处置清单)已经 GLM 三轮评审订正,本评审直接采信其订正后结论
- **修订跟进**:2026-10-17 同日——P1×3/P2×2/P3×4 全部落 Epic 与 `AGENTS.md` 债表 A3;跟进复核中确认修订方对本文 P3-2 中「未接线进 CI」子断言的反驳成立(`scripts/run-gates.ts:371/:792` 将 `verify-official-bundle-catalog` 编入 `ciSharedStaticGates`,CI 经 run-gates 调用),该子断言已就地订正;复审**通过**,开工条件满足(见 §六)
- **Grok 三审跟进**:2026-10-17 Epic 补三处执行口径(alpha.1 resolutions 整段放回与 vendor/补丁保留、子模组 gitlink 两跳、yarn.lock 按 §5 重放与 dshmarket 容让),GLM 逐条背靠背复核**全部成立**(含「hunk #7 打不上」对 1.66.32/1.66.35 的离线复现);该轮并修复本文两处缺陷(P1-1 两支 peer 漏 next 宿主、§六复核对 alpha.1 补丁计数矛盾的漏察);债表 A3 peer 目标已同步三支(见 §七)

---

## 一、事实核查结果(Current State 与 Context 逐条比对)

| # | Epic 声称 | 核查结果 | 出处 |
|---|---------|---------|------|
| 1 | 子模组 pin `5badb15009`(alpha.1) | ✅ | submodule HEAD |
| 2 | vendored runtime 321 包 | ✅(321 tgz + manifest.json) | `vendor/dsh-runtime/0.2.1-alpha.1/` |
| 3 | `patches/` 21 个 `*@0.2.1-alpha.1.patch` | ✅ | `ls patches/ \| grep -c` |
| 4 | driver 行 desktop `:278`(0.2.0-rc.2)、beta `:279`、huaanwork `:329`、next `:164` | ✅ 四处行号与版本全部精确 | 四包 package.json |
| 5 | cordis 钉版 `4.0.5-alpha.1` 系,公网 npm 解析、不受 vendored runtime 约束 | ✅(beta`:152`/huaanwork`:207`/next`:39`/market`:88,215`;desktop 为 4.0.4 系) | 四包 package.json;vendored manifest 无 cordis 条目 |
| 6 | merge-base `ca52ce2cd9` | ✅(2026-10-08 12:44:38,「2026-10-08→10-17」窗口成立) | `git merge-base HEAD upstream/master` |
| 7 | 落后 116 提交(75 非合并) | ⚠️ 落笔时准确;**现实测 119(77)**(upstream tip 已前移至 `44084bdae0`,2026-10-17 14:14) | `git rev-list --count/--no-merges --count` |
| 8 | 子模组到 rc.1 跨 4 个 alpha(1646 提交) | ⚠️ 1646 是 alpha.1→**alpha.5**;alpha.1→**rc.1 = 1650**;括号数挂错端点 | `git rev-list --count 5badb15009..dsh-v0.2.1-rc.1` |
| 9 | rc.1 目标 `1600d8a1e14` = alpha.5 + 4 提交/355 文件**纯版本号行** | ✅ **逐行验证**:4 提交(`d9c04d6cc6` vendor 发布 + `c6e89e6755` dsh 发布 + 2 merge)、355 文件/355 增/355 删、**全部 355 行变更均为 `"version":` 字段、0 行非版本变更** | `git diff dsh-v0.2.1-alpha.5 dsh-v0.2.1-rc.1` 逐行 |
| 10 | 升级后 sync 静默回落为无补丁解析(check 亦不报错) | ✅ | `scripts/sync-vendored-runtime.mjs:89-96` |
| 11 | 预期冲突点①:上游 `75ad518423`(pass attachInput disposer) | ✅ 存在(2026-10-17 02:27:40)、同文件同根因、为 upstream/master 祖先;但「两种写法」表述偏重——两侧**同为** `guests.bind(window, () => () => {})`,上游仅多 uncaughtException 兜底,冲突消解是平凡的 | 外仓 `git show 75ad518423`;fork `3e5002f1d8` |
| 12 | 预期冲突点②:CI 矩阵 hunk | ✅ fork 侧 `ci.yml:101/169/249` 均含 huaanwork | `.github/workflows/ci.yml` |
| 13 | AGENTS.md 债表 R-M9-1…R-M9-4 已登记 | ✅ 且裁定内容与 Epic 一致;R-M9-2 支撑断言抽验命中(四包 src 对 driver **零 import** 实测 0;`agent-invoke.ts:180` `start("spawn")` 精确) | `AGENTS.md` 债表「上游新一轮落后」行 |
| 14 | 跟踪壳 issue #4/#5/#6 | ✅ 全部存在、OPEN、标题一致(含 Epic 本体 #3) | `gh issue view` |
| 15 | M8 先例文档 | ✅(`2026-10-m8-push/ci-reconciliation/merge-decisions.md` 均在) | `docs/evidence/` |
| 16 | M4 基线「17 通过、A10 不通过、A19 负例通过」 | ✅ 逐字吻合 | `docs/huaanwork-m4-human-verification-2026-10-07.md:157` |
| 17 | A20–A28 环境阻塞项(凭据/Windows 主机/旧树/7 天等待/内网机) | ✅ 有源(M4 §3 照录 M7 checklist §2.3:A20/A21 凭据、A22–24 Windows、A25 旧树、A26 Tauri、A27 7 天、A28 内网) | 同上 `:138-140` |
| 18 | **迁移幂等对 rc.1 persistence 新增 7 项** | ✅ **精确坐实**:窗口内 `docs/persistence-changes/` 新增 7 条(163→191 文件,每条 4 文件):`2026-09-13-working-directory`、`2026-09-19-external-subagent-catalog`、`2026-09-30-job-session-lifecycle`、`2026-10-05-ptc-operation-metadata`、`2026-10-05-working-directory-attribution`、`2026-10-07-title-reasoning-effort`、`2026-10-13-user-rpc-principal` | 子模组 `git ls-tree` 对比 |
| 19 | DoD 1 基点 ≥ `2e7a9a44d9` | ✅ 该提交存在(2026-10-17 02:45:23)且为现 upstream/master 祖先;「≥」表述正确吸收 tip 漂移 | `git merge-base --is-ancestor` |
| 20 | 「rc.1 起含 on-demand bundle 前置校验」 | ⚠️ 载体未指明(见 P3-2):`release:pack` 经 `scripts/release/families.ts` 纳入 ON_DEMAND_BUNDLES 发布序与 peer 边校验(`8ed0b530ed`);`verify-official-bundle-catalog` 不在 build/pack、但**在子模组 run-gates 门禁链**(`run-gates.ts:371/:792`,CI 经 run-gates 调用——本行原判「未接线进 CI」系漏看 workflow→run-gates 间接层,修订跟进时订正) | 子模组 `git grep` |
| 21 | 人日 13–19(A 3–5 + B 7–9 + C 3–5)、缓冲至 M8 级 15–25 | ✅ 算术自洽;M8 级与债表一致 | — |

**补充事实(核查中发现、Epic 未记载但影响 A3 修订)**:

- **npm registry 上 `@deepseek-ai/cordis` 四版本并存**:`4.0.4`、`4.0.5-alpha.1`、`4.0.5-alpha.2`、`4.0.5`(稳定版,rc.1 vendor 发布产物)。**这使 P1-1 的错误更危险**:按错误的 `-alpha.2` 目标实施,`yarn install` 不会失败(两个版本都在 npm),双实例问题会被掩盖到运行时。
- fork 的 **schemastery 钉版**与 cordis 同模式铺在五包:desktop `^3.18.4`、beta `:311` / huaanwork `:361` / next `:197` 均 `^3.18.5-alpha.1`、market peers `:131` `^3.18.4 || ^3.18.5-alpha.1` + devDep `:273`;rc.1 vendor 已将其升至 **3.18.5 稳定版**。
- cordis 版本阶梯(全部实测):0.2.0-rc.2 → `4.0.4`;alpha.1 → `4.0.5-alpha.1`;alpha.5 → `4.0.5-alpha.2`;**rc.1 → `4.0.5` 稳定版**(vendor 发布提交 `d9c04d6cc6`)。
- next 的 dsh 与五成员家族钉版均为运行时 **dependencies**(非 devDependencies),与其 `@deepseek-ai/dsh@0.2.1-alpha.1` 强耦合。
- root `package.json` 有 4 行 driver resolutions(`:286/:287` 钉 0.2.0-rc.2、`:920/:921` 钉 0.2.1-alpha.1);next 留在 alpha.1 期间,后两行是 next 的解析通道,**正确保留**。

---

## 二、必须修订(P1,修订后方可开工 M9-A)

### P1-1 A3 cordis 家族版本目标与自身 rc.1 目标矛盾(-alpha.2 系 → 应为稳定系)

Epic M9-A 步骤⑤与 Files Reference 的目标值为 `cordis 4.0.5-alpha.2 / group 1.0.5-α.2 / include 1.0.10-α.2 / loader 1.0.6-α.2 / timer 1.1.7-α.2 / cosmokit 1.8.6-α.2`——**这是 alpha.5 的 vendor 状态**(处置清单 A3 对其自身的 alpha.5 目标而言是对的)。而 alpha.5→rc.1 窗口内的 vendor 发布提交 `d9c04d6cc6`(「release(vendor): cordis 4.0.5, cosmokit 1.8.6, group 1.0.5, hmr 1.0.20, include 1.0.10, loader 1.0.6, logger-console 1.0.5, schemastery 3.18.5, timer 1.1.7」)已把全家族转入**稳定系**。rc.1 实测:`vendor/cordis=4.0.5`、`vendor/group=1.0.5`、`vendor/include=1.0.10`、`vendor/loader=1.0.6`、`vendor/timer=1.1.7`。

- **正确目标**:beta/huaanwork 五成员钉 `4.0.5 / 1.0.5 / 1.0.10 / 1.0.6 / 1.1.7`;market devDep → `4.0.5`、peers → ~~**`"4.0.4 || 4.0.5"`**~~ **订正(2026-10-17 Grok 三审,见 §七):应为三支 `"4.0.4 || 4.0.5-alpha.1 || 4.0.5"`**——stable 宿主 `4.0.4`(实测 0.2.0-rc.2 的 vendor cordis = 4.0.4)、beta/huaanwork 宿主 `4.0.5`、**next 宿主 `4.0.5-alpha.1`**(next 在 dependencies 依赖 market,原两支漏此宿主)。
- **根因与传播**:目标从 alpha.5 改为 rc.1 时,A3 文本未随 vendor 发布提交更新;**AGENTS.md 债表 A3 的「-alpha.2 系」同文同样过期**(同源),两处需一并订正,否则实施者以债表为准仍会做错。
- **后果**:按 -alpha.2 实施 → beta/huaanwork 钉 4.0.5-alpha.2 而 rc.1 runtime 依赖解析 4.0.5 → 恰好制造 Epic 自己警告的「两份 cordis 单例」;且因 npm 上 -alpha.2 亦存在,安装不报错,缺陷掩盖到运行时。
- 顺带订正:cosmokit 在 fork 无钉版(上游 vendor 语境,列入无害但无动作);vendor 发布还动了 hmr(1.0.20)/logger-console(1.0.5),fork 同样无钉版、无动作——建议 A3 注明「fork 侧有钉版的家族成员 = cordis/group/include/loader/timer(+schemastery,见 P1-2)」。

### P1-2 A3 家族清单漏 schemastery

fork 五包以与 cordis 完全相同的模式钉 `@deepseek-ai/schemastery`(beta `:311`、huaanwork `:361`、next `:197` 均 `^3.18.5-alpha.1`;market peers `:131` + devDep `:273`;desktop `^3.18.4`),而 rc.1 vendor 已升至 **3.18.5 稳定版**。caret 区间虽形式上容纳 3.18.5,但 lockfile 现解析在 `-alpha.1` 实例,与 rc.1 runtime 解析实例的分裂风险与 cordis 同源。A3 的范围与 Files Reference 均未提及 schemastery。**修订**:A3 补入 schemastery(beta/huaanwork devDep 刷新解析至 3.18.5、market peers → `^3.18.4 || ^3.18.5`、next 不动、desktop `^3.18.4` 已覆盖无需动)。

### P1-3 「四包 cordis 钉版」范围歧义——next 不得随升

Out of Scope 明确「dsh-desktop-next:本轮不升 runtime」,而 next 的五成员家族钉版是运行时 dependencies、与其 `dsh@0.2.1-alpha.1`(解析 cordis `4.0.5-alpha.1`)强耦合。Files Reference 的「四包 `package.json` cordis 钉版 → -alpha.2 系」若按自然读法(beta/huaanwork/next/market 四个 -alpha.1 系钉版者)执行,会把 next 一并升版——与其冻结的 runtime 脱钩,再次落入双实例陷阱。**修订**:步骤⑤与 Files Reference 点名升版包清单 = **beta + huaanwork(+ market devDep 与 peers)**;next 明示保持 `-alpha.1` 系;desktop(4.0.4 系)不动。

---

## 三、应修订(P2)

### P2-1 DoD 3「全仓 `grep -c` = 2」按字面不可达成

删 beta/huaanwork driver 行后,`dsh-subagent-in-process-driver` 字串仍存在于:root `package.json` resolutions 4 行(`:286/:287` 0.2.0-rc.2、`:920/:921` 0.2.1-alpha.1——后者是 next 留在 alpha.1 的解析通道,**正确保留**)、desktop `:278`、next `:164`、vendor tgz 文件名、node_modules、dist。字面「全仓」计数远大于 2。**改写**:限定为四个插件/应用包 package.json 的依赖行计数(= 2,desktop + next),并注明 root alpha.1 resolutions 因 next 而保留、不算违规。

### P2-2 Context 数字时效性(开工前刷新)

「116(75 非合并)」现实测 **119(77)**(tip `44084bdae0`);「到 rc.1…(1646 提交)」应为 **1650**(1646 是到 alpha.5)。均为落笔时准确、现已漂移的 As-Of 数字;DoD 1 的「≥ 2e7a9a44d9」已正确吸收漂移。**改写**:Context 加 As-Of 注记,M9-A 开工时以实际 tip 重述;债表同行的 1646 一并订正为 1650(或注明口径)。

---

## 四、建议(P3,随修订顺手处理)

- **P3-1**:冲突点①「同一根因两种写法」改为「同一根因同一写法(`() => () => {}`),上游多 uncaughtException 兜底」——冲突消解比表述更简单(取上游即涵盖 fork 侧),预期该 hunk 为平凡冲突。
- **P3-2**:「rc.1 起含 on-demand bundle 前置校验」点名载体:`release:pack --family dsh` 经 `scripts/release/families.ts` 将 ON_DEMAND_BUNDLES 纳入发布序并校验 peer 边(提交 `8ed0b530ed`)。~~`verify-official-bundle-catalog` 为独立脚本、未接线~~ **订正(2026-10-17 修订跟进)**:该脚本不在 build/pack、但编入子模组 `run-gates` 门禁链(`scripts/run-gates.ts:371/:792`,`ciSharedStaticGates` 门禁集,CI 经 run-gates 调用)——原判只 grep 了 workflow 直引、漏看 run-gates 间接层,经修订方反驳后复核确认。Epic 已按正确口径落文(「在 run-gates 门禁链里、不在 build/pack」)。
- **P3-3**:M9-B 验收「sync `--check` 绿且 21 补丁逐条列出实际命中(非静默跳过)」——sync 脚本无「列出」机制,建议给出具体判据(如 root `package.json` 中 `patch:@deepseek-ai/dsh…` 解析条目计数 = 21)或补一个脚本增强小任务,勿留成无法执行的验收句。
- **P3-4**:M9-C「迁移幂等对 persistence 新增 7 项」引用 §一 #18 的 7 条清单名,便于逐条销号。

---

## 五、总体结论

Epic 的骨架经得起背靠背核查:分阶段与依赖顺序的理由成立(补丁打在 vendor 构建产物上 ⇒ A→B→C);引用链完整无虚指(4 个 GitHub issue、M8 三份先例文档、M4 基线、R-M9-1…4 裁定全部在位);**最关键的前提「rc.1 = alpha.5 + 纯版本号行」经逐行验证为真**(355/355 行均为 version 字段),处置清单结论对 rc.1 成立;连「persistence 新增 7 项」这类冷门数字都精确命中。A1 删行(R-M9-2)的支撑断言(四包零 import、spawn 路径)抽验属实。

全部问题集中在 A3 一处,且同根因:**目标从 alpha.5 改为 rc.1 时,携带 alpha.5 口径的 A3 文本(经债表传播)未随窗口内的 vendor 发布提交更新**。P1-1/2/3 修订成本是十几行文字,但不修的代价是 M9-A 步骤⑤按错误版本实施——且因 npm 上新旧版本并存而安装不报错,双实例缺陷会掩盖到运行时,正是 Epic 自己列为硬阻断的那个故障模式。

**裁定建议:有条件通过。P1-1/P1-2/P1-3 与 P2-1 修订后即可开工 M9-A;P2-2/P3 随修订顺手处理,无需重审。**

---

## 六、修订跟进记录(2026-10-17)

评审意见当日跟进,修订落点逐条背靠背复核:

| 级别 | 处置核对结果 | 落点 |
|---|---|---|
| P1-1(cordis 目标转稳定系 + market peers 区间) | ✅ 步骤⑤/DoD 5/Files Reference/Proposed Change 重写为 rc.1 vendor 稳定系(依据 `d9c04d6cc6`,五个实测值全对);npm 新旧版本并存的「安装不报错」警示与升版后 `yarn why` 验证要求已入文;`AGENTS.md` 债表 A3 同源订正(含订正溯源注记) | Epic 四处 + AGENTS.md |
| P1-2(补 schemastery) | ✅ 步骤⑤/DoD 5/Files Reference 补 schemastery `3.18.5`(beta `:311`/huaanwork `:361` devDep 刷新解析、market peers `^3.18.4 \|\| ^3.18.5`、desktop `^3.18.4` 已覆盖、next 不动) | 同上 |
| P1-3(next 范围点名) | ✅ 步骤⑤点名升版范围 = beta + huaanwork 的 dependencies + market 的 devDep/peers;next 冻结理由(五成员是运行时 dependencies、与 `dsh@0.2.1-alpha.1` 强耦合)入文;Files Reference 增「next 与 root resolutions `:920/:921` 不动」行,「四包」歧义消除 | 同上 |
| P2-1(DoD 3 grep 口径) | ✅ 改为四包依赖行计数 = 2,root resolutions 4 行(desktop/next 解析通道)保留理由入文 | Epic §DoD 3 |
| P2-2(数字时效) | ✅ Context 加 As-Of 注记(116/75 → 当日实测 119/77、tip 前移);「1646 提交」订正为 **1650** 并注明 1646 是到 alpha.5 的口径 | Epic §Context |
| P3-1(冲突①措辞) | ✅ 改为「同一根因同一写法」+ 预期平凡冲突 | Epic §M9-A 冲突点 |
| P3-2(前置校验载体) | ✅ 修订方对本文的反驳成立并经复核确认(见 §四订正与 §一 #20);Epic 落文「在 run-gates 门禁链里、不在 build/pack」——口径正确 | Epic §M9-A 步骤⑥ |
| P3-3(sync 命中判据) | ✅ 落具体判据且比本文原建议更精确:唯一路径数 = 21、现行形态每补丁 2 行条目 = 42 行(实测 root `package.json` 每个补丁路径恰出现 2 次 ✓);`@0.2.1-alpha.1.patch` 引用数 = 0 | Epic §M9-B 验收 |
| P3-4(7 项清单名) | ✅ 7 条 persistence 清单名全部内联 | Epic §M9-C 冒烟② |

**修订版顺带改进(非本文要求、复核认可)**:M9-A 验收「cordis `yarn why` 单份」收窄为「beta/huaanwork 侧」并纳入 schemastery——workspace 内 desktop(4.0.4)/next(`-alpha.1`)/beta·huaanwork(4.0.5)多版本共存是设计内多通道状态,原表述按字面不可达成,此收窄是 P1-3 的必要连带。

**本文自身的订正**:§一 #20 与 §四 P3-2 中「`verify-official-bundle-catalog` 未接线进 CI」子断言**错误**——该脚本编入 `scripts/run-gates.ts:371/:792`(`ciSharedStaticGates` 门禁集),CI 经 run-gates 调用;原判漏看 workflow → run-gates → pnpm script 的间接层,经修订方反驳后复核确认,已就地订正并保留删除线痕迹。教训与处置清单 §6 三条机制性原因同款:**判「未接线」前先查间接调用链,不能只 grep 直接引用**。

**复审结论**:全部 P1/P2/P3 处置到位;修订版新引入的口径(42 行形态、run-gates 位置、1650/119/77)均经本跟进复核属实;未发现修订引入的新错误。**开工条件满足,M9-A 可启动。**

---

## 七、Grok 三审修订跟进(2026-10-17)

Epic 经第三轮修订(Grok,Epic header 第 7 行的三处执行口径),本节为 GLM 逐条背靠背复核记录。

### 三处口径核实结果(全部成立)

**口径① Next 与 beta/huaanwork 共用 alpha.1 解析段——整段放回 + vendor/补丁保留(成立,且修复本文两处缺陷)**

- 脚本级证实:`sync-vendored-runtime.mjs:154-155` 的 filter 会把 alpha.1 整段 resolutions **删除**(alpha.1 既非本通道 rc.1、亦非其他通道 0.2.0-rc.2);不放回则 next 的 `dsh@0.2.1-alpha.1` 落公网 npm 解析,vendored+patched 纪律被破坏
- 脚本级证实:老 vendor 目录不删(cleanup 循环 `:127-131` 只作用于新版本目录);check 对放回段与 `vendor/dsh-runtime/0.2.1-alpha.1/` 不可见(`:212-215` `isChannelResolution` 只匹配本通道版本、`:216` 只扫本通道 vendor 目录)⇒「放回后三通道 check 仍绿」成立
- 关键前提证实:**next 在 dependencies 依赖 market**(`dsh-desktop-next/package.json:198`;desktop/beta/huaanwork 亦同)⇒ market 的 44 个 dsh peer 必须盖住 alpha.1
- **本文两处缺陷被该轮修复**:①§三 P1-1 建议的 market cordis peer 两支目标(`"4.0.4 || 4.0.5"`)漏了 next 宿主——精确版本 `4.0.5-alpha.1` ≠ `4.0.5`,漏支即 next 图内 peer 不满足;②§六复核认可的上轮验收「`@0.2.1-alpha.1.patch` 引用数 = 0」与「next 的 alpha.1 resolutions 保留」自相矛盾——Grok 的双计数(rc.1 = 21 且 alpha.1 仍 = 21)消解之
- semver 推理逐条核实:`^3.18.4` 覆盖 `3.18.5` 稳定版;`^3.18.5` 不含 prerelease(删 `-alpha.1` 支会破 next);market 的 schemastery/cordis devDep 均在 devDependencies(非 peer),sync 脚本不动非 `dsh` 前缀依赖(`isDshPackage`)——均正确

**口径② 子模组 gitlink 两跳(成立)**

`git ls-tree upstream/master deepseek-harness` 实测 = `1517a4dbca`(dsh-v0.2.1-alpha.5)——合并提交带到 alpha.5、pin 提交只做 `1517a4dbca → 1600d8a1e14` 的两跳结构成立;「步骤⑥必须用 `git submodule update` 后的 rc.1 检出」为必要提醒(否则 pack 出 alpha.5,靠 tarball 文件名校验才兜底)。

**口径③ yarn.lock 按 upstream-sync.md §5 重放 + dshmarket 容让(成立且内部一致)**

- `docs/upstream-sync.md` §5(yarn.lock 与根 package.json 严禁逐行三方合并、上游基底重放)与 §6(8 文件永久 override = 3 项 + 5 文件)逐字吻合
- `scripts/prepare-dsh-market.mjs` 行为吻合:latest 查询 → 改 resolutions + 4 个 workspace manifest → `yarn install` 套补丁 → 失败还原 manifest 与 lockfile 后抛错
- **「hunk #7 打不上」离线复现**:`.yarn/patches/dshmarket-desktop.patch` 共 12 hunks,`lib/routes.js` 第 7 个 hunk(`@@ -4188`)对 1.66.32 与复核当日 latest **1.66.35** 均 `git apply --check` 失败(exit=1)
- 内部一致性证实:root `check` 与全部 workspace check 均不含 `market:check`;`ci.yml` 只跑 workspace 级 dist(不含 market:prepare);`release.yml` 仅 workflow_dispatch 触发 ⇒ dshmarket 打不上**只咬本地出包链**,carve-out 与「M9-C 四条无头命令全绿 + CI 对账」不冲突;`dist:mac:huaanwork` 确实前置 `market:prepare`

### 复核中发现的残留(处置状态)

| # | 事项 | 处置 |
|---|---|---|
| 1 | `AGENTS.md` 债表 A3 的 market cordis peer 目标仍为两支,与 Epic 三支矛盾 | **本次已同步为三支**并在 A3 内注明 Grok 三审溯源(本文件 §七) |
| 2 | Epic「latest `1.66.32`」as-of 漂移(复核时 latest 已至 1.66.35,同样打不上) | Epic 文本自带日期限定,可不动;1.66.35 复测结果记录于上,M9-C 出包时以当时 latest 为准 |
| 3 | `marketPeerRange` 脚本改动硬编码 `0.2.1-alpha.1`(next 当前钉版);dshmarket 容让与 `AGENTS.md`「fail rather than silently retaining an old market」规则构成显式偏离 | 两项均为维护债/裁定登记项:**建议 M9 落地时在债表 M9 行登记**(next 升级时 peer 支随动;容让为有记录的范围裁定) |
| 4 | nit:M9-B 回滚「删单个 rc.1 patch 即回退该补丁」不精确——还需同步改该包两条 resolution,否则 `patch:` 悬空致 yarn 失败(前轮已有,非该轮引入) | 随 M9-B 实施消化 |

### 结论

Grok 三处执行口径全部经机械验证成立;该轮同时修复了本文两处缺陷(§三 P1-1 的两支 peer 漏 next 宿主、§六复核对 alpha.1 补丁计数矛盾的漏察)。**开工条件维持满足。**
