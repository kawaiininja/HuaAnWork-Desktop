import assert from "node:assert/strict";
import { test } from "vitest";
import { classifyToolCalls } from "../../src/huaanwork-guardrails/route-tools.ts";

test("control tools win and only the declared fields parse", () => {
  assert.deepEqual(classifyToolCalls([]), { kind: "answer" });
  assert.deepEqual(classifyToolCalls([{ name: "read", args: { file_path: "a.md" } }]), {
    kind: "direct",
    call: { name: "read", args: { file_path: "a.md" } },
  });
  assert.deepEqual(
    classifyToolCalls([
      { name: "read", args: {} },
      { name: "propose_plan", args: { objective: "汇总三份材料" } },
    ]),
    { kind: "planned", objective: "汇总三份材料" },
  );
  assert.deepEqual(classifyToolCalls([{ name: "request_input", args: { question: "目标目录是哪一个？" } }]), {
    kind: "clarify",
    question: "目标目录是哪一个？",
  });
  assert.deepEqual(classifyToolCalls([{ name: "propose_plan", args: { objective: "汇总", steps: [] } }]), {
    kind: "invalid",
  });
  assert.deepEqual(classifyToolCalls([{ name: "request_input", args: { question: "  " } }]), { kind: "invalid" });
});
