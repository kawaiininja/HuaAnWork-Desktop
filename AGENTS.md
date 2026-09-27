# DSH Desktop repository rules

This repository owns the desktop product around an unmodified DeepSeek Harness checkout.

## Prerequisites and setup

- Use Node.js `^22.19.0` or `>=24.0.0` and the root Yarn `4.18.0` release through Corepack.
- Initialize the pinned upstream checkout with `git submodule update --init --recursive`.
- Install root dependencies with `corepack yarn install --immutable`.

## Build, run, and verify

- Start the desktop development workflow with `corepack yarn dev`.
- Build the desktop package with `corepack yarn build`.
- Run unit tests with `corepack yarn test`.
- Run type checking with `corepack yarn typecheck`.
- Run the complete headless gate with `corepack yarn check`.
- Develop and validate Desktop feature changes in `dsh-plugin-desktop-beta/` first, then synchronize shared changes into `dsh-plugin-desktop/` while preserving declared variant differences. Before committing or pushing shared Desktop changes, run `corepack yarn check:desktop-variants` and validate both affected packages; neither package automatically inherits the other's source edits.
- Run upstream operations through the root scripts, such as `corepack yarn upstream:build`.

- `deepseek-harness/` is a pinned upstream Git submodule. Never edit files inside it from a desktop feature branch.
- `dsh-plugin-desktop/` owns the Cordis Host and Client faces, Electron bootstrap, packaging, and release tests.
- `dsh-community-fabric/` owns the community interoperability RFC. Until schemas and a reviewed reference adapter exist, it remains a private documentation scaffold and must not declare loadable DSH or package entry points.
- `dsh-community-market/` owns the community-market shell. Its runtime is implemented with a **public-network security model** (`restricted-http.ts` blocks intranet addresses; `createNpmRegistryVerifier` trusts npmjs). The M5 intranet market does **not** reuse its runtime routes (spec §14 第十轮 第 39 条, review D8); the huaanwork intranet consumer face is self-implemented in the wrapper (`dsh-plugin-huaanwork/src/huaanwork-host/market/`, 7 off-table routes), importing only the `dsh-community-market/contracts` provider-page schemas. The upstream package itself remains zero-modified.
- The outer repository and all owned packages use the root Yarn release with `nodeLinker: node-modules`.
- The upstream submodule keeps its own pnpm workspace. Run upstream commands through the root `upstream:*` scripts, whose Yarn portable-shell commands enter the submodule before invoking Corepack.
- Compatibility mode must run the upstream default client without overrides. Advanced presentation belongs to desktop-owned client plugins and may replace documented slots or services through profile composition.
- Keep graphical application launch explicit. Builds, typechecks, unit tests, and Loader smokes must remain headless-safe.
- Commit before major changes of direction and keep the submodule pin update separate from desktop behavior changes.
- Keep the repository topology and package-manager split consistent with the [owning Agent Note](.agents/notes/implemented/process/2026-08-15-pinned-upstream-and-isolated-yarn-workspace.md).

## HuaAnWork variant (`dsh-plugin-huaanwork`)

- Derived from `dsh-plugin-desktop-beta` at M1 (2026-09-19). Identity source of truth: `dsh-plugin-huaanwork/src/product-identity.ts`.
- **Zero-touch rule**: never edit `dsh-plugin-desktop/src/` or `dsh-plugin-desktop-beta/src/` when working on the huaanwork variant; changes to shared logic go into the originating package and are then reviewed via `corepack yarn check:desktop-variants`.
- `dsh-community-market` DSH deps are synced exclusively via the beta channel vendored runtime; `sync-vendored-runtime.mjs` intentionally skips it for the `huaanwork` channel.

## Known tech debt

| Item | File | Milestone |
|------|------|-----------|
| NSIS `artifactName` still reads `DSH-Desktop-Beta-*` | `dsh-plugin-huaanwork/package.json` L417; test pinned with `TODO(M6)` | M6 |
| `verify:aa` concurrent process race: running `corepack yarn check` in parallel across all three workspaces occasionally causes the beta `verify:aa` step to fail (AA Host services conflict). Each workspace passes in isolation; CI strips `verify:aa` via the AA-skip step. Pre-dates M1. | `dsh-plugin-desktop-beta/scripts/verify-profile-boot.mjs` L333 | Pre-existing upstream flakiness |
| README 仍自述为「DSH Desktop Beta 通道」并声称提供 `dsh-desktop-beta` bin 别名(事实性错误,该别名已随派生移除) | `dsh-plugin-huaanwork/README.md`, `README.zh.md` | M6 |
| macOS 无原生目录选择(`MacPlatformStrategy.canPickDirectory = false`),picker route 保持 win32-only,客户端非 2xx(实测为 405)降级为 null;启用需改能力位并扩 variant 白名单,或改走上游 `dsh-host-directory-picker-native`(评审 P1-4 裁决)。**现为 M5 内网宕机旁路的阻塞项**(评审 D11 重新定级):市场「本地安装」页签已加自由文本路径输入兜底(`.tgz` 与 macOS 共同走它),picker 不可用时页面诚实提示——但完整旁路体验仍依赖本债项落地 | `dsh-plugin-huaanwork/src/electron-platform.ts` | M4(依 M5 D11 重新定级) |
| M4 本地安装悬空 `file:` 引用(既有缺陷,round6 S5):本地 `.tgz`/目录安装后源文件被移动/删除,后续任何 `pnpm add` 以 ENOENT 确定性失败(与市场 N1 根因同构,M4 起既有暴露,非 M5 引入);M5 市场路径已用 `.market-artifacts/` 布局规避,本地路径未修 | `dsh-plugin-huaanwork/src/huaanwork-host/plugins-host.ts`(addPlugin 写 `file:` 引用处) | M6 处置候选(是否让 `plugin.add` 把本地源复制进 `.market-artifacts/` 再安装,统一两条路径语义;spec §14 第十轮 第 48 条) |
| M5 签名信任锚发版供给:`PINS_AT_RELEASE` 现为空(fail-closed by design),生产公钥须随 app 发版按 `docs/market-server-deployment.md` 钉入 current 槽,否则 market 面恒拒;占位 origin `market.intranet.example:8787` 同为部署期配置(env `HUAANWORK_MARKET_ORIGIN` 覆盖) | `dsh-plugin-huaanwork/src/huaanwork-host/market/config.ts` | 发版 provisioning(M6 发行) |
| 市场来源选择入口未接入华安工作台界面(评审修复轮 N-1):provider 选择器住在 `client/DesktopSettingsSection.tsx`,经 `settings.section` slot 注入;而默认 `advanced` shell 下 `client-huaanwork/` 独占 layout 且对该 slot 零消费(实测 grep 无命中)⇒ 用户在本界面**无法**把 market provider 从默认 `disabled` 切到 `huaanwork-market`,只能经兼容模式桌面设置或直接改 profile 偏好。MarketView 的 not-registered 文案已按此事实陈述(不给走不通的导航路径)并由 `marketErrors.spec.ts` + `market-view.spec.ts` 双门钉住;接入该入口需把 `DesktopSettingsSection`(853 行,依赖完整 `DesktopSettingsApi`:profiles/AA/LAN/webview)或其 market 子集引进 `client-huaanwork/`,属 M6 UI 范围 | `dsh-plugin-huaanwork/src/client-huaanwork/logic/marketErrors.ts`(文案), `dsh-plugin-huaanwork/src/client/DesktopSettingsSection.tsx`(入口本体) | M6 |
