import { existsSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { RouteError, type RouteContext } from './routes.ts'
import { assertAutomationIdle } from './sessions.ts'
import { clearPendingWorkspaceRoot, neutralWorkspaceRoot, writePendingWorkspaceRoot } from './workspace-state.ts'

/**
 * workspace.open/close 应答:确认重启后主进程下一拍才 relaunch,HTTP 应答与
 * teardown 无先后保证,两条时序都可能(评审 R6:不按概率描述):200 +
 * `{ restarting: true, workspaceRoot }` 正常写出(评审 D1:workspaceRoot 恒在,
 * 客户端契约以此为准);或连接被掐断,由 api.ts waitForReady 按
 * `{ restarting: true }` 承接——两条路径客户端都必须承接。用户在确认框取消时
 * 返回当前根 `{ workspaceRoot }`(与「已在目标根」短路同形),不应答 restarting
 * (评审 D2-③)。
 */
export type WorkspaceResult = { restarting: true; workspaceRoot: string } | { workspaceRoot: string }

/**
 * workspace.open:写 pendingRoot → 弹确认框;确认 → generation 重启,组合期由
 * profile.ts 消费;取消 → 立即清除 pendingRoot,workspace 维持当前根(评审 D2-②:
 * 残留 pendingRoot 会在下次冷启动被静默消费)。
 * 旧 host.ts:1013-1019 语义:assertAutomationIdle 先于一切;已在目标根时短路
 * (不写 pendingRoot、不重启),消除同根发送时的整窗重载。
 * 已知残余窗口:确认框挂起期间进程被杀(⌘Q),pendingRoot 已落盘而无裁决可回传,
 * 下次启动仍会消费——main 侧不回传该事件,属可接受的极端边角。
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
  const confirmed = await routeCtx.requestRestart()
  if (!confirmed) {
    clearPendingWorkspaceRoot(routeCtx.profileDir)
    return { workspaceRoot: routeCtx.workspaceRoot.current }
  }
  return { restarting: true, workspaceRoot: target }
}

/**
 * workspace.close:回到中立根(未归属项目的「任务」会话工作目录)。
 * 旧 host.ts:1019-1023 语义:已在中立根时短路(`workspaceRoot !== defaultWorkspaceRoot`
 * 才切换),App.tsx ensureNeutralWorkspace 因此不会每次发送都触发整窗 relaunch。
 * 真切换写 pendingRoot=中立根(不删文件,钉中立根 sandbox 且状态可读);
 * 取消与确认的处理同 openWorkspace。
 */
export async function closeWorkspace(routeCtx: RouteContext): Promise<WorkspaceResult> {
  assertAutomationIdle()
  const neutral = neutralWorkspaceRoot(routeCtx.profileDir)
  if (resolve(routeCtx.workspaceRoot.current) === resolve(neutral)) {
    return { workspaceRoot: routeCtx.workspaceRoot.current }
  }
  writePendingWorkspaceRoot(routeCtx.profileDir, neutral)
  const confirmed = await routeCtx.requestRestart()
  if (!confirmed) {
    clearPendingWorkspaceRoot(routeCtx.profileDir)
    return { workspaceRoot: routeCtx.workspaceRoot.current }
  }
  return { restarting: true, workspaceRoot: neutral }
}
