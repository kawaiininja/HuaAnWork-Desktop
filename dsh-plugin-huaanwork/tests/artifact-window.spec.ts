/**
 * 全屏 Artifact 窗口的纯函数契约：安全参数、独占 partition 与启动目标往返。
 * 主进程建窗与 7B 的客户端 shell 共用同一模块，因此这里不依赖 Electron/React。
 */
import { describe, expect, it } from 'vitest'

import {
  artifactWindowOptions,
  artifactWindowTargetFromSearch,
  isArtifactFrameName,
} from '../src/artifact-window.ts'

const PARTITION = 'huaanwork-artifact-11111111-1111-4111-8111-111111111111'

describe('artifactWindowOptions', () => {
  it('opens a fullscreen artifact window without node or business preload', () => {
    const options = artifactWindowOptions(
      { url: 'http://127.0.0.1:3000/' },
      { sessionId: 'session-1', artifactId: 'artifact-1' },
      PARTITION,
    )

    expect(options.fullscreen).toBe(true)
    expect(options.webPreferences).toMatchObject({
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    })
    expect(options.webPreferences).not.toHaveProperty('preload')
    expect(options.webPreferences.partition).toBe(PARTITION)
    expect(artifactWindowTargetFromSearch(new URL(options.url).search))
      .toEqual({ sessionId: 'session-1', artifactId: 'artifact-1' })
  })

  it('keeps the webserver origin and existing markers while adding the artifact target', () => {
    const options = artifactWindowOptions(
      { url: 'http://127.0.0.1:3000/?dsh-desktop-mode=advanced' },
      { sessionId: 'session-2', artifactId: 'artifact-2' },
      PARTITION,
    )

    const url = new URL(options.url)
    expect(url.origin).toBe('http://127.0.0.1:3000')
    expect(url.searchParams.get('dsh-desktop-mode')).toBe('advanced')
    expect(url.searchParams.get('artifactWindow')).toBe('1')
    expect(artifactWindowTargetFromSearch(url.search))
      .toEqual({ sessionId: 'session-2', artifactId: 'artifact-2' })
  })
})

describe('artifactWindowTargetFromSearch', () => {
  it('accepts only artifactWindow=1 with two valid single segments', () => {
    const search = new URLSearchParams({
      artifactWindow: '1',
      sessionId: 'session-1',
      artifactId: 'artifact-1',
    }).toString()

    expect(artifactWindowTargetFromSearch(`?${search}`))
      .toEqual({ sessionId: 'session-1', artifactId: 'artifact-1' })
  })

  it.each([
    ['missing marker', '?sessionId=s&artifactId=a'],
    ['marker not one', '?artifactWindow=0&sessionId=s&artifactId=a'],
    ['missing session', '?artifactWindow=1&artifactId=a'],
    ['missing artifact', '?artifactWindow=1&sessionId=s'],
    ['empty session', '?artifactWindow=1&sessionId=&artifactId=a'],
    ['dot segment', '?artifactWindow=1&sessionId=.&artifactId=a'],
    ['dotdot segment', '?artifactWindow=1&sessionId=..&artifactId=a'],
    ['path separator', '?artifactWindow=1&sessionId=a/b&artifactId=a'],
    ['backslash separator', '?artifactWindow=1&sessionId=a%5Cb&artifactId=a'],
    ['trailing dot', '?artifactWindow=1&sessionId=s&artifactId=a.'],
    ['control character', '?artifactWindow=1&sessionId=s%0A&artifactId=a'],
  ])('rejects an %s target', (_label, search) => {
    expect(artifactWindowTargetFromSearch(search)).toBeUndefined()
  })
})

describe('isArtifactFrameName', () => {
  it('accepts the bounded random frame name and rejects everything else', () => {
    expect(isArtifactFrameName(PARTITION)).toBe(true)
    expect(isArtifactFrameName('huaanwork-artifact-not-a-uuid')).toBe(false)
    expect(isArtifactFrameName('other-11111111-1111-4111-8111-111111111111')).toBe(false)
    expect(isArtifactFrameName(`${PARTITION}\n`)).toBe(false)
    expect(isArtifactFrameName(42)).toBe(false)
  })
})
