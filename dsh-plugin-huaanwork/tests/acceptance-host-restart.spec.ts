import { expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(),
  invoke: vi.fn(),
}))

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: electron.exposeInMainWorld },
  ipcRenderer: { invoke: electron.invoke, on: vi.fn(), send: vi.fn(), removeListener: vi.fn() },
  webUtils: { getPathForFile: vi.fn() },
}))

it('exposes only the huaanwork acceptance Host-restart IPC bridge', async () => {
  await import('../src/preload.ts')
  const exposed = electron.exposeInMainWorld.mock.calls.find(([name]) => name === 'huaanworkAcceptance')
  expect(exposed).toBeDefined()
  const bridge = exposed![1] as { restartHost(): Promise<{ oldPid: number; newPid: number }> }
  const result = { oldPid: 123, newPid: 456 }
  electron.invoke.mockResolvedValue(result)

  await expect(bridge.restartHost()).resolves.toEqual(result)
  expect(electron.invoke).toHaveBeenCalledExactlyOnceWith('huaanwork:acceptance-host-restart')
})
