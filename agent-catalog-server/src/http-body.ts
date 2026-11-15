/**
 * Shared capped request-body plumbing (Task 5).
 *
 * The agent submission surface and the skill publish surface must enforce the
 * same buffering discipline: stop BUFFERING at the cap, drain the rest so the
 * client can read the 413/400 instead of a reset, and never keep bytes beyond
 * the cap in memory. Keeping the reader here prevents the two surfaces from
 * drifting apart.
 */

import type { IncomingMessage } from 'node:http'

export class BodyTooLargeError extends Error {
  constructor() {
    super('request body exceeded the read cap')
    this.name = 'BodyTooLargeError'
  }
}

/**
 * Read a request body, aborting BUFFERING at `cap`. The connection is then
 * drained rather than destroyed so the client can still read the error
 * response; nothing beyond the cap is kept in memory.
 */
export function readCappedBody(request: IncomingMessage, cap: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    let settled = false

    const cleanup = (): void => {
      request.off('data', onData)
      request.off('end', onEnd)
      request.off('error', onError)
      request.off('aborted', onAborted)
      request.off('close', onClose)
    }
    const onData = (chunk: Buffer): void => {
      if (settled) return
      total += chunk.byteLength
      if (total >= cap) {
        settled = true
        cleanup()
        request.resume()
        reject(new BodyTooLargeError())
        return
      }
      chunks.push(chunk)
    }
    const onEnd = (): void => {
      if (settled) return
      settled = true
      cleanup()
      resolve(Buffer.concat(chunks, total))
    }
    const onError = (cause: Error): void => {
      if (settled) return
      settled = true
      cleanup()
      reject(cause)
    }
    const onAborted = (): void => {
      if (settled) return
      settled = true
      cleanup()
      reject(new Error('request aborted while reading the body'))
    }
    const onClose = (): void => {
      // Node also emits `close` after a successful `end`; `settled` guards that.
      if (settled) return
      settled = true
      cleanup()
      reject(new Error('connection closed while reading the body'))
    }

    request.on('data', onData)
    request.on('end', onEnd)
    request.on('error', onError)
    request.on('aborted', onAborted)
    request.on('close', onClose)
  })
}

/** Discard an unread body so the error response can reach the client. */
export function drain(request: IncomingMessage): void {
  if (!request.readableEnded) request.resume()
}

/** `application/gzip` media type (parameters ignored). */
export function isGzipRequest(request: IncomingMessage): boolean {
  const header = request.headers['content-type']
  if (typeof header !== 'string') return false
  const mediaType = header.split(';')[0]?.trim().toLowerCase() ?? ''
  return mediaType === 'application/gzip'
}

/** Declared `content-length` when it is a plain non-negative integer. */
export function declaredContentLength(request: IncomingMessage): number | null {
  const raw = request.headers['content-length']
  if (typeof raw !== 'string' || !/^\d+$/u.test(raw.trim())) return null
  return Number(raw.trim())
}
