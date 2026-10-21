# Conversation Capabilities Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Work only in `.worktrees/conversation-capabilities` on `feat/huaanwork-conversation-capabilities`. Keep the main worktree untouched.

**Goal:** Fix every P0/P1/P2 finding from the 2026-10-20 code review of `feat/huaanwork-conversation-capabilities`, turn the branch gates green, and then run the desktop acceptance that the environment allows.

**Baseline:** `6bb667bf60751e55bddae820943acfbfc7701981` (branch head). The branch is 32 commits / 74 files over `3f2557dd821462cfcd38eb41b701c6c659d46f3f`.

**Review source:** the consolidated findings are reproduced per task below. The original design and plan remain the behavioral authority:
- `docs/superpowers/specs/2026-10-19-conversation-capabilities-design.md`
- `docs/superpowers/plans/2026-10-19-conversation-capabilities.md`

## Global Constraints

- Do not edit `dsh-plugin-desktop/src/`, `dsh-plugin-desktop-beta/src/`, `deepseek-harness/`, `vendor/`, `dsh-desktop-next/`, or `dsh-community-market/`.
- Do not enable `jobs`, `tool-jobs`, `workflow-ptc`, `tool-workflow`, `tool-ralph`, `web`, `web-search-deepseek`, `tool-web`, `hmr`, `llm-deepseek`, or any `ui-*` row. Do not add variant allowlist entries.
- Every behavioral fix needs a regression test that fails before the fix and passes after. Comment-only fixes are exempt.
- Run the targeted tests named in the task; the final task runs the full gates.
- Commit one task at a time. Do not rewrite published history.
- No subagent may dispatch another subagent. Reports go to the SDD workspace, not into the chat.
- `corepack yarn workspace dsh-plugin-huaanwork typecheck` and `corepack yarn check:desktop-variants` are the non-negotiable gates.
- Real-model acceptance is attempted only in Task 8. If the configured endpoint (`127.0.0.1:11434`) is unavailable, record the B items as **blocked**, never as passed.

## File map

| Area | Files |
| --- | --- |
| Client state/events | `dsh-plugin-huaanwork/src/client-huaanwork/App.tsx`, `logic/chatTabs.ts`, `logic/goalRound.ts`, `logic/thinkingPanel.ts`, `logic/turnStatus.ts` |
| Host lifecycle | `dsh-plugin-huaanwork/src/huaanwork-host/sessions.ts`, `child-sessions.ts`, `holders.ts`, `automations-host.ts` |
| Guardrails | `dsh-plugin-huaanwork/src/huaanwork-guardrails/{bridge,model,question-answerer,route-tool-plugin,route-tools,policy,skills}.ts` |
| Profile/gates | `dsh-plugin-huaanwork/src/profile.ts`, `src/huaanwork-host/{gates,row-assertions}.ts`, `scripts/verify-profile-boot.mjs` |
| History/outcome | `dsh-plugin-huaanwork/src/huaanwork-host/session-view.ts`, `src/client-huaanwork/logic/{commandOutcome,outcomeCheck}.ts`, `HistoryDetailPane.tsx` |
| Tests | existing `tests/**` files for each area; add focused specs where named |

---

### Task 1: Green the gates and close assertion gaps

**Files:**
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/App.tsx`
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/logic/thinkingPanel.ts`
- Modify: `dsh-plugin-huaanwork/tests/client-huaanwork/{outcomeCheck,thinkingPanel}.spec.ts`
- Modify: `dsh-plugin-huaanwork/tests/huaanwork-host/market-routes.spec.ts`
- Modify: `dsh-plugin-huaanwork/tests/profile.spec.ts`

**Requirements:**
1. `corepack yarn workspace dsh-plugin-huaanwork typecheck` must exit 0. Fix all errors, not only the known ones. Known errors at baseline:
   - `App.tsx:1772-1774`: `takeHeldEnds` is constrained to `T extends { sessionId?: string }` but is called with the `RpcEvent` union. Make the helper accept `RpcEvent` safely (e.g. an explicit `sessionIdOfEvent` accessor) and keep the returned types precise.
   - `logic/thinkingPanel.ts:86/88`: `withThinkingToggle` returns `T[]` while `items` is `readonly T[]`. Make the parameter and return type agree; update callers.
   - `tests/client-huaanwork/outcomeCheck.spec.ts:73/179`: the `TreeLike` fixture uses `name`/`isDir`, which the production type does not have; `appendOutcomeNotes` is called with a `note` item that the generic does not accept. Fix the fixture to the real `{ path, children }` shape and make the note typing explicit.
   - `tests/client-huaanwork/thinkingPanel.spec.ts:97`: the item array is inferred without `userToggled`; annotate it with the real item type.
2. `tests/huaanwork-host/market-routes.spec.ts:236` must expect `ROUTE_TABLE` length **56**, matching `routes.spec.ts:40/138` and `route-contract.spec.ts:333-334`. Keep the test's intent (market routes are off-table); do not delete the assertion.
3. Add `huaanwork-thinking-prompt` to the `expectedOrder` array in `tests/profile.spec.ts` (between `huaanwork-model` and `huaanwork-policy`).
4. Add a positive assertion in `tests/profile.spec.ts` that the composed `user-questions` row exists and is not disabled (the branch removed the disable line but left no positive check). Do not re-add a disable row.
5. Run:
   - `corepack yarn workspace dsh-plugin-huaanwork typecheck`
   - `corepack yarn workspace dsh-plugin-huaanwork vitest run tests/client-huaanwork/thinkingPanel.spec.ts tests/client-huaanwork/outcomeCheck.spec.ts tests/huaanwork-host/market-routes.spec.ts tests/profile.spec.ts`
6. Commit: `fix(huaanwork): green the typecheck and route-count gates`

**Acceptance:** both commands exit 0; the diff contains no unrelated formatting churn.

---

### Task 2: Close session lifecycle and cross-session leaks

**Files:**
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/App.tsx`
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/logic/chatTabs.ts`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/sessions.ts`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/child-sessions.ts`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-guardrails/route-tool-plugin.ts`
- Test: `dsh-plugin-huaanwork/tests/client-huaanwork/chatTabs.spec.ts`, `tests/huaanwork-host/sessions.spec.ts`, `tests/huaanwork-guardrails/route-tool-plugin.spec.ts`

**Requirements:**
1. **Auto-continue plan card no longer blocks logout.** `App.tsx` computes `pendingAsk` from any `ask` card without `answered`. A `plan-review` card with `autoContinue` never renders buttons and never gets `answered`, so `logoutDisabled` stays true until restart. Extract a pure `hasPendingAsk(tabs)` (or equivalent) into `logic/chatTabs.ts`; exclude `autoContinue` cards (or mark them answered at event time). Test both an ordinary unanswered card (pending) and an auto-continue card (not pending).
2. **`sessionExitPlanMode` must not cancel another session.** In `sessions.ts`, resolve the target with the no-channel-fallback lookup (`findAgentBySession`) rather than `findSessionAgent`. If the target session has no live agent, return `{ exited: false }` and do not cancel anything. Add a test where a channel agent is running a sibling session and the target has no live agent; assert the sibling receives no cancel.
3. **`cancelAgent` must not cancel an agent that is not bound to the target session.** Use the same no-fallback lookup for the primary; still cancel registered children. Keep the existing sibling test green and add a channel-agent sibling case.
4. **`session.remove` must release waiting `request_input` and stop the session.** Before/after unlinking, release the pending route input (`releaseRouteInput(sessionId)`), cancel the live agent for that session, and clear the session's child registrations and invalid-route counter. Add a test that removes a session with a pending input and asserts the pending map is empty and the agent was canceled.
5. **Bounded cleanup.** Add `forgetChildSessions(parentSessionId)` / `forgetChildSession(childSessionId)` to `child-sessions.ts` and call them from removal (and from `subagent/end` if the event exists). Add `clearInvalidRoute(sessionId)` to `route-tool-plugin.ts` and call it on removal/session end. Keep `pendingInputs` cleanup in `waitForInput`'s `finally` and in `releaseRouteInput`.
6. Run:
   - `corepack yarn workspace dsh-plugin-huaanwork vitest run tests/client-huaanwork/chatTabs.spec.ts tests/huaanwork-host/sessions.spec.ts tests/huaanwork-guardrails/route-tool-plugin.spec.ts`
   - `corepack yarn workspace dsh-plugin-huaanwork typecheck`
7. Commit: `fix(huaanwork): release session state and never cancel a foreign session`

**Acceptance:** the new tests fail on the pre-fix code and pass after; no sibling/channel agent receives a cancel in the cross-session tests.

---

### Task 3: Make goal rounds stop writing `已完成` mid-goal

**Files:**
- Modify: `dsh-plugin-huaanwork/src/huaanwork-guardrails/bridge.ts`
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/App.tsx`
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/logic/goalRound.ts`
- Test: `dsh-plugin-huaanwork/tests/huaanwork-guardrails/bridge.spec.ts`, `tests/client-huaanwork/goalRound.spec.ts`

**Requirements:**
1. **Bridge emits goal state.** On official `session/event` type `goal/change`, emit a new RPC event `{ event: "goal/state"; phase: "active" | "paused" | "blocked" | "complete"; roundsStarted?: number; sessionId?: string }` in addition to the existing `goal/round-limit` translation. Do not invent a new driver. Test all four phases and the round-limit translation.
2. **Suppress per-round outcome notes.** `App.tsx` currently calls `appendTurnOutcome` on every `session/end ok`. Track goal-active sessions from `goal/state` and suppress the per-round outcome while a goal is active. Write exactly one outcome when the goal reaches `complete` (or a non-round-limit `blocked`/`paused` terminal state), or when no goal is active. The round-limit path continues to use `appendGoalStopped` and its dedicated message. Add a per-turn idempotence guard so `session/end` + `goal/state` cannot append the outcome twice.
3. **Scope `turnActive`.** The `goal/round` branch sets the global `turnActive` unconditionally. Set it only when `event.sessionId === turnSessionRef.current` (or the equivalent tracked-session predicate); for a background session, append the round note to that session's tab without touching the global turn state. Test a background goal/round does not leave `turnActive` stuck and does not block `send()`.
4. Add a pure helper in `goalRound.ts` (or a new small logic module) for the decision "does this goal event start/finish the tracked turn" and unit-test it; do not rely only on timing.
5. Run:
   - `corepack yarn workspace dsh-plugin-huaanwork vitest run tests/huaanwork-guardrails/bridge.spec.ts tests/client-huaanwork/goalRound.spec.ts`
   - `corepack yarn workspace dsh-plugin-huaanwork typecheck`
6. Commit: `fix(huaanwork): keep completion notes out of intermediate goal rounds`

**Acceptance:** a simulated goal with rounds 1-3 produces only round labels; round 4/limit produces the stop message; no intermediate `已完成` note; a background goal does not leave `turnActive` true.

---

### Task 4: Make user-initiated host stop neutral and bound blocking git work

**Files:**
- Modify: `dsh-plugin-huaanwork/src/host-process.ts`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/host-liveness.ts`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-guardrails/bridge.ts`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-guardrails/policy.ts`
- Modify: `dsh-plugin-huaanwork/src/electron-runtime.ts` / `main.ts` only if the neutral stop needs a new message path
- Test: `dsh-plugin-huaanwork/tests/host-liveness.spec.ts`, guardrail tests for git budget helpers

**Requirements:**
1. **User stop is not a crash.** `beginHostLiveness`'s `onStop` currently calls `child.kill()` without setting the outer `stopping` flag, so the `exit` handler calls `options.onFailure`, which shows the error recovery dialog with "restart" as the default. Add a `stoppedByUser` / `terminateByUser` path: set it before `child.kill()`, make the exit handler skip `onFailure` for it, and show a neutral "执行进程已按你的要求结束" path (no error dialog, no automatic restart). Add a unit test for the flag/predicate; if the full Electron path cannot be unit-tested, test the extracted `shouldReportHostFailure` helper and record the GUI check for Task 8.
2. **Bound synchronous git work.** `bridge.ts:205-223` runs `spawnSync("git", ["diff"])`, `git status --porcelain -uall`, and one `git diff --no-index` per untracked file, all without a timeout. Add a timeout (<= 1500 ms) to each call and cap the number of untracked-file diffs (e.g. 20) or the total output. `policy.ts:201` `isGitDirty` also gets a timeout. Extract a small budget helper if needed and test it. The 2 s liveness probe must not be defeated by routine git diff work.
3. Keep the 2 s probe timeout, 15 s suspect, and 60 s stoppable semantics unchanged. Do not reuse the 120 s RPC timeout.
4. Run:
   - `corepack yarn workspace dsh-plugin-huaanwork vitest run tests/host-liveness.spec.ts`
   - `corepack yarn workspace dsh-plugin-huaanwork typecheck`
5. Commit: `fix(huaanwork): treat a requested host stop as a stop and bound git blocking`

**Acceptance:** a user stop never invokes `onFailure`; a large untracked tree cannot block the host loop longer than the configured budget; existing liveness tests remain green.

---

### Task 5: Make plan mode's prompt match the tools HuaAnWork actually exposes

**Files:**
- Modify: `dsh-plugin-huaanwork/src/profile.ts`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-guardrails/question-answerer.ts`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/gates.ts`
- Modify: `dsh-plugin-huaanwork/scripts/verify-profile-boot.mjs` (comment only)
- Test: `dsh-plugin-huaanwork/tests/profile.spec.ts`, `tests/huaanwork-guardrails/question-answerer.spec.ts`, new `tests/huaanwork-host/gates.spec.ts` if needed

**Requirements:**
1. **Plan-mode section override.** The base `plan-mode` section tells the model to use `ask_user_question`, but that tool is not registered in HuaAnWork (preset-only, and `present-as` intentionally does not allow it). Add a `config.section` to the `plan-mode` row in `profile.ts` that keeps the upstream plan discipline but replaces the `ask_user_question` guidance with `request_input` (and keeps `exit_plan_mode` as the only final plan call). Do not add `ask_user_question` to any allowlist. Add a profile test asserting the composed section contains `request_input` and `exit_plan_mode` and does **not** contain `ask_user_question`.
2. **Unattended plan review must not hang.** `question-answerer.ts` ignores `ctx.huaanworkUnattended`. When an unattended automation scope is active (`ctx.huaanworkUnattended?.current`), a `plan-review` should settle as declined/keep-planning (or otherwise fail closed) instead of waiting for a human click. Add a test with the unattended holder populated and a plan-review request.
3. **Boot-time catalog assertions.** `huaanwork-host/gates.ts` must prove the route/plan tools are actually visible, not just registered. Add `propose_plan`, `request_input`, and `exit_plan_mode` to the post-boot schema check (and `get_goal`/`create_goal`/`update_goal` if `tool-goal` is enabled). Add `planMode` and `userQuestions` to the gate's `inject` (or an equivalent explicit presence check) so a missing service fails boot instead of silently skipping the route/answerer plugins. Add a test that a missing required tool/service throws.
4. Update the stale `verify-profile-boot.mjs` comment that says `user-questions` is still locked.
5. Run:
   - `corepack yarn workspace dsh-plugin-huaanwork vitest run tests/profile.spec.ts tests/huaanwork-guardrails/question-answerer.spec.ts`
   - `corepack yarn workspace dsh-plugin-huaanwork typecheck`
6. Commit: `fix(huaanwork): align plan mode with the exposed tools and fail closed when unattended`

**Acceptance:** the composed plan section has no `ask_user_question`; an unattended plan-review does not wait for a human; a missing route tool or service fails the boot gate.

---

### Task 6: Fix history command extraction and outcome-check honesty

**Files:**
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/session-view.ts`
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/logic/commandOutcome.ts`
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/logic/outcomeCheck.ts`
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/HistoryDetailPane.tsx`
- Test: `tests/huaanwork-host/session-view.spec.ts`, `tests/client-huaanwork/commandOutcome.spec.ts`, `tests/client-huaanwork/outcomeCheck.spec.ts`

**Requirements:**
1. **Real `tool/call.arguments` is a JSON string.** `session-view.ts:211` passes the raw string to `shellCommandOf`, which only accepts objects; the fixture passes an object and creates a false green. Make `shellCommandOf` (or a small parser in `session-view`) accept both a parsed object and a JSON string. Update `formatArgs` so a string argument is parsed and displayed as JSON, not double-encoded. Change the `toolCall` fixture to `JSON.stringify(args)` and add a test with the real string shape.
2. **Remove or wire the dead history helper.** `outcomeCheck.ts:214` `toolResultsFromRecords` has no production caller. Either wire it into `HistoryDetailPane` (show the recorded command/result summary for the last turn) or delete it and its test. Prefer deletion unless the UI change is small; the per-turn check is already live via `App.tsx`. If deleting, keep the `command` field only if the history row displays it.
3. **Unreadable workspace must be honest.** `turnOutcomeNotes` with `treeKnown=false` and `requiredFiles.length > 0` currently returns only command gaps, so a missing file check is silently skipped. Return `没能读取工作区，文件未核对：...` in that branch. Add a test.
4. **Depth beyond the scan must not be reported as missing.** `outcomeCheck` scans depth 6; a required path deeper than that is currently reported as `缺少文件`. Distinguish `未核对（超出扫描深度）` from a real missing file; add a test.
5. **History truncation parity.** `session-view.ts` `clipText` keeps only the head, while the live bridge uses head+tail+marker. Reuse the same `capToolOutput` or a shared head/tail helper for history results so B17 is consistent after reopening a session. Add a test.
6. Run:
   - `corepack yarn workspace dsh-plugin-huaanwork vitest run tests/huaanwork-host/session-view.spec.ts tests/client-huaanwork/commandOutcome.spec.ts tests/client-huaanwork/outcomeCheck.spec.ts`
   - `corepack yarn workspace dsh-plugin-huaanwork typecheck`
7. Commit: `fix(huaanwork): parse recorded commands and report unverified files honestly`

**Acceptance:** a real string-argument log yields the command; the fixture no longer passes with an object-only shape; unreadable/depth-exceeded files are reported as unverified, not missing; history truncation matches live.

---

### Task 7: Close the remaining P2 cleanup

**Files:**
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/logic/turnStatus.ts`
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/logic/thinkingPanel.ts`
- Modify: `dsh-plugin-huaanwork/src/client-huaanwork/App.tsx`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-guardrails/skills.ts`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-guardrails/question-answerer.ts`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/session-sweep.ts`
- Modify: `dsh-plugin-huaanwork/src/huaanwork-host/sessions.ts` (extract a shared release helper if useful)
- Test: the corresponding specs

**Requirements:**
1. `turnStatus` must not show `已 1 秒没有新结果` at the instant a send starts. Add a short initial grace (e.g. `quietMs < 1000` -> `正在思考` when no tool is running) and a boundary test. Do not change the 5-minute alert or the running-tool priority.
2. Remove the unused `thought` parameter from `thinkingChrome` (or use it to drive `shouldRenderThinking`); update call sites and tests.
3. Remove the dead `info.parent` fallback in `skills.ts` if the `subagent/start` payload cannot carry it; rely on the `AsyncLocalStorage` attribution that is already there. Keep the existing cold-resume test green.
4. `question-answerer`'s `unanswered` path currently emits an actionable plan-review card with no approval registration. Make the no-answerer state non-actionable (a note/card without approve/reject buttons) so a click cannot fail silently. If the path is unreachable by construction, add a comment and a test that records that fact.
5. `App.tsx`'s `answer()` writes the answer to `setLiveItems` rather than the card's tab. Make it update the card's own tab (or document why `liveChatRef` makes it equivalent and add a test). Do not break multi-tab behavior.
6. `route-tools.classifyToolCalls` is a plan-mandated pure classifier; keep it, but ensure the runtime uses it for the control-tool validation (or add a comment explaining it is the specification and is covered by tests). Do not delete a plan deliverable.
7. `answererDecision`'s `hasListener:false` branch is a fail-closed policy primitive; keep it with a comment, or replace it with a real no-provider test. Do not leave an unreachable branch unexplained.
8. `goalRound.spec` constant assertions are not enough; the Task 3 behavior tests must cover the event path. Do not add new constant-only tests.
9. Update the stale `task-10b-report.md` note that says plan-mode is unreachable (the code was fixed by Task 12); this is scratch workspace, but future reviewers read it. Do not rewrite the old commit message.
10. **Close the second deletion path.** `session-sweep.ts` `removeSessionFilesById` is reached by `task.remove` and `project.remove`; it currently deletes logs without the runtime cleanup that `session.remove` now does. Extract a shared `releaseSessionRuntime(ctx, sessionId)` (or equivalent) and call it from both paths so waiting inputs, the bound agent, child registrations, the confirmed plan target, and invalid-route state are released before the files are removed. Add a test using the sweep path.
11. Add a wiring test for `forgetConfirmedTarget` through `sessionRemove` (not only a direct call), so a future removal of the call is caught.
12. **Do not claim completion for a paused or blocked goal.** Only `goal/state complete` may write the `已完成` outcome. `paused` and non-round-limit `blocked` must produce a neutral note (or no note), never `已完成`; this closes the false-completion class reached through input-card cancel, exit-plan-mode, session removal, and `/goal pause`, all of which pause the goal before the cancelled `session/end`. Add regression tests for at least one non-stop cancel path and one `/goal pause` sequence.
13. **Clear the sticky failure banner after a user stop.** When the WebSocket close is handled before the `stopped` IPC, `onSidecarExit` sets `sessionFailed: true` and the later `stopped` phase does not clear it. Clear it when the stopped phase is observed (or carry the stop reason in the exit payload). Add a focused helper test.
14. **Share the liveness phase union.** `preload.ts` re-declares the phase literal union; import/share `LivenessPhase` so the two definitions cannot drift.
15. **Fail closed for `request_input` under unattended.** An unattended automation has no human card; `route-tool-plugin`'s `waitForInput` must reject immediately for the matching unattended scope instead of parking until the automation timeout. Add a test.
16. **Close the Task 6 residuals.** Assert that the history truncation marker is present (not only that the head/tail survive); use `capToolOutput`'s default byte cap (or a shared constant) instead of duplicating `32 * 1024`; share the 200-character label limit with `ARGS_MAX_CHARS` instead of two literals.
17. Run:
    - `corepack yarn workspace dsh-plugin-huaanwork vitest run tests/client-huaanwork/turnStatus.spec.ts tests/client-huaanwork/thinkingPanel.spec.ts tests/huaanwork-guardrails/skills.spec.ts tests/huaanwork-guardrails/question-answerer.spec.ts tests/huaanwork-host/sessions.spec.ts tests/client-huaanwork/goalRound.spec.ts tests/client-huaanwork/hostStop.spec.ts tests/huaanwork-guardrails/route-tool-plugin.spec.ts tests/huaanwork-host/session-sweep.spec.ts tests/huaanwork-host/session-view.spec.ts`
    - `corepack yarn workspace dsh-plugin-huaanwork typecheck`
18. Commit: `fix(huaanwork): close the remaining conversation cleanup`

**Acceptance:** no immediate `已 1 秒`; no dead fallback; no actionable dead card; the existing multi-tab/skills tests remain green.

---

### Task 8: Close the Task 7 residuals and run the headless gates

**Files:**
- Modify: `dsh-plugin-huaanwork/src/huaanwork-guardrails/policy.ts`
- Modify: `dsh-plugin-huaanwork/tests/huaanwork-host/{stores,automations-store}.spec.ts` or a new focused route test
- Create (tracked): `docs/evidence/2026-10-20-conversation-capabilities-gates.md`

**Requirements:**
1. Type `policy.ts`'s `UnattendedHolder.current` as `UnattendedScope | null` to match `holders.ts` (the runtime is already null-safe; this is a type-truth fix).
2. Add an end-to-end test that `project.remove` passes the release callback to `removeAutomationsOfProject` (or a route-level equivalent), so deleting the callback argument fails a test. The store-level test alone is not enough.
3. Run the complete headless gates in the feature worktree and capture exact commands/exit codes:
   - `corepack yarn workspace dsh-plugin-huaanwork test`
   - `corepack yarn workspace dsh-plugin-huaanwork typecheck`
   - `corepack yarn check:desktop-variants`
   - `corepack yarn workspace dsh-plugin-huaanwork check` if feasible; otherwise record why not.
   - Separate any environment-only failure (e.g. an uninitialized `deepseek-harness` submodule) from branch-caused failures. Never report a blocked environment check as green.
4. Build the huaanwork package for Task 9:
   - `corepack yarn workspace dsh-plugin-huaanwork build`
   - Confirm `lib/bin.js` and the new modules exist. Do not launch the GUI in this task.
5. Commit the cleanup and the gate evidence. If the full suite is red for a branch-caused reason, stop and report BLOCKED with the failure; do not mask it.

**Acceptance:** the two residual fixes have tests; the headless gates are run and recorded with exact results; the build is fresh for Task 9.

---

### Task 9: Desktop acceptance and evidence

**Files:**
- Create (tracked): `docs/evidence/2026-10-20-conversation-capabilities-desktop-acceptance.md`
- Modify only if acceptance exposes a real defect; a defect goes back through the fix loop.

**Requirements:**
1. Launch the desktop app in explicit advanced mode from the fresh build (`corepack yarn workspace dsh-plugin-huaanwork dev`, or `node lib/bin.js` after the build). Use the real user settings at `~/Library/Application Support/HuaAnWork/settings.json`; do not reset them.
2. The configured model endpoint is `http://127.0.0.1:11434/v1`. It is currently not running and no Ollama/LM Studio installation was found. Attempt to start an installed local server only if one exists; do not download a model or install a new runtime without asking.
3. Execute the desktop B items that do not require a real model first: boot in advanced mode, B20 lock regression (no official `ui-*`, jobs/web/hmr remain off), the thinking-panel static shell if a session can be opened, history restore if a local session exists, and the host-liveness UI if a turn can be kept active. If a local stub OpenAI-compatible server is used to exercise UI mechanics, label every such result `MOCK` and never count it as a real-model PASS.
4. Execute B01-B17 and B21-B26 only with a real model endpoint. If the endpoint is unavailable, mark every model-dependent item `BLOCKED` and give the exact settings/endpoint needed to unblock. B18 is a sequencing regression already satisfied by the branch order; record it as not applicable on HEAD if its pre-enable state cannot be constructed.
5. Record every item as `PASS`, `FAIL`, or `BLOCKED` with evidence (screenshot path, log excerpt, command). Never mark a model-dependent item PASS without a real model turn. Windows-specific B16 remains unverified if no Windows machine exists.
6. Commit the evidence document only when it contains real observations. If all model items are blocked, state that in the first section and list the human follow-up commands.

**Acceptance:** the evidence document is honest and complete; all model-dependent items are either real-model PASS/FAIL or explicitly BLOCKED with an unblock path.

---

## Rulings and parked items

These are recorded in the SDD ledger and must not be silently dropped:

- `route-tools.classifyToolCalls`'s `answer`/`direct` branches stay because the implementation plan mandated the four-way classifier; Task 7 ensures the runtime validation uses the classifier rather than leaving it test-only.
- `answererDecision`'s `hasListener:false` branch stays as an explicit fail-closed primitive unless Task 7 can replace it with a real no-provider test.
- The liveness turn count counts user interactive/automation runs, not subagent children; a subagent is covered by its parent turn. If the design owner wants child sessions counted separately, that is a follow-up.
- `reduceLiveness` may return from `stoppable` to `suspect` when `turns` drops to 0; this is intentional (no live turn => no kill offer), and Task 4 keeps the `onStop` recheck.
- The stale commit message `6dd52dbddf` and the old `task-10b` report are documentation debt; code is fixed by Task 12's profile row.
- The main worktree has unrelated uncommitted changes; this plan never touches them.
