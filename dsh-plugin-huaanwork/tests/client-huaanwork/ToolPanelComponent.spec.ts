// @vitest-environment jsdom
import { act, createElement, useState } from "react";
import type { ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ToolPanel from "../../src/client-huaanwork/ToolPanel.tsx";
import {
  projectToolPanels,
  type PanelToggle,
  type ToolPanelCard,
  type ToolPanelItem,
  type ToolPanelView,
} from "../../src/client-huaanwork/logic/toolPanel.ts";

const START_READ: ToolPanelCard = { key: "read", name: "read", status: "start" };
const START_GREP: ToolPanelCard = { key: "grep", name: "grep", status: "start" };

function panelFor(cards: readonly ToolPanelCard[], panelToggled: PanelToggle | null = null): ToolPanelView {
  const items: ToolPanelItem[] = [
    { id: 1, kind: "user" },
    ...cards.map((card, index) => ({ id: index + 2, kind: "tool" as const, card })),
  ];
  if (panelToggled && items[1]?.kind === "tool") items[1] = { ...items[1], panelToggled };
  const rows = projectToolPanels(items, {
    contentItems: items,
    connectionLost: false,
    turnFinalByUserId: panelToggled ? { 1: true } : undefined,
  });
  const row = rows[1];
  if (row?.kind !== "panel") throw new Error("expected one panel");
  return row.panel;
}

function Harness(): ReactElement {
  const [toggle, setToggle] = useState<PanelToggle | null>(null);
  return createElement(ToolPanel, {
    panel: panelFor([START_READ, START_GREP], toggle),
    onToggle: (_anchorId: number, next: PanelToggle) => setToggle(next),
  });
}

const DETAIL_CARDS: readonly ToolPanelCard[] = [
  START_READ,
  { key: "empty", name: "read", status: "end", hasResult: true, output: "" },
  { key: "missing", name: "read", status: "end", hasResult: false, resultMissing: true },
  { key: "failed", name: "bash", status: "end", hasResult: true, output: "bad", isError: true },
  { key: "truncated", name: "read", status: "end", hasResult: true, output: "<img src=x onerror=alert(1)>", truncated: true },
  { key: "interrupted", name: "bash", status: "start", interrupted: true },
  { key: "unconfirmed", name: "read", status: "start", unconfirmed: true },
];

function StaticPanelHarness(): ReactElement {
  return createElement(ToolPanel, { panel: panelFor(DETAIL_CARDS), onToggle: () => undefined });
}

function TransitionHarness({ status, count = 1 }: { status: "running" | "done"; count?: number }): ReactElement {
  const card: ToolPanelCard = status === "running"
    ? START_READ
    : { key: "done", name: "read", status: "end", hasResult: true, output: "ok" };
  const cards = Array.from({ length: count }, (_, index) => ({ ...card, key: `${card.key}-${index}` }));
  return createElement(ToolPanel, { panel: panelFor(cards), onToggle: () => undefined });
}

let root: Root | undefined;
let container: HTMLDivElement | undefined;

async function mount(element: ReactElement): Promise<HTMLDivElement> {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => { root!.render(element); });
  return container;
}

async function rerender(element: ReactElement): Promise<void> {
  await act(async () => { root!.render(element); });
}

async function click(button: HTMLButtonElement): Promise<void> {
  await act(async () => { button.click(); });
}

function buttonByClass(view: ParentNode, className: string): HTMLButtonElement {
  const button = view.querySelector<HTMLButtonElement>(`button.${className}`);
  if (!button) throw new Error(`button not found: ${className}`);
  return button;
}

function statusRegion(view: ParentNode): HTMLElement {
  const region = view.querySelector<HTMLElement>('[role="status"]');
  if (!region) throw new Error("status region not found");
  return region;
}

/** `aria-controls` 指向的 id 必须在当前 DOM 里存在；收起态不应留下悬空引用。 */
function unresolvedControls(view: ParentNode): string[] {
  const ids = new Set(Array.from(view.querySelectorAll<HTMLElement>("[id]"), (element) => element.id));
  return Array.from(view.querySelectorAll<HTMLElement>("[aria-controls]"))
    .map((element) => element.getAttribute("aria-controls") ?? "")
    .filter((id) => id === "" || !ids.has(id));
}

afterEach(async () => {
  await act(async () => { root?.unmount(); });
  root = undefined;
  container?.remove();
  container = undefined;
  vi.unstubAllGlobals();
});

it("toggles the controlled panel and independently expands multiple tool details", async () => {
  const view = await mount(createElement(Harness));
  const title = buttonByClass(view, "tool-panel-title");
  expect(title.getAttribute("aria-expanded")).toBe("true");
  title.focus();
  expect(document.activeElement).toBe(title);
  await click(title); // 原生 button 的 click 与 Enter/Space 共用 activation behavior；真机任务另走实际键盘。
  expect(buttonByClass(view, "tool-panel-title").getAttribute("aria-expanded")).toBe("false");
  await click(buttonByClass(view, "tool-panel-title"));
  const entries = view.querySelectorAll<HTMLButtonElement>(".tool-panel-entry-title");
  expect(entries).toHaveLength(2);
  await click(entries[0]!);
  await click(entries[1]!);
  expect(entries[0]?.getAttribute("aria-expanded")).toBe("true");
  expect(entries[1]?.getAttribute("aria-expanded")).toBe("true");
  expect(view.querySelectorAll(".tool-panel-detail")).toHaveLength(2);
  expect(view.textContent).toContain("未记录参数");
});

it("never points aria-controls at an element that is not rendered", async () => {
  const view = await mount(createElement(Harness));
  const title = () => buttonByClass(view, "tool-panel-title");
  const entries = () => Array.from(view.querySelectorAll<HTMLButtonElement>(".tool-panel-entry-title"));
  expect(title().getAttribute("aria-controls")).toBe("tool-panel-body-2");
  expect(entries().map((entry) => entry.getAttribute("aria-controls"))).toEqual([null, null]);
  expect(unresolvedControls(view)).toEqual([]);
  await click(title()); // 收起：面板体已移除，标题不再指向它
  expect(title().getAttribute("aria-controls")).toBeNull();
  expect(unresolvedControls(view)).toEqual([]);
  await click(title());
  await click(entries()[0]!);
  expect(entries()[0]?.getAttribute("aria-controls")).toBe("tool-detail-2-2");
  expect(entries()[1]?.getAttribute("aria-controls")).toBeNull();
  expect(unresolvedControls(view)).toEqual([]);
});

it("renders waiting, empty, missing, failed, truncated, interrupted and unconfirmed results as plain text", async () => {
  const view = await mount(createElement(StaticPanelHarness));
  for (const entry of view.querySelectorAll<HTMLButtonElement>(".tool-panel-entry-title")) await click(entry);
  expect(view.textContent).toContain("等待执行结果");
  expect(view.textContent).toContain("无输出");
  expect(view.textContent).toContain("历史记录未保存结果");
  expect(view.textContent).toContain("失败");
  expect(view.textContent).toContain("已截断");
  expect(view.textContent).toContain("已中断");
  expect(view.textContent).toContain("状态未确认");
  expect(view.textContent).toContain("<img src=x onerror=alert(1)>");
  expect(view.querySelector("img")).toBeNull();
  expect(view.querySelector("script")).toBeNull();
});

it("keeps one status region and announces only title transitions", async () => {
  const view = await mount(createElement(TransitionHarness, { status: "running" }));
  const region = statusRegion(view);
  expect(region.textContent).toBe("");
  await rerender(createElement(TransitionHarness, { status: "running" }));
  expect(statusRegion(view)).toBe(region);
  expect(region.textContent).toBe("");
  await rerender(createElement(TransitionHarness, { status: "done" }));
  expect(statusRegion(view)).toBe(region);
  expect(region.textContent).toBe("工具 · 已完成 · 1 项调用");
  await rerender(createElement(TransitionHarness, { status: "done" }));
  expect(region.textContent).toBe("工具 · 已完成 · 1 项调用");
  await rerender(createElement(TransitionHarness, { status: "done", count: 2 }));
  expect(buttonByClass(view, "tool-panel-title").textContent).toBe("工具 · 已完成 · 2 项调用");
  expect(region.textContent, "a count-only change is not a new status announcement").toBe("工具 · 已完成 · 1 项调用");
});

it("caps long content inside a scrollable tokenized panel body", () => {
  const css = readFileSync(resolve(import.meta.dirname, "../../src/client-huaanwork/styles.css"), "utf8");
  const section = css.split("/* ---- 工具面板 ---- */")[1]?.split("/* ----")[0] ?? "";
  expect(section).toContain(".tool-panel-body");
  expect(section).toContain("max-height: 40vh");
  expect(section).toContain("overflow: auto");
  expect(section).toContain("white-space: pre-wrap");
  expect(section).toContain("overflow-wrap: anywhere");
  expect(section).toContain(".tool-panel-entry-title:focus-visible");
  expect(section).not.toMatch(/#[0-9a-f]{3,8}\b/i);
});
