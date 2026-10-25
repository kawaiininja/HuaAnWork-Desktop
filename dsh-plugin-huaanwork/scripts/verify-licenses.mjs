/**
 * Verify every package whose code ships inside the desktop installers carries
 * a permissive license that allows redistribution.
 *
 * Two graphs are walked:
 *
 * - the installed production graph (dependencies + optionalDependencies,
 *   excluding dev/peer) starting from this package manifest;
 * - the bundled runtime closure: modules compiled into `lib/` at build time by
 *   tsdown (see `deps.alwaysBundle` in `tsdown.config.ts`). Their code ships
 *   inside the application even though it never appears in the installer's
 *   `node_modules` tree, so it needs the same license proof. The boundary of
 *   that closure is pinned by `scripts/huaanwork-verify-bundled-runtime.mjs`.
 *
 * Fails when a package has no license field and no LICENSE file, or when its
 * license is not on the redistribution allowlist.
 *
 * @module scripts/verify-licenses
 */

import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const rootManifestPath = join(packageRoot, 'package.json')
const rootManifest = JSON.parse(readFileSync(rootManifestPath, 'utf8'))

/** Licenses accepted for redistribution inside the desktop installers. */
const ALLOWED_LICENSES = new Set([
  'MIT',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'ISC',
  '0BSD',
  'Unlicense',
  'MPL-2.0',
  'CC0-1.0',
  '(MIT OR CC0-1.0)',
  'Zlib',
  'Python-2.0',
  // Blue Oak Model License 1.0.0: permissive, OSI-approved, and the license of
  // `tar` and two of its bundled dependencies. It requires shipping a copy of
  // the license text, which the notices generator reproduces below.
  'BlueOak-1.0.0',
])

/**
 * Licenses that permit redistribution only when their notice obligations are
 * honored. Sharp ships libvips as a separate @img/sharp-libvips-* package on
 * macOS and inside the @img/sharp-win32-* package on Windows. Their license
 * texts ship inside node_modules in the installer. Keep this list minimal and
 * review any addition.
 */
const NOTICE_LICENSES = new Set([
  'LGPL-3.0-or-later',
  'Apache-2.0 AND LGPL-3.0-or-later',
])

/** First-party modules compiled into `lib/`; the repository LICENSE governs them. */
const BUNDLED_FIRST_PARTY_PACKAGES = [
  '@huaanwork/agent-package-format',
  '@huaanwork/catalog-signing',
  '@huaanwork/policy',
]

/**
 * Third-party packages compiled into `lib/` instead of installed in
 * `node_modules`. Each entry names the package whose manifest owns it in the
 * workspace install: Yarn puts `tar` under
 * `packages/agent-package-format/node_modules/tar`, so it must be resolved
 * from that manifest — resolving from this package's root would read the
 * hoisted copy instead of the bytes the bundler compiled in.
 */
const BUNDLED_THIRD_PARTY_PACKAGES = [
  { name: 'tar', owner: '@huaanwork/agent-package-format' },
]

/**
 * Every package compiled into `lib/` by tsdown. Their code ships inside the
 * installers, so it belongs to this verification even though it is absent
 * from the installed production graph.
 */
const BUNDLED_PACKAGES = [
  ...BUNDLED_FIRST_PARTY_PACKAGES,
  ...BUNDLED_THIRD_PARTY_PACKAGES.map(entry => entry.name),
]

/**
 * @typedef {{
 *   name: string,
 *   manifestPath: string,
 *   bundling: 'installed' | 'bundled',
 *   firstParty: boolean,
 * }} QueueEntry
 */

/**
 * Locate one installed package manifest by walking node_modules directories
 * upward from the parent manifest. Reads the real package.json regardless of
 * the package's `exports` map, which often hides the `./package.json` subpath.
 */
function resolvePackageManifest(name, fromManifestPath) {
  const segments = name.split('/')
  const folder = name.startsWith('@') ? segments.slice(0, 2).join('/') : segments[0]
  const entry = name.startsWith('@') ? segments.slice(2).join('/') : segments.slice(1).join('/')
  let dir = dirname(fromManifestPath)
  for (;;) {
    const candidate = join(dir, 'node_modules', folder, entry, 'package.json')
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

/** Follow workspace symlinks so nested lookups start in the real package. */
function realManifestPath(path) {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

/** Normalize the license field of one package manifest. */
function licenseExpression(manifest) {
  const value = manifest.license
  if (typeof value === 'string') return value
  if (typeof value === 'object' && value !== null && typeof value.type === 'string') return value.type
  if (Array.isArray(manifest.licenses)) {
    return manifest.licenses
      .map((item) => (typeof item === 'string' ? item : item.type))
      .filter(Boolean)
      .join(' OR ')
  }
  return undefined
}

/** Locate the license text shipped inside one installed package. */
function licenseTextPath(packageDirectory) {
  for (const file of ['LICENSE', 'LICENSE.md', 'LICENSE.txt']) {
    const candidate = join(packageDirectory, file)
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

const failures = []
const seen = new Set()
const manifests = []

const rootLicense = licenseExpression(rootManifest)
if (rootLicense === undefined || !ALLOWED_LICENSES.has(rootLicense)) {
  failures.push(`repository package.json: license ${JSON.stringify(rootLicense)} is not on the redistribution allowlist`)
}

/**
 * Verify one queue entry and append its production dependencies.
 * @param {QueueEntry} current - entry to verify.
 * @param {QueueEntry[]} queue - queue the dependencies are appended to.
 */
function visit(current, queue) {
  if (seen.has(current.name)) return
  seen.add(current.name)
  const manifest = JSON.parse(readFileSync(current.manifestPath, 'utf8'))

  if (current.name !== rootManifest.name) {
    const declared = licenseExpression(manifest)
    let license = declared
    if (current.firstParty) {
      // First-party workspace modules are covered by the repository LICENSE;
      // a conflicting declaration would need its own license text shipped.
      if (declared !== undefined && declared !== rootLicense) {
        failures.push(`${current.name}: declares ${JSON.stringify(declared)} but the repository license is ${JSON.stringify(rootLicense)}`)
      }
      license = rootLicense
    } else {
      const hasLicenseFile = licenseTextPath(dirname(current.manifestPath)) !== undefined
      if (license === undefined && !hasLicenseFile) {
        failures.push(`${current.name}: no license field and no LICENSE file`)
      } else if (license !== undefined && license.startsWith('SEE LICENSE IN ')) {
        if (!hasLicenseFile) {
          failures.push(`${current.name}: license refers to ${JSON.stringify(license)} but no LICENSE file is shipped`)
        }
      } else if (license !== undefined && !ALLOWED_LICENSES.has(license) && !NOTICE_LICENSES.has(license)) {
        failures.push(`${current.name}: license ${JSON.stringify(license)} is not on the redistribution allowlist`)
      }
    }
    manifests.push({
      name: current.name,
      version: manifest.version,
      license: license ?? 'SEE LICENSE FILE',
      bundling: current.bundling,
      firstParty: current.firstParty,
      manifestPath: current.manifestPath,
    })
  }

  for (const section of ['dependencies', 'optionalDependencies']) {
    for (const name of Object.keys(manifest[section] ?? {})) {
      const resolved = resolvePackageManifest(name, current.manifestPath)
      if (resolved === undefined) {
        // Optional dependencies may legitimately be absent on this platform.
        if (section === 'optionalDependencies') continue
        failures.push(`${current.name} -> ${name}: could not locate its manifest`)
        continue
      }
      queue.push({
        name,
        manifestPath: resolved,
        bundling: current.bundling,
        // Dependencies of a bundled module are compiled in too; workspace
        // packages among them stay first-party.
        firstParty: current.bundling === 'bundled' && name.startsWith('@huaanwork/'),
      })
    }
  }
}

const installedQueue = [{ name: rootManifest.name ?? 'dsh-plugin-huaanwork', manifestPath: rootManifestPath, bundling: 'installed', firstParty: false }]
for (let index = 0; index < installedQueue.length; index += 1) {
  const current = installedQueue[index]
  if (current === undefined) continue
  visit(current, installedQueue)
}

const bundledQueue = []
for (const name of BUNDLED_FIRST_PARTY_PACKAGES) {
  const manifestPath = resolvePackageManifest(name, rootManifestPath)
  if (manifestPath === undefined) {
    failures.push(`${name}: bundled first-party package manifest is missing`)
    continue
  }
  bundledQueue.push({ name, manifestPath: realManifestPath(manifestPath), bundling: 'bundled', firstParty: true })
}
for (const { name, owner } of BUNDLED_THIRD_PARTY_PACKAGES) {
  const ownerManifestPath = resolvePackageManifest(owner, rootManifestPath)
  if (ownerManifestPath === undefined) {
    failures.push(`${name}: could not locate the manifest of its workspace owner ${owner}`)
    continue
  }
  const manifestPath = resolvePackageManifest(name, realManifestPath(ownerManifestPath))
  if (manifestPath === undefined) {
    failures.push(`${name}: could not locate its manifest inside ${owner}`)
    continue
  }
  bundledQueue.push({ name, manifestPath, bundling: 'bundled', firstParty: false })
}
for (let index = 0; index < bundledQueue.length; index += 1) {
  const current = bundledQueue[index]
  if (current === undefined) continue
  visit(current, bundledQueue)
}

// A bundled package that was never visited would pass silently; the declared
// closure and the traversed one must be the same set.
for (const name of BUNDLED_PACKAGES) {
  if (!seen.has(name)) failures.push(`${name}: declared as bundled but was never verified`)
}

if (failures.length > 0) {
  process.stderr.write(`verify-licenses: ${failures.length} package(s) need attention\n`)
  for (const failure of failures) process.stderr.write(`- ${failure}\n`)
  process.exit(1)
}

const noticeOnly = manifests.filter(entry => NOTICE_LICENSES.has(entry.license))
const noticesArg = process.argv.indexOf('--notices')
if (noticesArg !== -1) {
  const target = process.argv[noticesArg + 1]
  if (target === undefined) {
    process.stderr.write('verify-licenses: --notices requires a file path\n')
    process.exit(1)
  }
  const bundledThirdParty = manifests
    .filter(entry => entry.bundling === 'bundled' && !entry.firstParty)
    .sort((a, b) => a.name.localeCompare(b.name))
  const overview = [
    '# Third-Party Notices',
    '',
    'DSH Desktop distributes the following packages inside its installers.',
    'Packages marked "installed" ship under node_modules with their own license text in the application files.',
    'Packages marked "bundled" are compiled into the application\'s own JavaScript output by the bundler;',
    'their license texts are reproduced verbatim at the end of this file. Bundled @huaanwork/* modules are',
    'first-party code covered by the repository LICENSE.',
    'This list records package names, versions, licenses, and how each package ships.',
    '',
    '| Package | Version | License | Bundling |',
    '| --- | --- | --- | --- |',
    ...manifests
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(entry => `| ${entry.name} | ${entry.version ?? ''} | ${entry.license} | ${entry.bundling} |`),
    '',
    noticeOnly.length === 0
      ? ''
      : `> Notice-required licenses in use: ${[...new Set(noticeOnly.map(entry => entry.license))].join(', ')}. Their license texts ship inside node_modules; see the package LICENSE files for the full terms.`,
  ].filter(line => line !== '')

  // Verbatim license texts keep their own blank lines, so they are appended
  // after the empty-line-free overview instead of being filtered with it.
  const appendix = bundledThirdParty.flatMap((entry) => {
    const textPath = licenseTextPath(dirname(entry.manifestPath))
    const text = textPath === undefined
      ? 'This package does not ship a license file; see the package repository for the full terms.'
      : readFileSync(textPath, 'utf8').trim()
    // Fenced so the license text renders verbatim: its own headings must not
    // collide with the section headings above.
    return [
      `### ${entry.name} ${entry.version ?? ''} (${entry.license})`,
      '',
      '```',
      text,
      '```',
      '',
    ]
  })
  const content = appendix.length === 0
    ? overview.join('\n')
    : `${[...overview, '', ...appendix].join('\n').replace(/\n+$/, '')}`
  writeFileSync(resolve(packageRoot, target), content)
}

const total = seen.size - 1
const bundledCount = manifests.filter(entry => entry.bundling === 'bundled').length
const summary = noticeOnly.length === 0
  ? `verify-licenses: ${total} packages (${bundledCount} bundled) carry redistribution-safe licenses`
  : `verify-licenses: ${total} packages checked (${bundledCount} bundled); ${noticeOnly.length} use notice-required licenses (${[...new Set(noticeOnly.map(entry => entry.license))].join(', ')})`
process.stdout.write(`${summary}\n`)
