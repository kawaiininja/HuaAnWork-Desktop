import assert from "node:assert/strict";
import { test } from "vitest";
import { failureMarkers, resultTextFailed, shellCommandOf, toolArgumentLabel, toolRowIcon } from "../../src/client-huaanwork/logic/commandOutcome.ts";

test("failure markers follow the rc.1 bash renderResult lines", () => {
  assert.equal(resultTextFailed("ok\n[exit code: 1]"), true);
  assert.equal(resultTextFailed("ok\n[exit code: 127]"), true);
  assert.equal(resultTextFailed("ok\n[exit code: 0]"), false);
  assert.equal(resultTextFailed("(no output)\n[timed out after 30000ms]"), true);
  assert.equal(resultTextFailed("x\n[killed by signal: SIGKILL]"), true);
  assert.equal(resultTextFailed("x\n[stopped: user cancelled]"), true);
  assert.equal(resultTextFailed("x\n[sandbox: file access denied under workspace-write mode]"), true);
  assert.equal(resultTextFailed("all good"), false);
  // a marker must be a line of its own, not text in the middle of output
  assert.equal(resultTextFailed("the log says [exit code: 1] sometimes"), false);
});

test("markers are found in the tail of long output, and listed for re-attachment", () => {
  const long = `${"x".repeat(20_000)}\n[exit code: 2]`;
  assert.equal(resultTextFailed(long), true);
  assert.deepEqual(failureMarkers(long), ["[exit code: 2]"]);
  assert.deepEqual(failureMarkers("fine"), []);
});

test("shell commands come only from bash / pwsh arguments", () => {
  assert.equal(shellCommandOf("bash", { command: "pnpm test" }), "pnpm test");
  assert.equal(shellCommandOf("pwsh", { command: "dir" }), "dir");
  assert.equal(shellCommandOf("write", { command: "x" }), undefined);
  assert.equal(shellCommandOf("bash", { command: "  " }), undefined);
  assert.equal(shellCommandOf("bash", undefined), undefined);
});

test("recorded JSON-string arguments yield the command, not an unparsed blob", () => {
  assert.equal(shellCommandOf("bash", '{"command":"pnpm test"}'), "pnpm test");
  assert.equal(shellCommandOf("pwsh", '{"command":"Get-ChildItem"}'), "Get-ChildItem");
  assert.equal(shellCommandOf("bash", '{"command":"  "}'), undefined);
  assert.equal(shellCommandOf("bash", '{"args":["x"]}'), undefined);
  assert.equal(shellCommandOf("bash", "not json"), undefined);
});

test("a failed tool row shows a cross, not a check", () => {
  assert.equal(toolRowIcon({ status: "start" }), "●");
  assert.equal(toolRowIcon({ status: "end" }), "✓");
  assert.equal(toolRowIcon({ status: "end", isError: true }), "✗");
});

test("history tool rows show the command over args and clip it to one display line", () => {
  assert.equal(toolArgumentLabel({ command: "pnpm test", args: '{"command":"pnpm test"}' }), "pnpm test");
  assert.equal(toolArgumentLabel({ args: '{"path":"a.md"}' }), '{"path":"a.md"}');
  assert.equal(toolArgumentLabel({ command: "  \n ", args: "ls -la\n" }), "ls -la");
  assert.equal(toolArgumentLabel({}), undefined);
  const long = "x".repeat(300);
  assert.equal(toolArgumentLabel({ command: long }), `${"x".repeat(200)}…`);
});
