# 2026-10 M8 delivery summary (Task 6.4)

Worktree: `HuaAnWork-Desktop-sync`. Branch: `sync/upstream-2.0.x`. Parent of this file: `bcf4088bba4d86e61a3a7e0e74a245d315c3af00`. `origin/master` is `6708693d4dfd239eea72f1c3715a5751bf69e1d0`. This commit is local. It was not pushed.

This file indexes the phase evidence. It does not claim the CI run passed.

## Phase evidence index

These are the `docs/evidence/2026-10-m8-*.md` files already on the branch when this summary was added. The SHA is the last commit that changes that file.

| File | Last change | What it records |
|---|---|---|
| `docs/evidence/2026-10-m8-merge-spike-refresh.md` | `3ecec80f32` | Phase 0 spike refresh (Task 0.2; last edit is the Task 0.3 inflation close) |
| `docs/evidence/2026-10-m8-merge-decisions.md` | `1743474908` | Phase 2 resolution table (opened in Task 2.5, closed in Task 2.9) |
| `docs/evidence/2026-10-m8-phase4-gates.md` | `f36e5ae3ad` | Phase 4 root gates (Task 4.1) |
| `docs/evidence/2026-10-m8-phase4-smoke.md` | `19c661087a` | Phase 4 smoke (Task 4.2) |
| `docs/evidence/2026-10-m8-phase5-readme.md` | `4ade24c3aa` | Phase 5 README version guard (Task 5.2) |
| `docs/evidence/2026-10-m8-exit-audit.md` | `ea6d59d19b` | Pre-push exit audit (Task 6.1) |
| `docs/evidence/2026-10-m8-push.md` | `6708693d4d` | Single push (Task 6.2). This SHA is `origin/master` |
| `docs/evidence/2026-10-m8-ci-reconciliation.md` | `bcf4088bba` | CI cell ledger (Task 6.3). Local only; not on `origin/master` |

## Effort

The plan's effort range is **14.5–21.0 person-days** (`2026-10-08-dsh-desktop-integration-m8-upstream-resync.md`, section 2): Phase 0 is 1–1.5, Phase 1 is 1–1.5, Phase 2 is 7–10, Phase 3 is 1.5–2.5, Phase 4 is 1.5–2, Phase 5 is 1.5–2, and Phase 6 is 1–1.5.

Actual person-days were not measured in this session. This file does not state an actual number.

## Resolution table

`docs/evidence/2026-10-m8-merge-decisions.md`

## Residuals

README out-of-scope artifact strings are still `2.0.5` / `2.0.5-beta.2`. `docs/evidence/2026-10-m8-phase5-readme.md` records that the four out-of-scope READMEs were not rewritten. `dsh-plugin-desktop` `package.json` is `2.0.17`, and both desktop READMEs still name `DSH-Desktop-2.0.5-x64-Setup.exe` and `DSH-Desktop-2.0.5-x64-Portable.zip`. `dsh-plugin-desktop-beta` `package.json` is `2.0.17-beta.1`, and both beta READMEs still name `DSH-Desktop-Beta-2.0.5-beta.2-x64-Setup.exe` and `DSH-Desktop-Beta-2.0.5-beta.2-x64-Portable.zip`.

`verify:protocol` and `verify:sidebar-browser` are not passed on Darwin. `docs/evidence/2026-10-m8-phase4-gates.md` records both exits as 1. Each script requires Linux under `xvfb-run`. This host is Darwin. They are not recorded as passed.

The second evidence push is already on origin. `origin/master` is `6708693d4dfd239eea72f1c3715a5751bf69e1d0`, which is the follow-up after `47f52aad5e`. That range stays on the remote. This task does not force-push and does not push again to erase it. `docs/evidence/2026-10-m8-push.md` at that SHA still says the main worktree submodule checkout is dirty and that the published tip is `47f52aad5e`.

CI run https://github.com/kawaiininja/HuaAnWork-Desktop/actions/runs/38033205707 is blocked by the account spending limit. The expanded ledger is 0 green, 1 red, 10 skipped. `changes` did not start. Its annotation is: "The job was not started because recent account payments have failed or your spending limit needs to be increased." The same annotation is on earlier runs, including https://github.com/kawaiininja/HuaAnWork-Desktop/actions/runs/37600132144 and https://github.com/kawaiininja/HuaAnWork-Desktop/actions/runs/37714088258 before this branch, and on https://github.com/kawaiininja/HuaAnWork-Desktop/actions/runs/38033065235 for the earlier M8 push. This red is not attributed to this branch. The run is not green. The ledger is `docs/evidence/2026-10-m8-ci-reconciliation.md`.

Update-chain digest. `docs/evidence/2026-10-m8-merge-decisions.md` says the remaining differences are identity constants and that they are allowed to stay. Those constants are the `huaanwork` channel enum, the intranet update origin inside `resolveUpdateOrigin`, and the release-channel shape (`SUPPORTED_RELEASE_CHANNELS` and `matchesReleaseChannelVersionShape`). The table does not record any other digest semantic difference as still unclosed. It does not call those identity constants closed.

A10. The tray-icon check stays failed and out of scope. `docs/huaanwork-m4-human-verification-2026-10-07.md` records A10 as not passed (F-M4-1): the status item is created and the menu works, and the icon draws no pixels. This milestone does not fix it. As-of parent `9bc0e2de02`, this branch vendors Electron `44.0.0`: `dsh-plugin-huaanwork/package.json` pins that version in `devDependencies` and `peerDependencies`, `yarn.lock` resolves `electron@npm:44.0.0` to version `44.0.0`, and `dsh-plugin-huaanwork/node_modules/electron/package.json` reads `44.0.0`. The tray check was not re-run.

M23. The `tests/` guard was not added. The remaining prerequisite is the left-sided mechanism. `oneSidedPrefixes` still means a path that exists only on the right.

## Dashboard

No fetch. Both counts are from the local `upstream/master` ref `ca52ce2cd9ac872358e9a9464902e3c7ee4d494f`. On parent `bcf4088bba`, `git merge-base HEAD upstream/master` was that same commit, `git rev-list --count HEAD..upstream/master` was 0, and `git rev-list --count upstream/master..HEAD` was 288. This file's commit is one more commit reachable from `HEAD` and not from `upstream/master`. The as-of reading on the commit that adds this file is:

```bash
git rev-list --count HEAD..upstream/master
```

```
0
```

```bash
git rev-list --count upstream/master..HEAD
```

```
289
```

The upstream count is 0. `upstream/master` is an ancestor of this commit. The local ref is still the merged tip `ca52ce2cd9ac872358e9a9464902e3c7ee4d494f`, so the zero is not an upstream advance after the merge.

Fix round 1 edits this file in a later commit. No fetch. As-of that commit, `git rev-list --count HEAD..upstream/master` is 0 and `git rev-list --count upstream/master..HEAD` is 290. The behind count stays 0 because `upstream/master` is still an ancestor of HEAD.
