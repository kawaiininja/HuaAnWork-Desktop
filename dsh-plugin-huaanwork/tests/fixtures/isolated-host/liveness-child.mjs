import { EventEmitter } from 'node:events'
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// The forked process is the Host. Its child is the grandchild the supervisor
// must not leak when it terminates the Host. Keep the default process group
// (detached: false) so the OS parent remains this Host.
const grandchild = spawn(process.execPath, [
  fileURLToPath(new URL('./liveness-grandchild.mjs', import.meta.url)),
], { stdio: 'ignore', windowsHide: true })
if (!grandchild.pid) throw new Error('Host failed to spawn the liveness grandchild')
const pidFile = process.env.B16_GRANDCHILD_PID_FILE
if (pidFile) writeFileSync(pidFile, String(grandchild.pid))

const port = Object.assign(new EventEmitter(), { postMessage: message => process.send(message) })
process.parentPort = port
await import('../../../lib/host-process-entry.js')
process.on('message', data => port.emit('message', { data }))
process.on('disconnect', () => process.exit(0))
process.send({ ready: true, grandchildPid: grandchild.pid })
