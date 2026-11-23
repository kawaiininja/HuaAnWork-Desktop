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

describe('专家团固定三列布局', () => {
  test('列表固定三列、等宽、同行等高且允许换行收缩', () => {
    const list = /\.expert-team-list\s*\{([^}]*)\}/.exec(readStyles())?.[1]
    expect(list).toMatch(/display:\s*grid;/)
    expect(list).toMatch(/grid-template-columns:\s*repeat\(3, minmax\(0, 1fr\)\);/)
    expect(list).toMatch(/align-items:\s*stretch;/)
    expect(list).toMatch(/align-content:\s*start;/)

    const item = /\.expert-team-list > li\s*\{([^}]*)\}/.exec(readStyles())?.[1]
    expect(item).toMatch(/min-width:\s*0;/)
    expect(item).toMatch(/display:\s*flex;/)
    expect(item).toMatch(/flex-direction:\s*column;/)

    const card = /\.expert-team-list \.team-card\s*\{([^}]*)\}/.exec(readStyles())?.[1]
    expect(card).toMatch(/flex:\s*1 1 auto;/)
    expect(card).toMatch(/height:\s*100%;/)
  })

  test('窄屏仍保持三列并只收紧间距与头部换行', () => {
    const css = readStyles()
    const narrow = /@media \(max-width: 640px\) \{([\s\S]*?)\n\}/.exec(css)?.[1]
    expect(narrow).toBeDefined()
    expect(narrow).toMatch(/gap:\s*6px;/)
    expect(narrow).toMatch(/padding:\s*10px;/)
    expect(narrow).toMatch(/flex-direction:\s*column;/)
    expect(css).toMatch(/grid-template-columns:\s*repeat\(3, minmax\(0, 1fr\)\);/)
  })
})
