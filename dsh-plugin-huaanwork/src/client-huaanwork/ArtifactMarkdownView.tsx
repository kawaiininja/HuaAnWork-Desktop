/**
 * Markdown 结果预览：只经上游 `MarkdownText` 安全渲染器输出，渲染前剔除指向
 * HTTP(S) 的图片节点，避免打开结果页时自动请求远程资源（AM-8）。
 *
 * 剔除用与上游相同的公开 micromark/mdast 包解析出 UTF-16 源码偏移，按两遍 AST
 * （先收集定义、再匹配图片）改写原文：引用标识按 CommonMark 归一化大小写且首定义生效，
 * 共享定义、普通链接与围栏代码块保持原样。原始 HTML 与不安全协议仍由上游渲染器禁用。
 */
import { type MarkdownLabels, MarkdownText } from "@deepseek-ai/dsh-client-ui-primitives";
import { memo, useMemo } from "react";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { mathFromMarkdown } from "mdast-util-math";
import { gfm } from "micromark-extension-gfm";
import { math } from "micromark-extension-math";

/** 结果页固定的中文渲染标签；不传 fileMentions/pathImages，本地路径不会被解析或读取。 */
const labels: MarkdownLabels = {
  code: {
    copyLabel: "复制",
    copiedLabel: "已复制",
    toolbarLabels: { codeLabel: "代码", wrapLabel: "换行", unwrapLabel: "不换行" },
  },
  footnotes: "脚注",
};

interface MarkdownNode {
  type: string;
  url?: string;
  identifier?: string;
  position?: { start: { offset?: number }; end: { offset?: number } };
  children?: MarkdownNode[];
}

/**
 * 把指向 HTTP(S) 的 Markdown 图片（含引用式图片）替换为纯文本占位。
 * @param content - 模型产出的 Markdown 原文。
 * @returns 解除远程图片后的 Markdown；无远程图片时返回原字符串本身。
 */
export function withoutRemoteMarkdownImages(content: string): string {
  const tree = fromMarkdown(content, {
    extensions: [gfm(), math()],
    mdastExtensions: [gfmFromMarkdown(), mathFromMarkdown()],
  }) as MarkdownNode;
  const definitions = new Map<string, string>();
  const walk = (node: MarkdownNode, visit: (node: MarkdownNode) => void): void => {
    visit(node);
    node.children?.forEach((child) => walk(child, visit));
  };
  walk(tree, (node) => {
    if (node.type !== "definition" || node.identifier === undefined || node.url === undefined) return;
    const key = node.identifier.toUpperCase();
    if (!definitions.has(key)) definitions.set(key, node.url);
  });
  const replacements: Array<{ start: number; end: number }> = [];
  walk(tree, (node) => {
    if (node.type !== "image" && node.type !== "imageReference") return;
    const url =
      node.type === "image"
        ? node.url
        : definitions.get(node.identifier?.toUpperCase() ?? "");
    if (!/^https?:\/\//i.test(url ?? "")) return;
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start === undefined || end === undefined) throw new Error("artifact-markdown-image-position-missing");
    replacements.push({ start, end });
  });
  return replacements
    .sort((a, b) => b.start - a.start)
    .reduce(
      (text, edit) => `${text.slice(0, edit.start)}远程图片（已禁用）${text.slice(edit.end)}`,
      content,
    );
}

/**
 * 右侧预览的 Markdown 正文；禁用流式解析与文件提及/本地图片词汇。
 *
 * 父页面每个流式 token 都会重渲染，因此过滤结果按 `content` 记忆化，并以 `memo`
 * 跳过内容未变的整棵渲染：避免每帧重新解析整篇 Markdown（可达数 MiB）。
 */
function ArtifactMarkdownView({ content }: { content: string }) {
  const filtered = useMemo(() => withoutRemoteMarkdownImages(content), [content]);
  return (
    <div className="artifact-markdown">
      <MarkdownText text={filtered} streaming={false} labels={labels} />
    </div>
  );
}

export default memo(ArtifactMarkdownView);
