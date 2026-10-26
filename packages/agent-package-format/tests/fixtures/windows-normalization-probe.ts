/**
 * Run in a child process with TESTING_TAR_FAKE_PLATFORM=win32 and the base64
 * tar.gz as argv[2]. The archive is built outside this process so its header
 * keeps a raw `skill\script.mjs` path: tar normalizes `ReadEntry.path` on
 * win32 before `onentry`, and the writer would normalize it too. If the parser
 * validated the normalized path, the bundle would be accepted and this process
 * would exit 1. The fixed implementation rejects the raw header path.
 */
import { Buffer } from 'node:buffer'
import { inspectUnsignedAgentPackageBundle } from '../../src/index.ts'

const encoded = process.argv[2]
if (encoded === undefined) {
  process.stderr.write('MISSING_ARCHIVE\n')
  process.exit(1)
}
const archive = Buffer.from(encoded, 'base64')
try {
  await inspectUnsignedAgentPackageBundle(archive)
  process.stderr.write('ACCEPTED\n')
  process.exit(1)
} catch (error) {
  if (!String((error as Error).message).includes('反斜杠')) {
    process.stderr.write(`WRONG_ERROR: ${String((error as Error).message)}\n`)
    process.exit(1)
  }
  process.stdout.write('REJECTED\n')
  process.exit(0)
}
