# 2026-10-17 Runtime 兼容补丁 alpha.5 处置清单(21/21)

> **性质**:升级前置评估(规划工件),不落地任何代码改动。
> 背景:新一轮上游同步评估(2026-10-17 对账,fork 落后 upstream 116 提交、子模组落后 4 个 alpha)判定 `patches/` 下 21 个 `*@0.2.1-alpha.1.patch` 全部钉死在旧版本,升级后 sync 脚本**静默回落为无补丁解析**(check 模式亦不报错)。本清单对 21 个补丁逐一核对 alpha.5 源码,给出「已吸收 / 需重做 / 可放弃」三态判定。

## 0. 口径与基线

- **评估时刻 (As-Of)**:2026-10-17(`git fetch` 后)
- **旧基线**:子模组 pin `5badb15009`(dsh-v0.2.1-alpha.1),`vendor/dsh-runtime/0.2.1-alpha.1/`(321 包),`patches/` 21 个 `*@0.2.1-alpha.1.patch`
- **新基线**:`deepseek-harness` `origin/master` = `1517a4dbca` = **dsh-v0.2.1-alpha.5**(alpha.5 之后无新增提交)
- **方法**:Read 补丁全文 → 定位子模组包源码 → `git diff 5badb15009..origin/master -- <包路径>` + `git show origin/master:<file>` 逐 hunk 对照 → 全仓 `git grep <补丁引入符号> origin/master` 验证是否被吸收。**吸收判定的证据口径(2026-10-17 GLM 评审订正)**:并非所有补丁符号在上游零命中——`pickNativeDirectory`(7 文件,上游自有包 `packages/host/directory-picker-native` 的同名符号)、`optionalBundles`(5 文件,上游 scripts 与 agent note)、`data-conversation-header`(3 文件,上游 `-leading`/`-corner` 前缀子串)、`resolvePackageManifest`(1 文件,web 测试同名助手)均有命中,但均为同名异码/上游自有,**不构成吸收**;其余符号(`readPatches`/`plugins.overview`/`desktopPermissions`/`exclusiveBundles` 等)零命中。附注(2026-10-17 二轮订正):上游自有包 `packages/host/directory-picker-native` **并非本轮新增**——2026-07-28 `5579b13503` 创建、首见 `dsh-v0.1.0-rc.7`,**alpha.1 树已包含**(`git ls-tree 5badb15009 packages/host/` 实测),本窗口仅演进 9 文件 +100/−42。「重做 #4 前先核对能否复用」的建议仍成立,但理由应表述为:**fork 在 alpha.1 选 bridge 方案时上游原生选择器(native capability 经 subprocess)已并存,重做是重新评估取舍的时机**,而非「本轮新增」。
- **补丁形态注意**:补丁打在构建产物 `lib/index.js` 上,对照以 `src/` 源码为准;重做产物路径(chunk 哈希、双构建出口)以 alpha.5 实际构建结果为准

## 1. 总体结论

| 判定 | 数量 | 说明 |
|---|---|---|
| 上游已吸收 | **0** | 21 个补丁引入的符号经 origin/master 全仓 grep 核对:`readPatches`/`plugins.overview`/`exclusiveBundles`/`desktopPermissions` 等零命中;`pickNativeDirectory`/`optionalBundles`/`data-conversation-*`/`resolvePackageManifest` 有命中但均为上游自有符号或同名异码,**不构成吸收**(口径详见 §0 方法条) |
| 需重做 | **21** | 难度小 16、中 3、中-大 2(dsh 核心补丁的 hunk① 属小、hunks②③ 属中,**按补丁计整体入「中」一档**,不重复计数) |
| 可放弃 | **0** | 21 个目标包在 alpha.5 全部存在;仅 `dsh-subagent-in-process-driver`(非补丁对象)被上游删除,另见消费面评估 |

**工作量估算:约 7–9 人日**(小 ×16 ≈ 2–3,中 ×3 ≈ 1.5–2,中-大 ×2 ≈ 3–4)。无吸收/放弃的不确定性,全部是确定性移植。

**hunk 计数口径**:补丁多同时打 lib 主产物与 lib/types 的 d.ts 产物;本文 hunk 数记「全部目标文件合计」,括号内注明主产物 hunk 数。

**重做顺序建议**:先 2 个中-大(slot/钩子形态由上游新结构决定)→ dsh 核心 + hmr + ptc(机制类,影响面大)→ 16 个小补丁批量过 → 每个补丁落地后跑 `check:vendored-runtime` + 对应包测试。

## 2. 难度小(16 个,锚点基本原位,机械重打)

| # | 补丁 | 意图 | alpha.5 证据与备注 |
|---|---|---|---|
| 1 | dsh-app-boot | ProfileContext 注入 `readPatches`/`resolvePackageManifest` 启动器钩子 | `profile-context.ts:74` `readProfilePatches` 仍在但函数体重写(经 `readBundlePatches`);早退插在函数顶部即可。`compatibility-preflight.ts:29` `manifestOf` 同形,`bare` 提前声明需按新版面重排;d.ts 重新生成 |
| 2 | dsh-client-modules | `newlineCount` 性能优化(indexOf 循环) | `src/index.ts:348-351` 仍是 alpha.1 原样实现。注意 alpha.5 该包拆了 Node/browser 双构建(`e137ebaaa1`),需验证两条产物路径 |
| 3 | dsh-client-ui-conversation | 会话头部 `data-conversation-header`/`data-conversation-title-row` 定位钩子 | `ConversationHeader.tsx:18-23`、`ConversationSession.tsx:69` 无属性,JSX 结构与 alpha.1 几乎一致(skeleton/ 子目录 **alpha.1 已存在**,非本轮迁入) |
| 4 | dsh-client-ui-directory-picker-browse | 原生选目录(`__DSH_DESKTOP_PICK_DIRECTORY__`)+ 打开前校验,13 hunk(lib/client.js 9) | 包仅 4 文件外围改动,核心源码未动,锚点原位;`browser.nativePicker` 文案注意 alpha.5 i18n 字典已精简(`c7d61ecc11`)。另:上游自有原生选择器包 `packages/host/directory-picker-native` **alpha.1 已并存**(非本轮新增,见 §0 附注)——重做是重新评估 bridge vs 上游原生方案取舍的时机,先核对能否直接复用 |
| 5 | dsh-client-ui-primitives | 宽表格常显细滚动条 | `MarkdownText.module.css:208-217` 与补丁前文逐字相同;`:221` 的 `:focus-visible` 规则 **alpha.1 已存在**(非本轮新增),无需联动 |
| 6 | dsh-client-ui-settings-general | `desktop` 设置分区专属 SVG 图标 | `SettingsRoot.tsx:32-38` **alpha.1→5 零改动**;直接在 `:36` 附近重加 `if (id === 'desktop')` 分支 |
| 7 | dsh-client-ui-settings-shell | Windows `desktop-windows-pwsh-sandbox` 第三控制器 | `index.ts:47-52` 结构同形;**以 alpha.5 的 `order: 40` 为基底,勿回退成 10** |
| 8 | dsh-client-ui-sidebar | `data-sidebar-header-controls` 标记属性 | `HeaderLeadingControls.tsx:30` 根元素零改动,一行属性 |
| 9 | dsh-experimental-computer-use-cua-driver-native | `check_permissions` 接桌面 `desktopPermissions` 服务 | `src/index.ts:103-109`/`:133-137` 锚点逐字对应;升级后确认桌面侧服务注册键名未变 |
| 10 | dsh-host-directory-picker-browse | Windows reparse/系统目录 stat 失败按「不可进入」跳过 | `src/index.ts:157-176` 原逻辑未动;**保留既有的 abort 重抛**(`signal?.aborted` 重抛 alpha.1 `:169` 起即有,非本轮新增) |
| 11 | dsh-host-open-in-app | 剥除子进程环境 `ELECTRON_RUN_AS_NODE` | `resolver.ts` alpha.1→5 **零 diff**;两 hunk 是同一份源码的两份构建出口,只改 `src/resolver.ts` 一处;`...options.env` 展开顺序不要动 |
| 12 | dsh-plugin-manager | `dsh.optionalBundles`/`dsh.exclusiveBundles` 清单驱动 bundle 管理 | 锚点文本未变但行号漂移(:291/:749 → :329/:823,`src/index.ts` +163/−56、净 +107),**以符号锚定勿用行号**;⚠️ 上游 agent note `2026-09-15-shipped-optional-bundles.md` 明载「`dsh.optionalBundles` 清单形态是 first form,维护者选择把产品决策留在代码里」——**与 #17 同属「与上游明示取向相左」的永久 fork 差,须同等登记**,否则未来同步该文件会反复冲突 |
| 13 | dsh-plugin-package-inventory-deepseek | asar 包清单解析(asar-module-resolver 符号探测) | `src/index.ts:74-84` `barePackageManifest` 逐字相同,hunk 几乎原样平移 |
| 14 | dsh-subprocess-local | Electron 宿主下私有 runner 强制 Node 模式 | `runner-launch.ts:66-84` 逐字相同;上游桌面的解法(`apps/desktop/src/node-environment.ts`)不覆盖私有 runner 路径,补丁继续必要 |
| 15 | dsh-web-app | opener 环境旗标剥离 + `windowsHide: true` | hunk② `env: scrubbedParentEnv(),` 原位可平移;hunk① 程序体新增 win32 launcher 等待逻辑,上下文行需用 alpha.5 新文本 |
| 16 | dsh(核心)hunk① | `manageDesktopProfile` 时跳过 `rejectElectronProfile` | `apps/cli/src/args.ts:183` 仍裸调用;上游 `apps/desktop-host/src/cli.ts:16` 同向演进,**未来有被吸收可能**,重做时留意。**计数口径**:本补丁整体计入 §3.3 的「中」档,本行仅为 hunk 级拆解,不占小档名额 |
| 17 | dsh-sandbox-windows-acl | DACL 仅 Modify 的目录先补 WRITE_OWNER ACE 再重试授权 | 包 src 零改动;⚠️ **上游刻意不做自愈**(README.md:130 明示 loud failure + 诊断 skill)——本补丁是与上游设计取向相左的**永久 fork 差**,重做时须登记,勿静默重打 |

## 3. 难度中(3 个,机制有结构性漂移)

### 3.1 dsh-hmr
- **意图**:无 `--expose-internals` 的 public-loader 嵌入跑 HMR(仅模块 HMR 才要求 internals)
- **关键问题**:alpha.5 `Service.init` 头部新增 `const mainJob = this.mainJob()`(`index.ts:349`),`mainJob() → esmJob() → hasEsmCache() → Reflect.get(this.internal, ...)` 在 `this.internal === undefined` 时直接 TypeError——alpha.1 的 init 无此前置解引用,**旧两 hunk 方案不再够用**。且 `private internal: ModuleLoader`(`:231`)非可选类型,条件放宽后 TS 收窄报错
- **重做要点**:同时对 `mainJob`/`hasEsmCache` 加空值守卫(或 init 头部跳过)+ 类型放宽

### 3.2 dsh-ptc-runtime-node
- **意图**:Electron utility process 无 `ELECTRON_RUN_AS_NODE` 可继承,构建 PTC 子进程 env 时显式补
- **关键问题(2026-10-17 评审订正)**:alpha.5 新增持久 PTC(`src/persistent.ts:192-196`,该文件 alpha.1 **不存在**)有**同构 env 过滤块**,alpha.1 补丁不可能覆盖它——这是本轮的**唯一真实增量**。原稿把上游 `a66d81e33f`(把 `ELECTRON_RUN_AS_NODE` 从 `STARTUP_ENVIRONMENT_NAMES` 白名单删掉改显式过滤)记为本轮变化并据此说「补丁从『仍需』升级为『硬需求」',**有误**:该提交(2026-09-16)首发布于 `dsh-v0.1.6-alpha.2`,**alpha.1 pin 已包含**(alpha.1 `src/index.ts:230` 已有同一显式过滤)——该补丁在 alpha.1 时就已是硬需求
- **重做要点**:`src/index.ts:224-227` 与 `src/persistent.ts:192-196` **两个现场必须同补**,漏一个持久 PTC 起不来

### 3.3 dsh(核心)hunks②③
- **意图**:`runProfile` 把 `options.resolvedProfile.readPatches` 透传进 `profileContext` + d.ts 补字段
- **关键问题**:机制完全未吸收,但承载代码大改——`profileContext` 块移入 `runProfile`(`profile-boot.ts:314-322`)并扩字段;`ProfileContext` 接口(`profile-context.ts:15-33`)改**全 readonly**
- **重做要点**:①`ResolvedProfileRuntime` 加 `readPatches?: ProfileContext['readPatches']`;②profileContext 字面量加条件展开(位置在 packageManager 展开项之后、dir 之前,与 alpha.1 补丁一致);③接口新增字段必须写 `readonly`

## 4. 难度中-大(2 个,本轮真正的重头)

### 4.1 dsh-client-ui-plugin-manager
- **意图**:5 个桌面 slot(`plugins.header.leading`/`plugins.overview`/`plugins.bundle.hidden`/`plugins.item.hidden`/`plugins.bundle.actions`)+ `renderComponents` 复合渲染 + 隐藏集合进 ConfigLedger,23 hunk(lib/client.js 16)
- **关键问题**:alpha.5 `PluginManagerPage.tsx` **单文件 +338/−92**(整包 25 文件 +1772/−256,原稿误用整包 diffstat):Installed/More 双 tab 模型,`listed` 过滤从 `optional` 改为 `official`,`ordered/pinned/more` 三段拆分(`60328899e5`/`b227127d62`/`3de3a977e0`)。**补丁「双列表」语义被上游新结构覆盖**
- **重做要点**:隐藏集合挂到新的 more/official 过滤链而非旧双变量;`PluginSidebarControl`/`data-plugin-page-header` 插入点对窄宽重排(`ee558c82d7`)重新定位

### 4.2 dsh-client-ui-settings-account
- **意图**:`dshDesktopSetup` 扩展——桌面 onboarding 组件抽取 + `onboarding.desktop.before` slot + `readOnboardingApiKeyPresence` 无 bridge 回退 + `openDesktopLogin`,7 hunk(lib/client.js 6)
- **关键问题**:包大改(55 文件),所有 hunk 锚点搬迁;`DesktopOnboardingEntry` 签名已改(`setVisible` + hooks 注入);`readOnboardingApiKeyPresence` 拆到 `onboarding-credentials.ts:7` 仍是纯 bridge 版
- **重做要点**:ctx 回退需改签名并在调用点包闭包(`index.ts:261` 以无参函数传入 controller);须与上游新增的凭据刷新失效机制(`credentials/reference-updated`)及 Web 账号登录(`8ee22c3668`)共存

## 5. 关联阻断项(非补丁,但同批处置)

本清单只覆盖补丁层;同一升级还有三个硬阻断项(详见会话评估,建议在立项文档中并列登记):

- **A1**:`dsh-subagent-in-process-driver` 被上游删除(**`3d852a1cea`**,2026-09-17「unify local and external activation lifecycles」,**alpha.1→alpha.2 窗口**,alpha.2 tag 已无此包;原稿误记为 `5ca7f533e1`——该提交(2026-09-21)只重构 activation-driver.ts,未删包),四个插件包 `package.json` 各引用一行(huaanwork 在 `:329`),`sync-vendored-runtime --check` 直接 fail ⇒ 裁定为删行或按上游 `bundle/base` 新组成换成 `dsh-subagent-fork-in-process`/`dsh-subagent-spawn-in-process`
- **A3**:cordis 家族外层钉版(`4.0.5-alpha.1` 系)须随上游升到 `-alpha.2` 系(含 cosmokit、community-market 的 `"4.0.4 || 4.0.5-alpha.1"` 区间),否则 yarn 装出两份 cordis 单例
- **验证链**:`upstream:prepare-runtime` → 裁 A1/A3 → `sync-vendored-runtime --write`(beta + huaanwork)→ 本清单 21 补丁 → `install --immutable` → `check` → `typecheck` → `test` → 真机冒烟(登录凭据优先级反转、市场插件重复安装报错语义、迁移幂等、profile-boot 断言)

stable 通道钉在 0.2.0-rc.2,不在本次区间;bump 只动 beta/huaanwork。

## 6. 评审订正记录(2026-10-17,GLM 评审 × 本仓 git 核实)

GLM 对本文件提出 6 处 issue,经逐条在子模组(`git show`/`git diff`/`git merge-base --is-ancestor`/`git grep`)与外仓 `patches/` 上独立核实,**6 条全部成立**,已全部订正:

| # | 指摘 | 核实结论与订正 |
|---|---|---|
| 1 | §5 A1 提交号与窗口双错 | ✅ 成立。`3d852a1cea`(2026-09-17)删除该包 **14 个文件、2515 行**(`git diff-tree -r --name-status` 实测 14 条 D;初稿核实时用 `grep -c` 数 `--stat` 输出得 7,系 stat 长路径缩写为 `.../` 吞掉匹配串所致的**核实方法缺陷**),alpha.2 tag 树已无此包;`5ca7f533e1`(2026-09-21)对该包零触及。已订正 |
| 2 | §3.2 `a66d81e33f` 归因错误 | ✅ 成立。`git tag --contains` 首见 `dsh-v0.1.6-alpha.2`,`merge-base --is-ancestor` 确认 alpha.1 已包含,alpha.1 `index.ts:230` 已有显式过滤。「升级为硬需求」表述删除,本轮真实增量仅 `persistent.ts` 第二现场(`git cat-file -e` 确认该文件 alpha.1 不存在)。已订正 |
| 3 | §1「零命中」表述不实 | ✅ 成立。`pickNativeDirectory`(7 文件)/`optionalBundles`(5)/`data-conversation-header`(3)/`resolvePackageManifest`(1) 在上游均有命中,均为同名异码或上游自有,「0 吸收」结论不变但证据口径已改写为「有命中但不构成吸收」 |
| 4 | 三处假「新增」 | ✅ 全部成立。`skeleton/` 子目录(alpha.1 ls-tree 已有)、`:focus-visible` 规则(alpha.1 `:221` 已有)、abort 重抛(alpha.1 `:169` 已有)。三处均已订正;#10「保留 abort 重抛」的建议本身仍正确,保留 |
| 5 | 数字口径 | ✅ 全部成立。dsh 补丁双计(小 17+中 3+中大 2=22)→ 改为 16/3/2=21 并注明口径;`PluginManagerPage.tsx` 单文件实为 +338/−92(+1772/−256 是整包 25 文件);plugin-manager `src/index.ts` 实为 +163/−56(净 +107,原「+219」是 diffstat 行数);hunk 计数统一为「全部目标文件合计(主产物)」:settings-account 7(6)、plugin-manager 23(16)、directory-picker-browse 13(9)。已订正 |
| 6 | #12 应与 #17 同等登记「与上游明示取向相左」 | ✅ 成立。上游 agent note `2026-09-15-shipped-optional-bundles.md` 明载清单形态被评估并否决(「maintainers keep product decisions in code」)。已在 #12 行内补「永久 fork 差、须同等登记」警示 |

**教训登记**:初稿由 3 个并行子代理分组产出,汇编者(本会话)未对子代理的关键断言(提交归因、行号归属、diffstat 口径)做独立核实即落盘——违反「代码断言先核实再引用」纪律。后续此类清单在落盘前,对「提交号/窗口」「diffstat 归属(单文件 vs 整包)」「新增 vs 既有」三类断言必须抽查核实。

### 第二轮(GLM 复审订正轮引入的新错误,2026-10-17)

GLM 复审发现**第一轮订正提交本身又引入 4 处错误**,核实后全部成立并已订正:

| # | 指摘 | 核实结论与订正 |
|---|---|---|
| 1 | §0/§6 附注称 `packages/host/directory-picker-native` 是「本轮新增」——不实 | ✅ 成立。该包 2026-07-28 `5579b13503` 创建、首见 `dsh-v0.1.0-rc.7`,`git ls-tree 5badb15009` 确认 **alpha.1 树已包含**;窗口内仅演进(实测 9 文件 +100/−42;GLM 给的 13/+117/−47 与实测有出入,以实测为准)。§0 附注、#4 行、§6 #3 行三处「本轮新增」表述已全部改写为「alpha.1 已并存,重做是重新评估取舍的时机」 |
| 2 | §1「已吸收 0」行仍写「零命中」,与已订正的 §0 自相矛盾 | ✅ 成立。第一轮只改了 §0 方法条,漏改 §1 表格行的同一断言。已改为「有命中但不构成吸收」口径 |
| 3 | §1 重做顺序「15 个小补丁」off-by-one | ✅ 成立。小档改为 16 后此句漏改(16/3/2=21 自洽,「15」是旧口径残迹)。已订正 |
| 4 | §6 #1「7 个删除文件」数字错 | ✅ 成立。实测 `git diff-tree -r` 为 **14 个文件、2515 行**;初稿的 7 来自 `grep -c` 统计 `--stat` 输出——stat 对长路径缩写为 `.../` 吞掉了匹配串,是**核实方法缺陷**而非 head 截断(GLM 推测的原因不准,数字对)。已订正并注明 |

**修订为何引入新错误——三条机制性原因**:

1. **订正动作自身豁免了核实纪律**:§6 刚登记「新增 vs 既有」类断言必须核实,同一提交里就把 `directory-picker-native` 写成「本轮新增」——该断言来自核实 #3 时看到 grep 命中后的即兴推断,没有 `git log`/`ls-tree` 验证包的历史。教训:**订正补丁与正文适用同一核实标准,「顺手补充的观察」也要核实**。
2. **改断言不做全文件扫尾**:同一断言(「零命中」「15 个」)在文档多处出现,第一轮只改了最先看到的一处。教训:**订正前先 `grep` 旧表述在全文的所有出现点,列清单逐处改**,而非发现一处改一处。
3. **核实命令本身有损耗**:`grep -c` 打在被路径缩写的 `--stat` 输出上得到假计数。教训:**计数类断言用结构化输出(`diff-tree -r --name-status`)而非对展示用输出做文本匹配**。
