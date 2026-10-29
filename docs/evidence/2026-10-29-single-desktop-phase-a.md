# Phase A single-desktop acceptance (Task 8)

Recorded 2026-10-30 local (UTC+8) from `/Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop`, branch `refactor/huaanwork-single-desktop-maintenance`. Host: macOS 27.0.1, arm64, Node v22.23.2, Yarn 4.18.0 through Corepack.

This document records the phase A recovery point and its gates. The code SHA below is the recovery point; the evidence commit that adds this file is its direct child and contains nothing else.

| Field | Value |
|---|---|
| Baseline (`b5ef3e84a7`, `origin/master`, also `git merge-base origin/master HEAD`) | `b5ef3e84a7951941480b50a8749fe6714b8c9fc7` — Merge pull request #20 from `kawaiininja/cursor/gitleaks-allowlist-5f6b` |
| Commits on the branch above the baseline | 10 |
| **`PHASE_A_SHA`** | **`156e71d0a267e88ab4fe80fbaf59671958992c11`** (`docs: record the single-active-desktop transition`, 2026-10-29 23:30:56 +0800) |
| Reference trees `dsh-plugin-desktop`, `dsh-plugin-desktop-beta`, `dsh-desktop-next` vs baseline | zero changed paths |
| Harness pin (`git rev-parse PHASE_A_SHA:deepseek-harness`) | `1600d8a1e140dcde43a1a0941940a0480712c011` |
| Working tree at validation | clean except untracked `.gstack/` (excluded by the task's own status filter) |

Commits above the baseline, newest first: `156e71d0a2` docs: record the single-active-desktop transition, `2b35c7475e` ci(huaanwork): narrow desktop jobs, `c3435d721b` refactor(gates): retire multi-desktop reference checks, `7194168bdd` refactor(runtime): assign market runtime checks to HuaAnWork, `e9472c0c1e` refactor(aa): prepare the connector only for HuaAnWork, `9b79f49e7f` refactor(market): refresh only the HuaAnWork desktop, `a0ffa551f8` refactor(root): make HuaAnWork the only active desktop workspace, `274c0c5a22` docs: align the maintenance plan with the baseline review commit, `cb1566f377` ci(huaanwork): correct the provisioning smoke comment, `1f9c394d66` docs: plan and review the single desktop maintenance.

## Step 1 — four serial local gates

`git diff --check` exited 0 with no output. The filtered status check (`git status --porcelain | grep -vE '^\?\? (\.gstack/|docs/superpowers/(specs|plans)/2026-10-29-single-desktop-maintenance-(design|plan)-review\.md)$'`) was empty, so the only untracked entry was `.gstack/`.

| # | Command | Exit | Key output |
|---|---|---|---|
| 1 | `corepack yarn install --immutable` | 0 | `Done with warnings in 1s 465ms`; warnings are the pre-existing `YN0002`/`YN0086` peer-dependency notices, no resolution change |
| 2 | `corepack yarn check` | 0 | full chain green, details below |
| 3 | `corepack yarn typecheck` | 0 | only `contract-types: 4 generated type files are current` (tsc projects print nothing on success) |
| 4 | `corepack yarn test` | 0 | all workspaces green, details below |

The four gates ran one at a time. No other gate ran concurrently, including across the `verify:aa` boundaries.

### Gate 2 — `corepack yarn check`

`check:whitespace` resolved its base with `git merge-base origin/master HEAD` (no `BASE_SHA` in the environment) and ran `git diff --check b5ef3e84a7951941480b50a8749fe6714b8c9fc7 HEAD`; success is silent.

| Step | Result |
|---|---|
| `test:market-release` | 6 tests, 6 pass, 0 fail |
| `test:aa-release` | 14 tests, 14 pass, 0 fail |
| `check:bilingual-docs` | 4 tests, 4 pass, 0 fail; `verify-bilingual-docs: 55 records and 110 documents are consistent` |
| `check:architecture` | 10 tests, 10 pass, 0 fail; `verify-market-dependency-direction: 441 tracked source files ... 8 market wrapper files carry no registry bypass` |
| `check:vendored-runtime` | `sync-vendored-runtime: huaanwork 341 packages from 1600d8a1e1 are verified` |
| `verify-layout.mjs` | `verify-layout: HuaAnWork and retained workspaces are consistent with upstream 1600d8a1e1` |
| `test:gate-scripts` | 1 test, 1 pass, 0 fail |
| `check:readme-versions` | 3 tests, 3 pass, 0 fail; `4 hardcoded artifact version string(s) in 1 scoped package(s) (dsh-plugin-huaanwork) match their own package.json` |
| `test:aa-connector` | 4 tests, 4 pass, 0 fail |

Workspace checks in chain order:

| Workspace | Result |
|---|---|
| `dsh-community-fabric` | `verify-fabric-docs: 20 Markdown files and 10 bilingual pairs are consistent` |
| `dsh-community-market` | `verify-market-docs: 12 Markdown files, 6 bilingual pairs, and 4 schemas are consistent`; `contract-types: 4 generated type files written`; `verify-market-client-loader: dsh-community-market registered one client module`; **13 files, 303 tests, 0 fail** |
| `dsh-plugin-huaanwork` | build (`tsdown` + client/native-ui Vite + declarations) then **267 files passed, 4 skipped (271); 3545 tests passed, 14 skipped (3559)**. `verify:closure` 4 tests + `verify-runtime-closure: 316 first-party nodes`; `verify:bundled` 11 tests + `verify-bundled-runtime: 131 files checked; 9 bundled packages are inlined`; `verify:cli` and `verify:loader` silent success; `verify:profile` `minimal preset, plugin manager, and disabled hmr lock passed`; `verify:host` 35 tests, 0 fail; `verify:aa` the same minimal-preset line; `verify-licenses: 636 packages checked (9 bundled)`; `verify-operation-reliability: 7 operations and 18 fault contracts verified` |
| `market-server` | **14 files, 244 tests, 0 fail** |
| `update-server` | **5 files, 88 tests, 0 fail** |
| `@huaanwork/catalog-signing` | 13 tests, 13 pass, 0 fail |
| `@huaanwork/agent-package-format` | 35 tests, 35 pass, 0 fail |
| `agent-catalog-server` | **5 files, 80 tests, 0 fail** |
| `agent-catalog-admin` | 15 tests, 15 pass, 0 fail |

`verify:profile` and `verify:aa` still log `warning: 2 entries did not activate` for `web-fetch-http` (waiting for `web`) and `job-controller` (waiting for `jobs`); the guardrail lock disables those rows and the command exits 0.

The reference-tree package checks (`check:desktop-variants`) no longer exist in `check:layout`; Task 3 retired them with the reference-tree tools. `verify:aa` ran inside `dsh-plugin-huaanwork check` on this machine (it is the workspace script's own step); the CI `check` job strips it, see Step 4.

### Gate 4 — `corepack yarn test`

| Workspace | Result |
|---|---|
| `dsh-plugin-huaanwork` | 267 files passed, 4 skipped (271); 3545 tests passed, 14 skipped (3559) |
| `dsh-community-market` | 13 files, 303 tests, 0 fail |
| `@huaanwork/policy` | 64 tests, 62 pass, 2 skipped, 0 fail |
| `@huaanwork/model` | 10 tests, 10 pass, 0 fail |
| `@huaanwork/git-tools` | 8 tests, 8 pass, 0 fail |
| `@huaanwork/web-tools` | 19 tests, 19 pass, 0 fail |
| `market-server` | 14 files, 244 tests, 0 fail |
| `update-server` | 5 files, 88 tests, 0 fail |
| `@huaanwork/catalog-signing` | 13 tests, 13 pass, 0 fail |
| `@huaanwork/agent-package-format` | 35 tests, 35 pass, 0 fail |
| `agent-catalog-server` | 5 files, 80 tests, 0 fail |
| `agent-catalog-admin` | 15 tests, 15 pass, 0 fail |

## Step 2 — provisioning guard, then the local unsigned smoke

### Provisioning guard — exit 0, no exemption

```bash
node dsh-plugin-huaanwork/scripts/huaanwork-verify-provisioning.mjs --smoke
```

Exit **0**. `release provisioning 就绪:三项均已钉入真实值` — the market origin, the update origin, and `PINS_AT_RELEASE.current` (public key + its sha256 fingerprint) are all pinned; the script reports `keyId == sha256(公钥原始字节):一致` and no missing item. `HUAANWORK_ALLOW_UNPROVISIONED_SMOKE` was **not** set for the local smoke, and no provisioning exemption applies to this record. A passing static guard does not prove deployment delivery or origin reachability; neither is claimed here.

### Root smoke wrapper — exit 1 at `market:prepare` (external, known red)

```bash
corepack yarn dist:mac-smoke:huaanwork
```

Exit **1** before any packaging. The wrapper's first step is `yarn market:prepare`, which refreshes `dshmarket` to npm `latest` and then applies `.yarn/patches/dshmarket-desktop.patch`:

```text
➤ YN0085: │ + dshmarket@patch:dshmarket@npm%3A1.73.3#./.yarn/patches/dshmarket-desktop.patch ...
➤ YN0085: │ - dshmarket@npm:1.70.2, and 1 more.
➤ YN0066: │ dshmarket@patch:...: Cannot apply hunk #6 (set enableInlineHunks for details)
➤ YN0000: · Failed with errors in 5s 830ms
Error: Market preparation failed; manifests and lockfile restored. Rerun yarn install before continuing.
```

This is the known external market red: npm `latest` is `1.73.3` while the checkout pins `1.70.2`, and the committed Desktop patch does not apply to `1.73.3`, so `prepare-dsh-market.mjs` fails closed by design rather than shipping a market without its Desktop safeguards. The same class of failure is recorded in `docs/superpowers/specs/2026-10-17-m9-upstream-sync-epic-review.md` (§口径③: the patch hunk does not apply to the then-latest; CI runs workspace-level dist without `market:prepare`, so the failure bites only the local root packaging chain). Nothing was masked: `market:check` was not run, and `market:prepare` was not retried or bypassed. The script restored `package.json`, the workspace manifest, and `yarn.lock`; `git status --porcelain` after the failure listed only `?? .gstack/`, and the later workspace smoke was built from that restored, pinned `1.70.2` state.

Because the root wrapper cannot get past its market refresh on this machine, the smoke was produced with the workspace-level packaging entry point — the exact command the CI macOS job runs (`.github/workflows/ci.yml:211` for the package gate and `:223` for the smoke):

```bash
corepack yarn workspace dsh-plugin-huaanwork dist:mac-smoke
```

Exit **0**. This path does not run `market:prepare` or `aa:prepare-release`; it packages the committed pinned `dshmarket 1.70.2` and the committed Agents Anywhere artifacts, the same inputs CI packages. Its internal `check:mac-package` gate ran first (7 files, 180 tests passed, 1 skipped) and `check:mac-package`'s typecheck passed.

### Smoke nature

- **Unsigned** universal DMG: the run's first line is `Building an unsigned macOS DMG smoke; signing and notarization are release-only steps.`
- Both CPU slices were packaged (`arch=x64`, `arch=arm64`) and merged (`arch=universal`); artifact `dsh-plugin-huaanwork/dist/mac-smoke/HuaAnWork-0.1.0-universal.dmg` (≈494 MB) plus its blockmap.
- Final line: `macOS DMG smoke verification passed: .../HuaAnWork-0.1.0-universal.dmg`.
- No code signing, no notarization, no Gatekeeper assessment is claimed. This is a local unsigned smoke, not a release artifact.

## Step 3 — pre-push checks and the branch push

```bash
test -z "$(git status --porcelain | grep -vE '^\?\? (\.gstack/|docs/superpowers/(specs|plans)/2026-10-29-single-desktop-maintenance-(design|plan)-review\.md)$' || true)"   # PASS
test -z "$(git diff --name-only b5ef3e84a7 -- dsh-plugin-desktop dsh-plugin-desktop-beta dsh-desktop-next)"   # PASS, zero paths
test "$(git rev-parse 156e71d0a2:deepseek-harness)" = '1600d8a1e140dcde43a1a0941940a0480712c011'              # PASS
git push -u origin refactor/huaanwork-single-desktop-maintenance
```

The smoke and both prepare-style steps left no tracked change: the only untracked entry was `.gstack/`. The reference trees have zero changed paths against the baseline, and the Harness gitlink is still the rc.1 pin.

The first `git push` attempt failed with `Failed to connect to github.com port 443 after 75019 ms` (transient connectivity); `https://github.com` answered 200 immediately afterwards and the immediate retry succeeded. Push result: new remote branch `refactor/huaanwork-single-desktop-maintenance`, tracking set, `git ls-remote --heads origin` returned `156e71d0a267e88ab4fe80fbaf59671958992c11`. Nothing was pushed to `master`.

## Step 4 — branch CI for the exact SHA

```bash
gh workflow run ci.yml --ref refactor/huaanwork-single-desktop-maintenance --repo kawaiininja/HuaAnWork-Desktop
```

The dispatch returned run `40908689112`; the registration loop matched it on the first attempt because its `headSha` already equalled `PHASE_A_SHA`. `gh run watch --exit-status` exited 0.

| Field | Value |
|---|---|
| Run ID | `40908689112` |
| URL | https://github.com/kawaiininja/HuaAnWork-Desktop/actions/runs/40908689112 |
| Event / branch | `workflow_dispatch` / `refactor/huaanwork-single-desktop-maintenance` |
| `headSha` | `156e71d0a267e88ab4fe80fbaf59671958992c11` (= `PHASE_A_SHA`) |
| Created / updated | `2026-10-29T16:08:59Z` / `2026-10-29T16:30:26Z` |
| Status / conclusion | `completed` / **`success`** |

| Job | Conclusion | URL |
|---|---|---|
| `changes` | success | https://github.com/kawaiininja/HuaAnWork-Desktop/actions/runs/40908689112/job/123570403056 |
| `gitleaks` | success | https://github.com/kawaiininja/HuaAnWork-Desktop/actions/runs/40908689112/job/123570403399 |
| `desktop-windows (dsh-plugin-huaanwork)` | success | https://github.com/kawaiininja/HuaAnWork-Desktop/actions/runs/40908689112/job/123570654045 |
| `upstream-command-windows` | success | https://github.com/kawaiininja/HuaAnWork-Desktop/actions/runs/40908689112/job/123570654108 |
| `desktop-macos (dsh-plugin-huaanwork)` | success | https://github.com/kawaiininja/HuaAnWork-Desktop/actions/runs/40908689112/job/123570654263 |
| `check` | success | https://github.com/kawaiininja/HuaAnWork-Desktop/actions/runs/40908689112/job/123570654341 |

What each job actually ran:

- `check`: `yarn install --immutable`, the workflow's `Temporarily skip AA profile smoke in CI` step (`.github/workflows/ci.yml:94`), then `yarn check`. CI therefore covers the same chain as the local gate **minus `verify:aa`**, which the workflow strips by design; the local run above included it and passed.
- `desktop-windows`: `check:win-package:platform`, `Real Host liveness on Windows` (`.github/workflows/ci.yml:156`), `Build Windows installer` (`:160`), `Build Windows portable archive` (`:166`). Liveness ran at the real 15 s and 60 s thresholds: `B16_WIN_TIMING {"bootMs":6774,"suspectMs":16017,"stoppableMs":60099,"stopToExitMs":16,"hostGoneMs":0,"grandchildAlive":false}`; `Windows installer verification passed: ...\dist\HuaAnWork-0.1.0-x64-Setup.exe`; `Windows portable verification passed: ...\dist\HuaAnWork-0.1.0-x64-Portable.zip`. This is single-runner packaging and liveness evidence, **not** second-machine acceptance and **not** a signed Windows release.
- `desktop-macos`: `check:mac-package:platform` then `Build macOS smoke artifact` (`:223`) with the workflow's `HUAANWORK_ALLOW_UNPROVISIONED_SMOKE=1` (`:218`) and `DSH_MAC_SMOKE_ARCH=universal` for a `workflow_dispatch` (`:222`). The guard exemption is unconditional in the workflow but only matters for a checkout that still carries placeholder provisioning; this checkout's guard exits 0, so nothing was exempted. The job logged `Building an unsigned macOS DMG smoke; signing and notarization are release-only steps.`, packaged `arch=universal`, and ended with `macOS DMG smoke verification passed: .../HuaAnWork-0.1.0-universal.dmg`. No signing or notarization.
- `gitleaks`: current-tree scan with `.gitleaks.toml` (gitleaks 8.30.1), passed.
- `changes` / `upstream-command-windows`: the classifier (product=true for `workflow_dispatch`) and the pinned submodule's Yarn/pnpm resolution on Windows, both passed.

Because the run was a `workflow_dispatch`, the `product` output is `true` unconditionally, so no job was skipped by the documentation-only path (the `Documentation-only gate` step shows `skipped`).

## Step 5 — this evidence commit

```bash
git add docs/evidence/2026-10-29-single-desktop-phase-a.md
git commit -m "docs: record phase A single-desktop acceptance"
test -z "$(git diff --name-only "$PHASE_A_SHA"..HEAD -- . ':!docs/evidence/2026-10-29-single-desktop-phase-a.md')"
git push origin refactor/huaanwork-single-desktop-maintenance
```

The parent of the evidence commit is `156e71d0a267e88ab4fe80fbaf59671958992c11`, and the diff against `PHASE_A_SHA` contains this file only. No code, test, workflow, or other document changed after the recovery point.

## What this record does not claim

- No push to `master`, no merge, no pull request merge, no release, no tag.
- No signed or notarized macOS artifact, no Gatekeeper result, no deployment delivery, no intranet origin reachability.
- No second-machine Windows acceptance; the Windows evidence is a single GitHub-hosted runner's package and liveness run.
- No `dshmarket` freshness: `market:check` is red for the external `1.73.3` vs `1.70.2` reason and was not run, and the root smoke wrapper cannot get past `market:prepare` on this machine (see Step 2). The smoke above uses the committed pinned `1.70.2` market, which is what CI also packages.
