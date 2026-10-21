// @vitest-environment jsdom
/**
 * 「运行记录」删除接线（规格 §6）：行内删除 → 确认框 → automation.deleteRun →
 * 刷新列表 / 关闭运行标签 / 目录删除失败的诚实提示，以及 M26 P2-3 的在飞守卫
 * （只靠按钮 disabled 挡不住同一批事件里的第二次点击）。
 *
 * 形态承 tests/client-huaanwork/market-view.spec.ts 先例：createRoot + act 挂真实组件，
 * 只 mock 边界上的 api.rpcCall。
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/client-huaanwork/api.ts", () => ({ rpcCall: vi.fn() }));

import { rpcCall } from "../../src/client-huaanwork/api.ts";
import AutomationsView from "../../src/client-huaanwork/AutomationsView.tsx";
import type { AutomationInfo, RunSummary } from "../../src/client-huaanwork/logic/projects.ts";

type DeleteResult = { removed: boolean; sessionDirRemoved: boolean };

const rpc = rpcCall as unknown as {
  mockImplementation: (
    impl: (method: string, params?: Record<string, unknown>) => Promise<unknown>,
  ) => void;
  mock: { calls: unknown[][] };
};

const AUTOMATION: AutomationInfo = {
  id: "a1",
  projectId: null,
  name: "每日简报",
  kind: "agent",
  schedule: { kind: "manual" },
  prompt: "整理今天的纪要",
  widget: false,
  enabled: true,
  createdAt: 1,
};

function run(runId: string, sessionId: string, startedAt: number, output: string): RunSummary {
  return { runId, sessionId, startedAt, endedAt: startedAt + 1000, ok: true, status: "ok", output };
}

let root: Root | undefined;
let container: HTMLDivElement | undefined;

/** 按 method 分派的最小 rpc 桩；runs 读取调用方持有的可变列表。 */
function stubRpc(options: {
  runs: () => RunSummary[];
  deleteRun: (automationId: string, runId: string) => Promise<DeleteResult>;
}) {
  rpc.mockImplementation(async (method, params) => {
    if (method === "automation.runs") return { runs: options.runs() };
    if (method === "automation.deleteRun") {
      return options.deleteRun(String(params?.id), String(params?.runId));
    }
    if (method === "session.open") return { log: "", records: [] };
    throw new Error(`unexpected rpc: ${method}`);
  });
}

function buttonByText(view: HTMLElement, label: string): HTMLButtonElement {
  const button = [...view.querySelectorAll("button")].find((item) => item.textContent === label);
  if (button === undefined) throw new Error(`button not found: ${label}`);
  return button;
}

function dialogConfirm(view: HTMLElement): HTMLButtonElement {
  const dialog = view.querySelector('[role="dialog"]');
  if (dialog === null) throw new Error("delete confirmation is not open");
  return buttonByText(dialog as HTMLElement, "删除");
}

/** 行按 startedAt 倒序，按输出文本定位目标行，避免测试依赖排序细节。 */
function deleteButtonFor(view: HTMLElement, output: string): HTMLButtonElement {
  const row = [...view.querySelectorAll(".automation-runs li")].find((item) =>
    item.textContent?.includes(output),
  );
  const button = row?.querySelector(".run-delete");
  if (!(button instanceof HTMLButtonElement)) throw new Error(`delete button not found for: ${output}`);
  return button;
}

async function mount(options: { onRunDeleted: (sessionId: string) => void; onChanged: () => void }): Promise<HTMLDivElement> {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      createElement(AutomationsView, {
        projects: [],
        activeProjectId: null,
        automations: [AUTOMATION],
        runs: {},
        runningIds: new Set<string>(),
        onChanged: options.onChanged,
        onRunDeleted: options.onRunDeleted,
        keepAwake: false,
        onToggleKeepAwake: () => undefined,
        missedBanner: { visible: false, count: 0 },
        onDismissMissedBanner: () => undefined,
      }),
    );
  });
  await act(async () => {
    buttonByText(container!, "运行记录").click();
  });
  return container;
}

beforeEach(() => {
  rpc.mock.calls.length = 0;
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  root = undefined;
  container?.remove();
  vi.unstubAllGlobals();
});

describe("运行记录删除（spec §6）", () => {
  it("deletes the confirmed row, reports the kept session dir and closes the run tab", async () => {
    let runs = [run("r1", "s-1", 1000, "第一条输出"), run("r2", "s-2", 2000, "第二条输出")];
    const onChanged = vi.fn();
    const onRunDeleted = vi.fn();
    stubRpc({
      runs: () => runs,
      deleteRun: async () => {
        // 宿主已经删行；第二次 automation.runs 只回剩下的那条。
        runs = runs.filter((item) => item.runId !== "r1");
        return { removed: true, sessionDirRemoved: false };
      },
    });

    const view = await mount({ onRunDeleted, onChanged });
    expect(view.querySelectorAll(".run-delete")).toHaveLength(2);

    await act(async () => {
      deleteButtonFor(view, "第一条输出").click();
    });
    expect(view.querySelector('[role="dialog"]')).not.toBeNull();
    expect(view.querySelector('[role="dialog"]')!.textContent).toContain("会话目录将被一并删除");

    await act(async () => {
      dialogConfirm(view).click();
    });

    const deleteCalls = rpc.mock.calls.filter((call) => call[0] === "automation.deleteRun");
    expect(deleteCalls).toHaveLength(1);
    expect(deleteCalls[0]![1]).toEqual({ id: "a1", runId: "r1" });
    expect(view.querySelector('[role="dialog"]')).toBeNull();
    // 被删的那行消失，另一行还在。
    expect(view.textContent).not.toContain("第一条输出");
    expect(view.textContent).toContain("第二条输出");
    // 目录没删掉要诚实说出来（记录本身已删，列表不再出现）。
    expect(view.textContent).toContain("记录已删除，但会话目录未能删除");
    expect(onRunDeleted).toHaveBeenCalledWith("s-1");
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("keeps the list untouched and surfaces the host error when the run is still running", async () => {
    const runs = [run("r1", "s-1", 1000, "第一条输出")];
    const onChanged = vi.fn();
    const onRunDeleted = vi.fn();
    stubRpc({
      runs: () => runs,
      deleteRun: async () => {
        throw new Error("运行中的记录不能删除");
      },
    });

    const view = await mount({ onRunDeleted, onChanged });
    await act(async () => {
      (view.querySelector(".run-delete") as HTMLButtonElement).click();
    });
    await act(async () => {
      dialogConfirm(view).click();
    });

    expect(view.querySelector('[role="dialog"]')).toBeNull();
    const banner = view.querySelector(".banner.error");
    expect(banner).not.toBeNull();
    expect(banner!.textContent).toContain("运行中的记录不能删除");
    // 列表保持原样：行还在，没有乐观删除。
    expect(view.textContent).toContain("第一条输出");
    expect(onRunDeleted).not.toHaveBeenCalled();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("a second click in the same batch never sends a second deleteRun", async () => {
    let runs = [run("r1", "s-1", 1000, "第一条输出")];
    let settle: ((value: DeleteResult) => void) | undefined;
    stubRpc({
      runs: () => runs,
      deleteRun: () =>
        new Promise<DeleteResult>((resolve) => {
          settle = resolve;
        }),
    });

    const view = await mount({ onRunDeleted: vi.fn(), onChanged: vi.fn() });
    await act(async () => {
      (view.querySelector(".run-delete") as HTMLButtonElement).click();
    });
    const confirm = dialogConfirm(view);
    await act(async () => {
      // 同一批事件里点两次：deletingRunId 还没经渲染生效为 disabled，
      // 只有函数体的同步在飞锁能挡住第二次（把守卫换成 state 判定即双发，已实测）。
      confirm.click();
      confirm.click();
    });

    expect(rpc.mock.calls.filter((call) => call[0] === "automation.deleteRun")).toHaveLength(1);

    runs = runs.filter((item) => item.runId !== "r1");
    await act(async () => {
      settle?.({ removed: true, sessionDirRemoved: true });
    });
    expect(view.querySelector('[role="dialog"]')).toBeNull();
    expect(view.textContent).not.toContain("第一条输出");
  });
});
