/** Real Electron RunAsNode smoke for Profile CJS/ESM resolution and native binaries. */

import { execFileSync } from 'node:child_process'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type {} from '@deepseek-ai/dsh-session-persistence'
import { verifyBundledSkills } from './packaged-filesystem-smoke.ts'
import { rgPath } from '@vscode/ripgrep'
import AdmZip from 'adm-zip'
import { exportDiagnosticsZip } from './diagnostic-export.ts'
import { installProfilePackageResolver } from './module-resolution.ts'
import { createExtractionPool } from './huaanwork-host/knowledge/extraction-pool.ts'
import { buildMinimalChineseCidPdf } from './huaanwork-host/knowledge/pdf-fixture.ts'
import { createKnowledgeStorageClient } from './huaanwork-host/knowledge/storage-client.ts'
import { resolveKnowledgeWorkerUrl } from './huaanwork-host/knowledge/worker-paths.ts'

const OK_MARKER = 'DSH_PACKAGED_RUNTIME_OK'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`dsh-plugin-desktop: packaged runtime smoke ${message}`)
}

const installAnchor = new URL('../package.json', import.meta.url)
const packagedAsarRoot = /(?:^|[\\/])app\.asar(?:\.unpacked)?[\\/]/u
const packagedDirectoryRoot = /(?:^|[\\/])app[\\/]/u
const usesAsar = packagedAsarRoot.test(installAnchor.pathname)
assert(
  usesAsar || packagedDirectoryRoot.test(installAnchor.pathname),
  `did not start from a packaged application root: ${installAnchor.pathname}`,
)
assert(
  usesAsar
    ? /(?:^|[\\/])app\.asar\.unpacked[\\/]/u.test(rgPath)
    : packagedDirectoryRoot.test(rgPath),
  `resolved ripgrep outside the packaged application root: ${rgPath}`,
)
assert(existsSync(rgPath), `cannot find ripgrep at ${rgPath}`)
const rgVersion = execFileSync(rgPath, ['--version'], { encoding: 'utf8', windowsHide: true })
assert(/^ripgrep\s/u.test(rgVersion), `received an invalid ripgrep version: ${JSON.stringify(rgVersion.trim())}`)
if (process.platform === 'win32') {
  const sessionBackend = await import('@deepseek-ai/dsh-session-persistence-jsonl') as {
    default?: unknown
    apply?: unknown
  }
  assert(
    typeof (sessionBackend.default ?? sessionBackend.apply) === 'function',
    'could not import the Windows JSONL session backend without fs-ext',
  )
} else {
  const fsExt = createRequire(installAnchor)('fs-ext') as { flockSync?: unknown }
  assert(typeof fsExt.flockSync === 'function', 'did not load the Electron ABI fs-ext binding')
}

/** Exercise upstream migration and native session locks from the packaged runtime. */
async function smokeSessionMigration(): Promise<void> {
  const { Context } = await import('@deepseek-ai/cordis')
  const { SessionId } = await import('@deepseek-ai/dsh-session')
  const sessionBackend = await import('@deepseek-ai/dsh-session-persistence-jsonl')
  const JsonlSessionPersistence = (
    'default' in sessionBackend ? sessionBackend.default : sessionBackend
  ) as Parameters<InstanceType<typeof Context>['plugin']>[0]
  const root = mkdtempSync(join(tmpdir(), 'dsh-packaged-session-migration-'))
  const id = SessionId('packaged-migration')
  const directory = join(root, '_no-cwd', id)
  const source = JSON.stringify({
    type: 'session', version: 2, id, createdAt: 1, isSeeded: false,
    delegationDepth: 0, agentPreset: 'code',
  }) + '\n'
  const ctx = new Context()
  try {
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'session.v2.jsonl'), source)
    await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
    const handle = await ctx.sessionPersistence.open(id, 'write')
    try {
      assert(handle.header.version === 4 && handle.header.agentPreset === 'ptc', 'did not migrate the legacy preset through the upstream worker')
    } finally {
      await handle.close()
    }
    await ctx.sessionPersistence.flush()
    assert(existsSync(join(directory, 'session.v4.jsonl')), 'did not publish the V4 session log')
    assert(readFileSync(join(directory, 'session.v2.jsonl'), 'utf8') === source, 'changed the original V2 session log')
  } finally {
    await ctx.fiber.dispose()
    rmSync(root, { recursive: true, force: true })
  }
}

/** Exercise the production Worker entry through Electron's logical ASAR path. */
async function smokeDiagnosticExportWorker(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'dsh-packaged-diagnostics-'))
  const logsDir = join(root, 'logs')
  const userDataDir = join(root, 'user-data')
  const crashDumpsDir = join(root, 'Crashpad')
  mkdirSync(logsDir)
  mkdirSync(userDataDir)
  mkdirSync(join(crashDumpsDir, 'pending'), { recursive: true })
  writeFileSync(join(logsDir, 'dsh-2000-01-01.log'), 'packaged worker smoke\n')
  writeFileSync(join(crashDumpsDir, 'pending', 'packaged-smoke.dmp'), 'packaged crash dump smoke\n')
  try {
    const output = await exportDiagnosticsZip(logsDir, userDataDir, {
      appVersion: 'packaged-smoke',
      maxEvidenceBytes: 1024,
      crashDumpsDir,
    })
    assert(existsSync(output), `diagnostic Worker produced no archive at ${output}`)
    const crashEntry = 'crash-dumps/pending/packaged-smoke.dmp'
    assert(
      new AdmZip(output).getEntry(crashEntry) !== null,
      `diagnostic Worker omitted ${crashEntry}`,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

/**
 * M1-1 packaged knowledge smoke（控制器裁决 I-2 / M-11）。
 *
 * 断言打包根内 pdfjs `cmaps/` 与 `standard_fonts/` 存在、可选原生依赖
 * `@napi-rs/canvas*` 已从安装包排除（`pdfjs-dist` 纯文本提取不需要它，保留会
 * 增大 ~60 MB 且破坏 macOS universal 合并），再经 `resolveKnowledgeWorkerUrl`
 * 拉起**构建产物** `lib/huaanwork-host/knowledge/{storage,extraction}-worker.js`：
 * 提取损坏 `.asar` 与最小中文 CID PDF、FTS5 入库并检索命中中文字符，最后断言
 * 两个 Worker 的 `dispose()` < 1,000 ms。包体积/文件数是观察值（写到 stderr，
 * 绝不进入 stdout 的 OK 标记）。
 */
export async function smokeKnowledgeWorkers(): Promise<void> {
  const installRoot = fileURLToPath(new URL('./', installAnchor))
  const pdfPackageRoot = join(installRoot, 'node_modules', 'pdfjs-dist')
  const cmapsDir = join(pdfPackageRoot, 'cmaps')
  const standardFontsDir = join(pdfPackageRoot, 'standard_fonts')
  assert(
    existsSync(cmapsDir) && readdirSync(cmapsDir).length > 0,
    'is missing non-empty node_modules/pdfjs-dist/cmaps for Chinese CID PDF extraction',
  )
  assert(
    existsSync(standardFontsDir) && readdirSync(standardFontsDir).length > 0,
    'is missing non-empty node_modules/pdfjs-dist/standard_fonts for PDF text extraction',
  )
  const leakedCanvasPaths = findLeakedCanvasPackages(join(installRoot, 'node_modules'))
  assert(
    leakedCanvasPaths.length === 0,
    `packaged app unexpectedly shipped @napi-rs/canvas* entries: ${leakedCanvasPaths.join(', ')}`,
  )

  const root = mkdtempSync(join(tmpdir(), 'dsh-packaged-knowledge-'))
  const sourceDir = join(root, 'source')
  const kbDir = join(root, 'kb')
  mkdirSync(sourceDir, { recursive: true })
  mkdirSync(kbDir, { recursive: true })
  writeFileSync(join(sourceDir, 'corrupt.asar'), 'NOT_AN_ASAR_ARCHIVE')
  writeFileSync(join(sourceDir, 'compliance.pdf'), buildMinimalChineseCidPdf())

  const storage = createKnowledgeStorageClient({ workerUrl: resolveKnowledgeWorkerUrl('storage-worker') })
  const pool = createExtractionPool({
    maxWorkers: 1,
    workerUrl: resolveKnowledgeWorkerUrl('extraction-worker'),
  })
  let disposeMs = 0
  let disposeResults: PromiseSettledResult<void>[] = []
  try {
    const opened = await storage.openKb('packaged-smoke', kbDir)
    assert(opened.ok, `could not open the packaged knowledge index: ${opened.ok ? '' : opened.error}`)

    let chineseText = ''
    for (const relPath of ['corrupt.asar', 'compliance.pdf']) {
      const extracted = await pool.extractFile('packaged-smoke', {
        sourceRoot: sourceDir,
        filePath: join(sourceDir, relPath),
        relPath,
      })
      assert(
        extracted.ok,
        `knowledge extraction failed for ${relPath}: ${extracted.ok ? '' : extracted.reason}`,
      )
      if (!extracted.ok || extracted.hashOnly === true) continue
      if (relPath.endsWith('.pdf')) {
        chineseText = extracted.doc.sections.map(section => section.text).join('')
      }
      await storage.upsertDocument('packaged-smoke', {
        relPath,
        normPath: relPath,
        sha256: extracted.sha256,
        size: extracted.size,
        mtimeMs: extracted.mtimeMs,
        format: extracted.doc.format,
        extractMode: extracted.doc.extractMode,
        extractConfigHash: extracted.doc.extractConfigHash,
        status: extracted.doc.status,
        ...(extracted.doc.statusReason === undefined ? {} : { statusReason: extracted.doc.statusReason }),
        chunks: extracted.chunks,
      })
    }
    assert(
      /\p{Script=Han}{2,}/u.test(chineseText) && chineseText.includes('合规'),
      `packaged PDF extraction lost the expected Chinese characters: ${JSON.stringify(chineseText.slice(0, 80))}`,
    )
    const hanRun = chineseText.match(/\p{Script=Han}{2,}/u)?.[0] ?? '合规'
    const hits = await storage.searchFts('packaged-smoke', '打包冒烟库', hanRun.slice(0, 4), 10)
    assert(hits.length > 0, `packaged knowledge FTS5 search missed ${JSON.stringify(hanRun.slice(0, 4))}`)
    assert(
      hits.some(hit => hit.content.includes(hanRun.slice(0, 2))),
      'packaged knowledge FTS5 hit did not contain the expected Chinese characters',
    )
  } finally {
    const disposeStart = performance.now()
    disposeResults = await Promise.allSettled([storage.dispose(), pool.dispose()])
    disposeMs = performance.now() - disposeStart
    rmSync(root, { recursive: true, force: true })
  }
  const disposeFailures = disposeResults
    .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    .map(result => String(result.reason))
  assert(
    disposeFailures.length === 0,
    `knowledge workers dispose rejected: ${disposeFailures.join('; ')}`,
  )
  assert(
    disposeMs < 1_000,
    `knowledge workers dispose took ${disposeMs.toFixed(1)} ms (budget 1,000 ms)`,
  )

  try {
    const measured = measurePackagedTree(installRoot)
    process.stderr.write(
      `[knowledge-smoke] package files=${String(measured.files)} bytes=${String(measured.bytes)} `
      + `canvasBytes=0 disposeMs=${disposeMs.toFixed(1)}\n`,
    )
  } catch (error) {
    // 体积观察绝不影响冒烟结论。
    process.stderr.write(`[knowledge-smoke] package measurement skipped: ${String(error)}\n`)
  }
}

/** 递归排查安装目录全部 `node_modules`（含嵌套）是否泄漏 `@napi-rs/canvas*`。 */
function findLeakedCanvasPackages(rootNodeModules: string): string[] {
  if (!existsSync(rootNodeModules)) return []
  const leaked: string[] = []
  const queue: string[] = [rootNodeModules]
  while (queue.length > 0) {
    const nodeModulesDir = queue.pop()
    if (nodeModulesDir === undefined) break
    let entries: string[]
    try {
      entries = readdirSync(nodeModulesDir)
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.startsWith('.')) continue
      const entryPath = join(nodeModulesDir, entry)
      if (entry === '@napi-rs') {
        let scopedEntries: string[]
        try {
          scopedEntries = readdirSync(entryPath)
        } catch {
          continue
        }
        for (const scoped of scopedEntries) {
          if (scoped === 'canvas' || scoped.startsWith('canvas-')) {
            leaked.push(join(entryPath, scoped))
          } else {
            const nested = join(entryPath, scoped, 'node_modules')
            if (existsSync(nested)) queue.push(nested)
          }
        }
        continue
      }
      if (entry.startsWith('@')) {
        let scopedEntries: string[]
        try {
          scopedEntries = readdirSync(entryPath)
        } catch {
          continue
        }
        for (const scoped of scopedEntries) {
          const nested = join(entryPath, scoped, 'node_modules')
          if (existsSync(nested)) queue.push(nested)
        }
        continue
      }
      const nested = join(entryPath, 'node_modules')
      if (existsSync(nested)) queue.push(nested)
    }
  }
  return leaked
}

/** 有限深度的包体积观察（只统计普通文件；符号链接/ASAR 虚拟项跳过）。 */
function measurePackagedTree(rootPath: string): { files: number; bytes: number } {
  let files = 0
  let bytes = 0
  let visited = 0
  const stack: string[] = [rootPath]
  while (stack.length > 0 && visited < 60_000) {
    const dir = stack.pop()
    if (dir === undefined) break
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      continue
    }
    for (const name of entries) {
      visited += 1
      if (visited >= 60_000) break
      const full = join(dir, name)
      try {
        const info = lstatSync(full)
        if (info.isDirectory()) stack.push(full)
        else if (info.isFile()) {
          files += 1
          bytes += info.size
        }
      } catch {
        // 已消失/不可读的条目不计入观察。
      }
    }
  }
  return { files, bytes }
}

const root = mkdtempSync(join(tmpdir(), 'dsh-packaged-profile-resolver-'))
try {
  const profileDir = join(root, 'profiles', 'smoke')
  const profileManifestPath = join(profileDir, 'package.json')
  const profileModulesDir = join(profileDir, 'node_modules')
  const commonJsDir = join(profileModulesDir, 'dsh-packaged-cjs-consumer')
  const esmDir = join(profileModulesDir, 'dsh-packaged-esm-consumer')
  const staleSchemasteryDir = join(root, 'profiles', 'node_modules', '@deepseek-ai', 'schemastery')
  mkdirSync(join(commonJsDir, 'features'), { recursive: true })
  mkdirSync(esmDir, { recursive: true })
  mkdirSync(staleSchemasteryDir, { recursive: true })
  writeFileSync(profileManifestPath, `${JSON.stringify({
    name: 'dsh-packaged-smoke-profile',
    private: true,
    type: 'module',
  })}\n`)

  // Simulate an ESM-only fallback proxy left by an older release. The Desktop
  // resolver must bypass it or CommonJS will receive the wrong export shape.
  writeFileSync(join(staleSchemasteryDir, 'package.json'), `${JSON.stringify({
    name: '@deepseek-ai/schemastery',
    version: '999.0.0',
    type: 'commonjs',
    main: './index.cjs',
  })}\n`)
  writeFileSync(join(staleSchemasteryDir, 'index.cjs'), 'module.exports = { stale: true }\n')

  writeFileSync(join(commonJsDir, 'package.json'), `${JSON.stringify({
    name: 'dsh-packaged-cjs-consumer',
    version: '1.0.0',
    type: 'commonjs',
    exports: {
      '.': { import: './wrong-import.mjs', require: './index.cjs' },
      './features/*': './features/*.cjs',
      './package.json': './package.json',
    },
  })}\n`)
  writeFileSync(join(commonJsDir, 'wrong-import.mjs'), 'throw new Error("require selected the import condition")\n')
  writeFileSync(join(commonJsDir, 'features', 'shape.cjs'), 'module.exports = "wildcard-cjs"\n')
  writeFileSync(join(commonJsDir, 'index.cjs'), [
    "const Schema = require('@deepseek-ai/schemastery')",
    "const manifest = require('@deepseek-ai/schemastery/package.json')",
    "const yamlUtil = require('yaml/util')",
    "const frontend = require.resolve('@deepseek-ai/dsh-web-frontend/dist/index.html')",
    'module.exports = {',
    '  Schema, manifest, yamlUtil, frontend,',
    "  loadEsm: () => import('dsh-packaged-esm-consumer'),",
    '}',
    '',
  ].join('\n'))

  writeFileSync(join(esmDir, 'package.json'), `${JSON.stringify({
    name: 'dsh-packaged-esm-consumer',
    version: '1.0.0',
    type: 'module',
    exports: { '.': { import: './index.mjs', require: './wrong-require.cjs' } },
  })}\n`)
  writeFileSync(join(esmDir, 'wrong-require.cjs'), 'throw new Error("import selected the require condition")\n')
  writeFileSync(join(esmDir, 'index.mjs'), [
    "import Schema from '@deepseek-ai/schemastery'",
    "import { parse } from 'yaml'",
    'export { Schema }',
    "export const value = parse('value: 7').value",
    '',
  ].join('\n'))

  const releaseResolver = installProfilePackageResolver(pathToFileURL(profileManifestPath).href)
  try {
    const profileRequire = createRequire(profileManifestPath)
    const installRequire = createRequire(installAnchor)
    const consumer = profileRequire('dsh-packaged-cjs-consumer') as {
      Schema?: unknown
      manifest?: { name?: unknown }
      yamlUtil?: { createNode?: unknown }
      frontend?: unknown
      loadEsm?: () => Promise<{ Schema?: unknown; value?: unknown }>
    }
    assert(typeof consumer.Schema === 'function', 'did not preserve callable CommonJS exports')
    assert(
      consumer.Schema === installRequire('@deepseek-ai/schemastery'),
      'did not preserve the installation CommonJS module identity',
    )
    assert(consumer.manifest?.name === '@deepseek-ai/schemastery', 'did not resolve package.json exports')
    assert(typeof consumer.yamlUtil?.createNode === 'function', 'did not resolve an exact conditional subpath')
    assert(
      typeof consumer.frontend === 'string'
        && (usesAsar
          ? /(?:^|[\\/])app\.asar[\\/]/u.test(consumer.frontend)
          : packagedDirectoryRoot.test(consumer.frontend))
        && consumer.frontend.endsWith(join('dist', 'index.html')),
      `did not resolve a wildcard export inside the packaged application: ${String(consumer.frontend)}`,
    )
    assert(
      profileRequire('dsh-packaged-cjs-consumer/features/shape') === 'wildcard-cjs',
      'did not preserve a Profile CommonJS wildcard export',
    )
    assert(
      (profileRequire('dsh-packaged-cjs-consumer/package.json') as { name?: unknown }).name
        === 'dsh-packaged-cjs-consumer',
      'did not preserve a Profile manifest export',
    )
    assert(typeof consumer.loadEsm === 'function', 'CommonJS fixture omitted its ESM branch')
    const esm = await consumer.loadEsm()
    const installationEsm = await import('@deepseek-ai/schemastery')
    assert(esm.Schema === installationEsm.default, 'did not preserve the installation ESM module identity')
    assert(esm.value === 7, 'did not select the ESM/import condition through the Profile graph')
  } finally {
    releaseResolver()
  }
} finally {
  rmSync(root, { recursive: true, force: true })
}

await verifyBundledSkills(fileURLToPath(new URL('./', installAnchor)))
await smokeSessionMigration()
await smokeDiagnosticExportWorker()
await smokeKnowledgeWorkers()

process.stdout.write(OK_MARKER)
