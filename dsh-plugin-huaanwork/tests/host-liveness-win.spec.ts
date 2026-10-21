/**
 * Windows CI proof for acceptance B16 (design §7.2 / §10).
 *
 * Forks the real Host entry the way `host-process-integration.spec.ts` does,
 * suspends that process with NtSuspendProcess so it stays alive but cannot
 * answer `status`, then runs `beginHostLiveness` on real timers. Electron
 * `utilityProcess.fork` is not covered: it only exists inside an Electron main
 * process, and the native confirm dialog, banner copy, and a human reading of
 * the session-count sentence still need a Windows desktop session.
 */
import { execFile, fork, type ChildProcess, type Serializable } from 'node:child_process'
import { once } from 'node:events'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it, vi } from 'vitest'
import { installDesktopPnpmRuntime } from '../src/desktop-runtime-environment.ts'
import { HostRpc } from '../src/host-rpc.ts'
import { bindNativeRuntime, runtimeSnapshot } from '../src/host-runtime-bridge.ts'
import {
  HOST_LIVENESS_STOP_CHANNEL,
  HOST_LIVENESS_TURNS_CHANNEL,
  createHostExitGate,
} from '../src/huaanwork-host/host-liveness.ts'
import { desktopReleaseUserDataLocations } from '../src/profile-channel-admission.ts'
import { prepareDesktopProfile } from '../src/profile.ts'
import type { DesktopRuntime, DesktopShellSpec } from '../src/runtime.ts'

vi.mock('electron', () => ({
  utilityProcess: {
    fork() { throw new Error('B16 forks the Host with node, not utilityProcess') },
  },
}))

import { beginHostLiveness, type ElectronLivenessApi } from '../src/host-process.ts'

// Probe every 2s, each `status` call times out at 2s, thresholds are 15s / 60s.
// The miss that crosses a threshold therefore lands a couple of seconds after it.
// The windows reject an immediate failure and a kill at 15s, and still allow CI slack.
const SUSPECT_MIN_MS = 14_000
const SUSPECT_MAX_MS = 25_000
const STOPPABLE_MIN_MS = 55_000
const STOPPABLE_MAX_MS = 80_000

const suspendScript = fileURLToPath(new URL('./fixtures/isolated-host/suspend-process.ps1', import.meta.url))

function delay(ms: number): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, ms) })
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function between(label: string, value: number, min: number, max: number): void {
  if (value < min || value > max) throw new Error(`${label} was ${value}ms, expected ${min}-${max}ms`)
}

function note(line: string): void {
  console.log(line)
  const summary = process.env.GITHUB_STEP_SUMMARY
  if (summary) appendFileSync(summary, `${line}\n`)
}

function controlProcess(pid: number, action: 'suspend' | 'resume'): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', suspendScript, '-TargetPid', String(pid), '-Action', action,
    ], { windowsHide: true, timeout: 20_000 }, (error, stdout, stderrText) => {
      if (error) {
        reject(new Error(`powershell ${action} ${pid} failed: ${error.message}\n${stdout}\n${stderrText}`))
        return
      }
      resolve()
    })
  })
}

function forceKill(pid: number): Promise<void> {
  return new Promise(resolve => {
    execFile('taskkill.exe', ['/F', '/T', '/PID', String(pid)], { windowsHide: true, timeout: 15_000 }, () => resolve())
  })
}

async function waitGone(pid: number, timeoutMs: number): Promise<number | undefined> {
  const started = Date.now()
  while (Date.now() - started <= timeoutMs) {
    if (!pidAlive(pid)) return Date.now() - started
    await delay(100)
  }
  if (!pidAlive(pid)) return Date.now() - started
  return undefined
}

type Publication = { phase: string; turns: number; at: number }

function livenessHarness(published: Publication[]) {
  const handlers = new Map<string, (...args: never[]) => unknown>()
  const listeners = new Map<string, (...args: never[]) => unknown>()
  const dialogCalls: Array<{ message: string; buttons: string[]; cancelId: number; defaultId: number }> = []
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
    dialog: {
      async showMessageBox(options: { message: string; buttons: string[]; cancelId: number; defaultId: number }) {
        dialogCalls.push({
          message: options.message,
          buttons: [...options.buttons],
          cancelId: options.cancelId,
          defaultId: options.defaultId,
        })
        // Button 0 is 「终止」. The native dialog itself is not created.
        return { response: 0 }
      },
    },
    BrowserWindow: {
      getAllWindows: () => [{
        isDestroyed: () => false,
        webContents: {
          send(_channel: string, payload: { phase: string; turns: number }) {
            published.push({ phase: payload.phase, turns: payload.turns, at: Date.now() })
          },
        },
      }],
    },
  } as unknown as ElectronLivenessApi
  return {
    api,
    dialogCalls,
    reportTurns(turns: number) {
      const listener = listeners.get(HOST_LIVENESS_TURNS_CHANNEL) as
        | ((event: unknown, turns: number) => void)
        | undefined
      listener?.({}, turns)
    },
    stop() {
      const handler = handlers.get(HOST_LIVENESS_STOP_CHANNEL) as (() => Promise<boolean>) | undefined
      if (!handler) return Promise.resolve(false)
      return handler()
    },
  }
}

function isReady(message: unknown): message is { ready: true; grandchildPid: number } {
  if (!message || typeof message !== 'object') return false
  const value = message as { ready?: unknown; grandchildPid?: unknown }
  return value.ready === true && typeof value.grandchildPid === 'number'
}

it.skipIf(process.platform !== 'win32')(
  'suspends a booted Host and stops it at the real 15s and 60s liveness thresholds',
  async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-b16-liveness-'))
    const token = Buffer.alloc(32, 7).toString('base64url')
    const grandchildPidFile = join(home, 'grandchild.pid')
    let child: ChildProcess | undefined
    let rpc: HostRpc | undefined
    let releaseNative: (() => Promise<void>) | undefined
    let pnpm: ReturnType<typeof installDesktopPnpmRuntime> | undefined
    let stopLiveness = () => {}
    let hostPid: number | undefined
    let grandchildPid: number | undefined
    let stderr = ''
    const timing: {
      bootMs?: number
      suspectMs?: number
      stoppableMs?: number
      stopToExitMs?: number
      hostGoneMs?: number | null
      grandchildAlive?: boolean
    } = {}
    const published: Publication[] = []
    const stoppedByUser: unknown[] = []
    const failures: unknown[] = []

    const cleanup = async () => {
      stopLiveness()
      try {
        if (hostPid !== undefined && pidAlive(hostPid)) {
          await controlProcess(hostPid, 'resume').catch(() => {})
          if (child && child.exitCode === null) {
            const exited = once(child, 'exit')
            child.kill()
            await Promise.race([exited, delay(3_000)])
          }
          if (pidAlive(hostPid)) await forceKill(hostPid)
        }
        if (grandchildPid !== undefined && pidAlive(grandchildPid)) await forceKill(grandchildPid)
      } finally {
        try { rpc?.close() } catch { /* the channel is already gone when the Host dies */ }
        await releaseNative?.().catch(() => {})
        try { pnpm?.dispose() } catch { /* temp runtime dir is removed below */ }
        child?.stdout?.destroy()
        child?.stderr?.destroy()
        if (child && child.exitCode === null) {
          try { child.disconnect() } catch { /* the IPC channel is already closed */ }
          child.unref()
        }
        try { rmSync(home, { recursive: true, force: true }) } catch { /* the runner discards the disk */ }
      }
    }

    try {
      const bootStarted = Date.now()
      writeFileSync(join(home, 'settings.yaml'), 'dsh-desktop:\n  mode: advanced\nagent-presets:\n  default: minimal\n')
      const prepared = prepareDesktopProfile('1', home, 'win32', undefined, undefined, undefined, { aaEnabled: false })
      prepared.overlays = []
      prepared.port = 0
      const plugin = join(prepared.profile.dir, 'node_modules', 'isolated-client-fixture')
      mkdirSync(plugin, { recursive: true })
      writeFileSync(join(plugin, 'package.json'), JSON.stringify({
        name: 'isolated-client-fixture', version: '1.0.0', type: 'module',
        exports: { '.': './index.js', './client': './client.js', './package.json': './package.json' },
        dsh: { client: { platform: 'web' } },
      }))
      writeFileSync(join(plugin, 'index.js'), 'export function apply() {}\n')
      writeFileSync(join(plugin, 'client.js'), 'export function apply(ctx) { ctx.provide("isolatedClientFixture", true) }\n')
      prepared.overlays.push({ insert: [{ id: 'isolated-client-fixture', name: 'isolated-client-fixture' }] })
      const packageRoot = new URL('../', import.meta.url)
      const pnpmBinPath = fileURLToPath(new URL('node_modules/pnpm/bin/pnpm.mjs', packageRoot))
      const electronVersion = JSON.parse(readFileSync(new URL('node_modules/electron/package.json', packageRoot), 'utf8')).version as string
      pnpm = installDesktopPnpmRuntime({
        platform: process.platform, appExecutable: process.execPath, pnpmBinPath,
        electronVersion, stateDir: join(home, 'runtime'), environment: process.env,
      })
      prepared.patches.push(...prepared.overlays)
      child = fork(fileURLToPath(new URL('./fixtures/isolated-host/liveness-child.mjs', import.meta.url)), [], {
        execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'], serialization: 'advanced', windowsHide: true,
        env: { ...process.env, B16_GRANDCHILD_PID_FILE: grandchildPidFile },
      })
      const worker = child
      // Drain both pipes. A full stdout buffer would stall the Host before boot finishes.
      worker.stderr?.on('data', data => { stderr = (stderr + String(data)).slice(-16_384) })
      worker.stdout?.on('data', () => {})
      const ready = await new Promise<{ ready: true; grandchildPid: number }>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Host did not become ready')), 30_000)
        const onMessage = (message: unknown) => {
          if (!isReady(message)) return
          clearTimeout(timer)
          worker.off('message', onMessage)
          resolve(message)
        }
        worker.on('message', onMessage)
      })
      grandchildPid = ready.grandchildPid
      expect(pidAlive(grandchildPid)).toBe(true)
      if (worker.pid === undefined) throw new Error('Host pid missing')
      hostPid = worker.pid
      expect(hostPid).not.toBe(process.pid)
      expect(grandchildPid).not.toBe(hostPid)

      rpc = new HostRpc({
        send: data => { worker.send(data as Serializable) },
        listen: receive => {
          worker.on('message', receive)
          return () => { worker.off('message', receive) }
        },
      }, 120_000)
      const hostRpc = rpc
      let shell: DesktopShellSpec | undefined
      const restarts: string[] = []
      const runtime = {
        platform: 'win32', locale: 'en',
        updates: { isPackaged: false, canDownload: false, currentVersion: '2.0.7-beta.1', statePath: join(home, 'updates') },
        schedule(spec: DesktopShellSpec) { shell = spec; return async () => {} },
        registerTrayItem() { return { refresh() {}, dispose() {} } },
        setLocalePreference() {}, setThemeSource() {},
        async requestRestart() { restarts.push('restart') },
        async requestRecoveryRestart() { restarts.push('recovery') },
      } as unknown as DesktopRuntime
      releaseNative = bindNativeRuntime(hostRpc, runtime)
      hostRpc.handle('certificate', () => ({ failureCode: 'test-disabled' }))
      hostRpc.handle('quit', () => {})
      const result = await hostRpc.call<{ pid: number }>('boot', [{
        prepared, profilePreferences: {
          mode: 'advanced', openBrowser: false, networkExposure: 'loopback',
          macosMaterial: 'auto', windowsMaterial: 'auto', market: 'disabled', notifications: { enabled: false }, aaEnabled: false,
        },
        homeDir: home, activeProfileName: prepared.profile.name, pluginManagementStatePath: join(home, 'plugins.json'),
        selectionStatePath: join(home, 'selection.json'), marketUserDataDir: join(home, 'userdata'),
        releaseUserDataLocations: desktopReleaseUserDataLocations(home, join(home, 'userdata')),
        launchEnvironmentLayers: [],
        desktopProxyOverlay: {},
        desktopPnpmBootstrap: {
          activeProfileName: prepared.profile.name, activeProfileDir: prepared.profile.dir, homeDir: home,
          appExecutable: process.execPath, pnpmBinPath, electronVersion, nodeBinDir: pnpm.nodeBinDir,
          nodeShimPath: pnpm.nodeShimPath, clearEnvironmentPath: pnpm.clearEnvironmentPath,
          dshBootstrapPath: fileURLToPath(new URL('../lib/desktop-cli.js', import.meta.url)),
        },
        logDirectory: join(home, 'logs'),
      }, runtimeSnapshot(runtime), token], undefined, 90_000)
      expect(result.pid).toBe(hostPid)
      expect(shell).toBeDefined()
      expect(restarts).not.toContain('recovery')
      const alive = await hostRpc.call<{ pid: number }>('status', [], undefined, 10_000)
      expect(alive.pid).toBe(hostPid)
      timing.bootMs = Date.now() - bootStarted

      const exitGate = createHostExitGate()
      exitGate.markBooted()
      let exitCode: number | null = null
      const exitPromise = new Promise<void>(resolve => {
        worker.once('exit', code => {
          exitCode = code
          stopLiveness()
          const exitInfo = { exitCode: code, uptimeMs: Date.now() - bootStarted, stderrTail: stderr.slice(-4_096) }
          const disposition = exitGate.disposition()
          if (disposition === 'failure') failures.push(exitInfo)
          else if (disposition === 'user-stop') stoppedByUser.push(exitInfo)
          resolve()
        })
      })

      await controlProcess(hostPid, 'suspend')
      if (worker.exitCode !== null) throw new Error(`Host exited during suspend (${worker.exitCode})`)
      await expect(hostRpc.call('status', [], undefined, 2_000)).rejects.toThrow(/timed out|cancelled/)
      expect(pidAlive(hostPid)).toBe(true)
      expect(pidAlive(grandchildPid)).toBe(true)

      const harness = livenessHarness(published)
      const livenessStarted = Date.now()
      stopLiveness = beginHostLiveness(hostRpc, worker, () => exitGate.markStoppedByUser(), harness.api)
      harness.reportTurns(1)

      const suspect = await waitPhase(published, 'suspect', livenessStarted, 30_000)
      timing.suspectMs = suspect
      note(`B16_WIN_TIMING suspectMs=${suspect}`)
      between('suspect', suspect, SUSPECT_MIN_MS, SUSPECT_MAX_MS)

      const stoppable = await waitPhase(published, 'stoppable', livenessStarted, 90_000)
      timing.stoppableMs = stoppable
      note(`B16_WIN_TIMING stoppableMs=${stoppable}`)
      between('stoppable', stoppable, STOPPABLE_MIN_MS, STOPPABLE_MAX_MS)
      expect(published.find(item => item.phase === 'stoppable')?.turns).toBe(1)
      expect(published.findIndex(item => item.phase === 'suspect'))
        .toBeLessThan(published.findIndex(item => item.phase === 'stoppable'))

      const stopStarted = Date.now()
      expect(await harness.stop()).toBe(true)
      expect(harness.dialogCalls).toEqual([{
        message: '将终止 1 个未结束会话',
        buttons: ['终止', '取消'],
        cancelId: 1,
        defaultId: 1,
      }])
      const exitArrived = await Promise.race([
        exitPromise.then(() => true),
        delay(5_000).then(() => false),
      ])
      const stopToExitMs = Date.now() - stopStarted
      timing.stopToExitMs = stopToExitMs
      if (!exitArrived || stopToExitMs > 5_000) {
        throw new Error(`Host exit did not arrive within 5000ms (stopToExitMs=${stopToExitMs}, exitCode=${exitCode})`)
      }
      const hostGoneMs = await waitGone(hostPid, 5_000)
      timing.hostGoneMs = hostGoneMs ?? null
      if (hostGoneMs === undefined) throw new Error(`Host pid ${hostPid} still alive after exit ${exitCode}`)
      expect(stoppedByUser).toHaveLength(1)
      expect(failures).toHaveLength(0)
      expect(exitGate.stoppedByUser).toBe(true)
      expect(published.at(-1)?.phase).toBe('stopped')

      // Grace for a job-object kill. Still alive after this is an orphan, not a slow exit.
      const grandchildGoneMs = await waitGone(grandchildPid, 2_000)
      const grandchildAlive = grandchildGoneMs === undefined
      timing.grandchildAlive = grandchildAlive
      note(`B16_WIN_TIMING ${JSON.stringify({ ...timing, hostPid, grandchildPid, exitCode })}`)
      if (grandchildAlive) {
        throw new Error(
          `Host pid ${hostPid} is gone but grandchild pid ${grandchildPid} is still running. ` +
          'child.kill() on Windows terminates that pid only, so a process the Host spawned can be orphaned. ' +
          'Keep this assertion. Repair options: taskkill /T /F, a Job Object with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, or tree-kill.',
        )
      }
    } catch (error) {
      note(`B16_WIN_TIMING_PARTIAL ${JSON.stringify(timing)}`)
      if (error instanceof Error && stderr !== '') error.message += `\n--- host stderr ---\n${stderr.slice(-8_000)}`
      throw error
    } finally {
      await cleanup()
    }
  },
  240_000,
)

async function waitPhase(published: Publication[], phase: string, started: number, timeoutMs: number): Promise<number> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const hit = published.find(item => item.phase === phase)
    if (hit) return hit.at - started
    await delay(50)
  }
  throw new Error(`phase ${phase} not seen within ${timeoutMs}ms; saw ${published.map(item => item.phase).join(',')}`)
}
