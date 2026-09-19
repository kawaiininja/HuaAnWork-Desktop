import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { isOneSided } from './verify-desktop-variants.mjs'

test('isOneSided: 精确路径与前缀都命中(键带目录前缀,见 Step 2 语义说明)', () => {
  assert.equal(isOneSided('src/client-huaanwork/api.ts', new Set(), ['src/client-huaanwork/']), true)
  assert.equal(isOneSided('scripts/gen-client-styles.mjs', new Set(), ['scripts/gen-']), true)
  assert.equal(isOneSided('src/product-identity.ts', new Set(['src/product-identity.ts']), []), true)
  assert.equal(isOneSided('src/profile.ts', new Set(), ['src/client-huaanwork/']), false)
})

test('verify-desktop-variants: 当前仓库实跑全绿,三通道摘要在位', () => {
  const out = execFileSync(process.execPath, ['scripts/verify-desktop-variants.mjs'], {
    cwd: new URL('..', import.meta.url).pathname,
    encoding: 'utf8',
  })
  assert.match(out, /stable↔beta src \(\d+ files\)/)
  assert.match(out, /beta↔huaanwork src \(\d+ files\)/)
  assert.match(out, /beta↔huaanwork scripts \(\d+ files\)/)
})
