// @vitest-environment jsdom
/**
 * 右栏进度面板：三区展示、当前回合活动复用 ToolPanel、子代理摘要复用运行卡二次确认。
 *
 * `confirmingRunId`、忙态与错误都由调用方（App）持有；本组测试用受控 props 钉住
 * 「点终止只请求确认、绝不直接发取消」与「确认区只属于被确认的 run」。
 */
import { act, createElement } from "react";
import type { ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";

import ProgressPanel from "../../src/client-huaanwork/ProgressPanel.tsx";
import type { ProgressPanelModel } from "../../src/client-huaanwork/logic/progressPanel.ts";
import type { SubagentRunView } from "../../src/client-huaanwork/logic/subagentRuns.ts";
import type { PanelToggle, ToolPanelView } from "../../src/client-huaanwork/logic/toolPanel.ts";

function run(overrides: Partial<SubagentRunView> & { runId: string }): SubagentRunView {
  return {
    parentSessionId: "session-1",
    clientMessageId: "message-1",
    kind: "legacy",
    label: "@审阅",
    phase: "tool",
    activeTools: [{ id: "tool-1", name: "read_file", startedAt: 1_000 }],
    startedAt: 1_000,
    lastActivity: 1_000,
    cleanupWarnings: [],
    generation: "gen-1",
    revision: 1,
    ...overrides,
  };
}

const ACTIVITY: ToolPanelView = {
  anchorId: 7,
  count: 1,
  status: "running",
  title: "工具 · 正在执行 · 1 项调用",
  expanded: false,
  panelToggled: null,
  tools: [
    {
      id: 8,
      key: "call-1",
      name: "read_file",
      description: "正在读取文件",
      status: "running",
      statusText: "进行中",
      result: "",
      truncated: false,
    },
  ],
};

function model(overrides: Partial<ProgressPanelModel> = {}): ProgressPanelModel {
  return {
    sessionId: "session-1",
    connection: "live",
    taskPhase: "ready",
    tasks: [
      { content: "分析需求", sourceStatus: "completed", displayStatus: "completed" },
      { content: "实现面板", sourceStatus: "in_progress", displayStatus: "in_progress" },
      { content: "运行验证", sourceStatus: "pending", displayStatus: "pending" },
    ],
    completedCount: 1,
    totalCount: 3,
    activity: [],
    subagents: [],
    ...overrides,
  };
}

type Spies = {
  onToggleActivity: Mock<(anchorId: number, next: PanelToggle) => void>;
  onRequestCancel: Mock<(runId: string) => void>;
  onConfirmCancel: Mock<(runId: string) => void>;
  onDismissCancel: Mock<(runId: string) => void>;
};

function createSpies(): Spies {
  return {
    onToggleActivity: vi.fn<(anchorId: number, next: PanelToggle) => void>(),
    onRequestCancel: vi.fn<(runId: string) => void>(),
    onConfirmCancel: vi.fn<(runId: string) => void>(),
    onDismissCancel: vi.fn<(runId: string) => void>(),
  };
}

function panelElement(
  progress: ProgressPanelModel,
  spies: Spies,
  overrides: {
    now?: number;
    frozenAt?: number;
    confirmingRunId?: string | null;
    cancelBusyByRunId?: Readonly<Record<string, boolean>>;
    cancelErrorByRunId?: Readonly<Record<string, string>>;
  } = {},
): ReactElement {
  return createElement(ProgressPanel, {
    model: progress,
    now: overrides.now ?? 13_000,
    frozenAt: overrides.frozenAt,
    confirmingRunId: overrides.confirmingRunId ?? null,
    cancelBusyByRunId: overrides.cancelBusyByRunId ?? {},
    cancelErrorByRunId: overrides.cancelErrorByRunId ?? {},
    onToggleActivity: spies.onToggleActivity,
    onRequestCancel: spies.onRequestCancel,
    onConfirmCancel: spies.onConfirmCancel,
    onDismissCancel: spies.onDismissCancel,
  });
}

let root: Root | undefined;
let container: HTMLDivElement | undefined;

async function mount(element: ReactElement): Promise<HTMLDivElement> {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(element);
  });
  return container;
}

async function rerender(element: ReactElement): Promise<void> {
  await act(async () => {
    root!.render(element);
  });
}

async function click(button: HTMLButtonElement): Promise<void> {
  await act(async () => {
    button.click();
  });
}

function buttonByText(view: ParentNode, text: string): HTMLButtonElement {
  const button = [...view.querySelectorAll("button")].find(
    (item) => item.textContent?.trim() === text,
  );
  if (button === undefined) throw new Error(`button not found by text: ${text}`);
  return button;
}

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  root = undefined;
  container?.remove();
  container = undefined;
  vi.unstubAllGlobals();
});

describe("ProgressPanel tasks", () => {
  it("renders the task list with a completed/total count and no percentages", async () => {
    const view = await mount(panelElement(model(), createSpies()));

    expect(view.textContent).toContain("已完成 1/3");
    expect(view.textContent).toContain("分析需求");
    expect(view.textContent).toContain("实现面板");
    expect(view.textContent).toContain("运行验证");
    expect(view.textContent).not.toMatch(/\d+%/);
    expect(view.querySelectorAll(".progress-task")).toHaveLength(3);
    expect(view.querySelector('.progress-task[data-status="in_progress"]')?.textContent).toContain(
      "实现面板",
    );
  });

  it("shows an interrupted overlay label without touching the count", async () => {
    const view = await mount(
      panelElement(
        model({
          tasks: [
            { content: "分析需求", sourceStatus: "completed", displayStatus: "completed" },
            { content: "实现面板", sourceStatus: "in_progress", displayStatus: "interrupted" },
            { content: "运行验证", sourceStatus: "pending", displayStatus: "pending" },
          ],
        }),
        createSpies(),
      ),
    );

    expect(view.textContent).toContain("已完成 1/3");
    expect(view.textContent).toContain("已中断");
    expect(view.textContent).not.toMatch(/\d+%/);
  });

  it("renders waiting and empty phases without a fabricated count", async () => {
    const waiting = await mount(
      panelElement(model({ taskPhase: "waiting", tasks: [], completedCount: 0, totalCount: 0 }), createSpies()),
    );
    expect(waiting.textContent).toContain("等待任务步骤");
    expect(waiting.textContent).not.toContain("已完成 0/0");

    await rerender(
      panelElement(model({ taskPhase: "empty", tasks: [], completedCount: 0, totalCount: 0 }), createSpies()),
    );
    expect(waiting.textContent).toContain("当前回合还没有任务步骤");
    expect(waiting.textContent).not.toContain("等待任务步骤");
  });
});

describe("ProgressPanel connection", () => {
  it("shows the disconnected banner only for the disconnected state", async () => {
    const view = await mount(
      panelElement(model({ connection: "disconnected" }), createSpies()),
    );
    expect(view.querySelector(".progress-connection")?.textContent).toContain(
      "连接中断，状态可能不是最新",
    );
  });

  it("shows the reconnecting banner and stays silent when live", async () => {
    const view = await mount(panelElement(model({ connection: "reconnecting" }), createSpies()));
    expect(view.querySelector(".progress-connection")?.textContent).toContain("正在重新连接");

    await rerender(panelElement(model({ connection: "live" }), createSpies()));
    expect(view.querySelector(".progress-connection")).toBeNull();
  });
});

describe("ProgressPanel activity", () => {
  it("reuses ToolPanel and forwards the panel toggle", async () => {
    const spies = createSpies();
    const view = await mount(panelElement(model({ activity: [ACTIVITY] }), spies));

    const title = buttonByText(view, ACTIVITY.title);
    expect(title.getAttribute("aria-expanded")).toBe("false");
    await click(title);
    expect(spies.onToggleActivity).toHaveBeenCalledWith(7, "expand");

    await rerender(
      panelElement(model({ activity: [{ ...ACTIVITY, expanded: true }] }), spies),
    );
    await click(buttonByText(view, ACTIVITY.title));
    expect(spies.onToggleActivity).toHaveBeenLastCalledWith(7, "collapse");
  });

  it("renders an empty activity state for the current turn", async () => {
    const view = await mount(panelElement(model(), createSpies()));
    expect(view.textContent).toContain("当前回合还没有工具活动");
  });
});

describe("ProgressPanel subagents", () => {
  it("requests confirmation first and never confirms from the summary click", async () => {
    const spies = createSpies();
    const view = await mount(panelElement(model({ subagents: [run({ runId: "run-1" })] }), spies));

    expect(view.textContent).toContain("@审阅");
    await click(buttonByText(view, "终止"));

    expect(spies.onRequestCancel).toHaveBeenCalledWith("run-1");
    expect(spies.onConfirmCancel).not.toHaveBeenCalled();
    expect(view.textContent).not.toContain("确认终止 @审阅");
  });

  it("renders the confirmation only for the matching run and routes confirm/dismiss", async () => {
    const spies = createSpies();
    const runs = [run({ runId: "run-1" }), run({ runId: "run-2", label: "@测试" })];
    const view = await mount(
      panelElement(model({ subagents: runs }), spies, { confirmingRunId: "run-1" }),
    );

    expect(view.textContent).toContain("确认终止 @审阅");
    await click(buttonByText(view, "确认终止 @审阅"));
    expect(spies.onConfirmCancel).toHaveBeenCalledWith("run-1");
    expect(spies.onConfirmCancel).toHaveBeenCalledTimes(1);
    expect(spies.onRequestCancel).not.toHaveBeenCalled();

    await click(buttonByText(view, "取消"));
    expect(spies.onDismissCancel).toHaveBeenCalledWith("run-1");
    expect(spies.onConfirmCancel).toHaveBeenCalledTimes(1);
  });

  it("shows stale runs with the fixed unrecoverable text and disables termination", async () => {
    const spies = createSpies();
    const view = await mount(
      panelElement(
        model({ subagents: [run({ runId: "run-1", stale: true, staleAt: 5_000 })] }),
        spies,
        { now: 600_000 },
      ),
    );

    expect(view.textContent).toContain("状态不可恢复 · Host 已重启，结果未确认");
    const terminate = buttonByText(view, "终止");
    expect(terminate.disabled).toBe(true);
    await click(terminate);
    expect(spies.onRequestCancel).not.toHaveBeenCalled();
  });

  it("shows a cancel error as the run's error banner", async () => {
    const view = await mount(
      panelElement(model({ subagents: [run({ runId: "run-1" })] }), createSpies(), {
        cancelErrorByRunId: { "run-1": "无法连接 Host" },
      }),
    );

    const banner = view.querySelector<HTMLElement>(".subagent-run-alert.is-error");
    expect(banner?.textContent).toBe("无法连接 Host");
    expect(banner?.getAttribute("role")).toBe("alert");
  });

  it("renders terminal runs from the current turn as compact summaries", async () => {
    const view = await mount(
      panelElement(
        model({
          subagents: [
            run({
              runId: "run-done",
              phase: "completed",
              stopReason: "completed",
              endedAt: 30_000,
            }),
          ],
        }),
        createSpies(),
      ),
    );

    expect(view.querySelector(".subagent-run-compact")).not.toBeNull();
    expect(view.textContent).toContain("已完成");
    const terminate = [...view.querySelectorAll("button")].find(
      (item) => item.textContent?.trim() === "终止",
    );
    expect(terminate).toBeUndefined();
  });
});
