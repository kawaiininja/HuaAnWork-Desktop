import { workNetworkGateError } from '@huaanwork/policy/network'

/**
 * 会话 → 模型条目 id 的绑定表。宿主在 Task 6 创建并登记为 `ctx.huaanworkSessionModels`；
 * 本模块只读，不写。
 */
export type SessionModelTable = Map<string, string>

/** 门禁与选条目共用的模型端点视图（settings 的 `models` 条目结构兼容）。 */
export type SessionModelEndpoint = {
  base_url: string
  model: string
  api_key: string
}

export type ResolveSessionModelInput = {
  /** 本次模型流/前置门禁所属的会话；缺省时按无绑定处理。 */
  sessionId: string | undefined
  table: SessionModelTable
  models: readonly ({ id: string } & SessionModelEndpoint)[]
  /** 无绑定时使用的全局激活条目（settings 镜像出的 base_url/model/api_key）。 */
  active: SessionModelEndpoint
  allowNetwork: boolean
  /** 向父会话走一层；不读 `currentCallerSession()`。 */
  parentOf?: ((sessionId: string) => string | undefined) | undefined
}

export type SessionModelResolution =
  | ({ ok: true } & SessionModelEndpoint)
  | { ok: false; reason: string }

/** 最近的绑定：会话自身优先，其次沿父链向上；都不在表里返回 undefined。 */
function nearestBoundModelId(
  sessionId: string | undefined,
  table: SessionModelTable,
  parentOf?: (sessionId: string) => string | undefined,
): string | undefined {
  const visited = new Set<string>()
  let current = sessionId
  while (current !== undefined && !visited.has(current)) {
    visited.add(current)
    const bound = table.get(current)
    if (bound !== undefined) return bound
    current = parentOf?.(current)
  }
  return undefined
}

/**
 * 按会话绑定选模型条目，并用实际端点的 `base_url` 做联网门禁。
 *
 * 有绑定且条目还在：用该条目；有绑定但条目已删：`模型不存在`，不回落全局；
 * 无绑定：用 `active`。门禁失败原样返回 `workNetworkGateError` 的文案。
 */
export function resolveSessionModel(input: ResolveSessionModelInput): SessionModelResolution {
  const boundId = nearestBoundModelId(input.sessionId, input.table, input.parentOf)
  let endpoint = input.active
  if (boundId !== undefined) {
    const entry = input.models.find((model) => model.id === boundId)
    if (!entry) return { ok: false, reason: '模型不存在' }
    endpoint = { base_url: entry.base_url, model: entry.model, api_key: entry.api_key }
  }
  const blocked = workNetworkGateError({ allowNetwork: input.allowNetwork, baseUrl: endpoint.base_url })
  if (blocked) return { ok: false, reason: blocked }
  return { ok: true, ...endpoint }
}
