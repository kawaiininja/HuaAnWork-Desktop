import { describe, expect, test } from 'vitest'
import { STUB_METHODS, hasGit, listTree, onSidecarEvent, pickDirectory, rpcCall, setKeepAwake } from '../../src/client-huaanwork/api.ts'

const ALL_METHODS = [
  'workspace.open', 'workspace.close',
  'session.send', 'session.cancel', 'session.approve', 'session.reject', 'session.list', 'session.open', 'session.remove', 'session.new', 'session.resume',
  'settings.get', 'settings.set',
  'auth.status', 'auth.register', 'auth.login', 'auth.logout', 'auth.changePassword',
  'plugin.add', 'plugin.remove', 'plugin.list',
  'skill.list', 'skill.get', 'skill.create', 'skill.update', 'skill.remove', 'skill.importPreview', 'skill.import', 'skill.setEnabled',
  'agent.list', 'agent.get', 'agent.refresh', 'agent.setEnabled', 'agent.addEndpoint', 'agent.removeEndpoint',
  'status.get',
  'project.list', 'project.create', 'project.open', 'project.remove', 'project.rename',
  'automation.list', 'automation.create', 'automation.update', 'automation.remove', 'automation.run', 'automation.runs', 'automation.pruneSessions', 'automation.templates',
  'task.list', 'task.create', 'task.remove', 'task.bindSession', 'task.rename',
]

describe('api stub', () => {
  test('54 个方法全部登记,无遗漏', () => {
    expect([...STUB_METHODS].sort()).toEqual([...ALL_METHODS].sort())
  })

  test('静态可用关键路径:auth/settings/status', async () => {
    await expect(rpcCall('auth.status')).resolves.toEqual({ state: 'logged-out' })
    await expect(rpcCall('auth.login', { username: 'dev', password: 'x'.repeat(8) })).resolves.toMatchObject({ state: 'logged-in', username: 'dev' })
    await expect(rpcCall('status.get')).resolves.toEqual({ ready: true })
    const settings = await rpcCall<any>('settings.get')
    expect(settings).toMatchObject({ allow_network: false, guard_mode: 'ask', active_model_id: 'default' })
    expect(Array.isArray(settings.models)).toBe(true)
  })

  test('读操作返回空集合 fixture', async () => {
    await expect(rpcCall('session.list')).resolves.toEqual([])
    await expect(rpcCall('project.list')).resolves.toEqual({ projects: [] })
    await expect(rpcCall('automation.list')).resolves.toEqual({ automations: [], runs: {}, missed: {} })
    await expect(rpcCall('skill.list')).resolves.toEqual({ skills: [] })
    await expect(rpcCall('agent.list')).resolves.toEqual({ items: [] })
    await expect(rpcCall('plugin.list')).resolves.toEqual({ bundles: [] })
    await expect(rpcCall('automation.templates')).resolves.toEqual({ templates: [] })
    await expect(rpcCall('task.list', { projectId: 'p' })).resolves.toEqual({ tasks: [] })
    await expect(rpcCall('session.new')).resolves.toEqual({ sessionId: 'huaanwork-stub' })
  })

  test('写操作诚实报错,不静默假成功', async () => {
    for (const method of ['session.send', 'session.cancel', 'session.approve', 'session.reject', 'session.remove',
      'workspace.open', 'workspace.close', 'project.create', 'project.open', 'project.remove', 'project.rename',
      'automation.create', 'automation.update', 'automation.remove', 'automation.run', 'automation.pruneSessions',
      'task.create', 'task.remove', 'task.bindSession', 'task.rename',
      'skill.create', 'skill.update', 'skill.remove', 'skill.import', 'skill.importPreview', 'skill.setEnabled',
      'agent.refresh', 'agent.setEnabled', 'agent.addEndpoint', 'agent.removeEndpoint', 'agent.get', 'skill.get',
      'plugin.add', 'plugin.remove', 'session.resume', 'session.open']) {
      await expect(rpcCall(method)).rejects.toThrow(/M2 打桩/)
    }
  })

  test('settings.set 合并回显且持久化至内存', async () => {
    const next = await rpcCall<any>('settings.set', { allow_network: true })
    expect(next.allow_network).toBe(true)
    expect(next.guard_mode).toBe('ask')
    const fetched = await rpcCall<any>('settings.get')
    expect(fetched.allow_network).toBe(true)
  })

  test('auth.logout / auth.changePassword 静默成功', async () => {
    await expect(rpcCall('auth.logout')).resolves.toEqual({})
    await expect(rpcCall('auth.changePassword', { current: 'a', next: 'b'.repeat(8) })).resolves.toEqual({})
  })

  test('原生桥 stub', async () => {
    await expect(hasGit('/tmp')).resolves.toBe(false)
    await expect(listTree('/tmp')).resolves.toEqual([])
    await expect(setKeepAwake(true)).resolves.toBe(false)
    await expect(pickDirectory()).resolves.toBeNull()
  })

  test('事件总线:订阅后补发 sidecar/status ready', async () => {
    const events: any[] = []
    await onSidecarEvent((event) => events.push(event))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(events).toContainEqual({ event: 'sidecar/status', ready: true })
  })
})
