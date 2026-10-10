# Phase 4 root gates — Task 4.1

As-of parent HEAD `7037c6e8a4` on `sync/upstream-2.0.x` (2026-10-10). The green `corepack yarn check` ran in the worktree that also contains this commit's HuaAnWork client-build fix. `BASE_SHA` was unset. `package:dir` and the migration smoke are Task 4.2 and were not run.

Raw logs: `docs/evidence/2026-10-m8-phase4-logs/`.

## What `corepack yarn check` already runs

Root `check` is `check:whitespace`, then `check:layout`, then `test:aa-connector`, then each workspace `check` in order. `check:layout` already runs `check:vendored-runtime` and `check:desktop-variants`. Each of `dsh-plugin-desktop`, `dsh-plugin-desktop-beta`, and `dsh-plugin-huaanwork` runs `verify:aa` inside its own `check`, and the root chain joins those with `&&`, so the three AA profile smokes are sequential. Those gates were not launched a second time. Their results below are quoted from the green `yarn check` log.

## Gate fix found by the first red runs

`corepack yarn check` on clean `7037c6e8a4` exited 1 while building `dsh-plugin-huaanwork`. Log: `yarn-check.log`. tsdown's client entry imported `src/client/onboarding.css` (Tailwind) and stopped because `@tsdown/css` is not installed. Beta compiles that sheet with Vite. The HuaAnWork client build now does the same: `vite.client.config.ts` (same text as beta; the package name is read from `package.json`), `vite build --config vite.client.config.ts` after `tsdown`, and the tsdown client entry removed. The "no Node process globals" test reads `vite.client.config.ts`.

The next `yarn check` (`yarn-check-rerun.log`, exit 1) got past the build and failed in `verify-profile-boot.mjs` at `acquireScope('cordis')`: the guardrail lock disables `jobs`, `web`, and `user-questions`, so the cordis preset cannot mount. A follow-up `verify:profile` (`verify-profile-huaanwork.log`, exit 1) then failed the live HMR loop, because the same lock disables `hmr`. The HuaAnWork smoke now mounts the selected default `minimal` and asserts the `hmr` disable, instead of claiming two live reload generations. `verify-profile-huaanwork-2.log` exit 0: `verify-profile-boot: minimal preset, plugin manager, and disabled hmr lock passed`.

No `check:layout` step was moved. The no-deps run below completed with the existing string.

## `corepack yarn check` — exit 0

Command, from `HuaAnWork-Desktop-sync`, `BASE_SHA` unset:

```bash
corepack yarn check
```

Log: `docs/evidence/2026-10-m8-phase4-logs/yarn-check-rerun-2.log`. Started 2026-10-10T03:39:08Z, ended 2026-10-10T03:44:17Z, **exit 0**. Parent HEAD `7037c6e8a4`. Worktree contained the fix above.

### `check:whitespace`

First step of `check`. Compares `git diff --check "$(git merge-base origin/master HEAD)" HEAD` when `BASE_SHA` is unset. Merge-base as-of this run: `8cd74f5e9b`. Success prints nothing. The log's next output is `check:layout`, and the chain exited 0, so this step passed for committed `7037c6e8a4`. It does not see uncommitted files. A separate `git diff --check 8cd74f5e9b` on the worktree that includes the fix also exited 0.

### `check:layout` (inside `yarn check`, dependencies already installed)

| Step | Result as-of this run |
|---|---|
| `test:market-release` | 5 tests, 5 pass, 0 fail |
| `test:aa-release` | 14 tests, 14 pass, 0 fail |
| `check:bilingual-docs` | 4 tests, 4 pass, 0 fail; `verify-bilingual-docs: 54 records and 108 documents are consistent` |
| `check:architecture` | 9 tests, 9 pass, 0 fail; `verify-market-dependency-direction: 779 tracked source files` |
| `check:vendored-runtime` | `stable 318 packages from 639ed01539`; `beta 321 packages from 5badb15009`; `huaanwork 321 packages from 5badb15009` |
| `check:desktop-variants` | 11 tests, 11 pass, 0 fail. Guard: `stable↔beta src (204 files), stable↔beta scripts (33 files), beta↔huaanwork src (187 files), beta↔huaanwork scripts (31 files)`; `stable↔beta allowlist 9 (oneSidedPrefixes 0), beta↔huaanwork allowlist 22 (oneSidedPrefixes 6)` |
| `icons:check` | 1 test, 1 pass, 0 fail; stable, beta, and next resources match |
| `verify-layout.mjs` | `verify-layout: all Desktop workspaces including Next and upstream 5badb15009 are consistent` |
| `test:gate-scripts` | 1 test, 1 pass, 0 fail |
| `check:readme-versions` | `4 hardcoded artifact version string(s) in 1 scoped package(s) (dsh-plugin-huaanwork)` |

### `test:aa-connector`

12 tests, 12 pass, 0 fail (desktop, beta, next, huaanwork).

### Workspace checks, in chain order

| Workspace | Result |
|---|---|
| `dsh-community-fabric` | `verify-fabric-docs: 20 Markdown files and 10 bilingual pairs are consistent` |
| `dsh-community-market` | docs consistent (12 Markdown, 6 pairs, 4 schemas); exports and client loader passed; **22 files, 285 tests, 0 fail** |
| `dsh-plugin-desktop` | **158 files passed, 2 skipped (160); 1742 tests passed, 12 skipped (1754)**. Closure 296 nodes. `verify:profile` and `verify:aa`: `Creator, plugin manager and two Profile HMR generations passed` (one line each, in that order). Licenses: 591 production packages. Operations: 7 operations, 18 fault contracts. |
| `dsh-plugin-desktop-beta` | **156 files passed, 1 skipped (157); 1721 tests passed, 10 skipped (1731)**. Closure 298 nodes. `verify:profile` and `verify:aa`: same Creator/HMR line, one each. Licenses: 609 production packages. Operations: 7 operations, 18 fault contracts. |
| `dsh-desktop-next` | **54 files, 427 tests, 0 fail**. Frontend check passed for official 0.2.1-alpha.1. Host smoke passed. |
| `dsh-plugin-huaanwork` | **215 files passed, 3 skipped (218); 2578 tests passed, 13 skipped (2591)**. Closure 298 nodes. `verify:profile` and `verify:aa`: `minimal preset, plugin manager, and disabled hmr lock passed` (one line each). Both boots still log `warning: 2 entries did not activate` for `web-fetch-http` (waiting for `web`) and `job-controller` (waiting for `jobs`); those rows are disabled by the guardrail lock, and the command still exited 0. Licenses: 609 production packages. Operations: 7 operations, 18 fault contracts. |
| `market-server` | **14 files, 244 tests, 0 fail** |
| `update-server` | **5 files, 88 tests, 0 fail** |

`check:aa` is those three `verify:aa` lines (desktop, then beta, then huaanwork). They were not run concurrently and were not repeated outside `yarn check`.

## `check:layout` with no install — exit 0

Temporary detached worktree of `7037c6e8a4` at `HuaAnWork-Desktop-layout-nodeps` (not the main `HuaAnWork-Desktop` checkout). Submodule `deepseek-harness` checked out at `5badb15009`. `find` reported **0** `node_modules` directories. No `yarn install`.

```bash
corepack yarn check:layout
```

Log: `docs/evidence/2026-10-m8-phase4-logs/check-layout-nodeps.log`. Started 2026-10-10T03:22:21Z, ended 2026-10-10T03:22:30Z, **exit 0**. Same pass counts and the same vendored-runtime, desktop-variant, layout, and readme lines as the table above. The worktree was removed afterwards (`git worktree list` shows only `HuaAnWork-Desktop` on `master` and this sync worktree).

## Next checks from §7.8 item 1

Not part of root `check`. Chromium for Playwright was installed first (`yarn workspace dsh-desktop-next exec playwright install chromium`) because the browser binary was absent. This machine has a built-in display (Liquid Retina XDR, online) and no `xvfb-run`.

| Command | Exit | Result |
|---|---|---|
| `corepack yarn workspace dsh-desktop-next verify:window-controls` | **0** | `Next window controls passed through the official 0.2.1-alpha.1 Desktop boot branch…` Log: `verify-window-controls.log` (2026-10-10T03:48:52Z–03:49:25Z). |
| `corepack yarn workspace dsh-desktop-next verify:onboarding` | **0** | `Original Next onboarding passed inside the official surface…` Log: `verify-onboarding.log` (03:49:25Z–03:49:41Z). |
| `corepack yarn workspace dsh-desktop-next verify:protocol --no-sandbox` | **1** | **Not passed.** Electron started (not Node mode) and printed `Run this native protocol check on Linux under xvfb-run; use check:next for portable headless checks.` The script requires `process.platform === 'linux'` and `DISPLAY`. This host is Darwin. Log: `verify-protocol.log` (03:50:11Z–03:50:12Z). |
| `corepack yarn workspace dsh-desktop-next verify:sidebar-browser --no-sandbox` | **1** | **Not passed.** `Run this native Browser check on Linux under xvfb-run; portable checks do not start Electron.` Same Linux requirement. Log: `verify-sidebar-browser.log` (03:50:12Z–03:50:12Z). |

The two exit-1 results are the scripts' own platform guard, not a product failure and not a missing display. They are not recorded as passed. The scripts were not changed to run on Darwin.
