/**
 * huaanwork-market provider-page → CatalogSnapshot 归一化(M5 Task 5 Step 2)。
 *
 * round3 R12/M4' 裁定:market-server 只发 provider-page(严格 schema,信封/sidecar
 * 旁挂);`CatalogSnapshot` 的 **Host provenance 由 wrapper 自铸**——wrapper 是
 * 本源消费端,属 Host 侧角色。单源裁定(Task 0.5 Step 4):sourceRecordId/providerId
 * 固定为 canonical 内网源身份;多源 keyring/UI 为 M6 裁定不实现的升级路径
 * (见 `docs/market-upgrade-paths.md`;不改造清单⑤)。
 *
 * 契约负载不自造方言:入参必须已过上游 `parseCatalogProviderPage` 自校(routes 层
 * 在验签后调用);本函数只做形态映射 + provenance 铸造。
 */

import type { CatalogSnapshot } from 'dsh-community-market/contracts'

/** canonical 内网源身份(单源裁定;多源为 M6 裁定不实现的升级路径,见 `docs/market-upgrade-paths.md`)。 */
export const HUAANWORK_MARKET_SOURCE_RECORD_ID = 'huaanwork-intranet' as const
export const HUAANWORK_MARKET_PROVIDER_ID = 'huaanwork-market' as const
export const HUAANWORK_MARKET_ADAPTER_ID = 'huaanwork-market-wrapper' as const

/** 上游 provider-page 形态(parseCatalogProviderPage 校验通过的负载)。 */
export interface CatalogProviderPageView {
  readonly schemaVersion: '1.0.0'
  readonly generatedAt?: string
  readonly items: readonly Record<string, unknown>[]
  readonly page: { readonly total?: number }
}

/**
 * 归一化:provider-page → CatalogSnapshot。
 * - `source.finalUrl` = 配置源 origin(plain-http 内网源;签名背书非 TLS)。
 * - 每个 item 自铸 provenance:{sourceRecordId, providerId, itemId: item.id}。
 * - `page` 透传(total);M5 单页 ≤200,无 cursor。
 */
export function normalizeProviderPageToSnapshot(
  page: CatalogProviderPageView,
  origin: string,
  fetchedAt: string,
): CatalogSnapshot {
  const items = page.items.map((item) => {
    const id = typeof item.id === 'string' && item.id.length > 0 ? item.id : ''
    return {
      ...item,
      provenance: {
        sourceRecordId: HUAANWORK_MARKET_SOURCE_RECORD_ID,
        providerId: HUAANWORK_MARKET_PROVIDER_ID,
        itemId: id,
      },
    }
  }) as CatalogSnapshot['items']
  return {
    schemaVersion: '1.0.0',
    source: {
      sourceRecordId: HUAANWORK_MARKET_SOURCE_RECORD_ID,
      providerId: HUAANWORK_MARKET_PROVIDER_ID,
      adapterId: HUAANWORK_MARKET_ADAPTER_ID,
      registrationKind: 'built-in',
      fetchedAt,
      finalUrl: origin,
      ...(page.generatedAt !== undefined ? { providerGeneratedAt: page.generatedAt } : {}),
    },
    items,
    page: { ...(page.page.total !== undefined ? { total: page.page.total } : {}) },
  }
}
