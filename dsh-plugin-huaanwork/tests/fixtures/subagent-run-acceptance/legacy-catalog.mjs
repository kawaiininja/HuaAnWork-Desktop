/**
 * Loopback legacy agent catalog for the Windows subagent-run acceptance.
 *
 * Serves one spec-valid `kind: agent` entry so the real legacy `@legacy-demo`
 * path runs without the intranet catalog. This is a fixture, not evidence that
 * the real intranet catalog works; the report records that boundary.
 */
import { createServer } from 'node:http'

const ENTRY = Object.freeze({
  name: 'legacy-demo',
  version: '1.0.0',
  kind: 'agent',
  description: 'Windows GHA legacy @ 验收夹具：真实执行 shell 工具并汇总。',
  whenToUse: '验收 legacy @agent 运行卡与定向取消时使用。',
  persona: '你是 legacy @agent 验收夹具。严格按用户请求执行；需要工具时真实调用当前平台提供的 shell 工具，不要凭空编造执行结果。完成后用一句话汇报。',
  allow: ['bash', 'pwsh', 'read', 'read_file', 'glob', 'grep'],
  permissions: ['读取本机目录', '执行本机命令'],
})

const PAYLOAD = JSON.stringify({ items: [ENTRY] })

export async function startLegacyCatalogFixture(options = {}) {
  const logFile = options.logFile
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    logFile?.write?.(`${request.method ?? 'GET'} ${url.pathname}\n`)
    if (url.pathname === '/v1/catalog') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(PAYLOAD)
      return
    }
    if (url.pathname === `/v1/catalog/${ENTRY.name}`) {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(ENTRY))
      return
    }
    response.writeHead(404, { 'content-type': 'application/json' })
    response.end('{"error":"not found"}')
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve(undefined)
    })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('legacy catalog fixture did not bind a TCP port')
  return {
    kind: 'loopback-fixture',
    host: '127.0.0.1',
    port: address.port,
    entryName: ENTRY.name,
    async close() {
      await new Promise((resolve) => server.close(() => resolve(undefined)))
    },
  }
}
