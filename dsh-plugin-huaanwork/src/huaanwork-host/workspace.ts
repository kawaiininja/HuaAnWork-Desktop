import { existsSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { RouteError, type RouteContext } from './routes.ts'
import { neutralWorkspaceRoot, writePendingWorkspaceRoot } from './workspace-state.ts'

/**
 * workspace.open:写 pendingRoot → 请求 generation 重启;组合期由 profile.ts 消费。
 * 重启为整代重启(Electron relaunch),fetch 连接必然中断,客户端由 api.ts
 * 的 waitForReady 轮询 /huaanwork/status 承接(视图层零改动)。
 */
export async function openWorkspace(routeCtx: RouteContext, root: string): Promise<{ restarting: true }> {
  if (!root) {
    throw new RouteError(400, 'validation', 'workspace.open requires root')
  }
  const target = resolve(root)
  if (!existsSync(target) || !statSync(target).isDirectory()) {
    throw new RouteError(400, 'validation', `目录不存在:${target}`)
  }
  writePendingWorkspaceRoot(routeCtx.profileDir, target)
  await routeCtx.requestRestart()
  return { restarting: true }
}

/**
 * workspace.close:回到中立根(未归属项目的「任务」会话工作目录)。
 * 旧语义钉中立根而非删文件——写 pendingRoot=中立根,保证下次组合仍钉中立根的
 * sandbox(若清文件,组合期 fallback 也是 neutralWorkspaceRoot,两者等价;
 * 显式写出让状态文件可读、与 open 同构)。
 */
export async function closeWorkspace(routeCtx: RouteContext): Promise<{ restarting: true }> {
  writePendingWorkspaceRoot(routeCtx.profileDir, neutralWorkspaceRoot(routeCtx.profileDir))
  await routeCtx.requestRestart()
  return { restarting: true }
}
