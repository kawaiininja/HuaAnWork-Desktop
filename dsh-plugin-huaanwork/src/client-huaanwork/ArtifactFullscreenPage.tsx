/**
 * 独立全屏 Artifact 页：只按启动目标的双 ID 读取 `artifact.get/content`，不挂载主 App，
 * 也不依赖业务 preload 或 Profile 全量反查。
 *
 * 下载与 HTML frame 准备固定 `surface: "artifact"`，因此保存对话框与 frame 防护都挂在
 * 当前全屏窗口上。Esc 与关闭按钮直接 `window.close()`，资源由 Electron 的 `close` 释放。
 * 读取失败显示 `role="alert"` 与重试，绝不把未读取当空成功页。
 */
import { useEffect, useState } from "react";
import ArtifactPreview from "./ArtifactPreview.tsx";
import { rpcCall } from "./api.ts";
import type { ArtifactRef, TaskArtifactSummary } from "./rpc-types.ts";

export type ArtifactFullscreenPageProps = { target: ArtifactRef };

type LoadState =
  | { status: "loading" }
  | { status: "ready"; artifact: TaskArtifactSummary; content: string }
  | { status: "error"; message: string };

function messageOf(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

/**
 * 全屏结果页。
 * @param target - 建窗时写入 URL 的会话与 Artifact 双 ID；归属仍由宿主路由校验。
 */
export default function ArtifactFullscreenPage({ target }: ArtifactFullscreenPageProps) {
  const { sessionId, artifactId } = target;
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setState({ status: "loading" });
    setActionError(null);
    void (async () => {
      try {
        const summary = await rpcCall<{ artifact?: TaskArtifactSummary }>("artifact.get", { sessionId, artifactId });
        const body = await rpcCall<{ artifact?: TaskArtifactSummary; content: string }>("artifact.content", {
          sessionId,
          artifactId,
        });
        const artifact = body.artifact ?? summary.artifact;
        if (!artifact) throw new Error("artifact-not-found");
        if (typeof body.content !== "string") throw new Error("artifact-content-unavailable");
        if (live) setState({ status: "ready", artifact, content: body.content });
      } catch (reason) {
        if (live) setState({ status: "error", message: messageOf(reason) });
      }
    })();
    return () => {
      live = false;
    };
  }, [sessionId, artifactId, attempt]);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") window.close();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, []);

  async function download(): Promise<void> {
    setActionError(null);
    try {
      await rpcCall<{ saved: boolean }>("artifact.download", { sessionId, artifactId, surface: "artifact" });
    } catch (reason) {
      setActionError(`保存失败：${messageOf(reason)}`);
    }
  }

  function prepareFrame(frameName: string): Promise<void> {
    return rpcCall<{ prepared: true }>("artifact.prepareFrame", {
      sessionId,
      artifactId,
      surface: "artifact",
      frameName,
    }).then(() => undefined);
  }

  return (
    <div className="artifact-page">
      <div className="artifact-preview-actions">
        <button type="button" className="side-action" onClick={() => window.close()}>
          关闭
        </button>
      </div>
      {actionError ? (
        <div role="alert" className="artifact-error">
          <p>{actionError}</p>
        </div>
      ) : null}
      {state.status === "loading" ? (
        <p className="panel-empty">正在读取结果…</p>
      ) : (
        <ArtifactPreview
          artifact={state.status === "ready" ? { artifact: state.artifact, content: state.content } : undefined}
          error={state.status === "error" ? state.message : undefined}
          onDownload={() => void download()}
          prepareHtmlFrame={prepareFrame}
          onRetry={() => setAttempt((value) => value + 1)}
        />
      )}
    </div>
  );
}
