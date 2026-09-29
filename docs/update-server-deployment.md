# update-server 部署 runbook（Task 3.5：只读内网更新服务端）

update-server 是 M6 内网更新通道的**只读**服务端：版本端点
`GET /api/desktop/version` + 制品端点 `GET /api/downloads/{mac,windows}`。
它**无账户体系、无口令、无任何写端点**：制品由运营者在部署机上经 `scp` +
`scripts/publish-release.mjs` 放入 `<dataDir>`，服务端只读这些文件。客户端
消费方是 `dsh-plugin-huaanwork` 的 `update-checker.ts` / `update-download.ts`。

## 进程形态与分发形态（登记偏离 D-M6-13 / D-M6-14）

- 单进程 `node`，**零运行时依赖**：`update-server/package.json` 没有
  `dependencies` 键（无原生模块、无数据库、无 HTTP 依赖）。服务端持有的全部
  状态 = `<dataDir>` 下的只读文件，且**每次请求重建、无内存缓存**——外部重发布
  在下一个请求即可见（`tests/version-service.spec.ts` 的
  「reflects an external republish on the very next request」）。
- 启动路径保留 **TS 直跑**（`node --experimental-strip-types src/index.ts`），
  另注册 `bin` 入口接受 `--port` / `--data`（**登记偏离 D-M6-13**：不做
  bundling 成单 `.js`——`--experimental-strip-types` 在
  `^22.19.0 || >=24.0.0` 下已是稳定路径，bundling 只会引入构建步骤与 source
  map 负担）。两个旗标是**便利**：env 值永远优先（`loadUpdateServerConfig`
  的 `env ?? overrides`）。
- 分发形态保持 `private: true`，经 **Dockerfile + git** 分发
  （**登记偏离 D-M6-14**：不发布到 npm——发布到公网 registry 与「整条链路不
  依赖公网」的产品定位冲突，且 `update-server` 这类通用名易被抢注）。

## 启动

```bash
corepack yarn install --immutable      # 仓库工作区内（仅 devDependencies）
corepack yarn workspace update-server start
# 或直接：
node --experimental-strip-types src/index.ts
# 或经 bin 入口（等价；env 仍优先于同名旗标）：
update-server --port 8790 --data /srv/huaanwork-updates
```

> 仓库工作区内 Yarn 不为工作区**自身**生成 bin shim
> （`nmHoistingLimits: workspaces`），所以本仓内请用上面前两条；`bin` 在包被
> 外部安装（或容器化）时生效。`node --experimental-strip-types src/index.ts
> --port 8790 --data /srv/huaanwork-updates` 与 bin 入口完全等价。

Node 要求 `^22.19.0 || >=24.0.0`（与仓库 engines 一致）。启动成功打印：

```
update-server: listening on 8790 for http://update.intranet.lan:8790
```

## 环境配置（三项必需、fail-closed）

缺任一必需项或值非法：进程打印指引（含完整 env 表）并以**非零码退出**，
不会半配置启动。错误由 `UpdateServerConfigError` 抛出，`code` 为
`missing-env` / `invalid-port` / `invalid-data-dir` / `invalid-public-origin`
/ `invalid-allowed-hosts` / `invalid-request-timeout` / `invalid-listen-host`。

| 变量 | 含义 | 校验 / 默认 |
| --- | --- | --- |
| `UPDATE_SERVER_PORT` | 监听 TCP 端口 | 必需；整数 1..65535 |
| `UPDATE_SERVER_DATA_DIR` | 发布数据目录（绝对路径）。服务端只读，**从不创建或写入**它；`channels/<channel>.json` 与 `artifacts/` 都由运营者放入 | 必需；非空绝对路径 |
| `UPDATE_SERVER_PUBLIC_ORIGIN` | 本服务对外 origin，如 `http://update.intranet.lan:8790` | 必需；http/https、无 userinfo/path/query/fragment。内网**允许 plain http**——制品完整性由客户端的 sha256 比对保证（D-M6-23），不靠 TLS |
| `UPDATE_SERVER_ALLOWED_HOSTS` | `Host` 头白名单（逗号分隔；条目可带端口，不带端口则覆盖该主机任意端口） | 可选；缺省由 `UPDATE_SERVER_PUBLIC_ORIGIN` 的 host 派生。**其他 Host 一律 403 `host-not-allowed`** |
| `UPDATE_SERVER_REQUEST_TIMEOUT_MS` | request / headers / socket 不活跃超时（毫秒） | 可选；默认 `30000`，必须 > 0（P8 形态：绝不使用 Node 的 0 = 无界超时） |
| `UPDATE_SERVER_LISTEN_HOST` | 监听地址 | 可选；默认 `0.0.0.0`（内网必须可达） |

**本服务没有 `UPDATE_SERVER_ADMIN_TOKEN`，也没有任何写端点**——这是
2026-09-28 的定型（写路径整体移除，Task 3.4 作废）：没有上传端点、没有
上架/下架端点、没有删除端点、没有 admin 页面。运营者排障时**不要去找一个
不存在的口令**；一切"写"都发生在部署机的文件系统上（见〈发布流程〉与
〈制品下架/删除〉）。历史遗留下的 `UPDATE_SERVER_ADMIN_TOKEN` 会被静默忽略，
不会把 admin 面"长回来"（`tests/config.spec.ts` 有对应负例）。

示例（systemd unit 的 `Environment=` 同口径）：

```bash
export UPDATE_SERVER_PORT=8790
export UPDATE_SERVER_DATA_DIR=/srv/huaanwork-updates
export UPDATE_SERVER_PUBLIC_ORIGIN=http://update.intranet.lan:8790
node --experimental-strip-types src/index.ts
```

## HTTP 面

| 路由 | 语义 |
| --- | --- |
| `GET /healthz` | 存活探针：`{"ok":true}`。不读数据目录 |
| `GET /api/desktop/version` | 通道范围内的发布元数据：`{"version","channel","sha256":{mac?,windows?}}`。请求头必须带 `X-DSH-Desktop-Channel`（缺失/未知 = 404 `unknown-channel`，**绝不回退到 stable**）；`X-DSH-Desktop-Version`、`X-DSH-Desktop-Installation-Id` 只记日志、不鉴权不比对（D-M6-11）。**永不重定向**（客户端 `redirect:"error"`）；响应体远小于客户端 4 KiB 上限 |
| `GET /api/downloads/mac`、`GET /api/downloads/windows` | 流式直出记录中的制品。请求头带通道 + `X-DSH-Desktop-Target-Version`（客户端刚查到的目标版本）；响应 `Content-Length` = 记录字节数、`X-HuaAnWork-Artifact-Sha256` = 发布时 sha256（运营者用它与发布输出对账） |

错误体统一 `{"error":{"code","message"}}`，不泄露路径、env 或内部细节：

| 状态 | code | 含义 / 处置 |
| --- | --- | --- |
| 400 | `invalid-header` | 某个客户端头值含控制字符（值既不回显也不进日志） |
| 403 | `host-not-allowed` | `Host` 不在 `UPDATE_SERVER_ALLOWED_HOSTS`（检查反向代理是否改写了 Host） |
| 404 | `unknown-channel` | 通道头缺失或不是本服务供应的三个通道 |
| 404 | `no-release` | 该通道还没有任何发布记录（`channels/<channel>.json` 不存在） |
| 404 | `version-mismatch` | 下载请求的目标版本 ≠ 记录里的当前版本（含目标头缺失） |
| 404 | `no-artifact` | 记录里没有该平台条目（正常的"这个平台还没发"） |
| 500 | `corrupt-channel-record` | 记录存在但不是合法记录（fail-closed：绝不降级成"没有更新"） |
| 500 | `artifact-missing-or-truncated` | 记录指向的文件缺失、不是常规文件、或大小与记录不符。**绝不答 404**——客户端把 404 读作"没有更新"，会把发布事故伪装成正常状态 |

快速自检（在部署机上，注意 `Host` 必须是白名单里的值）：

```bash
curl -s -H 'Host: update.intranet.lan:8790' http://127.0.0.1:8790/healthz
curl -s -H 'Host: update.intranet.lan:8790' \
  -H 'X-DSH-Desktop-Channel: huaanwork' \
  http://127.0.0.1:8790/api/desktop/version
curl -sI -H 'Host: update.intranet.lan:8790' \
  -H 'X-DSH-Desktop-Channel: huaanwork' \
  -H 'X-DSH-Desktop-Target-Version: 0.2.0' \
  http://127.0.0.1:8790/api/downloads/mac | head -8
```

## 制品命名规则（三通道 × 两平台）

服务端**不改名**：它原样托管运营者经 `scp` 放进
`<dataDir>/artifacts/<channel>/<platform>/` 的文件；命名规则的意义在于让
运营者**放对文件**。下表左半边是客户端"保存对话框默认名"
（`desktopUpdateFilename`），只用于人读；**真实制品名与它本就不同**（前者是
保存对话框的默认名，见 Task 4.1 的同款说明），运营者以
`publish-release.mjs` 写入记录里的 `filename` 为准。

| 通道 | 平台 | 客户端默认名（`desktopUpdateFilename`） | 真实发布流水线制品名 |
| --- | --- | --- | --- |
| `huaanwork` | mac | `HuaAnWork-<version>-mac.dmg` | `<product>-<version>-universal.dmg`（electron-builder `--mac dmg --universal`；**basename 必须带 `universal` 标记**，publish 脚本第 2 步强制） |
| `huaanwork` | windows | `HuaAnWork-<version>-windows.exe` | 现行 NSIS 制品名仍读作 `DSH-Desktop-Beta-<version>-<arch>-Setup.exe`（AGENTS.md 登记债，Task 6 的 M6 处置；与更新通道无关——通道只看记录里的 `filename`） |
| `stable` | mac | `DSH-Desktop-<version>-mac.dmg` | 同 mac 规则（`universal` 标记） |
| `stable` | windows | `DSH-Desktop-<version>-windows.exe` | 以 publish 记录里的 `filename` 为准 |
| `beta` | mac | `DSH-Desktop-Beta-<version>-mac.dmg` | 同 mac 规则（`universal` 标记） |
| `beta` | windows | `DSH-Desktop-Beta-<version>-windows.exe` | 以 publish 记录里的 `filename` 为准 |

版本形状按通道裁定（D-M6-1）：`stable` / `huaanwork` 只收**无 prerelease**
的规范 SemVer，`beta` 只收 `-beta.<数字>`。版本号里不要带 `v` 前缀、
不要写 `0.1` 这类缩写——publish 脚本第 4 步按同一规则拒绝。

## 发布流程（人工，四步）

1. **构建机产出制品**：mac 制品必须在 macOS 上产出（universal dmg；
   Task 4.7 的 artifact 或 R1 的 credentialed 机器），Windows 制品为 NSIS
   `.exe`。
2. **放进服务目录**：先建目录再 `scp`——

   ```bash
   ssh <deploy-host> mkdir -p <dataDir>/artifacts/<channel>/<platform>
   scp <artifact> <deploy-host>:<dataDir>/artifacts/<channel>/<platform>/<filename>
   ```

3. **登记发布记录**（在部署机上、`<dataDir>` 旁；本脚本是
   `channels/<channel>.json` 的唯一写者）：

   ```bash
   node update-server/scripts/publish-release.mjs \
     --channel huaanwork --version 0.2.0 --platform mac \
     --file <dataDir>/artifacts/huaanwork/mac/<filename>
   # --data-dir 缺省取 UPDATE_SERVER_DATA_DIR（与服务端同一变量）
   ```

   脚本自证其步骤与输出（**以它打印的指引为准**，本文不复述）：① 制品形状
   （与客户端下载后校验同源）→ ② mac universality（挂载 dmg 读内部
   `.app`；**mac 制品必须在 macOS 主机上发布**，`hdiutil` 是硬依赖）→
   ③ 客户端 1 GiB 上限 → ④ 版本形状 → ⑤ 流式 sha256（D-M6-12，绝不整文件
   读入内存）→ ⑥ 位置校验（`--file` 必须就是服务端将读取的那个路径）→
   ⑦ 原子写记录（临时文件 + rename，0700/0600；同版本重跑保留另一平台条目）。
4. **客户端下次检查即可见**：服务端无缓存，客户端每次版本检查都现读记录。

**每一步失败时运营者该看什么**（脚本以
`publish-release: step <名> failed: <原因>` + `nothing was written` 收尾；
修正调用或制品后重跑即可，不会留下半份记录）：

- `1 installer shape`：制品不是 koly 尾的 dmg / 不是合法 PE——重新从构建机取件。
- `2 mac universal`：basename 缺 `universal` 标记、内部 app 单架构、或主机无
  `hdiutil`——换 macOS 发布机重跑。
- `3 artifact size`：超过客户端 1 GiB 上限——不要发布会被客户端拒收的制品。
- `4 version shape`：版本不符合该通道形状——改版本号或改通道。
- `5 sha256`：哈希期间制品尺寸发生变化（文件被其它进程改写）——脚本报
  「the artifact changed size while it was being hashed」；发布期间不要让
  其它进程动该文件，重新取件后重跑。
- `6 placement`：文件不在 `<dataDir>/artifacts/<channel>/<platform>/`——脚本
  会打印确切的 `scp` 目标行；先执行它再重跑。
- `7 record`：既有记录不是合法 JSON——人工查看（或移除）该记录后重发；
  不要手工编辑记录。
- `arguments`：调用参数错误（未知/重复/缺值的旗标、缺 `--data-dir` 且未设
  `UPDATE_SERVER_DATA_DIR`、`--channel` / `--platform` 不在允许集内）——
  按脚本打印的指引修正调用；不会触碰任何已发布文件。
- 成功输出中的 `5 sha256` / `bytes` / `7 record <路径>` 请记入发布工单，
  用于与客户端的 `X-HuaAnWork-Artifact-Sha256` 对账。

## 制品下架 / 删除（硬顺序：先改记录，后删文件）

本服务没有删除端点（Task 3.4 作废），下架完全由运营者在文件系统上完成。
**顺序是硬规定：**

1. **先**改通道记录：重发布上一个版本（三平台各自走 publish 流程），或删掉
   该平台条目（需要手工改记录时，改完必须仍是合法 JSON）。
2. **再**删制品文件：`rm <dataDir>/artifacts/<channel>/<platform>/<filename>`。

反序（先删文件、记录仍指向它）会让下载路由答
`500 artifact-missing-or-truncated` 而不是干净的 `404 no-artifact`——客户端把
它读作**发布事故**（这是刻意的：一个不可达的服务必须说出来）。这正是
market-server **D2** 数据丢失的同一根因（删除前未查引用）；本服务以
**流程顺序**而非代码检查来防（服务端只读，不持有引用表），故 runbook 必须把
顺序写成硬规定。

## 与 market-server 共址部署的建议

两个服务端可以同机部署（同一台内网部署机、不同端口、各自独立的
`<dataDir>`）：

- 端口：update-server 用 `8790`、market-server 用 `8787`（默认值即错开）。
- 数据目录：**不要共用一个 `<dataDir>`**——update-server 只读
  `channels/` + `artifacts/`，market-server 有 `catalog-state.json` 与文件锁。
- 凭据：**market-server 有 `MARKET_SERVER_ADMIN_TOKEN`（发布制品必须），
  update-server 没有任何口令**——不要让运营者去找一个不存在的口令。
- 反向代理：两个服务可以共用一个对外前端，但 Host 白名单/路由要分别配置；
  update-server 的 `UPDATE_SERVER_ALLOWED_HOSTS` 缺省只认
  `UPDATE_SERVER_PUBLIC_ORIGIN` 的 host。

## Dockerfile 与容器运行

`update-server/Dockerfile`（spec §11 要求；与 `market-server/Dockerfile`
同构）：非 root（uid `10001`）、只拷 `package.json` + `src`、**不设 VOLUME、
不写死 data dir**——数据目录由部署方经 env + bind mount 提供。

```bash
docker build -t huaanwork/update-server -f update-server/Dockerfile update-server
docker run --rm -p 8790:8790 \
  -e UPDATE_SERVER_PORT=8790 \
  -e UPDATE_SERVER_DATA_DIR=/data \
  -e UPDATE_SERVER_PUBLIC_ORIGIN=http://update.intranet.lan:8790 \
  -v /srv/huaanwork-updates:/data:ro \
  huaanwork/update-server
```

镜像内只有 `package.json` 与 `src/`，`CMD ["node","--experimental-strip-types","src/index.ts"]`
即可启动（零运行时依赖已由 Task 3.1–3.3 的测试钉住）。

> **若加 HEALTHCHECK 或任何本机探针**：探针请求的 `Host` 必须在
> `UPDATE_SERVER_ALLOWED_HOSTS` 里（缺省 = `UPDATE_SERVER_PUBLIC_ORIGIN` 的
> host；skeleton 对白名单外的 Host 一律 403）。例如
> `HEALTHCHECK CMD curl -sf -H "Host: update.intranet.lan:8790" http://127.0.0.1:8790/healthz`。

## 威胁模型边界（诚实声明）

本服务**无账户体系、无口令、无写端点**，明文 http 在内网可接受。但它分发的
是**可执行安装器**：本服务的信任边界不在 HTTP 层，而在**部署机**——能
`ssh`/`scp` 到部署机、或对 `<dataDir>` 有写权限的人，就等于能向全内网分发
任意代码。因此：

1. **部署机与 `<dataDir>` 的访问控制是本服务唯一的鉴权面**，须按发行机密的
   等级管理（谁可登录、谁可写盘 = 谁能发布）。
2. 服务**必须部署在受控内网段**；不要直接暴露到不可信网络。
3. 若确需向公网分发，**必须在前面加一层做真实鉴权与 TLS 终止的反向代理**；
   本服务自身不提供这两者。
4. 客户端的 sha256 比对（D-M6-23）防的是**传输/存储层篡改**，它**不防**
   同时控制版本端点与下载端点的攻击者（那类攻击者的 sha256 与制品一起被改，
   比对自然通过）。该残余风险由**签名/公证**兜底（spec §5.5 第 9 条）——
  **不得把 sha256 说成签名**。本服务不代签、不验签。

## 灾备旁路：nginx 顶替（不等价，仅应急）

本服务是只读静态内容服务，应急时可直接用 nginx 指向 `<dataDir>` 顶替，但
**必须自行实现两个端点的语义**（版本 JSON 与制品直出），且它**不等价**：

```nginx
# 示意：仅应急。按实况调整；章节末列出不等价项。
map $http_x_dsh_desktop_channel $us_channel { default ""; stable stable; beta beta; huaanwork huaanwork; }
server {
  listen 8790;
  server_name update.intranet.lan;
  location = /api/desktop/version {
    if ($us_channel = "") { return 404; }
    # 由运维从 channels/<channel>.json 预生成（保留 version/channel/sha256 字段语义）
    alias /srv/huaanwork-updates/bypass/$us_channel/version.json;
    add_header Content-Type application/json always;
    add_header Cache-Control no-store always;
  }
  location /api/downloads/ {
    if ($us_channel = "") { return 404; }
    alias /srv/huaanwork-updates/artifacts/$us_channel/;  # 需按 mac|windows 子目录再映射
  }
}
```

**不等价之处（只作应急）：**

- 不做通道校验与版本形状校验（`channels/<channel>.json` 的合法性由预生成
  脚本负责）。
- **不做 bytes 核对**：记录说 200 字节、盘上短了，nginx 照发或照 404，
  拿不到 `500 artifact-missing-or-truncated` 的诚实语义——下架顺序的护栏在
  旁路下失效，只剩客户端 sha256 兜底。
- 不产生 `X-HuaAnWork-Artifact-Sha256` 响应头（对账能力丢失）。
- 不实现 `404 version-mismatch` / `unknown-channel` 等细分错误码语义。
- 恢复正式服务前，客户端仍按同一 origin 轮询——旁路期间不要让它比正式服务
  多答或少答字段（客户端对响应形状的校验会 fail-closed 为"检查失败"）。

## 备份与恢复

- **备份**：整体复制 `<dataDir>`（`channels/` + `artifacts/`）即可——没有
  一致性难题（记录是原子替换的单文件）。建议每日复制 + 每次发布后即时复制。
- **恢复顺序 = 先制品文件、后 `channels/*.json`**（与下架顺序相反的理由是
  同一件事：**记录一旦可见，它指向的制品必须已在位**）。恢复期间的短暂窗口
  里宁可答 `404 no-release`，也不要答 `500 artifact-missing-or-truncated`。
- 记录损坏 = fail-closed：服务端答 `500 corrupt-channel-record` 并把它记入
  日志，**不会**降级成"没有更新"。用备份里的对应文件替换，不要手工编辑。

## 升级与回滚

- **升级**：停进程 → `git pull` + `corepack yarn install --immutable` →
  重启（服务端无状态，无迁移步骤）→ 用〈HTTP 面〉的自检命令确认
  `GET /healthz` 与 `GET /api/desktop/version` 正常。
- **回滚 = 重新发布旧版本**：版本记录是**不可变身份**，回滚就是用
  `publish-release.mjs` 把旧版本重新发布成该通道的当前记录（旧制品若已删，
  须先从备份取回制品再发布）。
- 注意客户端语义：普通升级路径只在"服务端版本 > 本机版本"时提示更新
  （`allowDowngrade` 未开时低版本显示 `up-to-date`），所以**把通道回退到低
  版本不会让已升级的客户端自动降级**——降级需要显式通道切换/允许降级的
  入口，或重装。服务端的职责只是把旧记录诚实地发布回去。

## 与客户端的耦合点（发版前逐条核对）

- `HUAANWORK_UPDATE_ORIGIN`（客户端）**必须等于** `UPDATE_SERVER_PUBLIC_ORIGIN`
  （服务端）：前者缺省是不可达占位符 `http://update.intranet.example:8790`，
  未配置的部署会 fail-closed 地检查失败（不查公网）。两者必须逐字同源
  （协议 + 主机 + 端口，无 path/query/fragment）。
- **通道标签必须回显**：版本端点的响应 `channel` 必须等于请求通道
  （客户端对 non-stable 通道做强校验），且三通道名必须与客户端
  `SUPPORTED_RELEASE_CHANNELS` 一致：`stable` / `beta` / `huaanwork`。
- **版本必须是无 prerelease 的规范 SemVer**（`huaanwork` / `stable`；`beta`
  为 `-beta.N`）——裁定 D-M6-1，服务端读侧与发布侧双重强制。
- 下载端点路径必须与客户端一致：`/api/downloads/mac`、`/api/downloads/windows`
  （由 `dsh-plugin-huaanwork/tests/update-server-contract.spec.ts` 双侧共享
  fixture 钉住）。
- 客户端下载后按 sha256 比对制品（D-M6-23）；服务端发布时记录的 sha256 必须
  是**将被服务的那份字节**的摘要（publish 脚本第 5/6 步保证）。

## 文档门禁（双语）

`corepack yarn check:bilingual-docs` 只枚举 git 已跟踪的 `*.i18n.yaml` 记录
对（`docs/plugin-development.i18n.yaml` 一类）。本文档与
`docs/market-server-deployment.md` 一样**不在该守卫的覆盖集内**——它没有
同名 `.i18n.yaml` 记录，故新增本文档前后守卫输出不变
（2026-09-28 Task 3.5 实测：`verify-bilingual-docs: 53 records and 106
documents are consistent`，加入本文档后原样复现）。它仍是单语文档；双语化
须另建记录对，属后续文档工作。
