# Phase B single-desktop acceptance (Task 15)

Recorded 2026-10-30 local (UTC+8) from `/Users/amonmiao/Downloads/cursor/智能办公平台/HuaAnWork-Desktop`, branch `refactor/huaanwork-single-desktop-maintenance`. Host: macOS 27.0.1, arm64, Node v22.23.2, Yarn 4.18.0 through Corepack.

This is the phase-B closure record: it fixes the final code SHA, repeats the four local gates, repeats provisioning and the unsigned macOS smoke, runs the six structural acceptances, and records the branch CI run for the exact SHA. The evidence commit that adds this file is the direct child of the code SHA and contains nothing else; nothing was pushed to `master`, nothing was merged, and nothing was released.

| Field | Value |
|---|---|
| Baseline (`b5ef3e84a7`, `origin/master`, also `git merge-base origin/master HEAD`) | `b5ef3e84a7951941480b50a8749fe6714b8c9fc7` |
| Commits on the branch above the baseline / above phase A | 17 / 7 |
| **`PHASE_A_SHA`** (recovery point, Task 8) | **`156e71d0a267e88ab4fe80fbaf59671958992c11`** (`docs: record the single-active-desktop transition`, 2026-10-29 23:30:56 +08) |
| Phase A CI run | run `40908689112`, `conclusion=success`, 6/6 jobs — https://github.com/kawaiininja/HuaAnWork-Desktop/actions/runs/40908689112 ; record: `docs/evidence/2026-10-29-single-desktop-phase-a.md` |
| **`PHASE_B_SHA`** | **`cbd392fbc7f25eadc4c21be6adae905ca8973e28`** (`refactor: remove inactive desktop source trees`, 2026-10-30 09:26:02 +08) |
| Harness pin (`git rev-parse PHASE_B_SHA:deepseek-harness`) | `1600d8a1e140dcde43a1a0941940a0480712c011` (`dsh-v0.2.1-rc.1`) |
| Working tree at validation | clean except untracked `.gstack/` (excluded by the task's own status filter) |

Commits above phase A, newest first: `cbd392fbc7` refactor: remove inactive desktop source trees, `f2ef9026ce` docs: disposition the initial selective upstream shelf, `fe5fc0a73d` feat(upstream): report the selective review backlog, `96dc22189c` chore(runtime): remove unused vendored runtime lanes, `881681b4fd` refactor(runtime): make market peer history an explicit policy, `0f17522c82` docs: rule on market peer history and runtime consumers, `8fc54c4d80` docs: record phase A single-desktop acceptance.

Reference documents this record relies on:

- Peer ruling (Task 9): `docs/evidence/2026-10-29-single-desktop-runtime-consumers.md` — `stableHistorical: "retain"` / `dormantAlpha1: "retire"`, final market peer range `0.2.0-rc.2 || 0.2.1-rc.1`.
- First selective upstream shelf (Task 13): `docs/evidence/2026-10-29-single-desktop-upstream-shelf.md` — 56 commits / 2622 direct-file rows, `PORT` = 0.
- Rules triage (Task 7): `docs/evidence/2026-10-29-single-desktop-rules-triage.md`.

## Step 1 — final code SHA and the four serial local gates

`git diff --check` exited 0 with no output. The filtered status check (`git status --porcelain | grep -vE '^\?\? (\.gstack/|docs/superpowers/(specs|plans)/2026-10-29-single-desktop-maintenance-(design|plan)-review\.md)$'`) was empty; the only untracked entry was `.gstack/`, and both review docs are tracked, so the exemption never covered a real entry.

| # | Command | Exit | Key output |
|---|---|---|---|
| 1 | `corepack yarn install --immutable` | 0 | `Done with warnings in 1s 421ms`; warnings are the pre-existing `YN0002`/`YN0086` peer-dependency notices, no resolution change |
| 2 | `corepack yarn check` | 0 | full chain green, details below |
| 3 | `corepack yarn typecheck` | 0 | only `contract-types: 4 generated type files are current` (tsc projects print nothing on success) |
| 4 | `corepack yarn test` | 0 | all twelve workspaces green, details below |

The four gates ran one at a time, in the brief's order. No other gate ran concurrently, including across the `verify:aa` boundaries, so the known `verify:aa` concurrency race was not exercised and no rerun was needed.

### Gate 2 — `corepack yarn check`

Root steps, in chain order:

| Step | Result |
|---|---|
| `check:whitespace` | silent success (`BASE_SHA` unset, base resolved from `git merge-base origin/master HEAD`) |
| `check:layout` | 341 vendored packages verified, layout consistent (see sub-rows below) |
| `test:aa-connector` | 4 tests, 4 pass, 0 fail |
| `dsh-community-fabric check` | `verify-fabric-docs: 20 Markdown files and 10 bilingual pairs are consistent` |
| `dsh-community-market check` | `verify-market-docs: 12 Markdown files, 6 bilingual pairs, and 4 schemas are consistent`; `contract-types: 4 generated type files written`; `verify-market-client-loader: dsh-community-market registered one client module`; **13 files, 303 tests, 0 fail** |
| `dsh-plugin-huaanwork check` | build (`tsdown` + client/native-ui Vite + declarations) then **267 files passed, 4 skipped (271); 3547 tests passed, 14 skipped (3561)**; `verify:closure` 4 tests + `verify-runtime-closure: 316 first-party nodes`; `verify:bundled` 11 tests + `verify-bundled-runtime: 131 files checked; 9 bundled packages are inlined`; `verify:cli` and `verify:loader` silent success; `verify:profile` `minimal preset, plugin manager, and disabled hmr lock passed`; `verify:host` 35 tests, 0 fail; `verify:aa` the same minimal-preset line; `verify-licenses: 636 packages checked (9 bundled)`; `verify-operation-reliability: 7 operations and 18 fault contracts verified` |
| `market-server check` | **14 files, 244 tests, 0 fail** |
| `update-server check` | **5 files, 88 tests, 0 fail** |
| `@huaanwork/catalog-signing check` | 13 tests, 13 pass, 0 fail |
| `@huaanwork/agent-package-format check` | 35 tests, 35 pass, 0 fail |
| `agent-catalog-server check` | **5 files, 80 tests, 0 fail** |
| `agent-catalog-admin check` | 15 tests, 15 pass, 0 fail |

Inside `check:layout`: `test:market-release` 6/6, `test:aa-release` 14/14, `check:bilingual-docs` 4/4 with `verify-bilingual-docs: 50 records and 100 documents are consistent`, `check:architecture` 11/11 with `verify-market-dependency-direction: 441 tracked source files … 8 market wrapper files carry no registry bypass`, `check:vendored-runtime` `sync-vendored-runtime: huaanwork 341 packages from 1600d8a1e1 are verified`, `verify-layout: HuaAnWork and retained workspaces are consistent with upstream 1600d8a1e1`, `test:gate-scripts` 1/1, `check:readme-versions` 3/3 with `4 hardcoded artifact version string(s) in 1 scoped package(s) (dsh-plugin-huaanwork) match their own package.json`.

`verify:profile` and `verify:aa` still log `warning: 2 entries did not activate` for `web-fetch-http` (waiting for `web`) and `job-controller` (waiting for `jobs`); the guardrail lock disables those rows and both commands exit 0. This is the only warning left in the chain and it predates the single-desktop work.

### Gate 4 — `corepack yarn test`

| Workspace | Result |
|---|---|
| `dsh-plugin-huaanwork` | 267 files passed, 4 skipped (271); 3547 tests passed, 14 skipped (3561) |
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

## Step 2 — provisioning guard and the unsigned macOS smoke

### Provisioning guard — exit 0, no exemption

```bash
node dsh-plugin-huaanwork/scripts/huaanwork-verify-provisioning.mjs --smoke
```

Exit **0**. Output: `release provisioning 就绪:三项均已钉入真实值`, with `HUAANWORK_MARKET_DEFAULT_ORIGIN = http://market.intranet.lan:8787` (sha256 `80c6da2f…`), `HUAANWORK_UPDATE_DEFAULT_ORIGIN = http://update.intranet.lan:8790` (sha256 `e816cd5e…`), `PINS_AT_RELEASE.current.publicKeyHex = 5d162fd0…`, `keyId = f34f6afe…`, and `keyId == sha256(公钥原始字节):一致`. No missing item was reported, so `HUAANWORK_ALLOW_UNPROVISIONED_SMOKE` was **not** set and no provisioning exemption applies to this record. A passing static guard proves the pinned values, not deployment delivery or origin reachability; neither is claimed here.

Scope note (honest): the guard is wired only into the root packaging entrypoints (`dist:mac-smoke:huaanwork` et al.) and into `.github/workflows/release.yml:88-89/:157-158`. The workspace-level `dsh-plugin-huaanwork dist:mac-smoke` and the CI `check` job do **not** invoke it — its log contains no provisioning line, and `dsh-plugin-huaanwork/scripts/package-mac.ts` has no provisioning reference. So provisioning evidence for this record is this explicit run alone.

### Root smoke wrapper — exit 1 at `market:prepare` (external, known red, R8)

```bash
corepack yarn dist:mac-smoke:huaanwork
```

Exit **1** before any packaging. The wrapper's first step is `yarn market:prepare`, which refreshes `dshmarket` to npm `latest` and then applies `.yarn/patches/dshmarket-desktop.patch`:

```text
➤ YN0085: │ + dshmarket@patch:dshmarket@npm%3A1.73.5#./.yarn/patches/dshmarket-desktop.patch ...
➤ YN0085: │ - dshmarket@npm:1.70.2, and 1 more.
➤ YN0066: │ ...: Cannot apply hunk #6 (set enableInlineHunks for details)
➤ YN0000: · Failed with errors in 2s 162ms
Error: Market preparation failed; manifests and lockfile restored. Rerun yarn install before continuing.
```

This is the external market drift (R6), one minor version further along: npm `latest` is now `1.73.5` (phase A observed `1.73.3`) while the checkout pins `1.70.2`, and the committed Desktop patch does not apply to `1.73.5`, so `prepare-dsh-market.mjs` fails closed instead of shipping a market without its Desktop safeguards. The workspace-level substitute used in the next subsection is accepted under ruling R8. Nothing was masked: `market:check` was not run, `market:prepare` was not retried or bypassed, and the script restored `package.json`, the workspace manifest and `yarn.lock` (`git status --porcelain` afterwards listed only `?? .gstack/`). The smoke below was built from that restored, pinned `1.70.2` state.

### Substituted workspace smoke — exit 0, same entry point CI uses

Because the root wrapper cannot get past its market refresh on this machine, the smoke was produced with the workspace-level command CI runs (`.github/workflows/ci.yml:211` for `check:mac-package:platform`, `:223` for `dist:mac-smoke`, whose `Build macOS smoke artifact` step begins at `:212`), including the same non-secret environment CI sets there:

```bash
corepack yarn workspace dsh-plugin-huaanwork check:mac-package:platform     # exit 0, 7 files / 182 tests passed, 1 skipped
DSH_PACKAGE_CHECK_ALREADY_RAN=1 DSH_MAC_SMOKE_ARCH=universal \
  corepack yarn workspace dsh-plugin-huaanwork dist:mac-smoke                # exit 0
```

`DSH_PACKAGE_CHECK_ALREADY_RAN=1` mirrors CI (which has just run the package gate, exactly as above) and skips the duplicate in-run check; `DSH_MAC_SMOKE_ARCH=universal` mirrors CI's `workflow_dispatch` value. This path does not run `market:prepare` or `aa:prepare-release`, and it does not run the provisioning guard (see the scope note above); it packages the committed pinned `dshmarket 1.70.2` and the committed Agents Anywhere artifacts — the same inputs CI packages.

### Smoke nature

- **Unsigned** universal DMG: the run's first line is `Building an unsigned macOS DMG smoke; signing and notarization are release-only steps.`
- Both slices packaged and merged: `platform=darwin arch=x64` → `arch=arm64` → `arch=universal` (Electron 44.0.0), then `building target=DMG arch=universal`.
- Artifact `dsh-plugin-huaanwork/dist/mac-smoke/HuaAnWork-0.1.0-universal.dmg` (494 MB) plus its `.blockmap`, `latest-mac.yml` and `builder-debug.yml`, all written by this run.
- Final line: `macOS DMG smoke verification passed: …/HuaAnWork-0.1.0-universal.dmg`.
- No code signing, no notarization, no Gatekeeper assessment, no provisioning exemption is claimed. This is a local unsigned smoke, not a release artifact.

### Post-smoke assertions

```bash
test -z "$(git status --porcelain | grep -vE '^\?\? (\.gstack/|docs/superpowers/(specs|plans)/2026-10-29-single-desktop-maintenance-(design|plan)-review\.md)$' || true)"   # PASS
test "$(git rev-parse "$PHASE_B_SHA":deepseek-harness)" = '1600d8a1e140dcde43a1a0941940a0480712c011'                                                # PASS
```

The build left no tracked change (`dist/` is ignored by `dsh-plugin-huaanwork/.gitignore`), so no SHA re-validation from Step 1 was required.

## Step 3 — six structural acceptances

| # | Check | Result |
|---|---|---|
| 1 | `test ! -e dsh-plugin-desktop` | PASS (exit 0) |
| 2 | `test ! -e dsh-plugin-desktop-beta` | PASS (exit 0) |
| 3 | `test ! -e dsh-desktop-next` | PASS (exit 0) |
| 4 | node structural script (workspaces, root scripts, `upstream.json`, market peers, `vendor/dsh-runtime`, dashboard reproducibility, `product-identity.ts`) | PASS (exit 0) — `structure verified; upstream 092e2ecef750d10db43cedbab8e81fd48c8de38e; pending=0` |
| 5 | `corepack yarn check:vendored-runtime` | PASS (exit 0) — `sync-vendored-runtime: huaanwork 341 packages from 1600d8a1e1 are verified` |
| 6 | `corepack yarn aa:check` | PASS (exit 0) — `Selected AA main at 64c3f67ee3b270c1740da4da9dfae56d6217c8e4`; `AA release verified: HuaAnWork uses 64c3f67ee3b270c1740da4da9dfae56d6217c8e4` |

What check 4 asserted, and what it proves:

- root `workspaces` contains none of `dsh-plugin-desktop`, `dsh-plugin-desktop-beta`, `dsh-desktop-next`;
- no root script value mentions `dsh-plugin-desktop` or `dsh-desktop-next` (historical identity strings elsewhere do not participate — the assertion reads `Object.values(root.scripts)` only, so `DESKTOP_RELEASE_IDENTITIES` and npm-contract prose cannot produce a false positive);
- `upstream.json` has exactly one channel (`huaanwork`) and `marketPeerPolicy` is exactly `{stableHistorical: 'retain', dormantAlpha1: 'retire'}` (the Task 9 ruling);
- every `@deepseek-ai/dsh*` peer of `dsh-community-market` is exactly `0.2.0-rc.2 || 0.2.1-rc.1`;
- `vendor/dsh-runtime` contains only `0.2.1-rc.1`;
- `collectUpstreamReview` reports `ok: true`, and its `pendingCount` equals `git rev-list --count reviewedCommit..upstreamSha` (both 0 at `092e2ece…`), i.e. the dashboard's count is reproducible from local refs and nothing is silently filtered;
- `dsh-plugin-huaanwork/src/product-identity.ts` (the identity source of truth) still exists.

`aa:check` passing means the AA artifact still matches upstream `main` at `64c3f67ee3b2`; the expected drift did not occur, so no re-prepare, pin or bypass was considered.

## Ignored residue inventory (Task 14) and physical cleanup

Recorded before deletion with `git status --porcelain --ignored -- dsh-plugin-desktop dsh-plugin-desktop-beta dsh-desktop-next` — 6 entries, all ignored build output:

| Tree | Total size | `lib/` size | `lib/` files | `.DS_Store` | tracked files |
|---|---:|---:|---:|---:|---:|
| `dsh-plugin-desktop` | 16 MB | 7.0 MB | 367 | 8,196 B | 448 |
| `dsh-plugin-desktop-beta` | 16 MB | 7.0 MB | 367 | 6,148 B | 448 |
| `dsh-desktop-next` | 9.2 MB | 2.3 MB | 45 | 6,148 B | 252 |
| **total** | **≈41.2 MB** | **16.3 MB** | **779** | 3 | **1,148** |

`lib/` content is tsdown/Vite build output (`*.js`, `*.js.map`, `preload*.cjs`, `native-ui/`, `types/`), regenerable and never tracked; no `node_modules/` existed under any of the three trees.

Physical cleanup result: all 1,148 tracked files plus the 6 registered ignored entries are gone. `git rm` removed 1,156 paths in total (448 + 448 + 252 tree files, 8 retired root scripts), and `rm -rf` removed the directories including their `lib/` and `.DS_Store` residue. The three `test ! -e` checks above are the post-cleanup assertion; `git status --porcelain --ignored -- dsh-plugin-desktop dsh-plugin-desktop-beta dsh-desktop-next` now returns 0 lines because the paths no longer exist. One deviation is recorded honestly by Task 14: `dsh-plugin-desktop-beta/lib/` was ignored by beta's own tracked `.gitignore` rather than by the root file, so those 367 files surfaced as untracked after `git rm` and the registered residue was removed first, then the brief's assertions passed and `rm -rf` ran.

## Step 4 — branch push and CI for the exact SHA

```bash
git push origin refactor/huaanwork-single-desktop-maintenance    # 8fc54c4d80..cbd392fbc7
gh workflow run ci.yml --ref refactor/huaanwork-single-desktop-maintenance --repo kawaiininja/HuaAnWork-Desktop
```

The dispatch returned run `40988746000` directly, and the registration loop matched it on the first attempt because `headSha` already equalled `PHASE_B_SHA`. `gh run watch --exit-status` exited 0.

| Field | Value |
|---|---|
| Run ID | `40988746000` |
| URL | https://github.com/kawaiininja/HuaAnWork-Desktop/actions/runs/40988746000 |
| Event / branch | `workflow_dispatch` / `refactor/huaanwork-single-desktop-maintenance` |
| `headSha` | `cbd392fbc7f25eadc4c21be6adae905ca8973e28` (= `PHASE_B_SHA`) |
| Created / updated | `2026-10-30T01:56:16Z` / `2026-10-30T02:13:48Z` |
| Status / conclusion | `completed` / **`success`** |

| Job | Conclusion | URL |
|---|---|---|
| `changes` | success | https://github.com/kawaiininja/HuaAnWork-Desktop/actions/runs/40988746000/job/123845786372 |
| `gitleaks` | success | https://github.com/kawaiininja/HuaAnWork-Desktop/actions/runs/40988746000/job/123845786531 |
| `desktop-macos (dsh-plugin-huaanwork)` | success | https://github.com/kawaiininja/HuaAnWork-Desktop/actions/runs/40988746000/job/123845928872 |
| `check` | success | https://github.com/kawaiininja/HuaAnWork-Desktop/actions/runs/40988746000/job/123845928876 |
| `desktop-windows (dsh-plugin-huaanwork)` | success | https://github.com/kawaiininja/HuaAnWork-Desktop/actions/runs/40988746000/job/123845928878 |
| `upstream-command-windows` | success | https://github.com/kawaiininja/HuaAnWork-Desktop/actions/runs/40988746000/job/123845928902 |

Six jobs, all success; there is no `desktop-linux` job and no second desktop tree in the matrix, which is the Task 6 narrowing holding in CI.

What each job actually ran:

- `changes`: `Classify changed paths` → `product=true` (a `workflow_dispatch` is always a product change), so no job was skipped by the documentation-only path.
- `check`: `yarn install --immutable`, the workflow's `Temporarily skip AA profile smoke in CI` step (`.github/workflows/ci.yml:94`), then `yarn check`. CI therefore covers the same chain as the local gate **minus `verify:aa`**, which the workflow strips by design; the local run included it and passed. Observed there: `verify-bilingual-docs: 50 records and 100 documents are consistent`, `sync-vendored-runtime: huaanwork 341 packages from 1600d8a1e1 are verified`, `verify-layout: … consistent with upstream 1600d8a1e1`, `verify-readme-versions: 4 hardcoded artifact version string(s) … match their own package.json`, `verify-profile-boot: minimal preset, plugin manager, and disabled hmr lock passed`, `verify-licenses: 635 packages checked (9 bundled)`.
- `desktop-windows`: `check:win-package:platform`, `Real Host liveness on Windows` (`.github/workflows/ci.yml:156`), `Build Windows installer` (`:160`), `Build Windows portable archive` (`:166`). Liveness ran at the real thresholds: `B16_WIN_TIMING {"bootMs":6669,"suspectMs":16060,"stoppableMs":60202,"stopToExitMs":18,"hostGoneMs":0,"grandchildAlive":false,"hostPid":9196,"grandchildPid":880,"exitCode":null}`; `Windows installer verification passed: …\dist\HuaAnWork-0.1.0-x64-Setup.exe`; `Windows portable verification passed: …\dist\HuaAnWork-0.1.0-x64-Portable.zip`. Single-runner packaging and liveness evidence — **not** second-machine acceptance, **not** a signed Windows release.
- `desktop-macos`: `check:mac-package:platform` then `Build macOS smoke artifact` (`:223`) with the workflow's unconditional `HUAANWORK_ALLOW_UNPROVISIONED_SMOKE=1` (`:218`) and `DSH_MAC_SMOKE_ARCH=universal` for a `workflow_dispatch` (`:222`). The job logged `Building an unsigned macOS DMG smoke; signing and notarization are release-only steps.`, packaged `arch=universal`, and ended with `macOS DMG smoke verification passed: …/HuaAnWork-0.1.0-universal.dmg`. No signing, no notarization. Given the Step 2 scope note, this job does not execute the provisioning guard, so no exemption was actually consumed; the checkout's guard exits 0 anyway (Step 2).
- `gitleaks`: current-tree scan with `.gitleaks.toml`, passed (one annotation: the runner's `ubuntu-latest` → Ubuntu 26 migration notice).
- `upstream-command-windows`: the pinned submodule's Yarn/pnpm resolution on Windows (`yarn upstream:version`), passed.

Runner-vs-local test deltas, recorded so nobody reads them as regressions: `dsh-plugin-huaanwork` reported 3546 passed / 15 skipped on the Linux `check` runner against 3547 / 14 locally, and `update-server` 84 passed / 4 skipped against 88 / 0 locally; the deltas are platform-conditional skips (Windows/macOS-only suites and environment-gated cases), and both totals are 3561 and 88 respectively.

## Step 5 — this evidence commit

```bash
git add docs/evidence/2026-10-29-single-desktop-phase-b.md
git commit -m "docs: record phase B single-desktop acceptance"
test -z "$(git diff --name-only "$PHASE_B_SHA"..HEAD -- . ':!docs/evidence/2026-10-29-single-desktop-phase-b.md')"
git push origin refactor/huaanwork-single-desktop-maintenance
```

The parent of the evidence commit is `cbd392fbc7f25eadc4c21be6adae905ca8973e28`, and the diff against `PHASE_B_SHA` contains this file only. No code, test, workflow, or other document changed after the recovery point.

## What this record does not claim

- No push to `master`, no merge, no pull request, no release, no tag. The only ref pushed is `refactor/huaanwork-single-desktop-maintenance`.
- No signed or notarized macOS artifact, no Gatekeeper result, no deployment delivery, no intranet origin reachability.
- No second-machine Windows acceptance: the Windows evidence is one GitHub-hosted runner's package and liveness run. That runner **did** execute `verify-win-installer.ts` against the artifacts it built — `dist\HuaAnWork-0.1.0-x64-Setup.exe` and `dist\win-unpacked\HuaAnWork.exe`, which is where the `Windows installer verification passed: …` line quoted in Step 4 comes from — because `dist:win` invokes the verifier (`dsh-plugin-huaanwork/scripts/package-win.ts:201-206`). What remains uncovered is verification of the downloadable release artifacts, not the CI-built ones: `release.yml:186-189` uploads only the installer, the portable archive and `SHA256SUMS.txt`, never `win-unpacked/`, so the published set cannot be re-verified the way the verifier does it; and no real second machine has run it. The `AGENTS.md` debt row still reading that `verify-win-installer.ts` has never been executed against a real artifact is stale as of this run — noted here as a documentation follow-up, deliberately not edited in this commit.
- No `dshmarket` freshness: `market:check` is red for the external `1.73.5` vs `1.70.2` reason and was not run, and the root smoke wrapper cannot get past `market:prepare` on this machine. The smoke above uses the committed pinned `1.70.2` market, which is what CI also packages.
- No provisioning coverage from the smoke or from CI `check`; the guard's exit 0 is the explicit local run recorded in Step 2.
- No claim that the harness pin moved: it is `1600d8a1e1` at `PHASE_B_SHA`, unchanged since phase A.

---

# Addendum — final review fix wave (2026-10-30)

**This section is an addendum.** The phase-B record above is kept intact and describes `PHASE_B_SHA` and its CI run; everything below refers to the later `FINAL_SHA` produced by the final whole-branch review's fix wave.

The final review returned **"With fixes"** with three Important findings. All three were documentation / test-wiring defects — no product source, packaging input, version, AA/market asset, workflow, or submodule pin changed — and they are fixed in one commit.

| Field | Value |
|---|---|
| **`FINAL_SHA`** | **`4a6dbebe37f5fd5e3d3371574d4f05068cea41ce`** (`docs: correct single-desktop acceptance records and wire core tests`) |
| Parent | `337c7c1843` (`docs: correct phase B acceptance wording`) |
| Files changed | 4 — `docs/architecture.md`, `docs/architecture.en.md`, `AGENTS.md`, `package.json` (one script string) |
| Branch | `refactor/huaanwork-single-desktop-maintenance` |
| CI run | run `40994970656`, `conclusion=success`, 6/6 jobs — https://github.com/kawaiininja/HuaAnWork-Desktop/actions/runs/40994970656 |
| Harness pin at `FINAL_SHA` | `1600d8a1e140dcde43a1a0941940a0480712c011` (unchanged since phase A) |

## Finding 1 (Important) — false live architecture claim

`docs/architecture.md:66` and `docs/architecture.en.md:66` still described `upstream.json` as carrying `stable` / `beta` records "as vendored-runtime channel metadata". After Task 10 that file has exactly one channel; the stable historical leg is a market peer string, not a channel record.

Fix, in both languages, with the rest of the paragraph and the channel-protocol text untouched: `upstream.json` `activeChannel` is `huaanwork` and its `channels` map holds the `huaanwork` record alone; the historical Stable leg is **not** a channel record and survives only as the `marketPeerPolicy.stableHistorical` market peer string `0.2.0-rc.2`; `DESKTOP_RELEASE_IDENTITIES` `stable` / `beta` are historical identity only.

## Finding 2 (Important) — false Windows debt row

`AGENTS.md:58` claimed the Windows artifacts did not exist and that `verify-win-installer.ts` had never run against a real artifact, citing `ci.yml:140-148`. Both were false: `dist:win` runs the verifier after electron-builder (`dsh-plugin-huaanwork/scripts/package-win.ts:201-206`), and the phase-A run `40908689112` and phase-B run `40988746000` both logged `Windows installer verification passed` for the CI-built installer and `dist/win-unpacked/HuaAnWork.exe` (Step 4 above, `:208`).

Fix: the row is retitled **Windows 发行制品校验零证据** with a 2026-10-30 correction date; it records the CI-built-artifact verification and both run IDs; the stale `ci.yml` line references are replaced by the current workflow — `:155` runs `check:win-package:platform`, `Build Windows installer` starts at `:160` and runs `dist:win` at `:165`, `Build Windows portable archive` at `:166`. The real remaining gaps are kept and not downgraded: (1) `release.yml:186-189` uploads only the installer, the portable archive and `SHA256SUMS.txt`, so the **downloadable release artifacts** cannot be re-verified the way the verifier does it; (2) `update-server/scripts/publish-release.mjs --platform windows` has never been run; (3) no second machine has run it, so the real macOS→Windows boundary is unverified. The M3 cross-milestone gap (workspace switching on Windows, spec §14 item 21) and the trigger conditions (a Windows host becomes available, **or** release-artifact verification is scheduled) are unchanged. This discharges the follow-up that the last bullet of "What this record does not claim" deliberately deferred to a documentation fix.

## Finding 3 (Important) — new core tests never ran in CI

`package.json`'s `test:architecture-gates` ran only `market-dependency-direction.test.mjs` and `active-topology.test.mjs`; the new `scripts/vendored-runtime-policy.test.mjs` and the hermetic `scripts/upstream-sync-dashboard.test.mjs` ran only through the unwired `test:scripts`.

Fix: `test:architecture-gates` now runs all four files. `check:architecture`, `check:layout`, and `scripts/expected-root-gate-scripts.json` were not modified, so the read-only dashboard is still not a gate — only its hermetic test joins the architecture gate. The gate's own test count moved from 11 to 16, both locally and in the CI `check` job (`# tests 16`, `# pass 16` in run `40994970656`).

## Gates on `FINAL_SHA`, run serially

Every command below ran alone, in this order, on `4a6dbebe37`. `git diff --check` exited 0 with no output before the gates started.

| # | Command | Exit | Key output |
|---|---|---|---|
| 1 | `corepack yarn install --immutable` | 0 | `Done with warnings in 1s 398ms`; the pre-existing `YN0002`/`YN0086` peer notices, no resolution change |
| 2 | `corepack yarn check` | 0 | full chain green — `test:architecture-gates` **16/16**; `verify-bilingual-docs: 50 records and 100 documents are consistent`; `verify-market-dependency-direction: 441 tracked source files … 8 market wrapper files carry no registry bypass`; `sync-vendored-runtime: huaanwork 341 packages from 1600d8a1e1 are verified`; `verify-layout: HuaAnWork and retained workspaces are consistent with upstream 1600d8a1e1`; `test:gate-scripts` 1/1; `check:readme-versions` 3/3; workspace totals `dsh-plugin-huaanwork` 267 files / 3547 passed (14 skipped, 3561), `dsh-community-market` 13 files / 303, `market-server` 14 / 244, `update-server` 5 / 88, `agent-catalog-server` 5 / 80, all remaining packages green |
| 3 | `corepack yarn typecheck` | 0 | only `contract-types: 4 generated type files are current` |
| 4 | `corepack yarn test` | 0 | twelve workspaces green: `dsh-plugin-huaanwork` 267 files / 3547 passed (14 skipped), `dsh-community-market` 13 / 303, `@huaanwork/policy` 64 (62 passed, 2 skipped), `@huaanwork/model` 10, `@huaanwork/git-tools` 8, `@huaanwork/web-tools` 19, `market-server` 14 / 244, `update-server` 5 / 88, `@huaanwork/catalog-signing` 13, `@huaanwork/agent-package-format` 35, `agent-catalog-server` 5 / 80, `agent-catalog-admin` 15 — 0 failures |
| 5 | `corepack yarn aa:check` | 0 | `Selected AA main at 64c3f67ee3b270c1740da4da9dfae56d6217c8e4`; `AA release verified: HuaAnWork uses 64c3f67ee3b270c1740da4da9dfae56d6217c8e4` — AA `main` had not advanced, so nothing failed for drift and `aa:prepare-release` was not run |
| 6 | `node scripts/upstream-sync-dashboard.mjs --json` | 0 | `ok: true`, `upstreamSha` = `reviewedCommit` = `092e2ecef750d10db43cedbab8e81fd48c8de38e`, `pendingCount: 0`, and `git rev-list --count 092e2ece…..upstream/master` = **0**, so pending equals the rev-list count |

## CI for `FINAL_SHA`

```bash
git push origin refactor/huaanwork-single-desktop-maintenance    # 337c7c1843..4a6dbebe37
gh workflow run ci.yml --ref refactor/huaanwork-single-desktop-maintenance --repo kawaiininja/HuaAnWork-Desktop
```

The dispatch returned run `40994970656` directly and its `headSha` already equalled `FINAL_SHA`, so the registration match succeeded on the first poll (no polling extension was needed). `gh run watch --exit-status` exited 0.

| Field | Value |
|---|---|
| Run ID | `40994970656` |
| URL | https://github.com/kawaiininja/HuaAnWork-Desktop/actions/runs/40994970656 |
| Event / branch | `workflow_dispatch` / `refactor/huaanwork-single-desktop-maintenance` |
| `headSha` | `4a6dbebe37f5fd5e3d3371574d4f05068cea41ce` (= `FINAL_SHA`) |
| Created / updated | `2026-10-30T03:01:07Z` / `2026-10-30T03:25:01Z` |
| Status / conclusion | `completed` / **`success`** |

| Job | Conclusion | URL |
|---|---|---|
| `changes` | success | https://github.com/kawaiininja/HuaAnWork-Desktop/actions/runs/40994970656/job/123865861141 |
| `gitleaks` | success | https://github.com/kawaiininja/HuaAnWork-Desktop/actions/runs/40994970656/job/123865861491 |
| `desktop-macos (dsh-plugin-huaanwork)` | success | https://github.com/kawaiininja/HuaAnWork-Desktop/actions/runs/40994970656/job/123865996659 |
| `check` | success | https://github.com/kawaiininja/HuaAnWork-Desktop/actions/runs/40994970656/job/123865996724 |
| `upstream-command-windows` | success | https://github.com/kawaiininja/HuaAnWork-Desktop/actions/runs/40994970656/job/123865996742 |
| `desktop-windows (dsh-plugin-huaanwork)` | success | https://github.com/kawaiininja/HuaAnWork-Desktop/actions/runs/40994970656/job/123865996842 |

Six jobs, all success — the same matrix as the phase-B run, with no job added or dropped. Two details carry the fix wave into CI: the `check` job's `Run yarn check` step now logs `# tests 16` / `# pass 16` for the architecture gates (the two new files executing in CI, Finding 3), and `desktop-windows` again logged `Windows installer verification passed: D:\a\HuaAnWork-Desktop\HuaAnWork-Desktop\dsh-plugin-huaanwork\dist\HuaAnWork-0.1.0-x64-Setup.exe` plus `Windows portable verification passed: …\HuaAnWork-0.1.0-x64-Portable.zip`.

## Why the phase-B smoke remains valid

The fix commit changes two architecture documents, one `AGENTS.md` debt row, and one `package.json` script string.

```bash
git diff --name-only 337c7c1843..4a6dbebe37
# AGENTS.md  docs/architecture.en.md  docs/architecture.md  package.json
```

No product source file, packaging input, version field, AA or market asset, workflow, reference-tree history, or submodule pin is in that set, and `package.json` changes only the argument list of `test:architecture-gates` (no dependency, version, or runtime entry). The unsigned macOS DMG and the Windows artifacts produced in Step 2 and Step 4 are therefore still representative of `FINAL_SHA`, and the smoke was deliberately **not** re-run; re-running it would re-package byte-identical inputs. The smoke is not a gate for a docs/test-wiring-only change.

The full span from the phase-B code SHA is the same set plus this evidence file, which `337c7c1843` edited for wording before this fix wave:

```bash
git diff --name-only cbd392fbc7..4a6dbebe37
# AGENTS.md  docs/architecture.en.md  docs/architecture.md
# docs/evidence/2026-10-29-single-desktop-phase-b.md  package.json
```

## This addendum's evidence commit

```bash
git add docs/evidence/2026-10-29-single-desktop-phase-b.md
git commit -m "docs: append the final review fix wave to phase B evidence"
test -z "$(git diff --name-only "$FINAL_SHA"..HEAD -- . ':(exclude)docs/evidence/2026-10-29-single-desktop-phase-b.md')"
git push origin refactor/huaanwork-single-desktop-maintenance
```

The evidence commit's parent is `4a6dbebe37f5fd5e3d3371574d4f05068cea41ce`, and the diff against `FINAL_SHA` contains this file only.

## What this addendum does not claim

- No new smoke, no new signed or notarized artifact, no release, no tag, no `master` push, no merge — the only ref pushed is the feature branch.
- No claim that the three findings exhausted the review: only the three Important findings in scope were fixed; nothing else in the review was acted on.
- No claim that the Windows release face is now covered: the row's remaining gaps (downloadable release artifacts, `publish-release.mjs --platform windows`, second machine) are unchanged by this fix wave.
- No AA or market refresh: `aa:check` passed on the existing artifact and `market:check` was not run (the external `1.73.5` vs `1.70.2` drift recorded above is untouched).
