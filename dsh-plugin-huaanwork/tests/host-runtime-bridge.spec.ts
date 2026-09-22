import { MessageChannel } from 'node:worker_threads'
import { expect, it, vi } from 'vitest'
import { HostRpc } from '../src/host-rpc.ts'
import { bindNativeRuntime, createHostRuntime, runtimeSnapshot, type ConfirmedRestartRuntime } from '../src/host-runtime-bridge.ts'
import type { DesktopRuntime, DesktopShellSpec, DesktopTrayItem } from '../src/runtime.ts'

it('preserves the Web URL and authentication while projecting shell and tray callbacks', async () => {
  const { port1, port2 } = new MessageChannel()
  const [parent, child] = [port1, port2].map(port => new HostRpc({
    send: value => port.postMessage(value),
    listen: receive => { port.on('message', receive); return () => { port.off('message', receive) } },
  })) as [HostRpc, HostRpc]
  let shell!: DesktopShellSpec
  let tray!: DesktopTrayItem
  const disposeShell = vi.fn(async () => {})
  const disposeTray = vi.fn()
  const native = {
    platform: 'win32', windowsBuild: 22631, locale: 'en',
    updates: { isPackaged: true, canDownload: true, currentVersion: '2.0.7-beta.1', statePath: '/tmp/update',
      request: vi.fn(async () => new Response('{"version":"2.0.8-beta.1"}', { headers: { 'x-test': 'yes' } })),
    },
    schedule: (value: DesktopShellSpec) => { shell = value; return disposeShell },
    registerTrayItem: (value: DesktopTrayItem) => { tray = value; return { refresh() {}, dispose: disposeTray } },
  } as unknown as DesktopRuntime
  const release = bindNativeRuntime(parent, native)
  try {
    const runtime = createHostRuntime(child, runtimeSnapshot(native))
    let language: 'zh' | undefined
    const mode = vi.fn(async () => {})
    const invoke = vi.fn(async () => {})
    const spec = { url: 'http://127.0.0.1:1234/?dsh-desktop-mode=advanced',
      authenticationUrl: 'http://127.0.0.1:1234/?token=fixture',
      rendererAccessHeader: { name: 'x-dsh-desktop-renderer', value: 'fixture' },
      readLocalePreference: () => language, readThemeSource: () => 'dark',
      requestQuit() {}, requestModeChange: mode,
    } as unknown as DesktopShellSpec
    spec.readRemoteControl = vi.fn(async () => false)
    spec.enableRemoteControl = vi.fn(async () => {})
    const stopShell = runtime.schedule(spec)
    runtime.registerTrayItem({ group: 'tools', order: 1, label: () => 'Plugin action', invoke,
      submenu: () => [{ label: () => 'Child', invoke }] })
    language = 'zh'
    await runtime.mountScheduled()
    expect(await shell.readRemoteControl?.()).toBe(false)
    await shell.enableRemoteControl?.()
    expect(spec.enableRemoteControl).toHaveBeenCalledTimes(1)
    expect(shell.url).toBe(spec.url)
    expect(shell.authenticationUrl).toBe(spec.authenticationUrl)
    expect(shell.rendererAccessHeader).toEqual(spec.rendererAccessHeader)
    expect(shell.readLocalePreference()).toBe('zh')
    await shell.requestModeChange('extended')
    expect(mode).toHaveBeenCalledWith('extended')
    expect(tray.label()).toBe('Plugin action')
    await tray.submenu?.()[0]?.invoke()
    expect(invoke).toHaveBeenCalledOnce()
    const response = await runtime.updates.request('https://example.invalid', { headers: { accept: 'application/json' } })
    expect(response.headers.get('x-test')).toBe('yes')
    expect(await response.json()).toEqual({ version: '2.0.8-beta.1' })
    await stopShell()
    expect(disposeShell).toHaveBeenCalledOnce()
  } finally { await release(); parent.close(); child.close(); port1.close(); port2.close() }
})

it('pins the confirmed-restart RPC seam: method name, interactive flag, boolean verdict flow', async () => {
  // 评审 R1:workspace 切换修复的核心链路是跨进程 RPC——Host 侧 send 的方法名、
  // main 侧 handle 的注册、interactive 免超时名单三者必须逐字对齐;此前零覆盖,
  // 改名一个字符 / 漏注册 handler / 误删名单都是 1776 用例全绿、真机才爆。
  let verdict = true
  const calls: { method: string; timeout: number | undefined }[] = []
  const child = {
    call: <T = unknown>(_method: string, _args: unknown[] = [], _signal?: AbortSignal, _timeout?: number) => {
      calls.push({ method: _method, timeout: _timeout })
      return Promise.resolve(verdict as T)
    },
    handle: () => () => {},
  } as unknown as HostRpc
  // createHostRuntime 的公开返回类型仍是 DesktopRuntime(ConfirmedRestartRuntime
  // 是 huaanwork-host 侧的显式窄化),本用例按同约定窄化后再调用。
  const runtime = createHostRuntime(child, {
    platform: 'win32', windowsBuild: 22631, locale: 'en',
    updates: { isPackaged: true, canDownload: true, currentVersion: '2.0.0', statePath: '/tmp/update' },
  }) as ConfirmedRestartRuntime
  await expect(runtime.requestConfirmedRestart()).resolves.toBe(true)
  verdict = false
  await expect(runtime.requestConfirmedRestart()).resolves.toBe(false)
  expect(calls).toEqual([
    { method: 'native:requestConfirmedRestart', timeout: 0 },
    { method: 'native:requestConfirmedRestart', timeout: 0 },
  ])

  // main 侧注册对齐:bindNativeRuntime 登记的 handler 名与 Host 侧调用一致,且把
  // ElectronDesktopRuntime 的裁决原样回流为 boolean。
  const handlers = new Map<string, (args: any[], signal: AbortSignal) => unknown>()
  const parent = {
    call: () => Promise.resolve(undefined),
    handle: (name: string, handler: (args: any[], signal: AbortSignal) => unknown) => {
      handlers.set(name, handler)
      return () => { handlers.delete(name) }
    },
  } as unknown as HostRpc
  const native = {
    platform: 'win32', windowsBuild: 22631, locale: 'en',
    updates: { isPackaged: true, canDownload: true, currentVersion: '2.0.0', statePath: '/tmp/update' },
    schedule: () => async () => {},
    registerTrayItem: () => ({ refresh() {}, dispose() {} }),
    requestConfirmedRestart: async () => verdict,
  } as unknown as DesktopRuntime
  const release = bindNativeRuntime(parent, native)
  try {
    const handler = handlers.get('native:requestConfirmedRestart')
    expect(handler, 'native:requestConfirmedRestart must be registered on the main side').toBeTypeOf('function')
    const signal = new AbortController().signal
    verdict = true
    await expect(handler!([], signal)).resolves.toBe(true)
    verdict = false
    await expect(handler!([], signal)).resolves.toBe(false)
  } finally { await release() }
})
