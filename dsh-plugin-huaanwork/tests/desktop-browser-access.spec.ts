/**
 * 全屏 Artifact 窗口的渲染器鉴权生命周期:每次业务打开先在 about:blank 上撤下旧
 * header listener、重新鉴权、再安装新 listener;主窗口监听始终独立有效。
 *
 * session.fetch mock 必须经过当前真实安装的 onBeforeSendHeaders listener,
 * 并保留“已认证 cookie”路径,才能证明第二次打开不是靠 cookie 蒙混过关。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DesktopShellSpec } from '../src/runtime.ts'
import {
  createDesktopBrowserAccess,
  decideDesktopBrowserAccess,
  DESKTOP_RENDERER_ACCESS_HEADER,
  desktopBrowserUrlHasRendererMarkers,
} from '../src/desktop-browser-access.ts'

type Listener = (
  details: Record<string, unknown>,
  callback: (response: { requestHeaders?: Record<string, string> }) => void,
) => void

interface RequestRecord {
  url: string
  headers: Record<string, string>
  hadRendererHeader: boolean
  cookieOnly: boolean
}

interface SessionMock {
  readonly partition: string
  readonly webRequest: { onBeforeSendHeaders: ReturnType<typeof vi.fn> }
  readonly fetch: ReturnType<typeof vi.fn>
  readonly on: ReturnType<typeof vi.fn>
  readonly removeListener: ReturnType<typeof vi.fn>
  readonly setPermissionCheckHandler: ReturnType<typeof vi.fn>
  readonly setPermissionRequestHandler: ReturnType<typeof vi.fn>
  readonly listeners: Listener[]
  readonly requests: RequestRecord[]
  authenticated: boolean
  failWith?: number
  owner?: unknown
}

const electron = vi.hoisted(() => {
  const windows: any[] = []
  const sessions = new Map<string, SessionMock>()
  const trayInstances: any[] = []
  const browserWindowConstructor = vi.fn()
  const rendererAccessHeader = {
    name: 'x-dsh-desktop-renderer' as const,
    value: Buffer.alloc(32, 5).toString('base64url'),
  }
  let artifactAuthFailure: number | undefined

  /** vi.hoisted 工厂执行早于 import,EventEmitter 等外部绑定不能在这里使用。 */
  const createEvents = () => {
    const map = new Map<string, Set<(...args: any[]) => void>>()
    const events = {
      on(event: string, listener: (...args: any[]) => void) {
        const set = map.get(event) ?? new Set()
        map.set(event, set)
        set.add(listener)
        return events
      },
      once(event: string, listener: (...args: any[]) => void) {
        const wrapper = (...args: any[]): void => {
          events.off(event, wrapper)
          listener(...args)
        }
        return events.on(event, wrapper)
      },
      off(event: string, listener: (...args: any[]) => void) {
        map.get(event)?.delete(listener)
        return events
      },
      emit(event: string, ...args: any[]): void {
        for (const listener of [...(map.get(event) ?? [])]) listener(...args)
      },
      listenerCount(event: string): number {
        return map.get(event)?.size ?? 0
      },
    }
    return events
  }

  function sessionFor(partition: string): SessionMock {
    const existing = sessions.get(partition)
    if (existing) return existing
    const listeners: Listener[] = []
    const requests: RequestRecord[] = []
    const session: SessionMock = {
      partition,
      listeners,
      requests,
      authenticated: false,
      on: vi.fn(),
      removeListener: vi.fn(),
      setPermissionCheckHandler: vi.fn(),
      setPermissionRequestHandler: vi.fn(),
      webRequest: {
        onBeforeSendHeaders: vi.fn((filterOrNull: unknown, listener?: Listener) => {
          if (filterOrNull === null) {
            listeners.length = 0
            return
          }
          if (typeof listener === 'function') listeners.push(listener)
        }),
      },
      fetch: vi.fn(async (url: string) => {
        if (session.failWith !== undefined) return new Response(null, { status: session.failWith })
        if (partition.startsWith('huaanwork-artifact-') && artifactAuthFailure !== undefined) {
          return new Response(null, { status: artifactAuthFailure })
        }
        const owner = session.owner as { id?: number } | undefined
        let headers: Record<string, string> = {
          'x-dsh-desktop-renderer': rendererAccessHeader.value,
        }
        for (const listener of [...listeners]) {
          await new Promise<void>(resolve => {
            listener({
              id: 1,
              url,
              method: 'GET',
              webContentsId: owner?.id,
              webContents: owner,
              frame: null,
              resourceType: 'mainFrame',
              referrer: '',
              timestamp: 0,
              requestHeaders: headers,
            }, response => {
              headers = response.requestHeaders ?? headers
              resolve()
            })
          })
        }
        const hadRendererHeader = headers['x-dsh-desktop-renderer'] === rendererAccessHeader.value
        const cookieOnly = !hadRendererHeader && session.authenticated
        requests.push({ url, headers, hadRendererHeader, cookieOnly })
        if (hadRendererHeader) session.authenticated = true
        else if (!session.authenticated) return new Response(null, { status: 401 })
        return new Response(null, { status: 200 })
      }),
    }
    sessions.set(partition, session)
    return session
  }

  function createWebContents(partition: string, id: number): any {
    const events = createEvents()
    const session = sessionFor(partition)
    const contents: any = {
      id,
      session,
      mainFrame: { url: 'about:blank', frameTreeNodeId: id, detached: false, parent: null, framesInSubtree: [] },
      loadedUrls: [] as string[],
      setWindowOpenHandler: vi.fn(),
      ipc: { handle: vi.fn(), removeHandler: vi.fn() },
      isDestroyed: () => false,
      focus: vi.fn(),
      setZoomLevel: vi.fn(),
      getZoomLevel: vi.fn(() => 0),
      executeJavaScript: vi.fn(async () => null),
      closeDevTools: vi.fn(),
      isDevToolsOpened: vi.fn(() => false),
      openDevTools: vi.fn(),
      reloadIgnoringCache: vi.fn(),
      forcefullyCrashRenderer: vi.fn(),
      isLoadingMainFrame: vi.fn(() => false),
      loadURL: vi.fn(async (url: string) => {
        contents.loadedUrls.push(url)
        contents.mainFrame.url = url
      }),
      on: (event: string, listener: (...args: any[]) => void) => events.on(event, listener),
      once: (event: string, listener: (...args: any[]) => void) => events.once(event, listener),
      off: (event: string, listener: (...args: any[]) => void) => events.off(event, listener),
      emit: (event: string, ...args: any[]) => events.emit(event, ...args),
      listenerCount: (event: string) => events.listenerCount(event),
    }
    session.owner = contents
    return contents
  }

  class BrowserWindow {
    private readonly events = createEvents()
    readonly webContents: any
    readonly contentView = { addChildView: vi.fn(), removeChildView: vi.fn() }
    destroyed = false
    visible = false
    readonly focus = vi.fn()
    readonly show = vi.fn(() => { this.visible = true })
    readonly hide = vi.fn(() => { this.visible = false })
    readonly minimize = vi.fn()
    readonly restore = vi.fn()
    readonly flashFrame = vi.fn()
    readonly removeMenu = vi.fn()
    readonly setFullScreen = vi.fn()
    readonly setBackgroundMaterial = vi.fn()
    readonly loadFile = vi.fn(async () => {})
    readonly loadURL = vi.fn(async (url: string) => { await this.webContents.loadURL(url) })
    readonly destroy = vi.fn(() => {
      this.destroyed = true
      this.emit('closed')
    })

    constructor(options: any) {
      const partition = options?.webPreferences?.partition ?? 'default'
      this.webContents = createWebContents(partition, 73 + windows.length)
      browserWindowConstructor(options)
      windows.push(this)
    }

    on(event: string, listener: (...args: any[]) => void): this { this.events.on(event, listener); return this }
    once(event: string, listener: (...args: any[]) => void): this { this.events.once(event, listener); return this }
    off(event: string, listener: (...args: any[]) => void): this { this.events.off(event, listener); return this }
    emit(event: string, ...args: any[]): void { this.events.emit(event, ...args) }

    isDestroyed(): boolean { return this.destroyed }
    isFocused(): boolean { return false }
    isVisible(): boolean { return this.visible }
    isMinimized(): boolean { return false }
    isFullScreen(): boolean { return false }
    getNormalBounds() { return { x: 120, y: 80, width: 1280, height: 840 } }
    getContentSize(): [number, number] { return [1280, 840] }
  }

  class WebContentsView {
    readonly webContents: any
    readonly setBounds = vi.fn()
    readonly setBackgroundColor = vi.fn()
    constructor(options: any) {
      this.webContents = createWebContents(options?.webPreferences?.partition ?? 'view', 900)
    }
  }

  class Tray {
    readonly setToolTip = vi.fn()
    readonly setContextMenu = vi.fn()
    readonly on = vi.fn()
    readonly off = vi.fn()
    readonly destroy = vi.fn()
    constructor() { trayInstances.push(this) }
  }

  class Notification {
    static readonly isSupported = vi.fn(() => true)
    readonly once = vi.fn()
    readonly show = vi.fn()
  }

  return {
    app: {
      dock: { setIcon: vi.fn() },
      getLocale: vi.fn(() => 'en-US'),
      getPreferredSystemLanguages: vi.fn(() => ['en-US']),
      getPath: vi.fn(() => '/tmp/dsh-desktop-user-data'),
      getVersion: vi.fn(() => '43.4.0'),
      isPackaged: false,
      isHidden: vi.fn(() => false),
      show: vi.fn(),
      setBadgeCount: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
    },
    BrowserWindow,
    WebContentsView,
    Notification,
    Tray,
    browserWindowConstructor,
    rendererAccessHeader,
    sessionFor,
    sessions,
    windows,
    resetArtifactWindows() {
      windows.length = 0
      sessions.clear()
      browserWindowConstructor.mockReset()
      artifactAuthFailure = undefined
    },
    setArtifactAuthFailure(status: number | undefined) {
      artifactAuthFailure = status
    },
    dialog: {
      showErrorBox: vi.fn(),
      showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })),
      showSaveDialog: vi.fn(async () => ({ canceled: true, filePath: undefined })),
      showMessageBox: vi.fn(async () => ({ response: 0, checkboxChecked: false })),
    },
    Menu: {
      buildFromTemplate: vi.fn((template: unknown[]) => ({ template })),
      setApplicationMenu: vi.fn(),
    },
    nativeImage: {
      createFromPath: vi.fn(() => ({ isEmpty: () => false, setTemplateImage: vi.fn() })),
    },
    nativeTheme: { themeSource: 'system', get shouldUseDarkColors() { return false } },
    net: { fetch: vi.fn(), request: vi.fn() },
    powerSaveBlocker: {
      start: vi.fn(() => 1),
      stop: vi.fn(),
      isStarted: vi.fn(() => true),
    },
    powerMonitor: {
      on: vi.fn(),
      off: vi.fn(),
    },
    screen: {
      getDisplayMatching: vi.fn(() => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } })),
    },
    shell: { openExternal: vi.fn(async () => {}), openPath: vi.fn(async () => ''), showItemInFolder: vi.fn() },
    desktopCapturer: { getSources: vi.fn(async () => []) },
    systemPreferences: {
      getMediaAccessStatus: vi.fn(() => 'not-determined'),
      askForMediaAccess: vi.fn(async () => true),
      isTrustedAccessibilityClient: vi.fn(() => false),
    },
  }
})

vi.mock('electron', () => ({
  app: electron.app,
  BrowserWindow: electron.BrowserWindow,
  WebContentsView: electron.WebContentsView,
  dialog: electron.dialog,
  desktopCapturer: electron.desktopCapturer,
  systemPreferences: electron.systemPreferences,
  Menu: electron.Menu,
  nativeImage: electron.nativeImage,
  nativeTheme: electron.nativeTheme,
  net: electron.net,
  powerSaveBlocker: electron.powerSaveBlocker,
  powerMonitor: electron.powerMonitor,
  Notification: electron.Notification,
  screen: electron.screen,
  shell: electron.shell,
  Tray: electron.Tray,
}))

const spec: DesktopShellSpec = {
  mode: 'advanced',
  macosMaterial: 'transparent',
  windowsMaterial: 'off',
  material: 'off',
  width: 1280,
  height: 840,
  minWidth: 900,
  minHeight: 640,
  url: 'http://127.0.0.1:43120/?dsh-desktop-mode=advanced',
  authenticationUrl: 'http://127.0.0.1:43120/?token=test-token',
  rendererAccessHeader: electron.rendererAccessHeader,
  productName: 'HuaAnWork',
  windowTitle: 'HuaAnWork',
  iconPath: '/tmp/app-icon.png',
  trayIcons: { templatePath: '/tmp/tray-iconTemplate.png', bluePath: '/tmp/tray-icon-blue.png' },
  readLocalePreference: () => undefined,
  readThemeSource: () => 'system',
  requestQuit: () => {},
  requestModeChange: async () => {},
}

const ORIGIN = 'http://127.0.0.1:43120'

const RENDERER_TOKEN = Buffer.alloc(32, 7).toString('base64url')

describe('Desktop browser access policy', () => {
  it('creates an opaque generation-scoped renderer capability', () => {
    const first = createDesktopBrowserAccess(false)
    const second = createDesktopBrowserAccess(false)

    expect(first.rendererHeader.name).toBe(DESKTOP_RENDERER_ACCESS_HEADER)
    expect(first.rendererHeader.value).toMatch(/^[A-Za-z0-9_-]{43}$/u)
    expect(first.rendererHeader.value).not.toBe(second.rendererHeader.value)
    expect(Object.isFrozen(first)).toBe(true)
    expect(Object.isFrozen(first.rendererHeader)).toBe(true)
  })

  it('rejects invalid injected test tokens', () => {
    expect(() => createDesktopBrowserAccess(false, 'short')).toThrow('32 base64url bytes')
  })

  it('changes ordinary-browser access without replacing the renderer capability', () => {
    const access = createDesktopBrowserAccess(false, RENDERER_TOKEN)

    expect(decideDesktopBrowserAccess(access, { headers: {}, url: '/' })).toBe('denied')
    access.setOrdinaryBrowserEnabled(true)
    expect(decideDesktopBrowserAccess(access, { headers: {}, url: '/' })).toBe('browser')
    expect(access.rendererHeader.value).toBe(RENDERER_TOKEN)
    access.setOrdinaryBrowserEnabled(false)
    expect(decideDesktopBrowserAccess(access, { headers: {}, url: '/' })).toBe('denied')
    expect(() => access.setOrdinaryBrowserEnabled('yes' as unknown as boolean))
      .toThrow('ordinary browser access must be a boolean')
  })

  it('always permits an Electron request carrying the exact capability', () => {
    const access = createDesktopBrowserAccess(false, RENDERER_TOKEN)

    expect(decideDesktopBrowserAccess(access, {
      headers: { [DESKTOP_RENDERER_ACCESS_HEADER]: RENDERER_TOKEN },
      url: '/?dsh-desktop-mode=compatibility',
    })).toBe('renderer')
    expect(decideDesktopBrowserAccess(access, {
      headers: { [DESKTOP_RENDERER_ACCESS_HEADER]: `${RENDERER_TOKEN}x` },
      url: '/',
    })).toBe('denied')
    expect(decideDesktopBrowserAccess(access, {
      headers: { [DESKTOP_RENDERER_ACCESS_HEADER]: [RENDERER_TOKEN] },
      url: '/',
    })).toBe('denied')
    expect(() => decideDesktopBrowserAccess(access, {
      headers: { [DESKTOP_RENDERER_ACCESS_HEADER]: '你'.repeat(43) },
      url: '/',
    })).not.toThrow()
    expect(decideDesktopBrowserAccess(access, {
      headers: { [DESKTOP_RENDERER_ACCESS_HEADER]: '你'.repeat(43) },
      url: '/',
    })).toBe('denied')
  })

  it('allows only marker-free ordinary-browser traffic when enabled', () => {
    const access = createDesktopBrowserAccess(true, RENDERER_TOKEN)

    for (const url of ['/', '/assets/index.js', '/api/events.sse', '/?workspace=one']) {
      expect(decideDesktopBrowserAccess(access, { headers: {}, url })).toBe('browser')
    }
    for (const url of [
      '/?dsh-desktop-mode=compatibility',
      '/?dsh-desktop-platform=win32',
      '/?other=1&dsh-desktop-future=value',
    ]) {
      expect(decideDesktopBrowserAccess(access, { headers: {}, url })).toBe('denied')
    }
  })

  it('fails closed for malformed URLs and Desktop marker attempts', () => {
    expect(desktopBrowserUrlHasRendererMarkers('http://[')).toBe(true)
    expect(desktopBrowserUrlHasRendererMarkers('/?desktop-mode=compatibility')).toBe(false)
    expect(desktopBrowserUrlHasRendererMarkers('/?dsh-desktop-mode=compatibility')).toBe(true)
  })
})

async function mountRuntime(): Promise<{
  runtime: import('../src/electron-runtime.ts').ElectronDesktopRuntime
  release: () => Promise<void>
  mainWindow: any
}> {
  // 高级窗口只在 macOS/Windows 上构造。Ubuntu 的 `yarn check` 仍会跑本文件，
  // 这里在 runtime 读平台之前钉成 darwin；Electron 是 mock，断言只覆盖访问头生命周期。
  if (process.platform === 'linux') {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
  }
  const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
  const runtime = new ElectronDesktopRuntime(async () => {})
  const release = runtime.schedule(spec)
  await runtime.mountScheduled()
  return { runtime, release, mainWindow: electron.windows[0] }
}

function artifactWindow(): any {
  return electron.windows.at(-1)
}

function activeListener(session: SessionMock): Listener {
  const listener = session.listeners.at(-1)
  if (listener === undefined) throw new Error('no active renderer access listener')
  return listener
}

function invoke(listener: Listener, details: Record<string, unknown>): Record<string, string> {
  let result: Record<string, string> = {}
  listener(details, response => { result = response.requestHeaders ?? {} })
  return result
}

describe('artifact renderer access lifecycle', () => {
  beforeEach(() => {
    electron.resetArtifactWindows()
    electron.shell.openExternal.mockReset()
    electron.shell.openExternal.mockResolvedValue(undefined)
    electron.dialog.showSaveDialog.mockResolvedValue({ canceled: true, filePath: undefined })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('authenticates the artifact session through its own new WebContents before loading', async () => {
    const { runtime, release, mainWindow } = await mountRuntime()
    try {
      await runtime.openArtifactFullscreen({ sessionId: 'session-1', artifactId: 'artifact-1' })

      const window = artifactWindow()
      expect(window).not.toBe(mainWindow)
      expect(window.webContents.id).not.toBe(mainWindow.webContents.id)
      const session = window.webContents.session as SessionMock
      expect(session).not.toBe(mainWindow.webContents.session)
      expect(session.requests[0]?.url).toBe(spec.authenticationUrl)
      expect(session.requests[0]?.hadRendererHeader).toBe(true)
      expect(session.listeners).toHaveLength(1)
      const loads = window.webContents.loadedUrls
      expect(loads[0]).toBe('about:blank')
      expect(new URL(loads[1]!).searchParams.get('artifactWindow')).toBe('1')
    } finally {
      await release()
    }
  })

  it('opens a second artifact with an existing cookie and still tags it through the live listener', async () => {
    const { runtime, release } = await mountRuntime()
    try {
      await runtime.openArtifactFullscreen({ sessionId: 'session-1', artifactId: 'artifact-1' })
      await runtime.openArtifactFullscreen({ sessionId: 'session-2', artifactId: 'artifact-2' })

      const session = artifactWindow().webContents.session as SessionMock
      expect(session.authenticated).toBe(true)
      expect(session.requests).toHaveLength(2)
      for (const request of session.requests) {
        expect(request.hadRendererHeader).toBe(true)
        expect(request.cookieOnly).toBe(false)
      }
    } finally {
      await release()
    }
  })

  it('drops the capability for a request without renderer identity under the live listener', async () => {
    const { runtime, release } = await mountRuntime()
    try {
      await runtime.openArtifactFullscreen({ sessionId: 'session-1', artifactId: 'artifact-1' })
      const session = artifactWindow().webContents.session as SessionMock
      const listener = activeListener(session)

      const tagged = invoke(listener, {
        id: 1,
        url: `${ORIGIN}/huaanwork/status`,
        method: 'GET',
        webContentsId: artifactWindow().webContents.id,
        webContents: { id: artifactWindow().webContents.id },
        frame: null,
        resourceType: 'mainFrame',
        referrer: '',
        timestamp: 0,
        requestHeaders: { accept: '*/*' },
      })
      expect(tagged[DESKTOP_RENDERER_ACCESS_HEADER]).toBe(electron.rendererAccessHeader.value)

      const anonymous = invoke(listener, {
        id: 2,
        url: `${ORIGIN}/huaanwork/status`,
        method: 'GET',
        webContentsId: undefined,
        frame: null,
        resourceType: 'mainFrame',
        referrer: '',
        timestamp: 0,
        requestHeaders: { accept: '*/*' },
      })
      expect(anonymous).toEqual({ accept: '*/*' })
    } finally {
      await release()
    }
  })

  it('releases the previous listener before re-authenticating the new target', async () => {
    const { runtime, release } = await mountRuntime()
    try {
      await runtime.openArtifactFullscreen({ sessionId: 'session-1', artifactId: 'artifact-1' })
      const session = artifactWindow().webContents.session as SessionMock
      const previous = activeListener(session)
      await runtime.openArtifactFullscreen({ sessionId: 'session-2', artifactId: 'artifact-2' })

      const current = activeListener(session)
      expect(current).not.toBe(previous)
      expect(session.listeners).toHaveLength(1)
      const registrationOrder = (session.webRequest.onBeforeSendHeaders as ReturnType<typeof vi.fn>)
        .mock.invocationCallOrder
      expect(registrationOrder).toHaveLength(3) // 旧 listener 安装 + 撤下 + 新 listener 安装
      // 旧 listener 已不在注册表:即使手动调用也不再代表当前会话的鉴权路径。
      expect(invoke(previous, {
        id: 3,
        url: `${ORIGIN}/huaanwork/status`,
        method: 'GET',
        webContentsId: undefined,
        frame: null,
        resourceType: 'mainFrame',
        referrer: '',
        timestamp: 0,
        requestHeaders: {},
      })).toEqual({})
    } finally {
      await release()
    }
  })

  it('cleans up the failed open and its listener without touching the main window', async () => {
    electron.setArtifactAuthFailure(500)
    const { runtime, release, mainWindow } = await mountRuntime()
    try {
      await expect(runtime.openArtifactFullscreen({ sessionId: 'session-1', artifactId: 'artifact-1' }))
        .rejects.toThrow('browser authentication failed with HTTP 500')
      const failedWindow = artifactWindow()
      expect(failedWindow.destroy).toHaveBeenCalled()
      const failedSession = failedWindow.webContents.session as SessionMock
      expect(failedSession.listeners).toHaveLength(0)

      // 主窗口监听不受影响。
      const mainSession = mainWindow.webContents.session as SessionMock
      expect(mainSession.listeners).toHaveLength(1)
      const mainListener = activeListener(mainSession)
      const tagged = invoke(mainListener, {
        id: 4,
        url: `${ORIGIN}/huaanwork/events`,
        method: 'GET',
        webContentsId: mainWindow.webContents.id,
        webContents: { id: mainWindow.webContents.id },
        frame: null,
        resourceType: 'mainFrame',
        referrer: '',
        timestamp: 0,
        requestHeaders: {},
      })
      expect(tagged[DESKTOP_RENDERER_ACCESS_HEADER]).toBe(electron.rendererAccessHeader.value)
    } finally {
      await release()
    }
  })

  it('serializes concurrent opens onto one artifact window and keeps the last target', async () => {
    const { runtime, release } = await mountRuntime()
    try {
      const before = electron.browserWindowConstructor.mock.calls.filter(([options]) =>
        String(options?.webPreferences?.partition ?? '').startsWith('huaanwork-artifact-')).length
      await Promise.all([
        runtime.openArtifactFullscreen({ sessionId: 'session-1', artifactId: 'artifact-1' }),
        runtime.openArtifactFullscreen({ sessionId: 'session-2', artifactId: 'artifact-2' }),
      ])
      const after = electron.browserWindowConstructor.mock.calls.filter(([options]) =>
        String(options?.webPreferences?.partition ?? '').startsWith('huaanwork-artifact-')).length
      expect(after - before).toBe(1)

      const window = artifactWindow()
      const business = window.webContents.loadedUrls.filter((url: string) => url !== 'about:blank')
      expect(business).toHaveLength(2)
      expect(new URL(business.at(-1)!).searchParams.get('artifactId')).toBe('artifact-2')
    } finally {
      await release()
    }
  })

  it('keeps the main HTTP and WebSocket listener valid after the artifact window closes', async () => {
    const { runtime, release, mainWindow } = await mountRuntime()
    try {
      await runtime.openArtifactFullscreen({ sessionId: 'session-1', artifactId: 'artifact-1' })
      const window = artifactWindow()
      window.destroy()
      expect(window.destroyed).toBe(true)

      const session = window.webContents.session as SessionMock
      expect(session.listeners).toHaveLength(0)

      const mainSession = mainWindow.webContents.session as SessionMock
      expect(mainSession.listeners).toHaveLength(1)
      const listener = activeListener(mainSession)
      for (const url of [`${ORIGIN}/huaanwork/status`, 'ws://127.0.0.1:43120/huaanwork/events']) {
        const tagged = invoke(listener, {
          id: 5,
          url,
          method: 'GET',
          webContentsId: mainWindow.webContents.id,
          webContents: { id: mainWindow.webContents.id },
          frame: null,
          resourceType: 'mainFrame',
          referrer: '',
          timestamp: 0,
          requestHeaders: {},
        })
        expect(tagged[DESKTOP_RENDERER_ACCESS_HEADER]).toBe(electron.rendererAccessHeader.value)
      }

      // 关闭后再次打开仍创建新的单例窗口。
      await runtime.openArtifactFullscreen({ sessionId: 'session-2', artifactId: 'artifact-2' })
      expect(artifactWindow()).not.toBe(window)
    } finally {
      await release()
    }
  })

  it('keeps the top-level navigation constraint and safe external-link policy', async () => {
    const { runtime, release } = await mountRuntime()
    try {
      await runtime.openArtifactFullscreen({ sessionId: 'session-1', artifactId: 'artifact-1' })
      const contents = artifactWindow().webContents

      const foreign = { preventDefault: vi.fn() }
      contents.emit('will-navigate', foreign, 'https://example.com/escape')
      expect(foreign.preventDefault).toHaveBeenCalled()

      const sameOrigin = { preventDefault: vi.fn() }
      contents.emit('will-navigate', sameOrigin, `${ORIGIN}/next`)
      expect(sameOrigin.preventDefault).not.toHaveBeenCalled()

      // 重定向入口与主窗口同款：主帧外源/畸形 URL 拦截，iframe 重定向放行。
      const redirectForeign = { preventDefault: vi.fn() }
      contents.emit('will-redirect', redirectForeign, 'https://example.com/redirect', false, true)
      expect(redirectForeign.preventDefault).toHaveBeenCalled()

      const redirectSameOrigin = { preventDefault: vi.fn() }
      contents.emit('will-redirect', redirectSameOrigin, `${ORIGIN}/next`, false, true)
      expect(redirectSameOrigin.preventDefault).not.toHaveBeenCalled()

      const redirectMalformed = { preventDefault: vi.fn() }
      contents.emit('will-redirect', redirectMalformed, 'not a URL', false, true)
      expect(redirectMalformed.preventDefault).toHaveBeenCalled()

      const redirectIframe = { preventDefault: vi.fn() }
      contents.emit('will-redirect', redirectIframe, 'https://example.com/plugin', false, false)
      expect(redirectIframe.preventDefault).not.toHaveBeenCalled()

      const handler = contents.setWindowOpenHandler.mock.calls[0]?.[0] as (details: {
        url: string
      }) => { action: string }
      expect(handler({ url: 'https://example.com/docs' })).toEqual({ action: 'deny' })
      expect(electron.shell.openExternal).toHaveBeenCalledWith('https://example.com/docs')
      expect(handler({ url: 'javascript:alert(1)' })).toEqual({ action: 'deny' })
      expect(electron.shell.openExternal).toHaveBeenCalledTimes(1)
    } finally {
      await release()
    }
  })
})
