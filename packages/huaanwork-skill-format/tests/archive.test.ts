import assert from 'node:assert/strict'
import { gzipSync } from 'node:zlib'
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { c as createArchive } from 'tar'

import {
  MAX_SKILL_ARCHIVE_BYTES,
  MAX_SKILL_ARCHIVE_CONTENT_BYTES,
  MAX_SKILL_ENTRIES,
  buildSkillArchive,
  createSkillDigest,
  inspectSkillArchive,
  readSkillDirectory,
  writeSkillDirectory,
} from '../src/index.ts'
import type { SkillArchiveFile } from '../src/index.ts'

const SKILL_MD = '---\nname: demo\ndescription: 演示\n---\n\n正文\n'

const validFiles: SkillArchiveFile[] = [
  { path: 'SKILL.md', data: Buffer.from(SKILL_MD, 'utf8') },
  { path: 'scripts/run.mjs', data: Buffer.from('console.log("demo")\n', 'utf8') },
]

function byPath(a: SkillArchiveFile, b: SkillArchiveFile): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0
}

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'skill-format-'))
}

async function withTempDir<T>(run: (root: string) => Promise<T> | T): Promise<T> {
  const root = makeTempDir()
  try {
    return await run(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function writeTree(root: string, files: readonly SkillArchiveFile[]): void {
  for (const file of files) {
    const target = join(root, file.path)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, file.data)
  }
}

async function packViaTar(files: readonly SkillArchiveFile[]): Promise<Buffer> {
  return withTempDir(async (root) => {
    writeTree(root, files)
    const stream = createArchive(
      { cwd: root, gzip: true, portable: true, noMtime: true },
      files.map((file) => file.path),
    )
    const chunks: Buffer[] = []
    return await new Promise<Buffer>((resolve, reject) => {
      stream.on('data', (chunk: Buffer) => chunks.push(chunk))
      stream.on('error', reject)
      stream.on('end', () => resolve(Buffer.concat(chunks)))
    })
  })
}

type RawEntry =
  | { path: string; data: Buffer }
  | { path: string; type: 'directory' }
  | { path: string; type: 'symlink' | 'hardlink'; linkpath: string }
  | { path: string; type: 'fifo' }

function tarHeader(entry: RawEntry): Buffer {
  const isFile = !('type' in entry)
  const data = isFile ? entry.data : Buffer.alloc(0)
  const typeflag = isFile
    ? '0'
    : entry.type === 'directory'
      ? '5'
      : entry.type === 'symlink'
        ? '2'
        : entry.type === 'hardlink'
          ? '1'
          : '6'
  const header = Buffer.alloc(512)
  header.write(entry.path, 0, 100, 'utf8')
  header.write('0000644\0', 100, 8, 'ascii')
  header.write('0000000\0', 108, 8, 'ascii')
  header.write('0000000\0', 116, 8, 'ascii')
  header.write(`${data.byteLength.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii')
  header.write('00000000000\0', 136, 12, 'ascii')
  header.write('        ', 148, 8, 'ascii')
  header.write(typeflag, 156, 1, 'ascii')
  if ('linkpath' in entry) header.write(entry.linkpath, 157, 100, 'utf8')
  header.write('ustar\0', 257, 6, 'ascii')
  header.write('00', 263, 2, 'ascii')
  let checksum = 0
  for (const byte of header) checksum += byte
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii')
  return header
}

/** Hand-built tar so a test can express entries `tar.c` refuses to create. */
function rawArchive(entries: readonly RawEntry[]): Buffer {
  const blocks: Buffer[] = []
  for (const entry of entries) {
    blocks.push(tarHeader(entry))
    if (!('type' in entry)) {
      blocks.push(entry.data, Buffer.alloc((512 - (entry.data.byteLength % 512)) % 512))
    }
  }
  blocks.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(blocks))
}

test('round-trips a skill bundle with resources and stable digest', async () => {
  await withTempDir(async (root) => {
    writeTree(root, validFiles)
    const files = readSkillDirectory(root)
    const archive = await buildSkillArchive(files)
    const inspected = await inspectSkillArchive(archive)
    assert.equal(inspected.name, 'demo')
    assert.equal(inspected.description, '演示')
    assert.equal(inspected.skillMarkdown, SKILL_MD)
    assert.equal(inspected.digest, createSkillDigest(files))
    assert.deepEqual(inspected.files.map((file) => file.path), ['SKILL.md', 'scripts/run.mjs'])
  })
})

test('createSkillDigest is canonical, path-sorted, and prefixed with sha256:', () => {
  const digest = createSkillDigest(validFiles)
  assert.equal(digest, createSkillDigest([...validFiles].reverse()))
  assert.match(digest, /^sha256:[0-9a-f]{64}$/u)
  // Pinned canonical document: the digest is a cross-process contract, not an
  // implementation detail. Changing key order or row ordering must fail here.
  assert.equal(digest, 'sha256:cae3bcf4346d27f5b16db8f7692decef4443b4013df2a7bcc3328f8741dfbc38')
  assert.notEqual(
    digest,
    createSkillDigest([validFiles[0]!, { path: 'scripts/run.mjs', data: Buffer.from('changed\n') }]),
  )
})

test('buildSkillArchive normalizes input order', async () => {
  const forward = await buildSkillArchive(validFiles)
  const reversed = await buildSkillArchive([...validFiles].reverse())
  assert.deepEqual(reversed, forward)
})

test('inspectSkillArchive rejects an expected name that does not match SKILL.md', async () => {
  const archive = await buildSkillArchive(validFiles)
  await assert.rejects(inspectSkillArchive(archive, 'other'), /技能归档非法：SKILL\.md 名称不一致/u)
  const inspected = await inspectSkillArchive(archive, 'demo')
  assert.equal(inspected.name, 'demo')
})

test('writeSkillDirectory writes the inspected files under the target root', async () => {
  await withTempDir(async (root) => {
    const archive = await buildSkillArchive(validFiles)
    const inspected = await inspectSkillArchive(archive)
    const target = join(root, 'skills', 'demo')
    await writeSkillDirectory(target, inspected.files)
    assert.deepEqual(readSkillDirectory(target), [...validFiles].sort(byPath))
    assert.equal(readFileSync(join(target, 'SKILL.md'), 'utf8'), SKILL_MD)
  })
})

test('writeSkillDirectory refuses to follow a symlinked parent out of the root', async () => {
  await withTempDir(async (root) => {
    const outside = join(root, 'outside')
    const target = join(root, 'skill')
    mkdirSync(outside, { recursive: true })
    mkdirSync(target, { recursive: true })
    symlinkSync(outside, join(target, 'scripts'), 'dir')
    await assert.rejects(
      writeSkillDirectory(target, [validFiles[0]!, validFiles[1]!]),
      /技能归档非法/u,
    )
    assert.equal(existsSync(join(outside, 'run.mjs')), false)
  })
})

test('readSkillDirectory rejects symlinks and hard links in the source tree', async () => {
  await withTempDir(async (root) => {
    writeTree(root, validFiles)
    symlinkSync(join(root, 'SKILL.md'), join(root, 'link.md'))
    assert.throws(() => readSkillDirectory(root), /技能归档非法：不允许符号链接/u)
  })
  await withTempDir(async (root) => {
    writeTree(root, validFiles)
    linkSync(join(root, 'SKILL.md'), join(root, 'hard.md'))
    assert.throws(() => readSkillDirectory(root), /技能归档非法：不允许硬链接/u)
  })
})

test('buildSkillArchive enforces the SKILL.md body and description budgets', async () => {
  await assert.rejects(
    buildSkillArchive([
      {
        path: 'SKILL.md',
        data: Buffer.from(`---\nname: demo\ndescription: 演示\n---\n\n${'x'.repeat(64 * 1024 + 1)}\n`),
      },
    ]),
    /技能归档非法：正文超过65536字节/u,
  )
  await assert.rejects(
    buildSkillArchive([
      {
        path: 'SKILL.md',
        data: Buffer.from(`---\nname: demo\ndescription: ${'a'.repeat(1025)}\n---\n\n正文\n`),
      },
    ]),
    /技能归档非法：描述超过1024字符/u,
  )
})

test('writeSkillDirectory refuses symlinked or hard-linked target files', async () => {
  await withTempDir(async (root) => {
    const target = join(root, 'skill')
    mkdirSync(target)
    const outside = join(root, 'outside.md')
    writeFileSync(outside, 'outside')
    symlinkSync(outside, join(target, 'SKILL.md'))
    await assert.rejects(writeSkillDirectory(target, [validFiles[0]!]), /技能归档非法：不允许符号链接/u)
    rmSync(join(target, 'SKILL.md'))
    writeFileSync(join(target, 'SKILL.md'), 'x')
    linkSync(join(target, 'SKILL.md'), join(target, 'other.md'))
    await assert.rejects(writeSkillDirectory(target, [validFiles[0]!]), /技能归档非法：不允许硬链接/u)
  })
})

const structuralNegatives: ReadonlyArray<{ label: string; files: SkillArchiveFile[] }> = [
  { label: 'an absolute path', files: [...validFiles, { path: '/etc/passwd', data: Buffer.from('x') }] },
  { label: 'a parent-traversal segment', files: [...validFiles, { path: '../escape.md', data: Buffer.from('x') }] },
  { label: 'a backslash', files: [...validFiles, { path: 'scripts\\run.mjs', data: Buffer.from('x') }] },
  { label: 'a Windows drive prefix', files: [...validFiles, { path: 'C:demo.md', data: Buffer.from('x') }] },
  { label: 'a duplicate path', files: [...validFiles, { path: 'SKILL.md', data: Buffer.from('dup') }] },
  {
    label: 'a file used as a directory',
    files: [...validFiles, { path: 'scripts', data: Buffer.from('file') }, { path: 'scripts/nested.mjs', data: Buffer.from('x') }],
  },
  { label: 'a missing SKILL.md', files: [validFiles[1]!] },
  {
    label: 'an invalid SKILL.md name',
    files: [
      { path: 'SKILL.md', data: Buffer.from('---\nname: Demo Skill\ndescription: 演示\n---\n\n正文\n') },
      validFiles[1]!,
    ],
  },
  {
    label: 'more than MAX_SKILL_ENTRIES entries',
    files: [
      validFiles[0]!,
      ...Array.from({ length: MAX_SKILL_ENTRIES }, (_, index) => ({
        path: `resources/${index}.txt`,
        data: Buffer.from('x'),
      })),
    ],
  },
  {
    label: 'a path longer than MAX_SKILL_PATH_BYTES',
    files: [
      validFiles[0]!,
      { path: `scripts/${'a'.repeat(250)}/${'b'.repeat(250)}/run.mjs`, data: Buffer.from('x') },
    ],
  },
  {
    label: 'content over MAX_SKILL_ARCHIVE_CONTENT_BYTES',
    files: [
      validFiles[0]!,
      { path: 'resources/blob.bin', data: Buffer.alloc(MAX_SKILL_ARCHIVE_CONTENT_BYTES + 1) },
    ],
  },
]

for (const { label, files } of structuralNegatives) {
  test(`buildSkillArchive rejects ${label}`, async () => {
    await assert.rejects(buildSkillArchive(files), /技能归档非法/u)
  })
}

test('inspectSkillArchive rejects an archive over MAX_SKILL_ARCHIVE_BYTES before parsing', async () => {
  await assert.rejects(
    inspectSkillArchive(Buffer.alloc(MAX_SKILL_ARCHIVE_BYTES + 1)),
    /技能归档非法：技能归档超过5242880字节上限/u,
  )
})

test('inspectSkillArchive rejects nested gzip and zstd payloads', async () => {
  const archive = await buildSkillArchive(validFiles)
  await assert.rejects(
    inspectSkillArchive(gzipSync(archive)),
    /技能归档非法：不支持嵌套压缩/u,
  )
  await assert.rejects(
    inspectSkillArchive(gzipSync(Buffer.concat([Buffer.from([0x28, 0xb5, 0x2f, 0xfd]), Buffer.alloc(64)]))),
    /技能归档非法：不支持嵌套压缩/u,
  )
})

test('inspectSkillArchive rejects an archive whose content exceeds the budget', async () => {
  const archive = rawArchive([
    { path: 'SKILL.md', data: Buffer.from(SKILL_MD) },
    { path: 'resources/blob.bin', data: Buffer.alloc(MAX_SKILL_ARCHIVE_CONTENT_BYTES + 1) },
  ])
  await assert.rejects(inspectSkillArchive(archive), /技能归档非法：文件内容超过5242880字节上限/u)
})

test('inspectSkillArchive rejects more than MAX_SKILL_ENTRIES entries', async () => {
  const archive = await packViaTar([
    validFiles[0]!,
    ...Array.from({ length: MAX_SKILL_ENTRIES }, (_, index) => ({
      path: `resources/${index}.txt`,
      data: Buffer.from('x'),
    })),
  ])
  await assert.rejects(inspectSkillArchive(archive), /技能归档非法：条目数超过256/u)
})

test('inspectSkillArchive counts implicit parent directories against the entry budget', async () => {
  const files = [
    validFiles[0]!,
    ...Array.from({ length: MAX_SKILL_ENTRIES - 1 }, (_, index) => ({
      path: `dir-${index}/file.txt`,
      data: Buffer.from('x'),
    })),
  ]
  // 256 explicit entries fit the archive, but extraction also creates 255
  // directories, so the installed layout exceeds the budget.
  await assert.rejects(buildSkillArchive(files), /技能归档非法：条目数超过256/u)
  await assert.rejects(inspectSkillArchive(await packViaTar(files)), /技能归档非法：条目数超过256/u)
})

test('inspectSkillArchive rejects paths over MAX_SKILL_PATH_BYTES', async () => {
  const archive = await packViaTar([
    validFiles[0]!,
    { path: `scripts/${'a'.repeat(250)}/${'b'.repeat(250)}/run.mjs`, data: Buffer.from('x') },
  ])
  await assert.rejects(inspectSkillArchive(archive), /技能归档非法：路径超过512字节/u)
})

test('inspectSkillArchive rejects an archive without a root SKILL.md', async () => {
  await assert.rejects(
    inspectSkillArchive(await packViaTar([validFiles[1]!])),
    /技能归档非法：缺少 SKILL\.md/u,
  )
  await assert.rejects(
    inspectSkillArchive(await packViaTar([{ path: 'demo/SKILL.md', data: Buffer.from(SKILL_MD) }])),
    /技能归档非法：缺少 SKILL\.md/u,
  )
})

test('inspectSkillArchive rejects backslash and drive-prefix header paths', async () => {
  await assert.rejects(
    inspectSkillArchive(
      await packViaTar([validFiles[0]!, { path: 'scripts\\run.mjs', data: Buffer.from('x') }]),
    ),
    /技能归档非法：路径不得包含反斜杠/u,
  )
  // tar.c strips a leading drive prefix, so this case needs a raw header.
  await assert.rejects(
    inspectSkillArchive(rawArchive([
      { path: 'SKILL.md', data: Buffer.from(SKILL_MD) },
      { path: 'C:demo.md', data: Buffer.from('x') },
    ])),
    /技能归档非法：路径不得包含盘符/u,
  )
})

test('inspectSkillArchive rejects an invalid SKILL.md name', async () => {
  const archive = rawArchive([
    { path: 'SKILL.md', data: Buffer.from('---\nname: Demo Skill\ndescription: 演示\n---\n\n正文\n') },
  ])
  await assert.rejects(inspectSkillArchive(archive), /技能归档非法：SKILL\.md 名称非法/u)
})

test('inspectSkillArchive rejects duplicate paths, file/dir conflicts, and empty archives', async () => {
  await assert.rejects(
    inspectSkillArchive(rawArchive([
      { path: 'SKILL.md', data: Buffer.from(SKILL_MD) },
      { path: 'SKILL.md', data: Buffer.from(SKILL_MD) },
    ])),
    /技能归档非法：重复条目/u,
  )
  await assert.rejects(
    inspectSkillArchive(rawArchive([
      { path: 'SKILL.md', data: Buffer.from(SKILL_MD) },
      { path: 'scripts', data: Buffer.from('file') },
      { path: 'scripts/run.mjs', data: Buffer.from('x') },
    ])),
    /技能归档非法：目录与文件冲突/u,
  )
  await assert.rejects(
    inspectSkillArchive(rawArchive([{ path: 'resources', type: 'directory' }])),
    /技能归档非法：归档为空/u,
  )
})

test('inspectSkillArchive rejects symlinks, hard links, and non-regular entries', async () => {
  for (const [label, entry] of [
    ['a symlink', { path: 'link', type: 'symlink', linkpath: 'SKILL.md' }],
    ['a hard link', { path: 'hard', type: 'hardlink', linkpath: 'SKILL.md' }],
    ['a FIFO', { path: 'pipe', type: 'fifo' }],
  ] as const) {
    await assert.rejects(
      inspectSkillArchive(rawArchive([{ path: 'SKILL.md', data: Buffer.from(SKILL_MD) }, entry])),
      /技能归档非法：只允许普通文件与目录/u,
      label,
    )
  }
})

test('inspectSkillArchive ignores explicit directory entries that only name parents', async () => {
  const archive = rawArchive([
    { path: 'SKILL.md', data: Buffer.from(SKILL_MD) },
    { path: 'scripts/', type: 'directory' },
    { path: 'scripts/run.mjs', data: Buffer.from('console.log("demo")\n') },
  ])
  const inspected = await inspectSkillArchive(archive)
  assert.deepEqual(inspected.files.map((file) => file.path), ['SKILL.md', 'scripts/run.mjs'])
  assert.equal(inspected.digest, createSkillDigest(validFiles))
})
