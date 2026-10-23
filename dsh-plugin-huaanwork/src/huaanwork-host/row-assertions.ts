export interface RowHitAssertion {
  id: string
  intent: 'disable' | 'override'
  expectConfig?: Record<string, unknown> | undefined
  optional?: boolean | undefined
}

export interface RowLike {
  name?: string | undefined
  disabled?: boolean | null | undefined
  config?: unknown
}

const shellToolAssertion: RowHitAssertion =
  process.platform === 'win32'
    ? { id: 'tool-pwsh', intent: 'override', expectConfig: { enableRunInBackground: false } }
    : { id: 'tool-bash', intent: 'override', expectConfig: { enableRunInBackground: false } }

export const HUAANWORK_ROW_ASSERTIONS: readonly RowHitAssertion[] = [
  { id: 'llm-deepseek', intent: 'disable' },
  { id: 'approval', intent: 'override', expectConfig: { policy: 'ask' } },
  { id: 'tools', intent: 'override', expectConfig: { mode: 'native' } },
  { id: 'agent-loop', intent: 'override', expectConfig: { 'agents.0.id': 'huaanwork', 'agents.0.provider': 'deepseek-official', 'agents.0.model': 'local' } },
  { id: 'hmr', intent: 'disable' },
  { id: 'jobs', intent: 'disable' },
  { id: 'tool-jobs', intent: 'disable' },
  { id: 'tool-fs', intent: 'override' },
  { id: 'tool-fs-search', intent: 'override' },
  shellToolAssertion,
  { id: 'subagent', intent: 'override' },
  { id: 'subagent-spawn-in-process', intent: 'override', expectConfig: { providerName: 'spawn' } },
  { id: 'plan-mode', intent: 'override' },
  { id: 'tool-todo', intent: 'override', expectConfig: { allowParallelInProgress: false } },
  { id: 'tool-goal', intent: 'override' },
  { id: 'goal', intent: 'override', expectConfig: { defaultMaxGoalRounds: 4 } },
  { id: 'tool-result-pruner', intent: 'override' },
  { id: 'compaction-basic', intent: 'override' },
  { id: 'web', intent: 'disable' },
  { id: 'web-search-deepseek', intent: 'disable' },
  { id: 'tool-web', intent: 'disable' },
  { id: 'workflow-ptc', intent: 'disable' },
  { id: 'tool-workflow', intent: 'disable' },
  { id: 'tool-ralph', intent: 'disable', optional: true },
  { id: 'fs-sandbox', intent: 'override' },
  { id: 'sandbox-policy', intent: 'override', expectConfig: { mode: 'workspace-write' } },
]

function deepGet(value: unknown, path: string): unknown {
  let current = value
  for (const key of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

export function assertHuaanworkRowIdsHit(
  rows: ReadonlyMap<string, RowLike>,
  declared: readonly RowHitAssertion[] = HUAANWORK_ROW_ASSERTIONS,
): void {
  const problems: string[] = []
  for (const { id, intent, expectConfig, optional } of declared) {
    const row = rows.get(id)
    if (row === undefined) {
      if (id === 'tool-ralph') {
        // tool-ralph is intentionally absent in this variant; catch a silent
        // upstream rename instead of letting the optional assertion swallow it.
        const renamed = [...rows.keys()].filter(candidate => candidate !== id && /ralph/u.test(candidate))
        if (renamed.length > 0) {
          problems.push(`${id}: expected absent for this variant, but renamed row(s) exist: ${renamed.join(', ')}`)
        }
      }
      if (optional) continue
      problems.push(`${id}: declared ${intent} but the id does not exist in the composed profile (upstream renamed or removed it)`)
      continue
    }
    if (intent === 'disable' && row.disabled !== true) {
      problems.push(`${id}: expected disabled, but the composed row is enabled`)
    }
    if (intent === 'override' && row.disabled === true) {
      problems.push(`${id}: expected enabled with override, but the composed row is disabled`)
    }
    if (intent === 'override' && expectConfig) {
      for (const [path, want] of Object.entries(expectConfig)) {
        const got = deepGet(row.config, path)
        if (got !== want) problems.push(`${id}: config.${path} expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`)
      }
    }
  }
  if (problems.length > 0) {
    throw new Error(`dsh-plugin-huaanwork: guardrail row-id drift detected:\n${problems.map((p) => `- ${p}`).join('\n')}`)
  }
}
