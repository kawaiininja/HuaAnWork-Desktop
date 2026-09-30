/** Assemble the Windows application icon from the cross-platform master PNG. */

import { writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

/** Frame sizes Windows chrome, Explorer, the taskbar, and NSIS request. */
export const WINDOWS_ICO_SIZES = Object.freeze([16, 24, 32, 48, 64, 128, 256])

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const ICONDIR_BYTES = 6
const ICONDIRENTRY_BYTES = 16
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const sourcePath = join(packageRoot, 'build', 'app-icon.png')
const outputPath = join(packageRoot, 'build', 'app-icon.ico')

/**
 * Pack PNG frames into an ICO container. PNG payloads are supported since
 * Vista; a directory width or height byte of 0 encodes 256 pixels.
 * @param {readonly {size: number, payload: Buffer}[]} frames - Square PNG frames in directory order.
 * @returns {Buffer} Complete .ico file bytes.
 */
export function buildWindowsIco(frames) {
  if (frames.length === 0 || frames.length > 255) {
    throw new Error('gen-windows-ico: an icon container carries between 1 and 255 frames')
  }
  const header = Buffer.alloc(ICONDIR_BYTES + frames.length * ICONDIRENTRY_BYTES)
  header.writeUInt16LE(0, 0)                // reserved
  header.writeUInt16LE(1, 2)                // type: icon
  header.writeUInt16LE(frames.length, 4)    // frame count
  let offset = header.byteLength
  frames.forEach((frame, index) => {
    if (!frame.payload.subarray(0, PNG_SIGNATURE.byteLength).equals(PNG_SIGNATURE)) {
      throw new Error(`gen-windows-ico: frame ${String(frame.size)} is not a PNG payload`)
    }
    const entry = ICONDIR_BYTES + index * ICONDIRENTRY_BYTES
    header.writeUInt8(frame.size === 256 ? 0 : frame.size, entry)      // width
    header.writeUInt8(frame.size === 256 ? 0 : frame.size, entry + 1)  // height
    header.writeUInt8(0, entry + 2)           // palette size (0 for truecolor)
    header.writeUInt8(0, entry + 3)           // reserved
    header.writeUInt16LE(1, entry + 4)        // color planes
    header.writeUInt16LE(32, entry + 6)       // bits per pixel
    header.writeUInt32LE(frame.payload.byteLength, entry + 8)
    header.writeUInt32LE(offset, entry + 12)
    offset += frame.payload.byteLength
  })
  return Buffer.concat([header, ...frames.map((frame) => frame.payload)])
}

/**
 * Render one square PNG payload per Windows frame size from the master icon.
 * @param {string} source - Absolute path to the 1024x1024 RGBA master PNG.
 * @returns {Promise<{size: number, payload: Buffer}[]>} One frame per configured size.
 */
async function renderFrames(source) {
  return Promise.all(WINDOWS_ICO_SIZES.map(async (size) => ({
    size,
    payload: await sharp(source)
      .resize({ width: size, height: size, fit: 'fill', kernel: sharp.kernel.lanczos3 })
      .toColourspace('srgb')
      .png({ compressionLevel: 9, palette: false })
      .toBuffer(),
  })))
}

/**
 * Write the Windows icon container derived from the cross-platform master.
 * @param {string} [source] - Absolute path to the master PNG.
 * @param {string} [output] - Absolute path for the generated .ico.
 * @returns {Promise<number[]>} The written frame sizes.
 */
export async function generateWindowsIco(source = sourcePath, output = outputPath) {
  if (resolve(source) === resolve(output)) {
    throw new Error('gen-windows-ico: output must not overwrite the source icon')
  }
  const frames = await renderFrames(source)
  await writeFile(output, buildWindowsIco(frames))
  return frames.map((frame) => frame.size)
}

const invokedPath = process.argv[1]
if (invokedPath !== undefined && resolve(invokedPath) === fileURLToPath(import.meta.url)) {
  const sizes = await generateWindowsIco()
  process.stdout.write(`gen-windows-ico: wrote build/app-icon.ico with frames ${sizes.join(', ')}\n`)
}
