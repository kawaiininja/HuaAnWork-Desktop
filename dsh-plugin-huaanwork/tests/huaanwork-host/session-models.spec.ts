import { describe, expect, test } from 'vitest'

import { workNetworkGateError } from '@huaanwork/policy/network'

import { resolveSessionModel } from '../../src/huaanwork-host/session-models.ts'

describe('resolveSessionModel', () => {
  test('pinned models stay apart from the global active model', () => {
    const table = new Map([['s1', 'local-model'], ['s2', 'other-model']])
    const models = [
      { id: 'local-model', base_url: 'http://127.0.0.1:11434/v1', model: 'qwen', api_key: '' },
      { id: 'other-model', base_url: 'http://10.0.0.8:8000/v1', model: 'llama', api_key: 'k' },
    ]
    const active = { base_url: 'http://127.0.0.1:11434/v1', model: 'qwen', api_key: '' }
    expect(resolveSessionModel({ sessionId: 's2', table, models, active, allowNetwork: false })).toMatchObject({
      ok: true, model: 'llama', base_url: 'http://10.0.0.8:8000/v1',
    })
    expect(resolveSessionModel({ sessionId: 's2', table, models: models.slice(0, 1), active, allowNetwork: true })).toEqual({
      ok: false, reason: '模型不存在',
    })
    expect(resolveSessionModel({
      sessionId: 'child',
      table,
      models,
      active: { base_url: 'https://api.example.com/v1', model: 'cloud', api_key: '' },
      allowNetwork: false,
      parentOf: (id) => (id === 'child' ? 's1' : undefined),
    })).toMatchObject({ ok: true, model: 'qwen', base_url: 'http://127.0.0.1:11434/v1' })
  })

  test('a pinned public endpoint is blocked by the network gate instead of falling back to the active model', () => {
    const table = new Map([['s1', 'cloud-model']])
    const models = [
      { id: 'cloud-model', base_url: 'https://api.example.com/v1', model: 'cloud', api_key: 'k' },
    ]
    const active = { base_url: 'http://127.0.0.1:11434/v1', model: 'qwen', api_key: '' }
    expect(resolveSessionModel({ sessionId: 's1', table, models, active, allowNetwork: false })).toEqual({
      ok: false,
      reason: workNetworkGateError({ allowNetwork: false, baseUrl: 'https://api.example.com/v1' }),
    })
    expect(resolveSessionModel({ sessionId: 's1', table, models, active, allowNetwork: true })).toMatchObject({
      ok: true, model: 'cloud', base_url: 'https://api.example.com/v1',
    })
  })

  test('no binding and no parent binding use the active model and gate its endpoint', () => {
    const table = new Map<string, string>()
    const models = [{ id: 'local', base_url: 'http://127.0.0.1:11434/v1', model: 'qwen', api_key: '' }]
    const active = { base_url: 'http://127.0.0.1:11434/v1', model: 'qwen', api_key: '' }
    expect(resolveSessionModel({ sessionId: 's9', table, models, active, allowNetwork: false })).toMatchObject({
      ok: true, model: 'qwen',
    })
    const publicActive = { base_url: 'https://api.example.com/v1', model: 'cloud', api_key: '' }
    expect(resolveSessionModel({ sessionId: 's9', table, models, active: publicActive, allowNetwork: false }).ok).toBe(false)
  })
})
