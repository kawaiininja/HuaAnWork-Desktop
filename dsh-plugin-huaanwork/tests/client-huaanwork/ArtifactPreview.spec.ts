// @vitest-environment jsdom
/**
 * 右侧结果预览：按声明格式选择渲染器；Markdown 只经上游安全渲染器且先剔除远程图片；
 * HTML 只有在原生 frame 防护确认后才把带 CSP 的 srcDoc 放进沙箱 iframe。
 *
 * 读取失败必须显示 role="alert" 与重试，不得把空内容当成功页；准备失败同样只报错，
 * 绝不提前插入模型 HTML。
 */
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import ArtifactPreview, { rendererFor } from "../../src/client-huaanwork/ArtifactPreview.tsx";
import ArtifactHtmlView, { withArtifactContentSecurity } from "../../src/client-huaanwork/ArtifactHtmlView.tsx";
import ArtifactMarkdownView, { withoutRemoteMarkdownImages } from "../../src/client-huaanwork/ArtifactMarkdownView.tsx";

describe("ArtifactPreview", () => {
  it("selects the declared renderer", () => {
    expect(rendererFor({ format: "markdown" })).toBe("markdown");
    expect(rendererFor({ format: "html" })).toBe("html");
  });

  it("allows scripts only inside an opaque sandbox and denies network", () => {
    const secured = withArtifactContentSecurity("<script>window.ran=true</script>");
    expect(secured).toContain("default-src 'none'");
    expect(secured).toContain("connect-src 'none'");
    expect(secured).toContain("script-src 'unsafe-inline'");
    expect(secured.indexOf("Content-Security-Policy")).toBeLessThan(
      secured.indexOf("<script>window.ran=true</script>"),
    );
    const frame = renderHtmlFrame(secured);
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame.getAttribute("sandbox")).not.toContain("allow-same-origin");
    expect(frame.getAttribute("srcDoc")).toBeNull();
    expect(frame.getAttribute("src")).toBe("about:blank");
  });

  it("releases HTML only after the native frame guard acknowledges preparation", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    const prepareFrame = vi.fn<(frameName: string) => Promise<void>>(() => ready);
    try {
      await act(async () =>
        root.render(
          createElement(ArtifactHtmlView, {
            content: "<p>受控正文</p>",
            title: "结果",
            prepareFrame,
          }),
        ),
      );
      const frame = container.querySelector("iframe")!;
      await act(async () => {
        frame.dispatchEvent(new Event("load"));
      });
      expect(prepareFrame).toHaveBeenCalledWith(frame.name);
      expect(frame.getAttribute("srcdoc")).toBeNull();
      await act(async () => {
        release();
        await ready;
      });
      expect(frame.getAttribute("src")).toBeNull();
      expect(frame.getAttribute("srcdoc")).toContain("受控正文");
      // srcDoc 自身的 load 不得再次请求登记。
      await act(async () => {
        frame.dispatchEvent(new Event("load"));
      });
      expect(prepareFrame).toHaveBeenCalledTimes(1);
    } finally {
      await act(async () => root.unmount());
      container.remove();
      vi.unstubAllGlobals();
    }
  });

  it("never releases model HTML when frame preparation fails", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const prepareFrame = vi.fn<(frameName: string) => Promise<void>>(() =>
      Promise.reject(new Error("artifact-frame-unavailable")),
    );
    try {
      await act(async () =>
        root.render(
          createElement(ArtifactHtmlView, {
            content: "<p>模型正文</p>",
            title: "结果",
            prepareFrame,
          }),
        ),
      );
      const frame = container.querySelector("iframe")!;
      const firstName = frame.name;
      await act(async () => {
        frame.dispatchEvent(new Event("load"));
        await Promise.resolve();
      });
      expect(container.querySelector('[role="alert"]')).not.toBeNull();
      expect(frame.getAttribute("src")).toBe("about:blank");
      expect(frame.getAttribute("srcdoc")).toBeNull();
      const retry = container.querySelector('[role="alert"] button')!;
      await act(async () => {
        retry.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      expect(prepareFrame).toHaveBeenCalledTimes(2);
      expect(prepareFrame.mock.calls[1]?.[0]).not.toBe(firstName);
    } finally {
      await act(async () => root.unmount());
      container.remove();
      vi.unstubAllGlobals();
    }
  });

  it("keeps the frame empty and shows an error when no frame guard callback is installed", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () =>
        root.render(createElement(ArtifactHtmlView, { content: "<p>模型正文</p>", title: "结果" })),
      );
      const frame = container.querySelector("iframe")!;
      await act(async () => {
        frame.dispatchEvent(new Event("load"));
      });
      expect(container.querySelector('[role="alert"]')?.textContent).toContain("安全预览");
      expect(frame.getAttribute("src")).toBe("about:blank");
      expect(frame.getAttribute("srcdoc")).toBeNull();
    } finally {
      await act(async () => root.unmount());
      container.remove();
      vi.unstubAllGlobals();
    }
  });

  it("never arms a replaced frame with a stale preparation promise", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    const firstReady = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const secondReady = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    const prepareFrame = vi
      .fn<(frameName: string) => Promise<void>>()
      .mockImplementationOnce(() => firstReady)
      .mockImplementationOnce(() => secondReady);
    try {
      await act(async () =>
        root.render(
          createElement(ArtifactHtmlView, { content: "<p>旧正文</p>", title: "结果", prepareFrame }),
        ),
      );
      const first = container.querySelector("iframe")!;
      const firstName = first.name;
      await act(async () => {
        first.dispatchEvent(new Event("load"));
      });
      await act(async () =>
        root.render(
          createElement(ArtifactHtmlView, { content: "<p>新正文</p>", title: "结果", prepareFrame }),
        ),
      );
      const second = container.querySelector("iframe")!;
      expect(second.name).not.toBe(firstName);
      await act(async () => {
        second.dispatchEvent(new Event("load"));
      });
      expect(second.getAttribute("src")).toBe("about:blank");
      await act(async () => {
        releaseFirst();
        await firstReady;
      });
      // 旧 Promise 归来不得武装新 frame。
      expect(second.getAttribute("srcdoc")).toBeNull();
      expect(second.getAttribute("src")).toBe("about:blank");
      expect(prepareFrame).toHaveBeenLastCalledWith(second.name);
      await act(async () => {
        releaseSecond();
        await secondReady;
      });
      expect(second.getAttribute("src")).toBeNull();
      expect(second.getAttribute("srcdoc")).toContain("新正文");
    } finally {
      await act(async () => root.unmount());
      container.remove();
      vi.unstubAllGlobals();
    }
  });

  it("does not auto-load remote images in markdown artifacts", () => {
    const markup = renderToStaticMarkup(
      createElement(ArtifactMarkdownView, {
        content: "![远程图](https://example.com/x.png)\n\n[链接](https://example.com/doc)",
      }),
    );
    expect(markup).not.toContain('src="https://example.com/x.png"'); // 远程 img 不自动加载（AM-8）
    expect(markup).toContain("https://example.com/doc"); // http 链接保留走既有安全打开
  });

  it.each(["![图][ref]", "![ref][]", "![ref]"])(
    "blocks remote reference image %s without deleting shared links",
    (image) => {
      const input = `${image}\n\n[普通链接][ref]\n\n[ref]: https://example.com/x.png`;
      const filtered = withoutRemoteMarkdownImages(input);
      expect(filtered).toContain("远程图片（已禁用）");
      expect(filtered).toContain("[普通链接][ref]");
      expect(filtered).toContain("[ref]: https://example.com/x.png");
      const markup = renderToStaticMarkup(createElement(ArtifactMarkdownView, { content: input }));
      expect(markup).not.toContain("<img");
      expect(markup).toContain('href="https://example.com/x.png"');
    },
  );

  it("uses normalized identifiers and the first definition while leaving code untouched", () => {
    const remoteFirst = "![图][REF]\n\n[ref]: https://example.com/first.png\n[REF]: local.png";
    expect(withoutRemoteMarkdownImages(remoteFirst)).not.toContain("![图][REF]");
    const localFirst = "![图][REF]\n\n[ref]: local.png\n[REF]: https://example.com/second.png";
    expect(withoutRemoteMarkdownImages(localFirst)).toBe(localFirst);
    const code = "```md\n![图][ref]\n[ref]: https://example.com/x.png\n```";
    expect(withoutRemoteMarkdownImages(code)).toBe(code);
  });

  it("keeps fenced code, tables and math while disabling raw HTML and unsafe protocols", () => {
    const content = [
      "```md",
      "![示例](https://example.com/x.png)",
      "```",
      "",
      "| 列 | 值 |",
      "| --- | --- |",
      "| a | 1 |",
      "",
      "公式 $x^2$ 保留。",
      "",
      '<img src="https://example.com/raw.png" onerror="alert(1)">',
      "",
      "[危险](javascript:alert(1))",
      "",
      "![本地](/etc/passwd)",
    ].join("\n");
    const markup = renderToStaticMarkup(createElement(ArtifactMarkdownView, { content }));
    expect(markup).toContain("![示例](https://example.com/x.png)"); // 代码块原样文本
    expect(markup).toContain("<table");
    expect(markup).toContain("katex");
    expect(markup).not.toContain("<img");
    expect(markup).not.toContain("javascript:");
    expect(markup).not.toContain("/etc/passwd");
  });

  it("shows the read error with a retry button instead of an empty success page", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const onRetry = vi.fn();
    try {
      await act(async () =>
        root.render(createElement(ArtifactPreview, { error: "artifact-content-unavailable", onRetry })),
      );
      const alert = container.querySelector('[role="alert"]');
      expect(alert).not.toBeNull();
      expect(alert?.textContent).toContain("artifact-content-unavailable");
      expect(container.textContent).not.toContain("结果尚未读取");
      const retry = alert?.querySelector("button");
      expect(retry?.textContent).toBe("重试");
      await act(async () => {
        retry!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      expect(onRetry).toHaveBeenCalledTimes(1);
    } finally {
      await act(async () => root.unmount());
      container.remove();
      vi.unstubAllGlobals();
    }
  });
});

function renderHtmlFrame(content: string): HTMLIFrameElement {
  const markup = renderToStaticMarkup(
    createElement(ArtifactHtmlView, { content, title: "结果", prepareFrame: async () => undefined }),
  );
  const document = new DOMParser().parseFromString(markup, "text/html");
  const frame = document.querySelector("iframe");
  if (!frame) throw new Error("iframe missing");
  return frame;
}
