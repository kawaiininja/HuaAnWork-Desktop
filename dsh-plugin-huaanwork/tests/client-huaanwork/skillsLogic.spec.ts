import assert from 'node:assert/strict'
import { test } from 'vitest'

import {
  RESERVED_SKILL_NAMES,
  SKILL_TABS,
  busyKeyFor,
  centerActionLabel,
  filterCenterSkills,
  filterLocalSkills,
  isBuiltinNameConflict,
  isReservedSlash,
  isUploadDisabled,
  originLabel,
  parseSlashInvoke,
  slashSkills,
  slashTokenAt,
  sourceLabel,
  tabLabel,
  uploadActionLabel,
  validateDuplicateName,
  validateSkillForm,
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


test('slash token parsing keeps URL/path-like input out of the menu', () => {
  assert.deepEqual(slashTokenAt('请看 /demo 技能', 6), { start: 3, end: 8, query: 'demo' })
  assert.equal(slashTokenAt('http://example.com/x', 10), undefined)
  assert.equal(slashTokenAt('a //demo', 8), undefined)
  assert.deepEqual(slashTokenAt('/', 1), { start: 0, end: 1, query: '' })
  assert.equal(slashTokenAt('/dem o', 4)?.query, 'dem')
  assert.equal(slashTokenAt('/Dem', 4), undefined)
})

test('schedule stays reserved for automation', () => {
  assert.equal(isReservedSlash('schedule'), true)
  assert.equal(isReservedSlash('schedule-daily'), true)
  assert.equal(isReservedSlash('demo'), false)
  assert.equal(parseSlashInvoke('/schedule 每小时'), undefined)
  assert.deepEqual(parseSlashInvoke('/demo 跑一下'), { name: 'demo', remainder: '跑一下' })
})

test('form validation checks kebab names, taken names and content', () => {
  const base = { name: 'demo', description: '演示', whenToUse: '', content: '正文', disableModelInvocation: false }
  assert.deepEqual(validateSkillForm(base, { editing: false, takenNames: [] }), {})
  assert.equal(validateSkillForm({ ...base, name: 'Bad Name' }, { editing: false, takenNames: [] }).name !== undefined, true)
  assert.equal(validateSkillForm({ ...base, name: 'taken' }, { editing: false, takenNames: ['taken'] }).name !== undefined, true)
  assert.equal(validateSkillForm({ ...base, description: ' ' }, { editing: false, takenNames: [] }).description !== undefined, true)
  assert.equal(validateSkillForm({ ...base, content: ' ' }, { editing: false, takenNames: [] }).content !== undefined, true)
  // Editing keeps the name locked → no name error even when "taken".
  assert.equal(validateSkillForm({ ...base, name: 'taken' }, { editing: true, takenNames: ['taken'] }).name, undefined)
})

test('builtin-name conflicts and upload disabling match the host rules', () => {
  const base: LocalSkillInfo = {
    name: 'pdf',
    description: 'x',
    source: 'user',
    enabled: false,
    origin: { kind: 'created' },
    contentDigest: 'sha256:' + 'a'.repeat(64),
    publishState: 'not-published',
  }
  assert.equal(busyKeyFor('catalog', 'pdf'), 'catalog:pdf')
  assert.equal(busyKeyFor('user', 'pdf'), 'user:pdf')
  assert.equal(isBuiltinNameConflict(base, new Set(['pdf'])), true)
  assert.equal(isBuiltinNameConflict({ ...base, origin: { kind: 'bundled' } }, new Set()), true)
  assert.equal(isBuiltinNameConflict({ ...base, name: 'other' }, new Set(['pdf'])), false)
  assert.equal(isUploadDisabled(base, new Set(['pdf'])), true)
  assert.equal(isUploadDisabled({ ...base, name: 'other', publishState: 'published' }, new Set(['pdf'])), true)
  assert.equal(isUploadDisabled({ ...base, name: 'other' }, new Set(['pdf'])), false)
  assert.ok(RESERVED_SKILL_NAMES.includes('create-agent'))
})
