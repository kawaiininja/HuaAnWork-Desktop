import { chmodSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  neutralKnowledgeBaseDir,
  neutralKnowledgeRootPath,
  neutralKnowledgeWikiRootPath,
} from '../../src/huaanwork-host/workspace-state.ts'
import { writeHuaanworkSettings } from '../../src/huaanwork-host/settings.ts'
import {
  foldAsciiPath,
  inspectUncSymlinkTargetsTopDown,
  isUncOrDevicePath,
  normalizeResolvedLocalPath,
  probeCaseSensitiveDir,
  validateSourceDir,
} from '../../src/huaanwork-host/knowledge/paths.ts'
import { resolveKnowledgeWorkerUrl } from '../../src/huaanwork-host/knowledge/worker-paths.ts'
import { readKnowledgeBases, writeKnowledgeBases } from '../../src/huaanwork-host/knowledge/registry.ts'

const DIR_SYMLINK_TYPE = process.platform === 'win32' ? 'junction' : 'dir'
const createdTempDirs: string[] = []
function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  createdTempDirs.push(dir)
  return dir
}

describe('knowledge registry, sourceDir validation, and worker path resolution', () => {
  afterEach(() => {
    for (const dir of createdTempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })
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

    // I-5（D11）：直接传入 UNC 字符串或符号链接指向 UNC/设备路径均必须拒绝。
    await expect(validateSourceDir({ sourceDir: '\\\\server\\share\\docs', profileDir, existing: [] })).resolves.toMatchObject({ ok: false })
    await expect(validateSourceDir({ sourceDir: '//server/share/docs', profileDir, existing: [] })).resolves.toMatchObject({ ok: false })
    if (process.platform !== 'win32') {
      const uncLinkPosix = join(root, 'link-unc-posix')
      const uncLinkWin = join(root, 'link-unc-win')
      symlinkSync('//server/share/docs', uncLinkPosix)
      symlinkSync('\\\\?\\UNC\\server\\share\\docs', uncLinkWin)
      await expect(validateSourceDir({ sourceDir: uncLinkPosix, profileDir, existing: [] })).resolves.toMatchObject({ ok: false })
      await expect(validateSourceDir({ sourceDir: join(uncLinkPosix, 'nested'), profileDir, existing: [] })).resolves.toMatchObject({ ok: false })
      await expect(validateSourceDir({ sourceDir: uncLinkWin, profileDir, existing: [] })).resolves.toMatchObject({ ok: false })
    }
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
    // M-3：缺失文件返回 []；畸形记录与非法 kbId 被丢弃，同文件中的合法记录保留。
    const missingProfile = join(root, 'profile-missing')
    mkdirSync(missingProfile, { recursive: true })
    await expect(readKnowledgeBases(missingProfile)).resolves.toEqual([])

    const mixedProfile = join(root, 'profile-mixed')
    mkdirSync(mixedProfile, { recursive: true })
    const validRecord = {
      id: 'kb-valid',
      name: '合法库',
      sourceDir: validDocsDir,
      autoOrganize: true,
      watchPaused: false,
      createdAt: '2026-11-26T00:00:00.000Z',
    }
    writeFileSync(
      join(mixedProfile, 'knowledge-bases.json'),
      JSON.stringify({
        knowledgeBases: [
          { ...validRecord, id: '../escape' },
          { id: 'kb-bad', name: '', sourceDir: validDocsDir, autoOrganize: true, watchPaused: false, createdAt: '2026-11-26T00:00:00.000Z' },
          validRecord,
        ],
      }),
    )
    await expect(readKnowledgeBases(mixedProfile)).resolves.toEqual([validRecord])
  })

  it('probes directory case sensitivity without creating files, agrees with actual volume semantics (M-3), and handles non-ASCII leaf names', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kb-CaseProbe-'))
    const nonAsciiDir = join(root, '资料库')
    mkdirSync(nonAsciiDir, { recursive: true })
    const beforeRoot = readdirSync(root)
    const beforeLeaf = readdirSync(nonAsciiDir)
    const res1 = await probeCaseSensitiveDir(root)
    const res2 = await probeCaseSensitiveDir(nonAsciiDir)
    // 与测试独立创建的对照目录比对真实卷行为（兼顾 M-24 大小写敏感 APFS 与 M-3 击穿硬编码平台桩）。
    const checkDir = mkdtempSync(join(tmpdir(), 'kb-case-oracle-'))
    const lowerDir = join(checkDir, 'alpha')
    const upperDir = join(checkDir, 'ALPHA')
    mkdirSync(lowerDir)
    let volumeIsCaseSensitive = true
    try {
      const sLower = statSync(lowerDir, { bigint: true })
      const sUpper = statSync(upperDir, { bigint: true })
      volumeIsCaseSensitive = !(sLower.dev === sUpper.dev && sLower.ino === sUpper.ino)
    } catch {
      volumeIsCaseSensitive = true
    }
    expect(res1).toBe(volumeIsCaseSensitive)
    expect(res2).toBe(volumeIsCaseSensitive)
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
    // 找不到 package.json 时应显式抛可读错误而非返回错误根路径。
    const orphanRoot = makeTempDir('kb-no-pkg-')
    const orphanFile = pathToFileURL(join(orphanRoot, 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'x.js')).href
    expect(() => resolveKnowledgeWorkerUrl('storage-worker', orphanFile)).toThrow(/package\.json/u)
  })

  it('enforces top-down UNC/device pre-check (C-4), locale-independent ASCII folding (M-4), Windows \\\\?\\ stripping (I-5), and serialized corrupt quarantine (I-10/M-6)', async () => {
    // C-4: mixed-slash UNC & NT object paths rejected
    expect(isUncOrDevicePath('\\/server/share/docs')).toBe(true)
    expect(isUncOrDevicePath('/\\server\\share\\docs')).toBe(true)
    expect(isUncOrDevicePath('\\??\\UNC\\server\\share')).toBe(true)
    expect(isUncOrDevicePath('\\??\\C:\\docs')).toBe(true)
    expect(normalizeResolvedLocalPath('\\\\?\\C:\\Users\\docs')).toBe('C:\\Users\\docs')
    expect(normalizeResolvedLocalPath('\\\\?\\UNC\\server\\share')).toBeNull()
    expect(normalizeResolvedLocalPath('\\??\\UNC\\server\\share')).toBeNull()
    // M-4: ASCII-only folding
    expect(foldAsciiPath('C:\\Docs\\AbC_İ')).toBe('c:\\docs\\abc_İ')

    const root = makeTempDir('kb-c4-i10-')
    const profileDir = join(root, 'profile')
    const validDocs = join(root, 'valid')
    mkdirSync(profileDir, { recursive: true })
    mkdirSync(validDocs, { recursive: true })

    if (process.platform !== 'win32') {
      const uncLink = join(root, 'unc-link')
      symlinkSync('\\\\server\\share\\docs', uncLink)
      // C-4：未折叠的 `${uncLink}/../valid` 仍必须在进入 realpath 之前被自顶向下预检拦住。
      await expect(inspectUncSymlinkTargetsTopDown(`${uncLink}/../valid`)).resolves.toBe('unc-target')
      await expect(validateSourceDir({ sourceDir: `${uncLink}/../valid`, profileDir, existing: [] }))
        .resolves.toMatchObject({ ok: false })
      await expect(inspectUncSymlinkTargetsTopDown(join(uncLink, 'sub', 'deep'))).resolves.toBe('unc-target')

      // C-4：超过 32 跳符号链接循环 fail-closed 返回 too-many-hops。
      const loopA = join(root, 'loop-a')
      const loopB = join(root, 'loop-b')
      symlinkSync(loopB, loopA)
      symlinkSync(loopA, loopB)
      await expect(inspectUncSymlinkTargetsTopDown(loopA)).resolves.toBe('too-many-hops')
      await expect(validateSourceDir({ sourceDir: loopA, profileDir, existing: [] }))
        .resolves.toMatchObject({ ok: false })
    }

    // I-10：并发读损坏注册表不抛 ENOENT，且与并发 writeKnowledgeBases 串行化不误隔离新写入的有效文件。
    const regPath = join(profileDir, 'knowledge-bases.json')
    writeFileSync(regPath, '{corrupt')
    const validRec = {
      id: 'kb-race',
      name: '并发库',
      sourceDir: validDocs,
      autoOrganize: true,
      watchPaused: false,
      createdAt: '2026-11-26T00:00:00.000Z',
    }
    const [r1, r2] = await Promise.all([
      readKnowledgeBases(profileDir),
      readKnowledgeBases(profileDir),
      writeKnowledgeBases(profileDir, [validRec]),
    ])
    expect(Array.isArray(r1)).toBe(true)
    expect(Array.isArray(r2)).toBe(true)
    // 并发写完后磁盘上必须仍是有效注册表（绝不被后到的损坏隔离 rename 掉）。
    await expect(readKnowledgeBases(profileDir)).resolves.toEqual([validRec])

    // M-6：去重重复 id，并丢弃被篡改为 UNC 或空白 sourceDir 的记录。
    writeFileSync(regPath, JSON.stringify({
      knowledgeBases: [
        validRec,
        { ...validRec, name: '重复ID' },
        { ...validRec, id: 'kb-unc', sourceDir: '\\\\evil\\share' },
        { ...validRec, id: 'kb-blank', sourceDir: '   ' },
      ],
    }))
    await expect(readKnowledgeBases(profileDir)).resolves.toEqual([validRec])
  })
})
