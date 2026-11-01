// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

import { InputCardView } from "../../src/client-huaanwork/App.tsx";
import type { InputCard } from "../../src/client-huaanwork/logic/inputCard.ts";

const CARD: InputCard = {
  question: "技能名称是什么？",
  sessionId: "s1",
  state: "open",
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

it("the question card leaves free-text answering to the composer", async () => {
  const onInput = vi.fn();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);

  await act(async () => {
    root!.render(createElement(InputCardView, { itemId: 7, card: CARD, blocked: false, onInput }));
  });

  expect(container.textContent).toContain("技能名称是什么？");
  expect(container.querySelectorAll("textarea")).toHaveLength(0);
  expect(container.textContent).not.toContain("提交");

  const buttons = Array.from(container.querySelectorAll("button"));
  expect(buttons.map((button) => button.textContent)).toEqual(["取消"]);
  await act(async () => {
    buttons[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  expect(onInput).toHaveBeenCalledWith(7, CARD, { cancel: true });
});
