import { describe, expect, it } from "vitest";

import { historyItemsFromRecords } from "../../src/client-huaanwork/logic/sessionChannel.ts";
import {
  currentSnapshotRoundKey,
  normalizeTodoEntries,
  shouldApplyTodoEvent,
} from "../../src/client-huaanwork/logic/todoProjection.ts";
import { createTurnAnchorStore } from "../../src/huaanwork-host/turn-anchors.ts";
import { detailRecords } from "../../src/huaanwork-host/session-view.ts";
import type { SessionDetailRecord } from "../../src/client-huaanwork/rpc-types.ts";

describe("todoProjection", () => {
  it("normalizes the three todo states and drops malformed entries", () => {
    expect(normalizeTodoEntries([
      { content: "分析", status: "completed" },
      { content: "实施", status: "in_progress" },
      { content: "验证", status: "pending" },
    ])).toHaveLength(3);
    // 与实时 bridge（bridge.spec.ts:534-560）同一语义：坏条目逐条丢弃，不是整单拒绝
    expect(normalizeTodoEntries([{ content: "核对", status: "weird" }, { content: 3, status: "pending" }])).toEqual([]);
    expect(normalizeTodoEntries([])).toEqual([]); // 空数组合法
    expect(normalizeTodoEntries('{"todos":[]}')).toBeUndefined(); // 非数组 → undefined
  });

  it("rejects events without exact anchor or with stale roundKey", () => {
    const items = [
      { kind: "user", id: 1, clientMessageId: "m-1" },
      { kind: "todo", todos: [{ content: "旧任务", status: "completed" as const }], roundKey: 4, id: 2 },
      { kind: "tool", roundKey: 4, id: 3 },
    ];
    const turnStart = 1;
    expect(shouldApplyTodoEvent(items, turnStart, { clientMessageId: "m-0", roundKey: 5 }, 4)).toBe(false); // 上一回合迟到
    expect(shouldApplyTodoEvent(items, turnStart, { clientMessageId: "m-1", roundKey: 3 }, 4)).toBe(false); // roundKey 回退
    expect(shouldApplyTodoEvent(items, turnStart, { clientMessageId: "m-1", roundKey: 4 }, 4)).toBe(true); // 同 roundKey 允许
    expect(shouldApplyTodoEvent(items, turnStart, { clientMessageId: "m-1", roundKey: 5 }, 4)).toBe(true);
    expect(shouldApplyTodoEvent(items, turnStart, { roundKey: 5 }, 4)).toBe(false); // 无锚 fail-closed
    expect(shouldApplyTodoEvent(items, turnStart, { clientMessageId: "m-1" }, 4)).toBe(false); // roundKey 必填
    // QP-M2：用户条目无 clientMessageId 时，即使事件 clientMessageId 恰好等于 String(id) 亦必须拒绝
    expect(shouldApplyTodoEvent([{ kind: "user", id: 7 }], 1, { clientMessageId: "7", roundKey: 5 }, 0)).toBe(false);
  });

  it("reads the current snapshot roundKey only from this turn's todo", () => {
    const items = [
      { kind: "user", id: 1, clientMessageId: "m-1" },
      { kind: "todo", id: 2, roundKey: 3 },
      { kind: "user", id: 3, clientMessageId: "m-2" },
      { kind: "todo", id: 4, roundKey: 8 },
      { kind: "assistant", id: 5, roundKey: 9 },
    ];
    expect(currentSnapshotRoundKey(items, 3)).toBe(8);
    // 前序回合的快照不在本回合切片里,不参与当前快照。
    expect(currentSnapshotRoundKey(items.slice(0, 3), 1)).toBe(3);
    expect(currentSnapshotRoundKey([{ kind: "user", id: 1, clientMessageId: "m-1" }], 1)).toBeUndefined();
    expect(currentSnapshotRoundKey([], 0)).toBeUndefined();
  });

  it("keeps one user turn and anchors goal-continuation todo events to the original send", () => {
    // 真实用户发送 → 锚点落定。
    const anchors = createTurnAnchorStore();
    anchors.register({ sessionId: "s1", clientMessageId: "m1", origin: "advanced" });
    const original = anchors.notePreStep("s1", [{ role: "user", id: "m1", source: { kind: "user" } }], "t1");
    // 完成通知/运行时上下文/指令注入/技能目录落盘:锚点保持原真实用户消息。
    const notices = ["subagent-settled", "runtime-context", "agent-instructions", "skill-catalog"];
    notices.forEach((kind, index) => {
      anchors.notePreStep("s1", [{ role: "user", id: `notice-${index}`, source: { kind } }], `t${index + 2}`);
    });
    expect(anchors.current("s1")).toEqual(original);
    expect(original?.clientMessageId).toBe("m1");

    const log = sessionLog([
      HEADER,
      userMessage("修好构建", 1, T0 + 3),
      userMessage("子代理完成", 2, T0 + 4, { kind: "subagent-settled" }),
      userMessage("运行时上下文", 3, T0 + 5, { kind: "runtime-context" }),
      userMessage("指令注入", 4, T0 + 6, { kind: "agent-instructions" }),
      userMessage("技能目录", 5, T0 + 7, { kind: "skill-catalog" }),
      stepStart(6, T0 + 8),
      toolCall("t1", { todos: [{ content: "复现", status: "completed" }] }, 7, T0 + 9),
      toolResult("t1", "updated", 8, T0 + 10),
      goalContinuation("mg", 1, 9, T0 + 11),
      stepStart(10, T0 + 12),
      toolCall("t2", {
        todos: [
          { content: "复现", status: "completed" },
          { content: "修复", status: "in_progress" },
        ],
      }, 11, T0 + 13),
    ]);
    const records = detailRecords(log);
    // 全程只有 1 条普通用户回合;goal 续轮仍是带 goalRound 的独立记录,不切分用户回合。
    expect(records.filter((record) => record.kind === "user" && record.goalRound === undefined)).toEqual([
      { kind: "user", time: T0 + 3, text: "修好构建", clientMessageId: "m1" },
    ]);
    const todoCalls = records.filter(
      (record): record is Extract<SessionDetailRecord, { kind: "tool-call" }> =>
        record.kind === "tool-call" && record.name === "todo_write",
    );
    expect(todoCalls.map((record) => record.clientMessageId)).toEqual(["m1", "m1"]);

    // 历史回放与实时事件走同一份守卫:续轮待办仍锚定原真实用户回合。
    // App 的 `currentTurnStart` 就是最后一条已启动用户条目之后的位置。
    const items = historyItemsFromRecords(records);
    expect(items.filter((item) => item.kind === "user")).toHaveLength(1);
    const turnStart = items.findLastIndex((item) => item.kind === "user") + 1;
    const snapshotRoundKey = currentSnapshotRoundKey(items, turnStart);
    expect(items.findLast((item) => item.kind === "todo")).toMatchObject({ clientMessageId: "m1", roundKey: 10 });
    expect(shouldApplyTodoEvent(items, turnStart, { clientMessageId: "m1", roundKey: 10 }, snapshotRoundKey)).toBe(true);
    // 其他（旧）回合的锚点仍被拒绝。
    expect(shouldApplyTodoEvent(items, turnStart, { clientMessageId: "m0", roundKey: 10 }, snapshotRoundKey)).toBe(false);
  });
});

const T0 = 1_787_907_111_933;

const HEADER = {
  type: "session",
  version: 0,
  id: "huaanwork-todo-projection",
  createdAt: T0,
  cwd: "/repo/demo",
  delegationDepth: 0,
};

function sessionLog(entries: Record<string, unknown>[]): string {
  return `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

function userMessage(text: string, seq: number, time: number, source: Record<string, unknown> = { kind: "user" }) {
  return {
    type: "user/message",
    seq,
    time,
    surfaceOp: "append",
    data: { id: `m${seq}`, role: "user", content: [{ type: "text", text }], source },
  };
}

function goalContinuation(id: string, round: number, seq: number, time: number) {
  return {
    type: "user/message",
    seq,
    time,
    surfaceOp: "append",
    data: {
      id,
      role: "user",
      content: [{ type: "text", text: "官方续轮提示" }],
      source: { kind: "goal", goalId: "g", round },
    },
  };
}

function stepStart(seq: number, time: number) {
  return { type: "step/start", seq, time, data: { turn: 0, step: 0 } };
}

/** 真实日志把 `arguments` 序列化成 JSON 字符串。 */
function toolCall(callId: string, args: Record<string, unknown>, seq: number, time: number) {
  return { type: "tool/call", seq, time, data: { turn: 0, step: 0, callId, name: "todo_write", arguments: JSON.stringify(args) } };
}

function toolResult(callId: string, text: string, seq: number, time: number) {
  return {
    type: "tool/result",
    seq,
    time,
    surfaceOp: "append",
    data: {
      turn: 0,
      step: 0,
      message: {
        id: `m${seq}`,
        role: "tool",
        source: { kind: "tool", callId },
        toolCallId: callId,
        content: [{ type: "text", text }],
        isError: false,
      },
    },
  };
}
