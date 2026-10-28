/** Electron owns the child lifetime; the child owns the unchanged DSH Web server. */
import { serializeHostEnvironment } from './host-launch-environment.ts'
import { utilityProcess, type IpcMainEvent } from 'electron'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { StringDecoder } from 'node:string_decoder'
import { HostRpc } from './host-rpc.ts'
import {
  createHostExitGate,
  HOST_LIVENESS_CHANNEL,
  HOST_LIVENESS_READ_CHANNEL,
  HOST_LIVENESS_STOP_CHANNEL,
  HOST_LIVENESS_TURNS_CHANNEL,
  probeAnswered,
  reduceLiveness,
  type Liveness,
} from './huaanwork-host/host-liveness.ts'
import { bindNativeRuntime, runtimeSnapshot, type HostNativeRuntimeBinding } from './host-runtime-bridge.ts'
import { acceptanceHooksEnabled } from './huaanwork-host/acceptance-hooks.ts'
import {
  ACCEPTANCE_HOST_RESTART_CHANNEL,
  type AcceptanceHostRestartResult,
  type HostShellAdoptionRuntime,
} from './huaanwork-host/acceptance-host-restart.ts'
import type { DesktopHostOptions } from './host-bootstrap.ts'
import type { DesktopRuntime } from './runtime.ts'
import type { DesktopStartupGenerationHost } from './startup-generation.ts'
import type { DesktopLanHttpsRuntimeOptions } from './lan-https-runtime.ts'

export interface IsolatedHostOptions {
  host: DesktopHostOptions
  runtime: DesktopRuntime
  rendererToken: string
  prepareCertificate: NonNullable<DesktopLanHttpsRuntimeOptions['prepareCertificate']>
  bindHost(host: DesktopStartupGenerationHost): void
  requestQuit(code: number): void
  onFailure(error: Error, exit: IsolatedHostExit): void
  /**
   * The liveness dialog's confirmed stop ended the Host. Neutral by design: no
   * recovery dialog and no automatic restart, only a plain record of the stop.
   */
  onStoppedByUser?(exit: IsolatedHostExit): void
  /** Acceptance-only lifecycle evidence; unset keeps the normal production log shape. */
  logHostRestart?(message: string): void
  /**
   * Test seam: the Electron surface the liveness probe, dialog, and renderer
   * publish would use. Production leaves it unset and looks `electron` up.
   */
  livenessApi?: ElectronLivenessApi
}

/** What an unexpected Host exit leaves behind for evidence. */
export interface IsolatedHostExit {
  /** Electron's reported code. A terminated Host reports the terminator's code, not a self-chosen one. */
  readonly exitCode: number
  /** Milliseconds between fork and exit; separates an instant death from one hours in. */
  readonly uptimeMs: number
  /**
   * The Host's last stderr output, bounded to {@link HOST_STDERR_TAIL_CHARS}. A fatal Host writes
   * its reason there (the fail-loud diagnostic, or Node's own crash stack) and nowhere else.
   */
  readonly stderrTail: string
}

/** Enough for a fail-loud diagnostic with its inspected cause chain, small enough for one log entry. */
export const HOST_STDERR_TAIL_CHARS = 16 * 1024

/** The Desktop log entry for an unexpected Host exit: the reason, then what the Host said last. */
export function formatUnexpectedHostExit(error: Error, exit: IsolatedHostExit): string {
  const tail = exit.stderrTail.trimEnd()
  return tail === '' ? error.message : `${error.message}\nLast DSH Host stderr:\n${tail}`
}

const requireElectron = createRequire(import.meta.url)

export type ElectronLivenessApi = {
  ipcMain?: {
    on(channel: string, listener: (event: IpcMainEvent, value: unknown) => void): void
    handle(channel: string, listener: () => unknown): void
    removeListener(channel: string, listener: (event: IpcMainEvent, value: unknown) => void): void
    removeHandler(channel: string): void
    removeAllListeners(channel: string): void
  }
  dialog?: {
    showMessageBox(options: {
      type: 'warning'
      message: string
      buttons: string[]
      cancelId: number
      defaultId: number
    }): Promise<{ response: number }>
  }
  BrowserWindow?: {
    getAllWindows(): Array<{ isDestroyed(): boolean; webContents: { send(channel: string, payload: unknown): void } }>
  }
}

function electronLivenessApi(): ElectronLivenessApi {
  try { return requireElectron('electron') as ElectronLivenessApi }
  catch { return {} }
}

function publishHostLiveness(state: Liveness, api: ElectronLivenessApi = electronLivenessApi()): void {
  const windows = api.BrowserWindow?.getAllWindows?.()
  if (!windows) return
  const payload = { phase: state.phase, turns: state.turns }
  for (const win of windows) {
    if (!win.isDestroyed()) win.webContents.send(HOST_LIVENESS_CHANNEL, payload)
  }
}

/**
 * Two-second probe of the isolated Host. A live pid, an open port, or stderr is not an answer.
 * The Electron surface is injectable so the stop dialog and mark-before-kill ordering can be
 * unit-tested without a running Electron main process.
 */
export function beginHostLiveness(
  rpc: HostRpc,
  child: { kill(): boolean },
  onUserStop: () => void,
  api: ElectronLivenessApi = electronLivenessApi(),
): () => void {
  let state: Liveness = { phase: 'ok', turns: 0, lastOkMs: Date.now() }
  let closed = false
  let stoppedByUser = false
  const apply = (event: { kind: 'probe-ok' | 'probe-miss' | 'turn-count'; atMs: number; turns?: number }) => {
    if (closed || stoppedByUser) return
    const next = reduceLiveness(state, event)
    const changed = next.phase !== state.phase || next.turns !== state.turns
    state = next
    if (changed) publishHostLiveness(state, api)
  }
  const onTurns = (_event: IpcMainEvent, turns: unknown) => {
    if (typeof turns !== 'number' || !Number.isFinite(turns) || turns < 0) return
    apply({ kind: 'turn-count', atMs: Date.now(), turns: Math.floor(turns) })
  }
  const onRead = () => ({ phase: state.phase, turns: state.turns })
  const onStop = async () => {
    if (closed || state.phase !== 'stoppable' || state.turns <= 0) return false
    const turns = state.turns
    const dialog = api.dialog
    if (typeof dialog?.showMessageBox !== 'function') return false
    const { response } = await dialog.showMessageBox({
      type: 'warning',
      message: `将终止 ${turns} 个未结束会话`,
      buttons: ['终止', '取消'],
      cancelId: 1,
      defaultId: 1,
    })
    if (response !== 0 || closed || state.phase !== 'stoppable' || state.turns <= 0) return false
    // The dialog's window may be unfocused, in which case the attention notice is
    // the only signal. The focused window keeps its banner, so publish the stop
    // before the kill: it must replace "unresponsive" with the neutral note there too.
    stoppedByUser = true
    state = { ...state, phase: 'stopped' }
    // Mark the reason before the kill: the exit handler runs asynchronously and
    // must never mistake the user's stop for an unexpected Host crash.
    onUserStop()
    publishHostLiveness(state, api)
    child.kill()
    return true
  }
  const ipcMain = api.ipcMain
  if (ipcMain && typeof ipcMain.on === 'function' && typeof ipcMain.handle === 'function') {
    ipcMain.removeHandler(HOST_LIVENESS_READ_CHANNEL)
    ipcMain.removeHandler(HOST_LIVENESS_STOP_CHANNEL)
    ipcMain.removeAllListeners(HOST_LIVENESS_TURNS_CHANNEL)
    ipcMain.on(HOST_LIVENESS_TURNS_CHANNEL, onTurns)
    ipcMain.handle(HOST_LIVENESS_READ_CHANNEL, onRead)
    ipcMain.handle(HOST_LIVENESS_STOP_CHANNEL, onStop)
  }
  publishHostLiveness(state, api)
  const timer = setInterval(() => {
    if (closed || stoppedByUser) return
    void rpc.call('status', [], undefined, 2_000).then(
      value => {
        const atMs = Date.now()
        if (probeAnswered(value)) apply({ kind: 'probe-ok', atMs })
        else apply({ kind: 'probe-miss', atMs })
      },
      () => { apply({ kind: 'probe-miss', atMs: Date.now() }) },
    )
  }, 2_000)
  return () => {
    if (closed) return
    closed = true
    clearInterval(timer)
    ipcMain?.removeListener(HOST_LIVENESS_TURNS_CHANNEL, onTurns)
    ipcMain?.removeHandler(HOST_LIVENESS_READ_CHANNEL)
    ipcMain?.removeHandler(HOST_LIVENESS_STOP_CHANNEL)
  }
}

interface IsolatedHostSession {
  pid: number
  readonly binding: HostNativeRuntimeBinding
  ready: Promise<void>
  stop(preserveShell: boolean): Promise<void>
  exitInfo(): IsolatedHostExit
}

/** Own one utility-process generation; the outer supervisor owns replacement order. */
function createIsolatedHostSession(
  options: IsolatedHostOptions,
  suppressFailure: () => boolean,
): IsolatedHostSession {
  const forkedAt = performance.now()
  const child = utilityProcess.fork(fileURLToPath(new URL('./host-process-entry.js', import.meta.url)), [], {
    serviceName: 'DSH Host', stdio: 'pipe', cwd: process.cwd(), env: { ...process.env },
  })
  child.stdout?.on('data', (data: Buffer) => { process.stdout.write(data) })
  const stderrDecoder = new StringDecoder('utf8')
  let stderrTail = ''
  child.stderr?.on('data', (data: Buffer) => {
    process.stderr.write(data)
    stderrTail = (stderrTail + stderrDecoder.write(data)).slice(-HOST_STDERR_TAIL_CHARS)
  })
  const rpc = new HostRpc({
    send: message => child.postMessage(message),
    listen: receive => { child.on('message', receive); return () => { child.removeListener('message', receive) } },
  }, 120_000)
  const binding = bindNativeRuntime(rpc, options.runtime)
  rpc.handle('certificate', () => options.prepareCertificate())
  rpc.handle('quit', ([code]) => { setImmediate(() => options.requestQuit(code)) })
  const exitGate = createHostExitGate()
  let exited = false
  let exitCode = -1
  let stopLiveness = () => {}
  let resolveExit!: () => void
  const exit = new Promise<void>(resolve => { resolveExit = resolve })
  const session: IsolatedHostSession = {
    pid: -1,
    binding,
    ready: Promise.resolve(),
    stop: async () => {},
    exitInfo: () => ({
      exitCode,
      uptimeMs: Math.max(0, performance.now() - forkedAt),
      stderrTail,
    }),
  }
  child.once('exit', (code) => {
    stopLiveness()
    exited = true
    exitCode = code
    rpc.close(`DSH Host exited (${code})`)
    resolveExit()
    const disposition = exitGate.disposition()
    if (disposition === 'failure' && !suppressFailure()) {
      options.onFailure(
        new Error(`DSH Host exited (${code}); restart the application to reconnect`),
        session.exitInfo(),
      )
    } else if (disposition === 'user-stop') {
      options.onStoppedByUser?.(session.exitInfo())
    }
  })
  let stopTask: Promise<void> | undefined
  session.stop = (preserveShell): Promise<void> => {
    if (stopTask !== undefined) {
      if (preserveShell) return stopTask
      return stopTask.catch(() => {}).then(async () => { await binding.release() })
    }
    stopTask = (async () => {
      exitGate.markStopping()
      stopLiveness()
      if (preserveShell) binding.retainShell()
      if (!exited) {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), 3_000)
        try { await rpc.call('stop', [], controller.signal) } catch { /* terminate an unresponsive Host */ }
        finally { clearTimeout(timeout) }
        if (!exited) child.kill()
        const timeoutExit = new Promise<never>((_resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('DSH Host termination was not confirmed')), 1_000)
          void exit.then(() => clearTimeout(timer))
        })
        await Promise.race([exit, timeoutExit])
      }
      await binding.release({ preserveShell })
      rpc.close()
    })()
    return stopTask
  }
  session.ready = (async () => {
    const { desktopLaunchEnvironment, ...host } = options.host
    const boot = await rpc.call<{ pid?: unknown }>('boot', [{ ...host, launchEnvironmentLayers: serializeHostEnvironment(desktopLaunchEnvironment) }, runtimeSnapshot(options.runtime), options.rendererToken])
    if (typeof boot.pid !== 'number') throw new Error('DSH Host boot returned no pid')
    session.pid = boot.pid
    exitGate.markBooted()
    stopLiveness = beginHostLiveness(rpc, child, () => exitGate.markStoppedByUser(), options.livenessApi)
  })()
  return session
}

function hostShellAdoptionRuntime(runtime: IsolatedHostOptions['runtime']): HostShellAdoptionRuntime {
  const candidate = runtime as Partial<HostShellAdoptionRuntime>
  if (typeof candidate.beginHostShellAdoption !== 'function'
    || typeof candidate.completeHostShellAdoption !== 'function'
    || typeof candidate.cancelHostShellAdoption !== 'function') {
    throw new Error('dsh-plugin-desktop: Host restart requires shell adoption support')
  }
  return candidate as HostShellAdoptionRuntime
}

export async function startIsolatedDesktopHost(options: IsolatedHostOptions): Promise<void> {
  let current: IsolatedHostSession | undefined
  const retainedBindings = new Set<HostNativeRuntimeBinding>()
  let plannedRestart = false
  let disposed = false
  let restartTask: Promise<AcceptanceHostRestartResult> | undefined
  let disposeTask: Promise<void> | undefined
  let acceptanceRegistered = false
  const electronApi = options.livenessApi ?? electronLivenessApi()
  const log = (message: string): void => { options.logHostRestart?.(message) }

  const dispose = (): Promise<void> => disposeTask ??= (async () => {
    disposed = true
    if (acceptanceRegistered) electronApi.ipcMain?.removeHandler(ACCEPTANCE_HOST_RESTART_CHANNEL)
    acceptanceRegistered = false
    if (restartTask !== undefined) await restartTask.catch(() => {})
    if (current !== undefined) {
      const session = current
      current = undefined
      retainedBindings.add(session.binding)
      await session.stop(false)
    }
    for (const binding of retainedBindings) await binding.release()
    retainedBindings.clear()
    log('dsh-plugin-desktop: Host supervisor final dispose complete')
  })()

  const restart = (): Promise<AcceptanceHostRestartResult> => {
    if (disposed) return Promise.reject(new Error('dsh-plugin-desktop: Host supervisor is disposed'))
    if (restartTask !== undefined) return restartTask
    const task = (async () => {
      const previous = current
      let adoption: HostShellAdoptionRuntime | undefined
      let oldStopped = false
      let next: IsolatedHostSession | undefined
      try {
        if (previous === undefined) throw new Error('dsh-plugin-desktop: no running Host generation to replace')
        adoption = hostShellAdoptionRuntime(options.runtime)
        adoption.beginHostShellAdoption()
        plannedRestart = true
        log(`dsh-plugin-desktop: Host restart begin (old pid ${previous.pid})`)
        retainedBindings.add(previous.binding)
        await previous.stop(true)
        oldStopped = true
        if (current === previous) current = undefined
        log('dsh-plugin-desktop: Host restart old generation detached; shell retained')
        next = createIsolatedHostSession(options, () => plannedRestart || disposed)
        current = next
        await next.ready
        adoption.completeHostShellAdoption()
        for (const binding of retainedBindings) await binding.release()
        retainedBindings.clear()
        const result = { oldPid: previous.pid, newPid: next.pid }
        log(`dsh-plugin-desktop: Host restart adopted (new pid ${next.pid})`)
        return result
      } catch (cause) {
        if (next !== undefined) {
          retainedBindings.add(next.binding)
          await next.stop(true).catch(() => {})
          if (current === next) current = undefined
        }
        adoption?.cancelHostShellAdoption()
        if (oldStopped) {
          const detail = cause instanceof Error ? cause.message : String(cause)
          options.logHostRestart?.(`dsh-plugin-desktop: Host restart failed: ${detail}`)
          options.onFailure(
            new Error(`DSH Host restart failed; restart the application to reconnect: ${detail}`),
            (next ?? previous)!.exitInfo(),
          )
        }
        throw cause
      } finally {
        plannedRestart = false
      }
    })()
    restartTask = task
    const clear = (): void => { if (restartTask === task) restartTask = undefined }
    void task.then(clear, clear)
    return task
  }

  // One stable handle survives every child generation and needs no changes in
  // DesktopStartupGeneration, including when startup aborts before boot completes.
  options.bindHost({ fiber: { dispose } })
  try {
    current = createIsolatedHostSession(options, () => plannedRestart || disposed)
    await current.ready
  } catch (cause) {
    await dispose()
    throw cause
  }

  if (acceptanceHooksEnabled() && electronApi.ipcMain !== undefined) {
    electronApi.ipcMain.removeHandler(ACCEPTANCE_HOST_RESTART_CHANNEL)
    electronApi.ipcMain.handle(ACCEPTANCE_HOST_RESTART_CHANNEL, () => restart())
    acceptanceRegistered = true
  }
}
