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

function fixture(pids: number[] = [123]) {
  const children = pids.map(pid => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(), stderr: new EventEmitter(),
      postMessage: vi.fn((message: { kind: string; id: number; method?: string }) => {
        if (message.kind === 'call') queueMicrotask(() => child.emit('message', { kind: 'result', id: message.id, value: { pid } }))
      }),
      kill: vi.fn(() => { queueMicrotask(() => child.emit('exit', 0)); return true }),
    })
    return child
  })
  const child = children[0]!
  state.fork.mockReset()
  state.fork.mockImplementation(() => children[Math.min(state.fork.mock.calls.length - 1, children.length - 1)])
  let host!: DesktopStartupGenerationHost
  const onFailure = vi.fn()
  const options = {
    host: { desktopLaunchEnvironment: createLaunchEnvironmentSnapshot([]) },
    runtime: { platform: 'win32', locale: 'en', updates: { currentVersion: '2.0.7-beta.1' } },
    rendererToken: 'fixture', prepareCertificate: async () => ({ failureCode: 'fixture' }),
    bindHost: (value: DesktopStartupGenerationHost) => { host = value }, requestQuit() {}, onFailure,
  } as unknown as IsolatedHostOptions
  return { child, children, options, onFailure, host: () => host }
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
    api, rpc, child, onUserStop, published, send, handlers,
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

const ACCEPTANCE_HOST_RESTART_CHANNEL = 'huaanwork:acceptance-host-restart'

function adoptionHarness(options: IsolatedHostOptions) {
  const adoption = {
    beginHostShellAdoption: vi.fn(),
    completeHostShellAdoption: vi.fn(),
    cancelHostShellAdoption: vi.fn(),
  }
  options.runtime = { ...options.runtime, ...adoption }
  return adoption
}

it('replaces the Host once for concurrent acceptance restarts and disposes the newest child', async () => {
  vi.stubEnv('HUAANWORK_ACCEPTANCE_HOOKS', '1')
  try {
    const f = fixture([123, 456, 789])
    const h = livenessHarness(1)
    f.options.livenessApi = h.api
    const adoption = adoptionHarness(f.options)
    await startIsolatedDesktopHost(f.options)
    const restart = h.handlers.get(ACCEPTANCE_HOST_RESTART_CHANNEL) as () => Promise<{ oldPid: number; newPid: number }>
    expect(restart).toBeTypeOf('function')

    const [first, concurrent] = await Promise.all([restart(), restart()])
    expect(first).toEqual({ oldPid: 123, newPid: 456 })
    expect(concurrent).toEqual(first)
    expect(state.fork).toHaveBeenCalledTimes(2)
    expect(adoption.beginHostShellAdoption).toHaveBeenCalledOnce()
    expect(adoption.completeHostShellAdoption).toHaveBeenCalledOnce()
    expect(f.onFailure).not.toHaveBeenCalled()

    await expect(restart()).resolves.toEqual({ oldPid: 456, newPid: 789 })
    expect(state.fork).toHaveBeenCalledTimes(3)
    await f.host().fiber.dispose()
    expect(f.children[2]!.kill).toHaveBeenCalledOnce()
    expect(h.handlers.has(ACCEPTANCE_HOST_RESTART_CHANNEL)).toBe(false)
    await expect(restart()).rejects.toThrow('disposed')
  } finally {
    vi.unstubAllEnvs()
  }
})

it.each(['boot', 'adoption'] as const)('preserves final cleanup after a new Host %s failure without retrying', async failure => {
  vi.stubEnv('HUAANWORK_ACCEPTANCE_HOOKS', '1')
  try {
    const f = fixture([123, 456])
    const h = livenessHarness(1)
    f.options.livenessApi = h.api
    const adoption = adoptionHarness(f.options)
    if (failure === 'adoption') adoption.completeHostShellAdoption.mockImplementation(() => { throw new Error('adoption refused') })
    if (failure === 'boot') {
      f.children[1]!.postMessage.mockImplementation(message => {
        if (message.kind !== 'call') return
        queueMicrotask(() => f.children[1]!.emit('message', message.method === 'boot'
          ? { kind: 'result', id: message.id, error: 'boot refused' }
          : { kind: 'result', id: message.id, value: { pid: 456 } }))
      })
    }
    await startIsolatedDesktopHost(f.options)
    const restart = h.handlers.get(ACCEPTANCE_HOST_RESTART_CHANNEL) as () => Promise<unknown>
    await expect(restart()).rejects.toThrow(failure === 'boot' ? 'boot refused' : 'adoption refused')
    expect(state.fork).toHaveBeenCalledTimes(2)
    expect(adoption.cancelHostShellAdoption).toHaveBeenCalled()
    expect(f.onFailure).toHaveBeenCalledOnce()

    await f.host().fiber.dispose()
    expect(f.children[1]!.kill).toHaveBeenCalledOnce()
    expect(state.fork).toHaveBeenCalledTimes(2)
  } finally {
    vi.unstubAllEnvs()
  }
})

it('clears the single-flight latch when adoption arming fails', async () => {
  vi.stubEnv('HUAANWORK_ACCEPTANCE_HOOKS', '1')
  try {
    const f = fixture([123, 456])
    const h = livenessHarness(1)
    f.options.livenessApi = h.api
    await startIsolatedDesktopHost(f.options)
    const restart = h.handlers.get(ACCEPTANCE_HOST_RESTART_CHANNEL) as () => Promise<{ oldPid: number; newPid: number }>
    await expect(restart()).rejects.toThrow('adoption support')

    adoptionHarness(f.options)
    await expect(restart()).resolves.toEqual({ oldPid: 123, newPid: 456 })
    expect(state.fork).toHaveBeenCalledTimes(2)
    await f.host().fiber.dispose()
  } finally {
    vi.unstubAllEnvs()
  }
})

it('keeps final cleanup available when the old Host does not confirm termination', async () => {
  vi.stubEnv('HUAANWORK_ACCEPTANCE_HOOKS', '1')
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
  try {
    const f = fixture([123, 456])
    const h = livenessHarness(1)
    f.options.livenessApi = h.api
    const adoption = adoptionHarness(f.options)
    f.children[0]!.kill.mockImplementation(() => true)
    await startIsolatedDesktopHost(f.options)
    const restart = h.handlers.get(ACCEPTANCE_HOST_RESTART_CHANNEL) as () => Promise<unknown>
    const pending = restart()
    await vi.advanceTimersByTimeAsync(1_000)
    await expect(pending).rejects.toThrow('termination was not confirmed')
    expect(state.fork).toHaveBeenCalledOnce()
    expect(adoption.cancelHostShellAdoption).toHaveBeenCalled()
    expect(f.onFailure).not.toHaveBeenCalled()

    await f.host().fiber.dispose()
    expect(state.fork).toHaveBeenCalledOnce()
  } finally {
    vi.useRealTimers()
    vi.unstubAllEnvs()
  }
})

it('registers no acceptance restart handler when the master gate is off', async () => {
  vi.stubEnv('HUAANWORK_ACCEPTANCE_HOOKS', '0')
  try {
    const f = fixture()
    const h = livenessHarness(1)
    f.options.livenessApi = h.api
    await startIsolatedDesktopHost(f.options)
    expect(h.handlers.has(ACCEPTANCE_HOST_RESTART_CHANNEL)).toBe(false)
    expect(state.fork).toHaveBeenCalledOnce()
    await f.host().fiber.dispose()
  } finally {
    vi.unstubAllEnvs()
  }
})
