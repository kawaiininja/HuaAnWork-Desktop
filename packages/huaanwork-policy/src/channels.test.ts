import assert from "node:assert/strict";
import { test } from "node:test";

import { sessionIdOfAgentRef } from "./channels.ts";

test("sessionIdOfAgentRef prefers session.id and falls back to agent id", () => {
  assert.equal(sessionIdOfAgentRef({ id: "agent-1", session: { id: "sess-1" } }), "sess-1");
  assert.equal(sessionIdOfAgentRef({ id: "agent-1" }), "agent-1");
  assert.equal(sessionIdOfAgentRef({ id: "agent-1", session: {} }), "agent-1");
  assert.equal(sessionIdOfAgentRef(undefined), undefined);
  assert.equal(sessionIdOfAgentRef({}), undefined);
  assert.equal(sessionIdOfAgentRef({ id: "", session: { id: "" } }), undefined);
});
