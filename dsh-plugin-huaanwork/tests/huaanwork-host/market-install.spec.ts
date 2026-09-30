/**
 * install.ts 单元层:(c) 安装侧门正负例、sha256 比对、流式下载(第 53 条)、制品落盘/GC。
 * pnpm 层语义在 market-pnpm-semantics.spec.ts;wrapper e2e 在 market-e2e.spec.ts。
 */
import {
  chmodSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, openSync,
  readFileSync, readdirSync, rmSync, statSync, writeFileSync, type WriteStream,
} from 'node:fs'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { Readable } from 'node:stream'
import { gzipSync } from 'node:zlib'
import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  DesktopProfileCheckpoint,
  PROFILE_CHECKPOINT_USER_DATA_DIR_ENV,
} from '../../src/profile-checkpoint.ts'
import type { DesktopPnpmHandle } from '../../src/pnpm.ts'
import type { ConfirmedRestartRuntime } from '../../src/host-runtime-bridge.ts'
import {
  ensureMarketArtifactsDir,
  gcRemovedPackageArtifacts,
  marketArtifactName,
  marketArtifactTempPath,
  profileFileReferencesExist,
  sweepOrphanMarketArtifacts,
} from '../../src/huaanwork-host/market/artifacts.ts'
import {
  createFileRevisionStore,
  createMarketHttpClient,
  MarketFetchError,
  resolveSameOriginUrl,
  type MarketHttpClient,
} from '../../src/huaanwork-host/market/catalog-client.ts'
import {
  downloadAndStageArtifact,
  executeMarketInstall,
  MARKET_ARTIFACT_MAX_BYTES,
  MarketInstallGateError,
  type MarketInstallContext,
  precheckTarballManifest,
  readTarballPackageJson,
  readTarballPackageJsonFromFile,
} from '../../src/huaanwork-host/market/install.ts'
import { sha256Hex } from './market-test-server.ts'

const roots: string[] = []
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true })
})

function tempProfile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hw-market-install-'))
  roots.push(dir)
  // 评审 D7:不预建 .market-artifacts——目录创建是被测代码(ensureMarketArtifactsDir)
  // 的职责,预建会让 0700 断言测到脚手架而非生产行为。
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ name: 'profile', dependencies: {} }, undefined, 2)}\n`)
  return dir
}

/**
 * 真实 tar.gz(npm 形态 package/ 根),与 market-pnpm-fixture 同构造。
 * `padding` 追加一个 `package/payload.bin` —— 第 53 条的「100 个 chunk」用例需要一个
 * 明显大于单个 chunk 的全量字节数,好让「峰值 = 全量」与「峰值 = 单 chunk」可区分。
 */
function buildTgz(dir: string, manifest: Record<string, unknown>, padding?: Buffer): Buffer {
  const pkgDir = join(dir, 'package')
  mkdirSync(pkgDir, { recursive: true })
  writeFileSync(join(pkgDir, 'package.json'), `${JSON.stringify(manifest, undefined, 2)}\n`)
  if (padding !== undefined) writeFileSync(join(pkgDir, 'payload.bin'), padding)
  const out = join(dir, 'out.tgz')
  const tar = spawnSync('tar', ['czf', out, 'package'], { cwd: dir, encoding: 'utf8' })
  if (tar.status !== 0) throw new Error(`tar failed: ${tar.stderr}`)
  return readFileSync(out)
}

/**
 * 注入缝的假 client:制品**逐 chunk 供给**(第 53 条后安装链只走 fetchStream)。
 * `fetchBuffer` 刻意拒绝调用——若实现回退到「一次收齐」,现有用例会因这一条而红,
 * 而不是静默把整包缓冲回内存。
 */
function fakeHttp(routes: Map<string, Buffer>): MarketHttpClient {
  return {
    fetchText: (url) => {
      const bytes = routes.get(url)
      if (bytes === undefined) return Promise.reject(new Error(`404 ${url}`))
      return Promise.resolve(bytes.toString('utf8'))
    },
    fetchBuffer: () => Promise.reject(new Error('the streaming install path must not call fetchBuffer (第 53 条)')),
    fetchStream: async (url, _label, _maxBytes, onChunk) => {
      const bytes = routes.get(url)
      if (bytes === undefined) throw new Error(`404 ${url}`)
      const chunkSize = Math.max(1, Math.ceil(bytes.byteLength / 4))
      for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
        await onChunk(bytes.subarray(offset, Math.min(offset + chunkSize, bytes.byteLength)))
      }
      return { bytes: bytes.byteLength }
    },
  }
}

const ORIGIN = 'http://market.intranet.example:8787'

function fileEntry(overrides: Partial<{ name: string; version: string; sha256: string; tarballPath: string }> = {}) {
  return {
    name: '@huaanwork/sample',
    version: '1.2.3',
    sha256: '0'.repeat(64),
    tarballPath: '/artifacts/huaanwork-sample-1.2.3.tgz',
    size: 4096,
    ...overrides,
  }
}

describe('precheckTarballManifest ((c) 安装侧门,与发布侧门同口径)', () => {
  test('zero-dependency, no lifecycle scripts passes (peer/bundle deps, build scripts allowed)', () => {
    expect(() => precheckTarballManifest({
      name: 'a', version: '1.0.0',
      peerDependencies: { cordis: '^1.0.0' },
      bundleDependencies: ['vendor'],
      scripts: { build: 'tsc', test: 'vitest' },
    })).not.toThrow()
  })

  test.each([
    [{ dependencies: { ms: '^2.1.3' } }, /dependencies must be empty/],
    [{ optionalDependencies: { ms: '^2.1.3' } }, /optionalDependencies must be empty/],
    [{ scripts: { preinstall: 'x' } }, /scripts\.preinstall/],
    [{ scripts: { install: 'x' } }, /scripts\.install/],
    [{ scripts: { postinstall: 'curl evil' } }, /scripts\.postinstall/],
    [{ scripts: { prepare: 'x' } }, /scripts\.prepare/],
  ])('rejects non-compliant manifest %j fail-closed', (extra, pattern) => {
    expect(() => precheckTarballManifest({ name: 'a', version: '1.0.0', ...extra })).toThrow(pattern)
  })
})

describe('readTarballPackageJson', () => {
  test('extracts the top-level package.json from a real tgz', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hw-market-tgz-'))
    roots.push(dir)
    const bytes = buildTgz(dir, { name: 'pkg-a', version: '2.0.0' })
    expect(readTarballPackageJson(bytes)).toEqual({ name: 'pkg-a', version: '2.0.0' })
  })

  test('rejects non-gzip and missing package.json', () => {
    expect(() => readTarballPackageJson(Buffer.from('not gzip'))).toThrow(/gzip/u)
  })

  // 评审 D6:解压上限。gunzipSync 不带 maxOutputLength 时,一个几十 KB 的
  // gzip 炸弹可在 Electron 主进程里膨胀到数十 GiB。回退该选项即红。
  test('caps decompression and says so instead of blaming gzip (review D6)', () => {
    // 65 MiB 均匀字节压到几十 KB,越过 64 MiB 上限(与发布侧同值)。
    const bomb = gzipSync(Buffer.alloc(65 * 1024 * 1024, 0x41))
    expect(bomb.length).toBeLessThan(1024 * 1024)

    let caught: unknown
    try {
      readTarballPackageJson(bomb)
    } catch (cause) {
      caught = cause
    }
    expect(caught).toBeInstanceOf(MarketInstallGateError)
    expect((caught as MarketInstallGateError).code).toBe('market-invalid-tarball')
    // 诚实报错:超限与「不是合法 gzip」是两件事,不得混为一谈。
    expect((caught as Error).message).toMatch(/decompresses beyond/u)
    expect((caught as Error).message).not.toMatch(/not a valid gzip/u)
  })
})

describe('downloadAndStageArtifact (sha256 比对 + origin 钉扎 + 制品落盘)', () => {
  test('stages the artifact 0600 under .market-artifacts with the planned name', async () => {
    const profileDir = tempProfile()
    const dir = mkdtempSync(join(tmpdir(), 'hw-market-stage-'))
    roots.push(dir)
    const bytes = buildTgz(dir, { name: '@huaanwork/sample', version: '1.2.3' })
    const sha256 = sha256Hex(bytes)
    const http = fakeHttp(new Map([[`${ORIGIN}/artifacts/huaanwork-sample-1.2.3.tgz`, bytes]]))

    const prepared = await downloadAndStageArtifact({
      origin: ORIGIN,
      file: fileEntry({ sha256 }),
      profileDir,
      http,
    })

    expect(prepared.sha256).toBe(sha256)
    expect(prepared.artifactPath).toBe(join(profileDir, '.market-artifacts', marketArtifactName('@huaanwork/sample', '1.2.3', sha256)))
    expect(existsSync(prepared.artifactPath)).toBe(true)
    expect(statSync(prepared.artifactPath).mode & 0o777).toBe(0o600)
    expect(statSync(join(profileDir, '.market-artifacts')).mode & 0o777).toBe(0o700)
    expect(readFileSync(prepared.artifactPath).equals(bytes)).toBe(true)
  })

  test('rejects tampered-in-transit bytes: sha256 mismatch, nothing staged, honest error', async () => {
    const profileDir = tempProfile()
    const dir = mkdtempSync(join(tmpdir(), 'hw-market-tamper-'))
    roots.push(dir)
    const bytes = buildTgz(dir, { name: '@huaanwork/sample', version: '1.2.3' })
    // 清单签的是另一个 sha(模拟传输途中被换包)。
    const http = fakeHttp(new Map([[`${ORIGIN}/artifacts/huaanwork-sample-1.2.3.tgz`, bytes]]))

    await expect(downloadAndStageArtifact({
      origin: ORIGIN,
      file: fileEntry({ sha256: 'f'.repeat(64) }),
      profileDir,
      http,
    })).rejects.toThrow(/sha256/u)

    // 不落盘:拒绝路径不产生盘上副作用(目录未被创建,或其中没有任何 .tgz/残留 temp)。
    const staged = join(profileDir, '.market-artifacts')
    if (existsSync(staged)) {
      for (const entry of readdirSync(staged)) {
        expect(entry.endsWith('.tgz')).toBe(false)
      }
    }
  })

  test('rejects a non-zero-dependency tarball at the gate: nothing staged', async () => {
    const profileDir = tempProfile()
    const dir = mkdtempSync(join(tmpdir(), 'hw-market-dep-'))
    roots.push(dir)
    const bytes = buildTgz(dir, { name: '@huaanwork/sample', version: '1.2.3', dependencies: { ms: '^2.1.3' } })
    const http = fakeHttp(new Map([[`${ORIGIN}/artifacts/huaanwork-sample-1.2.3.tgz`, bytes]]))

    await expect(downloadAndStageArtifact({
      origin: ORIGIN,
      file: fileEntry({ sha256: sha256Hex(bytes) }),
      profileDir,
      http,
    })).rejects.toThrow(/dependencies must be empty/u)
    // 拒绝路径不落盘(tempProfile 不再预建目录,见 D7):目录可能根本未被创建。
    const staged = join(profileDir, '.market-artifacts')
    if (existsSync(staged)) {
      for (const entry of readdirSync(staged)) {
        expect(entry.endsWith('.tgz')).toBe(false)
      }
    }
  })

  test('rejects manifest-entry-vs-tarball identity mismatch: nothing staged (D4/D5)', async () => {
    const profileDir = tempProfile()
    const dir = mkdtempSync(join(tmpdir(), 'hw-market-idmismatch-'))
    roots.push(dir)
    // tarball 自述 name/version 与已验签清单条目不一致(被换包/被篡改)。
    const bytes = buildTgz(dir, { name: '@huaanwork/other', version: '9.9.9' })
    const http = fakeHttp(new Map([[`${ORIGIN}/artifacts/huaanwork-sample-1.2.3.tgz`, bytes]]))

    await expect(downloadAndStageArtifact({
      origin: ORIGIN,
      file: fileEntry({ sha256: sha256Hex(bytes) }),
      profileDir,
      http,
    })).rejects.toThrow(/identity/u)

    const staged = join(profileDir, '.market-artifacts')
    if (existsSync(staged)) {
      for (const entry of readdirSync(staged)) {
        expect(entry.endsWith('.tgz')).toBe(false)
      }
    }
  })

  // Task 6.3 收敛落盘协议:不再有 existsSync 原地覆盖写(那是非原子窗口:写一半
  // 被杀进程即留半个制品在最终名下)。重复安装 = 重写 temp + rename 原子替换,内容
  // 与权限不变,盘上不留暂存残留。
  test('same-sha reinstall atomically replaces the artifact (temp + rename, no residue)', async () => {
    const profileDir = tempProfile()
    const dir = mkdtempSync(join(tmpdir(), 'hw-market-overwrite-'))
    roots.push(dir)
    const bytes = buildTgz(dir, { name: '@huaanwork/sample', version: '1.2.3' })
    const sha256 = sha256Hex(bytes)
    const http = fakeHttp(new Map([[`${ORIGIN}/artifacts/huaanwork-sample-1.2.3.tgz`, bytes]]))
    const entry = fileEntry({ sha256 })

    const first = await downloadAndStageArtifact({ origin: ORIGIN, file: entry, profileDir, http })
    const second = await downloadAndStageArtifact({ origin: ORIGIN, file: entry, profileDir, http })

    expect(second.artifactPath).toBe(first.artifactPath)
    expect(readFileSync(first.artifactPath).equals(bytes)).toBe(true)
    expect(statSync(first.artifactPath).mode & 0o777).toBe(0o600)
    // 同 sha 的两次安装只留一条制品;暂存名(`.tmp-<pid>`)在两次落盘后都不留痕。
    expect(readdirSync(join(profileDir, '.market-artifacts'))).toEqual([marketArtifactName('@huaanwork/sample', '1.2.3', sha256)])
  })
})

// ---------------------------------------------------------------------------
// 第 53 条 / 裁定 D-M6-25:远程制品流式下载
// ---------------------------------------------------------------------------

describe('streaming artifact download (spec §14 第 53 条 / 裁定 D-M6-25)', () => {
  const CHUNK_COUNT = 100

  /**
   * 注入缝的 request 桩:制品逐 chunk 供给,并记录**调用方的驻留峰值**
   * (`liveBytes` = 已交给 onChunk、其回调尚未 resolve 的字节总和)。流式实现下
   * 峰值 = 单个 chunk 量级;一次收齐的实现走 `fetchBuffer`(桩如实提供全量,好让
   * 回归以**断言**而非类型错误变红),峰值 = 全量 —— 这正是第一条用例的红判据。
   * 可选 `afterChunk` 钩子让用例在流**中途**观察盘上状态:边收边落盘的实现此刻
   * 已有字节在暂存文件里,而一次收齐的实现此刻盘上什么都没有。
   */
  function streamingProbe(payload: Buffer, chunkCount = CHUNK_COUNT, afterChunk?: (chunkIndex: number) => void) {
    const chunkSize = Math.max(1, Math.ceil(payload.byteLength / chunkCount))
    const state = {
      onChunkCalls: 0,
      handedBytes: 0,
      streamCalls: 0,
      fetchBufferCalls: 0,
      liveBytes: 0,
      peakLiveBytes: 0,
    }
    const client: MarketHttpClient = {
      fetchText: () => Promise.reject(new Error('unexpected fetchText on the install path')),
      fetchBuffer: () => {
        state.fetchBufferCalls += 1
        state.peakLiveBytes = Math.max(state.peakLiveBytes, payload.byteLength)
        return Promise.resolve(Buffer.from(payload))
      },
      fetchStream: async (_url, _label, _maxBytes, onChunk) => {
        state.streamCalls += 1
        // 恰好 chunkCount 块(按长度均分,不因余数少给一块)。
        for (let index = 0; index < chunkCount; index++) {
          const start = Math.floor((index * payload.byteLength) / chunkCount)
          const end = Math.floor(((index + 1) * payload.byteLength) / chunkCount)
          const chunk = payload.subarray(start, end)
          state.onChunkCalls += 1
          state.handedBytes += chunk.byteLength
          state.liveBytes += chunk.byteLength
          state.peakLiveBytes = Math.max(state.peakLiveBytes, state.liveBytes)
          await onChunk(chunk)
          state.liveBytes -= chunk.byteLength
          afterChunk?.(index + 1)
        }
        return { bytes: payload.byteLength }
      },
    }
    return { client, state, chunkSize }
  }

  function completedPnpmHandle(): DesktopPnpmHandle {
    return {
      stdout: Readable.from([]),
      stderr: Readable.from([]),
      done: Promise.resolve({ exitCode: 0, signal: null }),
      cancel() {},
    }
  }

  /** 制品目录内容:拒绝路径断言「零残留」(既无 .tgz,也无 `.tmp-<pid>`)。 */
  function artifactDirEntries(profileDir: string): string[] {
    const dir = join(profileDir, '.market-artifacts')
    return existsSync(dir) ? readdirSync(dir).sort() : []
  }

  /**
   * 与生产同形的安装链:downloadAndStageArtifact → executeMarketInstall(→ addPlugin)。
   * 负例据此断言「下载/校验失败时 addPlugin 一次未被调用」(pnpm 零调用、零重启请求)。
   * `extra` 传 `openStagingStream`(评审 Important 1 的暂存写故障注入缝)或替换 origin
   * (真实 socket 用例用随机端口)。
   */
  function installChain(
    profileDir: string,
    http: MarketHttpClient,
    entry: ReturnType<typeof fileEntry>,
    extra: { readonly origin?: string; readonly openStagingStream?: (tmpPath: string) => WriteStream } = {},
  ) {
    const pnpmCalls: string[][] = []
    let restartRequests = 0
    // profile 清单先落一份非空 bundles(与 plugins-host.spec 的 writeProfile 同形):
    // addPlugin 成功路径要读回清单,空清单会落到 fallback/抛错分支。
    writeFileSync(join(profileDir, 'package.json'), `${JSON.stringify({
      name: 'profile',
      version: '0.0.0',
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
      dependencies: {},
    }, undefined, 2)}\n`)
    const ctx: MarketInstallContext = {
      profileDir,
      logger: () => {},
      pnpm: {
        runPlugin: (argv) => {
          pnpmCalls.push([...argv])
          return completedPnpmHandle()
        },
      },
      // addPlugin 只消费 requestConfirmedRestart;其余成员由 main.ts 的生产 runtime 提供。
      runtime: {
        requestConfirmedRestart: async () => { restartRequests += 1; return true },
      } as unknown as ConfirmedRestartRuntime,
    }
    return {
      pnpmCalls,
      restartRequests: () => restartRequests,
      run: async () => executeMarketInstall(ctx, await downloadAndStageArtifact({
        origin: extra.origin ?? ORIGIN,
        file: entry,
        profileDir,
        http,
        ...(extra.openStagingStream !== undefined ? { openStagingStream: extra.openStagingStream } : {}),
      })),
    }
  }

  /**
   * 在有界时间内等一个 promise 落定。**挂死**是本组用例的失效形态之一(等一个
   * 永不再来的 'drain'),故「超时未落定」与「落定但分类错」必须分开上报 ——
   * vitest 的默认超时只能证否,说不出分类。
   */
  async function settleWithin<T>(
    promise: Promise<T>,
    ms: number,
  ): Promise<{ kind: 'resolved'; value: T } | { kind: 'rejected'; error: unknown } | { kind: 'stalled' }> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        promise.then(
          (value): { kind: 'resolved'; value: T } => ({ kind: 'resolved', value }),
          (error): { kind: 'rejected'; error: unknown } => ({ kind: 'rejected', error }),
        ),
        new Promise<{ kind: 'stalled' }>((resolve) => { timer = setTimeout(() => resolve({ kind: 'stalled' }), ms) }),
      ])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  /**
   * 注入缝的暂存写流:真实 fs 写流(生产同款:0600 文件 + `fd`),在第 `failAtWrite`
   * 次 `write` 上以 **fs 写故障的终态**失败 —— `destroy(ENOSPC 形态 error)`,即
   * `stream.errored` 同步置位、'error' 已发出、此后 `write()` 恒返回 false 且不会再
   * 有任何 'drain'/'error'(实测;评审 Important 1 的复现形态)。之前的块仍走真实
   * fs 写,故「边收边落盘」未被替换,替换掉的只是故障的**来源**(单测无法真的把
   * 磁盘写满)。message 刻意带上绝对路径:真实 fs 错误(open/rename 等)的 message
   * 就含路径,故「只回 errno」的断言必须有牙齿(评审 P1)。
   */
  function stagingStreamFailingAt(tmpPath: string, failAtWrite: number): WriteStream {
    const stream = createWriteStream(tmpPath, { fd: openSync(tmpPath, 'w', 0o600) })
    const originalWrite = stream.write.bind(stream) as (chunk: Buffer) => boolean
    let writes = 0
    stream.write = ((chunk: Buffer): boolean => {
      writes += 1
      if (writes === failAtWrite) {
        stream.destroy(Object.assign(
          new Error(`ENOSPC: no space left on device, write '${tmpPath}'`),
          { code: 'ENOSPC', syscall: 'write', path: tmpPath },
        ))
        return false
      }
      return originalWrite(chunk)
    }) as unknown as WriteStream['write']
    return stream
  }

  /** fs 写故障的 errno 形态错误(单测里无法真的写满磁盘,故以同形态错误注入)。 */
  function enospcFault(): Error {
    return Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC', syscall: 'write' })
  }

  /**
   * 逐 chunk 供给的裸 node:http 服务器(真实 socket,不经注入桩),供 fetchStream
   * 直测截断与重定向。`finished` 只在客户端**真的读完全部字节**后才为 true:每次
   * write 越过 highWaterMark 都等 drain,客户端不读就写不完(32 MiB 远超任何内核
   * 发送缓冲)⇒ 它是「超限即断连、不读完剩余」的可观测判据。
   */
  async function chunkedServer(options: { chunks: number; chunkBytes: number; status?: number; location?: string }) {
    const state = { sentChunks: 0, finished: false }
    const server: Server = createServer((_req, res) => {
      // 客户端 destroy 之后服务端续写会 EPIPE;吞掉以免未捕获 'error' 掀翻测试进程。
      res.on('error', () => {})
      res.statusCode = options.status ?? 200
      if (options.location !== undefined) res.setHeader('location', options.location)
      const chunk = Buffer.alloc(options.chunkBytes, 0x42)
      let index = 0
      const pump = (): void => {
        while (index < options.chunks) {
          index += 1
          state.sentChunks += 1
          if (!res.write(chunk)) {
            res.once('drain', pump)
            return
          }
        }
        state.finished = true
        res.end()
      }
      pump()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('chunked test server has no address')
    return {
      origin: `http://127.0.0.1:${address.port}`,
      state,
      close: () => new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
    }
  }

  test('never holds the whole compressed artifact in memory', async () => {
    const profileDir = tempProfile()
    const dir = mkdtempSync(join(tmpdir(), 'hw-market-mem-'))
    roots.push(dir)
    // 200 KiB(**不可压**随机字节,故 tgz 本身也约 200 KiB)切成 100 份 ⇒
    // 单 chunk ≈ 2 KiB,与全量相差两个数量级。
    const bytes = buildTgz(dir, { name: '@huaanwork/sample', version: '1.2.3' }, randomBytes(200 * 1024))
    const signedSha = sha256Hex(bytes)
    const tmpPath = marketArtifactTempPath(join(
      profileDir, '.market-artifacts', marketArtifactName('@huaanwork/sample', '1.2.3', signedSha),
    ))
    let midStreamSize = -1
    const probe = streamingProbe(bytes, CHUNK_COUNT, (chunkIndex) => {
      if (chunkIndex === CHUNK_COUNT / 2) {
        // 流到一半:写流已排空的那些字节**已经在盘上**,而整包尚未收齐。
        midStreamSize = existsSync(tmpPath) ? statSync(tmpPath).size : 0
      }
    })

    const prepared = await downloadAndStageArtifact({
      origin: ORIGIN,
      file: fileEntry({ sha256: signedSha }),
      profileDir,
      http: probe.client,
    })

    // 100 个 chunk 逐一交给安装侧;**一次收齐**的旧路(fetchBuffer)一次也没走。
    expect(probe.state.onChunkCalls).toBe(CHUNK_COUNT)
    expect(probe.state.fetchBufferCalls).toBe(0)
    expect(probe.state.streamCalls).toBe(1)
    expect(probe.state.handedBytes).toBe(bytes.byteLength)
    // 「任何时刻」的驻留 = 单个 chunk 量级(桩记录峰值);旧实现这里是全量。
    expect(probe.state.peakLiveBytes).toBeLessThanOrEqual(probe.chunkSize)
    expect(probe.state.peakLiveBytes).toBeLessThan(bytes.byteLength)
    // 中点处盘上已有字节且尚未收齐 ⇒ 边收边写,不是收齐后才落盘。
    expect(midStreamSize).toBeGreaterThan(0)
    expect(midStreamSize).toBeLessThan(bytes.byteLength)
    expect(sha256Hex(readFileSync(prepared.artifactPath))).toBe(signedSha)
  })

  test('hashes the exact bytes it writes (solution A preserved)', async () => {
    const profileDir = tempProfile()
    const dir = mkdtempSync(join(tmpdir(), 'hw-market-stream-sha-'))
    roots.push(dir)
    const bytes = buildTgz(dir, { name: '@huaanwork/sample', version: '1.2.3' })
    const signedSha = sha256Hex(bytes)
    const probe = streamingProbe(bytes, CHUNK_COUNT)

    const prepared = await downloadAndStageArtifact({
      origin: ORIGIN,
      file: fileEntry({ sha256: signedSha }),
      profileDir,
      http: probe.client,
    })

    // 落盘文件的 sha256 === 流式累加算出的 sha256 === 已验签清单里的值。
    expect(prepared.sha256).toBe(signedSha)
    expect(sha256Hex(readFileSync(prepared.artifactPath))).toBe(signedSha)
    expect(prepared.size).toBe(bytes.byteLength)
  })

  test('aborts and cleans up when the sha256 does not match the signed manifest', async () => {
    const profileDir = tempProfile()
    const dir = mkdtempSync(join(tmpdir(), 'hw-market-stream-tamper-'))
    roots.push(dir)
    const bytes = buildTgz(dir, { name: '@huaanwork/sample', version: '1.2.3' }, Buffer.alloc(64 * 1024, 0x33))
    const tampered = Buffer.from(bytes)
    tampered[Math.floor(tampered.byteLength / 2)]! ^= 0xff
    const probe = streamingProbe(tampered, CHUNK_COUNT)
    const chain = installChain(profileDir, probe.client, fileEntry({ sha256: sha256Hex(bytes) }))

    await expect(chain.run()).rejects.toMatchObject({ code: 'market-sha256-mismatch' })

    // 暂存文件已删:制品目录零残留(非原子窗口会留下的半个制品也不存在)。
    expect(artifactDirEntries(profileDir)).toEqual([])
    // 绝不调用 addPlugin:pnpm 零调用、零重启请求。
    expect(chain.pnpmCalls).toEqual([])
    expect(chain.restartRequests()).toBe(0)
  })

  test('aborts at the compressed cap instead of buffering past it', async () => {
    // 裁定 D-M6-25:上限自 512 MiB 放宽到 2 GiB(流式后内存峰值 O(chunk) 才敢放宽)。
    expect(MARKET_ARTIFACT_MAX_BYTES).toBe(2 * 1024 ** 3)
    // 2 GiB 的流量无法真跑;此处以 1 KiB 的小上限直测同一段截断机制。
    const server = await chunkedServer({ chunks: 32768, chunkBytes: 1024 })
    try {
      const url = resolveSameOriginUrl(server.origin, '/artifacts/big.tgz')
      const delivered: number[] = []
      await expect(createMarketHttpClient().fetchStream(url, 'artifact big', 1024, (chunk) => {
        delivered.push(chunk.byteLength)
      })).rejects.toThrow(/market artifact big exceeded 1024 bytes/u)
      // 交付恒不越过 cap(超限那一块没有交给安装侧)——TCP 可能把多次 write 并成
      // 一个 chunk,故这里断言的是上界而非「恰好 1024」。
      expect(delivered.reduce((sum, size) => sum + size, 0)).toBeLessThanOrEqual(1024)
      // 客户端 destroy 了连接:服务端剩余 32 MiB 从未被读走(不是「读完再报错」)。
      expect(server.state.finished).toBe(false)
    } finally {
      await server.close()
    }
  })

  test('a mid-stream abort deletes the staging file (cap breach leaves zero residue, no install)', async () => {
    const profileDir = tempProfile()
    const dir = mkdtempSync(join(tmpdir(), 'hw-market-stream-cap-'))
    roots.push(dir)
    const bytes = buildTgz(dir, { name: '@huaanwork/sample', version: '1.2.3' }, Buffer.alloc(64 * 1024, 0x44))
    // 前 2 块正常落盘,第 3 块处 fetchStream 以「超上限」中止(与真实 client 同语义)。
    const client: MarketHttpClient = {
      fetchText: () => Promise.reject(new Error('unexpected fetchText')),
      fetchBuffer: () => Promise.reject(new Error('unexpected fetchBuffer')),
      fetchStream: async (_url, _label, _maxBytes, onChunk) => {
        await onChunk(bytes.subarray(0, 4096))
        await onChunk(bytes.subarray(4096, 8192))
        throw new MarketFetchError('market artifact @huaanwork/sample@1.2.3 exceeded 2 bytes', 502)
      },
    }
    const chain = installChain(profileDir, client, fileEntry({ sha256: sha256Hex(bytes) }))

    await expect(chain.run()).rejects.toThrow(/exceeded/u)

    expect(artifactDirEntries(profileDir)).toEqual([])
    expect(chain.pnpmCalls).toEqual([])
  })

  test('a staging IO fault reports errno only (no absolute path, no install)', async () => {
    const profileDir = tempProfile()
    // `.market-artifacts` 是文件而不是目录 ⇒ 建暂存文件必失败(ENOTDIR)。
    writeFileSync(join(profileDir, '.market-artifacts'), 'not a directory')
    const dir = mkdtempSync(join(tmpdir(), 'hw-market-io-'))
    roots.push(dir)
    const bytes = buildTgz(dir, { name: '@huaanwork/sample', version: '1.2.3' })
    const probe = streamingProbe(bytes, 4)
    const chain = installChain(profileDir, probe.client, fileEntry({ sha256: sha256Hex(bytes) }))

    let caught: unknown
    try {
      await chain.run()
    } catch (cause) {
      caught = cause
    }
    expect(caught).toBeInstanceOf(MarketFetchError)
    expect((caught as MarketFetchError).code).toBe('market-artifact-io')
    // 评审 P1:message 只回 errno,绝不回 profileDir 绝对路径。
    expect((caught as Error).message).toMatch(/\(ENOTDIR\)/u)
    expect((caught as Error).message).not.toContain(profileDir)
    expect(chain.pnpmCalls).toEqual([])
  })

  /**
   * 评审 Important 1(前半):下载到一半时**宿主写故障**不得被讲成「内网市场不可达」。
   * 故障用注入缝制造(磁盘满无法在可移植的单测里真实制造),其余全链是生产件:真实
   * socket + `createMarketHttpClient` 的 `requestStream` —— 正是它会把非
   * MarketFetchError 的 fs 错误包装成 502 `market-unreachable`(本用例的回归点)。
   */
  test('a mid-stream staging write fault is host IO (500 market-artifact-io), not a 502 market outage', async () => {
    const profileDir = tempProfile()
    const served = Buffer.alloc(64 * 8192, 0x42)
    const server = await chunkedServer({ chunks: 64, chunkBytes: 8192 })
    try {
      const chain = installChain(profileDir, createMarketHttpClient(), fileEntry({ sha256: sha256Hex(served) }), {
        origin: server.origin,
        // 第 2 块写时「磁盘满」:下载**中途**、且已有一块真实落盘。
        openStagingStream: (tmpPath) => stagingStreamFailingAt(tmpPath, 2),
      })

      const started = Date.now()
      // 等待上界 3 s > 断言上界 2 s:这样「落定但慢到不像样」与「根本没落定(挂死)」
      // 是两条不同的失败信息。生产件里的 socket 静默超时是 15 s(MARKET_HTTP_TIMEOUT_MS)。
      const outcome = await settleWithin(chain.run(), 3000)
      const elapsed = Date.now() - started

      expect(outcome.kind).not.toBe('stalled')
      if (outcome.kind !== 'rejected') throw new Error(`expected the install to reject, got ${outcome.kind}`)
      const error = outcome.error as MarketFetchError
      expect(error).toBeInstanceOf(MarketFetchError)
      // 宿主 IO ⇒ 500 market-artifact-io;绝不是 502 market-unreachable(磁盘满与网络无关)。
      expect(error.status).toBe(500)
      expect(error.code).toBe('market-artifact-io')
      expect(error.message).toMatch(/\(ENOSPC\)/u)
      expect(error.message).not.toMatch(/unreachable/u)
      expect(error.message).not.toMatch(/timed out/u)
      expect(error.message).not.toContain(profileDir)
      // 未等满 15 s 的 socket 静默超时:故障即报,不白占 execute 的单飞互斥。
      expect(elapsed).toBeLessThan(2000)
      // 暂存零残留、绝不安装。
      expect(artifactDirEntries(profileDir)).toEqual([])
      expect(chain.pnpmCalls).toEqual([])
    } finally {
      await server.close()
    }
  })

  /**
   * 评审 Important 1(后半):写流一旦 `destroy(err)`,`write()` 恒返回 false 且**不会
   * 再有 'drain'/'error'** ⇒ 「等 drain」等于等一个永不再来的事件(实测 1.5 s 不落定)。
   * 本用例把故障放在两次 onChunk 之间的边界上(此刻 'error' 已发出、`stream.errored`
   * 已置位),正是只会挂死的那个交错;此处没有 socket,故旧实现会**永久**挂住(生产中
   * 则拖满 15 s 的静默超时并谎报 timed out)。
   */
  test('a write fault that already destroyed the stream cannot stall the install on a drain that never comes', async () => {
    const profileDir = tempProfile()
    const dir = mkdtempSync(join(tmpdir(), 'hw-market-stream-io-'))
    roots.push(dir)
    const bytes = buildTgz(dir, { name: '@huaanwork/sample', version: '1.2.3' }, Buffer.alloc(64 * 1024, 0x55))
    let staging: WriteStream | undefined
    const client: MarketHttpClient = {
      fetchText: () => Promise.reject(new Error('unexpected fetchText on the install path')),
      fetchBuffer: () => Promise.reject(new Error('the streaming install path must not call fetchBuffer (第 53 条)')),
      fetchStream: async (_url, _label, _maxBytes, onChunk) => {
        await onChunk(bytes.subarray(0, 4096))
        const stream = staging!
        const errored = once(stream, 'error')
        stream.destroy(enospcFault())
        await errored // 故障已完整发出:'error' 已 emit、errored 已置位
        await onChunk(bytes.subarray(4096, 8192))
        return { bytes: bytes.byteLength }
      },
    }
    const chain = installChain(profileDir, client, fileEntry({ sha256: sha256Hex(bytes) }), {
      openStagingStream: (tmpPath) => {
        staging = createWriteStream(tmpPath, { fd: openSync(tmpPath, 'w', 0o600) })
        return staging
      },
    })

    const outcome = await settleWithin(chain.run(), 2000)

    expect(outcome.kind).not.toBe('stalled')
    if (outcome.kind !== 'rejected') throw new Error(`expected the install to reject, got ${outcome.kind}`)
    const error = outcome.error as MarketFetchError
    expect(error).toBeInstanceOf(MarketFetchError)
    expect(error.status).toBe(500)
    expect(error.code).toBe('market-artifact-io')
    expect(error.message).toMatch(/\(ENOSPC\)/u)
    expect(error.message).not.toMatch(/unreachable|timed out/u)
    expect(artifactDirEntries(profileDir)).toEqual([])
    expect(chain.pnpmCalls).toEqual([])
  })

  test('still refuses a cross-origin tarball URL before making any request (spec §14 第 51 条)', async () => {
    const profileDir = tempProfile()
    const calls: string[] = []
    const http: MarketHttpClient = {
      fetchText: (url) => { calls.push(url); return Promise.reject(new Error('unreachable')) },
      fetchBuffer: (url) => { calls.push(url); return Promise.reject(new Error('unreachable')) },
      fetchStream: (url) => { calls.push(url); return Promise.reject(new Error('unreachable')) },
    }
    await expect(downloadAndStageArtifact({
      origin: ORIGIN,
      file: fileEntry({ tarballPath: 'http://evil.intranet.example:9999/artifacts/x.tgz' }),
      profileDir,
      http,
    })).rejects.toMatchObject({ code: 'market-artifact-origin' })
    expect(calls).toEqual([])
  })

  test('still does not follow redirects (a 3xx hop cannot be taken)', async () => {
    const target = await chunkedServer({ chunks: 1, chunkBytes: 16 })
    const redirector = await chunkedServer({ chunks: 0, chunkBytes: 1, status: 302, location: `${target.origin}/artifacts/x.tgz` })
    try {
      const url = resolveSameOriginUrl(redirector.origin, '/artifacts/x.tgz')
      await expect(createMarketHttpClient().fetchStream(url, 'artifact x', 4096, () => {}))
        .rejects.toThrow(/HTTP 302/u)
      expect(target.state.sentChunks).toBe(0)
    } finally {
      await redirector.close()
      await target.close()
    }
  })

  test('keeps the decompression cap equal to the publish-side cap', async () => {
    // 边界即数值:解压恰 64 MiB 通过上限(随后因「没有 package.json」而拒),
    // 64 MiB + 1 字节才触发上限错误 —— 那个 +1 把 64 MiB 这个数值本身钉死。
    // 发布侧同值单测(market-server/tests/tarball-parse.spec.ts):
    // 「rejects a gzip bomb over the cap with an honest fail-closed error (buffer path)」
    // 断言消息含 67108864;「streaming file path: a gzip bomb file over the cap …」
    // 钉住流式文件路径。依赖方向守卫禁止 import market-server,故两侧各自单测钉住。
    const dir = mkdtempSync(join(tmpdir(), 'hw-market-cap-'))
    roots.push(dir)
    const atCap = join(dir, 'at-cap.tgz')
    const overCap = join(dir, 'over-cap.tgz')
    const corrupt = join(dir, 'corrupt.tgz')
    writeFileSync(atCap, gzipSync(Buffer.alloc(64 * 1024 * 1024, 0x41)))
    writeFileSync(overCap, gzipSync(Buffer.alloc(64 * 1024 * 1024 + 1, 0x41)))
    writeFileSync(corrupt, Buffer.from('definitely not gzip'))
    expect(statSync(atCap).size).toBeLessThan(1024 * 1024) // 炸弹形态,不是 64 MiB 真传输

    await expect(readTarballPackageJsonFromFile(atCap)).rejects.toThrow(/no top-level package\.json/u)

    let caught: unknown
    try {
      await readTarballPackageJsonFromFile(overCap)
    } catch (cause) {
      caught = cause
    }
    expect(caught).toBeInstanceOf(MarketInstallGateError)
    expect((caught as MarketInstallGateError).code).toBe('market-invalid-tarball')
    // 超限与「不是合法 gzip」分开诚实报错(第 53 条);上限数字出现在文案里。
    expect((caught as Error).message).toMatch(/decompresses beyond the 67108864-byte limit/u)
    expect((caught as Error).message).not.toMatch(/not a valid gzip/u)

    // 坏 gzip 仍报「不是合法 gzip」:两条失败路径不互相冒充。
    await expect(readTarballPackageJsonFromFile(corrupt)).rejects.toThrow(/not a valid gzip/u)
  })

  test('a gzip bomb artifact is rejected at the decompression cap through the install path', async () => {
    const profileDir = tempProfile()
    const dir = mkdtempSync(join(tmpdir(), 'hw-market-bomb-'))
    roots.push(dir)
    const bomb = gzipSync(Buffer.alloc(64 * 1024 * 1024 + 1, 0x41))
    expect(bomb.byteLength).toBeLessThan(1024 * 1024)
    const probe = streamingProbe(bomb, 4)
    const chain = installChain(profileDir, probe.client, fileEntry({ sha256: sha256Hex(bomb) }))

    await expect(chain.run()).rejects.toThrow(/decompresses beyond/u)

    expect(artifactDirEntries(profileDir)).toEqual([])
    expect(chain.pnpmCalls).toEqual([])
  })

  test('installs the artifact it just verified, byte for byte', async () => {
    const profileDir = tempProfile()
    const dir = mkdtempSync(join(tmpdir(), 'hw-market-install-bytes-'))
    roots.push(dir)
    const bytes = buildTgz(dir, { name: '@huaanwork/sample', version: '1.2.3' }, Buffer.alloc(32 * 1024, 0x77))
    const signedSha = sha256Hex(bytes)
    const probe = streamingProbe(bytes, CHUNK_COUNT)
    const chain = installChain(profileDir, probe.client, fileEntry({ sha256: signedSha }))

    const result = await chain.run()

    // addPlugin 收到的是**已校验制品**路径(offline:true ⇒ 两 flag),不是源/临时路径。
    const expectedPath = join(profileDir, '.market-artifacts', marketArtifactName('@huaanwork/sample', '1.2.3', signedSha))
    expect(chain.pnpmCalls).toEqual([['add', expectedPath, '--offline', '--ignore-scripts']])
    expect(result.restarting).toBe(true)
    // 被安装文件 = 被哈希文件:argv 路径的 sha256 === 清单值,且中途未重新取字节。
    expect(sha256Hex(readFileSync(expectedPath))).toBe(signedSha)
    expect(probe.state.streamCalls).toBe(1)
    expect(probe.state.fetchBufferCalls).toBe(0)
    expect(artifactDirEntries(profileDir)).toEqual([marketArtifactName('@huaanwork/sample', '1.2.3', signedSha)])
  })
})

describe('readTarballPackageJsonFromFile (第 53 条:落盘制品不再整包读回内存)', () => {
  test('streams the manifest out of a staged file (same walk rules as the buffered reader)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hw-market-file-read-'))
    roots.push(dir)
    const bytes = buildTgz(dir, { name: 'pkg-file', version: '2.0.0' })
    const path = join(dir, 'artifact.tgz')
    writeFileSync(path, bytes)

    await expect(readTarballPackageJsonFromFile(path)).resolves.toEqual({ name: 'pkg-file', version: '2.0.0' })
  })

  test('maps a read fault to an errno-only host error instead of a tarball verdict', async () => {
    // 文件读不动(此处不存在)是**宿主**故障,不得被报成「制品不是合法 tarball」。
    await expect(readTarballPackageJsonFromFile(join(tmpdir(), 'hw-market-missing-artifact.tgz')))
      .rejects.toMatchObject({ code: 'market-artifact-io' })
  })
})

describe('artifact dir mode (review D7)', () => {
  test('catalog read before install (production timing): revision persistence creates the dir 0700', () => {
    // 用户先浏览目录再安装是生产正常时序:saveMaxRevision 先于任何安装到达时,
    // 制品目录由它创建——必须 0700(修复前是 mkdirSync 无 mode 的 0755)。
    const profileDir = tempProfile()
    const store = createFileRevisionStore(profileDir, () => {})
    store.saveMaxRevision(ORIGIN, 1)
    expect(existsSync(join(profileDir, '.market-artifacts'))).toBe(true)
    expect(statSync(join(profileDir, '.market-artifacts')).mode & 0o777).toBe(0o700)
    expect(store.loadMaxRevision(ORIGIN)).toBe(1)
  })

  test('an existing 0755 artifact dir is forced back to 0700 on the next ensure', () => {
    const profileDir = tempProfile()
    const dir = join(profileDir, '.market-artifacts')
    mkdirSync(dir, { mode: 0o755 })
    chmodSync(dir, 0o755)
    ensureMarketArtifactsDir(profileDir)
    expect(statSync(dir).mode & 0o777).toBe(0o700)
  })
})

describe('revision state staging name (P16)', () => {
  /**
   * P16(Task 6.9):固定暂存名 `${statePath}.tmp` 下,共享同一 profileDir 的两个 app
   * 实例会互相覆盖对方的暂存文件。协议改为 `<statePath>.tmp-<pid>-<8hex>`(与
   * Task 6.3 的制品暂存同款):pid 区分实例,8 位随机 hex 让同 pid 的多次提交也
   * 各有其名。时钟冻结——名字不得来自时间(同刻两个实例会撞名)。
   */
  test('P16: two concurrent state writers never share a staging name (frozen clock)', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-27T12:00:00Z'))
    try {
      const module = (await import('../../src/huaanwork-host/market/catalog-client.ts')) as unknown as Record<string, unknown>
      const protocol = module.revisionStateTempPath as ((statePath: string) => string) | undefined
      expect(protocol, 'catalog-client must export the one staging-name protocol').toBeTypeOf('function')
      if (protocol === undefined) throw new Error('unreachable: asserted above')

      const profileDir = tempProfile()
      const statePath = join(profileDir, '.market-artifacts', 'state.json')
      const first = protocol(statePath)
      const second = protocol(statePath)
      expect(first).toMatch(/^.*state\.json\.tmp-\d+-[0-9a-f]{8}$/u)
      expect(first).toContain(`.tmp-${String(process.pid)}-`)
      expect(second).not.toBe(first)

      // 两个写者并发提交(同进程 = 同 pid 的最坏形态:pid 分不开时靠随机后缀分开):
      // 都成功、互不覆盖,且暂存名不留残余(提交是同步 write+rename)。
      const storeA = createFileRevisionStore(profileDir, () => {})
      const storeB = createFileRevisionStore(profileDir, () => {})
      const originA = 'http://a.intranet.example:8787'
      const originB = 'http://b.intranet.example:8787'
      await Promise.all([
        Promise.resolve().then(() => storeA.saveMaxRevision(originA, 5)),
        Promise.resolve().then(() => storeB.saveMaxRevision(originB, 7)),
      ])
      expect(storeA.loadMaxRevision(originA)).toBe(5)
      expect(storeB.loadMaxRevision(originB)).toBe(7)
      expect(readdirSync(join(profileDir, '.market-artifacts')).filter(entry => entry.includes('.tmp'))).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('artifact GC (N1)', () => {
  function artifact(profileDir: string, name: string, version: string, sha: string): string {
    // GC 用例不经过安装路径(tempProfile 已不预建目录),本 helper 自备目录。
    mkdirSync(join(profileDir, '.market-artifacts'), { recursive: true })
    const path = join(profileDir, '.market-artifacts', marketArtifactName(name, version, sha))
    writeFileSync(path, 'bytes')
    return path
  }

  test('removePlugin-side GC deletes only the removed package artifacts', () => {
    const profileDir = tempProfile()
    const a = artifact(profileDir, '@huaanwork/plugin-a', '1.0.0', 'a'.repeat(64))
    const b = artifact(profileDir, '@huaanwork/plugin-b', '1.0.0', 'b'.repeat(64))
    const logs: string[] = []

    gcRemovedPackageArtifacts(profileDir, '@huaanwork/plugin-a', (m) => logs.push(m))

    expect(existsSync(a)).toBe(false)
    expect(existsSync(b)).toBe(true)
    expect(logs.some(m => m.includes('plugin-a'))).toBe(true)
  })

  test('GC prefix collision (N1, review round 1): uninstalling plugin-a never touches plugin-a-extra', () => {
    const profileDir = tempProfile()
    const a = artifact(profileDir, '@x/plugin-a', '1.0.0', 'a'.repeat(64))
    // 相邻包:safeName `x/plugin-a` 是 `x/plugin-a-extra` 制品名的裸前缀。
    const extra = artifact(profileDir, '@x/plugin-a-extra', '2.0.0', 'e'.repeat(64))
    // extra 已装,profile 里有指向其制品的 file: 引用(卸载 a 后必须仍可解析)。
    writeFileSync(join(profileDir, 'package.json'), `${JSON.stringify({
      name: 'profile',
      dependencies: { '@x/plugin-a-extra': `file:${extra}` },
    }, undefined, 2)}\n`)
    const logs: string[] = []

    gcRemovedPackageArtifacts(profileDir, '@x/plugin-a', (m) => logs.push(m))

    // a 的制品被 GC;extra 的制品与引用全部存活——后续 pnpm 操作不会 ENOENT。
    expect(existsSync(a)).toBe(false)
    expect(existsSync(extra)).toBe(true)
    expect(profileFileReferencesExist(profileDir)).toBe(true)
    expect(logs.some(m => m.includes('x-plugin-a-1.0.0') && m.includes('removed artifact'))).toBe(true)
    expect(logs.some(m => m.includes('x-plugin-a-extra'))).toBe(false)
  })

  // P17:保留判据必须与 checkpoint 侧同口径地扫 devDependencies。只扫
  // dependencies 时,pnpm 落点一旦变化(如 `pnpm add -D`)活 profile 侧就看不见
  // 引用 ⇒ 删掉在役制品 ⇒ 悬空 `file:` 引用,即评审 D9 的失效模式经此路径依然
  // 可达(D9 的修复只让 checkpoint 半边变严)。回退 collectProfileFileReferences
  // 为只读 dependencies 即红。
  test('GC and the orphan sweep both retain an artifact referenced from devDependencies (P17)', () => {
    const profileDir = tempProfile()
    const dev = artifact(profileDir, '@x/plugin-dev', '1.0.0', 'd'.repeat(64))
    writeFileSync(join(profileDir, 'package.json'), `${JSON.stringify({
      name: 'profile',
      devDependencies: { '@x/plugin-dev': `file:${dev}` },
    }, undefined, 2)}\n`)

    // 卸载侧 GC:制品名精确命中该包,唯一的保命理由就是那条 devDependencies 引用
    // (代码注释里的「双保险」分支)。
    const logs: string[] = []
    gcRemovedPackageArtifacts(profileDir, '@x/plugin-dev', (m) => logs.push(m))
    expect(existsSync(dev)).toBe(true)
    expect(logs.some(m => m.includes('kept referenced artifact'))).toBe(true)

    // 启动孤儿清扫同口径:有引用者不是孤儿。
    expect(sweepOrphanMarketArtifacts(profileDir, () => {})).toEqual([])
    expect(existsSync(dev)).toBe(true)
    expect(profileFileReferencesExist(profileDir)).toBe(true)
  })

  test('GC boundary: prerelease versions still match exactly; non-semver lookalikes never match', () => {
    const profileDir = tempProfile()
    const stable = artifact(profileDir, '@x/pkg', '1.0.0', '1'.repeat(64))
    const prerelease = artifact(profileDir, '@x/pkg', '1.0.0-beta.2', '2'.repeat(64))
    // 命名陷阱:裸前缀 `x/pkg-` 命中,但 `notsemver` 不是版本 ⇒ 不得删。
    writeFileSync(join(profileDir, '.market-artifacts', 'x-pkg-notsemver-' + '3'.repeat(12) + '.tgz'), 'x')
    const logs: string[] = []

    gcRemovedPackageArtifacts(profileDir, '@x/pkg', (m) => logs.push(m))

    expect(existsSync(stable)).toBe(false)
    expect(existsSync(prerelease)).toBe(false)
    expect(existsSync(join(profileDir, '.market-artifacts', 'x-pkg-notsemver-' + '3'.repeat(12) + '.tgz'))).toBe(true)
  })

  test('GC version span: publish gate accepts filename-safe versions, so 1.0/1 two-segment artifacts are GC-able too', () => {
    // gate.ts PACKAGE_VERSION_PATTERN 只要求 filename-safe(`1.0` 合法可发布);
    // GC 版本面必须对齐,否则卸载后制品漏删(只能等下次启动孤儿清扫)。
    const profileDir = tempProfile()
    const one = artifact(profileDir, '@x/pkg', '1.0', '4'.repeat(64))
    const bare = artifact(profileDir, '@x/pkg', '1', '5'.repeat(64))
    const fourSegment = artifact(profileDir, '@x/pkg', '1.0.0.1', '6'.repeat(64))
    const logs: string[] = []

    gcRemovedPackageArtifacts(profileDir, '@x/pkg', (m) => logs.push(m))

    expect(existsSync(one)).toBe(false)
    expect(existsSync(bare)).toBe(false)
    // 四段 `1.0.0.1` 超出点分 1–3 段面(也非合法发布版本形态)⇒ 保守不删。
    expect(existsSync(fourSegment)).toBe(true)
    expect(logs.some(m => m.includes('x-pkg-1.0-') && m.includes('removed artifact'))).toBe(true)
    expect(logs.some(m => m.includes('x-pkg-1-') && m.includes('removed artifact'))).toBe(true)
  })

  test('boot sweep deletes only orphans without a file: reference', () => {
    const profileDir = tempProfile()
    const referenced = artifact(profileDir, '@huaanwork/plugin-a', '1.0.0', 'a'.repeat(64))
    const orphan = artifact(profileDir, '@huaanwork/plugin-b', '1.0.0', 'b'.repeat(64))
    // profile package.json 引用 plugin-a 的制品(N1:有引用者必须保留)。
    writeFileSync(join(profileDir, 'package.json'), `${JSON.stringify({
      name: 'profile',
      dependencies: { '@huaanwork/plugin-a': `file:${referenced}` },
    }, undefined, 2)}\n`)

    const removed = sweepOrphanMarketArtifacts(profileDir, () => {})

    expect(removed).toEqual([marketArtifactName('@huaanwork/plugin-b', '1.0.0', 'b'.repeat(64))])
    expect(existsSync(referenced)).toBe(true)
    expect(existsSync(orphan)).toBe(false)
    expect(profileFileReferencesExist(profileDir)).toBe(true)
  })

  test('installed artifact survives: no GC touches referenced artifacts', () => {
    const profileDir = tempProfile()
    const referenced = artifact(profileDir, '@huaanwork/plugin-a', '1.0.0', 'a'.repeat(64))
    writeFileSync(join(profileDir, 'package.json'), `${JSON.stringify({
      dependencies: { '@huaanwork/plugin-a': `file:${referenced}` },
    })}\n`)
    sweepOrphanMarketArtifacts(profileDir, () => {})
    gcRemovedPackageArtifacts(profileDir, '@huaanwork/other', () => {})
    expect(existsSync(referenced)).toBe(true)
  })
})

describe('artifact GC × profile checkpoint (review D9)', () => {
  function artifactFile(profileDir: string, name: string, version: string, sha: string): string {
    mkdirSync(join(profileDir, '.market-artifacts'), { recursive: true })
    const path = join(profileDir, '.market-artifacts', marketArtifactName(name, version, sha))
    writeFileSync(path, 'bytes')
    return path
  }

  function profileManifest(dependencies: Record<string, string>): string {
    return `${JSON.stringify({ name: 'profile', dependencies }, undefined, 2)}\n`
  }

  test('an artifact referenced by a checkpoint slot survives uninstall GC and boot sweep; GC resumes once the checkpoint reference is gone', () => {
    const profileDir = tempProfile()
    const userDataDir = mkdtempSync(join(tmpdir(), 'hw-market-checkpoint-'))
    roots.push(userDataDir)
    const a = artifactFile(profileDir, '@x/plugin-a', '1.0.0', 'a'.repeat(64))

    // ① 安装态:profile package.json 引用 A 的制品。
    writeFileSync(join(profileDir, 'package.json'), profileManifest({ '@x/plugin-a': `file:${a}` }))
    // ② 健康启动 captureHealthy:真实写路径产出含该引用的 slot 快照。
    const checkpoint = new DesktopProfileCheckpoint({
      userDataDir,
      profileDir,
      profileName: 'test-profile',
      provider: 'desktop-profile',
    })
    expect(checkpoint.captureHealthy().status).toBe('captured')
    // ③ 卸载结果态:当前 profile 中的引用已消失(只剩 checkpoint slot 持有)。
    writeFileSync(join(profileDir, 'package.json'), profileManifest({}))

    // main 进程注入的 env(生产由 main.ts 赋值;此处直接模拟)。
    process.env[PROFILE_CHECKPOINT_USER_DATA_DIR_ENV] = userDataDir
    try {
      // 卸载 GC 必须保留 A:某个 checkpoint slot 仍引用它,restoreSlot 后物化
      // 依赖要靠它(删了 ⇒ 恢复后 pnpm 确定性 ENOENT,D9 失效模式)。
      gcRemovedPackageArtifacts(profileDir, '@x/plugin-a', () => {})
      expect(existsSync(a)).toBe(true)
      // 启动孤儿清扫同样必须保留 A。
      expect(sweepOrphanMarketArtifacts(profileDir, () => {})).toEqual([])
      expect(existsSync(a)).toBe(true)
      expect(profileFileReferencesExist(profileDir)).toBe(true)

      // ④ checkpoint 引用失效(如该 profile 的 checkpoint 被清空)⇒ GC 恢复收集。
      rmSync(checkpoint.profileRoot, { recursive: true, force: true })
      const logs: string[] = []
      gcRemovedPackageArtifacts(profileDir, '@x/plugin-a', (m) => logs.push(m))
      expect(existsSync(a)).toBe(false)
      expect(logs.some(m => m.includes('x-plugin-a-1.0.0') && m.includes('removed artifact'))).toBe(true)
    } finally {
      delete process.env[PROFILE_CHECKPOINT_USER_DATA_DIR_ENV]
    }
  })

  test('env unset (non-Desktop host) keeps the pre-D9 checkpoint-blind behavior', () => {
    const profileDir = tempProfile()
    const a = artifactFile(profileDir, '@x/plugin-a', '1.0.0', 'a'.repeat(64))
    delete process.env[PROFILE_CHECKPOINT_USER_DATA_DIR_ENV]

    gcRemovedPackageArtifacts(profileDir, '@x/plugin-a', () => {})
    expect(existsSync(a)).toBe(false)
  })

  // 评审 D9 指定而我方修复轮漏掉的最后一环:前一个测试只断言「GC 没删」,
  // 从不真正 restore。此处走完 装 A → 快照 → 卸 A(GC) → restoreSlot → 引用仍可
  // 解析 的完整四步。回退保留判据(退回 profile-only)即红:GC 会在 restore 之前
  // 删掉 A,恢复后的 package.json 便指向不存在的制品,物化依赖确定性 ENOENT。
  test('a checkpoint restore after uninstall GC still resolves the artifact reference (review D9, full cycle)', () => {
    const profileDir = tempProfile()
    const userDataDir = mkdtempSync(join(tmpdir(), 'hw-market-restore-'))
    roots.push(userDataDir)
    const a = artifactFile(profileDir, '@x/plugin-a', '1.0.0', 'a'.repeat(64))

    writeFileSync(join(profileDir, 'package.json'), profileManifest({ '@x/plugin-a': `file:${a}` }))
    const checkpoint = new DesktopProfileCheckpoint({
      userDataDir,
      profileDir,
      profileName: 'test-profile',
      provider: 'desktop-profile',
    })
    const captured = checkpoint.captureHealthy()
    expect(captured.status).toBe('captured')
    if (captured.status !== 'captured') return
    // 卸载结果态:当前 profile 的引用消失,只剩 checkpoint slot 持有。
    writeFileSync(join(profileDir, 'package.json'), profileManifest({}))

    process.env[PROFILE_CHECKPOINT_USER_DATA_DIR_ENV] = userDataDir
    try {
      gcRemovedPackageArtifacts(profileDir, '@x/plugin-a', () => {})
      expect(existsSync(a)).toBe(true)

      // 用户在恢复窗口选回该 slot:旧 package.json(含 A 的 file: 引用)被写回。
      const restored = checkpoint.restoreSlot(captured.slotId)
      expect(restored.status).toBe('restored')
      expect(restored.dependencyMaterializationRequired).toBe(true)

      // D9 的承重点:引用回来了,制品也还在盘上 ⇒ 后续物化 pnpm 不会 ENOENT。
      const restoredManifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')) as {
        dependencies?: Record<string, string>
      }
      expect(restoredManifest.dependencies?.['@x/plugin-a']).toBe(`file:${a}`)
      expect(existsSync(a)).toBe(true)
      expect(profileFileReferencesExist(profileDir)).toBe(true)
    } finally {
      delete process.env[PROFILE_CHECKPOINT_USER_DATA_DIR_ENV]
    }
  })

  // 上一条的 profileFileReferencesExist 断言只有在「制品缺失时返回 false」的前提下
  // 才有意义——否则它对任何 profile 都真(无 file: 引用时空集恒真)。此处钉住其牙齿。
  test('profileFileReferencesExist is false when a referenced artifact is missing (assertion has teeth)', () => {
    const profileDir = tempProfile()
    const ghost = join(profileDir, '.market-artifacts', 'x-plugin-a-1.0.0-aaaaaaaaaaaa.tgz')
    writeFileSync(join(profileDir, 'package.json'), profileManifest({ '@x/plugin-a': `file:${ghost}` }))
    expect(existsSync(ghost)).toBe(false)
    expect(profileFileReferencesExist(profileDir)).toBe(false)
  })

  /**
   * N-11(Task 6.9):`HUAANWORK_CHECKPOINT_USER_DATA_DIR` 写进 `process.env` 会泄漏到
   * 所有子进程(含用户可见终端)。裁定 = **已评估,保留现状**:显式传递只能改
   * `src/host-process.ts` 的 `utilityProcess.fork` env(与 beta 逐字节共享,白名单预算
   * 冻结 22/6、不得新增条目),而隔离宿主的 `artifacts.ts` 读的是**子进程自己的**
   * `process.env`——fork 的 `env: { ...process.env }` 是唯一可达通道。理由现落在
   * main.ts 的注释里;本条钉住注释与唯一注入点(退回沉默即红)。
   */
  test('N-11: the unconditional env write is evaluated and kept, with its reason recorded in main.ts', () => {
    const mainSource = readFileSync(join(import.meta.dirname, '../../src/main.ts'), 'utf8')
    expect(mainSource).toContain('已评估,保留')
    expect(mainSource).toContain('host-process.ts')
    expect(mainSource).toContain('utilityProcess.fork')
    expect(mainSource.match(/process\.env\[PROFILE_CHECKPOINT_USER_DATA_DIR_ENV\] = profileUserDataDir/gu))
      .toHaveLength(1)
  })
})
