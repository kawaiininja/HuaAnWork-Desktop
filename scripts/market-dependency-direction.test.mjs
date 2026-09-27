import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  verifyDesktopDependencyDirection,
  verifyMarketDependencyDirection,
  verifyMarketInstallPathHasNoRegistryBypass,
} from './market-dependency-direction.mjs'

test('allows product-name data in Market source', () => {
  assert.deepEqual(verifyMarketDependencyDirection([
    ['dsh-community-market/src/install.ts', "const blocked = new Set(['dsh-plugin-desktop'])\n"],
    // M5 round3 R10:market-server 同属 market 面受检根;尚未实现前的骨架也须过向检查。
    ['market-server/src/index.ts', "const blocked = new Set(['dsh-plugin-huaanwork'])\n"],
  ]), { fileCount: 2 })
})

test('rejects Market imports of Desktop implementation', () => {
  assert.throws(() => verifyMarketDependencyDirection([
    ['dsh-community-market/src/index.ts', "import type { DesktopRuntime } from 'dsh-plugin-desktop/runtime'\n"],
    ['dsh-community-market/src/beta.ts', "import type { DesktopRuntime } from 'dsh-plugin-desktop-beta/runtime'\n"],
  ]), /must not import Desktop implementation/u)
  assert.throws(() => verifyMarketDependencyDirection([
    ['dsh-community-market/src/index.ts', "const desktop = await import('dsh-plugin-desktop')\n"],
  ]), /must not import Desktop implementation/u)
  assert.throws(() => verifyMarketDependencyDirection([
    ['dsh-community-market/src/index.ts', "export { runtime } from '../../dsh-plugin-desktop/src/runtime.js'\n"],
  ]), /must not import Desktop implementation/u)
  assert.throws(() => verifyMarketDependencyDirection([
    ['dsh-community-market/src/huaanwork.ts', "import type { DesktopRuntime } from 'dsh-plugin-huaanwork/runtime'\n"],
  ]), /must not import Desktop implementation/u)
  // M5 round3 R10:扩展受检根后,market-server 源同样不得 import 桌面实现。
  assert.throws(() => verifyMarketDependencyDirection([
    ['market-server/src/catalog.ts', "import type { HostRuntime } from 'dsh-plugin-huaanwork/host-runtime'\n"],
  ]), /must not import Desktop implementation/u)
  assert.throws(() => verifyMarketDependencyDirection([
    ['market-server/src/server.ts', "const runtime = await import('../dsh-plugin-desktop/src/runtime.js')\n"],
  ]), /must not import Desktop implementation/u)
})

test('allows Desktop sources importing upstream market contracts', () => {
  assert.deepEqual(verifyDesktopDependencyDirection([
    // wrapper 消费面只经上游 contracts(round3 R12),这是 market 面唯一被允许的 Desktop→market 依赖。
    ['dsh-plugin-huaanwork/src/huaanwork-host/market/catalog-client.ts', "import type { CatalogPage } from 'dsh-community-market/contracts'\n"],
    // 纯数据字符串不命中 import 形态,不算违规。
    ['dsh-plugin-desktop/src/plugin.ts', "const blocked = new Set(['market-server'])\n"],
  ]), { fileCount: 2 })
})

test('rejects Desktop imports of the market-server workspace (reverse rule, round3 R10)', () => {
  assert.throws(() => verifyDesktopDependencyDirection([
    ['dsh-plugin-huaanwork/src/huaanwork-host/market/routes.ts', "import { verifyManifest } from 'market-server/contracts'\n"],
  ]), /must not import the market-server workspace/u)
  assert.throws(() => verifyDesktopDependencyDirection([
    ['dsh-plugin-desktop/src/index.ts', "const admin = await import('market-server/admin')\n"],
  ]), /must not import the market-server workspace/u)
  assert.throws(() => verifyDesktopDependencyDirection([
    ['dsh-plugin-desktop-beta/src/index.ts', "const server = require('market-server')\n"],
  ]), /must not import the market-server workspace/u)
  // 相对路径钻进 market-server 工作区同样算违规(双向守卫按路径形态判定)。
  assert.throws(() => verifyDesktopDependencyDirection([
    ['dsh-plugin-huaanwork/src/client-huaanwork/api.ts', "export { fetchCatalog } from '../../market-server/src/catalog.js'\n"],
  ]), /must not import the market-server workspace/u)
})

// 评审 P15:解法 A(spec §14 第 40 条)的机器守卫——远程市场安装绝不旁路已验签清单。
test('allows the market wrapper to explain the bypass in prose (P15)', () => {
  // install.ts 的两处 docstring 正是在解释「不经 runExternalMarketPluginInstall/
  // --registry」;裸词匹配会误报,故守卫要求代码形态(调用括号 / import 花括号 /
  // 引号内 flag)。
  assert.deepEqual(verifyMarketInstallPathHasNoRegistryBypass([
    [
      'dsh-plugin-huaanwork/src/huaanwork-host/market/install.ts',
      [
        "import { addPlugin } from '../plugins-host.ts'",
        ' * (两道补强;flag 构造只在 addPlugin 内;不经 runExternalMarketPluginInstall/--registry)。',
        "const argv = ['add', artifactPath, '--offline', '--ignore-scripts']",
      ].join('\n'),
    ],
    // 受检根之外的文件不受本规则约束(pnpm.ts 定义该函数、dshmarket 是其生产消费方,
    // round3 R17:非死代码,不得清理)。
    [
      'dsh-plugin-huaanwork/src/pnpm.ts',
      'export async function runExternalMarketPluginInstall(spec) { return spec }',
    ],
  ]), { fileCount: 2 })
})

test('rejects any registry bypass of the signed manifest in the market wrapper (P15)', () => {
  const wrapper = 'dsh-plugin-huaanwork/src/huaanwork-host/market/install.ts'
  assert.throws(() => verifyMarketInstallPathHasNoRegistryBypass([
    [wrapper, "await runExternalMarketPluginInstall(ctx, `${name}@${version}`, registryUrl)\n"],
  ]), /must not bypass the signed manifest/u)
  assert.throws(() => verifyMarketInstallPathHasNoRegistryBypass([
    [wrapper, "import { runExternalMarketPluginInstall } from '../../pnpm.ts'\n"],
  ]), /must not bypass the signed manifest/u)
  // pnpm 自行下载 + 只信 registry dist.integrity = 签名清单被绕过(P0)。
  assert.throws(() => verifyMarketInstallPathHasNoRegistryBypass([
    [wrapper, "const argv = ['add', spec, `--registry=${origin}`]\n"],
  ]), /must not bypass the signed manifest/u)
  assert.throws(() => verifyMarketInstallPathHasNoRegistryBypass([
    [wrapper, "const argv = ['add', spec, '--registry', origin]\n"],
  ]), /must not bypass the signed manifest/u)
  // --prefer-offline 会回网,使 --offline 兜底失效(计划实施护栏明令不得降级)。
  assert.throws(() => verifyMarketInstallPathHasNoRegistryBypass([
    [wrapper, "const argv = ['add', spec, '--prefer-offline']\n"],
  ]), /must not bypass the signed manifest/u)
  assert.throws(() => verifyMarketInstallPathHasNoRegistryBypass([
    [wrapper, "env.npm_config_registry = origin\n"],
  ]), /must not bypass the signed manifest/u)
  // 违规须点名文件,便于定位。
  assert.throws(() => verifyMarketInstallPathHasNoRegistryBypass([
    [wrapper, "await runExternalMarketPluginInstall(ctx, spec)\n"],
  ]), /market\/install\.ts/u)
})
