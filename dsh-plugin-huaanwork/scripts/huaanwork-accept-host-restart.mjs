import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const STALE_TEXT = '状态不可恢复 · Host 已重启，结果未确认'
const TERMINAL_PHASES = new Set(['completed', 'failed', 'stopped'])

/** Fail closed on every observable that distinguishes Host replacement from app/renderer replacement. */
export function assertHostRestartEvidence(evidence) {
  if (!Number.isInteger(evidence.restart.oldPid) || !Number.isInteger(evidence.restart.newPid)
    || evidence.restart.oldPid === evidence.restart.newPid) {
    throw new Error('Host pid did not change')
  }
  if (evidence.before.canary !== evidence.after.canary
    || evidence.before.timeOrigin !== evidence.after.timeOrigin
    || evidence.before.origin !== evidence.after.origin) {
    throw new Error('renderer document was replaced')
  }
  if (evidence.mainRunCountBefore !== evidence.mainRunCountAfter) {
    throw new Error('main process restarted during Host acceptance')
  }
  if (evidence.staleCards.length === 0) throw new Error('no stale subagent run card appeared')
  if (evidence.staleCards.length !== evidence.staleCardsLater.length) {
    throw new Error('stale card count changed while checking frozen elapsed time')
  }
  for (const [index, card] of evidence.staleCards.entries()) {
    if (!card.text.includes(STALE_TEXT)) throw new Error('stale recovery copy is missing')
    if (card.terminateDisabled !== true) throw new Error('stale terminate control is enabled')
    if (TERMINAL_PHASES.has(card.phase)) throw new Error(`stale card guessed terminal phase ${card.phase}`)
    if (card.elapsed !== evidence.staleCardsLater[index].elapsed) {
      throw new Error('stale card elapsed time advanced')
    }
  }
  return true
}

function parseArguments(argv) {
  const options = { cdp: '9333', origin: 'http://127.0.0.1:43120', timeoutMs: 60_000, mainLog: undefined }
  for (const argument of argv) {
    if (argument.startsWith('--cdp=')) options.cdp = argument.slice('--cdp='.length)
    else if (argument.startsWith('--origin=')) options.origin = argument.slice('--origin='.length)
    else if (argument.startsWith('--timeout=')) options.timeoutMs = Number(argument.slice('--timeout='.length))
    else if (argument.startsWith('--main-log=')) options.mainLog = argument.slice('--main-log='.length)
    else throw new Error(`unknown argument: ${argument}`)
  }
  if (!/^\d+$/.test(options.cdp)) throw new Error('--cdp must be a numeric port')
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1) throw new Error('--timeout must be a positive integer')
  return options
}

async function mainRunCount(path) {
  if (path === undefined) return undefined
  const contents = await readFile(path, 'utf8')
  return (contents.match(/^--- .* run \d+ ---$/gm) ?? []).length
}

async function pageTarget(cdpPort, origin) {
  const response = await fetch(`http://127.0.0.1:${cdpPort}/json/list`)
  if (!response.ok) throw new Error(`CDP target list returned HTTP ${response.status}`)
  const targets = await response.json()
  const pages = targets.filter(target => target.type === 'page'
    && typeof target.url === 'string' && target.url.startsWith(origin)
    && typeof target.webSocketDebuggerUrl === 'string')
  if (pages.length !== 1) throw new Error(`expected exactly one ${origin} page target, found ${pages.length}`)
  return pages[0]
}

async function connect(target, timeoutMs) {
  const socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolveOpen, rejectOpen) => {
    socket.addEventListener('open', resolveOpen, { once: true })
    socket.addEventListener('error', () => rejectOpen(new Error('CDP WebSocket failed')), { once: true })
  })
  let sequence = 0
  const pending = new Map()
  const rejectPending = cause => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(cause)
    }
    pending.clear()
  }
  socket.addEventListener('close', () => { rejectPending(new Error('CDP target closed')) })
  socket.addEventListener('error', () => { rejectPending(new Error('CDP WebSocket failed')) })
  socket.addEventListener('message', event => {
    const message = JSON.parse(String(event.data))
    if (!message.id) return
    const entry = pending.get(message.id)
    if (!entry) return
    pending.delete(message.id)
    clearTimeout(entry.timer)
    if (message.error) entry.reject(new Error(JSON.stringify(message.error)))
    else entry.resolve(message.result)
  })
  const call = (method, params = {}) => new Promise((resolveCall, rejectCall) => {
    const id = ++sequence
    const timer = setTimeout(() => {
      pending.delete(id)
      rejectCall(new Error(`${method} timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    pending.set(id, { resolve: resolveCall, reject: rejectCall, timer })
    socket.send(JSON.stringify({ id, method, params }))
  })
  const evaluate = async expression => {
    const response = await call('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true, userGesture: true,
    })
    if (response.exceptionDetails) {
      throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text)
    }
    return response.result?.value
  }
  await call('Runtime.enable')
  await call('Page.enable')
  return { socket, evaluate }
}

const BEFORE_EXPRESSION = `(() => {
  const canary = crypto.randomUUID()
  window.__huaanworkHostRestartCanary = canary
  return { canary, timeOrigin: performance.timeOrigin, origin: location.origin }
})()`
const AFTER_EXPRESSION = `(() => ({
  canary: window.__huaanworkHostRestartCanary,
  timeOrigin: performance.timeOrigin,
  origin: location.origin,
}))()`
const STALE_EXPRESSION = `([...document.querySelectorAll('.subagent-run-card[data-stale="true"]')].map(card => ({
  text: card.textContent ?? '',
  terminateDisabled: card.querySelector('.subagent-run-terminate')?.disabled ?? null,
  elapsed: card.querySelector('.subagent-run-status .subagent-run-meta')?.textContent ?? null,
  phase: card.getAttribute('data-phase'),
})))`

async function run(options) {
  const target = await pageTarget(options.cdp, options.origin)
  const { socket, evaluate } = await connect(target, options.timeoutMs)
  try {
    const before = await evaluate(BEFORE_EXPRESSION)
    const mainRunCountBefore = await mainRunCount(options.mainLog)
    const restart = await evaluate('window.huaanworkAcceptance.restartHost()')
    const after = await evaluate(AFTER_EXPRESSION)
    const deadline = Date.now() + options.timeoutMs
    let staleCards = await evaluate(STALE_EXPRESSION)
    while (staleCards.length === 0 && Date.now() < deadline) {
      await new Promise(resolveWait => { setTimeout(resolveWait, 250) })
      staleCards = await evaluate(STALE_EXPRESSION)
    }
    if (staleCards.length === 0) throw new Error('timed out waiting for a real stale subagent run card')
    const mainRunCountAfter = await mainRunCount(options.mainLog)
    await new Promise(resolveWait => { setTimeout(resolveWait, 1_250) })
    const staleCardsLater = await evaluate(STALE_EXPRESSION)
    const evidence = { before, restart, after, mainRunCountBefore, mainRunCountAfter, staleCards, staleCardsLater }
    assertHostRestartEvidence(evidence)
    return {
      status: 'PASS', oldPid: restart.oldPid, newPid: restart.newPid,
      sameDocument: true, sameMainRun: mainRunCountBefore === undefined ? null : mainRunCountBefore === mainRunCountAfter,
      staleCardCount: staleCards.length,
    }
  } finally {
    socket.close()
  }
}

const invokedPath = process.argv[1] === undefined ? undefined : pathToFileURL(resolve(process.argv[1])).href
if (invokedPath === import.meta.url) {
  try {
    const result = await run(parseArguments(process.argv.slice(2)))
    console.log(JSON.stringify(result, null, 2))
  } catch (cause) {
    console.error(JSON.stringify({
      status: 'FAIL', message: cause instanceof Error ? cause.message : String(cause),
      usage: 'node dsh-plugin-huaanwork/scripts/huaanwork-accept-host-restart.mjs [--cdp=9333] [--origin=http://127.0.0.1:43120] [--timeout=60000] [--main-log=/path/dsh.log]',
    }, null, 2))
    process.exitCode = 1
  }
}
