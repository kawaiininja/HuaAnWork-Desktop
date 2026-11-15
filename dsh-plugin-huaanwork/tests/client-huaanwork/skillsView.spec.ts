// @vitest-environment jsdom
/**
 * 技能页组件级 jsdom spec(Task 9/11):两标签默认态、系统技能与下载状态按钮、
 * 迁移警告展示、我的技能徽标/启停/上传入口与空态指路。
 * 形态承 agent-packages-panel.spec.ts 的 createRoot + act;`rpcCall` 经 vi.mock 拦截。
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/client-huaanwork/api.ts", () => ({
  rpcCall: vi.fn(),
  pickDirectory: vi.fn(),
}));

import { rpcCall, pickDirectory } from "../../src/client-huaanwork/api.ts";
import SkillsView from "../../src/client-huaanwork/SkillsView.tsx";
import type { CenterSkillInfo, LocalSkillInfo } from "../../src/client-huaanwork/rpc-types.ts";

const rpc = vi.mocked(rpcCall);
const pick = vi.mocked(pickDirectory);

let root: Root | undefined;
let container: HTMLDivElement | undefined;

const CENTER: CenterSkillInfo[] = [
  { name: "explore", description: "探索", source: "bundled", downloadState: "not-applicable" },
  { name: "pdf", description: "PDF 处理", source: "bundled", downloadState: "available" },
  {
    name: "shared",
    description: "共享技能",
    source: "catalog",
    revision: 2,
    publisher: "alice",
    digest: "sha256:" + "a".repeat(64),
    updatedAt: "2026-11-14T00:00:00.000Z",
    downloadState: "downloaded",
  },
];

const LOCAL: LocalSkillInfo = {
  name: "demo",
  description: "本地演示",
  source: "user",
  enabled: false,
  origin: { kind: "created" },
  contentDigest: "sha256:" + "b".repeat(64),
  publishState: "not-published",
};

const WARNING = "迁移警告：内置技能 pdf 的同名本地副本已启用";

function flush(turns = 6): Promise<void> {
  return (async () => {
    for (let index = 0; index < turns; index += 1) {
      await act(async () => {
        await Promise.resolve();
      });
    }
  })();
}

async function mount(options: { mine: LocalSkillInfo[]; warning?: string } = { mine: [LOCAL] }): Promise<HTMLDivElement> {
  rpc.mockImplementation((async (method: string) => {
    if (method === "skill.centerList") {
      return {
        skills: CENTER,
        ...(options.warning === undefined ? {} : { migrationWarnings: [options.warning] }),
      };
    }
    if (method === "skill.mineList") return { skills: options.mine };
    throw new Error(`unexpected rpc ${method}`);
  }) as never);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(createElement(SkillsView));
  });
  await flush();
  return container;
}

function buttonByText(view: HTMLElement, text: string): HTMLButtonElement | undefined {
  return [...view.querySelectorAll("button")].find((button) => button.textContent?.trim() === text);
}

function buttonByLabel(view: HTMLElement, label: string): HTMLButtonElement | undefined {
  return view.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`) ?? undefined;
}

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  root = undefined;
  container = undefined;
  rpc.mockReset();
});

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

describe("SkillsView", () => {
  it("defaults to the center tab and renders system/download states plus the migration warning", async () => {
    const view = await mount({ mine: [LOCAL], warning: WARNING });
    expect(buttonByText(view, "技能中心")?.className).toContain("on");
    expect(buttonByText(view, "我的技能")).toBeDefined();
    // 系统技能:只显示“系统技能·始终启用”,没有下载按钮。
    expect(view.textContent).toContain("系统技能·始终启用");
    expect(buttonByLabel(view, "下载技能 explore")).toBeUndefined();
    // 可下载 vs 已下载(禁用)按 downloadState 渲染。
    expect(buttonByLabel(view, "下载技能 pdf")?.disabled).toBe(false);
    expect(buttonByLabel(view, "已下载技能 shared")?.disabled).toBe(true);
    // 共享卡展示发布者/revision。
    expect(view.textContent).toContain("alice");
    expect(view.textContent).toContain("revision 2");
    // 迁移警告渲染在中心页。
    expect(view.textContent).toContain(WARNING);
  });

  it("switches to my skills with the origin badge, enable toggle and upload entry", async () => {
    const view = await mount();
    await act(async () => {
      buttonByText(view, "我的技能")?.click();
    });
    await flush();
    expect(view.textContent).toContain("创建");
    expect(buttonByLabel(view, "启用技能 demo")).toBeDefined();
    expect(buttonByLabel(view, "上传技能 demo")).toBeDefined();
    // 中心专属动作不在我的技能里。
    expect(buttonByText(view, "刷新")).toBeUndefined();
  });

  it("guides create and import when my skills is empty", async () => {
    const view = await mount({ mine: [] });
    await act(async () => {
      buttonByText(view, "我的技能")?.click();
    });
    await flush();
    expect(view.textContent).toContain("还没有创建过技能");
    expect(view.textContent).toContain("导入技能");
  });
});

function dialogOf(view: HTMLElement): HTMLElement {
  return view.querySelector<HTMLElement>('[role="dialog"]')!;
}

async function clickText(scope: HTMLElement, text: string): Promise<void> {
  await act(async () => {
    buttonByText(scope, text)?.click();
  });
  await flush();
}

async function fillInput(input: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await flush();
}

async function openMine(view: HTMLElement): Promise<void> {
  await clickText(view, "我的技能");
}

describe("SkillsView 弹窗错误透传与防重入(评审 Important 3 / Minor 4)", () => {
  it("删除失败时错误显示在弹窗内且弹窗不关闭", async () => {
    const view = await mount();
    await openMine(view);
    await clickText(view, "删除");
    expect(dialogOf(view)).toBeTruthy();
    rpc.mockImplementation((async (method: string) => {
      if (method === "skill.remove") throw new Error("删除失败：磁盘只读");
      throw new Error(`unexpected rpc ${method}`);
    }) as never);
    await clickText(dialogOf(view), "删除");
    expect(view.querySelector('[role="dialog"]')).toBeTruthy();
    expect(dialogOf(view).textContent).toContain("删除失败：磁盘只读");
  });

  it("另存为失败时错误显示在弹窗内且弹窗不关闭", async () => {
    const view = await mount({ mine: [{ ...LOCAL, name: "pdf" }] });
    await openMine(view);
    await clickText(view, "另存为新技能");
    const dialog = dialogOf(view);
    await fillInput(dialog.querySelector<HTMLInputElement>("input")!, "pdf-copy");
    rpc.mockImplementation((async (method: string) => {
      if (method === "skill.duplicate") throw new Error("另存为失败：名称冲突");
      throw new Error(`unexpected rpc ${method}`);
    }) as never);
    await clickText(dialog, "复制");
    expect(view.querySelector('[role="dialog"]')).toBeTruthy();
    expect(dialogOf(view).textContent).toContain("另存为失败：名称冲突");
  });

  it("确认导入失败时错误显示在弹窗内且弹窗不关闭", async () => {
    pick.mockResolvedValue("/tmp/imp-dir" as never);
    const view = await mount();
    await openMine(view);
    rpc.mockImplementation((async (method: string) => {
      if (method === "skill.importPreview") {
        return {
          ok: true,
          preview: {
            name: "imp", description: "导入技能", source: "user", content: "正文",
            targetName: "imp", sourceName: "imp-dir", nameMismatch: false, kind: "directory",
          },
        };
      }
      if (method === "skill.import") throw new Error("导入失败：目录含硬链接");
      throw new Error(`unexpected rpc ${method}`);
    }) as never);
    await clickText(view, "导入技能");
    await clickText(dialogOf(view), "选择目录");
    expect(dialogOf(view).getAttribute("aria-label")).toBe("确认导入技能");
    await clickText(dialogOf(view), "确认导入");
    expect(view.querySelector('[role="dialog"]')).toBeTruthy();
    expect(dialogOf(view).textContent).toContain("导入失败：目录含硬链接");
  });

  it("确认导入在途时确认按钮禁用防重入", async () => {
    pick.mockResolvedValue("/tmp/imp-dir" as never);
    const view = await mount();
    await openMine(view);
    rpc.mockImplementation((async (method: string) => {
      if (method === "skill.importPreview") {
        return {
          ok: true,
          preview: {
            name: "imp", description: "导入技能", source: "user", content: "正文",
            targetName: "imp", sourceName: "imp-dir", nameMismatch: false, kind: "directory",
          },
        };
      }
      if (method === "skill.import") return new Promise(() => {});
      throw new Error(`unexpected rpc ${method}`);
    }) as never);
    await clickText(view, "导入技能");
    await clickText(dialogOf(view), "选择目录");
    await clickText(dialogOf(view), "确认导入");
    expect(buttonByText(dialogOf(view), "确认导入")?.disabled).toBe(true);
  });

  it("编辑已启用技能保存后提示不再要求启用(评审 Minor 4)", async () => {
    const view = await mount({ mine: [{ ...LOCAL, enabled: true }] });
    await openMine(view);
    rpc.mockImplementation((async (method: string) => {
      if (method === "skill.get") {
        return { skill: { name: "demo", description: "本地演示", source: "user", content: "正文" } };
      }
      if (method === "skill.update") return { ok: true, skill: { ...LOCAL, enabled: true } };
      if (method === "skill.mineList") return { skills: [{ ...LOCAL, enabled: true }] };
      throw new Error(`unexpected rpc ${method}`);
    }) as never);
    await clickText(view, "编辑");
    await clickText(dialogOf(view), "保存");
    expect(view.textContent).toContain("已保存技能 demo");
    expect(view.textContent).not.toContain("请在“我的技能”中启用");
  });
});
