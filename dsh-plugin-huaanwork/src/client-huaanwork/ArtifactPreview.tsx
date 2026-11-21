/**
 * 右侧结果页预览：按宿主声明的格式选择 Markdown 或 HTML 渲染器，并提供全屏/下载入口。
 *
 * 读取错误与未读取是两种不同状态：错误显示 `role="alert"` 与重试，且绝不把空内容
 * 当成功页；未读取空态提供读取入口。渲染期异常由边界收敛为可见错误态（规格 §7.2），
 * 不冒泡卸载整棵 App/全屏树；下载只需双 ID，错误态仍由父级保留入口。
 */
import { Component, type ReactNode } from "react";
import ArtifactHtmlView from "./ArtifactHtmlView.tsx";
import ArtifactMarkdownView from "./ArtifactMarkdownView.tsx";
import type { ArtifactFormat, TaskArtifactSummary } from "./rpc-types.ts";

/** 预览所需的完整读取结果：摘要与按需读取的正文。 */
export type ArtifactPreviewDocument = {
  artifact: TaskArtifactSummary;
  content: string;
};

export type ArtifactPreviewProps = {
  artifact?: ArtifactPreviewDocument | undefined;
  error?: string | undefined;
  onFullscreen?: (() => void) | undefined;
  onDownload?: (() => void) | undefined;
  /** 原生 frame 防护确认回调；Task 7 接线 `artifact.prepareFrame` 前保持缺失。 */
  prepareHtmlFrame?: ((frameName: string) => Promise<void>) | undefined;
  onRetry?: (() => void) | undefined;
};

/**
 * 结果页渲染器选择：直接采用宿主声明的格式（第三种值已在宿主侧拒绝）。
 * @param artifact - 至少带 `format` 的 Artifact 摘要。
 * @returns 该格式对应的预览渲染器。
 */
export function rendererFor(artifact: Pick<TaskArtifactSummary, "format">): ArtifactFormat {
  return artifact.format;
}

type ArtifactRenderBoundaryProps = {
  /** 内容变化（重读/换结果）时清除错误态；重试按钮另调父级重读。 */
  resetKey: string;
  onRetry?: (() => void) | undefined;
  children: ReactNode;
};

/** 渲染期异常（过滤、解析或渲染器抛出）在此收敛为可见错误态，不卸载上层树。 */
class ArtifactRenderBoundary extends Component<ArtifactRenderBoundaryProps, { message: string | null }> {
  override state: { message: string | null } = { message: null };

  static getDerivedStateFromError(error: unknown): { message: string } {
    return { message: error instanceof Error ? error.message : String(error) };
  }

  override componentDidUpdate(prev: ArtifactRenderBoundaryProps): void {
    if (prev.resetKey !== this.props.resetKey && this.state.message !== null) {
      this.setState({ message: null });
    }
  }

  override render(): ReactNode {
    if (this.state.message !== null) {
      return (
        <div role="alert" className="artifact-error">
          <p>结果渲染失败：{this.state.message}</p>
          {this.props.onRetry ? (
            <button
              type="button"
              className="btn"
              onClick={() => {
                this.setState({ message: null });
                this.props.onRetry?.();
              }}
            >
              重试
            </button>
          ) : null}
        </div>
      );
    }
    return this.props.children;
  }
}

export default function ArtifactPreview({
  artifact,
  error,
  onFullscreen,
  onDownload,
  prepareHtmlFrame,
  onRetry,
}: ArtifactPreviewProps) {
  const title = artifact?.artifact.title ?? "结果页";
  return (
    <div className="artifact-preview">
      <p className="h preview-head">
        <span className="artifact-preview-title">{title}</span>
        {onFullscreen || onDownload ? (
          <span className="artifact-preview-actions">
            {onDownload ? (
              <button type="button" className="side-action" onClick={onDownload}>
                下载
              </button>
            ) : null}
            {onFullscreen ? (
              <button type="button" className="side-action" onClick={onFullscreen}>
                全屏
              </button>
            ) : null}
          </span>
        ) : null}
      </p>
      {error ? (
        <div role="alert" className="artifact-error">
          <p>{error}</p>
          {onRetry ? (
            <button type="button" className="btn" onClick={onRetry}>
              重试
            </button>
          ) : null}
        </div>
      ) : !artifact ? (
        <div className="panel-empty artifact-empty">
          <p>结果尚未读取</p>
          {onRetry ? (
            <button type="button" className="btn" onClick={onRetry}>
              读取
            </button>
          ) : null}
        </div>
      ) : (
        <ArtifactRenderBoundary resetKey={artifact.content} onRetry={onRetry}>
          {rendererFor(artifact.artifact) === "markdown" ? (
            <ArtifactMarkdownView content={artifact.content} />
          ) : (
            <ArtifactHtmlView content={artifact.content} title={title} prepareFrame={prepareHtmlFrame} />
          )}
        </ArtifactRenderBoundary>
      )}
    </div>
  );
}
