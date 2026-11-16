// @vitest-environment jsdom
/**
 * 对话创建技能的确认卡（Task 6）：只呈现草稿的四项内容并收集三个用户动作。
 * 写入正式技能仍由会话里的固定同意句触发，卡片本身不调用 skill.create。
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import SkillConfirmCard from "../../src/client-huaanwork/SkillConfirmCard.tsx";
import type { SkillConfirmCard as SkillConfirmCardData } from "../../src/client-huaanwork/rpc-types.ts";

const CARD: SkillConfirmCardData = {
  name: "daily-summary",
  description: "生成日报",
  whenToUse: "需要日报时",
  contentPreview: "整理输入并生成日报",
};

let root: Root | undefined;
let container: HTMLDivElement | undefined;

async function mount(card: SkillConfirmCardData = CARD, disabled = false) {
  const handlers = { onConsent: vi.fn(), onRevise: vi.fn(), onCancel: vi.fn() };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(createElement(SkillConfirmCard, { card, disabled, ...handlers }));
  });
  return { view: container, ...handlers };
}

function buttonByText(view: HTMLElement, text: string): HTMLButtonElement | undefined {
  return [...view.querySelectorAll("button")].find((button) => button.textContent === text);
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  root = undefined;
  container?.remove();
  container = undefined;
  vi.unstubAllGlobals();
});

describe("SkillConfirmCard", () => {
  it("shows the proposed name, description, trigger and content preview", async () => {
    const { view } = await mount();

    expect(view.textContent).toContain("daily-summary");
    expect(view.textContent).toContain("生成日报");
    expect(view.textContent).toContain("需要日报时");
    expect(view.textContent).toContain("整理输入并生成日报");
  });

  it("sends the exact consent phrase through the normal conversation path", async () => {
    const { view, onConsent, onRevise, onCancel } = await mount();
    const button = buttonByText(view, "确认创建");
    await act(async () => {
      button?.click();
    });

    expect(onConsent).toHaveBeenCalledTimes(1);
    expect(onRevise).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("keeps revise and cancel as separate actions", async () => {
    const { view, onConsent, onRevise, onCancel } = await mount();

    await act(async () => {
      buttonByText(view, "继续修改")?.click();
    });
    expect(onRevise).toHaveBeenCalledTimes(1);
    expect(onConsent).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();

    await act(async () => {
      buttonByText(view, "取消")?.click();
    });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConsent).not.toHaveBeenCalled();
    expect(onRevise).toHaveBeenCalledTimes(1);
  });

  it("omits the trigger row when the draft has no whenToUse", async () => {
    const { view } = await mount({ ...CARD, whenToUse: undefined });

    expect(view.textContent).toContain("daily-summary");
    expect(view.textContent).not.toContain("触发场景");
  });

  it("disables every action once the card is consumed", async () => {
    const { view, onConsent, onRevise, onCancel } = await mount(CARD, true);

    for (const label of ["确认创建", "继续修改", "取消"]) {
      const button = buttonByText(view, label);
      expect(button?.disabled).toBe(true);
      await act(async () => {
        button?.click();
      });
    }
    expect(onConsent).not.toHaveBeenCalled();
    expect(onRevise).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
    expect(view.textContent).toContain("已处理");
  });
});
