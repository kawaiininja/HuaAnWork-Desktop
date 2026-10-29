// Phase A keeps all three channels pinned, so the market peer string still spells
// out every channel's version. HuaAnWork alone owns the market DSH dependency check.
export function ownsMarketRuntime(channel) {
  return channel === 'huaanwork'
}

// The market bundle loads in every desktop channel, and dsh 0.2 refuses a bundle
// whose dsh peers exclude the running runtime, so its peers accept the stable and
// beta versions plus the dormant alpha.1 lane. The channel set, order, and values
// are frozen for Phase A: this must keep producing 0.2.0-rc.2 || 0.2.1-rc.1 || 0.2.1-alpha.1.
export function marketPeerRange(upstreamDocument) {
  return [...new Set([
    ...['stable', 'beta'].map(name => upstreamDocument.channels?.[name]?.sourceVersion),
    '0.2.1-alpha.1',
  ])].join(' || ')
}
