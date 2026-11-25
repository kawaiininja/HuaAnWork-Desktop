/**
 * 最小中文 CID PDF 样本生成器（控制器裁决 M-11）。
 *
 * 纯 JS/TS 字节构造，零测试专用依赖：Vitest 提取器用例与 Task 7
 * `packaged-runtime-smoke` 共用同一份样本，确保打包态 `cmaps/` 与
 * `standard_fonts/` 配置正确时中文不会变成乱码。
 *
 * 结构：Type0 字体 + `/Encoding /UniGB-UCS2-H`（触发 pdfjs 从 `cMapUrl`
 * 加载预定义 CMap）+ 内联 ToUnicode CMap（文字层解码为原字符）。文本以
 * UCS-2 大端十六进制写入内容流；样本只用 BMP 常用汉字，不嵌入字体。
 */

/** 默认可提取文本：非空字符数 > 30，满足 M1「文字页」判定。 */
const DEFAULT_PDF_TEXT = '产品合规说明书：本产品遵循基金销售适当性管理办法与信息披露要求。'

function utf16BeHex(text: string): string {
  let hex = ''
  for (let index = 0; index < text.length; index += 1) {
    hex += text.charCodeAt(index).toString(16).toUpperCase().padStart(4, '0')
  }
  return hex
}

/** 生成最多 100 条 `beginbfchar` 块。 */
function buildToUnicodeCMap(codeUnits: readonly number[]): string {
  const unique = [...new Set(codeUnits)]
  const lines: string[] = [
    '/CIDInit /ProcSet findresource begin',
    '12 dict begin',
    'begincmap',
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
    '/CMapName /Adobe-Identity-UCS def',
    '/CMapType 2 def',
    '1 begincodespacerange',
    '<0000> <FFFF>',
    'endcodespacerange',
  ]
  for (let start = 0; start < unique.length; start += 100) {
    const block = unique.slice(start, start + 100)
    lines.push(`${block.length} beginbfchar`)
    for (const code of block) {
      const hex = code.toString(16).toUpperCase().padStart(4, '0')
      lines.push(`<${hex}> <${hex}>`)
    }
    lines.push('endbfchar')
  }
  lines.push('endcmap', 'CMapName currentdict /CMap defineresource pop', 'end', 'end')
  return `${lines.join('\n')}\n`
}

interface PdfStreamObject {
  readonly data: string
}

type PdfObject = string | PdfStreamObject

function isStreamObject(object: PdfObject): object is PdfStreamObject {
  return typeof object !== 'string'
}

function serializeObject(objectNumber: number, object: PdfObject): Buffer {
  if (!isStreamObject(object)) {
    return Buffer.from(`${objectNumber} 0 obj\n${object}\nendobj\n`, 'latin1')
  }
  const dataBytes = Buffer.from(object.data, 'latin1')
  return Buffer.from(
    `${objectNumber} 0 obj\n<< /Length ${dataBytes.byteLength} >>\nstream\n`
      + `${object.data}endstream\nendobj\n`,
    'latin1',
  )
}

/**
 * 构造一份可被 pdfjs 提取出中文文字层的单页 PDF。
 *
 * @param text - 要写入页面的文本（BMP 字符；缺省为合规说明句）。
 */
export function buildMinimalChineseCidPdf(text: string = DEFAULT_PDF_TEXT): Buffer {
  const codeUnits: number[] = []
  for (let index = 0; index < text.length; index += 1) {
    codeUnits.push(text.charCodeAt(index))
  }
  const contentStream = `BT\n/F1 14 Tf\n72 720 Td\n<${utf16BeHex(text)}> Tj\nET\n`

  const objects: PdfObject[] = [
    // 1: Catalog
    '<< /Type /Catalog /Pages 2 0 R >>',
    // 2: Pages
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    // 3: Page
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] '
      + '/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    // 4: Type0 font using a predefined Adobe-GB1 CMap
    '<< /Type /Font /Subtype /Type0 /BaseFont /HuaAnWorkCIDTest '
      + '/Encoding /UniGB-UCS2-H /DescendantFonts [6 0 R] /ToUnicode 7 0 R >>',
    // 5: page content stream
    { data: contentStream },
    // 6: CIDFontType2 descendant with Identity CIDToGIDMap and default width
    '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /HuaAnWorkCIDTest '
      + '/CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 2 >> '
      + '/FontDescriptor 8 0 R /CIDToGIDMap /Identity /DW 1000 >>',
    // 7: ToUnicode CMap stream
    { data: buildToUnicodeCMap(codeUnits) },
    // 8: Font descriptor (no embedded font program: text layer only)
    '<< /Type /FontDescriptor /FontName /HuaAnWorkCIDTest /Flags 4 '
      + '/FontBBox [0 -120 1000 880] /ItalicAngle 0 /Ascent 880 /Descent -120 '
      + '/CapHeight 700 /StemV 80 >>',
  ]

  const chunks: Buffer[] = []
  const header = Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n', 'latin1')
  chunks.push(header)
  let offset = header.byteLength
  const offsets: number[] = []
  for (let index = 0; index < objects.length; index += 1) {
    const object = objects[index]
    if (object === undefined) continue
    offsets.push(offset)
    const buffer = serializeObject(index + 1, object)
    chunks.push(buffer)
    offset += buffer.byteLength
  }

  const xrefLines: string[] = ['xref', `0 ${objects.length + 1}`, '0000000000 65535 f \r\n']
  for (const entryOffset of offsets) {
    xrefLines.push(`${entryOffset.toString().padStart(10, '0')} 00000 n \r\n`)
  }
  xrefLines.push(
    'trailer',
    `<< /Size ${objects.length + 1} /Root 1 0 R >>`,
    'startxref',
    `${offset}`,
    '%%EOF',
    '',
  )
  chunks.push(Buffer.from(xrefLines.join('\n'), 'latin1'))
  return Buffer.concat(chunks)
}
