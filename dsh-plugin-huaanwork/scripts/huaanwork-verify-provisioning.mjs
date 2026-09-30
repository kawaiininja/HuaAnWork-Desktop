#!/usr/bin/env node
/**
 * 发行 provisioning 守卫(M6 Task 4.8;裁定 D-M6-18:R2 供真实值、R1 在发行分支钉入)。
 *
 * 发行命令(root `dist:mac:huaanwork` / `dist:win:huaanwork` / `dist:win-portable:huaanwork`
 * 的前置,以及 `.github/workflows/release.yml` 两个 job 的 fail-fast 步骤)在打包前跑本脚本:
 * **未完成 provisioning 的构建不产出制品** —— 而不是产出一个市场面恒拒的包让用户去发现。
 *
 * 三项输入(源码文本,非 import:本脚本要在没有 yarn install、没有 TS 运行时的最小环境里可跑):
 *   PINS_AT_RELEASE.current            dsh-plugin-huaanwork/src/huaanwork-host/market/config.ts
 *                                       生产验签公钥(raw 32 字节小写 hex)+ 其 sha256 指纹(keyId)
 *   HUAANWORK_MARKET_DEFAULT_ORIGIN    同上:真实内网市场 origin
 *   HUAANWORK_UPDATE_DEFAULT_ORIGIN    dsh-plugin-huaanwork/src/update-checker.ts:真实内网更新 origin
 *
 * 判定:空钉扎(keyId 或公钥缺任一)或任一 origin 仍含 `.example` ⇒ 非零退出并逐项列出缺什么;
 * keyId != sha256(公钥原始字节) ⇒ 同样拒绝(人工钉入最可能的错误是抄错指纹)。
 * 全部就绪 ⇒ 逐项打印 sha256 指纹,供 R1 与 R2 经第二信道带外核对。
 *
 * 本脚本不生成密钥、不猜测地址(裁定 D-M6-18),也不读写网络。
 *
 * 用法:
 *   node dsh-plugin-huaanwork/scripts/huaanwork-verify-provisioning.mjs [--root <dir>]
 *
 * `--root` 只用于测试/演练时指向 fixture 仓;发行命令与 CI 都不传它(默认 = 本仓库根)。
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const CONFIG_SOURCE = 'dsh-plugin-huaanwork/src/huaanwork-host/market/config.ts'
const UPDATE_SOURCE = 'dsh-plugin-huaanwork/src/update-checker.ts'
const PINNED_KEY_PATTERN = /^[0-9a-f]{64}$/u

const USAGE = `usage: node dsh-plugin-huaanwork/scripts/huaanwork-verify-provisioning.mjs [--root <dir>]

Verifies that this build carries the release-provisioned market trust anchor
(public key + its sha256 fingerprint) and both real intranet origins.
Exit code 0 = provisioned; 1 = unprovisioned (refuses to build a release);
2 = usage error.`

function parseArgs(argv) {
  const args = { root: DEFAULT_ROOT, help: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--root') {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('-')) throw new Error('--root requires a directory')
      args.root = resolve(value)
      index += 1
    } else if (arg === '--help' || arg === '-h') {
      args.help = true
    } else {
      throw new Error(`unknown argument: ${arg}`)
    }
  }
  return args
}

function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex')
}

/** 顶层 `export const <name> = '<literal>'` 的字符串值。 */
function stringConstant(source, name) {
  const pattern = new RegExp(`export const ${name}\\b[^\\n]*?=\\s*'([^']*)'`, 'u')
  const match = pattern.exec(source)
  return match === null ? undefined : match[1]
}

/** `PINS_AT_RELEASE` 声明片段(到下一个顶层导出为止;之后的函数体不得被读成钉扎)。 */
function pinsDeclaration(source) {
  const start = source.indexOf('export const PINS_AT_RELEASE')
  if (start === -1) return ''
  const rest = source.slice(start)
  const end = rest.search(/\nexport /u)
  return end === -1 ? rest : rest.slice(0, end)
}

/** 钉扎片段里 `keyId: '<literal>'` / `publicKeyHex: '<literal>'` 的字符串值。 */
function pinField(declaration, field) {
  const match = new RegExp(`${field}\\s*:\\s*'([^']*)'`, 'u').exec(declaration)
  return match === null ? undefined : match[1]
}

/**
 * 读源码文本并判定三项 provisioning 输入。
 * 返回 `items`(逐项:名字、值、sha256 指纹、问题)与 `problems`(缺什么/错什么)。
 */
function inspectProvisioning(root) {
  const configSource = readFileSync(resolve(root, CONFIG_SOURCE), 'utf8')
  const updateSource = readFileSync(resolve(root, UPDATE_SOURCE), 'utf8')

  const problems = []
  const declaration = pinsDeclaration(configSource)
  const publicKeyHex = pinField(declaration, 'publicKeyHex')
  const keyId = pinField(declaration, 'keyId')

  if (publicKeyHex === undefined) {
    problems.push(
      `PINS_AT_RELEASE.current.publicKeyHex 未钉入(${CONFIG_SOURCE} 的 PINS_AT_RELEASE 仍是空钉扎)`
      + ';未钉公钥 ⇒ market 验签恒拒(fail-closed)',
    )
  } else if (!PINNED_KEY_PATTERN.test(publicKeyHex)) {
    problems.push(
      `PINS_AT_RELEASE.current.publicKeyHex 形状非法:须是 raw 32 字节 Ed25519 公钥的小写 hex(64 字符),`
      + `实际 ${JSON.stringify(publicKeyHex)}`,
    )
  }
  if (keyId === undefined || keyId.length === 0) {
    problems.push(
      'PINS_AT_RELEASE.current.keyId 未钉入:公钥的 sha256 指纹必须与公钥一并钉入,'
      + '发行当天用于与 R2 经第二信道给出的指纹比对',
    )
  } else if (!PINNED_KEY_PATTERN.test(keyId)) {
    problems.push(
      `PINS_AT_RELEASE.current.keyId 形状非法:须是 sha256 hex(64 字符),实际 ${JSON.stringify(keyId)}`,
    )
  }
  let fingerprintHex
  if (publicKeyHex !== undefined && PINNED_KEY_PATTERN.test(publicKeyHex)) {
    fingerprintHex = sha256Hex(Buffer.from(publicKeyHex, 'hex'))
    if (keyId !== undefined && PINNED_KEY_PATTERN.test(keyId) && keyId !== fingerprintHex) {
      problems.push(
        `PINS_AT_RELEASE.current.keyId 与公钥不配对:keyId = ${keyId},`
        + ` sha256(publicKeyHex) = ${fingerprintHex}(抄错指纹会让这一版 app 恒拒真清单,故打包前拒绝)`,
      )
    }
  }

  const origins = [
    { name: 'HUAANWORK_MARKET_DEFAULT_ORIGIN', source: CONFIG_SOURCE, value: stringConstant(configSource, 'HUAANWORK_MARKET_DEFAULT_ORIGIN') },
    { name: 'HUAANWORK_UPDATE_DEFAULT_ORIGIN', source: UPDATE_SOURCE, value: stringConstant(updateSource, 'HUAANWORK_UPDATE_DEFAULT_ORIGIN') },
  ]
  for (const origin of origins) {
    if (origin.value === undefined || origin.value.length === 0) {
      problems.push(`${origin.name} 未定义(${origin.source})`)
    } else if (origin.value.includes('.example')) {
      problems.push(
        `${origin.name} 仍是占位 ${JSON.stringify(origin.value)}(含 ".example",按构造不可达);`
        + '须换成 R2 提供的真实内网地址',
      )
    }
  }

  return { publicKeyHex, keyId, fingerprintHex, origins, problems }
}

function reportUnprovisioned(state) {
  const lines = [
    '本构建未完成发行 provisioning(unprovisioned release build):市场信任锚或内网 origin 仍是占位。',
    '按裁定 D-M6-18,真实值由 R2 提供、R1 在发行分支钉入;本守卫不生成密钥、不猜测地址。',
    '',
    '缺什么:',
  ]
  for (const problem of state.problems) lines.push(`  - ${problem}`)
  lines.push(
    '',
    '诚实说明:env 覆盖(HUAANWORK_MARKET_ORIGIN / HUAANWORK_UPDATE_ORIGIN)只重指运行期 origin,'
    + '既不提供验签公钥也不构成对信任锚的 provisioning,故不满足本守卫。',
    '流程见 docs/release-checklist.md 的发行 provisioning 节与 docs/market-server-deployment.md 的公钥分发与指纹核对节。',
  )
  console.error(lines.join('\n'))
}

function reportProvisioned(state) {
  const lines = [
    'release provisioning 就绪:三项均已钉入真实值。以下 sha256 指纹供 R1 与 R2 经第二信道带外核对。',
    '',
  ]
  for (const origin of state.origins) {
    lines.push(`  ${origin.name} = ${origin.value}`)
    lines.push(`    sha256(origin 字符串) = ${sha256Hex(Buffer.from(origin.value, 'utf8'))}`)
  }
  lines.push(`  PINS_AT_RELEASE.current.publicKeyHex = ${state.publicKeyHex}`)
  lines.push(`  PINS_AT_RELEASE.current.keyId = ${state.keyId}`)
  lines.push(`    sha256(公钥原始字节) = ${state.fingerprintHex}  ← 与 R2 带外给出的指纹逐字符比对这一行`)
  lines.push('    keyId == sha256(公钥原始字节):一致')
  console.log(lines.join('\n'))
}

function main() {
  let args
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`)
    process.exit(2)
    return
  }
  if (args.help) {
    console.log(USAGE)
    return
  }
  let state
  try {
    state = inspectProvisioning(args.root)
  } catch (error) {
    console.error(`无法读取 provisioning 输入(仓库根 ${args.root}):${error instanceof Error ? error.message : String(error)}`)
    process.exit(2)
    return
  }
  if (state.problems.length > 0) {
    reportUnprovisioned(state)
    process.exit(1)
  }
  reportProvisioned(state)
}

main()
