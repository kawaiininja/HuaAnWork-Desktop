import {
  artifactFormatLabel,
  type ArtifactErrorCardItem,
  type ArtifactLoadingCardItem,
  type ArtifactResultCardItem,
} from "./logic/artifactProjection.ts";

/**
 * 会话内的结果卡：成功卡整卡可点击打开右侧预览；失败卡只展示标题、格式与错误码，
 * 不含原始正文；占位卡带重试入口。Markdown/HTML 的实际渲染由预览面板负责。
 */

function formatSize(sizeBytes: number): string {
  if (!Number.isFinite(sizeBytes) || sizeBytes < 0) return "";
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  if (sizeBytes < 1024 * 1024) return `${(sizeBytes / 1024).toFixed(1)} KB`;
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatCreatedAt(createdAt: string): string {
  const time = Date.parse(createdAt);
  if (Number.isNaN(time)) return createdAt;
  return new Date(time).toLocaleString();
}

export default function ResultArtifactCard({
  item,
  onOpen,
  onRetry,
}: {
  item: ArtifactResultCardItem | ArtifactErrorCardItem | ArtifactLoadingCardItem;
  onOpen?: (artifactId: string) => void;
  onRetry?: (artifactId?: string) => void;
}) {
  if (item.kind === "artifact") {
    const size = formatSize(item.artifact.sizeBytes);
    return (
      <button
        type="button"
        className="card artifact-card"
        style={{ display: "block", width: "100%", textAlign: "left" }}
        onClick={() => onOpen?.(item.artifactId)}
      >
        <span className="ttl">{item.artifact.title}</span>{" "}
        <span className="badge">{artifactFormatLabel(item.artifact.format)}</span>
        <p className="muted" style={{ margin: "4px 0 0" }}>
          {formatCreatedAt(item.artifact.createdAt)}
          {size ? ` · ${size}` : ""}
        </p>
      </button>
    );
  }
  if (item.kind === "artifact-error") {
    return (
      <div className="card artifact-card" role="alert">
        <span className="ttl">结果页保存失败</span>{" "}
        <span className="badge">{item.formatLabel}</span>
        <p className="muted" style={{ margin: "4px 0 0" }}>
          {item.title} · {item.error}
        </p>
      </div>
    );
  }
  const artifactId = item.artifactId;
  return (
    <div className="card artifact-card">
      <span className="ttl">结果页暂时不可读</span>
      <p className="muted" style={{ margin: "4px 0 0" }}>
        内容读取失败；可以重试，重试仍失败将显示失败状态。
      </p>
      <button type="button" className="btn" onClick={() => onRetry?.(artifactId)}>
        重试
      </button>
    </div>
  );
}
