import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { collectUpstreamLag } from './upstream-sync-dashboard.mjs'

const repoRoot = resolve(import.meta.dirname, '..')

test('the dashboard refuses to run without the upstream remote, and says why', () => {
  // remote 缺失时不得静默输出 0 —— 那正是前版「以 origin/master 为基准」会产生的
  // 假象(落后量恒 0)。必须明确报错并指向 docs/upstream-sync.md。
  const result = collectUpstreamLag({ root: repoRoot, upstreamRef: 'definitely-not-a-remote/master' })
  assert.strictEqual(result.ok, false)
  assert.match(result.error, /upstream/i)
  assert.match(result.error, /docs\/upstream-sync\.md/u)
})

test('the lag report carries an as-of timestamp and the exact ref it used', () => {
  const result = collectUpstreamLag({ root: repoRoot, upstreamRef: 'upstream/master' })
  if (!result.ok) {
    // 无网络/未 fetch 时如实跳过,不用镜像的值冒充(纪律:阻塞要如实记)。
    console.log(`# skipped: ${result.error}`)
    return
  }
  assert.match(result.asOf, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/u, 'as-of must be an ISO timestamp')
  assert.strictEqual(result.ref, 'upstream/master')
  assert.match(result.upstreamSha, /^[0-9a-f]{40}$/u)
  assert.match(result.mergeBase, /^[0-9a-f]{40}$/u)
  // 不用单调递增断言(如与历史基线比较大小):落后量只会增长,那种断言永远通过、检不出任何东西。
  // 改为断言它**等于**直接跑 git rev-list --count 的结果 —— 即自证一致性,而非自证大小。
  const direct = execFileSync('git', ['rev-list', '--count', `${result.mergeBase}..${result.ref}`], {
    cwd: repoRoot, encoding: 'utf8',
  }).trim()
  assert.strictEqual(String(result.behindCount), direct)
  assert.ok(result.aheadCount >= 0)
})

test('the three overlap scopes are reported separately and never summed', () => {
  const result = collectUpstreamLag({ root: repoRoot, upstreamRef: 'upstream/master' })
  if (!result.ok) { console.log(`# skipped: ${result.error}`); return }
  for (const scope of ['whitelist', 'threePackageIdentical', 'permanentOverride']) {
    assert.ok(scope in result.overlap, `missing overlap scope: ${scope}`)
    assert.strictEqual(typeof result.overlap[scope].hits, 'number')
    assert.strictEqual(typeof result.overlap[scope].denominator, 'number')
    assert.ok(result.overlap[scope].hits <= result.overlap[scope].denominator)
  }
  // 三个口径有交集,故不得存在一个「总计」字段。
  assert.ok(!('total' in result.overlap), 'the three scopes must not be summed')
})
