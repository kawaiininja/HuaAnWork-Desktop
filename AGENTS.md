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
- macOS release acceptance is **"credentials arrive → sign"**: the pipeline (`scripts/release-preflight.ts`, `scripts/release-mac.ts`, `scripts/verify-mac-release.ts`) is complete and runbook'd in `docs/release-checklist.md`. Per ruling R-6 (2026-09-30) the credential purchase is trigger-deferred, so shipping unsigned intranet artifacts is the expected M6 state rather than a gap — once credentials arrive, R1 runs the checklist as-is (no unfinished development work).

## Known tech debt

| Item | File | Milestone |
|------|------|-----------|
| `verify:aa` concurrent process race: running `corepack yarn check` in parallel across all three workspaces occasionally causes the beta `verify:aa` step to fail (AA Host services conflict). Each workspace passes in isolation; CI strips `verify:aa` via the AA-skip step. Pre-dates M1. | `dsh-plugin-desktop-beta/scripts/verify-profile-boot.mjs` L333 | Pre-existing upstream flakiness |
| market-server 运营面延后加固残余(实现评审第 5 批,2026-09-27 登记;其中 **P5–P10 六项已由 M6 Task 6.5 处置**、**P11 两半已由 M6 Task 6.6 处置**、**D3 残余(读侧逐条目隔离)已由 M6 Task 6.7 处置**):**P36** `dsh-community-market` 依赖用普通版本号而非 `workspace:^`(工作区版本漂移时会静默解析到 registry 版本,而 `entry-contract.ts` 现已把上游契约校验器放进**写路径**) | `market-server/src/{store.ts,catalog/store.ts,catalog/service.ts,admin/ui.ts,server.ts,signing.ts,tarball/store.ts}`, `market-server/package.json` | M6(逐条见 `HuaAnWork/docs/superpowers/plans/2026-09-26-…-m5-market-implementation-review.md` 低优先项表) |
| 市场目录**单页 200 条目上限**(实现评审 D15;M6 Task 6.4,2026-09-30 已可配置 + 文档诚实化):签名清单只承载一个 provider page(上游契约 `catalog-provider-page` 的 `items` `maxItems: 200`),故目录**规模天花板 = 200 条目**——这是**上游契约**而非本服务的实现选择。**已修的部分**:① 冻结态(2026-09-27):上限前移到**发布时**(第 N 条上架即 422 `catalog-full`),目录因此永不进入「prepare 持续失败、连既有条目也发不出新清单」的冻结态;② 硬编码常量(Task 6.4):上限经 `MARKET_SERVER_MAX_CATALOG_ENTRIES` 可配置(**默认 200、硬上限 200**;配置更高即启动失败并在错误信息中引上游契约 `maxItems`,调低合法——如 50 ⇒ 第 51 条上架即 422 `catalog-full`),发布时 cap 与 prepare 纵深(422 `catalog-too-large`)读**同一配置值**;`MAX_MANIFEST_ENTRIES` 是该契约默认/天花板的唯一定义。回归测试 `admin.spec.ts`「rejects the 201st entry at publish time so the catalog can never freeze」+ 配置低上限用例;runbook 新节〈目录规模上限〉。**仍在的部分(延后)**:超过 200 个插件需分页清单/多页签名(须另解「一个签名信封覆盖多页」的信任模型);M5 计划 Tech Stack「规模千级条目前足够」的假设已在该计划〈实施后订正汇总〉第 10 条订正(评审 D15) | `market-server/src/config.ts`(env 解析 + 启动校验), `market-server/src/manifest-prepare.ts`(`MAX_MANIFEST_ENTRIES` 契约默认/天花板), `market-server/src/admin/routes.ts`(发布时读配置) | 后续(裁定 R-3:分页/多页签名延后) |
| MarketView UX/a11y 延后项(实现评审第 5 批,2026-09-27 登记):**P26** `installed` 页签对 IMMUTABLE bundle(`@deepseek-ai/dsh-base`、`dsh-web-app`、`dsh-desktop-app`、`dsh-community-market`、`huaanwork-market`)给可点的「移除」且必然失败(失败信息诚实,但按钮应灰化) | `dsh-plugin-huaanwork/src/client-huaanwork/{MarketView.tsx,styles.css}` | M6 |
| 取消重启后的界面入口残余(P28 处置后,2026-09-30 整支评审登记):Task 5.3 只接线了「安装写入清单后取消重启」;plugin **remove** 流(`dsh-plugin-huaanwork/src/client-huaanwork/MarketView.tsx:312-323`,取消后仅中性通知)与 market provider **切换**流(`dsh-plugin-huaanwork/src/client-huaanwork/MarketSourcePanel.tsx:113-137,258-262`,取消后对话框只剩「已保存…」提示,关闭后无任何重启入口)仍无界面手段重启。与兼容模式设置面同形,非本变体回归。修法 = 复用 5.3 的 `restartPending` 模式(各约 4-10 行);若多于一处接线,应抽共享组件以免三份横幅 | `dsh-plugin-huaanwork/src/client-huaanwork/{MarketView.tsx,MarketSourcePanel.tsx}` | 后续(M6 处置候选) |
| wrapper 清理延后项(实现评审第 5 批,2026-09-27 登记):**P3** 独立 restart 路由返回裸「已取消重启」,未复用 `plugins-host.ts` 的 §14 第 33 条诚实措辞(「取消≠未生效,下次启动照常生效」) · **P13** `usableMarketVerificationKeys` 是生产死代码且与 `marketKeySlotsFromPins` **重复实现**槽 2 `retiredAt` 判定(两份真相源) · **P16** `${statePath}.tmp` 固定名(`install.ts` 的制品 tmp 已带 pid,两处不一致) · **P18** `market-composition-order.spec.ts` 的负例注释与报错文案(`landed in the guardrail lock layer`)与实际 fixture 构造不符(断言本身有效) · **P19** 已签名清单的 `manifest.files` 无形状守卫(畸形值经 `canonicalJson` 会 fail-closed 映射 503,但非数组会抛裸 TypeError → 400) · **P20** `VerifiedManifest.revisionAdvanced` 无消费方 · **N-11** `HUAANWORK_CHECKPOINT_USER_DATA_DIR` 无条件写入 `process.env` ⇒ 泄漏到所有子进程(含用户可见终端),与既有 `DSH_HOME` 同级非新类 | `dsh-plugin-huaanwork/src/huaanwork-host/market/{routes.ts,config.ts,verify.ts,catalog-client.ts}`, `src/main.ts` | M6 |
| 上游同步例外: 三包 `tests/package.spec.ts` 运行时跨边界读取 root `scripts/expected-root-gate-scripts.json` 作为单一真相源 (消解 P21)。stable/beta 的 `tests/package.spec.ts` 由此新增一段对 root `scripts/` 的运行时读取 (`readFileSync` + `join(import.meta.dirname, '../../scripts/expected-root-gate-scripts.json')`, 不是 import 以避免破坏本包 typecheck); 这两份文件虽属 variant 守卫既有例外 (spec §14 第 17 条), 但与上游 `dsh-desktop` 同步时该段读取仍会冲突 | `dsh-plugin-desktop/tests/package.spec.ts`, `dsh-plugin-desktop-beta/tests/package.spec.ts`, `dsh-plugin-huaanwork/tests/package.spec.ts` | 上游同步例外 |
| M6 variant 白名单预算预登记(22 项,前缀 6 项):`allowedDifferences` 扩容 19→22(新增 `src/update-checker.ts`、`src/update-download.ts`、`scripts/verify-win-installer.ts` 三项,因 release-channel 切换/更新 endpoint 配置化/NSIS 制品名差异;`src/profile-channel-admission.ts` 和解下沉已在册的 `src/profile-checkpoint.ts` #18 保持三包逐字节相同故零改动不占额);`oneSidedPrefixes` 扩容 5→6(新增 `src/huaanwork-migration/` 数据迁移模块) | `scripts/verify-desktop-variants.mjs` | M6 |
| DSH Desktop 命名残留(variant 原生文案,2026-09-30 用户裁定「登记为债、本轮不修」):`dsh-plugin-huaanwork/src/` 实测 33 文件 127 处仍写 "DSH Desktop",其中**运行时可触达**的有更新可用/已下载/可安装/已安装对话框、重启确认与 mac 安装指引(`native-dialog-copy.ts`,经 `electron-runtime.ts` 弹窗)、恢复文案(`recovery-copy.ts`)与兼容模式标题栏(`native-ui/compatibility-chrome/main.tsx`);含两条死文案 `DSH Desktop Beta`(`native-dialog-copy.ts:94/167`,install-stable 流程未注册于本 variant)。33 中的 `product-identity.ts:13` 与 `update-download.ts:200` 是 beta variant 自身的身份/命名表项,属正当豁免。清理须逐文件扩 variant 白名单,而预算已满(22/22,由 `scripts/verify-desktop-variants.test.mjs` 钉死)⇒ 需单独预算裁定 | `dsh-plugin-huaanwork/src/native-dialog-copy.ts`, `dsh-plugin-huaanwork/src/recovery-copy.ts`, `dsh-plugin-huaanwork/src/native-ui/compatibility-chrome/main.tsx` | 后续(命名清扫需单独预算裁定) |

