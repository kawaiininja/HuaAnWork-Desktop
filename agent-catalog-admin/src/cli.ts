#!/usr/bin/env -S node --experimental-strip-types
/**
 * Offline administrator CLI of the HuaAnWork intranet agent catalog.
 *
 *   pending                                  list pending submissions
 *   review <submissionId> --out <dir>        download + independently re-digest
 *   approve <id> --review <file> --private-key <pem> --slot 1|2 --yes
 *   reject <id> --reason <text>
 *   delist-requests                          list pending delist requests
 *   delist-approve <requestId>
 *   delist-reject <requestId> --reason <text>
 *   revoke <slug> <version> --reason <text>
 *   migrate-legacy <slug> [--submit]
 *
 * Environment:
 *   AGENT_CATALOG_URL              catalog root (required everywhere)
 *   AGENT_CATALOG_ADMIN_TOKEN      admin routes (review/approve/reject/governance)
 *   AGENT_CATALOG_TOKEN            read token, migrate-legacy legacy entry read
 *   AGENT_CATALOG_PUBLISH_TOKEN    publish token, migrate-legacy --submit
 *
 * The private key is read ONLY from `--private-key`, is never printed, and is
 * read only after every receipt/digest check AND the explicit `--yes`.
 * Argument parsing uses `node:util` `parseArgs`; there is no CLI framework.
 */

import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

import { AgentCatalogAdminClient, CatalogCliError } from './client.ts'
import {
  approveSubmissionFromReceipt,
  migrateLegacyEntry,
  reviewSubmission,
  type LegacyMigrationOutcome,
  type ReviewOutcome,
} from './review.ts'

const MAX_REASON_LENGTH = 500

const USAGE = `用法：
  agent-catalog-admin pending
  agent-catalog-admin review <submissionId> --out <目录>
  agent-catalog-admin approve <submissionId> --review <目录>/review.json \\
      --private-key <私钥文件> --slot 1|2 --yes
  agent-catalog-admin reject <submissionId> --reason <文本>
  agent-catalog-admin delist-requests
  agent-catalog-admin delist-approve <下架申请ID>
  agent-catalog-admin delist-reject <下架申请ID> --reason <文本>
  agent-catalog-admin revoke <slug> <version> --reason <文本>
  agent-catalog-admin migrate-legacy <slug> [--submit]

环境变量：AGENT_CATALOG_URL；管理命令需 AGENT_CATALOG_ADMIN_TOKEN；
migrate-legacy 需 AGENT_CATALOG_TOKEN；migrate-legacy --submit 需
AGENT_CATALOG_PUBLISH_TOKEN。私钥只从 --private-key 读取，任何输出都不含私钥或 token。`

/** A usage error: printed with the usage text and exits 2. */
class UsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UsageError'
  }
}

interface CliIo {
  readonly stdout: (text: string) => void
  readonly stderr: (text: string) => void
}

const CONSOLE_IO: CliIo = {
  stdout: (text) => process.stdout.write(`${text}\n`),
  stderr: (text) => process.stderr.write(`${text}\n`),
}

interface CommandLine {
  readonly command: string
  readonly positionals: readonly string[]
  readonly values: {
    readonly out?: string
    readonly review?: string
    readonly privateKey?: string
    readonly slot?: string
    readonly reason?: string
    readonly yes: boolean
    readonly submit: boolean
  }
}

function parseCommandLine(argv: readonly string[]): CommandLine {
  let parsed: ReturnType<typeof parseArgs>
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
      options: {
        out: { type: 'string' },
        review: { type: 'string' },
        'private-key': { type: 'string' },
        slot: { type: 'string' },
        reason: { type: 'string' },
        yes: { type: 'boolean', default: false },
        submit: { type: 'boolean', default: false },
      },
    })
  } catch (cause) {
    throw new UsageError(cause instanceof Error ? cause.message : String(cause))
  }

  const [command, ...positionals] = parsed.positionals
  if (command === undefined) throw new UsageError('缺少子命令')
  const values = parsed.values
  return {
    command,
    positionals,
    values: {
      ...(typeof values.out === 'string' ? { out: values.out } : {}),
      ...(typeof values.review === 'string' ? { review: values.review } : {}),
      ...(typeof values['private-key'] === 'string' ? { privateKey: values['private-key'] } : {}),
      ...(typeof values.slot === 'string' ? { slot: values.slot } : {}),
      ...(typeof values.reason === 'string' ? { reason: values.reason } : {}),
      yes: values.yes === true,
      submit: values.submit === true,
    },
  }
}

function requireOne(command: string, positionals: readonly string[], what: string): string {
  if (positionals.length !== 1) {
    throw new UsageError(`${command} 需要且只接受一个${what}`)
  }
  return positionals[0] as string
}

function requireTwo(command: string, positionals: readonly string[]): [string, string] {
  if (positionals.length !== 2) throw new UsageError(`${command} 需要 <slug> <version> 两个参数`)
  return [positionals[0] as string, positionals[1] as string]
}

function requireNoPositionals(command: string, positionals: readonly string[]): void {
  if (positionals.length !== 0) throw new UsageError(`${command} 不接受额外参数`)
}

function requireReason(raw: string | undefined): string {
  const reason = raw?.trim() ?? ''
  if (reason.length < 1 || reason.length > MAX_REASON_LENGTH) {
    throw new UsageError(`--reason 去除首尾空白后必须是 1-${String(MAX_REASON_LENGTH)} 个字符`)
  }
  return reason
}

function requireFlag(value: string | undefined, flag: string, command: string): string {
  if (value === undefined || value.trim() === '') {
    throw new UsageError(`${command} 需要 ${flag}`)
  }
  return value.trim()
}

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim()
  if (value === undefined || value === '') {
    throw new CatalogCliError(`缺少环境变量 ${name}`)
  }
  return value
}

/** Validated catalog root (no trailing slash). */
function catalogBaseUrl(env: NodeJS.ProcessEnv): string {
  const raw = requireEnv(env, 'AGENT_CATALOG_URL')
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new CatalogCliError('AGENT_CATALOG_URL 不是合法 URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new CatalogCliError('AGENT_CATALOG_URL 必须是 http(s) 地址')
  }
  return raw.replace(/\/+$/u, '')
}

interface TokenNeeds {
  readonly admin?: boolean
  readonly read?: boolean
  readonly publish?: boolean
}

function makeClient(env: NodeJS.ProcessEnv, needs: TokenNeeds): AgentCatalogAdminClient {
  return new AgentCatalogAdminClient({
    baseUrl: catalogBaseUrl(env),
    ...(needs.admin === true
      ? { adminToken: requireEnv(env, 'AGENT_CATALOG_ADMIN_TOKEN') }
      : {}),
    ...(needs.read === true ? { readToken: requireEnv(env, 'AGENT_CATALOG_TOKEN') } : {}),
    ...(needs.publish === true
      ? { publishToken: requireEnv(env, 'AGENT_CATALOG_PUBLISH_TOKEN') }
      : {}),
  })
}

function printReview(io: CliIo, outcome: ReviewOutcome): void {
  io.stdout(outcome.report)
  io.stdout('')
  io.stdout(`审查回执：${outcome.receiptPath}`)
}

function printMigration(io: CliIo, outcome: LegacyMigrationOutcome): void {
  const { manifest } = outcome
  io.stdout(`已生成最小智能体包：${manifest.slug}/${manifest.version}`)
  io.stdout(`displayName：${manifest.displayName}`)
  io.stdout(`description：${manifest.description}`)
  io.stdout(`人设来源：${outcome.personaSource}`)
  io.stdout(`文件：agent.json、persona.md`)
  io.stdout(`包大小：${String(outcome.bundleBytes)} 字节`)
  io.stdout(`摘要 sha256：${outcome.digestSha256}`)
  if (outcome.submission === undefined) {
    io.stdout('未提交：加 --submit 才会提交审查。')
    return
  }
  io.stdout('')
  io.stdout('已提交审查：')
  io.stdout(`  submissionId：${outcome.submission.submissionId}`)
  io.stdout(`  状态：${outcome.submission.status}`)
  io.stdout('未自动批准：请先运行 review 与 approve。')
}

async function execute(
  args: CommandLine,
  env: NodeJS.ProcessEnv,
  io: CliIo,
): Promise<void> {
  const { command, positionals, values } = args
  switch (command) {
    case 'pending': {
      requireNoPositionals(command, positionals)
      const items = await makeClient(env, { admin: true }).listPendingSubmissions()
      if (items.length === 0) {
        io.stdout('待审查提交：无')
        return
      }
      io.stdout(`待审查提交（${String(items.length)}）：`)
      for (const item of items) {
        io.stdout(
          `  ${item.submissionId}  ${item.slug}/${item.version}  提交于 ${item.submittedAt}`,
        )
      }
      return
    }

    case 'review': {
      const submissionId = requireOne(command, positionals, ' submissionId')
      const outDir = requireFlag(values.out, '--out <目录>', command)
      const outcome = await reviewSubmission({
        client: makeClient(env, { admin: true }),
        submissionId,
        outDir: resolve(outDir),
      })
      printReview(io, outcome)
      return
    }

    case 'approve': {
      const submissionId = requireOne(command, positionals, ' submissionId')
      // Confirmation comes FIRST: nothing is read (not the receipt, not the
      // key) and nothing is sent before the operator explicitly typed --yes.
      if (!values.yes) {
        throw new UsageError('approve 需要 --yes 明确确认；未确认前不会读取私钥、不会签名、不会发布')
      }
      const reviewPath = requireFlag(values.review, '--review <review.json>', command)
      const privateKeyPath = requireFlag(values.privateKey, '--private-key <私钥文件>', command)
      const slotRaw = requireFlag(values.slot, '--slot 1|2', command)
      if (slotRaw !== '1' && slotRaw !== '2') {
        throw new UsageError('--slot 只能是 1 或 2')
      }
      const outcome = await approveSubmissionFromReceipt({
        client: makeClient(env, { admin: true }),
        submissionId,
        receiptPath: resolve(reviewPath),
        privateKeyPath: resolve(privateKeyPath),
        slot: slotRaw === '1' ? 1 : 2,
      })
      io.stdout(`已批准并发布：${outcome.submission.slug}/${outcome.submission.version}`)
      io.stdout(`提交：${outcome.submission.submissionId}`)
      io.stdout(`签名 keyId：${outcome.signature.keyId}`)
      io.stdout(`签名槽位：${String(outcome.signature.slot)}`)
      io.stdout(`签名时间：${outcome.signature.signedAt}`)
      return
    }

    case 'reject': {
      const submissionId = requireOne(command, positionals, ' submissionId')
      const reason = requireReason(values.reason)
      const record = await makeClient(env, { admin: true }).rejectSubmission(submissionId, reason)
      io.stdout(`已拒绝：${record.slug}/${record.version}`)
      io.stdout(`提交：${record.submissionId}`)
      io.stdout(`原因：${record.reason ?? reason}`)
      return
    }

    case 'delist-requests': {
      requireNoPositionals(command, positionals)
      const items = await makeClient(env, { admin: true }).listPendingDelistRequests()
      if (items.length === 0) {
        io.stdout('待处理下架申请：无')
        return
      }
      io.stdout(`待处理下架申请（${String(items.length)}）：`)
      for (const item of items) {
        io.stdout(`  ${item.id}  ${item.slug}/${item.version}  申请于 ${item.createdAt}`)
        io.stdout(`    原因：${item.reason}`)
      }
      return
    }

    case 'delist-approve': {
      const requestId = requireOne(command, positionals, '下架申请 ID')
      const record = await makeClient(env, { admin: true }).approveDelistRequest(requestId)
      io.stdout(`已批准下架：${record.slug}/${record.version}（申请 ${record.id}）`)
      return
    }

    case 'delist-reject': {
      const requestId = requireOne(command, positionals, '下架申请 ID')
      const reason = requireReason(values.reason)
      const record = await makeClient(env, { admin: true }).rejectDelistRequest(requestId, reason)
      io.stdout(`已驳回下架申请：${record.slug}/${record.version}（申请 ${record.id}）`)
      io.stdout(`原因：${reason}`)
      return
    }

    case 'revoke': {
      const [slug, version] = requireTwo(command, positionals)
      const reason = requireReason(values.reason)
      const record = await makeClient(env, { admin: true }).revoke(slug, version, reason)
      io.stdout(`已撤销：${record.slug}/${record.version}`)
      io.stdout(`撤销时间：${record.revokedAt}`)
      io.stdout(`原因：${record.reason}`)
      io.stdout('已安装副本将在客户端下次刷新撤销列表后禁用；本命令无法撤回。')
      return
    }

    case 'migrate-legacy': {
      const slug = requireOne(command, positionals, ' slug')
      const outcome = await migrateLegacyEntry({
        client: makeClient(env, {
          read: true,
          ...(values.submit ? { publish: true } : {}),
        }),
        slug,
        submit: values.submit,
      })
      printMigration(io, outcome)
      return
    }

    default:
      throw new UsageError(`未知子命令：${command}`)
  }
}

/**
 * Run one CLI invocation. Returns the process exit code (0 ok, 1 operation
 * failure, 2 usage error). Exported so tests can also drive it in-process.
 */
export async function runCli(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  io: CliIo = CONSOLE_IO,
): Promise<number> {
  let args: CommandLine
  try {
    args = parseCommandLine(argv)
  } catch (cause) {
    if (cause instanceof UsageError) {
      io.stderr(`错误：${cause.message}`)
      io.stderr(USAGE)
      return 2
    }
    io.stderr(`内部错误：${cause instanceof Error ? cause.message : String(cause)}`)
    return 1
  }

  try {
    await execute(args, env, io)
    return 0
  } catch (cause) {
    if (cause instanceof UsageError) {
      io.stderr(`错误：${cause.message}`)
      io.stderr('')
      io.stderr(USAGE)
      return 2
    }
    if (cause instanceof CatalogCliError) {
      io.stderr(`错误：${cause.message}`)
      return 1
    }
    io.stderr(`内部错误：${cause instanceof Error ? cause.message : String(cause)}`)
    return 1
  }
}

const entry = process.argv[1]
const isEntryPoint = entry !== undefined && pathToFileURL(resolve(entry)).href === import.meta.url
if (isEntryPoint) {
  process.exitCode = await runCli(process.argv.slice(2))
}
