import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { randomBytes } from 'node:crypto'
import { Readable } from 'node:stream'
import test from 'node:test'
import { gzipSync } from 'node:zlib'

import { canonicalJson, generateKeyPair, signAgentPackageDigest } from '@huaanwork/catalog-signing'
import { Header, Pack, ReadEntry } from 'tar'
import { t as listArchive } from 'tar'

import {
  MAX_AGENT_PACKAGE_BUNDLE_BYTES,
  buildSignedAgentPackageBundle,
  buildUnsignedAgentPackageBundle,
  createAgentPackageDigest,
  inspectSignedAgentPackageBundle,
  inspectUnsignedAgentPackageBundle,
} from '../src/index.ts'
import type { AgentPackageDigest, AgentPackageFile } from '../src/index.ts'
import { VALID_MANIFEST, VALID_PERSONA } from './helpers.ts'

type ArchiveEntry = {
  name: string
  type?: 'File' | 'Directory' | 'SymbolicLink' | 'Link' | 'ExtendedHeader'
  linkpath?: string
  content?: string | Buffer
}

const validAgentJson: ArchiveEntry = { name: 'agent.json', content: JSON.stringify(VALID_MANIFEST) }
const validPersona: ArchiveEntry = { name: 'persona.md', content: VALID_PERSONA }

const validFiles: AgentPackageFile[] = [
  { path: 'agent.json', data: Buffer.from(JSON.stringify(VALID_MANIFEST)) },
  { path: 'persona.md', data: Buffer.from(VALID_PERSONA) },
]

/**
 * Build an arbitrary (possibly malicious) tar.gz in memory with `tar`'s Pack.
 * Entries are handed over as raw tar headers so names such as `/absolute`,
 * `C:/windows`, `../escape`, and `skill\script.mjs` survive unchanged.
 */
async function makeArchive(entries: ArchiveEntry[]): Promise<Buffer> {
  const pack = new Pack({ gzip: true, portable: true, noMtime: true, preservePaths: true })
  const chunks: Buffer[] = []
  const ended = new Promise<Buffer>((resolve, reject) => {
    pack.on('data', (chunk: Buffer) => chunks.push(chunk))
    pack.on('error', reject)
    pack.on('end', () => resolve(Buffer.concat(chunks)))
  })

  for (const entry of entries) {
    const data = Buffer.isBuffer(entry.content)
      ? entry.content
      : Buffer.from(entry.content ?? '')
    const header = new Header({
      path: entry.name,
      type: entry.type ?? 'File',
      size: data.byteLength,
      ...(entry.linkpath === undefined ? {} : { linkpath: entry.linkpath }),
    })
    const readEntry = new ReadEntry(header)
    readEntry.end(data)
    pack.add(readEntry)
  }
  pack.end()
  return ended
}

/** Read every file entry of an archive without touching the candidate API. */
function readArchiveFiles(archive: Buffer): Promise<Map<string, Buffer>> {
  return new Promise((resolve, reject) => {
    const entries = new Map<string, Buffer>()
    const parser = listArchive({
      gzip: true,
      onentry: (entry) => {
        const chunks: Buffer[] = []
        entry.on('data', (chunk: Buffer) => chunks.push(chunk))
        entry.on('end', () => entries.set(entry.path, Buffer.concat(chunks)))
      },
    })
    parser.on('error', reject)
    parser.on('end', () => resolve(entries))
    Readable.from([archive]).pipe(parser)
  })
}

/** 6 MiB of semi-compressible text: the gzip stays below the bundle cap while
 * declaring a single regular-file entry over the unpacked budget. */
function makeLargeEntryContent(): Buffer {
  const lines: string[] = []
  let total = 0
  for (let index = 0; total < 6 * 1024 * 1024; index += 1) {
    const line = `line-${index.toString(36).padStart(8, '0')}-abcdefghijklmnopqrstuvwxyz0123456789\n`
    lines.push(line)
    total += Buffer.byteLength(line)
  }
  return Buffer.from(lines.join('')).subarray(0, 6 * 1024 * 1024)
}

function createSignatureFixture(): {
  keyring: { keyId: string; publicKeyHex: string; slot: 1 }[]
  digest: AgentPackageDigest
  signature: ReturnType<typeof signAgentPackageDigest>
} {
  const key = generateKeyPair()
  const digest = createAgentPackageDigest(VALID_MANIFEST, validFiles)
  const signature = signAgentPackageDigest(digest, {
    privateKeyPem: key.privateKeyPem,
    slot: 1,
    signedAt: '2026-10-24T00:00:00.000Z',
  })
  return {
    keyring: [{ keyId: signature.keyId, publicKeyHex: key.publicKeyHex, slot: 1 }],
    digest,
    signature,
  }
}

test('rejects malicious archive entries and duplicates', async () => {
  const malicious: ArchiveEntry[] = [
    { name: '../escape', content: 'x' },
    { name: '/absolute', content: 'x' },
    { name: 'C:/windows', content: 'x' },
    { name: 'skill\\script.mjs', content: 'x' },
    { name: 'skill/link', type: 'SymbolicLink', linkpath: '/etc/passwd' },
    { name: 'skill/hardlink', type: 'Link', linkpath: 'agent.json' },
  ]
  for (const entry of malicious) {
    await assert.rejects(
      inspectUnsignedAgentPackageBundle(await makeArchive([entry, validAgentJson, validPersona])),
      /包结构非法/,
    )
  }

  await assert.rejects(
    inspectUnsignedAgentPackageBundle(await makeArchive([validAgentJson, validAgentJson, validPersona])),
    /重复/,
  )
  await assert.rejects(
    inspectUnsignedAgentPackageBundle(Buffer.alloc(6 * 1024 * 1024)),
    /5 MiB|包结构非法/,
  )
})

test('rejects unsigned archives carrying signature content', async () => {
  await assert.rejects(
    inspectUnsignedAgentPackageBundle(
      await makeArchive([
        validAgentJson,
        validPersona,
        { name: '.signature/signature.json', content: '{}' },
      ]),
    ),
    /包结构非法/,
  )

  await assert.rejects(
    inspectUnsignedAgentPackageBundle(
      await makeArchive([
        validAgentJson,
        validPersona,
        { name: 'nested/.signature/extra.json', content: '{}' },
      ]),
    ),
    /包结构非法/,
  )
})

test('aborts as soon as the unpacked content budget is exceeded', async () => {
  const archive = await makeArchive([
    validAgentJson,
    validPersona,
    { name: 'padding.txt', content: makeLargeEntryContent() },
  ])
  assert.ok(archive.byteLength < MAX_AGENT_PACKAGE_BUNDLE_BYTES)
  await assert.rejects(
    inspectUnsignedAgentPackageBundle(archive),
    /包结构非法：智能体包超过5242880字节上限/,
  )
})

test('charges Directory and meta bodies against the unpacked budget', async () => {
  // node-tar 把目录头的 size 归零,body 不进 onentry;PAX/global 头更是从不进
  // onentry。两者都必须在解压总量上受同一个预算约束,而不是被静默跳过。
  const directoryBody = await makeArchive([
    validAgentJson,
    validPersona,
    { name: 'padding', type: 'Directory', content: Buffer.alloc(8 * 1024 * 1024) },
  ])
  assert.ok(directoryBody.byteLength < MAX_AGENT_PACKAGE_BUNDLE_BYTES)
  await assert.rejects(
    inspectUnsignedAgentPackageBundle(directoryBody),
    /包结构非法：智能体包超过5242880字节上限/,
  )

  const extendedHeaderBody = await makeArchive([
    validAgentJson,
    validPersona,
    { name: 'padding.pax', type: 'ExtendedHeader', content: Buffer.alloc(8 * 1024 * 1024) },
  ])
  assert.ok(extendedHeaderBody.byteLength < MAX_AGENT_PACKAGE_BUNDLE_BYTES)
  await assert.rejects(
    inspectUnsignedAgentPackageBundle(extendedHeaderBody),
    /包结构非法：智能体包超过5242880字节上限/,
  )
})

test('accepts canonical tar directory entries', async () => {
  const inspected = await inspectUnsignedAgentPackageBundle(
    await makeArchive([
      validAgentJson,
      validPersona,
      { name: 'skill/', type: 'Directory' },
      { name: 'skill/agent.md', content: '# 技能' },
      { name: 'skill/scripts/', type: 'Directory' },
      { name: 'skill/scripts/run.mjs', content: 'console.log(1)\n' },
    ]),
  )
  assert.deepEqual(
    inspected.files.map((file) => file.path).sort(),
    ['agent.json', 'persona.md', 'skill/agent.md', 'skill/scripts/run.mjs'],
  )

  // 双斜杠不是规范写法,去掉一个结尾 `/` 后仍是空段。
  await assert.rejects(
    inspectUnsignedAgentPackageBundle(
      await makeArchive([
        validAgentJson,
        validPersona,
        { name: 'skill//', type: 'Directory' },
      ]),
    ),
    /包结构非法/,
  )
})

test('rejects archives over 1024 entries before parsing later entries', async () => {
  const files = Array.from({ length: 1025 }, (_, index) => ({
    name: `filler-${index}.bin`,
    content: '',
  }))
  await assert.rejects(
    inspectUnsignedAgentPackageBundle(
      await makeArchive([...files, { name: '/absolute', content: 'x' }]),
    ),
    /条目数超过1024/,
  )

  const directories = Array.from({ length: 1025 }, (_, index) => ({
    name: `dir-${index}`,
    type: 'Directory' as const,
  }))
  await assert.rejects(
    inspectUnsignedAgentPackageBundle(
      await makeArchive([...directories, { name: '/absolute', content: 'x' }]),
    ),
    /条目数超过1024/,
  )
})

test('accepts exactly 1024 entries and exactly 512-byte paths', async () => {
  const filler = Array.from({ length: 1022 }, (_, index) => ({
    name: `filler-${index}.bin`,
    content: '',
  }))
  const boundary = await inspectUnsignedAgentPackageBundle(
    await makeArchive([validAgentJson, validPersona, ...filler]),
  )
  assert.equal(boundary.files.length, 1024)

  const exactly512 = `a/${'b'.repeat(255)}/${'c'.repeat(254)}`
  assert.equal(Buffer.byteLength(exactly512, 'utf8'), 512)
  const pathBoundary = await inspectUnsignedAgentPackageBundle(
    await makeArchive([validAgentJson, validPersona, { name: exactly512 }]),
  )
  assert.ok(pathBoundary.files.some((file) => file.path === exactly512))
})

test('rejects normalized paths over 512 bytes', async () => {
  const tooLong = `a/${'b'.repeat(255)}/${'c'.repeat(255)}`
  assert.equal(Buffer.byteLength(tooLong, 'utf8'), 513)
  await assert.rejects(
    inspectUnsignedAgentPackageBundle(
      await makeArchive([validAgentJson, validPersona, { name: tooLong }]),
    ),
    /路径超过512字节/,
  )
})

test('normalizes a leading ./ in archive paths', async () => {
  const inspected = await inspectUnsignedAgentPackageBundle(
    await makeArchive([
      { name: './agent.json', content: JSON.stringify(VALID_MANIFEST) },
      { name: './persona.md', content: VALID_PERSONA },
    ]),
  )
  assert.deepEqual(
    inspected.files.map((file) => file.path).sort(),
    ['agent.json', 'persona.md'],
  )
})

test('counts signature entries against the shared 1024 entry cap', async () => {
  const filler = Array.from({ length: 1023 }, (_, index) => ({
    name: `filler-${index}.bin`,
    content: '',
  }))
  await assert.rejects(
    inspectSignedAgentPackageBundle(
      await makeArchive([
        ...filler,
        { name: '.signature/package-digest.json', content: '{}' },
        { name: '.signature/signature.json', content: '{}' },
      ]),
      [],
    ),
    /条目数超过1024/,
  )
})

test('rejects a nested gzip payload before node-tar can inflate it outside the meter', async () => {
  // 6 MiB 目录 body 只被内层 tar.gz 压成几十 KB,再包一层 gzip 的 bundle 仍远小于
  // 5 MiB。node-tar 无视 `gzip:false`,会在 meter 之后嗅探 `1f 8b` 再解压一层,
  // 所以必须在解压后的首字节上拒绝嵌套压缩。
  const inner = await makeArchive([
    validAgentJson,
    validPersona,
    { name: 'padding', type: 'Directory', content: makeLargeEntryContent() },
  ])
  const nestedGzip = gzipSync(inner)
  assert.ok(nestedGzip.byteLength < MAX_AGENT_PACKAGE_BUNDLE_BYTES)
  await assert.rejects(
    inspectUnsignedAgentPackageBundle(nestedGzip),
    /包结构非法：不支持嵌套压缩/,
  )

  // zstd 同属 node-tar 会自行嗅探的压缩格式,魔数同样在 meter 上拒绝。
  const nestedZstd = gzipSync(
    Buffer.concat([Buffer.from([0x28, 0xb5, 0x2f, 0xfd]), Buffer.alloc(512)]),
  )
  assert.ok(nestedZstd.byteLength < MAX_AGENT_PACKAGE_BUNDLE_BYTES)
  await assert.rejects(
    inspectUnsignedAgentPackageBundle(nestedZstd),
    /包结构非法：不支持嵌套压缩/,
  )
})

test('rejects a plain double-gzipped archive', async () => {
  const bundle = await buildUnsignedAgentPackageBundle(validFiles)
  const doubleGzipped = gzipSync(bundle)
  assert.ok(doubleGzipped.byteLength < MAX_AGENT_PACKAGE_BUNDLE_BYTES)
  await assert.rejects(
    inspectUnsignedAgentPackageBundle(doubleGzipped),
    /包结构非法：不支持嵌套压缩/,
  )
})

test('round-trips an unsigned bundle and derives the manifest digest', async () => {
  const bundle = await buildUnsignedAgentPackageBundle(validFiles)
  const inspected = await inspectUnsignedAgentPackageBundle(bundle)
  assert.deepEqual(inspected.files, validFiles)
  assert.equal(inspected.manifest.slug, VALID_MANIFEST.slug)
  assert.deepEqual(inspected.digest, createAgentPackageDigest(VALID_MANIFEST, validFiles))
})

test('round-trips a signed bundle without counting signature files in the digest', async () => {
  const { keyring, digest, signature } = createSignatureFixture()
  const unsigned = await buildUnsignedAgentPackageBundle(validFiles)
  const unsignedInspection = await inspectUnsignedAgentPackageBundle(unsigned)
  const signedBundle = await buildSignedAgentPackageBundle(
    unsignedInspection.files,
    unsignedInspection.digest,
    signature,
  )

  const rawEntries = await readArchiveFiles(signedBundle)
  assert.deepEqual([...rawEntries.keys()].sort(), [
    '.signature/package-digest.json',
    '.signature/signature.json',
    'agent.json',
    'persona.md',
  ])
  assert.deepEqual(rawEntries.get('.signature/package-digest.json'), Buffer.from(canonicalJson(digest), 'utf8'))
  assert.deepEqual(rawEntries.get('.signature/signature.json'), Buffer.from(JSON.stringify(signature), 'utf8'))

  const signed = await inspectSignedAgentPackageBundle(signedBundle, keyring)
  assert.deepEqual(signed.files, unsignedInspection.files)
  assert.deepEqual(signed.digest, unsignedInspection.digest)
  assert.deepEqual(signed.digest, digest)
  assert.equal(signed.signature.signature, signature.signature)
  assert.ok(signed.digest.files.every((file) => !file.path.startsWith('.signature/')))
})

test('accepts an explicit .signature directory entry in signed bundles only', async () => {
  const { keyring, digest, signature } = createSignatureFixture()
  const signedArchive = await makeArchive([
    { name: '.signature/', type: 'Directory' },
    { name: '.signature/package-digest.json', content: canonicalJson(digest) },
    { name: '.signature/signature.json', content: JSON.stringify(signature) },
    validAgentJson,
    validPersona,
  ])

  const inspected = await inspectSignedAgentPackageBundle(signedArchive, keyring)
  assert.deepEqual(inspected.files.map((file) => file.path).sort(), ['agent.json', 'persona.md'])
  assert.deepEqual(inspected.digest, digest)

  // 目录本身不是额外内容,但 `.signature/` 下的其他目录仍然是。
  await assert.rejects(
    inspectSignedAgentPackageBundle(
      await makeArchive([
        { name: '.signature/', type: 'Directory' },
        { name: '.signature/extra/', type: 'Directory' },
        { name: '.signature/package-digest.json', content: canonicalJson(digest) },
        { name: '.signature/signature.json', content: JSON.stringify(signature) },
        validAgentJson,
        validPersona,
      ]),
      keyring,
    ),
    /包结构非法/,
  )

  // unsigned 仍然不接受任何签名目录内容,即使目录为空。
  await assert.rejects(
    inspectUnsignedAgentPackageBundle(
      await makeArchive([validAgentJson, validPersona, { name: '.signature/', type: 'Directory' }]),
    ),
    /包结构非法/,
  )
})

test('rejects signed bundles with extra, missing, or extra-signature files', async () => {
  const { keyring, digest, signature } = createSignatureFixture()

  const withExtra = await buildSignedAgentPackageBundle(
    [...validFiles, { path: 'extra.txt', data: Buffer.from('extra') }],
    digest,
    signature,
  )
  await assert.rejects(inspectSignedAgentPackageBundle(withExtra, keyring), /包校验失败/)

  const missingPersona = await buildSignedAgentPackageBundle([validFiles[0]!], digest, signature)
  await assert.rejects(inspectSignedAgentPackageBundle(missingPersona, keyring), /包结构非法/)

  const extraSignatureFile = await makeArchive([
    validAgentJson,
    validPersona,
    { name: '.signature/package-digest.json', content: canonicalJson(digest) },
    { name: '.signature/signature.json', content: JSON.stringify(signature) },
    { name: '.signature/extra.json', content: '{}' },
  ])
  await assert.rejects(inspectSignedAgentPackageBundle(extraSignatureFile, keyring), /包结构非法/)

  const missingSignatureFile = await makeArchive([
    validAgentJson,
    validPersona,
    { name: '.signature/package-digest.json', content: canonicalJson(digest) },
  ])
  await assert.rejects(inspectSignedAgentPackageBundle(missingSignatureFile, keyring), /包结构非法/)
})

test('rejects signed bundles with tampered digests, signatures, or unknown keys', async () => {
  const { keyring, digest, signature } = createSignatureFixture()

  const tamperedDigest = {
    ...digest,
    files: digest.files.map((file, index) => (index === 0 ? { ...file, sha256: '0'.repeat(64) } : file)),
  }
  await assert.rejects(
    inspectSignedAgentPackageBundle(
      await buildSignedAgentPackageBundle(validFiles, tamperedDigest, signature),
      keyring,
    ),
    /包校验失败，未安装或未运行。请联系管理员/,
  )

  const tamperedSignature = {
    ...signature,
    signature: `${signature.signature[0] === 'A' ? 'B' : 'A'}${signature.signature.slice(1)}`,
  }
  await assert.rejects(
    inspectSignedAgentPackageBundle(
      await buildSignedAgentPackageBundle(validFiles, digest, tamperedSignature),
      keyring,
    ),
    /包校验失败，未安装或未运行。请联系管理员/,
  )

  const unknownKeyring = [{ ...keyring[0]!, keyId: '0'.repeat(64) }]
  await assert.rejects(
    inspectSignedAgentPackageBundle(
      await buildSignedAgentPackageBundle(validFiles, digest, signature),
      unknownKeyring,
    ),
    /包校验失败，未安装或未运行。请联系管理员/,
  )
})

test('forwards the verification clock to the keyring verifier', async () => {
  const key = generateKeyPair()
  const digest = createAgentPackageDigest(VALID_MANIFEST, validFiles)
  const signature = signAgentPackageDigest(digest, {
    privateKeyPem: key.privateKeyPem,
    slot: 1,
    signedAt: '2026-10-24T00:00:00.000Z',
  })
  const keyring = [{
    keyId: signature.keyId,
    publicKeyHex: key.publicKeyHex,
    slot: 1 as const,
    retiredAt: '2026-10-25T00:00:00.000Z',
  }]
  const bundle = await buildSignedAgentPackageBundle(validFiles, digest, signature)

  await assert.doesNotReject(
    inspectSignedAgentPackageBundle(bundle, keyring, Date.parse('2026-10-24T12:00:00.000Z')),
  )
  await assert.rejects(
    inspectSignedAgentPackageBundle(bundle, keyring, Date.parse('2026-10-26T00:00:00.000Z')),
    /包校验失败，未安装或未运行。请联系管理员/,
  )
})

test('rejects unsafe build inputs and bundles that grow past 5 MiB', async () => {
  await assert.rejects(
    buildUnsignedAgentPackageBundle([{ path: '../escape', data: Buffer.from('x') }]),
    /包结构非法/,
  )
  await assert.rejects(buildUnsignedAgentPackageBundle([]), /包结构非法/)
  await assert.rejects(
    buildUnsignedAgentPackageBundle([{ path: 'big.bin', data: randomBytes(MAX_AGENT_PACKAGE_BUNDLE_BYTES) }]),
    /包结构非法/,
  )
})

test('rejects empty archives and directory/file prefix conflicts', async () => {
  await assert.rejects(inspectUnsignedAgentPackageBundle(await makeArchive([])), /包结构非法/)

  await assert.rejects(
    inspectUnsignedAgentPackageBundle(
      await makeArchive([
        validAgentJson,
        validPersona,
        { name: 'nested', content: 'file' },
        { name: 'nested/child.md', content: 'child' },
      ]),
    ),
    /目录与文件冲突/,
  )

  await assert.rejects(
    inspectUnsignedAgentPackageBundle(
      await makeArchive([
        validAgentJson,
        validPersona,
        { name: 'nested', content: 'file' },
        { name: 'nested/child', type: 'Directory' },
      ]),
    ),
    /目录与文件冲突/,
  )
})
