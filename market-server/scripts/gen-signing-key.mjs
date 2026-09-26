#!/usr/bin/env node
/**
 * Offline Ed25519 signing-key generator for the M5 intranet market.
 *
 * RUN THIS ON THE SIGNING OPERATOR'S MACHINE — never on the market-server
 * host, never in CI. The private key must never enter the market-server
 * process (round3 R9 true-offline ruling); the server only ever holds the
 * public key(s).
 *
 * Usage:
 *   node scripts/gen-signing-key.mjs --out <dir-outside-the-repo> [--force]
 *
 * Outputs (in <dir>):
 *   market-signing-key.pem       PKCS#8 PEM private key, mode 0600. NEVER commit.
 *   market-signing-key.pub.hex   Raw 32-byte public key as lowercase hex — the
 *                                pinnable format for wrapper config (Task 4 Step 3)
 *                                and market-server config (Task 2).
 * Prints the sha256 fingerprint (= keyId) for out-of-band verification.
 *
 * Guards:
 *   - refuses to write inside a git worktree (the private key must not be
 *     reachable by `git add`); root .gitignore also lists market-server/keys/
 *     as defense in depth;
 *   - refuses to overwrite existing key files unless --force.
 */
import { generateKeyPairSync, createHash } from 'node:crypto'
import { existsSync, mkdirSync, openSync, writeFileSync, closeSync, statSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

function parseArgs(argv) {
  const args = { out: undefined, force: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--out') args.out = argv[++i]
    else if (arg === '--force') args.force = true
    else if (arg === '--help' || arg === '-h') args.help = true
    else throw new Error(`unknown argument: ${arg}`)
  }
  return args
}

function isInsideGitWorktree(dir) {
  let current = resolve(dir)
  for (;;) {
    if (existsSync(`${current}/.git`)) return true
    const parent = dirname(current)
    if (parent === current) return false
    current = parent
  }
}

function writeFileMode600(path, contents) {
  const fd = openSync(path, 'w', 0o600)
  try {
    writeFileSync(fd, contents)
  } finally {
    closeSync(fd)
  }
  if ((statSync(path).mode & 0o777) !== 0o600) {
    throw new Error(`failed to set 0600 on ${path}`)
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help || args.out === undefined) {
    console.log('usage: node scripts/gen-signing-key.mjs --out <dir-outside-the-repo> [--force]')
    process.exit(args.help ? 0 : 2)
  }

  const outDir = resolve(args.out)
  if (isInsideGitWorktree(outDir)) {
    console.error(
      `refusing to write signing keys inside a git worktree: ${outDir}\n` +
        'keep the private key outside the repository (and outside any machine the market-server process runs on).',
    )
    process.exit(1)
  }
  mkdirSync(outDir, { recursive: true, mode: 0o700 })

  const privateKeyPath = `${outDir}/market-signing-key.pem`
  const publicKeyPath = `${outDir}/market-signing-key.pub.hex`
  for (const path of [privateKeyPath, publicKeyPath]) {
    if (existsSync(path) && !args.force) {
      console.error(`${path} already exists; pass --force to overwrite (the old key pair will be lost)`)
      process.exit(1)
    }
  }

  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const spki = publicKey.export({ format: 'der', type: 'spki' })
  const rawPublicKey = spki.subarray(-32)
  const publicKeyHex = rawPublicKey.toString('hex')
  const fingerprint = createHash('sha256').update(rawPublicKey).digest('hex')

  writeFileMode600(privateKeyPath, privateKey.export({ format: 'pem', type: 'pkcs8' }))
  writeFileSync(publicKeyPath, `${publicKeyHex}\n`, { mode: 0o644 })

  console.log('Ed25519 signing key pair generated (offline).')
  console.log(`  private key : ${privateKeyPath} (mode 0600 — NEVER commit, NEVER copy to the market-server host)`)
  console.log(`  public key  : ${publicKeyPath} (raw hex, pinnable)`)
  console.log(`  publicKeyHex: ${publicKeyHex}`)
  console.log(`  fingerprint : ${fingerprint}  (= keyId; verify out-of-band before pinning)`)
}

main()
