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
| `POST /v1/admin/artifacts?displayName=..&summary=..[&sha256=..]` | 发布 .tgz（raw body 流式落盘 + 边收边算 sha256；可选 `sha256` 参数做客户端断言，不符即 400 `sha256-mismatch` 且不留文件）。**两个尺寸上限**：压缩字节 ≤ **100 MiB**（超出即 413 `artifact-too-large`）；解压后 tar ≤ **64 MiB**（超出即 400 `decompressed-tarball-too-large`，gunzip 炸弹防护）。**注意两值不等**：不可压缩字节的 70 MiB 制品会「上传通过、门拒」，打包前请自检解压后尺寸。随后过**发布侧门**：解包 tarball manifest（自实现 ustar 解析，零依赖），① 结构层——depth-1 `<dir>/package.json` 候选**必须恰好一个**（多于一个即 400 `invalid-tarball`「歧义 tarball」，防干净诱饵掩护脏 manifest）、任何条目名含 `..` 段即 400 `invalid-tarball`；② 身份层——包名须匹配契约小写正则、版本 ≤64 字符，否则 422 `invalid-package-identity`；③ 依赖层——`dependencies`/`optionalDependencies` 非空即 422 `nonzero-dependencies`，`scripts` 含 `preinstall`/`install`/`postinstall`/`prepare` 即 422 `lifecycle-scripts`（`peerDependencies` 豁免、`bundleDependencies` 允许）。②③ 均**点名**违规项——运营者在发布时拿错，不是用户安装时。 |
| `PATCH /v1/admin/entries/:id` | 编辑展示字段。**写入前在锁内跑一次 provider-page 契约自校**（评审 D3）：长度/控制字符/双向控制符/枚举/时间戳等违约一律 400 `invalid-entry-contract` 并点名 JSON path，不会先答 200 再把整站目录变成 400。URL 类字段（`homepage`/`publisherUrl`/`repositoryUrl`）预检与契约 `httpsUri` 正则**逐字一致**（禁 userinfo、禁端口、禁 fragment）：**留空 = 清除/不填**（schema 非必填），违约即 400 拒绝（round3 R15）。 |
| `POST /v1/admin/entries/:id/unpublish` | 下架条目（制品文件保留在盘，可重新上架同 name@version）。 |
| `POST /v1/admin/manifest/prepare` | 两步流第 1 步：生成 canonical 待签清单并入库 pending 槽——`domain` = 配置 origin、`revision` = 持久化 max+1（单调）、`issuedAt`/`notAfter`（TTL ≤ 7d）、catalog = 自校 provider page、files = 每个已托管制品的 sha256/tarballPath/size。**条目 >200（契约单页上限）→ 422 `catalog-too-large`**（响应体含「Split the source (M6) before releasing」指引）；**引用制品已不在盘 → 409 `artifact-missing`**（含重新上架指引）。两者都是诚实 4xx，不再是裸 500（评审 D14d）。**200 条目上限已在发布时前移**（评审 D15）：第 201 条上架即 422 `catalog-full`，故目录**永远不会**进入「prepare 持续失败、连既有条目也发不出新清单」的冻结态；`catalog-too-large` 因而只剩「运营者手改状态文件 / 从旧备份还原」这一条可达路径。分页清单 / 多页签名留待 M6。 |
| `GET /v1/admin/manifest/pending` | 下载当前待签清单（无则 404）。 |
| `POST /v1/admin/manifest/signature` | 两步流第 3 步：对**存储中的** pending 清单做三输入两槽验签（含信封负例：`revision` 回退 / `notAfter` 过期 / `domain` 不符一律拒）。**仅验签通过才收录激活**（fail-closed：无有效签名永不激活）；激活 = manifest+signature 成对服务、pending 清空、持久化 maxRevision 前进。失败返回 `{activated:false, reason}`。 |

> **registry 元数据端点（`/<pkg>` npm 风格 `dist.integrity`）：Task 2 未建。**
> 它是可选的 M6 依赖闭包升级路径 (b) 骨架，**不在 M5 安装路径上**（M5 安装
> 真相源 = 已签名 catalog/sha 清单 + wrapper 自下载，不经 pnpm registry 流）；
> 届时须先解决「pnpm 旁路下载未校验字节」问题再启用（market-face-spec
> 〈依赖闭包裁定〉）。

错误体统一 `{"error":{"code","message"}}`，不泄露路径、env 或内部细节。

**admin 面错误码速查**（运营者排障用；均为实测值，与 `src/admin/routes.ts` 对应）：

| 状态 | code | 含义 / 处置 |
| --- | --- | --- |
| 400 | `invalid-publish-request` | 缺 `displayName` 或 `summary`（须非空） |
| 400 | `invalid-sha256-format` | `sha256` 参数不是 64 位小写 hex |
| 400 | `sha256-mismatch` | 声明的 sha256 与上传字节不符（不留文件） |
| 400 | `invalid-tarball` | 非 gzip / 歧义 tarball（>1 个 depth-1 `package.json`）/ 条目名含 `..` 段 |
| 400 | `missing-package-json` | tarball 内无 `<dir>/package.json` |
| 400 | `invalid-package-json` | manifest 不是合法 JSON |
| 400 | `decompressed-tarball-too-large` | 解压后 > 64 MiB（gunzip 炸弹防护） |
| 400 | `invalid-entry-contract` | PATCH/publish 的条目违约上游 provider-page 契约（响应点名 JSON path） |
| 400 | `invalid-entry-patch` / `invalid-json` | 请求体形状错误 |
| 401 | `unauthorized` / `admin-disabled` | bearer token 缺失或错误；token 未配置时整个 admin 面禁用（`admin-disabled`，启动时打印配置指引） |
| 404 | `pending-manifest-not-found` / `entry-not-found` / `not-found` | 目标不存在 |
| 405 | `method-not-allowed` | 方法不符 |
| 409 | `already-published` | 同 name@version 已发布（**盘上制品不受影响**，评审 D2）；先 unpublish 再重发 |
| 409 | `manifest-activation-conflict` | 并发双 intake，败者诚实 409（非 500） |
| 409 | `artifact-missing` | prepare 引用的制品已不在盘 |
| 413 | `artifact-too-large` | 上传压缩字节 > 100 MiB |
| 422 | `nonzero-dependencies` / `lifecycle-scripts` / `invalid-package-identity` | 发布侧门拒绝（点名违规项） |
| 422 | `catalog-too-large` | prepare 时条目 > 200（契约单页上限）；发布时已前移拦截，故通常只剩手改状态文件/旧备份还原可达 |
| 422 | `catalog-full` | 发布第 201 条时被拒（评审 D15）；先 unpublish 一条再发布。目录因此永不进入 prepare 冻结态 |
| 500 | `upload-failed` / `internal-error` / `invalid-stored-catalog` | **服务端**故障；细节进服务端日志（响应体不含路径与 ajv 内部） |

> 读侧自校验失败（存储中的条目违约契约）答 **500 `invalid-stored-catalog`**
> 而非 400——那是服务端数据故障，不是调用方查询错误；ajv 的 instancePath 与
> schema 正则只进日志，不回给未认证客户端（评审 D3b）。写侧已在锁内自校
> （D3），正常运营路径不会走到这里。

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
  **⚠ 上述算法描述准确，但「声明槽位必须等于 keyId 解析到的槽位」这一步与
  「M5 服务端只配槽 1」合起来使槽 2 实际不可达——轮换因此没有重叠窗口。
  操作前必读下〈正常轮换〉节的实测表与限制说明（spec §14 第 52 条）。**

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

## 正常轮换（M5 机制限制：无重叠窗口，操作前必读）

**先说机制事实（2026-09-27 实测，非推断）。** market-server 只有**一个**验签槽
（`src/manifest-prepare.ts` 的 `keySlotsFromConfig` 恒返回 slot 1），故其收录的
每一份签名都声明 `slot: 1`。wrapper 的三输入两槽判定
（`dsh-plugin-huaanwork/src/huaanwork-host/market/verify.ts` 的
`verifyWithKeySlots`）先用 `keyId` 对**全部**钉扎槽解析（无处可循即
`unknown-key`），**再要求解析到的槽号 == 签名声明的槽号**（否则
`slot-key-mismatch`）。两条合起来的推论是：

> **一个客户端在任一时刻只接受一把公钥——即其 `PINS_AT_RELEASE.current`。**
> 槽 2（`previous` + `retiredAt`）只对**声明 `--slot 2` 的签名**生效，而 M5
> 服务端永远无法收录 `--slot 2` 的 sidecar（intake 只配了 slot 1；
> `scripts/sign-manifest.mjs` 对 `--slot 2` 打印告警）。因此**槽 2 在 M5 的
> 服务端拓扑下实际不可达**，「轮换重叠期旧钥清单仍可验」这一设计意图
> （spec §14 第 41 条）在当前实现下**不成立**——见 spec §14 第 52 条。

实测四种组合（真实 ed25519 密钥，两包真实代码，`verifyMarketManifest` 直调）：

| 客户端钉扎 | 服务端签名钥 / 声明槽 | 结果 |
|---|---|---|
| current=K1 | K1 / slot 1 | **OK**（稳态） |
| current=K2, previous=K1（`retiredAt` 未到） | K1 / slot 1 | **REJECT `slot-key-mismatch`** |
| current=K2, previous=K1 | K2 / slot 1 | **OK** |
| current=K1（未升级） | K2 / slot 1 | **REJECT `unknown-key`** |

第 2 行与第 4 行合起来意味着：**「app 发版钉新钥」与「服务端换钥」无论孰先孰后，
都存在一段窗口使部分客户端拒绝目录**——发版先走则第 2 行命中（已升级客户端拒绝
仍由旧钥签名的清单），服务端先走则第 4 行命中（未升级客户端拒绝新钥清单）。
**M5 没有无中断的轮换顺序。**

### M5 的轮换程序（诚实版：把拒绝窗口压到最小）

选「app 发版先走 + 紧随服务端换钥」而不是相反，理由是爆炸半径：app 发版是**渐进**
的（数天至数周），服务端换钥是**瞬时**的。发版先走时只有「在两步之间恰好升级」的
少数客户端受影响，且第 3 步一完成即自愈；服务端先走则**全部**未升级客户端立即恒拒，
直到它们各自升级。

1. 离线签名机 `gen-signing-key.mjs` 生成新钥对 K2；新公钥指纹经**带外渠道**告知
   app 发版负责人（见下「公钥分发与指纹核对」）。
2. app 发版把 **current = K2、previous = K1（`retiredAt` = 发版时刻 + 一个发版
   窗口）** 钉进 `PINS_AT_RELEASE`。注意：升级到该版本的客户端**即刻拒绝仍由 K1
   签名的清单**（上表第 2 行），故第 3 步必须在**同一维护窗口内**紧随执行。
3. 同一窗口内把 market-server 的 `MARKET_SERVER_VERIFY_PUBLIC_KEY` 指向 K2 并
   **重启**；随后用 K2 私钥 `--slot 1` 签新清单（`revision` 继续单调递增，
   `notAfter` ≤ issuedAt + 7d）。此后已升级客户端恢复（上表第 3 行）。
4. 第 3 步之前**尚未**升级的客户端在第 2、3 步之间恒拒；第 3 步之后升级的客户端
   直接落到第 3 行，正常。窗口内目录不可用期间**本地安装旁路不受影响**
   （MarketView「本地安装」页签走 host RPC，不经 market routes）。
5. `retiredAt` 过后槽 2 机判拒绝（`slot-retired`）；旧私钥 K1 离线销毁。

**不得**：为了「让旧钥清单继续可验」而用 K1 签 `--slot 2` 的 sidecar——服务端
intake 只配了 slot 1，该 sidecar 会被拒（K1 已配置时 `slot-key-mismatch`，K1 未
配置时 `unknown-key`），永远无法激活。

### M6 处置候选（机制修复，二选一，须单独评审）

- **让服务端也支持两槽**：`keySlotsFromConfig` 读两把公钥、intake 接受
  `--slot 2`，于是重叠期内旧钥清单可以 `--slot 2` 声明并被双方接受（真正兑现
  第 41 条的重叠期意图）；或
- **放宽 wrapper 的槽号相等判定为以 `keyId` 解析为准**（声明槽降为元数据），
  `retiredAt` 仍按解析到的槽判定。安全性不因此减弱：`keyId` 是公钥的 sha256
  指纹，攻击者仍需持有被钉扎公钥对应的私钥；在 `keyId` 权威之后，槽号声明不
  提供额外保证。**此项属验签语义变更，须单独评审 + 落共享测试向量，不在 M5
  修复轮范围内**（本轮只做诚实化登记，未改验签代码）。

登记：AGENTS.md 技术债表「M5 市场签名轮换无重叠窗口」行 + spec §14 第十轮
第 52 条。

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
