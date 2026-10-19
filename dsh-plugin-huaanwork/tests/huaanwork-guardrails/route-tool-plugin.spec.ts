import assert from "node:assert/strict";
import { test } from "vitest";
import { preferControlCalls } from "../../src/huaanwork-guardrails/route-tools.ts";
import { apply, cancelRouteInput, noteInvalidRoute } from "../../src/huaanwork-guardrails/route-tool-plugin.ts";

test("a control call drops sibling ordinary calls before they are emitted", () => {
  assert.deepEqual(
    preferControlCalls([
      { name: "read", args: { file_path: "a.md" } },
      { name: "propose_plan", args: { objective: "汇总三份材料" } },
    ]).map((call) => call.name),
    ["propose_plan"],
  );
});

test("propose_plan execute enters plan mode for the current agent", async () => {
  const agent = { id: "huaanwork-0123456789abcdef" };
  const seen: unknown[] = [];
  const tools = new Map<string, { execute: (args: unknown) => Promise<unknown> }>();
  apply({
    huaanworkRouteAgent: { current: agent },
    planMode: { set(next: unknown, active: boolean) { seen.push([next, active]); return "queued"; } },
    tools: { register(definition: { name: string; execute: (args: unknown) => Promise<unknown> }) { tools.set(definition.name, definition); } },
  });
  await tools.get("propose_plan")?.execute({ objective: "汇总三份材料" });
  assert.deepEqual(seen, [[agent, true]]);
});

test("route tools act on the executing agent, not the shared holder", async () => {
  const sent = { id: "huaanwork-aaaaaaaaaaaaaaaa", cancel() {} };
  const later = { id: "huaanwork-bbbbbbbbbbbbbbbb", cancelled: 0, cancel() { this.cancelled += 1; } };
  const seen: unknown[] = [];
  type Exec = { agent?: unknown; signal?: AbortSignal };
  const tools = new Map<string, { execute: (args: unknown, exec?: Exec) => Promise<unknown> }>();
  apply({
    huaanworkRouteAgent: { current: sent },
    planMode: { set(next: unknown, active: boolean) { seen.push([next, active]); return "queued"; } },
    tools: { register(definition: { name: string; execute: (args: unknown, exec?: Exec) => Promise<unknown> }) { tools.set(definition.name, definition); } },
  });

  await tools.get("propose_plan")?.execute({ objective: "汇总三份材料" }, { agent: later });
  assert.deepEqual(seen, [[later, true]]);

  const waiting = tools.get("request_input")?.execute({ question: "哪一份？" }, { agent: later });
  assert.equal(cancelRouteInput(later.id), true);
  await assert.rejects(waiting!, /用户取消了这个问题/);
  assert.equal(later.cancelled, 1);
});

test("the second invalid route call ends the turn", () => {
  assert.equal(noteInvalidRoute("s1").endTurn, false);
  assert.equal(noteInvalidRoute("s1").endTurn, true);
  assert.equal(noteInvalidRoute("s1").text, "没能理解这个请求");
});
