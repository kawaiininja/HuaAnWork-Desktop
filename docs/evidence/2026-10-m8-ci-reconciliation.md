# 2026-10 M8 CI reconciliation (Task 6.3)

Worktree: `HuaAnWork-Desktop-sync`. Recorded SHA: `6708693d4dfd239eea72f1c3715a5751bf69e1d0` (`origin/master` after the later of the two master pushes). This file is the expanded-cell ledger for that run. It is not a green-run archive, and it is not committed.

The cell list is the expanded matrix of `.github/workflows/ci.yml` at that SHA, under plan §7.4. The count is not frozen at 9. `check` is one job; its four Next steps are steps of that job (`:113–127`), not extra cells. `desktop-linux` is desktop and beta only (`:186`).

## Run

| Field | Value |
|---|---|
| Event | `push` to `master` |
| Head SHA | `6708693d4dfd239eea72f1c3715a5751bf69e1d0` |
| Run | https://github.com/kawaiininja/HuaAnWork-Desktop/actions/runs/38033205707 |
| Created | `2026-10-10T07:05:22Z` |
| Status | `completed` |
| Conclusion | `failure` |
| Earlier push of `47f52aad5e` | https://github.com/kawaiininja/HuaAnWork-Desktop/actions/runs/38033065235 (also `failure`; superseded by this run) |

The run was already completed when it was read. No cell was still running.

GitHub created six jobs. The three matrix jobs were skipped before expansion, so they have one URL each. The workspace rows below are the cells the workflow would have expanded. They share that unexpanded job URL. A skipped cell is not green.

## Expanded cells

| Job | Conclusion | URL |
|---|---|---|
| `changes` | `failure` | https://github.com/kawaiininja/HuaAnWork-Desktop/actions/runs/38033205707/job/114158226563 |
| `check` (steps include `verify:window-controls`, `verify:onboarding`, `verify:protocol`, `verify:sidebar-browser`) | `skipped` | https://github.com/kawaiininja/HuaAnWork-Desktop/actions/runs/38033205707/job/114158233371 |
| `desktop-windows` / `dsh-plugin-desktop` | `skipped` | https://github.com/kawaiininja/HuaAnWork-Desktop/actions/runs/38033205707/job/114158233386 |
| `desktop-windows` / `dsh-plugin-desktop-beta` | `skipped` | https://github.com/kawaiininja/HuaAnWork-Desktop/actions/runs/38033205707/job/114158233386 |
| `desktop-windows` / `dsh-plugin-huaanwork` | `skipped` | https://github.com/kawaiininja/HuaAnWork-Desktop/actions/runs/38033205707/job/114158233386 |
| `desktop-linux` / `dsh-plugin-desktop` | `skipped` | https://github.com/kawaiininja/HuaAnWork-Desktop/actions/runs/38033205707/job/114158233291 |
| `desktop-linux` / `dsh-plugin-desktop-beta` | `skipped` | https://github.com/kawaiininja/HuaAnWork-Desktop/actions/runs/38033205707/job/114158233291 |
| `desktop-macos` / `dsh-plugin-desktop` | `skipped` | https://github.com/kawaiininja/HuaAnWork-Desktop/actions/runs/38033205707/job/114158233225 |
| `desktop-macos` / `dsh-plugin-desktop-beta` | `skipped` | https://github.com/kawaiininja/HuaAnWork-Desktop/actions/runs/38033205707/job/114158233225 |
| `desktop-macos` / `dsh-plugin-huaanwork` | `skipped` | https://github.com/kawaiininja/HuaAnWork-Desktop/actions/runs/38033205707/job/114158233225 |
| `upstream-command-windows` | `skipped` | https://github.com/kawaiininja/HuaAnWork-Desktop/actions/runs/38033205707/job/114158233261 |

11 cells: 0 `success`, 1 `failure`, 10 `skipped`.

## Why `changes` is red

The `changes` job has zero steps and no runner. Its failure annotation is:

> The job was not started because recent account payments have failed or your spending limit needs to be increased. Please check the 'Billing & plans' section in your settings

The other five jobs were skipped because `changes` failed. No product step ran, including the four Next steps inside `check`.

The same annotation is on runs that are not this branch:

| Run | When | Head |
|---|---|---|
| [37600132144](https://github.com/kawaiininja/HuaAnWork-Desktop/actions/runs/37600132144) | `2026-10-07T09:22:14Z` | docs checklist push, before M8 |
| [37714088258](https://github.com/kawaiininja/HuaAnWork-Desktop/actions/runs/37714088258) | `2026-10-08T01:40:22Z` | docs debt push, before M8 |
| [38033065235](https://github.com/kawaiininja/HuaAnWork-Desktop/actions/runs/38033065235) | `2026-10-10T07:03:03Z` | earlier M8 push `47f52aad5e` |

The last run that actually received a runner was [37585841196](https://github.com/kawaiininja/HuaAnWork-Desktop/actions/runs/37585841196) (`2026-10-07T07:11:40Z`, `success`). This red is the account billing limit. It is not a failure of the M8 tree. No guard was weakened and no job was skipped in the workflow. Nothing was pushed.
