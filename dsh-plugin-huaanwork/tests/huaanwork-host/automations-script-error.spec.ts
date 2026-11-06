/**
 * P-2: `runScript` 只在 spawn 本身失败时按启动失败结算。spawn 成功之后的 `error`
 * (公认场景是 kill 失败)不代表进程已结束,必须等 `close` 才完成 —— 否则
 * `executeRun` 的 `finally` 会在进程仍写目录时释放脚本槽位/准入根。
 */
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { expect, test, vi } from 'vitest'

import { runScript, scriptRunKillers } from '../../src/huaanwork-host/automations-host.ts'

const childProcess = vi.hoisted(() => {
  const spawned: unknown[] = []
  let next: unknown
  return {
    spawned,
    setNext(child: unknown) {
      next = child
    },
    spawn: vi.fn(() => {
      spawned.push(next)
      return next
    }),
  }
})

// 只替换 spawn:自动化脚本必须由假子进程驱动,真实 spawn 仍留给其它模块。
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawn: childProcess.spawn }
})

/** 事件形状对齐 `ChildProcess`:`pid` 为 `undefined` 即 spawn 失败。 */
class FakeChild extends EventEmitter {
  readonly stdout = new EventEmitter()
  readonly stderr = new EventEmitter()
  readonly kill = vi.fn()
  readonly unref = vi.fn()
  pid: number | undefined

  constructor(pid: number | undefined) {
    super()
    this.pid = pid
  }
}

test('a post-spawn error waits for close before the run finishes', async () => {
  const child = new FakeChild(4242)
  childProcess.setNext(child)
  const runId = 'run-error-after-spawn'
  const run = runScript('echo ok', tmpdir(), 60_000, runId)
  const settled: Array<{ ok: boolean; output: string; timedOut: boolean }> = []
  void run.then((result) => settled.push(result))

  child.stdout.emit('data', Buffer.from('ok\n'))
  // 进程仍在跑(kill 失败是文档场景):此时不得结算,也不得摘掉 kill 句柄。
  child.emit('error', new Error('kill EPERM'))
  await new Promise((resolve) => setImmediate(resolve))
  expect(settled).toHaveLength(0)
  expect(scriptRunKillers.has(runId)).toBe(true)

  child.emit('close', 1)
  const result = await run
  expect(result.ok).toBe(false)
  expect(result.timedOut).toBe(false)
  expect(result.output).toContain('ok')
  expect(result.output).toContain('kill EPERM')
  expect(result.output).toContain('（退出码 1）')
  expect(scriptRunKillers.has(runId)).toBe(false)
})

test('a spawn failure finishes immediately, without waiting for close', async () => {
  const child = new FakeChild(undefined)
  childProcess.setNext(child)
  const run = runScript('echo ok', tmpdir(), 60_000)
  const settled: Array<{ ok: boolean; output: string; timedOut: boolean }> = []
  void run.then((result) => settled.push(result))

  child.emit('error', new Error('spawn bash ENOENT'))
  await new Promise((resolve) => setImmediate(resolve))
  expect(settled).toHaveLength(1)
  expect(settled[0]?.ok).toBe(false)
  expect(settled[0]?.timedOut).toBe(false)
  expect(settled[0]?.output).toContain('spawn bash ENOENT')
})
