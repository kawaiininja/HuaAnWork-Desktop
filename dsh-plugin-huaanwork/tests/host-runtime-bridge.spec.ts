import { MessageChannel } from 'node:worker_threads'
import { expect, it, vi } from 'vitest'
import { HostRpc } from '../src/host-rpc.ts'
import { bindNativeRuntime, createHostRuntime, KeepAwakeUnavailableError, runtimeSnapshot, type ConfirmedRestartRuntime, type KeepAwakeRuntime, type SystemResumeRuntime } from '../src/host-runtime-bridge.ts'
import type { ArtifactNativeCapability, DesktopLocale, DesktopRuntime, DesktopShellSpec, DesktopTrayItem } from '../src/runtime.ts'

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
  let nativeLocale: DesktopLocale = 'en'
  const native = {
    platform: 'win32', get locale() { return nativeLocale },
    setLocalePreference: (preference: DesktopLocale | undefined) => { nativeLocale = preference ?? 'zh' },
    updates: { isPackaged: true, canDownload: true, currentVersion: '2.0.7-beta.1', statePath: '/tmp/update',
      request: vi.fn(async () => new Response('{"version":"2.0.8-beta.1"}', { headers: { 'x-test': 'yes' } })),
    },
    schedule: (value: DesktopShellSpec) => { shell = value; return disposeShell },
    registerTrayItem: (value: DesktopTrayItem) => { tray = value; return { refresh() {}, dispose: disposeTray } },
  } as unknown as DesktopRuntime
  const binding = bindNativeRuntime(parent, native)
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
  } finally { await binding.release(); parent.close(); child.close(); port1.close(); port2.close() }
})

it('retains the shell through graceful Host disposal and destroys it only on final release', async () => {
  const { port1, port2 } = new MessageChannel()
  const [parent, child] = [port1, port2].map(port => new HostRpc({
    send: value => port.postMessage(value),
    listen: receive => { port.on('message', receive); return () => { port.off('message', receive) } },
  })) as [HostRpc, HostRpc]
  const disposeShell = vi.fn(async () => {})
  const native = {
    platform: 'win32', locale: 'en', setLocalePreference() {},
    updates: { isPackaged: true, canDownload: true, currentVersion: '2.0.7-beta.1', statePath: '/tmp/update' },
    schedule: () => disposeShell,
    registerTrayItem: () => ({ refresh() {}, dispose() {} }),
  } as unknown as DesktopRuntime
  const binding = bindNativeRuntime(parent, native)
  try {
    const runtime = createHostRuntime(child, runtimeSnapshot(native))
    const stopShell = runtime.schedule({
      url: 'http://127.0.0.1:1234/', authenticationUrl: 'http://127.0.0.1:1234/?token=fixture',
      rendererAccessHeader: { name: 'x-dsh-desktop-renderer', value: 'fixture' },
      readLocalePreference: () => 'en', readThemeSource: () => 'dark',
      requestQuit() {}, requestModeChange: async () => {},
    } as unknown as DesktopShellSpec)
    await runtime.mountScheduled()

    binding.retainShell()
    await stopShell()
    expect(disposeShell).not.toHaveBeenCalled()

    await binding.release()
    expect(disposeShell).toHaveBeenCalledOnce()
  } finally {
    await binding.release()
    parent.close(); child.close(); port1.close(); port2.close()
  }
})

it('preserve release detaches trays and RPC handlers but keeps the shell for final release', async () => {
  const handlers = new Map<string, (args: any[], signal: AbortSignal) => unknown>()
  const parent = {
    call: () => Promise.resolve(undefined),
    handle: (name: string, handler: (args: any[], signal: AbortSignal) => unknown) => {
      handlers.set(name, handler)
      return () => { handlers.delete(name) }
    },
  } as unknown as HostRpc
  const disposeShell = vi.fn(async () => {})
  const disposeTray = vi.fn()
  const native = {
    platform: 'win32', locale: 'en',
    updates: { isPackaged: true, canDownload: true, currentVersion: '2.0.0', statePath: '/tmp/update' },
    schedule: () => disposeShell,
    registerTrayItem: () => ({ refresh() {}, dispose: disposeTray }),
  } as unknown as DesktopRuntime
  const binding = bindNativeRuntime(parent, native)
  const signal = new AbortController().signal
  await handlers.get('shell:schedule')!([
    'callback:1',
    { url: 'http://127.0.0.1:1234/' },
    'en',
    'dark',
    false,
    false,
  ], signal)
  await handlers.get('tray:set')!([
    'tray:1',
    { group: 'tools', order: 1, id: 'plugin-action', label: 'Plugin action', invoke: 'callback:1:invoke' },
  ], signal)

  await binding.release({ preserveShell: true })
  expect(disposeTray).toHaveBeenCalledOnce()
  expect(handlers.size).toBe(0)
  expect(disposeShell).not.toHaveBeenCalled()

  await binding.release()
  expect(disposeShell).toHaveBeenCalledOnce()
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
    platform: 'win32', locale: 'en',
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
    platform: 'win32', locale: 'en',
    updates: { isPackaged: true, canDownload: true, currentVersion: '2.0.0', statePath: '/tmp/update' },
    schedule: () => async () => {},
    registerTrayItem: () => ({ refresh() {}, dispose() {} }),
    requestConfirmedRestart: async () => verdict,
  } as unknown as DesktopRuntime
  const binding = bindNativeRuntime(parent, native)
  try {
    const handler = handlers.get('native:requestConfirmedRestart')
    expect(handler, 'native:requestConfirmedRestart must be registered on the main side').toBeTypeOf('function')
    const signal = new AbortController().signal
    verdict = true
    await expect(handler!([], signal)).resolves.toBe(true)
    verdict = false
    await expect(handler!([], signal)).resolves.toBe(false)
  } finally { await binding.release() }
})

it('pins the keep-awake RPC seam: method name, non-interactive timeout, boolean hold flow', async () => {
  const calls: { method: string; args: unknown[]; timeout: number | undefined }[] = []
  const child = {
    call: <T = unknown>(method: string, args: unknown[] = [], _signal?: AbortSignal, timeout?: number) => {
      calls.push({ method, args, timeout })
      return Promise.resolve(undefined as T)
    },
    handle: () => () => {},
  } as unknown as HostRpc
  const runtime = createHostRuntime(child, {
    platform: 'win32', locale: 'en',
    updates: { isPackaged: true, canDownload: true, currentVersion: '2.0.0', statePath: '/tmp/update' },
  }) as KeepAwakeRuntime
  await runtime.setKeepAwake!(true)
  await runtime.setKeepAwake!(false)
  expect(calls).toEqual([
    { method: 'native:setKeepAwake', args: [true], timeout: undefined },
    { method: 'native:setKeepAwake', args: [false], timeout: undefined },
  ])

  const handlers = new Map<string, (args: any[], signal: AbortSignal) => unknown>()
  const parent = {
    call: () => Promise.resolve(undefined),
    handle: (name: string, handler: (args: any[], signal: AbortSignal) => unknown) => {
      handlers.set(name, handler)
      return () => { handlers.delete(name) }
    },
  } as unknown as HostRpc
  const seen: boolean[] = []
  const native = {
    platform: 'win32', locale: 'en',
    updates: { isPackaged: true, canDownload: true, currentVersion: '2.0.0', statePath: '/tmp/update' },
    schedule: () => async () => {},
    registerTrayItem: () => ({ refresh() {}, dispose() {} }),
    setKeepAwake: async (hold: boolean) => { seen.push(hold) },
  } as unknown as DesktopRuntime
  const binding = bindNativeRuntime(parent, native)
  try {
    const handler = handlers.get('native:setKeepAwake')
    expect(handler, 'native:setKeepAwake must be registered on the main side').toBeTypeOf('function')
    const signal = new AbortController().signal
    await handler!([true], signal)
    await handler!([false], signal)
    expect(seen).toEqual([true, false])
    await expect(handler!([1], signal)).rejects.toThrow('native:setKeepAwake requires a boolean hold')
  } finally { await binding.release() }

  const bareHandlers = new Map<string, (args: any[], signal: AbortSignal) => unknown>()
  const bareParent = {
    call: () => Promise.resolve(undefined),
    handle: (name: string, handler: (args: any[], signal: AbortSignal) => unknown) => {
      bareHandlers.set(name, handler)
      return () => { bareHandlers.delete(name) }
    },
  } as unknown as HostRpc
  const bare = {
    platform: 'linux', locale: 'en',
    updates: { isPackaged: false, canDownload: false, currentVersion: '2.0.0', statePath: '/tmp/update' },
    schedule: () => async () => {},
    registerTrayItem: () => ({ refresh() {}, dispose() {} }),
  } as unknown as DesktopRuntime
  const bindingBare = bindNativeRuntime(bareParent, bare)
  try {
    const handler = bareHandlers.get('native:setKeepAwake')
    await expect(handler!([true], new AbortController().signal)).rejects.toBeInstanceOf(KeepAwakeUnavailableError)
  } finally { await bindingBare.release() }
})

it('pins the system-resume RPC seam: unconditional handlers, callback flow, silent bare-stub no-op, and detach cleanup', async () => {
  // Host 侧：createHostRuntime.subscribeSystemResume 先登记回调、再发 native:subscribeSystemResume。
  const calls: { method: string; args: unknown[] }[] = []
  const hostHandlers = new Map<string, (...args: any[]) => unknown>()
  const child = {
    call: <T = unknown>(method: string, args: unknown[] = []) => {
      calls.push({ method, args })
      return Promise.resolve(undefined as T)
    },
    handle: (name: string, handler: (...args: any[]) => unknown) => {
      hostHandlers.set(name, handler)
      return () => { hostHandlers.delete(name) }
    },
  } as unknown as HostRpc
  const runtime = createHostRuntime(child, {
    platform: 'win32', locale: 'en',
    updates: { isPackaged: true, canDownload: true, currentVersion: '2.0.0', statePath: '/tmp/update' },
  }) as SystemResumeRuntime
  expect(runtime.subscribeSystemResume).toBeTypeOf('function')
  const listener = vi.fn()
  const release = runtime.subscribeSystemResume!(listener)
  expect(calls).toEqual([{ method: 'native:subscribeSystemResume', args: ['callback:1'] }])
  const resumeCallback = hostHandlers.get('callback:1:resume')
  expect(resumeCallback, 'Host side must register the resume callback handler').toBeTypeOf('function')
  await resumeCallback!([], new AbortController().signal)
  expect(listener).toHaveBeenCalledOnce()
  release()
  expect(calls[1]).toEqual({ method: 'native:unsubscribeSystemResume', args: ['callback:1'] })
  expect(hostHandlers.has('callback:1:resume')).toBe(false)
  // I-10 回归：重复取消是真正 no-op，不得再发第二次 unsubscribe RPC。
  release()
  expect(calls).toHaveLength(2)

  // I-10 回归：订阅 RPC 拒绝时清理本地回调且只经 send() 写一次 stderr，随后再取消不再发 RPC。
  const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  try {
    const failingCalls: string[] = []
    const failingHandlers = new Map<string, (...args: any[]) => unknown>()
    const failingChild = {
      call: (method: string) => {
        failingCalls.push(method)
        return Promise.reject(new Error('subscribe-failed'))
      },
      handle: (name: string, handler: (...args: any[]) => unknown) => {
        failingHandlers.set(name, handler)
        return () => { failingHandlers.delete(name) }
      },
    } as unknown as HostRpc
    const failingRuntime = createHostRuntime(failingChild, {
      platform: 'win32', locale: 'en',
      updates: { isPackaged: true, canDownload: true, currentVersion: '2.0.0', statePath: '/tmp/update' },
    }) as SystemResumeRuntime
    const releaseFailed = failingRuntime.subscribeSystemResume!(vi.fn())
    await Promise.resolve()
    await Promise.resolve()
    expect(failingHandlers.size).toBe(0)
    expect(stderrSpy).toHaveBeenCalledTimes(1)
    releaseFailed()
    expect(failingCalls).toEqual(['native:subscribeSystemResume'])
  } finally {
    stderrSpy.mockRestore()
  }

  // main 侧：两个 handler 无条件注册；有能力的 runtime 挂上/卸载 powerMonitor 监听。
  const mainHandlers = new Map<string, (args: any[], signal: AbortSignal) => unknown>()
  const parentCalls: unknown[][] = []
  const parent = {
    call: vi.fn((...args: unknown[]) => { parentCalls.push(args); return Promise.resolve(undefined) }),
    handle: (name: string, handler: (args: any[], signal: AbortSignal) => unknown) => {
      mainHandlers.set(name, handler)
      return () => { mainHandlers.delete(name) }
    },
  } as unknown as HostRpc
  const resumeListeners: Array<() => void> = []
  const nativeDisposes: Array<ReturnType<typeof vi.fn>> = []
  const native = {
    platform: 'win32', locale: 'en',
    updates: { isPackaged: true, canDownload: true, currentVersion: '2.0.0', statePath: '/tmp/update' },
    schedule: () => async () => {},
    registerTrayItem: () => ({ refresh() {}, dispose() {} }),
    subscribeSystemResume: (resume: () => void) => {
      resumeListeners.push(resume)
      const dispose = vi.fn(() => {
        const index = resumeListeners.indexOf(resume)
        if (index >= 0) resumeListeners.splice(index, 1)
      })
      nativeDisposes.push(dispose)
      return dispose
    },
  } as unknown as DesktopRuntime & SystemResumeRuntime
  const signal = new AbortController().signal
  const binding = bindNativeRuntime(parent, native)
  try {
    expect(mainHandlers.has('native:subscribeSystemResume')).toBe(true)
    expect(mainHandlers.has('native:unsubscribeSystemResume')).toBe(true)
    await mainHandlers.get('native:subscribeSystemResume')!(['callback:9'], signal)
    expect(resumeListeners).toHaveLength(1)
    resumeListeners[0]!()
    await Promise.resolve()
    expect(parentCalls).toContainEqual(['callback:9:resume', []])
    await mainHandlers.get('native:unsubscribeSystemResume')!(['callback:9'], signal)
    expect(nativeDisposes[0]).toHaveBeenCalledOnce()

    // release() 必须释放仍挂着的订阅（detachHostResources 全量清理）。
    await mainHandlers.get('native:subscribeSystemResume')!(['callback:10'], signal)
    expect(resumeListeners).toHaveLength(1)
    await binding.release()
    expect(nativeDisposes[1]).toHaveBeenCalledOnce()
    expect(mainHandlers.size).toBe(0)
  } finally { await binding.release() }

  // 裸 DesktopRuntime 测试桩（无 subscribeSystemResume）：两个 handler 仍注册，
  // 调用静默 no-op 返回 undefined，绝不抛 Unknown Host operation（保证既有 Host
  // 集成/Windows liveness 桩零改动通过）。
  const bareHandlers = new Map<string, (args: any[], signal: AbortSignal) => unknown>()
  const bareParent = {
    call: () => Promise.resolve(undefined),
    handle: (name: string, handler: (args: any[], signal: AbortSignal) => unknown) => {
      bareHandlers.set(name, handler)
      return () => { bareHandlers.delete(name) }
    },
  } as unknown as HostRpc
  const bare = {
    platform: 'linux', locale: 'en',
    updates: { isPackaged: false, canDownload: false, currentVersion: '2.0.0', statePath: '/tmp/update' },
    schedule: () => async () => {},
    registerTrayItem: () => ({ refresh() {}, dispose() {} }),
  } as unknown as DesktopRuntime
  const bindingBare = bindNativeRuntime(bareParent, bare)
  try {
    expect(bareHandlers.has('native:subscribeSystemResume')).toBe(true)
    expect(bareHandlers.has('native:unsubscribeSystemResume')).toBe(true)
    expect(bareHandlers.get('native:subscribeSystemResume')!(['callback:11'], signal)).toBeUndefined()
    expect(bareHandlers.get('native:unsubscribeSystemResume')!(['callback:11'], signal)).toBeUndefined()
  } finally { await bindingBare.release() }
})

it('pins the artifact native seam: interactive save without timeout plus strict handler validation', async () => {
  const calls: { method: string; args: unknown[]; timeout: number | undefined }[] = []
  const child = {
    call: <T = unknown>(method: string, args: unknown[] = [], _signal?: AbortSignal, timeout?: number) => {
      calls.push({ method, args, timeout })
      return Promise.resolve({ saved: false } as T)
    },
    handle: () => () => {},
  } as unknown as HostRpc
  const runtime = createHostRuntime(child, {
    platform: 'win32', locale: 'en',
    updates: { isPackaged: true, canDownload: true, currentVersion: '2.0.0', statePath: '/tmp/update' },
  })
  const frameName = 'huaanwork-artifact-11111111-1111-4111-8111-111111111111'
  const save = { downloadName: '结果.html', contentBase64: 'eA==', surface: 'artifact' as const }
  const target = { sessionId: 'session-1', artifactId: 'artifact-1' }
  await expect(runtime.saveArtifact(save)).resolves.toEqual({ saved: false })
  await runtime.openArtifactFullscreen(target)
  await runtime.prepareArtifactFrame({ surface: 'main', frameName })
  // 用户可能长时间停留在系统对话框:saveArtifact 必须走 interactive 0 超时,其余不带。
  expect(calls).toEqual([
    { method: 'native:saveArtifact', args: [save], timeout: 0 },
    { method: 'native:openArtifactFullscreen', args: [target], timeout: undefined },
    { method: 'native:prepareArtifactFrame', args: [{ surface: 'main', frameName }], timeout: undefined },
  ])

  const handlers = new Map<string, (args: any[], signal: AbortSignal) => unknown>()
  const parent = {
    call: () => Promise.resolve(undefined),
    handle: (name: string, handler: (args: any[], signal: AbortSignal) => unknown) => {
      handlers.set(name, handler)
      return () => { handlers.delete(name) }
    },
  } as unknown as HostRpc
  const opened: unknown[] = []
  const saved: unknown[] = []
  const prepared: unknown[] = []
  const native = {
    platform: 'win32', locale: 'en',
    updates: { isPackaged: true, canDownload: true, currentVersion: '2.0.0', statePath: '/tmp/update' },
    schedule: () => async () => {},
    registerTrayItem: () => ({ refresh() {}, dispose() {} }),
    openArtifactFullscreen: async (value: unknown) => { opened.push(value) },
    saveArtifact: async (value: unknown) => { saved.push(value); return { saved: false } },
    prepareArtifactFrame: async (value: unknown) => { prepared.push(value) },
  } as unknown as DesktopRuntime & ArtifactNativeCapability
  const binding = bindNativeRuntime(parent, native)
  try {
    const signal = new AbortController().signal
    await handlers.get('native:openArtifactFullscreen')!([target], signal)
    await handlers.get('native:saveArtifact')!([save], signal)
    await handlers.get('native:prepareArtifactFrame')!([{ surface: 'artifact', frameName }], signal)
    expect(opened).toEqual([target])
    expect(saved).toEqual([save])
    expect(prepared).toEqual([{ surface: 'artifact', frameName }])

    const open = handlers.get('native:openArtifactFullscreen')!
    const saveHandler = handlers.get('native:saveArtifact')!
    const prepare = handlers.get('native:prepareArtifactFrame')!
    // handler 直接装配在 HostRpc 上,校验在 await 之前同步拒绝(与 keep-awake 的
    // async handler 不同);HostRpc 的 handle 把同步 throw 转成错误应答。
    expect(() => open([{ sessionId: 'session-1' }], signal))
      .toThrow('native:openArtifactFullscreen requires valid sessionId and artifactId')
    expect(() => saveHandler([{ ...save, downloadName: '' }], signal))
      .toThrow('native:saveArtifact requires a downloadName')
    expect(() => saveHandler([{ ...save, contentBase64: 'eA' }], signal))
      .toThrow('native:saveArtifact requires base64 content')
    expect(() => saveHandler([{ ...save, surface: 'window' }], signal))
      .toThrow("native:saveArtifact requires surface 'main' or 'artifact'")
    expect(() => prepare([{ surface: 'main', frameName: 'huaanwork-artifact-nope' }], signal))
      .toThrow('native:prepareArtifactFrame requires a huaanwork-artifact frame name')
    expect(() => prepare([{ surface: 'window', frameName }], signal))
      .toThrow("native:prepareArtifactFrame requires surface 'main' or 'artifact'")
  } finally { await binding.release() }

  const bareHandlers = new Map<string, (args: any[], signal: AbortSignal) => unknown>()
  const bareParent = {
    call: () => Promise.resolve(undefined),
    handle: (name: string, handler: (args: any[], signal: AbortSignal) => unknown) => {
      bareHandlers.set(name, handler)
      return () => { bareHandlers.delete(name) }
    },
  } as unknown as HostRpc
  const bare = {
    platform: 'linux', locale: 'en',
    updates: { isPackaged: false, canDownload: false, currentVersion: '2.0.0', statePath: '/tmp/update' },
    schedule: () => async () => {},
    registerTrayItem: () => ({ refresh() {}, dispose() {} }),
  } as unknown as DesktopRuntime
  const bindingBare = bindNativeRuntime(bareParent, bare)
  try {
    // 测试桩未装配原生能力时,handler 明确报缺失而不是裸 TypeError。
    expect(() => bareHandlers.get('native:saveArtifact')!([save], new AbortController().signal))
      .toThrow('artifact-native-unavailable')
  } finally { await bindingBare.release() }
})
