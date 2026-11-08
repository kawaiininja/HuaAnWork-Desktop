/**
 * 单个标签的回合执行状态。每个标签各持一份，不再用进程级的「有没有回合」表示。
 * `waitingIds` 记的是本标签上已应答排队、还没开始执行的 `queueItemId`。
 */
export type TabRunState = { running: boolean; waitingIds: string[] };

/** 本次 `session.send` 应答是否开启了回合：只有非排队且真的开始执行才算。 */
export function sendOpensTurn(result: { waiting: boolean; started: boolean }): boolean {
  return !result.waiting && result.started;
}

/**
 * 应用一次 `session.send` 应答：开启回合时置 `running`，排队时只追加 `queueItemId`，
 * 未开始（`started: false`）时原样返回。开启回合不清除已有的等待项。
 *
 * @param state 该标签当前的回合状态
 * @param result 宿主应答；`queueItemId` 只在 `waiting` 时存在
 * @returns 更新后的状态；无需变化时返回入参本身
 */
export function noteSendResult(
  state: TabRunState,
  result: { waiting: boolean; started: boolean; queueItemId?: string },
): TabRunState {
  if (result.waiting && result.queueItemId !== undefined) {
    return { running: state.running, waitingIds: [...state.waitingIds, result.queueItemId] };
  }
  if (!sendOpensTurn(result)) return state;
  return { running: true, waitingIds: state.waitingIds };
}

/** 回合结束：只清 `running`，排队项要等各自的 queue-start/queue-fail 收尾。 */
export function noteTurnEnded(state: TabRunState): TabRunState {
  return state.running ? { running: false, waitingIds: state.waitingIds } : state;
}

/** 排队的消息开始执行：去掉它的等待、把标签置回执行中。 */
export function noteWaitingStarted(state: TabRunState, queueItemId: string): TabRunState {
  return { running: true, waitingIds: withoutWaiting(state.waitingIds, queueItemId) };
}

/** 排队项被取消：只去掉这一条等待，正在执行的回合不受影响。 */
export function noteWaitingCancelled(state: TabRunState, queueItemId: string): TabRunState {
  return withoutWaitingOrSame(state, queueItemId);
}

/** 排队项启动失败：同取消，只去掉这一条等待，不改 `running`。 */
export function noteWaitingFailed(state: TabRunState, queueItemId: string): TabRunState {
  return withoutWaitingOrSame(state, queueItemId);
}

/**
 * 用户消息是否还没成为活动回合：等待中（带 `queueItemId`）、本次 RPC 已抛错
 * （`sendRejected`）或没有启动过（`notStarted`——宿主应答 `started: false`，
 * 以及排队项出队失败、被用户取消）。这些都不参与「最新用户消息」的选择，
 * 也不承载回合终态。
 *
 * @param item 任意带这三个可选字段的对话条目
 * @returns 该条消息不是可结算的用户回合
 */
export function isUnstartedUserItem(item: { queueItemId?: string; sendRejected?: boolean; notStarted?: boolean }): boolean {
  return item.queueItemId !== undefined || item.sendRejected === true || item.notStarted === true;
}

/**
 * 等待项离开等待状态后，它挂的那条用户消息的下一步。
 *
 * 出队并真正开始执行时只去掉 `queueItemId`——这条消息成为活动回合；出队失败或用户
 * 取消时消息留在列表里（原因由脚注承担），但必须同时标 `notStarted`：它没有成为活动
 * 回合，不能再去抢上一回合的终态与 outcome。
 *
 * @param item 挂着 `queueItemId` 的用户消息
 * @param started 该等待项是否真的开始执行
 * @returns 去掉等待项后的消息；`started` 为 false 时同时带 `notStarted: true`
 */
export function releaseWaitingItem<T extends { queueItemId?: string; notStarted?: boolean }>(
  item: T,
  started: boolean,
): T {
  return { ...item, queueItemId: undefined, ...(started ? {} : { notStarted: true }) };
}

/**
 * 按标签保存 git diff：只写拥有该会话的标签，绝不落到当前正在查看的标签上。
 * 没有标签 id 时原样返回——客户端不猜是哪个标签。
 *
 * @param diffs 标签 id → diff 文本
 * @param tabId 该 diff 所属会话绑定的标签；未知时为 undefined
 * @param text 新的 diff 文本
 * @returns 更新后的映射；无需写入时返回入参本身
 */
export function noteDiffForTab(
  diffs: Readonly<Record<string, string>>,
  tabId: string | undefined,
  text: string,
): Record<string, string> {
  if (tabId === undefined) return diffs as Record<string, string>;
  if (diffs[tabId] === text) return diffs as Record<string, string>;
  return { ...diffs, [tabId]: text };
}

function withoutWaiting(waitingIds: readonly string[], queueItemId: string): string[] {
  return waitingIds.includes(queueItemId) ? waitingIds.filter((id) => id !== queueItemId) : [...waitingIds];
}

function withoutWaitingOrSame(state: TabRunState, queueItemId: string): TabRunState {
  if (!state.waitingIds.includes(queueItemId)) return state;
  return { running: state.running, waitingIds: state.waitingIds.filter((id) => id !== queueItemId) };
}

/**
 * `session.new` 铸造失败时给用户看哪一句。两种归属都不发送(设计 D2):
 * 中立标签显示真实错误——目录建不出来这件事必须可见;项目标签沿用
 * `App.tsx` 既有守卫那一句,避免同一种失败出现两种措辞。
 * 只做判定,不做副作用:调用方负责 noteActive 与 return。
 */
export function sessionMintFailureNote(input: {
  error: unknown;
  tabProjectId: string | null | undefined;
}): string {
  if (input.tabProjectId != null) return "子任务会话尚未就绪，消息未发送。请重试。";
  return input.error instanceof Error ? input.error.message : String(input.error);
}
