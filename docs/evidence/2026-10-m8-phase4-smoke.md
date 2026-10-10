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

## dist:mac-smoke:huaanwork — DMG produced after the pin

Provisioning scanner on the pinned tree, 2026-10-10T04:40:18Z, exit 0. Fingerprints only:

```text
HUAANWORK_MARKET_DEFAULT_ORIGIN = http://market.intranet.lan:8787
  sha256(origin string) = 80c6da2fa9934fa1e7115364062c6123ec42af8560a6f3e23da901567a2cc97d
HUAANWORK_UPDATE_DEFAULT_ORIGIN = http://update.intranet.lan:8790
  sha256(origin string) = e816cd5e97c6cd9bfa09fbb9518e776fd91c986f0a72d7212ced1f0e8d025ee9
PINS_AT_RELEASE.current.publicKeyHex = 5d162fd0a158518fa92769375c99ccd74b847670ef5a1ffbff035f22fffa1079
PINS_AT_RELEASE.current.keyId = f34f6afeb6d36759dafeb218d1b70a851ac08e9cdcc4ae6d9cbc12c2860fb531
  sha256(raw public key bytes) = f34f6afeb6d36759dafeb218d1b70a851ac08e9cdcc4ae6d9cbc12c2860fb531
```

`HUAANWORK_ALLOW_UNPROVISIONED_SMOKE` stayed unset. The private key stayed in `/Users/amonmiao/.huaanwork-release` and was not committed.

`corepack yarn dist:mac-smoke:huaanwork` started 2026-10-10T04:41:38Z and exited 1 at 04:42:52Z. `market:prepare` rewrote `dshmarket` from `1.66.11` to npm latest `1.66.14`, and `aa:prepare-release` moved the Agents Anywhere pin to `7fe1fce`. `package.spec` then rejected `dshmarket@npm:1.66.14`. Those rewrites were checked out and `corepack yarn install --immutable` exited 0. The upstream `dshmarket` resolution on the branch stays `1.66.11`. No DMG from that invocation.

On the restored tree, `corepack yarn workspace dsh-plugin-huaanwork dist:mac-smoke` (exemption still unset) exited 0, 2026-10-10T04:49:02Z–04:56:03Z. The first universal merge failed because `sherpa-onnx-darwin-arm64/libonnxruntime.dylib` was missing from HuaAnWork `x64ArchFiles`; that pattern is now in the huaanwork mac config, matching beta. The rerun printed `macOS DMG smoke verification passed` for `dsh-plugin-huaanwork/dist/mac-smoke/HuaAnWork-0.1.0-universal.dmg` (478M). The DMG is not committed.

## Earlier dist:mac-smoke attempt — not passed

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

## Root mac smoke after the dshmarket 1.66.14 lock

`corepack yarn market:prepare` at 2026-10-10T05:02:57Z exited 0 and wrote `dshmarket` `1.66.14` for desktop, beta, next, and huaanwork, with one root resolution `dshmarket@npm:1.66.14`. It did not move the Agents Anywhere pin. `corepack yarn install --immutable` exited 0. `corepack yarn check:desktop-variants` exited 0. Commit `fdb54d9d98`.

`corepack yarn dist:mac-smoke:huaanwork` with `HUAANWORK_ALLOW_UNPROVISIONED_SMOKE` unset started 2026-10-10T05:05:04Z and exited 0 at 05:12:57Z. `market:prepare` printed `dshmarket latest verified: 1.66.14` and did not rewrite the lock. `aa:prepare-release` selected AA main `7fe1fce32650483bf8433f7a198032178580ff16` and updated the bridge pin for the duration of the build. The command still exited 0. Verification printed `macOS DMG smoke verification passed` for `dsh-plugin-huaanwork/dist/mac-smoke/HuaAnWork-0.1.0-universal.dmg` (479M). The DMG is not committed.

After that exit, the AA provenance, bridge pin, and `yarn.lock` were checked back out to `7df5b31f3fe23d4be92ccd5ae5e0aeb6a3744c0e`. The new tarball was deleted. `corepack yarn install --immutable` exited 0. The AA pin move was not committed.

