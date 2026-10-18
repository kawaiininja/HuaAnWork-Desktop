# 2026-10 M9 CI reconciliation (Task 16.2)

Worktree: `HuaAnWork-Desktop-sync-m9`. Merge candidate `a1da73705d`, merged as `cba173c2d59bd1e5be89477ecdb0fb82e2ec882b` (PR #7). Recorded SHA: `cba173c2d59bd1e5be89477ecdb0fb82e2ec882b` (`origin/master` after the merge). This file is the expanded-cell ledger for the master push run; it is not a substitute for the run's own logs.

The cell list is the expanded matrix of `.github/workflows/ci.yml` at that SHA. `check` is one job; its Next steps are steps of that job, not extra cells. `desktop-linux` has stable and beta; huaanwork has no Linux artifact.

## Run

| Field | Value |
|---|---|
| Event | `push` to `master` |
| Head SHA | `cba173c2d59bd1e5be89477ecdb0fb82e2ec882b` |
| Run | https://github.com/kawaiininja/HuaAnWork-Desktop/actions/runs/39111938837 |
| Created | `2026-10-18T08:33:58Z` |
| Status | `completed` |
| Conclusion | `success` |

## Expanded cells

| Job | Conclusion | URL |
|---|---|---|
| `changes` | `success` | https://github.com/kawaiininja/HuaAnWork-Desktop/actions/runs/39111938837/job/117629737563 |
| `check` (steps include `verify:window-controls`, `verify:onboarding`, `verify:protocol`, `verify:sidebar-browser`) | `success` | https://github.com/kawaiininja/HuaAnWork-Desktop/actions/runs/39111938837/job/117629821802 |
| `desktop-linux` / `dsh-plugin-desktop` | `success` | https://github.com/kawaiininja/HuaAnWork-Desktop/actions/runs/39111938837/job/117629821736 |
| `desktop-linux` / `dsh-plugin-desktop-beta` | `success` | https://github.com/kawaiininja/HuaAnWork-Desktop/actions/runs/39111938837/job/117629821754 |
| `desktop-macos` / `dsh-plugin-desktop` | `success` | https://github.com/kawaiininja/HuaAnWork-Desktop/actions/runs/39111938837/job/117629821763 |
| `desktop-macos` / `dsh-plugin-desktop-beta` | `success` | https://github.com/kawaiininja/HuaAnWork-Desktop/actions/runs/39111938837/job/117629821762 |
| `desktop-macos` / `dsh-plugin-huaanwork` | `success` | https://github.com/kawaiininja/HuaAnWork-Desktop/actions/runs/39111938837/job/117629821771 |
| `desktop-windows` / `dsh-plugin-desktop` | `success` | https://github.com/kawaiininja/HuaAnWork-Desktop/actions/runs/39111938837/job/117629821784 |
| `desktop-windows` / `dsh-plugin-desktop-beta` | `success` | https://github.com/kawaiininja/HuaAnWork-Desktop/actions/runs/39111938837/job/117629821831 |
| `desktop-windows` / `dsh-plugin-huaanwork` | `success` | https://github.com/kawaiininja/HuaAnWork-Desktop/actions/runs/39111938837/job/117629821867 |
| `upstream-command-windows` | `success` | https://github.com/kawaiininja/HuaAnWork-Desktop/actions/runs/39111938837/job/117629821818 |

11 cells: 11 `success`, 0 `failure`, 0 `skipped`.

## PR validation

PR #7 run `39111163930` (`pull_request`, head `a1da73705d`) also passed 10/10 checks; its `desktop-linux` matrix contained beta only. The master run above is the official ledger.

## Notes

- macOS stable/beta spent ~34–35 minutes in `Build macOS smoke artifact`; both completed `success` before the 60-minute job timeout.
- The `check` job includes the restored `timeout --kill-after=10s 120s`, `timeout-minutes: 5`, `ELECTRON_ENABLE_LOGGING`, wrapper and log artifact; it passed.
- A10 remains a user-ruled pass (environment attribution), not a CI cell.
- The docs-only follow-up push (this file + AGENTS closure) triggers a separate run; it does not change product cells. Its URL is recorded in the delivery note.
