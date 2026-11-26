import { chmodSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  neutralKnowledgeBaseDir,
  neutralKnowledgeRootPath,
  neutralKnowledgeWikiRootPath,
} from '../../src/huaanwork-host/workspace-state.ts'
import { writeHuaanworkSettings } from '../../src/huaanwork-host/settings.ts'
import { isUncOrDevicePath, probeCaseSensitiveDir, validateSourceDir } from '../../src/huaanwork-host/knowledge/paths.ts'
import { resolveKnowledgeWorkerUrl } from '../../src/huaanwork-host/knowledge/worker-paths.ts'
import { readKnowledgeBases, writeKnowledgeBases } from '../../src/huaanwork-host/knowledge/registry.ts'

const DIR_SYMLINK_TYPE = process.platform === 'win32' ? 'junction' : 'dir'

describe('knowledge registry, sourceDir validation, and worker path resolution', () => {
  it('derives isolated knowledge workspace paths and rejects path traversal ids', () => {
    expect(neutralKnowledgeBaseDir('/p')).toBe(join('/p', 'workspace-knowledge'))
    expect(neutralKnowledgeRootPath('/p', 'kb-1')).toBe(join('/p', 'workspace-knowledge', 'kb-1'))
    expect(neutralKnowledgeWikiRootPath('/p', 'kb-1')).toBe(join('/p', 'workspace-knowledge', 'kb-1', 'wiki'))
    expect(() => neutralKnowledgeRootPath('/p', '../escape')).toThrow()
  })

  it('rejects UNC, Windows device paths, profileDir/child/ancestor, symlinks/junctions to forbidden dirs, and nested/ancestor KBs; allows project overlap', async () => {
    expect(isUncOrDevicePath('\\\\server\\share\\docs')).toBe(true)
    expect(isUncOrDevicePath('//server/share/docs')).toBe(true)
    expect(isUncOrDevicePath('\\\\.\\PhysicalDrive0')).toBe(true)
    expect(isUncOrDevicePath('\\\\?\\C:\\docs')).toBe(true)

    const root = mkdtempSync(join(tmpdir(), 'kb-paths-'))
    const profileDir = join(root, 'profile')
    const profileSub = join(profileDir, 'sub')
    const docsParent = join(root, 'docs-parent')
    const kbA = join(docsParent, 'docs-a')
    const kbASub = join(kbA, 'nested')
    // 目录名以 `..` 开头但不是 `..` 本身：`relative()` 产出 `..hidden` / `..sub`，
    // 旧实现用 `startsWith('..')` 会把真实子目录误判为非子目录（隔离守卫 fail-open）。
    const profileDotDotSub = join(profileDir, '..hidden')
    const kbADotDotSub = join(kbA, '..sub')
    const projectDir = join(root, 'registered-project')
    const linkToProfile = join(root, 'link-profile')
    const linkToKbA = join(root, 'link-kba')
    mkdirSync(profileSub, { recursive: true })
    mkdirSync(profileDotDotSub, { recursive: true })
    mkdirSync(kbASub, { recursive: true })
    mkdirSync(kbADotDotSub, { recursive: true })
    mkdirSync(projectDir, { recursive: true })
    symlinkSync(profileSub, linkToProfile, DIR_SYMLINK_TYPE)
    symlinkSync(kbASub, linkToKbA, DIR_SYMLINK_TYPE)

    await expect(validateSourceDir({ sourceDir: profileDir, profileDir, existing: [] })).resolves.toMatchObject({ ok: false })
    await expect(validateSourceDir({ sourceDir: profileSub, profileDir, existing: [] })).resolves.toMatchObject({ ok: false })
    // 回归：以 `..` 开头的真实子目录名必须仍被识别为 profileDir 的子目录。
    await expect(validateSourceDir({ sourceDir: profileDotDotSub, profileDir, existing: [] })).resolves.toMatchObject({ ok: false })
    await expect(validateSourceDir({ sourceDir: root, profileDir, existing: [] })).resolves.toMatchObject({ ok: false })
    await expect(validateSourceDir({ sourceDir: linkToProfile, profileDir, existing: [] })).resolves.toMatchObject({ ok: false })

    const existing = [{
      id: 'kb-a', name: 'A', sourceDir: kbA, autoOrganize: true, watchPaused: false, createdAt: '2026-11-25T00:00:00.000Z',
    }]
    await expect(validateSourceDir({ sourceDir: kbA, profileDir, existing })).resolves.toMatchObject({ ok: false })
    await expect(validateSourceDir({ sourceDir: kbASub, profileDir, existing })).resolves.toMatchObject({ ok: false })
    // 回归：以 `..` 开头的真实子目录名必须仍被识别为已登记源目录的子目录。
    await expect(validateSourceDir({ sourceDir: kbADotDotSub, profileDir, existing })).resolves.toMatchObject({ ok: false })
    await expect(validateSourceDir({ sourceDir: docsParent, profileDir, existing })).resolves.toMatchObject({ ok: false })
    await expect(validateSourceDir({ sourceDir: linkToKbA, profileDir, existing })).resolves.toMatchObject({ ok: false })

    // Rebinding kb-a succeeds when ignoreKbId is set; overlapping a registered project dir is allowed (spec §5.2(4))
    await expect(validateSourceDir({ sourceDir: kbA, profileDir, existing, ignoreKbId: 'kb-a' })).resolves.toMatchObject({ ok: true })
    await expect(validateSourceDir({ sourceDir: projectDir, profileDir, existing })).resolves.toMatchObject({ ok: true })
  })

  it('writes knowledge-bases.json and settings.json atomically with 0o600 on POSIX', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kb-reg-'))
    const profileDir = join(root, 'profile')
    const validDocsDir = join(root, 'valid-docs')
    mkdirSync(profileDir, { recursive: true })
    mkdirSync(validDocsDir, { recursive: true })
    await writeHuaanworkSettings(profileDir, { model: 'test-model' })
    await writeKnowledgeBases(profileDir, [{
      id: 'kb-1', name: '法务库', sourceDir: validDocsDir, autoOrganize: true, watchPaused: true, createdAt: '2026-11-25T00:00:00.000Z',
    }])
    const loaded = await readKnowledgeBases(profileDir)
    expect(loaded).toHaveLength(1)
    expect(loaded[0]?.watchPaused).toBe(true)
    expect(loaded[0]?.sourceDir).toBe(validDocsDir)
    if (process.platform !== 'win32') {
      expect(statSync(join(profileDir, 'knowledge-bases.json')).mode & 0o777).toBe(0o600)
      expect(statSync(join(profileDir, 'huaanwork-settings.json')).mode & 0o777).toBe(0o600)
    }
  })

  it('quarantines a corrupt knowledge-bases.json before returning [] so a later write cannot erase existing bindings', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kb-reg-corrupt-'))
    const profileDir = join(root, 'profile')
    const validDocsDir = join(root, 'valid-docs')
    mkdirSync(profileDir, { recursive: true })
    mkdirSync(validDocsDir, { recursive: true })
    const registryPath = join(profileDir, 'knowledge-bases.json')
    const corruptBytes = '{"knowledgeBases": ['

    writeFileSync(registryPath, corruptBytes, { mode: 0o600 })
    await expect(readKnowledgeBases(profileDir)).resolves.toEqual([])
    const quarantined = readdirSync(profileDir).filter(name => name.startsWith('knowledge-bases.json.corrupt-'))
    expect(quarantined).toHaveLength(1)
    const quarantinedPath = join(profileDir, quarantined[0]!)
    expect(readFileSync(quarantinedPath, 'utf8')).toBe(corruptBytes)
    if (process.platform !== 'win32') {
      // `rename` 保留原 0o600 权限，隔离文件可安全留在 profile 目录供人工恢复。
      expect(statSync(quarantinedPath).mode & 0o777).toBe(0o600)
    }

    const record = {
      id: 'kb-1',
      name: '恢复库',
      sourceDir: validDocsDir,
      autoOrganize: false,
      watchPaused: false,
      createdAt: '2026-11-25T00:00:00.000Z',
    }
    await writeKnowledgeBases(profileDir, [record])
    // 隔离文件不被新写入覆盖或删除，新注册表可正常解析。
    expect(readFileSync(quarantinedPath, 'utf8')).toBe(corruptBytes)
    await expect(readKnowledgeBases(profileDir)).resolves.toEqual([record])

    // 顶层形状不符（不是 `{ knowledgeBases: array }`）同样隔离。
    const shapeProfile = join(root, 'profile-shape')
    mkdirSync(shapeProfile, { recursive: true })
    writeFileSync(join(shapeProfile, 'knowledge-bases.json'), '{"knowledgeBases": 42}')
    await expect(readKnowledgeBases(shapeProfile)).resolves.toEqual([])
    expect(readdirSync(shapeProfile).some(name => name.startsWith('knowledge-bases.json.corrupt-'))).toBe(true)

    // 连续两次损坏隔离带随机后缀，同一毫秒内也不会互相覆盖。
    writeFileSync(join(shapeProfile, 'knowledge-bases.json'), '{"knowledgeBases": "again"}')
    await expect(readKnowledgeBases(shapeProfile)).resolves.toEqual([])
    const twoQuarantined = readdirSync(shapeProfile).filter(name => name.startsWith('knowledge-bases.json.corrupt-'))
    expect(twoQuarantined).toHaveLength(2)

    // 隔离 rename 失败时必须 fail-closed 抛出，不得静默返回 [] 导致后续写覆盖原文件。
    if (process.platform !== 'win32' && process.getuid?.() !== 0) {
      const roProfile = join(root, 'profile-ro')
      mkdirSync(roProfile, { recursive: true })
      const roRegistry = join(roProfile, 'knowledge-bases.json')
      writeFileSync(roRegistry, '{"corrupt":')
      chmodSync(roProfile, 0o500)
      try {
        await expect(readKnowledgeBases(roProfile)).rejects.toThrow()
        expect(readFileSync(roRegistry, 'utf8')).toBe('{"corrupt":')
      } finally {
        chmodSync(roProfile, 0o700)
      }
    }
  })

  it('probes directory case sensitivity without creating files and handles non-ASCII leaf names', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kb-CaseProbe-'))
    const nonAsciiDir = join(root, '资料库')
    mkdirSync(nonAsciiDir, { recursive: true })
    const beforeRoot = readdirSync(root)
    const beforeLeaf = readdirSync(nonAsciiDir)
    const res1 = await probeCaseSensitiveDir(root)
    const res2 = await probeCaseSensitiveDir(nonAsciiDir)
    // Controller ruling: Linux is known case-sensitive; other platforms only assert a boolean.
    if (process.platform === 'linux') {
      expect(res1).toBe(true)
    } else {
      expect(typeof res1).toBe('boolean')
    }
    expect(typeof res2).toBe('boolean')
    expect(readdirSync(root)).toEqual(beforeRoot)
    expect(readdirSync(nonAsciiDir)).toEqual(beforeLeaf)
  })

  it('resolves worker URLs independently of caller chunk depth in both src (.ts, including zero-arg call) and lib (.js)', () => {
    const pkgRoot = fileURLToPath(new URL('../../', import.meta.url))
    const fromSrcDepth3 = pathToFileURL(join(pkgRoot, 'src', 'huaanwork-host', 'knowledge', 'storage-client.ts')).href
    const fromLibDepth2 = pathToFileURL(join(pkgRoot, 'lib', 'huaanwork-host', 'index.js')).href
    const fromLibDepth1Chunk = pathToFileURL(join(pkgRoot, 'lib', 'packaged-runtime-smoke.js')).href

    // R3-B2 regression: zero-arg call from Vitest source tree MUST resolve to src/.../*.ts, not lib/.../*.js
    expect(fileURLToPath(resolveKnowledgeWorkerUrl('storage-worker')))
      .toBe(join(pkgRoot, 'src', 'huaanwork-host', 'knowledge', 'storage-worker.ts'))
    expect(fileURLToPath(resolveKnowledgeWorkerUrl('storage-worker', fromSrcDepth3)))
      .toBe(join(pkgRoot, 'src', 'huaanwork-host', 'knowledge', 'storage-worker.ts'))
    expect(fileURLToPath(resolveKnowledgeWorkerUrl('storage-worker', fromLibDepth2)))
      .toBe(join(pkgRoot, 'lib', 'huaanwork-host', 'knowledge', 'storage-worker.js'))
    expect(fileURLToPath(resolveKnowledgeWorkerUrl('extraction-worker', fromLibDepth1Chunk)))
      .toBe(join(pkgRoot, 'lib', 'huaanwork-host', 'knowledge', 'extraction-worker.js'))
  })
})
