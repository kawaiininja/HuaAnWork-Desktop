import type { RpcEvent } from './rpc-types.ts'

export type TreeNode = { name: string; path: string; isDir: boolean; children?: TreeNode[] }

const NOT_WIRED = 'M2 打桩:此功能在 M3 接入 Host route 后可用'

const settingsFixture = {
  base_url: 'http://127.0.0.1:11434/v1',
  model: '',
  api_key: '',
  theme: 'system',
  models: [{ id: 'default', name: '默认', base_url: 'http://127.0.0.1:11434/v1', model: '', api_key: '' }],
  active_model_id: 'default',
  allow_network: false,
  guard_mode: 'ask',
  automation_timeout_ms: 600_000,
  keep_awake: true,
  agents_host: '',
  agents_port: '',
  agents_catalog_token: '',
}

let currentSettings = { ...settingsFixture }

type Stub = (params: any) => unknown

const stubs: Record<string, Stub> = {
  // -- 静态可用关键路径(AuthGate / Settings / App 启动门) --
  'status.get': () => ({ ready: true }),
  'auth.status': () => ({ state: 'logged-out' }),
  'auth.register': (p) => ({ state: 'logged-in', username: p?.username ?? 'dev' }),
  'auth.login': (p) => ({ state: 'logged-in', username: p?.username ?? 'dev' }),
  'auth.logout': () => ({}),
  'auth.changePassword': () => ({}),
  'settings.get': () => ({ ...currentSettings, models: currentSettings.models.map((m) => ({ ...m })) }),
  'settings.set': (p) => {
    currentSettings = { ...currentSettings, ...(p ?? {}), models: p?.models ?? currentSettings.models }
    return { ...currentSettings, models: currentSettings.models.map((m) => ({ ...m })) }
  },
  // -- 读操作:空集合 fixture(视图渲染空态) --
  'session.list': () => [],
  'session.new': () => ({ sessionId: 'huaanwork-stub' }),
  'project.list': () => ({ projects: [] }),
  'task.list': () => ({ tasks: [] }),
  'automation.list': () => ({ automations: [], runs: {}, missed: {} }),
  'automation.runs': () => ({ runs: [] }),
  'automation.templates': () => ({ templates: [] }),
  'skill.list': () => ({ skills: [] }),
  'agent.list': () => ({ items: [] }),
  'plugin.list': () => ({ bundles: [] }),
}

export const STUB_METHODS = [
  ...Object.keys(stubs),
  'workspace.open', 'workspace.close',
  'session.send', 'session.cancel', 'session.approve', 'session.reject', 'session.open', 'session.remove', 'session.resume',
  'plugin.add', 'plugin.remove',
  'skill.get', 'skill.create', 'skill.update', 'skill.remove', 'skill.importPreview', 'skill.import', 'skill.setEnabled',
  'agent.get', 'agent.refresh', 'agent.setEnabled', 'agent.addEndpoint', 'agent.removeEndpoint',
  'project.create', 'project.open', 'project.remove', 'project.rename',
  'automation.create', 'automation.update', 'automation.remove', 'automation.run', 'automation.pruneSessions',
  'task.create', 'task.remove', 'task.bindSession', 'task.rename',
] as const

export async function rpcCall<T>(method: string, params?: unknown): Promise<T> {
  const stub = stubs[method]
  if (stub) return stub(params) as T
  if ((STUB_METHODS as readonly string[]).includes(method)) throw new Error(`${NOT_WIRED}(${method})`)
  throw new Error(`unknown method: ${method}`)
}

const handlers = new Set<(event: RpcEvent) => void>()

export async function onSidecarEvent(handler: (event: RpcEvent) => void): Promise<() => void> {
  handlers.add(handler)
  queueMicrotask(() => {
    if (handlers.has(handler)) handler({ event: 'sidecar/status', ready: true })
  })
  return () => { handlers.delete(handler) }
}

export async function onSidecarExit(_handler: (state: { ready: boolean }) => void): Promise<() => void> {
  return () => {}
}

export async function hasGit(_root: string): Promise<boolean> {
  return false
}

export async function listTree(_root: string, _depth?: number): Promise<TreeNode[]> {
  return []
}

export async function setKeepAwake(_hold: boolean): Promise<boolean> {
  return false
}

export async function pickDirectory(): Promise<string | null> {
  return null
}

export function notifyRunFailed(title: string, body: string): void {
  try {
    new Notification(title, { body })
  } catch {
    // 静默降级
  }
}
