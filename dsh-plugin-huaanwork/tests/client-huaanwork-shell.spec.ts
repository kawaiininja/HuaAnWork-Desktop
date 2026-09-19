import { describe, expect, test } from 'vitest'
import { applyHuaanworkShell } from '../src/client-huaanwork/shell.ts'

function fakeCtx(layoutTaken = false) {
  const provided = new Map<string, unknown>(layoutTaken ? [['layout', {}]] : [])
  const slots: Array<{ options: any, component: any }> = []
  const ctx = {
    reflect: {
      get: (key: string) => provided.get(key),
      provide: (key: string, value: unknown) => { provided.set(key, value); return () => provided.delete(key) },
    },
    slots: {
      register: (options: any, component: any) => { slots.push({ options, component }); return () => {} },
      subscribe: () => () => {},
      provideRoot: () => () => {},
      entries: () => [],
    },
    effect: (fn: () => unknown) => { fn() },
  }
  return { ctx: ctx as any, provided, slots }
}

const environment = { mode: 'advanced', platform: 'darwin', version: '0.1.0', material: 'off', mica: false, titlebarInset: 0 } as any

describe('applyHuaanworkShell', () => {
  test('layout 已被占用时抛配置冲突(所有权不变量)', () => {
    const { ctx } = fakeCtx(true)
    expect(() => applyHuaanworkShell(ctx, environment)).toThrow(/exclusive layout ownership/)
  })

  test('注册 root slot 并提供 layout service', () => {
    const { ctx, provided, slots } = fakeCtx()
    applyHuaanworkShell(ctx, environment)
    expect(provided.has('layout')).toBe(true)
    const root = slots.find((s) => s.options.name === 'root')
    expect(root).toBeDefined()
    expect(Object.keys(root!.options.children).sort()).toEqual(['main', 'rightbar', 'shell.overlay', 'sidebar'])
  })
})
