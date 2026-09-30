/** Generate native tray bitmaps from the repository-owned brand SVG. */

import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const buildRoot = join(packageRoot, 'build')
const sourcePath = join(buildRoot, 'tray-icon.svg')
const source = await readFile(sourcePath, 'utf8')

// The tray SVG owns the edition's brand color and this generator renders the
// blue variants in exactly that color. Each edition's design system documents
// the palette value its SVG carries (HuaAnWork: DESIGN.md --accent 靛蓝).
const fills = [...new Set([...source.matchAll(/fill="(#[0-9A-Fa-f]{6})"/gu)].map((match) => match[1]))]
const BRAND_BLUE = fills.length === 1 ? fills[0] : undefined
if (BRAND_BLUE === undefined || /<style\b/iu.test(source)) {
  throw new Error('generate-tray-icons: tray-icon.svg must use exactly one fill color and no <style> block')
}

const variants = [
  ['tray-iconTemplate.png', '#000000', 16],
  ['tray-iconTemplate@2x.png', '#000000', 32],
  ['tray-icon-blue.png', BRAND_BLUE, 16],
  ['tray-icon-blue@1.25x.png', BRAND_BLUE, 20],
  ['tray-icon-blue@1.5x.png', BRAND_BLUE, 24],
  ['tray-icon-blue@2x.png', BRAND_BLUE, 32],
]

await Promise.all(variants.map(async ([filename, color, size]) => {
  const rendered = source.replaceAll(BRAND_BLUE, color)
  await sharp(Buffer.from(rendered))
    .resize({ width: size, height: size, fit: 'contain' })
    .png({ compressionLevel: 9 })
    .toFile(join(buildRoot, filename))
}))
