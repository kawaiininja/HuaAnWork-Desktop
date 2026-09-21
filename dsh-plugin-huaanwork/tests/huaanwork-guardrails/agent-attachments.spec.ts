import assert from "node:assert/strict";
import { test } from "vitest";

import {
  attachAgentTools,
  attachHostTool,
  detachAgentTools,
  detachHostTool,
  emptyAttachments,
  isHostAttached,
  isMcpAttached,
} from "../../src/huaanwork-guardrails/agent-attachments.ts";

test("emptyAttachments creates fresh independent maps", () => {
  const maps1 = emptyAttachments();
  const maps2 = emptyAttachments();
  assert.notEqual(maps1, maps2);
  assert.notEqual(maps1.sessionHostTools, maps2.sessionHostTools);
  assert.notEqual(maps1.sessionAgentTools, maps2.sessionAgentTools);
  assert.equal(maps1.sessionHostTools.size, 0);
  assert.equal(maps1.sessionAgentTools.size, 0);
});

test("attachHostTool attaches name to session A and not session B", () => {
  const maps = emptyAttachments();
  attachHostTool(maps, "session-a", "pdf-extract");

  assert.equal(isHostAttached(maps, "session-a", "pdf-extract"), true);
  assert.equal(isHostAttached(maps, "session-b", "pdf-extract"), false);
  assert.equal(isHostAttached(maps, "session-a", "other-tool"), false);
});

test("detachHostTool detaches tool from session A", () => {
  const maps = emptyAttachments();
  attachHostTool(maps, "session-a", "pdf-extract");
  assert.equal(isHostAttached(maps, "session-a", "pdf-extract"), true);

  detachHostTool(maps, "session-a", "pdf-extract");
  assert.equal(isHostAttached(maps, "session-a", "pdf-extract"), false);

  assert.doesNotThrow(() => detachHostTool(maps, "session-a", "pdf-extract"));
  assert.doesNotThrow(() => detachHostTool(maps, "session-unknown", "pdf-extract"));
});

test("attachAgentTools and detachAgentTools manage MCP tools per session", () => {
  const maps = emptyAttachments();
  attachAgentTools(maps, "session-a", ["mcp__git__status", "mcp__git__commit"]);

  assert.equal(isMcpAttached(maps, "session-a", "mcp__git__status"), true);
  assert.equal(isMcpAttached(maps, "session-a", "mcp__git__commit"), true);
  assert.equal(isMcpAttached(maps, "session-b", "mcp__git__status"), false);
  assert.equal(isMcpAttached(maps, "session-a", "mcp__git__diff"), false);

  detachAgentTools(maps, "session-a", ["mcp__git__status"]);
  assert.equal(isMcpAttached(maps, "session-a", "mcp__git__status"), false);
  assert.equal(isMcpAttached(maps, "session-a", "mcp__git__commit"), true);

  assert.doesNotThrow(() => detachAgentTools(maps, "session-unknown", ["mcp__foo"]));
});

test("isHostAttached and isMcpAttached return false for undefined or empty inputs", () => {
  const maps = emptyAttachments();
  attachHostTool(maps, "session-a", "pdf-extract");
  attachAgentTools(maps, "session-a", ["mcp__git__status"]);

  assert.equal(isHostAttached(undefined, "session-a", "pdf-extract"), false);
  assert.equal(isHostAttached(maps, undefined, "pdf-extract"), false);
  assert.equal(isHostAttached(maps, "", "pdf-extract"), false);
  assert.equal(isHostAttached(maps, "session-a", ""), false);

  assert.equal(isMcpAttached(undefined, "session-a", "mcp__git__status"), false);
  assert.equal(isMcpAttached(maps, undefined, "mcp__git__status"), false);
  assert.equal(isMcpAttached(maps, "", "mcp__git__status"), false);
  assert.equal(isMcpAttached(maps, "session-a", ""), false);
});
