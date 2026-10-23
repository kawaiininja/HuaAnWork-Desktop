// @vitest-environment jsdom
/** 结构化创建确认卡（Task 8）：只呈现信息，创建必须由用户在会话里回复同意句触发。 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import AgentConfirmCard from "../../src/client-huaanwork/AgentConfirmCard.tsx";
import type { AgentPackageConfirmCard } from "../../src/client-huaanwork/rpc-types.ts";

const CARD: AgentPackageConfirmCard = {
  displayName: "周报助手",
  slug: "weekly-report",
  description: "每周汇总项目进展",
  personaSummary: "你是周报助手，按项目汇总进展。",
  skillSummary: "汇总本周进展",
  tools: "http",
  toolLabel: "HTTP 工具：汇总接口",
  warning: "脚本在本机沙箱中运行；沙箱只限制写，读取文件和网络不受限制。",
  consentHint: "回复「同意创建」后写入智能体。",
};

let root: Root | undefined;
let container: HTMLDivElement | undefined;

async function mount(): Promise<HTMLDivElement> {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(createElement(AgentConfirmCard, { card: CARD }));
  });
  return container;
}

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  root = undefined;
  container?.remove();
  vi.unstubAllGlobals();
});

describe("AgentConfirmCard", () => {
  it("显示标题与名称/slug/简介/人设/技能/工具六行", async () => {
    const view = await mount();

    expect(view.textContent).toContain("请确认是否创建这名智能体");
    expect(view.textContent).toContain("周报助手");
    expect(view.textContent).toContain("weekly-report");
    expect(view.textContent).toContain("每周汇总项目进展");
    expect(view.textContent).toContain("你是周报助手，按项目汇总进展。");
    expect(view.textContent).toContain("汇总本周进展");
    expect(view.textContent).toContain("HTTP 工具：汇总接口");
  });

  it("底部显示固定 warning 与 consentHint", async () => {
    const view = await mount();

    expect(view.textContent).toContain("脚本在本机沙箱中运行；沙箱只限制写，读取文件和网络不受限制。");
    expect(view.textContent).toContain("回复「同意创建」后写入智能体。");
  });

  it("没有可点击的创建按钮：创建只由用户在会话里回复同意句触发", async () => {
    const view = await mount();

    expect(view.querySelectorAll("button")).toHaveLength(0);
  });
});
