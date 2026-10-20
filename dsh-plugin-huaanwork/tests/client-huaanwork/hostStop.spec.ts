import assert from "node:assert/strict";
import { test } from "vitest";

import {
  HOST_EXIT_NOTE,
  HOST_STOPPED_BY_USER_TEXT,
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
