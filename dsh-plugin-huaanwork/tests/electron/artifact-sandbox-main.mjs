import { app, BrowserWindow } from 'electron'
import { installArtifactFrameGuard } from '../../lib/artifact-frame-guard.js'

// 探针专用隐藏窗口：与生产主窗口同样的安全参数，不加 --no-sandbox、不装 Node preload。
// 不能在主入口顶层 `await app.whenReady()`：Electron 的 ESM 主脚本求值未结束前不会发出
// ready 与 DevTools 端口，顶层 await 会导致 Playwright electron.launch() 永久挂起。
const blockedNavigations = []
let probeWindow
let probeGuard

/**
 * 挂到 globalThis 供 Playwright `app.evaluate()` 读取：Electron 44 的 Runtime.evaluate
 * 上下文未注册动态 import() 回调，直接 `import(mainUrl)` 会抛 TypeError。
 */
globalThis.__huaanworkArtifactSandboxProbe = {
  registerEmptyFrame(name) {
    if (!probeGuard) throw new Error('artifact-sandbox-probe-not-ready')
    probeGuard.registerEmptyFrame(name)
  },
  artifactFrameId(name) {
    return probeWindow?.webContents.mainFrame.framesInSubtree.find((frame) => frame.name === name)?.frameTreeNodeId
  },
  blockedNavigations,
}

void app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true },
  })
  probeWindow = win
  probeGuard = installArtifactFrameGuard(win.webContents)
  win.webContents.on('will-frame-navigate', (event) => {
    if (event.defaultPrevented) {
      blockedNavigations.push({ url: event.url, frameTreeNodeId: event.frame?.frameTreeNodeId })
    }
  })
  win.on('closed', () => {
    probeGuard?.dispose()
    probeGuard = undefined
    probeWindow = undefined
  })
  await win.loadURL('about:blank')
})

app.on('window-all-closed', () => app.quit())
