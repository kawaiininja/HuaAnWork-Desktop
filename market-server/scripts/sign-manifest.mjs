#!/usr/bin/env node
/**
 * Offline manifest signer — step 2 of the two-step release flow.
 *
 * Flow (round3 R9, supply-chain pinning in market-face-spec):
 *   1. market-server (admin upload) computes the sha manifest + anti-replay
 *      envelope and emits a PENDING manifest file; activation stays blocked.
 *   2. The signing operator downloads the pending manifest, runs THIS script
 *      with the offline private key, and uploads the resulting DETACHED
 *      signature record.
 *   3. market-server verifies against the configured public key slot and only
 *      then activates the manifest (fail-closed without a valid signature).
 *
 * The private key never leaves the operator's machine and never enters the
 * market-server process.
 *
 * Usage:
 *   node scripts/sign-manifest.mjs \
 *     --manifest <pending-manifest.json> \
 *     --key <market-signing-key.pem> \
 *     --slot 1|2 \
 *     [--signed-at <ISO-8601-UTC>]   (default: current time)
 *     [--out <signature.json>]       (default: <manifest>.sig.json)
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { signManifest } from '../src/signing.ts'

function parseArgs(argv) {
  const args = { manifest: undefined, key: undefined, slot: undefined, signedAt: undefined, out: undefined }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--manifest') args.manifest = argv[++i]
    else if (arg === '--key') args.key = argv[++i]
    else if (arg === '--slot') args.slot = Number(argv[++i])
    else if (arg === '--signed-at') args.signedAt = argv[++i]
    else if (arg === '--out') args.out = argv[++i]
    else if (arg === '--help' || arg === '-h') args.help = true
    else throw new Error(`unknown argument: ${arg}`)
  }
  return args
}

function assertEnvelopeShape(envelope) {
  const required = ['version', 'domain', 'revision', 'issuedAt', 'notAfter']
  for (const field of required) {
    if (envelope[field] === undefined || envelope[field] === null || envelope[field] === '') {
      throw new Error(`manifest envelope is missing required anti-replay field "${field}"; refusing to sign`)
    }
  }
  if (envelope.domain !== envelope.domain.trim() || !/^https?:\/\//.test(envelope.domain)) {
    throw new Error(`manifest envelope domain must be an http(s) origin, got: ${String(envelope.domain)}`)
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help || args.manifest === undefined || args.key === undefined || args.slot === undefined) {
    console.log(
      'usage: node scripts/sign-manifest.mjs --manifest <pending-manifest.json> --key <private.pem> --slot 1|2 [--signed-at <ISO-8601>] [--out <sig.json>]',
    )
    process.exit(args.help ? 0 : 2)
  }
  if (args.slot !== 1 && args.slot !== 2) {
    console.error(`--slot must be 1 or 2, got ${args.slot}`)
    process.exit(2)
  }

  const manifest = JSON.parse(readFileSync(args.manifest, 'utf8'))
  if (typeof manifest !== 'object' || manifest === null || typeof manifest.envelope !== 'object' || manifest.envelope === null) {
    console.error('manifest must be a JSON object with an "envelope" object')
    process.exit(1)
  }
  assertEnvelopeShape(manifest.envelope)

  const privateKeyPem = readFileSync(args.key, 'utf8')
  const signedAt = args.signedAt ?? new Date().toISOString()

  const signatureRecord = signManifest(manifest, { privateKeyPem, slot: args.slot, signedAt })
  const outPath = args.out ?? `${args.manifest}.sig.json`
  writeFileSync(outPath, `${JSON.stringify(signatureRecord, null, 2)}\n`, { mode: 0o644 })

  console.log(`detached signature written: ${outPath}`)
  console.log(`  keyId   : ${signatureRecord.keyId}`)
  console.log(`  slot    : ${signatureRecord.slot}`)
  console.log(`  signedAt: ${signatureRecord.signedAt}`)
  console.log('upload this signature record to the market-server to activate the manifest')
}

main()
