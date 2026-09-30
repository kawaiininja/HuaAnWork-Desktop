/**
 * huaanwork-market 制品目录助手(M5 Task 5)。
 *
 * 制品布局(round5 N1,〈安装入口边界〉④):
 * `<profileDir>/.market-artifacts/<name>-<version>-<sha256前12>.tgz`
 * ——目录 0700、文件 0600、**安装后不删除**(pnpm add 把 `file:<绝对路径>` 写进
 * profile package.json,制品与引用共存亡;删制品 ⇒ 任何后续 pnpm 操作 ENOENT,
 * round5 实验 C 实证)。GC 规则:profile package.json 不再含指向制品的 `file:`
 * 引用时才可删(removePlugin 成功后清对应制品;启动时惰性清扫孤儿;
 * 评审 D9 起判据扩为「当前 profile **且所有 checkpoint slot** 均无引用,
 * restoreSlot 会重新引入旧引用)。
 *
 * 本模块只放纯助手(无 cordis / 无 plugins-host 依赖),供 install.ts(安装)、
 * routes/index(惰性清扫)与 plugins-host(卸载 GC、Task 6.2 起的本地安装落盘)共用——
 * 避免 install.ts ⇄ plugins-host.ts 循环依赖。
 */

import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  PROFILE_CHECKPOINT_USER_DATA_DIR_ENV,
  collectDesktopProfileCheckpointFileReferences,
} from '../../profile-checkpoint.ts'

/** 制品目录名(profileDir 下,0700)。 */
export const MARKET_ARTIFACTS_DIR_NAME = '.market-artifacts'

/** 计划命名:`<name>-<version>-<sha256前12>.tgz`。 */
export function marketArtifactName(name: string, version: string, sha256hex: string): string {
  return `${safeArtifactName(name)}-${version}-${sha256hex.slice(0, 12)}.tgz`
}

/**
 * 制品版本面(命名边界的**唯一**字面量):数字起头、点分 1–3 段 + 可选
 * prerelease/build 后缀。GC 候选正则与本地安装的合法性判据共用它——两份实现
 * 会让「什么版本能落盘」与「什么版本能回收」漂移(spec §14 第 42/49 条)。
 */
const ARTIFACT_VERSION_LITERAL = '\\d+(?:\\.\\d+){0,2}(?:[-+][0-9A-Za-z.-]+)?'
const ARTIFACT_VERSION_PATTERN = new RegExp(`^${ARTIFACT_VERSION_LITERAL}$`, 'u')

/**
 * 版本号是否落在制品命名边界内(Task 6.2 的本地源合法性判据):点分 1–3 段
 * 数字 + 可选 `-`/`+` 后缀(`1.0`、`1.0.0`、`1.0.0-beta.1` 合法;`1.0.0.1`
 * 不合法)。本地源若落成 `1.0.0.1` 这类名字,`gcRemovedPackageArtifacts` 的
 * 候选正则永不命中 ⇒ 卸载时制品漏删(只剩启动孤儿清扫兜底)。故本地安装**拒绝**
 * 这类源并诚实报错,**不放宽 GC 正则**。
 */
export function isMarketArtifactVersion(version: string): boolean {
  return ARTIFACT_VERSION_PATTERN.test(version)
}

/** scoped 名(如 `@huaanwork/sample`)落盘前净化(与 market-server store 同口径)。 */
export function safeArtifactName(name: string): string {
  return name.replace(/^@/, '').replace(/[\\/]/g, '-')
}

export function marketArtifactsDir(profileDir: string): string {
  return join(profileDir, MARKET_ARTIFACTS_DIR_NAME)
}

/**
 * 确保制品目录存在且为 0700(评审 D7):chmod **恒执行**——mkdir 的 mode 受
 * umask 影响、且「先有 0755 目录再补权限」的旧路径要求 chmod 兜底;catalog
 * 读(saveMaxRevision)先于安装到达是生产正常时序,权限位不得依赖首次到达者。
 *
 * chmod 失败(EPERM/EROFS/非属主)**只忽略、不抛**(修复轮 N-9):权限收紧是
 * best-effort 加固——目录位只影响同机其他用户能否**列举**制品名,制品文件本身
 * 恒 0600,字节不因此泄露;而本函数也在 catalog **读**路径上(saveMaxRevision),
 * 让它抛会把「读目录」变成 400 且经 toRouteError 回显 profileDir 绝对路径。
 * mkdir 失败仍然抛(那是真故障:后续落制品必失败,早失败更诚实)。
 */
export function ensureMarketArtifactsDir(profileDir: string): string {
  const dir = marketArtifactsDir(profileDir)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
  }
  try {
    chmodSync(dir, 0o700)
  } catch {
    // best-effort:见上方注释。
  }
  return dir
}

/**
 * 制品落盘失败(IO)。message **只带 errno、不带绝对路径** —— 与 install.ts 的
 * `market-artifact-io` 同口径(评审 P1:fs 错误的 message 含 profileDir 绝对路径,
 * 而具名错误会经 routes 原样回渲染进程)。映射成哪个 HTTP 状态由消费方决定:
 * plugins-host 映 500 plugin-error(本地安装落盘失败是**宿主**故障)。
 */
export class MarketArtifactIoError extends Error {
  readonly errno: string

  constructor(errno: string) {
    super(`failed to stage the market artifact (${errno})`)
    this.name = 'MarketArtifactIoError'
    this.errno = errno
  }
}

/**
 * 把**已在手上的字节**落成制品:`<profileDir>/.market-artifacts/<name>-<version>-
 * <sha256前12>.tgz`(目录 0700、文件 0600;temp + rename 原子落盘,同 sha 重复落盘
 * 原地覆盖写保 inode——`file:` 引用不受影响)。
 *
 * 本地安装(Task 6.2,裁定 R-2)落的就是**同一个**命名与布局函数 ⇒ 本地制品一落位
 * 就与市场制品同受「当前 profile 且所有 checkpoint slot 均无引用才可删」的保留/GC
 * 判据(spec §14 第 42/48/50 条)。市场路径(`executeMarketInstall`)传入的制品已在
 * 本目录内,addPlugin 侧直通不再重新落盘(修复轮 1:否则二次落盘还会把发布侧门的
 * 宽版本面喂给本地命名边界)。
 *
 * 名字里的 sha12 由**同一份字节**算出(不另行传参——两处各算一次就多一个漂移面)。
 * 落盘失败抛 `MarketArtifactIoError`(只带 errno,不带绝对路径)。
 */
export function stageMarketArtifact(
  profileDir: string,
  name: string,
  version: string,
  bytes: Uint8Array,
): { artifactPath: string; sha256: string } {
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const artifactsDir = ensureMarketArtifactsDir(profileDir)
  const artifactPath = join(artifactsDir, marketArtifactName(name, version, sha256))
  // 与 market/install.ts:285-308 同协议(逐行双生:同 existsSync 原地覆盖写分支、同
  // `${artifactPath}.tmp-${process.pid}` 暂存名、同 0600、同 errno 提取)。复制是
  // 控制方把 install.ts 保留给 Task 6.3 的边界产物,不是自由选择;Task 6.3 收敛为
  // 单实现之前,两侧任一改动必须同步(否则「落盘协议」与「安装侧错误口径」漂移)。
  const tmpPath = `${artifactPath}.tmp-${String(process.pid)}`
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
    const errno = typeof (error as { code?: unknown } | null)?.code === 'string'
      ? (error as { code: string }).code
      : 'unknown'
    throw new MarketArtifactIoError(errno)
  }
  return { artifactPath, sha256 }
}

/** 读 profile package.json 的 dependencies 原样(缺文件/缺键返回 {})。 */
export function readProfileDependencies(profileDir: string): Record<string, string> {
  const path = join(profileDir, 'package.json')
  if (!existsSync(path)) return {}
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as { dependencies?: Record<string, string> }
  return manifest.dependencies ?? {}
}

/**
 * profile package.json 中所有 `file:` 引用,解析为绝对路径。
 *
 * P17:`dependencies` 与 `devDependencies` **都**扫——与 checkpoint 侧
 * `collectDesktopProfileCheckpointFileReferences` 同口径。只扫 dependencies 时,
 * 一旦 pnpm 落点变化(如 `pnpm add -D` 或未来版本行为),活 profile 侧会漏掉
 * 引用并删掉在役制品,即评审 D9 的失效模式经此路径依然可达(D9 的修复只让
 * checkpoint 半边变严,活 profile 半边没跟上)。
 *
 * 坏 JSON **抛出**而不回落空集:回落 = 「无引用」= 删光制品,方向不安全。
 * 与 readProfileDependencies 的既有行为一致。
 */
function collectProfileFileReferences(profileDir: string): string[] {
  const path = join(profileDir, 'package.json')
  if (!existsSync(path)) return []
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as {
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
  }
  const references: string[] = []
  for (const group of [manifest.dependencies, manifest.devDependencies]) {
    if (group === undefined || group === null) continue
    for (const reference of Object.values(group)) {
      if (typeof reference !== 'string' || !reference.startsWith('file:')) continue
      references.push(resolve(reference.slice('file:'.length)))
    }
  }
  return references
}

/**
 * profile 的 `file:` 引用是否都实际存在(N1 回归门的核心断言)。P17:与保留判据
 * 共用同一 collector(旧实现不 resolve、且只看 dependencies,与
 * referencedArtifactPaths 口径分裂)。注意**无引用时空集恒真**——消费方须自行
 * 保证「确实存在引用」再据此下结论(market-install.spec.ts 有一条专测钉住
 * 「引用缺失时返回 false」,防该断言退化为空真)。
 */
export function profileFileReferencesExist(profileDir: string): boolean {
  return collectProfileFileReferences(profileDir).every((path) => existsSync(path))
}

function referencedArtifactPaths(profileDir: string): Set<string> {
  return new Set(collectProfileFileReferences(profileDir))
}

/**
 * 健康检查点 slot 的 package.json 仍 `file:` 引用的制品路径(评审 D9:
 * restoreSlot 会把**旧** package.json 写回 profile——若其中引用的制品已被 GC,
 * 恢复后的物化依赖 pnpm 确定性 ENOENT,而计划钦定的四步 e2e 结构上抓不到
 * restore 路径)。经 main 进程注入的 env 定位 checkpoint profileRoot
 * (profileIdentity = sha256(profileDir),与上方同一 resolve 口径);env 缺席
 * (非 Electron 宿主/单测)= 空集,即修复前行为。
 */
function checkpointReferencedArtifactPaths(profileDir: string, logger: (message: string) => void): Set<string> {
  const userDataDir = process.env[PROFILE_CHECKPOINT_USER_DATA_DIR_ENV]
  if (userDataDir === undefined || userDataDir === '') return new Set()
  return collectDesktopProfileCheckpointFileReferences(userDataDir, profileDir, logger)
}

/** 当前 profile 与所有 checkpoint slot 合计的保留判据(D9:两者都不得引用才可删)。 */
function retentionReferencedArtifactPaths(profileDir: string, logger: (message: string) => void): Set<string> {
  const referenced = referencedArtifactPaths(profileDir)
  for (const path of checkpointReferencedArtifactPaths(profileDir, logger)) referenced.add(path)
  return referenced
}

/**
 * removePlugin 成功后的制品 GC:删除该包**精确制品名**的全部制品
 * (同一包多版本各一份,卸载即清该包全部制品——其 `file:` 引用已被 pnpm 移除)。
 *
 * **边界纪律(N1,评审 round 1 修复)**:不得按裸前缀 `<safeName>-*` 匹配——
 * `@x/plugin-a` 的 safeName `x-plugin-a` 是 `@x/plugin-a-extra` 制品名
 * `x-plugin-a-extra-<version>-<sha12>.tgz` 的前缀,裸前缀匹配会删掉仍在装的
 * 相邻包的制品 ⇒ 悬空 `file:` 引用 ⇒ 后续任何 pnpm 操作 ENOENT(实验 C)。
 * 故候选必须同时满足:① 严格结构 `<safeName>-<version>-<sha12>.tgz`
 * (版本以数字起头、点分 1–3 段 + 可选 prerelease/build 连字符/加号后缀——
 * 发布侧门(gate.ts)只要求 filename-safe 版本,`1.0` 之类两段版合法可发布,
 * 故 GC 不得限死三段 semver;`extra-1.0.0` 之类的残余不可能伪造成版本);
 * ② **该制品当前无 `file:` 引用指向**(当前 profile 与所有 checkpoint slot
 * 合计,见 retentionReferencedArtifactPaths;双保险:即便命名边界被
 * 未来命名规则突破,有引用者永不删)。漏删(伪阴性)无害——启动惰性清扫兜底。
 * best-effort:任何失败只记日志,绝不阻断卸载;不存在的目录直接返回。
 */
export function gcRemovedPackageArtifacts(profileDir: string, packageName: string, logger: (message: string) => void): void {
  const dir = marketArtifactsDir(profileDir)
  if (!existsSync(dir)) return
  const escaped = safeArtifactName(packageName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // 版本:数字起头、点分 1–3 段(对齐 gate.ts 的 filename-safe 版本面,`1.0` 可 GC)
  // + prerelease/build(连字符/加号后缀);sha12 恰 12 位小写 hex。版本面与本地
  // 安装的 `isMarketArtifactVersion` 共用同一字面量(见该函数注释)。
  const exactName = new RegExp(`^${escaped}-${ARTIFACT_VERSION_LITERAL}-([0-9a-f]{12})\\.tgz$`, 'u')
  const referenced = retentionReferencedArtifactPaths(profileDir, logger)
  for (const entry of readdirSync(dir)) {
    if (!exactName.test(entry)) continue
    const path = join(dir, entry)
    if (referenced.has(resolve(path))) {
      // 双保险命中:命名像该包的制品仍被 profile 引用(边界外情形)——保留。
      logger(`huaanwork-market: kept referenced artifact ${entry} during uninstall of ${packageName}`)
      continue
    }
    try {
      rmSync(path)
      logger(`huaanwork-market: removed artifact ${entry} after uninstall of ${packageName}`)
    } catch (error) {
      logger(`huaanwork-market: failed to remove artifact ${entry}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

/**
 * 启动时惰性清扫:只删**当前 profile 与所有 checkpoint slot 均无 `file:` 引用
 * 指向**的孤儿制品(N1 + 评审 D9:restoreSlot 会重新引入旧引用,有引用者删了必坏)。
 * best-effort;返回清扫掉的文件名(便于测试断言与日志)。
 */
export function sweepOrphanMarketArtifacts(profileDir: string, logger: (message: string) => void): string[] {
  const dir = marketArtifactsDir(profileDir)
  if (!existsSync(dir)) return []
  const referenced = retentionReferencedArtifactPaths(profileDir, logger)
  const removed: string[] = []
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith('.tgz')) continue
    const path = join(dir, entry)
    if (referenced.has(resolve(path))) continue
    try {
      if (!statSync(path).isFile()) continue
      rmSync(path)
      removed.push(entry)
      logger(`huaanwork-market: swept orphan market artifact ${entry}`)
    } catch (error) {
      logger(`huaanwork-market: failed to sweep artifact ${entry}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return removed
}
