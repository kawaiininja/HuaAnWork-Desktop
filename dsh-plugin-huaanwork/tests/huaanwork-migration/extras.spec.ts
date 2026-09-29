import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  createMigrateNeutralWorkspaceStep,
  createMigrateUserSkillsStep,
  migrateAgentsConfigStep,
  migrateNeutralWorkspaceStep,
  migrateSkillTogglesStep,
  migrateUserSkillsStep,
} from '../../src/huaanwork-migration/extras.ts'
import * as barrel from '../../src/huaanwork-migration/index.ts'
import { resolveLegacySource } from '../../src/huaanwork-migration/paths.ts'
import { createMigrationReport } from '../../src/huaanwork-migration/report.ts'

/**
 * 树外载荷的字节标记:两个 symlink 安全门用它做逐字节搜索,证明树外内容
 * **没有**被搬进 profile 目录。用自建文件而不是 /etc/passwd(平台无关)。
 */
const OUTSIDE_BYTES = 'out-of-tree-payload-that-must-not-migrate\n'

function fixture() {
  const userData = mkdtempSync(join(tmpdir(), 'mig-extras-'))
  const dshHome = join(userData, 'dsh')
  mkdirSync(dshHome, { recursive: true })
  const homeDir = mkdtempSync(join(tmpdir(), 'mig-extras-home-'))
  const profileDir = join(homeDir, 'profiles', 'desktop')
  mkdirSync(profileDir, { recursive: true })
  return { source: resolveLegacySource(userData), target: { homeDir, profileDir }, userData, dshHome, homeDir, profileDir }
}

/** 目的树内所有常规文件的路径(不跟随 symlink;根不存在时返回空)。 */
function filePathsUnder(root: string): string[] {
  if (!existsSync(root)) return []
  const found: string[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) found.push(...filePathsUnder(path))
    else if (entry.isFile()) found.push(path)
  }
  return found
}

/** 目的树内是否存在含树外载荷字节的文件(symlink 安全门的统一断言)。 */
function treeCarriesOutsideBytes(root: string): boolean {
  return filePathsUnder(root).some((path) => readFileSync(path).includes(OUTSIDE_BYTES))
}

describe('migrateAgentsConfigStep', () => {
  it('copies both agents config files into the profile directory', async () => {
    const f = fixture()
    const enabled = '{\n  "catalog:review": true,\n  "catalog:qa": false\n}\n'
    const endpoints =
      '{\n  "entries": [\n    {\n      "name": "db",\n      "kind": "tool",\n      "entrypoint": { "kind": "http", "url": "http://192.168.1.9:7777/mcp" }\n    }\n  ]\n}\n'
    writeFileSync(join(f.dshHome, 'agents-enabled.json'), enabled, 'utf8')
    writeFileSync(join(f.dshHome, 'agents-endpoints.json'), endpoints, 'utf8')
    const report = createMigrationReport()
    await migrateAgentsConfigStep.run(f.source, f.target, report)
    expect(readFileSync(join(f.profileDir, 'agents-enabled.json'), 'utf8')).toBe(enabled)
    expect(readFileSync(join(f.profileDir, 'agents-endpoints.json'), 'utf8')).toBe(endpoints)
    expect(report.counts.agentsEnabled).toBe(1)
    expect(report.counts.agentsEndpoints).toBe(1)
    expect(report.skipped).toEqual([])
  })

  it('copies each file independently when only one exists', async () => {
    const f = fixture()
    writeFileSync(join(f.dshHome, 'agents-enabled.json'), '{"catalog:review":true}\n', 'utf8')
    const report = createMigrationReport()
    await migrateAgentsConfigStep.run(f.source, f.target, report)
    expect(existsSync(join(f.profileDir, 'agents-enabled.json'))).toBe(true)
    expect(existsSync(join(f.profileDir, 'agents-endpoints.json'))).toBe(false)
    expect(report.counts.agentsEnabled).toBe(1)
    expect(report.counts.agentsEndpoints).toBeUndefined()
  })

  it('refuses a document that is not a JSON record', async () => {
    const f = fixture()
    writeFileSync(join(f.dshHome, 'agents-enabled.json'), '["catalog:review"]\n', 'utf8')
    writeFileSync(join(f.dshHome, 'agents-endpoints.json'), '"just a string"\n', 'utf8')
    const report = createMigrationReport()
    await migrateAgentsConfigStep.run(f.source, f.target, report)
    expect(existsSync(join(f.profileDir, 'agents-enabled.json'))).toBe(false)
    expect(existsSync(join(f.profileDir, 'agents-endpoints.json'))).toBe(false)
    expect(report.skipped).toContain('agents-enabled.json: not a JSON record')
    expect(report.skipped).toContain('agents-endpoints.json: not a JSON record')
    expect(report.counts.agentsEnabled).toBeUndefined()
    expect(report.counts.agentsEndpoints).toBeUndefined()
  })

  it('never overwrites agent config the new app already wrote', async () => {
    const f = fixture()
    writeFileSync(join(f.dshHome, 'agents-enabled.json'), '{"catalog:legacy":true}\n', 'utf8')
    writeFileSync(join(f.profileDir, 'agents-enabled.json'), '{"catalog:current":true}\n', 'utf8')
    const report = createMigrationReport()
    await migrateAgentsConfigStep.run(f.source, f.target, report)
    expect(readFileSync(join(f.profileDir, 'agents-enabled.json'), 'utf8')).toBe('{"catalog:current":true}\n')
    expect(report.skipped).toContain('agents-enabled.json: destination already exists')
    expect(report.counts.agentsEnabled).toBeUndefined()
  })
})

describe('migrateSkillTogglesStep', () => {
  it('copies the toggle map so user-enabled skills stay enabled', async () => {
    const f = fixture()
    writeFileSync(join(f.dshHome, 'skill-toggles.json'), '{"explore":true,"qa":false}\n', 'utf8')
    const report = createMigrationReport()
    await migrateSkillTogglesStep.run(f.source, f.target, report)
    expect(JSON.parse(readFileSync(join(f.profileDir, 'skill-toggles.json'), 'utf8'))).toEqual({
      explore: true,
      qa: false,
    })
    expect(report.counts.skillToggles).toBe(1)
    expect(report.skipped).toEqual([])
  })

  it('never overwrites toggles the new app already wrote', async () => {
    const f = fixture()
    writeFileSync(join(f.dshHome, 'skill-toggles.json'), '{"explore":true}\n', 'utf8')
    writeFileSync(join(f.profileDir, 'skill-toggles.json'), '{"qa":true}\n', 'utf8')
    const report = createMigrationReport()
    await migrateSkillTogglesStep.run(f.source, f.target, report)
    expect(JSON.parse(readFileSync(join(f.profileDir, 'skill-toggles.json'), 'utf8'))).toEqual({ qa: true })
    expect(report.skipped).toContain('skill-toggles.json: destination already exists')
    expect(report.counts.skillToggles).toBeUndefined()
  })

  it('refuses a document that is not a JSON record', async () => {
    const f = fixture()
    writeFileSync(join(f.dshHome, 'skill-toggles.json'), 'true\n', 'utf8')
    const report = createMigrationReport()
    await migrateSkillTogglesStep.run(f.source, f.target, report)
    expect(existsSync(join(f.profileDir, 'skill-toggles.json'))).toBe(false)
    expect(report.skipped).toContain('skill-toggles.json: not a JSON record')
    expect(report.counts.skillToggles).toBeUndefined()
  })
})

describe('migrateUserSkillsStep', () => {
  it('copies the whole user skills tree, preserving both layouts', async () => {
    const f = fixture()
    const skillsRoot = join(f.dshHome, 'skills')
    mkdirSync(join(skillsRoot, 'alpha', 'scripts'), { recursive: true })
    writeFileSync(join(skillsRoot, 'alpha', 'SKILL.md'), '# alpha\n', 'utf8')
    writeFileSync(join(skillsRoot, 'alpha', 'scripts', 'run.mjs'), 'console.log(1)\n', 'utf8')
    writeFileSync(join(skillsRoot, 'beta.md'), '# beta\n', 'utf8')
    const report = createMigrationReport()
    await migrateUserSkillsStep.run(f.source, f.target, report)
    const destinationRoot = join(f.profileDir, 'skills')
    for (const segments of [['alpha', 'SKILL.md'], ['alpha', 'scripts', 'run.mjs'], ['beta.md']]) {
      const from = join(skillsRoot, ...segments)
      const to = join(destinationRoot, ...segments)
      expect(existsSync(to)).toBe(true)
      expect(readFileSync(to).equals(readFileSync(from))).toBe(true)
    }
    // 三个文件、两个技能(alpha 包 + beta 扁平)—— 计数的是技能不是文件。
    expect(report.counts.skills).toBe(2)
    expect(report.skipped).toEqual([])
  })

  it('skips the reserved .system directory at the skills root', async () => {
    const f = fixture()
    const skillsRoot = join(f.dshHome, 'skills')
    mkdirSync(join(skillsRoot, '.system'), { recursive: true })
    writeFileSync(join(skillsRoot, '.system', 'hidden.md'), '# hidden\n', 'utf8')
    writeFileSync(join(skillsRoot, 'beta.md'), '# beta\n', 'utf8')
    // 包内的 .system 是 alpha 自己的资源(读侧随 resourceBase 一起提供),必须照搬。
    mkdirSync(join(skillsRoot, 'alpha', '.system'), { recursive: true })
    writeFileSync(join(skillsRoot, 'alpha', 'SKILL.md'), '# alpha\n', 'utf8')
    writeFileSync(join(skillsRoot, 'alpha', '.system', 'note.md'), '# note\n', 'utf8')
    const report = createMigrationReport()
    await migrateUserSkillsStep.run(f.source, f.target, report)
    const destinationRoot = join(f.profileDir, 'skills')
    expect(existsSync(join(destinationRoot, '.system'))).toBe(false)
    expect(existsSync(join(destinationRoot, 'beta.md'))).toBe(true)
    expect(readFileSync(join(destinationRoot, 'alpha', '.system', 'note.md'), 'utf8')).toBe('# note\n')
    expect(report.counts.skills).toBe(2)
  })

  it('does not follow symlinks out of the skills tree', async () => {
    const f = fixture()
    const outside = mkdtempSync(join(tmpdir(), 'mig-extras-outside-'))
    writeFileSync(join(outside, 'secret.txt'), OUTSIDE_BYTES, 'utf8')
    mkdirSync(join(outside, 'payload'), { recursive: true })
    writeFileSync(join(outside, 'payload', 'nested.txt'), OUTSIDE_BYTES, 'utf8')
    const skillsRoot = join(f.dshHome, 'skills')
    mkdirSync(join(skillsRoot, 'alpha', 'scripts'), { recursive: true })
    writeFileSync(join(skillsRoot, 'alpha', 'SKILL.md'), '# alpha\n', 'utf8')
    writeFileSync(join(skillsRoot, 'alpha', 'scripts', 'run.mjs'), 'console.log(1)\n', 'utf8')
    writeFileSync(join(skillsRoot, 'beta.md'), '# beta\n', 'utf8')
    symlinkSync(join(outside, 'secret.txt'), join(skillsRoot, 'link-file'))
    symlinkSync(join(outside, 'payload'), join(skillsRoot, 'link-dir'))
    symlinkSync(join(outside, 'secret.txt'), join(skillsRoot, 'alpha', 'scripts', 'link-nested'))
    const report = createMigrationReport()
    await migrateUserSkillsStep.run(f.source, f.target, report)
    const destinationRoot = join(f.profileDir, 'skills')
    expect(existsSync(join(destinationRoot, 'link-file'))).toBe(false)
    expect(existsSync(join(destinationRoot, 'link-dir'))).toBe(false)
    expect(existsSync(join(destinationRoot, 'alpha', 'scripts', 'link-nested'))).toBe(false)
    expect(readFileSync(join(destinationRoot, 'beta.md'), 'utf8')).toBe('# beta\n')
    expect(readFileSync(join(destinationRoot, 'alpha', 'scripts', 'run.mjs'), 'utf8')).toBe('console.log(1)\n')
    expect(report.skipped).toContain('link-file: symlink, not copied')
    expect(report.skipped).toContain('link-dir: symlink, not copied')
    expect(report.skipped).toContain(join('alpha', 'scripts', 'link-nested') + ': symlink, not copied')
    expect(treeCarriesOutsideBytes(destinationRoot)).toBe(false)
  })

  it('never merges into a skills tree the new app already wrote', async () => {
    const f = fixture()
    const skillsRoot = join(f.dshHome, 'skills')
    mkdirSync(skillsRoot, { recursive: true })
    writeFileSync(join(skillsRoot, 'beta.md'), '# beta\n', 'utf8')
    const destinationRoot = join(f.profileDir, 'skills')
    mkdirSync(destinationRoot, { recursive: true })
    writeFileSync(join(destinationRoot, 'mine.md'), '# mine\n', 'utf8')
    const report = createMigrationReport()
    await migrateUserSkillsStep.run(f.source, f.target, report)
    expect(existsSync(join(destinationRoot, 'beta.md'))).toBe(false)
    expect(readFileSync(join(destinationRoot, 'mine.md'), 'utf8')).toBe('# mine\n')
    expect(report.skipped).toContain('skills: destination already exists')
    expect(report.counts.skills).toBeUndefined()
  })

  it('stops at the injected size cap and keeps the usable partial tree', async () => {
    const f = fixture()
    const skillsRoot = join(f.dshHome, 'skills')
    mkdirSync(join(skillsRoot, 'alpha'), { recursive: true })
    writeFileSync(join(skillsRoot, 'alpha', 'SKILL.md'), '# alpha\n', 'utf8')
    writeFileSync(join(skillsRoot, 'big.bin'), Buffer.alloc(4096, 0x62))
    const report = createMigrationReport()
    await createMigrateUserSkillsStep({ maxTotalBytes: 1024 }).run(f.source, f.target, report)
    const destinationRoot = join(f.profileDir, 'skills')
    expect(existsSync(join(destinationRoot, 'alpha', 'SKILL.md'))).toBe(true)
    expect(existsSync(join(destinationRoot, 'big.bin'))).toBe(false)
    expect(report.counts.skills).toBe(1)
    expect(report.skipped).toContain('skills: exceeds the migration size cap, the copied tree is partial')
  })

  it('is a no-op when the source tree is absent', async () => {
    const f = fixture()
    const report = createMigrationReport()
    await migrateUserSkillsStep.run(f.source, f.target, report)
    expect(existsSync(join(f.profileDir, 'skills'))).toBe(false)
    expect(report.counts.skills).toBeUndefined()
    expect(report.skipped).toEqual([])
  })
})

describe('migrateNeutralWorkspaceStep', () => {
  it('copies the neutral root contents so migrated sessions still resolve their artifacts', async () => {
    const f = fixture()
    const workspaceRoot = join(f.dshHome, 'workspace')
    mkdirSync(join(workspaceRoot, 'sub'), { recursive: true })
    writeFileSync(join(workspaceRoot, 'notes.md'), 'notes\n', 'utf8')
    writeFileSync(join(workspaceRoot, 'sub', 'out.txt'), 'out\n', 'utf8')
    const report = createMigrationReport()
    await migrateNeutralWorkspaceStep.run(f.source, f.target, report)
    const destinationRoot = join(f.profileDir, 'workspace')
    expect(readFileSync(join(destinationRoot, 'notes.md'), 'utf8')).toBe('notes\n')
    expect(readFileSync(join(destinationRoot, 'sub', 'out.txt'), 'utf8')).toBe('out\n')
    expect(report.counts.workspaceFiles).toBe(2)
    expect(report.skipped).toEqual([])
  })

  it('merges into an existing neutral root without overwriting', async () => {
    const f = fixture()
    const workspaceRoot = join(f.dshHome, 'workspace')
    mkdirSync(workspaceRoot, { recursive: true })
    writeFileSync(join(workspaceRoot, 'notes.md'), 'legacy notes\n', 'utf8')
    writeFileSync(join(workspaceRoot, 'extra.txt'), 'legacy extra\n', 'utf8')
    const destinationRoot = join(f.profileDir, 'workspace')
    mkdirSync(destinationRoot, { recursive: true })
    writeFileSync(join(destinationRoot, 'notes.md'), 'current notes\n', 'utf8')
    const report = createMigrationReport()
    await migrateNeutralWorkspaceStep.run(f.source, f.target, report)
    expect(readFileSync(join(destinationRoot, 'notes.md'), 'utf8')).toBe('current notes\n')
    expect(readFileSync(join(destinationRoot, 'extra.txt'), 'utf8')).toBe('legacy extra\n')
    expect(report.counts.workspaceFiles).toBe(1)
    expect(report.skipped).toContain('workspace: 1 destination file(s) already existed and were left in place')
  })

  it('refuses to copy a tree whose total size exceeds the migration cap', async () => {
    const f = fixture()
    const workspaceRoot = join(f.dshHome, 'workspace')
    mkdirSync(workspaceRoot, { recursive: true })
    for (const name of ['a.bin', 'b.bin', 'c.bin']) writeFileSync(join(workspaceRoot, name), Buffer.alloc(512, 0x61))
    const report = createMigrationReport()
    await createMigrateNeutralWorkspaceStep({ maxTotalBytes: 1024 }).run(f.source, f.target, report)
    const destinationRoot = join(f.profileDir, 'workspace')
    expect(existsSync(join(destinationRoot, 'a.bin'))).toBe(true)
    expect(existsSync(join(destinationRoot, 'b.bin'))).toBe(true)
    // 两份 512 字节恰好用满 1 KiB 上限,第三份起停止复制:半份树保留。
    expect(existsSync(join(destinationRoot, 'c.bin'))).toBe(false)
    expect(report.counts.workspaceFiles).toBe(2)
    expect(report.skipped).toContain('workspace: exceeds the migration size cap, the copied tree is partial')
  })

  it('does not follow symlinks out of the workspace', async () => {
    const f = fixture()
    const outside = mkdtempSync(join(tmpdir(), 'mig-extras-outside-'))
    writeFileSync(join(outside, 'secret.txt'), OUTSIDE_BYTES, 'utf8')
    const workspaceRoot = join(f.dshHome, 'workspace')
    mkdirSync(workspaceRoot, { recursive: true })
    writeFileSync(join(workspaceRoot, 'notes.md'), 'notes\n', 'utf8')
    symlinkSync(join(outside, 'secret.txt'), join(workspaceRoot, 'leak.txt'))
    const report = createMigrationReport()
    await migrateNeutralWorkspaceStep.run(f.source, f.target, report)
    const destinationRoot = join(f.profileDir, 'workspace')
    expect(existsSync(join(destinationRoot, 'leak.txt'))).toBe(false)
    expect(report.skipped).toContain('leak.txt: symlink, not copied')
    expect(treeCarriesOutsideBytes(destinationRoot)).toBe(false)
  })

  it('is a no-op when the source tree is absent', async () => {
    const f = fixture()
    const report = createMigrationReport()
    await migrateNeutralWorkspaceStep.run(f.source, f.target, report)
    expect(report.counts.workspaceFiles).toBeUndefined()
    expect(report.skipped).toEqual([])
  })
})

describe('the migration barrel', () => {
  it('re-exports the four gap steps under their frozen names', () => {
    expect([
      barrel.migrateAgentsConfigStep.name,
      barrel.migrateSkillTogglesStep.name,
      barrel.migrateUserSkillsStep.name,
      barrel.migrateNeutralWorkspaceStep.name,
    ]).toEqual(['agents-config', 'skill-toggles', 'user-skills', 'neutral-workspace'])
  })

  it('keeps the injectable-limits factories internal to the module', () => {
    expect(Object.keys(barrel)).not.toContain('createMigrateUserSkillsStep')
    expect(Object.keys(barrel)).not.toContain('createMigrateNeutralWorkspaceStep')
  })
})
