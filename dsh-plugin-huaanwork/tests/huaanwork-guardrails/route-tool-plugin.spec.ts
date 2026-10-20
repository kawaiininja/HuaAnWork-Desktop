import assert from "node:assert/strict";
import { test } from "vitest";
import { preferControlCalls } from "../../src/huaanwork-guardrails/route-tools.ts";
import {
  answerRouteInput,
  apply,
  cancelRouteInput,
  clearInvalidRoute,
  noteInvalidRoute,
  releaseRouteInput,
} from "../../src/huaanwork-guardrails/route-tool-plugin.ts";

type Exec = { agent?: unknown; signal?: AbortSignal };
type Registered = { name: string; execute: (args: unknown, exec?: Exec) => Promise<unknown> };

function routeTools(emitted: unknown[], emit = true, unattended?: { sessionId?: string; [key: string]: unknown }) {
  const tools = new Map<string, Registered>();
  apply({
    huaanworkRouteAgent: { current: null },
    ...(emit ? { huaanworkEmit: (event: unknown) => { emitted.push(event); } } : {}),
    ...(unattended ? { huaanworkUnattended: { current: unattended } } : {}),
    planMode: { set() { return "queued"; } },
    tools: { register(definition: Registered) { tools.set(definition.name, definition); } },
  });
  return tools;
}

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
  const tools = new Map<string, { execute: (args: unknown, exec?: Exec) => Promise<unknown> }>();
  apply({
    huaanworkRouteAgent: { current: sent },
    huaanworkEmit: () => undefined,
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

test("request_input shows the question in the chat and returns the submitted answer", async () => {
  const emitted: unknown[] = [];
  const tools = routeTools(emitted);
  const agent = { id: "huaanwork-cccccccccccccccc" };
  const waiting = tools.get("request_input")!.execute({ question: "发给谁？" }, { agent });
  await Promise.resolve();
  assert.deepEqual(emitted, [{ event: "input/asked", question: "发给谁？", sessionId: agent.id }]);
  assert.equal(answerRouteInput(agent.id, "张三"), true);
  assert.deepEqual(await waiting, { text: "张三" });
  assert.equal(answerRouteInput(agent.id, "again"), false);
});

test("stopping the turn releases a waiting request_input", async () => {
  const tools = routeTools([]);
  const agent = { id: "huaanwork-dddddddddddddddd" };
  const controller = new AbortController();
  const aborted = tools.get("request_input")!.execute({ question: "哪个目录？" }, { agent, signal: controller.signal });
  controller.abort();
  await assert.rejects(aborted, /回合已停止/);
  assert.equal(answerRouteInput(agent.id, "late"), false);

  const released = tools.get("request_input")!.execute({ question: "哪个目录？" }, { agent });
  await Promise.resolve();
  assert.equal(releaseRouteInput(agent.id), true);
  await assert.rejects(released, /回合已停止/);
  assert.equal(releaseRouteInput(agent.id), false);
});

test("request_input does not wait when no chat can show the question", async () => {
  const tools = routeTools([], false);
  const agent = { id: "huaanwork-eeeeeeeeeeeeeeee" };
  await assert.rejects(tools.get("request_input")!.execute({ question: "发给谁？" }, { agent }), /没有可以显示问题的对话/);
  assert.equal(answerRouteInput(agent.id, "x"), false);
});

test("request_input fails closed under the matching unattended scope instead of parking", async () => {
  const emitted: unknown[] = [];
  const agent = { id: "huaanwork-9999999999999999" };
  const tools = routeTools(emitted, true, { runId: "run-1", automationId: "auto-1", sessionId: agent.id });
  await assert.rejects(
    tools.get("request_input")!.execute({ question: "发给谁？" }, { agent }),
    /无人值守运行没有可以回答这个问题的人/,
  );
  // 没有人类卡片:不 emit、不登记待答(点了也不会静默成功)。
  assert.deepEqual(emitted, []);
  assert.equal(answerRouteInput(agent.id, "late"), false);

  // 其他会话(人在自动化运行期间)照常等卡片,不被错误地降级。
  const attended = routeTools(emitted, true, { runId: "run-2", automationId: "auto-2", sessionId: "automation-1" });
  const human = { id: "huaanwork-aaaaaaaaaaaaaaaa" };
  const waiting = attended.get("request_input")!.execute({ question: "哪一份？" }, { agent: human });
  await Promise.resolve();
  assert.deepEqual(emitted, [{ event: "input/asked", question: "哪一份？", sessionId: human.id }]);
  assert.equal(answerRouteInput(human.id, "甲"), true);
  assert.deepEqual(await waiting, { text: "甲" });
});

test("control-tool execute validates through the shared classifier, not a copy", async () => {
  const emitted: unknown[] = [];
  const tools = routeTools(emitted);
  const planAgent = { id: "huaanwork-1111111111111111" };
  const askAgent = { id: "huaanwork-2222222222222222" };
  // 多出未声明字段 ⇒ classifyToolCalls 判 invalid，execute 返回可修正的错误。
  await assert.rejects(
    tools.get("propose_plan")!.execute({ objective: "汇总", steps: [] }, { agent: planAgent }),
    /只接受一个非空字符串字段 objective/,
  );
  await assert.rejects(
    tools.get("request_input")!.execute({ question: "  " }, { agent: askAgent }),
    /只接受一个非空字符串字段 question/,
  );
  assert.deepEqual(emitted, []);
});

test("a throwing chat emit does not leave the question waiting", async () => {
  const tools = new Map<string, { name: string; execute: (args: unknown, exec?: Exec) => Promise<unknown> }>();
  apply({
    huaanworkRouteAgent: { current: null },
    huaanworkEmit: () => {
      throw new Error("chat is gone");
    },
    planMode: { set() { return "queued"; } },
    tools: {
      register(definition: { name: string; execute: (args: unknown, exec?: Exec) => Promise<unknown> }) {
        tools.set(definition.name, definition);
      },
    },
  });
  const agent = { id: "huaanwork-ffffffffffffffff" };
  await assert.rejects(tools.get("request_input")!.execute({ question: "发给谁？" }, { agent }), /chat is gone/);
  assert.equal(releaseRouteInput(agent.id), false);
});

test("the second invalid route call ends the turn", () => {
  assert.equal(noteInvalidRoute("s1").endTurn, false);
  assert.equal(noteInvalidRoute("s1").endTurn, true);
  assert.equal(noteInvalidRoute("s1").text, "没能理解这个请求");
});

test("the next accepted user turn gets another repair", () => {
  assert.equal(noteInvalidRoute("s2").endTurn, false);
  assert.equal(noteInvalidRoute("s2").endTurn, true);
  clearInvalidRoute("s2");
  assert.equal(noteInvalidRoute("s2").endTurn, false);
});
