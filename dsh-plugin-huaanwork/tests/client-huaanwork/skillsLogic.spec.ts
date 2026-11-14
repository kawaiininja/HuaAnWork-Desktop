import assert from 'node:assert/strict'
import { test } from 'vitest'

import {
  SKILL_TABS,
  centerActionLabel,
  filterCenterSkills,
  filterLocalSkills,
  originLabel,
  slashSkills,
  sourceLabel,
  tabLabel,
  uploadActionLabel,
  validateDuplicateName,
  type CenterSkillInfo,
  type InvocableSkillInfo,
  type LocalSkillInfo,
} from '../../src/client-huaanwork/logic/skillsLogic.ts'

test('only the center and mine tabs remain', () => {
  assert.deepEqual([...SKILL_TABS], ['center', 'mine'])
  assert.equal(tabLabel('center'), '技能中心')
  assert.equal(tabLabel('mine'), '我的技能')
})

test('download and upload labels are independent from enablement', () => {
  assert.equal(centerActionLabel('available'), '下载')
  assert.equal(centerActionLabel('downloaded'), '已下载')
  assert.equal(centerActionLabel('update-available'), '更新')
  assert.equal(centerActionLabel('local-conflict'), '本地有修改')
  assert.equal(centerActionLabel('not-applicable'), '系统技能·始终启用')
  assert.equal(uploadActionLabel('not-published'), '上传')
  assert.equal(uploadActionLabel('published'), '已上传')
  assert.equal(uploadActionLabel('modified'), '更新上传')
})

test('source and origin badges follow the spec vocabulary', () => {
  assert.equal(sourceLabel('bundled'), '内置')
  assert.equal(sourceLabel('catalog'), '共享')
  assert.equal(sourceLabel('user'), '我的技能')
  assert.equal(originLabel({ kind: 'created' }), '创建')
  assert.equal(originLabel({ kind: 'imported' }), '导入')
  assert.equal(originLabel({ kind: 'bundled' }), '内置副本')
  assert.equal(
    originLabel({ kind: 'catalog', name: 'x', revision: 1, publisher: 'alice', digest: 'sha256:' + 'a'.repeat(64) }),
    '共享副本',
  )
})

const centerSkills: CenterSkillInfo[] = [
  { name: 'pdf', description: '处理 PDF', source: 'bundled', downloadState: 'available' },
  { name: 'shared-helper', description: '共享技能', source: 'catalog', revision: 1, publisher: 'alice', downloadState: 'downloaded' },
]
const localSkills: LocalSkillInfo[] = [
  {
    name: 'weekly-report',
    description: '周报',
    source: 'user',
    enabled: true,
    origin: { kind: 'created' },
    contentDigest: 'sha256:' + 'a'.repeat(64),
    publishState: 'not-published',
  },
]

test('page searches are scoped to their own tab', () => {
  assert.deepEqual(filterCenterSkills(centerSkills, 'pdf').map(skill => skill.name), ['pdf'])
  assert.deepEqual(filterCenterSkills(centerSkills, '周报'), [])
  assert.deepEqual(filterLocalSkills(localSkills, '周报').map(skill => skill.name), ['weekly-report'])
  assert.deepEqual(filterLocalSkills(localSkills, 'pdf'), [])
  // 中心列表不含本地 user 技能,本地列表不含中心条目。
  assert.equal(centerSkills.some(skill => skill.name === 'weekly-report'), false)
  assert.equal(localSkills.some(skill => skill.name === 'shared-helper'), false)
})

test('slash catalog filters and prefix-orders invocable skills only', () => {
  const skills: InvocableSkillInfo[] = [
    { name: 'explore', description: '探索', source: 'bundled', enabled: true },
    { name: 'demo', description: '演示', source: 'user', enabled: true },
    { name: 'demo-extra', description: '演示二', source: 'user', enabled: true },
  ]
  assert.deepEqual(slashSkills(skills, 'dem').map(skill => skill.name), ['demo', 'demo-extra'])
  assert.deepEqual(slashSkills(skills, '').map(skill => skill.name), ['demo', 'demo-extra', 'explore'])
  assert.deepEqual(slashSkills(skills, '探索').map(skill => skill.name), ['explore'])
})

test('duplicate target validation refuses taken, invalid and unchanged names', () => {
  assert.equal(validateDuplicateName('new-name', { sourceName: 'pdf', takenNames: ['pdf'] }), undefined)
  assert.match(validateDuplicateName('pdf', { sourceName: 'pdf', takenNames: ['pdf'] }) ?? '', /新的技能名称/)
  assert.match(validateDuplicateName('Bad Name', { sourceName: 'pdf', takenNames: ['pdf'] }) ?? '', /kebab-case/)
  assert.match(validateDuplicateName('taken', { sourceName: 'pdf', takenNames: ['taken'] }) ?? '', /已存在同名技能/)
})
