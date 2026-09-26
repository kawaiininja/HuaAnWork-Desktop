/**
 * Publish-side gate for market artifacts (Task 2).
 *
 * Dependency-closure ruling (round4 (c), dual-gate fail-closed): M5 market
 * artifacts must be ZERO-DEPENDENCY and carry NO lifecycle install scripts.
 * This module is the server-side (publish-side) half of the dual gate; the
 * wrapper install path repeats the same checks on the downloaded bytes
 * (Task 5). The operator gets the error AT PUBLISH TIME, not the user at
 * install time (user reinforcement ②).
 *
 * Rejections are honest and specific: the offending dependency names /
 * script names are named in the message.
 */

export type PublishRejectionCode = 'invalid-package-identity' | 'nonzero-dependencies' | 'lifecycle-scripts'

export interface PublishRejection {
  readonly code: PublishRejectionCode
  readonly message: string
}

export type PublishGateResult =
  | { readonly ok: true; readonly name: string; readonly version: string }
  | { readonly ok: false; readonly rejection: PublishRejection }

/** npm package-name shape (`@scope/name` or `name`). Intentionally strict. */
const PACKAGE_NAME_PATTERN = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/iu
/** Version must be filename-safe and single-line. */
const PACKAGE_VERSION_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9.+-]{0,127}$/u

/** Lifecycle scripts that must never appear in a market artifact. */
export const FORBIDDEN_LIFECYCLE_SCRIPTS = ['preinstall', 'install', 'postinstall', 'prepare'] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function dependencyNames(value: unknown): string[] {
  if (!isRecord(value)) return []
  return Object.keys(value)
}

function scriptNames(value: unknown): string[] {
  if (!isRecord(value)) return []
  return Object.keys(value).filter(name => typeof value[name] === 'string')
}

/**
 * Check a parsed package.json against the publish gate. `peerDependencies`
 * are exempt (hoisted-linker peers resolve via healed profile fallback) and
 * `bundleDependencies` are allowed (their bytes are inside the signed
 * tarball and covered by its sha256).
 */
export function checkPublishGate(packageManifest: Record<string, unknown>): PublishGateResult {
  const name = packageManifest.name
  const version = packageManifest.version
  if (typeof name !== 'string' || !PACKAGE_NAME_PATTERN.test(name)) {
    return {
      ok: false,
      rejection: {
        code: 'invalid-package-identity',
        message: `package.json "name" must be an npm package name, got ${JSON.stringify(name)}.`,
      },
    }
  }
  if (typeof version !== 'string' || !PACKAGE_VERSION_PATTERN.test(version)) {
    return {
      ok: false,
      rejection: {
        code: 'invalid-package-identity',
        message: `package.json "version" must be a non-empty filename-safe string, got ${JSON.stringify(version)}.`,
      },
    }
  }

  const runtimeDeps = [
    ...dependencyNames(packageManifest.dependencies).map(dep => `dependencies.${dep}`),
    ...dependencyNames(packageManifest.optionalDependencies).map(dep => `optionalDependencies.${dep}`),
  ].sort()
  if (runtimeDeps.length > 0) {
    return {
      ok: false,
      rejection: {
        code: 'nonzero-dependencies',
        message:
          `market artifacts must be zero-dependency (round4 ruling (c)); ` +
          `remove or bundle: ${runtimeDeps.join(', ')}. peerDependencies are exempt, ` +
          `bundleDependencies are allowed.`,
      },
    }
  }

  const lifecycle = scriptNames(packageManifest.scripts)
    .filter(name2 => (FORBIDDEN_LIFECYCLE_SCRIPTS as readonly string[]).includes(name2))
    .sort()
  if (lifecycle.length > 0) {
    return {
      ok: false,
      rejection: {
        code: 'lifecycle-scripts',
        message:
          `market artifacts must not carry lifecycle install scripts; ` +
          `remove from "scripts": ${lifecycle.join(', ')}.`,
      },
    }
  }

  return { ok: true, name, version }
}
