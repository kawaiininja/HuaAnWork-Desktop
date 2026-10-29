# 2026-10-29 单桌面改造阶段 A：活规则与活文档逐行分诊

- 计划：`docs/superpowers/plans/2026-10-29-single-desktop-maintenance.md` Task 7
- 分支：`refactor/huaanwork-single-desktop-maintenance`
- 计划基线 `BASE_SHA`：`b5ef3e84a7951941480b50a8749fe6714b8c9fc7`
- 本任务起点：`2b35c7475e99cb0e24d951e8a036713cb402b2e7`（Task 1–6 已完成）
- 阶段 A 事实前提：`dsh-plugin-desktop/`、`dsh-plugin-desktop-beta/`、`dsh-desktop-next/` 仍是 tracked 目录，但已从根 `workspaces` 移除，不再是活跃构建/测试/打包/版本刷新目标；HuaAnWork 的改动直接落在 `dsh-plugin-huaanwork/`
- 未触碰：`docs/superpowers/{specs,plans,evidence}`（历史设计/评审/证据原样保留）、三个参考树的任何 tracked 文件、`assets/app-icons.source.json`

本文是 Task 7 要求的三分类证据：AGENTS 债表逐行处置、活文档逐文件处置、允许保留的上游 contract / 历史身份命中、以及历史死条目登记。每一行都写明「关闭 / 改写 / 保留」与原因，没有「其余同理」。

---

## 1. `AGENTS.md` 逐行处置

行号列给出「基线行 → 现文行」。基线行是 Task 7 开始时的 `AGENTS.md`；现文行是本次提交后的行号。`:20` 被整行删除，故其后所有行号前移 1。

### 1.1 流程规则段（基线 `:15-41`）

| 基线行 → 现文行 | 条目 | 阶段 A 处置 | 阶段 B 处置 |
| --- | --- | --- | --- |
| `:15` → `:15` | market freshness | **改写**：`market:prepare` / `market:check` 只刷新与校验 **HuaAnWork**；删除 "for Stable, Beta, and Next"。原因：T1/T2 已把 `MARKET_WORKSPACES` 收窄为 `['dsh-plugin-huaanwork']`，原文与实现相反 | 保留 |
| `:16` → `:16` | AA freshness | **改写**：`aa:prepare-release` 只为 **HuaAnWork 桌面通道**准备最新官方 AA `main`；删除 "both Desktop channels"。原因：T3 已把 AA 工作区收窄为单通道，`aa:check` 也只验证该通道 | 保留 |
| `:20` → 删除 | Next dev/check 命令 | **关闭**：`dev:next` / `check:next` 已从根 manifest 删除（T1），行文保留即成为死命令 | 保持关闭 |
| `:21` → `:20` | beta-first 开发流 + variant 门禁 | **关闭并替换**：beta-first（先改 beta 再同步 stable）与 variant 对齐门禁都是多桌面对等维护的产物；活跃命令已退役（T5）。新行改写为「Desktop 改动直接落在 `dsh-plugin-huaanwork/`，没有 beta-first 镜像，也没有 variant 对齐门禁」 | 保持关闭 |
| `:23` → `:22` | upstream 同步指针 | **改写**：仍指向 `upstream` remote 与 `docs/upstream-sync.md`，但显式引用该文件顶部的过渡横幅——§§1-7 是整仓合并时代纪律，阶段 B 由 selective review 取代，§8 是历史快照 | **改写为 selective port**（Task 12 落地） |
| `:26` → `:25` | `dsh-plugin-desktop/` ownership | **改写**：改为 `dsh-plugin-huaanwork/` 是唯一活跃桌面源码树（Host/Client faces、Electron bootstrap、打包与发布测试） | **关闭**：目录删除 |
| `:27` → `:26` | `dsh-desktop-next/` ownership | **改写**：三个参考目录合并为一条只读参考规则——不是 workspace，不参与日常构建、测试、打包或版本刷新，tracked 内容禁改，阶段 B 删除 | **关闭**：目录删除 |
| `:39` → `:38` | Beta 衍生事实 | **保留**：`Derived from dsh-plugin-desktop-beta at M1 (2026-09-19)` 是历史身份事实，不因单桌面改造失效 | 保留 |
| `:40` → `:39` | zero-touch | **改写**：规则对象从「两个 variant 的 `src/`」改为「三个完整参考树的 tracked 内容」；删除 `check:desktop-variants` 门禁命令与「改动先落原包再同步」的要求。原因：阶段 A 仍禁止改参考树 tracked 内容，但 variant 同步流程已不存在 | **关闭**：目录删除后规则失去对象 |
| `:41` → `:40` | market runtime ownership | **改写**：`dsh-community-market` 的 DSH 依赖由 **huaanwork 通道**同步与校验。原因：原文「beta 通道同步 + `huaanwork` 通道跳过」与 T4 后的 `ownsMarketRuntime('huaanwork')` 相反 | 按 Task 10 的 peer 裁定更新 |

### 1.2 债表逐行处置（基线 `:49-77` → 现文 `:48-76`）

| 基线行 → 现文行 | 条目 | 阶段 A 处置 | 阶段 B 处置 |
| --- | --- | --- | --- |
| `:49` → `:48` | `verify:aa` 并发竞态 | **改写**：文件改为 `dsh-plugin-huaanwork/scripts/verify-profile-boot.mjs`（AA 段起于 `:93`）；删去「all three workspaces」「beta 的 `verify:aa`」，改为单活跃工作区口径；保留「隔离运行可通过 + CI AA-skip 剥离」的事实 | 保留 |
| `:50` → `:49` | 市场目录单页 200 条目上限 | **保留**：与单桌面改造无直接关系，触发条件（条目 ≥150 / 清单 ≥3 MiB / 元数据 ≥15 KB）仍是当前运维规则 | 保留原触发条件 |
| `:51` → `:50` | 取消重启后的界面入口残余 | **保留**：M7 已处置，与参考树无关 | 保留 |
| `:52` → `:51` | wrapper 清理 N-11 | **保留**：历史处置记录（已解决），不重开。原文的「三包同形改动」是**历史处置路径的描述**，不是活跃规则，故不改写以免篡改处置记录 | 保留 |
| `:53` → `:52` | 上游同步例外（跨包读 root fixture） | **改写**：范围收窄为 HuaAnWork + market-server 的 4 处运行时 `readFileSync`（`dsh-plugin-huaanwork/tests/package.spec.ts`、`market-server/src/manifest-prepare.ts`、`market-server/tests/manifest-byte-cap.spec.ts`、`dsh-plugin-huaanwork/tests/huaanwork-host/market-verify.spec.ts`）；stable/beta 对侧文件不再在活跃构建面；删除 M22 / Task 6.3 spike 的 6 类 hunk × 28 文件冲突计数（那是整仓合并时代的度量） | **关闭整仓冲突例外**（selective review 取代） |
| `:54` → `:53` | 变体守卫结构性清单（R-M8-3） | **关闭**：守卫退出活跃门禁（`.reference.mjs`，不进任何 gate），`allowedDifferences` / `oneSidedPrefixes` 名额不再有执行者；原文末尾的「现状以本句、`verify-desktop-variants.test.mjs` 的计数钉为准」指向已不存在的文件，必须删除。逐条历史清单保留在 M8/M9 计划与证据文档 | **删除对应文件** |
| `:55` → `:54` | DSH 命名残留 | **改写**：保留仍存在的实际残留（运行时可触达文案、src/ 22 文件 52 处、`scripts/` 2 文件 8 行、`tests/` 23 文件 86 行），保留「第一批已清扫」事实；删除「三包同形重构 / 白名单成本 0 / 22→50 名额」等 variant 预算口径。原文「install-stable 流程未注册于本 variant」保留并补上可核对的实现理由（`installStable` 在 `releaseChannel !== 'beta'` 时 no-op） | 保留实际残留 |
| `:56` → `:55` | 三包 `tests/` 无 variant 守卫 / 漂移量 | **关闭**：三包同形不再是维护目标，参考树 `tests/` 退出活跃测试面，「给守卫补 left-sided 机制」的前置工作作废；基线与分类证据指回 `docs/evidence/2026-10-m7-tests-drift-baseline.md` | 保持关闭 |
| `:57` → `:56` | `_no-cwd` 与 subagent 会话分类 | **保留**：与参考树无关，触发条件原样 | 保留原触发条件 |
| `:58` → `:57` | market-server 无审计日志 | **保留**：与参考树无关 | 保留原触发条件 |
| `:59` → `:58` | 市场 UI `/plan-design-review` | **保留**：M26 已完成后仍保留历史记录，无退役命令 | 保留 |
| `:60` → `:59` | M26 走查残余收编 | **保留**：HuaAnWork 单树 UI 债 | 保留 |
| `:61` → `:60` | Windows 发行面零证据 | **保留**：HuaAnWork 打包/校验债，与参考树无关 | 保留原触发条件 |
| `:62` → `:61` | 上游大同步（M28 / M8 已收口） | **保留**：历史事实（M8 已全量完成、推送与 CI 对账证据齐） | 由 selective 模型承接未来工作（Task 12/13） |
| `:63` → `:62` | R-M8-2 Next 基座观察 | **改写**：阶段 A 休眠——`dsh-desktop-next/` 不再是活跃产品，「上游为 next 启动 release qualification 即触发基座重估」不再触发任何活跃工作；原观察项与 M9 订正（升 rc.1、alpha.1 lane 休眠）作为历史背景保留 | **关闭** |
| `:64` → `:63` | `/healthz` `x-test-now` 假健康方向 | **保留**：已处置，与参考树无关 | 保留 |
| `:65` → `:64` | `native-ui/` 四个 HTML `<title>` 残留 | **保留**：HuaAnWork 单树文案债 | 保留 |
| `:66` → `:65` | 托盘图标渲染不可见（已关闭） | **保留**：已关闭的环境归因记录 | 保留 |
| `:67` → `:66` | 手动 Check for Updates 静默超时 | **保留**：HuaAnWork 更新链路观察项 | 保留原触发条件 |
| `:68` → `:67` | 迁移信息每次启动打印 | **保留**：HuaAnWork 迁移文案观察项 | 保留 |
| `:69` → `:68` | 变体守卫既有红（已处置） | **关闭**：守卫退役后「未登记进 `allowedDifferences` 即红」的准入判定不再适用；删除 `check:desktop-variants` 与 `verify-desktop-variants.test.mjs` 两处引用（前者是死命令，后者文件已不存在）。`f9fd375243` 的 5 行作为 huaanwork 专属实现保留 | 保持关闭 |
| `:70` → `:69` | Next `verify:sidebar-browser` 挂起（已关闭） | **关闭**：Next 不再是活跃产品，该 CI 步骤已随构建矩阵收窄删除（T6）；根因与 PR #1 / run 记录作为历史证据保留，删除 `dsh-desktop-next/scripts/*` 与 `.github/workflows/ci.yml` 的活指向说明 | 保持关闭 |
| `:71` → `:70` | 上游新一轮落后（M9 已收口） | **保留**：历史事实与当前 peer 背景（cordis 稳定系、schemastery 3.18.5、#12/#17 永久 fork 差）仍是有效背景 | 按 Task 9-10 裁定改写 |
| `:72` → `:71` | huaanwork 未吸收上游 2.1 功能面 | **改写**：保留实测存量形状（15 个文件只存在于 beta、25 个两侧分叉 ⇒ 新增 15 + 合并 25），删除「变体守卫 64→65 项计数」的推进口径与 File 列里的 `scripts/verify-desktop-variants.mjs`；标注这是登记债、不是 parity | 改由 reviewedCommit 货架与人工逐条裁定承接 |
| `:73` → `:72` | 智能体包 M1 残余小项 | **保留**：HuaAnWork 单树债 | 保留 |
| `:74` → `:73` | 智能体包 M2 豁免与 Minor | **保留**：owner 裁定与豁免口径不因单桌面改造变化 | 保留 |
| `:75` → `:74` | Host 重启 gap 期退出 fallback | **保留**：HuaAnWork 单树债 | 保留 |
| `:76` → `:75` | 验收 IPC bridge 无条件暴露 | **保留**：HuaAnWork 单树债 | 保留 |
| `:77` → `:76` | Host 重启验收证据强度 | **保留**：HuaAnWork 单树债 | 保留 |

### 1.3 死命令与幽灵引用核对

```text
$ grep -nE 'dev:next|check:next|dev:beta|dist:mac:beta|check:desktop-variants|icons:check' AGENTS.md
(no output, exit 1)
$ grep -n 'verify-desktop-variants.test.mjs' AGENTS.md
(no output, exit 1)
$ grep -n 'all three workspaces' AGENTS.md
(no output, exit 1)
```

被这四条核对覆盖的原命中：基线 `:20`（`dev:next` / `check:next`，整行删除）、`:21`（`check:desktop-variants`，改写为无命令的新规则）、`:40`（`check:desktop-variants`，改写为参考树 zero-touch）、`:69`（`check:desktop-variants` + `verify-desktop-variants.test.mjs`，整行关闭）。

---

## 2. 活文档逐文件处置

分类口径按计划：**当前产品** = 本地路径/命令/链接改指 `dsh-plugin-huaanwork/`；**上游 npm contract / 历史身份** = 保留并注明性质；**历史设计/评审/证据** = 原样不动。同一文件内按上下文分别处理。

| 文档 | 基线引用 | 处置 | 编辑后仍命中的 `dsh-plugin-desktop`（分类） |
| --- | --- | --- | --- |
| `CONTRIBUTING.md` | `:38` 桌面代码位于 `dsh-plugin-desktop/` +「三个自有 package」；`:49` `yarn workspace dsh-plugin-desktop verify:notices` + `dsh-plugin-desktop/THIRD_PARTY_NOTICES.md` | **当前产品**：`:38` 改为 `dsh-plugin-huaanwork/` 是唯一活跃桌面树、三个参考目录只读且非 workspace；`:49` 改为 `yarn workspace dsh-plugin-huaanwork verify:notices` 与 `dsh-plugin-huaanwork/THIRD_PARTY_NOTICES.md`（该脚本在 HuaAnWork manifest 中存在） | `:38` 三处参考树目录名（历史身份/只读参考树路径） |
| `CONTRIBUTING.en.md` | `:38`、`:45` 同上（英文） | **当前产品**：同 `CONTRIBUTING.md` | `:38` 三处参考树目录名（历史身份/只读参考树路径） |
| `docs/architecture.md` | `:56` 稳定包 contract 是 `dsh-plugin-desktop/profile-service` 与 `pnpm`，Beta 提供 `dsh-plugin-desktop-beta/*`；`:62` 稳定版与 Beta 桌面代码分别位于两个目录、由变体同步检查约束；`:66` 稳定版/Beta 双通道 `upstream.json` 与 appId；`:68-70` stable/beta Header、`-beta.N`、安装稳定版；`:74-75` 两个 `../dsh-plugin-desktop/...` 链接 | **当前产品**：`:56` 改为 HuaAnWork 暴露 `dsh-plugin-huaanwork/profile-service` / `pnpm`，并把 `dsh-plugin-desktop/*`、`dsh-plugin-desktop-beta/*` 明确标注为上游包与已退役 Beta 变体的同名 npm contract（历史身份）；`:62` 改为单活跃树 + 三个只读参考目录；§发行通道协议整体改为 `huaanwork` 单通道（`activeChannel`、通道 header、回显规则），删除 Stable/Beta 活跃协议描述；`:74-75` 链接改指 `dsh-plugin-huaanwork/` | `:56` 两个 npm contract 名 + 一个 `dsh-plugin-desktop-beta/*`（上游 npm contract / 历史身份，已就地注明）；`:62` 三处参考树目录名（历史身份/只读参考树路径） |
| `docs/architecture.en.md` | `:56`、`:62`、`:66`、`:68-70`、`:74-75` 同上（英文） | **当前产品**：同 `docs/architecture.md` | `:56`、`:62` 同上 |
| `docs/README.md` | `:33`｜`:34` 两个 `../dsh-plugin-desktop/...` 链接；`:44`「`dsh-plugin-desktop/README.md` 和 `README.zh.md` 是 npm 包随包发布的包级参考」 | **当前产品**：`:33`、`:34` 改指 `../dsh-plugin-huaanwork/`；`:44` 改为 `dsh-plugin-huaanwork/README[.zh].md` 是 HuaAnWork 包级参考，并注明三个只读参考目录内的包级文档不再维护 | `:44` 三处参考树目录名（历史身份/只读参考树路径） |
| `docs/README.en.md` | `:33`、`:34`、`:44` 同上（英文） | **当前产品**：同 `docs/README.md` | `:44` 同上 |
| `docs/plugin-development.md` | `:16`｜`:200` 两个 `../dsh-plugin-desktop/docs/plugin-services.md` 链接；`:25-26`｜`:99-101` import 示例 `dsh-plugin-desktop/profile-service`、`dsh-plugin-desktop/pnpm` | **当前产品**：链接改指 `../dsh-plugin-huaanwork/docs/plugin-services.md`；import 示例改指 `dsh-plugin-huaanwork/profile-service`、`dsh-plugin-huaanwork/pnpm`（`dsh-plugin-huaanwork/package.json` 的 `exports` 确有 `./profile-service` 与 `./pnpm`，见计划评审 P1-1 的核对） | 无命中 |
| `docs/plugin-development.en.md` | `:16`、`:25-26`、`:99-101`、`:200` 同上（英文） | **当前产品**：同 `docs/plugin-development.md` | 无命中 |
| `docs/why-desktop.md` | `:48-49` `../dsh-plugin-desktop/docs/plugin-services.md`、`../dsh-plugin-desktop/README.md` | **当前产品**：两个链接改指 `../dsh-plugin-huaanwork/` | 无命中 |
| `docs/why-desktop.en.md` | `:48-49` 同上（英文） | **当前产品**：同上 | 无命中 |
| `dsh-community-market/README.md` | `:64` `../dsh-plugin-desktop/docs/plugin-services.md` | **当前产品**：改指 `../dsh-plugin-huaanwork/docs/plugin-services.md` | 无命中 |
| `dsh-community-market/README.zh.md` | `:64` `../dsh-plugin-desktop/docs/plugin-services.zh.md` | **当前产品**：改指 `../dsh-plugin-huaanwork/docs/plugin-services.zh.md` | 无命中 |
| `README.md`（根，不在 Step 3 grep 列表内但同属活文档） | `:84`｜`:133` 桌面插件接口说明链接；`:86`｜`:173` 包级 README 链接；`:165`「稳定版与 Beta 桌面包分别位于…」；`:177-180` Stable/Beta/Next 签名线与 Stable/Beta 桥接句；`:121` 更新通道写 `stable` 或 `beta` | **当前产品**：插件 API 与包级 README 改指 `dsh-plugin-huaanwork/docs/plugin-services.zh.md` 与 `dsh-plugin-huaanwork/README.zh.md`；开发段声明唯一活跃树 + 三个只读参考目录；macOS 权限段改为 HuaAnWork 主应用与 Helper 使用 pinned Harness entitlements；更新通道写 `huaanwork`（协议代码未改） | `:165` 三处参考树目录名（历史身份/只读参考树路径） |
| `README.en.md`（根，同上） | `:84`、`:86`、`:133`、`:165`、`:173`、`:177-180`、`:121` 同上（英文） | **当前产品**：同上；`:121` 同时补齐下载请求携带通道与目标版本的协议描述（与中文侧对齐） | `:165` 同上 |
| `docs/upstream-sync.md` | 顶部无横幅；§§1-7 是整仓合并时代规则 | **只加过渡横幅**（本任务边界）：§§1-7 为整仓合并时代规则，阶段 A 活跃产品已单化，阶段 B 由 `desktop-upstream.json` + selective review 取代；§8 历史快照不动。§§1-7 的选择性重写归 Task 12；文件内 `fixtureVersion: 2` 的陈旧数字同样归 Task 12 | 未改动（不含 `dsh-plugin-desktop` 命中） |

所有被改双语文档的 `.i18n.yaml` 已按与守卫相同的形态（`git hash-object --path=<path> -- <path>`）重录。

---

## 3. 允许保留的命中清单（Step 3 grep 全量）

`rg -n 'dsh-plugin-desktop' <12 个活文档>` 在本次提交后的**全部**输出（8 行；`dsh-plugin-desktop-beta` 因同前缀一并命中）：

| 文件:行 | 命中内容（摘要） | 分类 | 保留理由 |
| --- | --- | --- | --- |
| `CONTRIBUTING.md:38` | `dsh-plugin-desktop/`、`dsh-plugin-desktop-beta/`、`dsh-desktop-next/` | 历史身份 / 只读参考树路径 | 句子的主语是 HuaAnWork 是唯一活跃树；三个目录名是阶段 A 仍 tracked、阶段 B 删除的参考树 |
| `CONTRIBUTING.en.md:38` | 同上 | 历史身份 / 只读参考树路径 | 同上 |
| `docs/architecture.md:56` | `dsh-plugin-desktop/profile-service`、`dsh-plugin-desktop/pnpm`、`dsh-plugin-desktop-beta/*` | 上游 npm contract / 历史身份 | 这三个 specifier 是上游包和已退役 Beta 变体的 npm 包名；同句已写明当前产品的 contract 是 `dsh-plugin-huaanwork/*`，不得为了零命中改成 HuaAnWork |
| `docs/architecture.en.md:56` | 同上 | 上游 npm contract / 历史身份 | 同上 |
| `docs/architecture.md:62` | 三个参考树目录名 | 历史身份 / 只读参考树路径 | 该句的定义就是「这三个目录是只读参考、不是 workspace」 |
| `docs/architecture.en.md:62` | 同上 | 历史身份 / 只读参考树路径 | 同上 |
| `docs/README.md:44` | 三个参考树目录名 | 历史身份 / 只读参考树路径 | 该句声明参考目录内的包级文档不再维护 |
| `docs/README.en.md:44` | 同上 | 历史身份 / 只读参考树路径 | 同上 |

根 README 另有两处同类命中（不在 Step 3 的 12 个文件列表内）：`README.md:165`、`README.en.md:165`，均为「唯一活跃树 + 三个只读参考目录」句中的目录名，分类同上。

`DESKTOP_RELEASE_IDENTITIES.stable/beta`、迁移字符串与 `.agents/notes/` 未被本任务改写，属「上游 npm contract / 历史身份」类别，原样保留。

---

## 4. 历史 / 死条目登记

`assets/app-icons.source.json`（**内容未改**，作为历史溯源保留）：

| 字段 | 当前值 | 状态 | 处置 |
| --- | --- | --- | --- |
| `artwork.stable` | `dsh-plugin-desktop/build/app-icon.icon` | 指向阶段 B 将删除的参考树 | 保留原文；不再被任何构建步骤消费 |
| `artwork.beta` | `dsh-plugin-desktop-beta/build/app-icon.icon` | 同上 | 保留原文 |
| `artwork.next` | `dsh-desktop-next/build/app-icon.icon` | 同上 | 保留原文 |
| `previews.stable` | `dsh-plugin-desktop/build/app-icon.png` | 同上 | 保留原文 |
| `previews.beta` | `dsh-plugin-desktop-beta/build/app-icon.png` | 同上 | 保留原文 |
| `previews.next` | `dsh-desktop-next/build/app-icon.png` | 同上 | 保留原文 |
| `exportCommand` | `corepack yarn icons:export` | 命令已删除（T1/T5 退役图标导出/校验门禁） | 保留原文；属历史导出流程记录 |
| `verifyCommand` | `corepack yarn icons:check` | 命令已删除 | 保留原文 |
| `macPackaging` | 描述 Stable/Beta 的 `mac.icon` 编译 | 历史身份描述 | 保留原文 |

依据：全仓对 `app-icons.source.json` 的引用仅存在于 `docs/superpowers/plans/2026-10-29-single-desktop-maintenance.md` 与其 plan review（均为历史/计划文档），无代码消费方；HuaAnWork 使用自己的 `scripts/gen-*` 品牌图标流水线。故本任务只登记、不改内容。

---

## 5. 验证记录（串行执行）

```text
$ corepack yarn check:bilingual-docs            # exit 0
verify-bilingual-docs: 55 records and 110 documents are consistent

$ corepack yarn check:readme-versions           # exit 0
verify-readme-versions: 4 hardcoded artifact version string(s) in 1 scoped package(s)
(dsh-plugin-huaanwork) match their own package.json; 4 README(s) out of scope (M28):
dsh-plugin-desktop/README.md, dsh-plugin-desktop/README.zh.md,
dsh-plugin-desktop-beta/README.md, dsh-plugin-desktop-beta/README.zh.md

$ grep -nE 'dev:next|check:next|dev:beta|dist:mac:beta|check:desktop-variants|icons:check' AGENTS.md
(no output, exit 1)

$ rg -n 'dsh-plugin-desktop' CONTRIBUTING.md CONTRIBUTING.en.md docs/architecture.md \
    docs/architecture.en.md docs/README.md docs/README.en.md docs/plugin-development.md \
    docs/plugin-development.en.md docs/why-desktop.md docs/why-desktop.en.md \
    dsh-community-market/README.md dsh-community-market/README.zh.md
8 lines, all listed in §3

$ git diff --check                              # empty, exit 0
$ corepack yarn check:whitespace                # exit 0
$ test -z "$(git diff --name-only "$BASE_SHA" -- dsh-plugin-desktop dsh-plugin-desktop-beta dsh-desktop-next)"
(no output, exit 0 —— 三个参考树零改动)
```

i18n 记录更新（`git hash-object --path=… -- …` 的输出）：

```text
README.md                        7fcd1f3208e21141863b5c278e2750be83e3d70e
README.en.md                     4e14ee7a7d72b7fc2ee3b1dfabc25078acf5e4d1
docs/plugin-development.md       8009da2c50e71200e10e04847a0d8819f33943a0
docs/plugin-development.en.md    6c82237fc50f4b550c9b0c2cee17bc8b8cd2664f
dsh-community-market/README.md   6ab6f0e69177a6e6f989d26c16e7beeb992dacb8
dsh-community-market/README.zh.md fb7395cfffa0fc0306e5b6f479a67bd7d4c5879c
```

---

## 6. 移交阶段 B / Task 12–14

- `docs/upstream-sync.md` §§1-7 的选择性重写、§6 永久 override 清单收敛、`fixtureVersion: 2` 陈旧值：Task 12。
- 本任务改动的文档里只有 3 对带 `.i18n.yaml` 记录（`README.i18n.yaml`、`docs/plugin-development.i18n.yaml`、`dsh-community-market/README.i18n.yaml`），已全部重录；`docs/architecture*`、`docs/README*`、`docs/why-desktop*`、`CONTRIBUTING*` 在仓库里没有 `.i18n.yaml` 记录，本任务不新增（新增记录会改变 `verify-bilingual-docs` 的 55 条记录面，超出本任务边界）。
- 参考树删除后，§3 中所有「只读参考树路径」命中的句子需要删除或改写为「已删除」——Task 14 收口时按本表逐条处理。
- `AGENTS.md` 的 zero-touch、参考树只读规则、R-M8-2 休眠行在阶段 B 目录删除后关闭（表中已写明）。
