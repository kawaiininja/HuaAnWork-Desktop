# Conversation capabilities — Task 8 headless gates (2026-10-21)

Worktree: `HuaAnWork-Desktop/.worktrees/conversation-capabilities`
Branch: `feat/huaanwork-conversation-capabilities`
Parent HEAD: `3fb2dc18bd7c6f7181cf224b2b786e4be3d4e4a6`

Scope: close the two Task 7 review residuals (type truth for the unattended holder; a route-level
`project.remove` release-callback test), then run the headless gates and build the huaanwork package
for Task 9. No GUI was launched, and no dependency or submodule content was downloaded.

## Changes under test

| Fix | File | Evidence |
| --- | --- | --- |
| `UnattendedHolder.current` now admits the `null` boot slot that `holders.ts` installs | `dsh-plugin-huaanwork/src/huaanwork-guardrails/policy.ts` | Typecheck exit 0; built declaration `lib/types/huaanwork-guardrails/policy.d.ts` prints `current?: UnattendedScope \| null` |
| `project.remove` hands the release callback to `removeAutomationsOfProject` | `dsh-plugin-huaanwork/tests/huaanwork-host/automations-store.spec.ts` (new route test) | RED when the callback argument was removed from the route; see below |
| Boot-shaped holder (`{ current: null }`) keeps the baseline ask path | `dsh-plugin-huaanwork/tests/huaanwork-guardrails/policy.cordis.spec.ts` | 30 tests pass, including the new boot-shape case |

### RED probe for the `project.remove` route test

Temporarily changed the route to `removeAutomationsOfProject(ctx.profileDir, projectId)` (no
sessions root, no callback), then:

```bash
corepack yarn workspace dsh-plugin-huaanwork vitest run tests/huaanwork-host/automations-store.spec.ts -t "project.remove releases automation run sessions"
```

Result: **1 failed | 41 skipped**; `expected [] to deeply equal [ "huaanwork-auto-…-r1" ]`. The route
still deleted the run session directory (the default sessions root coincides with the test's
`dshHome`), so only the missing release callback turned the test red. The route was restored
immediately; the full `automations-store` suite is green (42 tests).

## Gates

All commands were run from the worktree root on 2026-10-21.

| # | Command | Exit | Result |
| --- | --- | --- | --- |
| 1 | `corepack yarn workspace dsh-plugin-huaanwork test` | **1** | `Test Files 1 failed \| 238 passed \| 3 skipped (242)`; `Tests 1 failed \| 2804 passed \| 13 skipped (2818)`. The only failure is the environment-only `mac-entitlements` case below. |
| 2 | `corepack yarn workspace dsh-plugin-huaanwork typecheck` | **0** | Clean across all five tsconfigs (no output). |
| 3 | `corepack yarn check:desktop-variants` | **0** | 11 tests, 11 pass, 0 fail. Guard line: `stable↔beta src (214 files), stable↔beta scripts (33 files), beta↔huaanwork src (168 files), beta↔huaanwork scripts (22 files) … stable↔beta allowlist 7 (oneSidedPrefixes 0), beta↔huaanwork allowlist 64 (oneSidedPrefixes 6)`. No allowlist entry was added or enabled. |
| 4 | `corepack yarn workspace dsh-plugin-huaanwork check` | **1** | The chain is `build && typecheck && test && verify:closure && verify:cli && verify:loader && verify:profile && verify:host && verify:aa && verify:licenses && verify:operations`. Build, typecheck, and test ran; the chain stopped at test on the same environment-only `mac-entitlements` failure. See the step-by-step table for the remaining steps, run individually. |
| 5 | `corepack yarn workspace dsh-plugin-huaanwork build` | **0** | `lib/bin.js` rebuilt; see artifacts below. |

### `check` steps run individually after the chain stopped

Because `yarn check` uses `&&`, the steps after `test` did not execute inside that run. Each was run
separately in the same worktree:

| Step | Exit | Result |
| --- | --- | --- |
| `corepack yarn workspace dsh-plugin-huaanwork verify:closure` | 0 | 4 tests, 4 pass; `316 first-party nodes form a closed reachable runtime graph.` |
| `corepack yarn workspace dsh-plugin-huaanwork verify:cli` | 0 | Silent success. |
| `corepack yarn workspace dsh-plugin-huaanwork verify:loader` | 0 | Silent success. |
| `corepack yarn workspace dsh-plugin-huaanwork verify:profile` | 0 | `verify-profile-boot: minimal preset, plugin manager, and disabled hmr lock passed`; expected `warning: 2 entries did not activate` (`web-fetch-http` waits on `web`, `job-controller` waits on `jobs`, both disabled by the guardrail lock). |
| `corepack yarn workspace dsh-plugin-huaanwork verify:host` | 0 | 14 tests, 14 pass, 0 fail. |
| `corepack yarn workspace dsh-plugin-huaanwork verify:aa` | 0 | Same `minimal preset, plugin manager, and disabled hmr lock passed` line. |
| `corepack yarn workspace dsh-plugin-huaanwork verify:licenses` | 0 | `624 production packages checked; 2 use notice-required licenses (LGPL-3.0-or-later)`. |
| `corepack yarn workspace dsh-plugin-huaanwork verify:operations` | 0 | `7 operations and 18 fault contracts verified.` |

These steps were run sequentially, not in parallel, so the known `verify:aa` concurrency race does
not apply.

## Environment-only failure (not branch-caused)

```
FAIL tests/mac-entitlements.spec.ts > inherits the pinned upstream entitlement file for the main app and all Helpers
Error: ENOENT: no such file or directory, open '…/deepseek-harness/apps/desktop/scripts/macos-entitlements.plist'
```

`git submodule status deepseek-harness` reports `-1600d8a1e140dcde43a1a0941940a0480712c011`, i.e. the
submodule is **not initialized** in this worktree, and `deepseek-harness/` is empty. The test reads a
file that only exists in the pinned upstream checkout. No download or install was performed to
mask this, and the file is inside `deepseek-harness/`, which this task must not edit. This failure is
therefore recorded as environment-only and is the sole reason gates 1 and 4 exit non-zero.

Apart from it, the suite is green: **2804 passed, 13 skipped**, and all other `check` steps exit 0.
The full suite is **not** claimed green as a whole.

## Build artifacts

`corepack yarn workspace dsh-plugin-huaanwork build` exit 0. Fresh artifacts as of 2026-10-21 02:13:

- `dsh-plugin-huaanwork/lib/bin.js` — rebuilt (11,763 bytes).
- `dsh-plugin-huaanwork/lib/sessions-Bk6nJJl9.js` and `lib/routes-q60wpR96.js` — contain
  `releaseSessionRuntime` (the Task 7 helper the new route test exercises).
- `dsh-plugin-huaanwork/lib/client.js` — contains `INITIAL_GRACE_MS` (Task 7 turn-status change).
- `dsh-plugin-huaanwork/lib/types/huaanwork-guardrails/policy.d.ts` — declaration shows
  `current?: UnattendedScope | null`, i.e. the type fix is in the shipped types.
- `find lib -name "*.js" -newermt "2026-10-21 00:00:00" | wc -l` → **132** freshly built chunks.

Hashed chunk names change per build; the `lib/bin.js` and `lib/types/` timestamps are the stable
freshness markers Task 9 can re-check.

## Reproduction

```bash
cd HuaAnWork-Desktop/.worktrees/conversation-capabilities
corepack yarn workspace dsh-plugin-huaanwork test            # exit 1: only mac-entitlements (environment)
corepack yarn workspace dsh-plugin-huaanwork typecheck       # exit 0
corepack yarn check:desktop-variants                         # exit 0, 11/11
corepack yarn workspace dsh-plugin-huaanwork build           # exit 0
corepack yarn workspace dsh-plugin-huaanwork verify:closure  # exit 0
corepack yarn workspace dsh-plugin-huaanwork verify:cli      # exit 0
corepack yarn workspace dsh-plugin-huaanwork verify:loader   # exit 0
corepack yarn workspace dsh-plugin-huaanwork verify:profile  # exit 0
corepack yarn workspace dsh-plugin-huaanwork verify:host     # exit 0, 14/14
corepack yarn workspace dsh-plugin-huaanwork verify:aa       # exit 0
corepack yarn workspace dsh-plugin-huaanwork verify:licenses # exit 0
corepack yarn workspace dsh-plugin-huaanwork verify:operations # exit 0
```
