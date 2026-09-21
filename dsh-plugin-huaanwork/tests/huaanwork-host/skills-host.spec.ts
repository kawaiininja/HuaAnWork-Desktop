import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
  getSkill,
  listExternalSkills,
  listUserSkills,
} from '../../src/huaanwork-host/skills-host.ts'

// 用例移植自旧 sidecar skills-host.test.ts 的 list/get 段(skills-host.test.ts:29-110):
// 三源合并、遮蔽序 user → external → bundled、bundled 根为包内 skills/(Task 2)。

const DEMO = '---\nname: demo\ndescription: 演示技能\n---\n\n正文\n'

let homes: string[] = []
let prevAgentsHome: string | undefined

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'hw-skills-host-'))
  homes.push(home)
  return home
}

beforeEach(() => {
  // 隔离外部技能根:未设置时 externalSkillsRoot 回落 ~/.agents/skills(机器相关)。
  prevAgentsHome = process.env.DSH_AGENTS_HOME
  process.env.DSH_AGENTS_HOME = mkdtempSync(join(tmpdir(), 'hw-fake-agents-'))
  homes.push(process.env.DSH_AGENTS_HOME)
})

afterEach(() => {
  if (prevAgentsHome === undefined) delete process.env.DSH_AGENTS_HOME
  else process.env.DSH_AGENTS_HOME = prevAgentsHome
  while (homes.length > 0) rmSync(homes.pop()!, { recursive: true, force: true })
})

describe('skills-host 读路径(旧 skills-host.test.ts 用例)', () => {
  test('listUserSkills covers directory bundles and flat markdown, skips .system', async () => {
    const home = makeHome()
    const root = join(home, 'skills')
    mkdirSync(join(root, 'demo'), { recursive: true })
    writeFileSync(join(root, 'demo', 'SKILL.md'), DEMO)
    writeFileSync(join(root, 'flat.md'), '---\nname: flat\ndescription: 扁平技能\n---\n\n扁平正文\n')
    mkdirSync(join(root, '.system'), { recursive: true })
    writeFileSync(join(root, '.system', 'hidden.md'), '---\nname: hidden\ndescription: 不应出现\n---\n\nx\n')
    const skills = await listUserSkills(home)
    expect(skills.map((s) => s.name)).toEqual(['demo', 'flat'])
    expect(skills.every((s) => s.source === 'user')).toBe(true)
  })

  test('listUserSkills tolerates missing root and unparseable entries', async () => {
    const home = makeHome()
    expect(await listUserSkills(home)).toEqual([])
    mkdirSync(join(home, 'skills'), { recursive: true })
    writeFileSync(join(home, 'skills', 'broken.md'), '没有 frontmatter')
    expect(await listUserSkills(home)).toEqual([])
  })

  test('listExternalSkills reads the agents-home skills root read-only', async () => {
    const agents = process.env.DSH_AGENTS_HOME!
    mkdirSync(join(agents, 'skills'), { recursive: true })
    writeFileSync(join(agents, 'skills', 'ext.md'), '---\nname: ext\ndescription: 外部技能\n---\n\nx\n')
    const skills = await listExternalSkills()
    expect(skills.map((s) => [s.name, s.source])).toEqual([['ext', 'external']])
  })

  test('getSkill searches user then external then bundled', async () => {
    const home = makeHome()
    mkdirSync(join(home, 'skills', 'demo'), { recursive: true })
    writeFileSync(join(home, 'skills', 'demo', 'SKILL.md'), DEMO)
    const user = await getSkill(home, 'demo')
    expect(user?.source).toBe('user')
    expect(user?.content).toBe('正文')
    // 内置兜底(真实 bundle 内置技能,根为包内 skills/)
    const explore = await getSkill(home, 'explore')
    expect(explore?.source).toBe('bundled')
    expect(explore?.content ?? '').toMatch(/subagent/)
    expect(await getSkill(home, '../etc')).toBeUndefined()
    expect(await getSkill(home, 'missing')).toBeUndefined()
  })

  test('getSkill honors an explicit source to disambiguate shadowed names', async () => {
    const home = makeHome()
    // 手写用户技能,与内置 explore 同名(createSkill 拒绝内置同名,故直接落盘绕过)
    mkdirSync(join(home, 'skills', 'explore'), { recursive: true })
    writeFileSync(join(home, 'skills', 'explore', 'SKILL.md'), '---\nname: explore\ndescription: 用户同名\n---\n\n用户正文\n')
    const agents = process.env.DSH_AGENTS_HOME!
    mkdirSync(join(agents, 'skills'), { recursive: true })
    writeFileSync(join(agents, 'skills', 'explore.md'), '---\nname: explore\ndescription: 外部同名\n---\n\n外部正文\n')
    // 无 source:保持 用户 → 外部 → 内置 的 rank order
    const unscoped = await getSkill(home, 'explore')
    expect(unscoped?.source).toBe('user')
    expect(unscoped?.content).toBe('用户正文')
    // 定向 source:只在该来源的根里找
    expect((await getSkill(home, 'explore', 'user'))?.content).toBe('用户正文')
    expect((await getSkill(home, 'explore', 'external'))?.content).toBe('外部正文')
    const bundledScoped = await getSkill(home, 'explore', 'bundled')
    expect(bundledScoped?.source).toBe('bundled')
    expect(bundledScoped?.content ?? '').toMatch(/subagent/)
    // 该来源下不存在 → undefined(外部/用户 root 没有内置独占名;bundled 没有用户/外部名)
    expect(await getSkill(home, 'test-fix', 'external')).toBeUndefined()
    expect(await getSkill(home, 'test-fix', 'user')).toBeUndefined()
    expect(await getSkill(home, 'missing', 'bundled')).toBeUndefined()
    // SKILL_NAME_RE 守卫对带 source 的查询同样生效
    expect(await getSkill(home, '../etc', 'user')).toBeUndefined()
  })
})
