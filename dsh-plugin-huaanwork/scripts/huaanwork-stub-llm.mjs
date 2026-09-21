/**
 * Loopback stub LLM for the HuaAnWork host loop spec: an OpenAI-compatible
 * chat-completions SSE server scripted per request. It is the HTTP equivalent
 * of the old sidecar `stubLlm` (packages/sidecar/src/host.ts:1817-1838) with
 * higher fidelity: requests traverse the real `@huaanwork/model` adapter path
 * (`huaanwork-guardrails/model.ts`), and the loopback bind passes the LAN-only
 * network gate by design.
 *
 * Never talks to a real model. Binds 127.0.0.1 on an OS-assigned port only.
 */

import { createServer } from 'node:http'
import { appendFileSync } from 'node:fs'

/**
 * @typedef {object} StubTurn
 * @property {RegExp} match tested against the last user message of the request
 * @property {{ content?: string, toolCalls?: Array<{ name: string, arguments: Record<string, unknown> }>, hang?: boolean }} reply
 */

const DEFAULT_REPLY = { content: 'stub:收到,已完成。' }

/**
 * Start the scripted stub server.
 * @param {StubTurn[]} turns ordered script; the first turn whose `match` hits
 *   the request's last user message wins. Requests whose last wire message is
 *   not a user message (tool-result follow-ups) and non-matching requests get
 *   the fixed default text reply.
 * @returns {Promise<{ url: string, close: () => Promise<void>, requests: unknown[] }>}
 */
export async function startStubLlm(turns) {
  /** @type {unknown[]} */
  const requests = []
  /** @type {import('node:http').ServerResponse[]} */
  const hanging = []

  const server = createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'stub: not found' }))
      return
    }
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      let body
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'stub: invalid json' }))
        return
      }
      requests.push(body)
      if (process.env.STUB_DEBUG_FILE) {
        try {
          appendFileSync(process.env.STUB_DEBUG_FILE, `${JSON.stringify(body.messages?.map((m) => ({ role: m.role, content: typeof m.content === 'string' ? m.content.slice(0, 600) : m.content })))}\n`)
        } catch { /* debug only */ }
      }
      const reply = scriptReply(turns, body)
      if (reply.hang === true) {
        // 剧本 hang:挂起 SSE 不收尾,等客户端取消;连接断开即清理。
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        })
        hanging.push(res)
        res.on('close', () => {
          const at = hanging.indexOf(res)
          if (at >= 0) hanging.splice(at, 1)
        })
        return
      }
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      if (Array.isArray(reply.toolCalls) && reply.toolCalls.length > 0) {
        for (const call of reply.toolCalls) {
          sse(res, {
            choices: [{
              index: 0,
              delta: {
                role: 'assistant',
                tool_calls: [{
                  index: 0,
                  id: `call_stub_${requests.length}`,
                  type: 'function',
                  function: { name: call.name, arguments: JSON.stringify(call.arguments ?? {}) },
                }],
              },
              finish_reason: null,
            }],
          })
        }
        sse(res, { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })
      } else {
        const text = typeof reply.content === 'string' && reply.content.length > 0 ? reply.content : DEFAULT_REPLY.content
        sse(res, { choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] })
        sse(res, { choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })
        sse(res, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
      }
      res.write('data: [DONE]\n\n')
      res.end()
    })
    req.on('error', () => { if (!res.headersSent) res.destroy() })
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve(undefined)
    })
  })
  const { port } = server.address()

  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    async close() {
      for (const res of hanging.splice(0)) res.destroy()
      await new Promise((resolve) => server.close(() => resolve(undefined)))
    },
  }
}

function sse(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`)
}

/**
 * Match the playbook against the request's user messages.
 *
 * The harness appends a runtime-context snapshot as an extra `user` message
 * right after the human text ("Current runtime context. This snapshot
 * supersedes ..."), so the last user message is NOT reliably the human text.
 * Rules:
 * - 尾消息是 tool result(工具结果跟进)→ 固定文本收尾(防剧本重触发,case 2/3 依赖)。
 * - 否则逆序扫描 user 消息,跳过运行时快照,取最近一条真人消息匹配剧本;
 *   不匹配 → 固定文本(不回退更旧的消息,避免旧回合文本被误触发)。
 */
function scriptReply(turns, body) {
  const messages = Array.isArray(body?.messages) ? body.messages : []
  const last = messages[messages.length - 1]
  if (last && typeof last === 'object' && last.role === 'tool') return DEFAULT_REPLY
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (!message || typeof message !== 'object' || message.role !== 'user') continue
    if (typeof message.content !== 'string') continue
    if (isRuntimeContextSnapshot(message.content)) continue
    for (const turn of turns) {
      if (turn.match.test(message.content)) return turn.reply
    }
    return DEFAULT_REPLY
  }
  return DEFAULT_REPLY
}

function isRuntimeContextSnapshot(content) {
  return content.startsWith('Current runtime context.')
}
