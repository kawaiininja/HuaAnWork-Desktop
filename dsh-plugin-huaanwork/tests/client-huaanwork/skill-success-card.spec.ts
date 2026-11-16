// @vitest-environment jsdom
/** 技能创建成功卡（Task 6）：展示成功文案，只有点击“前往我的技能”才导航。 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import SkillSuccessCard from "../../src/client-huaanwork/SkillSuccessCard.tsx";

let root: Root | undefined;
let container: HTMLDivElement | undefined;

async function mount(name = "daily-summary", draftId = "draft-1") {
  const onGoToMine = vi.fn();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(createElement(SkillSuccessCard, { name, draftId, onGoToMine }));
  });
  return { view: container, onGoToMine };
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

describe("SkillSuccessCard", () => {
  it("navigates to My Skills only when the success card action is clicked", async () => {
    const { view, onGoToMine } = await mount();
    // 渲染成功卡本身不触发跳转。
    expect(onGoToMine).not.toHaveBeenCalled();
    const button = [...view.querySelectorAll("button")].find((item) => item.textContent === "前往我的技能");
    await act(async () => {
      button?.click();
    });
    expect(onGoToMine).toHaveBeenCalledTimes(1);
  });

  it("shows the saved-skill copy and keeps the draft identity on the card", async () => {
    const { view } = await mount();

    expect(view.textContent).toContain("已保存技能 daily-summary，请在“我的技能”中启用");
    expect(view.querySelector("[data-draft-id]")?.getAttribute("data-draft-id")).toBe("draft-1");
  });
});
