# M5 真机冒烟记录（离线等价）— 2026-09-26

Task 8 Step 3。驱动器：`dsh-plugin-huaanwork/tests/huaanwork-host/market-smoke-live.spec.ts`
（`MARKET_SMOKE_LIVE=1` 门控，默认 skip，不进入常规门禁）。本记录逐项标注
** exercised 层级**，未做 UI 驱动的不声称 UI 驱动。

## 环境

- FORK 仓库 `HuaAnWork-Desktop`：初跑 `fca41276cc`，最新复跑 `fe3765b63d`
  （+ 本冒烟新增 spec）。
- Node v22.23.2（满足 `^22.19.0`）。
- 应用自带 pnpm（round6 S2 版本基线）：`dsh-plugin-huaanwork/node_modules/pnpm/bin/pnpm.mjs`
  = **11.8.0**（初跑时点 PATH pnpm 为 10.32.1，两侧结果均绿——该双版本对照为
  **历史时点证据**：当前树两者均解析 11.8.0，不再可复现，见下 round6 S2 节）。
- 冒烟时间：2026-09-26 16:53 本地；**2026-09-27 08:20 评审修复批后在
  `fe3765b63d` 复跑刷新**（1 passed / 2.3s；spec 其间经 `8295b835ee`、
  `db2922126e` 与评审修复批演进）。

## 拓扑（全部真实件）

- **真实 market-server 子进程**：`node --experimental-strip-types market-server/src/index.ts`，
  env 四必需项（`MARKET_SERVER_PORT` / `_DATA_DIR` / `_PUBLIC_ORIGIN=http://127.0.0.1:<port>` /
  `_VERIFY_PUBLIC_KEY=<keygen 产出 .pub.hex>`）+ `MARKET_SERVER_ADMIN_TOKEN`。
  loopback = 内网等价；`PUBLIC_ORIGIN` 用真实 loopback origin（信封 `domain` 钉扎值）。
- **真实离线签名工具链**：`scripts/gen-signing-key.mjs --out <tmpdir>`（脚本自带
  「拒绝写入 git worktree」守卫）→ 管理面 `POST /v1/admin/manifest/prepare` → 下载
  pending → `scripts/sign-manifest.mjs --manifest … --key … --slot 1`（**独立进程**，
  私钥永不进服务端进程）→ `POST /v1/admin/manifest/signature` 激活
  （应答 `{activated:true,revision,slot}`）。
- **真实 wrapper**：`registerMarketRoutes` 实注册 7 条表外 routes（fake
  `ctx.webServer` 仅记录注册；handler 为生产代码原样直调）；revision store 用真实
  文件实现 `createFileRevisionStore`（`<profileDir>/.market-artifacts/state.json`）。
- **应用自带 pnpm**：stub 以 `node <app>/node_modules/pnpm/bin/pnpm.mjs` 执行，
  密封 `--store-dir`/`--cache-dir`（每次新建空目录 = 冷 store/cache）。

## 结果：1 passed（vitest，约 3s）

| 项 | 结果 | 层级 |
| --- | --- | --- |
| 目录端点 `GET /v1/plugins` provider-page 负载 | 200 | 真实服务端 HTTP |
| 发布侧门：非零依赖制品 | **422 拒** | 真实服务端 HTTP |
| 发布侧门：带 `postinstall`（curl 载荷）制品 | **422 拒** | 真实服务端 HTTP |
| 两步离线签名流（真实工具，私钥独立进程） | 激活成功 revision 1（**历史时点写法「1..N」**：初跑时 spec 曾逐激活轮换 revision；HEAD 已改为单次激活 `revision === 1` + 其后等值幂等重读，spec §14 第 49 条） | 真实服务端 + 真实工具进程 |
| wrapper state/catalog/installable/installations | 200，installable 恰 2 项 | wrapper route handler |
| 装 A → 装 B → 卸 A → 卸 B 四步全绿，依赖数 0→1→2→1→0 | 绿 | route handler + removePlugin + 应用自带 pnpm |
| 每步 `file:` 引用实际存在（N1 回归门） | 绿 | pnpm 密封沙箱实证 |
| 制品装后不删、卸后 GC（无 `file:` 引用才删） | 1→2→1→0 个 .tgz | 同上 |
| add argv 恒带 `--offline --ignore-scripts`、无 `--registry` | 绿 | argv 快照 |
| remove argv 不含两 flag（N2 硬约束） | 绿 | argv 快照 |
| `pnpm-workspace.yaml` 逐字节不变（无批准键写入） | 绿 | 文件快照 |
| 防重放：持久 revision 已前进后重放旧清单 | **502 `market-verification-failed`** | 真实服务端 + 种子 revision store |
| origin 钉扎（X1）：跨源 tarball URL | 下载入口即拒，**零网络请求** | wrapper install 模块 |
| 取消重启诚实告知（§14 第 33 条）：message「已取消重启」、清单已写入不回滚 | 绿 | route handler |
| 装坏包恢复窗口：无自动回滚 + `routeDesktopStartupFailure` → `startup-recovery` | 绿 | wrapper 判定函数（窗口本体为 Electron 面，见「层级限制」） |
| 内网宕机：state 仍 200 诚实可读（本地 tab 旁路依据）、catalog 502 `market-unreachable` | 绿 | route handler（真实进程 SIGKILL 后） |
| 远程安装全程零非 loopback 连接 | wrapper HTTP seam 记录（每次 fetch 委托前记录 host）+ 阳性对照（记录数 >0，防记录器空转）= 仅 `127.0.0.1:*` | wrapper HTTP 注入缝（委托真实 `createMarketHttpClient`，socket 层为真实 node:http） |

## 断网/不触公网的论证（三证，本环境未做 pfctl 级封禁——记录为环境限制）

1. **机制强制**：每次市场 add argv 恒含 `--offline`（封死网络路径）+ 双门零依赖断言；
2. **冷缓存密封**：store/cache 双目录每次新建为空——任何触网解析必确定性失败，
   四步仍全绿 ⇒ 安装实际零网络依赖；
3. **连接记录**：记录器坐在 wrapper 的 HTTP 注入缝（`deps.http`）上——每次 `fetchText`/
   `fetchBuffer` 委托前记录目标 host，再委托真实 `createMarketHttpClient()`（真实
   node:http socket）；阳性对照断言记录数 >0（记录器空转则测试必失败，评审 round 1
   修正：模块导出补丁拦不到 wrapper 的 ESM `get` 绑定，初版记录器为空转，已废弃该做法）。
   实测全部记录目标为 `127.0.0.1:<port>`（loopback 源 + wrapper 自有 client）。

## round6 S2：应用自带 pnpm 密封语义复现

同一组密封断言套件以 PATH shim 指向应用自带 pnpm 复跑：

- `market-pnpm-semantics.spec.ts` + `market-e2e.spec.ts` → **11 passed / 0 fail**
  （套件自报 `[market-pnpm-semantics] pnpm version: 11.8.0`）。
- 对照：PATH pnpm 10.32.1（yarn-resolved）下同一套件此前 6/6 + e2e 全绿（Task 5）
  ——**此对照为历史时点证据**：当前树 PATH 与应用自带两侧均解析 11.8.0，
  双版本对照不再可复现；版本差异面（`ERR_PNPM_IGNORED_BUILDS` 第三重纵深）
  已按 round6 S4 版本条件化，两侧分支各有断言。
- 结论：两套 pnpm 版本下密封语义（`file:` 引用、卸载拒 flag、离线兜底、脚本零执行）
  均绿。

## 层级限制（诚实声明）

- **UI（MarketView renderer）未驱动**：本环境无显示/Electron 窗口。UI 是 wrapper
  routes 之上的薄 fetch 层；冒烟在 route handler 层 exercise 全部 7 条 routes 的
  生产代码路径，UI 专项留 `/plan-design-review`（已登记）。
- **恢复窗口本体**（`openStartupRecoveryWindow`）为 Electron 主进程面：冒烟只锁
  wrapper 层「无自动回滚」+ 启动失败路由承接两条可测语义（与 e2e 同口径），
  窗口 UI 由既有 startup-recovery-window.spec 单测覆盖。
- **公网断连**为 pfctl/拔网级证据的替代：以上三证为机制+冷缓存+连接记录的组合实证。
- **pnpm 调用封装差异**（round6 S2 复现的层级限制，P32）：复现只对齐了 pnpm
  **二进制**，未对齐生产**调用封装**——生产路径是
  `appExecutable --import clear-env pnpmBinPath …`（Electron-as-node + 环境清洗，
  `desktop-runtime-environment.ts` 还带 `PNPM_IGNORE_MINIMUM_RELEASE_AGE`），
  本冒烟为 `process.execPath [BUNDLED_PNPM, …]`。版本一致，封装不一致；
  封装层语义由 `verify:profile` 等常规门禁在别处覆盖。
- 占位 origin `market.intranet.example:8787`（`config.ts`
  `HUAANWORK_MARKET_DEFAULT_ORIGIN`）为**发版/部署期配置**（env
  `HUAANWORK_MARKET_ORIGIN` 覆盖），非可连真实地址；冒烟用真实 loopback origin
  验证 domain 钉扎全链。

## 复跑

```bash
cd dsh-plugin-huaanwork && MARKET_SMOKE_LIVE=1 corepack yarn vitest run tests/huaanwork-host/market-smoke-live.spec.ts
```
