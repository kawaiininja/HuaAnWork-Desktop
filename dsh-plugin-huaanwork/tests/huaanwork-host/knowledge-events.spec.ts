import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import AdmZip from 'adm-zip'
import { afterEach, describe, expect, it } from 'vitest'
import {
  appendKnowledgeEvent,
  EVENT_DETAIL_MAX_BYTES,
  EVENT_MAX_BYTES,
  EVENT_MAX_LINES,
  EVENT_SUMMARY_MAX_BYTES,
  readKnowledgeEvents,
} from '../../src/huaanwork-host/knowledge/events.ts'
import {
  createDesktopProfileCheckpoint,
  DESKTOP_PROFILE_CHECKPOINT_FILES,
} from '../../src/profile-checkpoint.ts'
import { exportDesktopDiagnostics } from '../../src/diagnostic-export.ts'

const eventTempDirs: string[] = []
function makeEventTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  eventTempDirs.push(dir)
  return dir
}

describe('knowledge events log and checkpoint/diagnostics exclusion', () => {
  afterEach(() => {
    for (const dir of eventTempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })
  it('masks secrets before UTF-8 byte truncation and enforces 500 lines / 512 KB bounds', async () => {
    const kbDir = mkdtempSync(join(tmpdir(), 'kb-events-'))
    const longDetail = `Bearer sk-secret-token-1234567890 api_key=abc123456789 ${'中文详情'.repeat(2_000)}`
    const ev = await appendKnowledgeEvent(kbDir, {
      kind: 'file_error',
      level: 'error',
      summary: `失败 sk-1234567890abcdef ${'标题'.repeat(300)}`,
      detail: longDetail,
    })
    expect(ev.summary).not.toContain('sk-1234567890abcdef')
    expect(ev.detail).not.toContain('sk-secret-token-1234567890')
    expect(Buffer.byteLength(ev.summary, 'utf8')).toBeLessThanOrEqual(EVENT_SUMMARY_MAX_BYTES)
    expect(Buffer.byteLength(ev.detail ?? '', 'utf8')).toBeLessThanOrEqual(EVENT_DETAIL_MAX_BYTES)
    // M-2：断言磁盘落盘内容不含密钥原文，并验证跨 512B 截断边界的密钥先脱敏再截断
    // （504B 中文 + 空格后紧接 sk-... 跨越 512B：若先截断只剩 sk-Boun 将逃过正则，先脱敏则变为 sk-****）。
    const boundarySecret = 'sk-BoundarySecret9876543210'
    const boundaryEv = await appendKnowledgeEvent(kbDir, {
      kind: 'file_error',
      level: 'error',
      summary: `${'详'.repeat(168)} ${boundarySecret}`,
      relPath: `${'p'.repeat(EVENT_MAX_BYTES + 10_000)}/secret.md`,
    })
    expect(boundaryEv.summary).not.toContain('Boundary')
    expect(boundaryEv.summary).toContain('sk-****')
    expect(Buffer.byteLength(boundaryEv.relPath ?? '', 'utf8')).toBeLessThanOrEqual(EVENT_DETAIL_MAX_BYTES)
    const diskAfterBoundary = readFileSync(join(kbDir, 'events.jsonl'), 'utf8')
    expect(diskAfterBoundary).not.toContain('sk-1234567890abcdef')
    expect(diskAfterBoundary).not.toContain('sk-secret-token-1234567890')
    expect(diskAfterBoundary).not.toContain('Boundary')
    // M-1：超大 relPath 被安全截断，单条记录绝不会把 events.jsonl 撑破 512 KB 上限。
    expect(Buffer.byteLength(diskAfterBoundary, 'utf8')).toBeLessThanOrEqual(EVENT_MAX_BYTES)

    for (let i = 0; i < 550; i += 1) {
      await appendKnowledgeEvent(kbDir, {
        kind: 'file_indexed',
        level: 'info',
        summary: `indexed-${i}`,
        detail: 'd'.repeat(1_200),
      })
    }
    const raw = readFileSync(join(kbDir, 'events.jsonl'), 'utf8')
    const lines = raw.trim().split('\n')
    expect(lines.length).toBeLessThanOrEqual(EVENT_MAX_LINES)
    expect(Buffer.byteLength(raw, 'utf8')).toBeLessThanOrEqual(EVENT_MAX_BYTES)
    if (process.platform !== 'win32') {
      expect(statSync(join(kbDir, 'events.jsonl')).mode & 0o777).toBe(0o600)
    }
  })

  it('filters events cleanly across all / alerts / organize / sync pills', async () => {
    const kbDir = mkdtempSync(join(tmpdir(), 'kb-ev-filter-'))
    await appendKnowledgeEvent(kbDir, { kind: 'sync_completed', level: 'info', summary: 'sync done' })
    await appendKnowledgeEvent(kbDir, { kind: 'watch_failed', level: 'warn', summary: 'watch down' })
    await appendKnowledgeEvent(kbDir, { kind: 'organize_failed', level: 'error', summary: 'org err' })
    await appendKnowledgeEvent(kbDir, { kind: 'organize_completed', level: 'info', summary: 'org ok' })
    await appendKnowledgeEvent(kbDir, { kind: 'cloud_probe_unavailable', level: 'info', summary: 'probe fallback' })

    expect((await readKnowledgeEvents(kbDir, { filter: 'all' })).length).toBe(5)
    expect((await readKnowledgeEvents(kbDir, { filter: 'alerts' })).map(e => e.kind)).toEqual(['watch_failed', 'organize_failed'])
    expect((await readKnowledgeEvents(kbDir, { filter: 'organize' })).map(e => e.kind)).toEqual(['organize_failed', 'organize_completed'])
    expect((await readKnowledgeEvents(kbDir, { filter: 'sync' })).map(e => e.kind)).toEqual(['sync_completed', 'cloud_probe_unavailable'])
  })

  it('excludes all knowledge files and directories from profile checkpoints and diagnostics zips', async () => {
    for (const forbidden of ['knowledge-bases.json', 'session-knowledge.json', 'session-citations', 'workspace-knowledge']) {
      expect(DESKTOP_PROFILE_CHECKPOINT_FILES as readonly string[]).not.toContain(forbidden)
    }

    const root = mkdtempSync(join(tmpdir(), 'kb-excl-'))
    const userDataDir = join(root, 'user-data')
    const profileDir = join(root, 'profiles', 'default')
    const homeDir = join(root, 'home')
    mkdirSync(join(profileDir, 'workspace-knowledge', 'kb-1', 'wiki'), { recursive: true })
    mkdirSync(join(profileDir, 'session-citations'), { recursive: true })
    mkdirSync(join(userDataDir, 'workspace-knowledge', 'kb-1'), { recursive: true })
    mkdirSync(join(userDataDir, 'session-citations'), { recursive: true })
    mkdirSync(join(userDataDir, 'logs'), { recursive: true })
    mkdirSync(homeDir, { recursive: true })

    writeFileSync(join(profileDir, 'package.json'), '{"name":"p","private":true}\n')
    writeFileSync(join(profileDir, 'knowledge-bases.json'), '{"knowledgeBases":[]}\n')
    writeFileSync(join(profileDir, 'session-knowledge.json'), '{}\n')
    writeFileSync(join(profileDir, 'session-citations', 's1.json'), '{"secret":"kb-private"}\n')
    writeFileSync(join(profileDir, 'workspace-knowledge', 'kb-1', 'index.sqlite'), 'sqlite-bytes')
    writeFileSync(join(profileDir, 'workspace-knowledge', 'kb-1', 'wiki', 'INDEX.md'), '# private')

    // 1. Real profile checkpoint capture must exclude all 4 knowledge paths
    const checkpoint = createDesktopProfileCheckpoint({ userDataDir, profileDir, homeDir })
    const captured = checkpoint.captureHealthy()
    expect(captured.status).toBe('captured')
    if (captured.status === 'captured') {
      const snapNames = captured.manifest.files.map(f => f.name as string)
      expect(snapNames).not.toContain('knowledge-bases.json')
      expect(snapNames).not.toContain('session-knowledge.json')
      expect(existsSync(join(captured.snapshotDirectory, 'knowledge-bases.json'))).toBe(false)
      expect(existsSync(join(captured.snapshotDirectory, 'workspace-knowledge'))).toBe(false)
      expect(existsSync(join(captured.snapshotDirectory, 'session-citations'))).toBe(false)
    }

    // 2. Real diagnostics zip must never bundle knowledge files even if placed beside logs/userDataDir
    writeFileSync(join(userDataDir, 'knowledge-bases.json'), '{"secret":true}\n')
    writeFileSync(join(userDataDir, 'session-knowledge.json'), '{"secret":true}\n')
    writeFileSync(join(userDataDir, 'workspace-knowledge', 'kb-1', 'index.sqlite'), 'sqlite-bytes')
    writeFileSync(join(userDataDir, 'session-citations', 's1.json'), '{}')
    writeFileSync(join(userDataDir, 'logs', 'dsh-2026-11-25.log'), 'normal log\n')

    const zipPath = await exportDesktopDiagnostics(userDataDir, { appVersion: '1.0.0-test' })
    const entryNames = new AdmZip(zipPath).getEntries().map(e => e.entryName)
    for (const name of entryNames) {
      expect(name).not.toMatch(/knowledge-bases\.json|session-knowledge\.json|session-citations|workspace-knowledge/u)
    }
  })

  it('bounds injected id/at, drops non-finite count, preserves 4-byte emoji UTF-8 boundary, and serializes concurrent appends (M-6)', async () => {
    const kbDir = makeEventTempDir('kb-events-m6-')
    const ev = await appendKnowledgeEvent(kbDir, {
      id: `sk-SecretId1234567890-${'x'.repeat(300)}`,
      at: '2026-11-26T00:00:00.000Z-' + 'y'.repeat(200),
      kind: 'sync_completed',
      level: 'info',
      summary: `${'🚀'.repeat(200)}`,
      count: Number.NaN,
    })
    expect(ev.id).not.toContain('SecretId1234567890')
    expect(Buffer.byteLength(ev.id, 'utf8')).toBeLessThanOrEqual(128)
    expect(Buffer.byteLength(ev.at, 'utf8')).toBeLessThanOrEqual(64)
    expect(ev.count).toBeUndefined()
    expect(Buffer.byteLength(ev.summary, 'utf8')).toBeLessThanOrEqual(EVENT_SUMMARY_MAX_BYTES)
    expect(ev.summary).not.toContain('\uFFFD')

    // 并发通过等价路径（含 `.` 段）追加 20 条，队列 key 经 resolve() 归一化后零丢条。
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        appendKnowledgeEvent(i % 2 === 0 ? kbDir : join(kbDir, '.'), {
          kind: 'file_indexed',
          level: 'info',
          summary: `parallel-${String(i)}`,
        })),
    )
    const all = await readKnowledgeEvents(kbDir)
    expect(all).toHaveLength(21)
  })
})
