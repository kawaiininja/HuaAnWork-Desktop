/**
 * Verify that the agent-package runtime is compiled into `lib/` instead of
 * being resolved at runtime.
 *
 * The three `@huaanwork/*` modules export raw TypeScript, so they can never be
 * runtime externals of the published JavaScript: every emitted file must carry
 * their code inline. `tar` is allowed to ship either way, but never both and
 * never neither:
 *
 * - bundled: its code must be present in `lib/` and nothing may import it;
 * - external: it must be a production dependency that resolves from this
 *   package (the license graph then covers it as an installed package).
 *
 * @module scripts/huaanwork-verify-bundled-runtime
 */

import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** First-party runtime modules that must be compiled into `lib/`. */
export const AGENT_PACKAGE_RUNTIME_PACKAGES = Object.freeze([
  '@huaanwork/agent-package-format',
  '@huaanwork/catalog-signing',
  '@huaanwork/policy',
])

/**
 * Identifiers each bundled package leaves in the emitted JavaScript. They are
 * exported or module-level names the bundler keeps verbatim, so an absent
 * marker means the package silently stopped being compiled in.
 */
export const BUNDLED_MARKERS = Object.freeze({
  '@huaanwork/agent-package-format': 'MAX_AGENT_PACKAGE_BUNDLE_BYTES',
  '@huaanwork/catalog-signing': 'parseCatalogKeyring',
  '@huaanwork/policy': 'workNetworkGateError',
  tar: 'TAR_BAD_ARCHIVE',
})

/** Package allowed to ship bundled or external, never in neither state. */
export const BUNDLE_OR_EXTERNAL_PACKAGE = 'tar'

/**
 * Package whose manifest owns `tar` in the workspace install:
 * Yarn places it under `packages/agent-package-format/node_modules/tar`, so
 * resolving it from this package's root would read the hoisted copy instead.
 */
const TAR_MANIFEST_OWNER = '@huaanwork/agent-package-format'

/** Directory, relative to the package root, that holds the emitted JavaScript. */
const LIB_DIRECTORY = 'lib'

/** Matches static imports/re-exports plus dynamic imports and requires. */
const IMPORT_SPECIFIER_RE = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)['"]([^'"\n]+)['"]/g

/**
 * List every JavaScript file under a directory, sorted for stable output.
 * Source maps (`*.js.map`) are skipped: they repeat the source imports.
 * @param {string} directory - directory to walk.
 * @returns {string[]} absolute file paths.
 */
export function listJavaScriptFiles(directory) {
  const files = []
  const pending = [directory]
  while (pending.length > 0) {
    const current = pending.pop()
    if (current === undefined) continue
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) pending.push(path)
      else if (entry.isFile() && entry.name.endsWith('.js')) files.push(path)
    }
  }
  return files.sort()
}

/**
 * Extract every module specifier an emitted file could resolve at runtime.
 * @param {string} text - emitted JavaScript.
 * @returns {Set<string>} raw specifiers.
 */
export function importSpecifiers(text) {
  const specifiers = new Set()
  for (const match of text.matchAll(IMPORT_SPECIFIER_RE)) {
    const specifier = match[1]
    if (specifier !== undefined) specifiers.add(specifier)
  }
  return specifiers
}

/**
 * Reduce a specifier to its package name, or `undefined` when it is relative,
 * absolute, or a URL (`node:`, `data:`).
 * @param {string} specifier - module specifier.
 * @returns {string | undefined} package name.
 */
export function packageNameOf(specifier) {
  if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.includes(':')) return undefined
  const segments = specifier.split('/')
  return specifier.startsWith('@') ? segments.slice(0, 2).join('/') : segments[0]
}

/**
 * Locate one installed package manifest by walking node_modules directories
 * upward from the owning manifest.
 * @param {string} name - package name.
 * @param {string} fromManifestPath - manifest whose dependency edge owns it.
 * @returns {string | undefined} manifest path.
 */
function locateManifest(name, fromManifestPath) {
  const segments = name.split('/')
  const folder = name.startsWith('@') ? segments.slice(0, 2).join('/') : segments[0]
  const entry = name.startsWith('@') ? segments.slice(2).join('/') : segments.slice(1).join('/')
  let directory = dirname(fromManifestPath)
  for (;;) {
    const candidate = join(directory, 'node_modules', folder, entry, 'package.json')
    if (existsSync(candidate)) return candidate
    const parent = dirname(directory)
    if (parent === directory) return undefined
    directory = parent
  }
}

/** Follow workspace symlinks so nested lookups start in the real package. */
function realManifestPath(path) {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

/**
 * Collect every package whose code is compiled into `lib/`: the three
 * first-party runtime modules, `tar`, and the production dependency closure of
 * `tar` (all of it is inlined by the bundler).
 * @param {string} packageRoot - absolute package root.
 * @returns {{ names: string[], failures: string[] }} bundled package names.
 */
export function bundledPackageClosure(packageRoot) {
  const names = new Set(AGENT_PACKAGE_RUNTIME_PACKAGES)
  const failures = []
  const owner = locateManifest(TAR_MANIFEST_OWNER, join(packageRoot, 'package.json'))
  if (owner === undefined) {
    failures.push(`could not locate ${TAR_MANIFEST_OWNER}: the bundled dependency closure is unknown`)
    return { names: [...names].sort(), failures }
  }

  const pending = [realManifestPath(owner)]
  const visited = new Set()
  while (pending.length > 0) {
    const manifestPath = pending.pop()
    if (manifestPath === undefined || visited.has(manifestPath)) continue
    visited.add(manifestPath)
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    for (const section of ['dependencies', 'optionalDependencies']) {
      for (const name of Object.keys(manifest[section] ?? {}).sort()) {
        const located = locateManifest(name, manifestPath)
        if (located === undefined) {
          // Optional dependencies may legitimately be absent on this platform.
          if (section === 'optionalDependencies') continue
          failures.push(`${manifest.name ?? manifestPath} -> ${name}: could not locate the bundled manifest`)
          continue
        }
        names.add(name)
        pending.push(realManifestPath(located))
      }
    }
  }
  return { names: [...names].sort(), failures }
}

/**
 * Check the emitted bundle against the bundling invariant.
 * @param {{
 *   packageRoot: string,
 *   libDirectory: string,
 *   manifest: object,
 *   bundledPackageNames: string[],
 * }} options - package root, `lib/` path, package manifest, and bundled closure.
 * @returns {{ failures: string[], mode: 'bundled' | 'external' | 'missing', fileCount: number }}
 *   failures and the state `tar` was found in.
 */
export function verifyBundledRuntime(options) {
  const { packageRoot, libDirectory, manifest, bundledPackageNames } = options
  const failures = []
  if (!existsSync(libDirectory)) {
    return { failures: [`${libDirectory} does not exist; build the package before verifying`], mode: 'missing', fileCount: 0 }
  }
  const files = listJavaScriptFiles(libDirectory)
  if (files.length === 0) {
    return { failures: [`${libDirectory} contains no JavaScript files; build the package before verifying`], mode: 'missing', fileCount: 0 }
  }

  const contents = new Map()
  const externalImports = []
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    contents.set(file, text)
    for (const specifier of importSpecifiers(text)) {
      const name = packageNameOf(specifier)
      if (name !== undefined) externalImports.push({ file, specifier, name })
    }
  }

  const firstParty = new Set(AGENT_PACKAGE_RUNTIME_PACKAGES)
  for (const { file, specifier, name } of externalImports) {
    if (!firstParty.has(name)) continue
    failures.push(`${relative(packageRoot, file)} imports ${JSON.stringify(specifier)} at runtime; ${name} must be bundled`)
  }

  const importsTar = externalImports.some((entry) => entry.name === BUNDLE_OR_EXTERNAL_PACKAGE)
  const mode = importsTar ? 'external' : 'bundled'
  if (importsTar) {
    if (manifest.dependencies?.[BUNDLE_OR_EXTERNAL_PACKAGE] === undefined) {
      failures.push(`${BUNDLE_OR_EXTERNAL_PACKAGE} is imported at runtime but missing from dependencies`)
    } else {
      const requireFromPackage = createRequire(join(packageRoot, 'package.json'))
      try {
        requireFromPackage.resolve(BUNDLE_OR_EXTERNAL_PACKAGE)
      } catch {
        failures.push(`${BUNDLE_OR_EXTERNAL_PACKAGE} is declared in dependencies but does not resolve from the package root`)
      }
    }
  } else {
    for (const name of bundledPackageNames) {
      if (firstParty.has(name)) continue
      const offenders = externalImports.filter((entry) => entry.name === name)
      for (const { file, specifier } of offenders) {
        failures.push(`${relative(packageRoot, file)} imports ${JSON.stringify(specifier)} at runtime; the bundled closure must be inlined`)
      }
    }
  }

  const texts = [...contents.values()]
  for (const name of AGENT_PACKAGE_RUNTIME_PACKAGES) {
    const marker = BUNDLED_MARKERS[name]
    if (!texts.some((text) => text.includes(marker))) {
      failures.push(`${name} is not compiled into ${LIB_DIRECTORY}: marker ${JSON.stringify(marker)} is absent`)
    }
  }
  if (mode === 'bundled') {
    const marker = BUNDLED_MARKERS[BUNDLE_OR_EXTERNAL_PACKAGE]
    if (!texts.some((text) => text.includes(marker))) {
      failures.push(`${BUNDLE_OR_EXTERNAL_PACKAGE} is neither imported nor compiled into ${LIB_DIRECTORY}: marker ${JSON.stringify(marker)} is absent`)
    }
  }

  return { failures, mode, fileCount: files.length }
}

function main() {
  const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
  const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
  const closure = bundledPackageClosure(packageRoot)
  const result = verifyBundledRuntime({
    packageRoot,
    libDirectory: join(packageRoot, LIB_DIRECTORY),
    manifest,
    bundledPackageNames: closure.names,
  })
  const failures = [...closure.failures, ...result.failures]
  if (failures.length > 0) {
    process.stderr.write(`verify-bundled-runtime: ${failures.length} bundling invariant(s) failed\n`)
    for (const failure of failures) process.stderr.write(`- ${failure}\n`)
    process.exit(1)
  }
  const state = result.mode === 'bundled'
    ? `${BUNDLE_OR_EXTERNAL_PACKAGE} is compiled into ${LIB_DIRECTORY}`
    : `${BUNDLE_OR_EXTERNAL_PACKAGE} is a resolvable production dependency`
  process.stdout.write(`verify-bundled-runtime: ${result.fileCount} files checked; ${closure.names.length} bundled packages are inlined; ${state}\n`)
}

const invokedPath = process.argv[1]
if (invokedPath !== undefined && fileURLToPath(import.meta.url) === resolve(invokedPath)) {
  main()
}
