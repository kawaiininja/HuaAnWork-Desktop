import assert from "node:assert/strict";
import { test } from "vitest";
import {
  extractRequiredCommands,
  extractRequiredFiles,
  fileExistsInTree,
  outcomeGaps,
  todoLabel,
  treePaths,
  turnChecks,
  turnOutcomeLines,
  turnOutcomeNotes,
} from "../../src/client-huaanwork/logic/outcomeCheck.ts";

test("missing files and commands are gaps even when every todo is checked", () => {
  const gaps = outcomeGaps({
    requiredFiles: ["报告.md"],
    requiredCommands: ["pnpm test"],
    toolResults: [{ name: "bash", command: "pnpm test", isError: true }],
    fileExists: () => false,
  });
  assert.deepEqual(gaps, ["缺少文件：报告.md", "命令未通过：pnpm test"]);
  assert.deepEqual(
    outcomeGaps({
      requiredFiles: ["报告.md"],
      requiredCommands: ["pnpm test"],
      toolResults: [{ name: "bash", command: "pnpm test", isError: false }],
      fileExists: (path) => path === "报告.md",
    }),
    [],
  );
});

test("a command with no paired call is a gap and a checked todo does not matter", () => {
  assert.deepEqual(
    outcomeGaps({
      requiredFiles: [],
      requiredCommands: ["pnpm test"],
      toolResults: [{ name: "bash", command: "pnpm lint", isError: false }],
      fileExists: () => true,
    }),
    ["命令未通过：pnpm test"],
  );
});

test("required files and commands come only from what the text spells out", () => {
  assert.deepEqual(extractRequiredFiles("请把结果写到 报告.md 和 `docs/plan.docx`，不要动 example.com"), ["报告.md", "docs/plan.docx"]);
  assert.deepEqual(extractRequiredCommands("跑 `pnpm test` 和 `corepack yarn check`，别管 `foo`"), ["pnpm test", "corepack yarn check"]);
  assert.deepEqual(extractRequiredFiles("随便聊聊"), []);
});

test("turn result lists gaps, never claims done with gaps, and admits when nothing was checkable", () => {
  assert.deepEqual(turnOutcomeLines({ requiredFiles: ["a.md"], requiredCommands: [], gaps: ["缺少文件：a.md"] }), {
    done: false,
    lines: ["缺少文件：a.md"],
  });
  assert.deepEqual(turnOutcomeLines({ requiredFiles: [], requiredCommands: [], gaps: [] }), {
    done: false,
    lines: ["没有自动核对项，需要你自己看"],
  });
  assert.deepEqual(turnOutcomeLines({ requiredFiles: ["a.md"], requiredCommands: [], gaps: [] }), { done: true, lines: [] });
});

test("file lookup works on a flattened workspace tree with relative paths", () => {
  const paths = treePaths([
    { name: "docs", path: "/w/docs", isDir: true, children: [{ name: "plan.docx", path: "/w/docs/plan.docx", isDir: false }] },
    { name: "报告.md", path: "/w/报告.md", isDir: false },
  ]);
  assert.equal(fileExistsInTree(paths, "报告.md"), true);
  assert.equal(fileExistsInTree(paths, "./docs/plan.docx"), true);
  assert.equal(fileExistsInTree(paths, "docs\\plan.docx"), true);
  assert.equal(fileExistsInTree(paths, "other.md"), false);
});

test("todo labels follow todo_write statuses", () => {
  assert.deepEqual(["pending", "in_progress", "completed"].map(todoLabel), ["待做", "进行中", "已勾选"]);
});

test("turn checks read the last turn only and outcome notes never say done with a gap", () => {
  const items = [
    { kind: "user" as const, text: "上一轮 旧.md" },
    { kind: "user" as const, text: "写 报告.md 并跑 `pnpm test`" },
    { kind: "ask" as const, card: { toolName: "plan-review", summary: "产物：out/摘要.md" } },
    { kind: "tool" as const, card: { name: "bash", command: "pnpm test", isError: false } },
    { kind: "todo" as const },
  ];
  const checks = turnChecks(items);
  assert.deepEqual(checks.requiredFiles, ["报告.md", "out/摘要.md"]);
  assert.deepEqual(checks.requiredCommands, ["pnpm test"]);
  assert.deepEqual(checks.toolResults, [{ name: "bash", command: "pnpm test", isError: false }]);

  const tree = [
    { path: "/w/报告.md" },
    { path: "/w/out", children: [{ path: "/w/out/摘要.md" }] },
  ];
  assert.deepEqual(turnOutcomeNotes(checks, tree), ["已完成：自动核对 3 项均通过"]);
  assert.deepEqual(turnOutcomeNotes(checks, [{ path: "/w/报告.md" }]), ["缺少文件：out/摘要.md"]);
  assert.deepEqual(turnOutcomeNotes(checks, []), ["没能读取工作区，文件未核对：报告.md、out/摘要.md"]);
  assert.deepEqual(turnOutcomeNotes(turnChecks([{ kind: "user", text: "帮我润色这段话" }]), []), [
    "没有自动核对项，需要你自己看",
  ]);
});
