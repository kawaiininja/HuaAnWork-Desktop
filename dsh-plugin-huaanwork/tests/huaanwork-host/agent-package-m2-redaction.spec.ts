/**
 * Task 7 (I-8): the acceptance probe's shared redaction helper.
 *
 * `scripts/huaanwork-acceptance-redaction.mjs` is a plain ESM module (the probe is a
 * `.mjs` script and is not part of any `tsc` program), so the import carries a
 * `@ts-expect-error` for the missing declaration file. The behaviour itself is
 * pinned here: tokens and PEM blocks must never survive into a failure report.
 */

import assert from 'node:assert/strict'
import { describe, expect, it } from 'vitest'

// @ts-expect-error -- untyped ESM helper shared with the .mjs acceptance probe
import { redactSecrets } from '../../scripts/huaanwork-acceptance-redaction.mjs'

describe('acceptance probe redaction', () => {
  it('redacts tokens and PEM blocks before a failure report is written', () => {
    const secret = 'sk-live-0123456789abcdef'
    const pem = '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----'
    const text = redactSecrets(`failed ${secret} ${pem}`, [secret]) as string
    assert.equal(text.includes(secret), false)
    assert.equal(text.includes('BEGIN PRIVATE KEY'), false)
    expect(text).toMatch(/\[REDACTED/)
    expect(text).toContain('[REDACTED PRIVATE KEY]')
  })

  it('redacts an unterminated PEM block and keeps ordinary text intact', () => {
    const text = redactSecrets(
      'failed: -----BEGIN RSA PRIVATE KEY-----\nMIIabc\nno end marker',
      [],
    ) as string
    assert.equal(text.includes('MIIabc'), false)
    expect(text).toMatch(/\[REDACTED PRIVATE KEY\]/)
    assert.equal(redactSecrets('plain failure text', ['some-token']), 'plain failure text')
  })

  it('replaces the longest configured secret first', () => {
    const short = 'probe-token-0123456789'
    const long = `${short}-extended`
    assert.equal(redactSecrets(`x ${long} y`, [short, long]), 'x [REDACTED] y')
    // Every non-empty configured value is redacted, in any order.
    assert.equal(redactSecrets('a b', ['', 'b']), 'a [REDACTED]')
  })
})
