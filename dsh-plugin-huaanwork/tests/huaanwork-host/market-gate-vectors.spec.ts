/**
 * 共享发布门向量(review D1/D4 消费侧):与 market-server 的
 * publish-gate-vectors.spec.ts 消费同一份 fixture
 * (market-server/tests/fixtures/publish-gate-vectors.json),任一侧口径漂移
 * 即红。tar 字节用零依赖 ustar 构造器直写(与 market-server 测试助手同形态;
 * `..` 段条目无法经真实文件系统 + tar 二进制构造,必须直写头)。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { describe, expect, test } from 'vitest'
import { MarketInstallGateError, precheckTarballManifest, readTarballPackageJson } from '../../src/huaanwork-host/market/install.ts'

const TAR_BLOCK_SIZE = 512

function octal(value: number, width: number): string {
  return value.toString(8).padStart(width - 1, '0') + '\0'
}

function tarHeader(name: string, size: number, typeflag: number): Buffer {
  const header = Buffer.alloc(TAR_BLOCK_SIZE)
  header.write(name, 0, 'latin1')
  header.write(octal(0o644, 8), 100, 'latin1')
  header.write(octal(0, 8), 108, 'latin1')
  header.write(octal(0, 8), 116, 'latin1')
  header.write(octal(size, 12), 124, 'latin1')
  header.write(octal(0, 12), 136, 'latin1')
  header.write('        ', 148, 'latin1')
  header.writeUInt8(typeflag, 156)
  header.write('ustar\0', 257, 'latin1')
  header.write('00', 263, 'latin1')
  let sum = 0
  for (const byte of header) sum += byte
  header.write(octal(sum, 8), 148, 'latin1')
  return header
}

function buildTgzBytes(entries: ReadonlyArray<{ path: string; bytes: Buffer; typeflag?: string }>): Buffer {
  const parts: Buffer[] = []
  for (const entry of entries) {
    const typeflag = entry.typeflag === undefined ? 0x30 : entry.typeflag.charCodeAt(0)
    parts.push(tarHeader(entry.path, entry.bytes.length, typeflag))
    parts.push(entry.bytes)
    const remainder = entry.bytes.length % TAR_BLOCK_SIZE
    if (remainder !== 0) parts.push(Buffer.alloc(TAR_BLOCK_SIZE - remainder))
  }
  parts.push(Buffer.alloc(TAR_BLOCK_SIZE))
  return gzipSync(Buffer.concat(parts))
}

interface GateVectorEntry {
  readonly path: string
  readonly manifest?: Record<string, unknown>
  readonly raw?: string
  readonly typeflag?: string
}

interface GateVector {
  readonly name: string
  readonly reason: string
  readonly tarball: { readonly entries: readonly GateVectorEntry[] }
  readonly expected: {
    readonly accept: boolean
    readonly code?: string
    readonly wrapperCode?: string
    readonly messageIncludes?: string
  }
}

const vectors = JSON.parse(
  readFileSync(join(__dirname, '../../../market-server/tests/fixtures/publish-gate-vectors.json'), 'utf8'),
) as readonly GateVector[]

describe('publish-gate-vectors.json (wrapper install-side gate, shared with market-server)', () => {
  for (const vector of vectors) {
    test(`${vector.name}: ${vector.reason}`, () => {
      const bytes = buildTgzBytes(vector.tarball.entries.map(entry => ({
        path: entry.path,
        bytes: Buffer.from(entry.manifest !== undefined ? JSON.stringify(entry.manifest) : (entry.raw ?? ''), 'utf8'),
        ...(entry.typeflag !== undefined ? { typeflag: entry.typeflag } : {}),
      })))

      // tarball 结构层拒收(歧义 / `..` 段):readTarballPackageJson 即拒。
      if (vector.expected.code === 'invalid-tarball') {
        let caught: unknown
        try {
          readTarballPackageJson(bytes)
        } catch (cause) {
          caught = cause
        }
        expect(caught).toBeInstanceOf(MarketInstallGateError)
        expect((caught as MarketInstallGateError).code).toBe(vector.expected.wrapperCode)
        expect((caught as Error).message).toContain(vector.expected.messageIncludes ?? '')
        return
      }

      const manifest = readTarballPackageJson(bytes)
      if (vector.expected.accept) {
        expect(() => precheckTarballManifest(manifest)).not.toThrow()
        return
      }
      expect(vector.expected.wrapperCode).toBeDefined()
      let caught: unknown
      try {
        precheckTarballManifest(manifest)
      } catch (cause) {
        caught = cause
      }
      expect(caught).toBeInstanceOf(MarketInstallGateError)
      expect((caught as MarketInstallGateError).code).toBe(vector.expected.wrapperCode)
      expect((caught as Error).message).toContain(vector.expected.messageIncludes ?? '')
    })
  }
})
