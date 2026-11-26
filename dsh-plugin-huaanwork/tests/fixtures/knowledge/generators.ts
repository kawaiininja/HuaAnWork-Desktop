/**
 * 知识库提取器测试样本生成器（计划 Task 5）。
 *
 * 全部为纯 JS/TS 字节构造：最小 docx / xlsx / pptx、伪造中央目录
 * `header.size = 0` 的 ZIP 炸弹、加密 ZIP 与超条目数 ZIP。中文 CID PDF
 * 生成器按 M-11 放在产品源码 `src/huaanwork-host/knowledge/pdf-fixture.ts`，
 * 这里仅再导出，保证 Vitest 与 Task 7 打包冒烟共用同一份字节实现。
 */

import { deflateRawSync } from 'node:zlib'

export { buildMinimalChineseCidPdf } from '../../../src/huaanwork-host/knowledge/pdf-fixture.ts'

const ZIP_LOCAL_SIG = 0x04034b50
const ZIP_CENTRAL_SIG = 0x02014b50
const ZIP_EOCD_SIG = 0x06054b50
const ZIP_METHOD_STORED = 0
const ZIP_METHOD_DEFLATED = 8
const ZIP_FLAG_ENCRYPTED = 0x0001
const ZIP_DOS_DATE_1980_01_01 = 0x0021

const CRC32_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb8_8320 ^ (value >>> 1) : value >>> 1
    }
    table[index] = value >>> 0
  }
  return table
})()

function crc32(buffer: Buffer): number {
  let crc = 0xffff_ffff
  for (const byte of buffer) {
    crc = (CRC32_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8)
  }
  return (crc ^ 0xffff_ffff) >>> 0
}

export interface ZipFixtureEntry {
  readonly name: string
  readonly data: Buffer
  readonly method?: number
  readonly flags?: number
  /** 伪造中央目录 `header.size`（B-1 炸弹用）；缺省为真实解压长度。 */
  readonly declaredSize?: number
}

/** 以 stored / deflated 写入最小 ZIP（含正确的本地头、中央目录与 EOCD）。 */
export function buildZipBuffer(entries: readonly ZipFixtureEntry[]): Buffer {
  const localChunks: Buffer[] = []
  const centralChunks: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, 'utf8')
    const method = entry.method ?? ZIP_METHOD_DEFLATED
    const flags = entry.flags ?? 0
    const compressed = method === ZIP_METHOD_DEFLATED ? deflateRawSync(entry.data) : entry.data
    const crc = crc32(entry.data)
    const declaredSize = entry.declaredSize ?? entry.data.byteLength

    const local = Buffer.alloc(30)
    local.writeUInt32LE(ZIP_LOCAL_SIG, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(flags, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(0, 10)
    local.writeUInt16LE(ZIP_DOS_DATE_1980_01_01, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(compressed.byteLength, 18)
    local.writeUInt32LE(declaredSize, 22)
    local.writeUInt16LE(nameBytes.byteLength, 26)
    local.writeUInt16LE(0, 28)
    localChunks.push(local, nameBytes, compressed)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(ZIP_CENTRAL_SIG, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(flags, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt16LE(0, 12)
    central.writeUInt16LE(ZIP_DOS_DATE_1980_01_01, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(compressed.byteLength, 20)
    central.writeUInt32LE(declaredSize, 24)
    central.writeUInt16LE(nameBytes.byteLength, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(0, 38)
    central.writeUInt32LE(offset, 42)
    centralChunks.push(central, nameBytes)

    offset += local.byteLength + nameBytes.byteLength + compressed.byteLength
  }
  const centralDirectory = Buffer.concat(centralChunks)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(ZIP_EOCD_SIG, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralDirectory.byteLength, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)
  return Buffer.concat([...localChunks, centralDirectory, eocd])
}

function escapeXml(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&apos;')
}

const CONTENT_TYPES_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
  + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
  + '<Default Extension="xml" ContentType="application/xml"/>'
  + '</Types>'

/** 最小 Word 文档：`<w:p><w:r><w:t>` 段落文本。 */
export function buildMinimalDocx(text: string): Buffer {
  const documentXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
    + '<w:body>'
    + `<w:p><w:r><w:t>${escapeXml(text)}</w:t></w:r></w:p>`
    + '</w:body></w:document>'
  return buildZipBuffer([
    { name: '[Content_Types].xml', data: Buffer.from(CONTENT_TYPES_XML, 'utf8'), method: ZIP_METHOD_STORED },
    { name: 'word/document.xml', data: Buffer.from(documentXml, 'utf8'), method: ZIP_METHOD_DEFLATED },
  ])
}

/** 最小工作簿：sharedStrings + 单表 worksheet（表头行即第一行）。 */
export function buildMinimalXlsx(sheetName: string, rows: readonly (readonly string[])[]): Buffer {
  const shared: string[] = []
  const sharedIndex = new Map<string, number>()
  const indexOf = (value: string): number => {
    const existing = sharedIndex.get(value)
    if (existing !== undefined) return existing
    const index = shared.length
    shared.push(value)
    sharedIndex.set(value, index)
    return index
  }
  const rowXml: string[] = []
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const cells = rows[rowIndex] ?? []
    const cellXml = cells
      .filter(cell => cell !== '')
      .map((cell, columnIndex) => {
        const reference = `${String.fromCharCode(65 + columnIndex)}${rowIndex + 1}`
        return `<c r="${reference}" t="s"><v>${indexOf(cell)}</v></c>`
      })
      .join('')
    rowXml.push(`<row r="${rowIndex + 1}">${cellXml}</row>`)
  }
  const workbookXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
    + 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
    + `<sheets><sheet name="${escapeXml(sheetName)}" sheetId="1" r:id="rId1"/></sheets>`
    + '</workbook>'
  const sharedStringsXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    + `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${shared.length}" uniqueCount="${shared.length}">`
    + shared.map(item => `<si><t>${escapeXml(item)}</t></si>`).join('')
    + '</sst>'
  const sheetXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    + `<sheetData>${rowXml.join('')}</sheetData>`
    + '</worksheet>'
  return buildZipBuffer([
    { name: '[Content_Types].xml', data: Buffer.from(CONTENT_TYPES_XML, 'utf8'), method: ZIP_METHOD_STORED },
    { name: 'xl/workbook.xml', data: Buffer.from(workbookXml, 'utf8') },
    { name: 'xl/sharedStrings.xml', data: Buffer.from(sharedStringsXml, 'utf8') },
    { name: 'xl/worksheets/sheet1.xml', data: Buffer.from(sheetXml, 'utf8') },
  ])
}

/** 最小演示文稿：每页一个 `<a:p><a:r><a:t>` 文本段落。 */
export function buildMinimalPptx(slideTexts: readonly string[]): Buffer {
  const slideEntries: ZipFixtureEntry[] = slideTexts.map((text, index) => {
    const slideXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
      + '<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
      + 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">'
      + '<p:cSld><p:spTree><p:sp><p:txBody>'
      + `<a:p><a:r><a:t>${escapeXml(text)}</a:t></a:r></a:p>`
      + '</p:txBody></p:sp></p:spTree></p:cSld></p:sld>'
    return { name: `ppt/slides/slide${index + 1}.xml`, data: Buffer.from(slideXml, 'utf8') }
  })
  return buildZipBuffer([
    { name: '[Content_Types].xml', data: Buffer.from(CONTENT_TYPES_XML, 'utf8'), method: ZIP_METHOD_STORED },
    ...slideEntries,
  ])
}

/**
 * 伪造 `header.size = 0` 的 ZIP 炸弹 docx（B-1 回归样本）：
 * 中央目录谎报解压后 0 字节，真实 deflate 流会膨胀 `inflatedBytes`；
 * 提取器必须靠 `inflateRawSync` 的 `maxOutputLength` fail-closed。
 */
export function buildForgedZeroSizeZipBombDocx(inflatedBytes: number): Buffer {
  return buildZipBuffer([
    {
      name: 'word/document.xml',
      data: Buffer.alloc(Math.max(1, inflatedBytes), 0x41),
      method: ZIP_METHOD_DEFLATED,
      declaredSize: 0,
    },
  ])
}

/** 超条目数 ZIP：`entryCount` 个 XML 条目（多出 MAX_ZIP_ENTRIES）。 */
export function buildOverEntryLimitZipDocx(entryCount: number): Buffer {
  const entries: ZipFixtureEntry[] = [{ name: 'word/document.xml', data: Buffer.from('<w:document/>', 'utf8') }]
  for (let index = 1; index < entryCount; index += 1) {
    entries.push({
      name: `word/media/part${index}.xml`,
      data: Buffer.from('<part/>', 'utf8'),
      method: ZIP_METHOD_STORED,
    })
  }
  return buildZipBuffer(entries)
}

/** 传统 ZipCrypto 加密条目（通用位标记 bit 0），提取器必须直接跳过。 */
export function buildEncryptedZipBuffer(): Buffer {
  return buildZipBuffer([
    {
      name: 'word/document.xml',
      data: Buffer.from('ENCRYPTED-PAYLOAD-PLACEHOLDER', 'utf8'),
      method: ZIP_METHOD_STORED,
      flags: ZIP_FLAG_ENCRYPTED,
    },
  ])
}

/** C-3 / M-5 回归：含自闭合空单元格 `<c r="A1" s="3"/>`、自闭合 `<row/>`、多 `<t>` 内联串、单引号属性与非顺序 `workbook.xml.rels`。 */
export function buildRichSelfClosingXlsx(): Buffer {
  const workbookXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    + "<workbook xmlns='http://schemas.openxmlformats.org/spreadsheetml/2006/main' "
    + "xmlns:r='http://schemas.openxmlformats.org/officeDocument/2006/relationships'>"
    + "<sheets><sheet name='风控总表' sheetId='1' r:id='rId2'/><sheet name='附表甲' sheetId='2' r:id='rId1'/></sheets>"
    + '</workbook>'
  const relsXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + "<Relationship Id='rId1' Target='worksheets/sheet1.xml'/>"
    + "<Relationship Id='rId2' Target='worksheets/sheet2.xml'/>"
    + '</Relationships>'
  const sharedStringsXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    + '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    + '<si><t>列头甲</t></si>'
    + '<si><t>第一条关键数据</t></si>'
    + '<si><t/>'
    + '<t>空后拼接</t></si>'
    + '</sst>'
  const sheet1Xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>'
    + '<row r="1"><c r="A1" s="3"/><c r="B1" t="s"><v>0</v></c></row>'
    + '<row r="2"/>'
    + '<row r="5"><c r="A5" s="1"/><c r="B5" t="s"><v>1</v></c><c r="C5" t="inlineStr"><is><r><t>合</t></r><r><t>规</t></r></is></c></row>'
    + '</sheetData></worksheet>'
  const sheet2Xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>'
    + '<row r="1"><c r="A1" t="s"><v>2</v></c></row>'
    + '</sheetData></worksheet>'
  return buildZipBuffer([
    { name: '[Content_Types].xml', data: Buffer.from(CONTENT_TYPES_XML, 'utf8'), method: ZIP_METHOD_STORED },
    { name: 'xl/workbook.xml', data: Buffer.from(workbookXml, 'utf8') },
    { name: 'xl/_rels/workbook.xml.rels', data: Buffer.from(relsXml, 'utf8') },
    { name: 'xl/sharedStrings.xml', data: Buffer.from(sharedStringsXml, 'utf8') },
    { name: 'xl/worksheets/sheet1.xml', data: Buffer.from(sheet1Xml, 'utf8') },
    { name: 'xl/worksheets/sheet2.xml', data: Buffer.from(sheet2Xml, 'utf8') },
  ])
}

/** I-8 回归：含真实 `<w:tab/>`、`<w:br/>`、自闭合 `<w:t/>` 与字面 `&lt;w:br/&gt;` 的 DOCX。 */
export function buildDocxWithTabsAndBreaks(): Buffer {
  const documentXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
    + '<w:p><w:r><w:t>列一</w:t><w:tab/><w:t>列二</w:t><w:br/><w:t/>'
    + '<w:t>字面&lt;w:br/&gt;保持原样</w:t></w:r></w:p>'
    + '</w:body></w:document>'
  return buildZipBuffer([
    { name: '[Content_Types].xml', data: Buffer.from(CONTENT_TYPES_XML, 'utf8'), method: ZIP_METHOD_STORED },
    { name: 'word/document.xml', data: Buffer.from(documentXml, 'utf8') },
  ])
}

/** I-8 回归：`xl/workbook.xml` 伪装为 0 字节的 25 MB 炸弹，必须 fail-closed 返回 `zip-limit-exceeded`。 */
export function buildWorkbookBombXlsx(): Buffer {
  return buildZipBuffer([
    { name: '[Content_Types].xml', data: Buffer.from(CONTENT_TYPES_XML, 'utf8'), method: ZIP_METHOD_STORED },
    { name: 'xl/workbook.xml', data: Buffer.alloc(25 * 1024 * 1024, 0x41), method: ZIP_METHOD_DEFLATED, declaredSize: 0 },
    { name: 'xl/worksheets/sheet1.xml', data: Buffer.from('<worksheet><sheetData/></worksheet>', 'utf8') },
  ])
}

/** I-8 回归：合法 ZIP64 归档（EOCD 条目数 0xFFFF，ZIP64 EOCD 真实条目数为 2）。 */
export function buildValidZip64Docx(text: string): Buffer {
  const baseZip = buildMinimalDocx(text)
  // 拆出原 EOCD（末尾 22 字节）并在中央目录后追加 ZIP64 EOCD（56B）+ ZIP64 Locator（20B）+ 修改后的 EOCD（22B）。
  const bodyWithoutEocd = baseZip.subarray(0, baseZip.byteLength - 22)
  const origEocd = baseZip.subarray(baseZip.byteLength - 22)
  const cdSize = origEocd.readUInt32LE(12)
  const cdOffset = origEocd.readUInt32LE(16)
  const entryCount = origEocd.readUInt16LE(10)

  const zip64EocdOffset = bodyWithoutEocd.byteLength
  const zip64Eocd = Buffer.alloc(56)
  zip64Eocd.writeUInt32LE(0x06064b50, 0)
  zip64Eocd.writeBigUInt64LE(44n, 4)
  zip64Eocd.writeUInt16LE(45, 12)
  zip64Eocd.writeUInt16LE(45, 14)
  zip64Eocd.writeUInt32LE(0, 16)
  zip64Eocd.writeUInt32LE(0, 20)
  zip64Eocd.writeBigUInt64LE(BigInt(entryCount), 24)
  zip64Eocd.writeBigUInt64LE(BigInt(entryCount), 32)
  zip64Eocd.writeBigUInt64LE(BigInt(cdSize), 40)
  zip64Eocd.writeBigUInt64LE(BigInt(cdOffset), 48)

  const zip64Locator = Buffer.alloc(20)
  zip64Locator.writeUInt32LE(0x07064b50, 0)
  zip64Locator.writeUInt32LE(0, 4)
  zip64Locator.writeBigUInt64LE(BigInt(zip64EocdOffset), 8)
  zip64Locator.writeUInt32LE(1, 16)

  const eocd64 = Buffer.from(origEocd)
  eocd64.writeUInt16LE(0xffff, 8)
  eocd64.writeUInt16LE(0xffff, 10)
  return Buffer.concat([bodyWithoutEocd, zip64Eocd, zip64Locator, eocd64])
}

/** I-8 回归：带标准 `/Encrypt` 字典的最小密码保护 PDF（触发 pdfjs `PasswordException`）。 */
export function buildPasswordProtectedPdf(): Buffer {
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [] /Count 0 >>\nendobj\n',
    '3 0 obj\n<< /Filter /Standard /V 1 /R 2 /O <0000000000000000000000000000000000000000000000000000000000000000> /U <0000000000000000000000000000000000000000000000000000000000000000> /P -4 >>\nendobj\n',
  ]
  const header = '%PDF-1.4\n'
  let body = header
  const offsets: number[] = [0]
  for (const obj of objects) {
    offsets.push(Buffer.byteLength(body, 'latin1'))
    body += obj
  }
  const xrefPos = Buffer.byteLength(body, 'latin1')
  let xref = `xref\n0 ${String(objects.length + 1)}\n0000000000 65535 f \n`
  for (let i = 1; i < offsets.length; i += 1) {
    xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`
  }
  const trailer = `trailer\n<< /Size ${String(objects.length + 1)} /Root 1 0 R /Encrypt 3 0 R /ID [<0123456789abcdef> <0123456789abcdef>] >>\nstartxref\n${String(xrefPos)}\n%%EOF\n`
  return Buffer.from(body + xref + trailer, 'latin1')
}

/** 构造多页 ASCII / 空白混合 PDF（空字符串页触发 `needs-vision`，用于预算与早停回归）。 */
export function buildMultiPageAsciiPdf(pages: readonly string[]): Buffer {
  const pageCount = pages.length
  const fontObjNum = 3
  const kidsRefs: string[] = []
  const objects: string[] = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '', // placeholder for 2: Pages
    `${String(fontObjNum)} 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n`,
  ]
  for (let i = 0; i < pageCount; i += 1) {
    const pageObjNum = 4 + i * 2
    const contentObjNum = pageObjNum + 1
    kidsRefs.push(`${String(pageObjNum)} 0 R`)
    const escaped = (pages[i] ?? '').replace(/\\/gu, '\\\\').replace(/\(/gu, '\\(').replace(/\)/gu, '\\)')
    const stream = escaped === '' ? '' : `BT /F1 12 Tf 72 720 Td (${escaped}) Tj ET`
    objects.push(
      `${String(pageObjNum)} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${String(fontObjNum)} 0 R >> >> /Contents ${String(contentObjNum)} 0 R >>\nendobj\n`,
      `${String(contentObjNum)} 0 obj\n<< /Length ${String(Buffer.byteLength(stream, 'latin1'))} >>\nstream\n${stream}\nendstream\nendobj\n`,
    )
  }
  objects[1] = `2 0 obj\n<< /Type /Pages /Kids [${kidsRefs.join(' ')}] /Count ${String(pageCount)} >>\nendobj\n`

  const header = '%PDF-1.4\n'
  let body = header
  const offsets: number[] = [0]
  for (const obj of objects) {
    offsets.push(Buffer.byteLength(body, 'latin1'))
    body += obj
  }
  const xrefPos = Buffer.byteLength(body, 'latin1')
  let xref = `xref\n0 ${String(objects.length + 1)}\n0000000000 65535 f \n`
  for (let i = 1; i < offsets.length; i += 1) {
    xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`
  }
  const trailer = `trailer\n<< /Size ${String(objects.length + 1)} /Root 1 0 R >>\nstartxref\n${String(xrefPos)}\n%%EOF\n`
  return Buffer.from(body + xref + trailer, 'latin1')
}
