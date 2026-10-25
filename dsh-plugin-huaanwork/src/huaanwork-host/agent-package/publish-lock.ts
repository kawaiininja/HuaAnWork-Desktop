/**
 * per-profile/per-slug 发布锁(Task 10 / I-15、I-16)。
 *
 * `publishLocalAgentPackage` 与 `commitAgentPackage` 必须共用同一把锁:
 * - 上传在飞时内容不能被 commit 改写,否则旧内容的 submissionId 会落到新版本;
 * - commit 的「写包 + 发布状态复位」对同 slug 的 publish 原子,重试不会交错。
 *
 * 键是 `profileDir + slug`(不同 profile、不同智能体可并行);队列尾部只保留
 * 最新一个 promise,结束时清理,长时间运行不会积累条目。同进程单实例即可
 * 覆盖本产品的写入方(宿主是唯一写者);跨进程写同一 profile 不在锁的范围内。
 */
export type AgentPackagePublishLock = {
  run<T>(profileDir: string, slug: string, fn: () => Promise<T>): Promise<T>
}

export function createAgentPackagePublishLock(): AgentPackagePublishLock {
  const tails = new Map<string, Promise<unknown>>()
  return {
    async run(profileDir, slug, fn) {
      const key = `${profileDir}\0${slug}`
      const previous = tails.get(key) ?? Promise.resolve()
      const run = previous.then(fn, fn)
      const tail = run.then(
        () => undefined,
        () => undefined,
      )
      tails.set(key, tail)
      void tail.finally(() => {
        if (tails.get(key) === tail) tails.delete(key)
      })
      return run
    },
  }
}

/**
 * 唯一实例。publish 与 commit 都从这里取锁,不能各自 `create` 一份。
 */
export const agentPackagePublishLock = createAgentPackagePublishLock()
