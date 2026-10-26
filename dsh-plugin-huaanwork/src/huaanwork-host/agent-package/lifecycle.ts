/**
 * per-slug 生命周期门禁(Task 8 / I-11)。
 *
 * 一次安装/更新/移除交易从**停止在途回合之前**占住 slug,直到 rename 与
 * state 提交全部结束;期间的同 slug `@slug` dispatch 与第二次交易都以
 * 「正在<label>」拒绝。只用 slug 作键:不同智能体的安装/更新可以并行。
 */
export type AgentPackageLifecycleLock = {
  /** 该 slug 是否有安装/更新/移除交易在途。 */
  isBusy(slug: string): boolean
  /**
   * 占用 slug 跑 `fn`;已被占用时立即拒绝。
   *
   * `finally` 只释放仍由本次调用持有的槽位,晚到的释放不会抹掉更新的持有者。
   */
  run<T>(slug: string, label: string, fn: () => Promise<T>): Promise<T>
}

/** @returns 一个共享的 per-slug 生命周期门禁(index 只建一个) */
export function createAgentPackageLifecycleLock(): AgentPackageLifecycleLock {
  const busy = new Map<string, string>()
  return {
    isBusy: (slug) => busy.has(slug),
    async run(slug, label, fn) {
      const current = busy.get(slug)
      if (current !== undefined) throw new Error(`智能体「${slug}」正在${current}，请稍后重试`)
      busy.set(slug, label)
      try {
        return await fn()
      } finally {
        if (busy.get(slug) === label) busy.delete(slug)
      }
    },
  }
}
