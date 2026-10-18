# 2026-10 M9 Task-13 修复记录:next 升 rc.1 + 中断波次的清理与验证

> 工件性质:M9 Task 13 前置修复证据(2026-10-18)
> Worktree:`HuaAnWork-Desktop-sync-m9`(分支 `sync/upstream-2.1.x`,基点 `2edce24e4f`)
> 裁定:用户 2026-10-18 批准 R-M9-R1 —— `dsh-desktop-next` 随合并带入的上游源码升级到 `0.2.1-rc.1`

## 1. 为什么升级 next

Task 13 的无头链在基点上红在三处:next `typecheck` 114 errors、`test` 5 failures(`tests/package.spec.ts`、4× `tests/plugin-detail-navigation.spec.ts`,另有 `tests/host-office.spec.ts` 无法加载)、`check:whitespace` 红在已提交范围的空白。根因是 Task 2 的合并把 next 源码推进到 alpha.5/rc.1 时代,而 Epic 的冻结条款把 next 依赖钉在 alpha.1。

- 冻结状态下的失败是结构性的:alpha.1 没有合并源码引用的包(`dsh-plugin-market`、`dsh-skill-office` 等),把 next 整体回退 pre-merge 后对 rc.1 beta 仍报 typecheck 错(在一次性 worktree 实测)。
- 采用 Epic 的 era-mismatch 条款「accept deps follow upstream + sync DoD 3/5」:保留合并源码、把 next 的 lane 依赖升到 rc.1,并同步订正 DoD 3/5(Epic 内 dated note)。
- `vendor/dsh-runtime/0.2.1-alpha.1/`、21 个 `*@0.2.1-alpha.1.patch`、根 resolutions 的 642 行 alpha.1 段**原样保留、休眠**;next 离开 alpha.1 后没有消费方,`yarn.lock` 的 alpha.1 解析条目由 yarn 自然剪除(market 的 dsh peer 三支串仍含 alpha.1,故 lock 内仍保留 44 处字符串)。

## 2. next 清单变换(逐项可复核)

基底 = `git show 78efd755aa:dsh-desktop-next/package.json`(合并带入的 alpha.5 清单),按 brief 逐项变换:

| 项 | 变换 | 计数 |
|---|---|---|
| `@deepseek-ai/dsh` 与 `@deepseek-ai/dsh-*` | `0.2.1-alpha.5` → `0.2.1-rc.1` | 171 行(dependencies + devDependencies) |
| cordis 家族 | `4.0.5-alpha.2`→`4.0.5`;group `1.0.5-alpha.2`→`1.0.5`;include `1.0.10-alpha.2`→`1.0.10`;loader `1.0.6-alpha.2`→`1.0.6`;timer `1.1.7-alpha.2`→`1.1.7` | 5 行 |
| `@deepseek-ai/schemastery` | `^3.18.5-alpha.2` → `^3.18.5-alpha.1` | 1 行 |
| `@agents-anywhere/dsh-bridge-next` | 指向本次 AA 重建制品(见 §4) | 1 行 |
| `@deepseek-ai/dsh-subagent-in-process-driver` | alpha.5 基底本就没有该行,无需删除(已核实) | 0 |
| 其余依赖与全部 scripts | 保持 alpha.5 原样;真实 `typecheck`/`check` 恢复(中断波次曾把 typecheck 换成 `echo` 并把 typecheck/test 从 `check` 移除) | — |

变换脚本先断言「所有 dsh-* 行都是精确 `0.2.1-alpha.5`」「cordis 行都是 `-alpha.2`」「schemastery 是 `^3.18.5-alpha.2`」「不存在 driver 行」「每条 rc.1 行在根 resolutions 中都有 `@npm:0.2.1-rc.1` 选择子」,任一不满足即停止。清单以两空格缩进 + 末尾换行写出;`git diff --numstat` = 178 增 / 162 删(162 即 plan Task 2 Step 5 恢复过的 alpha.1 lane 值)。

`upstream-reference.json`:`commit` → `1600d8a1e140dcde43a1a0941940a0480712c011`,`version` → `0.2.1-rc.1`;39 个 `files[].upstreamSha256` 全部对 rc.1 子模组检出实测匹配(39/39),未改动。

安装后实测:`dsh-desktop-next/node_modules/@deepseek-ai/{dsh,dsh-skill-office,dsh-tool-workspace-dependencies,dsh-plugin-market,dsh-experimental-inspector}` 均为 `0.2.1-rc.1`;AA 为 `2.1.0-desktop.c39b82d4fffb1.r57f6b0fe`。

`src/host/office.ts` 的中断波次改动(动态 import + 两条 `@ts-expect-error`)在 rc.1 下报 TS2578(unused directive);恢复为合并带入的静态 import + `Context` 类型后 typecheck 转绿。这是 next 单侧修复,未触碰 beta 源码。

## 3. 失败 → 通过

| 命令 | 修复前 | 修复后 |
|---|---|---|
| `corepack yarn workspace dsh-desktop-next typecheck` | 114 errors | exit 0 |
| `corepack yarn workspace dsh-desktop-next test` | 5 failures / 3 files(`package.spec`、4× `plugin-detail-navigation`、`host-office` 无法加载) | 77 files,641 passed / 1 skipped (642),exit 0 |
| `corepack yarn check:whitespace` | exit 1(已提交范围) | exit 0 |
| `corepack yarn aa:check` | exit 1(runtime peers have changed) | exit 0 |
| `corepack yarn check:desktop-variants` | exit 1(`desktop-settings-styles.ts` 未声明) | exit 0 |

next 的三个预期修复(`package.spec` office 依赖、`plugin-detail-navigation` 在 rc.1 plugin-manager 下的分组、`host-office` 加载 `dsh-skill-office`)在 rc.1 安装后**无需改测试**即通过 —— 合并带入的 next 测试断言的就是 rc.1 行为;没有为转绿削弱任何断言。

## 4. Agents Anywhere 重建(两阶段)

1. 中断波次已按「next 仍在 alpha.1」的 peer 并集重建过一版:`2.1.0-desktop.c39b82d4fffb1.r3ee982af`(peers 含 `0.2.1-alpha.1` 第三支)。
2. next 升 rc.1 后,`scripts/agents-anywhere-release-policy.mjs` 的 `runtimePeerRanges()` 由四个 workspace 的依赖并集重算,结果变为 `0.2.0-rc.2 || 0.2.1-rc.1`;旧 provenance 的第三支使 `aa:check` 失败(runtime peers have changed)。artefact 的 r-hash 由 peer JSON 派生,因此必须按新并集重建。
3. `corepack yarn aa:prepare-release`(AA main `39b82d4fffb178a1217abd057e546374c57c030a`,与 `aa:check` 的 ls-remote 一致)产出:
   - 制品 `vendor/agents-anywhere/agents-anywhere-dsh-bridge-next-2.1.0-desktop.c39b82d4fffb1.r57f6b0fe.tgz`
   - sha256 `eee6ec1123f34722bcaba670b7591ad08701d3e36170d622b142919af8e541a0`(与 provenance 一致)
   - peers `@deepseek-ai/dsh-{typert-protocol,llm,session}` = `0.2.0-rc.2 || 0.2.1-rc.1`;cordis/schemastery 的 `~4.0.4`/`~3.18.4` 未被脚本改动,rc.1 宿主(4.0.5/3.18.5)满足
   - 四个 workspace 的 AA 引用、根 resolution、`yarn.lock` 均由脚本一并更新
4. 被取代的 `r3ee982af`(从未提交)已删除,避免工作树残留未跟踪制品。
5. `scripts/prepare-agents-anywhere-release.mjs` 的 cosmokit 映射补 `3.18.5 → 1.8.6`(AA 构建期 schemastery 3.18.5 需要 cosmokit 1.8.6)。

验证:`corepack yarn aa:check` exit 0(`AA release verified: all Desktop channels use 39b82d4f…`);`test:aa-release`/`test:aa-connector` 各 exit 0。

## 5. 中断波次的逐项验证

- **huaanwork rc.1 依赖 parity**:177 条 lane 值,与 beta 逐条一致(本记录以两包 `dependencies`/`devDependencies` 的 dsh/cordis/schemastery 并集比对)。保留。
- **package/behavior 测试更新**:dshmarket 1.66.28、beta `2.0.17-beta.2`、primary-runtime(`prepare:runtime`/`extraResources`/`signIgnore`)、rc.1 PTC `launch` 形状、request-inventory 由 reject 改 warning、通知文案读 `DESKTOP_PRODUCT_NAME`、`tool-ralph` optional。对应 workspace 测试全绿。
- **变体守卫**:stable↔beta 9→7(上游剪掉 6 个 NSIS A/B 脚本;4 个 runtime 脚本两侧分化);beta↔huaanwork 24→**64** = 24 既有 + 40 上游 2.1 新登记。40 条新登记的实测形状(2026-10-18 复核):**15 个文件只存在于 beta**、**25 个两侧都存在但内容分叉**(上游 2.1 developer-logging / file-path-bridge 功能未搬);未来对齐 wave 必须新增 15 + 合并 25,不是「加 40 个文件」。这是「上游 2.1 功能未搬进 huaanwork」的登记债,不是 parity;类别见 `AGENTS.md` 新债行。上游 2.1 的深色主题 `<select>` 修复已同步到 huaanwork(`desktop-settings-styles.ts` 与 beta 逐字节相同),sharp 0.35.5 对齐后 `scripts/mac-universal.ts` 也逐字节相同,均不占名额。守卫与 `verify-desktop-variants.test.mjs` 的计数钉同步(64/6),`corepack yarn check:desktop-variants` exit 0。
- **空白**:mapping 文档的行尾两空格改为 `<br>`,`merge-decisions.md` 去掉 EOF 空行,`market-toggle.ts` 去掉 3 行 EOF 空行;`git diff --check` exit 0,提交后 `check:whitespace` exit 0。
- **深色主题 `<select>` 修复**:早先中断波次把它当作停放项;复核发现它正是 beta 已含的上游 2.1 UI 修复(`desktop-settings-styles.ts` 两版只差这 6 行)。按「上游变更应同步进变体」处理:应用到 huaanwork,两文件逐字节相同,不占白名单名额;`parked-desktop-settings-select.patch` 已应用,不再保留为债务。
- **host-process 集成测试**:原中断波次写 `compatibility.json` 键到旧 AA 版本;按 brief 先尝试直接删除该写入 —— 新 AA 的 dsh peers 直接接受 rc.1,beta 与 huaanwork 的两个用例都通过,故不再需要豁免。
- **`verify:operations`**:删掉的一行 spec 只是同一矩阵的重复断言;`verify-operation-reliability.mjs` 现在自己断言 7 operations / 18 scenarios。实跑 exit 0(`7 operations and 18 fault contracts verified`)。
- **Market × plugin-manager**:`tests/market-plugin-manager-integration.spec.ts` 替换 `market-pnpm-integration.spec.ts`;rc.1 的 `@deepseek-ai/dsh-plugin-manager/lib/index.js` 确有 `super(ctx, "pluginManager")`,而 `dsh-community-market/src/index.ts` 通过 `ctx.inject(['pluginManager','profileContext'])` 消费它 —— 新 spec 走的是真实当前路径。实跑 exit 0。
- **`webRuntime`**:rc.1 安装树内 `grep -R "webRuntime" dsh-plugin-{desktop-beta,huaanwork}/node_modules/@deepseek-ai` 命中 0;子模组内唯一命中是一个测试里的局部变量 `web-runtime`。`src/index.ts` 的 inject 删除是必要的启动修复;beta/huaanwork 的 `verify-loader-boot.mjs` 也不再提供该 mock(stable 仍钉 0.2.0-rc.2,保留该行)。
- **`tool-ralph`**:用真实 `prepareDesktopProfile` + `composeEntries` 组合 huaanwork profile,实测 210 行、无 `tool-ralph` 行(rc.1 的 ralph bundle 仍定义该行 id,但 huaanwork 的 bundle 选择不挂载它)。optional 标记正确。

## 6. 门禁记录(2026-10-18,worktree 根目录)

| 命令 | 退出码 | 关键输出 |
|---|---|---|
| `corepack yarn install --immutable` | 0 | Done with warnings(既有 peer 警告) |
| `corepack yarn typecheck` | 0 | 七个 workspace 全绿(next 真实 `tsc --noEmit` + packaging) |
| `corepack yarn test` | 1(首跑)→ 0(最终树复跑) | **首跑**:唯一失败 `dsh-plugin-huaanwork/tests/huaanwork-host/automation-scheduler.spec.ts > cross-root due stays due and a deleted project still runs`(`poll timed out after 4000ms`,全量并发负载下);其余 2595 passed / 13 skipped。隔离复跑该文件 12/12 passed(6.9s)⇒ 负载型 flake,非代码回归;未改测试。**最终树全量复跑**:exit 0,全部 workspace 绿,该超时未复现。 |
| `corepack yarn check` | 0 | 全链绿(`verify-profile-boot`、`verify:operations`、`verify:licenses`、`verify-runtime-closure`、`check:desktop-variants`、三通道 vendored runtime 等) |
| `corepack yarn check:desktop-variants` | 0 | stable↔beta allowlist 7;beta↔huaanwork allowlist 64(oneSidedPrefixes 6);11/11 tests |
| `corepack yarn aa:check` | 0 | `AA release verified: all Desktop channels use 39b82d4f…` |

补充:`corepack yarn workspace dsh-desktop-next typecheck` / `test` 均 exit 0(见 §3);`corepack yarn test:aa-release` / `test:aa-connector` 均 exit 0(见 §4)。

## 7. 残留风险

- next 升 rc.1 后不再有 alpha.1 消费方,alpha.1 的 resolution/patches 只是**休眠资产**;若未来有人重新引入 alpha.1 依赖,`yarn.lock` 需要重新解析(当前 lock 无 alpha.1 包条目)。
- huaanwork 有 40 条与 beta 的已登记分叉(**15 个文件只存在于 beta** + **25 个两侧内容分叉**;深色主题 select 与 `mac-universal.ts` 已同步,不占名额),意味着上游 2.1 的功能面尚未进入内网变体;触发条件与工作量见 `AGENTS.md` 新债行。
- `THIRD_PARTY_NOTICES.md` 已按安装树重生成(2026-10-18):stable 592 / beta 623 / huaanwork 624 production packages;stable DSH 0.2.0-rc.2,beta/huaanwork 0.2.1-rc.1;sharp 0.35.5;AA r57f6b0fe;无 alpha.5/0.35.3。`verify:notices` 仍不在任何 `check` 链里,发版前若依赖树再变需重跑。
- AA 制品随 workspace peer 并集变化而换名(r-hash):以后再改任一 desktop 包的 dsh peer 版本,`aa:check` 会先红并提示重跑 `aa:prepare-release` —— 这是设计内行为,但需要发版流程预期一次制品更新。

## 8. R-M9-R2 / notices / P3 后最终门禁(2026-10-18)

- **R-M9-R2(用户裁定)**:市场重复安装判据改为「UI 禁用重复安装;底层重复 install 返回 `restart-required` / `changed=false` 且 profile 字节不变」;human doc 已勾选通过,Epic/plan/AGENTS 已同步。
- **notices**:三包 `THIRD_PARTY_NOTICES.md` 已重生成(见 §7);`verify:notices` 未纳入 `check` 链,本次为手工生成。
- **P3 清理**:删除 `vendor/dsh-runtime/0.2.1-alpha.2/` 与 `0.2.1-alpha.5/` 两个死 lane(675 个 vendor 文件)及 44 个未引用 `*@0.2.1-alpha.2.patch` / `*@0.2.1-alpha.5.patch`;alpha.1 休眠 lane 与 21 个 alpha.1 补丁保留。`nextResolutions`→`alpha1Resolutions`(三包测试);row-assertions 增加 ralph rename 探针;present-as 改用类型守卫;webserver 策略单测独立;beta/huaanwork 的 `webRuntime` mock 移除(stable 仍钉 0.2.0-rc.2 保留);huaanwork 两个死直接依赖移除;market cordis peer 收敛为 `"4.0.4 || 4.0.5"`。兼容性说明见处置清单 §7.1。

| 命令 | 退出码 | 关键输出 |
|---|---|---|
| `corepack yarn install --immutable` | 0 | lock 与 manifests 一致 |
| `corepack yarn check` | 0 | 全链绿;变体守卫 7/64/6;三通道 vendored runtime;huaanwork host loop / loader / profile / AA / licenses / operations 全过 |
| `corepack yarn typecheck` | 0 | 七个 workspace 全绿 |
| `corepack yarn test` | 0 | 全部 workspace 测试文件通过:desktop 143、beta 143、huaanwork 218(+3 skipped)、next 77、market 13、market-server 14、update-server 5;wrapper 4/4、update-download 目标测试 44/44 |
| `corepack yarn check:desktop-variants` | 0 | 11/11;stable↔beta 7;beta↔huaanwork 64;oneSidedPrefixes 6 |
| `corepack yarn check:vendored-runtime` | 0 | stable 318 / beta 341 / huaanwork 341 |

未本机执行:Linux/xvfb 的 CI Electron 步骤(需 CI runner)。
