import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { PROFILE_TEMPLATES } from '@deepseek-ai/dsh-app-boot'

import { DESKTOP_PACKAGE_NAMES } from '../product-identity.ts'

/**
 * 插件清单读路径(Task 10):读 profileDir package.json 的 `dsh.profile.bundles`,
 * 逐字移植自旧 sidecar plugins.ts:35,142-154 的 listPlugins / readBundleList。
 *
 * 存储根:旧 sidecar 读 `$DSH_HOME/profiles/<name>/package.json`;Desktop 组合下
 * profileDir 本身就是该目录,直接读 `<profileDir>/package.json`。manifest 缺失
 * (档案尚未物化)时回落 REQUIRED_BUNDLES(src/profile.ts:85 desktopBundleList 的
 * composition 前导,即随包分发的 web 模板 bundle)。注意 dsh-plugin-huaanwork 是
 * DESKTOP_PACKAGE_NAME(走 patch 行组合,src/profile.ts:981),从不出现在
 * dsh.profile.bundles 清单里,不得列入回落。
 */

/**
 * 档案清单缺失时的回落 bundle 清单 = REQUIRED_BUNDLES(web profile 模板,
 * PROFILE_TEMPLATES.web.bundles;与 src/profile.ts:239 requiredWebBundles 同源)。
 * 读路径不硬失败:物化器不可用时回落到发布期已知的 web 模板前导。
 */
export function fallbackProfileBundles(): string[] {
  const template = PROFILE_TEMPLATES.web
  if (template === undefined) return ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']
  return [...template.bundles]
}

/**
 * 不可移除的 bundle(与 src/desktop-plugins.ts IMMUTABLE_BUNDLES 同口径:
 * web 模板 bundle + 桌面包名(DESKTOP_PACKAGE_NAMES)+ 历史/市场固定项;
 * M4 plugin.remove 写路径消费,防止把随包 carrier 标为可移除)。
 */
export const IMMUTABLE_BUNDLES: ReadonlySet<string> = new Set([
  ...fallbackProfileBundles(),
  '@deepseek-ai/dsh-desktop-app',
  ...DESKTOP_PACKAGE_NAMES,
  'dsh-community-market',
])

export function listPlugins(storageRoot: string): { bundles: string[] } {
  return { bundles: readBundleList(storageRoot) }
}

function readBundleList(storageRoot: string): string[] {
  const path = join(storageRoot, 'package.json')
  try {
    const manifest = JSON.parse(readFileSync(path, 'utf8')) as {
      dsh?: { profile?: { bundles?: unknown } }
    }
    const bundles = manifest.dsh?.profile?.bundles
    return Array.isArray(bundles) ? bundles.filter((bundle): bundle is string => typeof bundle === 'string') : []
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallbackProfileBundles()
    throw error
  }
}
