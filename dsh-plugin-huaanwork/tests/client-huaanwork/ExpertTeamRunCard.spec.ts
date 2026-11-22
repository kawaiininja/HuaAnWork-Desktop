// @vitest-environment jsdom
/**
 * 专家团聚合运行卡（Task 16）：混合活动、7 种可区分状态、主报告入口/关联异常、
 * 两级取消、成员结果链展开，以及断连冻结、同代重连解冻与换代移除旧卡。
 *
 * Harness 用真实 `ExpertTeamRunCard` 组件、Task 13 的 `reduceExpertTeamRuns` 与既有
 * Artifact 卡条目拼成最小聊天流；只通过 DOM 与公开的 reconcile/点击操作断言，
 * 不读取组件私有字段。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, createElement } from "react";
import type { ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";

import ExpertTeamRunCard from "../../src/client-huaanwork/ExpertTeamRunCard.tsx";
import ResultArtifactCard from "../../src/client-huaanwork/ResultArtifactCard.tsx";
import {
  reduceExpertTeamRuns,
  type ExpertTeamRunsState,
} from "../../src/client-huaanwork/logic/expertTeamRuns.ts";
import type { ArtifactResultCardItem } from "../../src/client-huaanwork/logic/artifactProjection.ts";
import type { ExpertTeamRun } from "../../src/client-huaanwork/rpc-types.ts";
import { artifact, executeResult, validTeam } from "../fixtures/expert-team/team.ts";

declare module "vitest" {
  // 与 Vitest 自带 Assertion 的泛型默认值保持一致；仅补齐本 spec 用到的 DOM 断言。
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  interface Assertion<T = any> {
    toBeDisabled(): T;
  }
}

expect.extend({
  toBeDisabled(received) {
    const element = received as { disabled?: boolean };
    const pass = element.disabled === true;
    return {
      pass,
      message: () => `expected element ${pass ? "not " : ""}to be disabled`,
    };
  },
});

const TEAM = validTeam();
const STARTED_AT = "2026-11-22T00:00:00.000Z";
const NOW = Date.parse(STARTED_AT) + 12_000;

function teamRun(overrides: Partial<ExpertTeamRun> = {}): ExpertTeamRun {
  return {
    teamRunId: "run-1",
    parentSessionId: "s1",
    clientMessageId: "m1",
    teamId: TEAM.id,
    teamSnapshot: TEAM,
    status: "running",
    results: [],
    artifactStatus: "not-required",
    deliverySealed: false,
    unifiedRevisionRounds: 0,
    dispatchAttempts: 0,
    startedAt: STARTED_AT,
    revision: 1,
    ...overrides,
  };
}

/** 无成员结果的 running 运行；默认属于 Host generation `g1`。 */
function runningTeam(overrides: Partial<ExpertTeamRun> = {}): ExpertTeamRun {
  return teamRun(overrides);
}

/** 一名进行中的执行成员与一名进行中的审查成员，用于混合活动与成员取消。 */
function runWithExecutingAndReviewingMembers(overrides: Partial<ExpertTeamRun> = {}): ExpertTeamRun {
  return teamRun({
    dispatchAttempts: 2,
    results: [
      executeResult("r1", {
        memberId: "m-exec-1",
        agentRef: { source: "local", slug: "writer" },
        status: "running",
        memberRunId: "member-run-1",
      }),
      executeResult("rev-1", {
        kind: "review",
        memberId: "m-rev-1",
        agentRef: { source: "local", slug: "reviewer" },
        status: "running",
        memberRunId: "member-run-2",
      }),
    ],
    ...overrides,
  });
}

function runWithStatus(
  status: ExpertTeamRun["status"],
  overrides: Partial<ExpertTeamRun> = {},
): ExpertTeamRun {
  return teamRun({ status, ...overrides });
}

const ARTIFACT_ITEM: ArtifactResultCardItem = {
  id: 900,
  kind: "artifact",
  artifactId: "art-1",
  artifact: artifact({ artifactId: "art-1" }),
};

type HarnessItem =
  | { kind: "expert-team-run"; teamRunId: string }
  | { kind: "artifact"; item: ArtifactResultCardItem };

type ReconcileSnapshot = {
  sessionId?: string;
  generation: string;
  revision: number;
  runs: ExpertTeamRun[];
};

type HarnessProps = {
  run: ExpertTeamRun;
  generation?: string;
  connection?: "open" | "closed";
  onCancelTeam?: Mock<(input: { parentSessionId: string; teamRunId: string }) => unknown>;
  onCancelMember?: Mock<(input: { parentSessionId: string; runId: string }) => unknown>;
  onPreviewArtifact?: Mock<(artifactId: string) => unknown>;
};

type Harness = {
  text(): string;
  click(label: string): Promise<void>;
  button(label: string): HTMLButtonElement;
  statusLabel(): string;
  reconcile(snapshot: ReconcileSnapshot): void;
  queryTeamRun(): Element | null;
  queryArtifact(): Element | null;
};

let root: Root | undefined;
let container: HTMLDivElement | undefined;

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  root = undefined;
  container?.remove();
  container = undefined;
  vi.unstubAllGlobals();
});

function renderExpertTeamRunCard(props: HarnessProps): Harness {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const generation = props.generation ?? "g1";
  let state: ExpertTeamRunsState = {
    generation,
    revision: props.run.revision,
    runs: new Map([[props.run.teamRunId, props.run]]),
    connection: props.connection ?? "open",
  };
  let items: HarnessItem[] = [
    { kind: "expert-team-run", teamRunId: props.run.teamRunId },
    { kind: "artifact", item: ARTIFACT_ITEM },
  ];
  const expanded: Record<string, boolean> = {};

  const element = (): ReactElement => {
    const teams = items.filter(
      (item): item is Extract<HarnessItem, { kind: "expert-team-run" }> => item.kind === "expert-team-run",
    );
    return createElement(
      "div",
      null,
      teams.map((item) => {
        // 运行已不在投影里时容忍空卡：不伪造内容，也不隐藏同条聊天流里的 Artifact。
        const run = state.runs.get(item.teamRunId);
        return run === undefined
          ? null
          : createElement(ExpertTeamRunCard, {
              key: run.teamRunId,
              run,
              now: NOW,
              connection: state.connection,
              expandedResultIds: expanded,
              onToggleResult: (resultId: string) => {
                expanded[resultId] = expanded[resultId] !== true;
                render();
              },
              onRequestCancelTeam: props.onCancelTeam,
              onRequestCancelMember: props.onCancelMember,
              onPreviewArtifact: props.onPreviewArtifact,
            });
      }),
      items.flatMap((item) =>
        item.kind === "artifact" ? [createElement(ResultArtifactCard, { key: item.item.id, item: item.item })] : [],
      ),
    );
  };

  const render = (): void => {
    act(() => {
      root!.render(element());
    });
  };

  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  render();

  const click = async (label: string): Promise<void> => {
    const target = [...container!.querySelectorAll("button")].find(
      (item) => item.textContent?.trim() === label,
    );
    if (target === undefined) throw new Error(`button not found by text: ${label}`);
    await act(async () => {
      target.click();
    });
  };

  return {
    text: () => container!.textContent ?? "",
    click,
    button(label: string): HTMLButtonElement {
      const target = [...container!.querySelectorAll("button")].find(
        (item) => item.textContent?.trim() === label,
      );
      if (target === undefined) throw new Error(`button not found by text: ${label}`);
      return target;
    },
    statusLabel(): string {
      const status = container!.querySelector('[data-role="expert-team-status"]');
      if (status === null) throw new Error("expert team status not found");
      return status.textContent?.trim() ?? "";
    },
    reconcile(snapshot: ReconcileSnapshot): void {
      const previous = state;
      state = reduceExpertTeamRuns(state, {
        type: "snapshot",
        ...(snapshot.sessionId === undefined ? {} : { sessionId: snapshot.sessionId }),
        generation: snapshot.generation,
        revision: snapshot.revision,
        runs: snapshot.runs,
      });
      // Host 换代：旧聚合卡整体失效，但用户/助手消息与 Artifact 卡必须保留。
      if (previous.generation !== undefined && previous.generation !== snapshot.generation) {
        items = items.filter((item) => item.kind !== "expert-team-run");
      }
      render();
      // 同代快照里新出现的运行按快照对账补卡；同 teamRunId 不重复插入。
      for (const run of snapshot.runs) {
        if (!items.some((item) => item.kind === "expert-team-run" && item.teamRunId === run.teamRunId)) {
          items = [{ kind: "expert-team-run", teamRunId: run.teamRunId }, ...items];
        }
      }
      render();
    },
    queryTeamRun: () => container!.querySelector(".expert-team-run-card"),
    queryArtifact: () => container!.querySelector(".artifact-card"),
  };
}

describe("ExpertTeamRunCard", () => {
  it("shows mixed activities, distinct 7-state labels, primary artifact entry, and two-level cancel", async () => {
    const cancelTeam = vi.fn<(input: { parentSessionId: string; teamRunId: string }) => Promise<{ status: string; teamRunId: string }>>()
      .mockResolvedValue({ status: "accepted", teamRunId: "run-1" });
    const cancelMember = vi.fn<(input: { parentSessionId: string; runId: string }) => Promise<{ ok: boolean }>>()
      .mockResolvedValue({ ok: true });
    const previewArtifact = vi.fn();
    const card = renderExpertTeamRunCard({
      run: runWithExecutingAndReviewingMembers({ primaryArtifactId: "art-1", artifactStatus: "created" }),
      onCancelTeam: cancelTeam,
      onCancelMember: cancelMember,
      onPreviewArtifact: previewArtifact,
    });
    expect(card.text()).toContain("执行与审查");
    expect(card.text()).not.toContain("2/5");
    await card.click("查看主报告");
    expect(previewArtifact).toHaveBeenCalledWith("art-1");
    await card.click("终止成员");
    expect(cancelMember).toHaveBeenCalledWith({ parentSessionId: "s1", runId: "member-run-1" });
    await card.click("终止专家团");
    expect(cancelTeam).toHaveBeenCalledWith({ parentSessionId: "s1", teamRunId: "run-1" });
  });

  it("renders pairwise distinct copy for all 7 states, expands member versions/supersedes/invalid-verdict, and keeps the Artifact card visible on artifactLinkError", async () => {
    const allStatuses = ["running", "stopping", "completed", "completed_with_issues", "partial", "stopped", "failed"] as const;
    const labels = allStatuses.map((status) => renderExpertTeamRunCard({ run: runWithStatus(status) }).statusLabel());
    expect(new Set(labels).size).toBe(7);

    const partialLinkErr = renderExpertTeamRunCard({
      run: runWithStatus("partial", {
        deliverySealed: true,
        artifactStatus: "pending",
        artifactLinkError: "expert-team-artifact-link-failed",
        results: [
          executeResult("r1", { output: "初版结果" }),
          executeResult("r2", { kind: "revision", supersedesResultId: "r1", output: "返修结果" }),
          executeResult("rev-1", { kind: "review", memberId: "m-rev-1", reviewError: "invalid-verdict", output: "缺少末行标记" }),
        ],
      }),
    });
    expect(partialLinkErr.text()).toContain("主报告关联异常");
    // 关联异常时聊天流中的已有 Artifact 卡片仍保持可见，不得被隐藏
    expect(partialLinkErr.queryArtifact()).not.toBeNull();
    await partialLinkErr.click("展开成员结果 r2");
    expect(partialLinkErr.text()).toContain("返修结果");
    expect(partialLinkErr.text()).toContain("替代");
    await partialLinkErr.click("展开成员结果 rev-1");
    expect(partialLinkErr.text()).toContain("invalid-verdict");
  });

  it("freezes operations on disconnect, unfreezes on same-generation reconnect, and drops old-generation cards while keeping artifacts", () => {
    const card = renderExpertTeamRunCard({ run: runningTeam(), connection: "closed" });
    expect(card.button("终止专家团")).toBeDisabled();
    expect(card.text()).toContain("连接已断开");
    // 同代重连快照解冻：操作重新可用且清除断连提示
    card.reconcile({ sessionId: "s1", generation: "g1", revision: 2, runs: [runningTeam({ revision: 2 })] });
    expect(card.button("终止专家团")).not.toBeDisabled();
    expect(card.text()).not.toContain("连接已断开");
    // 换代快照：移除旧聚合卡并保留已提交 Artifact 卡片
    card.reconcile({ sessionId: "s1", generation: "new-generation", revision: 0, runs: [] });
    expect(card.queryTeamRun()).toBeNull();
    expect(card.queryArtifact()).not.toBeNull();
  });
});

describe("App expert team wiring", () => {
  const APP_SOURCE = readFileSync(
    resolve(import.meta.dirname, "../../src/client-huaanwork/App.tsx"),
    "utf8",
  );

  it("intercepts team run frames before session handling and reconciles with runList", () => {
    const applyEventAt = APP_SOURCE.indexOf("const applyEvent = (event: RpcEvent) => {");
    expect(applyEventAt).toBeGreaterThan(-1);
    const body = APP_SOURCE.slice(applyEventAt);
    const runAt = body.indexOf('event.event === "expertTeam/run"');
    const removeAt = body.indexOf('event.event === "expertTeam/run-remove"');
    const holdAt = body.indexOf("const holdEarlyEvent");
    expect(runAt).toBeGreaterThan(-1);
    expect(removeAt).toBeGreaterThan(-1);
    expect(holdAt).toBeGreaterThan(-1);
    expect(runAt).toBeLessThan(holdAt);
    expect(removeAt).toBeLessThan(holdAt);
    expect(APP_SOURCE).toMatch(/rpcCall<ExpertTeamRunSnapshot>\("expertTeam\.runList", \{ sessionId \}\)/);
    expect(APP_SOURCE).toMatch(/expertTeam\.cancel/);
    expect(APP_SOURCE).toContain("insertExpertTeamRunCard");
  });

  it("keeps team member subagents out of the main stream but still reconciles their state", () => {
    expect(APP_SOURCE).toMatch(/run\.teamRunId !== undefined/);
    expect(APP_SOURCE).toMatch(
      /if \(run\.teamRunId !== undefined\) return;[\s\S]{0,600}insertSubagentRunCard/,
    );
    // 换代只清理聚合卡条目，绝不删除用户/助手消息或 Artifact 卡。
    expect(APP_SOURCE).toMatch(/item\.kind !== "expert-team-run"/);
    expect(APP_SOURCE).toContain('kind === "subagent-run" || item.kind === "expert-team-run"');
  });
});
