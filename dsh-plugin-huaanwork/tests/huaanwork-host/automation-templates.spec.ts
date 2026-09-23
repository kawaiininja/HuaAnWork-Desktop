/**
 * 旧 automations-host.test.ts「六个内置模板且每个都能创建」。
 * 不放进 stores.spec.ts:那个文件单独跑时,同毫秒 create 会打乱 listProjects 排序断言。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'

import { createAutomation, normalizeAutomationInput } from '../../src/huaanwork-host/automations-store.ts'
import { listAutomations, readAutomationTemplates } from '../../src/huaanwork-host/stores.ts'

const homes: string[] = []

afterEach(() => {
  while (homes.length > 0) rmSync(homes.pop()!, { recursive: true, force: true })
})

test('six built-in templates each create successfully', async () => {
  const templates = await readAutomationTemplates()
  expect(templates).toHaveLength(6)
  const names = templates.map((template) => template.name)
  expect(names).toEqual(['每日投研早报', '周报草稿', '目录整理', '数据巡检', 'CI 状态汇总', '下载归档'])

  const home = mkdtempSync(join(tmpdir(), 'hw-auto-templates-'))
  homes.push(home)
  for (const template of templates) {
    const created = await createAutomation(home, normalizeAutomationInput({ ...template }))
    expect(created.name).toBe(template.name)
    expect(created.kind).toBe(template.kind)
  }
  const stored = await listAutomations(home)
  expect(stored.map((item) => item.name)).toEqual(names)
})
