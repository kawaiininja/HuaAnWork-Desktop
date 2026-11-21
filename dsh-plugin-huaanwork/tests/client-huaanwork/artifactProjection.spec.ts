import { describe, expect, it, vi } from "vitest";

import type { ChatItem } from "../../src/client-huaanwork/App.tsx";
import {
  ARTIFACT_READ_FAILED,
  applyRunEndProjection,
  insertArtifactIntoHistory,
  insertBeforeArtifactGroup,
  openArtifactPreview,
  projectAutomationResult,
  settleArtifactLoading,
  shouldApplyArtifactResponse,
  sortArtifactsForBackfill,
} from "../../src/client-huaanwork/logic/artifactProjection.ts";
import { historyItemsFromRecords } from "../../src/client-huaanwork/logic/sessionChannel.ts";
import { runResultNoteText } from "../../src/client-huaanwork/logic/runTabsLogic.ts";
import type { ArtifactAnchor, TaskArtifactSummary } from "../../src/client-huaanwork/rpc-types.ts";

const resultPresentToolCall = {
  kind: "tool-call" as const,
  time: 1,
  name: "result_present",
  callId: "call-1",
  args: '{"title":"报告","format":"markdown","content":"完整结果正文"}',
};
const resultPresentToolResult = {
  kind: "tool-result" as const,
  time: 2,
  callId: "call-1",
  text: "已生成结果页",
  isError: false,
};
type ProjectionItem = { id: number; kind: string; text?: string; sourceText?: string };
const items: ProjectionItem[] = [{ id: 1, kind: "assistant", text: '{"title":"报告","content":"完整结果正文"}' }];
const legacyItems = items;
const createdRun = { artifactOutcome: "created" as const, artifactId: "artifact-1" };
const failedRun = { artifactOutcome: "failed" as const, artifactError: "artifact-write-failed" };
const legacyRun = {};
const isArtifactCard = (item: { kind: string }) => item.kind === "artifact";
const isArtifactErrorCard = (item: { kind: string }) => item.kind === "artifact-error";
const isLegacyAttachment = (item: { kind: string }) => item.kind === "attachment";
const createAttachment = (sourceText: string): ProjectionItem => ({ id: 99, kind: "attachment", sourceText });

function artifactFixture(anchor: ArtifactAnchor): TaskArtifactSummary {
  return {
    artifactId: "artifact-1",
    sessionId: "session-1",
    title: "报告",
    format: "markdown",
    downloadName: "报告.md",
    sizeBytes: 4,
    sha256: "sha256:test",
    createdAt: "2026-11-15T10:00:00.000Z",
    anchor,
  };
}
const artifact = artifactFixture({ kind: "turn", clientMessageId: "message-1" });
const unanchoredArtifact = artifactFixture({ kind: "turn" });

describe("artifact projection", () => {
  it("never shows result_present arguments as a tool card", () => {
    const projected = historyItemsFromRecords([resultPresentToolCall, resultPresentToolResult]);
    expect(projected.some((item) => item.kind === "tool")).toBe(false);
    expect(JSON.stringify(projected)).not.toContain("完整结果正文");
  });

  it("uses exactly one automation result presentation", () => {
    expect(projectAutomationResult(items, createdRun, artifact).filter(isArtifactCard)).toHaveLength(1);
    expect(projectAutomationResult(items, failedRun).filter(isArtifactErrorCard)).toHaveLength(1);
    expect(projectAutomationResult(legacyItems, legacyRun, undefined, createAttachment).filter(isLegacyAttachment)).toHaveLength(1);
  });

  it("removes the original envelope and never duplicates created cards", () => {
    const projected = projectAutomationResult(items, createdRun, artifact);
    expect(JSON.stringify(projected)).not.toContain("完整结果正文");
    expect(projected.filter((item) => item.kind === "assistant")).toHaveLength(0);
    expect(projected.filter(isArtifactCard)).toHaveLength(1);
    // 同一 artifactId 的 created 事件 + artifact.list 快照去重后仍只有一张卡
    const withListReplay = projectAutomationResult(projected, createdRun, artifact);
    expect(withListReplay.filter(isArtifactCard)).toHaveLength(1);
  });

  it("shows a failed run as a single error card with title, format and error code", () => {
    const failedWithMeta = {
      artifactOutcome: "failed" as const,
      artifactError: "artifact-write-failed",
      artifactTitle: "季度报告",
      artifactFormat: "html" as const,
    };
    const projected = projectAutomationResult(items, failedWithMeta);
    expect(projected.filter(isArtifactErrorCard)).toHaveLength(1);
    expect(projected.filter((item) => item.kind === "assistant")).toHaveLength(0);
    expect(projected.filter(isArtifactCard)).toHaveLength(0);
    expect(projected.filter(isLegacyAttachment)).toHaveLength(0);
    expect(JSON.stringify(projected)).toContain("季度报告");
    expect(JSON.stringify(projected)).toContain("artifact-write-failed");
    expect(JSON.stringify(projected)).not.toContain("完整结果正文");
    // 校验失败的封套无 title/format：回退“任务结果/未知格式”
    const projectedUnknown = projectAutomationResult(items, failedRun);
    expect(JSON.stringify(projectedUnknown)).toContain("任务结果");
    expect(JSON.stringify(projectedUnknown)).toContain("未知格式");
  });

  it("keeps a temporarily unreadable artifact as a retryable placeholder, then a terminal error card", () => {
    const loading = projectAutomationResult(items, createdRun, undefined /* 摘要暂存、内容未读 */);
    expect(loading.filter((item) => item.kind === "artifact-loading")).toHaveLength(1);
    expect(loading.filter(isLegacyAttachment)).toHaveLength(0); // 不回退旧附件
    expect(JSON.stringify(loading)).not.toContain("完整结果正文");
    const permanent = projectAutomationResult(items, { ...createdRun, artifactReadError: "artifact-content-missing" });
    expect(permanent.filter((item) => item.kind === "artifact-loading")).toHaveLength(0); // 不无限停留
    expect(permanent.filter(isArtifactErrorCard)).toHaveLength(1);
  });

  it("backfills a lost created event from RunSummary without double-emitting", () => {
    const loading = projectAutomationResult(items, createdRun, undefined);
    expect(loading.filter((item) => item.kind === "artifact-loading")).toHaveLength(1);
    const repaired = projectAutomationResult(loading, createdRun, artifact);
    expect(repaired.filter(isArtifactCard)).toHaveLength(1);
    expect(repaired.filter((item) => item.kind === "artifact-loading")).toHaveLength(0);
    expect(repaired.filter(isLegacyAttachment)).toHaveLength(0);
    expect(JSON.stringify(repaired)).not.toContain("完整结果正文");
    // Host 侧“只 emit 一次”由 Task 3 的适配重放测试覆盖，投影不再触发任何 emit。
  });

  it("requires the legacy attachment factory only for runs without an outcome", () => {
    expect(() => projectAutomationResult(legacyItems, legacyRun)).toThrow("legacy-attachment-factory-required");
    // 新协议分支不需要附件构造器。
    expect(projectAutomationResult(items, createdRun, artifact).filter(isArtifactCard)).toHaveLength(1);
    expect(projectAutomationResult(items, failedRun).filter(isArtifactErrorCard)).toHaveLength(1);
  });

  it("settles a loading placeholder into the card or the terminal read error in place", () => {
    const loading = projectAutomationResult(items, createdRun, undefined);
    const resolved = settleArtifactLoading(loading, "artifact-1", artifact);
    expect(resolved.filter(isArtifactCard)).toHaveLength(1);
    expect(resolved.filter((item) => item.kind === "artifact-loading")).toHaveLength(0);
    const failed = settleArtifactLoading(loading, "artifact-1", undefined);
    expect(failed.filter(isArtifactErrorCard)).toHaveLength(1);
    expect(failed.filter((item) => item.kind === "artifact-loading")).toHaveLength(0);
    expect(JSON.stringify(failed)).toContain(ARTIFACT_READ_FAILED);
    // 不是本次 artifact 的占位保持原样。
    expect(settleArtifactLoading(loading, "other-artifact", artifact)).toEqual(loading);
  });
});

describe("artifact history anchoring", () => {
  it("places an unanchored historical artifact in the explicit group", () => {
    const result = insertArtifactIntoHistory([], unanchoredArtifact, () => 9);
    expect(result[0]).toMatchObject({ kind: "artifact-group", text: "未定位的历史结果" });
    expect(result[1]?.kind).toBe("artifact");
  });

  it("places an automation artifact immediately before its exact run footer", () => {
    const automationArtifact = artifactFixture({
      kind: "automation-run",
      automationId: "automation-1",
      runId: "run-1",
    });
    const run = { automationId: "automation-1", summary: { runId: "run-1", status: "ok" as const } };
    const history = [
      { id: 1, kind: "assistant" as const, text: "运行中" },
      { id: 2, kind: "note" as const, text: runResultNoteText(run.summary.status) },
    ];
    const result = insertArtifactIntoHistory(history, automationArtifact, () => 3, run);
    expect(result.map((item) => item.kind)).toEqual(["assistant", "artifact", "note"]);
  });

  it("never anchors an automation artifact across a different run", () => {
    const automationArtifact = artifactFixture({
      kind: "automation-run",
      automationId: "automation-1",
      runId: "run-1",
    });
    const otherRun = { automationId: "automation-1", summary: { runId: "run-2", status: "ok" as const } };
    const history = [
      { id: 1, kind: "note" as const, text: runResultNoteText("ok") },
    ];
    const result = insertArtifactIntoHistory(history, automationArtifact, () => 3, otherRun);
    expect(result.map((item) => item.kind)).toEqual(["note", "artifact-group", "artifact"]);
  });

  it("keeps duplicate artifact ids out of history", () => {
    const once = insertArtifactIntoHistory([], unanchoredArtifact, () => 9);
    const twice = insertArtifactIntoHistory(once, unanchoredArtifact, () => 10);
    expect(twice.map((item) => item.kind)).toEqual(["artifact-group", "artifact"]);
  });

  it.each([false, true])("keeps exact artifacts outside the trailing unlocated group, reverse=%s", (reverse) => {
    let id = 2;
    const exact = { ...artifactFixture({ kind: "turn", clientMessageId: "user-1" }), artifactId: "exact" };
    const loose = { ...artifactFixture({ kind: "turn" }), artifactId: "loose" };
    let result: ChatItem[] = [{ id: 1, kind: "user", text: "生成报告", clientMessageId: "user-1" }];
    for (const item of reverse ? [exact, loose] : [loose, exact]) {
      result = insertArtifactIntoHistory(result, item, () => id++);
    }
    result = insertArtifactIntoHistory(result, exact, () => id++);
    expect(result.map((item) => item.kind)).toEqual(["user", "artifact", "artifact-group", "artifact"]);
    expect(result[1]).toMatchObject({ artifactId: "exact" });
    expect(result[3]).toMatchObject({ artifactId: "loose" });
  });

  it("places new ordinary items before the trailing group", () => {
    let result: ChatItem[] = insertArtifactIntoHistory([], unanchoredArtifact, () => 1);
    result = insertBeforeArtifactGroup(result, { id: 2, kind: "note", text: "新提示" });
    expect(result.map((item) => item.kind)).toEqual(["note", "artifact-group", "artifact"]);
  });

  it("orders list backfill by createdAt then artifactId", () => {
    const sorted = sortArtifactsForBackfill([
      { artifactId: "b", createdAt: "2026-11-15T10:00:00.000Z" },
      { artifactId: "a", createdAt: "2026-11-15T10:00:00.000Z" },
      { artifactId: "c", createdAt: "2026-11-14T10:00:00.000Z" },
    ]);
    expect(sorted.map((entry) => entry.artifactId)).toEqual(["c", "a", "b"]);
  });
});

describe("artifact preview selection", () => {
  it("clicking the card opens the preview rail and selects the artifact", async () => {
    const fetchArtifact = vi.fn().mockResolvedValue({ summary: artifact, content: "# 正文" });
    const next = await openArtifactPreview(
      { rightOpen: false, rightTab: "chat", previewArtifactId: undefined },
      "artifact-1",
      fetchArtifact,
    );
    expect(next).toMatchObject({ rightOpen: true, rightTab: "preview", previewArtifactId: "artifact-1" });
    expect(fetchArtifact).toHaveBeenCalledWith("artifact-1"); // 触发 artifact.get + artifact.content
  });

  it("keeps the open rail and reports a failed read instead of throwing", async () => {
    const next = await openArtifactPreview(
      { rightOpen: false, rightTab: "chat", previewArtifactId: undefined },
      "artifact-1",
      () => Promise.reject(new Error("artifact-not-found")),
    );
    expect(next).toMatchObject({ rightOpen: true, rightTab: "preview", previewArtifactId: "artifact-1" });
    expect(next.previewError).toBe("artifact-not-found");
  });

  it("drops a late response from the previously selected session", () => {
    expect(shouldApplyArtifactResponse(
      { sessionId: "new-session", epoch: 4 },
      { sessionId: "old-session", epoch: 3 },
    )).toBe(false);
    expect(shouldApplyArtifactResponse(
      { sessionId: "session-1", epoch: 4 },
      { sessionId: "session-1", epoch: 3 },
    )).toBe(false);
    expect(shouldApplyArtifactResponse(
      { sessionId: "session-1", epoch: 4 },
      { sessionId: "session-1", epoch: 4 },
    )).toBe(true);
  });

  it("projects only the run-end boundary and keeps later items before a trailing group", () => {
    const tabItems: ProjectionItem[] = [
      { id: 1, kind: "assistant", text: '{"title":"报告","content":"完整结果正文"}' },
      { id: 2, kind: "artifact-group", text: "未定位的历史结果" },
      { id: 4, kind: "user", text: "再补一版" }, // 读取摘要期间到达的续聊
    ];
    const boundaryIds = new Set([1, 2]);
    const projected = applyRunEndProjection(
      tabItems,
      boundaryIds,
      (prefix) => projectAutomationResult(prefix, createdRun, artifact),
      { id: 5, kind: "note", text: "运行已结束" },
    );
    expect(projected.map((item) => item.kind)).toEqual(["artifact", "note", "user", "artifact-group"]);
    expect(JSON.stringify(projected)).not.toContain("完整结果正文");
    expect(JSON.stringify(projected)).toContain("再补一版");
  });
});
