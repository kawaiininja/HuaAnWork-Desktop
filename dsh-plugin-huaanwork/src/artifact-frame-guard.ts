/**
 * Artifact HTML 预览的原生 frame 导航防护。
 *
 * 只保存当前 WebContents 里已登记 Artifact frame 的稳定 `frameTreeNodeId`；
 * frame 名称只在受信父页面尚未插入内容时用于定位空 frame，之后不再作为授权依据。
 * 每个登记 frame 允许且只允许一次 about:srcdoc 引导导航（srcDoc 释放），随后在导航
 * 发出前拒绝该 frame 及其后代的全部文档导航，包括脚本自导航、链接、meta refresh、
 * 重定向入口，以及被内容改写 window.name 后的导航。
 *
 * 主窗口与全屏页面共用本模块；未登记的 frame 与主页面导航不归它接管。
 */
import type {
  Event as ElectronEvent,
  WebContents,
  WebContentsWillFrameNavigateEventParams,
  WebFrameMain,
} from "electron";

/** 一个已安装防护的控制面；dispose 只移除自己的 listener。 */
export interface ArtifactFrameGuard {
  /**
   * 登记一个刚创建的空 Artifact frame。
   * @param frameName - 父页面为该空 iframe 生成的随机名称（`huaanwork-artifact-<uuid>`）。
   * @throws 当该名称不能唯一对应当前主 frame 的直属、存活、尚无内容的子 frame 时。
   */
  registerEmptyFrame(frameName: string): void;
  /** 移除导航 listener 与全部登记状态；重复调用无副作用。 */
  dispose(): void;
}

/**
 * 安装 Artifact frame 导航防护。
 * @param renderer - 承载预览页面的 WebContents（主窗口或全屏 Artifact 窗口）。
 * @returns 登记与释放控制面。
 */
export function installArtifactFrameGuard(renderer: WebContents): ArtifactFrameGuard {
  const guarded = new Set<number>();
  const bootstrap = new Set<number>();
  const inside = (frame: WebFrameMain | null | undefined): boolean => {
    for (let current = frame; current && !current.detached; current = current.parent) {
      if (guarded.has(current.frameTreeNodeId)) return true;
    }
    return false;
  };
  const navigate = (event: ElectronEvent<WebContentsWillFrameNavigateEventParams>): void => {
    const frame = event.frame;
    if (!inside(frame) && !inside(event.initiator)) return;
    if (frame && bootstrap.has(frame.frameTreeNodeId) && event.url === "about:srcdoc") {
      bootstrap.delete(frame.frameTreeNodeId);
      return;
    }
    event.preventDefault();
  };
  renderer.on("will-frame-navigate", navigate);
  return {
    registerEmptyFrame(frameName: string): void {
      const live = renderer.mainFrame.framesInSubtree.filter((frame) => !frame.detached);
      const liveIds = new Set(live.map((frame) => frame.frameTreeNodeId));
      for (const id of guarded) {
        if (!liveIds.has(id)) {
          guarded.delete(id);
          bootstrap.delete(id);
        }
      }
      const matches = live.filter(
        (frame) =>
          frame.name === frameName &&
          frame.parent?.frameTreeNodeId === renderer.mainFrame.frameTreeNodeId &&
          (frame.url === "about:blank" || frame.url === ""),
      );
      if (matches.length !== 1) throw new Error("artifact-frame-unavailable");
      const frame = matches[0]!;
      guarded.add(frame.frameTreeNodeId);
      bootstrap.add(frame.frameTreeNodeId);
    },
    dispose(): void {
      renderer.off("will-frame-navigate", navigate);
      guarded.clear();
      bootstrap.clear();
    },
  };
}
