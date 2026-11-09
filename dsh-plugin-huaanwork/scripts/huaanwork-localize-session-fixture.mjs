// 把整树复制进临时 DSH_HOME 的真实会话日志改写为「临时实例原生」会话：
// 新 id 携带临时 workspace 的稳定前缀（huaanwork-host/session-id.ts 同算法），
// header cwd 指向临时铸造根（workspace-state.ts 的 neutralSessionRootPath 同算法），
// 物理路径与 header 同源派生（上游 session-persistence-jsonl 的 projectKey/encodeSegment 同算法，
// 其 assertStoredIdentity 强制两者一致）。事件行逐字保留。
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

function parseArgs(argv) {
  const options = { home: undefined, state: undefined, src: undefined, suffix: undefined, zstd: '/opt/anaconda3/bin/zstd' }
  for (const arg of argv) {
    if (arg.startsWith('--home=')) options.home = arg.slice(7)
    else if (arg.startsWith('--state=')) options.state = arg.slice(8)
    else if (arg.startsWith('--src=')) options.src = arg.slice(6)
    else if (arg.startsWith('--suffix=')) options.suffix = arg.slice(9)
    else if (arg.startsWith('--zstd=')) options.zstd = arg.slice(7)
    else throw new Error(`unknown argument: ${arg}`)
  }
  for (const key of ['home', 'state', 'src', 'suffix']) {
    if (typeof options[key] !== 'string' || options[key].length === 0) throw new Error(`--${key} required`)
  }
  // --suffix 直接拼进 sessionId 与铸造根目录名：路径分隔符或 `..` 会让 mintedRoot 逃出临时 profile
  // （原守卫只拒绝精确的真实 home 路径，挡不住 `../..` 这类后缀穿越），因此只接受保守字符集。
  if (!/^[A-Za-z0-9._-]+$/.test(options.suffix) || options.suffix === '.' || options.suffix === '..') {
    throw new Error('--suffix must match ^[A-Za-z0-9._-]+$ and must not be "." or ".."')
  }
  return options
}

/** 与上游 projectKey 同形：分隔符（/ 与反斜杠与 :）折叠为 -、安全字符保留、其余 ~XXXX 大写十六进制，前导 - 去除后包 --…--。 */
function projectKey(cwd) {
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += '~' + code.toString(16).toUpperCase().padStart(4, '0')
      separatorRun = false
    }
  }
  const slug = readable.replace(/^-+/, '') || 'root'
  return `--${slug.slice(0, 251)}--`
}

/** 与上游 encodeSegment 同形：安全字符保留，其余（含 ~）转 ~XXXX；`.`/`..` 全转义防穿越。 */
function encodeSegment(raw) {
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch
    else out += '~' + code.toString(16).toUpperCase().padStart(4, '0')
  }
  return out
}

/** realpath 解析失败（路径不存在或悬空链接）时回落 resolve；守卫比较两端同用本函数，误判方向只会更严。 */
function canonical(path) {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

const options = parseArgs(process.argv.slice(2))
// 字符串比较挡不住软链或不同拼法的同一真实 home（如 /var → /private/var）；两端都先 realpath。
const realHome = process.env.HOME === undefined ? undefined : canonical(join(process.env.HOME, '.huaanwork'))
if (realHome !== undefined && canonical(options.home) === realHome) {
  throw new Error('--home points at the real ~/.huaanwork; refusing to write into the production home')
}
const state = JSON.parse(readFileSync(options.state, 'utf8'))
if (typeof state.active !== 'string' || state.active.length === 0) throw new Error('state.json has no active profile')
// active 直接作为 profiles/ 下的路径段拼进 profileDir：与 --suffix 同一保守字符集，拒绝 `.`/`..` 与分隔符。
if (!/^[A-Za-z0-9._-]+$/.test(state.active) || state.active === '.' || state.active === '..') {
  throw new Error('state.json active profile must match ^[A-Za-z0-9._-]+$ and must not be "." or ".."')
}
const profileDir = resolve(join(options.home, 'profiles', state.active))
const workspaceRoot = resolve(join(profileDir, 'workspace'))
const stable = `huaanwork-${createHash('sha256').update(workspaceRoot).digest('hex').slice(0, 16)}`
const sessionId = `${stable}-${options.suffix}`
const mintedRoot = join(profileDir, 'workspace-sessions', sessionId)

const sourceText = (() => {
  const dec = spawnSync(options.zstd, ['-dc', options.src], { maxBuffer: 64 * 1024 * 1024 })
  if (dec.error !== undefined || dec.status !== 0) throw new Error(`zstd -dc failed: ${String(dec.stderr)}`)
  return dec.stdout.toString('utf8')
})()
const firstNewline = sourceText.indexOf('\n')
if (firstNewline < 0) throw new Error('fixture log has no header line')
const header = JSON.parse(sourceText.slice(0, firstNewline))
if (header.type !== 'session' || typeof header.version !== 'number') throw new Error('fixture header is not a session header')
header.id = sessionId
header.cwd = mintedRoot
const rewritten = `${JSON.stringify(header)}${sourceText.slice(firstNewline)}`

const storageDir = join(options.home, 'sessions', projectKey(mintedRoot), encodeSegment(sessionId))
const dst = join(storageDir, 'session.v4.jsonl.zstd')
mkdirSync(storageDir, { recursive: true })
mkdirSync(mintedRoot, { recursive: true })
const staging = `${dst}.staging`

// 上游读取器（session-persistence-jsonl 的 assertZstdHeaderFrame）要求首个 zstd 帧
// 独立可解且恰为一行 header，后续帧各自以行边界结束；整文件单帧会被判为 corrupt。
const headerLine = `${JSON.stringify(header)}\n`
const bodyText = sourceText.slice(firstNewline + 1)
function compressFrame(source) {
  const plain = `${staging}.plain`
  const frame = `${staging}.frame`
  writeFileSync(plain, source)
  const compressed = spawnSync(options.zstd, ['-f', '-q', plain, '-o', frame])
  if (compressed.error !== undefined || compressed.status !== 0) {
    throw new Error(`zstd compress failed: ${String(compressed.stderr)}`)
  }
  const bytes = readFileSync(frame)
  rmSync(plain, { force: true })
  rmSync(frame, { force: true })
  return bytes
}
const headerFrame = compressFrame(headerLine)
const bodyFrame = compressFrame(bodyText)
writeFileSync(staging, Buffer.concat([headerFrame, bodyFrame]))
renameSync(staging, dst)

// 回读校验：行数一致、header 为改写值、事件行逐字不变。
const verifyText = (() => {
  const dec = spawnSync(options.zstd, ['-dc', dst], { maxBuffer: 64 * 1024 * 1024 })
  if (dec.error !== undefined || dec.status !== 0) throw new Error(`zstd -dc verify failed: ${String(dec.stderr)}`)
  return dec.stdout.toString('utf8')
})()
const sourceLines = sourceText.split('\n').filter(Boolean)
const verifyLines = verifyText.split('\n').filter(Boolean)
if (verifyLines.length !== sourceLines.length) throw new Error('line count changed')
const verifyHeader = JSON.parse(verifyLines[0] ?? 'null')
if (verifyHeader?.id !== sessionId || verifyHeader?.cwd !== mintedRoot) throw new Error('header rewrite lost')
for (let i = 1; i < verifyLines.length; i++) {
  if (verifyLines[i] !== sourceLines[i]) throw new Error(`event line ${i} changed`)
}
console.log(JSON.stringify({ sessionId, storagePath: dst, mintedRoot, eventLines: sourceLines.length - 1 }))
