import test from 'node:test'
import assert from 'node:assert/strict'
import { assertHostRestartEvidence } from './huaanwork-accept-host-restart.mjs'

const STALE_TEXT = '状态不可恢复 · Host 已重启，结果未确认'

function validEvidence() {
  return {
    before: { canary: 'canary-1', timeOrigin: 1234.5, origin: 'http://127.0.0.1:43120' },
    restart: { oldPid: 123, newPid: 456 },
    after: { canary: 'canary-1', timeOrigin: 1234.5, origin: 'http://127.0.0.1:43120' },
    mainRunCountBefore: 4,
    mainRunCountAfter: 4,
    staleCards: [{ text: STALE_TEXT, terminateDisabled: true, elapsed: '00:42', phase: 'tool' }],
    staleCardsLater: [{ text: STALE_TEXT, terminateDisabled: true, elapsed: '00:42', phase: 'tool' }],
  }
}

test('accepts changed Host pids with the same document and frozen stale cards', () => {
  assert.doesNotThrow(() => assertHostRestartEvidence(validEvidence()))
})

test('rejects a restart that did not replace the Host process', () => {
  const evidence = validEvidence()
  evidence.restart.newPid = evidence.restart.oldPid
  assert.throws(() => assertHostRestartEvidence(evidence), /Host pid did not change/)
})

test('rejects a replacement document or main-process restart', () => {
  const document = validEvidence()
  document.after.timeOrigin += 1
  assert.throws(() => assertHostRestartEvidence(document), /renderer document was replaced/)
  const main = validEvidence()
  main.mainRunCountAfter += 1
  assert.throws(() => assertHostRestartEvidence(main), /main process restarted/)
})

test('rejects enabled stale controls, terminal guesses, and advancing elapsed time', () => {
  const enabled = validEvidence()
  enabled.staleCards[0].terminateDisabled = false
  assert.throws(() => assertHostRestartEvidence(enabled), /terminate control is enabled/)
  const terminal = validEvidence()
  terminal.staleCards[0].phase = 'completed'
  assert.throws(() => assertHostRestartEvidence(terminal), /terminal phase/)
  const elapsed = validEvidence()
  elapsed.staleCardsLater[0].elapsed = '00:43'
  assert.throws(() => assertHostRestartEvidence(elapsed), /elapsed time advanced/)
})
