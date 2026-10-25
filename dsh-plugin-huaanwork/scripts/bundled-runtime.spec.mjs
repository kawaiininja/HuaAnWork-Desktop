import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  AGENT_PACKAGE_RUNTIME_PACKAGES,
  bundledPackageClosure,
  importSpecifiers,
  packageNameOf,
  verifyBundledRuntime,
} from './verify-bundled-runtime.mjs'

const packageRoot = join(import.meta.dirname, '..')
const markerSources = {
  '@huaanwork/agent-package-format': 'const MAX_AGENT_PACKAGE_BUNDLE_BYTES = 5 * 1024 * 1024;',
  '@huaanwork/catalog-signing': 'function parseCatalogKeyring() {}',
  '@huaanwork/policy': 'function workNetworkGateError() {}',
  tar: 'const code = "TAR_BAD_ARCHIVE";',
}

function withFixture(files, run) {
  const root = mkdtempSync(join(tmpdir(), 'huaanwork-bundled-runtime-'))
  try {
    for (const [path, content] of Object.entries(files)) {
      const target = join(root, path)
      mkdirSync(join(target, '..'), { recursive: true })
      writeFileSync(target, `${content}\n`)
    }
    return run(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function bundledFixture(extraFiles = {}) {
  return {
    'package.json': JSON.stringify({ name: 'fixture', version: '0.0.0' }),
    'lib/bundle.js': Object.values(markerSources).join('\n'),
    ...extraFiles,
  }
}

function verifyFixture(root, manifest = { name: 'fixture' }) {
  return verifyBundledRuntime({
    packageRoot: root,
    libDirectory: join(root, 'lib'),
    manifest,
    bundledPackageNames: [...AGENT_PACKAGE_RUNTIME_PACKAGES, 'tar'],
  })
}

test('reads static imports, re-exports, and dynamic imports', () => {
  assert.deepEqual(
    [...importSpecifiers('import { a } from "tar";\nexport { b } from \'./x.js\';\nconst c = import("node:fs");\n')].sort(),
    ['./x.js', 'node:fs', 'tar'],
  )
})

test('reduces specifiers to package names and skips relative and URL forms', () => {
  assert.equal(packageNameOf('@huaanwork/policy/network'), '@huaanwork/policy')
  assert.equal(packageNameOf('tar/package.json'), 'tar')
  assert.equal(packageNameOf('./local.js'), undefined)
  assert.equal(packageNameOf('node:fs'), undefined)
  assert.equal(packageNameOf('/absolute.js'), undefined)
})

test('accepts a bundle that inlines every agent-package runtime package', () => {
  withFixture(bundledFixture(), (root) => {
    const result = verifyFixture(root)
    assert.deepEqual(result.failures, [])
    assert.equal(result.mode, 'bundled')
  })
})

test('rejects an external import of a shared runtime package', () => {
  withFixture(bundledFixture({
    'lib/routes.js': 'import { capToolOutput } from "@huaanwork/policy/truncate";',
  }), (root) => {
    const result = verifyFixture(root)
    assert.equal(result.failures.length, 1)
    assert.match(result.failures[0], /lib\/routes\.js imports "@huaanwork\/policy\/truncate" at runtime/)
  })
})

test('rejects an external import of tar when tar is not a production dependency', () => {
  withFixture(bundledFixture({ 'lib/bundle.js': Object.values(markerSources).join('\n') + '\nimport "tar";' }), (root) => {
    const result = verifyFixture(root)
    assert.equal(result.mode, 'external')
    assert.deepEqual(result.failures, ['tar is imported at runtime but missing from dependencies'])
  })
})

test('accepts an external tar that is a declared, resolvable dependency', () => {
  const manifest = { name: 'fixture', dependencies: { tar: '7.5.22' } }
  withFixture(bundledFixture({
    'package.json': JSON.stringify(manifest),
    'lib/bundle.js': `${Object.values(markerSources).join('\n')}\nimport { c } from "tar";`,
    'node_modules/tar/package.json': JSON.stringify({ name: 'tar', version: '7.5.22', main: 'index.js' }),
    'node_modules/tar/index.js': 'export const c = 1',
  }), (root) => {
    const result = verifyFixture(root, manifest)
    assert.deepEqual(result.failures, [])
    assert.equal(result.mode, 'external')
  })
})

test('rejects a state where tar is neither imported nor bundled', () => {
  const sources = { ...markerSources }
  delete sources.tar
  withFixture(bundledFixture({ 'lib/bundle.js': Object.values(sources).join('\n') }), (root) => {
    const result = verifyFixture(root)
    assert.equal(result.mode, 'bundled')
    assert.deepEqual(result.failures, [
      'tar is neither imported nor compiled into lib: marker "TAR_BAD_ARCHIVE" is absent',
    ])
  })
})

test('reports a missing lib directory instead of passing vacuously', () => {
  withFixture({ 'package.json': JSON.stringify({ name: 'fixture' }) }, (root) => {
    const result = verifyFixture(root)
    assert.equal(result.mode, 'missing')
    assert.equal(result.failures.length, 1)
    assert.match(result.failures[0], /does not exist; build the package before verifying/)
  })
})

test('resolves the bundled closure from the agent-package-format manifest', () => {
  const closure = bundledPackageClosure(packageRoot)
  assert.deepEqual(closure.failures, [])
  for (const name of [...AGENT_PACKAGE_RUNTIME_PACKAGES, 'tar', 'minipass', 'minizlib', 'chownr', 'yallist', '@isaacs/fs-minipass']) {
    assert.ok(closure.names.includes(name), `${name} is missing from the bundled closure`)
  }
})

test('the built lib bundles the agent-package runtime instead of importing it', () => {
  const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
  const closure = bundledPackageClosure(packageRoot)
  const result = verifyBundledRuntime({
    packageRoot,
    libDirectory: join(packageRoot, 'lib'),
    manifest,
    bundledPackageNames: closure.names,
  })
  assert.deepEqual(result.failures, [])
  assert.equal(result.mode, 'bundled')
  assert.ok(result.fileCount > 0)
})

test('the license graph and notices cover the bundled runtime closure', () => {
  const root = mkdtempSync(join(tmpdir(), 'huaanwork-notices-'))
  try {
    const noticesPath = join(root, 'THIRD_PARTY_NOTICES.md')
    const result = spawnSync(process.execPath, ['scripts/verify-licenses.mjs', '--notices', noticesPath], {
      cwd: packageRoot,
      encoding: 'utf8',
    })
    assert.equal(result.status, 0, result.stderr)
    const notices = readFileSync(noticesPath, 'utf8')
    for (const name of [...AGENT_PACKAGE_RUNTIME_PACKAGES, 'tar', 'minipass', 'minizlib', 'chownr', 'yallist', '@isaacs/fs-minipass']) {
      assert.ok(notices.includes(`| ${name} |`), `${name} is missing from THIRD_PARTY_NOTICES.md`)
    }
    assert.match(notices, /\| tar \| 7\.5\.22 \| BlueOak-1\.0\.0 \| bundled \|/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
