import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const FACTS = `(() => {
  const log = document.querySelector('.chat-log')
  if (!log) return null
  const rows = [...log.children]
  const panels = [...document.querySelectorAll('.tool-panel')]
  return {
    panelCount: panels.length,
    thinkingCount: document.querySelectorAll('.thinking-panel').length,
    titles: panels.map((p) => p.querySelector('.tool-panel-title')?.textContent ?? ''),
    counts: panels.map((p) => Number((p.querySelector('.tool-panel-title')?.textContent ?? '').match(/(\\d+) 项调用/)?.[1] ?? 0)),
    panelRowIndexes: panels.map((p) => rows.indexOf(p)),
    expanded: panels.map((p) => p.querySelector('.tool-panel-title')?.getAttribute('aria-expanded')),
  }
})()`

const STOPPED = `document.querySelector('.send.stop') === null`

// 三轮 T9-1：requestSubmit() 绕过 composer 就绪门（hostPhase/sidecar/pendingInput/运行中），会静默 no-op 或把提示误投成输入卡回答/运行中续写；改为等草稿写回后点可点的发送按钮，同 huaanwork-subagent-run-windows-acceptance.mjs 的 sendText。
function sendExpression(text) {
  return `(async () => {
    const box = document.querySelector('.composer textarea')
    if (!box) return { ok: false, reason: 'composer missing' }
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
    setter.call(box, ${JSON.stringify(text)})
    box.dispatchEvent(new Event('input', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 80))
    const send = document.querySelector('.composer button.send[aria-label="发送"]')
    if (!send) return { ok: false, reason: 'send button missing' }
    if (send.disabled) return { ok: false, reason: 'send disabled' }
    send.click()
    return { ok: true }
  })()`
}

// 会话行的 title 属性是 `${label}\n${sessionId}`（App.tsx 的 recent-item 渲染），按 id 后缀精确匹配；
// 项目行 title 以路径结尾、自动化运行标签行无 id 后缀，都不会误命中；也不依赖可能重名的显示标题。
function openHistoryExpression(sessionId) {
  return `(() => {
    const sessionId = ${JSON.stringify(sessionId)}
    const row = [...document.querySelectorAll('.recent-item')].find((item) => (item.getAttribute('title') ?? '').endsWith('\\n' + sessionId))
    if (!row) return null
    const attribute = row.getAttribute('title') ?? ''
    const title = attribute.slice(0, attribute.length - sessionId.length - 1).replace(/\\s+/g, ' ').trim()
    const log = document.querySelector('.chat-log')
    // 点击前的页面状态：a7-1 曾因只看 .tool-panel/.thinking-panel 非空而被上一次会话的既有内容满足，
    // 静默截到旧会话；记录旧日志元素与「旧日志已显示本会话」判定，供就绪等待区分重挂载与原地停留。
    window.__acceptOldLog = log
    window.__acceptOldLogMatched = log !== null
      && ((log.querySelector('.bubble.user')?.textContent ?? '').replace(/\\s+/g, ' ').trim().includes(title))
    row.click()
    return title
  })()`
}

// 就绪判据必须绑定被点的那一行（会话 id / 期望标题），不能是任意非空看板：
// - 只读回退：`.session-detail-title` 的 title 恰为本会话 id；
// - 可聊视图：首条用户消息（与宿主 summarizeSession 同为空白折叠 + trim）包含期望标题，
//   且要么 `.chat-log` 已重挂载，要么点击前显示的本来就是本会话（同标签重复点击不重挂载）。
function historyReadyExpression(sessionId, title) {
  return `(() => {
    if (document.querySelector('.session-detail-title')?.getAttribute('title') === ${JSON.stringify(sessionId)}) return true
    const log = document.querySelector('.chat-log')
    if (!log) return false
    if (log === window.__acceptOldLog && window.__acceptOldLogMatched !== true) return false
    const first = log.querySelector('.bubble.user')
    if (!first) return false
    return (first.textContent ?? '').replace(/\\s+/g, ' ').trim().includes(${JSON.stringify(title)})
  })()`
}

function toggleExpression(index) {
  return `(() => {
    const titles = [...document.querySelectorAll('.tool-panel .tool-panel-title')]
    if (!titles[${index}]) return false
    titles[${index}].click()
    return true
  })()`
}

function parseArgs(argv) {
  const options = { cdp: '9333', origin: undefined, timeout: 300_000, action: 'facts', out: undefined, prompt: undefined, sessionId: undefined, index: 0, newTask: true }
  for (const arg of argv) {
    if (arg.startsWith('--cdp=')) options.cdp = arg.slice(6)
    else if (arg.startsWith('--origin=')) options.origin = arg.slice(9)
    else if (arg.startsWith('--timeout=')) options.timeout = Number(arg.slice(10))
    else if (arg.startsWith('--action=')) options.action = arg.slice(9)
    else if (arg.startsWith('--out=')) options.out = arg.slice(6)
    else if (arg.startsWith('--prompt=')) options.prompt = arg.slice(9)
    else if (arg.startsWith('--session-id=')) options.sessionId = arg.slice(13)
    else if (arg.startsWith('--index=')) options.index = Number(arg.slice(8))
    else if (arg.startsWith('--new=')) options.newTask = arg.slice(6) !== '0'
    else throw new Error(`unknown argument: ${arg}`)
  }
  if (!['facts', 'new-task', 'send', 'stop', 'toggle', 'open-history'].includes(options.action)) throw new Error('bad --action')
  if (options.action === 'send' || options.action === 'stop') {
    if (typeof options.prompt !== 'string' || options.prompt.length === 0) throw new Error('--prompt required')
  }
  if (options.action === 'open-history' && typeof options.sessionId !== 'string') throw new Error('--session-id required')
  if (!Number.isSafeInteger(options.timeout) || options.timeout < 1) throw new Error('bad --timeout')
  return options
}

async function pageTarget(port, origin) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`)
  if (!response.ok) throw new Error(`CDP list HTTP ${response.status}`)
  let pages = (await response.json()).filter((t) => t.type === 'page' && typeof t.url === 'string' && t.webSocketDebuggerUrl)
  if (origin !== undefined) {
    pages = pages.filter((t) => t.url.startsWith(origin))
  } else {
    // 二轮 M-5：webserver 在默认口 43120 被占时顺延（desktop-port.ts 重试上限 32），不假设默认口；
    // 客户端 origin 直接取本调试端口自己的页面清单，--origin 仅作歧义时的逃生门。
    pages = pages.filter((t) => /^http:\/\/127\.0\.0\.1:\d+\//.test(t.url))
  }
  if (pages.length !== 1) {
    throw new Error(origin === undefined
      ? `expected one 127.0.0.1 page on the debugging port, found ${pages.length}; pass --origin=... to disambiguate`
      : `expected one ${origin} page, found ${pages.length}`)
  }
  return pages[0]
}

async function connect(target, timeout) {
  const socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((ok, fail) => {
    socket.addEventListener('open', ok, { once: true })
    socket.addEventListener('error', () => fail(new Error('CDP WebSocket failed')), { once: true })
  })
  let sequence = 0
  const pending = new Map()
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data))
    const entry = pending.get(message.id)
    if (!entry) return
    pending.delete(message.id)
    clearTimeout(entry.timer)
    if (message.error) entry.fail(new Error(JSON.stringify(message.error)))
    else entry.ok(message.result)
  })
  const call = (method, params = {}) => new Promise((ok, fail) => {
    const id = ++sequence
    const timer = setTimeout(() => { pending.delete(id); fail(new Error(`${method} timeout`)) }, timeout)
    pending.set(id, { ok, fail, timer })
    socket.send(JSON.stringify({ id, method, params }))
  })
  await call('Runtime.enable')
  await call('Page.enable')
  const evaluate = async (expression) => {
    const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
    return result.result?.value
  }
  return { socket, call, evaluate }
}

async function waitFor(evaluate, expression, timeout) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await evaluate(expression)) return
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`timed out waiting for ${expression}`)
}

const SEND_READY_TIMEOUT = 30_000

async function submitPrompt(evaluate, text, timeout) {
  const deadline = Date.now() + Math.min(timeout, SEND_READY_TIMEOUT)
  let reason = 'composer missing'
  while (Date.now() < deadline) {
    const result = await evaluate(sendExpression(text))
    if (result?.ok === true) return
    reason = result?.reason ?? 'unknown'
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`composer not ready: ${reason}`)
}

async function run(options) {
  const { socket, call, evaluate } = await connect(await pageTarget(options.cdp, options.origin), options.timeout)
  try {
    await waitFor(evaluate, `document.querySelector('.chat-log') !== null`, options.timeout)
    if (options.action === 'new-task') {
      await evaluate(`document.querySelector('button.nav-it[title="新建任务"]')?.click()`)
      await waitFor(evaluate, `document.querySelector('.composer textarea') !== null`, options.timeout)
    } else if (options.action === 'send' || options.action === 'stop') {
      if (options.newTask) {
        await evaluate(`document.querySelector('button.nav-it[title="新建任务"]')?.click()`)
        await waitFor(evaluate, `document.querySelector('.composer textarea') !== null`, options.timeout)
      }
      const baseline = await evaluate(`(() => ({
        users: document.querySelectorAll('.bubble.user').length,
        assistants: document.querySelectorAll('.bubble.assistant').length,
        panels: document.querySelectorAll('.tool-panel').length,
        notes: document.querySelectorAll('.note, .banner').length,
      }))()`)
      await submitPrompt(evaluate, options.prompt, options.timeout)
      await waitFor(evaluate, `document.querySelectorAll('.bubble.user').length > ${baseline.users}`, options.timeout)
      if (options.action === 'stop') {
        await waitFor(evaluate, `document.querySelector('.send.stop') !== null`, options.timeout)
        await evaluate(`document.querySelector('.send.stop').click()`)
      } else {
        await waitFor(evaluate, `document.querySelector('.send.stop') !== null
          || document.querySelectorAll('.bubble.assistant').length > ${baseline.assistants}
          || document.querySelectorAll('.tool-panel').length > ${baseline.panels}
          || document.querySelectorAll('.note, .banner').length > ${baseline.notes}`, options.timeout)
      }
      await waitFor(evaluate, STOPPED, options.timeout)
    } else if (options.action === 'toggle') {
      await waitFor(evaluate, `document.querySelectorAll('.tool-panel .tool-panel-title').length > ${options.index}`, options.timeout)
      if (!(await evaluate(toggleExpression(options.index)))) throw new Error('panel index not found')
    } else if (options.action === 'open-history') {
      await waitFor(evaluate, `[...document.querySelectorAll('.recent-item')].some((item) => (item.getAttribute('title') ?? '').endsWith('\\n' + ${JSON.stringify(options.sessionId)}))`, options.timeout)
      const expectedTitle = await evaluate(openHistoryExpression(options.sessionId))
      if (typeof expectedTitle !== 'string' || expectedTitle.length === 0) throw new Error('history row not found')
      await waitFor(evaluate, historyReadyExpression(options.sessionId, expectedTitle), options.timeout)
    }
    const facts = await evaluate(FACTS)
    // FACTS 以 `.chat-log` 为根：开历史失败、界面停在只读回退（`.session-detail-title`）时，
    // 就绪判据可满足而这里返回 null；若不拦截，命令会以 facts:null 静默 exit 0。
    if (facts === null) throw new Error('capture failed: no .chat-log (read-only fallback?)')
    const shot = await call('Page.captureScreenshot', { format: 'png' })
    if (options.out !== undefined) {
      await mkdir(dirname(resolve(options.out)), { recursive: true })
      await writeFile(resolve(options.out), Buffer.from(shot.data, 'base64'))
    }
    return { action: options.action, facts, screenshot: options.out ?? null }
  } finally {
    socket.close()
  }
}

const invoked = process.argv[1] === undefined ? undefined : pathToFileURL(resolve(process.argv[1])).href
if (invoked === import.meta.url) {
  try {
    console.log(JSON.stringify(await run(parseArgs(process.argv.slice(2))), null, 2))
  } catch (cause) {
    console.error(JSON.stringify({ status: 'FAIL', message: cause instanceof Error ? cause.message : String(cause) }, null, 2))
    process.exitCode = 1
  }
}
