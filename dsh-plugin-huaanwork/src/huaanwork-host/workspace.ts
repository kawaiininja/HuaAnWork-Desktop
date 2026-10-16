import { existsSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { RouteError, type RouteContext } from './routes.ts'
import { assertAutomationIdle } from './sessions.ts'
import { neutralWorkspaceRoot } from './workspace-state.ts'

/**
 * 工作区切换应答。切换在当前进程完成:改 `workspaceRoot` holder(新会话与
 * sandbox-cwd 都读它),并尽量同步 sandboxPolicy.workspaceRoot。不应答
 * `restarting`,不写 pendingRoot,不弹重启确认框。
 * `restarting` 仍留在联合类型里,是插件安装等其它路径的应答形状;本文件不产生它。
 */
export type WorkspaceResult = { restarting: true; workspaceRoot: string } | { workspaceRoot: string }

/**
 * 把已打开的工作区钉到 target。holder 与 cordis 上的 sandboxPolicy 快照一起改,
 * 这样新建会话的 cwd 和直接读 workspaceRoot 的工具都看到新目录。
 * sandboxPolicy 未注入时 get 会抛,holder 已经切完,不因此失败。
 */
function pinWorkspace(routeCtx: RouteContext, target: string): void {
  routeCtx.workspaceRoot.current = target
  const runtime = routeCtx.runtimeCtx
  if (!runtime) return
  try {
    const direct = runtime.sandboxPolicy
    const found = direct ?? (typeof runtime.get === 'function' ? runtime.get('sandboxPolicy') : undefined)
    if (found && typeof found === 'object' && 'workspaceRoot' in found) {
      ;(found as { workspaceRoot?: string }).workspaceRoot = target
    }
  } catch (error) {
    // Cordis 在本插件未注入 sandboxPolicy 时，读属性或 get 会抛。
    // holder 已经指向目标目录，策略快照写失败不能让这次切换对调用方失败，
    // 否则第一次点击报错、第二次因已在目标根而短路成功。
    if (!(error instanceof Error)) throw error
  }
}

/**
 * workspace.open:校验目录后在进程内切到目标根。
 * assertAutomationIdle 先于一切;已在目标根时短路,不改 holder。
 */
export async function openWorkspace(routeCtx: RouteContext, root: string): Promise<WorkspaceResult> {
  assertAutomationIdle()
  if (!root) {
    throw new RouteError(400, 'validation', 'workspace.open requires root')
  }
  const target = resolve(root)
  if (!existsSync(target) || !statSync(target).isDirectory()) {
    throw new RouteError(400, 'validation', `目录不存在:${target}`)
  }
  if (target === resolve(routeCtx.workspaceRoot.current)) {
    return { workspaceRoot: routeCtx.workspaceRoot.current }
  }
  pinWorkspace(routeCtx, target)
  return { workspaceRoot: target }
}

/**
 * workspace.close:回到中立根(未归属项目的「任务」会话工作目录)。
 * 已在中立根时短路;否则与 open 一样进程内切换,不重启。
 */
export async function closeWorkspace(routeCtx: RouteContext): Promise<WorkspaceResult> {
  assertAutomationIdle()
  const neutral = neutralWorkspaceRoot(routeCtx.profileDir)
  if (resolve(routeCtx.workspaceRoot.current) === resolve(neutral)) {
    return { workspaceRoot: routeCtx.workspaceRoot.current }
  }
  pinWorkspace(routeCtx, neutral)
  return { workspaceRoot: neutral }
}
