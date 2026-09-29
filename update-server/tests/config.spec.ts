import { describe, expect, it } from 'vitest'
import { loadUpdateServerConfig, UpdateServerConfigError } from '../src/config.ts'
import { matchesChannelVersionShape } from '../src/channels.ts'

const VALID = {
  UPDATE_SERVER_PORT: '8790',
  UPDATE_SERVER_DATA_DIR: '/var/lib/huaanwork-updates',
  UPDATE_SERVER_PUBLIC_ORIGIN: 'http://update.intranet.lan:8790',
}

describe('loadUpdateServerConfig', () => {
  it('accepts the three required variables', () => {
    const config = loadUpdateServerConfig(VALID)
    expect(config).toMatchObject({
      port: 8790,
      dataDir: '/var/lib/huaanwork-updates',
      publicOrigin: 'http://update.intranet.lan:8790',
    })
  })

  it('exposes no write-path configuration at all', () => {
    // 只读服务端(2026-09-28 修订):没有 token、没有上传上限、没有并发上传闸。
    // 这条负例把「写路径攻击面归零」变成可执行断言,而不是一句评审说明。
    // (接口无索引签名,故经 unknown 中转;本用例的全部意义就是探测「必须不存在」的键。)
    const config = loadUpdateServerConfig(VALID) as unknown as Record<string, unknown>
    for (const absent of ['adminToken', 'maxUploadBytes', 'maxConcurrentUploads']) {
      expect(absent in config, `${absent} must not exist on a read-only server`).toBe(false)
    }
  })

  it('ignores a legacy UPDATE_SERVER_ADMIN_TOKEN rather than growing an admin face back', () => {
    const config = loadUpdateServerConfig({ ...VALID, UPDATE_SERVER_ADMIN_TOKEN: 'sekrit' })
    expect('adminToken' in (config as unknown as Record<string, unknown>)).toBe(false)
  })

  it.each(['UPDATE_SERVER_PORT', 'UPDATE_SERVER_DATA_DIR', 'UPDATE_SERVER_PUBLIC_ORIGIN'])(
    'fails closed when %s is missing', key => {
      const env = { ...VALID }
      delete env[key as keyof typeof VALID]
      expect(() => loadUpdateServerConfig(env)).toThrow(UpdateServerConfigError)
    })

  it('rejects a non-numeric or out-of-range port', () => {
    expect(() => loadUpdateServerConfig({ ...VALID, UPDATE_SERVER_PORT: 'http' })).toThrow(/port/u)
    expect(() => loadUpdateServerConfig({ ...VALID, UPDATE_SERVER_PORT: '0' })).toThrow(/port/u)
    expect(() => loadUpdateServerConfig({ ...VALID, UPDATE_SERVER_PORT: '70000' })).toThrow(/port/u)
  })

  it('rejects a public origin that is not an absolute http(s) base', () => {
    expect(() => loadUpdateServerConfig({ ...VALID, UPDATE_SERVER_PUBLIC_ORIGIN: 'update.intranet.lan' })).toThrow(/origin/u)
    expect(() => loadUpdateServerConfig({ ...VALID, UPDATE_SERVER_PUBLIC_ORIGIN: 'https://x.lan/base' })).toThrow(/origin/u)
  })

  it('applies the hardening defaults that still apply to a read-only server (P8, minus uploads)', () => {
    const config = loadUpdateServerConfig(VALID)
    expect(config.requestTimeoutMs).toBeGreaterThan(0)
    expect(config.allowedHosts).toContain('update.intranet.lan:8790')
  })
})

describe('matchesChannelVersionShape', () => {
  it('mirrors the client rule: huaanwork and stable take plain SemVer, beta takes -beta.N', () => {
    expect(matchesChannelVersionShape('huaanwork', '0.1.0')).toBe(true)
    expect(matchesChannelVersionShape('huaanwork', '0.1.0-beta.1')).toBe(false)
    expect(matchesChannelVersionShape('stable', '2.0.4')).toBe(true)
    expect(matchesChannelVersionShape('beta', '2.0.6-beta.1')).toBe(true)
    expect(matchesChannelVersionShape('beta', '2.0.6')).toBe(false)
  })

  it('rejects a version that is not canonical SemVer', () => {
    expect(matchesChannelVersionShape('huaanwork', '0.1')).toBe(false)
    expect(matchesChannelVersionShape('huaanwork', 'v0.1.0')).toBe(false)
  })
})
