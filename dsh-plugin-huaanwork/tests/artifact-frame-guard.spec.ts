/**
 * Artifact frame 原生导航防护：按唯一空直属子 frame 的 frameTreeNodeId 登记，
 * 仅放行一次 about:srcdoc 引导，随后拒绝该 frame 及其后代的全部文档导航。
 *
 * 事件形状与 Electron `will-frame-navigate` 一致（frame/initiator 可为 null，
 * preventDefault 影响同一事件对象）；未登记的其他 frame 与主页面导航不受影响。
 */
import { EventEmitter } from "node:events";
import type { WebContents } from "electron";
import { describe, expect, it } from "vitest";

import { installArtifactFrameGuard } from "../src/artifact-frame-guard.ts";

const FRAME_NAME = "huaanwork-artifact-11111111-1111-4111-8111-111111111111";

interface FakeFrame {
  frameTreeNodeId: number;
  name: string;
  url: string;
  detached: boolean;
  parent: FakeFrame | null;
}

class FakeWebContents extends EventEmitter {
  readonly mainFrame: FakeFrame & { framesInSubtree: FakeFrame[] };

  constructor() {
    super();
    const main: FakeFrame & { framesInSubtree: FakeFrame[] } = {
      frameTreeNodeId: 1,
      name: "",
      url: "https://app.huaanwork.local/",
      detached: false,
      parent: null,
      framesInSubtree: [],
    };
    main.framesInSubtree = [main];
    this.mainFrame = main;
  }
}

interface Renderer {
  contents: FakeWebContents;
  main: FakeFrame;
  addFrame(options: { name: string; url: string; parent?: FakeFrame }): FakeFrame;
  removeFrame(frame: FakeFrame): void;
  navigate(
    frame: FakeFrame | null,
    url: string,
    initiator?: FakeFrame | null,
  ): { url: string; frame: FakeFrame | null; defaultPrevented: boolean; preventDefault(): void };
}

function createRenderer(): Renderer {
  const contents = new FakeWebContents();
  let nextId = 10;
  return {
    contents,
    main: contents.mainFrame,
    addFrame({ name, url, parent }) {
      const frame: FakeFrame = {
        frameTreeNodeId: nextId++,
        name,
        url,
        detached: false,
        parent: parent ?? contents.mainFrame,
      };
      contents.mainFrame.framesInSubtree.push(frame);
      return frame;
    },
    removeFrame(frame) {
      frame.detached = true;
      contents.mainFrame.framesInSubtree = contents.mainFrame.framesInSubtree.filter(
        (item) => item !== frame,
      );
    },
    navigate(frame, url, initiator) {
      const event = {
        url,
        isSameDocument: false,
        isMainFrame: frame === null || frame === contents.mainFrame,
        frame,
        initiator: initiator === undefined ? frame : initiator,
        defaultPrevented: false,
        preventDefault() {
          this.defaultPrevented = true;
        },
      };
      contents.emit("will-frame-navigate", event);
      return event;
    },
  };
}

function guardFor(renderer: Renderer) {
  return installArtifactFrameGuard(renderer.contents as unknown as WebContents);
}

describe("installArtifactFrameGuard", () => {
  it("registers the unique live direct empty child frame and allows one srcdoc bootstrap", () => {
    const renderer = createRenderer();
    const guard = guardFor(renderer);
    const frame = renderer.addFrame({ name: FRAME_NAME, url: "about:blank" });

    guard.registerEmptyFrame(FRAME_NAME);
    expect(renderer.navigate(frame, "about:srcdoc").defaultPrevented).toBe(false);
    expect(renderer.navigate(frame, "about:srcdoc").defaultPrevented).toBe(true);
    expect(renderer.navigate(frame, "https://example.com/self").defaultPrevented).toBe(true);
    guard.dispose();
  });

  it("accepts an empty frame whose url has not settled yet", () => {
    const renderer = createRenderer();
    const guard = guardFor(renderer);
    const frame = renderer.addFrame({ name: FRAME_NAME, url: "" });

    guard.registerEmptyFrame(FRAME_NAME);
    expect(renderer.navigate(frame, "about:srcdoc").defaultPrevented).toBe(false);
    guard.dispose();
  });

  it("rejects a frame that already carries content", () => {
    const renderer = createRenderer();
    const guard = guardFor(renderer);
    renderer.addFrame({ name: FRAME_NAME, url: "https://example.com/loaded" });

    expect(() => guard.registerEmptyFrame(FRAME_NAME)).toThrow("artifact-frame-unavailable");
    guard.dispose();
  });

  it("rejects duplicate frames with the same name", () => {
    const renderer = createRenderer();
    const guard = guardFor(renderer);
    renderer.addFrame({ name: FRAME_NAME, url: "about:blank" });
    renderer.addFrame({ name: FRAME_NAME, url: "about:blank" });

    expect(() => guard.registerEmptyFrame(FRAME_NAME)).toThrow("artifact-frame-unavailable");
    guard.dispose();
  });

  it("rejects detached, non-direct and missing frames", () => {
    const renderer = createRenderer();
    const guard = guardFor(renderer);
    const detached = renderer.addFrame({ name: FRAME_NAME, url: "about:blank" });
    renderer.removeFrame(detached);
    expect(() => guard.registerEmptyFrame(FRAME_NAME)).toThrow("artifact-frame-unavailable");

    const parent = renderer.addFrame({ name: "nested-parent", url: "about:blank" });
    renderer.addFrame({ name: FRAME_NAME, url: "about:blank", parent });
    expect(() => guard.registerEmptyFrame(FRAME_NAME)).toThrow("artifact-frame-unavailable");

    expect(() => guard.registerEmptyFrame("huaanwork-artifact-missing")).toThrow(
      "artifact-frame-unavailable",
    );
    guard.dispose();
  });

  it("keeps blocking after the content renames its own frame", () => {
    const renderer = createRenderer();
    const guard = guardFor(renderer);
    const frame = renderer.addFrame({ name: FRAME_NAME, url: "about:blank" });
    guard.registerEmptyFrame(FRAME_NAME);
    expect(renderer.navigate(frame, "about:srcdoc").defaultPrevented).toBe(false);

    frame.name = "renamed-by-content";
    expect(renderer.navigate(frame, "https://example.com/renamed").defaultPrevented).toBe(true);
    guard.dispose();
  });

  it("blocks link, meta refresh and redirect-entry navigations of the guarded frame", () => {
    const renderer = createRenderer();
    const guard = guardFor(renderer);
    const frame = renderer.addFrame({ name: FRAME_NAME, url: "about:blank" });
    guard.registerEmptyFrame(FRAME_NAME);
    expect(renderer.navigate(frame, "about:srcdoc").defaultPrevented).toBe(false);

    expect(renderer.navigate(frame, "https://example.com/link").defaultPrevented).toBe(true);
    expect(renderer.navigate(frame, "https://example.com/meta").defaultPrevented).toBe(true);
    expect(renderer.navigate(frame, "https://example.com/redirect").defaultPrevented).toBe(true);
    guard.dispose();
  });

  it("blocks descendant navigations and navigations initiated by the guarded frame", () => {
    const renderer = createRenderer();
    const guard = guardFor(renderer);
    const frame = renderer.addFrame({ name: FRAME_NAME, url: "about:blank" });
    const child = renderer.addFrame({ name: "", url: "about:blank", parent: frame });
    guard.registerEmptyFrame(FRAME_NAME);
    expect(renderer.navigate(frame, "about:srcdoc").defaultPrevented).toBe(false);

    expect(renderer.navigate(child, "https://example.com/descendant").defaultPrevented).toBe(true);
    expect(
      renderer.navigate(renderer.main, "https://example.com/top", frame).defaultPrevented,
    ).toBe(true);
    guard.dispose();
  });

  it("does not take over unregistered frames or the main page", () => {
    const renderer = createRenderer();
    const guard = guardFor(renderer);
    renderer.addFrame({ name: FRAME_NAME, url: "about:blank" });
    const other = renderer.addFrame({ name: "other-frame", url: "about:blank" });
    guard.registerEmptyFrame(FRAME_NAME);

    expect(renderer.navigate(other, "https://example.com/other").defaultPrevented).toBe(false);
    expect(renderer.navigate(renderer.main, "https://example.com/next").defaultPrevented).toBe(
      false,
    );
    expect(renderer.navigate(null, "https://example.com/null-frame").defaultPrevented).toBe(false);
    guard.dispose();
  });

  it("reclaims dead frame ids on the next registration", () => {
    const renderer = createRenderer();
    const guard = guardFor(renderer);
    const first = renderer.addFrame({ name: FRAME_NAME, url: "about:blank" });
    guard.registerEmptyFrame(FRAME_NAME);
    renderer.removeFrame(first);

    const second = renderer.addFrame({
      name: "huaanwork-artifact-22222222-2222-4222-8222-222222222222",
      url: "about:blank",
    });
    guard.registerEmptyFrame(second.name);

    // frameTreeNodeId 不会真的复用；同号新 frame 不受旧登记影响，证明旧标识已回收。
    const reused = renderer.addFrame({ name: "reused-id", url: "about:blank" });
    reused.frameTreeNodeId = first.frameTreeNodeId;
    expect(renderer.navigate(reused, "https://example.com/reused").defaultPrevented).toBe(false);
    guard.dispose();
  });

  it("dispose removes only its own listener", () => {
    const renderer = createRenderer();
    const otherListener = (): void => undefined;
    renderer.contents.on("will-frame-navigate", otherListener);
    const guard = guardFor(renderer);
    const frame = renderer.addFrame({ name: FRAME_NAME, url: "about:blank" });
    guard.registerEmptyFrame(FRAME_NAME);
    guard.dispose();

    expect(renderer.navigate(frame, "https://example.com/after-dispose").defaultPrevented).toBe(
      false,
    );
    expect(renderer.contents.listenerCount("will-frame-navigate")).toBe(1);
    renderer.contents.off("will-frame-navigate", otherListener);
  });
});
