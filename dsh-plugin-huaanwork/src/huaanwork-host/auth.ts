import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Uint8Array,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>

const ACCOUNT_FILE = 'account.json'
const SESSION_FILE = 'auth-session.json'
const KDF = 'scrypt' as const
const N = 16384
const R = 8
const P = 1
const KEYLEN = 32
const SALT_LEN = 16
const MAXMEM = 64 * 1024 * 1024

export type AuthStatus = { state: 'needs-register' | 'logged-out' | 'logged-in'; username?: string }

type Account = {
  username: string
  salt: string
  hash: string
  kdf: typeof KDF
  N: number
  r: number
  p: number
}

function accountPath(profileDir: string): string {
  return join(profileDir, ACCOUNT_FILE)
}

function sessionPath(profileDir: string): string {
  return join(profileDir, SESSION_FILE)
}

function isEnoent(error: unknown): boolean {
  return (error as { code?: string }).code === 'ENOENT'
}

function validateUsername(username: string): string {
  const trimmed = username.trim()
  const length = [...trimmed].length
  if (length < 2 || length > 32) throw new Error('用户名须为 2–32 个字符')
  return trimmed
}

function validatePassword(password: string): void {
  if ([...password].length < 8) throw new Error('密码至少 8 位')
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8'))
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function isAccount(value: unknown): value is Account {
  if (value === null || typeof value !== 'object') return false
  const candidate = value as Record<string, unknown>
  return (
    typeof candidate.username === 'string' &&
    typeof candidate.salt === 'string' &&
    typeof candidate.hash === 'string' &&
    candidate.kdf === KDF &&
    candidate.N === N &&
    candidate.r === R &&
    candidate.p === P
  )
}

async function readAccount(profileDir: string): Promise<Account | undefined> {
  try {
    const parsed = await readJson(accountPath(profileDir))
    return isAccount(parsed) ? parsed : undefined
  } catch (error: unknown) {
    if (isEnoent(error) || error instanceof SyntaxError) return undefined
    throw error
  }
}

async function tryUnlinkSession(profileDir: string): Promise<void> {
  try {
    await unlink(sessionPath(profileDir))
  } catch {
    // Best-effort: missing or unreadable session still counts as logged-out.
  }
}

async function readSessionUsername(profileDir: string): Promise<{ present: boolean; username?: string }> {
  try {
    const parsed = await readJson(sessionPath(profileDir))
    if (parsed !== null && typeof parsed === 'object' && typeof (parsed as { username?: unknown }).username === 'string') {
      return { present: true, username: (parsed as { username: string }).username }
    }
    return { present: true }
  } catch (error: unknown) {
    if (isEnoent(error)) return { present: false }
    return { present: true }
  }
}

async function deriveKey(password: string, salt: Uint8Array): Promise<Buffer> {
  return scryptAsync(password, salt, KEYLEN, { N, r: R, p: P, maxmem: MAXMEM })
}

function equalHash(derived: Buffer, stored: Buffer): boolean {
  if (derived.length !== stored.length) return false
  return timingSafeEqual(derived, stored)
}

async function verifyPassword(account: Account, password: string): Promise<boolean> {
  const stored = Buffer.from(account.hash, 'base64')
  const derived = await deriveKey(password, Buffer.from(account.salt, 'base64'))
  return equalHash(derived, stored)
}

async function hashPassword(password: string): Promise<{ salt: string; hash: string }> {
  const salt = randomBytes(SALT_LEN)
  const hash = await deriveKey(password, salt)
  return { salt: salt.toString('base64'), hash: hash.toString('base64') }
}

export async function authStatus(profileDir: string): Promise<AuthStatus> {
  const account = await readAccount(profileDir)
  const session = await readSessionUsername(profileDir)

  if (!account) {
    if (session.present) await tryUnlinkSession(profileDir)
    return { state: 'needs-register' }
  }

  if (session.present && session.username === account.username) {
    return { state: 'logged-in', username: account.username }
  }

  if (session.present) await tryUnlinkSession(profileDir)
  return { state: 'logged-out', username: account.username }
}

export async function authRegister(profileDir: string, username: string, password: string): Promise<AuthStatus> {
  const trimmed = validateUsername(username)
  validatePassword(password)

  const status = await authStatus(profileDir)
  if (status.state === 'logged-in') return status

  if (await readAccount(profileDir)) throw new Error('已有本地账户，请登录')

  const { salt, hash } = await hashPassword(password)
  const account: Account = { username: trimmed, salt, hash, kdf: KDF, N, r: R, p: P }
  await writeJson(accountPath(profileDir), account)
  await writeJson(sessionPath(profileDir), { username: trimmed })
  return { state: 'logged-in', username: trimmed }
}

export async function authLogin(profileDir: string, username: string, password: string): Promise<AuthStatus> {
  const trimmed = validateUsername(username)
  validatePassword(password)

  const status = await authStatus(profileDir)
  if (status.state === 'logged-in') return status

  const account = await readAccount(profileDir)
  if (!account || account.username !== trimmed || !(await verifyPassword(account, password))) {
    throw new Error('用户名或密码错误')
  }

  await writeJson(sessionPath(profileDir), { username: account.username })
  return { state: 'logged-in', username: account.username }
}

export async function authLogout(profileDir: string): Promise<AuthStatus> {
  await tryUnlinkSession(profileDir)
  const account = await readAccount(profileDir)
  return account ? { state: 'logged-out', username: account.username } : { state: 'needs-register' }
}

export async function authChangePassword(profileDir: string, current: string, next: string): Promise<AuthStatus> {
  const status = await authStatus(profileDir)
  if (status.state !== 'logged-in') throw new Error('未登录')

  const account = await readAccount(profileDir)
  if (!account) throw new Error('未登录')
  if (!(await verifyPassword(account, current))) throw new Error('当前密码不正确')

  validatePassword(next)
  const { salt, hash } = await hashPassword(next)
  await writeJson(accountPath(profileDir), { ...account, salt, hash, kdf: KDF, N, r: R, p: P })
  return { state: 'logged-in', username: account.username }
}
