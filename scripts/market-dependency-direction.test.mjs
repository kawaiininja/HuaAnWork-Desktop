import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { test } from 'node:test'
import {
  verifyDesktopDependencyDirection,
  verifyMarketDependencyDirection,
  verifyMarketInstallPathHasNoRegistryBypass,
} from './market-dependency-direction.mjs'

// 与 market-dependency-direction.mjs 的 MARKET_WRAPPER_ROOT 同值(该常量未导出;
// 源头改路径的话本文件的后缀查找会落空并以**显式断言**变红,而不是静默跳过)。
const MARKET_WRAPPER_ROOT = 'dsh-plugin-huaanwork/src/huaanwork-host/market'

/** 与库内 readTrackedSources 同形的真实受检树读取(git ls-files,跟踪集先 git add)。 */
function trackedMarketWrapperFiles(root) {
  const paths = execFileSync('git', ['ls-files', '-z', '--', MARKET_WRAPPER_ROOT], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
    .split('\0')
    .filter(path => /\.[cm]?[jt]sx?$/u.test(path))
  return paths.map(path => [path, readFileSync(resolve(root, path), 'utf8')])
}

test('allows product-name data in Market source', () => {
  assert.deepEqual(verifyMarketDependencyDirection([
    ['dsh-community-market/src/install.ts', "const blocked = new Set(['dsh-plugin-desktop'])\n"],
    // M5 round3 R10:market-server 同属 market 面受检根;尚未实现前的骨架也须过向检查。
    ['market-server/src/index.ts', "const blocked = new Set(['dsh-plugin-huaanwork'])\n"],
    ['update-server/src/index.ts', "const blocked = new Set(['dsh-plugin-huaanwork'])\n"],
  ]), { fileCount: 3 })
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
  assert.throws(() => verifyMarketDependencyDirection([
    ['update-server/src/routes.ts', "import type { HostRuntime } from 'dsh-plugin-huaanwork/host-runtime'\n"],
  ]), /must not import Desktop implementation/u)
  assert.throws(() => verifyMarketDependencyDirection([
    ['update-server/src/server.ts', "const runtime = await import('../dsh-plugin-desktop/src/runtime.js')\n"],
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

test('rejects Desktop imports of server workspaces (market-server / update-server)', () => {
  assert.throws(() => verifyDesktopDependencyDirection([
    ['dsh-plugin-huaanwork/src/huaanwork-host/market/routes.ts', "import { verifyManifest } from 'market-server/contracts'\n"],
  ]), /must not import a server workspace \(market-server \/ update-server\)/u)
  assert.throws(() => verifyDesktopDependencyDirection([
    ['dsh-plugin-desktop/src/index.ts', "const admin = await import('market-server/admin')\n"],
  ]), /must not import a server workspace \(market-server \/ update-server\)/u)
  assert.throws(() => verifyDesktopDependencyDirection([
    ['dsh-plugin-desktop-beta/src/index.ts', "const server = require('market-server')\n"],
  ]), /must not import a server workspace \(market-server \/ update-server\)/u)
  // 相对路径钻进 market-server 工作区同样算违规(双向守卫按路径形态判定)。
  assert.throws(() => verifyDesktopDependencyDirection([
    ['dsh-plugin-huaanwork/src/client-huaanwork/api.ts', "export { fetchCatalog } from '../../market-server/src/catalog.js'\n"],
  ]), /must not import a server workspace \(market-server \/ update-server\)/u)
  // update-server 工作区同受反向规则约束
  assert.throws(() => verifyDesktopDependencyDirection([
    ['dsh-plugin-huaanwork/src/huaanwork-host/updates/client.ts', "import { checkUpdate } from 'update-server/client'\n"],
  ]), /must not import a server workspace \(market-server \/ update-server\)/u)
  assert.throws(() => verifyDesktopDependencyDirection([
    ['dsh-plugin-desktop/src/index.ts', "const server = await import('update-server')\n"],
  ]), /must not import a server workspace \(market-server \/ update-server\)/u)
  assert.throws(() => verifyDesktopDependencyDirection([
    ['dsh-plugin-desktop-beta/src/index.ts', "const server = require('update-server')\n"],
  ]), /must not import a server workspace \(market-server \/ update-server\)/u)
  assert.throws(() => verifyDesktopDependencyDirection([
    ['dsh-plugin-huaanwork/src/client-huaanwork/api.ts', "export { fetchUpdate } from '../../update-server/src/index.js'\n"],
  ]), /must not import a server workspace \(market-server \/ update-server\)/u)
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

// Task 6.11(第 39 条核实的机器钉):守卫对**真实受检树**返回零违规,且对注入负例
// 必须变红——恒真的守卫比没有守卫更危险(spec §14 第 49 条、第 52 条末段,M5 教训)。
// 上一条的负例全部是合成 fixture;本测试把负例注入**真实 git ls-files 文件清单**,
// 证明这批真实文件确实逐个进入守卫的 pattern 判定,而不是被预过滤成空转。
test('keeps the registry-bypass shape guard green on the real tracked tree (Task 6.11)', () => {
  const root = resolve(import.meta.dirname, '..')
  const files = trackedMarketWrapperFiles(root)
  // 受检树非空(空文件集会让「零违规」断言恒真——正是本测试要封死的那种恒真)。
  assert.ok(files.length > 0, `expected tracked files under ${MARKET_WRAPPER_ROOT}`)
  // 真实树今天就是这样绿的:全部受检文件零违规,fileCount 与读取集一致。
  assert.deepEqual(verifyMarketInstallPathHasNoRegistryBypass(files), { fileCount: files.length })

  // 负例注入:同一份真实文件清单,把 install.ts 的源码换成含 bypass 形态的文本。
  const installIndex = files.findIndex(([path]) => path.endsWith('/install.ts'))
  assert.notEqual(installIndex, -1, `expected ${MARKET_WRAPPER_ROOT}/install.ts in the tracked set`)
  const injected = source => files.map(([path, current], index) => [path, index === installIndex ? source : current])

  assert.throws(() => verifyMarketInstallPathHasNoRegistryBypass(injected(
    "const argv = ['add', spec, '--registry', origin]\n",
  )), /must not bypass the signed manifest/u)
  assert.throws(() => verifyMarketInstallPathHasNoRegistryBypass(injected(
    'await runExternalMarketPluginInstall(ctx, spec)\n',
  )), /must not bypass the signed manifest/u)
})
