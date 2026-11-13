import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import AdmZip from 'adm-zip'
import { afterEach, describe, expect, test } from 'vitest'

import { classifyShell } from '@huaanwork/policy/shell'

// SKILL.md（agent-packages/typo-check/skill/SKILL.md）的 Windows 提取处方是
// **单条简单命令** `pwsh -EncodedCommand <base64>`：base64 按 PowerShell 约定编码
// 整段脚本的 UTF-16LE 文本，字母表不含 shell 元字符（ask/smart 档的 classifyShell
// 对含 `$`/`;` 的内联脚本直接 deny，只有 full 档放行）。本 spec 不再另行物化 .ps1，
// 而是从 SKILL.md 取出处方脚本原文、代入 fixture 路径、编码后执行 SKILL 规定的
// 那条命令——测的就是 SKILL 文本本身，处方漂移会立刻红。
const SKILL_PATH = join(import.meta.dirname, '..', '..', 'agent-packages', 'typo-check', 'skill', 'SKILL.md')
const SKILL_TEXT = readFileSync(SKILL_PATH, 'utf8')

function skillRecipe(): string {
  const match = /```powershell\n([\s\S]*?)```/u.exec(SKILL_TEXT)
  const recipe = match?.[1]
  if (recipe === undefined) throw new Error('SKILL.md carries no powershell recipe block')
  return recipe
}

/** The exact command the SKILL prescribes: `pwsh -EncodedCommand <base64>`. */
function prescribedCommand(docxPath: string, outPath: string): { argv: string[]; command: string } {
  const script = skillRecipe().replaceAll('<DOCX>', docxPath).replaceAll('<OUT>', outPath)
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  return { argv: ['-EncodedCommand', encoded], command: `pwsh -EncodedCommand ${encoded}` }
}

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

  test('SKILL prescribes a metachar-free EncodedCommand carrying the full recipe', () => {
    // 不依赖 pwsh：处方文本与命令形态在 macOS 上也能钉住。
    expect(SKILL_TEXT).toContain('pwsh -EncodedCommand')
    expect(SKILL_TEXT).toContain('单条简单命令')
    const recipe = skillRecipe()
    for (const pin of ['System.IO.Compression', 'word/document.xml', '</w:p>', 'HtmlDecode', 'UTF8Encoding', '<DOCX>', '<OUT>']) {
      expect(recipe).toContain(pin)
    }
    // 代入真实路径后的命令串必须不被 classifyShell 判 deny（元字符自由），
    // 否则 smart 档（SKILL 指定的档位）根本发不出去。
    const { command } = prescribedCommand(join(tmpdir(), 'fixture.docx'), join(tmpdir(), 'fixture.txt'))
    expect(command.startsWith('pwsh -EncodedCommand ')).toBe(true)
    expect(classifyShell(command)).not.toBe('deny')
    // 对照：内联脚本形态（含 $/;）在 ask/smart 档被 deny——处方改回内联会红。
    expect(classifyShell(`pwsh -Command "${recipe.replaceAll('"', '\\"')}"`)).toBe('deny')
  })

  test('extracts paragraphs, strips tags, decodes entities and keeps UTF-8 Chinese (requires pwsh)', (ctx) => {
    if (!PWSH_AVAILABLE) ctx.skip(PWSH_SKIP_REASON)

    const dir = makeWorkDir()
    const docxPath = buildFixtureDocx(dir)
    const outPath = join(dir, 'fixture.txt')

    // 执行 SKILL 规定的那条命令本身：pwsh -EncodedCommand <base64 of the recipe>。
    const { argv, command } = prescribedCommand(docxPath, outPath)
    expect(classifyShell(command)).not.toBe('deny')
    const result = spawnSync('pwsh', argv, { encoding: 'utf8', timeout: 120_000 })
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
