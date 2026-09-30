/**
 * Task 6.12 启动清扫用例的共用装配:临时 profile + 真实 Cordis Context 上直调
 * `huaanwork-host` 的 `apply()`。
 *
 * 裁定 D-M6-24:清扫接在 `apply()` 内(每次 generation 启动都跑,天然晚于 main.ts
 * 的一次性迁移钩子),因此「起临时 profile、boot、断言清扫发生了」= 起 `apply()` 本身。
 * webServer/desktopRuntime 以最小桩供上(apply 的其余接线——routes 注册、upgrade
 * 注册、网络门禁、调度器禁用——照常执行,便于同场断言组合面未回归)。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { apply, type HuaanworkHostConfig } from '../../src/huaanwork-host/index.ts'

export interface BootedHuaanworkHost {
  ctx: Context
  registeredPaths: string[]
  upgradePaths: string[]
}

export function hostConfig(root: string): HuaanworkHostConfig {
  return {
    dshHome: join(root, 'home'),
    profileDir: join(root, 'profile'),
    workspaceRoot: join(root, 'profile', 'workspace'),
    automationScheduler: { disabled: true },
  }
}

export async function bootHuaanworkHost(config: HuaanworkHostConfig): Promise<BootedHuaanworkHost> {
  mkdirSync(config.profileDir, { recursive: true })
  mkdirSync(config.dshHome, { recursive: true })
  const registeredPaths: string[] = []
  const upgradePaths: string[] = []
  const ctx = new Context()
  ctx.provide('webServer', {
    port: 43_120,
    register: (route: { path: string }) => {
      registeredPaths.push(route.path)
      return () => {}
    },
    registerUpgrade: (options: { path: string }) => {
      upgradePaths.push(options.path)
      return () => {}
    },
  } as never)
  ctx.provide('desktopRuntime', { requestConfirmedRestart: async () => true } as never)
  await apply(ctx, config)
  return { ctx, registeredPaths, upgradePaths }
}

/** 三级布局会话日志:`<sessionsRoot>/<cwdKey>/<sessionId>/session.jsonl`,返回会话目录。 */
export function writeSessionLog(sessionsRoot: string, cwdKey: string, id: string, cwd: string): string {
  const dir = join(sessionsRoot, cwdKey, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'session.jsonl'),
    `${JSON.stringify({ type: 'session', version: 0, id, createdAt: 1_000, cwd, delegationDepth: 0 })}\n`,
    'utf8',
  )
  return dir
}

export function writeJsonFile(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}
