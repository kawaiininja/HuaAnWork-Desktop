/**
 * huaanwork-market 远程安装执行(M5 Task 5 Step 3,解法 A)。
 *
 * 安装链(〈安装入口边界〉,被校验顶层制品字节 = 被安装字节):
 * ① 从**已验签清单**取 `name@version` 的 tarballPath + sha256;URL 经
 *    catalog-client.resolveSameOriginUrl 同源钉扎(X1,fail-closed)。
 * ② 自有 HTTP client 拉取 .tgz,**边下边算 sha256**(流式逐 chunk 更新 hash)。
 * ③ 与清单 sha256 比对:不符即拒——temp 清理,**不落盘、不安装、诚实报错**。
 * ④ **零依赖与无脚本预检**(round4 裁定 (c),安装侧门,与发布侧门同口径):
 *    dependencies/optionalDependencies 非空即拒;scripts 含 preinstall/install/
 *    postinstall/prepare 亦拒(peerDependencies 豁免;bundleDependencies 允许;
 *    其余非 lifecycle scripts 允许)。
 * ⑤ 通过才落制品 `<profileDir>/.market-artifacts/<name>-<version>-<sha256前12>.tgz`
 *    (目录 0700、文件 0600、**不删**——file: 引用共存亡,N1);同 sha 重复安装覆盖写。
 * ⑥ `addPlugin(制品路径, {offline: true})` → pnpm 恒带 `--offline --ignore-scripts`
 *    (两道补强;flag 构造只在 addPlugin 内;不经 runExternalMarketPluginInstall/--registry)。
 *
 * tarball 解包:node:zlib gunzip + ustar 512B 头 walk(零依赖,与 market-server
 * 发布侧门同形态;支持 ustar prefix 拼接与 GNU longname 'L';depth-1
 * package.json 恰好一个才可用,含 `..` 段或多候选一律拒——与发布侧门同口径)。
 */

import { createHash } from 'node:crypto'
import { chmodSync, existsSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import type { DesktopPnpm } from '../../pnpm.ts'
import type { ConfirmedRestartRuntime } from '../../host-runtime-bridge.ts'
import { addPlugin, type PluginMutationResult } from '../plugins-host.ts'
import { marketArtifactName, ensureMarketArtifactsDir } from './artifacts.ts'
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
 * 从 .tgz 字节解出顶层 package.json 对象。找不到/坏 gzip/坏 JSON/含 `..` 段/
 * 多 depth-1 候选一律 MarketInstallGateError(不落盘判定的前置:预检不过即拒)。
 * 选择规则与 market-server 发布侧门逐条一致(review D1):depth-1 候选恰好一个
 * 才可用,多于一个即「歧义 tarball」拒绝,不做任何 tie-break。
 */
export function readTarballPackageJson(tgzBytes: Buffer): Record<string, unknown> {
  let tar: Buffer
  try {
    tar = gunzipSync(tgzBytes)
  } catch {
    throw new MarketInstallGateError('downloaded artifact is not a valid gzip tarball', 'market-invalid-tarball')
  }
  const entries = tarEntries(tar)
  let best: Buffer | undefined
  for (const entry of entries) {
    if (entry.type !== '0' && entry.type !== '\0') continue
    // 路径穿越段:任何文件条目名含 ".." 段即整包拒收(与发布侧门同口径)。
    if (entry.name.split('/').includes('..')) {
      throw new MarketInstallGateError(`tarball entry name contains a ".." segment: ${JSON.stringify(entry.name)}`, 'market-invalid-tarball')
    }
    const segments = entry.name.split('/').filter((segment) => segment.length > 0)
    if (segments.length !== 2 || segments[1] !== 'package.json') continue
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
// 下载 + 校验 + 落制品
// ---------------------------------------------------------------------------

/** 制品响应体上限(内网插件制品;防失控服务端)。 */
export const MARKET_ARTIFACT_MAX_BYTES = 512 * 1024 * 1024

export interface PreparedMarketArtifact {
  readonly artifactPath: string
  readonly sha256: string
  readonly size: number
}

/**
 * 流式下载 .tgz + 边下边算 sha256 + 比对清单 + 零依赖无脚本预检 + 落制品。
 * 任何一步失败:temp 清理(不落盘)、不安装、抛具名错误。
 */
export async function downloadAndStageArtifact(options: {
  readonly origin: string
  readonly file: MarketManifestFile
  readonly profileDir: string
  readonly http?: MarketHttpClient
}): Promise<PreparedMarketArtifact> {
  const url = resolveSameOriginUrl(options.origin, options.file.tarballPath)
  const http = options.http ?? createMarketHttpClient()

  let bytes: Buffer
  try {
    bytes = await http.fetchBuffer(url, `artifact ${options.file.name}@${options.file.version}`, MARKET_ARTIFACT_MAX_BYTES)
  } catch (error) {
    if (error instanceof MarketFetchError) throw error
    throw new MarketFetchError(`market artifact download failed: ${error instanceof Error ? error.message : String(error)}`, 502)
  }

  // 边下边算(hash 在 chunk 上更新;默认 client 一次收齐,注入式流 client 逐 chunk)。
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  if (sha256 !== options.file.sha256.toLowerCase()) {
    // sha256 不符:不落盘、不安装、诚实报错(传输损坏/路径 MITM 换包/清单不一致)。
    throw new MarketFetchError(
      `插件文件校验失败,已拒绝安装:${options.file.name}@${options.file.version} 下载所得 sha256=${sha256} 与已验签清单 ${options.file.sha256} 不符`,
      400,
      'market-sha256-mismatch',
    )
  }

  // 零依赖 + 无脚本预检(落盘前;不过即拒,profile 零接触)。
  const manifest = readTarballPackageJson(bytes)
  precheckTarballManifest(manifest)
  // 身份一致性(review D4/D5 廉价半段):制品落盘与安装的身份以**已验签清单
  // 条目**为准(签名覆盖的就是它);tarball 自述 name/version 必须与之完全
  // 相等,不等即拒——绝不允许装出一个与清单身份不一致的在盘制品。
  if (manifest.name !== options.file.name || manifest.version !== options.file.version) {
    throw new MarketInstallGateError(
      `tarball self-declared identity ${JSON.stringify(`${String(manifest.name)}@${String(manifest.version)}`)} ` +
      `does not match the signed manifest entry ${JSON.stringify(`${options.file.name}@${options.file.version}`)}`,
      'invalid-package-identity',
    )
  }
  const name = options.file.name
  const version = options.file.version

  const artifactsDir = ensureMarketArtifactsDir(options.profileDir)
  const artifactPath = `${artifactsDir}/${marketArtifactName(name, version, sha256)}`
  // 同 sha 重复安装:已存在则原地覆盖写(保 inode,不删重建——file: 引用不受影响);
  // 不存在则 temp + rename 原子落盘。
  const tmpPath = `${artifactPath}.tmp-${process.pid}`
  try {
    if (existsSync(artifactPath)) {
      writeFileSync(artifactPath, bytes)
    } else {
      writeFileSync(tmpPath, bytes, { mode: 0o600 })
      chmodSync(tmpPath, 0o600)
      renameSync(tmpPath, artifactPath)
    }
    chmodSync(artifactPath, 0o600)
  } catch (error) {
    try { rmSync(tmpPath, { force: true }) } catch { /* best-effort */ }
    throw new MarketFetchError(`failed to stage market artifact: ${error instanceof Error ? error.message : String(error)}`, 500, 'market-artifact-io')
  }
  return { artifactPath, sha256, size: bytes.byteLength }
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
