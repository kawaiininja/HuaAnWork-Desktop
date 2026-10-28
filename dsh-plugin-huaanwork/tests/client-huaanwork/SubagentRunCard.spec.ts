// @vitest-environment jsdom
/**
 * 子代理运行卡（Task 10）：诚实状态、卡内二次确认、键盘焦点、读屏区域与 token 化样式。
 *
 * 卡片的 `expanded`/`confirming` 由调用方持有（Task 11 的 UI Map），所以测试用
 * 一个有状态 Harness 模拟父组件；纯展示断言直接读 DOM。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, createElement, useState } from "react";
import type { ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";

import SubagentRunCard from "../../src/client-huaanwork/SubagentRunCard.tsx";
import {
  formatRunStartedAt,
  type SubagentRunView,
} from "../../src/client-huaanwork/logic/subagentRuns.ts";

const RUN: SubagentRunView = {
  runId: "run-1",
  parentSessionId: "parent-1",
  clientMessageId: "11",
  kind: "package",
  label: "@代码审查",
  packageVersion: "1.2.0",
  phase: "tool",
  activeTools: [{ id: "tool-1", name: "read_file", startedAt: 1_000 }],
  startedAt: 0,
  lastActivity: 1_000,
  cleanupWarnings: [],
  generation: "gen-1",
  revision: 1,
};

const TERMINAL_RUN: SubagentRunView = {
  ...RUN,
  phase: "failed",
  stopReason: "error",
  endedAt: 30_000,
  failure: "上游连接中断",
  cleanupWarnings: [{ code: "activation-dispose-failed", severity: "error" }],
  activeTools: [
    { id: "tool-1", name: "read_file", startedAt: 1_000 },
    { id: "tool-2", name: "write_file", startedAt: 2_000 },
  ],
};

type HandlerSpies = {
  onRequestCancel: Mock<(runId: string) => void>;
  onConfirmCancel: Mock<(runId: string) => void>;
  onDismissCancel: Mock<(runId: string) => void>;
};

type HarnessProps = {
  run: SubagentRunView;
  now: number;
  spies: HandlerSpies;
  frozenAt?: number;
  duplicateLabel?: boolean;
  initialExpanded?: boolean;
  cancelBusy?: boolean;
  cancelError?: string;
};

/** 模拟 Task 11：confirming/expanded 由调用方持有，确认回调只记录不发送 RPC。 */
function Harness(props: HarnessProps): ReactElement {
  const [confirming, setConfirming] = useState(false);
  const [expanded, setExpanded] = useState(props.initialExpanded ?? false);

  return createElement(SubagentRunCard, {
    run: props.run,
    now: props.now,
    frozenAt: props.frozenAt,
    duplicateLabel: props.duplicateLabel ?? false,
    expanded,
    confirming,
    cancelBusy: props.cancelBusy ?? false,
    cancelError: props.cancelError,
    onToggleExpanded: (): void => {
      setExpanded((current) => !current);
    },
    onRequestCancel: (runId: string): void => {
      props.spies.onRequestCancel(runId);
      setConfirming(true);
    },
    onConfirmCancel: (runId: string): void => {
      props.spies.onConfirmCancel(runId);
    },
    onDismissCancel: (runId: string): void => {
      props.spies.onDismissCancel(runId);
      setConfirming(false);
    },
  });
}

function createSpies(): HandlerSpies {
  return {
    onRequestCancel: vi.fn<(runId: string) => void>(),
    onConfirmCancel: vi.fn<(runId: string) => void>(),
    onDismissCancel: vi.fn<(runId: string) => void>(),
  };
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

async function pressEscape(): Promise<void> {
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
}

function buttonByText(view: ParentNode, text: string): HTMLButtonElement {
  const button = [...view.querySelectorAll("button")].find(
    (item) => item.textContent?.trim() === text,
  );
  if (button === undefined) throw new Error(`button not found by text: ${text}`);
  return button;
}

function buttonByLabel(view: ParentNode, label: string): HTMLButtonElement {
  const button = [...view.querySelectorAll("button")].find(
    (item) => item.getAttribute("aria-label") === label,
  );
  if (button === undefined) throw new Error(`button not found by label: ${label}`);
  return button;
}

function statusRegion(view: ParentNode): HTMLElement {
  const region = view.querySelector<HTMLElement>('[role="status"]');
  if (region === null) throw new Error("status region not found");
  return region;
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

describe("SubagentRunCard active card", () => {
  it("首次点击只展开卡内确认；取消按钮取得焦点；Esc 关闭并归还焦点且不再发 RPC", async () => {
    const spies = createSpies();
    const view = await mount(createElement(Harness, { run: RUN, now: 13_000, spies }));

    expect(view.textContent).toContain("@代码审查");
    expect(view.textContent).toContain("v1.2.0");
    expect(view.textContent).toContain("正在执行工具");
    expect(view.textContent).toContain("read_file");
    expect(view.textContent).toContain("00:13");
    expect(view.textContent).toContain("最近活动 12 秒前");

    const region = statusRegion(view);
    expect(region.getAttribute("aria-live")).toBe("polite");
    expect(region.getAttribute("aria-atomic")).toBe("true");
    expect(region.textContent).toBe("正在执行工具 · read_file");
    expect(region.textContent).not.toContain("00:13");
    expect(region.textContent).not.toContain("最近活动");

    const terminate = buttonByText(view, "终止");
    expect(terminate.getAttribute("aria-label")).toBe("终止 @代码审查 本次运行");
    await click(terminate);

    expect(spies.onRequestCancel).toHaveBeenCalledWith("run-1");
    expect(spies.onConfirmCancel).not.toHaveBeenCalled();
    expect(spies.onDismissCancel).not.toHaveBeenCalled();
    expect(view.textContent).toContain("确认终止 @代码审查");
    expect(document.activeElement?.textContent).toBe("取消");

    await pressEscape();

    expect(spies.onDismissCancel).toHaveBeenCalledWith("run-1");
    expect(spies.onConfirmCancel).not.toHaveBeenCalled();
    expect(document.activeElement?.textContent).toBe("终止");

    // 监听器只存在于确认区：关闭后再按 Esc 不得重复回调。
    await pressEscape();
    expect(spies.onDismissCancel).toHaveBeenCalledTimes(1);

    await act(async () => {
      root!.unmount();
    });
    root = undefined;
    container?.remove();
    container = undefined;
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(spies.onDismissCancel).toHaveBeenCalledTimes(1);
  });

  it("展开按钮是原生 button，aria-expanded 随状态变化并释放完整工具列表", async () => {
    const spies = createSpies();
    const run: SubagentRunView = {
      ...RUN,
      activeTools: [
        { id: "tool-2", name: "write_file", startedAt: 2_000 },
        { id: "tool-1", name: "read_file", startedAt: 1_000 },
      ],
    };
    const view = await mount(createElement(Harness, { run, now: 3_000, spies }));

    const expand = buttonByLabel(view, "展开 @代码审查 详情");
    expect(expand.tagName).toBe("BUTTON");
    expect(expand.getAttribute("aria-expanded")).toBe("false");
    expect(view.querySelector(".subagent-run-tools")).toBeNull();

    await click(expand);

    expect(buttonByLabel(view, "收起 @代码审查 详情").getAttribute("aria-expanded")).toBe("true");
    const tools = [...view.querySelectorAll(".subagent-run-tools li")].map(
      (item) => item.textContent,
    );
    expect(tools).toEqual(["read_file", "write_file"]);
  });

  it("状态区域只随相位与在途工具更新，不随时钟跳动", async () => {
    const spies = createSpies();
    const run: SubagentRunView = {
      ...RUN,
      activeTools: [
        { id: "tool-2", name: "write_file", startedAt: 2_000 },
        { id: "tool-1", name: "read_file", startedAt: 1_000 },
      ],
    };
    const view = await mount(createElement(Harness, { run, now: 13_000, spies }));
    const before = statusRegion(view).textContent;
    expect(before).toBe("正在执行 2 个工具 · read_file、write_file");
    expect(before).not.toContain("正在执行工具 · 正在执行");

    await rerender(createElement(Harness, { run, now: 99_000, spies }));
    expect(statusRegion(view).textContent).toBe(before);
    expect(statusRegion(view).textContent).not.toContain("01:39");
    expect(view.textContent).toContain("01:39");

    const reordered: SubagentRunView = {
      ...run,
      activeTools: [run.activeTools[1]!, run.activeTools[0]!],
      revision: 2,
    };
    await rerender(createElement(Harness, { run: reordered, now: 99_000, spies }));
    expect(statusRegion(view).textContent).toBe(before);
  });

  it("同名运行显示开始时间，终止与详情按钮的可访问名带上该时间", async () => {
    const spies = createSpies();
    const view = await mount(
      createElement(Harness, { run: RUN, now: 13_000, spies, duplicateLabel: true }),
    );
    const startedAt = formatRunStartedAt(RUN.startedAt);

    expect(view.textContent).toContain(startedAt);
    expect(buttonByText(view, "终止").getAttribute("aria-label")).toBe(
      `终止 @代码审查 本次运行，开始于 ${startedAt}`,
    );
    expect(
      buttonByLabel(view, `展开 @代码审查 详情，开始于 ${startedAt}`),
    ).toBeTruthy();

    await click(buttonByText(view, "终止"));
    expect(view.textContent).toContain(`确认终止 @代码审查，开始于 ${startedAt}`);
  });

  it("长名称保留完整 title，不会顶掉终止控件", async () => {
    const spies = createSpies();
    const label = `@${"超长名称".repeat(20)}`;
    const view = await mount(
      createElement(Harness, { run: { ...RUN, label }, now: 13_000, spies }),
    );

    const name = view.querySelector<HTMLElement>(".subagent-run-label");
    expect(name?.textContent).toBe(label);
    expect(name?.getAttribute("title")).toBe(label);
    expect(buttonByText(view, "终止")).toBeTruthy();
  });

  it("确认与取消按钮分别提交和关闭，取消后焦点回到终止", async () => {
    const spies = createSpies();
    const view = await mount(createElement(Harness, { run: RUN, now: 13_000, spies }));

    await click(buttonByText(view, "终止"));
    await click(buttonByText(view, "确认终止 @代码审查"));
    expect(spies.onConfirmCancel).toHaveBeenCalledWith("run-1");

    // 关闭确认后重新打开，走取消。
    await click(buttonByText(view, "取消"));
    await click(buttonByText(view, "终止"));
    await click(buttonByText(view, "取消"));
    expect(spies.onDismissCancel).toHaveBeenCalledWith("run-1");
    expect(document.activeElement?.textContent).toBe("终止");
  });

  it("cancelBusy 时终止与确认禁用，取消仍可关闭确认", async () => {
    const spies = createSpies();
    const view = await mount(
      createElement(Harness, { run: { ...RUN, phase: "stopping" }, now: 13_000, spies, cancelBusy: true }),
    );

    expect(buttonByText(view, "终止").disabled).toBe(true);
    await click(buttonByText(view, "终止"));
    expect(spies.onRequestCancel).not.toHaveBeenCalled();
  });

  it("cancelError 落在本卡，作为错误横幅且不进入状态区域", async () => {
    const spies = createSpies();
    const view = await mount(
      createElement(Harness, {
        run: RUN,
        now: 13_000,
        spies,
        cancelError: "无法连接 Host",
      }),
    );

    const banner = view.querySelector<HTMLElement>(".subagent-run-alert.is-error");
    expect(banner?.textContent).toBe("无法连接 Host");
    expect(banner?.getAttribute("role")).toBe("alert");
    expect(banner?.closest('[role="status"]')).toBeNull();
    expect(statusRegion(view).textContent).not.toContain("无法连接 Host");
  });
});

describe("SubagentRunCard terminal card", () => {
  it("活跃切到终态时复用同一个 role=status 节点，终态文案仍被播报", async () => {
    const spies = createSpies();
    const view = await mount(createElement(Harness, { run: RUN, now: 13_000, spies }));

    const before = statusRegion(view);
    expect(before.textContent).toBe("正在执行工具 · read_file");
    expect(before.classList.contains("subagent-run-sr-only")).toBe(true);
    expect(before.parentElement?.classList.contains("subagent-run-card")).toBe(true);

    await rerender(
      createElement(Harness, {
        run: { ...RUN, phase: "completed", stopReason: "completed", endedAt: 14_000 },
        now: 14_000,
        spies,
      }),
    );

    const after = statusRegion(view);
    expect(after).toBe(before);
    expect(view.contains(before)).toBe(true);
    expect(after.textContent).toBe("已完成");
    expect(after.parentElement?.classList.contains("subagent-run-card")).toBe(true);
    expect(view.querySelectorAll('[role="status"]')).toHaveLength(1);
  });

  it("终态折叠为单行，无提醒与工具列表；展开后显示失败、告警与工具，且不被重渲染折叠", async () => {
    const spies = createSpies();
    const view = await mount(
      createElement(Harness, { run: TERMINAL_RUN, now: 999_999, spies }),
    );

    expect(view.querySelector(".subagent-run-compact")).not.toBeNull();
    expect(view.querySelector(".subagent-run-header")).toBeNull();
    expect(view.querySelector(".subagent-run-alert")).toBeNull();
    expect(view.querySelector(".subagent-run-tools")).toBeNull();
    expect(view.textContent).toContain("@代码审查");
    expect(view.textContent).toContain("失败 · 执行出错");
    expect(view.textContent).toContain("00:30");
    expect(statusRegion(view).textContent).toBe("失败 · 执行出错");

    await click(buttonByLabel(view, "展开 @代码审查 详情"));

    expect(view.textContent).toContain("上游连接中断");
    expect(view.textContent).toContain("子代理释放失败，清理未确认");
    const tools = [...view.querySelectorAll(".subagent-run-tools li")].map(
      (item) => item.textContent,
    );
    expect(tools).toEqual(["read_file", "write_file"]);

    // 外部 run 更新（新 revision）不得重置调用方持有的展开状态。
    await rerender(
      createElement(Harness, {
        run: { ...TERMINAL_RUN, revision: 2, endedAt: 31_000 },
        now: 999_999,
        spies,
      }),
    );
    expect(view.textContent).toContain("上游连接中断");
    expect(view.textContent).toContain("子代理释放失败，清理未确认");
    expect(statusRegion(view).textContent).toBe("失败 · 执行出错");
  });

  it("真实 error warning 用一次 role=alert，位于状态区域之外，且不改写终态文案", async () => {
    const spies = createSpies();
    const run: SubagentRunView = {
      ...RUN,
      phase: "completed",
      stopReason: "completed",
      endedAt: 30_000,
      cleanupWarnings: [
        { code: "activation-dispose-failed", severity: "error" },
        { code: "runtime-stop-failed", severity: "error" },
      ],
    };
    const view = await mount(createElement(Harness, { run, now: 30_000, spies }));

    expect(statusRegion(view).textContent).toBe("已完成");
    expect(view.querySelector('[role="alert"]')).toBeNull();

    await click(buttonByLabel(view, "展开 @代码审查 详情"));

    const alerts = view.querySelectorAll<HTMLElement>('[role="alert"]');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.closest('[role="status"]')).toBeNull();
    expect(view.textContent).toContain("子代理释放失败，清理未确认");
    expect(view.textContent).toContain("运行环境停止失败，清理未确认");
    expect(statusRegion(view).textContent).toBe("已完成");
    expect(view.textContent).not.toContain("失败 · 执行出错");
  });

  it("终态详情不展示过期的取消 RPC 错误，仍保留真实清理告警", async () => {
    const spies = createSpies();
    const view = await mount(
      createElement(Harness, {
        run: TERMINAL_RUN,
        now: 999_999,
        spies,
        cancelError: "无法连接 Host",
      }),
    );

    await click(buttonByLabel(view, "展开 @代码审查 详情"));

    expect(view.textContent).not.toContain("无法连接 Host");
    expect(view.textContent).toContain("子代理释放失败，清理未确认");
  });

  it("终态卡没有终止按钮", async () => {
    const spies = createSpies();
    const run: SubagentRunView = {
      ...RUN,
      phase: "completed",
      stopReason: "completed",
      endedAt: 30_000,
    };
    const view = await mount(createElement(Harness, { run, now: 30_000, spies }));

    const terminate = [...view.querySelectorAll("button")].find(
      (item) => item.textContent?.trim() === "终止",
    );
    expect(terminate).toBeUndefined();
  });
});

describe("SubagentRunCard stale and frozen views", () => {
  it("stale 卡片显示不可恢复文案、冻结计时、禁用终止并抑制无活动提醒", async () => {
    const spies = createSpies();
    const run: SubagentRunView = { ...RUN, stale: true, staleAt: 5_000 };
    const view = await mount(
      createElement(Harness, { run, now: 600_000, spies }),
    );

    expect(view.textContent).toContain("状态不可恢复 · Host 已重启，结果未确认");
    expect(view.textContent).toContain("最后状态：正在执行工具");
    expect(statusRegion(view).textContent).toBe("状态不可恢复 · Host 已重启，结果未确认");
    expect(statusRegion(view).classList.contains("subagent-run-sr-only")).toBe(true);
    expect(view.textContent).toContain("00:05");
    expect(view.textContent).not.toContain("没有新活动");
    expect(view.querySelector(".subagent-run-alert")).toBeNull();
    expect(buttonByText(view, "终止").disabled).toBe(true);
    expect(view.querySelector(".subagent-run-card")?.getAttribute("data-stale")).toBe("true");

    await click(buttonByText(view, "终止"));
    expect(spies.onRequestCancel).not.toHaveBeenCalled();
  });

  it("frozen 卡片追加滞后说明、冻结计时、禁用终止并抑制无活动提醒", async () => {
    const spies = createSpies();
    const view = await mount(
      createElement(Harness, { run: RUN, now: 600_000, spies, frozenAt: 4_000 }),
    );

    expect(view.textContent).toContain("连接中断，状态可能滞后");
    expect(statusRegion(view).textContent).toBe("正在执行工具 · read_file");
    expect(statusRegion(view).classList.contains("subagent-run-sr-only")).toBe(true);
    expect(view.textContent).toContain("00:04");
    expect(view.textContent).not.toContain("没有新活动");
    expect(buttonByText(view, "终止").disabled).toBe(true);
    expect(view.querySelector(".subagent-run-card")?.getAttribute("data-frozen")).toBe("true");

    await click(buttonByText(view, "终止"));
    expect(spies.onRequestCancel).not.toHaveBeenCalled();
  });
});

describe("SubagentRunCard confirmation lifecycle", () => {
  it("确认前 run 变终态：只关闭确认，零取消请求", async () => {
    const spies = createSpies();
    const view = await mount(createElement(Harness, { run: RUN, now: 13_000, spies }));

    await click(buttonByText(view, "终止"));
    expect(document.activeElement?.textContent).toBe("取消");

    await rerender(
      createElement(Harness, {
        run: { ...RUN, phase: "completed", stopReason: "completed", endedAt: 14_000 },
        now: 14_000,
        spies,
      }),
    );

    expect(spies.onDismissCancel).toHaveBeenCalledWith("run-1");
    expect(spies.onConfirmCancel).not.toHaveBeenCalled();
    expect(view.textContent).not.toContain("确认终止");
    expect(view.querySelector(".subagent-run-compact")).not.toBeNull();

    // 自动关闭只发生一次。
    await rerender(
      createElement(Harness, {
        run: { ...RUN, phase: "completed", stopReason: "completed", endedAt: 14_000, revision: 2 },
        now: 15_000,
        spies,
      }),
    );
    expect(spies.onDismissCancel).toHaveBeenCalledTimes(1);
  });

  it("确认前 run 变 stale：只关闭确认，零取消请求", async () => {
    const spies = createSpies();
    const view = await mount(createElement(Harness, { run: RUN, now: 13_000, spies }));

    await click(buttonByText(view, "终止"));
    await rerender(
      createElement(Harness, {
        run: { ...RUN, stale: true, staleAt: 14_000 },
        now: 14_000,
        spies,
      }),
    );

    expect(spies.onDismissCancel).toHaveBeenCalledWith("run-1");
    expect(spies.onConfirmCancel).not.toHaveBeenCalled();
    expect(view.textContent).not.toContain("确认终止");
  });
});

describe("SubagentRunCard alert priority", () => {
  it("活跃卡默认只显示第一条提醒，展开后显示全部", async () => {
    const spies = createSpies();
    const run: SubagentRunView = {
      ...RUN,
      phase: "stopping",
      stopRequestedAt: 0,
      cleanupWarnings: [{ code: "unknown-warning", severity: "info" }],
    };
    const view = await mount(createElement(Harness, { run, now: 62_000, spies }));

    let alerts = [...view.querySelectorAll(".subagent-run-alert")].map(
      (item) => item.textContent,
    );
    expect(alerts).toEqual(["清理状态需要关注"]);

    await click(buttonByLabel(view, "展开 @代码审查 详情"));

    alerts = [...view.querySelectorAll(".subagent-run-alert")].map((item) => item.textContent);
    expect(alerts).toHaveLength(2);
    expect(alerts).toContain("清理状态需要关注");
    expect(alerts.some((text) => text?.includes("停止已受理超过 1 分钟"))).toBe(true);
  });
});

/** 按花括号配对从 styles.css 抠出 reduce 媒体块原文（含最外层花括号）；块内没有字符串，裸计数即可。 */
function reducedMotionBlock(source: string): string {
  const marker = "@media (prefers-reduced-motion: reduce) {";
  const start = source.indexOf(marker);
  if (start < 0) return "";
  let depth = 0;
  for (let index = start + marker.length - 1; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  return "";
}

describe("SubagentRunCard styles contract", () => {
  const css = readFileSync(
    resolve(import.meta.dirname, "../../src/client-huaanwork/styles.css"),
    "utf8",
  );
  const start = css.indexOf("/* ---- 子代理运行卡");
  const section = start >= 0 ? css.slice(start) : "";

  it("新增运行卡选择器全部存在", () => {
    expect(start).toBeGreaterThanOrEqual(0);
    for (const selector of [
      ".subagent-run-card",
      ".subagent-run-header",
      ".subagent-run-status",
      ".subagent-run-status-text",
      ".subagent-run-sr-only",
      ".subagent-run-meta",
      ".subagent-run-compact",
      ".subagent-run-alert",
      ".subagent-run-terminate",
      ".subagent-run-tools",
    ]) {
      expect(section).toContain(selector);
    }
  });

  it("读屏专用状态区用标准视觉隐藏写法，不作为可见布局成员", () => {
    expect(section).toContain("position: absolute");
    expect(section).toContain("width: 1px");
    expect(section).toContain("height: 1px");
    expect(section).toContain("clip: rect(0, 0, 0, 0)");
    expect(section).toContain("white-space: nowrap");
  });

  it("命中区、最小宽度与 reduced-motion 落地", () => {
    expect(section).toContain("min-height: 44px");
    expect(section).toContain("min-width: 44px");
    expect(section).toContain("min-width: 280px");
    expect(section).toContain("prefers-reduced-motion: reduce");
    expect(section).toContain("animation: tool-pulse 1.4s ease-in-out infinite");
  });

  it("脉冲只属于活跃相位，收尾/失效/断连保持静止", () => {
    for (const phase of ["starting", "reasoning", "generating", "tool"]) {
      expect(section).toContain(`[data-phase="${phase}"] .subagent-run-dot`);
    }
    expect(section).toContain('[data-phase="finalizing"] .subagent-run-dot');
    expect(section).toContain('[data-phase="stopping"] .subagent-run-dot');
    expect(section).toContain('[data-stale="true"] .subagent-run-dot');
    expect(section).toContain('[data-frozen="true"] .subagent-run-dot');
  });

  it("reduced-motion 圆点复位按相位限定，才能压过相位脉冲规则", () => {
    const block = reducedMotionBlock(css);
    expect(block).not.toBe("");
    // 相位脉冲规则 = 类 + 属性 + 类；复位规则必须同权重且位于文件更后处，否则活跃相位仍会脉冲。
    expect(block).toMatch(
      /\.subagent-run-card\[data-phase\]\s+\.subagent-run-dot\s*\{[^}]*animation:\s*none\s*;/,
    );
    expect(block).not.toContain(".subagent-run-card .subagent-run-dot");
    expect(css.indexOf('[data-phase="tool"] .subagent-run-dot')).toBeLessThan(
      css.indexOf("@media (prefers-reduced-motion: reduce)"),
    );
  });

  it("运行卡区只引用既有 token：无裸 hex、无 12px 字阶外尺寸、无琥珀", () => {
    expect(section).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(section).not.toContain("12px");
    expect(section).not.toContain("--approval");
    expect(section).toContain("--text-muted");
    expect(section).toContain("--error");
  });
});
