import assert from "node:assert/strict";
import { test } from "vitest";
import { turnStatus } from "../../src/client-huaanwork/logic/turnStatus.ts";

test("turn status names thinking only while reasoning is current", () => {
  assert.deepEqual(turnStatus({ latest: "reasoning", runningTool: null, quietMs: 0 }), {
    text: "正在思考",
    alert: false,
  });
  assert.deepEqual(turnStatus({ latest: "reasoning", runningTool: "bash", quietMs: 0 }), {
    text: "正在执行工具 bash",
    alert: false,
  });
  assert.equal(
    turnStatus({ latest: "reasoning", runningTool: null, quietMs: 1_500 }).text,
    "正在思考",
  );
  assert.equal(
    turnStatus({ latest: "reasoning", runningTool: null, quietMs: 2_000 }).text,
    "已 2 秒没有新结果",
  );
  assert.equal(turnStatus({ latest: "quiet", runningTool: null, quietMs: 300_000 }).alert, true);
  assert.equal(turnStatus({ latest: "text", runningTool: null, quietMs: 299_000 }).alert, false);
});
