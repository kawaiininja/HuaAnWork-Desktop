# 《HuaAnWork 单桌面、单代码维护两阶段设计》设计评审意见

- **评审对象**：`docs/superpowers/specs/2026-10-26-single-desktop-maintenance-design.md`
- **评审日期**：2026-10-29
- **评审方式**：第二轮复核稿。第一轮为口头意见；本轮对每条结论在源码上重新取证、专项排查误报与夸大（见 §一），全部核对在 master `b5ef3e84a7` 上进行（设计自带基线 `1895210b74`，其后 18 提交，见 F-3）
- **评审结论**：**有条件通过**——设计方向与两阶段框架成立，事实性声明逐条核对无一失实（两处初评表述过宽已收窄订正）；存在 **Major×1**（Phase B 开工前必须裁定）与 **Minor×4**、**Question×2**。处置顺序见 §五。

> **2026-10-29 后续核查订正**：F-1、F-2、F-5、F-7 的严重度、现状和口径以 §七为准，其余结论维持。设计正文已按该节同步修订。

> **2026-10-29 修订复审（§八）**：对设计修订稿与 §七 订正的第四轮复审——7 项发现全部落实，§七 六项订正逐条取证成立（含实跑守卫证实当前 0 缺项、`--write` 无自动化调用点）；新发现 N×4（不拦）。**结论：通过，设计可批准进入实施计划。**

> **2026-10-29 终审（§九）**：第三轮设计修订将 §八 残余 N-1/N-2/N-3 全部采纳并逐条核实无误（含「静默退化为空报告」新断言的源码证实）；唯一开口 N-4（ci.yml 过时注释，代码侧备查）。**结论：终审通过，设计定稿，可进入实施计划。**

---

## 一、复核说明（第一轮意见的二次核查处置）

| 第一轮意见 | 处置 | 复核要点 |
|---|---|---|
| F-1 market peer range 硬耦合（Major） | **维持**，两处订正 | ① 退化值确切形态是 `" \|\| 0.2.1-alpha.1"`（`Array.join` 把 `undefined` 转空串，首段为空；初评误写为 `"undefined \|\| …"`），已用 node 按脚本原式复算证实；② 补录 write 路径危害：`sync-vendored-runtime.mjs:170` 会把退化串写进 `dsh-community-market/package.json`，Phase B 期间一次顺手 `--write` 即污染清单 |
| F-2 本机 smoke 豁免口径（Minor） | **维持**，机制补精确 | 守卫未 provisioning 时 `exit 1`（`huaanwork-verify-provisioning.mjs:221-222`）；仅 `--smoke` + `HUAANWORK_ALLOW_UNPROVISIONED_SMOKE=1` 才 `exit 0` 并打印「不构成 provisioning、不得用于发行」横幅（`:209-219`，裁定依据 R-M7-8）；CI 对同一命令显式带该 env（`ci.yml:311`，注释载明 R2 部署位未交付、缺 4 项） |
| F-3 元数据过时（Minor） | **维持**，计数订正 | 基线以来 **18** 提交（`git rev-list --count 1895210b74..master`；初评的 22 是按日期口径、含基线当日更早提交，已订正）；分支本地与 origin 均已不存在；**PR #21 未触及任何根工具**（diff 无 `verify-desktop-variants` / `upstream-sync-dashboard` / 任何 `package.json`）⇒ 设计事实面未被这 18 提交扰动，本轮 §二全部在现 HEAD 重取 |
| F-4 §4 漏列 fabric（Minor） | **维持** | §4 保留清单无 `dsh-community-fabric`，而它仍在 workspaces 且挂在根 `check` 链 |
| F-5 AGENTS.md 幽灵规则（Minor） | **维持**，补实证 | `dsh-plugin-huaanwork/tests/package.spec.ts:34` 读 root `expected-root-gate-scripts.json`、`:87`/`:169` 运行时读取 `dsh-plugin-desktop/package.json`——阶段 A 改根脚本 ⇒ 该清单必变 ⇒ 断言必改，§5.3 工作面真实 |
| F-6 守卫退役语义（Question） | **维持**，数字订正 | 三包 src/ 逐字节相同现值 **164**（2026-10-29 本地实测，与 dashboard Scope B 同口径；债表 M23 的 162 系 2026-10-03 值，已漂移）；另补 dashboard 对 `PAIRS` 的 import（`upstream-sync-dashboard.mjs:22`）与三包磁盘扫描（`:123-131`）依赖 |
| F-7 移植载荷预估（Question） | **维持**，定位明确为建议非缺陷；出处订正 | 「6 类 hunk × 28 文件 = 63 处」系 **M7 Task 6.3 spike**（2026-10-07，债表「上游同步例外」行）；「21 补丁重做 ≈7–9 人日」系 **M9 A2 处置清单**（2026-10-17）——初评把两者都归到 M9 spike，已订正 |
| 初评「huaanwork 对参考树命中全部是字符串字面量、零依赖」 | **订正（收窄）** | `src/` 内确为字符串字面量（`product-identity.ts:5/:12` 身份项、`client/styles.ts:60-61` CSS 溯源 dataset）；但 `tests/package.spec.ts:87/:169` 存在对 stable 清单的**运行时 readFileSync**——属测试面而非产品运行时，设计 §5.3 已列改造；初评「零命中」表述过宽 |

## 二、事实核查（设计 §1/§5 现状声明逐条）

| # | 设计声称 | 结果 | 出处 |
|---|---|---|---|
| 1 | 四桌面均为活跃 workspace；根 build/typecheck/test/check 全含四桌面 | ✅ | root `package.json` workspaces 与 `scripts.build/typecheck/test/check`；`check:layout` 还串着 `check:desktop-variants`、`icons:check`、`verify-layout`、`test:gate-scripts`——阶段 A 的改动会级联到这四个子门 |
| 2 | market 与 AA 准备逻辑各维护四桌面清单 | ✅ | `scripts/prepare-dsh-market.mjs:8`（`MARKET_WORKSPACES`）、`scripts/agents-anywhere-release-policy.mjs:8`（`AA_WORKSPACES`）；AA 准备按清单读四包 manifest（`prepare-agents-anywhere-release.mjs:163`） |
| 3 | HuaAnWork 运行时不依赖另外三个桌面 | ✅（表述收窄见 §一末行） | `src/` 命中均为字符串字面量；测试面存在运行时读取（设计已列改造） |
| 4 | release.yml 产物只有 HuaAnWork，但根发布命令仍过四桌面 market/AA | ✅ | `release.yml` 两 job 走 `dist:mac-smoke:huaanwork`（`:94-95`）、`dist:win:huaanwork` / `dist:win-portable:huaanwork`（`:162-165`）；三条根命令均链式 `market:prepare` + `aa:prepare-release` |
| 5 | 分支 CI 用既有 workflow_dispatch，不放宽 push 自动化 | ✅ | `ci.yml:8` 已有 dispatch；`:52-53` dispatch 强制 `product=true`，恰好绕开 docs-only 分类歧义——设计选 dispatch 是对的 |
| 6 | 通用图标导出检查只覆盖 Stable/Beta/Next | ✅ | `scripts/export-app-icons.mjs:10-14`（`ICON_PACKAGES` 无 huaanwork）；`icons:check` 挂在 `check:layout` |
| 7 | huaanwork 无 Linux 发行线；移除 Stable/Beta 的 Linux 命令与 CI job | ✅（精度注记） | `ci.yml:229-237`（`desktop-linux` 矩阵：push/manual 为 stable+beta，PR 仅 beta）。注记：根 Linux 命令实际只有 `dist:linux`（stable 无后缀一条），并无 `dist:linux:beta`——设计 §5.2「Stable/Beta 的 Linux 命令」精确说是一条根命令 + 一个 CI job |
| 8 | AA-skip 处理只修改 HuaAnWork | ✅（现状对齐） | 现状 `ci.yml:103-112` 重写 stable/beta/huaanwork 三包 `package.json`（PR 时对 stable 特判）；设计改法与之衔接 |
| 9 | Windows/macOS 矩阵三桌面，huaanwork 另有 Host liveness | ✅ | `ci.yml:178`、`:277`、`:208-210`（`test:host-liveness-win`） |
| 10 | vendored runtime 现检查三通道；market 的 DSH 依赖由 beta 通道校验 | ✅ | root `check:vendored-runtime`（stable+beta+huaanwork）；`sync-vendored-runtime.mjs:61` 仅 beta 通道把 `marketPath` 纳入校验 |
| 11 | §7.2 是对 dashboard 的改造 | ✅（补充：必是重写非参数化） | `upstream-sync-dashboard.mjs:22` import `PAIRS`、`:123-131` 扫三包 src/、`:141-149` 解析 `docs/upstream-sync.md` §6——三包目录消失后 Scope B 与 PAIRS import 结构性不可用 |

## 三、问题清单（复核后）

### F-1（Major，Phase B 开工前必须裁定）`dsh-community-market` peer range 的构造硬耦合未进设计

`sync-vendored-runtime.mjs:68` 的 `marketPeerRange` 硬编码从 `upstream.json` 读 **stable+beta** 通道的 `sourceVersion`，拼出 `dsh-community-market/package.json` 全部 DSH peer 的现值 `"0.2.0-rc.2 || 0.2.1-rc.1 || 0.2.1-alpha.1"`（已实测逐字符吻合——该串是机器生成，非手写）。设计的覆盖情况：

- §5.3「同步归属从 Beta 改为 HuaAnWork」只覆盖 `:61` 的 `pluginPaths` 切换（beta 通道独占 marketPath → huaanwork 通道）。阶段 A 保留三通道（仅改 `activeChannel`）⇒ 构造不受影响，且 beta/huaanwork 同版本 ⇒ 值不变。**Phase A 无阻断。**
- §7.1 的消费方扫描只覆盖「旧 runtime resolutions、`vendor/dsh-runtime/`、`patches/`」，不含 market peer 串；§10 Phase B「清理旧通道与无消费方资产生成规则」未点名此处。

Phase B「`upstream.json` 只保留活跃通道」之后：`['stable','beta'].map(…)` 产生 `[undefined, undefined]`，`Array.join` 把 `undefined` 转空串 ⇒ 期望 peer 退化为 `" || 0.2.1-alpha.1"`（node 按脚本原式复算证实）：

- **check 路径 fail-closed**：`:222-232` 的 range 比对必红，不会静默——好。
- **write 路径危害**：`:170` 会把退化串写进 market `package.json`——Phase B 期间任何一次顺手 `--write` 即污染清单。

真正缺的是**裁定**而非修法：dsh-community-market 的最终 peer 语义有三个互斥选项——(a) 收敛 rc.1 单值（在装旧 stable/next 实例若仍加载该 bundle 会被 dsh 0.2 的 peer 校验拒绝；但 AGENTS.md 载明 huaanwork 对该包的运行时消费面仅 contracts，宽度的真实受益方须实施者确认）；(b) 保留历史腿（则 `marketPeerRange` 不能再从通道推导，须改为常量或显式字段）；(c) alpha.1 腿是否随 dormant lane 退役（脚本内注释已有「lane 退役时删除」的既有约定，恰可并入 §7.1 消费方扫描）。任一选项都是 §7.1 清单之外的一处显式改动 + 一个政策决定，设计应补裁定段。

### F-2（Minor）阶段 A 硬门槛第 5 条的 provisioning 豁免口径未写明

根 `dist:mac-smoke:huaanwork` 的第三步就是 `huaanwork-verify-provisioning.mjs --smoke`。未 provisioning 的机器上：不带 `HUAANWORK_ALLOW_UNPROVISIONED_SMOKE=1` 时守卫 `exit 1`（`:221-222`）——**门槛第 5 条按字面跑不起来**；带 env 则 `exit 0`，并打印「仍缺 N 项…unsigned/unprovisioned 冒烟制品…不构成 provisioning、不得用于发行」的诚实横幅（`:210-219`，R-M7-8）。CI 对同一命令显式带该 env（`ci.yml:311`；缺的 4 项 = 市场公钥 pin + 两个真实内网 origin 等，R2 部署位未交付）。设计 §6 第 5 条只写「本机 `corepack yarn dist:mac-smoke:huaanwork`」，未写带不带豁免、证据如何记录——不同实施者会产出不同性质的证据。建议与 §9「不夸大证据」对齐：写死口径（允许豁免，但证据须注明 unprovisioned，与 CI 同形）。

### F-3（Minor）设计文档元数据已过时：基线与实施分支

- 基线 `1895210b74` 之后 master 已进 **18 提交**（subagent-run-visibility 整支 + gitleaks allowlist）。
- 头部「实施分支：`refactor/huaanwork-single-desktop`」**已被占用**：该分支经 PR #21（merge `2222dce000`，2026-10-28）合并，载有 subagent-run-visibility 整支 + 本设计文档自身（`692f12f507`）。当前本地与 origin 均无同名分支。续用该名会让「分支 → 设计实施」的指称与已合并 PR 混淆。
- 缓和项（复核新增）：PR #21 未触及任何根工具（守卫、dashboard、package.json 零命中）⇒ 设计的静态依赖结论未被扰动，本轮 §二已全部在现 HEAD 重取证实。

处置：实施计划重钉基线为开工时 master；分支名显式续用（注明与 PR #21 的关系）或换名；设计文档头部状态行与分支指针随之刷新。

### F-4（Minor）§4 最终边界清单漏列 `dsh-community-fabric`

§4 枚举的保留输入不含 `dsh-community-fabric`，而它仍是 workspace 且挂在根 `check`（`yarn workspace dsh-community-fabric check`）。Phase B 删除范围明确只含三个桌面目录，fabric 不在其中——但枚举不完整易让实施者误判其去留。建议补一句。

### F-5（Minor）AGENTS.md 成片失效的流程规则需要显式清点交付

阶段 A 后成片失效的规则不止债表：beta-first 开发流（「Develop and validate Desktop feature changes in `dsh-plugin-desktop-beta/` first…」）、提交前 `check:desktop-variants` 门禁、`market:check`「for Stable, Beta, and Next」新鲜度口径、零触改规则、债表「上游同步例外」行（三包 tests 交叉读 root `scripts/expected-root-gate-scripts.json`）。§5.3/§10 虽有「Agent 规则改成单一活跃桌面」，建议实施计划把「AGENTS.md 流程段 + 债表逐行三整理（关闭 / 改写 / 保留）」列为显式交付物，防止留下引用已死命令的幽灵规则。

### F-6（Question）守卫退役的语义转换应明示，防后人误补

现值实测（2026-10-29）：三包 src/ 共有 205 文件、**逐字节相同 164**（债表 M23 的 162 系 2026-10-03 值）。变体守卫（beta↔huaanwork 65 项，M2 口径）退出活跃门禁后，「huaanwork 未吸收上游 2.1 功能面」（40 文件，M9 登记）与逐字节相同同步面的机器核对消失，替代机制 = `watchedPaths` + `docs/evidence/` 处置纪律。这在单桌面模型下是必然，但建议在 Phase B 完成定义或 `docs/upstream-sync.md` 改写时**明示这层「由守卫改为纪律」的转换**（含 dashboard 的 PAIRS import 与三包扫描退役），避免后人误以为丢了守卫该补回来。

### F-7（Question / 建议）选择性移植的首期载荷预估

出处订正后的参照数据：整仓合并冲突面 6 类 hunk × 28 文件 = 63 处（M7 Task 6.3 spike，2026-10-07）；单次版本 bump 的 21 补丁重做 ≈7–9 人日（M9 A2 处置清单，2026-10-17）。vendored runtime 钉版已隔离依赖面 churn，选择性移植的真实载荷 ≈ 上游桌面集成层（2.1 未吸收面中的 25 个分叉文件，M9 登记）。建议实施计划给出 `reviewedCommit..upstream/master` 的首期货架实测作为排期依据。

## 四、设计强项（维持）

1. 阶段间硬门禁 + 「SHA / CI run 落盘后才准开删」与 M8 大同步纪律同构，恢复点明确；
2. §6/§9 证据口径（Windows = CI 打包证据、macOS = unsigned smoke，不冒充签名 / 公证 / 真实多机）与 R-6 / R-ACCEPT-1 的措辞纪律一致；
3. `desktop-upstream.json` 的 `reviewedCommit` 语义（取最后完整合并点而非 tip、整批处置完才推进）正确防住「未处理提交被静默标记已审阅」；
4. 不 force-push、不推 master、未跟踪文件不裹挟、market/AA fail-closed 不绕过——与仓规逐条对齐；
5. Linux 处置诚实（删 job 而非伪造 huaanwork Linux 验证）；workflow_dispatch 选择恰好落在 CI 既有的 product=true 强制路径上（`ci.yml:52-53`）。

## 五、处置顺序与放行条件

1. **F-1（裁定）**：Phase B 开工前必须完成——三选一（rc.1 单值 / 保留历史腿改常量 / 随 alpha.1 lane 退役）并落进设计 §7.1 补段或独立裁定记录。**Phase A 不受此项阻断。**
2. **F-2 / F-3（口径）**：落实施计划前刷新——设计文档头部（基线、分支、状态行）与 §6 第 5 条（smoke 豁免写法）。
3. **F-5** 列入实施计划显式交付物；**F-4** 随手补一句。
4. **F-6 / F-7** 随 Phase B 的 `docs/upstream-sync.md` 改写与实施计划货架实测处理。

**放行条件**：第 1–2 步收口后，设计可批准进入实施计划。

## 六、复核环境与边界

- 只读评审：未修改任何产品文件；本轮唯一新增文件即本文档。
- 全部核对在 master `b5ef3e84a7`（2026-10-29）上进行；三包逐字节相同计数系本地实测（sha256 全量比对，与 dashboard Scope B 同口径）。
- 初评与复核的差异全部登记在 §一处置表——无发现撤回，四处精度订正（F-1 退化串形态、提交计数 18、逐字节相同 164、「零命中」收窄）。

## 七、后续核查订正（2026-10-29）

本节记录对第二轮复核稿的再次源码核查。前文保留为原始评审记录；实施时以本节及修订后的设计文档为准。

1. **F-1 核心事实维持，严重度与时点收窄。** `marketPeerRange` 对 Stable/Beta 的硬编码、Phase B 后的退化值及 check/write 两条路径均属实，设计必须显式处置。但正常根检查、构建、dev/start 和 market/AA prepare 只执行 `--check`，`--write` 是维护者显式手动操作，不是日常命令自动触发的环境污染。原列 (a)/(b) 是两种政策，(c) 的 alpha.1 退役是可组合的子决定，三者并非互斥。处置门改为“删除 Stable/Beta 通道元数据或执行 `--write` 之前必须完成”，不再阻断 Phase B 的调查和其他清理工作；定级以强 Minor 至轻 Major 理解，而非整个 Phase B 的开工阻断。另，“仅 contracts”只描述 HuaAnWork 内网 consumer face，不概括完整 market bundle 的运行时加载关系。
2. **F-2 的条件化建议维持，当前缺项断言撤回。** 未 provisioning 检出的退出码和 smoke 豁免机制描述正确，但当前 HEAD 的 market/update origin、公钥和 keyId 已非占位，静态守卫实测为 0 缺项；`ci.yml` 的“缺 4 项”注释及其在本评审中的复述均已过时。静态守卫通过不证明 R2 实际部署交付或 origin 可达。设计只需为仍有缺项的检出写明豁免命令和证据口径，不再暗示当前硬门槛必因 provisioning 失败。
3. **F-3 维持。** 基线后 18 提交、PR #21 和分支状态均已复核。“PR #21 未触及任何根工具”收窄为未触及本评审点名的 variant 守卫、dashboard 和 package.json；该 PR 另有根 CI workflow 与 `AGENTS.md` 改动。实施分支改用未消费的新名称，基线在实施计划开工时再次重钉。
4. **F-4 维持。** `dsh-community-fabric` 仍是 workspace 且挂在根 `check`，已补入最终保留边界。
5. **F-5 维持但按阶段执行。** 涉退休目录的活规则和债表条目需要显式“关闭 / 改写 / 保留”清点；zero-touch 在 Phase A 仍由“参考树 tracked 内容不变”强化，Phase B 删除目录后才彻底关闭，不概括为 Phase A 后全部立即失效。
6. **F-6 维持并补强能力边界。** 205 个三包共有 `src/` 文件、164 个逐字节相同等数字复算吻合。`watchedPaths` 与证据纪律替代的是覆盖和分诊，不提供移植完整性或等价性的机器验证；文档须明确这项能力损失，而不是把两种机制写成等价替换。
7. **F-7 的实测建议维持，载荷近似撤回。** 63 个冲突 hunk、21 个补丁约 7–9 人日的出处无误，但工作类型不同，不能直接折算选择性移植成本。“真实载荷 ≈ 25 个分叉文件”也不成立：既有功能对齐欠账是“新增 15 + 合并 25”，且不包含审阅基线后的新提交。首期排期只以 `reviewedCommit..upstream/master` 的实际货架和逐项裁定为准。

**订正后的放行口径**：设计的两阶段方向和“有条件通过”结论不变；F-2/F-3/F-4/F-5 已在设计与实施交付物要求中收口，F-1 是删除旧通道元数据前的强制裁定项，F-6/F-7 随上游同步文档和首期货架实测落实。

---

## 八、修订复审（对 2026-10-29 设计修订稿与 §七 订正，同日第四轮）

本节复审两件事：设计方按本文修订的设计稿（工作区未提交，+16/−8，触及头部元数据、§4、§5.3、§6、§7.1、§7.2、§7.3、§10），以及 §七 对第二轮意见的订正。前文保留为原始记录；当前有效口径以 §七、本节与修订后的设计稿为准。注：`git diff` 管道显示的 `���` 系显示伪影，设计稿文件本体干净（全文 grep U+FFFD = 0 处）。

### 修订稿采纳矩阵

| 发现（按 §七 订正后口径） | 修订处置（设计条款落点） | 复审评估 |
|---|---|---|
| F-1 peer range（§七 定级：强 Minor–轻 Major） | 设计 §7.1 前置门（删通道元数据或任何 `--write` 前须先裁定并改造；三腿框架 +「不得从待删通道推导」）；§5.3 澄清阶段 A 保留三通道、构造及值不变；§7.3 验收项；§10 表 | **采纳**。时点从「Phase B 开工前」移入阶段 B 内部前置门——认可：裁定的真实输入（Stable/alpha.1 腿的消费方证据）恰是 Phase B 调查产出；两个具体危害（check 必红、`--write` 污染）均被门挡住，且门把「任何 `--write`」纳入，比必要更保守 |
| F-2 smoke 豁免（§七 撤回「当前缺 4 项」） | 设计 §6 第 5 条 / §7.3 第 5 条的条件化豁免 + 证据口径新条（含「静态守卫通过 ≠ 部署交付」） | **采纳，与 §七 订正一致**。条件化措辞经实跑校验（见下表）：当前检出 0 缺项，门槛第 5 条不带 env 即可通过；豁免条款为未钉扎检出保留口径 |
| F-3 元数据 | 头部三行：分支换名 `refactor/huaanwork-single-desktop-maintenance`（注明旧名随 PR #21 不续用）、基线重钉 `b5ef3e84a7…`（开工时再钉）、状态行记修订 | **采纳**（基线 SHA 经 `git rev-parse` 核实） |
| F-4 fabric | 设计 §4 补条目 | **采纳**（「不声明可加载入口」与 AGENTS.md 原文一致） |
| F-5 AGENTS.md 清点 | 设计 §5.3 嵌入「关闭 / 改写 / 保留」逐行清点 +「不得以历史文档保留为由留活规则」 | **采纳并前置**；时序歧义见 N-1 |
| F-6 守卫退役语义 | 设计 §7.2 新段 | **采纳并加强**（明说 watchedPaths 不验证移植完整性与等价性） |
| F-7 载荷预估（§七 撤回「≈ 25 分叉」近似） | 设计 §7.2 新段：首期货架实测为排期依据 + 防换算条款 | **采纳并加强** |

### 对 §七 订正的再核查（逐条取证）

| §七 断言 | 核查结果 |
|---|---|
| F-2：「当前 HEAD 的 origin/公钥/keyId 已非占位，静态守卫实测 0 缺项；ci.yml『缺 4 项』注释过时」 | **属实**。实跑守卫（无 env 与 `--smoke` 两种）均 `exit 0`、三项全钉（market origin `http://market.intranet.lan:8787`、update origin `http://update.intranet.lan:8790`、公钥与 sha256 指纹一致）；真实钉扎落在 `4e1fa83ed0`「fix(huaanwork): pin the release market key and intranet origins」。第二轮 F-2「门槛第 5 条按字面跑不起来」对当前 HEAD 不成立，§七 撤回正确 |
| F-3：「该 PR 另有根 CI workflow 与 AGENTS.md 改动」 | **属实**。`git show 2222dce000 --stat` 含 `.github/workflows/windows-subagent-run-acceptance.yml +93`、`AGENTS.md +3`。第二轮「未触及任何根工具」的引导语过宽（括号内的守卫/dashboard/package.json 限定本身无误），收窄成立 |
| F-1：「`--write` 是维护者显式手动操作，非日常命令自动触发」 | **属实**。全仓唯一接线是 `check:vendored-runtime`（三条 `--check`）；`--write` 在 package.json、`.github/workflows/`、`scripts/*.mjs` 中零自动化调用点 |
| F-1：「(a)/(b) 是政策、(c) 是可组合子决定，三者并非互斥」 | **认可**。决定空间实为两个独立布尔（Stable 腿、alpha.1 腿各自保留/退役）；第二轮「互斥三选一」表述不准 |
| F-1：「『仅 contracts』只描述内网 consumer face」 | **认可**。AGENTS.md 原句语境即内网 consumer face；第二轮已同时标注「宽度的真实受益方须实施者确认」，属措辞收窄而非误报 |
| F-7：「『真实载荷 ≈ 25 个分叉文件』不成立」 | **认可**。对齐欠账是「新增 15 + 合并 25」（AGENTS.md M9 登记行）且不含审阅基线后的新提交，25 只是分叉子集 |

### 修订稿其余新引入断言核实

基线 `b5ef3e84a7…` = master HEAD ✅（`git rev-parse`）；「阶段 A 保留三通道、peer range 构造及值不变」✅（§一 F-1 复算）；豁免语义「仅当…仍有缺项时」与 `huaanwork-verify-provisioning.mjs:207-210`（豁免仅在 `problems.length > 0` 时被咨询）一致 ✅；fabric 描述 ✅；「新增 15 + 合并 25」✅；「watchedPaths 不验证完整性/等价性」构造上为真 ✅。

### 残余（N 级，不拦）

- **N-1（设计 §5.3 时序歧义）**：「阶段 B 删除目录后再关闭对应规则」未区分命令指向与目录指向——指向阶段 A 已退役命令的规则（`dev:beta`、`dist:mac:beta`、`market:check` 三桌面口径）按修订自身原则应随阶段 A 改写。建议实施计划说全：「命令指向随阶段 A 改写，目录指向随阶段 B 关闭」。
- **N-2（设计 §5.2 措辞）**：「Stable/Beta 的 Linux 命令」仍略宽（根 Linux 命令仅 stable 无后缀一条，无 `dist:linux:beta`；CI job 才是 stable+beta）。方向正确，实施计划必然触到真实命令集。
- **N-3（设计 §7.2 未点名）**：dashboard 的 `PAIRS` import（`upstream-sync-dashboard.mjs:22`）未点名；「Scope B 退役」已足够表意。
- **N-4（本轮新增，代码侧观察）**：`ci.yml:308-311` 的 R-M7-8 注释（「provisioning 实测缺 4 项」）与 `HUAANWORK_ALLOW_UNPROVISIONED_SMOKE=1` 已成无操作（守卫实测 0 缺项 ⇒ 豁免分支不可达）。注释现为失实描述，下次触碰 CI 时应订正；不属本设计范围，登记备查。

### 结论

**通过。** 修订稿自洽、新引入断言核实为真；§七 六项订正逐条取证成立，其中 F-2 的「当前缺项」撤回经实跑守卫证实。两阶段方向与 §七 订正后的放行口径不变：F-1 是删除旧通道元数据前的强制裁定项（阶段 B 内前置门，不阻断调查与其他清理），F-2/F-3/F-4/F-5 已在设计中收口，F-6/F-7 随 `docs/upstream-sync.md` 改写与首期货架实测落实；残余 N×4 由实施计划吸收。**设计可批准进入实施计划。**

---

## 九、终审收口（对 2026-10-29 第三轮设计修订，同日第五轮）

设计方第三轮修订：设计稿相对 HEAD 为 +18/−9，相对 §八 所审版本仅**三处增量**，其余逐字一致（无误改）；评审记录本轮未被设计方触碰（仍至 §八）。文件字节完整（0 处 U+FFFD、无 `[m` 残留；diff 管道显示的乱码系显示伪影）。

### 三处增量核对（= §八 残余的精准采纳）

| 增量（设计条款） | 对应残余 | 复核结果 |
|---|---|---|
| §5.2：「移除 **Stable 的根 Linux 命令**以及 **Stable/Beta 的 Linux CI job 及其矩阵**」 | N-2 | ✅ 与 §二 row 7 实测逐字对应：根 Linux 命令仅 `dist:linux`（stable 无后缀）一条；`desktop-linux` 矩阵 push/manual 为 stable+beta、PR 仅 beta（`ci.yml:229-237`） |
| §5.3：「**指向已退役命令、门禁和跨包读取的规则随阶段 A 改写**；zero-touch 等参考目录保护规则在阶段 A 继续有效，阶段 B 删除目录后关闭。阶段 A 仍不修改参考树 tracked 内容」 | N-1 | ✅ 正是 N-1 建议措辞，且更完整——显式声明 zero-touch 在 A 期**继续有效**（目录还在，保护规则必须留），与 §5.1「参考树不变」自洽 |
| §7.2 dashboard 改造新增首条 bullet：「移除对 variant 守卫 `PAIRS` 的 import、三包 `src/` 磁盘扫描及对应报告面，**不让这些已退役能力在参考目录缺失后静默退化为空报告**」 | N-3 | ✅ 采纳并加强。新断言「静默退化」经源码证实为真：`upstream-sync-dashboard.mjs:26-38` 的 `listFiles` 对缺失目录 try/catch 吞错返回 `[]` ⇒ 删目录后 Scope B 会静默报 0 而非报错 |

**N-4（ci.yml:308-311 过时注释）未入设计文档——正确取舍**：代码侧清理动作，不属设计范围；按 §八 登记口径由下次 CI 触碰时收口，本评审记录备查。

### 终审结论

**终审通过，设计定稿。** 闭环账：F-1~F-7（§一/§三）→ §七 六项订正 → §八 修订复审 → 本轮 N-1/N-2/N-3 采纳核实。**唯一开口 = N-4（代码侧备查，非设计内）。** 设计状态行「待实施计划」准确，实施计划开工时重钉基线、使用新分支名 `refactor/huaanwork-single-desktop-maintenance`。
