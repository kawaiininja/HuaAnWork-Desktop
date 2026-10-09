import { execFileSync, spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const root = resolve(import.meta.dirname, '..')

export function resolveTargetBase(env = process.env, cwd = root) {
  const envBaseSha = env.BASE_SHA?.trim()
  if (envBaseSha && !/^0+$/.test(envBaseSha)) {
    return envBaseSha
  }
  let base
  try {
    base = execFileSync('git', ['merge-base', 'origin/master', 'HEAD'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
  } catch (err) {
    const stderr = err.stderr?.toString()?.trim()
    throw new Error(
      `failed to determine base commit via "git merge-base origin/master HEAD"${
        stderr ? `: ${stderr}` : `: ${err.message || String(err)}`
      }`,
    )
  }
  if (!base) {
    throw new Error('git merge-base origin/master HEAD returned empty output')
  }
  return base
}

export function runWhitespaceCheck({
  cwd = root,
  env = process.env,
  targetBase,
  stdio = 'pipe',
} = {}) {
  const base = targetBase ?? resolveTargetBase(env, cwd)
  const result = spawnSync('git', ['diff', '--check', base, 'HEAD'], {
    cwd,
    encoding: 'utf8',
    stdio,
  })
  if (result.error) {
    throw result.error
  }
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    base,
  }
}

export function runCli() {
  try {
    const targetBase = resolveTargetBase(process.env, root)
    const result = spawnSync('git', ['diff', '--check', targetBase, 'HEAD'], {
      cwd: root,
      stdio: 'inherit',
    })
    if (result.error) {
      console.error(`check-whitespace: failed to run git diff: ${result.error.message || String(result.error)}`)
      process.exit(1)
    }
    if (result.status !== 0) {
      process.exit(1)
    }
    process.exit(0)
  } catch (err) {
    console.error(`check-whitespace: ${err.message || String(err)}`)
    process.exit(1)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runCli()
}
