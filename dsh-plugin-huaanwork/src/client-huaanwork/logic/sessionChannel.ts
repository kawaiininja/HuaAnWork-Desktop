import type { TodoEntry } from "@huaanwork/policy/todo";

import type { RpcEvent, SessionDetailRecord } from "../rpc-types.ts";
import { sendOpensTurn } from "./concurrentTurn.ts";
import { goalRoundLabel } from "./goalRound.ts";

/**
 * 自动化运行会话 id 前缀。
 * 客户端与宿主进程隔离, 保持独立声明; 值与 src/huaanwork-host/automation-session-ids.ts 保持同步。
 */
export const AUTO_SESSION_PREFIX = "huaanwork-auto-";
/**
 * 旧 chat 通道自动化运行会话前缀（与 src/huaanwork-host/automation-session-ids.ts 的 LEGACY_CHAT_AUTO_SESSION_PREFIX 保持同步）。
 * sidecar 启动时一次性清扫删除该前缀目录，这里仅过滤清扫失败（如 Windows 文件占用）的残留。
 */
export const LEGACY_CHAT_AUTO_SESSION_PREFIX = "huaanwork-chat-auto-";

/**
 * 自动化运行会话不进侧栏常规会话列表——它们由「任务」区运行 tab 与「自动化」页「运行记录」展示。
 * 同时识别旧 chat 通道运行前缀（huaanwork-chat-auto-）：正常已被 sidecar 启动清扫删除，
 * 匹配它只为兜住清扫失败的残留目录，避免以幽灵历史条目混入「任务」区/项目卡。
 */
export function isAutomationSessionId(id: string | undefined): boolean {
  return (
    typeof id === "string" &&
    (id.startsWith(AUTO_SESSION_PREFIX) || id.startsWith(LEGACY_CHAT_AUTO_SESSION_PREFIX))
  );
}

/**
 * 会话是否有真实对话内容：消息数 / 轮次数均大于 0 才算数。
 * 项目打开时会自动铸造稳定会话（只写初始化事件的空壳），它们不属于历史条目，
 * 若不过滤会以「未命名」条目污染「最近对话」/「历史记录」列表。
 */
export function sessionHasContent(session: { messageCount?: number; turnCount?: number }): boolean {
  return (
    (typeof session.messageCount === "number" && session.messageCount > 0) ||
    (typeof session.turnCount === "number" && session.turnCount > 0)
  );
}

/**
 * cwd 是否落在 root 目录内（含等于）。跨平台：统一分隔符并去尾部斜杠后做前缀比较，
 * 与 sidecar host.ts 的 sessionWithinRoot 语义一致（项目隔离的展示分组依据）。
 */
export function cwdWithinRoot(cwd: string | undefined, root: string | undefined): boolean {
  if (!cwd || !root) return false;
  const normalize = (p: string) => {
    const flat = p.replace(/\\/g, "/").replace(/\/+$/, "");
    return flat || "/";
  };
  const dir = normalize(cwd);
  const base = normalize(root);
  return dir === base || dir.startsWith(`${base}/`);
}

type SessionLike = { id?: string; cwd?: string; messageCount?: number; turnCount?: number };
type ProjectLike = { id: string; root: string };

/**
 * 未归属任何项目的会话（中立工作区的游离对话）：cwd 不落在任何已登记项目根内。
 * 项目分组已退役（规格 §4.1）——项目会话全部收编进子任务，项目卡不再列 cwd 会话。
 * 自动化运行会话与空壳会话在此剔除，返回值可直接渲染。
 */
export function unscopedSessions<S extends SessionLike, P extends ProjectLike>(
  sessions: readonly S[],
  projects: readonly P[],
): S[] {
  return sessions.filter(
    (session) =>
      sessionHasContent(session) &&
      !isAutomationSessionId(session.id) &&
      !projects.some((project) => cwdWithinRoot(session.cwd, project.root)),
  );
}

type TitleItem = { kind: string; text?: string };

/** 对话列表标题：首条用户消息，否则回退标签名。 */
export function chatTabTitle(tab: { label: string; items: readonly TitleItem[] }): string {
  const first = tab.items.find((item) => item.kind === "user" && typeof item.text === "string" && item.text.trim());
  if (first && typeof first.text === "string") return first.text.replace(/\s+/g, " ").trim().slice(0, 80);
  return tab.label;
}

export function chatTabHasConversation(tab: { items: readonly TitleItem[] }): boolean {
  return tab.items.some((item) => item.kind === "user" || item.kind === "assistant");
}

/** 会话日志详情记录（与 sidecar session-view 的 detailRecords 对齐；唯一定义在 rpc-types）。 */
export type HistoryRecord = SessionDetailRecord;

/** 历史记录映射后的对话流条目（App 侧再包一层 id 成为 ChatItem）。 */
export type HistoryChatItem =
  | {
      kind: "user";
      text: string;
      /** Host 持久化的用户消息 id（`session-view` 从 `user/message` 的 `data.id` 透传）。 */
      clientMessageId?: string;
    }
  | { kind: "thinking"; text: string; roundKey?: number }
  | { kind: "assistant"; text: string; roundKey?: number }
  | {
      kind: "todo";
      /** 结构化待办快照；空数组是合法的空快照。 */
      todos: TodoEntry[];
      roundKey?: number;
      /** 快照所属真实用户回合的持久锚点；旧记录没有时 fail closed。 */
      clientMessageId?: string;
    }
  | {
      kind: "tool";
      name: string;
      callId?: string;
      args?: string;
      command?: string;
      output?: string;
      hasResult: boolean;
      resultMissing?: boolean;
      interrupted?: boolean;
      truncated?: boolean;
      isError?: boolean;
      roundKey?: number;
    }
  | { kind: "note"; text: string };

/**
 * `session.send` 的请求参数。顶层 `clientMessageId` 是本次发送的持久回合锚；
 * `at.clientMessageId` 仅为旧 @ 运行卡的本地展示兼容保留。
 */
export type SessionSendParams = {
  text: string;
  tabId: string;
  clientMessageId: string;
  sessionId?: string;
  modelId?: string;
  skill?: string;
  at?: { name: string; clientMessageId: string };
};

/**
 * 构造一次用户发送的 RPC 参数（`session.send`）。
 *
 * - 顶层 `clientMessageId` 恒为调用方生成的 UUID（`crypto.randomUUID()`）：它是 Host 与
 *   进度面板的持久回合锚，**禁止**用 `String(userMsg.id)`（`allocId()` 刷新后可重复）；
 * - `@` 发送仍带 `at.clientMessageId = String(userItemId)`（仅旧 @ 卡展示兼容），且保持
 *   旧口径优先于 skill；skill / 普通发送不带 `at`。
 */
export function buildSessionSendParams(input: {
  text: string;
  tabId: string;
  clientMessageId: string;
  /** 本条本地 user 条目的数值 id（仅作为 `@` 兼容值）。 */
  userItemId: number;
  sessionId?: string;
  modelId?: string;
  invokedAt?: { name: string; remainder: string };
  invokedSkill?: { name: string; remainder: string };
}): SessionSendParams {
  const text = input.invokedAt ? input.invokedAt.remainder : input.invokedSkill ? input.invokedSkill.remainder : input.text;
  return {
    text,
    tabId: input.tabId,
    clientMessageId: input.clientMessageId,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.modelId ? { modelId: input.modelId } : {}),
    ...(input.invokedAt
      ? { at: { name: input.invokedAt.name, clientMessageId: String(input.userItemId) } }
      : input.invokedSkill
        ? { skill: input.invokedSkill.name }
        : {}),
  };
}

/**
 * 一次 `session.send` 应答后应重放的早到事件。
 *
 * - 真正开始执行的应答重放整份缓冲(顺序不变)；
 * - 排队应答只重放本次 `queueItemId` 的队列事件；仅当本次排队项的
 *   `session/queue-start` 已在缓冲里(它真的开始执行)时，才保留携带本次
 *   `clientMessageId` 的早到 `todo_write`，并让队列开始先于待办重放——
 *   `beginQueuedTurn` 先开回合清 `notStarted`，待办才落得到这一回合；
 * - 未启动(含 `queue-fail`)的应答丢弃本次缓冲。
 *
 * @param sent `session.send` 应答(排队/启动/`queueItemId`)
 * @param buffered 本次发送应答回来之前暂存的事件(按到达顺序)
 * @param pendingClientMessageId 本次发送的持久回合锚
 * @param isQueueControl 只匹配本次排队项的队列事件(start/fail)，由调用点按 `queueItemId` 闭包
 * @returns 重放顺序的事件列表；不重放任何事件时为空数组
 */
export function takeEarlyPendingEvents(
  sent: { waiting: boolean; started: boolean; queueItemId?: string },
  buffered: readonly RpcEvent[],
  pendingClientMessageId: string,
  isQueueControl: (event: RpcEvent) => boolean,
): RpcEvent[] {
  if (sendOpensTurn(sent)) return [...buffered];
  if (!(sent.waiting && sent.queueItemId !== undefined)) return [];
  const queueEvents = buffered.filter(isQueueControl);
  // 本次排队项没有真正开始(只有 queue-fail 或什么都没到)：没有回合可以挂待办。
  if (!queueEvents.some((event) => event.event === "session/queue-start")) return queueEvents;
  const todos = buffered.filter((event) => (
    event.event === "tool/start" && event.name === "todo_write" && event.clientMessageId === pendingClientMessageId
  ));
  return [...queueEvents, ...todos];
}

/**
 * 历史会话记录 → 对话流条目：user/assistant 按原文还原，tool-call 成工具卡，
 * tool-result 按 callId 配对回调用（缺 callId 时只在当前用户回合内按顺序配对）；
 * 配不上的失败结果折叠为一条提示，配不上的成功结果不产出条目。
 * 官方 goal 续轮记录只恢复为与实时 goal/round 同文案的 note，不切分用户回合。
 * `todo_write` 与实时投影一致地恢复为待办卡，并吞掉它自己的工具结果。
 */
export function historyItemsFromRecords(records: readonly HistoryRecord[]): HistoryChatItem[] {
  const items: HistoryChatItem[] = [];
  const todoCallIds = new Set<string>();
  for (const record of records) {
    if (record.kind === "user") {
      if (record.goalRound !== undefined) {
        items.push({ kind: "note", text: goalRoundLabel(record.goalRound) });
      } else {
        items.push({
          kind: "user",
          text: record.text,
          ...(record.clientMessageId === undefined ? {} : { clientMessageId: record.clientMessageId }),
        });
      }
      continue;
    }
    if (record.kind === "thinking") {
      items.push({ kind: "thinking", text: record.text, ...(record.roundKey === undefined ? {} : { roundKey: record.roundKey }) });
      continue;
    }
    if (record.kind === "assistant") {
      items.push({ kind: "assistant", text: record.text, ...(record.roundKey === undefined ? {} : { roundKey: record.roundKey }) });
      continue;
    }
    if (record.kind === "tool-call") {
      if (record.name === "todo_write") {
        // 坏参数只留安全提示，不展开原始参数；坏条目已由宿主逐条过滤过。
        if (!Array.isArray(record.todos)) {
          items.push({ kind: "note", text: "历史待办无法解析" });
        } else {
          items.push({
            kind: "todo",
            todos: record.todos,
            ...(record.roundKey === undefined ? {} : { roundKey: record.roundKey }),
            ...(record.clientMessageId === undefined ? {} : { clientMessageId: record.clientMessageId }),
          });
        }
        if (record.callId !== undefined) todoCallIds.add(record.callId);
        continue;
      }
      items.push({
        kind: "tool",
        name: record.name || "tool",
        ...(record.roundKey === undefined ? {} : { roundKey: record.roundKey }),
        ...(record.callId ? { callId: record.callId } : {}),
        ...(record.args === undefined ? {} : { args: record.args }),
        ...(record.command === undefined ? {} : { command: record.command }),
        hasResult: false,
        resultMissing: true,
      });
      continue;
    }

    // 待办卡已吸收本次调用的结果：不再生成第二条待办，也不留孤儿工具失败提示。
    if (record.callId !== undefined && todoCallIds.has(record.callId)) continue;
    let turnStart = 0;
    for (let index = items.length - 1; index >= 0; index -= 1) {
      if (items[index]?.kind === "user") {
        turnStart = index + 1;
        break;
      }
    }
    let match = -1;
    if (record.callId) {
      match = items.findIndex((item) => item.kind === "tool" && item.callId === record.callId && item.hasResult === false);
    } else {
      match = items.findIndex((item, index) => index >= turnStart && item.kind === "tool" && item.hasResult === false);
    }
    if (match >= 0) {
      const tool = items[match];
      if (tool?.kind !== "tool") continue;
      if (record.synthetic === "hidden") continue;
      items[match] = record.synthetic === "interrupted"
        ? {
            ...tool,
            output: undefined,
            hasResult: false,
            resultMissing: undefined,
            interrupted: true,
            isError: undefined,
            truncated: undefined,
          }
        : record.synthetic === "resultMissing"
          ? {
              ...tool,
              output: undefined,
              hasResult: false,
              resultMissing: true,
              interrupted: undefined,
              isError: undefined,
              truncated: undefined,
            }
          : {
              ...tool,
              output: record.text,
              hasResult: true,
              resultMissing: undefined,
              interrupted: undefined,
              ...(record.truncated === true ? { truncated: true } : {}),
              ...(record.isError ? { isError: true } : {}),
            };
    } else if (record.isError && record.synthetic === undefined) {
      const text = record.text.replace(/\s+/g, " ").trim().slice(0, 200);
      items.push({ kind: "note", text: `工具调用失败：${text || "未知错误"}` });
    }
  }
  return items;
}
