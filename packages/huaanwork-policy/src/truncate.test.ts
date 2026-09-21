import assert from "node:assert/strict";
import { test } from "node:test";

import { capToolOutput } from "./truncate.ts";

test("concatenates stdout and stderr below the limit", () => {
  assert.deepEqual(capToolOutput("out", "err"), {
    text: "outerr",
    truncated: false,
  });
});

test("caps output at 32768 UTF-8 bytes", () => {
  const result = capToolOutput("x".repeat(32 * 1024 + 1), "");

  assert.equal(result.truncated, true);
  assert.equal(Buffer.byteLength(result.text, "utf8"), 32 * 1024);
});

test("caps multibyte output without splitting a code point", () => {
  const result = capToolOutput("€".repeat(32 * 1024), "");

  assert.equal(result.truncated, true);
  assert.equal(Buffer.byteLength(result.text, "utf8") <= 32 * 1024, true);
  assert.equal(result.text.endsWith("€"), true);
});

test("does not grow an already truncated payload", () => {
  const result = capToolOutput("payload", "ignored", true);

  assert.deepEqual(result, { text: "payload", truncated: true });
});

test("supports an explicit output limit", () => {
  assert.deepEqual(capToolOutput("abcdef", "", false, 3), {
    text: "abc",
    truncated: true,
  });
});
