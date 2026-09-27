# market-server 部署 runbook（D4 最小部署面）

market-server 是 M5 内网插件市场的单进程 HTTP 服务端：provider-page 契约
兼容的目录端点 + 已签名清单的存储/透传 +（Task 2 起）制品托管与两步离线
签名发布流。它**不声称 standard source**（不发 `catalog-source` manifest；
源发现 = wrapper 配置钉扎），仅在 provider-page 负载层做 schema 兼容
（`parseCatalogProviderPage` 自校）。

## 进程形态

- 单进程 `node`（无原生依赖、无 SQLite；评审 D6：整个服务端状态 =
  `<dataDir>/catalog-state.json` 一个 JSON 文档，原子写 + 文件锁，
  目录 0700 / 文件 0600，随 `desktop-market/state.json` 先例）。
- 启动即全量恢复（§13 缓解）：状态从 JSON 文档重建；重启 = 完整恢复。
  读取无状态语义，服务端**不做 catalog 缓存**（round5 N8：M5 全链路无
  catalog 缓存，wrapper 每次拉取并验签，`revision` 单调使重放无效）。
- 服务端只持**验签公钥**；签名私钥永不进入本进程（两步离线签名，见下）。

## 启动

```bash
corepack yarn install --immutable          # 仓库工作区内安装（Yarn 4 corepack）
node --experimental-strip-types src/index.ts
# 或经 workspace 脚本：
corepack yarn workspace market-server start
```

Node 要求 `^22.19.0 || >=24.0.0`（与仓库 engines 一致）。

## 环境配置（前四项必需、fail-closed；admin token 可选）

缺任一必需项或值非法：进程打印指引并以 exit 1 退出，**不会**半配置启动。

| 变量 | 含义 | 校验 |
| --- | --- | --- |
| `MARKET_SERVER_PORT` | 监听 TCP 端口 | 整数 1..65535 |
| `MARKET_SERVER_DATA_DIR` | JSON 状态目录（绝对路径；缺省不存在则创建，0700） | 非空绝对路径 |
| `MARKET_SERVER_PUBLIC_ORIGIN` | 本服务对外 origin，如 `http://market.intranet.example:8787` | http/https；禁 userinfo、query、fragment。内网**允许 plain http**——但该祝福只覆盖 catalog/manifest 的**真实性**（由离线签名清单保证，不靠 TLS，决策 2）；**不覆盖 admin token 的保密性**（见〈Admin 面〉通道要求）。同时是清单信封的 `domain` 钉扎值 |
| `MARKET_SERVER_VERIFY_PUBLIC_KEY` | 钉扎 Ed25519 验签公钥文件路径 | 存在且可读；内容为 raw 32 字节小写 hex（64 字符，`gen-signing-key.mjs` 产出的钉扎格式） |
| `MARKET_SERVER_ADMIN_TOKEN` | admin 面 bearer token（**可选**） | 非空才生效。**未配置/为空 = admin 面整体禁用**（fail-closed：`/v1/admin/*` 一律 401 `admin-disabled`），启动时打印指引；配置后错 token / 缺 token 一律 401 `unauthorized` |

**不存在任何私钥配置项**（round3 R9：原「env 注入私钥」裁定作废，与
「不与托管同进程」矛盾）。发布签名是真离线两步流（见下）。

示例（systemd unit 的 `Environment=` 同口径）：

```bash
export MARKET_SERVER_PORT=8787
export MARKET_SERVER_DATA_DIR=/srv/market-server/data
export MARKET_SERVER_PUBLIC_ORIGIN=http://market.intranet.example:8787
export MARKET_SERVER_VERIFY_PUBLIC_KEY=/srv/market-server/keys/market-signing-key.pub.hex
export MARKET_SERVER_ADMIN_TOKEN=<out-of-band 分发的强随机 token>
node --experimental-strip-types src/index.ts
```

## HTTP 面

### 公开面（GET）

| 路由 | 语义 |
| --- | --- |
| `GET /v1/plugins` | provider-page 目录端点。查询参数按上游契约编码：`q`、重复 `category`（OR）/`capability`（AND）、`cursor`（不透明、绑定有效查询）、`limit`（1..200，默认 50）、`sort`（`relevance`/`updated`/`name`/`downloads`）、`locale`。响应为已通过上游 `parseCatalogProviderPage` 自校的 `CatalogProviderPage`。 |
| `GET /v1/manifest` | **已激活**的离线签名清单原文（Task 2 两步流激活后非 404）。文档形态 `{envelope, catalog, files}`：`catalog` 单独过 `parseCatalogProviderPage`；`envelope`（防重放）与 `files`（name@version → tarballPath + sha256 + size）为**旁挂**字段——严格 schema 顶层 `additionalProperties:false`，消费方须先剥离再 parse（Task 5 wrapper 判定同此）。验签由 wrapper 钉住公钥完成，服务端不代验。 |
| `GET /v1/manifest/signature` | 已激活清单的**分离签名** sidecar（Ed25519 记录：`version/algorithm/keyId/slot/signedAt/signature`）；未激活 404。 |
| `GET /artifacts/<file>` | 流式 .tgz 下载（`fs.createReadStream` 管道，不整文件入内存）。文件名为内容派生（`<name>-<version>-<sha256[:12]>.tgz`）；sha256 信任来自已验签清单，不来自传输层。未知/不安全名 404。 |
| `GET /admin` | 运营管理页（静态 shell，无服务端数据内嵌；一切数据操作走下述 token 端点）。 |
| `GET /healthz` | 存活探针 `{"ok":true}`。 |

### Admin 面（`/v1/admin/*`，bearer token，fail-closed）

未配置 token：整面 401 `admin-disabled`。已配置：错/缺 token 一律 401 `unauthorized`。

> **通道要求（D14b）**：admin 面每次请求都以 `Authorization: Bearer` 明文
> 发送 token（管理页并存 `sessionStorage`）。在 plain http 上，路径上的任何
> MITM 都可收割 token——拿到 token 虽**无法**伪造激活（仍需离线私钥），但
> 具备〈威胁模型边界〉所述的完整停服能力。要求：对 admin 面使用 **TLS**，或
> 仅经 **localhost / SSH 隧道**访问；若确须在 plain http 上用，须明示接受
> token 明文暴露的风险。

| 路由 | 语义 |
| --- | --- |
| `GET /v1/admin/state` | 总览：条目（含私有信封字段 sha256/tarball）、maxRevision、激活状态。 |
| `POST /v1/admin/artifacts?displayName=..&summary=..[&sha256=..]` | 发布 .tgz（raw body 流式落盘 + 边收边算 sha256；可选 `sha256` 参数做客户端断言，不符即 400 `sha256-mismatch` 且不留文件）。随后过**发布侧门**：解包 tarball manifest（自实现 ustar 解析，零依赖），`dependencies`/`optionalDependencies` 非空或 `scripts` 含 `preinstall`/`install`/`postinstall`/`prepare` 一律 422 拒绝并**点名**违规项（`peerDependencies` 豁免、`bundleDependencies` 允许）——运营者在发布时拿错，不是用户安装时。 |
| `PATCH /v1/admin/entries/:id` | 编辑展示字段。URL 类字段（`homepage`/`publisherUrl`/`repositoryUrl`）预检：**留空 = 清除/不填**（schema 非必填），填非 https 值 400 拒绝（round3 R15）。 |
| `POST /v1/admin/entries/:id/unpublish` | 下架条目（制品文件保留在盘，可重新上架同 name@version）。 |
| `POST /v1/admin/manifest/prepare` | 两步流第 1 步：生成 canonical 待签清单并入库 pending 槽——`domain` = 配置 origin、`revision` = 持久化 max+1（单调）、`issuedAt`/`notAfter`（TTL ≤ 7d）、catalog = 自校 provider page、files = 每个已托管制品的 sha256/tarballPath/size。条目 >200（契约单页上限）或制品缺失时诚实拒绝。 |
| `GET /v1/admin/manifest/pending` | 下载当前待签清单（无则 404）。 |
| `POST /v1/admin/manifest/signature` | 两步流第 3 步：对**存储中的** pending 清单做三输入两槽验签（含信封负例：`revision` 回退 / `notAfter` 过期 / `domain` 不符一律拒）。**仅验签通过才收录激活**（fail-closed：无有效签名永不激活）；激活 = manifest+signature 成对服务、pending 清空、持久化 maxRevision 前进。失败返回 `{activated:false, reason}`。 |

> **registry 元数据端点（`/<pkg>` npm 风格 `dist.integrity`）：Task 2 未建。**
> 它是可选的 M6 依赖闭包升级路径 (b) 骨架，**不在 M5 安装路径上**（M5 安装
> 真相源 = 已签名 catalog/sha 清单 + wrapper 自下载，不经 pnpm registry 流）；
> 届时须先解决「pnpm 旁路下载未校验字节」问题再启用（market-face-spec
> 〈依赖闭包裁定〉）。

错误体统一 `{"error":{"code","message"}}`，不泄露路径、env 或内部细节。

## 数据目录与备份/恢复

- 状态 = `catalog-state.json`（catalog 条目 + 已激活 manifest/signature 对 +
  pending 待签清单 + 持久化 maxRevision）。制品字节在 `artifacts/`
  子目录（0700；文件 0600，文件名内容派生含 sha256 前 12 位）。
- **备份**：停机（或持锁时）复制整个数据目录即可；单 JSON 文档无一致性
  难题。建议每日复制 + 发布（激活新清单）后即时复制。
- **恢复**：停机，用备份替换 `catalog-state.json`（保持 0600），重启。
  损坏 JSON = **fail-closed**：启动报 `StoreCorruptError` 并退出，
  文件不被触碰——按本 runbook 从备份恢复，切勿手工编辑状态文件。
- 原子写（同目录 tmp + rename）保证崩溃/重启中读者只会看到整份旧或
  整份新状态；文件锁（`catalog-state.json.lock`，O_EXCL，30s 陈旧自动
  熔断）串行化并发写者。状态 schema 保持 `version:1`，Task 2 字段为
  增量可选，Task 1 状态文件可直接加载。

## 升级

1. 停进程。
2. 更新代码（`git pull` + `corepack yarn install --immutable`）。
3. 状态 schema 带 `version` 字段；不兼容变更须随代码提供迁移说明并在
   `parseState` 校验处失败关闭（拒绝启动而非静默吞）。
4. 启进程，验证 `GET /healthz` 与 `GET /v1/plugins` 响应过
   `parseCatalogProviderPage`。
5. 回滚 = 停进程、还原代码与状态备份、重启。

---

# 威胁模型边界（诚实声明）

本机制**不防 market-server 管理员作恶**。持有 admin token 的运营者可以：下架
任意乃至全部条目、污染 pending 槽、托管任意字节、冻结发布流水线——即具备
**完整的市场停服能力**（含让在役版本 404，如果同时动盘上制品）。离线签名保证
的边界是：**管理员无法伪造激活**——激活需要离线签名机上的私钥产出的分离签名，
而私钥永不进入服务端进程（见下）。若部署方的威胁模型包含「恶意管理员」或
「token 泄露后的主动滥用」，本机制不提供防御；token 泄露面见下节 admin 面
说明，多签/审批类控制不在 M5 范围。

admin bearer token 是本服务**唯一不受离线签名保护的机密**：catalog/manifest
的真实性由签名保证（plain http 可用），token 的保密性只能靠传输层——见
〈Admin 面〉的通道要求。

# 密钥供给、轮换与吊销（Task 0.5 片段并入）

> 信任锚形态（M5 单源裁定，P2③）：M5 只支持**一个 canonical 内网市场
> 源**——单一钉扎 Ed25519 公钥 + 轮换期内的上一把公钥（槽 2，带
> `retiredAt` 退役时刻）。多源 keyring / 每源公钥延后 M6。客户端
> `sources` tab 在 M5 只展示并管理这一个 canonical 源，多源 UI 占位禁用、
> 注明 M6（与〈不改造清单〉⑤ 一致）。

- 算法：Ed25519（`node:crypto`，零新依赖）。
- 钉扎格式：**raw 32 字节公钥，小写 hex（64 字符）**。keyId = 公钥原始
  字节的 sha256 hex 指纹。wrapper 侧以 JWK（`{kty:'OKP', crv:'Ed25519',
  x: base64url}`）重建 KeyObject，无需 PEM/SPKI 解析。
- 槽位：槽 1 = 当前钥；槽 2 = 上一把钥，`retiredAt` = 换钥时刻 + 一个
  app 发版窗口。验签为**三输入两槽判定**：分离签名 + 声明槽位 +
  槽 2 `retiredAt`——keyId 先对全部槽位解析（无命中即 `unknown-key`），
  再比对声明槽位（不符即 `slot-key-mismatch`），槽 2 过 `retiredAt` 即拒
  （`slot-retired`），最后做 Ed25519 验签（`invalid-signature`）。信封字段
  判定先于一切：`missing-field` / `unsupported-envelope-version` /
  `invalid-revision` / `revision-regression` / `invalid-timestamp` /
  `domain-mismatch` / `not-yet-valid` / `expired` / `ttl-exceeds-cap`。

## 真离线两步发布流（round3 R9）

私钥**永不进入 market-server 进程**（服务端只持配置公钥）。发布一个清单：

1. 管理员在 market-server 管理面上架/更新制品；服务端计算 sha256 并生成
   canonical 待签清单（含防重放信封字段），输出 **pending manifest** 文件；
   未激活。
2. 签名管理员把 pending manifest 下载到**离线签名机**（私钥唯一居所），运行
   `node scripts/sign-manifest.mjs --manifest <pending.json> --key <market-signing-key.pem> --slot 1`，
   产出**分离签名** sidecar（`<pending.json>.sig.json`）。
3. 签名管理员把 sidecar 上传回 market-server；服务端用配置公钥做三输入两槽
   验签（含信封字段判定与 `revision` 单调检查），**通过才收录激活**——
   **fail-closed：无有效签名的清单不得激活**（Task 2 侧断言）。

密钥生成：`node scripts/gen-signing-key.mjs --out <仓库外目录>`。私钥
`market-signing-key.pem` 落盘 0600，**绝不入仓**——脚本拒绝在 git worktree
内写盘（.gitignore 另列 `market-server/keys/` 兜底）。公钥导出
`market-signing-key.pub.hex`（raw hex，即钉扎格式）并打印指纹。

## 暴露窗口陈述（round5 N7）

`notAfter` 上限 = **7 天**（信封寿命 `notAfter - issuedAt ≤ 7d`，验签侧
`ttl-exceeds-cap` 强制）。**`notAfter` 上限即私钥泄露的最大暴露窗口：泄露后
攻击者用泄露私钥签出的清单，最长可用期 = 7 天**（受 `revision` 单调与
`domain` 钉扎进一步收窄）。因此**离线签名操作节奏（重签/签名）必须短于该
窗口**：每 ≤7 天重签一轮，或每次发布即签（推荐后者——发布即签使任何时刻在
效清单的 `notAfter` 都不超过下一次常规发布）。

## 正常轮换

1. 离线签名机 `gen-signing-key.mjs` 生成新钥对；新公钥指纹经**带外渠道**
   告知 app 发版负责人（见下「公钥分发与指纹核对」）。
2. **先换服务端验签公钥**（D14c，按此顺序操作）：把 market-server 的
   `MARKET_SERVER_VERIFY_PUBLIC_KEY` 指向新公钥文件并**重启**——服务端
   intake 只认配置公钥（M5 单源：`keySlotsFromConfig` 单槽 = 槽 1），不先换
   钥，新私钥签出的 sidecar 在 intake 时必然 `unknown-key`（若声明 `--slot 2`
   则 `slot-key-mismatch`），市场无法发新清单，且故障现象与「私钥配错」难以
   区分。
3. 新私钥签新清单（`--slot 1`——M5 服务端只认槽 1，`--slot 2` 是 wrapper 侧
   概念，服务端永远无法满足）；新清单 `revision` 继续单调递增，
   `notAfter` 照常 ≤ issuedAt + 7d。
4. app 发版把**新旧两把公钥**同时钉进 wrapper 配置（新钥进槽 1，旧钥退槽 2
   并带 `retiredAt` = 发版时刻 + 一个发版窗口）。
5. 重叠期内旧钥签名仍可验（槽 2 未过 `retiredAt`）；窗口过后槽 2 机判拒绝
   （`slot-retired`），旧钥签名自然失效——轮换重叠期 = 一个 app 发版窗口
   （round4 C3）。
6. 旧私钥离线销毁。

## 吊销（诚实表述，round3 R3）

**吊销能力 = app 发版换钥 + `notAfter` 到期。不存在在线吊销**——market-server
与 wrapper 之间没有、也不引入密钥状态在线查询通道；任何声称「立即吊销」的
说法都不符合本机制。私钥泄露处置：

1. 立即用**新**私钥以更高 `revision` 重签全部在效清单（缩短已签清单的剩余
   可用期只能靠签发替换清单——但注意：旧清单在客户端若 `revision` 更高曾
   被接受则无法被低 revision 替换，因此泄露响应的核心是第 2 步的换钥 +
   过期）。
2. 走「正常轮换」第 3 步：紧急 app 发版把泄露钥移出钉扎配置（最短路径是把
   泄露钥的槽位置为空槽/移除）。未更新 app 的客户端：泄露钥签的清单最长
   再可用至其 `notAfter`（≤ 泄露发现时刻 + 7 天）。
3. 记录泄露时间窗，审计期间内以该钥签名的全部清单 revision。

## 公钥分发与指纹核对

- 公钥（raw hex）与指纹（sha256 hex）由 `gen-signing-key.mjs` 打印；指纹是
  唯一需要带外传递的值。
- 带外渠道：与 app 发版流程绑定的内部工单/签名邮件/口头 + 二次确认，**不得**
  经 market-server 自身通道回读（防自证）。
- 发版钉扎进 wrapper `config.ts`（Task 4 Step 3）前，负责人在离线签名机重算
  `sha256(raw pubkey)` 与带外指纹比对一致才允许合入；market-server 侧配置
  （Task 2）同口径核对。

## 离线签名操作纪律

- 私钥只在离线签名机落盘（0600），不出该机、不入任何版本控制、不经任何
  网络传输（用 U 盘/专人传递待签清单与签名产物）。
- 签名机不运行 market-server、不挂载内网共享盘。
- 每次签名记录 `signedAt`、所签清单 `revision`、所用槽位，供审计。
