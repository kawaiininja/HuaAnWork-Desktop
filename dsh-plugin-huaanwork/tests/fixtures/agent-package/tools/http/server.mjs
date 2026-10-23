// Fixture agent-package HTTP server: listens on the loopback port the host chose
// and answers POST /invoke with the echoed arguments.
import { writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'

const host = process.env.AGENT_HTTP_HOST ?? '127.0.0.1'
const port = Number(process.env.AGENT_HTTP_PORT)

if (!Number.isInteger(port) || port <= 0) {
  process.stderr.write('http fixture: AGENT_HTTP_PORT missing\n')
  process.exit(1)
}

const server = createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/health') {
    response.writeHead(200, { 'content-type': 'text/plain' })
    response.end('ok')
    return
  }
  if (request.method !== 'POST' || request.url !== '/invoke') {
    response.writeHead(404, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ ok: false, error: 'not found' }))
    return
  }
  let body = ''
  request.setEncoding('utf8')
  request.on('data', (chunk) => { body += chunk })
  request.on('end', () => {
    let payload = {}
    try {
      payload = JSON.parse(body)
    } catch {
      response.writeHead(400, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok: false, error: 'invalid json' }))
      return
    }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ ok: true, result: { echo: payload.arguments ?? {} } }))
  })
})

server.listen(port, host, () => {
  writeFileSync(join(process.cwd(), 'http-port.txt'), String(port))
  process.stdout.write(`http fixture ready on ${host}:${port}\n`)
})
