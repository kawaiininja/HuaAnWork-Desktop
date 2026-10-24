import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  decideWindowsAcceptance,
  evaluateSandboxFacts,
  findResidualProcesses,
  parseCimProcessList,
} from './huaanwork-agent-package-windows-acceptance-verdict.mjs'

const passingFacts = {
  platform: 'win32',
  enforcement: 'partial',
  httpReady: true,
  writeDenied: true,
  readOutside: true,
  networkOutside: true,
}

const passingPhases = [
  { name: 'httpAfterIdle', started: true, stopped: true, residuals: [] },
  { name: 'mcpAfterIdle', started: true, stopped: true, residuals: [] },
  { name: 'hostExit', started: true, stopped: true, residuals: [] },
]

test('accepts the Windows sandbox facts Step 5 requires', () => {
  assert.deepEqual(evaluateSandboxFacts(passingFacts), { pass: true, failures: [] })
})

test('rejects a finished probe whose enforcement is not partial', () => {
  const evaluated = evaluateSandboxFacts({ ...passingFacts, enforcement: 'full' })
  assert.equal(evaluated.pass, false)
  assert.deepEqual(evaluated.failures, ['enforcement:full'])
})

test('rejects a missing read or network observation', () => {
  const evaluated = evaluateSandboxFacts({ ...passingFacts, readOutside: false, networkOutside: false })
  assert.equal(evaluated.pass, false)
  assert.deepEqual(evaluated.failures, ['readOutside:false', 'networkOutside:false'])
})

test('treats unreadable sandbox facts as a failure of the fact check', () => {
  assert.deepEqual(evaluateSandboxFacts(null), { pass: false, failures: ['sandbox-facts-missing'] })
})

test('parses a CIM JSON array and a single-object payload', () => {
  assert.deepEqual(parseCimProcessList(JSON.stringify([
    { ProcessId: 4, Name: 'System', CommandLine: null },
    { ProcessId: 80, Name: 'node.exe', CommandLine: 'node C:\\p\\agents\\weekly-report\\tools\\http\\server.mjs' },
  ])), [
    { processId: 4, name: 'System', commandLine: null },
    { processId: 80, name: 'node.exe', commandLine: 'node C:\\p\\agents\\weekly-report\\tools\\http\\server.mjs' },
  ])
  assert.deepEqual(parseCimProcessList('{"ProcessId":9,"Name":"node.exe","CommandLine":"node agents/weekly-report/tools/mcp/server.mjs"}'), [
    { processId: 9, name: 'node.exe', commandLine: 'node agents/weekly-report/tools/mcp/server.mjs' },
  ])
  assert.deepEqual(parseCimProcessList('null'), [])
  assert.deepEqual(parseCimProcessList(''), [])
})

test('matches only the package directory in a Win32 command line', () => {
  const processes = parseCimProcessList(JSON.stringify([
    { ProcessId: 1, Name: 'node.exe', CommandLine: 'node C:\\data\\agents\\weekly-report\\tools\\http\\server.mjs' },
    { ProcessId: 2, Name: 'node.exe', CommandLine: 'node C:\\data\\agents/weekly-report/tools/mcp/server.mjs' },
    { ProcessId: 3, Name: 'node.exe', CommandLine: 'node C:\\data\\agents\\weekly-report-v2\\tools\\http\\server.mjs' },
    { ProcessId: 4, Name: 'node.exe', CommandLine: null },
    { ProcessId: 5, Name: 'node.exe', CommandLine: 'node dsh-plugin-huaanwork\\scripts\\huaanwork-agent-package-windows-acceptance.mjs' },
  ]))
  assert.deepEqual(findResidualProcesses(processes, 'weekly-report').map((row) => row.processId), [1, 2])
})

test('passes when sandbox facts and every lifecycle phase hold', () => {
  const decision = decideWindowsAcceptance({
    sandboxExitCode: 0,
    sandboxFacts: passingFacts,
    phases: passingPhases,
    forceKillErrors: [],
  })
  assert.equal(decision.exitCode, 0)
  assert.equal(decision.verdict, 'PASS')
  assert.deepEqual(decision.hardFailures, [])
  assert.deepEqual(decision.blockers, [])
})

test('fails closed when a completed sandbox probe contradicts partial enforcement', () => {
  const decision = decideWindowsAcceptance({
    sandboxExitCode: 0,
    sandboxFacts: { ...passingFacts, enforcement: 'full' },
    phases: passingPhases,
    forceKillErrors: [],
  })
  assert.equal(decision.exitCode, 1)
  assert.equal(decision.verdict, 'FAIL')
  assert.deepEqual(decision.hardFailures, ['enforcement:full'])
})

test('keeps an inconclusive sandbox probe blocked instead of calling the facts a product failure', () => {
  const decision = decideWindowsAcceptance({
    sandboxExitCode: 3,
    sandboxFacts: { ...passingFacts, httpReady: false, networkOutside: false },
    phases: passingPhases,
    forceKillErrors: [],
  })
  assert.equal(decision.exitCode, 3)
  assert.equal(decision.verdict, 'BLOCKED')
  assert.deepEqual(decision.hardFailures, [])
  assert.deepEqual(decision.blockers, ['sandbox-probe-blocked'])
})

test('fails when HTTP or MCP is still alive after idle cleanup', () => {
  const decision = decideWindowsAcceptance({
    sandboxExitCode: 0,
    sandboxFacts: passingFacts,
    phases: [
      { name: 'httpAfterIdle', started: true, stopped: false, residuals: [] },
      { name: 'mcpAfterIdle', started: true, stopped: true, residuals: [{ processId: 9 }] },
      passingPhases[2],
    ],
    forceKillErrors: [],
  })
  assert.equal(decision.exitCode, 1)
  assert.deepEqual(decision.hardFailures, ['httpAfterIdle:not-stopped', 'mcpAfterIdle:residuals:1'])
})

test('fails when a normal host exit leaves an agents package process', () => {
  const decision = decideWindowsAcceptance({
    sandboxExitCode: 0,
    sandboxFacts: passingFacts,
    phases: [
      passingPhases[0],
      passingPhases[1],
      { name: 'hostExit', started: true, stopped: true, residuals: [{ processId: 44 }, { processId: 45 }] },
    ],
    forceKillErrors: ['taskkill 44 exited 1'],
  })
  assert.equal(decision.exitCode, 1)
  assert.deepEqual(decision.hardFailures, ['hostExit:residuals:2'])
  assert.deepEqual(decision.forceKillIgnored, ['taskkill 44 exited 1'])
})

test('does not let a force-kill observation change a clean result', () => {
  const decision = decideWindowsAcceptance({
    sandboxExitCode: 0,
    sandboxFacts: passingFacts,
    phases: passingPhases,
    forceKillErrors: ['taskkill was not required and this note is ignored'],
  })
  assert.equal(decision.exitCode, 0)
  assert.equal(decision.verdict, 'PASS')
  assert.deepEqual(decision.forceKillIgnored, ['taskkill was not required and this note is ignored'])
})

test('blocks a phase that never started without hiding a later hard failure', () => {
  const blocked = decideWindowsAcceptance({
    sandboxExitCode: 0,
    sandboxFacts: passingFacts,
    phases: [
      passingPhases[0],
      { name: 'mcpAfterIdle', started: false, stopped: false, residuals: [], error: 'fixture handshake failed' },
      passingPhases[2],
    ],
    forceKillErrors: [],
  })
  assert.equal(blocked.exitCode, 3)
  assert.deepEqual(blocked.blockers, ['mcpAfterIdle:fixture handshake failed'])

  const failed = decideWindowsAcceptance({
    sandboxExitCode: 0,
    sandboxFacts: passingFacts,
    phases: [
      { name: 'httpAfterIdle', started: true, stopped: false, residuals: [] },
      { name: 'mcpAfterIdle', started: false, stopped: false, residuals: [], error: 'fixture handshake failed' },
      passingPhases[2],
    ],
    forceKillErrors: [],
  })
  assert.equal(failed.exitCode, 1)
  assert.deepEqual(failed.hardFailures, ['httpAfterIdle:not-stopped'])
  assert.deepEqual(failed.blockers, ['mcpAfterIdle:fixture handshake failed'])
})

test('maps a sandbox usage error to exit 2 before lifecycle results', () => {
  const decision = decideWindowsAcceptance({
    sandboxExitCode: 2,
    sandboxFacts: null,
    phases: [],
    forceKillErrors: ['ignored'],
  })
  assert.equal(decision.exitCode, 2)
  assert.equal(decision.verdict, 'USAGE')
})

const entry = fileURLToPath(new URL('./huaanwork-agent-package-windows-acceptance.mjs', import.meta.url))

function runEntry(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`acceptance entry timed out\n${stdout}\n${stderr}`))
    }, 10_000)
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
  })
}

test('the acceptance entry rejects a non-win32 platform before starting a probe', async () => {
  const result = await runEntry(['--platform', 'darwin'])
  assert.equal(result.code, 2)
  assert.match(result.stderr, /win32/u)
  assert.equal(result.stdout.trim(), '')
})

test('the acceptance entry refuses to record a linux or macOS process as win32', async () => {
  if (process.platform === 'win32') return
  const result = await runEntry(['--platform', 'win32'])
  assert.equal(result.code, 2)
  assert.match(result.stderr, /real win32/u)
  assert.equal(result.stdout.trim(), '')
})
