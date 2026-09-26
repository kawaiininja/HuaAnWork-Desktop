import { chmod, mkdir, mkdtemp, readFile, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { JsonFileStore, LockTimeoutError, STATE_DIRECTORY_MODE, STATE_FILE_MODE, StoreCorruptError } from '../src/store.ts'

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
    // Simulate a crashed holder: lock exists and is older than the stale window.
    await writeFile(lockPath, '999999', { mode: STATE_FILE_MODE })
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
