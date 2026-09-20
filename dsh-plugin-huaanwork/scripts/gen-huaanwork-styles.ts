/** Regenerate src/client-huaanwork/styles.generated.ts from styles.css (run via `yarn gen:styles`). */

import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const dir = resolve(import.meta.dirname, '../src/client-huaanwork')

/** 序列化格式的唯一事实源;tests/client-huaanwork/styles-generated.spec.ts 复用它做新鲜度断言。 */
export function renderStylesModule(css: string): string {
  return `export const HUAANWORK_STYLES = ${JSON.stringify(css)}\n`
}

/** styles.css 改了之后必须重跑(yarn gen:styles),否则新鲜度测试会红。 */
export function generateStyles(): void {
  const css = readFileSync(join(dir, 'styles.css'), 'utf8')
  writeFileSync(join(dir, 'styles.generated.ts'), renderStylesModule(css))
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  generateStyles()
  process.stdout.write('gen-huaanwork-styles: styles.generated.ts regenerated from styles.css\n')
}
