import type { ArtifactFormat, ArtifactOutcome, RunSummary, TaskArtifactSummary } from "../rpc-types.ts";
import { foldRunAssistantItems } from "./runResultAttachments.ts";
import { runResultNoteText } from "./runTabsLogic.ts";

/**
 * 任务结果的唯一展示投影（纯函数；App 与测试共用）。
 *
 * 有 `artifactOutcome` 的运行只渲染 Artifact 卡（created）或失败卡（failed），
 * 原始封套/兼容 JSON 助手正文在投影里被移除；只有无 `artifactOutcome` 的旧运行
 * 才走 `foldRunAssistantItems` 的旧附件折叠。`artifactReadError` 是客户端读取失败
 * 状态，只影响展示，不写回 `RunSummary`，也不把 created 改成 failed。
 */

/** 未定位历史结果分组的固定标题；分组只有一个，且始终位于列表尾部。 */
export const ARTIFACT_GROUP_TITLE = "未定位的历史结果";

/** 客户端读取失败时的稳定错误码；不写回 RunSummary。 */
export const ARTIFACT_READ_FAILED = "artifact-content-missing";

/** 没有原封套可复用时的结果卡 id；渲染 id 从 1 递增，0 不会与 allocId 冲突。 */
const FALLBACK_RESULT_CARD_ID = 0;

/** 投影所需的运行结果字段：实时 run-end 事件与持久化 RunSummary 都能构造。 */
export type AutomationResultRun = {
  artifactOutcome?: ArtifactOutcome;
  artifactId?: string;
  artifactError?: string;
  /** 客户端读取失败状态（仅展示）。 */
  artifactReadError?: string;
  artifactTitle?: string;
  artifactFormat?: ArtifactFormat;
};

/** 成功结果卡（标题、格式、时间、大小；整卡可点击）。 */
export type ArtifactResultCardItem = {
  id: number;
  kind: "artifact";
  artifactId: string;
  artifact: TaskArtifactSummary;
};

/** 无正文的失败终态卡（保存失败或不可读）。 */
export type ArtifactErrorCardItem = {
  id: number;
  kind: "artifact-error";
  title: string;
  format: ArtifactFormat | "unknown";
  formatLabel: string;
  error: string;
};

/** 内容暂不可读的占位卡；带重试入口，重试失败收敛为 `artifact-error`。 */
export type ArtifactLoadingCardItem = {
  id: number;
  kind: "artifact-loading";
  artifactId?: string;
};

/** 未定位历史结果的尾部分组标题项。 */
export type ArtifactGroupCardItem = {
  id: number;
  kind: "artifact-group";
  text: string;
};

export type ArtifactProjectionCard = ArtifactResultCardItem | ArtifactErrorCardItem | ArtifactLoadingCardItem;
export type ArtifactHistoryCard = ArtifactResultCardItem | ArtifactGroupCardItem;

/** 结果卡格式展示文案；`unknown` 只用于失败卡的回退。 */
export function artifactFormatLabel(format: ArtifactFormat | "unknown"): string {
  if (format === "markdown") return "Markdown";
  if (format === "html") return "HTML";
  return "未知格式";
}

type ProjectionItem = {
  id: number;
  kind: string;
  text?: string;
  sourceText?: string;
  artifactId?: string;
  title?: string;
  error?: string;
};

type HistoryItem = {
  id: number;
  kind: string;
  text?: string;
  clientMessageId?: string;
  artifactId?: string;
};

type ErrorInfo = { title: string; format: ArtifactFormat | "unknown"; error: string };

/** 用一张结果类卡替换所有助手正文（封套）与旧结果卡；插入位置取第一条被替换项。 */
function replaceResultCards<T extends ProjectionItem>(
  items: readonly T[],
  createCard: (id: number) => ArtifactProjectionCard,
  matches: (item: T) => boolean,
): (T | ArtifactProjectionCard)[] {
  const kept: (T | ArtifactProjectionCard)[] = [];
  let cardId: number | undefined;
  let insertAt = -1;
  for (const item of items) {
    if (matches(item)) {
      if (cardId === undefined) {
        cardId = item.id;
        insertAt = kept.length;
      }
      continue;
    }
    kept.push(item);
  }
  if (cardId === undefined) {
    // 没有可复用的封套/占位位置：追加到末尾（run-end 的脚注随后仍在其后）。
    return [...kept, createCard(FALLBACK_RESULT_CARD_ID)];
  }
  return [...kept.slice(0, insertAt), createCard(cardId), ...kept.slice(insertAt)];
}

function isResultPresentation(item: ProjectionItem): boolean {
  return item.kind === "assistant"
    || item.kind === "artifact"
    || item.kind === "artifact-error"
    || item.kind === "artifact-loading";
}

function replaceRunAssistantWithArtifact<T extends ProjectionItem>(
  items: readonly T[],
  artifact: TaskArtifactSummary,
): (T | ArtifactProjectionCard)[] {
  // 同一 artifactId 的 created 事件 + artifact.list 快照：保留已有卡片，只补删封套。
  if (items.some((item) => item.kind === "artifact" && item.artifactId === artifact.artifactId)) {
    if (!items.some((item) => item.kind === "assistant" || item.kind === "artifact-loading")) return [...items];
    return items.filter((item) => item.kind !== "assistant" && item.kind !== "artifact-loading");
  }
  return replaceResultCards(
    items,
    (id) => ({ id, kind: "artifact", artifactId: artifact.artifactId, artifact }),
    isResultPresentation,
  );
}

function replaceRunAssistantWithError<T extends ProjectionItem>(
  items: readonly T[],
  info: ErrorInfo,
): (T | ArtifactProjectionCard)[] {
  // 同一错误已经渲染过：不新建第二张失败卡，只补删可能重现的封套/占位。
  if (items.some((item) => item.kind === "artifact-error" && item.error === info.error && item.title === info.title)) {
    if (!items.some((item) => isResultPresentation(item) && item.kind !== "artifact-error")) return [...items];
    return items.filter((item) => item.kind !== "assistant" && item.kind !== "artifact-loading" && item.kind !== "artifact");
  }
  return replaceResultCards(
    items,
    (id) => ({
      id,
      kind: "artifact-error",
      title: info.title,
      format: info.format,
      formatLabel: artifactFormatLabel(info.format),
      error: info.error,
    }),
    isResultPresentation,
  );
}

function replaceRunAssistantWithArtifactLoading<T extends ProjectionItem>(
  items: readonly T[],
  artifactId?: string,
): (T | ArtifactProjectionCard)[] {
  if (items.some((item) => item.kind === "artifact-loading" && (artifactId === undefined || item.artifactId === artifactId))) {
    if (!items.some((item) => item.kind === "assistant")) return [...items];
    return items.filter((item) => item.kind !== "assistant");
  }
  return replaceResultCards(
    items,
    (id) => ({ id, kind: "artifact-loading", ...(artifactId === undefined ? {} : { artifactId }) }),
    isResultPresentation,
  );
}

/**
 * 自动化运行结果的五分支投影。
 *
 * @param items 运行标签当前条目
 * @param run 运行结果字段（实时事件或持久化摘要）
 * @param artifact created 运行的 Artifact 摘要；缺失时显示可重试占位
 * @param createAttachment 旧折叠的附件构造器；只有无 `artifactOutcome` 时使用
 * @returns 已移除原始封套的唯一结果展示
 * @throws Error 旧运行缺少附件构造器（`legacy-attachment-factory-required`）
 */
export function projectAutomationResult<T extends ProjectionItem>(
  items: readonly T[],
  run: AutomationResultRun,
  artifact?: TaskArtifactSummary,
  createAttachment?: (sourceText: string) => T,
): (T | ArtifactProjectionCard)[] {
  if (run.artifactOutcome === "created" && run.artifactReadError) {
    return replaceRunAssistantWithError(items, {
      title: artifact?.title ?? "任务结果",
      format: artifact?.format ?? "unknown",
      error: run.artifactReadError,
    });
  }
  if (run.artifactOutcome === "created" && artifact) return replaceRunAssistantWithArtifact(items, artifact);
  if (run.artifactOutcome === "created" && !artifact) return replaceRunAssistantWithArtifactLoading(items, run.artifactId);
  if (run.artifactOutcome === "failed") {
    return replaceRunAssistantWithError(items, {
      title: run.artifactTitle ?? "任务结果",
      format: run.artifactFormat ?? "unknown",
      error: run.artifactError ?? "artifact-write-failed",
    });
  }
  if (run.artifactOutcome === undefined) {
    if (!createAttachment) throw new Error("legacy-attachment-factory-required");
    return [...foldRunAssistantItems(items, createAttachment)];
  }
  return [...items];
}

/** 重试占位卡：读到摘要就换成结果卡，仍读不到就收敛为无正文错误终态。 */
export function settleArtifactLoading<T extends ProjectionItem>(
  items: readonly T[],
  artifactId: string | undefined,
  artifact: TaskArtifactSummary | undefined,
): (T | ArtifactProjectionCard)[] {
  const next: (T | ArtifactProjectionCard)[] = [];
  for (const item of items) {
    if (item.kind !== "artifact-loading" || (artifactId !== undefined && item.artifactId !== artifactId)) {
      next.push(item);
      continue;
    }
    next.push(artifact
      ? { id: item.id, kind: "artifact", artifactId: artifact.artifactId, artifact }
      : {
          id: item.id,
          kind: "artifact-error",
          title: "任务结果",
          format: "unknown",
          formatLabel: artifactFormatLabel("unknown"),
          error: ARTIFACT_READ_FAILED,
        });
  }
  return next;
}

/**
 * 把历史 Artifact 插到确定锚点：普通回合插在下一条用户消息之前（没有就插在
 * 正常内容末尾、未定位分组之前）；自动化运行插在精确 `automationId + runId`
 * 选中的运行脚注之前。找不到精确锚点才进入唯一的尾部“未定位的历史结果”分组。
 * 同一 artifactId 不重复插卡。
 */
export function insertArtifactIntoHistory<T extends HistoryItem>(
  items: readonly T[],
  artifact: TaskArtifactSummary,
  allocId: () => number,
  run?: { automationId: string; summary: Pick<RunSummary, "runId" | "status"> },
): (T | ArtifactHistoryCard)[] {
  if (items.some((item) => item.kind === "artifact" && item.artifactId === artifact.artifactId)) return [...items];
  const card: ArtifactResultCardItem = { id: allocId(), kind: "artifact", artifactId: artifact.artifactId, artifact };
  if (artifact.anchor.kind === "turn" && artifact.anchor.clientMessageId) {
    const clientMessageId = artifact.anchor.clientMessageId;
    const anchorIndex = items.findIndex((item) => item.kind === "user" && item.clientMessageId === clientMessageId);
    if (anchorIndex >= 0) {
      const groupStart = items.findIndex((item) => item.kind === "artifact-group");
      const normalEnd = groupStart < 0 ? items.length : groupStart;
      const nextUser = items.findIndex(
        (item, index) => index > anchorIndex && index < normalEnd && item.kind === "user",
      );
      const insertAt = nextUser < 0 ? normalEnd : nextUser;
      return [...items.slice(0, insertAt), card, ...items.slice(insertAt)];
    }
  }
  if (artifact.anchor.kind === "automation-run") {
    const exactRun = run !== undefined
      && run.automationId === artifact.anchor.automationId
      && run.summary.runId === artifact.anchor.runId;
    const footnoteText = exactRun ? runResultNoteText(run.summary.status) : undefined;
    const footnote = footnoteText === undefined
      ? -1
      : items.findLastIndex((item) => item.kind === "note" && item.text === footnoteText);
    if (footnote >= 0) return [...items.slice(0, footnote), card, ...items.slice(footnote)];
  }
  if (items.some((item) => item.kind === "artifact-group")) return [...items, card];
  return [
    ...items,
    { id: allocId(), kind: "artifact-group", text: ARTIFACT_GROUP_TITLE },
    card,
  ];
}

/** 新普通条目落在尾部未定位分组之前；没有分组时仍是追加。 */
export function insertBeforeArtifactGroup<T extends { kind: string }>(items: readonly T[], item: T): T[] {
  const groupStart = items.findIndex((entry) => entry.kind === "artifact-group");
  const at = groupStart < 0 ? items.length : groupStart;
  return [...items.slice(0, at), item, ...items.slice(at)];
}

/** 历史回填的确定顺序：先 createdAt，再 artifactId（与存储列表排序同口径）。 */
export function sortArtifactsForBackfill<T extends Pick<TaskArtifactSummary, "createdAt" | "artifactId">>(
  artifacts: readonly T[],
): T[] {
  return [...artifacts].sort((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
    if (a.artifactId === b.artifactId) return 0;
    return a.artifactId < b.artifactId ? -1 : 1;
  });
}

export type ArtifactPreviewState<T> = {
  rightOpen: boolean;
  rightTab: string;
  previewArtifactId?: string;
  preview?: T;
  previewError?: string;
};

/**
 * 点击结果卡后的右栏状态：展开预览、切到 preview、选中 artifactId 并读取内容。
 * 读取失败不抛出，返回 `previewError` 供调用方展示；请求在 App 侧另有会话/代际守卫。
 */
export async function openArtifactPreview<T>(
  state: { rightOpen: boolean; rightTab: string; previewArtifactId?: string },
  artifactId: string,
  fetchArtifact: (artifactId: string) => Promise<T>,
): Promise<ArtifactPreviewState<T>> {
  const opened = {
    ...state,
    rightOpen: true,
    rightTab: "preview",
    previewArtifactId: artifactId,
  };
  try {
    return { ...opened, preview: await fetchArtifact(artifactId) };
  } catch (error) {
    return { ...opened, previewError: error instanceof Error ? error.message : String(error) };
  }
}

/** 迟到的 Artifact 响应只写回仍匹配的会话与代际；旧会话/旧代际直接丢弃。 */
export function shouldApplyArtifactResponse(
  current: { sessionId: string; epoch: number },
  response: { sessionId: string; epoch: number },
): boolean {
  return current.sessionId === response.sessionId && current.epoch === response.epoch;
}
