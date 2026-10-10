# Phase 4 smoke — Task 4.2

Recorded on `sync/upstream-2.0.x` as-of `d22f8409fd` in `HuaAnWork-Desktop-sync`. `HUAANWORK_ALLOW_UNPROVISIONED_SMOKE` was unset. Built binaries and `dist/` are not in the commit.

Logs: `docs/evidence/2026-10-m8-phase4-logs/`.

## Update-chain digest — passed

The M6 data directory still matches the client. `channels/huaanwork.json` is version `0.1.1`, and `artifacts/huaanwork/mac/HuaAnWork-0.1.1-universal.dmg` is 531865729 bytes with sha256 `8dc014a72fd684db19d89672d214f06446c1ad3751920cd5b0bc8fc456c5d242`.

The server was pointed at an APFS clone of that directory. `checkForDesktopUpdate` from `0.1.0` on channel `huaanwork` returned `update-available` and `installerSha256.darwin` equal to the published digest. `downloadDesktopUpdate` saved a file with that digest. One byte at offset 4096 of the clone was flipped; the size stayed the same. The next download threw `invalid-artifact` / `The update installer does not match the published digest` and left no file. The original DMG hash was unchanged.

Command exit 0. Log: `digest-smoke.log` (2026-10-10T04:13:21Z–04:13:24Z).

## Market chain — passed

HuaAnWork market unit tests, not only `/healthz`:

```bash
corepack yarn workspace dsh-plugin-huaanwork exec vitest run \
  tests/client-huaanwork/market.spec.ts \
  tests/client-huaanwork/market-view.spec.ts \
  tests/client-huaanwork/market-source-panel.spec.ts \
  tests/client-huaanwork/marketErrors.spec.ts \
  tests/desktop-market.spec.ts \
  tests/dshmarket-compat.spec.ts \
  tests/huaanwork-market-provider.spec.ts \
  tests/huaanwork-market-wrapper.spec.ts \
  tests/market-composition-order.spec.ts \
  tests/market-pnpm-integration.spec.ts \
  tests/huaanwork-host/market-config.spec.ts \
  tests/huaanwork-host/market-e2e.spec.ts \
  tests/huaanwork-host/market-gate-vectors.spec.ts \
  tests/huaanwork-host/market-install.spec.ts \
  tests/huaanwork-host/market-pnpm-semantics.spec.ts \
  tests/huaanwork-host/market-routes.spec.ts \
  tests/huaanwork-host/market-verify.spec.ts
```

Exit 0. 17 files, 271 tests, 0 fail. Log: `market-unit.log` (04:13:20Z–04:13:26Z).

Live server, then the client: a throwaway market-server answered `GET /healthz` with `ok: true` before and after one signed catalog page. `fetchVerifiedManifest` plus `parseCatalogProviderPage` returned one item, `@huaanwork/phase4-probe`, `latestVersion` `1.0.0`, `page.total` 1. Exit 0. Log: `market-chain-smoke.log` (04:16:03Z–04:16:05Z). The one-shot spec was not committed.

## package:dir and migration smoke — passed

`corepack yarn workspace dsh-plugin-huaanwork package:dir` first exited 1. The packaged runtime smoke listed `Contents/Resources`, and `dsh-fs-local` threw `Cannot mix BigInt and other types` while probing `default_app.asar` (Electron's stat hook does not honor `{ bigint: true }`). Log: `package-dir-huaanwork.log`.

The same file in desktop, beta, and huaanwork now stats that parent and lists only the app tree and the skills root. The three packaged-filesystem unit tests passed. The rebuild exited 0 (04:18:15Z–04:18:41Z) and wrote `dist/mac-arm64/HuaAnWork.app`. Signing was skipped because the directory build sets the identity to null.

`upstream-session-migration.spec.ts` with `HUAANWORK_MIGRATION_SMOKE` unset: exit 0, 1 test. Log: `upstream-session-migration.log`. It does not need the packaged app.

`HUAANWORK_MIGRATION_SMOKE=1` first exited 1 because this shell exports `ELECTRON_RUN_AS_NODE=1`, so the binary started as Node and rejected `--user-data-dir` (exit 9). The spec now deletes that variable before spawn. The rerun exited 0 in 3.57s. Log: `migration-smoke.log` (passing run 04:26:11Z–04:26:16Z).

## dist:mac-smoke:huaanwork — not passed

```bash
corepack yarn dist:mac-smoke:huaanwork
```

`HUAANWORK_ALLOW_UNPROVISIONED_SMOKE` was unset. The command is not recorded as passed.

`market:prepare` rewrote the pinned `dshmarket` `1.66.11` to npm latest `1.66.14`. `aa:prepare-release` resolved AA main to `7fe1fce32650483bf8433f7a198032178580ff16`, which is not the pinned `7df5b31f3fe23d4be92ccd5ae5e0aeb6a3744c0e`. That rewrite was stopped before it replaced the bridge, and the `dshmarket` edit was checked out. `corepack yarn install --immutable` then exited 0.

The local release-smoke-gate on the restored tree:

```bash
node dsh-plugin-huaanwork/scripts/huaanwork-verify-provisioning.mjs --smoke
```

Exit 1. Unprovisioned: empty `PINS_AT_RELEASE`, and both default origins still contain `.example`. No DMG. Keys were not invented. Log: `dist-mac-smoke-huaanwork.log` (command start 04:26:34Z, gate end 04:27:39Z).
