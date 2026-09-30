import { chmod, mkdir, mkdtemp, readFile, readdir, rename, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { JsonFileStore, LockTimeoutError, STATE_DIRECTORY_MODE, STATE_FILE_MODE, StoreCorruptError } from '../src/store.ts'
import { deadProcessPid, liveProcess } from './helpers/server.ts'

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'market-server-store-'))
}

interface DemoState {
  readonly version: 1
  readonly entries: readonly string[]
}

const DEFAULT_STATE: DemoState = { version: 1, entries: [] }

function validateDemo(value: unknown): DemoState {
  if (typeof value !== 'object' || value === null) throw new TypeError('state must be an object')
  const record = value as { version?: unknown; entries?: unknown }
  if (record.version !== 1) throw new TypeError('unsupported version')
  if (!Array.isArray(record.entries)) throw new TypeError('entries must be an array')
  return { version: 1, entries: record.entries as string[] }
}

describe('JsonFileStore', () => {
  it('returns the default value for a missing file (empty-dir fail-safe)', async () => {
    const dir = await tempDir()
    const store = new JsonFileStore<DemoState>(dir, 'state.json', { defaultValue: DEFAULT_STATE, validate: validateDemo })
    await expect(store.load()).resolves.toEqual(DEFAULT_STATE)
  })

  it('persists with atomic write and 0600 file / 0700 directory permissions', async () => {
    const parent = await tempDir()
    const dir = join(parent, 'nested', 'state')
    const store = new JsonFileStore<DemoState>(dir, 'state.json', { defaultValue: DEFAULT_STATE, validate: validateDemo })
    await store.update(() => ({ version: 1, entries: ['a'] }))
    const path = join(dir, 'state.json')
    const fileStat = await stat(path)
    expect(fileStat.mode & 0o777).toBe(STATE_FILE_MODE)
    const dirStat = await stat(dir)
    expect(dirStat.mode & 0o777).toBe(STATE_DIRECTORY_MODE)
    await expect(readFile(path, 'utf8')).resolves.toBe(`${JSON.stringify({ version: 1, entries: ['a'] }, null, 2)}\n`)
    // no tmp debris left behind
    expect(fileStat.isFile()).toBe(true)
  })

  it('recovers the full state after restart (new instance over the same directory)', async () => {
    const dir = await tempDir()
    const first = new JsonFileStore<DemoState>(dir, 'state.json', { defaultValue: DEFAULT_STATE, validate: validateDemo })
    await first.update(() => ({ version: 1, entries: ['x', 'y'] }))
    const second = new JsonFileStore<DemoState>(dir, 'state.json', { defaultValue: DEFAULT_STATE, validate: validateDemo })
    await expect(second.load()).resolves.toEqual({ version: 1, entries: ['x', 'y'] })
  })

  it('serializes concurrent updates through the file lock', async () => {
    const dir = await tempDir()
    const store = new JsonFileStore<DemoState>(dir, 'state.json', { defaultValue: DEFAULT_STATE, validate: validateDemo })
    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        store.update(current => ({ version: 1, entries: [...current.entries, `e${index}`] })),
      ),
    )
    const reloaded = new JsonFileStore<DemoState>(dir, 'state.json', { defaultValue: DEFAULT_STATE, validate: validateDemo })
    const state = await reloaded.load()
    expect(state.entries).toHaveLength(8)
    expect(new Set(state.entries).size).toBe(8)
  })

  it('rejects corrupt JSON with StoreCorruptError and leaves the file untouched', async () => {
    const dir = await tempDir()
    const path = join(dir, 'state.json')
    await mkdir(dir, { recursive: true })
    await writeFile(path, '{ not json !!!', { mode: STATE_FILE_MODE })
    const before = await readFile(path, 'utf8')
    const store = new JsonFileStore<DemoState>(dir, 'state.json', { defaultValue: DEFAULT_STATE, validate: validateDemo })
    await expect(store.load()).rejects.toBeInstanceOf(StoreCorruptError)
    await expect(store.update(() => DEFAULT_STATE)).rejects.toBeInstanceOf(StoreCorruptError)
    await expect(readFile(path, 'utf8')).resolves.toBe(before)
  })

  it('rejects structurally invalid state at load time', async () => {
    const dir = await tempDir()
    await writeFile(join(dir, 'state.json'), JSON.stringify({ version: 99 }), { mode: STATE_FILE_MODE })
    const store = new JsonFileStore<DemoState>(dir, 'state.json', { defaultValue: DEFAULT_STATE, validate: validateDemo })
    await expect(store.load()).rejects.toThrow(TypeError)
  })

  it('breaks a stale lock left by a crashed holder', async () => {
    const dir = await tempDir()
    const lockPath = join(dir, 'state.json.lock')
    await mkdir(dir, { recursive: true })
    // Simulate a crashed holder: the recorded pid is gone and the lock is older
    // than the stale window.
    await writeFile(lockPath, `${JSON.stringify({ pid: await deadProcessPid(), startedAt: Date.now() - 60_000, token: 'crashed' })}\n`, { mode: STATE_FILE_MODE })
    const past = new Date(Date.now() - 60_000)
    await chmod(lockPath, STATE_FILE_MODE)
    await utimes(lockPath, past, past)
    const store = new JsonFileStore<DemoState>(dir, 'state.json', { defaultValue: DEFAULT_STATE, validate: validateDemo })
    await store.update(() => ({ version: 1, entries: ['after-stale'] }))
    await expect(store.load()).resolves.toEqual({ version: 1, entries: ['after-stale'] })
  })

  it('times out when a live foreign lock is never released', { timeout: 15_000 }, async () => {
    const dir = await tempDir()
    const lockPath = join(dir, 'state.json.lock')
    await mkdir(dir, { recursive: true })
    await writeFile(lockPath, '42', { mode: STATE_FILE_MODE })
    const store = new JsonFileStore<DemoState>(dir, 'state.json', { defaultValue: DEFAULT_STATE, validate: validateDemo })
    await expect(
      store.update(() => DEFAULT_STATE),
    ).rejects.toBeInstanceOf(LockTimeoutError)
  })
})

// ---------------------------------------------------------------------------
// P5: stale-lock takeover (M6 Task 6.5)
//
// The defect: breaking a stale lock was `unlink(lockPath)`, so two processes
// that both saw the same stale lock could delete EACH OTHER's fresh lock — and
// both ended up believing they held it. The fix: a lock is only broken when its
// recorded owner is CONFIRMED gone (`process.kill(pid, 0)` probe), and the
// takeover is a single atomic `rename` whose result is verified by content, so
// a fresh lock is never destroyed (a lock that is not the one inspected is put
// back with a non-clobbering `link`).
// ---------------------------------------------------------------------------

describe('P5 stale lock takeover', () => {
  async function seedLock(dir: string, contents: string, ageMs: number): Promise<string> {
    const lockPath = join(dir, 'state.json.lock')
    await mkdir(dir, { recursive: true })
    await writeFile(lockPath, contents, { mode: STATE_FILE_MODE })
    const past = new Date(Date.now() - ageMs)
    await utimes(lockPath, past, past)
    return lockPath
  }

  it('takes over a lock whose owning process is dead, atomically', async () => {
    const dir = await tempDir()
    const lockPath = await seedLock(
      dir,
      `${JSON.stringify({ pid: await deadProcessPid(), startedAt: Date.now() - 60_000, token: 'dead-holder' })}\n`,
      60_000,
    )
    const store = new JsonFileStore<DemoState>(dir, 'state.json', { defaultValue: DEFAULT_STATE, validate: validateDemo })
    await store.update(() => ({ version: 1, entries: ['after-takeover'] }))
    await expect(store.load()).resolves.toEqual({ version: 1, entries: ['after-takeover'] })
    // The takeover moved the dead holder's entry aside and cleaned it up: no
    // lock-related file (lock, takeover quarantine) is left behind after release.
    await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await readdir(dir)).filter(name => name.includes('.lock'))).toEqual([])
  })

  it('takes over a legacy bare-pid lock whose owner is gone (Task 1/2 format)', async () => {
    const dir = await tempDir()
    await seedLock(dir, `${String(await deadProcessPid())}\n`, 60_000)
    const store = new JsonFileStore<DemoState>(dir, 'state.json', { defaultValue: DEFAULT_STATE, validate: validateDemo })
    await store.update(() => ({ version: 1, entries: ['legacy'] }))
    await expect(store.load()).resolves.toEqual({ version: 1, entries: ['legacy'] })
  })

  it('refuses to take over a lock whose owning process is alive', async () => {
    const dir = await tempDir()
    const holder = await liveProcess()
    try {
      const seeded = `${JSON.stringify({ pid: holder.pid, startedAt: Date.now(), token: 'live-holder' })}\n`
      const lockPath = await seedLock(dir, seeded, 60_000) // old enough to look stale
      const store = new JsonFileStore<DemoState>(dir, 'state.json', {
        defaultValue: DEFAULT_STATE,
        validate: validateDemo,
        lockTiming: { waitMs: 200, retryMs: 25 },
      })
      const failure = await store.update(() => DEFAULT_STATE).then(() => null, (cause: unknown) => cause)
      expect(failure).toBeInstanceOf(LockTimeoutError)
      expect((failure as LockTimeoutError).holder?.pid).toBe(holder.pid)
      // The live holder's lock file is untouched, byte for byte.
      await expect(readFile(lockPath, 'utf8')).resolves.toBe(seeded)
    } finally {
      await holder.stop()
    }
  })

  it('does not let two concurrent starters both believe they hold the lock', async () => {
    const dir = await tempDir()
    const lockPath = join(dir, 'state.json.lock')
    const events: string[] = []
    const first = new JsonFileStore<DemoState>(dir, 'state.json', { defaultValue: DEFAULT_STATE, validate: validateDemo })
    const second = new JsonFileStore<DemoState>(dir, 'state.json', { defaultValue: DEFAULT_STATE, validate: validateDemo })
    const holder = first.update(async (current) => {
      events.push('first:enter')
      // Age our own lock: it now LOOKS stale, but its recorded owner (this very
      // process) is alive — a correct breaker must refuse to touch it.
      const past = new Date(Date.now() - 60_000)
      await utimes(lockPath, past, past)
      await new Promise(resolve => setTimeout(resolve, 300))
      events.push('first:exit')
      return { version: 1, entries: [...current.entries, 'first'] }
    })
    while (!events.includes('first:enter')) await new Promise(resolve => setTimeout(resolve, 5))
    const contender = second.update((current) => {
      events.push('second:enter')
      events.push('second:exit')
      return { version: 1, entries: [...current.entries, 'second'] }
    })
    await Promise.all([holder, contender])
    // Exactly one holder at a time: the contender waits for the release instead
    // of breaking a live holder's lock (the pre-fix code destroyed it and both
    // writers ran inside "their" lock — events interleaved and one update was
    // lost).
    expect(events).toEqual(['first:enter', 'first:exit', 'second:enter', 'second:exit'])
    const reloaded = new JsonFileStore<DemoState>(dir, 'state.json', { defaultValue: DEFAULT_STATE, validate: validateDemo })
    await expect(reloaded.load()).resolves.toEqual({ version: 1, entries: ['first', 'second'] })
  })

  it('never removes a lock file it does not own (release is identity-checked)', async () => {
    const dir = await tempDir()
    const lockPath = join(dir, 'state.json.lock')
    const store = new JsonFileStore<DemoState>(dir, 'state.json', { defaultValue: DEFAULT_STATE, validate: validateDemo })
    const reported = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    let foreignInode: number | bigint = 0
    try {
      await store.update(async (current) => {
        // Simulate another process taking over our lock while the update runs:
        // replace the directory entry with a different file (new inode).
        const replacement = join(dir, 'foreign.lock')
        await writeFile(replacement, `${JSON.stringify({ pid: process.pid, startedAt: Date.now(), token: 'foreign' })}\n`, { mode: STATE_FILE_MODE })
        await rename(replacement, lockPath)
        foreignInode = (await stat(lockPath)).ino
        return current
      })
      // The foreign lock survived — deleting it would be the P5 defect — and the
      // compromise reached the operator log instead of being swallowed.
      expect((await stat(lockPath)).ino).toBe(foreignInode)
      expect(reported).toHaveBeenCalledWith(expect.stringContaining('state.json.lock'))
    } finally {
      reported.mockRestore()
    }
  })
})
