import { describe, expect, it, vi } from 'vitest'
import {
  DESKTOP_CURRENT_VERSION_HEADER,
  DESKTOP_RELEASE_CHANNEL_HEADER,
  MAX_VERSION_RESPONSE_BYTES,
  checkForStableUpdate,
  checkForDesktopUpdate,
  compareSemVerVersions,
  desktopVersionEndpoint,
  desktopVersionRequestHeaders,
  matchesReleaseChannelVersionShape,
  parseSemVer,
  resolveUpdateOrigin,
  SUPPORTED_RELEASE_CHANNELS,
  UpdateOriginError,
  type UpdateRequest,
} from '../src/update-checker.ts'
import {
  assertDesktopInstallationId,
  DESKTOP_INSTALLATION_ID_HEADER,
} from '../src/desktop-installation-id.ts'

const INSTALLATION_ID = assertDesktopInstallationId('01234567-89ab-4cde-8f01-23456789abcd')

function versionResponse(version: unknown, init: ResponseInit = {}): Response {
  return Response.json({ version }, init)
}

function channelVersionResponse(
  version: unknown,
  channel: 'stable' | 'beta' | 'huaanwork',
  extra: Record<string, unknown> = {},
): Response {
  return Response.json({ version, channel, ...extra })
}

describe('strict SemVer parsing', () => {
  it('accepts a three-part version, optional lowercase v, prerelease, and build metadata', () => {
    expect(parseSemVer('v2.10.3-alpha.1+mac.arm64')).toEqual({
      version: '2.10.3-alpha.1+mac.arm64',
      major: '2',
      minor: '10',
      patch: '3',
      prerelease: ['alpha', '1'],
      build: ['mac', 'arm64'],
    })
    expect(parseSemVer('0.0.0')).not.toBeNull()
  })

  it.each([
    '1',
    '1.2',
    '01.2.3',
    '1.02.3',
    '1.2.03',
    '1.2.3-01',
    '1.2.3-alpha..1',
    '1.2.3+',
    'V1.2.3',
    ' 1.2.3',
  ])('rejects invalid SemVer %s', version => {
    expect(parseSemVer(version)).toBeNull()
  })

  it('compares strict versions without numeric overflow', () => {
    expect(compareSemVerVersions('2.1.0', '2.0.9')).toBeGreaterThan(0)
    expect(compareSemVerVersions('2.0.0-rc.1', '2.0.0')).toBeLessThan(0)
    expect(compareSemVerVersions('2.0', '2.0.0')).toBeNull()
    expect(compareSemVerVersions(
      '10000000000000000.0.0',
      '9007199254740992.0.0',
    )).toBeGreaterThan(0)
  })
})

describe('public Desktop version check', () => {
  it('isolates Beta checks and rejects an unlabelled or stable response', async () => {
    const calls: RequestInit[] = []
    const request = vi.fn(async (_url: string, init: RequestInit) => {
      calls.push(init)
      return channelVersionResponse('2.0.5-beta.3', 'beta')
    })
    await expect(checkForDesktopUpdate({
      currentVersion: '2.0.5-beta.2',
      channel: 'beta',
      request,
    })).resolves.toEqual({
      status: 'update-available',
      currentVersion: '2.0.5-beta.2',
      latestVersion: '2.0.5-beta.3',
    })
    expect(new Headers(calls[0]?.headers).get(DESKTOP_RELEASE_CHANNEL_HEADER)).toBe('beta')

    await expect(checkForDesktopUpdate({
      currentVersion: '2.0.5-beta.2',
      channel: 'beta',
      request: async () => versionResponse('2.0.5-beta.3'),
    })).resolves.toBeNull()
    await expect(checkForDesktopUpdate({
      currentVersion: '2.0.5-beta.2',
      channel: 'beta',
      request: async () => channelVersionResponse('2.0.5', 'stable'),
    })).resolves.toBeNull()
  })

  it('allows an explicit Beta-to-stable selection even when stable is older', async () => {
    await expect(checkForDesktopUpdate({
      currentVersion: '2.0.5-beta.2',
      channel: 'stable',
      currentChannel: 'beta',
      allowDowngrade: true,
      request: async () => channelVersionResponse('2.0.4', 'stable'),
    })).resolves.toEqual({
      status: 'update-available',
      currentVersion: '2.0.5-beta.2',
      latestVersion: '2.0.4',
    })
  })

  it('uses only the fixed no-cache version endpoint and reports a newer stable version', async () => {
    const controller = new AbortController()
    const calls: Array<{ url: string, init: RequestInit }> = []
    const request: UpdateRequest = async (url, init) => {
      calls.push({ url, init })
      return versionResponse('2.10.0')
    }

    await expect(checkForStableUpdate({
      currentVersion: '2.9.9',
      installationId: INSTALLATION_ID,
      signal: controller.signal,
      request,
    })).resolves.toEqual({
      status: 'update-available',
      currentVersion: '2.9.9',
      latestVersion: '2.10.0',
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe(desktopVersionEndpoint('http://update.intranet.lan:8790'))
    expect(calls[0]?.url).not.toContain('/api/downloads/')
    expect(calls[0]?.init).toMatchObject({
      method: 'GET',
      cache: 'no-store',
      redirect: 'error',
      signal: controller.signal,
    })
    const headers = new Headers(calls[0]?.init.headers)
    expect(headers.get('accept')).toBe('application/json')
    expect(headers.get(DESKTOP_CURRENT_VERSION_HEADER)).toBe('2.9.9')
    expect(headers.get(DESKTOP_INSTALLATION_ID_HEADER)).toBe(INSTALLATION_ID)
    expect(headers.has('if-none-match')).toBe(false)
    expect(headers.has('x-github-api-version')).toBe(false)
  })

  it('builds a bounded version-check header set and rejects malformed identities', () => {
    expect(desktopVersionRequestHeaders(INSTALLATION_ID)).toEqual({
      Accept: 'application/json',
      [DESKTOP_INSTALLATION_ID_HEADER]: INSTALLATION_ID,
    })
    expect(desktopVersionRequestHeaders(INSTALLATION_ID, '2.9.9')).toEqual({
      Accept: 'application/json',
      [DESKTOP_CURRENT_VERSION_HEADER]: '2.9.9',
      [DESKTOP_INSTALLATION_ID_HEADER]: INSTALLATION_ID,
    })
    expect(() => desktopVersionRequestHeaders(INSTALLATION_ID, '2.0.5-beta.2'))
      .toThrow('canonical stable SemVer')
    expect(desktopVersionRequestHeaders(INSTALLATION_ID, '2.0.5-beta.2', 'beta')).toEqual({
      Accept: 'application/json',
      [DESKTOP_RELEASE_CHANNEL_HEADER]: 'beta',
      [DESKTOP_CURRENT_VERSION_HEADER]: '2.0.5-beta.2',
      [DESKTOP_INSTALLATION_ID_HEADER]: INSTALLATION_ID,
    })
    expect(desktopVersionRequestHeaders()).toEqual({ Accept: 'application/json' })
    expect(() => desktopVersionRequestHeaders(undefined, 'v2.9.0')).toThrow('canonical stable SemVer')
    expect(() => desktopVersionRequestHeaders('not-a-uuid')).toThrow('canonical lowercase UUID v4')
  })

  it('skips the fixed endpoint when an invalid installation identity reaches the checker', async () => {
    const request = vi.fn(async () => versionResponse('2.1.0'))
    await expect(checkForStableUpdate({
      currentVersion: '2.0.0',
      installationId: 'not-a-uuid' as never,
      request,
    })).resolves.toBeNull()
    expect(request).not.toHaveBeenCalled()
  })

  it.each([
    ['2.0.0', '2.0.0'],
    ['2.0.1', '2.0.0'],
    ['2.0.0+installed', '2.0.0+release'],
  ])('reports no update for installed %s and service %s', async (currentVersion, latestVersion) => {
    await expect(checkForStableUpdate({
      currentVersion,
      request: async () => versionResponse(latestVersion),
    })).resolves.toEqual({
      status: 'up-to-date',
      currentVersion,
      latestVersion,
    })
  })

  it('compares service versions without overflowing JavaScript numbers', async () => {
    await expect(checkForStableUpdate({
      currentVersion: '9007199254740992.0.0',
      request: async () => versionResponse('10000000000000000.0.0'),
    })).resolves.toMatchObject({ status: 'update-available' })
  })

  it('lets a Beta installation discover the corresponding stable release', async () => {
    await expect(checkForStableUpdate({
      currentVersion: '2.0.5-beta.2',
      currentChannel: 'beta',
      allowDowngrade: true,
      request: async () => versionResponse('2.0.5'),
    })).resolves.toEqual({
      status: 'update-available',
      currentVersion: '2.0.5-beta.2',
      latestVersion: '2.0.5',
    })
  })

  it.each([
    ['leading v', { version: 'v2.1.0' }],
    ['prerelease', { version: '2.1.0-rc.1' }],
    ['invalid SemVer', { version: '2.01.0' }],
    ['missing version', {}],
    ['non-string version', { version: 2 }],
    ['array response', ['2.1.0']],
  ])('silently ignores a service response with %s', async (_case, value) => {
    await expect(checkForStableUpdate({
      currentVersion: '2.0.0',
      request: async () => Response.json(value),
    })).resolves.toBeNull()
  })

  it('silently ignores malformed JSON and non-200 statuses', async () => {
    await expect(checkForStableUpdate({
      currentVersion: '2.0.0',
      request: async () => new Response('{'),
    })).resolves.toBeNull()
    await expect(checkForStableUpdate({
      currentVersion: '2.0.0',
      request: async () => new Response('unavailable', { status: 503 }),
    })).resolves.toBeNull()
    await expect(checkForStableUpdate({
      currentVersion: '2.0.0',
      request: async () => new Response(null, { status: 304 }),
    })).resolves.toBeNull()
  })

  it('silently ignores network failure and caller cancellation', async () => {
    await expect(checkForStableUpdate({
      currentVersion: '2.0.0',
      request: async () => { throw new TypeError('offline') },
    })).resolves.toBeNull()

    const controller = new AbortController()
    controller.abort()
    await expect(checkForStableUpdate({
      currentVersion: '2.0.0',
      signal: controller.signal,
      request: async () => { throw new DOMException('cancelled', 'AbortError') },
    })).resolves.toBeNull()
  })

  it('silently ignores declared and streamed oversized responses', async () => {
    await expect(checkForStableUpdate({
      currentVersion: '2.0.0',
      request: async () => new Response('{}', {
        headers: { 'content-length': String(MAX_VERSION_RESPONSE_BYTES + 1) },
      }),
    })).resolves.toBeNull()
    await expect(checkForStableUpdate({
      currentVersion: '2.0.0',
      request: async () => new Response('x'.repeat(MAX_VERSION_RESPONSE_BYTES + 1)),
    })).resolves.toBeNull()
  })

  it.each(['2.0', 'v2.0.0', '2.0.0-01'])('skips invalid installed version %s before requesting', async currentVersion => {
    const request = vi.fn(async () => versionResponse('2.1.0'))

    await expect(checkForStableUpdate({ currentVersion, request })).resolves.toBeNull()
    expect(request).not.toHaveBeenCalled()
  })
})

describe('huaanwork release channel version shape', () => {
  it('lists the three supported channels', () => {
    expect(SUPPORTED_RELEASE_CHANNELS).toEqual(['stable', 'beta', 'huaanwork'])
  })

  it('accepts canonical SemVer without prerelease for huaanwork, mirroring stable', () => {
    const parsed = parseSemVer('0.1.0')!
    expect(matchesReleaseChannelVersionShape('huaanwork', parsed)).toBe(true)
    expect(matchesReleaseChannelVersionShape('stable', parsed)).toBe(true)
  })

  it('rejects a beta-shaped version on the huaanwork channel', () => {
    const parsed = parseSemVer('0.1.0-beta.1')!
    expect(matchesReleaseChannelVersionShape('huaanwork', parsed)).toBe(false)
    expect(matchesReleaseChannelVersionShape('beta', parsed)).toBe(true)
  })

  it('rejects a stable-shaped version on the beta channel', () => {
    expect(matchesReleaseChannelVersionShape('beta', parseSemVer('0.1.0')!)).toBe(false)
  })
})

describe('huaanwork version checks', () => {
  it('reports an update when the service echoes the huaanwork channel', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const request: UpdateRequest = async (url, init) => {
      calls.push({ url, init })
      return channelVersionResponse('0.2.0', 'huaanwork')
    }
    const result = await checkForDesktopUpdate({
      currentVersion: '0.1.0',
      channel: 'huaanwork',
      request,
    })
    expect(result).toEqual({ status: 'update-available', currentVersion: '0.1.0', latestVersion: '0.2.0' })
    expect(new Headers(calls[0]!.init.headers).get(DESKTOP_RELEASE_CHANNEL_HEADER)).toBe('huaanwork')
  })

  it('refuses a response that omits the huaanwork channel label', async () => {
    const request: UpdateRequest = async () => versionResponse('0.2.0')
    await expect(checkForDesktopUpdate({ currentVersion: '0.1.0', channel: 'huaanwork', request }))
      .resolves.toBeNull()
  })

  it('refuses a response labeled with a different channel', async () => {
    const request: UpdateRequest = async () => channelVersionResponse('0.2.0', 'stable')
    await expect(checkForDesktopUpdate({ currentVersion: '0.1.0', channel: 'huaanwork', request }))
      .resolves.toBeNull()
  })

  it('accepts the installed 0.1.0 as a valid huaanwork current version', () => {
    expect(() => desktopVersionRequestHeaders(undefined, '0.1.0', 'huaanwork')).not.toThrow()
    expect(desktopVersionRequestHeaders(undefined, '0.1.0', 'huaanwork')[DESKTOP_CURRENT_VERSION_HEADER]).toBe('0.1.0')
  })

  it('carries valid sha256 digests in UpdateCheckResult when present in version response (D-M6-23)', async () => {
    const validHash = 'a'.repeat(64)
    const request: UpdateRequest = async () => channelVersionResponse('0.2.0', 'huaanwork', {
      sha256: { mac: validHash, windows: validHash },
    })
    const result = await checkForDesktopUpdate({
      currentVersion: '0.1.0',
      channel: 'huaanwork',
      request,
    })
    expect(result).toEqual({
      status: 'update-available',
      currentVersion: '0.1.0',
      latestVersion: '0.2.0',
      installerSha256: {
        darwin: validHash,
        win32: validHash,
      },
      sha256: { mac: validHash, windows: validHash },
    })
  })

  it('accepts uppercase and whitespace-padded valid digests, normalizing them (D-M6-23)', async () => {
    // 采上游共享提取器的归一化语义:大写 / 两端空白但本体合法的摘要应被接受并归一,
    // 不应在 fail-closed 校验前被误拒。
    const upper = 'A'.repeat(64)
    const padded = `  ${'b'.repeat(64)}  `
    const request: UpdateRequest = async () => channelVersionResponse('0.2.0', 'huaanwork', {
      sha256: { windows: upper, mac: padded },
    })
    const result = await checkForDesktopUpdate({
      currentVersion: '0.1.0',
      channel: 'huaanwork',
      request,
    })
    expect(result).toEqual({
      status: 'update-available',
      currentVersion: '0.1.0',
      latestVersion: '0.2.0',
      installerSha256: { win32: 'a'.repeat(64), darwin: 'b'.repeat(64) },
      sha256: { windows: 'a'.repeat(64), mac: 'b'.repeat(64) },
    })
  })

  it('refuses a version response carrying an invalid sha256 payload (D-M6-23)', async () => {
    // 非 record
    const req1: UpdateRequest = async () => channelVersionResponse('0.2.0', 'huaanwork', { sha256: 'not-a-record' })
    await expect(checkForDesktopUpdate({ currentVersion: '0.1.0', channel: 'huaanwork', request: req1 })).resolves.toBeNull()

    // 长度不足:归一化后仍非 64 位 hex
    const req2: UpdateRequest = async () => channelVersionResponse('0.2.0', 'huaanwork', { sha256: { mac: 'too-short' } })
    await expect(checkForDesktopUpdate({ currentVersion: '0.1.0', channel: 'huaanwork', request: req2 })).resolves.toBeNull()

    // 归一化后才暴露的非法:大写但含非 hex 字符,trim+lowercase 后仍失败,整检查 fail-closed
    const req3: UpdateRequest = async () => channelVersionResponse('0.2.0', 'huaanwork', { sha256: { win32: `${'A'.repeat(63)}G` } })
    await expect(checkForDesktopUpdate({ currentVersion: '0.1.0', channel: 'huaanwork', request: req3 })).resolves.toBeNull()
  })
})

describe('configurable update origin', () => {
  it('defaults to the intranet update origin rather than the upstream public service', () => {
    expect(resolveUpdateOrigin({})).toBe('http://update.intranet.lan:8790')
    expect(resolveUpdateOrigin({})).not.toContain('dshdesktop.cn')
    expect(resolveUpdateOrigin({})).not.toContain('.example')
  })

  it('reads the deployment origin from the environment and strips a trailing slash', () => {
    expect(resolveUpdateOrigin({ HUAANWORK_UPDATE_ORIGIN: 'https://update.corp.lan:9000/' }))
      .toBe('https://update.corp.lan:9000')
  })

  it('builds the version endpoint from the origin', () => {
    expect(desktopVersionEndpoint('https://update.corp.lan:9000'))
      .toBe('https://update.corp.lan:9000/api/desktop/version')
  })

  it.each([
    'not a url',
    'ftp://update.corp.lan',
    'https://update.corp.lan/base',
    'https://update.corp.lan/?x=1',
    'https://user:pass@update.corp.lan',
    '',
  ])('rejects the unusable origin %s', raw => {
    expect(() => resolveUpdateOrigin({ HUAANWORK_UPDATE_ORIGIN: raw })).toThrow(UpdateOriginError)
  })

  it('requests the configured endpoint', async () => {
    const calls: string[] = []
    const request: UpdateRequest = async url => {
      calls.push(url)
      return channelVersionResponse('0.1.0', 'huaanwork')
    }
    await checkForDesktopUpdate({
      currentVersion: '0.1.0',
      channel: 'huaanwork',
      request,
      origin: 'https://update.corp.lan:9000',
    })
    expect(calls).toEqual(['https://update.corp.lan:9000/api/desktop/version'])
  })
})

