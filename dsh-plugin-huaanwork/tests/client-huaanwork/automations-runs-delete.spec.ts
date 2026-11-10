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
import AutomationsView, { lastRunLabel } from "../../src/client-huaanwork/AutomationsView.tsx";
import type { AutomationInfo, ProjectInfo, RunSummary, TaskInfo } from "../../src/client-huaanwork/logic/projects.ts";

type DeleteResult = { removed: boolean; sessionDirRemoved: boolean; taskId?: string };

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
  enabled: true,
  createdAt: 1,
};

function run(runId: string, sessionId: string, startedAt: number, output: string): RunSummary {
  return { runId, sessionId, startedAt, endedAt: startedAt + 1000, ok: true, status: "ok", output };
}

/** 脚本/missed 运行没有会话目录。 */
function runWithoutSession(runId: string, startedAt: number, output: string): RunSummary {
  return { runId, startedAt, endedAt: startedAt + 1000, ok: true, status: "ok", output };
}

let root: Root | undefined;
let container: HTMLDivElement | undefined;

/** 按 method 分派的最小 rpc 桩；runs 读取调用方持有的可变列表。 */
function stubRpc(options: {
  runs: () => RunSummary[];
  deleteRun: (automationId: string, runId: string) => Promise<DeleteResult>;
  /** 表单模态的保存应答；不传时原样回一份任务（编辑表单只读 nextRunAt）。 */
  update?: (automationId: string, patch: Record<string, unknown>) => Promise<AutomationInfo>;
}) {
  rpc.mockImplementation(async (method, params) => {
    if (method === "automation.runs") return { runs: options.runs() };
    if (method === "automation.deleteRun") {
      return options.deleteRun(String(params?.id), String(params?.runId));
    }
    // 创建表单挂载即取模板；模板加载失败被组件静默吞掉，这里给一份空列表让路径确定。
    if (method === "automation.templates") return { templates: [] };
    if (method === "automation.update") {
      const update = options.update ?? (async () => AUTOMATION);
      return { automation: await update(String(params?.id), params ?? {}) };
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

/**
 * 运行产出已不在页面上展示（规格 §7.1），行按 startedAt 倒序（组内同序），
 * 按序号取删除按钮。
 */
function deleteButtonAt(view: HTMLElement, index: number): HTMLButtonElement {
  const button = view.querySelectorAll(".run-delete")[index];
  if (!(button instanceof HTMLButtonElement)) throw new Error(`delete button not found at index ${index}`);
  return button;
}

const PROJECT_ALPHA: ProjectInfo = { id: "p-alpha", name: "Alpha 项目", root: "/tmp/alpha", createdAt: 1 };
const PROJECT_BETA: ProjectInfo = { id: "p-beta", name: "Beta 项目", root: "/tmp/beta", createdAt: 2 };

function selectByLabel(view: HTMLElement, label: string): HTMLSelectElement {
  const select = view.querySelector(`select[aria-label="${label}"]`);
  if (!(select instanceof HTMLSelectElement)) throw new Error(`select not found: ${label}`);
  return select;
}

/** 当前选中项的下拉显示文案（不是 value：空值的默认项自带文案）。 */
function selectedText(select: HTMLSelectElement): string {
  return select.selectedOptions[0]?.textContent ?? "";
}

function optionByValue(select: HTMLSelectElement, value: string): HTMLOptionElement {
  const option = [...select.options].find((item) => item.value === value);
  if (option === undefined) throw new Error(`option not found: ${value}`);
  return option;
}

/** 受控 select 的 change：先写 DOM 值再派发事件，React 从事件目标读新值。 */
async function pickProject(select: HTMLSelectElement, value: string): Promise<void> {
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function mount(options: {
  onRunDeleted: (sessionId: string, automationId: string, startedAt: number) => void;
  onChanged: () => void;
  onWorkspaceAligned?: (workspaceRoot: string) => void;
  runningIds?: ReadonlySet<string>;
  runs?: Record<string, RunSummary[]>;
  /** 运行记录跳转的权威子任务快照（默认空：旧记录只能只读打开）。 */
  tasks?: TaskInfo[];
  onOpenRunTask?: (task: TaskInfo) => void;
  /** 默认进「运行记录」tab；任务行用例留在「任务」tab。 */
  openRuns?: boolean;
  /** 归属项目下拉的数据源（默认空列表：零项目也照常展示表单）。 */
  projects?: ProjectInfo[];
  /** 覆盖默认的单条任务（编辑态用例需要带归属的任务）。 */
  automations?: AutomationInfo[];
}): Promise<HTMLDivElement> {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      createElement(AutomationsView, {
        projects: options.projects ?? [],
        activeProjectId: null,
        automations: options.automations ?? [AUTOMATION],
        runs: options.runs ?? {},
        runningIds: options.runningIds ?? new Set<string>(),
        tasks: options.tasks ?? [],
        // 组件契约里 onOpenRunTask 是必填（App 是唯一消费方）；不关心跳转的用例给空桩。
        onOpenRunTask: options.onOpenRunTask ?? (() => undefined),
        onChanged: options.onChanged,
        onWorkspaceAligned: options.onWorkspaceAligned,
        onRunDeleted: options.onRunDeleted,
        keepAwake: false,
        onToggleKeepAwake: () => undefined,
        missedBanner: { visible: false, count: 0 },
        onDismissMissedBanner: () => undefined,
      }),
    );
  });
  if (options.openRuns !== false) {
    await act(async () => {
      buttonByText(container!, "运行记录").click();
    });
  }
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
  it("deletes the confirmed row and closes the run tab", async () => {
    let runs = [run("r1", "s-1", 1000, "第一条输出"), run("r2", "s-2", 2000, "第二条输出")];
    const onChanged = vi.fn();
    const onRunDeleted = vi.fn();
    stubRpc({
      runs: () => runs,
      deleteRun: async () => {
        // 宿主已经删行；第二次 automation.runs 只回剩下的那条。
        // sessionDirRemoved 只可能是 true：目录删除失败时宿主抛错、保留 Run（走下面的 catch 用例）。
        runs = runs.filter((item) => item.runId !== "r1");
        return { removed: true, sessionDirRemoved: true };
      },
    });

    const view = await mount({ onRunDeleted, onChanged });
    expect(view.querySelectorAll(".run-delete")).toHaveLength(2);

    await act(async () => {
      // startedAt 倒序：r2（2000）在前，r1（1000）是第二行。
      deleteButtonAt(view, 1).click();
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
    // 被删的那行消失，另一行还在（输出不再展示，按行数断言）。
    expect(view.querySelectorAll(".run-delete")).toHaveLength(1);
    expect(onRunDeleted).toHaveBeenCalledWith("s-1", "a1", 1000);
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
    // 列表保持原样：行还在，没有乐观删除（输出不再展示，按行数断言）。
    expect(view.querySelectorAll(".run-delete")).toHaveLength(1);
    expect(onRunDeleted).not.toHaveBeenCalled();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("does not promise a session directory for a session-less run", async () => {
    const runs = [runWithoutSession("r1", 1000, "脚本输出")];
    stubRpc({
      runs: () => runs,
      deleteRun: async () => ({ removed: true, sessionDirRemoved: true }),
    });
    const view = await mount({ onRunDeleted: vi.fn(), onChanged: vi.fn(), runs: { a1: runs } });
    await act(async () => {
      deleteButtonAt(view, 0).click();
    });
    const dialog = view.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog!.textContent).not.toContain("会话目录");
    expect(dialog!.textContent).toContain("这条运行记录将被删除");
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
    expect(view.querySelectorAll(".run-delete")).toHaveLength(0);
  });
});

describe("运行记录跳转（规格 §8）", () => {
  const TASK: TaskInfo = {
    id: "task-1",
    projectId: "p-old",
    name: "每日简报 · 2026-11-09 10:00:00",
    createdAt: 1_000,
    automationId: "a1",
    runId: "r1",
    sessionId: "s-1",
  };

  /** 行按 runId 定位（规格 §8：不再依赖运行产出文本）。 */
  function rowByRunId(view: HTMLElement, runId: string): HTMLElement {
    const row = view.querySelector(`[data-run-id="${runId}"]`);
    if (!(row instanceof HTMLElement)) throw new Error(`run row not found: ${runId}`);
    return row;
  }

  it("opens the historical task through the task branch instead of the read-only session", async () => {
    const runs = [{ ...run("r1", "s-1", 1000, "输出"), taskId: "task-1" }];
    stubRpc({ runs: () => runs, deleteRun: async () => ({ removed: true, sessionDirRemoved: true }) });
    const onOpenRunTask = vi.fn();
    const view = await mount({
      onRunDeleted: vi.fn(),
      onChanged: vi.fn(),
      runs: { a1: runs },
      tasks: [TASK],
      onOpenRunTask,
    });

    const button = rowByRunId(view, "r1").querySelector(".run-row-btn");
    expect(button).not.toBeNull();
    await act(async () => {
      (button as HTMLButtonElement).click();
    });

    expect(onOpenRunTask).toHaveBeenCalledWith(TASK);
    // 跳转走子任务流程；不再在同一页开只读会话详情。
    expect(rpc.mock.calls.some((call) => call[0] === "session.open")).toBe(false);
  });

  it("a run whose task is gone is not clickable and says the task or session is gone", async () => {
    const runs = [{ ...run("r1", "s-1", 1000, "输出"), taskId: "task-gone" }];
    stubRpc({ runs: () => runs, deleteRun: async () => ({ removed: true, sessionDirRemoved: true }) });
    const onOpenRunTask = vi.fn();
    const view = await mount({
      onRunDeleted: vi.fn(),
      onChanged: vi.fn(),
      runs: { a1: runs },
      tasks: [],
      onOpenRunTask,
    });

    const row = rowByRunId(view, "r1");
    expect(row.querySelector(".run-row-btn")).toBeNull();
    expect(row.textContent).toContain("对应子任务或会话已删除/清理");
    expect(onOpenRunTask).not.toHaveBeenCalled();
  });

  it("a legacy record without taskId still opens the read-only session", async () => {
    const runs = [run("r1", "s-1", 1000, "输出")];
    stubRpc({ runs: () => runs, deleteRun: async () => ({ removed: true, sessionDirRemoved: true }) });
    const onOpenRunTask = vi.fn();
    const view = await mount({
      onRunDeleted: vi.fn(),
      onChanged: vi.fn(),
      runs: { a1: runs },
      tasks: [],
      onOpenRunTask,
    });

    const button = rowByRunId(view, "r1").querySelector(".run-row-btn");
    expect(button).not.toBeNull();
    await act(async () => {
      (button as HTMLButtonElement).click();
    });

    const opened = rpc.mock.calls.filter((call) => call[0] === "session.open");
    expect(opened).toHaveLength(1);
    expect(opened[0]![1]).toEqual({ sessionId: "s-1" });
    expect(onOpenRunTask).not.toHaveBeenCalled();
  });

  it("a script run without a session is not clickable and explains why", async () => {
    const runs = [runWithoutSession("r1", 1000, "脚本输出")];
    stubRpc({ runs: () => runs, deleteRun: async () => ({ removed: true, sessionDirRemoved: true }) });
    const view = await mount({
      onRunDeleted: vi.fn(),
      onChanged: vi.fn(),
      runs: { a1: runs },
      automations: [{ ...AUTOMATION, kind: "script", command: "echo hi" }],
    });

    const row = rowByRunId(view, "r1");
    expect(row.querySelector(".run-row-btn")).toBeNull();
    expect(row.textContent).toContain("脚本运行无会话");
  });
});

describe("看板与产出展示退役（规格 §7.1）", () => {
  it("automation page has no board tab, widget control, or collected output", async () => {
    const collected = run("r1", "s1", 1000, "SECRET-COLLECTED-OUTPUT");
    stubRpc({
      runs: () => [collected],
      deleteRun: async () => ({ removed: true, sessionDirRemoved: true }),
    });
    const view = await mount({
      onChanged: () => undefined,
      onRunDeleted: () => undefined,
      runs: { [AUTOMATION.id]: [collected] },
    });
    // mount 默认落在「运行记录」tab：看板 tab 与运行产出都不得出现在页面上。
    expect(view.textContent).not.toContain("看板");
    expect(view.textContent).not.toContain("SECRET-COLLECTED-OUTPUT");
    expect(view.querySelector(".run-output")).toBeNull();
    // 回到「任务」tab：任务行不再有展开历史的入口与内联产出块（规格 §7.1 删除任务行展开历史）。
    await act(async () => {
      buttonByText(view, "任务").click();
    });
    expect(view.querySelector(".automation-expand")).toBeNull();
    expect(view.querySelector(".run-output")).toBeNull();
    expect(view.textContent).not.toContain("SECRET-COLLECTED-OUTPUT");
    // 创建表单：widget 勾选与看板文案也不得存在。
    await act(async () => {
      buttonByText(view, "＋ 新建任务").click();
    });
    expect(view.textContent).not.toContain("推送到项目看板");
    expect(view.textContent).not.toContain("看板");
    const createDialog = view.querySelector('[role="dialog"]') as HTMLElement;
    await act(async () => {
      buttonByText(createDialog, "取消").click();
    });
    // 编辑表单同样没有该控件（原 widget 勾选在两态共用）。
    await act(async () => {
      buttonByText(view, "编辑").click();
    });
    const editDialog = view.querySelector('[role="dialog"]') as HTMLElement;
    expect(editDialog.textContent).not.toContain("推送到项目看板");
    expect(editDialog.textContent).not.toContain("看板");
  });
});

describe("归属项目字段（设计 §3.3.3：创建自动建项目 / 编辑可改绑）", () => {
  it("a create form defaults to auto-creating a same-named project and says so", async () => {
    stubRpc({ runs: () => [], deleteRun: async () => ({ removed: true, sessionDirRemoved: true }) });
    const view = await mount({
      onRunDeleted: vi.fn(),
      onChanged: vi.fn(),
      openRuns: false,
      projects: [PROJECT_ALPHA, PROJECT_BETA],
    });

    await act(async () => {
      buttonByText(view, "＋ 新建任务").click();
    });

    const dialog = view.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    const select = selectByLabel(dialog as HTMLElement, "归属项目");
    // 创建态的默认项不是「不绑定」：宿主会自动创建同名项目并绑定。
    expect(select.selectedOptions[0]?.value).toBe("");
    expect(selectedText(select)).toBe("自动创建同名项目（推荐）");
    expect(select.disabled).toBe(false);
    expect(dialog!.textContent).toContain("将自动为您创建同名项目并绑定");
    // 已有项目仍可显式选择（不是二选一的单选项）。
    expect(optionByValue(select, PROJECT_BETA.id).textContent).toBe(PROJECT_BETA.name);
  });

  it("an edit form rebinds the project and sends projectId in automation.update", async () => {
    const update = vi.fn(async (automationId: string, patch: Record<string, unknown>) => {
      return { ...AUTOMATION, id: automationId, projectId: String(patch.projectId) };
    });
    stubRpc({ runs: () => [], deleteRun: async () => ({ removed: true, sessionDirRemoved: true }), update });
    const view = await mount({
      onRunDeleted: vi.fn(),
      onChanged: vi.fn(),
      openRuns: false,
      projects: [PROJECT_ALPHA, PROJECT_BETA],
      automations: [{ ...AUTOMATION, projectId: PROJECT_ALPHA.id }],
    });

    await act(async () => {
      buttonByText(view, "编辑").click();
    });
    const dialog = view.querySelector('[role="dialog"]') as HTMLElement;
    const select = selectByLabel(dialog, "归属项目");
    expect(selectedText(select)).toBe(PROJECT_ALPHA.name);
    expect(select.disabled).toBe(false);

    await pickProject(select, PROJECT_BETA.id);
    await act(async () => {
      buttonByText(dialog, "保存").click();
    });

    const updateCalls = rpc.mock.calls.filter((call) => call[0] === "automation.update");
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]![1]).toMatchObject({ id: AUTOMATION.id, projectId: PROJECT_BETA.id });
    // 补丁只带显式字段：整条 automation 展开会把 enabled/createdAt 一并写回宿主。
    expect(updateCalls[0]![1]).not.toHaveProperty("enabled");
    expect(updateCalls[0]![1]).not.toHaveProperty("createdAt");
  });

  it("saving an unchanged project select omits projectId from automation.update", async () => {
    const update = vi.fn(async (automationId: string) => ({
      ...AUTOMATION,
      id: automationId,
      projectId: PROJECT_ALPHA.id,
    }));
    stubRpc({ runs: () => [], deleteRun: async () => ({ removed: true, sessionDirRemoved: true }), update });
    const view = await mount({
      onRunDeleted: vi.fn(),
      onChanged: vi.fn(),
      openRuns: false,
      projects: [PROJECT_ALPHA, PROJECT_BETA],
      automations: [{ ...AUTOMATION, projectId: PROJECT_ALPHA.id }],
    });

    await act(async () => {
      buttonByText(view, "编辑").click();
    });
    const dialog = view.querySelector('[role="dialog"]') as HTMLElement;
    expect(selectedText(selectByLabel(dialog, "归属项目"))).toBe(PROJECT_ALPHA.name);

    await act(async () => {
      buttonByText(dialog, "保存").click();
    });

    const updateCalls = rpc.mock.calls.filter((call) => call[0] === "automation.update");
    expect(updateCalls).toHaveLength(1);
    // OMIT 分支：绑定没变就不带 projectId（null 不可回写，见 AutomationPatch），
    // 但显式字段仍照常发送。
    expect(updateCalls[0]![1]).not.toHaveProperty("projectId");
    expect(updateCalls[0]![1]).toMatchObject({
      id: AUTOMATION.id,
      name: AUTOMATION.name,
      kind: "agent",
      schedule: { kind: "manual" },
    });
  });

  it("keeps the edit form's project select disabled while the task is running", async () => {
    stubRpc({ runs: () => [], deleteRun: async () => ({ removed: true, sessionDirRemoved: true }) });
    const view = await mount({
      onRunDeleted: vi.fn(),
      onChanged: vi.fn(),
      openRuns: false,
      runningIds: new Set([AUTOMATION.id]),
      projects: [PROJECT_ALPHA, PROJECT_BETA],
      automations: [{ ...AUTOMATION, projectId: PROJECT_ALPHA.id }],
    });

    await act(async () => {
      buttonByText(view, "编辑").click();
    });
    const dialog = view.querySelector('[role="dialog"]') as HTMLElement;
    expect(selectByLabel(dialog, "归属项目").disabled).toBe(true);
    expect(dialog.textContent).toContain("任务正在运行，请等待运行结束或停止后再修改归属项目");
  });

  it("shows a legacy unbound task as a disabled placeholder it can rebind from", async () => {
    stubRpc({ runs: () => [], deleteRun: async () => ({ removed: true, sessionDirRemoved: true }) });
    const view = await mount({
      onRunDeleted: vi.fn(),
      onChanged: vi.fn(),
      openRuns: false,
      projects: [PROJECT_ALPHA, PROJECT_BETA],
    });

    await act(async () => {
      buttonByText(view, "编辑").click();
    });
    const dialog = view.querySelector('[role="dialog"]') as HTMLElement;
    const select = selectByLabel(dialog, "归属项目");
    const placeholder = optionByValue(select, "");
    expect(placeholder.disabled).toBe(true);
    expect(placeholder.textContent).toBe("未绑定项目（历史任务，可选择项目绑定）");
    expect(select.disabled).toBe(false);
  });

  it("marks a deleted project binding as rebind-required instead of silently dropping it", async () => {
    stubRpc({ runs: () => [], deleteRun: async () => ({ removed: true, sessionDirRemoved: true }) });
    const view = await mount({
      onRunDeleted: vi.fn(),
      onChanged: vi.fn(),
      openRuns: false,
      projects: [PROJECT_ALPHA, PROJECT_BETA],
      automations: [{ ...AUTOMATION, projectId: "gone" }],
    });

    await act(async () => {
      buttonByText(view, "编辑").click();
    });
    const dialog = view.querySelector('[role="dialog"]') as HTMLElement;
    const select = selectByLabel(dialog, "归属项目");
    const dangling = optionByValue(select, "gone");
    expect(dangling.disabled).toBe(true);
    expect(dangling.textContent).toBe("原归属项目已删除（请选择新项目）");
    // 仍可直接选一个新项目改绑。
    expect(selectByLabel(dialog, "归属项目").disabled).toBe(false);
  });
});

describe("手动运行准入反馈（P-4e）", () => {
  it("says the manual run did not start when admission skipped it and keeps the workspace", async () => {
    rpc.mockImplementation(async (method) => {
      if (method === "automation.run") {
        return { queued: false, waiting: true, reason: "root-busy", runId: "r1", workspaceRoot: "/projects/other" };
      }
      throw new Error(`unexpected rpc: ${method}`);
    });
    const onWorkspaceAligned = vi.fn();

    const view = await mount({
      onRunDeleted: vi.fn(),
      onChanged: vi.fn(),
      onWorkspaceAligned,
      openRuns: false,
    });
    await act(async () => {
      buttonByText(view, "立即运行").click();
    });

    expect(rpc.mock.calls.filter((call) => call[0] === "automation.run")).toHaveLength(1);
    expect(view.querySelector(".banner.error")?.textContent).toContain(
      "同一项目根上已有任务在运行，本次手动运行未开始。",
    );
    expect(onWorkspaceAligned).not.toHaveBeenCalled();
  });

  it("says the concurrency cap was reached when admission skipped it as cap-full", async () => {
    rpc.mockImplementation(async (method) => {
      if (method === "automation.run") {
        return { queued: false, waiting: true, reason: "cap-full", runId: "r1", workspaceRoot: "/projects/other" };
      }
      throw new Error(`unexpected rpc: ${method}`);
    });
    const onWorkspaceAligned = vi.fn();

    const view = await mount({
      onRunDeleted: vi.fn(),
      onChanged: vi.fn(),
      onWorkspaceAligned,
      openRuns: false,
    });
    await act(async () => {
      buttonByText(view, "立即运行").click();
    });

    expect(rpc.mock.calls.filter((call) => call[0] === "automation.run")).toHaveLength(1);
    expect(view.querySelector(".banner.error")?.textContent).toContain(
      "已达到同时进行的任务数上限，本次手动运行未开始。",
    );
    expect(onWorkspaceAligned).not.toHaveBeenCalled();
  });

  it("aligns the workspace after a started manual run", async () => {
    rpc.mockImplementation(async (method) => {
      if (method === "automation.run") {
        return { queued: true, runId: "r1", workspaceRoot: "/projects/other" };
      }
      throw new Error(`unexpected rpc: ${method}`);
    });
    const onWorkspaceAligned = vi.fn();

    const view = await mount({
      onRunDeleted: vi.fn(),
      onChanged: vi.fn(),
      onWorkspaceAligned,
      openRuns: false,
    });
    await act(async () => {
      buttonByText(view, "立即运行").click();
    });

    expect(onWorkspaceAligned).toHaveBeenCalledWith("/projects/other");
    expect(view.querySelector(".banner.error")).toBeNull();
  });
});

describe("任务行停止与「上次」文案（规格 §8）", () => {
  it("a running task row shows 停止 and stops through automation.stop, then refreshes", async () => {
    rpc.mockImplementation(async (method) => {
      if (method === "automation.runs") return { runs: [] };
      if (method === "automation.stop") return { stopped: true };
      throw new Error(`unexpected rpc: ${method}`);
    });
    const onChanged = vi.fn();
    const view = await mount({
      onRunDeleted: vi.fn(),
      onChanged,
      runningIds: new Set(["a1"]),
      openRuns: false,
    });

    const stop = buttonByText(view, "停止");
    await act(async () => {
      stop.click();
    });

    const stopCalls = rpc.mock.calls.filter((call) => call[0] === "automation.stop");
    expect(stopCalls).toHaveLength(1);
    expect(stopCalls[0]![1]).toEqual({ id: "a1" });
    // 宿主接受停止后、run-end 清掉 running 之前，按钮保持禁用，避免二次停止。
    const pendingStop = buttonByText(view, "停止中…");
    expect(pendingStop.disabled).toBe(true);
    // 停止后必须向宿主重取读数（按钮文案随后收敛）。
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("re-enables the stop button when the host rejects the request", async () => {
    rpc.mockImplementation(async (method) => {
      if (method === "automation.runs") return { runs: [] };
      if (method === "automation.stop") throw new Error("stop failed");
      throw new Error(`unexpected rpc: ${method}`);
    });
    const onChanged = vi.fn();
    const view = await mount({
      onRunDeleted: vi.fn(),
      onChanged,
      runningIds: new Set(["a1"]),
      openRuns: false,
    });

    await act(async () => {
      buttonByText(view, "停止").click();
    });

    // 请求失败时不能把按钮永久卡在“停止中…”；用户需要能重试。
    expect(buttonByText(view, "停止").disabled).toBe(false);
    expect(view.querySelector(".banner.error")?.textContent).toContain("stop failed");
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("a task with no live run offers 立即运行 instead of 停止", async () => {
    rpc.mockImplementation(async (method) => {
      if (method === "automation.runs") return { runs: [] };
      throw new Error(`unexpected rpc: ${method}`);
    });
    const view = await mount({ onRunDeleted: vi.fn(), onChanged: vi.fn(), openRuns: false });
    expect(view.textContent).toContain("立即运行");
    expect(view.textContent).not.toContain("停止");
  });

  it("lastRunLabel says 已取消 only when the newest loaded run is cancelled", () => {
    const automation: AutomationInfo = { ...AUTOMATION, lastRunAt: 5_000, lastStatus: "error" };
    const cancelled: RunSummary[] = [
      run("r1", "s-1", 1_000, "旧"),
      { ...run("r2", "s-2", 2_000, "新"), status: "cancelled", ok: false },
    ];
    expect(lastRunLabel(automation, false, cancelled)).toContain("已取消");

    const missed: RunSummary[] = [{ ...run("r1", "s-1", 1_000, "错过"), status: "missed", ok: false }];
    expect(lastRunLabel(automation, false, missed)).not.toContain("已取消");

    const timeout: RunSummary[] = [{ ...run("r1", "s-1", 1_000, "超时"), status: "timeout", ok: false }];
    expect(lastRunLabel(automation, false, timeout)).not.toContain("已取消");

    // 运行中优先于任何记录读数。
    expect(lastRunLabel(automation, true, cancelled)).toBe("运行中");
  });
});
