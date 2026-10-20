export type StopTicket = {
  readonly id: number;
  readonly sessionId: string;
  readonly epoch: number;
};

export type StaleIdle = {
  readonly sessionId: string;
  readonly epoch: number;
};

/** 取消请求还在飞时，这个会话的结束先搁下，等取消成功或失败再处理。 */
export function isStopPending(pending: StopTicket | null, eventSessionId: string | undefined): boolean {
  return pending !== null && eventSessionId === pending.sessionId;
}

/** 同一次发送里，取消还没返回时不再接受第二次停止。 */
export function canStartStop(pending: StopTicket | null): boolean {
  return pending === null;
}

/**
 * 取消返回之后才决定要不要扣上停止闩锁。
 * 这张票据已经不是在飞的那张，或用户已经发出了更新的一轮，都不能扣。
 * 失败只清这张票据自己扣上的闩锁。
 * 轮次已经前进时，记下这次停止，后面那条旧的空闲结束要丢掉。
 */
export function finishStop(input: {
  ticket: StopTicket;
  pending: StopTicket | null;
  currentEpoch: number;
  ok: boolean;
  latchOwner: number | null;
}): { pending: StopTicket | null; arm: boolean; clearLatch: boolean; note: boolean; stale: StaleIdle | null } {
  const ownsPending = input.pending?.id === input.ticket.id;
  const sameTurn = ownsPending && input.ticket.epoch === input.currentEpoch;
  if (input.ok && sameTurn) {
    return {
      pending: null,
      arm: true,
      clearLatch: false,
      note: false,
      stale: { sessionId: input.ticket.sessionId, epoch: input.ticket.epoch },
    };
  }
  const epochMoved = ownsPending && input.ticket.epoch !== input.currentEpoch;
  return {
    pending: ownsPending ? null : input.pending,
    arm: false,
    clearLatch: !input.ok && input.latchOwner === input.ticket.id,
    note: !input.ok && sameTurn,
    stale: epochMoved ? { sessionId: input.ticket.sessionId, epoch: input.ticket.epoch } : null,
  };
}

/** 未消化的停止可以有多条。新的一次取消追加，不覆盖更早的那条。 */
export function rememberStale(existing: readonly StaleIdle[], next: StaleIdle | null): StaleIdle[] {
  return next ? [...existing, next] : [...existing];
}

/**
 * 同一会话上，只要还有落后于当前轮次的停止标记，这条结束就属于旧回合。
 * 取消标记的结束不删标记；空闲结束只删最旧的一条。
 * 标记的轮次仍是当前轮时照常处理，空闲结束才把它用掉。
 */
export function consumeStaleIdle(
  stale: readonly StaleIdle[],
  event: { sessionId?: string; cancelled?: boolean },
  currentEpoch: number,
): { drop: boolean; stale: StaleIdle[] } {
  const index = stale.findIndex((item) => item.sessionId === event.sessionId);
  if (index < 0) return { drop: false, stale: [...stale] };
  const marker = stale[index];
  if (!marker) return { drop: false, stale: [...stale] };
  if (currentEpoch === marker.epoch) {
    if (event.cancelled) return { drop: false, stale: [...stale] };
    const next = stale.slice();
    next.splice(index, 1);
    return { drop: false, stale: next };
  }
  if (event.cancelled) return { drop: true, stale: [...stale] };
  const next = stale.slice();
  next.splice(index, 1);
  return { drop: true, stale: next };
}

/** 只取出这次取消对应的结束事件，其它会话的仍留在队列里。 */
export function takeHeldEnds<T extends { sessionId?: string }>(
  held: readonly T[],
  sessionId: string,
): { taken: T[]; rest: T[] } {
  const taken: T[] = [];
  const rest: T[] = [];
  for (const event of held) {
    if (event.sessionId === sessionId) taken.push(event);
    else rest.push(event);
  }
  return { taken, rest };
}
