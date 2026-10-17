/** Spawn the Electron binary and return as soon as that child exits. */
import { spawn } from 'node:child_process'
import { realpathSync, writeSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const entry = fileURLToPath(new URL('verify-sidebar-browser.mjs', import.meta.url))

export function finishStatus(code, signal) {
  if (signal) return 1
  if (code === 0) return 0
  return code ?? 1
}

/**
 * Exit on the child's `exit` event. Do not wait for `close`: a grandchild can
 * hold the stdio pipes after the Electron process is already gone.
 * If the pid disappears without an exit event, fail immediately.
 */
export function watchChild(child, { exit = process.exit, write = line => writeSync(2, line), pollMs = 200 } = {}) {
  let settled = false
  const finish = (code, signal, via) => {
    if (settled) return
    settled = true
    clearInterval(timer)
    const status = finishStatus(code, signal)
    write(`electron-check: child ${via} code=${code ?? 'null'} signal=${signal ?? 'none'} wrapperExit=${status}\n`)
    exit(status)
  }
  child.once('exit', (code, signal) => finish(code, signal, 'exit'))
  child.once('error', error => {
    write(`electron-check: spawn failed: ${error instanceof Error ? error.message : String(error)}\n`)
    finish(1, null, 'error')
  })
  const timer = setInterval(() => {
    if (settled || child.pid == null) return
    try {
      process.kill(child.pid, 0)
    } catch (error) {
      if (error?.code === 'ESRCH') finish(1, null, 'pid-gone')
    }
  }, pollMs)
  timer.unref()
}

function isDirectRun() {
  const argvPath = process.argv[1]
  if (!argvPath) return false
  try { return realpathSync(argvPath) === fileURLToPath(import.meta.url) }
  catch { return false }
}

if (isDirectRun()) {
  const electron = createRequire(import.meta.url)('electron')
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(electron, [entry, ...process.argv.slice(2)], { env, stdio: 'inherit', windowsHide: true })
  writeSync(2, `electron-check: spawned pid=${child.pid ?? 'none'} entry=${entry}\n`)
  watchChild(child)
}
