import assert from "node:assert/strict";
import { test } from "vitest";
import {
  isUnstartedUserItem,
  noteDiffForTab,
  noteSendResult,
  noteTurnEnded,
  noteWaitingCancelled,
  noteWaitingFailed,
  noteWaitingStarted,
  releaseWaitingItem,
  sendOpensTurn,
  sessionMintFailureNote,
  type TabRunState,
} from "../../src/client-huaanwork/logic/concurrentTurn.ts";

test("a second send on a running tab stays running and records the waiting item", () => {
  const running = noteSendResult({ running: false, waitingIds: [] }, { waiting: false, started: true });
  assert.deepEqual(running, { running: true, waitingIds: [] });
  const both = noteSendResult(running, { waiting: true, started: false, queueItemId: "q1" });
  assert.deepEqual(both, { running: true, waitingIds: ["q1"] });
  assert.equal(running.waitingIds.length, 0, "recording a waiting item never mutates the earlier state");
  assert.deepEqual(noteTurnEnded(both), { running: false, waitingIds: ["q1"] });
  assert.deepEqual(noteWaitingStarted(noteTurnEnded(both), "q1"), { running: true, waitingIds: [] });
  assert.deepEqual(noteWaitingCancelled(both, "q1"), { running: true, waitingIds: [] });
  assert.deepEqual(noteWaitingFailed(both, "q1"), { running: true, waitingIds: [] });
});

test("a send that does not start leaves the tab idle", () => {
  const idle: TabRunState = { running: false, waitingIds: [] };
  assert.equal(sendOpensTurn({ waiting: false, started: false }), false);
  assert.equal(sendOpensTurn({ waiting: true, started: false }), false);
  assert.equal(sendOpensTurn({ waiting: true, started: true }), false, "a queued send is not a started turn");
  assert.equal(sendOpensTurn({ waiting: false, started: true }), true);
  assert.equal(noteSendResult(idle, { waiting: false, started: false }), idle);
  assert.equal(noteSendResult(idle, { waiting: true, started: false }), idle, "waiting without a queue id changes nothing");
  assert.deepEqual(noteWaitingCancelled(idle, "q9"), idle, "an unknown queue id changes nothing");
  assert.deepEqual(noteWaitingFailed(idle, "q9"), idle, "a failed unknown queue id changes nothing");
});

test("a queued item is not a started turn and never clears the running flag", () => {
  const running: TabRunState = { running: true, waitingIds: [] };
  const queued = noteSendResult(running, { waiting: true, started: false, queueItemId: "q2" });
  assert.equal(queued.running, true);
  assert.deepEqual(queued.waitingIds, ["q2"]);
  // 排队失败只去掉这一条等待，不把正在执行的回合停掉。
  assert.deepEqual(noteWaitingFailed(queued, "q2"), running);
  assert.deepEqual(noteWaitingCancelled(queued, "q2"), running);
});

test("stopping one tab leaves the other running", () => {
  const stopped = noteTurnEnded({ running: true, waitingIds: [] });
  const other: TabRunState = { running: true, waitingIds: [] };
  assert.equal(stopped.running, false);
  assert.equal(other.running, true);
});

test("stopping one tab does not consume the other stop ticket", () => {
  const a: TabRunState = { running: true, waitingIds: [] };
  const b: TabRunState = { running: true, waitingIds: ["b-1"] };
  const aEnded = noteTurnEnded(a);
  const bStarted = noteWaitingStarted(b, "b-1");
  assert.deepEqual(aEnded, { running: false, waitingIds: [] });
  assert.deepEqual(bStarted, { running: true, waitingIds: [] });
  // 每个标签各持一份状态：结算 A 不动 B，B 的等待项也不会被 A 消费。
  assert.deepEqual(a, { running: true, waitingIds: [] });
  assert.deepEqual(b, { running: true, waitingIds: ["b-1"] });
  assert.equal(noteWaitingCancelled(a, "b-1"), a, "tab A holds no ticket for tab B's waiting item");
  assert.equal(noteTurnEnded(aEnded), aEnded, "settling an already settled tab changes nothing");
});

test("a background diff stays off the visible tab", () => {
  const visible = noteDiffForTab({}, "a", "diff-a");
  const background = noteDiffForTab(visible, "b", "diff-b");
  assert.equal(background.a, "diff-a");
  assert.equal(background.b, "diff-b");
  assert.equal(visible.b, undefined, "the visible tab never receives the background diff");
  assert.equal(background, noteDiffForTab(background, "b", "diff-b"), "an unchanged diff keeps the same value");
  assert.equal(noteDiffForTab(background, undefined, "orphan"), background, "no tab id never guesses a tab");
});

test("waiting and rejected user messages are not started turns", () => {
  assert.equal(isUnstartedUserItem({ queueItemId: "q1" }), true);
  assert.equal(isUnstartedUserItem({ sendRejected: true }), true);
  assert.equal(isUnstartedUserItem({ notStarted: true }), true, "a started:false response never becomes a turn");
  assert.equal(isUnstartedUserItem({}), false);
  assert.equal(isUnstartedUserItem({ queueItemId: undefined, sendRejected: false }), false);
  assert.equal(isUnstartedUserItem({ notStarted: false }), false);
});

test("a waiting item that fails or is cancelled keeps its message but never becomes a turn", () => {
  const message = { id: 2, kind: "user" as const, queueItemId: "q1" };
  // 出队开始：只去掉等待，这条消息就是活动回合。
  assert.deepEqual(releaseWaitingItem(message, true), { id: 2, kind: "user", queueItemId: undefined });
  assert.equal(isUnstartedUserItem(releaseWaitingItem(message, true)), false);
  // 出队失败/被取消：消息留着，但标成未启动，不参与最新用户消息与终态选择。
  assert.deepEqual(releaseWaitingItem(message, false), {
    id: 2,
    kind: "user",
    queueItemId: undefined,
    notStarted: true,
  });
  assert.equal(isUnstartedUserItem(releaseWaitingItem(message, false)), true);
  assert.equal(message.queueItemId, "q1", "the helper never mutates the waiting message");
});

test("session.new failure shows the real error on a neutral tab and the existing copy on a project tab", () => {
  // 中立标签（projectId 为 null 或缺失）：目录建不出来这件事必须可见，显示真实错误。
  assert.equal(
    sessionMintFailureNote({ error: new Error("ENOSPC: no space left on device"), tabProjectId: null }),
    "ENOSPC: no space left on device",
  );
  assert.equal(sessionMintFailureNote({ error: new Error("EACCES"), tabProjectId: undefined }), "EACCES");
  // 字符串非 Error 原样可见。
  assert.equal(sessionMintFailureNote({ error: "磁盘已满", tabProjectId: null }), "磁盘已满");

  // 项目标签：与 App.tsx:2695-2698 既有守卫同一句，避免同一种失败出现两种措辞。
  assert.equal(
    sessionMintFailureNote({ error: new Error("EACCES"), tabProjectId: "p1" }),
    "子任务会话尚未就绪，消息未发送。请重试。",
  );
});
