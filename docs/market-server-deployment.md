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
  **单实例守卫（P6，Task 6.5）**：打开状态时取 `<dataDir>/server.lock`
  （内含 pid + 启动时刻）；同一数据目录上的**第二个实例启动即失败**并诚实
  报出持锁 pid（见〈数据目录与备份/恢复〉）。
- 启动即全量恢复（§13 缓解）：状态从 JSON 文档重建；重启 = 完整恢复。
  读取无状态语义，服务端**不做 catalog 缓存**（round5 N8：M5 全链路无
  catalog 缓存，wrapper 每次拉取并验签，`revision` 单调使重放无效）。
- 服务端只持**验签公钥**；签名私钥永不进入本进程（两步离线签名，见下）。

## 启动

```bash
corepack yarn install --immutable                   # 仓库工作区内安装（Yarn 4 corepack）
corepack yarn workspace dsh-community-market build  # 必做（理由见下）；或根命令 corepack yarn build
node --experimental-strip-types src/index.ts
# 或经 workspace 脚本（同样以 install + build 为前置）：
corepack yarn workspace market-server start
```

**为什么必须先 build**：market-server 运行期 value-import
`dsh-community-market/contracts`，该子路径解析到 `lib/contracts/index.js`
——**git-ignored 的构建产物**；`dsh-community-market` 没有 prepare/postinstall
一类钩子，**新克隆的工作树里没有 `lib/`，也没有任何步骤会自动构建它**。
跳过 build 会在 import 期以 `ERR_MODULE_NOT_FOUND` 退出（两类签名见
〈Dockerfile 与容器运行〉(iii)）。

Node 要求 `^22.19.0 || >=24.0.0`（与仓库 engines 一致）。

**启动即校验「这是唯一实例」**（P6）：数据目录被另一个活进程持有时
（`<dataDir>/server.lock`），启动打印诚实错误（含持锁 pid）并以 exit 1 退出；
记录 pid 已不在（崩溃残留）的锁会被**原子接管**，所以常规重启无需手工清理。
另：进程收到 SIGTERM/SIGINT 直接退出、不释放锁 —— 这是可接受的，因为下一次
启动会接管「pid 已死」的锁。

## CLI 参数（Task 3.5）

market-server 的入口注册了 `bin`（`market-server` → `src/index.ts`，首行
`#!/usr/bin/env -S node --experimental-strip-types`），并接受两个便利旗标：

```bash
market-server --port 8787 --data /srv/market-server/data
# 等价于：
node --experimental-strip-types src/index.ts --port 8787 --data /srv/market-server/data
```

旗标只是**便利**：`loadConfig(env, overrides)` 取 `env ?? overrides`，
**env 值永远优先**（一条游离的 `--port` 不得静默覆盖部署配置）。未知旗标被
忽略而不是猜测；`--port` / `--data` 缺少取值即报错退出。两个必需变量
（`MARKET_SERVER_VERIFY_PUBLIC_KEY`、`MARKET_SERVER_PUBLIC_ORIGIN`）没有对应
旗标，仍须经 env 提供。注：仓库工作区内 Yarn 不为工作区**自身**生成 bin
shim（`nmHoistingLimits: workspaces`），本仓内以 `node --experimental-strip-types
src/index.ts --port … --data …` 调用；`bin` 在包被外部安装（或容器化）时生效。

## Dockerfile 与容器运行（Task 3.5，spec §11）

`market-server/Dockerfile` 与 `update-server/Dockerfile` 同构：非 root
（uid `10002`）、只拷 `package.json` + `src`、**不设 VOLUME、不写死 data
dir**——数据目录由部署方经 env + bind mount 提供：

```bash
docker build -t huaanwork/market-server -f market-server/Dockerfile market-server
docker run --rm -p 8787:8787 \
  -e MARKET_SERVER_PORT=8787 \
  -e MARKET_SERVER_DATA_DIR=/data \
  -e MARKET_SERVER_PUBLIC_ORIGIN=http://market.intranet.example:8787 \
  -e MARKET_SERVER_VERIFY_PUBLIC_KEY=/keys/market-signing-key.pub.hex \
  -e MARKET_SERVER_ADMIN_TOKEN=<强随机 token> \
  -v /srv/market-server/data:/data \
  -v /srv/market-server/keys:/keys:ro \
  huaanwork/market-server
```

**登记偏离：该镜像是「基座」镜像——只含服务端自身代码，必须由部署方补上依赖
闭包才能启动**（spec §11 的形状不变：`market-server/Dockerfile` 仍是非 root、
只拷 `package.json` + `src`）。原因：market-server 运行期 import
`dsh-community-market/contracts`，它解析到该包的 `lib/contracts/index.js`
（**git-ignored 构建产物**，无自动构建钩子）；该子路径还 import `ajv`，并在
运行期读本包 `docs/schemas/*.schema.json`。补闭包是**有顺序的**三步：

**(i) 先产出构建产物**（与〈启动〉同一前置，不可省）：

```bash
corepack yarn install --immutable
corepack yarn workspace dsh-community-market build
```

**(ii) 二选一提供闭包：**

① **直接用仓库工作区运行**——把仓库挂进 `node:22-slim`，不构造派生镜像：

```bash
docker run --rm -p 8787:8787 -w /repo/market-server \
  -v <repo-checkout>:/repo:ro \
  -e MARKET_SERVER_PORT=8787 -e MARKET_SERVER_DATA_DIR=/data \
  -e MARKET_SERVER_PUBLIC_ORIGIN=http://market.intranet.example:8787 \
  -e MARKET_SERVER_VERIFY_PUBLIC_KEY=/keys/market-signing-key.pub.hex \
  -e MARKET_SERVER_ADMIN_TOKEN=<强随机 token> \
  -v /srv/market-server/data:/data -v /srv/market-server/keys:/keys:ro \
  node:22-slim node --experimental-strip-types src/index.ts
```

该形态不搬闭包：仓库工作区的 `node_modules/` 由 (i) 的 install 提供
（`market-server/node_modules/dsh-community-market` 是工作区符号链接），
`lib/` 由 (i) 的 build 提供。

② **构造派生镜像**——把闭包落到 `/app/node_modules`。在构建机上装配只含闭包的
目录，再叠到基座镜像上：

```bash
# 在仓库根、已完成 (i)：
corepack yarn workspaces focus market-server --production   # Yarn 按真实依赖图收敛闭包
rm -rf /tmp/market-server-closure && mkdir -p /tmp/market-server-closure/node_modules
cp -R dsh-community-market/node_modules/. /tmp/market-server-closure/node_modules/
mkdir -p /tmp/market-server-closure/node_modules/dsh-community-market/docs
cp -R dsh-community-market/package.json dsh-community-market/lib \
  /tmp/market-server-closure/node_modules/dsh-community-market/
cp -R dsh-community-market/docs/schemas \
  /tmp/market-server-closure/node_modules/dsh-community-market/docs/schemas
```

```dockerfile
# /tmp/market-server-closure/Dockerfile
FROM huaanwork/market-server
COPY node_modules /app/node_modules
```

```bash
docker build -t huaanwork/market-server:closure /tmp/market-server-closure
# 运行参数同①，镜像名换成 huaanwork/market-server:closure
```

`focus --production` 收敛出市场包的生产闭包（`ajv` / `ajv-formats` 及其传递依赖
`fast-deep-equal`、`fast-uri`、`json-schema-traverse`、`require-from-string`），
不必手抄清单；`Done with warnings` 与若干 `YN0002` peer 依赖警告属预期（市场包的
可选 DSH peer 不在聚焦集合内，`contracts` 路径不需要它们）。随后的拷贝必须是
**真复制**（不要 `cp -al` 硬链接、不要符号链接，搬运到部署机会失效）。注意
`focus` 会把整个安装裁成这一条生产闭包（其它工作区的 devDependencies 与被按需
下载的原生二进制一并被裁掉）：之后若要重建 `lib/`（如升级），先
`corepack yarn install --immutable` 复原完整安装。本节的
文件集已按 `/app` 布局在 `/tmp` 模拟启动实测（2026-09-30 修复轮：构建 → 装配 →
`node --experimental-strip-types src/index.ts`，`listening` 横幅、`/healthz`、
`/v1/plugins` 均通过）；镜像构建本身仍是部署门（本机无 Docker daemon）。

**(iii) 缺闭包的两类失败签名**（都在 import 期、监听前退出）：

- `ERR_MODULE_NOT_FOUND: Cannot find package 'dsh-community-market'` ⇒
  `/app/node_modules` 里完全没有该包（闭包未提供）。
- `ERR_MODULE_NOT_FOUND: Cannot find module '…/dsh-community-market/lib/contracts/index.js'`
  ⇒ 包在，但 (i) 的 `lib/` 构建产物缺失或未拷入（等价于在全新克隆里跳过 build）。

## 环境配置（前四项必需、fail-closed；admin token 可选）

缺任一必需项或值非法：进程打印指引并以 exit 1 退出，**不会**半配置启动。

| 变量 | 含义 | 校验 |
| --- | --- | --- |
| `MARKET_SERVER_PORT` | 监听 TCP 端口 | 整数 1..65535 |
| `MARKET_SERVER_DATA_DIR` | JSON 状态目录（绝对路径；缺省不存在则创建，0700） | 非空绝对路径 |
| `MARKET_SERVER_PUBLIC_ORIGIN` | 本服务对外 origin，如 `http://market.intranet.example:8787` | http/https；禁 userinfo、query、fragment。内网**允许 plain http**——但该祝福只覆盖 catalog/manifest 的**真实性**（由离线签名清单保证，不靠 TLS，决策 2）；**不覆盖 admin token 的保密性**（见〈Admin 面〉通道要求）。同时是清单信封的 `domain` 钉扎值 |
| `MARKET_SERVER_VERIFY_PUBLIC_KEY` | 钉扎 Ed25519 验签公钥文件路径 | 存在且可读；内容为 raw 32 字节小写 hex（64 字符，`gen-signing-key.mjs` 产出的钉扎格式） |
| `MARKET_SERVER_ADMIN_TOKEN` | admin 面 bearer token（**可选**） | 非空才生效。**未配置/为空 = admin 面整体禁用**（fail-closed：`/v1/admin/*` 一律 401 `admin-disabled`），启动时打印指引；配置后错 token / 缺 token 一律 401 `unauthorized` |
| `MARKET_SERVER_MAX_CATALOG_ENTRIES` | 目录规模上限（**可选**，默认 200） | 正整数 **1..200**。配置 **>200 启动即失败**（错误信息指向上游契约 `maxItems`）；只能调低，见〈目录规模上限〉 |
| `MARKET_SERVER_ALLOWED_HOSTS` | `Host` 头白名单（逗号分隔；条目可带端口，不带端口则覆盖该主机任意端口） | 可选；缺省由 `MARKET_SERVER_PUBLIC_ORIGIN` 的 host 派生（与 update-server 的 `UPDATE_SERVER_ALLOWED_HOSTS` 同语义）。**白名单外的 Host 一律 403 `host-not-allowed`**；本机探针须显式带 Host 头（见〈HTTP 面〉） |
| `MARKET_SERVER_MAX_CONCURRENT_UPLOADS` | 并发上传上限（**可选**，正整数 ≥ 1，默认 4） | 超限的 `POST /v1/admin/artifacts` 一律 **429 `too-many-uploads`**（不排队、不吞请求） |

**不存在任何私钥配置项**（round3 R9：原「env 注入私钥」裁定作废，与
「不与托管同进程」矛盾）。发布签名是真离线两步流（见下）。

**三项服务器超时（P8，Task 6.5）没有 env 键**：`requestTimeout` = 300 s
（收完整请求，含 100 MiB 上传的慢链路）、`headersTimeout` = 60 s、
`timeout`（空闲 socket）= 120 s，均为代码内具名常量并显式生效。此前的
`server.timeout = 0`（= 永不超时）意味着一条卡住的连接可以永久占住它的
资源 —— 修法是把三个值都显式、非零地建进 config。

示例（systemd unit 的 `Environment=` 同口径）：

```bash
export MARKET_SERVER_PORT=8787
export MARKET_SERVER_DATA_DIR=/srv/market-server/data
export MARKET_SERVER_PUBLIC_ORIGIN=http://market.intranet.example:8787
export MARKET_SERVER_VERIFY_PUBLIC_KEY=/srv/market-server/keys/market-signing-key.pub.hex
export MARKET_SERVER_ADMIN_TOKEN=<out-of-band 分发的强随机 token>
node --experimental-strip-types src/index.ts
```

## 目录规模上限（D15 / 裁定 R-3）

**上限 200 条目来自上游契约，不是本服务的实现选择。** 签名清单只承载
**一个** provider page，而上游 `dsh-community-market` 的 provider-page 契约
把 `items` 钉在 `maxItems: 200`
（`src/contracts/generated/catalog-provider-page.ts`；catalog snapshot 同值）。
因此目录规模天花板 = 200 条目——没有任何服务端配置能放大清单一次可承载的
条目数，除非先改签名的信任模型（见下）。

**可配置（只能调低）**：`MARKET_SERVER_MAX_CATALOG_ENTRIES`（可选，整数
1..200，默认 200）。

- **调低**：小型部署可设更小的上限（如 `=50`），第 51 条上架即 422
  `catalog-full`；恰在上限时发布流（prepare）照常可用。
- **调高**：**启动即失败**（打印指引 + exit 1），错误信息指向上游契约
  `maxItems` 与「一个签名信封只覆盖一个 provider page」。放得更宽只会把失败
  推迟到 `manifest/prepare` 阶段——那正是 D15 修掉的「目录冻结」态（第 N+1
  条上架成功、之后每次 prepare 都失败）。

**生效点（单一真相源）**：有效上限来自配置，两处消费**同一值**——发布时
（第 N+1 条即 422 `catalog-full`，`admin/routes.ts`）与 prepare 纵深（条目数
> N 即 422 `catalog-too-large`，`manifest-prepare.ts`）。**目录规模上限域内**的数值 `200`
> 只在 `MAX_MANIFEST_ENTRIES` 定义一次（契约默认 / 天花板），config 的默认值
> 与启动校验的硬上限都取自它（`catalog/service.ts` 的 `MAX_PAGE_ITEMS = 200` 是
> 单请求页大小上限，与本上限无关）。

**清单字节上限(M8,2026-10-05)**:条目数不是唯一的上限。客户端对**整个响应体**设有
`MARKET_JSON_MAX_BYTES = 4 MiB` 的帽(`dsh-plugin-huaanwork/src/huaanwork-host/market/catalog-client.ts:51`),
而服务端此前只有条目数守卫 ⇒ `prepare` 会照签一份客户端拉不下来的清单、`intake` 会照激活它,
**激活之后全部客户端才开始失败**,且失败被重包成 `market-unreachable`(502)——归因错误。
现服务端在条目数守卫之后再设一道 `MARKET_SERVER_MAX_MANIFEST_BYTES`(默认 3.5 MiB = 客户端帽的 7/8,
留出传输信封与将来字段增长的余量),超限即 **422 `manifest-too-large`**,错误信息给出实测 canonical
字节数、帽值与唯一出路(拆源;分页/多页签名是 M18,按 R-3 与 R-M7-7 延后)。
两个数字**互相不得 import**(依赖方向红线),故经 root `scripts/market-manifest-byte-budget.json`
对账,两侧各有一条测试钉住自己与 fixture 相等(机制同 M6 为消解 P21 而建的
`scripts/expected-root-gate-scripts.json`)。
**运营观测量**:`/v1/admin/state` 与 `/healthz` 暴露 `manifestCanonicalBytes` / `entryCount` /
`averageEntryBytes` 三个量,它们正是 M18 三个触发条件(条目 ≥150 / canonical ≥3 MiB / 平均元数据 ≥15 KB)
的可打印形式 —— **巡检时直接读这三个数,不要人工估算**(债表 `AGENTS.md:45`)。

**超过 200 个插件需要什么（未实现，延后）**：分页清单 + **多页签名的信任
模型**——须先解「一个签名信封如何覆盖多页」（页间绑定、页序、缺页检测）这一
独立设计问题。裁定 R-3：M6 只做「上限可配置 + 文档诚实化」，分页 / 多页签名
延后。

**运营方动作**：在插件数**接近**上限（而非到第 201 条被拒）时就提出——规划
分批拆源或推动分页方案立项。

> 订正记录：M5 计划 Tech Stack 曾写「规模千级条目前足够」，该假设**从未与
> 契约 `maxItems` 对账**（评审 D15）。已在 M5 计划〈实施后订正汇总〉第 10 条
> 订正，正文保持时点原样（spec §14 第 29 条先例）。

## HTTP 面

### 公开面（GET）

| 路由 | 语义 |
| --- | --- |
| `GET /v1/plugins` | provider-page 目录端点。查询参数按上游契约编码：`q`、重复 `category`（OR）/`capability`（AND）、`cursor`（不透明、绑定有效查询）、`limit`（1..200，默认 50）、`sort`（`relevance`/`updated`/`name`/`downloads`）、`locale`。响应为逐条目通过上游契约校验、且**装配后再过一次整页（信封）校验**的 `CatalogProviderPage`（Task 6.7 fix round 1——逐条目校验不覆盖信封字段，如 `page.nextCursor` 的 2048 字符上限）。**读侧逐条目隔离（Task 6.7，裁定 D-M6-26）**：命中本次查询但违约契约的存储条目**只隔离其自身**（不再 500 掉整个目录）——隔离数进响应头 `x-catalog-isolated-entries`，逐条 `name (id): 违约原因` 进服务端日志（**非**响应体）；全部命中条目皆违约时答 500 `invalid-stored-catalog`（不以 200 + 空目录谎称市场为空）。**超大但合法的查询**（如 `q` 200 字符 + 20 个长 `category`）会让翻页游标超过契约上限，此时拒绝服务该载荷并答 **400 `query-not-paginable`**——请求级拒绝，不是存储故障。 |
| `GET /v1/manifest` | **已激活**的离线签名清单原文（Task 2 两步流激活后非 404）。文档形态 `{envelope, catalog, files}`：`catalog` 单独过 `parseCatalogProviderPage`；`envelope`（防重放）与 `files`（name@version → tarballPath + sha256 + size）为**旁挂**字段——严格 schema 顶层 `additionalProperties:false`，消费方须先剥离再 parse（Task 5 wrapper 判定同此）。验签由 wrapper 钉住公钥完成，服务端不代验。 |
| `GET /v1/manifest/signature` | 已激活清单的**分离签名** sidecar（Ed25519 记录：`version/algorithm/keyId/slot/signedAt/signature`）；未激活 404。 |
| `GET /artifacts/<file>` | 流式 .tgz 下载（`fs.createReadStream` 管道，不整文件入内存）。文件名为内容派生（`<name>-<version>-<sha256[:12]>.tgz`）；sha256 信任来自已验签清单，不来自传输层。未知/不安全名 404。 |
| `GET /admin` | 运营管理页（静态 shell，无服务端数据内嵌；一切数据操作走下述 token 端点）。**P7（Task 6.5）：未认证页面在「token 是否已配置」两种情况下返回逐字节相同的响应** —— 早先的「未配置横幅」泄漏了「admin 面是否禁用」这一目标选择情报；`admin-disabled` 这个 code 自此只出现在 JSON API（与启动日志）。 |
| `GET /healthz` | 存活探针 `{"ok":true}`。 |

> **Host 白名单（P8，Task 6.5）**：每个请求先过 `Host` 白名单，白名单外的
> Host 一律 **403 `host-not-allowed`**（本服务此前无任何 `headers.host`
> 消费点，故这是纵深加固而非已利用缺陷的修补）。默认只认
> `MARKET_SERVER_PUBLIC_ORIGIN` 的 host，所以**本机探针/容器 HEALTHCHECK
> 必须显式带 Host 头**（或用 load balancer 转发时保留原 Host）：
>
> ```bash
> curl -sf -H "Host: market.intranet.example:8787" http://127.0.0.1:8787/healthz
> # 或把 127.0.0.1 加进白名单：MARKET_SERVER_ALLOWED_HOSTS=market.intranet.example:8787,127.0.0.1
> ```
>
> 另：上传并发上限（默认 4）超限即 **429 `too-many-uploads`**，不排队。

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
| `GET /v1/admin/state` | 总览：条目（含私有信封字段 sha256/tarball）、maxRevision、激活状态、**制品清单 `artifacts`**（P11b，Task 6.6）：每项 `fileName`/`size`/`deletable` 布尔 + `referencedBy` 面名（`catalog`/`manifest`/`pending` 或 `*-unreadable`；`deletable` 仅在**三面全清**时为 true，fail-closed）。 |
| `POST /v1/admin/artifacts?displayName=..&summary=..[&sha256=..]` | 发布 .tgz（raw body 流式落盘 + 边收边算 sha256；可选 `sha256` 参数做客户端断言，不符即 400 `sha256-mismatch` 且不留文件）。**两个尺寸上限**：压缩字节 ≤ **100 MiB**（超出即 413 `artifact-too-large`）；解压后 tar ≤ **64 MiB**（超出即 400 `decompressed-tarball-too-large`，gunzip 炸弹防护）。**注意两值不等**：不可压缩字节的 70 MiB 制品会「上传通过、门拒」，打包前请自检解压后尺寸。随后过**发布侧门**：解包 tarball manifest（自实现 ustar 解析，零依赖），① 结构层——depth-1 `<dir>/package.json` 候选**必须恰好一个**（多于一个即 400 `invalid-tarball`「歧义 tarball」，防干净诱饵掩护脏 manifest）、任何条目名含 `..` 段即 400 `invalid-tarball`；② 身份层——包名须匹配契约小写正则、版本 ≤64 字符，否则 422 `invalid-package-identity`；③ 依赖层——`dependencies`/`optionalDependencies` 非空即 422 `nonzero-dependencies`，`scripts` 含 `preinstall`/`install`/`postinstall`/`prepare` 即 422 `lifecycle-scripts`（`peerDependencies` 豁免、`bundleDependencies` 允许）。②③ 均**点名**违规项——运营者在发布时拿错，不是用户安装时。 |
| `DELETE /v1/admin/artifact?file=<存放文件名>` | 删除单个已托管制品（P11b，Task 6.6；`unpublish` 有意保留字节，此前磁盘只增不减）。**引用面判定 fail-closed（三面，顺序固定）**：① 目录条目 `tarball`、② 已激活清单 `files[].tarballPath`（`GET /v1/manifest` 原文重放，故仅 unpublish 不够）、③ 已 prepare 的待签清单（仍可被签名激活）——任何一面仍引用即拒，答 **409 `artifact-referenced`**（清单形状无法解析、无法证明未引用时答 409 `manifest-unreadable`），文案**点名是哪一面**与运营者下一步（下架条目 / 重新 prepare + activate / 先处理当前 pending）。三面全清才 unlink，答 **204 + `x-artifact-bytes-reclaimed` 头**（回收字节数；204 无 body）。 |
| `PATCH /v1/admin/entries/:id` | 编辑展示字段。**写入前在锁内跑一次 provider-page 契约自校**（评审 D3）：长度/控制字符/双向控制符/枚举/时间戳等违约一律 400 `invalid-entry-contract` 并点名 JSON path，不会先答 200 再把整站目录变成 400。URL 类字段（`homepage`/`publisherUrl`/`repositoryUrl`）预检与契约 `httpsUri` 正则**逐字一致**（禁 userinfo、禁端口、禁 fragment）：**留空 = 清除/不填**（schema 非必填），违约即 400 拒绝（round3 R15）。 |
| `POST /v1/admin/entries/:id/unpublish` | 下架条目（制品文件保留在盘，可重新上架同 name@version）。 |
| `POST /v1/admin/manifest/prepare` | 两步流第 1 步：生成 canonical 待签清单并入库 pending 槽——`domain` = 配置 origin、`revision` = 持久化 max+1（单调）、`issuedAt`/`notAfter`（TTL ≤ 7d）、catalog = 自校 provider page、files = 每个已托管制品的 sha256/tarballPath/size。**条目数 > 配置上限（默认 200 = 契约单页上限）→ 422 `catalog-too-large`**（响应体含「Split the source before releasing」指引）；**引用制品已不在盘 → 409 `artifact-missing`**（含重新上架指引）。两者都是诚实 4xx，不再是裸 500（评审 D14d）。**上限已在发布时前移**（评审 D15）：第 N+1 条（N = 配置上限）上架即 422 `catalog-full`，故目录**永远不会**进入「prepare 持续失败、连既有条目也发不出新清单」的冻结态；`catalog-too-large` 因而只剩「运营者手改状态文件 / 从旧备份还原」这一条可达路径。上限可配置（Task 6.4，裁定 R-3）与分页延后见〈目录规模上限〉。**存储条目违约契约 → 409 `catalog-entry-invalid`**（Task 6.7，裁定 D-M6-26）：签名清单不得静默少条目，故 prepare 拒绝并点名条目与处置（下架该条目或修好状态文件后重跑）；只有手改状态文件/还原旧备份可达此分支。 |
| `GET /v1/admin/manifest/pending` | 下载当前待签清单（无则 404）。 |
| `POST /v1/admin/manifest/signature` | 两步流第 3 步：对**存储中的** pending 清单做 keyId 权威验签（裁定 R-1；含信封负例：`revision` 回退 / `notAfter` 过期 / `domain` 不符一律拒）。**仅验签通过才收录激活**（fail-closed：无有效签名永不激活）；激活 = manifest+signature 成对服务、pending 清空、持久化 maxRevision 前进。失败返回 `{activated:false, reason}`。 |

> **registry 元数据端点（`/<pkg>` npm 风格 `dist.integrity`）：Task 2 未建。**
> 它是可选的 M6 依赖闭包升级路径 (b) 骨架，**不在 M5 安装路径上**（M5 安装
> 真相源 = 已签名 catalog/sha 清单 + wrapper 自下载，不经 pnpm registry 流）；
> 届时须先解决「pnpm 旁路下载未校验字节」问题再启用（market-face-spec
> 〈依赖闭包裁定〉）。

错误体统一 `{"error":{"code","message"}}`，不泄露路径、env 或内部细节。

**admin 面错误码速查**（运营者排障用；均为实测值，与 `src/admin/routes.ts` 对应）：

| 状态 | code | 含义 / 处置 |
| --- | --- | --- |
| 400 | `invalid-query` | 查询不符合上游契约（含超长/坏形状的入站 `cursor`） |
| 400 | `query-not-paginable` | `/v1/plugins` 的有效查询**过大**：翻页游标是有效查询键的 base64url，超过契约 `page.nextCursor` 的 2048 字符上限（Task 6.7 fix round 1）。**合法请求但无法在契约内翻页**——收窄 `q`/`category`/`capability` 后重试；**非**存储故障 |
| 400 | `invalid-publish-request` | 缺 `displayName` 或 `summary`（须非空） |
| 400 | `invalid-sha256-format` | `sha256` 参数不是 64 位小写 hex |
| 400 | `sha256-mismatch` | 声明的 sha256 与上传字节不符（不留文件） |
| 400 | `invalid-tarball` | 非 gzip / 歧义 tarball（>1 个 depth-1 `package.json`）/ 条目名含 `..` 段 |
| 400 | `missing-package-json` | tarball 内无 `<dir>/package.json` |
| 400 | `invalid-package-json` | manifest 不是合法 JSON |
| 400 | `decompressed-tarball-too-large` | 解压后 > 64 MiB（gunzip 炸弹防护） |
| 400 | `invalid-entry-contract` | PATCH/publish 的条目违约上游 provider-page 契约（响应点名 JSON path） |
| 400 | `invalid-entry-patch` / `invalid-json` | 请求体形状错误 |
| 400 | `invalid-delete-request` | `DELETE /v1/admin/artifact` 缺必填查询参数 `file`（存储制品文件名，须以 `.tgz` 结尾） |
| 401 | `unauthorized` / `admin-disabled` | bearer token 缺失或错误；token 未配置时整个 admin 面禁用（`admin-disabled`，启动时打印配置指引）。**`admin-disabled` 只出现在 JSON API 与启动日志，不出现在未认证的 `/admin` 页面**（P7） |
| 403 | `host-not-allowed` | `Host` 不在 `MARKET_SERVER_ALLOWED_HOSTS`（默认 = `MARKET_SERVER_PUBLIC_ORIGIN` 的 host；检查反向代理是否改写了 Host，或本机探针是否漏带 Host 头） |
| 404 | `pending-manifest-not-found` / `entry-not-found` / `not-found` | 目标不存在 |
| 404 | `artifact-not-found` | `DELETE /v1/admin/artifact` 的目标不在盘：名字不安全、未存储、或与并发删除者竞争后已被删；盘上制品名以 `.tgz` 结尾 |
| 405 | `method-not-allowed` | 方法不符 |
| 409 | `already-published` | 同 name@version 已发布（**盘上制品不受影响**，评审 D2）；先 unpublish 再重发 |
| 409 | `manifest-activation-conflict` | 并发双 intake，败者诚实 409（非 500） |
| 409 | `artifact-missing` | prepare 引用的制品已不在盘 |
| 409 | `catalog-entry-invalid` | prepare 拒绝：存储条目违约 provider-page 契约（Task 6.7，裁定 D-M6-26；只可能来自手改状态文件/旧备份还原）；点名条目与处置，修好后重跑 |
| 409 | `artifact-referenced` / `manifest-unreadable` | `DELETE /v1/admin/artifact` 的引用面拒绝：文案点名是哪一面（目录条目 / 已激活清单 / 待签清单）与下一步；`manifest-unreadable` = 清单形状无法解析、无法证明未引用（fail-closed） |
| 413 | `artifact-too-large` | 上传压缩字节 > 100 MiB |
| 429 | `too-many-uploads` | 并发上传已达 `MARKET_SERVER_MAX_CONCURRENT_UPLOADS`（默认 4）；等手上传结束后重试 |
| 422 | `nonzero-dependencies` / `lifecycle-scripts` / `invalid-package-identity` | 发布侧门拒绝（点名违规项） |
| 422 | `catalog-too-large` | prepare 时条目数 > 配置上限（默认 200 = 契约单页上限）；发布时已前移拦截，故通常只剩手改状态文件/旧备份还原可达 |
| 422 | `catalog-full` | 发布第 N+1 条时被拒（N = 配置上限，默认 200；评审 D15 / Task 6.4）；先 unpublish 一条再发布。目录因此永不进入 prepare 冻结态 |
| 500 | `upload-failed` / `internal-error` / `invalid-stored-catalog` | **服务端**故障；细节进服务端日志（响应体不含路径与 ajv 内部）。`invalid-stored-catalog` 自 Task 6.7（裁定 D-M6-26）起仅剩「**全部**命中条目皆违约」这一条路径——单条违约改为逐条目隔离（200 + 隔离信号） |
| 500 | `page-envelope-invalid` | `/v1/plugins` 装配出的页面**整页**校验失败，但逐条目校验全过（Task 6.7 fix round 1 的兜底臂；当前装配下不可达——可达的游标超限走 400 `query-not-paginable`）。fail-closed：不服务契约拒绝的载荷，也不归因存储状态 |

> **读侧逐条目隔离（Task 6.7，裁定 D-M6-26）**：存储中的条目违约契约的唯一可达
> 来源是「运营者手改状态文件 / 从旧备份还原」（写侧已在锁内自校，D3）。此时
> `/v1/plugins` **只隔离违约条目本身**：仍答 200 并服务其余条目，隔离数经响应头
> `x-catalog-isolated-entries` 暴露，逐条 `name (id): 违约原因` 进服务端日志
> —— 隔离绝不静默（静默少一个插件会让运营者无从知道自己改坏了什么）。**全部命中
> 条目皆违约时仍 fail-closed**：答 **500 `invalid-stored-catalog`**（非 400——那是
> 服务端数据故障，不是调用方查询错误；也**不**答 200 + 空目录，那会让客户端以为
> 市场是空的）。隔离后的页面还要过一遍**整页（信封）校验**（Task 6.7 fix round 1）
> ——逐条目校验不覆盖信封：`page.nextCursor` 契约上限 2048 字符，而游标是本服务
> 生成的**有效查询键的 base64url**，超大但**合法**的查询（`q` 与分类/能力过滤的
> 尺寸上限相加即可超过）会撞上它；此时既不服务违约载荷、也不归因存储状态，而是
> **400 `query-not-paginable`**（请求级拒绝，收窄查询即可）。ajv 的 instancePath 与
> schema 正则只进日志，不回给未认证客户端
> （评审 D3b）。**发布路径不放行**：存在违约条目时
> `POST /v1/admin/manifest/prepare` 答 **409 `catalog-entry-invalid`** 并点名条目与
> 处置（签名清单是客户端的安装真相源，不得像单次响应那样静默少条目）；修好或下架
> 该条目后重跑 prepare 即可，读侧期间照常服务。

## 数据目录与备份/恢复

- 状态 = `catalog-state.json`（catalog 条目 + 已激活 manifest/signature 对 +
  pending 待签清单 + 持久化 maxRevision）。制品字节在 `artifacts/`
  子目录（0700；文件 0600，文件名内容派生含 sha256 前 12 位）。
- **单实例锁 = `server.lock`（P6，Task 6.5）**：内含持锁 pid + 启动时刻。
  第二个实例（或「未停机就还原 JSON」留下的运行中实例）会让**新实例启动即
  失败**并诚实报出持锁 pid，而不是静默服务陈旧状态。处置：
  1. 若报出的 pid 仍在运行 → 先停该实例（`kill <pid>` / 停 systemd unit）；
  2. 若该 pid 已不在（崩溃残留）→ 直接删除 `server.lock` 后重启
     （**先确认没有 market-server 在跑**）；正常的下一次启动也会自动接管
     「记录 pid 已死」的锁，所以只有 pid 无法归属（文件内容损坏）时才必须手工删。
- **备份**：停机（或持锁时）复制整个数据目录即可；单 JSON 文档无一致性
  难题。建议每日复制 + 发布（激活新清单）后即时复制。
  **不要在实例运行中还原 `catalog-state.json`** —— 运行中的实例持有内存
  快照，还原会让它继续服务旧状态；先停实例（`server.lock` 是「谁在跑」的
  权威标记），再还原，再启动。
- **恢复**：停机，用备份替换 `catalog-state.json`（保持 0600），重启。
  损坏 JSON = **fail-closed**：启动报 `StoreCorruptError` 并退出，
  文件不被触碰——按本 runbook 从备份恢复，切勿手工编辑状态文件。
- 原子写（同目录 tmp + rename）保证崩溃/重启中读者只会看到整份旧或
  整份新状态；文件锁（`catalog-state.json.lock`）串行化并发写者。
  **陈旧锁接管（P5，Task 6.5）**：只有**确认持锁进程已死**（`process.kill(pid, 0)`
  探测）且锁龄超过 30 s 才会熔断，且熔断本身是一次原子 `rename` 过户 +
  内容身份校验（若期间已有人建了新锁，会把新锁原样放回，绝不删除）
  ——两进程同时熔断不会再互删对方的锁。取不到锁即诚实超时
  （`LockTimeoutError`），接管无法安全完成则抛 `LockTakeoverError`（启动失败）。
  状态 schema 保持 `version:1`，Task 2 字段为增量可选，Task 1 状态文件
  可直接加载。

## 升级

1. 停进程。
2. 更新代码（`git pull` + `corepack yarn install --immutable` +
   `corepack yarn workspace dsh-community-market build`）：`lib/` 是 git-ignored
   构建产物，不重建会继续跑到旧契约代码，或直接 `ERR_MODULE_NOT_FOUND`。
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
> `retiredAt` 退役时刻）。多源 keyring / 每源公钥为 M6 裁定不实现的升级路径
> （见 `docs/market-upgrade-paths.md`）。客户端
> `sources` tab 在 M5 只展示并管理这一个 canonical 源，多源 UI 占位禁用、
> 注明 M6（与〈不改造清单〉⑤ 一致）。

- 算法：Ed25519（`node:crypto`，零新依赖）。
- 钉扎格式：**raw 32 字节公钥，小写 hex（64 字符）**。keyId = 公钥原始
  字节的 sha256 hex 指纹。wrapper 侧以 JWK（`{kty:'OKP', crv:'Ed25519',
  x: base64url}`）重建 KeyObject，无需 PEM/SPKI 解析。
- 槽位：槽 1 = 当前钥；槽 2 = 上一把钥，`retiredAt` = 换钥时刻 + 一个
  app 发版窗口。验签为 **keyId 权威判定**（裁定 R-1，spec §14 第 63 条）：
  keyId 先对全部槽位解析（无命中即 `unknown-key`），**解析到的槽即权威钥**；
  签名记录声明的槽号只是运营元数据，不参与判定；随后按**解析到的槽**判
  `retiredAt`（槽 2 过点即拒，`slot-retired`），最后做 Ed25519 验签
  （`invalid-signature`）。信封字段判定先于一切：`missing-field` /
  `unsupported-envelope-version` / `invalid-revision` / `revision-regression` /
  `invalid-timestamp` / `domain-mismatch` / `not-yet-valid` / `expired` /
  `ttl-exceeds-cap`。`not-yet-valid` 带 30 s 时钟偏移宽限
  （`CLOCK_SKEW_GRACE_MS`，P10；两侧实现同名同值，运营侧见〈离线签名操作纪律〉
  的 NTP 前置条件）。既有已签名清单无需重签——`slot` 字段仍在，只是不再被比对。

## 真离线两步发布流（round3 R9）

私钥**永不进入 market-server 进程**（服务端只持配置公钥）。发布一个清单：

1. 管理员在 market-server 管理面上架/更新制品；服务端计算 sha256 并生成
   canonical 待签清单（含防重放信封字段），输出 **pending manifest** 文件；
   未激活。
2. 签名管理员把 pending manifest 下载到**离线签名机**（私钥唯一居所），运行
   `node scripts/sign-manifest.mjs --manifest <pending.json> --key <market-signing-key.pem> --slot 1`，
   产出**分离签名** sidecar（`<pending.json>.sig.json`）。
3. 签名管理员把 sidecar 上传回 market-server；服务端用配置公钥做 keyId 权威
   验签（含信封字段判定与 `revision` 单调检查），**通过才收录激活**——
   **fail-closed：无有效签名的清单不得激活**（Task 2 侧断言）。

密钥生成：`node scripts/gen-signing-key.mjs --out <仓库外目录>`。私钥
`market-signing-key.pem` 落盘 0600，**绝不入仓**——脚本拒绝在 git worktree
内写盘（.gitignore 另列 `market-server/keys/` 兜底）。公钥导出
`market-signing-key.pub.hex`（raw hex，即钉扎格式）并打印指纹。

## 暴露窗口陈述（round5 N7）

`notAfter` 上限 = **7 天**（信封寿命 `notAfter - issuedAt ≤ 7d`，验签侧 `ttl-exceeds-cap`
强制）。**`notAfter` 上限即私钥泄露的最大暴露窗口：泄露后攻击者用泄露私钥签出的清单，
最长可用期 = 7 天**（受 `revision` 单调与 `domain` 钉扎进一步收窄）。

**离线签名节奏是硬要求，不是二选一（M11 订正，2026-10-05）**：原文把「每 ≤7 天重签一轮」
与「每次发布即签」并列成两个可选方案，并论证「发布即签使任何时刻在效清单的
`notAfter` 都不超过下一次常规发布」。**该论证对无发布的静默期不成立** —— 它是事件驱动的
（由发布触发），静默期内没有任何事件去重签，在效清单会在 `notAfter` 到期后**过期即全市场
四条 route 全 502**（客户端无缓存、每次读都重验，`verify.ts:285-288` 过期即 `expired`）。
括号里那句默默假设了「7 天内会有下一次发布」。

⇒ **必须做的是**：① 设立**定时巡检**（周期 ≤ 7 天，建议每日）读 `/healthz` 的
`envelope.expiresInSeconds` 与 `envelope.warning`；② 设立**每周定期空转重签**（无发布也重签
一轮；空转重签合法 —— `revision` 等值放行，见〈正常轮换〉节的机制事实）；③ 「发布即签」
仍然推荐，但它是**锦上添花**，不能替代 ①②。
**可见性**：`/healthz` 现暴露 `envelope: { active, revision, notAfter, expiresInSeconds, warning }`
（剩余不足 **48 小时**即 `warning: true`；**已过期则 `ok: false`**，不会把全市场停摆显示成健康），
并同时暴露 Task 4.1 的三个 M18 观测量（`manifestCanonicalBytes` / `entryCount` / `averageEntryBytes`）。
巡检脚本可直接读这个端点，不需要人工估算。

## 正常轮换（重叠窗口成立，操作前必读）

**先说机制事实（2026-09-30 实现后实测，非推断）。** 验签为 keyId 权威判定
（裁定 R-1，spec §14 第 63 条）：wrapper 的 `verifyWithKeySlots`
（`dsh-plugin-huaanwork/src/huaanwork-host/market/verify.ts`）与 market-server
的镜像（`market-server/src/signing.ts`）都先用 `keyId` 对**全部**钉扎槽解析
（无处可循即 `unknown-key`），**解析到的槽即权威钥**；签名记录声明的槽号只是
运营元数据，不参与判定；`retiredAt` 按解析到的槽判定。market-server 的
`keySlotsFromConfig` 仍只配置服务端生产钥（恒 `slot: 1`），故其收录的签名都
声明 `slot: 1`——这在判定里已无影响。

实测四种组合（真实 ed25519 密钥，两包真实代码，`verifyMarketManifest` 直调；
2026-09-30 实现后重跑）：

| 客户端钉扎 | 服务端签名钥 / 声明槽 | 结果 |
|---|---|---|
| current=K1 | K1 / slot 1 | **OK**（slot 1，稳态） |
| current=K2, previous=K1（`retiredAt` 未到） | K1 / slot 1 | **OK**（slot 2，重叠期旧钥清单可验） |
| current=K2, previous=K1 | K2 / slot 1 | **OK**（slot 1） |
| current=K1（未升级） | K2 / slot 1 | **REJECT `unknown-key`** |

**重叠窗口现在成立**：app 发版把 current 钉成 K2 之后，已升级客户端在
`retiredAt` 之前**同时接受** K1 与 K2 签名的清单（第 2、3 行）——发版与服务器
换钥之间不再有恒拒段，轮换顺序不再产生拒绝窗口（M5 的第 2 行 REJECT
`slot-key-mismatch` 已消除）。第 4 行仍然成立且**不是顺序缺陷**：未升级客户端
没有被钉过新钥，无法验证新钥签名的清单（`unknown-key`）——这是钉扎机制的固有
边界，故仍推荐「app 发版先走」。

### 轮换程序（本实现下两步之间目录持续可用）

选「app 发版先走 + 在 `retiredAt` 之前完成服务端换钥」而不是相反：发版先走的
第 2、3 步之间服务端清单仍由 K1 签名，已升级客户端照样验证通过（上文实测表
第 2 行）；反序（服务端先换 K2）则会让第 4 行的窗口出现在所有未升级客户端上
（它们拒绝新钥清单，直到各自升级）。

1. 离线签名机 `gen-signing-key.mjs` 生成新钥对 K2；新公钥指纹经**带外渠道**告知
   app 发版负责人（见下「公钥分发与指纹核对」）。
2. app 发版把 **current = K2、previous = K1（`retiredAt` = 发版时刻 + 一个发版
   窗口）** 钉进 `PINS_AT_RELEASE`。已升级客户端从这一刻起即可验证 K2 与 K1
   两种签名的清单；未升级客户端继续验证仍由 K1 签名（`slot: 1`）的清单。
3. 在 `retiredAt` 之前把 market-server 的 `MARKET_SERVER_VERIFY_PUBLIC_KEY`
   指向 K2 并**重启**；随后用 K2 私钥 `--slot 1` 签新清单（`revision` 继续单调
   递增，`notAfter` ≤ issuedAt + 7d）。此步不必与第 2 步挤在同一维护窗口。
4. `retiredAt` 过后槽 2 机判拒绝（`slot-retired`）；旧私钥 K1 离线销毁。

**`--slot` 声明已不影响判定**：声明槽是元数据，`--slot 1` 与 `--slot 2` 不再
改变验签结果（`sign-manifest.mjs` 对 `--slot 2` 的旧告警已按此订正）；服务端
intake 按 keyId 对配置钥解析，**配置里没有的钥无论声明哪个槽都拒**
（`unknown-key`）。运营仍按惯例声明 `--slot 1`（服务端单钥的现实），便于审计。

### 处置记录（裁定 R-1，2026-09-30 落地）

M5 登记的二选一处置已选定并落地：**放宽为以 `keyId` 解析为准**（声明
槽降为元数据，`retiredAt` 仍按解析到的槽判定），**未**采用「服务端支持两槽
intake」。安全性论证不变：`keyId` 是公钥的 sha256 指纹，攻击者仍需持有被钉扎
公钥对应的私钥；在 `keyId` 权威之后，槽号声明不提供额外保证。这是验签语义变更，
已按纪律落共享测试向量（`fixtureVersion: 3`：重叠期正向量 + 声明槽元数据正向量 +
`retiredAt` 按解析槽判定的负向量；`slot-key-mismatch` 原因码自此移除，两侧
验签器与生成器同步）。登记：spec §14 第 63 条。

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

## 紧急下架（SOP：让一个在架插件停止被安装）

**先读这一句：`unpublish` 挡不住客户端安装。** 客户端的安装真相源**只有已激活的
Ed25519 签名清单**；`POST /v1/admin/…/unpublish` 只从 `state.entries` 里删掉该条目
（`admin/routes.ts:721-739` → `catalog/store.ts:425-431` 的 `removeEntry`），**既不重建也不重签清单**，
而 `GET /v1/manifest`（`server.ts:352-360` 一带）原样回放已激活清单 ⇒ 下架之后客户端
仍能按旧清单下载并安装该插件。删除制品字节也不行：DELETE 有三面引用检查（catalog 条目 /
已激活清单 / pending 清单，`admin/routes.ts:275-285` 的 `artifactReference()`，拒绝分支 `:314-358`），任一面命中即 **409 `artifact-referenced`**
（清单不可读时是 **409 `manifest-unreadable`**，fail-closed）。

**紧急下架唯一路径 = 一次完整的离线重签**，需要离线签名机与签名管理员在场：

1. 服务端下架条目：`POST /v1/admin/…/unpublish`（把它移出 `state.entries`）。
2. 重新生成清单：`prepare` —— 新 revision 不含该条目。
3. 离线签名机签名（气隙、私钥 0600、见〈离线签名操作纪律〉的 NTP 前置）。
4. `intake` 激活新签名清单。**激活完成之前，旧清单仍然有效、客户端仍能安装该插件。**

**时间窗口与责任人（紧急下架流程，必须填实，不得留空）**

| 环节 | 预计耗时 | 责任人 | 备注 |
|---|---|---|---|
| 1 服务端下架 | < 1 min | 市场运营 | 需 admin token；该动作**成功时无任何日志**（M25，见威胁模型节） |
| 2 prepare | < 1 min | 市场运营 | 若撞上 `catalog-too-large` / `manifest-too-large` 见〈目录规模上限〉 |
| 3 离线签名 | **取决于签名管理员到场** | 签名管理员 | 含带外指纹核对；**这是唯一的长杆** |
| 4 intake 激活 | < 1 min | 市场运营 | 激活后旧 revision 被 `maxRevision` 单调判定挡住重放 |

⇒ **紧急下架不是一个按钮，是一次需要人到场、耗时以「签名管理员多久能到」计的运维动作。**
威胁模型节已诚实声明「不防管理员作恶」，但此前**没有**声明「下架一个在架条目需要一次完整
离线重签」—— 本节补上这句。若业务上需要「秒级下架」，那是一个**新的信任根设计问题**
（在线吊销 / 远程可更新 keyring），按 spec §14 第 41 条已明裁「不存在在线吊销」，
远程可更新 keyring 是 M19 的未决问题（R-M7-7 维持不做）。

**回归钉**：`market-server/tests/admin.spec.ts` 的
`replays the activated manifest and its signature byte-for-byte across an unpublish (M10)`（`:888-908`）
钉住「unpublish 不动已激活清单与签名的任何一个字节」；既有的
`refuses to delete after unpublish while the activated manifest still references it`（`:869-886`）
与「唯一生效路径 = 重新 prepare + 签 + 激活」（`deletes an artifact once neither the entries nor the activated manifest reference it`，`:974-987`）一同构成本节的机械保障。

## 公钥分发与指纹核对

- 公钥（raw hex）与指纹（sha256 hex）由 `gen-signing-key.mjs` 打印；指纹是
  唯一需要带外传递的值。
- 带外渠道：与 app 发版流程绑定的内部工单/签名邮件/口头 + 二次确认，**不得**
  经 market-server 自身通道回读（防自证）。
- 发版钉扎进 wrapper `config.ts`（Task 4 Step 3）前，负责人在离线签名机重算
  `sha256(raw pubkey)` 与带外指纹比对一致才允许合入；market-server 侧配置
  （Task 2）同口径核对。
- **钉入形态与机械守卫（M6 Task 4.8）**：wrapper 侧钉扎是
  `PINS_AT_RELEASE.current = { keyId: <sha256 指纹>, publicKeyHex: <raw hex> }`
  ——两项一并钉入且必须配对（`config.ts` 的 `parsePinnedMarketKey` 校验
  `keyId === sha256(publicKeyHex)`，不配对即 fail-closed 抛错）。发行命令前置的
  `node dsh-plugin-huaanwork/scripts/huaanwork-verify-provisioning.mjs` 在打包前做
  同一判定并逐项打印指纹，供 R1 与 R2 带外核对；**空钉扎、只给公钥不给指纹、
  指纹不配对、或任一 default origin 仍含 `.example`，构建一律拒绝**。
- **master 的按设计状态是未 provisioning**（空钉扎 + 两个 `.example` 占位 origin），
  故守卫在 master 上恒拒；真实值在发行分支钉入，步骤见
  [`release-checklist.md`](./release-checklist.md)。

## 离线签名操作纪律

- **NTP 前置条件（P10 的运营侧，Task 6.5）**：离线签名机与 market-server
  都必须启用 NTP 对时（签名机同样算「时钟可信设备」，停机久了尤其是）。
  签名机时钟快 1 秒曾会让每次 intake 都以 `not-yet-valid` 失败——一个读起来
  像被攻击的原因码。机制侧兜底 = 两侧实现共同的具名常量
  `CLOCK_SKEW_GRACE_MS = 30_000`（`market-server/src/signing.ts` 与 wrapper 的
  `verify.ts` 同名同值）：`issuedAt` 最多提前 30 s 仍接受；**再往前一律
  `not-yet-valid`**。**宽限是兜底，不是免对时的理由**——一次真实的事故
  （时钟跳变）只会被宽限掩盖 30 秒。
- 私钥只在离线签名机落盘（0600），不出该机、不入任何版本控制、不经任何
  网络传输（用 U 盘/专人传递待签清单与签名产物）。
- 签名机不运行 market-server、不挂载内网共享盘。
- 每次签名记录 `signedAt`、所签清单 `revision`、所用槽位，供审计。

## 与更新服务端的关系

market-server（内网插件市场）与 update-server（桌面**更新通道**）是两个
**独立**的内网服务端，可以同机部署：不同端口（默认 8787 / 8790）、各自独立
的 `<dataDir>`（**不要共用一个数据目录**）：

- **凭据面不同**：market-server 有 `MARKET_SERVER_ADMIN_TOKEN`（发布 / 下架 /
  激活的写入面由它保护）；**update-server 没有任何口令，也没有任何写端点**
  （只读；制品由运营者在部署机文件系统上直接放置）——不要让运营者去找一个
  不存在的口令。
- **信任面不同**：market-server 的目录真实性由**离线签名清单**保证，制品
  字节另有 sha256 对账；update-server 只做客户端侧 sha256 比对（D-M6-23），
  防传输/存储篡改，不防同时控制版本端点与下载端点的攻击者。
- 两者**都不进桌面安装包**——`dsh-plugin-huaanwork/tests/package.spec.ts`
  的回归门（`keeps both intranet servers out of the desktop installer`）钉住
  两个工作区 `private: true` 且不出现于 `build.files`。
- update-server 的部署、发布流程、下架硬顺序、备份/恢复、灾备旁路与威胁模型
  边界见 [`update-server-deployment.md`](./update-server-deployment.md)。

## 监控、HA 与事故响应

### 1. 失效形态：Fail-Silent（静默宕机）

market-server 若发生单点宕机或反向代理后进程挂死，客户端请求各路由将收到 502 / 连接拒绝，并在客户端内被包装为 `market-unreachable` 错误。对最终用户而言，仅表现为市场目录加载失败或重试提示，其感官形态与**临时网络抖动完全无法区分**。在缺乏主动监控的情况下，**市场服务端宕机可持续数周无人发现**，直到用户集中反馈无法获取或安装新插件。

### 2. 最小可行巡检要求（无外部工具依赖）

全仓不引入任何外部监控系统套件，运维依靠轻量每日巡检：
- **每日探测**：通过定时脚本或运维定时任务执行探测：
  ```bash
  curl -fsS http://<market-server-host>:8787/healthz
  ```
  非 2xx 响应即刻判定为异常并触发运维介入。
- **信封有效期检查（Task 4.3）**：
  必须解析 `/healthz` 响应中的信封字段：
  - `ok`：若为 `false`（或 HTTP 响应异常），说明服务不可用或签名已过期；
  - `envelope.warning`：若为 `true`，或 `envelope.expiresInSeconds` 剩余时间偏低，说明离线签名信封即将失效，必须**立即触发离线重签 runbook**（见前文〈离线签名操作纪律〉与〈真离线两步发布流〉），避免凭据自然过期导致验签恒拒。
- **M18 目录规模观测量读取（Task 4.1）**：
  必须同时读取 `/healthz` 返回的三个观测量：
  - `manifestCanonicalBytes`（清单规范化 JSON 字节数）
  - `entryCount`（当前条目数）
  - `averageEntryBytes`（条目平均元数据字节数）
  若任一指标达到或越过债表（`AGENTS.md:45`）设定的警戒阈值（**在册条目数 ≥ 150，或清单 canonical 字节 ≥ 3 MiB，或平均条目元数据 ≥ 15 KB**），必须立即登记 **M18 触发**，进入多页清单与分源架构预案。
- **巡检留痕**：巡检脚本必须将时间戳、`/healthz` 关键字段及指标追加记录至持久化运维日志文件（如 `/var/log/huaanwork-market-patrol.log`）或工单系统，确保巡检有迹可循（填补 L3 纪律留痕缺口）。

### 3. 事故响应与备份恢复

- **单实例宕机处置**：
  1. 检查 node 进程状态与端口占用；
  2. 检查 `server.lock`（见前文〈数据目录与备份/恢复〉，`:358-380`）：若实例崩溃残留旧锁，确认无运行进程后按规则接管或清理；
  3. 检查数据目录读写权限与磁盘空间；
  4. 重启服务进程并用 `GET /healthz` 验收。
- **数据恢复与原子写护栏**：
  若发生数据损坏，启动时将抛出 `StoreCorruptError` 并 fail-closed 退出。此时必须从备份中恢复：
  - 严禁在服务运行状态下直接覆盖 `catalog-state.json`；
  - 恢复步骤：停止服务进程 → 从最近备份还原 `catalog-state.json` 与 `artifacts/` 目录 → 确认文件权限（0600）→ 重新拉起服务。
  - 数据文件采用原子写（tmp + rename）与文件排他锁机制，杜绝半写入状态；陈旧锁在确认进程不存在时支持安全接管。

### 4. 备份节奏的诚实定性（L3）

当前备份机制**无自动化调度、无定时任务脚本，纯属人工纪律**（runbook 虽建议「每日复制 + 发布（激活新清单）后即时复制」，但无内置 cron/脚本守护）。运维人员必须明确知晓该缺口，在后续自动化机制落地前，严格执行手动备份与留痕。
