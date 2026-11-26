/**
 * Windows 云盘占位文件属性探针（规格 §6.1 / 计划 Task 6）。
 *
 * OneDrive / 文件按需 等云盘会在 NTFS 属性上标记「未水合」占位文件：
 * `FILE_ATTRIBUTE_OFFLINE`、`FILE_ATTRIBUTE_RECALL_ON_OPEN`、
 * `FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS`。对这类文件做读取会触发下载（可能在
 * 无网络/计量网络下失败），因此同步引擎必须先看属性：`dehydrated` 直接按
 * `skipped` 记录，绝不 `open()` / 解析。
 *
 * 探针只在 Win32 生效：经 `createRequire(import.meta.url)('koffi')` 延迟绑定
 * `kernel32.dll` 的 `GetFileAttributesW`（与 `src/windows-volume-diagnostics.ts`
 * 的加载方式一致）。非 Win32、`GetFileAttributesW` 返回 `0xFFFFFFFF`（`INVALID_FILE_ATTRIBUTES`）
 * 或任何异常都判为 `'probe-unavailable'`，调用方据此按普通本地文件继续索引，
 * 绝不因探针不可用而跳过整批文件。
 */

import { createRequire } from 'node:module'

/** `FILE_ATTRIBUTE_OFFLINE`：数据未全部本地化。 */
export const WIN32_FILE_ATTRIBUTE_OFFLINE = 0x00001000
/** `FILE_ATTRIBUTE_RECALL_ON_OPEN`：打开即触发云召回。 */
export const WIN32_FILE_ATTRIBUTE_RECALL_ON_OPEN = 0x00040000
/** `FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS`：读数据即触发云召回。 */
export const WIN32_FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS = 0x00400000

/** Win32 属性位：三个云占位标志任一命中即视为未水合。 */
const DEHYDRATED_ATTRIBUTE_MASK =
  WIN32_FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS | WIN32_FILE_ATTRIBUTE_RECALL_ON_OPEN | WIN32_FILE_ATTRIBUTE_OFFLINE

/** `GetFileAttributesW` 失败返回值。 */
const WIN32_INVALID_FILE_ATTRIBUTES = 0xffffffff

export type CloudPlaceholderState = 'local' | 'dehydrated' | 'probe-unavailable'

export interface DetectCloudPlaceholderOptions {
  /** 可注入平台（测试确定性）；缺省 `process.platform`。 */
  readonly platform?: NodeJS.Platform
  /** 可注入属性读取器（测试确定性）；缺省惰性绑定 `kernel32.dll`。 */
  readonly readWin32Attributes?: (filePath: string) => number | undefined
}

const WIN32_LONG_PATH_THRESHOLD = 248

/**
 * Windows `GetFileAttributesW` 对 ≥248 字符路径不带 `\\?\` 会失败返回
 * `INVALID_FILE_ATTRIBUTES`，导致深层 OneDrive 占位文件被误判为探针不可用
 * 进而触发云下载（I-9 修复）。
 */
export function formatWin32AttributesPath(filePath: string): string {
  if (filePath.length < WIN32_LONG_PATH_THRESHOLD) return filePath
  if (filePath.startsWith('\\\\?\\') || filePath.startsWith('\\\\.\\')) return filePath
  if (!/^[A-Za-z]:[\\/]/u.test(filePath)) return filePath
  return `\\\\?\\${filePath.replace(/\//gu, '\\')}`
}

/** 默认属性读取器：惰性加载 `koffi`，成功与失败均只尝试一次（M-5 缓存失败哨兵）。 */
let cachedAttributeReader: ((filePath: string) => number) | null | undefined

function win32AttributeReader(): ((filePath: string) => number) | null {
  if (cachedAttributeReader !== undefined) return cachedAttributeReader
  try {
    const koffi = createRequire(import.meta.url)('koffi') as typeof import('koffi').default
    const kernel32 = koffi.load('kernel32.dll')
    const getFileAttributesW = kernel32.func('uint32 __stdcall GetFileAttributesW(str16)')
    cachedAttributeReader = (filePath: string): number => getFileAttributesW(filePath) as number
  } catch {
    cachedAttributeReader = null
  }
  return cachedAttributeReader
}

/**
 * 判定源文件是否为「未水合」云占位文件。
 *
 * 非 Win32 或探针不可用一律返回 `'probe-unavailable'`（调用方按普通文件继续）；
 * 返回 `'dehydrated'` 时调用方必须跳过读取与解析。
 */
export function detectCloudPlaceholder(
  filePath: string,
  opts: DetectCloudPlaceholderOptions = {},
): CloudPlaceholderState {
  const platform = opts.platform ?? process.platform
  if (platform !== 'win32') return 'probe-unavailable'
  try {
    const read = opts.readWin32Attributes ?? win32AttributeReader()
    if (read === null) return 'probe-unavailable'
    const attributes = read(formatWin32AttributesPath(filePath))
    if (attributes === undefined || !Number.isFinite(attributes)) return 'probe-unavailable'
    // koffi 的 `uint32` 返回值在 JS 中是 0..2^32-1；`0xFFFFFFFF` 表示调用失败。
    if ((attributes >>> 0) === WIN32_INVALID_FILE_ATTRIBUTES) return 'probe-unavailable'
    return (attributes & DEHYDRATED_ATTRIBUTE_MASK) !== 0 ? 'dehydrated' : 'local'
  } catch {
    return 'probe-unavailable'
  }
}
