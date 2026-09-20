import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, test } from 'vitest'
import { renderStylesModule } from '../../scripts/gen-huaanwork-styles.ts'

describe('styles.generated.ts 新鲜度', () => {
  test('与 styles.css 保持同步(改 CSS 后跑 yarn gen:styles 重新生成)', () => {
    const dir = resolve(import.meta.dirname, '../../src/client-huaanwork')
    const css = readFileSync(join(dir, 'styles.css'), 'utf8')
    const generated = readFileSync(join(dir, 'styles.generated.ts'), 'utf8')
    expect(generated).toBe(renderStylesModule(css))
  })
})
