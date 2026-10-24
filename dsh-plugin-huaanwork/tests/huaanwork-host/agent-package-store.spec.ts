import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { parseAgentPackageManifest } from '../../src/huaanwork-host/agent-package/manifest.ts'
import {
  agentPackageBytes,
  agentPackageDir,
  agentPackageStatePath,
  agentPackagesRoot,
  assertAgentPackageSlugFree,
  listLocalAgentPackages,
  readAgentPackage,
  readAgentPackageFile,
  readAgentPackageState,
  setAgentPackageEnabled,
  writeAgentPackageAtomically,
  writeAgentPackageState,
  type WriteAgentPackageInput,
} from '../../src/huaanwork-host/agent-package/store.ts'
import type { AgentPackageManifest } from '../../src/huaanwork-host/agent-package/types.ts'

const VALID = {
  schemaVersion: 1,
  slug: 'weekly-report',
  displayName: '周报小助手',
  description: '把一周工作整理成周报',
  version: '1.0.0',
  draftId: 'draft-1',
  createdAt: '2026-10-23T00:00:00.000Z',
  updatedAt: '2026-10-23T00:00:00.000Z',
  persona: 'persona.md',
  skill: { entry: 'skill/SKILL.md', summary: '生成周报' },
  tools: { mode: 'none' },
  allowSkills: [],
}

const DEFAULT_PERSONA = '# 周报小助手\n把一周工作整理成周报。'
const DEFAULT_SKILL = {
  markdown: '---\nname: weekly-report\n---\n先收集本周工作,再生成周报。',
  scripts: [{ path: 'skill/scripts/collect.mjs', content: 'export const collect = true\n' }],
}

let roots: string[] = []

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
  roots = []
})

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'agent-package-store-'))
  roots.push(root)
  return root
}

function validManifest(overrides: Partial<AgentPackageManifest> = {}): AgentPackageManifest {
  const parsed = parseAgentPackageManifest({ ...VALID, ...overrides })
  if (!parsed.ok) {
    throw new Error(`test fixture manifest is invalid: ${JSON.stringify(parsed.fieldErrors)}`)
  }
  return parsed.manifest
}

function defaultSkill(manifest: AgentPackageManifest): WriteAgentPackageInput['skill'] {
  return manifest.skill === null ? null : DEFAULT_SKILL
}

function inputFor(
  root: string,
  manifest: AgentPackageManifest,
  overrides: Partial<WriteAgentPackageInput> = {},
): WriteAgentPackageInput {
  return {
    profileDir: root,
    manifest,
    persona: DEFAULT_PERSONA,
    skill: defaultSkill(manifest),
    replace: false,
    ...overrides,
  }
}

function writePackage(
  root: string,
  options: {
    manifest?: Partial<AgentPackageManifest>
    persona?: string
    skill?: WriteAgentPackageInput['skill']
    replace?: boolean
    httpServer?: string
    mcpServer?: string
  } = {},
): AgentPackageManifest {
  const manifest = validManifest(options.manifest)
  const input = inputFor(root, manifest, {
    persona: options.persona ?? DEFAULT_PERSONA,
    skill: options.skill === undefined ? defaultSkill(manifest) : options.skill,
    replace: options.replace ?? false,
  })
  if (manifest.tools.mode === 'http' || manifest.tools.mode === 'both') {
    input.httpServer = options.httpServer ?? 'export const http = true\n'
  } else if (options.httpServer !== undefined) {
    input.httpServer = options.httpServer
  }
  if (manifest.tools.mode === 'mcp' || manifest.tools.mode === 'both') {
    input.mcpServer = options.mcpServer ?? 'export const mcp = true\n'
  } else if (options.mcpServer !== undefined) {
    input.mcpServer = options.mcpServer
  }
  writeAgentPackageAtomically(input)
  return manifest
}

function writeRawPackage(
  root: string,
  directorySlug: string,
  manifest: unknown,
  files: Record<string, string> = {},
): string {
  const directory = join(agentPackagesRoot(root), directorySlug)
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'agent.json'), JSON.stringify(manifest), 'utf8')
  for (const [relativePath, content] of Object.entries(files)) {
    const target = join(directory, relativePath)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, content, 'utf8')
  }
  return directory
}

function listFiles(root: string, relativeDir = ''): string[] {
  const directory = relativeDir === '' ? root : join(root, relativeDir)
  const result: string[] = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const relativePath = relativeDir === '' ? entry.name : `${relativeDir}/${entry.name}`
    if (entry.isDirectory()) {
      result.push(...listFiles(root, relativePath))
      continue
    }
    result.push(relativePath)
  }
  return result.sort()
}

describe('agent package manifest', () => {
  test('rejects bad slug and displayName', () => {
    expect(parseAgentPackageManifest({ ...VALID, slug: 'Bad Slug' }).ok).toBe(false)
    expect(parseAgentPackageManifest({ ...VALID, displayName: '' }).ok).toBe(false)
  })

  test('rejects selected tool without entry and unselected tool with entry', () => {
    expect(parseAgentPackageManifest({ ...VALID, tools: { mode: 'http' } }).ok).toBe(false)
    expect(parseAgentPackageManifest({ ...VALID, tools: { mode: 'none', http: { entry: 'tools/http/server.mjs' } } }).ok).toBe(false)
  })

  test('accepts the valid manifest and trims display fields', () => {
    const result = parseAgentPackageManifest({
      ...VALID,
      displayName: '  周报小助手  ',
      description: '  把一周工作整理成周报  ',
      allowSkills: ['  skill-a  ', 'skill-b'],
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.manifest.displayName).toBe('周报小助手')
    expect(result.manifest.description).toBe('把一周工作整理成周报')
    expect(result.manifest.allowSkills).toEqual(['skill-a', 'skill-b'])
    expect(result.manifest.skill).toEqual({ entry: 'skill/SKILL.md', summary: '生成周报' })
  })

  test('rejects unknown fields at every level', () => {
    const cases: unknown[] = [
      { ...VALID, source: 'local' },
      { ...VALID, enabled: true },
      { ...VALID, skill: { ...VALID.skill, extra: true } },
      { ...VALID, tools: { mode: 'http', http: { entry: 'tools/http/server.mjs', extra: true } } },
      { ...VALID, tools: { mode: 'mcp', mcp: { entry: 'tools/mcp/server.mjs', extra: true } } },
    ]
    for (const value of cases) {
      expect(parseAgentPackageManifest(value).ok).toBe(false)
    }
  })

  test('enforces slug, name, description, and draft id limits', () => {
    expect(parseAgentPackageManifest({ ...VALID, slug: 'a'.repeat(32) }).ok).toBe(true)
    expect(parseAgentPackageManifest({ ...VALID, slug: 'a'.repeat(33) }).ok).toBe(false)
    expect(parseAgentPackageManifest({ ...VALID, displayName: '名'.repeat(40) }).ok).toBe(true)
    expect(parseAgentPackageManifest({ ...VALID, displayName: '名'.repeat(41) }).ok).toBe(false)
    expect(parseAgentPackageManifest({ ...VALID, description: '说'.repeat(200) }).ok).toBe(true)
    expect(parseAgentPackageManifest({ ...VALID, description: '说'.repeat(201) }).ok).toBe(false)
    expect(parseAgentPackageManifest({ ...VALID, draftId: 'd'.repeat(128) }).ok).toBe(true)
    expect(parseAgentPackageManifest({ ...VALID, draftId: 'd'.repeat(129) }).ok).toBe(false)
    expect(parseAgentPackageManifest({ ...VALID, schemaVersion: 2 }).ok).toBe(false)
    expect(parseAgentPackageManifest({ ...VALID, draftId: '   ' }).ok).toBe(false)
  })

  test('rejects invalid version, timestamps, persona, and allowSkills entries', () => {
    expect(parseAgentPackageManifest({ ...VALID, version: '1.0' }).ok).toBe(false)
    expect(parseAgentPackageManifest({ ...VALID, version: 'v1.0.0' }).ok).toBe(false)
    expect(parseAgentPackageManifest({ ...VALID, version: '1.0.0-beta.1+build.2' }).ok).toBe(true)
    expect(parseAgentPackageManifest({ ...VALID, createdAt: 'not-a-date' }).ok).toBe(false)
    expect(parseAgentPackageManifest({ ...VALID, updatedAt: '2026-10-23T00:00:00+08:00' }).ok).toBe(true)
    expect(parseAgentPackageManifest({ ...VALID, persona: 'other.md' }).ok).toBe(false)
    expect(parseAgentPackageManifest({ ...VALID, allowSkills: 'create-agent' }).ok).toBe(false)
    expect(parseAgentPackageManifest({ ...VALID, allowSkills: ['ok', 1] }).ok).toBe(false)
    expect(parseAgentPackageManifest({ ...VALID, allowSkills: [''] }).ok).toBe(false)
    expect(parseAgentPackageManifest({ ...VALID, allowSkills: ['create-agent'] }).ok).toBe(true)
    expect(parseAgentPackageManifest(null).ok).toBe(false)
    expect(parseAgentPackageManifest([]).ok).toBe(false)
  })

  test('validates skill entry and summary, and accepts null skill', () => {
    expect(parseAgentPackageManifest({ ...VALID, skill: null }).ok).toBe(true)
    expect(parseAgentPackageManifest({ ...VALID, skill: { entry: 'other/SKILL.md', summary: '生成周报' } }).ok).toBe(false)
    expect(parseAgentPackageManifest({ ...VALID, skill: { entry: 'skill/SKILL.md', summary: '' } }).ok).toBe(false)
    expect(
      parseAgentPackageManifest({ ...VALID, skill: { entry: 'skill/SKILL.md', summary: '摘'.repeat(201) } }).ok,
    ).toBe(false)
  })

  test('validates every tools mode and argumentsSchema bound', () => {
    for (const tools of [
      { mode: 'none' },
      { mode: 'http', http: { entry: 'tools/http/server.mjs' } },
      { mode: 'mcp', mcp: { entry: 'tools/mcp/server.mjs' } },
      {
        mode: 'both',
        http: { entry: 'tools/http/server.mjs' },
        mcp: { entry: 'tools/mcp/server.mjs' },
      },
    ]) {
      expect(parseAgentPackageManifest({ ...VALID, tools }).ok).toBe(true)
    }
    expect(parseAgentPackageManifest({ ...VALID, tools: { mode: 'both', http: { entry: 'tools/http/server.mjs' } } }).ok).toBe(false)
    expect(parseAgentPackageManifest({ ...VALID, tools: { mode: 'http', mcp: { entry: 'tools/mcp/server.mjs' } } }).ok).toBe(false)
    expect(parseAgentPackageManifest({ ...VALID, tools: { mode: 'http', http: { entry: 'server.mjs' } } }).ok).toBe(false)
    expect(parseAgentPackageManifest({ ...VALID, tools: { mode: 'bogus' } }).ok).toBe(false)

    const schemaOfLength = (length: number): unknown => ({ v: 'a'.repeat(length - JSON.stringify({ v: '' }).length) })
    expect(JSON.stringify(schemaOfLength(1024))).toHaveLength(1024)
    expect(
      parseAgentPackageManifest({
        ...VALID,
        tools: { mode: 'http', http: { entry: 'tools/http/server.mjs', argumentsSchema: schemaOfLength(1024) } },
      }).ok,
    ).toBe(true)
    expect(
      parseAgentPackageManifest({
        ...VALID,
        tools: { mode: 'http', http: { entry: 'tools/http/server.mjs', argumentsSchema: schemaOfLength(1025) } },
      }).ok,
    ).toBe(false)

    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(
      parseAgentPackageManifest({
        ...VALID,
        tools: { mode: 'http', http: { entry: 'tools/http/server.mjs', argumentsSchema: circular } },
      }).ok,
    ).toBe(false)
  })
})

describe('agent package store', () => {
  test('lists a broken card when agent.json is invalid', () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-package-store-'))
    mkdirSync(join(root, 'agents', 'bad'), { recursive: true })
    writeFileSync(join(root, 'agents', 'bad', 'agent.json'), '{"slug":"bad"}')
    const items = listLocalAgentPackages(root)
    expect(items[0]?.broken?.reason).toMatch(/manifest/i)
  })

  test('enabled defaults false and persists', () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-package-store-'))
    expect(readAgentPackageState(root)['local:weekly-report']?.enabled).toBeUndefined()
    setAgentPackageEnabled(root, 'weekly-report', true)
    expect(readAgentPackageState(root)['local:weekly-report']?.enabled).toBe(true)
  })

  test('writes only the declared file set and reads the detail', () => {
    const root = makeRoot()
    const manifest = writePackage(root, {
      manifest: {
        tools: {
          mode: 'both',
          http: { entry: 'tools/http/server.mjs' },
          mcp: { entry: 'tools/mcp/server.mjs' },
        },
      },
    })
    const packageDir = agentPackageDir(root, manifest.slug)

    expect(listFiles(packageDir)).toEqual([
      'agent.json',
      'persona.md',
      'skill/SKILL.md',
      'skill/scripts/collect.mjs',
      'tools/http/server.mjs',
      'tools/mcp/server.mjs',
    ])
    expect(JSON.parse(readFileSync(join(packageDir, 'agent.json'), 'utf8'))).toEqual(manifest)
    expect(agentPackagesRoot(root)).toBe(join(root, 'agents'))
    expect(agentPackageStatePath(root)).toBe(join(root, 'agents-state.json'))
    expect(readAgentPackageState(root)).toEqual({})

    const detail = readAgentPackage(root, manifest.slug)
    expect(detail).toBeDefined()
    expect(detail).toMatchObject({
      slug: 'weekly-report',
      displayName: '周报小助手',
      description: '把一周工作整理成周报',
      version: '1.0.0',
      source: 'local',
      enabled: false,
      persona: DEFAULT_PERSONA,
      tools: 'both',
      skill: {
        summary: '生成周报',
        markdown: DEFAULT_SKILL.markdown,
        scripts: ['skill/scripts/collect.mjs'],
      },
    })
    expect(detail?.broken).toBeUndefined()
    expect(detail?.files.map((file) => file.path)).toEqual(listFiles(packageDir))
    for (const file of detail?.files ?? []) expect(file.size).toBeGreaterThan(0)
  })

  test('refuses replace:false, swaps with replace:true, and removes the old directory', () => {
    const root = makeRoot()
    writePackage(root)
    writeFileSync(join(agentPackageDir(root, 'weekly-report'), 'stale.txt'), 'stale', 'utf8')

    expect(() => writePackage(root, { manifest: { displayName: '新名字' } })).toThrow(/已存在/)
    expect(readAgentPackage(root, 'weekly-report')?.displayName).toBe('周报小助手')

    writePackage(root, {
      replace: true,
      manifest: { displayName: '新名字', version: '1.0.1' },
      persona: '# 新版人设',
    })
    const detail = readAgentPackage(root, 'weekly-report')
    expect(detail?.displayName).toBe('新名字')
    expect(detail?.version).toBe('1.0.1')
    expect(detail?.persona).toBe('# 新版人设')
    expect(existsSync(join(agentPackageDir(root, 'weekly-report'), 'stale.txt'))).toBe(false)
    expect(readdirSync(agentPackagesRoot(root)).sort()).toEqual(['weekly-report'])
  })

  test('persists enabled state with the installed version', () => {
    const root = makeRoot()
    writePackage(root)
    setAgentPackageEnabled(root, 'weekly-report', true)
    expect(readAgentPackageState(root)['local:weekly-report']).toEqual({
      source: 'local',
      enabled: true,
      installedVersion: '1.0.0',
    })
    expect(listLocalAgentPackages(root)[0]?.enabled).toBe(true)
    setAgentPackageEnabled(root, 'weekly-report', false)
    expect(readAgentPackageState(root)['local:weekly-report']?.enabled).toBe(false)
  })

  test('tolerates malformed state and keeps only local entries', () => {
    const root = makeRoot()
    writeFileSync(agentPackageStatePath(root), '{ nope', 'utf8')
    expect(readAgentPackageState(root)).toEqual({})
    writeFileSync(
      agentPackageStatePath(root),
      JSON.stringify({
        'local:kept': { source: 'local', enabled: true, installedVersion: '1.0.0' },
        'local:broken': { source: 'local', enabled: 'yes' },
        'catalog:m2': { source: 'catalog', enabled: true, installedVersion: '1.0.0' },
      }),
      'utf8',
    )
    expect(readAgentPackageState(root)).toEqual({
      'local:kept': { source: 'local', enabled: true, installedVersion: '1.0.0' },
      'local:broken': { source: 'local', enabled: false, installedVersion: '' },
    })
  })

  test('writes state through a temporary file', () => {
    const root = makeRoot()
    writeAgentPackageState(root, {
      'local:weekly-report': { source: 'local', enabled: true, installedVersion: '1.0.0' },
    })
    expect(readdirSync(root).filter((name) => name.includes('.tmp'))).toEqual([])
    expect(readAgentPackageState(root)['local:weekly-report']?.enabled).toBe(true)
  })

  test('asserts slug availability against packages and caller-supplied names', () => {
    const root = makeRoot()
    expect(() => assertAgentPackageSlugFree(root, 'taken', ['taken'])).toThrow(/重名/)
    writePackage(root)
    expect(() => assertAgentPackageSlugFree(root, 'weekly-report', [])).toThrow(/已存在/)
    expect(() => assertAgentPackageSlugFree(root, 'fresh', ['other'])).not.toThrow()
    expect(() => assertAgentPackageSlugFree(root, 'Bad Slug', [])).toThrow(/无效/)
  })

  test('enforces per-file, count, and package byte caps', () => {
    const root = makeRoot()
    expect(() => writePackage(root, { persona: 'a'.repeat(32 * 1024 + 1) })).toThrow(/persona\.md/)
    expect(() => writePackage(root, { skill: { markdown: 'a'.repeat(32 * 1024 + 1), scripts: [] } })).toThrow(
      /skill\/SKILL\.md/,
    )
    expect(() =>
      writePackage(root, { skill: { markdown: 'x', scripts: [{ path: 'skill/scripts/big.mjs', content: 'a'.repeat(256 * 1024 + 1) }] } }),
    ).toThrow(/big\.mjs/)
    expect(() =>
      writePackage(root, {
        skill: {
          markdown: 'x',
          scripts: Array.from({ length: 21 }, (_, index) => ({ path: `skill/scripts/${index}.mjs`, content: 'x' })),
        },
      }),
    ).toThrow(/最多 20 个/)
    expect(() =>
      writePackage(root, {
        manifest: {
          tools: { mode: 'http', http: { entry: 'tools/http/server.mjs' } },
        },
        httpServer: 'a'.repeat(256 * 1024 + 1),
      }),
    ).toThrow(/tools\/http\/server\.mjs/)
    expect(() =>
      writePackage(root, {
        skill: {
          markdown: 'x',
          scripts: Array.from({ length: 20 }, (_, index) => ({
            path: `skill/scripts/${index}.mjs`,
            content: 'a'.repeat(256 * 1024),
          })),
        },
      }),
    ).toThrow(/智能体包超过/)
  })

  test('accepts exact per-file caps', () => {
    const root = makeRoot()
    expect(() =>
      writePackage(root, {
        persona: 'a'.repeat(32 * 1024),
        skill: {
          markdown: 'a'.repeat(32 * 1024),
          scripts: [{ path: 'skill/scripts/max.mjs', content: 'a'.repeat(256 * 1024) }],
        },
      }),
    ).not.toThrow()
  })

  test('agentPackageBytes counts exactly the files the writer emits', () => {
    const root = makeRoot()
    const manifest = writePackage(root, {
      manifest: {
        allowSkills: ['skill-a'],
        tools: {
          mode: 'both',
          http: { entry: 'tools/http/server.mjs' },
          mcp: { entry: 'tools/mcp/server.mjs' },
        },
      },
    })
    const packageDir = agentPackageDir(root, manifest.slug)
    const onDisk = listFiles(packageDir).reduce(
      (total, relativePath) => total + statSync(join(packageDir, relativePath)).size,
      0,
    )
    const budget = agentPackageBytes({
      manifest,
      persona: DEFAULT_PERSONA,
      skill: DEFAULT_SKILL,
      httpServer: 'export const http = true\n',
      mcpServer: 'export const mcp = true\n',
    })
    expect(budget).toBe(onDisk)
  })

  test('rejects missing and undeclared entry contents', () => {
    const root = makeRoot()
    const skillManifest = validManifest()
    expect(() =>
      writeAgentPackageAtomically(inputFor(root, validManifest({ skill: null }), { skill: DEFAULT_SKILL })),
    ).toThrow(/未声明 skill/)
    expect(() => writeAgentPackageAtomically(inputFor(root, skillManifest, { skill: null }))).toThrow(/缺少 skill/)
    expect(() =>
      writeAgentPackageAtomically(inputFor(root, skillManifest, { httpServer: 'x' })),
    ).toThrow(/未选择 HTTP/)
    expect(() =>
      writeAgentPackageAtomically(
        inputFor(root, validManifest({ tools: { mode: 'http', http: { entry: 'tools/http/server.mjs' } } })),
      ),
    ).toThrow(/缺少 tools\/http/)
    expect(() =>
      writeAgentPackageAtomically(
        inputFor(root, validManifest({ tools: { mode: 'mcp', mcp: { entry: 'tools/mcp/server.mjs' } } })),
      ),
    ).toThrow(/缺少 tools\/mcp/)
    expect(() =>
      writeAgentPackageAtomically(inputFor(root, skillManifest, { mcpServer: 'x' })),
    ).toThrow(/未选择 MCP/)
  })

  test('rejects traversal, absolute, misplaced, and duplicate script paths', () => {
    const root = makeRoot()
    const manifest = validManifest()
    const invalidPaths = [
      '../escape.mjs',
      '/abs.mjs',
      'skill/scripts/../../escape.mjs',
      'skill/scripts/./echo.mjs',
      'skill/scripts/',
      'skill/scripts/a b.mjs',
      'tools/http/server.mjs',
      'skill\\scripts\\echo.mjs',
    ]
    for (const path of invalidPaths) {
      expect(() =>
        writeAgentPackageAtomically(
          inputFor(root, manifest, { skill: { markdown: 'x', scripts: [{ path, content: 'x' }] } }),
        ),
      ).toThrow(/技能脚本/)
    }
    expect(() =>
      writeAgentPackageAtomically(
        inputFor(root, manifest, {
          skill: {
            markdown: 'x',
            scripts: [
              { path: 'skill/scripts/echo.mjs', content: 'x' },
              { path: 'skill/scripts/ECHO.mjs', content: 'x' },
            ],
          },
        }),
      ),
    ).toThrow(/重复/)
    expect(() =>
      writeAgentPackageAtomically(
        inputFor(root, manifest, {
          skill: { markdown: 'x', scripts: [{ path: 'skill/scripts/nested/echo.mjs', content: 'x' }] },
        }),
      ),
    ).not.toThrow()
    expect(readAgentPackage(root, 'weekly-report')?.skill?.scripts).toEqual(['skill/scripts/nested/echo.mjs'])
  })

  test('marks missing persona, missing tool entry, and slug mismatch as broken', () => {
    const root = makeRoot()
    writeRawPackage(root, 'missing-persona', { ...VALID, slug: 'missing-persona', skill: null })
    writeRawPackage(
      root,
      'missing-http',
      {
        ...VALID,
        slug: 'missing-http',
        skill: null,
        tools: { mode: 'http', http: { entry: 'tools/http/server.mjs' } },
      },
      { 'persona.md': '人设' },
    )
    writeRawPackage(root, 'wrong-directory', { ...VALID, slug: 'weekly-report', skill: null }, { 'persona.md': '人设' })

    const items = listLocalAgentPackages(root)
    expect(items.find((item) => item.slug === 'missing-persona')?.broken?.reason).toMatch(/persona/)
    expect(items.find((item) => item.slug === 'missing-http')?.broken?.reason).toMatch(/tools\/http/)
    expect(items.find((item) => item.slug === 'wrong-directory')?.broken?.reason).toMatch(/slug/)
    expect(readAgentPackage(root, 'missing-persona')?.broken?.reason).toMatch(/persona/)
    expect(readAgentPackage(root, 'missing-persona')?.persona).toBe('')
  })

  test('returns undefined for missing packages and invalid slugs', () => {
    const root = makeRoot()
    expect(readAgentPackage(root, 'missing')).toBeUndefined()
    expect(readAgentPackage(root, '../weekly-report')).toBeUndefined()
    expect(readAgentPackage(root, 'Bad Slug')).toBeUndefined()
    expect(readAgentPackage(root, 'a'.repeat(33))).toBeUndefined()
  })

  test('cleans temporary directories and restores interrupted replacements on read', () => {
    const root = makeRoot()
    const agentsRoot = agentPackagesRoot(root)
    const raw = { ...VALID, skill: null }
    const oldDir = writeRawPackage(root, '.old-weekly-report-abcdef123456', raw, { 'persona.md': '旧人设' })
    mkdirSync(join(agentsRoot, '.tmp-weekly-report-abcdef123456'), { recursive: true })
    writeFileSync(join(agentsRoot, '.tmp-weekly-report-abcdef123456', 'agent.json'), '{}', 'utf8')
    mkdirSync(join(agentsRoot, '.drafts'), { recursive: true })

    const detail = readAgentPackage(root, 'weekly-report')
    expect(detail?.persona).toBe('旧人设')
    expect(existsSync(oldDir)).toBe(false)
    expect(existsSync(join(agentsRoot, '.tmp-weekly-report-abcdef123456'))).toBe(false)
    expect(readdirSync(agentsRoot)).toContain('.drafts')

    const staleOld = writeRawPackage(root, '.old-weekly-report-fedcba654321', raw, { 'persona.md': '过期备份' })
    const items = listLocalAgentPackages(root)
    expect(items.map((item) => item.slug)).toEqual(['weekly-report'])
    expect(items[0]?.broken).toBeUndefined()
    expect(existsSync(staleOld)).toBe(false)
    expect(readdirSync(agentsRoot).sort()).toEqual(['.drafts', 'weekly-report'])
  })

  test('ignores dot entries, files, and invalid directory slugs', () => {
    const root = makeRoot()
    mkdirSync(join(agentPackagesRoot(root), '.drafts'), { recursive: true })
    mkdirSync(join(agentPackagesRoot(root), '.hidden'), { recursive: true })
    writeFileSync(join(agentPackagesRoot(root), 'notes.txt'), 'x', 'utf8')
    mkdirSync(join(agentPackagesRoot(root), 'Bad Slug'), { recursive: true })
    writeFileSync(join(agentPackagesRoot(root), 'Bad Slug', 'agent.json'), '{}', 'utf8')
    expect(listLocalAgentPackages(root)).toEqual([])
  })

  test.skipIf(process.platform === 'win32')('does not read package files through symlinks', () => {
    const root = makeRoot()
    const packageDir = writeRawPackage(root, 'linked', { ...VALID, slug: 'linked', skill: null })
    const secret = join(root, 'secret.txt')
    writeFileSync(secret, 'SECRET', 'utf8')
    symlinkSync(secret, join(packageDir, 'persona.md'))

    expect(listLocalAgentPackages(root)[0]?.broken?.reason).toMatch(/persona/)
    expect(readAgentPackage(root, 'linked')?.persona).toBe('')
    expect(readAgentPackage(root, 'linked')?.files.map((file) => file.path)).not.toContain('persona.md')
  })

  test.skipIf(process.platform === 'win32')('readAgentPackageFile refuses symlinked segments and invalid slugs', () => {
    const root = makeRoot()
    const packageDir = writeRawPackage(root, 'linked-file', { ...VALID, slug: 'linked-file', skill: null })
    const secret = join(root, 'secret.txt')
    writeFileSync(secret, 'SECRET', 'utf8')
    symlinkSync(secret, join(packageDir, 'persona.md'))

    expect(readAgentPackageFile(root, 'linked-file', 'persona.md')).toBeUndefined()
    expect(readAgentPackageFile(root, 'linked-file', 'missing.md')).toBeUndefined()
    expect(readAgentPackageFile(root, 'linked-file', '../agent.json')).toBeUndefined()
    expect(readAgentPackageFile(root, 'linked-file', 'skill/../agent.json')).toBeUndefined()
    expect(readAgentPackageFile(root, 'Bad Slug', 'persona.md')).toBeUndefined()
    expect(readAgentPackageFile(root, 'linked-file', 'agent.json')).toBeDefined()
  })

  test.skipIf(process.platform === 'win32')('does not list package directories that are symlinks', () => {
    const root = makeRoot()
    const outside = join(root, 'outside')
    mkdirSync(outside, { recursive: true })
    writeRawPackage(root, 'linked-directory', { ...VALID, slug: 'linked-directory', skill: null }, { 'persona.md': 'x' })
    rmSync(join(agentPackagesRoot(root), 'linked-directory'), { recursive: true, force: true })
    symlinkSync(outside, join(agentPackagesRoot(root), 'linked-directory'))

    expect(listLocalAgentPackages(root).map((item) => item.slug)).not.toContain('linked-directory')
    expect(readAgentPackage(root, 'linked-directory')).toBeUndefined()
  })
})
