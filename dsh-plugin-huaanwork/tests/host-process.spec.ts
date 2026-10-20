import { EventEmitter } from 'node:events'
import { expect, it, vi } from 'vitest'
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import type { DesktopStartupGenerationHost } from '../src/startup-generation.ts'
import type { HostRpc } from '../src/host-rpc.ts'
import { HOST_LIVENESS_STOP_CHANNEL, HOST_LIVENESS_TURNS_CHANNEL } from '../src/huaanwork-host/host-liveness.ts'
const state = vi.hoisted(() => ({ fork: vi.fn() }))
vi.mock('electron', () => ({ utilityProcess: { fork: state.fork } }))
import {
  beginHostLiveness, formatUnexpectedHostExit, HOST_STDERR_TAIL_CHARS, startIsolatedDesktopHost,
  type ElectronLivenessApi, type IsolatedHostExit, type IsolatedHostOptions,
} from '../src/host-process.ts'

function fixture() {
  const child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(), stderr: new EventEmitter(),
    postMessage: vi.fn((message: { kind: string; id: number; method?: string }) => {
      if (message.kind === 'call') queueMicrotask(() => child.emit('message', { kind: 'result', id: message.id, value: { pid: 123 } }))
    }),
    kill: vi.fn(() => { queueMicrotask(() => child.emit('exit', 0)); return true }),
  })
  state.fork.mockReturnValue(child)
  let host!: DesktopStartupGenerationHost
  const onFailure = vi.fn()
  const options = {
    host: { desktopLaunchEnvironment: createLaunchEnvironmentSnapshot([]) },
    runtime: { platform: 'win32', locale: 'en', updates: { currentVersion: '2.0.7-beta.1' } },
    rendererToken: 'fixture', prepareCertificate: async () => ({ failureCode: 'fixture' }),
    bindHost: (value: DesktopStartupGenerationHost) => { host = value }, requestQuit() {}, onFailure,
  } as unknown as IsolatedHostOptions
  return { child, options, onFailure, host: () => host }
}

/** The Electron surface the liveness probe normally gets from `require('electron')`. */
function livenessHarness(dialogResponse: number) {
  const handlers = new Map<string, (...args: never[]) => unknown>()
  const listeners = new Map<string, (...args: never[]) => unknown>()
  const published: { phase: string; turns: number }[] = []
  const send = vi.fn((_channel: string, payload: { phase: string; turns: number }) => {
    published.push(payload)
  })
  const api = {
    ipcMain: {
      on(channel: string, listener: (...args: never[]) => unknown) { listeners.set(channel, listener) },
      handle(channel: string, listener: (...args: never[]) => unknown) { handlers.set(channel, listener) },
      removeListener(channel: string, listener: (...args: never[]) => unknown) {
        if (listeners.get(channel) === listener) listeners.delete(channel)
      },
      removeHandler(channel: string) { handlers.delete(channel) },
      removeAllListeners(channel: string) { listeners.delete(channel) },
    },
    dialog: { showMessageBox: vi.fn(async () => ({ response: dialogResponse })) },
    BrowserWindow: {
      getAllWindows: () => [{ isDestroyed: () => false, webContents: { send } }],
    },
  } as unknown as ElectronLivenessApi
  // Every status probe misses: after 60 s with a live turn the Host is stoppable.
  const rpc = { call: vi.fn(() => Promise.reject(new Error('probe missed'))) } as unknown as HostRpc
  const child = { kill: vi.fn(() => true) }
  const onUserStop = vi.fn()
  return {
    api, rpc, child, onUserStop, published, send,
    reportTurns: (turns: number) =>
      (listeners.get(HOST_LIVENESS_TURNS_CHANNEL) as ((event: unknown, turns: number) => void) | undefined)?.({}, turns),
    stop: () => (handlers.get(HOST_LIVENESS_STOP_CHANNEL) as (() => Promise<boolean>) | undefined)?.(),
  }
}
it('binds the child before startup and makes repeated teardown idempotent', async () => {
  const f = fixture()
  await startIsolatedDesktopHost(f.options)
  await Promise.all([f.host().fiber.dispose(), f.host().fiber.dispose()])
  expect(f.child.kill).toHaveBeenCalledOnce()
  expect(f.onFailure).not.toHaveBeenCalled()
  expect(f.child.postMessage.mock.calls.filter(([m]) => m.method === 'stop')).toHaveLength(1)
})
it('reports unexpected Host exit without automatically relaunching or replaying work', async () => {
  const f = fixture()
  await startIsolatedDesktopHost(f.options)
  f.child.emit('exit', 9)
  expect(f.onFailure).toHaveBeenCalledOnce()
  await f.host().fiber.dispose()
  expect(f.child.kill).not.toHaveBeenCalled()
})
it('carries the exit code and how long the Host lived, so a code 0 is not read as a clean exit', async () => {
  const f = fixture()
  await startIsolatedDesktopHost(f.options)
  f.child.emit('exit', 0)
  const [error, exit] = f.onFailure.mock.calls[0] as [Error, { exitCode: number; uptimeMs: number }]
  expect(error.message).toContain('DSH Host exited (0)')
  expect(exit.exitCode).toBe(0)
  expect(exit.uptimeMs).toBeGreaterThanOrEqual(0)
  expect(Number.isFinite(exit.uptimeMs)).toBe(true)
})
it('leaves a Desktop-requested teardown off the unexpected-exit record', async () => {
  const f = fixture()
  await startIsolatedDesktopHost(f.options)
  await f.host().fiber.dispose()
  expect(f.onFailure).not.toHaveBeenCalled()
})
it('keeps what a fatal Host said last, since its stderr is otherwise never persisted', async () => {
  const f = fixture()
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  try {
    await startIsolatedDesktopHost(f.options)
    f.child.stderr.emit('data', Buffer.from('x'.repeat(HOST_STDERR_TAIL_CHARS)))
    // A multibyte character split across two chunks must not turn into replacement characters.
    const euro = Buffer.from('€')
    f.child.stderr.emit('data', Buffer.concat([Buffer.from('dsh: fatal load failure: boom '), euro.subarray(0, 1)]))
    f.child.stderr.emit('data', euro.subarray(1))
    f.child.emit('exit', 1)
  } finally { vi.restoreAllMocks() }
  const [error, exit] = f.onFailure.mock.calls[0] as [Error, IsolatedHostExit]
  expect(exit.stderrTail).toHaveLength(HOST_STDERR_TAIL_CHARS)
  expect(exit.stderrTail.endsWith('dsh: fatal load failure: boom €')).toBe(true)
  expect(formatUnexpectedHostExit(error, exit))
    .toBe(`DSH Host exited (1); restart the application to reconnect\nLast DSH Host stderr:\n${exit.stderrTail}`)
})
it('logs only the exit reason when the Host wrote nothing', () => {
  const error = new Error('DSH Host exited (0); restart the application to reconnect')
  expect(formatUnexpectedHostExit(error, { exitCode: 0, uptimeMs: 1, stderrTail: '\n' })).toBe(error.message)
})
it('marks a confirmed liveness stop before killing the Host', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
  try {
    const h = livenessHarness(0)
    const dispose = beginHostLiveness(h.rpc, h.child, h.onUserStop, h.api)
    h.reportTurns(1)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(await h.stop()).toBe(true)
    expect(h.onUserStop).toHaveBeenCalledOnce()
    expect(h.child.kill).toHaveBeenCalledOnce()
    // The exit handler reads this flag asynchronously; marking after kill() would race it.
    expect(h.onUserStop.mock.invocationCallOrder[0]).toBeLessThan(
      h.child.kill.mock.invocationCallOrder[0]!,
    )
    // The focused window never sees notifyAttention: the neutral phase must reach it
    // before the kill, or it keeps the unresponsive banner with a dead stop button.
    expect(h.published.at(-1)).toEqual({ phase: 'stopped', turns: 1 })
    expect(h.send.mock.invocationCallOrder.at(-1)!).toBeLessThan(
      h.child.kill.mock.invocationCallOrder[0]!,
    )
    dispose()
  } finally {
    vi.useRealTimers()
  }
})
it('dispatches a confirmed liveness stop to onStoppedByUser instead of onFailure', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
  try {
    const f = fixture()
    const h = livenessHarness(0)
    const onStoppedByUser = vi.fn()
    f.options.onStoppedByUser = onStoppedByUser
    f.options.livenessApi = h.api
    await startIsolatedDesktopHost(f.options)
    // The fixture answers every RPC, so silence the status probe: without an answer
    // the liveness state must reach stoppable after 60 s with a live turn.
    f.child.postMessage.mockImplementation(() => {})
    h.reportTurns(1)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(await h.stop()).toBe(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(onStoppedByUser).toHaveBeenCalledOnce()
    expect(f.onFailure).not.toHaveBeenCalled()
    expect(h.published.at(-1)).toEqual({ phase: 'stopped', turns: 1 })
    await f.host().fiber.dispose()
  } finally {
    vi.useRealTimers()
  }
})
it('keeps the Host alive when the liveness stop is cancelled', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
  try {
    const h = livenessHarness(1)
    const dispose = beginHostLiveness(h.rpc, h.child, h.onUserStop, h.api)
    h.reportTurns(1)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(await h.stop()).toBe(false)
    expect(h.onUserStop).not.toHaveBeenCalled()
    expect(h.child.kill).not.toHaveBeenCalled()
    dispose()
  } finally {
    vi.useRealTimers()
  }
})
