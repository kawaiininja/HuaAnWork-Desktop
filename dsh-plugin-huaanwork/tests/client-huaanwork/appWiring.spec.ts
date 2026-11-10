import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";

import { answerApprovalInTabs } from "../../src/client-huaanwork/logic/chatTabs.ts";
import {
  isUnstartedUserItem,
  noteSendResult,
  noteTurnEnded,
  noteWaitingCancelled,
  noteWaitingFailed,
  noteWaitingStarted,
  releaseWaitingItem,
  sendOpensTurn,
} from "../../src/client-huaanwork/logic/concurrentTurn.ts";
import {
  INITIAL_GOAL_TURN_STATE,
  reduceGoalTurn,
  type GoalTurnEvent,
  type GoalTurnState,
} from "../../src/client-huaanwork/logic/goalRound.ts";
import { applyTurnFinalToTabs, projectToolPanels, reduceTurnFinal, type TurnFinalEvent } from "../../src/client-huaanwork/logic/toolPanel.ts";
import { consumeBufferedStaleEnds, consumeStaleIdle, finishStop } from "../../src/client-huaanwork/logic/stopGate.ts";
import { appendOutcomeNotes, latestUserItemId, turnChecks } from "../../src/client-huaanwork/logic/outcomeCheck.ts";
import { interruptTurnItems } from "../../src/client-huaanwork/logic/thinkingPanel.ts";
import { clearFailuresInTabs } from "../../src/client-huaanwork/logic/hostStop.ts";
import { foldRunAssistantItems } from "../../src/client-huaanwork/logic/runResultAttachments.ts";
import * as AppModule from "../../src/client-huaanwork/App.tsx";

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
const AUTOMATION_RUN_LINK_SOURCE = readFileSync(
  new URL("../../src/client-huaanwork/logic/automationRunLink.ts", import.meta.url),
  "utf8",
);

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
  // （readTurn 现在核对的是带活动用户消息的 contentItems(items)，旧的 "turnChecks(items)" 已不在源码里）。
  const checksAt = turnBody.indexOf("turnChecks(contentItems(items), turnUserId)");
  const listTreeAt = turnBody.indexOf("listTree(root, WORKSPACE_SCAN_DEPTH)");
  assert.ok(checksAt >= 0, "readTurn still computes the turn checks (rename the needle with it)");
  assert.ok(listTreeAt >= 0, "readTurn still lists the workspace tree");
  assert.ok(listTreeAt > checksAt, "the tree listing stays inside the required-files branch");
});

test("the outcome check scans the turn's own root, not whichever project is on screen", () => {
  // 项目列表进入事件闭包：回合结束核对要按标签的 projectId 找项目根。
  assert.match(APP_SOURCE, /const projectsRef = useRef<ProjectInfo\[\]>\(\[\]\);/);
  assert.match(
    APP_SOURCE,
    /workspaceRef\.current = workspace;\s*sessionsRef\.current = sessions;\s*projectsRef\.current = projects;\s*\}, \[workspace, sessions, projects\]\);/,
    "the project list is synced into the ref alongside workspace and sessions",
  );
  // 标签 ID 与它自己的 projectId 一起读出：核对不靠前台标签猜归属。
  const itemsBody = functionBody("const readTurnItems = async", "const readTurn = async");
  assert.match(itemsBody, /const tabId = outcomeTargetTab\(sessionId, chatTabsRef\.current, liveChatRef\.current\);/);
  assert.match(itemsBody, /const projectId = chatTabsRef\.current\.find\(\(tab\) => tab\.id === tabId\)\?\.projectId \?\? null;/);
  assert.match(itemsBody, /return \{ tabId, items, projectId \};/);

  const body = functionBody("const readTurn = async (", "const appendTurnNotes = (");
  assert.match(body, /const listedCwd = lookupSessionCwd\(sessionId, sessionsRef\.current, sessionCwdRef\.current\);/);
  assert.match(
    body,
    /const projectRoot = turn\.projectId === null\s*\? undefined\s*: projectsRef\.current\.find\(\(project\) => project\.id === turn\.projectId\)\?\.root;/,
    "the tab's own project root is looked up from the project list",
  );
  assert.match(
    body,
    /const root = outcomeWorkspace\(\{\s*sessionCwd: listedCwd,\s*projectRoot,\s*tabProjectId: turn\.projectId,\s*foregroundWorkspace: workspaceRef\.current,\s*foregroundProjectId: activeProjectIdRef\.current,\s*\}\);/,
    "the root decision gets the turn's ids and the foreground only as a context-checked fallback",
  );
  // 根未知时 treeKnown 为 false：文件项如实记为未核对，不报「缺少文件」。
  assert.match(body, /const treeKnown = checks\.requiredFiles\.length === 0 \|\| root\.length > 0;/);
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

test("the automations view refreshes projects, tasks and sessions alongside the tasks", () => {
  // 设计 §3.3.3：automation.create 会自动建项目。只刷任务列表时，新项目在侧栏
  // 要等下一次刷新（重启/开项目）才出现，用户会以为没建成。
  // 规格 §8：运行记录跳转吃 tasks 快照，删除运行/自动化/prune 后必须一起刷新。
  const at = APP_SOURCE.indexOf("<AutomationsView");
  const end = APP_SOURCE.indexOf("/>", at);
  assert.ok(at >= 0 && end > at, "the AutomationsView call site is still present");
  const site = APP_SOURCE.slice(at, end);
  assert.match(
    site,
    /onChanged=\{\(\) => \{\s*void refreshAutomations\(\);\s*void refreshProjects\(\);\s*void refreshTasks\(\);\s*void refreshSessions\(\);\s*\}\}/,
    "onChanged refreshes automations, projects, tasks and sessions",
  );
  // 运行记录跳转复用子任务选择流程（规格 §8.3），且吃 App 的常驻 tasks 快照。
  assert.match(site, /tasks=\{projectTasks\}/);
  assert.match(site, /onOpenRunTask=\{\(task\) => void selectSubtask\(task\)\}/);
});

test("automation deletion refreshes tasks and sessions so stale run tabs get reconciled", () => {
  // 规格 §9.3:删除自动化会级联清掉跨项目的运行子任务与会话日志。只刷新自动化列表时,
  // 运行标签与「任务」区会留着已失 Task 的条目(标签对账吃的是 tasks 快照,不吃 runs)。
  // 三段接线缺一即失效:删除成功 → onChanged → tasks/sessions 刷新 → 失效对账。
  const removeAt = AUTOMATIONS_VIEW_SOURCE.indexOf("async function submitRemove()");
  const removeEnd = AUTOMATIONS_VIEW_SOURCE.indexOf("return (", removeAt);
  assert.ok(removeAt >= 0 && removeEnd > removeAt, "AutomationsView still owns submitRemove");
  const removeBody = AUTOMATIONS_VIEW_SOURCE.slice(removeAt, removeEnd);
  const callAt = removeBody.indexOf("await removeAutomation(confirming.id)");
  const changedAt = removeBody.indexOf("onChanged()");
  assert.ok(callAt >= 0, "the confirm dialog still calls automation.remove");
  assert.ok(changedAt > callAt, "the view refreshes from the host only after a successful removal");

  const at = APP_SOURCE.indexOf("<AutomationsView");
  const end = APP_SOURCE.indexOf("/>", at);
  assert.ok(at >= 0 && end > at, "the AutomationsView call site is still present");
  const site = APP_SOURCE.slice(at, end);
  assert.match(site, /void refreshTasks\(\);/, "deletion refreshes the tasks snapshot, not only the automation list");
  assert.match(site, /void refreshSessions\(\);/, "deletion refreshes sessions alongside tasks");

  // 刷新必须真的落到失效标签对账:对账的依赖是 tasks 快照本身。
  assert.match(
    APP_SOURCE,
    /reconcileStaleAutomationTabs\(chatTabsRef\.current, projectTasks, activeTabRef\.current\)/,
  );
  assert.match(APP_SOURCE, /\}, \[projectTasks, tasksLoaded\]\);/);
});

test("refreshTasks discards stale responses before writing projectTasks", () => {
  // 规格 §9.1（T3）：早于 Task 落盘发出、晚于 run-task 返回的旧 task.list 会把刚建的
  // 运行标签当成失效并关掉；run-end 不刷新 tasks，误关后不能自愈。
  const fn = functionBody("async function refreshTasks", "async function createSubtask");
  assert.ok(fn.indexOf("taskRequestSeq") >= 0, "refreshTasks owns a monotonic request sequence");
  const guardAt = fn.indexOf("seq !== taskRequestSeq.current");
  const writeAt = fn.indexOf("setProjectTasks");
  assert.ok(guardAt >= 0, "the stale-response guard is present");
  assert.ok(writeAt > guardAt, "the guard runs before projectTasks is written");
});

test("run tabs are created only by automation/run-task", () => {
  // 规格 §7.2：run-start 只更新在途表，不再建标签。
  const runStart = functionBody('if (event.event === "automation/run-start")', 'if (event.event === "automation/run-task")');
  assert.match(runStart, /setRunningRuns/);
  assert.doesNotMatch(runStart, /setChatTabs/);

  const runTask = functionBody('if (event.event === "automation/run-task")', 'if (event.event === "automation/missed")');
  // 查找键依次为 tabId、taskId、sessionId；标签名取 Task.name；只有 manual 聚焦。
  assert.match(runTask, /`run-\$\{event\.runId\}`/);
  assert.match(runTask, /tab\.id === tabId/);
  assert.match(runTask, /tab\.taskId === task\.id/);
  assert.match(runTask, /tab\.sessionId === event\.sessionId/);
  assert.match(runTask, /label: task\.name/);
  assert.match(runTask, /taskId: task\.id/);
  assert.match(runTask, /automationId: event\.automationId/);
  assert.match(runTask, /if \(event\.trigger === "manual"\) setActiveTab\(targetId\)/);
  assert.match(runTask, /void refreshTasks\(\)/);
});

test("stale run-tab reconciliation is keyed by the tasks snapshot while the rebuild keeps automations/runs", () => {
  // 规格 §7.2 + 评审 R5-1：run-task 先建标签再 refreshTasks。失效对账若跟 automations/runs 一起
  // 重跑，期间任何一次 refreshAutomations（另一条运行的 run-end、stop、missed、开项目、切到
  // 自动化视图）都会拿运行前的旧快照把刚建的运行标签误关成骨架。对账必须只以 tasks 快照为依赖。
  const staleAt = APP_SOURCE.indexOf(
    "reconcileStaleAutomationTabs(chatTabsRef.current, projectTasks, activeTabRef.current)",
  );
  assert.ok(staleAt >= 0, "stale reconciliation is still wired");
  const effectStart = APP_SOURCE.lastIndexOf("useEffect(() => {", staleAt);
  assert.ok(effectStart >= 0, "reconciliation lives in an effect");
  const reconcileDepsAt = APP_SOURCE.indexOf("}, [projectTasks, tasksLoaded]);", staleAt);
  assert.ok(reconcileDepsAt > staleAt, "reconciliation is keyed only by the tasks snapshot and its loaded flag");
  const reconcile = APP_SOURCE.slice(effectStart, reconcileDepsAt);
  assert.match(reconcile, /if \(!tasksLoaded\) return;/, "no reconciliation before the first authoritative snapshot");
  assert.doesNotMatch(reconcile, /runTabsToRebuild\(/, "the rebuild does not share the reconciliation effect");
  // 关闭复用现有 closeRunTabsForSession（active 选择规则不另写一份）：合成在 logic 模块单测覆盖。
  assert.match(AUTOMATION_RUN_LINK_SOURCE, /from "\.\/chatTabs\.ts"/, "the composition lives next to the tab helpers");
  assert.match(AUTOMATION_RUN_LINK_SOURCE, /closeRunTabsForSession\(/, "closing still goes through closeRunTabsForSession");

  const rebuildAt = APP_SOURCE.indexOf("runTabsToRebuild(", reconcileDepsAt);
  assert.ok(rebuildAt > reconcileDepsAt, "the rebuild effect is separate from the reconciliation effect");
  const rebuildEffectStart = APP_SOURCE.lastIndexOf("useEffect(() => {", rebuildAt);
  const rebuildDepsAt = APP_SOURCE.indexOf("}, [automations, automationRuns, projectTasks, tasksLoaded]);", rebuildAt);
  assert.ok(rebuildEffectStart > reconcileDepsAt && rebuildDepsAt > rebuildAt, "the rebuild is keyed by automations/runs/tasks/tasksLoaded");
  const rebuild = APP_SOURCE.slice(rebuildEffectStart, rebuildDepsAt);
  assert.match(rebuild, /if \(!tasksLoaded\) return;/, "no rebuild before the first authoritative snapshot");
  assert.match(rebuild, /runTabsToRebuild\(\s*automations,\s*automationRuns,\s*projectTasks,/, "rebuild consumes the tasks snapshot");
});

test("a failed run-tab backfill closes the skeleton instead of keeping an input-capable tab", () => {
  // 规格 §7.2：回填失败关闭骨架并提示，不保留可输入的旧会话标签。
  const backfill = functionBody("const runBackfillBusyRef", "}, [activeTab, chatTabs, automationRuns]);");
  const catchAt = backfill.indexOf("} catch (error) {");
  assert.ok(catchAt >= 0, "the backfill still has a failure branch");
  const failure = backfill.slice(catchAt);
  assert.match(failure, /closeRunTabsForSession\(chatTabsRef\.current, sessionId, activeTabRef\.current\)/);
  assert.match(failure, /setActiveTab\(result\.nextActiveId\)/);
  assert.match(failure, /noteTab\(result\.nextActiveId,/, "the error is surfaced on the surviving tab");
  assert.doesNotMatch(failure, /runPlaceholder: false/);
});

test("an automation task's failed restore never falls back to a fresh chat tab", () => {
  // 规格 §7.2 末条：恢复失败只报错，不走普通任务「发送后新建子任务」的降级。
  const body = functionBody("async function selectSubtask(", "async function renameSubtask(");
  const catchAt = body.indexOf("} catch (error) {");
  assert.ok(catchAt >= 0, "selectSubtask still handles open/resume failures");
  const failure = body.slice(catchAt);
  const guardAt = failure.indexOf("if (task.automationId)");
  const fallbackAt = failure.indexOf("failedSubtaskTabs.current.set");
  assert.ok(guardAt >= 0, "the automation guard comes first");
  assert.ok(fallbackAt > guardAt, "the ordinary fallback stays after the automation guard");
  const automationBranch = failure.slice(guardAt, fallbackAt);
  assert.match(automationBranch, /noteActive\(/);
  assert.match(automationBranch, /return;/, "the automation branch returns before any fallback tab");
  assert.doesNotMatch(automationBranch, /setChatTabs|session\.new/);
  // 去重按 taskId 或 sessionId（自动化 Task 与运行标签共用同一会话）。
  assert.match(
    functionBody("async function selectSubtask(", "async function renameSubtask("),
    /tab\.taskId === task\.id \|\|\s*\(task\.sessionId !== undefined && tab\.sessionId === task\.sessionId\)/,
  );
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
  // 探活上报的是在跑轮数,不是任务数:占名额的执行中标签 + 在途运行。
  assert.match(APP_SOURCE, /bridge\.reportTurns\(runningTurnCount \+ runningRuns\.size\)/);
  assert.match(
    APP_SOURCE,
    /const runningTurnCount = useMemo\(\s*\(\) => Object\.values\(tabRuns\)\.filter\(\(state\) => state\.running\)\.length,/,
    "the turn count is derived from per-tab running state, not a process-wide boolean",
  );
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
  assert.match(newBranch, /\bitems,/, "the new-tab branch still seeds items from history");
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
  const openAt = selectBody.indexOf('rpcCall<{ records?: SessionDetailRecord[] }>("session.open"');
  const resumeAt = selectBody.indexOf('rpcCall("session.resume"');
  assert.ok(openAt >= 0 && resumeAt > openAt, "selectSubtask reads history before resume: resume repairs an open tail on disk");
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

test("App turn final wiring consumes actual goal actions and sidecarDead only", () => {
  let state: GoalTurnState = INITIAL_GOAL_TURN_STATE;
  let final = false;
  const observed: boolean[] = [];
  const events: GoalTurnEvent[] = [
    { kind: "turn-started", sessionId: "s" },
    { kind: "goal-state", phase: "active", sessionId: "s" },
    { kind: "session-end", sessionId: "s", ok: true },
    { kind: "goal-state", phase: "complete", sessionId: "s" },
  ];
  for (const event of events) {
    const result = reduceGoalTurn(state, event);
    state = result.state;
    const input: TurnFinalEvent = event.kind === "session-end"
      ? { kind: "session-end", ok: event.ok, cancelled: event.cancelled === true }
      : { kind: "goal-action", action: result.action };
    final = reduceTurnFinal(final, input, state.phases[event.sessionId ?? ""]);
    observed.push(final);
  }
  assert.deepEqual(observed, [false, false, false, true], "only the real complete outcome settles endFirst");

  assert.match(
    APP_SOURCE,
    /const phase = goalTurnRef\.current\.phases\[sessionId \?\? ""\];/,
    "the goal phase must be sampled before the deferred state updater runs",
  );
  // 终态按该标签自己的活动用户消息结算（排队中/已抛错的消息不参与）。
  const finalBody = functionBody("function applyFinalForTab(", "useEffect(() => {");
  const phaseAt = finalBody.indexOf('const phase = goalTurnRef.current.phases[sessionId ?? ""];');
  const activeAt = finalBody.indexOf("const activeUserId = tabTurnOf(tabId).activeUserId");
  const finalCallAt = finalBody.indexOf(
    "setChatTabs((prev) => applyTurnFinalToTabs(prev, tabId, event, phase, activeUserId));",
  );
  assert.ok(phaseAt >= 0, "applyFinalForTab samples the goal phase synchronously");
  assert.ok(activeAt > phaseAt, "the active user message is read after the phase");
  assert.ok(finalCallAt > activeAt, "the deferred updater receives the recorded active user message id");
  assert.equal((APP_SOURCE.match(/applyFinalForTab\(targetTabFor\(/g) ?? []).length, 3);
  assert.match(APP_SOURCE, /setItems\(\(prev\) => applyToolEnd\(prev, event\), event\.sessionId\)/);
  assert.match(APP_SOURCE, /applyFinalForTab\(tabId, ticket\.sessionId, \{ kind: "session-end", ok: false, cancelled: true \}\)/);
  assert.match(APP_SOURCE, /applyFinalForTab\(target, event\.sessionId, \{/);
  assert.match(APP_SOURCE, /kind: "run-end",/);
  assert.match(APP_SOURCE, /kind: "goal-action", action/);
  assert.match(APP_SOURCE, /kind: "session-end", ok: event\.ok, cancelled: event\.cancelled === true \|\| userStopped/);
  assert.match(APP_SOURCE, /runningToolName\(items, sidecarDead\)/);
  assert.match(APP_SOURCE, /toolsUnconfirmed\(items, sidecarDead\)/);
  assert.match(APP_SOURCE, /\.\.\.\(item\.interrupted === true \? \{ interrupted: true \} : \{\}\)/);
  assert.match(
    APP_SOURCE,
    /parentTurnLine\(\{\s*hasActiveChild,\s*toolsUnconfirmed: unconfirmedTools,\s*current: turnStatus\(/,
    "the parent line must receive the unconfirmed flag so an active child cannot hide it",
  );
  assert.match(APP_SOURCE, /const activeTabRunning = tabRuns\[activeChat\.id\]\?\.running === true;/);
  assert.match(
    APP_SOURCE,
    /hasActiveChild \|\| unconfirmedTools \|\| activeTabRunning/,
    "the parent turn line follows the visible tab's own running state",
  );
  assert.doesNotMatch(APP_SOURCE, /runningToolName\(items, hostPhase\)/);

  const exitAt = APP_SOURCE.indexOf("await onSidecarExit((payload) => {");
  const exitEnd = APP_SOURCE.indexOf("hostExitNotice(hostStoppedByUserRef.current)", exitAt);
  assert.ok(exitAt >= 0 && exitEnd > exitAt);
  const exitBody = APP_SOURCE.slice(exitAt, exitEnd);
  assert.match(exitBody, /setSidecarDead\(true\)/);
  assert.doesNotMatch(exitBody, /applyTurnFinal|applyFinalForTab|turnFinalByUserId/);
});

test("all three history consumers seed final turns and read-only history is not projected", () => {
  assert.equal((APP_SOURCE.match(/historicalTurnFinalByUserId\(items\)/g) ?? []).length, 3);
  assert.equal((APP_SOURCE.match(/turnFinalWithoutUser: true/g) ?? []).length, 3);
  const history = readFileSync(new URL("../../src/client-huaanwork/HistoryDetailPane.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(history, /ToolPanel|projectToolPanels/);
});

test("the history pane keeps the continue action on an error view", () => {
  const history = readFileSync(new URL("../../src/client-huaanwork/HistoryDetailPane.tsx", import.meta.url), "utf8");
  assert.match(history, /\{canResume \? \(/);
  assert.doesNotMatch(history, /canResume && !view\.error/);
});

test("resumeHistorySession retries opening an empty error view", () => {
  const start = APP_SOURCE.indexOf("async function resumeHistorySession(");
  const end = APP_SOURCE.indexOf("async function removeSession(", start);
  assert.ok(start >= 0 && end > start, "resumeHistorySession is still followed by removeSession");
  const body = APP_SOURCE.slice(start, end);
  assert.match(body, /view\.records\.length === 0/);
  assert.match(body, /openFreeSession\(view\.sessionId\)/);
  assert.match(body, /resumeFromView\(\{ \.\.\.view, error: undefined \}\)/);
});

test("App projects only the final chat rows and persists panel toggle on the anchor item", () => {
  assert.match(APP_SOURCE, /const toolRows = useMemo\(\(\) => projectToolPanels\(items, \{/);
  assert.match(APP_SOURCE, /contentItems: contentView/);
  assert.match(APP_SOURCE, /turnFinalByUserId: activeChat\.turnFinalByUserId/);
  assert.match(APP_SOURCE, /turnFinalWithoutUser: activeChat\.turnFinalWithoutUser/);
  assert.match(APP_SOURCE, /connectionLost: sidecarDead/);
  assert.match(APP_SOURCE, /withToolPanelToggle\(tab\.items, anchorId, next\)/);
  assert.match(APP_SOURCE, /toolRows\.map\(\(row\) =>/);
  assert.doesNotMatch(APP_SOURCE, /items\.map\(\(item, index\) => \(\s*<ChatRow/);
  assert.match(APP_SOURCE, /turnChecks\(contentItems\(items\), turnUserId\)/);
  assert.match(APP_SOURCE, /insertBeforeToolRow\(prev, ask, event\.callId\)/);
});

/** 按函数名切片：锚到下一段已知定义，避免固定字符窗口随注释增长失去意义。 */
function functionBody(startNeedle: string, endNeedle: string): string {
  const start = APP_SOURCE.indexOf(startNeedle);
  const end = APP_SOURCE.indexOf(endNeedle, start);
  assert.ok(start >= 0, `${startNeedle} is still defined`);
  assert.ok(end > start, `${startNeedle} is still followed by ${endNeedle}`);
  return APP_SOURCE.slice(start, end);
}

test("background automations no longer lock project navigation", () => {
  // 拆除自动化全局锁：点项目、点子任务、新建项目都不再早退。
  assert.doesNotMatch(functionBody("async function selectSubtask(", "async function renameSubtask("), /automationActiveRef/);
  assert.doesNotMatch(functionBody("async function createProjectFlow(", "async function confirmCreateProject("), /automationActiveRef/);
  assert.doesNotMatch(functionBody("async function openProjectById(", "async function rebindTabSession("), /automationActiveRef/);
  // 项目列表与「新建项目」只按 sidecar 存活/选择在飞禁用，自动化在跑不再禁用。
  assert.doesNotMatch(APP_SOURCE, /disabled=\{runningAutomationIds\.size > 0 \|\| sidecarDead\}/);
  assert.doesNotMatch(APP_SOURCE, /disabled=\{runningAutomationIds\.size > 0 \|\| sidecarDead \|\| selectBusy\}/);
  assert.match(APP_SOURCE, /disabled=\{sidecarDead \|\| selectBusy\}/);
});

test("send carries the tab id and selected model and mints under the tab's own root", () => {
  const body = functionBody("async function send()", "async function stopTurn(");
  // 后台任务不再挡住发送；发送前的整段工作区对齐只为铸造会话，已由 session.new 的 cwd 取代。
  assert.doesNotMatch(body, /automationActiveRef/);
  assert.doesNotMatch(body, /ensureNeutralWorkspace\(\)/);
  assert.doesNotMatch(body, /alignWorkspaceOnly\(/);
  // 在途发送按标签 id 挡重入：只挡同一标签，不挡另一个标签。
  assert.match(body, /if \(sendingRef\.current\.has\(chatId\)\) return;/);
  assert.match(body, /sendingRef\.current\.add\(chatId\)/);
  assert.match(body, /sendingRef\.current\.delete\(chatId\)/);
  // cwd 只属于这条新会话：标签已有项目用项目根，未绑定用中立根。
  assert.match(body, /const cwd = await sessionCwdForTab\(sendingTab\);/);
  assert.match(body, /"session\.new", \{\s*fresh: chatId !== "work-1",\s*\.\.\.\(cwd \? \{ cwd \} : \{\}\),/);
  // 发送参数带当前标签 id、所选 modelId，以及本次 skill 或 at。
  assert.match(body, /tabId: chatId,/);
  assert.match(body, /const modelId = resolveSendModelId\(modelPickByTab, chatId, sendingTask\?\.modelId, activeModelId\);/);
  assert.match(body, /\.\.\.\(modelId \? \{ modelId \} : \{\}\),/);
  assert.match(body, /\{ at: \{ name: invokedAt\.name, clientMessageId: String\(userMsg\.id\) \} \}/);
  assert.match(body, /\{ skill: invokedSkill\.name \}/);
});

test("a neutral tab does not send when session.new fails", () => {
  const body = functionBody("async function send()", "async function stopTurn(");
  const mintAt = body.indexOf('"session.new"');
  const sendAt = body.indexOf('await rpcCall<SessionSendResult>("session.send"');
  assert.ok(mintAt >= 0 && sendAt > mintAt);
  const between = body.slice(mintAt, sendAt);
  // 接线钉：catch 调用抽出的判定函数，随后 return。catch 内不再有分支。
  assert.match(
    between,
    /catch \(error\) \{\s*noteActive\(sessionMintFailureNote\(\{ error, tabProjectId: sendingTab\?\.projectId \}\)\);\s*return;\s*\}/,
  );
  // 不得退回改造前的空 catch。
  assert.doesNotMatch(between, /catch \{\s*sessionId = undefined;\s*\}/);
  // 草稿清空必须在这个 return 之后：否则「失败时草稿留存」不成立。
  assert.ok(
    between.indexOf("setDraft(") > between.indexOf("sessionMintFailureNote"),
    "setDraft must come after the mint-failure return",
  );
  // 调用点留着而导入被删时，这条先变红（源码层面兜住）。
  assert.match(
    APP_SOURCE,
    /import \{[^}]*sessionMintFailureNote[^}]*\} from "\.\/logic\/concurrentTurn\.ts";/,
  );
});

test("send records the id it actually sends before the RPC so the next send keeps it", () => {
  // P-1：宿主在 followup 之后才把 modelId 写回任务，刷新前改全局模型会把新 id 写进会话绑定。
  // 发送前把实际送出的 id 记进本标签的选择，下一次发送就按这个 id 走。
  const body = functionBody("async function send()", "async function stopTurn(");
  const resolveAt = body.indexOf("const modelId = resolveSendModelId(");
  const recordAt = body.indexOf(
    "setModelPickByTab((prev) => (prev[chatId] === modelId ? prev : { ...prev, [chatId]: modelId }))",
  );
  const sendAt = body.indexOf('await rpcCall<SessionSendResult>("session.send"');
  assert.ok(resolveAt >= 0, "send still resolves the model it will send");
  assert.ok(recordAt > resolveAt, "the sent id is recorded after it is resolved");
  assert.ok(sendAt > recordAt, "the id is recorded before the session.send RPC leaves the client");

  // 只有非空 id 才记：没有可送模型时不能把空串写成本标签的选择。
  // 守卫与写入一起匹配：没有守卫的裸 setModelPickByTab 不算通过。
  const beforeSend = body.slice(resolveAt, sendAt);
  assert.match(
    beforeSend,
    /if \(modelId\) \{\s*setModelPickByTab\(\(prev\) => \(prev\[chatId\] === modelId \? prev : \{ \.\.\.prev, \[chatId\]: modelId \}\)\);\s*\}/,
    "the setter is wrapped in the truthiness guard so an empty id is never recorded as a pick",
  );
  assert.equal(
    (beforeSend.match(/setModelPickByTab\(/g) ?? []).length,
    1,
    "send records exactly one pick before the RPC: the id it sends",
  );
});

test("an unsent turn's pick is restored to the pre-send value, unless the user already picked anew", () => {
  const picks = { "work-2": "sent-model", "work-3": "other-model" };
  const restored = AppModule.restoreModelPick(picks, "work-2", "sent-model", "previous-model");
  assert.deepEqual(
    restored,
    { "work-2": "previous-model", "work-3": "other-model" },
    "the unsent turn's own pick goes back to what the tab had before the send",
  );

  // 发送前没有选择：还原成「没有记录」，而不是留下这次送出的 id。
  const deleted = AppModule.restoreModelPick(picks, "work-2", "sent-model", undefined);
  assert.deepEqual(deleted, { "work-3": "other-model" }, "no previous pick means the record is dropped");
  assert.equal("work-2" in deleted, false);
  assert.deepEqual(
    AppModule.restoreModelPick(picks, "work-2", "sent-model", ""),
    { "work-3": "other-model" },
    "an empty previous pick is treated as no pick",
  );

  // 发送前就是同一个 id：记录本来就对，不制造无意义的状态更新。
  assert.equal(
    AppModule.restoreModelPick(picks, "work-2", "sent-model", "sent-model"),
    picks,
    "restoring the same id changes nothing",
  );
  // 发送在飞期间用户换了选择：回滚不能把新选择一起撤掉。
  const newer = { "work-2": "newer-model" };
  assert.equal(
    AppModule.restoreModelPick(newer, "work-2", "sent-model", "previous-model"),
    newer,
    "a newer pick is preserved",
  );
  // 没有可撤的 id 时原样返回同一个对象，不制造无意义的状态更新。
  assert.equal(AppModule.restoreModelPick(picks, "work-2", undefined, "previous-model"), picks, "an undefined sent id rolls nothing back");
  assert.equal(AppModule.restoreModelPick(picks, "work-2", "", "previous-model"), picks, "an empty sent id rolls nothing back");
  assert.equal(AppModule.restoreModelPick(picks, "work-9", "sent-model", "previous-model"), picks, "another tab's pick is untouched");
});

test("the send rejection path rolls the recorded pick back through the helper", () => {
  const body = functionBody("async function send()", "async function stopTurn(");
  const sendAt = body.indexOf('await rpcCall<SessionSendResult>("session.send"');
  assert.ok(sendAt >= 0, "send still awaits the session.send response");
  const catchAt = body.indexOf("} catch (error) {", sendAt);
  assert.ok(catchAt > sendAt, "the session.send rejection path is still present");
  const catchBlock = body.slice(catchAt, body.indexOf("} finally {", catchAt));
  assert.match(catchBlock, /dropPending\(pending\)/);
  // 失败路径必须经 helper 还原本次送出 id 的记录（发送前的选择，没有则删掉）；
  // 用户已换的新选择由 helper 保留。
  assert.match(
    catchBlock,
    /setModelPickByTab\(\(prev\) => restoreModelPick\(prev, chatId, modelId, previousModelPick\)\)/,
  );
});

test("every non-starting send path rolls the implicit pick back, a started one keeps it", () => {
  const body = functionBody("async function send()", "async function stopTurn(");
  const sendAt = body.indexOf('await rpcCall<SessionSendResult>("session.send"');
  assert.ok(sendAt >= 0, "send still awaits the session.send response");
  // 发送前的选择要在写入本次选择之前记下：回滚只能还原到那个值。
  const previousAt = body.indexOf("const previousModelPick = modelPickByTab[chatId];");
  const recordAt = body.indexOf("setModelPickByTab((prev) => (prev[chatId] === modelId ? prev : { ...prev, [chatId]: modelId }))");
  assert.ok(previousAt >= 0, "send captures the tab's pick before the send");
  assert.ok(previousAt < recordAt, "the pre-send pick is captured before this send's pick is recorded");

  // started: false（没开始也没排队）也回滚，而不是只标 notStarted。
  const notStartedAt = body.indexOf("} else if (!sent.started) {");
  assert.ok(notStartedAt > sendAt, "the started:false branch is still present");
  const notStartedEnd = body.indexOf("if (sendOpensTurn(sent)) {", notStartedAt);
  // 结束锚点必须真实存在且在起点之后:门一旦被删/改名,切片会一路吃到 catch 或函数尾,
  // 断言就可能靠别的分支通过。
  assert.ok(
    notStartedEnd > notStartedAt,
    "the started:false branch still ends at the sendOpensTurn gate",
  );
  const notStartedBlock = body.slice(notStartedAt, notStartedEnd);
  assert.match(
    notStartedBlock,
    /setModelPickByTab\(\(prev\) => restoreModelPick\(prev, chatId, modelId, previousModelPick\)\)/,
    "a response that neither started nor queued the turn rolls its pick back",
  );
  // 排队中失败/取消走归属记录里的模型与发送前选择；归属记录本身也要带上这两项。
  assert.match(
    body,
    /queueOwnersRef\.current\.set\(queueItemId, \{\s*tabId: chatId,\s*userId: userMsg\.id,\s*\.\.\.\(modelId \? \{ modelId \} : \{\}\),\s*\.\.\.\(previousModelPick \? \{ previousModelPick \} : \{\}\),\s*\}\)/,
    "the queue owner carries the sent model and the pre-send pick",
  );
  assert.match(
    APP_SOURCE,
    /function rollbackQueuedModelPick\(queueItemId: string\): void \{\s*const owner = queueOwnersRef\.current\.get\(queueItemId\);\s*if \(!owner\) return;\s*const owners = new Map\(Array\.from\(queueOwnersRef\.current, \(\[id, entry\]\) => \[id, \{ \.\.\.entry \}\]\)\);\s*restoreQueuedModelPick\(\{\}, queueOwnersRef\.current, queueItemId\);\s*setModelPickByTab\(\(prev\) => restoreQueuedModelPick\(prev, owners, queueItemId\)\);\s*\}/,
    "the queued rollback hands off synchronously on queueOwnersRef and restores through the queue-aware helper",
  );

  const failBody = functionBody("function failQueuedTurn(", "function discardBufferedStopEnds(");
  const failRollbackAt = failBody.indexOf("rollbackQueuedModelPick(queueItemId)");
  const failClearAt = failBody.indexOf("clearQueueItem(tabId, queueItemId, \"unstarted\")");
  assert.ok(failRollbackAt >= 0, "a failed queue item rolls its pick back");
  assert.ok(failRollbackAt < failClearAt, "the owner is read before clearQueueItem drops it");

  const cancelBody = functionBody("async function cancelWaiting(", "async function stopTurn(");
  const cancelRollbackAt = cancelBody.indexOf("rollbackQueuedModelPick(queueItemId)");
  const cancelClearAt = cancelBody.indexOf("clearQueueItem(tabId, queueItemId, \"unstarted\")");
  assert.ok(cancelRollbackAt >= 0, "cancelling a waiting message rolls its pick back");
  assert.ok(cancelRollbackAt < cancelClearAt, "the owner is read before clearQueueItem drops it");

  // 出队真正开始（queue-start）不回滚：宿主这时已经把模型写回任务。
  assert.doesNotMatch(
    functionBody("function beginQueuedTurn(", "function failQueuedTurn("),
    /restoreModelPick|restoreQueuedModelPick/,
    "a dequeued turn keeps the pick it was sent with",
  );
});

test("rolling back an earlier queued send keeps a later queued send's pick and hands off the pre-queue baseline", () => {
  // 1. 标签原本无选择（previousModelPick: undefined），连续排队 q1、q2（同为 m1）：
  //    先取消/失败 q1 时保留 picks["work-2"] === "m1"，并把 undefined 基准交接给 q2；
  //    随后 q2 也取消/失败时删掉 picks["work-2"]，恢复 q1 之前的空基准。
  const ownersWithoutBaseline = new Map<string, AppModule.QueuedModelOwner>([
    ["q1", { tabId: "work-2", userId: 1, modelId: "m1" }],
    ["q2", { tabId: "work-2", userId: 2, modelId: "m1", previousModelPick: "m1" }],
  ]);
  const initialPicks = { "work-2": "m1", "work-3": "other-model" };
  const afterQ1Cancelled = AppModule.restoreQueuedModelPick(initialPicks, ownersWithoutBaseline, "q1");
  assert.equal(afterQ1Cancelled, initialPicks, "q2 is still queued with m1 so the tab pick stays m1");
  assert.equal(afterQ1Cancelled["work-2"], "m1");
  assert.equal(
    ownersWithoutBaseline.get("q2")?.previousModelPick,
    undefined,
    "q1 hands its undefined pre-queue baseline off to q2",
  );
  assert.equal("previousModelPick" in (ownersWithoutBaseline.get("q2") ?? {}), false);

  ownersWithoutBaseline.delete("q1");
  const afterQ2Cancelled = AppModule.restoreQueuedModelPick(afterQ1Cancelled, ownersWithoutBaseline, "q2");
  assert.deepEqual(
    afterQ2Cancelled,
    { "work-3": "other-model" },
    "cancelling q2 afterwards drops work-2 back to the pre-q1 empty baseline",
  );
  assert.equal("work-2" in afterQ2Cancelled, false);

  // 2. 标签原本已选 m0（previousModelPick: "m0"），连续排队 q1、q2（同为 m1）：
  //    先取消/失败 q1 保留 "m1" 并把 "m0" 交接给 q2；随后取消/失败 q2 还原为 "m0"。
  const ownersWithM0 = new Map<string, AppModule.QueuedModelOwner>([
    ["q1", { tabId: "work-2", userId: 1, modelId: "m1", previousModelPick: "m0" }],
    ["q2", { tabId: "work-2", userId: 2, modelId: "m1", previousModelPick: "m1" }],
  ]);
  const afterQ1WithM0 = AppModule.restoreQueuedModelPick(initialPicks, ownersWithM0, "q1");
  assert.equal(afterQ1WithM0, initialPicks, "q2 still needs m1 while waiting");
  assert.equal(
    ownersWithM0.get("q2")?.previousModelPick,
    "m0",
    "q1 hands its m0 baseline off to q2",
  );

  ownersWithM0.delete("q1");
  const afterQ2WithM0 = AppModule.restoreQueuedModelPick(afterQ1WithM0, ownersWithM0, "q2");
  assert.deepEqual(
    afterQ2WithM0,
    { "work-2": "m0", "work-3": "other-model" },
    "cancelling q2 afterwards restores the pre-q1 m0 baseline",
  );

  // 3. 不同模型排队（q1: m1/previous m0，q2: m2/previous m1）：
  //    先取消/失败 q1 保留 m2 并把 m0 交接给 q2；随后取消/失败 q2 还原为 m0。
  const ownersDifferentModels = new Map<string, AppModule.QueuedModelOwner>([
    ["q1", { tabId: "work-2", userId: 1, modelId: "m1", previousModelPick: "m0" }],
    ["q2", { tabId: "work-2", userId: 2, modelId: "m2", previousModelPick: "m1" }],
  ]);
  const picksWithM2 = { "work-2": "m2", "work-3": "other-model" };
  const afterQ1Diff = AppModule.restoreQueuedModelPick(picksWithM2, ownersDifferentModels, "q1");
  assert.equal(afterQ1Diff, picksWithM2, "q2 already switched the tab to m2 so cancelling q1 keeps m2");
  assert.equal(
    ownersDifferentModels.get("q2")?.previousModelPick,
    "m0",
    "q1 still hands its m0 baseline off to q2",
  );

  ownersDifferentModels.delete("q1");
  const afterQ2Diff = AppModule.restoreQueuedModelPick(afterQ1Diff, ownersDifferentModels, "q2");
  assert.deepEqual(
    afterQ2Diff,
    { "work-2": "m0", "work-3": "other-model" },
    "cancelling q2 afterwards restores the pre-q1 m0 baseline",
  );

  // 4. 交替模型排队（q1: m1 -> q2: m2 -> q3: m1）：先取消末尾的 q3 时不能被更早的 q1 挡住，必须还原为 q2 的 m2。
  const ownersAlternating = new Map<string, AppModule.QueuedModelOwner>([
    ["q1", { tabId: "work-2", userId: 1, modelId: "m1", previousModelPick: "m0" }],
    ["q2", { tabId: "work-2", userId: 2, modelId: "m2", previousModelPick: "m1" }],
    ["q3", { tabId: "work-2", userId: 3, modelId: "m1", previousModelPick: "m2" }],
  ]);
  const afterQ3Cancelled = AppModule.restoreQueuedModelPick(initialPicks, ownersAlternating, "q3");
  assert.deepEqual(
    afterQ3Cancelled,
    { "work-2": "m2", "work-3": "other-model" },
    "cancelling the tail q3 restores q2's m2 even though an earlier q1 also used m1",
  );
});

test("a started or queued send refreshes tasks so the host's task-model write-back lands", () => {
  const body = functionBody("async function send()", "async function stopTurn(");
  const sendAt = body.indexOf('await rpcCall<SessionSendResult>("session.send"');
  assert.ok(sendAt >= 0, "send still awaits the session.send response");
  const catchAt = body.indexOf("} catch (error) {", sendAt);
  assert.ok(catchAt > sendAt, "the session.send rejection path is still present");
  assert.doesNotMatch(
    body.slice(0, sendAt),
    /refreshTasks\(/,
    "no task refresh before the response says the turn started or queued",
  );
  assert.match(
    body.slice(sendAt, catchAt),
    /if \(sent\.started === true \|\| sent\.waiting === true\) void refreshTasks\(\);/,
    "a started or queued response refreshes the task list so views without a recorded pick see the task model",
  );

  // 出队 start 的模型写回发生在 queue-start 之后：beginQueuedTurn 开回合后再拉一次任务列表。
  const beginBody = functionBody("function beginQueuedTurn(", "function failQueuedTurn(");
  const openAt = beginBody.indexOf("openTurnForTab(tabId, sessionId, userId)");
  const refreshAt = beginBody.indexOf("void refreshTasks()");
  assert.ok(openAt >= 0, "the queued start still opens the turn");
  assert.ok(refreshAt > openAt, "the dequeue refresh runs after the turn opens");
});

test("a mint uses the tab project root, else the neutral root read from workspace.close", () => {
  assert.match(
    APP_SOURCE,
    /const sendModelId = resolveSendModelId\(modelPickByTab, activeChat\.id, activeTabTask\?\.modelId, activeModelId\);/,
  );
  const cwdBody = functionBody("async function sessionCwdForTab(", "async function bindDefaultTabSessions(");
  assert.match(cwdBody, /projects\.find\(\(item\) => item\.id === tab\.projectId\)/);
  assert.match(cwdBody, /return neutralWorkspaceRoot\(\)/);
  // 中立根只有 workspace.close 一条查询路径；取到即缓存，且不把应答写进前台工作区状态。
  const neutralBody = functionBody("async function neutralWorkspaceRoot(", "async function sessionCwdForTab(");
  assert.match(neutralBody, /"workspace\.close"/);
  assert.match(neutralBody, /neutralRootRef\.current = root/);
  assert.doesNotMatch(neutralBody, /setWorkspace\(/);
});

test("the composer model chip picks the tab model and persists it on a bound task", () => {
  assert.match(APP_SOURCE, /activeId=\{sendModelId\}/);
  assert.match(APP_SOURCE, /onSelect=\{\(id\) => void selectTabModel\(id\)\}/);
  const body = functionBody("async function selectTabModel(", "async function applyThemePref(");
  // 选择先记在本标签；已有子任务时经 Task 9 的 task.setModel 写回，不切全局当前模型。
  assert.match(body, /setModelPickByTab\(\(prev\) => \(\{ \.\.\.prev, \[tab\.id\]: id \}\)\)/);
  assert.match(body, /if \(!tab\.taskId\) return;/);
  assert.match(body, /await setTaskModel\(\{ taskId: tab\.taskId, modelId: id \}\)/);
  assert.match(body, /setProjectTasks\(\(prev\) => prev\.map\(\(task\) => \(task\.id === saved\.task\.id \? saved\.task : task\)\)\)/);
  assert.doesNotMatch(body, /settings\.set/);
});

/**
 * 从 `source` 里 `startNeedle` 之后的第一处 `{` 开始按花括号配对取出整块。
 * 只用于不含模板字符串/正则字面量的函数体；注释里不写花括号。
 */
function blockAfter(source: string, startNeedle: string): { start: number; body: string } {
  const at = source.indexOf(startNeedle);
  assert.ok(at >= 0, `${startNeedle} is still present`);
  const open = source.indexOf("{", at);
  assert.ok(open >= 0, `${startNeedle} is followed by a block`);
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i];
    if (quote !== null) {
      if (ch === "\\") i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return { start: open, body: source.slice(open + 1, i) };
    }
  }
  assert.fail(`${startNeedle} block is unterminated`);
}

test("a queued send preserves the running turn stop latch", () => {
  const body = functionBody("async function send()", "async function stopTurn(");
  // 进程级单槽早退已删除：发送不再被另一个标签的回合挡住，也不在应答前自称执行中。
  assert.doesNotMatch(body, /turnActive/);
  const sendAt = body.indexOf('await rpcCall<SessionSendResult>("session.send"');
  const stateAt = body.indexOf("writeTabRun(chatId, (state) => noteSendResult(state, sent))");
  const gateAt = body.indexOf("if (sendOpensTurn(sent)) {");
  assert.ok(sendAt >= 0, "send still awaits the session.send response");
  assert.ok(stateAt > sendAt, "the tab's run state is written from the response");
  assert.ok(gateAt > stateAt, "the start branch runs after noteSendResult");

  // epoch、turn-started、活动消息、进度与闩锁清理全部只在 started 初始化里：排队应答碰不到执行中的回合。
  const gate = blockAfter(body, "if (sendOpensTurn(sent)) {").body;
  assert.match(gate, /openTurnForTab\(/, "the started-only branch opens the turn through the single init point");
  assert.equal(
    (body.match(/openTurnForTab\(/g) ?? []).length,
    1,
    "send() has exactly one turn-opening call site",
  );
  const openBody = functionBody("function openTurnForTab(", "function clearQueueItem(");
  for (const needle of [
    "epoch: tabTurnOf(tabId).epoch + 1",
    "activeUserId: userId",
    "stopSessionId: null",
    "latchOwner: null",
    "stopping: false",
    'kind: "turn-started"',
    "setTurnPulseByTab(",
  ]) {
    assert.ok(openBody.includes(needle), `${needle} stays inside the started-only init`);
  }
  const beforeResponse = body.slice(0, gateAt);
  for (const needle of ["epoch:", "turn-started", "setTurnPulseByTab(", "stopSessionId", "latchOwner"]) {
    assert.ok(!beforeResponse.includes(needle), `${needle} is not written before the started branch`);
  }

  // 排队只追加等待项，执行中的标签保持 running；不开始回合就不发 turn-started。
  assert.equal(sendOpensTurn({ waiting: true, started: false }), false);
  assert.deepEqual(
    noteSendResult({ running: true, waitingIds: [] }, { waiting: true, started: false, queueItemId: "q1" }),
    { running: true, waitingIds: ["q1"] },
  );

  // 停止票据按标签自己的代际扣闩：另一个标签的排队不影响 A 的取消成功。
  const armed = finishStop({
    ticket: { id: 1, sessionId: "a-session", epoch: 1 },
    pending: { id: 1, sessionId: "a-session", epoch: 1 },
    currentEpoch: 1,
    ok: true,
    latchOwner: null,
  });
  assert.equal(armed.arm, true);
  assert.deepEqual(armed.stale, { sessionId: "a-session", epoch: 1 });
  const stopBody = functionBody("async function stopTurn(", "async function stopAutomationWithReconcile(");
  assert.match(stopBody, /const turn = tabTurnOf\(tabId\);/);
  assert.match(stopBody, /const ticket: StopTicket = \{ id: stopSeqRef\.current \+ 1, sessionId, epoch: turn\.epoch \};/);
  // A 的结束仍记成用户停止：闩锁按该会话自己的标签读取，也只释放它自己那份。
  assert.match(
    APP_SOURCE,
    /const userStopped = event\.event === "session\/end"[\s\S]*?stopOwnerForSession\(eventSessionId\)\?\.turn\.stopSessionId === eventSessionId/,
  );
  assert.match(
    APP_SOURCE,
    /const owner = stopOwnerForSession\(eventSessionId\);\s*if \(owner !== undefined\) patchTabTurn\(owner\.tabId, \{ stopSessionId: null, stopping: false \}\);/,
  );
});

test("a goal intermediate end keeps the tab running", () => {
  // 相位仍 active 的结束是续轮中间结束：状态机不写结论，App 也不清执行态。
  let state = reduceGoalTurn(INITIAL_GOAL_TURN_STATE, { kind: "turn-started", sessionId: "s" }).state;
  state = reduceGoalTurn(state, { kind: "goal-state", phase: "active", sessionId: "s" }).state;
  const ended = reduceGoalTurn(state, { kind: "session-end", sessionId: "s", ok: true });
  assert.deepEqual(ended.action, { kind: "none" }, "an active goal round never settles on the round end");
  assert.equal(ended.state.phases.s, "active", "the goal phase is still active after the intermediate end");

  assert.match(
    APP_SOURCE,
    /const goalIntermediate = event\.event === "session\/end"[\s\S]*?event\.ok[\s\S]*?event\.cancelled !== true[\s\S]*?!userStopped[\s\S]*?goalTurnRef\.current\.phases\[eventSessionId \?\? ""\] === "active";/,
  );
  assert.match(
    APP_SOURCE,
    /const endsTrackedTurn = event\.event === "session\/end"[\s\S]*?!goalIntermediate[\s\S]*?&& endTurn\.sessionId === eventSessionId;/,
    "an intermediate end must not clear the tab's running state",
  );
  // 停止按钮与进度条读该标签自己的执行态；另一个标签的回合不影响它。
  assert.match(APP_SOURCE, /tabRuns\[activeChat\.id\]\?\.running === true \? \(/);
  // 续轮只恢复事件所属标签的执行态。
  assert.match(APP_SOURCE, /if \(drivesTrackedTurn\) setTurnRunning\(true, event\.sessionId\);/);
  assert.match(APP_SOURCE, /const goalRoundTab = event\.event === "goal\/round" \? turnTabForSession\(eventSessionId\) : undefined;/);
  assert.match(
    APP_SOURCE,
    /const goalRoundDrives = goalRoundTab !== undefined && tabTurnOf\(goalRoundTab\)\.sessionId === eventSessionId;/,
  );
  assert.doesNotMatch(APP_SOURCE, /goalRoundDrivesTurn\(/);
});

test("stale idle uses the event tab epoch", () => {
  // 同一张停止票据：按标签自己的代际判定会扣闩；拿另一个标签的当前代际判定会被当成旧回合。
  const ticket = { id: 7, sessionId: "a", epoch: 1 };
  const own = finishStop({ ticket, pending: ticket, currentEpoch: 1, ok: true, latchOwner: null });
  const otherTab = finishStop({ ticket, pending: ticket, currentEpoch: 2, ok: true, latchOwner: null });
  assert.equal(own.arm, true);
  assert.equal(own.stale?.epoch, 1);
  assert.equal(otherTab.arm, false, "another tab's epoch must not decide this turn's stop");
  assert.deepEqual(otherTab.stale, { sessionId: "a", epoch: 1 });

  // 旧结束只按自己标签的代际消费：另一个标签推进代际不影响这条结束。
  const marker = [{ sessionId: "a", epoch: 1 }];
  assert.deepEqual(consumeStaleIdle(marker, { sessionId: "a" }, 1), { drop: false, stale: [] });
  assert.deepEqual(consumeStaleIdle(marker, { sessionId: "a" }, 2), { drop: true, stale: [] });

  assert.match(
    APP_SOURCE,
    /const eventTabId = tabIdForSession\(event\.sessionId\);\s*const eventEpoch = tabTurnOf\(eventTabId\)\.epoch;/,
    "the stale-idle check reads the epoch of the tab that owns the event's session",
  );
  assert.match(APP_SOURCE, /consumeStaleIdle\(staleIdleRef\.current, event, eventEpoch\)/);
  assert.doesNotMatch(APP_SOURCE, /turnEpochRef/, "no process-wide epoch remains");
  // 造票据与收票据同样用这张标签自己的代际。
  assert.match(functionBody("async function stopTurn(", "async function stopAutomationWithReconcile("), /epoch: turn\.epoch/);
  assert.match(functionBody("function settleStop(", "function releaseHeldEnds("), /currentEpoch: turn\.epoch/);
});

test("a rejected send leaves the running turn stop latch", () => {
  const body = functionBody("async function send()", "async function stopTurn(");
  // 只取 session.send 的那个 catch：前面铸造子任务会话的 catch 不在这里。
  const sendAt = body.indexOf("const sent = await rpcCall<SessionSendResult>");
  assert.ok(sendAt >= 0, "send still awaits the session.send response");
  const catchAt = body.indexOf("} catch (error) {", sendAt);
  assert.ok(catchAt > sendAt, "the session.send rejection path is still present");
  const catchBody = blockAfter(body.slice(catchAt), "catch (error) {").body;
  // 本次消息标成未启动；失败原因仍然追加（停止闩锁扣着也追加，不提前 return）。
  assert.match(catchBody, /item\.kind === "user" && item\.id === userMsg\.id \? \{ \.\.\.item, sendRejected: true \} : item/);
  assert.match(catchBody, /items: \[\s*\.\.\.tab\.items\.map\([\s\S]*?\),\s*note,\s*\]/);
  assert.doesNotMatch(catchBody, /^\s*return;/m);
  // 仍执行中的标签不标 sessionFailed。
  assert.match(catchBody, /tabRunOf\(chatId\)\.running \? \{\} : \{ sessionFailed: true \}/);
  // 不清同标签正在执行回合的停止闩锁、stopping、epoch 或执行态。
  for (const needle of [
    "latchOwner",
    "stopSessionId",
    "stopping:",
    "stopping.current",
    "epoch:",
    "patchTabTurn(",
    "writeTabRun(",
    "turn-started",
    "setTurnPulseByTab(",
  ]) {
    assert.ok(!catchBody.includes(needle), `the catch must not touch ${needle}`);
  }

  const finallyBody = blockAfter(body, "} finally {").body;
  assert.match(finallyBody, /sendingRef\.current\.delete\(chatId\);/);
  assert.doesNotMatch(finallyBody, /patchTabTurn|writeTabRun|setChatTabs/);

  // 失败的消息不参与最新用户消息与终态选择：终态仍落在 A 的活动消息上。
  const items = [
    { id: 1, kind: "user" as const },
    { id: 2, kind: "user" as const, sendRejected: true },
  ];
  assert.equal(latestUserItemId(items), 1);
  const tabs = [{ id: "a", items, turnFinalByUserId: {}, turnFinalWithoutUser: false }];
  const settled = applyTurnFinalToTabs(tabs, "a", { kind: "session-end", ok: false, cancelled: true }, undefined, 1);
  assert.deepEqual(settled[0]?.turnFinalByUserId, { 1: true });
});

/** 本次发送在应答回来之前暂存早到事件的闸门（挂载期事件闭包里的一份声明）。 */
function earlyEventGate(): string {
  return functionBody(
    "const holdEarlyEvent = (incoming: RpcEvent): boolean => {",
    "if (holdEarlyEvent(event)) return;",
  );
}

test("queued send opens the goal window only when the turn starts", () => {
  const body = functionBody("async function send()", "async function stopTurn(");
  const sendAt = body.indexOf('await rpcCall<SessionSendResult>("session.send"');
  const gateAt = body.indexOf("if (sendOpensTurn(sent)) {");
  assert.ok(sendAt >= 0, "send still awaits the session.send response");
  assert.ok(gateAt > sendAt, "the turn only opens after the response says it started");
  assert.match(blockAfter(body, "if (sendOpensTurn(sent)) {").body, /openTurnForTab\(/);
  assert.doesNotMatch(
    body.slice(0, gateAt),
    /openTurnForTab\(/,
    "nothing opens a goal window or bumps the epoch before the started response",
  );

  // 唯一的初始化点：epoch、turn-started、活动消息与进度都在这里。
  const openBody = functionBody("function openTurnForTab(", "function clearQueueItem(");
  assert.match(openBody, /epoch: tabTurnOf\(tabId\)\.epoch \+ 1/);
  assert.match(openBody, /kind: "turn-started"/);
  assert.match(openBody, /activeUserId: userId/);
  assert.match(openBody, /setTurnPulseByTab\(/);
  assert.equal((openBody.match(/epoch:/g) ?? []).length, 1, "one turn start bumps the epoch exactly once");

  // queue-start 走同一段初始化，且在清掉等待文案之后。
  const queueBranchAt = APP_SOURCE.indexOf('if (event.event === "session/queue-start") {');
  assert.ok(queueBranchAt >= 0, "the queue-start branch is wired");
  assert.match(
    APP_SOURCE.slice(queueBranchAt),
    /beginQueuedTurn\(queueItemTab\(event\.queueItemId\) \?\? event\.tabId, event\.sessionId, event\.queueItemId\);/,
  );
  const beginBody = functionBody("function beginQueuedTurn(", "function failQueuedTurn(");
  const stateAt = beginBody.indexOf("queuedTurnRunState(state, queueItemId, userId !== undefined)");
  const openAt = beginBody.indexOf("openTurnForTab(tabId, sessionId, userId)");
  assert.ok(stateAt >= 0, "the queued turn settles its own waiting item through the shared state decision");
  assert.ok(openAt > stateAt, "the epoch and goal window open after the waiting item is consumed");
  const stateBody = functionBody("export function queuedTurnRunState(", "export function upsertTodoItem(");
  assert.match(stateBody, /noteWaitingStarted\(state, queueItemId\)/, "an owned start still sets the tab running");
});

test("a queued response backfills the inserted user message", () => {
  const body = functionBody("async function send()", "async function stopTurn(");
  const sendAt = body.indexOf('await rpcCall<SessionSendResult>("session.send"');
  const pendingAt = body.indexOf("pendingSendsRef.current.set(chatId, pending)");
  assert.ok(pendingAt >= 0 && pendingAt < sendAt, "the pending identity exists before the send leaves the client");
  const stateAt = body.indexOf("writeTabRun(chatId, (state) => noteSendResult(state, sent))");
  const backfillAt = body.indexOf('item.kind === "user" && item.id === userMsg.id ? { ...item, queueItemId } : item');
  assert.ok(stateAt > sendAt, "the tab's run state comes from the response");
  assert.ok(backfillAt > stateAt, "the queue item id is written back onto the already inserted message");
  assert.match(
    body,
    /queueOwnersRef\.current\.set\(queueItemId, \{\s*tabId: chatId,\s*userId: userMsg\.id,\s*\.\.\.\(modelId \? \{ modelId \} : \{\}\),\s*\.\.\.\(previousModelPick \? \{ previousModelPick \} : \{\}\),\s*\}\)/,
  );
  // 宿主没启动也没有排队项：这条消息只标 notStarted，不写等待、不占回合。
  assert.match(body, /} else if \(!sent\.started\) \{/);
  assert.match(body, /item\.kind === "user" && item\.id === userMsg\.id \? \{ \.\.\.item, notStarted: true \} : item/);

  // 等待文案挂在带 queueItemId 的那条用户消息上，不挂在标签级另一份列表。
  const rowAt = APP_SOURCE.indexOf("function ChatRow(");
  const rowEnd = APP_SOURCE.indexOf("\nfunction PlanCard(", rowAt);
  assert.ok(rowAt >= 0 && rowEnd > rowAt, "ChatRow is still a top-level component before PlanCard");
  const row = APP_SOURCE.slice(rowAt, rowEnd);
  assert.match(row, /if \(item\.queueItemId !== undefined\) \{/);
  assert.match(row, /等待当前任务/);
  assert.match(row, /onCancelWaiting\?\.\(queueItemId\)/);
  assert.match(APP_SOURCE, /onCancelWaiting=\{\(queueItemId\) => void cancelWaiting\(queueItemId\)\}/);

  // 等待消息的取消只带这条 queueItemId；停止按钮仍只停整条回合。
  const cancelBody = functionBody("async function cancelWaiting(", "async function stopTurn(");
  assert.match(cancelBody, /noteWaitingCancelled\(state, queueItemId\)/);
  assert.match(cancelBody, /await rpcCall\("session\.cancel", \{ queueItemId \}\);/);
  assert.doesNotMatch(cancelBody, /sessionId/);
  assert.match(functionBody("async function stopTurn(", "async function stopAutomationWithReconcile("), /await rpcCall\("session\.cancel", \{ sessionId \}\);/);
  assert.doesNotMatch(
    functionBody("async function stopTurn(", "async function stopAutomationWithReconcile("),
    /queueItemId/,
    "the composer stop never cancels a single waiting item",
  );

  // A 的终态仍落在 A 的活动消息上：后面那条等待消息与没启动的消息都不参与选择。
  const items = [
    { id: 1, kind: "user" as const },
    { id: 2, kind: "user" as const, queueItemId: "q1" },
    { id: 3, kind: "user" as const, notStarted: true },
  ];
  assert.equal(latestUserItemId(items), 1);
  const tabs = [{ id: "a", items, turnFinalByUserId: {}, turnFinalWithoutUser: false }];
  assert.deepEqual(
    applyTurnFinalToTabs(tabs, "a", { kind: "session-end", ok: true, cancelled: false }, undefined, 1)[0]?.turnFinalByUserId,
    { 1: true },
  );
});

test("queue fail does not duplicate the emitted notice", () => {
  const failBody = functionBody("function failQueuedTurn(", "function takePendingBuffer(");
  const removedAt = failBody.indexOf("noteWaitingFailed(state, queueItemId)");
  const sameAt = failBody.indexOf("if (lastAgentNoticeRef.current[tabId] === reason) {");
  const noteAt = failBody.indexOf("noteTab(tabId, reason);");
  assert.ok(removedAt >= 0, "the waiting item is dropped");
  assert.ok(sameAt > removedAt, "the duplicate check runs on the waiting item's own tab");
  assert.ok(noteAt > sameAt, "an identical agent/notice suppresses the second footnote");
  assert.match(failBody, /delete lastAgentNoticeRef\.current\[tabId\];/, "the notice is consumed once");
  assert.match(failBody, /noteTab\(tabId, reason\);/, "a recheck failure without a notice still shows its reason");
  assert.match(
    APP_SOURCE,
    /lastAgentNoticeRef\.current\[target\] = event\.text;/,
    "agent/notice records the text it appended",
  );
  // 只去掉这条等待，不把执行中的回合改成结束。
  assert.deepEqual(noteWaitingFailed({ running: true, waitingIds: ["q1"] }, "q1"), { running: true, waitingIds: [] });
});

test("a queue-failed user message does not hijack the previous turn outcome", () => {
  type Item = { id: number; kind: "user" | "assistant"; text: string; queueItemId?: string; notStarted?: boolean };
  // A 执行、B 排队：标签状态完全按 App 接线的顺序推一遍。
  let run = noteSendResult({ running: false, waitingIds: [] }, { waiting: false, started: true });
  run = noteSendResult(run, { waiting: true, started: false, queueItemId: "q1" });
  assert.deepEqual(run, { running: true, waitingIds: ["q1"] });
  let items: Item[] = [
    { id: 1, kind: "user", text: "A" },
    { id: 2, kind: "user", text: "B", queueItemId: "q1" },
  ];
  // B 出队复检失败：等待项消失，B 的消息留在列表里但标成未启动。
  run = noteWaitingFailed(run, "q1");
  items = items.map((item) => item.queueItemId === "q1" ? releaseWaitingItem(item, false) : item);
  assert.deepEqual(items[1], { id: 2, kind: "user", text: "B", queueItemId: undefined, notStarted: true });
  assert.deepEqual(run, { running: true, waitingIds: [] }, "a failed queue item never ends the running turn");

  // A 的 session/end：活动消息仍是 A，失败那条既不承载终态也不丢 A 的结论。
  const activeUserId = latestUserItemId(items);
  assert.equal(activeUserId, 1);
  const settled = applyTurnFinalToTabs(
    [{ id: "a", items, turnFinalByUserId: {}, turnFinalWithoutUser: false }],
    "a",
    { kind: "session-end", ok: true, cancelled: false },
    undefined,
    activeUserId,
  );
  assert.deepEqual(settled[0]?.turnFinalByUserId, { 1: true });
  const conclusion: Item = { id: 3, kind: "assistant", text: "结论" };
  assert.deepEqual(appendOutcomeNotes(items, activeUserId, [conclusion]), [...items, conclusion]);

  // 反证：同两条消息不标未启动时，B 会抢走「最新用户消息」，A 的结论被丢弃。
  const unmarked: Item[] = [
    { id: 1, kind: "user", text: "A" },
    { id: 2, kind: "user", text: "B" },
  ];
  assert.equal(latestUserItemId(unmarked), 2);
  assert.equal(appendOutcomeNotes(unmarked, 1, [conclusion]).length, 2, "without the mark the previous conclusion is lost");

  // 接线：出队失败按未启动收尾，出队开始去掉等待与插入时的未启动标记。
  assert.match(
    functionBody("function clearQueueItem(", "function beginQueuedTurn("),
    /outcome === "started" \? startUserItem\(item\) : releaseWaitingItem\(item, false\)/,
  );
  assert.match(
    functionBody("function failQueuedTurn(", "function takePendingBuffer("),
    /clearQueueItem\(tabId, queueItemId, "unstarted"\);/,
    "a queue failure keeps the message but marks it unstarted",
  );
  assert.match(
    functionBody("function beginQueuedTurn(", "function failQueuedTurn("),
    /clearQueueItem\(tabId, queueItemId\);/,
    "a queue item that really starts is not marked unstarted",
  );
});

test("a cancelled waiting message is not the latest user message", () => {
  type Item = { id: number; kind: "user"; text: string; queueItemId?: string; notStarted?: boolean };
  const waiting: Item[] = [
    { id: 1, kind: "user", text: "A" },
    { id: 2, kind: "user", text: "B", queueItemId: "q1" },
  ];
  // 用户取消：等待项撤掉，消息留在列表里但同样标成未启动。
  assert.deepEqual(noteWaitingCancelled({ running: true, waitingIds: ["q1"] }, "q1"), {
    running: true,
    waitingIds: [],
  });
  const cancelled = waiting.map((item) => item.queueItemId === "q1" ? releaseWaitingItem(item, false) : item);
  assert.equal(isUnstartedUserItem(cancelled[1] ?? {}), true);
  assert.equal(latestUserItemId(cancelled), 1, "the cancelled message never becomes the latest user message");
  const settled = applyTurnFinalToTabs(
    [{ id: "a", items: cancelled, turnFinalByUserId: {}, turnFinalWithoutUser: false }],
    "a",
    { kind: "session-end", ok: false, cancelled: true },
    undefined,
    latestUserItemId(cancelled),
  );
  assert.deepEqual(settled[0]?.turnFinalByUserId, { 1: true }, "the cancelled message cannot take A's terminal state");
  assert.match(
    functionBody("async function cancelWaiting(", "async function stopTurn("),
    /clearQueueItem\(tabId, queueItemId, "unstarted"\);/,
    "cancelling a waiting item marks its message unstarted",
  );
});

test("early session end is buffered until the started response", () => {
  const holdSource = earlyEventGate();
  assert.match(holdSource, /incoming\.event === "session\/end"/);
  assert.match(holdSource, /pendingSendOfSession\(sessionId\)/);
  const goalCheckAt = holdSource.indexOf("if (!isGoalEvent) return false;");
  const goalPushAt = holdSource.lastIndexOf("pending.buffered.push(incoming);");
  assert.ok(goalCheckAt >= 0, "only goal and end events take the buffering path");
  assert.ok(goalPushAt > goalCheckAt, "an early end does reach this send's buffer");

  const gateAt = APP_SOURCE.indexOf("if (holdEarlyEvent(event)) return;");
  assert.ok(gateAt >= 0, "the early-event gate is wired into the sidecar event handler");
  const stopGateAt = APP_SOURCE.indexOf('if (event.event === "session/end") {', gateAt);
  const heldAt = APP_SOURCE.indexOf("heldEndsRef.current.push(event);", gateAt);
  assert.ok(stopGateAt > gateAt, "the early end is held before the stop-ticket gate");
  assert.ok(heldAt > gateAt, "the early end never reaches the held-end queue while its send is pending");

  // 身份写回 → 初始化回合 → 重放；started:false 只丢本次缓冲。
  const body = functionBody("async function send()", "async function stopTurn(");
  const openAt = body.indexOf("openTurnForTab(");
  const replayAt = body.indexOf("for (const buffered of takePendingBuffer(pending, sent)) applySidecarEventRef.current(buffered);");
  assert.ok(openAt >= 0, "send opens the turn through the shared init point");
  assert.ok(replayAt > openAt, "buffered events replay after the identity is written and the window opens");
  const takeBody = functionBody("function takePendingBuffer(", "function dropPending(");
  assert.match(takeBody, /if \(sendOpensTurn\(sent\)\) return buffered;/);
  assert.match(takeBody, /return \[\];/, "a started:false response only discards this send's buffer");

  // 重放后的结束仍清 running，终态落在本次用户消息上。
  const running = noteSendResult({ running: false, waitingIds: [] }, { waiting: false, started: true });
  assert.equal(running.running, true);
  assert.deepEqual(noteTurnEnded(running), { running: false, waitingIds: [] });
});

test("early queue start is buffered until the queued response", () => {
  const holdSource = earlyEventGate();
  const knownAt = holdSource.indexOf("if (queueItemTab(incoming.queueItemId) !== undefined) return false;");
  const firstPushAt = holdSource.indexOf("pending.buffered.push(incoming);");
  assert.ok(knownAt >= 0, "a queue event that already matches a waiting message is handled immediately");
  assert.ok(firstPushAt > knownAt, "an unknown queue item is buffered only after that check");
  assert.match(holdSource, /pendingSendOfTab\(incoming\.tabId\)/, "queue events are buffered per tab");

  // 排队应答只重放与本条 queueItemId 一致的队列事件，其他未知 id 不得套用。
  const takeBody = functionBody("function takePendingBuffer(", "function dropPending(");
  assert.match(takeBody, /sent\.waiting && sent\.queueItemId !== undefined/);
  assert.match(takeBody, /event\.queueItemId === queueItemId/);
  assert.match(takeBody, /\(event\.event === "session\/queue-start" \|\| event\.event === "session\/queue-fail"\)/);

  // 重放 queue-start 之后：等待项清空、running 为真，两者不并存。
  const waiting = noteSendResult({ running: true, waitingIds: [] }, { waiting: true, started: false, queueItemId: "q1" });
  assert.deepEqual(waiting, { running: true, waitingIds: ["q1"] });
  const started = noteWaitingStarted(waiting, "q1");
  assert.deepEqual(started, { running: true, waitingIds: [] });
});

test("pending send does not buffer the previous turn events", () => {
  const holdSource = earlyEventGate();
  const runningGuardAt = holdSource.indexOf(
    "if (tabRunOf(pending.tabId).running && tabTurnOf(pending.tabId).sessionId === sessionId) return false;",
  );
  const lastPushAt = holdSource.lastIndexOf("pending.buffered.push(incoming);");
  assert.ok(runningGuardAt >= 0, "a running turn on the same session keeps its events out of the buffer");
  assert.ok(lastPushAt > runningGuardAt, "the running-turn guard runs before the goal events are buffered");

  // B 的 waiting 应答不撤销 A 的停止闩锁或终态。
  const body = functionBody("async function send()", "async function stopTurn(");
  const waitingBranch = blockAfter(body, "if (sent.waiting && sent.queueItemId !== undefined) {").body;
  for (const needle of ["patchTabTurn(", "stopSessionId", "latchOwner", "stopping", "writeTabRun("]) {
    assert.ok(!waitingBranch.includes(needle), `the waiting branch must not touch ${needle}`);
  }
  const a = { running: true, waitingIds: [] as string[] };
  assert.deepEqual(noteSendResult(a, { waiting: true, started: false, queueItemId: "qb" }), {
    running: true,
    waitingIds: ["qb"],
  });
  const ticket = { id: 3, sessionId: "a-session", epoch: 1 };
  const armed = finishStop({ ticket, pending: ticket, currentEpoch: 1, ok: true, latchOwner: null });
  assert.equal(armed.arm, true, "another tab's queued send leaves A's stop ticket armed");
});

test("a cross-tab running turn's session end is never buffered into another tab's pending send", () => {
  const holdSource = earlyEventGate();
  // 既有本标签规则不变:pending 自己的标签正在执行同会话上一回合时事件照常即时处理。
  const sameTabGuardAt = holdSource.indexOf(
    "if (tabRunOf(pending.tabId).running && tabTurnOf(pending.tabId).sessionId === sessionId) return false;",
  );
  assert.ok(sameTabGuardAt >= 0, "the same-tab running-turn guard is intact");

  // 最终评审 Important 1:标签 A 正在执行会话 S,标签 B 也绑定 S 并发送(同根排队)。
  // B 的应答未回时 A 的 session/end 到达:它属于 A 的执行中回合,必须照常即时结算。
  // 若被放进 B 的 pending 缓冲,B 的 waiting 应答只重放匹配 queueItemId 的队列事件,
  // A 的结束会被丢弃,A 永久 running。
  const crossTabLookupAt = holdSource.indexOf("const turnTab = turnTabForSession(sessionId);");
  assert.ok(crossTabLookupAt > sameTabGuardAt, "an any-tab turn lookup runs after the same-tab guard");
  const crossTabGuardAt = holdSource.indexOf(
    "if (turnTab !== undefined && tabRunOf(turnTab).running && tabTurnOf(turnTab).sessionId === sessionId) return false;",
  );
  assert.ok(crossTabGuardAt > crossTabLookupAt, "the any-tab guard judges the running turn via tabRunOf/tabTurnOf");
  const lastPushAt = holdSource.lastIndexOf("pending.buffered.push(incoming);");
  assert.ok(lastPushAt > crossTabGuardAt, "goal events are buffered only after the any-tab running guard");

  // 行为钉:A 的结束即时结算(执行态落下),B 的 waiting 应答只写 B 自己的等待位,
  // 不触碰 A 的停止闩锁与 epoch(生产 reducer 实测,非 helper 布尔)。
  const settled = noteTurnEnded({ running: true, waitingIds: [] });
  assert.deepEqual(settled, { running: false, waitingIds: [] }, "A's end settles A's run state immediately");
  const a = { running: true, waitingIds: [] as string[] };
  assert.deepEqual(noteSendResult(a, { waiting: true, started: false, queueItemId: "qb" }), {
    running: true,
    waitingIds: ["qb"],
  });
  const ticket = { id: 3, sessionId: "s-shared", epoch: 1 };
  const armed = finishStop({ ticket, pending: ticket, currentEpoch: 1, ok: true, latchOwner: null });
  assert.equal(armed.arm, true, "B's queued send on the shared session leaves A's stop ticket armed");
  const body = functionBody("async function send()", "async function stopTurn(");
  const waitingBranch = blockAfter(body, "if (sent.waiting && sent.queueItemId !== undefined) {").body;
  for (const needle of ["openTurnForTab(", "patchTabTurn(", "writeTabRun("]) {
    assert.ok(!waitingBranch.includes(needle), `the waiting branch must not touch ${needle}`);
  }
});

test("a stopped session's idle end never enters the next send's buffer", () => {
  // 停止成功之后 agent 的 idle 结束常常晚于下一次发送的应答：它一旦进了这次缓冲，
  // waiting/started:false/抛错的应答会连同缓冲一起丢掉它，残留标记随即吞掉下一回合
  // 自己的结束，停止按钮永久留着（R-2）。
  const holdSource = earlyEventGate();
  const goalCheckAt = holdSource.indexOf("if (!isGoalEvent) return false;");
  const stopGuardAt = holdSource.indexOf("stopRequestedForSession(sessionId)");
  const staleGuardAt = holdSource.indexOf("staleIdleRef.current.some((item) => item.sessionId === sessionId)");
  const goalPushAt = holdSource.lastIndexOf("pending.buffered.push(incoming);");
  assert.ok(goalCheckAt >= 0, "only goal and end events take the buffering path");
  assert.ok(stopGuardAt > goalCheckAt, "a stop still in effect processes the end immediately");
  assert.ok(staleGuardAt > stopGuardAt, "a leftover stale marker processes the end immediately");
  assert.ok(goalPushAt > staleGuardAt, "the stop guards run before any goal event is buffered");

  // 兜底：这次发送不会重放缓冲时，丢弃前先把其中的结束送进过期标记。
  const takeBody = functionBody("function takePendingBuffer(", "function dropPending(");
  const replayAt = takeBody.indexOf("if (sendOpensTurn(sent)) return buffered;");
  const discardAt = takeBody.indexOf("discardBufferedStopEnds(buffered);");
  const filterAt = takeBody.indexOf("if (sent.waiting && sent.queueItemId !== undefined) {");
  const emptyAt = takeBody.indexOf("return [];");
  assert.ok(replayAt >= 0, "a started response still replays the buffer as-is");
  assert.ok(discardAt > replayAt, "only buffers this send will not replay need the fallback");
  assert.ok(
    filterAt > discardAt && emptyAt > discardAt,
    "queued and unstarted responses consume the caught ends before dropping the buffer",
  );

  const dropBody = functionBody("function dropPending(", "function tabIdForSession(");
  const dropDiscardAt = dropBody.indexOf("discardBufferedStopEnds(pending.buffered);");
  const clearAt = dropBody.indexOf("pending.buffered = [];");
  assert.ok(dropDiscardAt >= 0, "a rejected send still consumes the ends it caught");
  assert.ok(clearAt > dropDiscardAt, "the fallback runs before the failed send's buffer is cleared");

  // 该会话的停止闩锁由 shim 清掉，主链的过期标记处理仍在。
  const discardBody = functionBody("function discardBufferedStopEnds(", "function takePendingBuffer(");
  assert.match(discardBody, /consumeBufferedStaleEnds\(/);
  assert.match(discardBody, /staleIdleRef\.current = consumed\.stale;/);
  assert.match(discardBody, /stopOwnerForSession\(sessionId\)/);
  assert.match(discardBody, /stopSessionId: null, latchOwner: null, stopping: false/);
  assert.match(APP_SOURCE, /if \(event\.event === "session\/end"\) \{[\s\S]*?consumeStaleIdle\(staleIdleRef\.current, event, eventEpoch\)/);

  // 行为钉：缓冲里的当前轮结束用掉标记并清闩锁；更新一轮的结束只让标记失效。
  const marker = [{ sessionId: "s-shared", epoch: 3 }];
  assert.deepEqual(
    consumeBufferedStaleEnds(marker, [{ event: "session/end", sessionId: "s-shared" }], () => 3),
    { stale: [], clearedSessionIds: ["s-shared"] },
  );
  assert.deepEqual(
    consumeBufferedStaleEnds(marker, [{ event: "session/end", sessionId: "s-shared" }], () => 4),
    { stale: [], clearedSessionIds: [] },
  );
});

test("the diff follows the session's own tab", () => {
  assert.doesNotMatch(APP_SOURCE, /setDiff\(/, "the process-wide diff setter is gone");
  assert.match(APP_SOURCE, /setDiffsByTab\(\(prev\) => noteDiffForTab\(prev, diffTab, event\.text\)\)/);
  assert.match(APP_SOURCE, /const diff = diffsByTab\[activeChat\.id\] \?\? "";/, "the pane shows the visible tab's own diff");
  const diffAt = APP_SOURCE.indexOf('if (event.event === "diff") {');
  assert.ok(diffAt >= 0, "the diff branch is still wired");
  const diffBody = blockAfter(APP_SOURCE.slice(diffAt), 'if (event.event === "diff") {').body;
  assert.match(diffBody, /const diffTab = tabIdForSession\(event\.sessionId\);/);
  assert.match(diffBody, /if \(diffTab !== undefined\) \{/, "no session id writes no tab at all");
  assert.match(diffBody, /if \(activeTabRef\.current === diffTab\) setRightTab\("diff"\);/, "a background diff never switches the pane");
});

/** 活动回合 + 一条排队中（带 `queueItemId`）的用户消息：B 还没开始执行。 */
function turnWithQueuedMessage(): Parameters<typeof AppModule.appendToken>[0] {
  return [
    { id: 1, kind: "user", text: "A 的请求" },
    { id: 2, kind: "tool", card: { key: "tool-1", name: "bash", callId: "call-1", status: "start" } },
    { id: 3, kind: "user", text: "B 的请求", queueItemId: "q-b" },
  ];
}

test("a queued user message does not split the running turn", () => {
  const items = turnWithQueuedMessage();

  // 工具面板：B 不终结 A 的段，运行中的面板保持展开。
  const rows = projectToolPanels(items, { contentItems: [], connectionLost: false });
  const panels = rows.filter((row) => row.kind === "panel");
  assert.equal(panels.length, 1, "one running turn projects one panel");
  assert.equal(panels[0]?.kind === "panel" ? panels[0].panel.expanded : false, true);
  assert.ok(rows.some((row) => row.kind === "item" && row.item.kind === "user" && row.item.id === 3), "the queued message still renders");

  // 正文：A 的流式 token 写回 A 的回合，不新开在 B 后面。
  const streamed = AppModule.appendToken(items, "输出", () => 90);
  assert.equal(streamed.length, items.length + 1);
  assert.equal(streamed[2]?.kind, "assistant", "the stream lands before the queued message");
  assert.equal(streamed.at(-1)?.kind, "user", "the queued message stays last");
  const continued = AppModule.appendToken(streamed, "续写", () => 91);
  assert.equal(continued.length, streamed.length, "a later token extends the same assistant item");
  assert.equal(continued[2]?.kind === "assistant" ? continued[2].text : "", "输出续写");

  // 思考：只保留一块，且落在 B 之前。
  const thought = AppModule.applyReasoning(items, "先想一下", false, () => 92);
  assert.equal(thought[2]?.kind, "thinking", "reasoning stays inside the running turn");
  assert.equal(thought.at(-1)?.kind, "user");
  const moreThought = AppModule.applyReasoning(thought, "再想一下", false, () => 93);
  assert.equal(
    moreThought.filter((item) => item.kind === "thinking").length,
    1,
    "a second reasoning event extends the same thinking block",
  );

  // 待办：todo_write 替换本回合那一份，不在 B 后面追加第二份。
  const todos = [{ content: "写报告", status: "pending" as const }];
  const todoItems = AppModule.upsertTodoItem(items, todos, () => 94);
  assert.equal(todoItems[2]?.kind, "todo", "the todo list lands inside the running turn");
  assert.equal(todoItems.at(-1)?.kind, "user");
  const nextTodos = [{ content: "写报告", status: "completed" as const }];
  const replaced = AppModule.upsertTodoItem(todoItems, nextTodos, () => 95);
  assert.equal(replaced.length, todoItems.length, "the next todo_write replaces this turn's list");
  assert.equal(replaced.filter((item) => item.kind === "todo").length, 1);

  // 计划卡：仍画在自己那行工具之前，不落到 B 后面。
  const planItems = AppModule.insertBeforeToolRow(
    turnWithQueuedMessage(),
    { id: 96, kind: "note", text: "计划" },
    "call-1",
  );
  assert.equal(planItems[1]?.kind, "note", "the plan card sits before its own tool row");
  assert.equal(planItems.at(-1)?.kind, "user", "the queued message stays last");
});

/** 活动回合 + 一条刚插入、`session.send` 应答还没回来的用户消息（还没有 queueItemId）。 */
function turnWithInsertedMessage(): Parameters<typeof AppModule.appendToken>[0] {
  return [
    { id: 1, kind: "user", text: "A 的请求" },
    { id: 2, kind: "tool", card: { key: "tool-1", name: "bash", callId: "call-1", status: "start" } },
    { id: 3, kind: "user", text: "B 的请求", notStarted: true },
  ];
}

test("a just-inserted user message stays inside the running turn's append window", () => {
  const items = turnWithInsertedMessage();
  // 插入时即标未启动：应答回来之前这条消息不参与「最新用户消息」的选择。
  const insertedMessage = items[2];
  assert.ok(insertedMessage?.kind === "user");
  assert.equal(isUnstartedUserItem(insertedMessage), true);
  assert.equal(latestUserItemId(items), 1);

  // 工具面板不为它切段：A 的面板仍是运行中、展开。
  const panels = projectToolPanels(items, { contentItems: [], connectionLost: false })
    .filter((row) => row.kind === "panel");
  assert.equal(panels.length, 1, "the inserted message does not cut the running turn's panel");
  assert.equal(panels[0]?.kind === "panel" ? panels[0].panel.expanded : false, true);

  // 流式正文、思考、待办、计划卡与工具行都写回 A，不落到 B 后面。
  const streamed = AppModule.appendToken(items, "输出", () => 90);
  assert.equal(streamed[2]?.kind, "assistant", "the stream lands before the inserted message");
  assert.equal(streamed.at(-1)?.kind, "user", "the inserted message stays last");
  const thought = AppModule.applyReasoning(items, "先想一下", false, () => 91);
  assert.equal(thought[2]?.kind, "thinking");
  assert.equal(thought.at(-1)?.kind, "user");
  const todo = AppModule.upsertTodoItem(items, [{ content: "写报告", status: "pending" as const }], () => 92);
  assert.equal(todo[2]?.kind, "todo");
  assert.equal(todo.at(-1)?.kind, "user");
  const plan = AppModule.insertBeforeToolRow(items, { id: 93, kind: "note", text: "计划" }, "call-1");
  assert.equal(plan[1]?.kind, "note");
  assert.equal(plan.at(-1)?.kind, "user");
  const row = AppModule.insertTurnItem(items, { id: 94, kind: "note", text: "工具行" });
  assert.equal(row[2]?.id, 94);
  assert.equal(row.at(-1)?.kind, "user");

  // 标签上还没有任何已启动回合时（首条消息刚插入），写入位置仍是末尾：正文不能跑到问题前面。
  const fresh = [{ id: 3, kind: "user" as const, text: "B 的请求", notStarted: true }];
  const freshStream = AppModule.appendToken(fresh, "输出", () => 95);
  assert.equal(freshStream[0]?.kind, "user");
  assert.equal(freshStream.at(-1)?.kind, "assistant");
});

test("the sent message is unstarted until the started response clears it", () => {
  const body = functionBody("async function send()", "async function stopTurn(");
  assert.match(
    body,
    /const userMsg: ChatItem = \{ id: allocId\(\), kind: "user", text, notStarted: true \};/,
    "the just-inserted message carries the unstarted marker before the response",
  );
  const gate = blockAfter(body, "if (sendOpensTurn(sent)) {").body;
  assert.match(gate, /startUserItem\(item\)/, "only the started response clears the marker");
  assert.equal((body.match(/startUserItem\(/g) ?? []).length, 1, "send clears the marker at exactly one point");
  // 排队项真正出队：等待项与插入标记一起清掉；失败/取消保留消息但标未启动。
  const clearBody = functionBody("function clearQueueItem(", "function beginQueuedTurn(");
  assert.match(
    clearBody,
    /outcome === "started" \? startUserItem\(item\) : releaseWaitingItem\(item, false\)/,
    "a queue item that really starts drops both markers; a failed or cancelled one stays unstarted",
  );
  assert.deepEqual(
    AppModule.startUserItem({ id: 3, kind: "user", text: "B", queueItemId: "q-b", notStarted: true }),
    { id: 3, kind: "user", text: "B" },
  );
  assert.equal(isUnstartedUserItem(AppModule.startUserItem({ id: 3, kind: "user", notStarted: true })), false);
});

test("the pre-response window reads the active message for its outcome checks", () => {
  const items = [
    { id: 1, kind: "user" as const, text: "生成 report.md，并运行 `pnpm test`" },
    { id: 2, kind: "tool" as const, card: { name: "bash", command: "pnpm test", status: "end" as const, isError: false } },
    { id: 3, kind: "user" as const, text: "生成 other.md，并运行 `pnpm build`" },
  ];
  // 没有标记时原始回落会读到刚插入的那条；该标签记录的活动消息必须压过它。
  assert.equal(latestUserItemId(items), 3);
  const turnUserId = AppModule.turnUserIdFor({ activeUserId: 1 }, items);
  assert.equal(turnUserId, 1, "the tab's recorded active message wins over the inserted one");
  const checks = turnChecks(items, turnUserId);
  assert.deepEqual(checks.requiredFiles, ["report.md"]);
  assert.deepEqual(checks.requiredCommands, ["pnpm test"]);
  // 没有记录活动消息（历史标签）时回落到最后一条已启动的用户消息。
  const marked = [
    { id: 1, kind: "user" as const, text: "A" },
    { id: 2, kind: "user" as const, text: "B", notStarted: true },
  ];
  assert.equal(AppModule.turnUserIdFor({ activeUserId: null }, marked), 1);
  // readTurn 用这条规则选消息，不再直接取最后一条用户消息。
  const readBody = functionBody("const readTurn = async (", "const appendTurnNotes = (");
  assert.match(readBody, /const turnUserId = turnUserIdFor\(tabTurnOf\(tabId\), items\);/);
  assert.doesNotMatch(readBody, /latestUserItemId\(items\)/);
});

test("turn-owned rows land before a just-inserted user message", () => {
  const items = turnWithInsertedMessage();
  // 工具行、审批卡、失败/目标脚注都进本回合的写入位置，不落到排队消息后面。
  const toolRow = AppModule.insertTurnItem(items, {
    id: 90,
    kind: "tool",
    card: { key: "tool-2", name: "read", callId: "call-2", status: "start" },
  });
  assert.equal(toolRow[2]?.id, 90, "a tool row starts inside the running turn");
  assert.equal(toolRow.at(-1)?.kind, "user");
  const askRow = AppModule.insertTurnItem(items, {
    id: 91,
    kind: "ask",
    card: { approvalRequestId: "req-1", toolName: "bash" },
  });
  assert.equal(askRow[2]?.id, 91, "an approval card starts inside the running turn");
  assert.equal(askRow.at(-1)?.kind, "user");
  const noteRow = AppModule.insertTurnItem(items, { id: 92, kind: "note", text: "会话失败" });
  assert.equal(noteRow[2]?.id, 92, "a failure or goal note belongs to the running turn");
  assert.equal(noteRow.at(-1)?.kind, "user");
  // 没有排队消息时行为不变：追加到末尾。
  const plain = items.slice(0, 2);
  assert.equal(AppModule.insertTurnItem(plain, { id: 93, kind: "note", text: "脚注" }).at(-1)?.id, 93);

  // request_input 卡片同样落在排队消息之前，并把上一张没人回答的卡关掉。
  const withOpenInput: Parameters<typeof AppModule.appendOpenInputInTurn>[0] = [
    { id: 1, kind: "user", text: "A 的请求" },
    { id: 2, kind: "input", card: { question: "旧问题", sessionId: "s", state: "open" } },
    { id: 3, kind: "user", text: "B 的请求", notStarted: true },
  ];
  const withInput = AppModule.appendOpenInputInTurn(withOpenInput, 94, "新问题", "s");
  assert.equal(withInput[2]?.kind, "input", "the question card lands before the queued message");
  assert.equal(withInput.at(-1)?.kind, "user");
  assert.equal(withInput[1]?.kind === "input" ? withInput[1].card.state : "", "closed");

  // 接线：各分支都走同一插入点，没有任何一处继续追加到末尾。
  const h = functionBody("function handleEvent(", "function turnAppendIndex(");
  assert.equal(
    (h.match(/insertTurnItem\(prev, /g) ?? []).length,
    5,
    "tool row, approval, compaction, goal and failure notes share the append position",
  );
  assert.match(h, /insertTurnItem\(prev, ask\)/);
  assert.match(h, /appendOpenInputInTurn\(prev, allocId\(\), event\.question, event\.sessionId\)/);
  assert.doesNotMatch(h, /\.\.\.prev/, "no chat row is appended after a queued message");
});

test("stopping the running turn interrupts its items despite a queued message", () => {
  const items: Array<{ id: number; kind: string; interrupted?: boolean; queueItemId?: string }> = [
    { id: 1, kind: "user" },
    { id: 2, kind: "thinking", interrupted: false },
    { id: 3, kind: "assistant", interrupted: false },
    { id: 4, kind: "user", queueItemId: "q-b" },
  ];
  const next = interruptTurnItems(items);
  assert.equal(next[1]?.interrupted, true, "the running turn's thinking is marked interrupted");
  assert.equal(next[2]?.interrupted, true, "the running turn's answer is marked interrupted");
  assert.equal(next[3]?.kind, "user");
  assert.equal(next[3]?.interrupted, undefined, "the queued message is not a turn and stays untouched");
});

test("an owner-less queue start leaves the running tab and foreign pending alone", () => {
  // 归属消息已被取消或删除：只收等待项，不碰该标签的执行态。
  assert.deepEqual(
    AppModule.queuedTurnRunState({ running: true, waitingIds: ["q-b"] }, "q-b", false),
    { running: true, waitingIds: [] },
    "an owner-less queue start never ends a genuinely running tab",
  );
  assert.deepEqual(
    AppModule.queuedTurnRunState({ running: false, waitingIds: ["q-b"] }, "q-b", false),
    { running: false, waitingIds: [] },
  );
  // 归属消息还在：清等待项并真正开回合。
  assert.deepEqual(
    AppModule.queuedTurnRunState({ running: false, waitingIds: ["q-b"] }, "q-b", true),
    { running: true, waitingIds: [] },
  );

  // App 必须先定位归属消息，再写执行态；找不到就直接返回。
  const body = functionBody("function beginQueuedTurn(", "function failQueuedTurn(");
  const ownerAt = body.indexOf("const userId = clearQueueItem(tabId, queueItemId);");
  const stateAt = body.indexOf("queuedTurnRunState(state, queueItemId, userId !== undefined)");
  assert.ok(ownerAt >= 0, "the owner lookup is still the first step");
  assert.ok(stateAt > ownerAt, "the tab's run state is written only after the owner is known");
  assert.match(body, /if \(userId === undefined\) return;/, "an owner-less queue start never opens a turn");
  // 不能按标签删掉别的发送的 pending：那条记录只由它自己的应答清理。
  assert.doesNotMatch(body, /pendingSendsRef/, "an owner-less queue start never touches another send's pending");
  assert.match(
    functionBody("function takePendingBuffer(", "function dropPending("),
    /pendingSendsRef\.current\.get\(pending\.tabId\) === pending/,
    "a replayed response removes only its own pending",
  );
  assert.match(
    functionBody("function dropPending(", "function tabIdForSession("),
    /pendingSendsRef\.current\.get\(pending\.tabId\) === pending/,
    "a failed send drops only its own pending",
  );
  // 删除子任务 / 会话时一并清掉这些表，迟到的队列事件不会再拉回已删标签。
  assert.match(functionBody("async function removeSubtask(", "async function refreshSessions("), /pruneTabBookkeeping\(tab\.id\)/);
  assert.match(functionBody("async function removeSession(", "const blocked = sidecarDead;"), /pruneTabBookkeeping\(tab\.id\)/);
});

test("a queued message does not change the running turn outcome checks", () => {
  const items: Parameters<typeof turnChecks>[0] = [
    { id: 1, kind: "user", text: "生成 report.md，并运行 `pnpm test`" },
    { id: 2, kind: "tool", card: { name: "bash", command: "pnpm test", status: "end", isError: false } },
    { id: 3, kind: "user", text: "生成 other.md，并运行 `pnpm build`", queueItemId: "q-b" },
  ];
  // 活动用户消息是 A：文件与命令都只按 A 的文本核对。
  const checks = turnChecks(items, 1);
  assert.deepEqual(checks.requiredFiles, ["report.md"]);
  assert.deepEqual(checks.requiredCommands, ["pnpm test"]);
  // 没传活动消息时也不能读排队的 B。
  const fallback = turnChecks(items);
  assert.deepEqual(fallback.requiredFiles, ["report.md"]);
  assert.deepEqual(fallback.requiredCommands, ["pnpm test"]);
  // App 的结算把活动消息 id 交给核对，而不是只传内容视图。
  assert.match(APP_SOURCE, /turnChecks\(contentItems\(items\), turnUserId\)/);
});

test("reasoning events of different steps create separate thinking blocks in order", () => {
  const items = [{ id: 1, kind: "user" as const, text: "问题" }];
  const first = AppModule.applyReasoning(items, "第一轮想", false, () => 2, 10);
  const streamed = AppModule.appendToken(first, "第一轮正文", () => 3, 10);
  const tooled = AppModule.insertTurnItem(streamed, {
    id: 4, kind: "tool", card: { key: "k4", name: "read", status: "start", roundKey: 10 },
  });
  const second = AppModule.applyReasoning(tooled, "第二轮想", false, () => 5, 20);
  assert.equal(second.filter((item) => item.kind === "thinking").length, 2);
  assert.deepEqual(second.map((item) => item.kind), ["user", "thinking", "assistant", "tool", "thinking"]);
  assert.equal(second[1]?.kind === "thinking" ? second[1].roundKey : undefined, 10);
  assert.equal(second[4]?.kind === "thinking" ? second[4].roundKey : undefined, 20);
  const more = AppModule.applyReasoning(second, "第二轮续", false, () => 6, 20);
  assert.equal(more.filter((item) => item.kind === "thinking").length, 2, "same step keeps extending its own block");
  assert.equal(more[4]?.kind === "thinking" ? more[4].thought : "", "第二轮想第二轮续");
});

test("assistant text does not merge across steps", () => {
  const items = [{ id: 1, kind: "user" as const, text: "问题" }];
  const first = AppModule.appendToken(items, "A", () => 2, 10);
  const second = AppModule.appendToken(first, "B", () => 3, 20);
  assert.deepEqual(second.map((item) => item.kind), ["user", "assistant", "assistant"]);
  assert.equal(second[1]?.kind === "assistant" ? second[1].roundKey : undefined, 10);
  assert.equal(second[2]?.kind === "assistant" ? second[2].roundKey : undefined, 20);
  const more = AppModule.appendToken(second, "B2", () => 4, 20);
  assert.equal(more.length, 3, "the same step keeps extending its own assistant item");
  assert.equal(more[2]?.kind === "assistant" ? more[2].text : "", "BB2");
});

test("reasoning arriving after its own round's body still inserts before that body", () => {
  const items = [
    { id: 1, kind: "user" as const, text: "问题" },
    { id: 2, kind: "assistant" as const, text: "第一轮正文", roundKey: 10 },
  ];
  const next = AppModule.applyReasoning(items, "想", false, () => 3, 10);
  assert.deepEqual(next.map((item) => item.kind), ["user", "thinking", "assistant"]);
  assert.equal(next[1]?.kind === "thinking" ? next[1].roundKey : undefined, 10);
});

test("handleEvent passes roundKey from tool/start into the card", () => {
  const updates: ReturnType<typeof AppModule.insertTurnItem>[] = [];
  const setItems = (updater: (prev: Parameters<typeof AppModule.insertTurnItem>[0]) => Parameters<typeof AppModule.insertTurnItem>[0]) => {
    updates.push(updater([]));
  };
  AppModule.handleEvent(
    { event: "tool/start", name: "read", callId: "c1", roundKey: 42 } as never,
    () => 2,
    () => undefined,
    setItems,
    () => undefined,
    () => undefined,
    async () => undefined,
    { current: false },
    false,
    false,
    false,
  );
  const card = updates[0]?.[0]?.kind === "tool" ? updates[0][0].card : undefined;
  assert.equal(card?.roundKey, 42);
});

test("reasoning without roundKey keeps the single block behaviour", () => {
  const items = [{ id: 1, kind: "user" as const, text: "问题" }];
  const first = AppModule.applyReasoning(items, "想", false, () => 2);
  const second = AppModule.applyReasoning(first, "再想", false, () => 3);
  assert.equal(second.filter((item) => item.kind === "thinking").length, 1);
});

test("tool/start roundKey lands on the card", () => {
  const items = [{ id: 1, kind: "user" as const, text: "问题" }];
  const next = AppModule.insertTurnItem(items, {
    id: 2, kind: "tool", card: { key: "k2", name: "bash", status: "start", roundKey: 42 },
  });
  assert.equal(next[1]?.kind === "tool" ? next[1].card.roundKey : undefined, 42);
});

test("thinkingBefore never borrows another round's reasoning", () => {
  const items = [
    { id: 1, kind: "user" as const, text: "问题" },
    { id: 2, kind: "thinking" as const, thought: "第一轮想", interrupted: false, roundKey: 10 },
    { id: 3, kind: "assistant" as const, text: "第二轮正文", roundKey: 20 },
  ];
  assert.equal(AppModule.thinkingBefore(items, 2), undefined);
  const sameRound = [...items.slice(0, 2), { id: 4, kind: "assistant" as const, text: "第一轮正文", roundKey: 10 }];
  assert.equal(AppModule.thinkingBefore(sameRound, 2)?.id, 2);
});
