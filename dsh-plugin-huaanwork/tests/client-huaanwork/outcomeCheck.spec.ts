import assert from "node:assert/strict";
import { test } from "vitest";
import {
  appendOutcomeNotes,
  extractRequiredCommands,
  extractRequiredFiles,
  eventTargetTab,
  lookupSessionCwd,
  fileExistsInTree,
  latestUserItemId,
  outcomeGaps,
  outcomeTargetTab,
  outcomeWorkspace,
  todoLabel,
  toolResultsFromRecords,
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

test("turn result lists gaps and never claims done with gaps; empty lists are not a pass", () => {
  assert.deepEqual(turnOutcomeLines({ requiredFiles: ["a.md"], requiredCommands: [], gaps: ["缺少文件：a.md"] }), {
    done: false,
    lines: ["缺少文件：a.md"],
  });
  assert.deepEqual(turnOutcomeLines({ requiredFiles: [], requiredCommands: [], gaps: [] }), {
    done: false,
    lines: [],
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
  assert.deepEqual(turnOutcomeNotes(checks, [], false), []);
  assert.deepEqual(turnOutcomeNotes(turnChecks([{ kind: "user", text: "帮我润色这段话" }]), []), []);
});

test("the last result of a repeated command wins, in both orders", () => {
  const base = { requiredFiles: [], requiredCommands: ["pnpm test"], fileExists: () => true };
  assert.deepEqual(
    outcomeGaps({
      ...base,
      toolResults: [
        { name: "bash", command: "pnpm test", isError: true },
        { name: "bash", command: "pnpm test", isError: false },
      ],
    }),
    [],
  );
  assert.deepEqual(
    outcomeGaps({
      ...base,
      toolResults: [
        { name: "bash", command: "pnpm test", isError: false },
        { name: "bash", command: "pnpm test", isError: true },
      ],
    }),
    ["命令未通过：pnpm test"],
  );
});

test("a bash result ending in [exit code: 1] is a gap even when isError is false", () => {
  const records = [
    { kind: "tool-call" as const, time: 1, name: "bash", callId: "c1", command: "pnpm test" },
    { kind: "tool-result" as const, time: 2, callId: "c1", isError: false, text: `${"x".repeat(100)}\n[exit code: 1]` },
  ];
  const [result] = toolResultsFromRecords(records);
  assert.deepEqual(result, { name: "bash", command: "pnpm test", isError: true });
  assert.deepEqual(
    outcomeGaps({ requiredFiles: [], requiredCommands: ["pnpm test"], toolResults: [result!], fileExists: () => true }),
    ["命令未通过：pnpm test"],
  );
});

test("a tool call without a result is not a pass", () => {
  const records = [{ kind: "tool-call" as const, time: 1, name: "bash", callId: "c1", command: "pnpm test" }];
  assert.deepEqual(toolResultsFromRecords(records), [{ name: "bash", command: "pnpm test", isError: true }]);
});

test("a tool card that has not ended is not a pass", () => {
  const checks = turnChecks([
    { kind: "user", text: "跑 `pnpm test`" },
    { kind: "tool", card: { name: "bash", command: "pnpm test", status: "start" } },
  ]);
  assert.deepEqual(turnOutcomeNotes(checks, []), ["命令未通过：pnpm test"]);
});

test("outcome notes go to a user chat tab only, never a child session or an automation tab", () => {
  const tabs = [
    { id: "work-1", sessionId: "huaanwork-aaaaaaaaaaaaaaaa" },
    { id: "run-1", sessionId: "huaanwork-auto-1", automationId: "a1" },
  ];
  assert.equal(outcomeTargetTab("huaanwork-aaaaaaaaaaaaaaaa", tabs, "work-1"), "work-1");
  assert.equal(outcomeTargetTab("child-session-9", tabs, "work-1"), undefined);
  assert.equal(outcomeTargetTab("huaanwork-auto-1", tabs, "work-1"), undefined);
  assert.equal(outcomeTargetTab(undefined, tabs, "work-1"), "work-1");
  assert.equal(outcomeTargetTab(undefined, tabs, "run-1"), undefined);
});

test("a late outcome is dropped when a newer user message already sits on the tab", () => {
  const items = [
    { id: 1, kind: "user" as const },
    { id: 2, kind: "assistant" as const },
  ];
  const notes = [{ id: 9, kind: "note" as const, text: "已完成：自动核对 1 项均通过" }];
  assert.equal(latestUserItemId(items), 1);
  assert.deepEqual(appendOutcomeNotes(items, 1, notes), [...items, ...notes]);
  const next = [...items, { id: 3, kind: "user" as const }];
  assert.equal(appendOutcomeNotes(next, 1, notes), next);
});

test("leading Chinese words are not part of the file name", () => {
  assert.deepEqual(extractRequiredFiles("帮我把总结写到报告.md里"), ["报告.md"]);
  assert.deepEqual(extractRequiredFiles("保存为周报/本周总结.md"), ["周报/本周总结.md"]);
  assert.deepEqual(extractRequiredFiles("整理一份总结报告.md"), ["整理一份总结报告.md"]);
});

test("a file matches only the exact name or a path ending in it", () => {
  const paths = treePaths([{ path: "/w/总结报告.md" }, { path: "/w/docs/报告.md" }]);
  assert.equal(fileExistsInTree(treePaths([{ path: "/w/报告.md" }]), "报告.md"), true);
  assert.equal(fileExistsInTree(paths, "报告.md"), true);
  assert.equal(fileExistsInTree(treePaths([{ path: "/w/总结报告.md" }]), "报告.md"), false);
  assert.equal(fileExistsInTree(treePaths([{ path: "/w/总结报告.md" }]), "整理一份总结报告.md"), false);
  assert.equal(fileExistsInTree(treePaths([{ path: "/w/周报/本周总结.md" }]), "保存周报/本周总结.md"), false);
  assert.equal(fileExistsInTree(treePaths([{ path: "/w/a报告.md" }]), "报告.md"), false);
  assert.equal(fileExistsInTree(treePaths([{ path: "/w/总结.md" }]), "报告.md"), false);
  assert.deepEqual(
    turnOutcomeNotes(turnChecks([{ kind: "user", text: "帮我把总结写到报告.md里" }]), [{ path: "/w/报告.md" }]),
    ["已完成：自动核对 1 项均通过"],
  );
});

test("帮我把总结写到报告.md里 extracts 报告.md", () => {
  assert.deepEqual(extractRequiredFiles("帮我把总结写到报告.md里"), ["报告.md"]);
});

test("的和与及或 stay inside the file name", () => {
  assert.deepEqual(extractRequiredFiles("请写我的报告.md"), ["我的报告.md"]);
  assert.deepEqual(extractRequiredFiles("写到项目的计划.md"), ["项目的计划.md"]);
  assert.equal(fileExistsInTree(treePaths([{ path: "/w/报告.md" }]), "我的报告.md"), false);
  assert.deepEqual(
    turnOutcomeNotes(turnChecks([{ kind: "user", text: "请写我的报告.md" }]), [{ path: "/w/报告.md" }]),
    ["缺少文件：我的报告.md"],
  );
});

test("总结报告.md is a gap when the tree only contains 报告.md", () => {
  assert.equal(fileExistsInTree(treePaths([{ path: "/w/报告.md" }]), "总结报告.md"), false);
  assert.deepEqual(
    turnOutcomeNotes(turnChecks([{ kind: "user", text: "请写 总结报告.md" }]), [{ path: "/w/报告.md" }]),
    ["缺少文件：总结报告.md"],
  );
});

test("a plain user and assistant turn produces no outcome note", () => {
  assert.deepEqual(turnOutcomeNotes(turnChecks([{ kind: "user", text: "你好" }, { kind: "assistant" }]), []), []);
});

test("a turn that ran a tool and names no file or command still needs a human look", () => {
  assert.deepEqual(
    turnOutcomeNotes(
      turnChecks([
        { kind: "user", text: "你好" },
        { kind: "assistant" },
        { kind: "tool", card: { name: "bash", isError: false } },
      ]),
      [],
    ),
    ["没有自动核对项，需要你自己看"],
  );
});

test("a session directory still checks the file when no project is open", () => {
  assert.equal(outcomeWorkspace(null, "/w"), "/w");
  assert.equal(outcomeWorkspace("/project", "/w"), "/project");
  assert.deepEqual(
    turnOutcomeNotes(
      turnChecks([
        { kind: "user", text: "读 notes/a.md" },
        { kind: "tool", card: { name: "read", status: "end" } },
      ]),
      [{ path: "/w/notes", children: [{ path: "/w/notes/a.md" }] }],
    ),
    ["已完成：自动核对 1 项均通过"],
  );
});

test("a minted session directory is used before the session list catches up", () => {
  assert.equal(lookupSessionCwd("s1", [], new Map([["s1", "/w"]])), "/w");
  assert.equal(lookupSessionCwd("s1", [{ id: "s1", cwd: "/listed" }], new Map([["s1", "/w"]])), "/listed");
  assert.equal(lookupSessionCwd("s1", [{ id: "s1" }], new Map()), undefined);
});

test("a deleted session does not paint onto a chat that already has another session", () => {
  const tabs = [{ id: "new", sessionId: undefined }, { id: "old", sessionId: "huaanwork-weather" }];
  assert.equal(eventTargetTab("huaanwork-weather", tabs, "new"), "old");
  assert.equal(eventTargetTab("huaanwork-weather", [{ id: "new" }], "new", "huaanwork-weather"), "new");
  assert.equal(eventTargetTab("huaanwork-weather", [{ id: "new" }], "new"), undefined);
  assert.equal(eventTargetTab("huaanwork-weather", [{ id: "new", sessionId: "other" }], "new", "huaanwork-weather"), undefined);
  assert.equal(eventTargetTab(undefined, [{ id: "new" }], "new"), "new");
});

test("a plan-review card with nothing to check still needs a human look", () => {
  assert.deepEqual(
    turnOutcomeNotes(
      turnChecks([
        { kind: "user", text: "你好" },
        { kind: "ask", card: { toolName: "plan-review", summary: "先看看" } },
      ]),
      [],
    ),
    ["没有自动核对项，需要你自己看"],
  );
});
