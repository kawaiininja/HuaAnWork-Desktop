import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  agentsDirectoryErrors,
  defaultSettings,
  emptySettings,
  mergeSettings,
  parseSettings,
  readHuaanworkSettings,
  readHuaanworkSettingsSync,
  writeHuaanworkSettings,
} from '../../src/huaanwork-host/settings.ts'

describe('settings logic ported from sidecar', () => {
  test('parseSettings and mergeSettings handle automation_timeout_ms', () => {
    expect(parseSettings({}).automation_timeout_ms).toBe(600_000)
    expect(parseSettings({ automation_timeout_ms: 1234 }).automation_timeout_ms).toBe(1234)
    expect(parseSettings({ automation_timeout_ms: -5 }).automation_timeout_ms).toBe(600_000)
    expect(parseSettings({ automation_timeout_ms: 0 }).automation_timeout_ms).toBe(600_000)
    const next = mergeSettings(parseSettings({}), { automation_timeout_ms: 2000 })
    expect(next.automation_timeout_ms).toBe(2000)
    const kept = mergeSettings(parseSettings({ automation_timeout_ms: 2000 }), { theme: 'dark' })
    expect(kept.automation_timeout_ms).toBe(2000)
    const kept2 = mergeSettings(parseSettings({ automation_timeout_ms: 2000 }), { automation_timeout_ms: -1 })
    expect(kept2.automation_timeout_ms).toBe(2000)
  })

  test('parseSettings synthesizes one entry from legacy flat fields', () => {
    const got = parseSettings({ base_url: 'http://127.0.0.1:9/v1', model: 'qwen', api_key: '', theme: 'dark' })
    expect(got.theme).toBe('dark')
    expect(got.model).toBe('qwen')
    expect(got.base_url).toBe('http://127.0.0.1:9/v1')
    expect(got.models).toHaveLength(1)
    expect(got.models[0]!.model).toBe('qwen')
    expect(got.active_model_id).toBe(got.models[0]!.id)
  })

  test('parseSettings empty object matches defaultSettings shape', () => {
    const got = parseSettings({})
    expect(got.theme).toBe(defaultSettings.theme)
    expect(got.models).toHaveLength(1)
    expect(got.active_model_id).toBe('default')
    expect(got.base_url).toBe(defaultSettings.base_url)
  })

  test('parseSettings honors explicit empty models list', () => {
    const got = parseSettings({ models: [], model: 'stale' })
    expect(got.models).toEqual([])
    expect(got.model).toBe('')
    expect(got.active_model_id).toBe('')
  })

  test('parseSettings picks active entry and mirrors flat fields', () => {
    const got = parseSettings({
      models: [
        { id: 'a', name: 'Ollama', base_url: 'http://127.0.0.1:11434/v1', model: 'qwen', api_key: '' },
        { id: 'b', name: 'LM Studio', base_url: 'http://127.0.0.1:1234/v1', model: 'llama', api_key: 'k' },
      ],
      active_model_id: 'b',
      model: 'ignored',
    })
    expect(got.active_model_id).toBe('b')
    expect(got.model).toBe('llama')
    expect(got.base_url).toBe('http://127.0.0.1:1234/v1')
    expect(got.api_key).toBe('k')
  })

  test('mergeSettings theme does not clear models', () => {
    const current = parseSettings({
      models: [{ id: 'a', name: 'A', base_url: 'http://x/v1', model: 'qwen', api_key: '' }],
      active_model_id: 'a',
      theme: 'light',
    })
    const next = mergeSettings(current, { theme: 'dark' })
    expect(next.theme).toBe('dark')
    expect(next.models).toHaveLength(1)
    expect(next.model).toBe('qwen')
  })

  test('mergeSettings legacy model updates the active entry', () => {
    const current = parseSettings({ model: 'old', theme: 'light' })
    const next = mergeSettings(current, { model: 'x' })
    expect(next.model).toBe('x')
    expect(next.theme).toBe('light')
    expect(next.models[0]!.model).toBe('x')
  })

  test('mergeSettings replaces models and switches active', () => {
    const current = parseSettings({ model: 'old' })
    const next = mergeSettings(current, {
      models: [
        { id: 'one', name: 'One', base_url: 'http://a/v1', model: 'a', api_key: '' },
        { id: 'two', name: 'Two', base_url: 'http://b/v1', model: 'b', api_key: 's' },
      ],
      active_model_id: 'two',
    })
    expect(next.active_model_id).toBe('two')
    expect(next.model).toBe('b')
    expect(next.base_url).toBe('http://b/v1')
    expect(next.api_key).toBe('s')
    expect(next.models).toHaveLength(2)
  })

  test('mergeSettings assigns id when client omits it', () => {
    const current = parseSettings({})
    const next = mergeSettings(current, {
      models: [{ name: 'New', base_url: 'http://n/v1', model: 'n', api_key: '' }],
    })
    expect(next.models).toHaveLength(1)
    expect(next.models[0]!.id.length).toBeGreaterThan(0)
    expect(next.models[0]!.name).toBe('New')
    expect(next.active_model_id).toBe(next.models[0]!.id)
  })

  test('parseSettings defaults allow_network to false and honors explicit true', () => {
    expect(parseSettings({}).allow_network).toBe(false)
    expect(parseSettings({ allow_network: true }).allow_network).toBe(true)
    expect(parseSettings({ allow_network: 'yes' }).allow_network).toBe(false)
    // 兼容旧 key: work_allow_network
    expect(parseSettings({ work_allow_network: true }).allow_network).toBe(true)
    expect(parseSettings({ work_allow_network: false }).allow_network).toBe(false)
  })

  test('mergeSettings toggles allow_network without touching models', () => {
    const current = parseSettings({ model: 'qwen' })
    const on = mergeSettings(current, { allow_network: true })
    expect(on.allow_network).toBe(true)
    expect(on.model).toBe('qwen')
    const still = mergeSettings(on, { model: 'other' })
    expect(still.allow_network).toBe(true)
    const off = mergeSettings(still, { allow_network: false })
    expect(off.allow_network).toBe(false)
  })

  test('mergeSettings ignores non-finite automation_timeout_ms', () => {
    const current = parseSettings({ automation_timeout_ms: 2000 })
    expect(mergeSettings(current, { automation_timeout_ms: Infinity }).automation_timeout_ms).toBe(2000)
    expect(mergeSettings(current, { automation_timeout_ms: NaN }).automation_timeout_ms).toBe(2000)
    expect(mergeSettings(current, { automation_timeout_ms: 500 }).automation_timeout_ms).toBe(500)
  })

  test('parseSettings defaults keep_awake to true and honors explicit false', () => {
    expect(parseSettings({}).keep_awake).toBe(true)
    expect(parseSettings({ keep_awake: false }).keep_awake).toBe(false)
    expect(parseSettings({ keep_awake: true }).keep_awake).toBe(true)
    expect(parseSettings({ keep_awake: 'no' }).keep_awake).toBe(true)
  })

  test('mergeSettings toggles keep_awake without touching models', () => {
    const current = parseSettings({ model: 'qwen' })
    expect(current.keep_awake).toBe(true)
    const off = mergeSettings(current, { keep_awake: false })
    expect(off.keep_awake).toBe(false)
    expect(off.model).toBe('qwen')
    const still = mergeSettings(off, { model: 'other' })
    expect(still.keep_awake).toBe(false)
    const on = mergeSettings(still, { keep_awake: true })
    expect(on.keep_awake).toBe(true)
  })

  test('parseSettings defaults guard_mode to ask and rejects unknown values', () => {
    expect(parseSettings({}).guard_mode).toBe('ask')
    expect(parseSettings({ guard_mode: 'ask' }).guard_mode).toBe('ask')
    expect(parseSettings({ guard_mode: 'smart' }).guard_mode).toBe('smart')
    expect(parseSettings({ guard_mode: 'full' }).guard_mode).toBe('full')
    expect(parseSettings({ guard_mode: 'bypass' }).guard_mode).toBe('ask')
    expect(parseSettings({ guard_mode: 1 }).guard_mode).toBe('ask')
  })

  test('mergeSettings updates guard_mode and preserves it across unrelated writes', () => {
    const current = parseSettings({ model: 'qwen' })
    expect(current.guard_mode).toBe('ask')
    const full = mergeSettings(current, { guard_mode: 'full' })
    expect(full.guard_mode).toBe('full')
    expect(full.model).toBe('qwen')
    const kept = mergeSettings(full, { theme: 'dark' })
    expect(kept.guard_mode).toBe('full')
    expect(mergeSettings(full, { guard_mode: 'nope' }).guard_mode).toBe('full')
    expect(mergeSettings(full, { guard_mode: 'ask' }).guard_mode).toBe('ask')
  })

  test('parseSettings defaults agents directory fields to empty', () => {
    const parsed = parseSettings({})
    expect(parsed.agents_host).toBe('')
    expect(parsed.agents_port).toBe('')
    expect(parsed.agents_catalog_token).toBe('')
  })

  test('mergeSettings writes agents fields and preserves them across theme', () => {
    const current = parseSettings({})
    const next = mergeSettings(current, {
      agents_host: '192.168.10.20',
      agents_port: 8080,
      agents_catalog_token: 'secret',
    })
    expect(next.agents_host).toBe('192.168.10.20')
    expect(next.agents_port).toBe(8080)
    expect(mergeSettings(next, { theme: 'dark' }).agents_catalog_token).toBe('secret')
  })

  test('agentsDirectoryErrors rejects public host when port is set', () => {
    const current = parseSettings({})
    const next = mergeSettings(current, { agents_host: 'api.openai.com', agents_port: 443 })
    const errors = agentsDirectoryErrors(next)
    expect(errors.some((error) => error.field === 'agents_host')).toBe(true)
    expect(
      agentsDirectoryErrors(mergeSettings(current, { agents_host: '192.168.10.20', agents_port: 8080 })),
    ).toEqual([])
    expect(agentsDirectoryErrors(mergeSettings(current, { agents_host: 'example.com' }))).toEqual([])
  })

  test('parseSettings and mergeSettings handle agents port and field clearing', () => {
    expect(parseSettings({ agents_port: '8080' }).agents_port).toBe(8080)
    expect(parseSettings({ agents_port: 8080 }).agents_port).toBe(8080)
    expect(parseSettings({ agents_port: 'invalid' }).agents_port).toBe('')
    expect(parseSettings({ agents_port: -1 }).agents_port).toBe('')
    expect(parseSettings({ agents_port: 70000 }).agents_port).toBe('')

    const current = mergeSettings(parseSettings({}), {
      agents_host: '192.168.1.1',
      agents_port: 8080,
      agents_catalog_token: 'tok',
    })
    expect(mergeSettings(current, { agents_port: 'bad' }).agents_port).toBe(8080)
    expect(mergeSettings(current, { agents_port: -5 }).agents_port).toBe(8080)
    expect(mergeSettings(current, { agents_port: '' }).agents_port).toBe('')
    expect(mergeSettings(current, { agents_port: null }).agents_port).toBe('')
    const cleared = mergeSettings(current, { agents_host: '', agents_catalog_token: '' })
    expect(cleared.agents_host).toBe('')
    expect(cleared.agents_catalog_token).toBe('')
  })
})

describe('settings disk storage in profileDir', () => {
  test('readHuaanworkSettings on missing file returns emptySettings()', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hw-settings-test-'))
    try {
      const settings = await readHuaanworkSettings(dir)
      expect(settings).toEqual(emptySettings())
      expect(readHuaanworkSettingsSync(dir)).toEqual(emptySettings())
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('writeHuaanworkSettings writes to huaanwork-settings.json and readHuaanworkSettings reads it back', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hw-settings-test-'))
    try {
      const written = await writeHuaanworkSettings(dir, {
        model: 'qwen-max',
        theme: 'dark',
        allow_network: true,
      })
      expect(written.model).toBe('qwen-max')
      expect(written.theme).toBe('dark')
      expect(written.allow_network).toBe(true)

      const readBack = await readHuaanworkSettings(dir)
      expect(readBack.model).toBe('qwen-max')
      expect(readBack.theme).toBe('dark')
      expect(readBack.allow_network).toBe(true)

      const syncRead = readHuaanworkSettingsSync(dir)
      expect(syncRead.model).toBe('qwen-max')
      expect(syncRead.theme).toBe('dark')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('writeHuaanworkSettings with invalid public agents_host throws RouteError 400 validation', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hw-settings-test-'))
    try {
      await expect(
        writeHuaanworkSettings(dir, {
          agents_host: '8.8.8.8',
          agents_port: 8080,
        }),
      ).rejects.toMatchObject({
        status: 400,
        code: 'validation',
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('illegal theme on disk falls back to system', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hw-settings-test-'))
    try {
      writeFileSync(
        join(dir, 'huaanwork-settings.json'),
        JSON.stringify({ theme: 'neon', model: 'qwen' }),
        'utf8',
      )
      const readBack = await readHuaanworkSettings(dir)
      expect(readBack.theme).toBe('system')
      expect(readBack.model).toBe('qwen')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
