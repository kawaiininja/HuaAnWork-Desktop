import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { test } from 'node:test'
import { finishStatus, watchChild } from './run-electron-check.mjs'

test('maps exit codes and signals to a wrapper status', () => {
  assert.equal(finishStatus(0, null), 0)
  assert.equal(finishStatus(4, null), 4)
  assert.equal(finishStatus(null, 'SIGTERM'), 1)
  assert.equal(finishStatus(null, null), 1)
})

test('returns on exit while a grandchild still holds stdio open', async () => {
  const child = spawn(process.execPath, ['-e', `
    const { spawn } = require('node:child_process')
    spawn(process.execPath, ['-e', 'setTimeout(() => {}, 800)'], { stdio: 'inherit' })
    setTimeout(() => process.exit(0), 40)
  `], { stdio: ['ignore', 'pipe', 'pipe'] })
  const started = Date.now()
  let closed = false
  child.once('close', () => { closed = true })
  const status = await new Promise(resolve => {
    watchChild(child, { exit: resolve, write() {}, pollMs: 50 })
  })
  assert.equal(status, 0)
  assert.equal(closed, false)
  assert.ok(Date.now() - started < 400)
})

test('returns the child failure code', async () => {
  const child = spawn(process.execPath, ['-e', 'process.exit(4)'], { stdio: 'ignore' })
  const status = await new Promise(resolve => {
    watchChild(child, { exit: resolve, write() {}, pollMs: 50 })
  })
  assert.equal(status, 4)
})

test('treats a disappeared pid as failure when exit never arrives', async () => {
  const child = { pid: 2147483646, once() {} }
  const kill = process.kill
  process.kill = (pid, signal) => {
    if (pid === child.pid && signal === 0) {
      const error = new Error('no such process')
      error.code = 'ESRCH'
      throw error
    }
    return kill.call(process, pid, signal)
  }
  try {
    const status = await new Promise(resolve => {
      watchChild(child, { exit: resolve, write() {}, pollMs: 20 })
    })
    assert.equal(status, 1)
  } finally {
    process.kill = kill
  }
})
