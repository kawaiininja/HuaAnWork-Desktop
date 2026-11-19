/**
 * HTML 结果预览：先渲染空 about:blank 沙箱 iframe，等原生 frame 防护确认后才以
 * 带 CSP 的 srcDoc 释放模型 HTML；准备失败只显示错误与重试，绝不提前插入正文。
 *
 * 每次内容替换或重试都重建 frame 名称；旧准备 Promise 归来不得武装新 frame，
 * srcDoc 自身的 load 也不得再次请求登记。登记不依赖空 frame 的 load 事件：该事件可能
 * 在 React 挂上监听前就已触发，因此 frame 一就绪就主动请求，load 只作兜底。
 * 沙箱只开 allow-scripts，不增加其他 token。
 */
import { useEffect, useMemo, useRef, useState } from "react";

const ARTIFACT_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data:",
  "font-src data:",
  "connect-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

/**
 * 在模型 HTML 之前插入结果页固定的 CSP meta。
 * @param content - 模型产出的完整或片段 HTML。
 * @returns 带 `<!doctype html>` 与 CSP meta 的 srcDoc 文本。
 */
export function withArtifactContentSecurity(content: string): string {
  return `<!doctype html><meta http-equiv="Content-Security-Policy" content="${ARTIFACT_CSP}">${content}`;
}

type ArtifactHtmlViewProps = {
  content: string;
  title: string;
  /** 父页面提供的原生防护确认；缺失时保持空 frame 并显示错误。 */
  prepareFrame?: ((frameName: string) => Promise<void>) | undefined;
};

/** 结果页 HTML 正文；`prepareFrame` 只在原生保护确认后返回。 */
export default function ArtifactHtmlView({ content, title, prepareFrame }: ArtifactHtmlViewProps) {
  const [attempt, setAttempt] = useState(0);
  const frameName = useMemo(() => `huaanwork-artifact-${crypto.randomUUID()}`, [content, attempt]);
  /** 最新 frame 名称：晚到的准备 Promise 只有仍匹配当前名称时才可武装。 */
  const currentFrameName = useRef(frameName);
  currentFrameName.current = frameName;
  const [preparedName, setPreparedName] = useState<string | null>(null);
  const [failure, setFailure] = useState<{ frameName: string; message: string } | null>(null);
  /** 每个 frame 只在空文档就绪时请求一次登记；srcDoc 的 load 不再重复请求。 */
  const requested = useRef<string | null>(null);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const armed = preparedName === frameName;
  const error = failure?.frameName === frameName ? failure.message : null;
  const secured = useMemo(() => withArtifactContentSecurity(content), [content]);

  const requestPrepare = (): void => {
    if (requested.current === frameName) return;
    requested.current = frameName;
    if (!prepareFrame) {
      setFailure({ frameName, message: "安全预览未就绪：原生 frame 防护回调缺失" });
      return;
    }
    const fail = (reason: unknown): void => {
      if (currentFrameName.current !== frameName) return;
      const message = reason instanceof Error ? reason.message : String(reason);
      setFailure({ frameName, message: `安全预览准备失败：${message}` });
    };
    let pending: Promise<void>;
    try {
      pending = prepareFrame(frameName);
    } catch (reason) {
      fail(reason);
      return;
    }
    pending.then(() => {
      if (currentFrameName.current === frameName) setPreparedName(frameName);
    }, fail);
  };

  const handleLoad = (): void => requestPrepare();

  useEffect(() => {
    // about:blank 可能在 React 挂上合成 load 监听之前就已装载完成，load 不再重放。
    // 只要子 frame 已在（contentWindow 存在；沙箱 frame 的 contentDocument 对父页面不可见），
    // 就走与 onLoad 相同的登记路径；onLoad 只兜底更晚装载的 frame。
    const frame = frameRef.current;
    if (frame !== null && (frame.contentWindow !== null || frame.contentDocument !== null)) {
      requestPrepare();
    }
  }, [frameName]);

  const retry = (): void => setAttempt((value) => value + 1);

  return (
    <div className="artifact-html">
      {error ? (
        <div role="alert" className="artifact-error">
          <p>{error}</p>
          <button type="button" className="btn" onClick={retry}>
            重试
          </button>
        </div>
      ) : null}
      <iframe
        key={frameName}
        ref={frameRef}
        name={frameName}
        title={title}
        className="artifact-frame"
        sandbox="allow-scripts"
        src={armed ? undefined : "about:blank"}
        srcDoc={armed ? secured : undefined}
        onLoad={handleLoad}
      />
    </div>
  );
}
