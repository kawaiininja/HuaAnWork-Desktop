import { readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { LEGACY_CHAT_AUTO_SESSION_PREFIX } from './automation-session-ids.ts'

/**
 * G6 清扫(Task 6.12):旧 chat 通道自动化运行会话(`huaanwork-chat-auto-*`)的
 * 一次性启动清扫 + `.runs.jsonl` 死链过滤。
 *
 * 逐字移植旧 sidecar `packages/sidecar/src/automations.ts:573-655`
 * (`sweepLegacyChatAutoSessions` → `removeLegacyChatAutoSessionDirs` +
 * `filterLegacyChatAutoRuns`),判据逐条保持:
 * - 前缀来自本目录 `automation-session-ids.ts`(与铸造入口同源,不重写字面量);
 * - 顶层与下探一层都扫(`rm -r` 对两级散文件与三级会话目录布局同效);
 * - `.runs.jsonl` 只删 `sessionId` 以 legacy 前缀开头的运行记录;**不可解析的行保留**
 *   (清扫绝不抹掉无法解析的历史),`huaanwork-auto-` 当前通道行原样保留;
 * - `huaanwork-chat-<digest>` 用户会话不在判据内(旧 AGENTS.md 不变式 9);
 * - 幂等:无可删项即 no-op;readdir 次数 = 顶层 + 各非 legacy 顶层项一层 + runs 目录,
 *   不随会话数增长(不做全树遍历)。
 *
 * 定向改动(相对旧实现,与 session-sweep.ts 同原则):sessions 根与 runs 根由调用方
 * 显式传入——旧版都由 dshHome 拼出,而 Desktop 组合下会话在 `dshHome/sessions`、
 * automations 注册表在 `profileDir`。fs 以窄接口注入(默认 node:fs/promises):测试用
 * 计数桩钉「第二跑 0 删除 + readdir 不随会话数增长」——裁定 D-M6-24 下 `apply()` 每次
 * generation 重启都会跑清扫(旧 sidecar 只在进程启动时扫一次)。
 */
export interface AutomationSweepFileSystem {
  readdir(path: string): Promise<string[]>
  readFile(path: string, encoding: 'utf8'): Promise<string>
  rm(path: string, options: { recursive: true; force: true }): Promise<void>
  writeFile(path: string, data: string, encoding: 'utf8'): Promise<void>
}

const nodeAutomationSweepFs: AutomationSweepFileSystem = {
  readdir: (path) => readdir(path),
  readFile: (path, encoding) => readFile(path, encoding),
  rm: (path, options) => rm(path, options),
  writeFile: (path, data, encoding) => writeFile(path, data, encoding),
}

/** 一次性清扫:删除旧 chat 通道自动化运行会话目录,并过滤引用它们的运行记录(避免死链)。返回删除目录数。 */
export async function sweepLegacyChatAutoSessions(
  sessionsRoot: string,
  runsDir: string,
  fs: AutomationSweepFileSystem = nodeAutomationSweepFs,
): Promise<number> {
  const removed = await removeLegacyChatAutoSessionDirs(sessionsRoot, fs)
  await filterLegacyChatAutoRuns(runsDir, fs)
  return removed
}

export async function removeLegacyChatAutoSessionDirs(
  sessionsRoot: string,
  fs: AutomationSweepFileSystem = nodeAutomationSweepFs,
): Promise<number> {
  let top: string[]
  try {
    top = await fs.readdir(sessionsRoot)
  } catch {
    return 0
  }
  let removed = 0
  await Promise.all(
    top.map(async (entry) => {
      const path = join(sessionsRoot, entry)
      if (entry.startsWith(LEGACY_CHAT_AUTO_SESSION_PREFIX)) {
        await fs.rm(path, { recursive: true, force: true }).catch(() => undefined)
        removed += 1
        return
      }
      let children: string[]
      try {
        children = await fs.readdir(path)
      } catch {
        return
      }
      await Promise.all(
        children
          .filter((child) => child.startsWith(LEGACY_CHAT_AUTO_SESSION_PREFIX))
          .map(async (child) => {
            await fs.rm(join(path, child), { recursive: true, force: true }).catch(() => undefined)
            removed += 1
          }),
      )
    }),
  )
  return removed
}

export async function filterLegacyChatAutoRuns(
  runsDir: string,
  fs: AutomationSweepFileSystem = nodeAutomationSweepFs,
): Promise<void> {
  let files: string[]
  try {
    files = await fs.readdir(runsDir)
  } catch {
    return
  }
  await Promise.all(
    files
      .filter((file) => file.endsWith('.runs.jsonl'))
      .map(async (file) => {
        const path = join(runsDir, file)
        let text: string
        try {
          text = await fs.readFile(path, 'utf8')
        } catch {
          return
        }
        const kept: string[] = []
        let dropped = false
        for (const line of text.split('\n')) {
          if (!line) continue
          try {
            const parsed = JSON.parse(line) as Record<string, unknown>
            if (
              typeof parsed.sessionId === 'string' &&
              parsed.sessionId.startsWith(LEGACY_CHAT_AUTO_SESSION_PREFIX)
            ) {
              dropped = true
              continue
            }
          } catch {
            // 坏行保留,避免清扫把无法解析的历史抹掉。
          }
          kept.push(line)
        }
        if (!dropped) return
        await fs.writeFile(path, kept.length ? `${kept.join('\n')}\n` : '', 'utf8')
      }),
  )
}
