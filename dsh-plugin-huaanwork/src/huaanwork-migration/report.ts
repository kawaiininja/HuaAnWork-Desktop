import type { HuaanworkMigrationMarker } from './marker.ts'

export interface HuaanworkMigrationReport {
  performed: boolean
  marker: HuaanworkMigrationMarker | null
  readonly counts: Record<string, number>
  readonly skipped: string[]
  readonly notMigrated: string[]
}

export function createMigrationReport(): HuaanworkMigrationReport {
  return { performed: false, marker: null, counts: {}, skipped: [], notMigrated: [] }
}

export function bumpCount(report: HuaanworkMigrationReport, key: string, by = 1): void {
  report.counts[key] = (report.counts[key] ?? 0) + by
}

export function recordSkip(report: HuaanworkMigrationReport, reason: string): void {
  if (!report.skipped.includes(reason)) report.skipped.push(reason)
}
