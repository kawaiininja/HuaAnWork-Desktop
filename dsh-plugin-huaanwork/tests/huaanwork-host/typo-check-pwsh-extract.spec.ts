import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import AdmZip from 'adm-zip'
import { afterEach, describe, expect, test } from 'vitest'

// SKILL.md（agent-packages/typo-check/skill/SKILL.md）的 Windows 提取处方:
// 用 System.IO.Compression 打开 docx、读 word/document.xml、把 `</w:p>` 换成换行、
// 去掉全部标签、解码 XML 实体、写 UTF-8 txt。下面原样按这个顺序实现,并用真实 docx
// fixture 验证行为——不是断言 SKILL.md 里出现了这些字样。
const PWSH_EXTRACT_SCRIPT = `param(
  [Parameter(Mandatory = $true)][string]$DocxPath,
  [Parameter(Mandatory = $true)][string]$OutPath
)
$fileStream = [System.IO.File]::OpenRead($DocxPath)
try {
  $archive = [System.IO.Compression.ZipArchive]::new($fileStream, [System.IO.Compression.ZipArchiveMode]::Read)
  try {
    $entry = $archive.GetEntry('word/document.xml')
    if ($null -eq $entry) { throw 'word/document.xml is missing from the docx' }
    $entryStream = $entry.Open()
    try {
      $reader = [System.IO.StreamReader]::new($entryStream, [System.Text.Encoding]::UTF8)
      $xml = $reader.ReadToEnd()
    } finally {
      $entryStream.Dispose()
    }
  } finally {
    $archive.Dispose()
  }
} finally {
  $fileStream.Dispose()
}
# LF only: the txt must stay byte-identical on Windows and macOS.
$newline = [string][char]10
$text = $xml -replace '</w:p>', $newline
$text = $text -replace '<[^>]+>', ''
$text = [System.Net.WebUtility]::HtmlDecode($text)
[System.IO.File]::WriteAllText($OutPath, $text, [System.Text.UTF8Encoding]::new($false))
`

const CONTENT_TYPES_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
  '</Types>'

// 第 2 段在 XML 里以实体形式存放,提取后必须还原成字面字符 & 与 <。
const FIXTURE_PARAGRAPHS = [
  '第一段：本基金份额净值增长率为 5.2%。',
  '第二段：收入 &amp; 支出 &lt;合计&gt; 见下表。',
  '第三段：银行帐户与帐务处理需逐项核对。',
]
const EXPECTED_PARAGRAPHS = [
  '第一段：本基金份额净值增长率为 5.2%。',
  '第二段：收入 & 支出 <合计> 见下表。',
  '第三段：银行帐户与帐务处理需逐项核对。',
]

const DOCUMENT_XML =
  '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
  FIXTURE_PARAGRAPHS.map(
    (paragraph) => `<w:p><w:r><w:t xml:space="preserve">${paragraph}</w:t></w:r></w:p>`,
  ).join('') +
  '</w:body></w:document>'

const PWSH_PROBE = spawnSync('pwsh', ['-Version'], { encoding: 'utf8', timeout: 15_000 })
const PWSH_AVAILABLE = PWSH_PROBE.status === 0
const PWSH_SKIP_REASON =
  'pwsh is not installed on this host, so the SKILL.md Windows extraction recipe is NOT covered here; a Windows host (or pwsh) must run this test. See task-5 report.'

let workDir: string | null = null

function makeWorkDir(): string {
  workDir = mkdtempSync(join(tmpdir(), 'typo-check-pwsh-'))
  return workDir
}

function buildFixtureDocx(dir: string): string {
  const zip = new AdmZip()
  zip.addFile('[Content_Types].xml', Buffer.from(CONTENT_TYPES_XML, 'utf8'))
  zip.addFile('word/document.xml', Buffer.from(DOCUMENT_XML, 'utf8'))
  const docxPath = join(dir, 'fixture.docx')
  zip.writeZip(docxPath)
  return docxPath
}

afterEach(() => {
  if (workDir !== null) rmSync(workDir, { recursive: true, force: true })
  workDir = null
})

describe('typo-check pwsh docx extraction', () => {
  test('fixture docx is a readable zip carrying the escaped document.xml', () => {
    // 这个用例不依赖 pwsh:即使提取用例被跳过,fixture 自身也必须是真 ZIP + 真转义,
    // 否则 Windows 上一旦出现 pwsh 就只会测到一个坏 fixture。
    const dir = makeWorkDir()
    const docxPath = buildFixtureDocx(dir)
    const replayed = new AdmZip(docxPath).readAsText('word/document.xml')
    expect(replayed).toBe(DOCUMENT_XML)
    expect(replayed).toContain('&amp;')
    expect(replayed).toContain('&lt;合计&gt;')
    expect(replayed).not.toContain('收入 & 支出')
  })

  test('extracts paragraphs, strips tags, decodes entities and keeps UTF-8 Chinese (requires pwsh)', (ctx) => {
    if (!PWSH_AVAILABLE) ctx.skip(PWSH_SKIP_REASON)

    const dir = makeWorkDir()
    const docxPath = buildFixtureDocx(dir)
    const scriptPath = join(dir, 'extract-docx.ps1')
    writeFileSync(scriptPath, PWSH_EXTRACT_SCRIPT, 'utf8')
    const outPath = join(dir, 'fixture.txt')

    const result = spawnSync(
      'pwsh',
      ['-NoProfile', '-NonInteractive', '-File', scriptPath, '-DocxPath', docxPath, '-OutPath', outPath],
      { encoding: 'utf8', timeout: 120_000 },
    )
    expect(result.error).toBeUndefined()
    expect(result.status, `pwsh extraction failed: ${result.stderr}`).toBe(0)

    const extracted = readFileSync(outPath, 'utf8')

    // 段落换行:`</w:p>` 每段一处 ⇒ 每段独立一行(末尾换行后无空行)。
    expect(extracted.split('\n').filter((line) => line.length > 0)).toEqual(EXPECTED_PARAGRAPHS)

    // 标签全部移除。
    expect(extracted).not.toMatch(/<\/?w:/)

    // 实体解码:&amp; 与 &lt;&gt; 以字面字符出现,而不是残留实体写法。
    expect(extracted).toContain('收入 & 支出 <合计> 见下表。')
    expect(extracted).not.toContain('&amp;')
    expect(extracted).not.toContain('&lt;')

    // UTF-8 中文完好,无 BOM、无替换字符。
    expect(extracted).toContain('第一段：本基金份额净值增长率为 5.2%。')
    expect(extracted).toContain('第三段：银行帐户与帐务处理需逐项核对。')
    expect(extracted.charCodeAt(0)).not.toBe(0xfeff)
    expect(extracted).not.toContain('\uFFFD')
  })
})
