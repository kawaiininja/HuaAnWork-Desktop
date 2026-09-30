/**
 * huaanwork-market 远程安装执行(M5 Task 5 Step 3,解法 A;M6 Task 6.3 流式,第 53 条)。
 *
 * 安装链(〈安装入口边界〉,被校验顶层制品字节 = 被安装字节):
 * ① 从**已验签清单**取 `name@version` 的 tarballPath + sha256;URL 经
 *    catalog-client.resolveSameOriginUrl 同源钉扎(X1,fail-closed)。
 * ② 自有 HTTP client **流式**拉取 .tgz(catalog-client.fetchStream,不跟随重定向;
 *    压缩上限 MARKET_ARTIFACT_MAX_BYTES = 2 GiB,裁定 D-M6-25):边收边
 *    `hash.update(chunk)` 边写暂存文件(背压:`write` 返回 false 即等 drain),主进程
 *    内存峰值 = O(chunk);超上限即断连并**不读完**剩余字节。
 * ③ 流结束比对 sha256(**被哈希的就是被写入暂存、随后原子 rename 成制品的那些
 *    字节**——第 53 条:「被校验顶层制品字节 = 被安装字节」不依赖流式,只要求校验后
 *    不重新取字节):不符即删暂存并拒——**不落盘、不安装、诚实报错**。
 * ④ **零依赖与无脚本预检**(round4 裁定 (c),安装侧门,与发布侧门同口径):
 *    dependencies/optionalDependencies 非空即拒;scripts 含 preinstall/install/
 *    postinstall/prepare 亦拒(peerDependencies 豁免;bundleDependencies 允许;
 *    其余非 lifecycle scripts 允许)。manifest 从**暂存文件流式解压**读出(下同),
 *    压缩字节不整包读回内存。
 * ⑤ 通过才落制品 `<profileDir>/.market-artifacts/<name>-<version>-<sha256前12>.tgz`
 *    (目录 0700、文件 0600、**不删**——file: 引用共存亡,N1);命名/暂存/提交走
 *    market/artifacts.ts 的**唯一**实现(与本地安装共用,Task 6.3 收敛),同 sha
 *    重复安装 = 等价重写(temp + rename 原子替换)。
 * ⑥ `addPlugin(制品路径, {offline: true})` → pnpm 恒带 `--offline --ignore-scripts`
 *    (两道补强;flag 构造只在 addPlugin 内;不经 runExternalMarketPluginInstall/--registry)。
 *
 * tarball 解包:node:zlib gunzip + ustar 512B 头 walk(零依赖,与 market-server
 * 发布侧门同形态;支持 ustar prefix 拼接与 GNU longname 'L';depth-1
 * package.json 恰好一个才可用,含 `..` 段或多候选一律拒)。**manifest 选取规则**
 * 与发布侧门逐条一致并由共享 fixture 钉住,两侧已知且有意的差异见
 * readTarballPackageJson 的函数注释(N-2)。
 */

import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { createReadStream, createWriteStream, openSync, type WriteStream } from 'node:fs'
import { Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGunzip, gunzipSync } from 'node:zlib'
import type { DesktopPnpm } from '../../pnpm.ts'
import type { ConfirmedRestartRuntime } from '../../host-runtime-bridge.ts'
import { addPlugin, type PluginMutationResult } from '../plugins-host.ts'
import {
  commitMarketArtifact,
  discardMarketArtifactTemp,
  MarketArtifactIoError,
  marketArtifactPath,
  marketArtifactTempPath,
  marketIoErrno,
} from './artifacts.ts'
import { MarketFetchError, createMarketHttpClient, resolveSameOriginUrl, type MarketHttpClient } from './catalog-client.ts'
import type { MarketManifestFile } from './verify.ts'

/** 安装侧门失败的具名错误(routes 层映射 400 + 点名违规项)。 */
export class MarketInstallGateError extends Error {
  constructor(message: string, readonly code: string = 'market-install-gate') {
    super(message)
    this.name = 'MarketInstallGateError'
  }
}

// ---------------------------------------------------------------------------
// ustar 解包(只取 <root>/package.json;零依赖)
// ---------------------------------------------------------------------------

const TAR_BLOCK_SIZE = 512

/**
 * 解压后 tar 字节上限(评审 D6:gunzip 炸弹防护)。**必须与 market-server 发布侧
 * `tarball/parse.ts` 的 `MAX_TAR_DECOMPRESSED_BYTES` 同值**——发布侧已按此上限
 * 拒绝过大的制品,安装侧若更严会让合法已发布制品装不上,若更松则失去意义。
 * 依赖方向守卫禁止 import market-server,故以注释交叉引用而非共享常量;
 * 两侧任一改动都必须同步(与 manifest 选取规则同理由,见 readTarballPackageJson)。
 */
const MAX_TAR_DECOMPRESSED_BYTES = 64 * 1024 * 1024

function parseOctal(field: Buffer): number {
  const text = field.toString('ascii').replace(/\0.*$/u, '').trim()
  if (text.length === 0) return 0
  const value = Number.parseInt(text, 8)
  return Number.isNaN(value) ? 0 : value
}

function tarEntries(buffer: Buffer): { name: string; type: string; data: Buffer }[] {
  const entries: { name: string; type: string; data: Buffer }[] = []
  let offset = 0
  let pendingLongName: string | undefined
  while (offset + TAR_BLOCK_SIZE <= buffer.length) {
    const header = buffer.subarray(offset, offset + TAR_BLOCK_SIZE)
    // 全零块 = 归档结束。
    if (header.every((byte) => byte === 0)) break
    const type = String.fromCharCode(header[156] ?? 0)
    let name = header.toString('utf8', 0, 100).replace(/\0.*$/u, '')
    const prefixField = header.toString('utf8', 345, 345 + 155).replace(/\0.*$/u, '')
    const magic = header.toString('ascii', 257, 263)
    if (magic.startsWith('ustar') && prefixField.length > 0) name = `${prefixField}/${name}`
    const size = parseOctal(header.subarray(124, 136))
    offset += TAR_BLOCK_SIZE
    const data = buffer.subarray(offset, offset + size)
    if (type === 'L') {
      pendingLongName = data.toString('utf8').replace(/\0.*$/u, '')
    } else {
      const entryName = pendingLongName ?? name
      pendingLongName = undefined
      entries.push({ name: entryName, type, data })
    }
    offset += Math.ceil(size / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE
  }
  return entries
}

/**
 * zlib 失败 → 具名门错误。超上限与坏 gzip 是两件事,**分开诚实报错**(实测 zlib
 * 分别抛 ERR_BUFFER_TOO_LARGE / Z_DATA_ERROR)——否则运营者看到「不是合法 gzip」
 * 会去查传输,而真实原因是制品过大。
 */
function mapGunzipFailure(cause: unknown): MarketInstallGateError {
  if (marketIoErrno(cause) === 'ERR_BUFFER_TOO_LARGE') {
    return new MarketInstallGateError(
      `downloaded artifact decompresses beyond the ${String(MAX_TAR_DECOMPRESSED_BYTES)}-byte limit (possible gzip bomb)`,
      'market-invalid-tarball',
    )
  }
  return new MarketInstallGateError('downloaded artifact is not a valid gzip tarball', 'market-invalid-tarball')
}

/**
 * 从 .tgz 字节解出顶层 package.json 对象。找不到/坏 gzip/坏 JSON/含 `..` 段/
 * 多 depth-1 候选一律 MarketInstallGateError(不落盘判定的前置:预检不过即拒)。
 *
 * **manifest 选取规则**与 market-server 发布侧门(`tarball/parse.ts` walkEntries +
 * extractManifestFromTar)逐条一致,并由共享 fixture
 * `market-server/tests/fixtures/publish-gate-vectors.json` 两包各跑一遍钉住
 * (review D1/D5,修复轮 N-2):① 前导 `./` 先归一化(`tar -czf x.tgz .` 的常见
 * 形态);② 归一化名含 `..` 段即整包拒;③ PaxHeaders 元数据条目不算候选;
 * ④ depth-1 候选用同一条正则,恰好一个才可用,多于一个即「歧义 tarball」拒绝,
 * 不做任何 tie-break。
 *
 * 两侧**已知且有意**的差异(不属选取规则):本函数的 `..` 检查覆盖**全部**条目
 * 类型,发布侧只覆盖 file/directory(parse.ts:147 先做类型过滤)——安装侧更严,
 * 方向安全;发布侧另解析 pax `path=` 覆盖,本 walker 不解析(只认 GNU longname),
 * 故 pax 长名制品由发布侧先拒。
 */
export function readTarballPackageJson(tgzBytes: Buffer): Record<string, unknown> {
  let tar: Buffer
  try {
    // 评审 D6:带上限解压,gunzip 炸弹在此确定性失败而不是把主进程推向 OOM。
    tar = gunzipSync(tgzBytes, { maxOutputLength: MAX_TAR_DECOMPRESSED_BYTES })
  } catch (cause) {
    throw mapGunzipFailure(cause)
  }
  return manifestFromTarBytes(tar)
}

/**
 * 从**盘上暂存文件**流式读出顶层 package.json(第 53 条):安装链落盘后不再把压缩
 * 制品整包读回内存——`createReadStream` 逐块喂 `createGunzip`,解压产物按**同一
 * 上限**收进内存后交给**同一个** walker 尾巴(选取规则零漂移)。
 *
 * 上限判定必须手工计数:`maxOutputLength` 只被 zlib 的便利方法(`gunzipSync` 等)
 * 兑现,**流式 Transform 会照单全收**——实测 `createGunzip({ maxOutputLength: 100 })`
 * 对 1000 字节的 gzip 输出全部 1000 字节且不报错。发布侧 `tarball/parse.ts` 的流式
 * 路径同样手工计数(total > MAX_TAR_DECOMPRESSED_BYTES ⇒ ERR_BUFFER_TOO_LARGE 语义),
 * 故两侧上限语义一致;判超即以上限错误中止(不再继续灌数据)。
 *
 * 内存口径诚实说明(与发布侧 extractPackageManifestFromFile 同款措辞):压缩字节恒
 * 不整包驻留;**解压后的 tar** 会收成单个 Buffer(峰值 ≈ 解压上限 64 MiB,
 * `Buffer.concat` 期间瞬时 ≈ 2×)。上限之内不值得再做增量 walk。
 *
 * 错误口径:zlib/上限失败是**制品**判定,走具名门错误;读盘故障(我们的暂存文件)
 * 是**宿主** IO,走只带 errno 的 500(评审 P1:不得把宿主故障报成制品的过错,也不得
 * 把 profileDir 绝对路径回给渲染进程)。
 */
export async function readTarballPackageJsonFromFile(path: string): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let total = 0
  try {
    await pipeline(
      createReadStream(path),
      createGunzip(),
      new Writable({
        write: (chunk: Buffer, _encoding, callback) => {
          total += chunk.byteLength
          if (total > MAX_TAR_DECOMPRESSED_BYTES) {
            // 与发布侧 parse.ts 的流式路径同款:`ERR_BUFFER_TOO_LARGE` 语义的错误码
            // 让上限失败与坏 gzip 走进同一个具名映射(mapGunzipFailure)。
            callback(Object.assign(new Error('decompressed tarball exceeds the cap'), { code: 'ERR_BUFFER_TOO_LARGE' }))
            return
          }
          chunks.push(chunk)
          callback()
        },
      }),
    )
  } catch (cause) {
    const errno = marketIoErrno(cause)
    if (errno === 'ERR_BUFFER_TOO_LARGE' || errno.startsWith('Z_')) throw mapGunzipFailure(cause)
    throw new MarketFetchError(`failed to read the staged market artifact (${errno})`, 500, 'market-artifact-io')
  }
  return manifestFromTarBytes(Buffer.concat(chunks))
}

/** tar 字节 → 顶层 package.json(两条读取路径共用的 walker 尾巴)。 */
function manifestFromTarBytes(tar: Buffer): Record<string, unknown> {
  const entries = tarEntries(tar)
  let best: Buffer | undefined
  for (const entry of entries) {
    // ① 前导 `./` 归一化(N-2):与发布侧 parse.ts:149 同式。缺这一步时
    //    `./package/package.json` 在本侧算 3 段而被跳过 ⇒ 服务端 201 上架、
    //    每个用户安装时都吃 market-invalid-tarball(正是 D1 抱怨的倒置形态)。
    const name = entry.name.replace(/^\.\//u, '')
    // ② 路径穿越段:任何条目名(含目录,先于类型过滤)含 ".." 段即整包拒收(D1)。
    if (name.split('/').includes('..')) {
      throw new MarketInstallGateError(`tarball entry name contains a ".." segment: ${JSON.stringify(name)}`, 'market-invalid-tarball')
    }
    if (entry.type !== '0' && entry.type !== '\0') continue
    // ③ pax 元数据条目(node-tar/npm 惯例 PaxHeaders 路径段;有些工具以普通
    //    文件 typeflag 落盘)不算 manifest 候选,否则带 pax 元数据的合法 npm 包
    //    会被误判「歧义 tarball」(D1 round 2)。
    if (name.split('/').some((segment) => segment.startsWith('PaxHeaders'))) continue
    // ④ depth-1 候选正则与发布侧 parse.ts:161 逐字相同(N-2:原
    //    `segments.length === 2` 写法对 `package//package.json` 与尾斜杠形态
    //    判定与发布侧相反)。
    if (!/^[^/]+\/package\.json$/u.test(name)) continue
    if (best !== undefined) {
      throw new MarketInstallGateError('tarball is ambiguous: more than one depth-1 package.json entry; expected exactly one', 'market-invalid-tarball')
    }
    best = entry.data
  }
  if (best === undefined) {
    throw new MarketInstallGateError('tarball has no top-level package.json', 'market-invalid-tarball')
  }
  try {
    return JSON.parse(best.toString('utf8')) as Record<string, unknown>
  } catch {
    throw new MarketInstallGateError('tarball package.json is not valid JSON', 'market-invalid-tarball')
  }
}

// ---------------------------------------------------------------------------
// 零依赖与无脚本预检((c) 安装侧门,与 market-server 发布侧门同口径)
// ---------------------------------------------------------------------------

const LIFECYCLE_SCRIPTS = ['preinstall', 'install', 'postinstall', 'prepare'] as const

// 包身份正则:与 market-server/src/tarball/gate.ts 逐字一致(依赖方向守卫
// 禁止 import market-server 源;共享 fixture publish-gate-vectors.json 把两侧
// 判定钉死,任一侧漂移即红)。契约 package.name 为小写、latestVersion 上限 64。
const PACKAGE_NAME_PATTERN = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u
const PACKAGE_VERSION_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9.+-]{0,63}$/u

function nonEmptyRecord(value: unknown): value is Record<string, string> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.keys(value).length > 0
}

/**
 * 零依赖 + 无 lifecycle 安装脚本预检。fail-closed,点名违规项;
 * peerDependencies 豁免、bundleDependencies 允许、其余 scripts(build/test)允许。
 * 包身份(name/version)先做与发布侧门同口径的校验(review D4/D5)。
 */
export function precheckTarballManifest(manifest: Record<string, unknown>): void {
  if (typeof manifest.name !== 'string' || !PACKAGE_NAME_PATTERN.test(manifest.name)) {
    throw new MarketInstallGateError(
      `package.json "name" must be a lowercase npm package name, got ${JSON.stringify(manifest.name)}`,
      'invalid-package-identity',
    )
  }
  if (typeof manifest.version !== 'string' || !PACKAGE_VERSION_PATTERN.test(manifest.version)) {
    throw new MarketInstallGateError(
      `package.json "version" must be a non-empty filename-safe string of at most 64 characters, got ${JSON.stringify(manifest.version)}`,
      'invalid-package-identity',
    )
  }
  const violations: string[] = []
  if (nonEmptyRecord(manifest.dependencies)) {
    violations.push(`dependencies must be empty (zero-dependency market artifact), got: ${Object.keys(manifest.dependencies).join(', ')}`)
  }
  if (nonEmptyRecord(manifest.optionalDependencies)) {
    violations.push(`optionalDependencies must be empty (zero-dependency market artifact), got: ${Object.keys(manifest.optionalDependencies).join(', ')}`)
  }
  const scripts = typeof manifest.scripts === 'object' && manifest.scripts !== null && !Array.isArray(manifest.scripts)
    ? manifest.scripts as Record<string, unknown>
    : {}
  for (const lifecycle of LIFECYCLE_SCRIPTS) {
    if (typeof scripts[lifecycle] === 'string') violations.push(`scripts.${lifecycle} is not allowed in market artifacts`)
  }
  if (violations.length > 0) {
    throw new MarketInstallGateError(`market artifact gate rejected the tarball: ${violations.join('; ')}`)
  }
}

// ---------------------------------------------------------------------------
// 下载 + 校验 + 落制品(第 53 条:流式)
// ---------------------------------------------------------------------------

/**
 * 制品响应体上限(内网插件制品;防失控服务端)。裁定 **D-M6-25**:自 512 MiB 放宽到
 * **2 GiB**(与 update-server 的 1 GiB 安装器上限同量级,留余量)——流式改造后主进程
 * 内存峰值只与单个 chunk 有关,上限不再等于内存占用,故可放宽而不把安装链推向 OOM。
 */
export const MARKET_ARTIFACT_MAX_BYTES = 2 * 1024 * 1024 * 1024

/** 已验签清单条目的 sha256 形状(64 位小写 hex)。 */
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/u

export interface PreparedMarketArtifact {
  readonly artifactPath: string
  readonly sha256: string
  readonly size: number
}

/**
 * 生产暂存写流(默认实现):先**同步**建好暂存文件(0600)再进写流——失败清理紧跟
 * 在「文件已存在」之后,不与写流的异步 open 赛跑(否则清理可能先跑、文件后出现,
 * 留下残留)。暂存与制品同目录(`.market-artifacts/`)——rename 必须同文件系统,
 * 不能借道 tmpdir。
 */
function openStagingWriteStream(tmpPath: string): WriteStream {
  return createWriteStream(tmpPath, { fd: openSync(tmpPath, 'w', 0o600) })
}

/**
 * 中止暂存写流并删除暂存文件(所有失败路径的收尾)。**先等 'close'**(fd 释放)再删:
 * Windows 上删一个仍被打开的文件会 EPERM;监听在 destroy **之前**挂好,无竞态。
 */
async function abortArtifactWrite(stream: WriteStream, tmpPath: string): Promise<void> {
  if (!stream.closed) {
    const closed = once(stream, 'close').catch(() => { /* destroy 期的 'error' 不遮蔽原故障 */ })
    stream.destroy()
    await closed
  }
  discardMarketArtifactTemp(tmpPath)
}

/**
 * 暂存写故障的**唯一**归类点(评审 Important 1):宿主 IO 一律
 * `MarketFetchError(500, 'market-artifact-io')`,**只带 errno**(P1:fs 错误的 message
 * 含 profileDir 绝对路径,而具名错误会经 routes 原样转给渲染进程)。
 *
 * 为什么必须在这里归类:裸 fs 错误若逃到 `fetchStream`,`requestStream` 的兜底会把
 * 任何非 MarketFetchError 包装成 502 `market-unreachable` —— 磁盘满/IO 故障就会被
 * 讲成「内网市场不可达」,与网络毫无关系。
 */
function stagingIoError(fault: unknown): MarketFetchError {
  return new MarketFetchError(`failed to stage market artifact (${marketIoErrno(fault)})`, 500, 'market-artifact-io')
}

/**
 * 把一个 chunk 写进暂存流并施加背压(第 53 条)。兑现 = 本块已交给内核。
 *
 * **不能在写流已死时等 'drain'**(评审 Important 1):`destroy(err)` 之后 'error' 已经
 * 发过、`write()` 恒返回 false,且**不会再有 'drain'/'error'** —— 实测 destroy 之后
 * `once(ws,'drain')` 1.5 s 不落定。挂在那里,安装链只能靠 15 s 的 socket 静默超时
 * 脱身(白占 execute 的单飞互斥 15 s),还会把「磁盘满」讲成「timed out」。故等 drain
 * 之前先看**已置位的故障**(调用方给的 `writeFault`:含 Node 在 destroy 时同步置位的
 * `stream.errored`)与 `destroyed`;`write` 期间才发生的错误由 'error' 让本 await 拒绝
 * (调用方按同一 errno 口径归类)。
 */
async function writeStageChunk(stream: WriteStream, chunk: Buffer, faultOf: () => Error | undefined): Promise<void> {
  const before = faultOf()
  if (before !== undefined || stream.destroyed) throw stagingIoError(before)
  if (stream.write(chunk)) return
  const during = faultOf()
  if (during !== undefined || stream.destroyed) throw stagingIoError(during)
  await once(stream, 'drain')
}

/**
 * 下载 .tgz(第 53 条:**流式**,上限 MARKET_ARTIFACT_MAX_BYTES = 2 GiB)+ 边收边
 * 算 sha256 边写暂存文件(背压:写返回 false 即等 drain,内存峰值 O(chunk))+
 * 与已验签清单比对 + 零依赖无脚本预检 + 落制品。任何一步失败:暂存清理(不落盘)、
 * 不安装、抛具名错误。
 *
 * **被校验顶层制品字节 = 被安装字节**(解法 A):`hash.update` 与
 * `writeStream.write` 吃的是同一个 chunk 变量,随后只有 chmod + rename,绝不在校验后
 * 重新取字节。落盘命名/暂存/提交流程的唯一实现在 market/artifacts.ts(与本地安装
 * Task 6.2 共用),本函数只负责「把流写进那个暂存名」。
 */
export async function downloadAndStageArtifact(options: {
  readonly origin: string
  readonly file: MarketManifestFile
  readonly profileDir: string
  readonly http?: MarketHttpClient
  /**
   * **测试注入缝**(生产恒用默认实现 `openStagingWriteStream`):替换暂存写流的
   * 创建。存在的唯一理由:「下载到一半时写流报错」(ENOSPC/EIO)这类**宿主故障**
   * 无法在可移植的单测里真实制造(填满磁盘/tmpfs 都不可行),而它正是「宿主 IO
   * 不得被讲成市场不可达、且不得挂在等不到的 drain 上」的回归位点(评审
   * Important 1)。注入者自己负责按生产同款建好暂存文件(0600),否则清理断言
   * 失去意义。
   */
  readonly openStagingStream?: (tmpPath: string) => WriteStream
}): Promise<PreparedMarketArtifact> {
  // ① URL 同源钉扎(X1,第 51 条):跨源在**任何请求之前**就拒,fail-closed。
  const url = resolveSameOriginUrl(options.origin, options.file.tarballPath)
  const http = options.http ?? createMarketHttpClient()
  const name = options.file.name
  const version = options.file.version
  // 已验签清单条目的 sha256:它同时是暂存名与制品名的输入,形状先 fail-closed 钉死
  // (名字里的 sha12 与校验值同源;畸形值不得进入文件名,畸形清单也不可能匹配任何下载)。
  const signedSha256 = options.file.sha256.toLowerCase()
  if (!SHA256_HEX_PATTERN.test(signedSha256)) {
    throw new MarketFetchError(
      `插件文件校验失败,已拒绝安装:${name}@${version} 的已验签清单 sha256 不是 64 位 hex 摘要`,
      400,
      'market-sha256-mismatch',
    )
  }

  const artifactPath = marketArtifactPath(options.profileDir, name, version, signedSha256)
  const tmpPath = marketArtifactTempPath(artifactPath)
  const hash = createHash('sha256')
  // 先**同步**建好暂存文件(0600)再进写流:失败清理紧跟在「文件已存在」之后,不与写流
  // 的异步 open 赛跑(否则清理可能先跑、文件后出现,留下残留)。暂存与制品同目录
  // (`.market-artifacts/`)——rename 必须同文件系统,不能借道 tmpdir。
  let writeStream: WriteStream
  try {
    writeStream = (options.openStagingStream ?? openStagingWriteStream)(tmpPath)
  } catch (error) {
    discardMarketArtifactTemp(tmpPath)
    // 建不了暂存文件是宿主 IO:只回 errno(评审 P1),不把绝对路径回给渲染进程。
    throw new MarketFetchError(`failed to stage market artifact (${marketIoErrno(error)})`, 500, 'market-artifact-io')
  }
  // 写流故障的确定性观察点:'error' 监听必须有——否则未捕获 'error' 会掀翻主进程;
  // 且背压等 drain 时 once(stream,'drain') 会以同一错误拒绝(见 writeStageChunk)。
  let writeFailure: Error | undefined
  writeStream.on('error', (error: Error) => { writeFailure = error })
  // 写故障的**唯一**读取口径:'error' 事件记下的错误优先;其次 Node 在 `destroy()` 时
  // **同步**置位的 `stream.errored`('error' 事件要到下一个 tick 才发出,背压路径上
  // 可能还没到 —— 只认事件就会漏掉「故障已置位」这个状态,正是评审 Important 1 的
  // 挂死窗口)。
  const writeFault = (): Error | undefined => {
    const fault: Error | null = writeFailure ?? writeStream.errored
    return fault ?? undefined
  }

  let receivedBytes: number
  try {
    const received = await http.fetchStream(url, `artifact ${name}@${version}`, MARKET_ARTIFACT_MAX_BYTES, async (chunk) => {
      // 边收边算 sha256、边写暂存:被哈希的正是被写入的同一份字节(解法 A)。
      hash.update(chunk)
      try {
        await writeStageChunk(writeStream, chunk, writeFault)
      } catch (error) {
        // 写故障(含背压等待期间的 'error')是**宿主 IO**:在此归类成 500
        // `market-artifact-io` 并只回 errno。若放它原样上抛,requestStream 会包装成
        // 502 `market-unreachable` —— 一次磁盘满就会被讲成「内网市场不可达」。
        throw error instanceof MarketFetchError ? error : stagingIoError(writeFault() ?? error)
      }
    })
    receivedBytes = received.bytes
  } catch (error) {
    await abortArtifactWrite(writeStream, tmpPath)
    if (error instanceof MarketFetchError) throw error
    throw new MarketFetchError(
      `market artifact download failed: ${error instanceof Error ? error.message : String(error)}`,
      502,
    )
  }

  const sha256 = hash.digest('hex')
  if (sha256 !== signedSha256) {
    // sha256 不符:不落盘、不安装、诚实报错(传输损坏/路径 MITM 换包/清单不一致)。
    await abortArtifactWrite(writeStream, tmpPath)
    throw new MarketFetchError(
      `插件文件校验失败,已拒绝安装:${name}@${version} 下载所得 sha256=${sha256} 与已验签清单 ${options.file.sha256} 不符`,
      400,
      'market-sha256-mismatch',
    )
  }

  try {
    // 收尾:冲刷已排队的字节并等 fd 关闭(rename 前确保写流已彻底交还文件)。
    // 写故障(可能发生在最后一块之后、流已收完)同样在此被拦下,走 500 errno 口径。
    const pending = writeFault()
    if (pending !== undefined) throw pending
    const closed = once(writeStream, 'close').catch(() => { /* fd 关闭细节不覆盖 end 的判定 */ })
    await new Promise<void>((resolve, reject) => {
      writeStream.end((error?: Error | null) => { error ? reject(error) : resolve() })
    })
    await closed
    const late = writeFault()
    if (late !== undefined) throw late
  } catch (error) {
    await abortArtifactWrite(writeStream, tmpPath)
    // 只回 errno,不回 error.message(评审 P1:fs 错误的 message 含 profileDir 绝对
    // 路径,而本错误是具名类 ⇒ routes 会原样把 message 转给渲染进程)。
    throw new MarketFetchError(`failed to stage market artifact (${marketIoErrno(error)})`, 500, 'market-artifact-io')
  }

  try {
    // 零依赖 + 无脚本预检(落盘前;不过即拒,profile 零接触)。manifest 从**暂存
    // 文件**流式解压读出(第 53 条):压缩字节不整包读回内存。
    const manifest = await readTarballPackageJsonFromFile(tmpPath)
    precheckTarballManifest(manifest)
    // 身份一致性(review D4/D5 廉价半段):制品落盘与安装的身份以**已验签清单
    // 条目**为准(签名覆盖的就是它);tarball 自述 name/version 必须与之完全
    // 相等,不等即拒——绝不允许装出一个与清单身份不一致的在盘制品。
    if (manifest.name !== name || manifest.version !== version) {
      throw new MarketInstallGateError(
        `tarball self-declared identity ${JSON.stringify(`${String(manifest.name)}@${String(manifest.version)}`)} ` +
        `does not match the signed manifest entry ${JSON.stringify(`${name}@${version}`)}`,
        'invalid-package-identity',
      )
    }
  } catch (error) {
    discardMarketArtifactTemp(tmpPath)
    throw error
  }

  try {
    // 暂存 → 制品(唯一实现):0600 + rename 原子替换(同 sha 重复安装 = 等价重写)。
    commitMarketArtifact(tmpPath, artifactPath)
  } catch (error) {
    if (error instanceof MarketArtifactIoError) {
      throw new MarketFetchError(`failed to stage market artifact (${error.errno})`, 500, 'market-artifact-io')
    }
    throw error
  }
  return { artifactPath, sha256, size: receivedBytes }
}

// ---------------------------------------------------------------------------
// execute:下载 → 预检 → 制品 → addPlugin(offline) → confirmed restart
// ---------------------------------------------------------------------------

export interface MarketInstallContext {
  readonly profileDir: string
  readonly logger: (message: string) => void
  readonly pnpm: Pick<DesktopPnpm, 'runPlugin'>
  readonly runtime: ConfirmedRestartRuntime
}

/**
 * 市场远程安装执行(解法 A):被校验顶层制品字节 = 被安装字节。
 * 只把**本地已校验制品路径**喂给 addPlugin(assertNotRemote 放行本地文件、只拒
 * http(s));offline ⇒ pnpm 恒带 `--offline --ignore-scripts`(flag 构造只在
 * addPlugin 内;不经 runExternalMarketPluginInstall/--registry)。
 * 取消/失败语义继承 addPlugin(§14 第 33 条诚实 message;无自动回滚,§14 第 25 条
 * bad bundle 由启动恢复窗口承接——routeDesktopStartupFailure/openStartupRecoveryWindow)。
 */
export async function executeMarketInstall(
  ctx: MarketInstallContext,
  prepared: PreparedMarketArtifact,
): Promise<PluginMutationResult> {
  return addPlugin({
    profileDir: ctx.profileDir,
    logger: ctx.logger,
    desktopPnpm: ctx.pnpm,
    requestRestart: () => ctx.runtime.requestConfirmedRestart(),
  }, prepared.artifactPath, { offline: true })
}
