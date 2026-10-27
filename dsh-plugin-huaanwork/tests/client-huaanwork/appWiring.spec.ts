import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";

import { answerApprovalInTabs } from "../../src/client-huaanwork/logic/chatTabs.ts";
import { clearFailuresInTabs } from "../../src/client-huaanwork/logic/hostStop.ts";
import { foldRunAssistantItems } from "../../src/client-huaanwork/logic/runResultAttachments.ts";

/**
 * App 两条回调接线的回归门（评审:helper 单测全绿但 App 调用被删仍绿）:
 * 1. 探活观察者 → clearFailuresInTabs → setChatTabs
 * 2. answer() → answerApprovalInTabs → setChatTabs
 *
 * 这里驱动 App 实际调用的生产函数（不是复刻循环），并在末尾钉住 App.tsx 的
 * 调用点；去掉调用点、把循环写回组件或换掉实现都会变红。
 */

type TabsSetter<T> = (value: T[] | ((prev: T[]) => T[])) => void;

/** 假 setChatTabs：收集函数式更新，按顺序应用后返回最终 tabs。 */
function collectUpdates<T>(initial: T[]) {
  const updates: Array<(prev: T[]) => T[]> = [];
  const setTabs: TabsSetter<T> = (value) => {
    updates.push(typeof value === "function" ? (value as (prev: T[]) => T[]) : () => value);
  };
  return {
    setTabs,
    updates,
    value(): T[] {
      return updates.reduce((tabs, update) => update(tabs), initial);
    },
  };
}

test("the stopped phase clears every failed tab through the same setter App uses", () => {
  const initial = [
    { id: "a", label: "会话 A", sessionFailed: true },
    { id: "b", label: "会话 B", sessionFailed: false },
  ];
  const harness = collectUpdates(initial);
  clearFailuresInTabs("stopped", harness.setTabs);
  assert.equal(harness.updates.length, 1);
  assert.deepEqual(harness.value(), [
    { id: "a", label: "会话 A", sessionFailed: false },
    { id: "b", label: "会话 B", sessionFailed: false },
  ]);
});

test("phases before the stop confirmation never touch the tabs", () => {
  // socket 先关时标签被标失败,但 suspect/stoppable 仍在探活里:不能提前撤掉红条。
  for (const phase of ["ok", "suspect", "stoppable"] as const) {
    const harness = collectUpdates([{ id: "a", sessionFailed: true }]);
    clearFailuresInTabs(phase, harness.setTabs);
    assert.equal(harness.updates.length, 0, phase);
    assert.deepEqual(harness.value(), [{ id: "a", sessionFailed: true }], phase);
  }
});

test("a repeated stopped phase with no failure keeps the same array (no state churn)", () => {
  const initial = [{ id: "a", sessionFailed: false }];
  const harness = collectUpdates(initial);
  clearFailuresInTabs("stopped", harness.setTabs);
  assert.equal(harness.updates.length, 1);
  assert.equal(harness.value(), initial);
});

test("answering writes the card into the tab that holds it, not the live tab", () => {
  type Item = {
    kind: string;
    text?: string;
    card?: { approvalRequestId?: string; toolName?: string; answered?: "approve" | "reject" };
  };
  type Tab = { id: string; items: Item[] };
  const tabs: Tab[] = [
    { id: "live", items: [{ kind: "user", text: "在另一张标签提问" }] },
    {
      id: "card",
      items: [
        { kind: "ask", card: { approvalRequestId: "req-1", toolName: "plan-review" } },
        { kind: "ask", card: { approvalRequestId: "req-2", toolName: "ask_user_question" } },
      ],
    },
  ];
  const harness = collectUpdates(tabs);
  answerApprovalInTabs("req-1", "approve", harness.setTabs);

  const next = harness.value();
  assert.equal(next[0], tabs[0], "不持有卡片的标签保持同一引用");
  assert.notEqual(next[1], tabs[1]);
  assert.equal(next[1]!.items[0]!.card?.answered, "approve");
  assert.equal(next[1]!.items[1]!.card?.answered, undefined, "只标记命中的那张卡");
});

const APP_SOURCE = readFileSync(new URL("../../src/client-huaanwork/App.tsx", import.meta.url), "utf8");

test("App consumes the two production helpers at their only call sites", () => {
  // 契约钉:删掉 App 里的调用(或把循环写回组件)即失败。
  assert.match(APP_SOURCE, /clearFailuresInTabs\(phase, setChatTabs\)/);
  assert.match(APP_SOURCE, /answerApprovalInTabs\(card\.approvalRequestId, decision, setChatTabs\)/);
  // 已处理标记只能由 helper 回写,App 里不得再出现内联循环。
  assert.doesNotMatch(APP_SOURCE, /markApprovalAnswered\(/);
});

test("agent notices and confirm cards follow their session instead of the live tab", () => {
  // 回合中新建任务会把 liveChatRef 移到新标签;agent 事件自带 sessionId,
  // 必须走 targetTabFor,否则旧会话的卡片/提示会落到新标签。
  const start = APP_SOURCE.indexOf('if (event.event === "agent/notice")');
  const end = APP_SOURCE.indexOf('if (event.event === "agent/changed")', start);
  assert.ok(start >= 0 && end > start, "agent notice/confirm branches are still present");
  const block = APP_SOURCE.slice(start, end);
  assert.match(block, /targetTabFor\(eventSessionId\)/);
  assert.doesNotMatch(block, /liveChatRef\.current/);
});

test("App skips plan-turn outcomes before it lists the workspace tree", () => {
  const start = APP_SOURCE.indexOf("const appendTurnOutcome = async");
  const end = APP_SOURCE.indexOf("const appendGoalStopped", start);
  assert.ok(start >= 0 && end > start, "appendTurnOutcome is defined before appendGoalStopped");
  const body = APP_SOURCE.slice(start, end);
  const checkAt = body.indexOf("if (!shouldCheckTurnOutcome(pending.items)) return;");
  const readAt = body.indexOf("const turn = await readTurn(sessionId, pending)");
  assert.ok(checkAt >= 0, "appendTurnOutcome still suppresses plan-mode turns");
  assert.ok(
    readAt > checkAt,
    "the plan-turn check must run before readTurn, which pays the depth-6 tree listing",
  );
  // readTurn 仍只在确有必核文件时才列树（执行回合行为不变）。
  const turnStart = APP_SOURCE.indexOf("const readTurn = async");
  const turnEnd = APP_SOURCE.indexOf("const appendTurnNotes", turnStart);
  assert.ok(turnStart >= 0 && turnEnd > turnStart, "readTurn is defined before appendTurnNotes");
  const turnBody = APP_SOURCE.slice(turnStart, turnEnd);
  assert.match(turnBody, /if \(checks\.requiredFiles\.length > 0 && root\) \{/);
  // 两个针都要真命中：indexOf 未命中返回 -1，单靠大小比较会变成永真断言
  // （readTurn 现在核对的是 contentItems(items)，旧的 "turnChecks(items)" 已不在源码里）。
  const checksAt = turnBody.indexOf("turnChecks(contentItems(items))");
  const listTreeAt = turnBody.indexOf("listTree(root, WORKSPACE_SCAN_DEPTH)");
  assert.ok(checksAt >= 0, "readTurn still computes the turn checks (rename the needle with it)");
  assert.ok(listTreeAt >= 0, "readTurn still lists the workspace tree");
  assert.ok(listTreeAt > checksAt, "the tree listing stays inside the required-files branch");
});

type FoldableItem = {
  id: number;
  kind: "note" | "assistant" | "tool" | "attachment";
  text?: string;
  sourceText?: string;
};

test("folding a run's JSON assistant text keeps one attachment in place and leaves siblings alone", () => {
  const items: FoldableItem[] = [
    { id: 1, kind: "note", text: "自动化运行中…" },
    { id: 2, kind: "assistant", text: '{"a":1}' },
    { id: 3, kind: "tool", text: undefined },
  ];
  const folded = foldRunAssistantItems(items, (sourceText) => ({ id: 9, kind: "attachment" as const, sourceText }));
  assert.deepEqual(folded, [
    { id: 1, kind: "note", text: "自动化运行中…" },
    { id: 9, kind: "attachment", sourceText: '{"a":1}' },
    { id: 3, kind: "tool", text: undefined },
  ]);
});

test("App folds run output at both call sites and keeps each footnote last", () => {
  // 两处调用：run-end 分支与回填效果。只数调用形式——import 行没有左括号，
  // 删掉任一处接线，计数即降为 1（helper 全绿但 App 不调用的回归门）。
  assert.equal((APP_SOURCE.match(/foldRunAssistantItems\(/g) ?? []).length, 2);

  // run-end：先折叠目标标签，再在同一更新体里追加结果脚注（脚注仍在末尾）。
  // 切片到「未命中标签」的 `: tab,` 分支为止：App.tsx 后面还有别的 `kind: "note"`
  // 字面量，全文件搜索会让删掉本处脚注（或把它挪到折叠之前）仍然全绿。
  const runEndFoldAt = APP_SOURCE.indexOf("foldRunAssistantItems(tab.items");
  assert.ok(runEndFoldAt >= 0, "run-end branch folds the target tab's items");
  const runEndEnd = APP_SOURCE.indexOf(": tab,", runEndFoldAt);
  assert.ok(runEndEnd > runEndFoldAt, "run-end update body still ends with the untouched-tab branch");
  const runEndBody = APP_SOURCE.slice(runEndFoldAt, runEndEnd);
  const runEndNoteAt = runEndBody.indexOf('{ id: allocId(), kind: "note" as const, text: resultLabel }');
  assert.ok(
    runEndNoteAt > 0,
    "the run-end result footnote is appended after the fold inside the same update (footnote stays last)",
  );

  // 回填：折叠包住 historyToChatItems，脚注 push 在其后。
  const composed = APP_SOURCE.indexOf("foldRunAssistantItems(historyToChatItems(view)");
  assert.ok(composed >= 0, "backfill folds the replayed history before appending its footnote");
  assert.ok(
    APP_SOURCE.indexOf("runResultNoteText(run.status)", composed) > composed,
    "the backfill footnote is pushed after the fold (footnote stays last)",
  );
});

test("ChatRow offers exactly the shared result attachment files through the optional handler", () => {
  // 只看 ChatRow 本体：`item.kind === "attachment"` 在 contentItems 适配器里也出现，
  // 全文件搜索证明不了渲染分支还在。
  const chatRowAt = APP_SOURCE.indexOf("function ChatRow(");
  const planCardAt = APP_SOURCE.indexOf("\nfunction PlanCard(", chatRowAt);
  assert.ok(chatRowAt >= 0 && planCardAt > chatRowAt, "ChatRow is still a top-level component before PlanCard");
  const chatRow = APP_SOURCE.slice(chatRowAt, planCardAt);
  assert.match(chatRow, /item\.kind === "attachment"/);
  assert.match(chatRow, /RESULT_ATTACHMENT_FILES\.map\(/);
  assert.match(chatRow, /onOpenAttachment\?\.\(file\)/);
  // 按钮文案来自共享清单，不在 App 里内联文件名。
  assert.doesNotMatch(APP_SOURCE, /结果\.md/);
});

test("deleting a run closes its run tabs through the shared helper", () => {
  // 契约钉:AutomationsView 的 onRunDeleted 必须落到 App 的 handler,且 handler 用
  // closeRunTabsForSession 计算关闭结果——删掉任一处接线,helper 单测仍绿但界面不关标签。
  assert.match(APP_SOURCE, /closeRunTabsForSession\(chatTabsRef\.current, sessionId, activeTab\)/);
  assert.match(APP_SOURCE, /onRunDeleted=\{handleRunDeleted\}/);
});

const AUTOMATIONS_VIEW_SOURCE = readFileSync(
  new URL("../../src/client-huaanwork/AutomationsView.tsx", import.meta.url),
  "utf8",
);

test("App wires the attachment open handler, preview branch and download of the current file", () => {
  // ChatRow 调用点:漏传 onOpenAttachment 时按钮点了没反应,而 ChatRow 单测仍绿。
  assert.match(APP_SOURCE, /onOpenAttachment=\{handleOpenAttachment\}/);

  // 预览分支:sandbox 空 + srcdoc 用完整 HTML 文档;Markdown 分支直接给原文。
  const previewAt = APP_SOURCE.indexOf('{rightTab === "preview" ? (');
  const previewEnd = APP_SOURCE.indexOf('{rightTab === "progress" ? (', previewAt);
  assert.ok(previewAt >= 0 && previewEnd > previewAt, "the preview branch is still between the right-pane tabs");
  const preview = APP_SOURCE.slice(previewAt, previewEnd);
  assert.match(preview, /sandbox=""/);
  assert.match(preview, /srcDoc=\{previewContent \?\? ""\}/);
  assert.match(preview, /previewFile === RESULT_ATTACHMENT_FILES\[0\]/);
  assert.match(preview, /\{previewContent \?\? ""\}/);
  // 「下载」只下载当前打开的这一份,不是固定某一份。
  assert.match(preview, /downloadAttachment\(previewFile, previewAttachment\.sourceText\)/);

  // 预览内容按 sourceText 记忆化,两份渲染器各用一次（预览与下载同源）。
  const memoAt = APP_SOURCE.indexOf("const previewContent = useMemo(");
  const memoEnd = APP_SOURCE.indexOf("const sessionFailed", memoAt);
  assert.ok(memoAt >= 0 && memoEnd > memoAt, "previewContent is memoized before sessionFailed");
  const memo = APP_SOURCE.slice(memoAt, memoEnd);
  // 预览页不可见时不解析/渲染：token 流每次刷新 items 都会换引用。
  assert.match(memo, /rightTab !== "preview"/);
  assert.match(memo, /previewFile === RESULT_ATTACHMENT_FILES\[0\]/);
  assert.match(memo, /renderResultMarkdown\(previewAttachment\.sourceText\)/);
  assert.match(memo, /renderResultHtml\(previewAttachment\.sourceText\)/);

  // 下载实现:文件名来自附件本身,内容与预览同源(两份渲染器各用一次)。
  const downloadAt = APP_SOURCE.indexOf("function downloadAttachment(");
  const downloadEnd = APP_SOURCE.indexOf("/** 宿主先把未回答的计划评审", downloadAt);
  assert.ok(downloadAt >= 0 && downloadEnd > downloadAt, "downloadAttachment is still defined before exitPlanMode");
  const download = APP_SOURCE.slice(downloadAt, downloadEnd);
  assert.match(download, /file === RESULT_ATTACHMENT_FILES\[0\]/);
  assert.match(download, /renderResultMarkdown\(sourceText\)/);
  assert.match(download, /renderResultHtml\(sourceText\)/);
  assert.match(download, /anchor\.download = file/);
  assert.match(download, /setTimeout\(\(\) => URL\.revokeObjectURL\(url\), 0\)/);
});

test("the composer stop branch for a live run is separate from the turn stop", () => {
  const composerAt = APP_SOURCE.indexOf('className="composer-bar"');
  const composerEnd = APP_SOURCE.indexOf("</form>", composerAt);
  assert.ok(composerAt >= 0 && composerEnd > composerAt, "the composer bar is still inside the form");
  const composer = APP_SOURCE.slice(composerAt, composerEnd);
  // 用户回合停止走 stopTurn;运行对话走 runTabLive 分支的 stopRunTab,两者不得合并。
  assert.match(composer, /onClick=\{\(\) => void stopTurn\(\)\}/);
  assert.match(composer, /\) : runTabLive \? \(/);
  assert.match(composer, /onClick=\{\(\) => void stopRunTab\(\)\}/);
  assert.match(composer, /disabled=\{blocked \|\| stopRunPending\}/);

  // stopRunTab 自身只调 automation.stop(停止这一轮),不碰 session.cancel。
  const stopAt = APP_SOURCE.indexOf("async function stopRunTab()");
  const stopEnd = APP_SOURCE.indexOf("function settleStop(", stopAt);
  assert.ok(stopAt >= 0 && stopEnd > stopAt, "stopRunTab is still defined before settleStop");
  const stopBody = APP_SOURCE.slice(stopAt, stopEnd);
  assert.match(stopBody, /const automationId = activeChat\.automationId/);
  assert.match(stopBody, /const tabId = activeChat\.id/);
  assert.match(stopBody, /await stopAutomationWithReconcile\(automationId\)/);
  // 停止失败的脚注必须落到点击时的标签，不能落到等待期间切到的当前标签。
  assert.match(stopBody, /noteTab\(tabId,/);
  assert.doesNotMatch(stopBody, /session\.cancel/);
});

test("the task-row stop goes through the reconciling stop path and refreshes afterwards", () => {
  const stopAt = AUTOMATIONS_VIEW_SOURCE.indexOf("async function stop(automation: AutomationInfo)");
  const stopEnd = AUTOMATIONS_VIEW_SOURCE.indexOf("async function submitRemove()", stopAt);
  assert.ok(stopAt >= 0 && stopEnd > stopAt, "AutomationsView still owns a task-row stop handler");
  const stopBody = AUTOMATIONS_VIEW_SOURCE.slice(stopAt, stopEnd);
  assert.match(stopBody, /onStopAutomation \?\? stopAutomation/);
  const callAt = stopBody.indexOf("await requestStop(automation.id)");
  assert.ok(callAt >= 0, "the task-row stop goes through automation.stop");
  assert.match(stopBody, /await requestStop\(automation\.id\)/);
  const refreshAt = stopBody.indexOf("onChanged()");
  assert.ok(refreshAt > callAt, "the task row refreshes from the host after the await on the stop call");
});

test("running-run state converges on refresh, host exit and stopped:false", () => {
  const refreshAt = APP_SOURCE.indexOf("async function refreshAutomations()");
  const refreshEnd = APP_SOURCE.indexOf("function handleRunDeleted", refreshAt);
  assert.ok(refreshAt >= 0 && refreshEnd > refreshAt, "refreshAutomations is still defined before handleRunDeleted");
  const refreshBody = APP_SOURCE.slice(refreshAt, refreshEnd);
  assert.match(refreshBody, /setRunningRuns\(\(prev\) => settleRunningRuns\(prev, listed\.runs \?\? \{\}\)\)/);

  const exitAt = APP_SOURCE.indexOf("await onSidecarExit((payload) => {");
  assert.ok(exitAt >= 0, "the sidecar exit handler is still wired");
  // 锚到下一段已知定义,不用固定字符窗口:上面的注释增长不应让断言失去意义。
  const exitEnd = APP_SOURCE.indexOf("const hydrateModels = useCallback(", exitAt);
  assert.ok(exitEnd > exitAt, "the sidecar exit handler is still followed by hydrateModels");
  const exitBody = APP_SOURCE.slice(exitAt, exitEnd);
  assert.match(exitBody, /setRunningRuns\(\(prev\) => \(prev\.size === 0 \? prev : new Map\(\)\)\)/);

  const stopAt = APP_SOURCE.indexOf("async function stopAutomationWithReconcile(");
  assert.ok(stopAt >= 0, "App owns a reconciling stop wrapper");
  const stopEnd = APP_SOURCE.indexOf("async function stopRunTab(", stopAt);
  assert.ok(stopEnd > stopAt, "stopAutomationWithReconcile is defined before stopRunTab");
  const stopBody = APP_SOURCE.slice(stopAt, stopEnd);
  assert.match(stopBody, /const runIds = \[\.\.\.runningRuns\]/);
  assert.match(stopBody, /if \(!result\.stopped\)/);
  assert.match(stopBody, /dropRunningRunIds\(prev, runIds\)/);

  const tabAt = APP_SOURCE.indexOf("async function stopRunTab()");
  const tabEnd = APP_SOURCE.indexOf("function settleStop(", tabAt);
  assert.ok(tabAt >= 0 && tabEnd > tabAt, "stopRunTab is still defined before settleStop");
  assert.match(APP_SOURCE.slice(tabAt, tabEnd), /await stopAutomationWithReconcile\(automationId\)/);

  // 任务行也必须走同一个 reconciling 入口，否则 stopped:false 仍会卡住。
  assert.match(APP_SOURCE, /onStopAutomation=\{stopAutomationWithReconcile\}/);
});

test("run deletion suppresses only the deleted run and earlier runs", () => {
  const at = APP_SOURCE.indexOf("function handleRunDeleted(");
  const end = APP_SOURCE.indexOf("Task 10：判定驱动在前端", at);
  assert.ok(at >= 0 && end > at, "handleRunDeleted is still defined before the keep-awake effect");
  const body = APP_SOURCE.slice(at, end);
  // 用被删运行自己的 startedAt 作为分界（不是任务级清空或固定值）。
  assert.match(body, /sessionsToSuppressAfterDelete\(automationRuns\[automationId\] \?\? \[\], sessionId, startedAt\)/);
  // 旧实现按任务抑制全部已加载会话，会挡住更新运行的合法重建。
  assert.doesNotMatch(body, /for \(const run of automationRuns\[automationId\]/);
});

test("live-run state is run-scoped: run-end deletes only its own runId and turns count runs", () => {
  // 旧实现按 automationId 记账:一条运行结束会摘掉任务 id,并发脚本的另一条仍在跑却不再显示停止。
  assert.match(APP_SOURCE, /next\.delete\(event\.runId\)/);
  assert.doesNotMatch(APP_SOURCE, /next\.delete\(event\.automationId\)/);
  assert.match(
    APP_SOURCE,
    /setRunningRuns\(\(prev\) => \{\s*const next = new Map\(prev\);\s*next\.set\(event\.runId, \{ automationId: event\.automationId \}\);/,
  );
  // 探活上报的是在跑轮数,不是任务数。
  assert.match(APP_SOURCE, /bridge\.reportTurns\(\(turnActive \? 1 : 0\) \+ runningRuns\.size\)/);
  // 运行标签 live 判据按 runId;任务行仍用派生的任务 id 集合。
  assert.match(APP_SOURCE, /isRunTabLive\(activeChat\.id, runningRunIds\)/);
  assert.match(APP_SOURCE, /isRunTabLive\(tab\.id, runningRunIds\)/);
  assert.match(APP_SOURCE, /useMemo\(\s*\(\) => new Set\(\[\.\.\.runningRuns\.values\(\)\]\.map\(\(entry\) => entry\.automationId\)\)/);
});

test("folded attachments use the assistant mapping and deleted runs stay suppressed", () => {
  // 附件不能映射成空 note:否则思考面板在运行结束后仍展开并显示「进行中」。
  assert.match(APP_SOURCE, /item\.kind === "attachment" \? attachmentAsAssistant\(item\) : item/);
  // 删过运行后把被删会话及其更早的会话记进抑制集,并交给重建判定。
  assert.match(APP_SOURCE, /const suppressed = suppressedRunSessionIdsRef\.current/);
  assert.match(APP_SOURCE, /sessionsToSuppressAfterDelete\(/);
  assert.match(APP_SOURCE, /suppressedRunSessionIdsRef\.current,\s*\);/);
});

test("the ready reconcile runs before the sidecar event gates so every reconnect unfreezes runs", () => {
  // 契约钉:sidecar/status 不携带 sessionId,而自动化闸门对 undefined 判定为非用户会话
  // 并早退。若 ready 对账留在闸门之后,后台自动化运行期间的重连永远到不了 snapshot:
  // 卡片停在「连接中断，状态可能滞后」,计时冻结、终止禁用,直到下一次重连才恢复,
  // 手动发送也被自动化挡住,无法自救。
  const handlerAt = APP_SOURCE.indexOf("const applyEvent = (event: RpcEvent) => {");
  const handlerEnd = APP_SOURCE.indexOf("applySidecarEventRef.current = applyEvent;", handlerAt);
  assert.ok(handlerAt >= 0 && handlerEnd > handlerAt, "the sidecar event handler is still a named applyEvent closure");
  const handler = APP_SOURCE.slice(handlerAt, handlerEnd);

  const readyAt = handler.indexOf('if (event.event === "sidecar/status" && event.ready) {');
  assert.ok(readyAt >= 0, "the handler still reacts to sidecar/status ready");
  const reconcileAt = handler.indexOf("reconcileBoundSubagentRuns()", readyAt);
  assert.ok(reconcileAt > readyAt, "sidecar/status ready still reconciles every bound tab");
  assert.equal(
    (handler.match(/reconcileBoundSubagentRuns\(\)/g) ?? []).length,
    1,
    "exactly one ready reconcile call site (a second copy left after the gates would resurrect the freeze)",
  );

  const gateAt = handler.indexOf(
    "if (automationActiveRef.current && !isUserSessionId(eventSessionId) && !boundTab) return;",
  );
  assert.ok(gateAt >= 0, "the automation route gate is still present");
  assert.ok(
    reconcileAt < gateAt,
    "reconcileBoundSubagentRuns() must run before the automation gate: sidecar/status has no sessionId, "
      + "so the gate returns early while a background automation runs and the post-reconnect reconcile is "
      + "unreachable — cards keep 连接中断，状态可能滞后, timers stay frozen and 终止 stays disabled "
      + "until the next reconnect (a manual send cannot clear it either)",
  );
});

test("the sidecar/status ready branch clears the dead latch a disconnect set", () => {
  // 产品钉:onSidecarExit 置位 sidecarDead,而 ready 是唯一能撤销它的地方。
  // 去掉这一行,一次瞬时断连 (C-07 真机:宿主换代期间 WS 断开) 之后即使已重连,
  // 发送、停止与自动化也永久禁用,只能重启应用。
  assert.match(APP_SOURCE, /setSidecarDead\(true\)/, "the exit handler still latches the dead state");

  const readyAt = APP_SOURCE.indexOf('if (event.event === "sidecar/status" && event.ready) {');
  assert.ok(readyAt >= 0, "the handler still reacts to sidecar/status ready");
  const readyEnd = APP_SOURCE.indexOf('if (event.event === "session/end"', readyAt);
  assert.ok(readyEnd > readyAt, "the ready branch still ends before the session/end handling");
  const readyBody = APP_SOURCE.slice(readyAt, readyEnd);
  assert.match(readyBody, /setSidecarDead\(false\);/, "ready must clear the dead latch inside the ready branch");

  // 撤销必须发生在 ready 分支内,不能在 ready 之外顺手清:否则任何未就绪的通知都会解锁界面。
  assert.equal(
    (APP_SOURCE.match(/setSidecarDead\(false\)/g) ?? []).length,
    1,
    "exactly one clear site, inside the ready branch",
  );
});

/**
 * 多标签运行卡回归门(E-05 真机 Important):切回/重开一个已有会话时若用历史回放覆盖标签,
 * 客户端专属的 subagent-run 卡片会全部消失——真机实测「标签 A 有 5 张卡,点一次侧栏归零」。
 * 历史回放只有消息条目,运行卡只能由宿主快照(subagent.list)补回。
 */
test("resuming an existing session tab activates it without replaying history over live run cards", () => {
  const resumeAt = APP_SOURCE.indexOf("async function resumeFromView(");
  assert.ok(resumeAt >= 0, "resumeFromView is still defined");
  const resumeEnd = APP_SOURCE.indexOf("async function resumeHistorySession(", resumeAt);
  assert.ok(resumeEnd > resumeAt, "resumeFromView is still followed by resumeHistorySession");
  const body = APP_SOURCE.slice(resumeAt, resumeEnd);

  const existingAt = body.indexOf("if (existing) {");
  assert.ok(existingAt >= 0, "resumeFromView still branches on an existing tab matched by sessionId");
  const elseAt = body.indexOf("} else {", existingAt);
  assert.ok(elseAt > existingAt, "the existing-tab branch is still followed by the new-tab branch");
  const existingBranch = body.slice(existingAt, elseAt);
  const newBranch = body.slice(elseAt);

  assert.match(existingBranch, /setActiveTab\(existing\.id\)/, "an existing tab is still activated");
  assert.doesNotMatch(
    existingBranch,
    /historyToChatItems/,
    "the existing-tab branch must not replay history: history items carry no subagent-run cards, "
      + "so overwriting the live tab with them drops every run card in every open tab "
      + "(E-05 live: 5 cards on tab A became 0 after one sidebar click)",
  );
  assert.doesNotMatch(
    existingBranch,
    /\bitems\b/,
    "the existing-tab branch must not replace the tab's items: the live tab state (including "
      + "client-only subagent-run cards) is authoritative, and a history replay empties it "
      + "(E-05 live: 5 cards on tab A became 0 after one sidebar click)",
  );

  // 历史回放只留给新建标签的分支,且新建后必须补拉宿主快照把运行卡补回来。
  assert.equal(
    (body.match(/historyToChatItems\(/g) ?? []).length,
    1,
    "historyToChatItems(view) is computed exactly once, inside the new-tab branch only",
  );
  assert.match(newBranch, /items: historyToChatItems\(view\)/, "the new-tab branch still seeds items from history");
  assert.match(
    newBranch,
    /void reconcileSubagentRuns\(id, sessionId\)/,
    "the new-tab branch must reconcile with the tab id + sessionId: a tab first opened after an app "
      + "restart otherwise shows history messages with zero subagent-run cards",
  );
});

test("history-load paths reconcile the host snapshot so run cards survive a fresh open", () => {
  // selectSubtask 的「有会话」历史分支:回放只产生消息条目,必须按 id + sessionId 对账。
  const selectAt = APP_SOURCE.indexOf("async function selectSubtask(");
  assert.ok(selectAt >= 0, "selectSubtask is still defined");
  const selectEnd = APP_SOURCE.indexOf("async function renameSubtask(", selectAt);
  assert.ok(selectEnd > selectAt, "selectSubtask is still followed by renameSubtask");
  const selectBody = APP_SOURCE.slice(selectAt, selectEnd);

  const historyAt = selectBody.indexOf("historyToChatItems(view)");
  assert.ok(historyAt >= 0, "selectSubtask's history branch still replays the session history");
  const createAt = selectBody.indexOf("setChatTabs((prev) => [", historyAt);
  assert.ok(createAt > historyAt, "selectSubtask still creates the tab from the replayed history");
  const selectReconcileAt = selectBody.indexOf("void reconcileSubagentRuns(id, sessionId)", createAt);
  assert.ok(
    selectReconcileAt > createAt,
    "selectSubtask's history branch must reconcile with the tab id + sessionId right after creating the tab: "
      + "without it a subtask first opened after an app restart shows zero subagent-run cards "
      + "even though the host still holds the runs",
  );

  // 重启重建的运行对话骨架回填历史后同样对账(用实际的 tabId 变量,不是当前激活标签)。
  const backfillAt = APP_SOURCE.indexOf("const runBackfillBusyRef = useRef<Set<string>>(new Set());");
  assert.ok(backfillAt >= 0, "the automation run-tab backfill effect is still present");
  const backfillEnd = APP_SOURCE.indexOf("}, [activeTab, chatTabs, automationRuns]);", backfillAt);
  assert.ok(backfillEnd > backfillAt, "the backfill effect still ends with its dependency list");
  const backfillBody = APP_SOURCE.slice(backfillAt, backfillEnd);
  const backfillWriteAt = backfillBody.indexOf("runPlaceholder: false");
  assert.ok(backfillWriteAt >= 0, "the backfill still replaces the placeholder items");
  const backfillReconcileAt = backfillBody.indexOf("void reconcileSubagentRuns(tabId, sessionId)", backfillWriteAt);
  assert.ok(
    backfillReconcileAt > backfillWriteAt,
    "the run-tab backfill must reconcile with its own tabId + sessionId after rebuilding the items: "
      + "otherwise a run tab restored after restart loses its subagent-run cards",
  );
});
