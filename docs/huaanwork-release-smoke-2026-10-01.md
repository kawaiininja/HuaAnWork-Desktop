# M6 双平台安装包冒烟记录（R1）— 2026-10-01

Task 7.3。本记录由续跑实现者（`impl-7.3-cont`）整编前实现者（`impl-7.3`，150 轮
截断于写记录之前）的全部机器证据，并叠加本轮的只读核验（`task-7.3-cont-verification.txt`）。
逐项标注 **exercised 层级**：真机、文件系统、打包产物内 shipped 代码、静态分析、
待人类；**未做 UI 驱动的不声称 UI 驱动**。全部证据落在
`.superpowers/sdd/2026-09-27-dsh-desktop-integration-m6-migration-release/logs/task-7.3-*`。

## 环境与运行元数据

- 仓库 `HuaAnWork-Desktop`：被测 HEAD `54d03efae6`（2026-10-01 23:21:16 +09:00，
  「docs(huaanwork): follow up the migration smoke findings」——早于冒烟窗口 23:32 开始，
  时序成立；本记录提交前树干净，末次核验见 `task-7.3-cont-verification.txt`）。
- 机器时区 +09:00；Node v22.23.2 / Yarn 4.18.0 / arm64。
- 构建（本轮，**路径替代按裁定 R-7.3-4**）：工作区级
  `cd dsh-plugin-huaanwork && corepack yarn dist:mac-smoke`（= `node scripts/package-mac.ts`），
  23:32:31 → 23:38:17，`MACSMOKE_EXIT=0`（`task-7.3-build.log`；链内
  `macOS DMG smoke verification passed` = 挂载 dmg 校验 Info.plist）。
  **未运行**根 `dist:mac-smoke:huaanwork`：其首步 `aa:prepare-release` 现会注入 AA 桥
  （副作用面 = 3 个 package.json + yarn.lock + vendor provenance，见 Task 7.2 的
  `task-7.2-aa-injection-evidence.txt`），构建将来自未提交状态；本轮无任何 AA 副作用。
  **差异面披露**：替代路径不注入 AA 桥（与 Task 7.2 成功路径同口径）。
- 两轮制品 hash 对比（`task-7.3-pre-rebuild-hashes.txt` vs `task-7.3-artifact-hashes.txt`；
  本轮**未复用** 7.2 制品，按 R-7.3-4 重新构建）：

  | 轮 | dmg sha256 | app 二进制 sha256 |
  | --- | --- | --- |
  | 7.2 修复轮（23:12 重建） | `4e03117c210fe7ab5895294f9017edd6ce3d7eafe2b5dd0ae1f4dcb26298095b` | `4f7513861419dc713ec1ec7f408b972ae59e4f9e7eb84bbd6ed68fe12fc2eb89` |
  | 7.3 本轮（23:37 构建） | `8dc014a72fd684db19d89672d214f06446c1ad3751920cd5b0bc8fc456c5d242` | `0a5f7fc110e5e170b1db9cf99333b189c57325b62e5c6f4e4c9056e05516d090` |

  本轮 dmg = `dsh-plugin-huaanwork/dist/mac-smoke/HuaAnWork-0.1.0-universal.dmg`，
  **531,865,729 bytes**。
- 制品身份（本轮从构建出的 bundle 直接核验）：`Contents/Info.plist` 的
  `CFBundleIdentifier = app.huaanwork.desktop`、`CFBundleName/CFBundleDisplayName = HuaAnWork`、
  版本 0.1.0。
- 启动时序：launch1 **23:39:48**（无 `HUAANWORK_UPDATE_ORIGIN`）；launch2 **23:45:25**
  （`HUAANWORK_UPDATE_ORIGIN=http://127.0.0.1:8794`）；两轮均 `APP_EXIT=0`。
- 更新服务端：本机 loopback `127.0.0.1:8794`，数据目录
  `~/Downloads/huaanwork-m6-update-server-data/`（原注记 **保留**供人类 UI 核对与再部署；
  **该目录已于 2026-10-10 删除**——M4 人类核对与 M8 更新链 digest 冒烟均已消费完毕，
  复跑需先重建，见「复跑与再部署」注记）；
  23:43:54 发布 0.1.1；`SERVER_EXIT=0` 干净停止。当前无任何进程/监听（核验在案）。

## Step 1：macOS 未签名冒烟包

| 核对项 | 结果 | 层级（可核证据） |
| --- | --- | --- |
| 构建产出 dmg | **已执行**：`HuaAnWork-0.1.0-universal.dmg`（531,865,729 B），`MACSMOKE_EXIT=0` | 真机（`task-7.3-build.log`） |
| `afterPack` / `afterAllArtifactBuild` 钩子 | **已执行**：构建内钩子成功时无输出；以 `task-7.3-hook-replication.mjs` 按同一上下文复现钩子函数体——`verifyElectronExecutableFuses: PASS`、`smokePackagedElectronRuntime: PASS`（DSH CLI / pnpm CLI / 打包运行时 / desktop CLI dump-config / desktop CLI loader boot），`HOOK_REPL_EXIT=0`；fuses `RunAsNode=ENABLE`（49；打包二进制兼任 CLI 冒烟的 Node 运行时，`verify-electron-fuses.ts:95` 无条件要求）、`EnableEmbeddedAsarIntegrityValidation=DISABLE`、`OnlyLoadAppFromAsar=DISABLE`，`usesAsarLayout=false` | 真机（`task-7.3-hook-replication.log`） |
| `Resources/app/` 下 `skills/`、`cordis.patch.yml`、`lib/`、`package.json` 俱在 | **已执行**：四项 + `build/app-icon.ico` 制品内实地核对在；权威 `build.files` 含 `skills/**` 与 `build/app-icon.ico`；`appId=app.huaanwork.desktop`、`productName=HuaAnWork` | 文件系统（`task-7.3-packaged-fs-checks.txt`） |
| 首启不进恢复窗口（M3 冒烟缺陷 1 的回归） | **已执行（两次启动）**：launch1/launch2 均 `startup.run.completed {finalStage:health-commit, rendererStatus:healthy}`，`startup.stage.failed` / `startup.run.failed` / recovery 事件 0 条；M3 缺陷 1 的两个具名根因（`skills/`、`app-icon.ico` 在 `build.files`）已在制品核对在位 | 真机（两份 lifecycle jsonl；启动差分法见下） |
| 关于框/产品名显示 HuaAnWork、bundle id `app.huaanwork.desktop` | 机器面已执行（Info.plist 直检，见上）；**关于框显示 = 待人类** | 文件系统 + 待人类 UI |
| 更新检查未配 origin 时静默无结果（fail-closed），不指向 `dshdesktop.cn` | **已执行**：shipped 检查器无 origin → `null`（24 ms）；launch1（无 origin）无任何请求到达真实主机；出厂代码 `dshdesktop.cn` 字面量零命中（唯一命中 = 包内 `node_modules/dshmarket/README.zh.md` 文档）；默认 origin = 不可达的 `http://update.intranet.example:8790` | 打包产物内 shipped 代码 + 真机（`task-7.3-negative-no-origin.log`、`task-7.3-origin-greps.txt`） |
| 市场面：未钉公钥时恒拒且文案诚实 | 机器面 = 恒拒（守卫输出，见 Step 2）；**文案诚实 = 待人类** | 静态 + 待人类 UI |
| 图标已换、Dock/标题栏/tray 一致 | **待人类**：步骤与接触表见 Task 7.2 记录附录 A（本记录不重复） | 待人类 UI |

启动证据法（两次启动通用）：`task-7.3-launch1-baseline.txt` 先记启动前
`~/Library/Application Support/HuaAnWork/lifecycle-events/startup.jsonl` = 22 行（尾行 = 7.2
二启 run），启动后按行数差分提取新增 run 存为 `task-7.3-launch1-lifecycle.jsonl`（22 行，runId
`3148ff26-…`）；launch2 同法（runId `eb9bf7ac-…`）。

**两次启动打印的迁移消息 = marker 常驻通告，非迁移重跑**：`runHuaanworkLegacyMigration` 在
marker 已存在时直接返回既有 marker（`src/huaanwork-migration/index.ts:103-106`，
performed=false），`main.ts:1203` 照印摘要。marker 未被触碰：sha
`84924ded08b46d64a5e117f38aa1c7c60fbf76bef863efac8c77a6922e4e9fe3`（与 7.2 评审钉住的
未变值一致），mtime 21:53:20，`migratedAt 2026-10-01T12:53:20.996Z`——均早于 23:39/23:45
两次启动。启动对象 = **既有 userData（非干净家）**；7.2 已消费真实首启。

launch2 还证明**打包应用 → loopback 服务端**链路真实可达：后台检查（激活后 60 s，
`initialDelayMs`）携带安装 UUID 到达版本端点，服务端记录
`channel=huaanwork installed=0.1.0 installation=0a2c4f7a-335b-4449-b717-2dff25a53293`
（`task-7.3-app-loopback-check.txt`）。

## Step 2：macOS 签名+公证（`dist:mac:huaanwork`）— 未执行，阻塞于凭据

按裁定 **R-6（2026-09-30）**：凭据采购为触发式延后，**这是预期状态而非缺陷**；
**不得声称已签名**。本 Task **未运行** `corepack yarn dist:mac:huaanwork`，
`verify-mac-release.ts` 三道门与 `spctl --assess` 验收均未执行、零声称。

证据 = 守卫的非零退出原文（`task-7.3-provisioning-guard.log`，`GUARD_EXIT=1`），
框架 = **管线就绪但值未填**：

- 未完成发行 provisioning（unprovisioned release build）：市场信任锚或内网 origin 仍是占位；
- `PINS_AT_RELEASE.current.publicKeyHex` / `keyId` 未钉入 ⇒ **market 验签恒拒（fail-closed）**；
- `HUAANWORK_MARKET_DEFAULT_ORIGIN` / `HUAANWORK_UPDATE_DEFAULT_ORIGIN` 仍是含 `.example`
  的构造性不可达占位；真实值由 R2 提供、R1 在发行分支钉入（D-M6-18）；
- 诚实说明（守卫原文）：env 覆盖只重指运行期 origin，不构成对信任锚的 provisioning。

7.4 出口审计表的「签名公证」行按 R-6 口径标注（预期终态，不构成 M6 收口阻塞），
且**双证据位同时如实标注**：Step 2（macOS）与本记录 Step 3b（Windows）**两个证据位均为空**
（R-6 生效期允许的收口形态；无单侧悬空）。

## Step 3 / 3b：Windows 安装包与 Authenticode 签名 — 阻塞于 R2 provisioning

**未执行、零声称。** 原因（预检发现 F4）：`release.yml` 的 mac 与 windows 两个 job 均以
`huaanwork-verify-provisioning.mjs` 为 fail-fast 步（`:89` / `:158`），根命令
`dist:win:huaanwork` / `dist:win-portable:huaanwork` 同门控（`package.json:1218-1219`）⇒
未 provisioning 期 CI **不产出任何制品（含 mac）**，Windows 无 guard-free 的 CI/根路径。
守卫行为是 Task 4.8 / D-M6-18 的刻意设计（未完成 provisioning 的构建不放行制品），
**不是缺陷、不得绕过**（R-7.3-2）。守卫 exit-1 原文见 `task-7.3-provisioning-guard.log`。

**provisioning 到位后的重跑指引（保留）**：

```bash
# R1 在发行分支钉入 R2 的真实值并推送后：
gh workflow run release.yml -f version=0.1.0
# 输入 version 必须等于 dsh-plugin-huaanwork/package.json 的版本（workflow 内有此门）。
# 产出：huaanwork-macos-unsigned（dmg + SHA256SUMS）与 huaanwork-windows-unsigned
#（HuaAnWork-*-x64-Setup.exe + -Portable.zip + SHA256SUMS），另有合并 manifest job。
```

**未来 Windows 路线（Windows 机器）**：工作区级无守卫等价命令
`cd dsh-plugin-huaanwork && corepack yarn dist:win`（`scripts/package-win.ts`）与
`corepack yarn dist:win-portable`（`scripts/package-win-portable.ts`）；校验 =
`node scripts/verify-win-installer.ts` 与 `node scripts/verify-win-portable.ts`
（纯 Node、跨平台，可对下载的 CI 制品执行；制品需就位 `dsh-plugin-huaanwork/dist/`——
portable 校验仅需 zip；installer 校验另需同批 `dist/win-unpacked/HuaAnWork.exe`，CI 制品不含
该目录，需在构建机顺手校验或解包补齐）。

**Step 3 核对项**（均在 Windows 执行后才能核对，现记待办）：安装器名 `HuaAnWork-*`（Task 4.1）、
`assistedMessages.yml` 进度文案（Task 4.2）、快捷方式名 `HuaAnWork`（`nsis.shortcutName`）、
安装→启动→不进恢复窗口 + `verify:win-package` spec 全绿、**workspace 切换链路在 Windows 的
可达性**（spec §14 第 21 条，M3 遗留冒烟缺口）、SmartScreen 如实记录（未签名期预期行为，spec §11）。
**Step 3b**（signtool `Status: Valid` + portable zip 内 `HuaAnWork.exe` 单独验签）同样未执行、
零声称——两个签名证据位见 Step 2 节。

## Step 4：更新链路端到端（loopback 8794）

### 部署与发布（可再部署命令）

> **注（2026-10-10）**：数据目录 `~/Downloads/huaanwork-m6-update-server-data/` 已删除；
> 以下命令为现场原文，复跑需先重建数据目录并重走本节的发布流程。

```bash
# 启动服务端（本 Task 现场用法；runbook = docs/update-server-deployment.md）
cd update-server
UPDATE_SERVER_PORT=8794 \
UPDATE_SERVER_DATA_DIR=$HOME/Downloads/huaanwork-m6-update-server-data \
UPDATE_SERVER_PUBLIC_ORIGIN=http://127.0.0.1:8794 \
node --experimental-strip-types src/index.ts
# 打印 update-server: listening on 8794 for http://127.0.0.1:8794（与 task-7.3-update-server.log 首行一致）

# 发布 0.1.1（人工流程：制品置入 dataDir + publish-release；无上传端点）
cp dsh-plugin-huaanwork/dist/mac-smoke/HuaAnWork-0.1.0-universal.dmg \
   $HOME/Downloads/huaanwork-m6-update-server-data/artifacts/huaanwork/mac/HuaAnWork-0.1.1-universal.dmg
node update-server/scripts/publish-release.mjs --channel huaanwork --version 0.1.1 \
  --platform mac \
  --file $HOME/Downloads/huaanwork-m6-update-server-data/artifacts/huaanwork/mac/HuaAnWork-0.1.1-universal.dmg
# --data-dir 缺省读 UPDATE_SERVER_DATA_DIR；mac 制品必须在 macOS 上发布（hdiutil universal 校验）
```

`PUBLISH_EXIT=0`（`task-7.3-publish-release.log`）：universal 校验通过、sha256
`8dc014a7…`、531,865,729 bytes、落 `channels/huaanwork.json`。当前通道记录 = **未篡改态**
（sha `69705f3e…`，与 `task-7.3-record-backup.json` 逐字节一致，本轮核验）。

### 服务端检查（`task-7.3-server-checks.txt`）

| # | 检查 | 结果 |
| --- | --- | --- |
| 1 | `GET /healthz` | 200 `{"ok":true}` |
| 2 | 版本端点 channel=huaanwork | 200 `{"version":"0.1.1","channel":"huaanwork","sha256":{"mac":"8dc014a7…"}}` |
| 3 | stable 查询（无 stable 记录） | 404 `no-release`（通道隔离） |
| 4 | 缺 `X-DSH-Desktop-Channel` 头 | 404 `unknown-channel`（**绝不回退 stable**） |
| 5 | 下载端点、错误目标版本 | 404 `version-mismatch` |
| 6 | Host 白名单：错误 Host | 403 `host-not-allowed` |
| 7 | 制品缺失（记录指向不存在的文件） | 500 `artifact-missing-or-truncated`（**绝不答 404**） |
| 8 | 下载端点 GET（正确目标版本，丢弃 body） | 200，`content-length: 531865729`、`X-HuaAnWork-Artifact-Sha256: 8dc014a7…`（另：headers-only 形态 405） |

### 客户端协议级检查（**打包产物内 shipped lib** 驱动；`task-7.3-client-checks.mjs`）

装载面已核验：脚本从 `HuaAnWork.app/Contents/Resources/app/lib/` 导入
`update-checker.js` 与 `update-download.js`（非 `src/`）。结果
（`task-7.3-client-checks-base.log` 等）：

- 检查：loopback + huaanwork → `update-available` 0.1.1，sha256.mac = `8dc014a7…`；
  `desktopUpdateFilename(darwin, 0.1.1, huaanwork) = HuaAnWork-0.1.1-mac.dmg`。
- 下载：531,865,729 B（= 记录值），sha256 **BYTE-MATCH**（server 侧 hdiutil + 发布 sha 链
  + 客户端 sha 逐字节比对，DMG 完整性在同一条链上）。
- **xattr：无 `com.apple.quarantine`**（仅 `com.apple.provenance`）——裁定 R-6 依据①的直接验证
  （应用内更新下载路径不打隔离属性）。
- `pending-installer.json`（throwaway userData）落盘
  `{"stateVersion":1,"platform":"darwin","version":"0.1.1","path":…}`。
- 通道标签负例（D-M6-2 族）：对 huaanwork 请求返回 stable 标签 / 无标签 → 检查器均 `null`。
- **D-M6-23 篡改负例**：sha 翻转 → `UpdateDownloadError code=update-integrity-mismatch`、
  目标文件与 scratch 残留 = 无（`task-7.3-negative-tamper-record.log` 为端到端变体：
  服务端实际提供被篡改记录 → 检查器照实报篡改 hash → 下载按该 hash 拒绝、删除已下载）。
- 制品缺失负例：服务端 500；客户端下载报 `http-status 500`，且检查仍报
  `update-available`（**不读成「无更新」**）（`task-7.3-negative-artifact-missing.log`）。
- 无 origin 负例：`null`（24 ms），见 Step 1 表。
- D-M6-23 接线静态证据（`task-7.3-dm623-wiring-evidence.txt`）：`confirmedResult` 携带
  sha256 → `downloadAndOpen`；完整性比对仅在提供 `expectedSha256` 时执行（缺省走诚实降级
  `integrity-unverified` 警告）；唯一生产调用方 `electron-runtime.ts` 传入该参数。
- **订正（2026-10-03，M7 评估 D1/D3 + D1 hotfix）**：上一条末句「唯一生产调用方 `electron-runtime.ts`
  传入该参数」在登记当日**失实** —— 所引证据文件（`task-7.3-dm623-wiring-evidence.txt:2`）逐字写的是
  「downloadAndOpen **has no sha256 parameter**」；当时适配器接口结构上没有该形参，生产路径恒走
  `integrity-unverified` 降级（M7 评估实测：三包 `grep -c sha256 electron-runtime.ts` = 0）。**D1 hotfix
  完成真实接线**（fork 提交 `246bd2a59d`）：`update-lifecycle` 把确认时版本响应的分平台 sha256 钉扎经适配器
  接口第 4 参透传，`electron-runtime` 按 `mac`/`windows` 线缆键映射后传入 `downloadDesktopUpdate`；
  三包同形改动，变体守卫 183/168/28 与 22/6 钉扎全绿。上一条末句自该提交起方为真。

**exercised 层级精确性**：以上为 **shipped-client-code 层级**（打包产物内 shipped lib 在
Node 中驱动 + 真实 loopback 字节流；应用内 Electron `net.fetch` 适配仅由 launch2 触达
版本端点）。**托盘 UI 全流程未做 UI 驱动，保留为待人类**（见下）。

### 更新链路待人类清单

- 托盘「检查更新」报告有新版 0.1.1（期望：托盘出现可更新标记；点击走确认弹窗）；
- 确认下载 → 保存对话框默认名 `HuaAnWork-0.1.1-mac.dmg`（与真实制品名
  `HuaAnWork-0.1.1-universal.dmg` 本就不同，属 Task 1.4/Task 4.1 记录的既定差异，不是缺陷）；
- 下载完成后核对**真实 userData** 的 `updates/pending-installer.json` 内容（本轮仅以
  throwaway userData 验证过该文件形状）；
- D-M6-23 经 UI 全流程复演篡改拒绝（改 `channels/huaanwork.json` 的 sha256 一位 → 下载被拒
  + 无残留；完成后恢复 `task-7.3-record-backup.json`）；
- 无 origin 负例经 UI：不设 `HUAANWORK_UPDATE_ORIGIN` 启动 → 「检查更新」静默无结果，
  且无任何请求发往 `dshdesktop.cn`。

## 待人类核对指南

1. **启动更新服务端**（原数据目录已就位、0.1.1 记录未篡改；**该目录已于 2026-10-10 删除**，复跑需先重建）：

   ```bash
   cd update-server
   UPDATE_SERVER_PORT=8794 \
   UPDATE_SERVER_DATA_DIR=$HOME/Downloads/huaanwork-m6-update-server-data \
   UPDATE_SERVER_PUBLIC_ORIGIN=http://127.0.0.1:8794 \
   node --experimental-strip-types src/index.ts
   ```

2. **以 loopback origin 启动冒烟 app**（直接跑二进制以带环境变量）：

   ```bash
   HUAANWORK_UPDATE_ORIGIN=http://127.0.0.1:8794 \
     "$PWD/dsh-plugin-huaanwork/dist/mac-smoke/mac-universal/HuaAnWork.app/Contents/MacOS/HuaAnWork"
   ```

   等待后台检查（激活后约 60 s）→ 托盘应出现 0.1.1 可更新；托盘菜单「检查更新」应报告新版。
3. **走完整更新 UI 流程**：确认弹窗 → 默认文件名 `HuaAnWork-0.1.1-mac.dmg` → 下载完成。
   随后核对：真实 userData `~/Library/Application Support/HuaAnWork/updates/pending-installer.json`；
   对下载文件 `xattr -l <file>`（应无 `com.apple.quarantine`）与 `shasum -a 256 <file>`
   （应 = `8dc014a72fd684db19d89672d214f06446c1ad3751920cd5b0bc8fc456c5d242`）。
4. **Step 1 UI 项**：图标一致性（Dock/标题栏/托盘/安装器卷；步骤见 Task 7.2 记录附录 A）；
   关于框/产品名显示 HuaAnWork；市场面（未钉公钥恒拒）文案诚实。
5. **负例抽演（可选）**：D-M6-23 篡改（步骤见上一节）；无 origin 启动（不设环境变量）→
   「检查更新」静默无结果。
6. 结束后停掉服务端（Ctrl-C）；不要把 loopback 数据目录部署到真实内网前遗忘。

## 偏差与诚实声明

- **打包路径替代（R-7.3-4）**：制品出自工作区级 `dist:mac-smoke`（AA 桥未注入的差异面）；
  未运行根命令，无 AA 副作用产生（树净）。两轮 hash 均在此差异面下，7.3 轮 dmg 与 7.2 轮
  不同属重新构建的预期结果（electron-builder 输出非逐位可复现）。
- **「首启」口径**：两次启动均对**既有 userData**（非干净家）。「不进恢复窗口」的机器面 =
  lifecycle 完成 + 恢复路由 0 条 + M3 缺陷 1 的两个具名根因（`skills/`、`app-icon.ico`）在
  `build.files`/制品内在位；干净家语义的真实首启证据在 Task 7.2 记录（不重复）。
- **迁移消息 = 常驻通告**：见 Step 1 节（marker sha/mtime 未变 + 代码路径）。不得把该消息
  读成迁移重跑。
- **launch1 的 `Error: net::ERR_NAME_NOT_RESOLVED`**：到默认 origin（`.example`）的 DNS
  失败打印的 Chromium 网络栈控制台行；检查层按 fail-closed 读作无结果（`runBackgroundCheck`
  的 catch；`updates/state.json` 前后同 sha `5f1ae282…`）。调度检查的失败**不**向用户或应用
  日志暴露属产品合同（`update-lifecycle.ts:305-307`），该行不是产品级报错路径。包内零
  `dshdesktop.cn` 字面量（唯一命中 = node_modules 文档）。
- **客户端协议检查层级**：shipped lib 值 + loopback 字节流（`request` 适配用 Node `fetch`）；
  应用内 Electron 适配的下载驱动路径（托盘 → 确认 → 下载）未做 UI 驱动 ⇒ 待人类。
- **服务端数据目录**原为保留在场（供人类核对/再部署），**已于 2026-10-10 删除**（DMG 逐字节
  副本与通道记录备份仍在，见「复跑与再部署」）；通道记录原为未篡改态（sha `69705f3e…`
  与 `task-7.3-record-backup.json` 一致）；篡改负例经「备份→篡改→复现→恢复」循环完成。
- **临时资源清理已核**（`task-7.3-cont-verification.txt`）：`/var/folders/.../task-7.3-client-*`
  无残留；`update-server`/`HuaAnWork` 进程 0；8790/8794 无监听；无仓库根 `logs/`。
- **未执行项零声称**：Step 2（签名+公证）、Step 3（Windows）、Step 3b（Authenticode）
  均未执行；两个签名证据位（mac + win32）**均空**并如实双标（R-6 允许的收口形态）。
- **启动驱动脚本未留档**：launch1/2 由包装脚本驱动（app 日志首行 `launch <time>`），其本体
  未保存；可核事实 = app 日志、lifecycle jsonl、baseline 行数差分、`APP_EXIT=0`。

## 复跑与再部署

- 更新服务数据目录：原 `~/Downloads/huaanwork-m6-update-server-data/`（含 0.1.1 记录）已于
  2026-10-10 删除；DMG 逐字节副本 = `~/Downloads/HuaAnWork-0.1.1-mac.dmg`，通道记录备份 =
  `.superpowers/sdd/2026-09-27-*/logs/task-7.3-record-backup.json`；复跑需重建数据目录并按 Step 4 发布。
- 重建制品：`cd dsh-plugin-huaanwork && corepack yarn dist:mac-smoke`
- 钩子复现：`node <WS>/logs/task-7.3-hook-replication.mjs "$PWD/dsh-plugin-huaanwork/dist/mac-smoke/mac-universal" HuaAnWork`
- 客户端协议复跑：`node <WS>/logs/task-7.3-client-checks.mjs base http://127.0.0.1:8794`
  （另有 `missing` / `tamper-record` 两模式；依赖服务端在本机运行）
- 服务端/发布/守卫：见 Step 4 与 Step 2/3 各节命令。
- 门禁（本轮）：`corepack yarn check:desktop-variants` 绿（`task-7.3-gate-variants.log`，
  `VARIANTS_EXIT=0`，6/6，stable↔beta 183 / beta↔huaanwork 168+28 对齐）——记录提交前执行。

## 交叉引用

- Task 7.2 记录 `docs/huaanwork-migration-smoke-2026-10-01.md` 的**附录 A**（Phase 4 图标目检
  步骤与接触表）与**附录 B**（Phase 5 三项 UI 核对）为本记录的待人类清单直接沿用，不重复。
- 部署 runbook：`docs/update-server-deployment.md`；发行清单与 R-6 口径：
  `docs/release-checklist.md`；市场部署与公钥指纹核对：`docs/market-server-deployment.md`。
