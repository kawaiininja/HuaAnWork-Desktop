import assert from "node:assert/strict";
import { test } from "vitest";

import {
  HOST_EXIT_NOTE,
  HOST_STOPPED_BY_USER_TEXT,
  clearFailureOnStopped,
  hostExitNotice,
  hostLivenessNotice,
} from "../../src/client-huaanwork/logic/hostStop.ts";

test("only a non-ok, non-stopped phase shows the unresponsive banner", () => {
  assert.deepEqual(hostLivenessNotice("ok"), { kind: "none" });
  assert.deepEqual(hostLivenessNotice("suspect"), { kind: "unresponsive", canStop: false });
  assert.deepEqual(hostLivenessNotice("stoppable"), { kind: "unresponsive", canStop: true });
});

test("a user-confirmed stop shows the neutral phrase without an unresponsive banner or stop button", () => {
  const notice = hostLivenessNotice("stopped");
  assert.deepEqual(notice, { kind: "stopped", text: HOST_STOPPED_BY_USER_TEXT });
  // No banner branch can render the stop button for this phase.
  assert.equal("canStop" in notice, false);
});

test("a host exit note is neutral for a user stop and a failure note otherwise", () => {
  assert.deepEqual(hostExitNotice(true), {
    text: HOST_STOPPED_BY_USER_TEXT,
    sessionFailed: false,
  });
  assert.deepEqual(hostExitNotice(false), {
    text: HOST_EXIT_NOTE,
    sessionFailed: true,
  });
});

test("the stopped phase clears a failure banner set by the earlier socket close", () => {
  const tabs = [
    { id: "a", sessionFailed: true, items: [{ kind: "user", text: "写吧" }] },
    { id: "b", sessionFailed: false, items: [] },
  ];
  const cleared = clearFailureOnStopped("stopped", tabs);
  assert.deepEqual(cleared, [
    { id: "a", sessionFailed: false, items: [{ kind: "user", text: "写吧" }] },
    { id: "b", sessionFailed: false, items: [] },
  ]);
  // 没有失败标记时不产生新数组，停止相位重复到达不会触发多余状态更新。
  const healthy = [{ id: "c", sessionFailed: false }];
  assert.equal(clearFailureOnStopped("stopped", healthy), healthy);
  // 其他相位（含用户尚未确认的 suspect/stoppable）不撤回失败标记。
  for (const phase of ["ok", "suspect", "stoppable"] as const) {
    assert.equal(clearFailureOnStopped(phase, tabs), tabs);
  }
});

test("the stopped phase replaces the trailing crash note left by the earlier socket close", () => {
  const tabs = [{
    id: "a",
    sessionFailed: true,
    items: [
      { kind: "user", text: "做吧" },
      { kind: "note", text: HOST_EXIT_NOTE },
    ],
  }];
  const cleared = clearFailureOnStopped("stopped", tabs);
  assert.deepEqual(cleared, [{
    id: "a",
    sessionFailed: false,
    items: [
      { kind: "user", text: "做吧" },
      { kind: "note", text: HOST_STOPPED_BY_USER_TEXT },
    ],
  }]);
  // 原脚注没有被原地改写。
  assert.equal(tabs[0]!.items[1]!.text, HOST_EXIT_NOTE);
});

test("a trailing crash note is replaced even when the failure marker is already clear", () => {
  const tabs = [{ id: "a", sessionFailed: false, items: [{ kind: "note", text: HOST_EXIT_NOTE }] }];
  const cleared = clearFailureOnStopped("stopped", tabs);
  assert.notEqual(cleared, tabs, "the note itself is the change");
  assert.deepEqual(cleared, [{
    id: "a",
    sessionFailed: false,
    items: [{ kind: "note", text: HOST_STOPPED_BY_USER_TEXT }],
  }]);
});

test("a trailing note that is not the crash note survives the stopped phase", () => {
  const tabs = [{ id: "a", sessionFailed: false, items: [{ kind: "note", text: "普通说明" }] }];
  assert.equal(clearFailureOnStopped("stopped", tabs), tabs);
  const failure = [{ id: "a", sessionFailed: true, items: [{ kind: "note", text: "普通说明" }] }];
  assert.deepEqual(clearFailureOnStopped("stopped", failure), [
    { id: "a", sessionFailed: false, items: [{ kind: "note", text: "普通说明" }] },
  ]);
});
