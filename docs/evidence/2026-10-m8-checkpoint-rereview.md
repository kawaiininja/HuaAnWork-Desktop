# 2026-10 M8 checkpoint 系统复核(wip 提交 827e53fc03 的 verify-as-I-go 收口)

复核对象:`827e53fc034652452c9244e7f31d7f668657f8c6`(2026-10-09 17:28:54 +0800,wip(m8) checkpoint,自述 "NOT yet reviewed",Controller 裁定 "keep, verify as I go")。

复核基线:主分支 HEAD = `b860ba8f9a`(2026-10-16 时点),checkpoint 之后 79 个提交。运行时门禁在独立干净 worktree(`HuaAnWork-Desktop-rereview`,detached at HEAD)上执行,主工作树的在途改动未被触碰、不被计入测量。

参照系:`a36953ee24`(checkpoint 的父提交 = M8 Phase 2 合并提交)、`efde2186be`(合并前 fork 侧 tip)、`ca52ce2cd9`(合并的上游 master)。

## 1. checkpoint 逐条主张核对矩阵

| 主张(提交信息原文要点) | 判定 | 证据 |
|---|---|---|
| runtime re-pin 0.2.1-alpha.1,`@deepseek-ai/*` dep profile 与 beta 完全一致(7 个 distinct 版本;schemastery ^3.18.5-alpha.1;node-addon-require-builtin ^0.1.6) | **部分成立** | 共享 dep 的版本钉全一致(HEAD 实测 161 keys 比对,155 个版本全等,含两个具名包)。但 **key 集合不一致**:checkpoint 时点 huaanwork 148 个 `@deepseek-ai/*` keys vs beta 160 个(合并前 beta 也是 148——12 个 key 是合并从上游带入 beta 的,huaanwork 未跟进)。至 HEAD 仍有 6 个 key 缺席,见 §4 F-3 |
| `yarn.lock` 由 yarn 再生、非手编(GC4);`yarn install --immutable` exit 0 | 成立 | HEAD 实测 exit 0(主树 2.2s;干净 worktree 49.5s,含 1 条 YN0007 构建提示,exit 0)。手编无法直接回溯证伪,lockfile 在两树均可被 yarn 接受 |
| 18 个新模块自上游移植 | 成立 | `git show 827e53fc03 --diff-filter=A` 实测恰 18 个 A 文件,清单与提交信息列举吻合(system-proxy、platform-login、onboarding、jobs-bridge、startup-audit、asar-archive-policy、disposable-tree、link-projections、launch-workspace、profile-context 等) |
| `paths.test.ts` 不再依赖真实 `.git`(worktree 中是 FILE),改为 tmpdir 合成 | 成立 | `packages/huaanwork-policy/src/paths.test.ts:10/33-36/58-61`:`mkdtempSync(os.tmpdir())` + `mkdirSync .git`,零真实 `.git` 读取 |
| 删除 `tests/dsh-settings-legacy-compat.spec.ts`(随上游,三符号无引用) | 成立 | 文件在 HEAD 不存在;`deepEqualJson` / `installSettingsSection` / `settingsNamespace` 在 huaanwork `src/` 零命中 |
| huaanwork typecheck(5 tsc projects)绿 | 成立(HEAD 复测) | 干净树 exit 0(`tsc -p tsconfig{,.client,.native-ui,.tests,.tests.client}.json --noEmit` × 5) |
| huaanwork 全量套件(214 files / 2562 tests)绿 | 成立(HEAD 复测,计数已漂移) | 干净树 + 完整构建链后 exit 0:**220 files(217 通过 / 3 skip)/ 2604 tests(2591 通过 / 13 skip)**。计数增长来自 checkpoint 之后的后续功能提交(automations、web_fetch/screenshot、call_host_tool 等),非复核发现的缺口 |
| `check:vendored-runtime`(3 channels)绿 | 成立(HEAD 复测) | `stable 318 packages from 639ed01539`、`beta 321 from 5badb15009`、`huaanwork 321 from 5badb15009` 全部 verified |
| 已知红:`check:desktop-variants`(2 of 9) | 已在后续收口 | HEAD 实测绿:守卫测试 11/11 pass,verify 通过,allowlist stable↔beta 9(前缀 0)、beta↔huaanwork **23**(前缀 6)。名额 23 = R-M8-3 结构性 22 + setZoomLevel 裁定(`1ce000b99c`)1;工作树在途的目录选择恢复会把名额带至 24(未提交,见 F-1) |
| 已知缺口:update-checker 缺 stable/beta 已验证的 `parseInstallerDigestResponse`(Task 2.5) | 已当日闭环 | `3ff2b646c6`(采共享 extractor + 重放两条 D-M6-23 语义)+ `ba30ead710`(fail-closed 前规范化)——当日 22:18/22:31 落地,后续 `4e1fa83ed0` 加固;函数现位于 `src/update-checker.ts:384` |

## 2. 静默丢弃扫描(本次复核的核心命题)

已知先例:`bd71df0beb`(2026-09-30)加入的 macOS 原生目录选择被 checkpoint 静默丢弃(白名单注释 `scripts/verify-desktop-variants.mjs:103-108` 记载)。问题:是否还有同类。

**方法**(四层):

1. **fork 单侧目录文件级对照**(`efde2186be` → HEAD):`client-huaanwork/`、`huaanwork-host/`、`huaanwork-guardrails/`、`huaanwork-migration/` 四目录**零删除**,仅新增 `huaanwork-guardrails/web.ts`。
2. **白名单收敛分析**(pre-merge 22 → HEAD 23):收敛集恰 3 文件,逐一判读——
   - `src/index.ts`:**确认为静默丢弃**(F-1);
   - `scripts/verify-win-portable.ts`、`scripts/verify-win-installer.ts`:**合法收敛**——HEAD 上 huaanwork 侧 `HuaAnWork-*` 制品名校验逻辑逐字保留,差异消失是 R-M8-3 `normalizeIdentity` 在比较前吸收身份拼法,不再占名额,非能力丢失。
3. **checkpoint 在 fork 单侧目录内的内容级改动判读**:`guardrails/model.ts` 是采上游一线 wire 格式(`role:"tool"` 一等消息),配套测试全绿,判合法;`guardrails/policy.ts` 的 `gitDirty` 语义收窄是**无上游对侧、无测试、无文档**的语义变更(F-2)。
4. **六项已知 fork 能力标记 grep**(HEAD):`requestConfirmedRestart`(electron-runtime 2 处 / host-runtime-bridge 5 处)、`huaanwork-market` 第四 provider(12+ 文件)、`huaanworkCheckpointUserDataDir` config 贯穿(holders/index/market/plugins-host)、三通道 `SUPPORTED_RELEASE_CHANNELS`(update-checker.ts:68)、profile-checkpoint 市场 GC(main.ts 迁移接线在位)——**全部在位**。

**结论:静默丢弃共 1 例(darwin 目录选择),与已知登记重合,无新增发现。**

## 3. 干净 HEAD 树上的运行时门禁

| 门禁 | 结果 |
|---|---|
| `corepack yarn install --immutable` | exit 0 |
| huaanwork typecheck(5 projects) | exit 0 |
| huaanwork 全量套件 | **exit 0**;220 files(217 pass / 3 skip)、2604 tests(2591 pass / 13 skip) |
| `check:vendored-runtime` | 3 channels verified |
| `check:desktop-variants` | 绿;守卫 11/11,allowlist 9/23,前缀 0/6 |

**裸树起跑红线(非缺陷,provisioning 缺件)**:新鲜 checkout 直接 `yarn workspace dsh-plugin-huaanwork test` 会红,须依次补:① `tsdown`(产 `lib/desktop-cli.js` 等主进程产物)② `vite build --config vite.client.config.ts` + `vite.native-ui.config.ts`(产 `lib/client.js`、`lib/native-ui/*.html`)③ `git submodule update --init --recursive`(`deepseek-harness`;mac-entitlements.spec 读它的 plist)④ `yarn workspace dsh-community-market build`(`dsh-community-market/contracts`)。补齐后全绿。该套件的有效性隐含「开发期已配置的树」,与 checkpoint 当时的绿一致。

## 4. 发现与待裁定项

| # | 发现 | 状态/建议 |
|---|---|---|
| F-1 | **darwin 目录选择恢复未提交**(登记时状态):HEAD(`b860ba8f9a`)的 `src/index.ts` 仍无 `directoryPicker` 的 darwin 注册;恢复(含被删 darwin 测试与白名单 23→24)当时只存在于主工作树的**在途未提交改动**(2026-10-16 实测:`src/index.ts` +54/-21,`verify-desktop-variants.mjs`/`.test.mjs` 已改) | **已处置(2026-10-16,`424ac705d4`)**:4 文件提交(宿主注册 + 4 条 darwin 用例 + 白名单 23→24 + 名额钉),plugin.spec 31/31、守卫 11/11 |
| F-2 | **`guardrails/policy.ts:192` 的 `gitDirty` 语义收窄**(所有工具 → 仅 `git_checkout` 才探测):checkpoint 携带,无上游对侧、无文档理由、无测试。**订正(2026-10-16 裁定时)**:本行原文「零读取方 ⇒ 惰性」**有误**——复核扫描只搜了 `dsh-plugin-huaanwork/`,漏了 `packages/`;真实读取方是 `packages/huaanwork-policy/src/decide.ts:106`,且**恰好在 `case "git_checkout"` 分支内** ⇒ 收窄在所有可达判定上与原版逐字等价,并把每次工具调用一次的同步 `git status` spawn(`spawnSync`)从热路径摘除;恢复原语义 = 纯性能回退,零功能收益 | **已处置(2026-10-16,用户裁定「保留收窄」,`a9b682eb36`)**:注释钉(policy.ts)+ probe 回归钉(policy.cordis.spec.ts,反向探针验证过活性)+ 本订正 |
| F-3 | **6 个 beta 声明而 huaanwork 缺席的 dep**:5 个 experimental/llm-account 类在 huaanwork src 零 import(结构性缺席,无害);`@deepseek-ai/dsh-client-shortcuts` 在 `src/client/layout-service.ts:3` 有 **type-only import 但未声明**——经 yarn hoisting 解析、编译后擦除,typecheck/测试全绿,属卫生问题 | **已处置(2026-10-16,`a188b5d82e`)**:镜像 beta 声明(dependencies @ 0.2.1-alpha.1),yarn.lock 仅增一行记账(root resolution 与 vendored tarball 均既有);处置后残余差异 5 项,全为零 import 结构性缺席;immutable/vendored-runtime/layout 测试 43/43/client typecheck/守卫全绿 |
| F-4 | **checkpoint 声明的精确性**:「dep profile matches beta's exactly」只对共享 dep 的版本钉成立,key 集合在 checkpoint 时点即不一致(148 vs 160) | 已在 §1 矩阵如实订正;无需代码动作 |

**主工作树在途改动的测量污染(记录,非发现)**:主树实测全量套 1 红(`test-port-mapping.spec.ts`,证据行 `automations-host.spec.ts:815` 被在途编辑移位)与守卫名额 24,均量在脏树上;干净树复测证明两者皆非 HEAD 缺陷。主树另有 24 个字体文件删除等在途工作(本句登记时误计为 26,2026-10-16 处置 A 组时实测订正),未被本复核触碰。

## 5. 收口结论

- checkpoint 的 verify-as-I-go 义务由本次复核**收口**:运行时主张在 HEAD 全部复测成立;两处已知问题(守卫红、Task 2.5 缺口)确认已在后续提交闭环;静默丢弃扫描除已登记的 darwin picker 外**无新增发现**。
- 开口项后续处置:F-1 已由 `424ac705d4` 提交收口;F-2 经订正后于 `a9b682eb36` 裁定「保留收窄」并补钉收口;F-3 已由 `a188b5d82e` 声明依赖收口。三个开口项全部闭。
- 复核自身的临时 worktree 已清理,主工作树零改动(本文件除外)。

## 6. 主线推送记录(2026-10-16,裁定 R-M8-4 单次推送)

本文件所在提交随本段描述的单次推送入库;推送范围 = `origin/master`(`147cbd39d2`)之后的提交,含 2026-10-16 会话前的 4 笔市场/vendor/守卫维护提交(市场 1.66.22 ×2、桥刷新、setZoomLevel 白名单)与本复核及收口链 11 笔(上文 §4–§5 各 SHA,另含工作树收口三笔:`3943e3b5f9` 字体裁剪、`ac9b57b1f6` 工作区热切换 + createAndOpen、`9a0d895c67` LLM 超时与补答,以及 whitespace 门禁修复一笔)。

推送前门禁读数(均为提交态、非工作树):

| 门禁 | 读数 |
|---|---|
| `check:whitespace`(BASE_SHA = merge-base) | exit 0(修复 `workspace.spec.ts` 文件尾空行后复跑) |
| huaanwork 全量套件 | exit 0:2608 tests(2595 pass / 13 skip) |
| huaanwork typecheck(5 projects) | exit 0 |
| `check:desktop-variants` | 绿:守卫 11/11,allowlist 9(0)/24(6) |

工作树收口三笔提交各自的验证细节在各自提交信息里;`3943e3b5f9` 同批订正了 §4 下方登记段的字体计数笔误(26→24)。

### CI 对账(run `38911832693`,终态 cancelled)

推送触发 CI run `38911832693`(commit `b9406e731b`)。终态读数于 2026-10-17 订正。未另标的时间是 UTC,北京时间 = UTC+8。

- **CI 额度已于 10-11 恢复**:run `38100060421` 在 2026-10-11 08:55:18(北京时间,`2026-10-11T00:55:18Z`)开始,workflow 更新于 `2026-10-11T01:18:28Z`,已正常执行约 23 分钟。这不是 spending-limit 跳过。该 run 自己的结论仍是 failure(`check` 为断言失败,不是下面的守卫红)。2026-10-10 的额度跳过(例如 run `38033205707` 的产品 job 全部 skipped)从这次起不再出现。
- **11 个展开格中 10 格绿**:`changes`、`upstream-command-windows`、`desktop-windows` ×3(huaanwork 6m17s)、`desktop-macos` ×3(huaanwork 14m32s)、`desktop-linux` ×2。huaanwork 只在 Windows 和 macOS 上构建;Linux 只有 `dsh-plugin-desktop` 与 `dsh-plugin-desktop-beta`。
- **`check` job 的根 gate `Run yarn check` 绿**——2026-10-11/12/13/14 **四连败**的根因实锤为 setZoomLevel 守卫红。四次 failure 日志均为 `Desktop variant source drift is not declared`,精确到 `[beta↔huaanwork] src/electron-shell-generation.ts`。10-11 那一次是提交 `f9fd375243`(run `38102194100`),加上 10-12 `38314604265`、10-13 `38408266786`、10-14 `38578361070`。四次 `check` 都在约 2 分钟早夭,未及 Next 步。修复 `1ce000b99c` 随本次推送在 CI 生效(`upstream-command-windows` 与 `check` 的守卫步均转绿)。
- **Next 四步验证:前三绿(`window-controls` 42s、`onboarding` 24s、`protocol` 3s)。`sidebar-browser` 自 `2026-10-16T14:10:18Z`(UTC,北京时间 22:10:18)挂起,脚本 45s deadline 没有日志。** 该步骤在本 fork 当时从无绿色先例(10-10 额度 skip;上述四连败的 check job 在 2 分钟早夭,未及 Next 步),属 R-M8-2 Next 基座观察项的首次暴露。本批推送对 `dsh-desktop-next/` 仅两处依赖钉刷新(桥 tarball 文件名、dshmarket 版本,`109cf90918`/`5ca2d0e72a`),无行为改动。
- **终态 = cancelled(6 小时默认超时),不是 failure。** `check` 从 `2026-10-16T13:57:31Z` 到 `2026-10-16T19:57:56Z`;步骤 `Verify Next native sidebar Browser in Electron` 结论 cancelled。取消时列出的孤儿进程是 xvfb-run、Xvfb 和两个 node,没有 Electron pid 17319。日志在启动后约 1 秒停在 `(node:17319) electron: Failed to load URL: http://127.0.0.1:44059/first with error: ERR_BLOCKED_BY_RESPONSE`。
- **2026-10-17 xvfb 复现订正了「Electron 加载 /embed 后退出、外层仍在等」。** 同一命令下 Electron 主进程一直存活,45s `setTimeout` 不执行。`/first` 的 `ERR_BLOCKED_BY_RESPONSE` 是 `/embed` 页面里的 iframe 被 `frame-ancestors 'none'` 拒绝,断言本来就要求这次嵌入失败。卡住的位置是 `guests.bind(window)` 没有传入 `attachInput`:访客 `dom-ready` 抛出未捕获的 `TypeError: attachInput is not a function`,Electron 的 JS 事件循环停住,npm CLI 只等子进程 `close`,所以外层一直等。补上 no-op `attachInput` 后,同一 xvfb 命令约 2 秒打印通过并退出。
- `57a675ad5c` 触发的 run `38979201338` 只走了文档快速通道(`changes` 将改动判为非产品路径,`check` 只执行 Documentation-only gate,desktop 与 upstream 任务全部 skipped),没有验证产品代码。
