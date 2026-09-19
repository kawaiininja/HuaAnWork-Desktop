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
- `dsh-community-market/` owns the community-market shell. Until its runtime is implemented, it remains a private documentation scaffold and must not declare loadable DSH or package entry points.
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
