/** Stable, Beta, and HuaAnWork identities used to locate each edition's private app data. */
export const DESKTOP_RELEASE_IDENTITIES = Object.freeze({
  stable: Object.freeze({
    releaseChannel: 'stable' as const,
    packageName: 'dsh-plugin-desktop',
    productName: 'DSH Desktop',
    appId: 'ai.deepseek.dsh.desktop',
    homeDirectoryName: '.dsh',
  }),
  beta: Object.freeze({
    releaseChannel: 'beta' as const,
    packageName: 'dsh-plugin-desktop-beta',
    productName: 'DSH Desktop Beta',
    appId: 'ai.deepseek.dsh.desktop.beta',
    homeDirectoryName: '.dsh-beta',
  }),
  huaanwork: Object.freeze({
    releaseChannel: 'huaanwork' as const,
    packageName: 'dsh-plugin-huaanwork',
    productName: 'HuaAnWork',
    appId: 'app.huaanwork.desktop',
    homeDirectoryName: '.huaanwork',
  }),
})

export type DesktopProductIdentity = typeof DESKTOP_RELEASE_IDENTITIES[keyof typeof DESKTOP_RELEASE_IDENTITIES]

/** HuaAnWork release-channel identities that must stay aligned with electron-builder. */
export const DESKTOP_PRODUCT_IDENTITY = DESKTOP_RELEASE_IDENTITIES.huaanwork
export const OTHER_DESKTOP_PRODUCT_IDENTITY = DESKTOP_RELEASE_IDENTITIES.stable
export const DESKTOP_PACKAGE_NAME = DESKTOP_PRODUCT_IDENTITY.packageName
export const STABLE_DESKTOP_PACKAGE_NAME = OTHER_DESKTOP_PRODUCT_IDENTITY.packageName
export const DESKTOP_PRODUCT_NAME = DESKTOP_PRODUCT_IDENTITY.productName
export const DESKTOP_APP_ID = DESKTOP_PRODUCT_IDENTITY.appId
export const DESKTOP_RELEASE_CHANNEL = DESKTOP_PRODUCT_IDENTITY.releaseChannel
export const DESKTOP_HOME_DIRECTORY_NAME = DESKTOP_PRODUCT_IDENTITY.homeDirectoryName

/** Desktop package identities are launcher-owned, never Profile plugins. */
export const DESKTOP_PACKAGE_NAMES: ReadonlySet<string> = new Set([
  STABLE_DESKTOP_PACKAGE_NAME,
  DESKTOP_RELEASE_IDENTITIES.beta.packageName,
  DESKTOP_PACKAGE_NAME,
])
