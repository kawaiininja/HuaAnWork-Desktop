import { existsSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { RouteError, type RouteContext } from './routes.ts'
import { assertAutomationIdle } from './sessions.ts'
import { neutralWorkspaceRoot, writePendingWorkspaceRoot } from './workspace-state.ts'

/**
 * workspace.open/close 应答:真重启路径 fetch 必然中断,客户端由 api.ts
 * waitForReady 按 `{ restarting: true }` 承接;短路路径(已在目标根)返回
 * `{ workspaceRoot }`,与旧 sidecar 应答同形(host.ts:1017/1023),
 * App.tsx 的工作区对齐早退(`workspaceRef.current === root`)靠它。
 */
export type WorkspaceResult = { restarting: true } | { workspaceRoot: string }

/**
 * workspace.open:写 pendingRoot → 请求 generation 重启;组合期由 profile.ts 消费。
 * 旧 host.ts:1013-1019 语义:assertAutomationIdle 先于一切;已在目标根时短路
 * (不写 pendingRoot、不重启),消除同根发送时的整窗重载。
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
  writePendingWorkspaceRoot(routeCtx.profileDir, target)
  await routeCtx.requestRestart()
  return { restarting: true }
}

/**
 * workspace.close:回到中立根(未归属项目的「任务」会话工作目录)。
 * 旧 host.ts:1019-1023 语义:已在中立根时短路(`workspaceRoot !== defaultWorkspaceRoot`
 * 才切换),App.tsx ensureNeutralWorkspace 因此不会每次发送都触发整窗 relaunch。
 * 真切换写 pendingRoot=中立根(不删文件,钉中立根 sandbox 且状态可读)。
 */
export async function closeWorkspace(routeCtx: RouteContext): Promise<WorkspaceResult> {
  assertAutomationIdle()
  const neutral = neutralWorkspaceRoot(routeCtx.profileDir)
  if (resolve(routeCtx.workspaceRoot.current) === resolve(neutral)) {
    return { workspaceRoot: routeCtx.workspaceRoot.current }
  }
  writePendingWorkspaceRoot(routeCtx.profileDir, neutral)
  await routeCtx.requestRestart()
  return { restarting: true }
}
