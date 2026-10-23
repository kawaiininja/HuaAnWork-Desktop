// Fixture agent-package MCP server: a minimal streamable-HTTP JSON-RPC endpoint
// exposing one `echo` tool.
import { writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'

const host = process.env.AGENT_MCP_HOST ?? '127.0.0.1'
const port = Number(process.env.AGENT_MCP_PORT)

if (!Number.isInteger(port) || port <= 0) {
  process.stderr.write('mcp fixture: AGENT_MCP_PORT missing\n')
  process.exit(1)
}

const TOOLS = [
  {
    name: 'echo',
    description: 'Echo the provided arguments',
    inputSchema: { type: 'object', additionalProperties: true },
  },
]

function reply(id, result) {
  return JSON.stringify({ jsonrpc: '2.0', id, result })
}

function handle(message) {
  switch (message.method) {
    case 'initialize':
      return reply(message.id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'demo', version: '1.0.0' },
      })
    case 'tools/list':
      return reply(message.id, { tools: TOOLS })
    case 'tools/call':
      return reply(message.id, {
        content: [{ type: 'text', text: JSON.stringify(message.params?.arguments ?? {}) }],
      })
    default:
      if (message.id === undefined) return undefined
      return JSON.stringify({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32601, message: `unknown method ${message.method}` },
      })
  }
}

const server = createServer((request, response) => {
  if (request.method !== 'POST' || request.url !== '/mcp') {
    response.writeHead(404).end()
    return
  }
  let body = ''
  request.setEncoding('utf8')
  request.on('data', (chunk) => { body += chunk })
  request.on('end', () => {
    let message
    try {
      message = JSON.parse(body)
    } catch {
      response.writeHead(400, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }))
      return
    }
    const payload = handle(message)
    if (payload === undefined) {
      response.writeHead(202).end()
      return
    }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(payload)
  })
})

server.listen(port, host, () => {
  writeFileSync(join(process.cwd(), 'mcp-port.txt'), String(port))
  process.stdout.write(`mcp fixture ready on ${host}:${port}\n`)
})
