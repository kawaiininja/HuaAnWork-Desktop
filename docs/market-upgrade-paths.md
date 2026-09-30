# 市场升级路径骨架：内网 registry 与多源 keyring（spec §14 第 35/41 条）

本文登记两条**刻意不在 M6 落地**的市场升级路径的裁定、骨架设计与安全取舍：

1. **内网 registry 承担依赖闭包**（spec §14 第 35 条方案 (b)；记为 M6 升级路径首选）；
2. **多源 keyring 与每源公钥**（spec §14 第 41 条；M5 裁定单一 canonical 内网源，多源延后）。

**裁定 R-4（M6 计划）**：两条路径在 M6 **只落本文档 + 骨架设计，不落地实现**。
理由的总纲：零依赖 + 双门 + `--offline` 兜底已在 M5 fail-closed 生效（第 35 条的
三重纵深），registry 与多源都是**升级路径而非缺口**；M6 的发行压力下不应引入新的
信任根。每节末给出该路径自己的「M6 不实现」理由。

两条路径都**不是**已发现的缺口或待修的债：它们是现行 fail-closed 方案被产品需求
证伪时才会启动的替换路线；本文只固定「触发条件、骨架、取舍」，把实现与评审留给
触发后的单独裁定。

---

## 0. 现行基线（两条路径共同的出发点）

- **信任根**：离线签名者的 Ed25519 私钥（真离线两步发布流；私钥永不进入
  market-server 进程），wrapper 侧两槽钉扎（keyId 权威判定；槽 2 = 上一把钥 +
  `retiredAt` 退役时刻）。见 `dsh-plugin-huaanwork/src/huaanwork-host/market/config.ts`
  与 `docs/market-server-deployment.md`〈密钥供给、轮换与吊销〉。
- **闭包语义（零依赖）**：每个上架制品都是**自包含、无 lifecycle 脚本**的闭包。
  发布侧门（`market-server/src/tarball/gate.ts`，拒绝 `nonzero-dependencies` 与
  `lifecycle-scripts`）与安装侧门（`dsh-plugin-huaanwork/src/huaanwork-host/market/install.ts`
  第 ④ 步：`dependencies`/`optionalDependencies` 非空即拒，scripts 含
  preinstall/install/postinstall/prepare 亦拒）**同口径**；peerDependencies 豁免，
  bundleDependencies 允许（其字节在被签名 tgz 内）。
- **`--offline` 兜底**：`addPlugin(artifactPath, { offline: true })` ⇒ pnpm 恒带
  `--offline --ignore-scripts`（install.ts 第 ⑥ 步）——即便闭包破裂，也无网可回。
- **单源**：唯一 canonical 内网源，origin 仅可经 `HUAANWORK_MARKET_ORIGIN` env
  覆盖（`src/huaanwork-host/market/config.ts`）；客户端 `sources` tab 只管理这一个
  源，多源 UI 占位禁用（`docs/market-server-deployment.md`〈信任锚形态〉、
  `normalize.ts` 的 canonical 源身份）。
- **机器守卫**：内网安装路径不得出现 registry 旁路形态——`runExternalMarketPluginInstall`
  调用/具名 import、`--registry`、`--prefer-offline`、`npm_config_registry`
  （`scripts/market-dependency-direction.mjs` 的 `verifyMarketInstallPathHasNoRegistryBypass`，
  经 `scripts/verify-market-dependency-direction.mjs` 与
  `scripts/market-dependency-direction.test.mjs` 进入 root gate；守卫含负例，
  不做恒真放行）。
  同一条事实的另一半：`runExternalMarketPluginInstall` **本身不是死代码**——它是
  `dshmarket` 外部市场安装边界（`dshmarket` 生产消费方）的接缝
  （`tests/dshmarket-compat.spec.ts`）；被禁止的是内网市场安装链使用它（spec §14 第 39 条）。

---

## 1. 升级路径一：内网 registry 承担依赖闭包（第 35 条方案 (b)）

### 1.1 触发条件

- 某个内网插件**真实需要第三方运行时依赖**（今天被发布/安装双门拒之门外，无法上架）；
- 或闭包规模使「逐个制品托管 + 逐个 sha256 进签名清单」在运营上不可持续（今天每个
  插件是独立签名制品，逐个发布、逐个更新）。

只有当零依赖方案被**产品需求**证伪时才启动：它替换的是整条分发信任链的根，不是一次
局部放宽。第 35 条把现行方案记为 **(c) 零依赖 + 两道补强**，并把 **(b) 内网 registry**
记为 M6 升级路径**首选**（即一旦触发，优先于其它闭包方案）；(a) 全闭包入签名清单
同属第 35 条留作升级路径的候选——本文 §1.2 的子形态 2（签名锁文件 + registry 仅作
传输）正是对它的重新接近。

### 1.2 设计骨架

- **信任根**（按第 35 条原文）：pnpm 从内网 registry 解析依赖闭包，每个包的完整性
  信任落在 **registry 运营者发布的 `dist.integrity` 元数据**上——「(b) 内网 registry
  会把闭包信任根从离线签名者换成 registry 运营者的 `dist.integrity`，plain-http
  闭包无签名」。目录/清单的验签形态不变（签名信封仍覆盖被安装条目的 sha256）；
  变化的是「被安装字节的来源与图」：从单个自包含 tgz 变为一个由 registry 解析的图。
- **两种子形态**（骨架必须在实现前二选一，本文不做选择）：
  1. **裸 registry 解析**：安装链带 `--registry <内网源>`，pnpm 自行下载闭包——
     信任根转移如上，`--offline` 兜底取消（或降级为 `--prefer-offline`，而后者会让
     兜底失效，计划实施护栏明令不得降级）。
  2. **签名锁文件 + registry 仅作传输**：已签名清单（或一份被签名引用的锁文件）
     枚举**整个闭包**（每个传递依赖的名字 + 版本 + sha256），pnpm 按钉住的值安装，
     registry 只是字节来源——信任根仍留在离线签名者；代价是签名信封要覆盖闭包图，
     发布侧要能计算并固定整图（与〈目录规模上限〉的「一个签名信封覆盖多页」问题同源）。
- **与现方案的关系**：安装侧门第 ④ 步必须放宽（允许 dependencies）；`--offline`
  兜底从「恒开」变为「按锁文件预置」或取消；`verifyMarketInstallPathHasNoRegistryBypass`
  守卫（`--registry`/`--prefer-offline`/`runExternalMarketPluginInstall`/
  `npm_config_registry`）必须被**有意识地**改写并重新评审，`dshmarket` 接缝
  （外部市场边界）的划界也要一并重新评审。

### 1.3 明确的安全取舍

- **信任根转移**：离线签名者 → registry 运营者。威胁模型由「registry 运营者无法伪造
  激活」（见 `docs/market-server-deployment.md`〈威胁模型边界〉）退化为「registry
  运营者可以决定客户端安装什么」——除非采用签名锁文件子形态，而这正是两种子形态的
  分水岭。
- **plain-http 闭包无签名**：第 35 条原文点名的残余；裸 registry 形态下，完整性不再
  由离线 Ed25519 背书，而由 registry 元数据背书。
- **双门同时失效**：安装侧门必须放宽；发布侧门要么放宽，要么改为「闭包图核验」。
- **兜底失效**：`--offline` 兜底与裸 registry 解析不相容；`--prefer-offline` 会回网，
  使兜底失效（明令不得降级）。
- **守卫是机械的**：任何实现都必须先删/改 `verifyMarketInstallPathHasNoRegistryBypass`
  及其负例测试——这是**有意设计**，让「换信任根」成为一次显式评审，而不是顺手引入。

### 1.4 为什么 M6 不实现（裁定 R-4）

- 零依赖 + 双门 + `--offline` 兜底已是第 35 条的三重纵深，M5 起 fail-closed 生效；
  registry 是升级路径，不是缺口。
- M6 的发行压力下**不引入新的信任根**：一旦引入，回退成本高——「registry 运营者被
  信任」的事实无法在发行窗口内悄悄撤回（信任根在发行时钉入，轮换/变更走运营流程）。
- 触发条件未出现（**运营者侧观察；本仓库无法核验在册 registry 内容**）：在册插件均
  满足零依赖约束，没有插件因依赖被挡在门外——是否属实**以运营者核验为准**。

---

## 2. 升级路径二：多源 keyring 与每源公钥（第 41 条）

### 2.1 触发条件

- 需要**同时消费多个市场源**（如内网源 + 另一内网/上游源），且各源需要**独立信任**；
- 或需要按源隔离信任（每源独立公钥、独立轮换、独立吊销），例如两个部门各运营一个源。

M5 已裁定单一 canonical 内网源（`docs/market-server-deployment.md`〈信任锚形态〉、
`config.ts` 注释「两槽钉扎……多源 keyring 为 M6 裁定不实现的升级路径」）：今天 keyring 只有一份
（单源、两槽）。

### 2.2 设计骨架

- **信任根**：keyring = 每源一份钉扎（公钥槽 1/2 + `retiredAt`），源身份 = origin。
  验签信封的 `domain` 已按 origin 绑定（`fetchVerifiedManifest` 传
  `domain: options.origin`），keyId 权威判定与槽位语义（槽 2 的 `retiredAt`）保持
  不变，只是**每源一套**。
- **验签/闭包语义**：防重放 revision 的状态**已经按 origin 键控**
  （`MarketRevisionStore.loadMaxRevision(origin)`，落盘为 `state.json` 的
  `sources[origin]` 映射）；制品同源钉扎 `resolveSameOriginUrl(origin, …)` 也已经是
  per-call origin——这两个是现成的结构性接缝，多源化主要是接口面与 UI 面的工作。
- **与现方案的关系**：客户端 `normalize.ts` 的 canonical 源身份
  （`sourceRecordId`/`providerId` 固定）要改为「源清单中的一项」；`sources` tab 从
  占位禁用变为真实管理；每源 keyring 的供给/轮换/吊销走与今天同形的真离线流程
  （每源一对 Ed25519 钥 + 离线签名机）。
- **实现前必须先回答的设计问题**（M6 不回答）：
  1. **keyring 自身如何更新**——build-time 钉入（新增源 = 发版）还是远程更新
     （那会引入「更新 keyring 的信任根」这一新的自指问题）？
  2. **跨源 keyId 冲突**——同一把钥/同一 keyId 出现在多个源时，信任是否可迁移？
     （今天 keyId 是全局唯一判定；多源后必须定义其命名空间。）

### 2.3 明确的安全取舍

- 每个新增源都是**一个新的信任根**：该源钥持有人可以决定客户端从该源安装什么。
  多源的信任面 = 各源信任面的并集。
- 破坏必须被隔离在源内：每源 keyring + 每源 revision（已按 origin 键控）+
  同源钉扎（已 fail-closed）三者缺一，都会把「一源的运营事故」扩散成
  「所有源的信任事故」。
- 多源不解决 `dist.integrity` 问题：若同时采用路径一，路径一的取舍叠加生效。

### 2.4 为什么 M6 不实现（裁定 R-4）

- 单源已在 M5 裁定并 fail-closed；多源是升级路径，不是缺口——产品当前只有一个
  canonical 内网市场，`sources` tab 的多源占位禁用是**有意为之**（M5 单源裁定）。
- 多源意味着新的信任根集合与新的轮换/吊销运营流程；M6 发行压力下不引入。
- keyring 更新机制本身是未决设计（见 2.2 的两个设计问题）：先落裁定、后落地。

---

## 3. 登记与边界

- 本文即 Task 6.11（M6 Phase 6，2026-10-01）的产出；两条路径**不进入 AGENTS.md
  的债务表**——它们是刻意不建的升级路径，不是待修的缺口（Phase 6 出口审计只认
  `verify:aa` 与 M6 期间登记的债务项）。AGENTS.md〈HuaAnWork variant〉一节只放指针。
- 相关但不同物：市场目录**单页 200 条目上限**（超过需分页清单/多页签名）是另一笔已
  登记的延后项（裁定 R-3，见 AGENTS.md 债务表），不在本文范围。
