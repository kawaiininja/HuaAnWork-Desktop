import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { generateKeyPair, signAgentPackageDigest } from '@huaanwork/catalog-signing'

import {
  compareAgentPackageVersions,
  createAgentPackageDigest,
  readUnsignedPackageFiles,
  verifyAgentPackageDigest,
  verifyAgentPackageDirectory,
} from '../src/index.ts'
import {
  VALID_MANIFEST,
  VALID_PERSONA,
  createTempDir,
  createValidPackageDir,
  removeTempDir,
  writePackageFiles,
} from './helpers.ts'

const manifest = { ...VALID_MANIFEST }
const files = [
  { path: 'persona.md', data: Buffer.from('你是周报助手') },
  { path: 'agent.json', data: Buffer.from(JSON.stringify(manifest)) },
]

test('digest binds sorted paths, sizes, and content hashes', () => {
  const digest = createAgentPackageDigest(manifest, files)
  assert.deepEqual(digest.files.map((file) => file.path), ['agent.json', 'persona.md'])
  assert.equal(digest.manifestSha256, createHash('sha256').update(files[1]!.data).digest('hex'))
  assert.doesNotThrow(() => verifyAgentPackageDigest(manifest, files, digest))
  files[0]!.data = Buffer.from('tampered')
  assert.throws(() => verifyAgentPackageDigest(manifest, files, digest), /包校验失败/)
  assert.throws(() => createAgentPackageDigest(manifest, [files[0]!, files[0]!]), /重复文件/)
  assert.throws(() => createAgentPackageDigest(manifest, [files[0]!]), /缺少 agent\.json/)
})

test('semver update comparison includes prerelease and ignores build metadata', () => {
  assert.equal(compareAgentPackageVersions('1.0.1', '1.0.0'), 1)
  assert.equal(compareAgentPackageVersions('1.0.0', '1.0.0+build.2'), 0)
  assert.equal(compareAgentPackageVersions('1.0.0-beta.2', '1.0.0'), -1)
  assert.equal(compareAgentPackageVersions('1.0.0-beta.10', '1.0.0-beta.2'), 1)
})

test('rejects more than 1024 file entries and accepts exactly 1024', (t) => {
  const tooMany = createTempDir()
  t.after(() => removeTempDir(tooMany))
  for (let index = 0; index < 1025; index += 1) {
    writeFileSync(join(tooMany, `filler-${index}.bin`), Buffer.alloc(0))
  }
  assert.throws(() => readUnsignedPackageFiles(tooMany), /条目数超过1024/)

  const boundary = createValidPackageDir()
  t.after(() => removeTempDir(boundary))
  for (let index = 0; index < 1022; index += 1) {
    writeFileSync(join(boundary, `filler-${index}.bin`), Buffer.alloc(0))
  }
  assert.equal(readUnsignedPackageFiles(boundary).length, 1024)
})

test('counts directories against the same 1024 entry budget', (t) => {
  const tooMany = createTempDir()
  t.after(() => removeTempDir(tooMany))
  for (let index = 0; index < 1025; index += 1) {
    mkdirSync(join(tooMany, `dir-${index}`))
  }
  assert.throws(() => readUnsignedPackageFiles(tooMany), /条目数超过1024/)
})

test('rejects a normalized path over 512 bytes and accepts exactly 512', (t) => {
  const overLong = createValidPackageDir()
  t.after(() => removeTempDir(overLong))
  const tooLong = `a/${'b'.repeat(255)}/${'c'.repeat(255)}`
  assert.equal(Buffer.byteLength(tooLong, 'utf8'), 513)
  writePackageFiles(overLong, { [tooLong]: Buffer.alloc(0) })
  assert.throws(() => readUnsignedPackageFiles(overLong), /路径超过512字节/)

  const boundary = createValidPackageDir()
  t.after(() => removeTempDir(boundary))
  const exactly512 = `a/${'b'.repeat(255)}/${'c'.repeat(254)}`
  assert.equal(Buffer.byteLength(exactly512, 'utf8'), 512)
  writePackageFiles(boundary, { [exactly512]: Buffer.alloc(0) })
  const listed = readUnsignedPackageFiles(boundary)
  assert.ok(listed.some((file) => file.path === exactly512))
})

test('rejects packages whose declared structure is missing or over budget', (t) => {
  const missingPersona = createTempDir()
  t.after(() => removeTempDir(missingPersona))
  writePackageFiles(missingPersona, { 'agent.json': JSON.stringify(VALID_MANIFEST) })
  assert.throws(() => readUnsignedPackageFiles(missingPersona), /包结构非法/)

  const missingSkill = createTempDir()
  t.after(() => removeTempDir(missingSkill))
  writePackageFiles(missingSkill, {
    'agent.json': JSON.stringify({
      ...VALID_MANIFEST,
      skill: { entry: 'skill/SKILL.md', summary: '整理周报' },
    }),
    'persona.md': VALID_PERSONA,
  })
  assert.throws(() => readUnsignedPackageFiles(missingSkill), /包结构非法/)

  const tooManyScripts = createTempDir()
  t.after(() => removeTempDir(tooManyScripts))
  const scriptEntries: Record<string, string> = {
    'agent.json': JSON.stringify({
      ...VALID_MANIFEST,
      skill: { entry: 'skill/SKILL.md', summary: '整理周报' },
    }),
    'persona.md': VALID_PERSONA,
    'skill/SKILL.md': '整理周报',
  }
  for (let index = 0; index < 21; index += 1) {
    scriptEntries[`skill/scripts/script-${index}.mjs`] = 'export {}'
  }
  writePackageFiles(tooManyScripts, scriptEntries)
  assert.throws(() => readUnsignedPackageFiles(tooManyScripts), /包结构非法：脚本/)

  const invalidManifest = createTempDir()
  t.after(() => removeTempDir(invalidManifest))
  writePackageFiles(invalidManifest, {
    'agent.json': JSON.stringify({ ...VALID_MANIFEST, source: 'local' }),
    'persona.md': VALID_PERSONA,
  })
  assert.throws(() => readUnsignedPackageFiles(invalidManifest), /包结构非法/)
})

test('rejects a package over the 5 MiB total or per-file persona budget', (t) => {
  const oversized = createValidPackageDir()
  t.after(() => removeTempDir(oversized))
  writeFileSync(join(oversized, 'padding.bin'), Buffer.alloc(5 * 1024 * 1024 + 1))
  assert.throws(() => readUnsignedPackageFiles(oversized), /智能体包超过/)

  const personaOverBudget = createValidPackageDir()
  t.after(() => removeTempDir(personaOverBudget))
  writeFileSync(join(personaOverBudget, 'persona.md'), Buffer.alloc(32 * 1024 + 1))
  assert.throws(() => readUnsignedPackageFiles(personaOverBudget), /persona\.md 超过/)
})

test('rejects symlinks and signature content in the unsigned entry point', (t) => {
  const linked = createValidPackageDir()
  t.after(() => removeTempDir(linked))
  symlinkSync('/etc/passwd', join(linked, 'linked.md'))
  assert.throws(() => readUnsignedPackageFiles(linked), /包结构非法：不得包含符号链接/)

  const signed = createValidPackageDir()
  t.after(() => removeTempDir(signed))
  writePackageFiles(signed, { '.signature/signature.json': '{}' })
  assert.throws(() => readUnsignedPackageFiles(signed), /包结构非法：不接受签名目录内容/)
})

test('verifies a signed directory and rejects tampering or extra signature files', (t) => {
  const dir = createValidPackageDir()
  t.after(() => removeTempDir(dir))

  const key = generateKeyPair()
  const keyring = [{ keyId: '', publicKeyHex: key.publicKeyHex, slot: 1 as const }]
  const digest = createAgentPackageDigest(
    VALID_MANIFEST,
    readUnsignedPackageFiles(dir),
  )
  const signature = signAgentPackageDigest(digest, {
    privateKeyPem: key.privateKeyPem,
    slot: 1,
    signedAt: '2026-10-24T00:00:00.000Z',
  })
  keyring[0]!.keyId = signature.keyId
  writePackageFiles(dir, {
    '.signature/package-digest.json': JSON.stringify(digest),
    '.signature/signature.json': JSON.stringify(signature),
  })

  const verified = verifyAgentPackageDirectory(dir, keyring)
  assert.equal(verified.manifest.slug, VALID_MANIFEST.slug)
  assert.equal(verified.digest.manifestSha256, digest.manifestSha256)
  assert.equal(verified.signature.signature, signature.signature)

  assert.throws(
    () => verifyAgentPackageDirectory(dir, [{ ...keyring[0]!, keyId: '0'.repeat(64) }]),
    /包校验失败，未安装或未运行。请联系管理员/,
  )

  writePackageFiles(dir, { 'persona.md': '被篡改的人设' })
  assert.throws(
    () => verifyAgentPackageDirectory(dir, keyring),
    /包校验失败，未安装或未运行。请联系管理员/,
  )
  writePackageFiles(dir, { 'persona.md': VALID_PERSONA })

  writePackageFiles(dir, { '.signature/extra.json': '{}' })
  assert.throws(
    () => verifyAgentPackageDirectory(dir, keyring),
    /包校验失败，未安装或未运行。请联系管理员/,
  )
})
