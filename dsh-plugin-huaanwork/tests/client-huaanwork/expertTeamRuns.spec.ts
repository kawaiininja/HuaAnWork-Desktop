import { describe, expect, it } from "vitest";

import {
  expertTeamCounts,
  insertExpertTeamRunCard,
  isExpertTeamTerminal,
  reduceExpertTeamRuns,
  type ExpertTeamRunAction,
  type ExpertTeamRunsState,
} from "../../src/client-huaanwork/logic/expertTeamRuns.ts";
import type { ExpertTeamRun, TaskArtifactSummary } from "../../src/client-huaanwork/rpc-types.ts";
import { artifact, validTeam } from "../fixtures/expert-team/team.ts";

/**
 * 专家团聚合运行卡的客户端对账（Task 13）：乱序 revision、终态回退、换代丢弃、
 * 同代重连解冻、空快照按会话对账、终态淘汰上限与回合锚定。
 */

function emptyExpertTeamRuns(): ExpertTeamRunsState {
  return { revision: 0, runs: new Map(), connection: "open" };
}

function run(overrides: Partial<ExpertTeamRun> = {}): ExpertTeamRun {
  const team = validTeam();
  return {
    teamRunId: "run-1",
    parentSessionId: "s1",
    clientMessageId: "m1",
    teamId: team.id,
    teamSnapshot: team,
    status: "running",
    results: [],
    artifactStatus: "not-required",
    deliverySealed: false,
    unifiedRevisionRounds: 0,
    dispatchAttempts: 0,
    startedAt: "2026-01-01T00:00:00Z",
    revision: 1,
    ...overrides,
  };
}

function stateWithActiveRun(overrides: Partial<ExpertTeamRun> = {}): ExpertTeamRunsState {
  const active = run(overrides);
  return {
    generation: "g1",
    revision: active.revision,
    runs: new Map([[active.teamRunId, active]]),
    connection: "open",
  };
}

function runAction(incoming: ExpertTeamRun): ExpertTeamRunAction {
  return { type: "run", generation: "g1", run: incoming };
}

function timestamp(offsetSeconds: number): string {
  return new Date(Date.UTC(2026, 0, 1) + offsetSeconds * 1_000).toISOString();
}

type ChatLikeItem =
  | { id: number; kind: "user"; text: string; clientMessageId: string }
  | { id: number; kind: "assistant"; text: string }
  | { id: number; kind: "artifact"; artifactId: string; artifact: TaskArtifactSummary }
  | { id: number; kind: "expert-team-run"; teamRunId: string };

let nextItemId = 0;

function userItem(clientMessageId: string): ChatLikeItem {
  nextItemId += 1;
  return { id: nextItemId, kind: "user", text: `消息 ${clientMessageId}`, clientMessageId };
}

function assistantItem(label: string): ChatLikeItem {
  nextItemId += 1;
  return { id: nextItemId, kind: "assistant", text: `回复 ${label}` };
}

describe("expert team run projection", () => {
  it("merges only same-generation revisions in order and prevents status regressions", () => {
    let state = emptyExpertTeamRuns();
    state = reduceExpertTeamRuns(state, {
      type: "snapshot",
      sessionId: "s1",
      generation: "g1",
      revision: 2,
      runs: [run({ revision: 2 })],
    });
    expect(state.generation).toBe("g1");
    expect(state.revision).toBe(2);
    expect(state.connection).toBe("open");

    state = reduceExpertTeamRuns(state, { type: "run", generation: "g1", run: run({ revision: 1, status: "failed" }) });
    expect(state.runs.get("run-1")).toMatchObject({ revision: 2, status: "running" });

    state = reduceExpertTeamRuns(state, {
      type: "run",
      generation: "g1",
      run: run({ revision: 3, status: "completed", endedAt: timestamp(3) }),
    });
    expect(state.runs.get("run-1")).toMatchObject({ revision: 3, status: "completed" });

    // 同代空快照在 snapshot.revision >= existing.revision 时仅清理当前 sessionId 的缺失终态，不误删新于 snapshot.revision 的运行或其他 tab
    state = reduceExpertTeamRuns(state, { type: "snapshot", sessionId: "s1", generation: "g1", revision: 4, runs: [] });
    expect(state.runs.has("run-1")).toBe(false);
  });

  it("reconciles same-generation snapshots only for the reported session and revision", () => {
    const sameTabTerminal = run({
      teamRunId: "run-terminal",
      clientMessageId: "m2",
      status: "completed",
      endedAt: timestamp(1),
      revision: 1,
    });
    const sameTabStopping = run({ teamRunId: "run-stopping", clientMessageId: "m3", status: "stopping", revision: 1 });
    const otherTabTerminal = run({
      teamRunId: "run-other",
      parentSessionId: "s2",
      clientMessageId: "m4",
      status: "completed",
      endedAt: timestamp(1),
      revision: 1,
    });
    const newerTerminal = run({
      teamRunId: "run-newer",
      clientMessageId: "m5",
      status: "completed",
      endedAt: timestamp(2),
      revision: 5,
    });
    const before: ExpertTeamRunsState = {
      generation: "g1",
      revision: 5,
      runs: new Map(
        [sameTabTerminal, sameTabStopping, otherTabTerminal, newerTerminal].map((item) => [item.teamRunId, item]),
      ),
      connection: "closed",
      frozenAt: timestamp(9),
    };

    const next = reduceExpertTeamRuns(before, {
      type: "snapshot",
      sessionId: "s1",
      generation: "g1",
      revision: 2,
      runs: [],
    });
    // 同 tab 的终态历史在快照 r2 之前已结束，按缺失项清理
    expect(next.runs.has("run-terminal")).toBe(false);
    // 停止中、其他 tab、以及快照捕获后才到达的高 revision 运行一律保留
    expect(next.runs.has("run-stopping")).toBe(true);
    expect(next.runs.has("run-other")).toBe(true);
    expect(next.runs.has("run-newer")).toBe(true);
    expect(next.revision).toBe(5);
    expect(next.connection).toBe("open");
    expect(next.frozenAt).toBeUndefined();
    // 入参状态与其中的 Map 不被修改
    expect(before.runs.size).toBe(4);
    expect(before.connection).toBe("closed");

    // 空快照没有 sessionId 时不猜测归属，不做缺项删除
    const withoutSession = reduceExpertTeamRuns(before, {
      type: "snapshot",
      generation: "g1",
      revision: 9,
      runs: [],
    });
    expect(withoutSession.runs.size).toBe(4);

    // 快照写入按 existing.revision <= action.revision 合并
    const lowerSnapshot = reduceExpertTeamRuns(before, {
      type: "snapshot",
      sessionId: "s1",
      generation: "g1",
      revision: 4,
      runs: [run({ teamRunId: "run-newer", revision: 4, status: "partial", endedAt: timestamp(4) })],
    });
    expect(lowerSnapshot.runs.get("run-newer")).toMatchObject({ revision: 5, status: "completed" });
  });

  it("freezes timers on disconnect, unfreezes on same-generation reconnect snapshot, and drops old-generation cards on Host restart", () => {
    let state = stateWithActiveRun({ startedAt: "2026-01-01T00:00:00Z" });
    state = reduceExpertTeamRuns(state, { type: "disconnect", at: "2026-01-01T00:00:05Z" });
    expect(state.connection).toBe("closed");
    expect(state.frozenAt).toBe("2026-01-01T00:00:05Z");
    // 断连只冻结连接，绝不把运行改写为 stopped
    expect(state.runs.get("run-1")?.status).toBe("running");

    // 重复断连保留首次冻结时刻
    state = reduceExpertTeamRuns(state, { type: "disconnect", at: "2026-01-01T00:00:06Z" });
    expect(state.frozenAt).toBe("2026-01-01T00:00:05Z");

    // 同代重连 snapshot 必须恢复 connection='open' 并清除 frozenAt，使运行卡操作立即可用
    state = reduceExpertTeamRuns(state, {
      type: "snapshot",
      sessionId: "s1",
      generation: "g1",
      revision: 2,
      runs: [run({ revision: 2 })],
    });
    expect(state.connection).toBe("open");
    expect(state.frozenAt).toBeUndefined();
    expect(state.runs.get("run-1")?.revision).toBe(2);

    // 再次断连后换代：清空旧运行、恢复 open 并清除 frozenAt
    state = reduceExpertTeamRuns(state, { type: "disconnect", at: "2026-01-01T00:00:10Z" });
    state = reduceExpertTeamRuns(state, { type: "snapshot", sessionId: "s1", generation: "g2", revision: 0, runs: [] });
    expect(state.runs.size).toBe(0);
    expect(state.generation).toBe("g2");
    expect(state.revision).toBe(0);
    expect(state.connection).toBe("open");
    expect(state.frozenAt).toBeUndefined();
  });

  it("prevents status regressions regardless of revision and ignores foreign-generation events", () => {
    let state = stateWithActiveRun({ revision: 2 });
    // 同 revision 或更低 revision 的帧不回滚
    expect(reduceExpertTeamRuns(state, runAction(run({ revision: 2, status: "failed" })))).toBe(state);
    expect(reduceExpertTeamRuns(state, runAction(run({ revision: 1, status: "failed" })))).toBe(state);

    // 终态后更高 revision 的 running/stopping 不复活旧运行
    const completed = reduceExpertTeamRuns(
      state,
      runAction(run({ revision: 3, status: "completed", endedAt: timestamp(3) })),
    );
    expect(reduceExpertTeamRuns(completed, runAction(run({ revision: 4, status: "running" })))).toBe(completed);
    expect(reduceExpertTeamRuns(completed, runAction(run({ revision: 4, status: "stopping" })))).toBe(completed);
    // terminal -> terminal 仍按 revision 合并（停止收敛）
    const stopped = reduceExpertTeamRuns(
      completed,
      runAction(run({ revision: 4, status: "stopped", endedAt: timestamp(4) })),
    );
    expect(stopped.runs.get("run-1")).toMatchObject({ revision: 4, status: "stopped" });

    // stopping 不回退 running，但可以继续收敛到终态
    const stopping = reduceExpertTeamRuns(state, runAction(run({ revision: 3, status: "stopping" })));
    expect(stopping.runs.get("run-1")).toMatchObject({ revision: 3, status: "stopping" });
    expect(reduceExpertTeamRuns(stopping, runAction(run({ revision: 4, status: "running" })))).toBe(stopping);
    expect(
      reduceExpertTeamRuns(stopping, runAction(run({ revision: 4, status: "completed", endedAt: timestamp(5) }))).runs.get(
        "run-1",
      ),
    ).toMatchObject({ revision: 4, status: "completed" });

    // 其他代际的事件一律忽略，不能混入当前对账
    expect(reduceExpertTeamRuns(state, { type: "run", generation: "g2", run: run({ revision: 9, status: "failed" }) })).toBe(
      state,
    );
  });

  it("accepts the first run event as the initial generation until a snapshot reconciles", () => {
    const state = reduceExpertTeamRuns(emptyExpertTeamRuns(), runAction(run()));
    expect(state.generation).toBe("g1");
    expect(state.revision).toBe(1);
    expect(state.runs.get("run-1")?.status).toBe("running");
  });

  it("evicts terminal history per parent and globally without evicting active or stopping runs", () => {
    let state = emptyExpertTeamRuns();
    const active = run({ teamRunId: "run-active", clientMessageId: "m-active" });
    const stopping = run({ teamRunId: "run-stopping", clientMessageId: "m-stopping", status: "stopping" });
    state = reduceExpertTeamRuns(state, runAction(active));
    state = reduceExpertTeamRuns(state, runAction(stopping));

    // 每父会话最多保留 20 条终态：第 21 条把 endedAt 最早的终态挤出
    for (let index = 0; index < 21; index += 1) {
      state = reduceExpertTeamRuns(
        state,
        runAction(
          run({
            teamRunId: `s1-${index}`,
            clientMessageId: `m-s1-${index}`,
            status: "completed",
            endedAt: timestamp(index),
          }),
        ),
      );
    }
    expect([...state.runs.values()].filter(isExpertTeamTerminal)).toHaveLength(20);
    expect(state.runs.has("s1-0")).toBe(false);
    expect(state.runs.has("s1-20")).toBe(true);
    expect(state.runs.has("run-active")).toBe(true);
    expect(state.runs.has("run-stopping")).toBe(true);

    // 全局最多保留 100 条终态：其余 5 个父会话各 20 条把本会话 20 条更早的终态挤出
    for (let parent = 0; parent < 5; parent += 1) {
      for (let index = 0; index < 20; index += 1) {
        state = reduceExpertTeamRuns(
          state,
          runAction(
            run({
              teamRunId: `p${parent}-${index}`,
              parentSessionId: `s-bulk-${parent}`,
              clientMessageId: `m-${parent}-${index}`,
              status: "completed",
              endedAt: timestamp(1_000 + parent * 20 + index),
            }),
          ),
        );
      }
    }
    expect([...state.runs.values()].filter(isExpertTeamTerminal)).toHaveLength(100);
    expect(state.runs.has("s1-20")).toBe(false);
    expect(state.runs.has("p4-19")).toBe(true);
    expect(state.runs.has("run-active")).toBe(true);
    expect(state.runs.has("run-stopping")).toBe(true);
  });

  it("removes only same-generation terminal runs at or below the removal revision for the same parent", () => {
    const state = stateWithActiveRun({ status: "completed", endedAt: timestamp(3), revision: 3 });
    const remove = (overrides: Partial<Extract<ExpertTeamRunAction, { type: "remove" }>> = {}): ExpertTeamRunAction => ({
      type: "remove",
      generation: "g1",
      revision: 3,
      teamRunId: "run-1",
      parentSessionId: "s1",
      ...overrides,
    });

    // 换代、父会话不符、运行比移除帧更新、活跃运行都不删除
    expect(reduceExpertTeamRuns(state, remove({ generation: "g2" }))).toBe(state);
    expect(reduceExpertTeamRuns(state, remove({ parentSessionId: "s2" }))).toBe(state);
    expect(reduceExpertTeamRuns(state, remove({ revision: 2 }))).toBe(state);
    const activeState = stateWithActiveRun({ revision: 3 });
    expect(reduceExpertTeamRuns(activeState, remove()).runs.has("run-1")).toBe(true);
    const stoppingState = stateWithActiveRun({ status: "stopping", revision: 3 });
    expect(reduceExpertTeamRuns(stoppingState, remove()).runs.has("run-1")).toBe(true);

    // 合法移除：同代、同父会话、终态且 revision 不高于移除帧
    const removed = reduceExpertTeamRuns(state, remove());
    expect(removed.runs.has("run-1")).toBe(false);
    expect(removed).not.toBe(state);
    expect(state.runs.has("run-1")).toBe(true);
  });

  it("run-remove drops only the team card entry and never deletes conversation Artifact items", () => {
    const summary = artifact({ artifactId: "artifact-1" });
    const items: ChatLikeItem[] = [
      userItem("m1"),
      { id: 900, kind: "expert-team-run", teamRunId: "run-1" },
      { id: 901, kind: "artifact", artifactId: summary.artifactId, artifact: summary },
    ];
    let state = reduceExpertTeamRuns(
      stateWithActiveRun(),
      runAction(run({ revision: 2, status: "completed", endedAt: timestamp(2) })),
    );
    state = reduceExpertTeamRuns(state, {
      type: "remove",
      generation: "g1",
      revision: 2,
      teamRunId: "run-1",
      parentSessionId: "s1",
    });
    expect(state.runs.size).toBe(0);

    // Task 16 的失效卡清理只按 teamRunId 移除团队卡条目；Artifact 卡与用户消息必须保留
    const remaining = items.filter(
      (item) => item.kind !== "expert-team-run" || state.runs.has(item.teamRunId),
    );
    expect(remaining.map((item) => item.kind)).toEqual(["user", "artifact"]);
    expect(items).toHaveLength(3);
  });

  it("anchors the aggregate card after the exact user clientMessageId", () => {
    const items = [userItem("m1"), assistantItem("a1"), userItem("m2")];
    let nextId = 100;
    const inserted = insertExpertTeamRunCard(items, {
      teamRunId: "run-1",
      clientMessageId: "m1",
      allocateId: () => ++nextId,
    });
    expect(inserted.map((item) => item.kind)).toEqual(["user", "expert-team-run", "assistant", "user"]);
    // 入参数组不被修改
    expect(items.map((item) => item.kind)).toEqual(["user", "assistant", "user"]);
  });

  it("dedupes by teamRunId, falls back only for snapshot reconciliation, and leaves unmatched lists unchanged", () => {
    const items = [userItem("m1"), assistantItem("a1"), userItem("m2")];
    let nextId = 100;
    const allocateId = (): number => ++nextId;

    // 精确锚点优先于快照回退：即使允许回退也插在 m1 之后
    const precise = insertExpertTeamRunCard(items, {
      teamRunId: "run-1",
      clientMessageId: "m1",
      allowSnapshotFallback: true,
      allocateId,
    });
    expect(precise.map((item) => item.kind)).toEqual(["user", "expert-team-run", "assistant", "user"]);

    // 已存在同 teamRunId 的卡：去重并返回入参数组
    const deduped = insertExpertTeamRunCard(precise, {
      teamRunId: "run-1",
      clientMessageId: "m2",
      allowSnapshotFallback: true,
      allocateId,
    });
    expect(deduped).toBe(precise);

    // 实时事件缺少锚点命中时不猜测归属
    const unmatched = insertExpertTeamRunCard(items, { teamRunId: "run-2", clientMessageId: "missing", allocateId });
    expect(unmatched).toBe(items);

    // 只有 snapshot 对账（allowSnapshotFallback === true）才回退到最后一条用户消息之后
    const fallback = insertExpertTeamRunCard(items, {
      teamRunId: "run-2",
      clientMessageId: "missing",
      allowSnapshotFallback: true,
      allocateId,
    });
    expect(fallback.map((item) => item.kind)).toEqual(["user", "assistant", "user", "expert-team-run"]);

    const noUserItems = [assistantItem("a1")];
    const noAnchor = insertExpertTeamRunCard(noUserItems, { teamRunId: "run-3", allowSnapshotFallback: true, allocateId });
    expect(noAnchor).toBe(noUserItems);
  });

  it("counts dispatch results and classifies the seven run statuses", () => {
    const running = run({
      results: [
        {
          resultId: "r1",
          dispatchId: "dispatch-r1",
          memberId: "m-exec-1",
          agentRef: { source: "local", slug: "writer" },
          packageVersion: "1.0.0",
          kind: "execute",
          inputResultIds: [],
          status: "completed",
          output: "结果",
          startedAt: timestamp(0),
          endedAt: timestamp(1),
        },
        {
          resultId: "r2",
          dispatchId: "dispatch-r2",
          memberId: "m-rev-1",
          agentRef: { source: "local", slug: "reviewer" },
          packageVersion: "1.0.0",
          kind: "review",
          inputResultIds: ["r1"],
          status: "running",
          startedAt: timestamp(1),
        },
        {
          resultId: "r3",
          dispatchId: "dispatch-r3",
          memberId: "m-exec-1",
          agentRef: { source: "local", slug: "writer" },
          packageVersion: "1.0.0",
          kind: "revision",
          inputResultIds: ["r1"],
          supersedesResultId: "r1",
          status: "failed",
          error: "失败",
          startedAt: timestamp(2),
          endedAt: timestamp(3),
        },
        {
          resultId: "r4",
          dispatchId: "dispatch-r4",
          memberId: "m-exec-1",
          agentRef: { source: "local", slug: "writer" },
          packageVersion: "1.0.0",
          kind: "execute",
          inputResultIds: [],
          status: "stopped",
          startedAt: timestamp(3),
          endedAt: timestamp(4),
        },
      ],
    });
    expect(expertTeamCounts(running)).toEqual({
      dispatched: 4,
      running: 1,
      completed: 1,
      failed: 1,
      stopped: 1,
      reviews: 1,
      revisions: 1,
    });
    expect(expertTeamCounts(run())).toEqual({
      dispatched: 0,
      running: 0,
      completed: 0,
      failed: 0,
      stopped: 0,
      reviews: 0,
      revisions: 0,
    });

    const statuses = [
      "running",
      "stopping",
      "completed",
      "completed_with_issues",
      "partial",
      "failed",
      "stopped",
    ] as const;
    expect(statuses.filter((status) => isExpertTeamTerminal(run({ status })))).toEqual([
      "completed",
      "completed_with_issues",
      "partial",
      "failed",
      "stopped",
    ]);
  });

  it("counts result attempts, so an execute superseded by its revision stays counted with that revision and review", () => {
    const attempts = run({
      results: [
        {
          resultId: "r-exec",
          dispatchId: "dispatch-exec",
          memberId: "m-writer",
          agentRef: { source: "local", slug: "writer" },
          packageVersion: "1.0.0",
          kind: "execute",
          inputResultIds: [],
          status: "completed",
          output: "初稿",
          startedAt: timestamp(0),
          endedAt: timestamp(1),
        },
        {
          resultId: "r-revision",
          dispatchId: "dispatch-revision",
          memberId: "m-writer",
          agentRef: { source: "local", slug: "writer" },
          packageVersion: "1.0.0",
          kind: "revision",
          inputResultIds: ["r-exec"],
          supersedesResultId: "r-exec",
          status: "completed",
          output: "修订稿",
          startedAt: timestamp(2),
          endedAt: timestamp(3),
        },
        {
          resultId: "r-review",
          dispatchId: "dispatch-review",
          memberId: "m-reviewer",
          agentRef: { source: "local", slug: "reviewer" },
          packageVersion: "1.0.0",
          kind: "review",
          inputResultIds: ["r-revision"],
          status: "completed",
          reviewVerdict: "pass",
          startedAt: timestamp(4),
          endedAt: timestamp(5),
        },
      ],
    });
    // 已被取代的 execute 仍按结果尝试计数：按成员去重会把 dispatched/completed 算成 2
    expect(expertTeamCounts(attempts)).toEqual({
      dispatched: 3,
      running: 0,
      completed: 3,
      failed: 0,
      stopped: 0,
      reviews: 1,
      revisions: 1,
    });
  });
});
