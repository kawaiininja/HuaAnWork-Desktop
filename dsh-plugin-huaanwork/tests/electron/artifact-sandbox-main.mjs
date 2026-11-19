import { app, BrowserWindow } from 'electron'
import { installArtifactFrameGuard } from '../../lib/artifact-frame-guard.js'

// 探针专用隐藏窗口：与生产主窗口同样的安全参数，不加 --no-sandbox、不装 Node preload。
await app.whenReady()
const window = new BrowserWindow({
  show: false,
  webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true },
})
export const guard = installArtifactFrameGuard(window.webContents)
export const blockedNavigations = []
export function artifactFrameId(name) {
  return window.webContents.mainFrame.framesInSubtree.find((frame) => frame.name === name)?.frameTreeNodeId
}
window.webContents.on('will-frame-navigate', (event) => {
  if (event.defaultPrevented) blockedNavigations.push({ url: event.url, frameTreeNodeId: event.frame?.frameTreeNodeId })
})
window.on('closed', () => guard.dispose())
await window.loadURL('about:blank')
app.on('window-all-closed', () => app.quit())
