// HuaAnWork alone owns the market DSH dependency check.
export function ownsMarketRuntime(channel) {
  return channel === 'huaanwork'
}

// The market bundle's DSH peers must accept every host runtime it can still load in.
// Only the active HuaAnWork lane is derived from metadata: the historical Stable leg
// and the dormant alpha.1 leg are explicit policy fields (`marketPeerPolicy`), so
// changing either one is a reviewed data edit rather than a rewrite of this function.
export function marketPeerRange(upstreamDocument) {
  const active = upstreamDocument.channels?.[upstreamDocument.activeChannel]?.sourceVersion
  if (upstreamDocument.activeChannel !== 'huaanwork' || typeof active !== 'string' || active.length === 0) {
    throw new Error('HuaAnWork active sourceVersion is required')
  }
  const policy = upstreamDocument.marketPeerPolicy
  for (const field of ['stableHistorical', 'dormantAlpha1']) {
    if (!['retain', 'retire'].includes(policy?.[field])) {
      throw new Error(`marketPeerPolicy.${field} must be retain or retire`)
    }
  }
  return [...new Set([
    ...(policy.stableHistorical === 'retain' ? ['0.2.0-rc.2'] : []),
    active,
    ...(policy.dormantAlpha1 === 'retain' ? ['0.2.1-alpha.1'] : []),
  ])].join(' || ')
}
