import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, test } from 'vitest'
import { renderStylesModule } from '../../scripts/gen-huaanwork-styles.ts'

const stylesDir = resolve(import.meta.dirname, '../../src/client-huaanwork')
const readStyles = (): string => readFileSync(join(stylesDir, 'styles.css'), 'utf8')

describe('styles.generated.ts 新鲜度', () => {
  test('与 styles.css 保持同步(改 CSS 后跑 yarn gen:styles 重新生成)', () => {
    const css = readStyles()
    const generated = readFileSync(join(stylesDir, 'styles.generated.ts'), 'utf8')
    expect(generated).toBe(renderStylesModule(css))
  })
})

describe('全屏结果页整高布局', () => {
  test('.artifact-page 声明整高 flex 链,Markdown 在页内滚动且 HTML iframe 取剩余高度', () => {
    const rule = /\.artifact-page\s*\{([^}]*)\}/.exec(readStyles())?.[1]
    expect(rule).toBeDefined()
    expect(rule).toMatch(/display:\s*flex;/)
    expect(rule).toMatch(/flex-direction:\s*column;/)
    expect(rule).toMatch(/height:\s*100%;/)
    expect(rule).toMatch(/min-height:\s*0;/)
    expect(rule).toMatch(/overflow:\s*hidden;/)
  })
})
