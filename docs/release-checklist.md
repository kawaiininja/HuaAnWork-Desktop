# 发行清单(release checklist)

本文件是 HuaAnWork Desktop 的发行清单:凭据从哪来、注入哪些环境变量、跑什么命令、产物在哪、
怎么验收、失败怎么处置。目标读者是执行发行的人(R1)——每一节都按「照着做即可」的标准写,
不需要再作判断。

> **M6 现状(裁定 R-6,2026-09-30)**:发行范围定为**内网自用**,签名凭据采购**延后为触发式**
> (触发条件:外部分发需求,或 IT 端点策略对未签名二进制的强制要求)。因此本周期交付的是
> **「凭据到位即可签」的完整管线与验收口径**,而不是已签名制品;「没有凭据」是**预期状态**,
> 不是待补缺口。凭据到位后按本文实跑即可,不需要任何未完成的开发工作;R-6 生效期的内网发行
> 使用未签名制品(macOS 见 §1.8,Windows 见 §2)。R1 的实跑结果记入 Task 7.3 的冒烟记录。

## 1. macOS 签名与公证

### 1.1 前置(缺一不可)

1. **Apple Developer Program 会员资格**(年费订阅在有效期内),账号可访问 App Store Connect。
2. **Developer ID Application 证书**(含私钥)。这是唯一可用于分发的 macOS 签名身份:预检会
   拒绝 `Apple Development:` 身份(`release-preflight.ts` 只接受 `Developer ID Application:` 前缀,
   且不接受 `CSC_NAME` 带前缀的写法)。
3. **公证凭据三组之一**(见 §1.2 的注入形态)。
4. **造包机必须是 macOS**:预检在非 darwin 上直接拒绝(`The signed macOS release must be built
   on macOS`);验收还要用到 `hdiutil`/`lipo`/`codesign`/`spctl`/`xcrun`(Xcode Command Line
   Tools 自带)。
5. **造包机能访问 Apple 公证服务**:notarytool 需要出网(严格内网环境不可行——这正是 R-6 把
   采购延后为触发式的依据之一)。
6. 仓库工作区已 `corepack yarn install --immutable`;发行命令会先跑一遍 `yarn run check`
   (在**剥离凭据**的环境里)。

### 1.2 凭据注入:18 个环境变量名(从 `RELEASE_VARIABLES` 机械导出)

下列 18 个名字是 `dsh-plugin-huaanwork/scripts/release-preflight.ts` 中 `RELEASE_VARIABLES`
的全部成员(`release-preflight.ts:10-17`)。本清单由该常量**机械导出**,并由守卫测试
`dsh-plugin-huaanwork/tests/release-preflight.spec.ts` 的「文档名单与常量一致」用例钉住:
**文档少列任何一个名字,该测试即失败**(改常量而不改文档会被立刻拦下)。

| 变量名 | 用途 |
| --- | --- |
| `MAC_CERT_P12_BASE64` | 签名证书 p12 的 base64(与 `MACOS_SIGN_IDENTITY`、`CSC_KEY_PASSWORD` 组成 p12 三元组) |
| `MACOS_SIGN_IDENTITY` | `Developer ID Application: <名称> (<TEAMID>)`;预检映射为 electron-builder 的 `CSC_NAME`(去掉证书类型前缀) |
| `CSC_KEY_PASSWORD` | p12 口令(用 p12 签名时必填) |
| `CSC_NAME` | electron-builder 选择签名身份的名字;钥匙串签名时可选,给定时必须与钥匙串里的 Developer ID 身份一致 |
| `CSC_LINK` | electron-builder 的证书输入(文件路径或 `data:` URL);不要与 `MAC_CERT_P12_BASE64` 同时给(预检报 `not both`) |
| `CSC_KEYCHAIN` | 自定义钥匙串路径(证书不在默认钥匙串时) |
| `APPLE_ID` | 公证:Apple ID 组 |
| `APPLE_APP_SPECIFIC_PASSWORD` | 公证:Apple ID 组(app 专用口令) |
| `APPLE_TEAM_ID` | 公证:Apple ID 组(团队 ID) |
| `APPLE_API_KEY` | 公证:App Store Connect API key 组(密钥文件路径) |
| `APPLE_API_KEY_ID` | 公证:API key 组(key ID) |
| `APPLE_API_ISSUER` | 公证:API key 组(issuer ID) |
| `APPLE_KEYCHAIN_PROFILE` | 公证:notarytool 钥匙串 profile 名(单独一项即可构成一组) |
| `APPLE_KEYCHAIN` | 存放 notarytool profile 的钥匙串;只给它而不给 `APPLE_KEYCHAIN_PROFILE` 会被预检明确拒绝 |
| `CSC_IDENTITY_AUTO_DISCOVERY` | 签名身份自动发现开关;**签发时不得设为 `false`**(设为 `false` 会被预检拒绝) |
| `CSC_FOR_PULL_REQUEST` | 预检识别的发行变量之一:会从所有非 builder 子进程环境中剥离,不参与 macOS 签发 |
| `CSC_INSTALLER_LINK` | 预检识别的发行变量之一(Windows 安装器签名用):同样会被剥离,不参与 macOS 签发 |
| `CSC_INSTALLER_KEY_PASSWORD` | 预检识别的发行变量之一(Windows 安装器签名用):同样会被剥离,不参与 macOS 签发 |

注入形态(签名任选一种 × 公证任选一组):

- **签名 A —— 钥匙串**:证书与私钥已装进造包机的登录钥匙串。只需给公证凭据;可选 `CSC_NAME`
  指定身份、`CSC_KEYCHAIN` 指定钥匙串。预检用 `security find-identity -v -p codesigning` 核对
  存在 Developer ID Application 身份。
- **签名 B —— p12**:给三元组 `MAC_CERT_P12_BASE64` + `MACOS_SIGN_IDENTITY` + `CSC_KEY_PASSWORD`。
  预检把 p12 转成 `data:application/x-pkcs12;base64,…` 形式的 `CSC_LINK`、把去掉前缀的身份写进
  `CSC_NAME`,**证书不落盘**(不需要写证书文件)。
- **公证(三选一)**:(a) `APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD` + `APPLE_TEAM_ID`;(b)
  `APPLE_API_KEY` + `APPLE_API_KEY_ID` + `APPLE_API_ISSUER`;(c) `APPLE_KEYCHAIN_PROFILE`
  (可选配 `APPLE_KEYCHAIN`)。
- **只给一半会被拒绝**:任一组三元组缺项、或给了 `APPLE_KEYCHAIN` 却没给 profile,预检都会报
  明确错误,不会静默跳过公证。
- **注入方式**:把变量 `export`(或 `set -a; source creds.env; set +a`)进发行命令的进程环境即可。
  预检/发行脚本只打印**非凭据**信息(签名身份名、签名与公证的来源机制),并把这 18 个变量从
  **所有非 electron-builder 子进程**的环境中剥离——`yarn run check` 与验收脚本都拿不到凭据。
- **凭据不写进仓库、不写进 CI**:发行工作流按裁定 D-M6-17 不持有任何签名凭据;签名是 R1 在
  credentialed 机器上的动作。

### 1.3 命令

```bash
corepack yarn dist:mac:huaanwork
```

一条命令按顺序完成 5 步(`dsh-plugin-huaanwork/scripts/release-mac.ts`):

1. 预检:平台、Developer ID 身份、凭据完整性(失败即中止,退出码非 0);
2. 在**剥离凭据**的环境中跑仓库根的 `yarn run check`(布局守卫 + 全部工作区的门禁:
   构建、类型检查、测试、变体守卫——凭据不会进入其中任何子进程);
3. 清空并重建 `dsh-plugin-huaanwork/dist/mac-release/`,准备 arm64+x64 的 fs-ext 与 universal 运行时;
4. `electron-builder --mac dmg --universal --config.forceCodeSigning=true --config.mac.notarize=true --config.npmRebuild=false --config.directories.output=dist/mac-release`;
5. `node scripts/verify-mac-release.ts dist/mac-release`(§1.5 的三道门)。

`--config.forceCodeSigning=true` 的意义:electron-builder 侧也拒绝产出未签名包——任何凭据问题
都是**显式失败**,不会悄悄给你一个未签名的 dmg。

### 1.4 产物

- 目录:`dsh-plugin-huaanwork/dist/mac-release/`(专用输出目录,每次运行前被清空,不会与历史制品混淆);
- 文件名:`HuaAnWork-<version>-<arch>.dmg`,即 `build.mac.artifactName = "HuaAnWork-${version}-${arch}.${ext}"`。
  `--universal` 构建下 electron-builder 以 `universal` 作为 `${arch}` 值,实际文件是
  **`HuaAnWork-<version>-universal.dmg`**(更新服务端的发布门
  `update-server/src/artifact/validate.ts` 同样要求 basename 带 `universal` 标记);
- `<version>` 取变体包 `dsh-plugin-huaanwork/package.json` 的 `version`。

### 1.5 验收:三道门 + 两项人工确认

`corepack yarn dist:mac:huaanwork` 的最后一步自动跑完三道门(对象是挂进临时挂载点的
`HuaAnWork.app`,`verify-mac-release.ts:86-88`):

1. `codesign --verify --deep --strict --verbose=2` —— 签名链完整;
2. `spctl --assess --type execute --verbose=4` —— Gatekeeper 评估通过;
3. `xcrun stapler validate` —— 公证票据已装订到 app。

三道门的输出以 `stdio: 'inherit'` 直通终端,任一门非 0 退出即整条命令失败;挂载点在成功与
失败路径上都会被卸载(清理失败会聚合进错误)。

**人工确认两项**(脚本只看退出码,不解析文本):

- `spctl` 输出里有 `accepted`;
- 且来源是 `source=Notarized Developer ID`。

不重建、只重验(可重复的验收命令):

```bash
cd dsh-plugin-huaanwork
node scripts/verify-mac-release.ts dist/mac-release
```

这与发行管线第 5 步调用的是同一个脚本、同一个目录(也可传显式路径作为参数);它要求该目录里
**恰好一份 dmg**(管线每次运行前清空该目录),并对 `MACOS_UNIVERSAL_NATIVE_ENTRIES` 逐项跑
`lipo -verify_arch`,把两道架构检查加在三道门之前。

### 1.6 失败处置

- **预检报错**(缺 Developer ID 身份 / 三元组只给了一半 / `CSC_IDENTITY_AUTO_DISCOVERY=false` /
  非 macOS):按报错补齐凭据,**不要用开关绕过**——预检存在的意义就是「宁可拒绝,不产未签名包」。
- **`codesign` 报缺 entitlements**:这时**才**按裁定 D-M6-15 新增 entitlements plist,并同步
  `build.mac.entitlements` / `entitlementsInherit`。
  - **裁定 D-M6-15(M6 不预防性新增 entitlements plist)与其证据**:三包都没有 entitlements
    plist(唯一一份在子模块 `deepseek-harness/apps/desktop/scripts/node-entitlements.plist`,
    子模块永不修改、不可用);而 `hardenedRuntime: true`(**`package.json:447`**)
    + `electronFuses.runAsNode: true`(**`package.json:412`,`electronFuses` 块 `:408-413`**)
    的组合在 beta 通道已验证可签名可公证,且 huaanwork 的 `build.mac` 块与 beta **逐字节相同**
    (实测 diff 只差 `artifactName`;整个 `build` 块的其余差异也只有品牌身份类字段——
    `appId`/`productName`/`files` 里的 `skills/**`/win 与 nsis 的制品名与快捷方式名——与
    macOS 签名路径无关)。
  - 处置原则:**先实跑,按失败证据再决定**。预防性抄一份 plist 可能放开不需要的能力,反而扩大
    攻击面;实跑失败才新增,新增时以失败输出为准只放开必需项。
- **公证服务不可达 / 上传失败**:补齐网络后**重跑同一条命令**即可(输出目录每次重建,产物
  从同一起点重新生成)。
- **不要手工修改 `dist/mac-release/` 里的产物再分发**:发行制品必须由这条管线一次产出、一次
  通过三道门;事后手改的制品没有可复现的来源。

### 1.7 universal 构建注意(`x64ArchFiles` 的 10 条 glob)

`--universal` 把 arm64 与 x64 两份合进一个 dmg。`build.mac.x64ArchFiles`
(`dsh-plugin-huaanwork/package.json:454`)的 **10 条 glob** 决定哪些原生模块在 universal 合包时
按 x64 处理:

```text
**/node_modules/{@deepseek-ai/node-addon-system-darwin-*/**,node-pty/prebuilds/darwin-*/**,fs-ext/prebuilds/darwin-*/**,node-addon-require-builtin-darwin-*/**,@vscode/ripgrep-darwin-*/**,@img/sharp-darwin-*/**,@img/sharp-libvips-darwin-*/**,@koromix/koffi-darwin-*/**,@dataiku/uv-darwin-*/**,@deepseek-ai/libreoffice-kit-darwin-*/**}
```

计数 10。**改原生依赖时必须同步这份清单**:新增原生模块而不把它纳入 glob,universal 包会在
Intel 机器上加载 arm64 二进制而崩。清单的**真相源是 `dsh-plugin-huaanwork/package.json` 的
`build.mac.x64ArchFiles` 字段**,本节副本只为对照,改字段时顺手更新这里;验收侧
`verify-mac-release.ts` 还会对 `MACOS_UNIVERSAL_NATIVE_ENTRIES` 里逐项跑 `lipo -verify_arch` 兜底。

### 1.8 未签名期的诚实标注(裁定 R-6 + macOS 15 Sequoia)

**制品来源**:R-6 生效期 macOS 内网发行制品来自 `corepack yarn dist:mac-smoke:huaanwork`,它是
**未签名、未公证**的完整构建:

- `scripts/package-mac.ts:138` 传 `--config.mac.notarize=false`;
- `:145` 设 `CSC_IDENTITY_AUTO_DISCOVERY=false`;
- `:135` 含 `--universal`——smoke 与签发是**同一条 electron-builder `--mac dmg --universal` 管线**,
  差异仅在签名/公证/身份发现开关与输出目录(`dist/mac-smoke`)。

因此它不是一个「缩水包」,而是 R-6 生效期可用的内网发行制品。

**分发说明必须写明两点**:

1. **macOS 15 Sequoia 起,右键 → 打开不再绕过 Gatekeeper**:未签名应用的首次打开必须走
   「系统设置 → 隐私与安全性 → 仍要打开」(Open Anyway)。凡经 Finder/AirDrop/浏览器下载等
   渠道拿到安装包的用户,都要随附这一放行步骤。
2. **经应用内更新链路下载的安装包不带 quarantine 属性**:下载实现是 Electron `net.fetch` +
   fs 写盘(`update-download.ts:60`;运行时绑定见 `electron-runtime.ts`),隔离属性只经
   Finder/AirDrop/浏览器下载等渠道打上。因此经应用内更新拿到的包 Gatekeeper 不评估、双击即开,
   零额外步骤。

结论:**内网经 Web 链接 / IM 直接分发安装包时,必须随附第 1 条的放行步骤**(该渠道会打上
quarantine 属性);经应用内更新链路分发时无需额外步骤。

## 2. Windows Authenticode 签名

### 2.1 前置(缺一不可)

1. **SafeNet 兼容的代码签名硬件令牌**:私钥只存在于令牌内、永不落盘。上游用同一种形态
   (`deepseek-harness/apps/desktop/scripts/windows-sign.cmd:16`):`/f` 指向**公开**证书文件,
   `/kc "[{{<PIN>}}]=<容器名>"` 指令牌里的私钥,`/csp "eToken Base Cryptographic Provider"` 指提供者。
2. **公开叶证书文件**(`.cer`):预检要求该证书**非 CA** 且**扩展密钥用途含 Code Signing**
   (`1.3.6.1.5.5.7.3.3`)——CA 证书、TLS/服务器证书都会被拒绝(`huaanwork-sign-windows.ts` 与上游
   `windows-sign.mjs:54-72` 同款判定)。
3. **支持 SafeNet key container 的 `signtool.exe`**(绝对路径,后缀必须是 `.exe`)。
4. **令牌容器名与 PIN**:PIN 不得含 `]`、引号或换行,容器名不得含引号或换行——它们是 SafeNet
   `/kc` 语法的分隔符(上游 `windows-sign.mjs:36-51` 同款校验)。P12 与口令(`/f`+`/p`)**不可用**:
   私钥不在文件里。
5. **造包机必须是原生 Windows x64**:预检在非 win32 上直接拒绝(`Windows Authenticode signing requires
   a native Windows host`);x64 要求由打包入口的门禁拒绝(`scripts/package-win.ts:111-126` 的
   `requires x64 Node`,CI 的 Windows 矩阵同为 x64),与 §1.1 第 4 条同款纪律。
6. **造包机能访问 RFC 3161 时间戳服务**:默认 `http://timestamp.digicert.com`(上游 `windows-sign.cmd:16`
   的同一个服务器),可用 `DSH_DESKTOP_WINDOWS_TIMESTAMP_URL` 覆盖;覆盖值必须是 `http`/`https` URL。
7. 仓库工作区已 `corepack yarn install --immutable`;发行命令会先跑一遍 `check:win-package`
   (Windows 可运行的 gate:**在剥离凭据的环境里**)。

### 2.2 凭据注入:13 个环境变量名(从 `WINDOWS_SIGNING_VARIABLES` 机械导出)

下列 13 个名字是 `dsh-plugin-huaanwork/scripts/huaanwork-sign-windows.ts` 中
`WINDOWS_SIGNING_VARIABLES` 的全部成员。它是三处上游/既有实现 env 名的**并集**加一项本仓覆盖:
上游令牌四元组(`windows-sign.mjs:36-109`、`windows-signing-preflight.ts:39-44`、`windows-sign.cmd:3-9`)
+ 上游交接名(`windows-sign.mjs:146-156`)+ electron-builder 发现名(`scripts/package-win.ts:10-17`)
+ 本仓时间戳覆盖。本清单由该常量**机械导出**,并由守卫测试
`dsh-plugin-huaanwork/tests/huaanwork-sign-windows.spec.ts` 的「文档名单与常量一致」用例钉住:
**文档少列任何一个名字,该测试即失败**(改常量而不改文档会被立刻拦下)。

| 变量名 | 分组 | 用途 |
| --- | --- | --- |
| `DSH_DESKTOP_WINDOWS_SIGNTOOL` | 令牌四元组 | SafeNet 兼容 SignTool 可执行文件(绝对路径,`.exe`) |
| `DSH_DESKTOP_WINDOWS_CER_FILE` | 令牌四元组 | 公开叶证书文件(非 CA + Code Signing EKU) |
| `DSH_DESKTOP_WINDOWS_TOKEN_PIN` | 令牌四元组 | 令牌 PIN(不得含 `]`、引号、换行) |
| `DSH_DESKTOP_WINDOWS_KEY_CONTAINER` | 令牌四元组 | 令牌内私钥容器名(不得含引号、换行) |
| `DSH_DESKTOP_WINDOWS_TIMESTAMP_URL` | 本仓覆盖 | 可选:替换默认 RFC 3161 服务器(默认 `http://timestamp.digicert.com`) |
| `DSH_DESKTOP_WINDOWS_SIGN_TARGET` | 上游交接名 | 签名子进程的目标文件;**不得由操作者设置**(本脚本以 argv 传目标);一律剥离 |
| `DSH_DESKTOP_WINDOWS_SIGN_APPEND` | 上游交接名 | 追加签名开关;**不得由操作者设置**;一律剥离 |
| `CSC_IDENTITY_AUTO_DISCOVERY` | electron-builder 发现名 | 发现开关;**不是本仓签名契约**:`package-win.ts` 在未签名打包里剥离/置 `false` |
| `CSC_KEY_PASSWORD` | electron-builder 发现名 | 同上(证书口令,非令牌 PIN) |
| `CSC_LINK` | electron-builder 发现名 | 同上(证书输入,非令牌 PEM/DER 证书文件) |
| `CSC_NAME` | electron-builder 发现名 | 同上(身份选择名,非 SafeNet 容器名) |
| `WIN_CSC_KEY_PASSWORD` | electron-builder 发现名 | 同上(Windows 变体) |
| `WIN_CSC_LINK` | electron-builder 发现名 | 同上(Windows 变体) |

- **只给令牌四元组的一部分会被拒绝**:预检列出缺失的名字并中止,不会静默产出未签名包
  (「宁可拒绝,不产未签名包」,与 §1.6 同款)。只给 `CSC_LINK`/`WIN_CSC_LINK` 一类的
  electron-builder 发现名**不算凭据**——它们会被未签名打包剥离,永不参与签名。
- **注入方式**:把变量 `export`(或 `set -a; source creds.env; set +a`)进发行命令的进程环境即可。
  PIN 与容器名只以 argv 元素形式交给 `signtool`(不经命令解释器;上游同样要求 PIN 出现在 SignTool
  命令行,见子模块 `apps/desktop/README.md:237`),失败信息里的 PIN 会被替换为 `<redacted>`。
- **凭据不落盘**:本脚本不写任何凭据文件(没有临时 pfx、没有临时证书库),并把上面 13 个名字从
  **所有子进程**环境中剥离——打包、重打包、验签子进程都拿不到它们。
- **凭据不写进仓库、不写进 CI**:发行工作流按裁定 D-M6-17 不持有任何签名凭据;签名是 R1 在
  credentialed 机器上的动作。

### 2.3 命令

```bash
corepack yarn dist:win-sign:huaanwork
```

一条命令按顺序完成 6 步(`dsh-plugin-huaanwork/scripts/huaanwork-sign-windows.ts`):

1. 预检:平台、令牌四元组、PIN/容器名的 `/kc` 分隔符、SignTool 与证书文件、证书非 CA + Code
   Signing EKU、时间戳服务器(失败即中止,退出码非 0);
2. 未签名打包:跑既有入口 `scripts/package-win.ts`(含 `check:win-package` 门禁与它自己的
   PE 校验),产出 `dist/win-unpacked/`(应用目录)与未签名的外层 Setup.exe;
3. 签**内层**可执行文件:`dsh-plugin-huaanwork/dist/win-unpacked/HuaAnWork.exe`
   (`/fd sha256` 摘要 + RFC 3161 `/td sha256` 时间戳);
4. 从**已签目录**重打包两件制品:electron-builder `--prepackaged dist/win-unpacked` 重出
   portable zip 与 Setup.exe(顺序要点见 §2.4);
5. 签**外层** Setup.exe;
6. 逐件验签 + 收尾:`signtool verify /pa /v` 覆盖 Setup.exe、`win-unpacked` 里的 `HuaAnWork.exe`、
   以及从 portable zip 中解出到**私有临时目录**的同名可执行文件(解出目录在成功与失败路径上都删除);
   任一失败即非零退出;最后再跑一遍 `scripts/verify-win-portable.ts` 与
   `scripts/verify-win-installer.ts` 复核重打包后的制品。

### 2.4 签名顺序(内层 exe → zip → Setup)与产物

**为什么必须重打包,而不是「对产物签名」**:ZIP 不是 PE,自身无法承载 Authenticode 签名;若只签
外层 Setup.exe,portable zip 里的 exe 与 NSIS 载荷里的 exe 都仍是未签名,而外层验签会通过——
这是典型的静默缺陷。上游因此**在打包过程中**签:electron-builder 的 sign 钩子
(`deepseek-harness/apps/desktop/scripts/electron-builder-config.mjs:59-75`)在目标打包前签应用文件,
NSIS 临时引导程序也在执行前签(`windows-sign.mjs:279-300`)。本仓的 post-hoc 等价物是上游
`test-windows-installer.mjs:80,96` 的写法:**先签 payload 里的 exe,再用 `prepackaged` 打目标**。
electron-builder 26.15.7 的 `--prepackaged` 让目标直接读给定目录并跳过 `doPack`
(`app-builder-lib/out/platformPackager.js:92,145-147`),所以顺序是:

```text
签 dist/win-unpacked/HuaAnWork.exe  →  --prepackaged dist/win-unpacked 重出 zip 与 Setup.exe  →  签 Setup.exe
```

| 制品 | 路径 | 签名状态 |
| --- | --- | --- |
| NSIS 安装器(外层) | `dist/HuaAnWork-<version>-x64-Setup.exe` | 本管线签(第 5 步) |
| NSIS 载荷内应用 | 装机后的 `<安装目录>/HuaAnWork.exe` | 已签(重打包取自已签目录) |
| portable zip | `dist/HuaAnWork-<version>-x64-Portable.zip` | zip 本身无 Authenticode 签名(不是 PE) |
| zip 内应用 | zip 根部的 `HuaAnWork.exe` | 已签(重打包取自已签目录,第 6 步逐件验签) |

`<version>` 取 `dsh-plugin-huaanwork/package.json` 的 `version`;三处路径与
`scripts/verify-win-installer.ts:86-91`、`scripts/verify-win-portable.ts:39-44` 的既有口径逐字一致。

**未签名入口(R-6 生效期照旧可用)**:`corepack yarn dist:win:huaanwork`(未签名 NSIS)与
`corepack yarn dist:win-portable:huaanwork`(未签名绿色 zip);它们不含任何签名步骤,产物见 §2.6 的
诚实标注。

### 2.5 验收

`corepack yarn dist:win-sign:huaanwork` 的第 6 步自动完成机器验收(对象是上表四件):

1. `signtool verify /pa /v` 对每一件 PE 逐件执行,输出含 **`Successfully verified`**;
2. 任一件非零退出即整条命令失败(不会留下「外层已签、内层未签」的混合制品);
3. `scripts/verify-win-portable.ts` / `verify-win-installer.ts` 复核重打包后的 PE 与归档布局。

**人工确认一项**(脚本只看退出码,不解析文本):PowerShell `Get-AuthenticodeSignature`
的 `Status` 为 `Valid`,且 `TimeStamperCertificate` 非空(RFC 3161 时间戳已装订):

```powershell
Get-AuthenticodeSignature 'dsh-plugin-huaanwork\dist\HuaAnWork-<version>-x64-Setup.exe' |
  Format-List Status, StatusMessage, SignerCertificate, TimeStamperCertificate
```

只验不重签(可重复的验收命令,不需要令牌与 PIN):

```powershell
signtool verify /pa /v dsh-plugin-huaanwork\dist\HuaAnWork-<version>-x64-Setup.exe
```

### 2.6 未签名期的诚实标注(裁定 R-6)

- **制品来源**:R-6 生效期内网发行使用未签名制品,入口为 §2.4 末尾的两个未签名命令;它们与签名
  管线是同一条 electron-builder 打包路径,差异仅在签名步骤缺失。
- **必随附的放行步骤**:未签名(以及签名初期)的安装器会显示 Unknown publisher / SmartScreen
  「Windows 已保护你的电脑」——点「更多信息」→「仍要运行」即可继续;这与本仓 README 记录的
  事实一致(`dsh-plugin-huaanwork\README.md`:unsigned artifacts may trigger an Unknown publisher or
  SmartScreen warning)。M6 发行口径(裁定 R-6 与 spec §11)明确:凭据到位前这类提示**按可接受
  处理**,随附上述放行步骤即可,不是待补缺口。
- **企业端点策略仍可能直接阻止**:WDAC/AppLocker 一类的 code-integrity 策略可以不经提示直接拦下
  未签名二进制(上游对未签名构建记录同一事实,`apps/desktop/README.md:199`)。这是采购触发的
  判据之一(见裁定 R-6)。
- **本管线的签名覆盖面**:签名只落在**外层安装器**与**应用可执行文件**两个 PE 上;载荷内的其它
  PE(原生插件的 `.node`/`.dll` 等)不逐个签名——上游在本仓之外的 runtime 阶段逐个签它们
  (`windows-sign.mjs` 的 `preserveSignature`/签钩子),本仓没有该阶段。若某端点策略按 PE 逐个
  校验,这些未签文件可能被拦;按 R-6 视为内网可接受。

### 2.7 失败处置

- **预检报错**(缺令牌四元组、`CSC_*` 只给一半、PIN/容器名含分隔符、证书是 CA 或非 Code Signing、
  非 Windows 主机):按报错补齐凭据,**不要用开关绕过**——预检存在的意义就是「宁可拒绝,不产
  未签名包」。注意:签名证书文件必须与令牌配对(私钥在令牌里,`.cer` 只是公开部分)。
- **PIN 错误**(`SignTool Error: No private key is available.` 一类)或令牌未插入/未解锁:
  **立即停止,不要重试**——SafeNet 令牌连续五次错误 PIN 会锁死,此后须由令牌所有者解锁(上游
  `apps/desktop/README.md:219` 记录同一事实)。本脚本不重试、不缓存凭据、不猜测 PIN。
- **时间戳服务器不可达**(第 3/5 步签名失败,报 `/tr` 相关错误):确认造包机出网后**重跑整条命令**
  (可以从头重跑:打包 → 签内层 → 重打包 → 签外层),或换一个 RFC 3161 服务器:
  `set DSH_DESKTOP_WINDOWS_TIMESTAMP_URL=https://<另一个 RFC3161 服务>` 后重跑。**不得**用不带
  时间戳的签名绕过:无时间戳的签名在证书过期后失效,验收也要求 `TimeStamperCertificate` 非空。
- **不要手工修改 `dist/` 里的产物再分发**(与 §1.6 同款纪律):签名制品必须由这条管线一次产出、
  一次通过 §2.5 的验收;手工改过的制品没有可复现的来源。任何重新打包(例如再跑一次
  `dist:win:huaanwork`)都会覆盖 `dist/win-unpacked/`,必须重新跑签名命令。
