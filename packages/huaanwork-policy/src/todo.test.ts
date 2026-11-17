import assert from "node:assert/strict";
import { test } from "node:test";

import { normalizeTodoEntries } from "./todo.ts";

test("normalizes the three todo states and drops malformed entries", () => {
  assert.deepEqual(
    normalizeTodoEntries([
      { content: "分析", status: "completed" },
      { content: "实施", status: "in_progress" },
      { content: "验证", status: "pending" },
    ]),
    [
      { content: "分析", status: "completed" },
      { content: "实施", status: "in_progress" },
      { content: "验证", status: "pending" },
    ],
  );
  // 与实时 bridge（bridge.spec.ts:534-560）同一语义：坏条目逐条丢弃，不是整单拒绝
  assert.deepEqual(normalizeTodoEntries([{ content: "核对", status: "weird" }, { content: 3, status: "pending" }]), []);
  assert.deepEqual(normalizeTodoEntries([]), []); // 空数组合法
  assert.equal(normalizeTodoEntries('{"todos":[]}'), undefined); // 非数组 → undefined
  assert.equal(normalizeTodoEntries(undefined), undefined);
  assert.equal(normalizeTodoEntries(null), undefined);
});

test("drops entries that are not objects and keeps the rest", () => {
  assert.deepEqual(
    normalizeTodoEntries([null, "条目", ["嵌套"], { content: "保留", status: "pending" }]),
    [{ content: "保留", status: "pending" }],
  );
});
