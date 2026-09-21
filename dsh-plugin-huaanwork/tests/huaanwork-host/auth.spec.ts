import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  authChangePassword,
  authLogin,
  authLogout,
  authRegister,
  authStatus,
} from '../../src/huaanwork-host/auth.ts'

function withDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'huaanwork-auth-spec-'))
  return run(dir).finally(() => {
    rmSync(dir, { recursive: true, force: true })
  })
}

describe('auth lifecycle & scrypt validation', () => {
  test('register then status is logged-in; logged-in register is a no-op; logged-out register fails', async () => {
    await withDir(async (dir) => {
      expect(await authStatus(dir)).toEqual({ state: 'needs-register' })
      const ok = await authRegister(dir, '  张三  ', 'password1')
      expect(ok.state).toBe('logged-in')
      expect(ok.username).toBe('张三')
      const again = await authRegister(dir, '李四', 'password9')
      expect(again.state).toBe('logged-in')
      expect(again.username).toBe('张三')
      await authLogout(dir)
      await expect(authRegister(dir, '李四', 'password1')).rejects.toThrow('已有本地账户，请登录')
      const raw = readFileSync(join(dir, 'account.json'), 'utf8')
      expect(raw.includes('password1')).toBe(false)
      expect(raw.includes('password9')).toBe(false)
    })
  })

  test('wrong password and bad session file', async () => {
    await withDir(async (dir) => {
      await authRegister(dir, 'ann', 'password1')
      await authLogout(dir)
      await expect(authLogin(dir, 'ann', 'nope!!!!')).rejects.toThrow('用户名或密码错误')
      writeFileSync(join(dir, 'auth-session.json'), `${JSON.stringify({ username: 'other' })}\n`, 'utf8')
      expect((await authStatus(dir)).state).toBe('logged-out')
      writeFileSync(join(dir, 'auth-session.json'), '{', 'utf8')
      expect((await authStatus(dir)).state).toBe('logged-out')
    })
  })

  test('status stays logged-in when session file is still on disk', async () => {
    await withDir(async (dir) => {
      await authRegister(dir, 'ann', 'password1')
      expect((await authStatus(dir)).state).toBe('logged-in')
      expect((await authStatus(dir)).state).toBe('logged-in')
      const raw = readFileSync(join(dir, 'auth-session.json'), 'utf8')
      expect(raw).toContain('ann')
    })
  })

  test('logout keeps account; matching session restores login', async () => {
    await withDir(async (dir) => {
      await authRegister(dir, 'ann', 'password1')
      expect((await authLogout(dir)).state).toBe('logged-out')
      expect((await authStatus(dir)).state).toBe('logged-out')
      expect(readFileSync(join(dir, 'account.json'))).toBeDefined()
      const again = await authLogin(dir, 'ann', 'password1')
      expect(again.state).toBe('logged-in')
      expect((await authStatus(dir)).state).toBe('logged-in')
    })
  })

  test('changePassword and validation', async () => {
    await withDir(async (dir) => {
      await expect(authChangePassword(dir, 'x', 'yyyyyyyy')).rejects.toThrow('未登录')
      await expect(authRegister(dir, ' ', 'password1')).rejects.toThrow('用户名须为 2–32 个字符')
      await expect(authRegister(dir, 'ab', 'short')).rejects.toThrow('密码至少 8 位')
      await authRegister(dir, 'ann', 'password1')
      await expect(authChangePassword(dir, 'wrongxxx', 'password2')).rejects.toThrow('当前密码不正确')
      await expect(authRegister(dir, `${'张'.repeat(33)}`, 'password1')).rejects.toThrow('用户名须为 2–32 个字符')
      await authChangePassword(dir, 'password1', 'password2')
      await authLogout(dir)
      const ok = await authLogin(dir, 'ann', 'password2')
      expect(ok.state).toBe('logged-in')
      const noop = await authLogin(dir, 'other', 'password9')
      expect(noop.state).toBe('logged-in')
      expect(noop.username).toBe('ann')
    })
  })

  test('logout with no account is needs-register; username mismatch fails', async () => {
    await withDir(async (dir) => {
      expect((await authLogout(dir)).state).toBe('needs-register')
      await authRegister(dir, 'ann', 'password1')
      await authLogout(dir)
      await expect(authLogin(dir, 'bob', 'password1')).rejects.toThrow('用户名或密码错误')
    })
  })
})
