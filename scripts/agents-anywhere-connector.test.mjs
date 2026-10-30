import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { access, cp, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, sep, dirname } from 'node:path'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import { promisify, stripVTControlCharacters } from 'node:util'
import { runInNewContext } from 'node:vm'
import { AA_WORKSPACES } from './agents-anywhere-release-policy.mjs'

// Exercise the installed artifact: Desktop relies on these upstream behaviors,
// so a silent upstream regression must fail here before a release ships.
// Upstream dropped the `//#region` bundle markers; regions now start at
// `// src/<path>` comment lines and run to the next one.
function loadConnector(workspace, environment) {
  const source = readFileSync(new URL(`../${workspace}/node_modules/@agents-anywhere/dsh-bridge-next/lib/index.js`, import.meta.url), 'utf8')
  const start = source.indexOf('// src/host/connector/logs.ts')
  const end = source.indexOf('// src/host/desktop/detect.ts', start)
  assert.ok(start >= 0 && end > start)
  // environment.ts owns the PyPI index rule the spawned uv process inherits.
  // Evaluate only those declarations: the rest of that region needs Host-only
  // globals (createRequire, userInfo) this sandbox deliberately omits.
  const indexStart = source.indexOf('const PYPI_SIMPLE =')
  const indexEnd = source.indexOf('async function resolveUv(', indexStart)
  assert.ok(indexStart >= 0 && indexEnd > indexStart)
  return runInNewContext(`${source.slice(indexStart, indexEnd)}${source.slice(start, end)}; ({ SourceConnector, ConnectorLogs })`, {
    execFile, promisify, stripVTControlCharacters, join, relative, dirname, createHash, setTimeout, clearTimeout,
    access, cp, mkdtemp, readFile, readdir, rename, rm,
    process: { platform: process.platform, env: environment },
    readJson$1: async () => [], writeJson: async () => {}, mkdir,
    resolveUv: async () => 'uv',
    DEFAULT_CONNECTOR_SETTINGS: { syncIntervalSeconds: 30 },
    setTimeout$1: async () => {},
    performance,
  })
}

for (const workspace of AA_WORKSPACES) {
  test(`${workspace}: rc.2 tool results retain the same hash after JSON transport`, () => {
    const source = readFileSync(new URL(`../${workspace}/node_modules/@agents-anywhere/dsh-bridge-next/lib/index.js`, import.meta.url), 'utf8')
    const region = name => {
      const start = source.indexOf(`// src/host/dsh-runtime/${name}.ts`)
      const end = source.indexOf('// src/', start + 1)
      assert.ok(start >= 0 && end > start)
      return source.slice(start, end)
    }
    const { createProjection, contentHash } = runInNewContext(
      // types carries the JSON helpers history applies before hashing, including lone-surrogate normalization.
      ['types', 'identity', 'tools', 'history'].map(region).join('\n') + ';({ createProjection, contentHash })',
      { createHash, Buffer },
    )
    const projection = createProjection('native-session', 'platform-session')
    projection.apply({ type: 'tool/result', seq: 0, time: '2026-09-24T00:00:00Z',
      data: { message: { role: 'tool', toolCallId: 'call-1', content: [] }, meta: {} } })
    const item = JSON.parse(JSON.stringify(projection.snapshot()[0]))
    // Python json.dumps(..., sort_keys=True, separators=(',', ':')) for this payload.
    const canonical = '{"content":{"callId":"call-1","dshResultMeta":{},"input":{},"isError":false,"kind":"tool_call","output":"","result":[],"title":"tool","toolName":"tool"},"role":"assistant","status":"done","type":"tool"}'
    assert.equal(item.contentHash, `sha256:${createHash('sha256').update(canonical).digest('hex')}`)
    assert.equal(item.content.callId, 'call-1')
    // Optional fields omitted by JSON must not change the hash sent to Python.
    assert.equal(contentHash({ ...item, content: { ...item.content, optional: undefined } }), item.contentHash)
    // A lone surrogate an old plugin sends is normalized before the hash Python recomputes from UTF-8.
    projection.apply({ type: 'tool/result', seq: 1, time: '2026-09-24T00:00:01Z',
      data: { message: { role: 'tool', toolCallId: 'call-2', content: [{ type: 'text', text: 'ok\uD800' }] }, meta: {} } })
    const normalized = JSON.parse(JSON.stringify(projection.snapshot().find(entry => entry.content.callId === 'call-2')))
    assert.equal(normalized.content.output, 'ok�')
    assert.equal(normalized.content.result[0].text, 'ok�')
    assert.equal(normalized.contentHash, contentHash(normalized))
    assert.throws(() => projection.apply({ type: 'tool/result', seq: 2, time: '2026-09-24T00:00:02Z',
      data: { message: { content: [{}] }, meta: {} } }), /Invalid DSH tool result message/)
  })

  test(`${workspace}: Python gets a compatible bypass list and a writable project copy`, async t => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-aa-connector-'))
    t.after(() => rm(root, { recursive: true, force: true }))
    const source = join(root, 'package', 'connector-source')
    const stateRoot = join(root, 'state')
    await mkdir(join(source, 'connector'), { recursive: true })
    await writeFile(join(source, 'pyproject.toml'), '[project]\nname = "fixture"\n')
    await writeFile(join(source, 'connector', 'cli.py'), '# fixture\n')
    const env = {
      NO_PROXY: 'localhost,127.0.0.1,::1,[::1],.example.com',
      no_proxy: 'internal.test, [::1] ',
      HTTPS_PROXY: 'http://127.0.0.1:7890',
      // An inherited index: without it the "UV_INDEX is absent" assertion below
      // would hold even if upstream stopped dropping the key.
      UV_INDEX: 'https://inherit.example/simple',
    }
    const original = { ...env }
    const { SourceConnector } = loadConnector(workspace, env)
    const child = new EventEmitter()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.stdin = new EventEmitter()
    child.exitCode = null
    child.signalCode = null
    let launched, launchedArgs
    const noopLogOutput = { connect() {}, async flush() {} }
    const noopDiagnostics = { log() {} }
    const connector = new SourceConnector(
      { stateRoot, connectorSourceDir: source, uvPath: 'uv' },
      (_command, args, options) => { launched = options; launchedArgs = args; return child },
      // The product always merges stored settings over DEFAULT_CONNECTOR_SETTINGS,
      // so an unset mirror is an empty string rather than a missing key.
      () => ({ syncIntervalSeconds: 30, uvPypiIndexUrl: '' }),
      1000,
      async () => {},
      noopDiagnostics,
      noopLogOutput,
    )
    // The Mesh control plane is upstream's own contract; stub the join so the
    // spawn environment and project mirroring can be observed directly.
    connector.connect = async () => {
      connector.control = {
        getState: async () => ({ running: true, authFailed: false }),
        start: async () => ({ running: true, authFailed: false }),
      }
    }
    connector.watchEvents = () => {}
    await connector.start({ connectorId: 'device', connectorToken: 'private-test-token' }, 'https://example.com', new AbortController().signal)
    assert.equal(connector.running, true)
    assert.equal(launched.env.NO_PROXY, 'localhost,127.0.0.1,::1,::1,.example.com')
    // Upstream rewrites bracketed IPv6 in place and, unlike the retired Desktop
    // patch, does not trim entries.
    assert.equal(launched.env.no_proxy, 'internal.test, ::1 ')
    assert.equal(launched.env.HTTPS_PROXY, env.HTTPS_PROXY)
    // An unset mirror still pins uv and pip to the official index explicitly.
    assert.equal(launched.env.PIP_INDEX_URL, 'https://pypi.org/simple')
    assert.equal(launched.env.UV_DEFAULT_INDEX, 'https://pypi.org/simple')
    assert.equal(launched.env.UV_INDEX_URL, 'https://pypi.org/simple')
    // The fixture inherits UV_INDEX above: the connector must drop it in favour
    // of the explicit keys it writes, and must do so on its own copy.
    assert.ok(
      !('UV_INDEX' in launched.env),
      `connector must drop the inherited UV_INDEX and write only UV_DEFAULT_INDEX/UV_INDEX_URL/PIP_INDEX_URL; got ${String(launched.env.UV_INDEX)}`,
    )
    assert.equal(env.UV_INDEX, 'https://inherit.example/simple')
    assert.deepEqual(env, original)
    assert.ok(launched.cwd.startsWith(join(stateRoot, 'connector-source') + sep))
    assert.equal(launchedArgs[launchedArgs.indexOf('--directory') + 1], launched.cwd)
    assert.equal(await readFile(join(launched.cwd, 'connector', 'cli.py'), 'utf8'), '# fixture\n')
    await writeFile(join(launched.cwd, 'uv.lock'), 'fixture lock\n')
    await assert.rejects(access(join(source, 'uv.lock')), { code: 'ENOENT' })
    await connector.logs.flush()
  })

  test(`${workspace}: connector output reaches logs and credentials stay redacted`, async t => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'dsh-aa-logs-'))
    t.after(() => rm(stateRoot, { recursive: true, force: true }))
    const { ConnectorLogs } = loadConnector(workspace, {})
    const logs = new ConnectorLogs(stateRoot)
    await logs.startSession(['private-test-token'])
    const text = "Invalid port: ':1]' private-test-token\nAuthorization: Bearer abc123 private-test-token\n"
    logs.output(text.slice(0, 20))
    logs.output(text.slice(20))
    logs.finish()
    await logs.flush()
    const lines = Array.from(logs.entries, entry => entry.text)
    assert.deepEqual(lines, [
      "Invalid port: ':1]' [REDACTED]",
      'Authorization: [REDACTED] [REDACTED] [REDACTED]',
    ])
  })
}
