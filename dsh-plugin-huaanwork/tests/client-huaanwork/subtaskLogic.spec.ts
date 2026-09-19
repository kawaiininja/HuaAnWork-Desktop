import assert from "node:assert/strict";
import { test } from "vitest";

import {
  isDefaultSubtaskName,
  isPendingSubtask,
  needsSubtaskOnSend,
  subtaskNameFromMessage,
  subtaskRenamesFromTitles,
  usableSessionTitle,
} from "../../src/client-huaanwork/logic/subtaskLogic.ts";

test("subtaskNameFromMessage: 压空白、截 20 字、空兜底", () => {
  assert.equal(subtaskNameFromMessage("  修一下\n\n登录页的   错别字  "), "修一下 登录页的 错别字");
  assert.equal(subtaskNameFromMessage(""), "新子任务");
  assert.equal(subtaskNameFromMessage("   \n "), "新子任务");
  assert.equal(subtaskNameFromMessage("一二三四五六七八九十一二三四五六七八九十一二三"), "一二三四五六七八九十一二三四五六七八九十");
});

test("isPendingSubtask: 已绑项目 + 未绑子任务 + 非待选 + 无对话", () => {
  const base = { projectId: "p1", taskId: undefined, pendingPick: false, hasConversation: false };
  assert.equal(isPendingSubtask(base), true);
  assert.equal(isPendingSubtask({ ...base, projectId: null }), false);
  assert.equal(isPendingSubtask({ ...base, taskId: "t1" }), false);
  assert.equal(isPendingSubtask({ ...base, pendingPick: true }), false);
  // 以对话内容为准而非 sessionId：预铸了会话但无对话的标签仍是待发送态（评审 P2-4）。
  assert.equal(isPendingSubtask({ ...base, hasConversation: true }), false);
});

test("needsSubtaskOnSend: 两子态判定（规格 §2.5）", () => {
  const pending = { projectId: "p1", taskId: undefined, pendingPick: false, hasConversation: false };
  // 子态一：无 taskId 且 pendingSubtask → true（boundTaskSessionId 此时无意义，传 undefined）。
  assert.equal(needsSubtaskOnSend(pending, undefined), true);
  // 子态二：有 taskId、任务尚无绑定会话 → true。
  assert.equal(needsSubtaskOnSend({ ...pending, taskId: "t1" }, undefined), true);
  // 已有绑定会话 → false（两个子态都不命中）。
  assert.equal(needsSubtaskOnSend({ ...pending, taskId: "t1", hasConversation: true }, "sess-1"), false);
  assert.equal(needsSubtaskOnSend({ ...pending, taskId: "t1" }, "sess-1"), false);
  // 中立标签（无项目）→ false。
  assert.equal(needsSubtaskOnSend({ ...pending, projectId: null }, undefined), false);
  // 有对话历史的项目标签不触发懒创建（评审 P2-4 防割裂）。
  assert.equal(needsSubtaskOnSend({ ...pending, hasConversation: true }, undefined), false);
});

test("isDefaultSubtaskName: 仅匹配「子任务 N」默认名", () => {
  assert.equal(isDefaultSubtaskName("子任务 2"), true);
  assert.equal(isDefaultSubtaskName("子任务 10"), true);
  assert.equal(isDefaultSubtaskName("修登录页错别字"), false);
  assert.equal(isDefaultSubtaskName("子任务2"), false);
  assert.equal(isDefaultSubtaskName("子任务 2 改"), false);
});

test("usableSessionTitle: 排除空与「未命名」兜底标题", () => {
  assert.equal(usableSessionTitle("你好"), true);
  assert.equal(usableSessionTitle("未命名 · 9月17日"), false);
  assert.equal(usableSessionTitle("  未命名 · 9月17日"), false);
  assert.equal(usableSessionTitle(""), false);
  assert.equal(usableSessionTitle("   "), false);
  assert.equal(usableSessionTitle(undefined), false);
});

test("subtaskRenamesFromTitles: 默认名 + 已绑会话 + 有标题才产出改名", () => {
  const sessions = [
    { id: "s1", title: "你好" },
    { id: "s2", title: "未命名 · 9月17日" },
    { id: "s3", title: "  多 行\n标题  " },
  ];
  const tasks = [
    { id: "t1", name: "子任务 1", sessionId: "s1" },          // → 改
    { id: "t2", name: "子任务 2", sessionId: "s2" },          // 兜底标题 → 不改
    { id: "t3", name: "子任务 3", sessionId: "s3" },          // → 压空白改
    { id: "t4", name: "手动改的名", sessionId: "s1" },        // 非默认名 → 不改
    { id: "t5", name: "子任务 5" },                           // 未绑会话 → 不改
    { id: "t6", name: "子任务 6", sessionId: "missing" },     // 会话不在列表 → 不改
  ];
  assert.deepEqual(subtaskRenamesFromTitles(tasks, sessions), [
    { taskId: "t1", name: "你好" },
    { taskId: "t3", name: "多 行 标题" },
  ]);
});

test("subtaskRenamesFromTitles: 名字截 20 字", () => {
  const long = "一二三四五六七八九十一二三四五六七八九十一二三四五六";
  const [rename] = subtaskRenamesFromTitles(
    [{ id: "t1", name: "子任务 1", sessionId: "s1" }],
    [{ id: "s1", title: long }],
  );
  assert.equal(rename.name, "一二三四五六七八九十一二三四五六七八九十");
});
