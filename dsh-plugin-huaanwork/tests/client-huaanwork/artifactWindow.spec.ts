// @vitest-environment jsdom
/**
 * 全屏 Artifact 启动模式与预览栏原生能力接线。
 *
 * 启动目标只来自 `artifactWindowOptions` 写出的 URL:用共享解析函数取回双 ID,再经
 * Task 4 的真实 ROUTE_TABLE 调用器按会话读取。参数不合法时 shell 只渲染错误提示,
 * 不挂载主 App。全屏页与主预览栏对下载/HTML frame 准备各自固定 surface。
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import App from "../../src/client-huaanwork/App.tsx";
import ArtifactFullscreenPage from "../../src/client-huaanwork/ArtifactFullscreenPage.tsx";
import ArtifactPreview from "../../src/client-huaanwork/ArtifactPreview.tsx";
import { rpcCall } from "../../src/client-huaanwork/api.ts";
import { huaanworkRootElement } from "../../src/client-huaanwork/shell.ts";
import type { RpcEvent, TaskArtifactSummary } from "../../src/client-huaanwork/rpc-types.ts";
import { artifactWindowOptions, artifactWindowTargetFromSearch } from "../../src/artifact-window.ts";
import { createArtifact, type ArtifactInput } from "../../src/huaanwork-host/artifacts-host.ts";
import { ROUTE_TABLE, type RouteContext } from "../../src/huaanwork-host/routes.ts";

// App.tsx 还绑定 api.ts 的其他导出，只替换 rpcCall。
vi.mock("../../src/client-huaanwork/api.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/client-huaanwork/api.ts")>();
  return { ...actual, rpcCall: vi.fn() };
});

const rpc = vi.mocked(rpcCall);

// createRoot 的异步渲染只有在 act 环境标记下才会在执行器内刷新 effect。
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

// jsdom 环境下 import.meta.url 不是 file: 方案，静态针按包根目录读取源码。
const sourceFile = (relative: string): string => readFileSync(join(process.cwd(), "src/client-huaanwork", relative), "utf8");

const APP_SOURCE = sourceFile("App.tsx");
const SHELL_SOURCE = sourceFile("shell.ts");
const FULLSCREEN_PAGE_SOURCE = sourceFile("ArtifactFullscreenPage.tsx");

/** 最小 RouteContext 夹具(与 artifact-routes.spec.ts 的同名夹具一致)。 */
function makeRouteCtx(root: string, events: RpcEvent[]): RouteContext {
  return {
    dshHome: join(root, "dsh"),
    profileDir: root,
    workspaceRoot: { current: join(root, "workspace") },
    emit: (event) => events.push(event),
    logger: () => undefined,
    requestRestart: async () => true,
  };
}

/** 真实 ROUTE_TABLE 调用器:GET 参数只经 query 传入,与 webserver 装配一致。 */
async function call<T>(method: string, routeCtx: RouteContext, params: Record<string, string>): Promise<T> {
  const route = ROUTE_TABLE.find((item) => item.method === method);
  if (!route) throw new Error(`missing route ${method}`);
  const result = await route.handler({ params: {}, body: undefined, query: new URLSearchParams(params) }, routeCtx);
  return result as T;
}

function artifactInput(sessionId: string, callId: string, extra: Partial<ArtifactInput> = {}): ArtifactInput {
  return {
    sessionId,
    title: "报告",
    format: "markdown",
    content: "# 正文",
    anchor: { kind: "turn" },
    idempotency: { kind: "tool", callId },
    ...extra,
  };
}

function profileDirFixture(): string {
  return mkdtempSync(join(tmpdir(), "artifact-window-"));
}

function launchTargetOf(summary: TaskArtifactSummary): { sessionId: string; artifactId: string } {
  const options = artifactWindowOptions(
    { url: "http://127.0.0.1:3000/" },
    { sessionId: summary.sessionId, artifactId: summary.artifactId },
    "huaanwork-artifact-test",
  );
  const target = artifactWindowTargetFromSearch(new URL(options.url).search);
  if (!target) throw new Error("launch target missing");
  return target;
}

type Mounted = { container: HTMLDivElement; root: Root };

/** effect 里的两级读取各占一个微任务，用一次宏任务把整条链走完。 */
async function settle(root: Root, element?: ReactElement): Promise<void> {
  await act(async () => {
    if (element) root.render(element);
    await new Promise((done) => setTimeout(done, 0));
  });
}

async function mount(element: ReactElement): Promise<Mounted> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await settle(root, element);
  return { container, root };
}

function summaryFor(sessionId: string, artifactId: string, format: "markdown" | "html" = "markdown"): TaskArtifactSummary {
  return {
    artifactId,
    sessionId,
    title: "结果",
    format,
    anchor: { kind: "turn" },
    createdAt: "2026-11-20T00:00:00.000Z",
    sizeBytes: 8,
    sha256: "0".repeat(64),
    downloadName: format === "markdown" ? "结果.md" : "结果.html",
  };
}

describe("artifact window launch target", () => {
  it("reads the launched artifact through the real routes", async () => {
    const profileDir = profileDirFixture();
    const routeCtx = makeRouteCtx(profileDir, []);
    const summary = await createArtifact(profileDir, artifactInput("session-1", "launch-1"));
    const target = launchTargetOf(summary);

    expect(target).toEqual({ sessionId: "session-1", artifactId: summary.artifactId });
    const got = await call<{ artifact: TaskArtifactSummary }>("artifact.get", routeCtx, target);
    expect(got.artifact.artifactId).toBe(summary.artifactId);
    const body = await call<{ content: string }>("artifact.content", routeCtx, target);
    expect(body.content).toBe("# 正文");
  });

  it("reads another session's artifact after switching the launch target", async () => {
    const profileDir = profileDirFixture();
    const routeCtx = makeRouteCtx(profileDir, []);
    await createArtifact(profileDir, artifactInput("session-1", "switch-1"));
    const second = await createArtifact(
      profileDir,
      artifactInput("session-2", "switch-2", { content: "# 另一会话", title: "另一份" }),
    );
    const target = launchTargetOf(second);

    expect(target).toEqual({ sessionId: "session-2", artifactId: second.artifactId });
    const got = await call<{ artifact: TaskArtifactSummary }>("artifact.get", routeCtx, target);
    expect(got.artifact.title).toBe("另一份");
    const body = await call<{ content: string }>("artifact.content", routeCtx, target);
    expect(body.content).toBe("# 另一会话");
  });

  it("rejects a mismatched session and artifact pair", async () => {
    const profileDir = profileDirFixture();
    const routeCtx = makeRouteCtx(profileDir, []);
    await createArtifact(profileDir, artifactInput("session-1", "mismatch-1"));
    const other = await createArtifact(profileDir, artifactInput("session-2", "mismatch-2"));

    await expect(
      call("artifact.get", routeCtx, { sessionId: "session-1", artifactId: other.artifactId }),
    ).rejects.toThrow("artifact-not-found");
    await expect(
      call("artifact.content", routeCtx, { sessionId: "session-1", artifactId: other.artifactId }),
    ).rejects.toThrow("artifact-not-found");
  });

  it("produces no target for incomplete or unsafe launch parameters", () => {
    expect(artifactWindowTargetFromSearch("?artifactWindow=1&sessionId=session-1")).toBeUndefined();
    expect(artifactWindowTargetFromSearch("?artifactWindow=1&artifactId=artifact-1")).toBeUndefined();
    expect(artifactWindowTargetFromSearch("?sessionId=session-1&artifactId=artifact-1")).toBeUndefined();
    expect(
      artifactWindowTargetFromSearch("?artifactWindow=1&sessionId=../etc&artifactId=artifact-1"),
    ).toBeUndefined();
    expect(
      artifactWindowTargetFromSearch("?artifactWindow=1&sessionId=session-1&artifactId=a/b"),
    ).toBeUndefined();
  });
});

describe("shell launch mode", () => {
  it("mounts the fullscreen page for a valid launch target", () => {
    const search = new URL(
      artifactWindowOptions(
        { url: "http://127.0.0.1:3000/" },
        { sessionId: "session-1", artifactId: "artifact-1" },
        "huaanwork-artifact-test",
      ).url,
    ).search;
    const element = huaanworkRootElement(search);
    expect(element.type).toBe(ArtifactFullscreenPage);
    expect(renderToStaticMarkup(element)).toContain("正在读取结果");
  });

  it("shows a parameter alert without mounting App when the target is invalid", () => {
    const element = huaanworkRootElement("?artifactWindow=1&sessionId=session-1");
    expect(element.type).toBe("div");
    expect(element.type).not.toBe(App);
    expect(renderToStaticMarkup(element)).toContain("结果窗口参数无效");
  });

  it("keeps mounting App for ordinary launches", () => {
    expect(huaanworkRootElement("").type).toBe(App);
  });

  it("pins the shell to the shared parser and root element", () => {
    expect(SHELL_SOURCE).toContain("artifactWindowTargetFromSearch");
    expect(SHELL_SOURCE).toContain("huaanworkRootElement(window.location.search)");
    expect(SHELL_SOURCE).toContain("installHuaanworkStyles()");
  });
});

describe("ArtifactFullscreenPage", () => {
  async function mountPage(target: { sessionId: string; artifactId: string }, summary: TaskArtifactSummary) {
    rpc.mockReset();
    rpc.mockImplementation((async (method: string) => {
      if (method === "artifact.get") return { artifact: summary };
      if (method === "artifact.content") {
        return { artifact: summary, content: summary.format === "html" ? "<p>正文</p>" : "# 正文" };
      }
      if (method === "artifact.download") return { saved: false };
      if (method === "artifact.prepareFrame") return { prepared: true };
      throw new Error(`unexpected method ${method}`);
    }) as typeof rpcCall);
    return mount(createElement(ArtifactFullscreenPage, { target }));
  }

  it("loads by the dual IDs and downloads with the artifact surface", async () => {
    const summary = summaryFor("session-1", "artifact-1");
    const { container, root } = await mountPage({ sessionId: "session-1", artifactId: "artifact-1" }, summary);
    try {
      expect(rpc).toHaveBeenCalledWith("artifact.get", { sessionId: "session-1", artifactId: "artifact-1" });
      expect(rpc).toHaveBeenCalledWith("artifact.content", { sessionId: "session-1", artifactId: "artifact-1" });
      expect(container.textContent).toContain("结果");
      const download = [...container.querySelectorAll("button")].find((button) => button.textContent === "下载");
      expect(download).toBeDefined();
      expect([...container.querySelectorAll("button")].some((button) => button.textContent === "全屏")).toBe(false);
      await act(async () => {
        download!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await new Promise((done) => setTimeout(done, 0));
      });
      expect(rpc).toHaveBeenCalledWith("artifact.download", {
        sessionId: "session-1",
        artifactId: "artifact-1",
        surface: "artifact",
      });
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  it("prepares the HTML frame with the artifact surface", async () => {
    const summary = summaryFor("session-2", "artifact-2", "html");
    const { container, root } = await mountPage({ sessionId: "session-2", artifactId: "artifact-2" }, summary);
    try {
      const frame = container.querySelector("iframe");
      expect(frame).not.toBeNull();
      await act(async () => {
        frame!.dispatchEvent(new Event("load"));
        await new Promise((done) => setTimeout(done, 0));
      });
      expect(rpc).toHaveBeenCalledWith("artifact.prepareFrame", {
        sessionId: "session-2",
        artifactId: "artifact-2",
        surface: "artifact",
        frameName: frame!.name,
      });
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  it("shows the read failure and retries with the same dual IDs", async () => {
    rpc.mockReset();
    rpc.mockRejectedValue(new Error("artifact-not-found"));
    const { container, root } = await mount(
      createElement(ArtifactFullscreenPage, { target: { sessionId: "session-1", artifactId: "artifact-9" } }),
    );
    try {
      const alert = container.querySelector('[role="alert"]');
      expect(alert?.textContent).toContain("artifact-not-found");
      expect(container.textContent).not.toContain("结果尚未读取");
      rpc.mockClear();
      const retry = alert?.querySelector("button");
      expect(retry?.textContent).toBe("重试");
      await act(async () => {
        retry!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await new Promise((done) => setTimeout(done, 0));
      });
      expect(rpc).toHaveBeenCalledWith("artifact.get", { sessionId: "session-1", artifactId: "artifact-9" });
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  it("closes the window from Esc and the visible close button", async () => {
    const close = vi.spyOn(window, "close").mockImplementation(() => undefined);
    const summary = summaryFor("session-1", "artifact-1");
    const { container, root } = await mountPage({ sessionId: "session-1", artifactId: "artifact-1" }, summary);
    try {
      const closeButton = [...container.querySelectorAll("button")].find((button) => button.textContent === "关闭");
      expect(closeButton).toBeDefined();
      await act(async () => {
        closeButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      expect(close).toHaveBeenCalledTimes(1);
      await act(async () => {
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      });
      expect(close).toHaveBeenCalledTimes(2);
    } finally {
      await act(async () => root.unmount());
      container.remove();
      close.mockRestore();
    }
  });

  it("pins the artifact surface and window close to the page source", () => {
    expect(FULLSCREEN_PAGE_SOURCE).toContain('surface: "artifact"');
    expect(FULLSCREEN_PAGE_SOURCE).toContain("window.close()");
    expect(FULLSCREEN_PAGE_SOURCE).not.toContain("artifact.openFullscreen");
  });
});

describe("ArtifactPreview action callbacks", () => {
  const document = { artifact: summaryFor("session-1", "artifact-1"), content: "# 正文" };

  it("renders fullscreen and download buttons only when callbacks are supplied", () => {
    const withActions = renderToStaticMarkup(
      createElement(ArtifactPreview, { artifact: document, onFullscreen: () => undefined, onDownload: () => undefined }),
    );
    expect(withActions).toContain("全屏");
    expect(withActions).toContain("下载");
    const withoutActions = renderToStaticMarkup(createElement(ArtifactPreview, { artifact: document }));
    expect(withoutActions).not.toContain("全屏");
    expect(withoutActions).not.toContain("下载");
  });

  it("invokes the supplied callbacks", async () => {
    const onFullscreen = vi.fn();
    const onDownload = vi.fn();
    const { container, root } = await mount(
      createElement(ArtifactPreview, { artifact: document, onFullscreen, onDownload }),
    );
    try {
      const button = (label: string) =>
        [...container.querySelectorAll("button")].find((item) => item.textContent === label)!;
      await act(async () => {
        button("全屏").dispatchEvent(new MouseEvent("click", { bubbles: true }));
        button("下载").dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      expect(onFullscreen).toHaveBeenCalledTimes(1);
      expect(onDownload).toHaveBeenCalledTimes(1);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});

describe("App preview rail wiring", () => {
  function previewCall(): string {
    const start = APP_SOURCE.indexOf("<ArtifactPreview");
    expect(start).toBeGreaterThan(-1);
    const end = APP_SOURCE.indexOf("/>", start);
    expect(end).toBeGreaterThan(start);
    return APP_SOURCE.slice(start, end);
  }

  it("passes the three native capability callbacks to ArtifactPreview", () => {
    const call = previewCall();
    expect(call).toContain("onFullscreen=");
    expect(call).toContain("onDownload=");
    expect(call).toContain("prepareHtmlFrame=");
    expect(call).toContain("previewArtifactLoaded");
  });

  it("calls the artifact RPCs with the current dual IDs and main surface", () => {
    expect(APP_SOURCE).toContain('rpcCall("artifact.openFullscreen"');
    expect(APP_SOURCE).toContain('rpcCall("artifact.download"');
    expect(APP_SOURCE).toContain('rpcCall<{ prepared: true }>("artifact.prepareFrame"');
    const start = APP_SOURCE.indexOf('rpcCall("artifact.download"');
    const end = APP_SOURCE.indexOf("});", start);
    expect(APP_SOURCE.slice(start, end)).toContain('surface: "main"');
    const prepareStart = APP_SOURCE.indexOf('rpcCall<{ prepared: true }>("artifact.prepareFrame"');
    expect(APP_SOURCE.slice(prepareStart, APP_SOURCE.indexOf("});", prepareStart))).toContain('surface: "main"');
  });

  it("does not keep a fail-closed prepareFrame stub", () => {
    expect(APP_SOURCE).not.toContain("安全预览未就绪");
  });
});
