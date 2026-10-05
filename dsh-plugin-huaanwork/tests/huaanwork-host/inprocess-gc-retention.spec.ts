/**
 * 同进程分支的 market 制品 GC 检查点保留覆盖测试 (M21 Task 3.1)。
 *
 * 验证在无全局 process.env 注入的情况下，通过显式实参传递 checkpointUserDataDir：
 * 1. 检查点引用的制品在卸载 GC 时予以保留；
 * 2. 孤儿制品在启动清扫时被正确清理；
 * 3. 传空串时退化为修复前的无检查点行为（被引用的制品也被删除）。
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { DesktopProfileCheckpoint } from '../../src/profile-checkpoint.ts'
import {
  gcRemovedPackageArtifacts,
  marketArtifactName,
  sweepOrphanMarketArtifacts,
} from '../../src/huaanwork-host/market/artifacts.ts'

const roots: string[] = []

afterEach(() => {
  while (roots.length > 0) {
    rmSync(roots.pop()!, { recursive: true, force: true })
  }
})

function tempProfile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hw-inprocess-profile-'))
  roots.push(dir)
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ name: 'profile', dependencies: {} }, undefined, 2)}\n`)
  return dir
}

function tempUserDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hw-inprocess-userdata-'))
  roots.push(dir)
  return dir
}

function artifactFile(profileDir: string, name: string, version: string, sha: string): string {
  mkdirSync(join(profileDir, '.market-artifacts'), { recursive: true })
  const path = join(profileDir, '.market-artifacts', marketArtifactName(name, version, sha))
  writeFileSync(path, 'bytes')
  return path
}

function profileManifest(dependencies: Record<string, string>): string {
  return `${JSON.stringify({ name: 'profile', dependencies }, undefined, 2)}\n`
}

describe('in-process GC retention with config parameter (N-11 / M21)', () => {
  test('retains checkpoint-referenced artifacts without global env, sweeps orphans, and degrades on empty string', () => {
    // 确保主进程未设置已废弃的全局 env
    const legacyEnv = ['HUAANWORK', 'CHECKPOINT', 'USER', 'DATA', 'DIR'].join('_')
    expect(process.env[legacyEnv]).toBeUndefined()

    const profileDir = tempProfile()
    const userDataDir = tempUserDataDir()

    const artifactA = artifactFile(profileDir, '@x/plugin-a', '1.0.0', 'a'.repeat(64))
    const orphanB = artifactFile(profileDir, '@x/orphan-b', '1.0.0', 'b'.repeat(64))

    // 1. 安装态: 写入引用并记录健康检查点
    writeFileSync(join(profileDir, 'package.json'), profileManifest({ '@x/plugin-a': `file:${artifactA}` }))
    const checkpoint = new DesktopProfileCheckpoint({
      userDataDir,
      profileDir,
      profileName: 'test-profile',
      provider: 'desktop-profile',
    })
    expect(checkpoint.captureHealthy().status).toBe('captured')

    // 2. 模拟卸载: profile package.json 清空
    writeFileSync(join(profileDir, 'package.json'), profileManifest({}))

    // 3. 直接调用 gcRemovedPackageArtifacts 传入 userDataDir:
    //    由于 checkpoint slot 仍引用 @x/plugin-a，制品必须被保留
    gcRemovedPackageArtifacts(profileDir, '@x/plugin-a', userDataDir, () => {})
    expect(existsSync(artifactA)).toBe(true)

    // 4. 清扫孤儿制品:
    //    orphanB 无引用被清理，artifactA 因 checkpoint 保留
    const swept = sweepOrphanMarketArtifacts(profileDir, userDataDir, () => {})
    expect(swept).toEqual([marketArtifactName('@x/orphan-b', '1.0.0', 'b'.repeat(64))])
    expect(existsSync(orphanB)).toBe(false)
    expect(existsSync(artifactA)).toBe(true)

    // 5. 传空串时退化:
    //    checkpointUserDataDir === '' 视为空集，artifactA 恢复被删除
    gcRemovedPackageArtifacts(profileDir, '@x/plugin-a', '', () => {})
    expect(existsSync(artifactA)).toBe(false)
  })
})
