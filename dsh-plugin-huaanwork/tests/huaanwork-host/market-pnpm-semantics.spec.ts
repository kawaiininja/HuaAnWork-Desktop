/**
 * M5 市场安装 pnpm 语义锁定（plan-review round5 实验 A/B/C/F/I → 回归测试）。
 *
 * 这些测试锁的是 **pnpm 层**语义——Task 5 wrapper `install.ts` 之下的地基。
 * wrapper 级 e2e（preview/execute、四步链路经 addPlugin、制品 GC）在 Task 5
 * 实施时基于同一夹具（market-pnpm-fixture.ts）叠加；本套件保证实施者在
 * wrapper 层写入的每条假设都有 pnpm 行为背书，且 pnpm 升级破坏语义时在此变红。
 *
 * 实验 → 测试映射（round5 报告 §3）：
 * - 实验 A → 「sealed offline 安装零依赖制品成功并写入 file: 引用」
 * - 实验 B → 「sealed offline 对带依赖制品确定性失败且不污染 profile」（N3 兜底负例）
 * - 实验 C → 「删除已装制品后安装第二个制品确定性失败」（N1 根因）
 * - 实验 F → 「.market-artifacts 布局:连续安装两个+卸载一个全绿」（N1 修复布局）
 * - 实验 I → 「pnpm remove 拒收 --offline / --ignore-scripts」（N2）
 * - 补强 → 「--ignore-scripts 在 onlyBuiltDependencies 批准状态下仍机械封死脚本」
 *   （计划〈依赖闭包裁定〉② 的机制证：批准存在时脚本会跑=威胁为真；
 *   加 flag 后永不执行=封死与 workspace 配置状态无关。）
 *   round6 S2：正向对照版本敏感——pnpm 10.32.1 上「批准后脚本会跑」成立，
 *   pnpm 11.8.0 上带 build 脚本的制品直接以 ERR_PNPM_IGNORED_BUILDS 硬失败
 *   （fail-closed，威胁通道在该版本根本不存在），故正向对照条件化。
 */
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import {
  combinedOutput,
  createMarketSandbox,
  disposeAllMarketSandboxes,
  fileReferenceExists,
  fileReferenceFor,
  pnpmSemanticsProbe,
} from './market-pnpm-fixture.ts'

const probe = pnpmSemanticsProbe()
const suite = probe.supported ? describe : describe.skip
if (probe.supported) {
  // round6 S2:pnpm 语义版本敏感,套件启动时输出实测版本,便于对齐计划基线。
  console.log(`[market-pnpm-semantics] pnpm version: ${probe.pnpmVersion}`)
}

afterEach(() => {
  disposeAllMarketSandboxes()
})

suite('market 安装 pnpm 语义（round5 实验锁定）', () => {
  test('实验A: sealed offline 安装零依赖制品成功,写入 file: 引用且依赖数恰 +1', () => {
    const sandbox = createMarketSandbox()
    const built = sandbox.buildTarball({ name: 'probe-zero-a', version: '1.0.0' })

    const run = sandbox.marketInstall(built.path)

    expect(run.exitCode).toBe(0)
    const dependencies = sandbox.readProfileDependencies()
    // 实验 A:本地 tarball 依赖以 file:<绝对路径> 记录——N1 的根源。
    expect(fileReferenceFor(dependencies, 'probe-zero-a')).toBeDefined()
    expect(fileReferenceFor(dependencies, 'probe-zero-a')!.endsWith('.tgz')).toBe(true)
    // (c) 可达性:零依赖 + 密封 store + --offline ⇒ 离线装成,字节落 node_modules。
    expect(existsSync(join(sandbox.profileDir, 'node_modules', 'probe-zero-a', 'package.json'))).toBe(true)
    // N3 依赖数 +1 机械校验(此处锁 pnpm 层;wrapper 层同款断言在 Task 5)。
    expect(Object.keys(dependencies)).toHaveLength(1)
  })

  test('实验B: sealed offline 对带依赖制品确定性失败(ERR_PNPM_NO_OFFLINE_META)且 profile 未被污染', () => {
    const sandbox = createMarketSandbox()
    const before = sandbox.readProfileManifestRaw()
    const built = sandbox.buildTarball({
      name: 'probe-dep-ful',
      version: '1.0.0',
      dependencies: { ms: '^2.1.3' },
    })

    const run = sandbox.marketInstall(built.path)

    // N3 兜底负例(密封):--offline 封死网络路径,冷 store/冷元数据镜像下
    // 解析确定性失败——双密封使该断言与机器 store/缓存状态无关
    // (本机真实缓存即使已暖,--store-dir + --cache-dir 也隔离之)。
    expect(run.exitCode).not.toBe(0)
    expect(combinedOutput(run)).toContain('ERR_PNPM_NO_OFFLINE_META')
    // 失败是干净的:profile manifest 逐字节不变,依赖闭包未混入。
    expect(sandbox.readProfileManifestRaw()).toBe(before)
    expect(Object.keys(sandbox.readProfileDependencies())).toHaveLength(0)
    expect(existsSync(join(sandbox.profileDir, 'node_modules', 'ms'))).toBe(false)
  })

  test('实验C: 删除已被引用的制品后,安装第二个制品以 ENOENT 确定性失败(N1 根因)', () => {
    const sandbox = createMarketSandbox()
    const first = sandbox.buildTarball({ name: 'probe-zero-a', version: '1.0.0' })
    const second = sandbox.buildTarball({ name: 'probe-zero-b', version: '1.0.0' })
    expect(sandbox.marketInstall(first.path).exitCode).toBe(0)

    // 「安装后清理」的错误语义:制品没了,file: 引用悬空。
    rmSync(first.path)

    const run = sandbox.marketInstall(second.path)

    // round5 实验 C / 我方复现:EXIT=254,ENOENT 指向被删的第一个制品
    // (pnpm 重解析既有 direct dependency 时踩悬空引用)。
    expect(run.exitCode).not.toBe(0)
    expect(combinedOutput(run)).toContain('ENOENT')
    expect(combinedOutput(run)).toContain('probe-zero-a')
    const dependencies = sandbox.readProfileDependencies()
    expect(dependencies['probe-zero-b']).toBeUndefined()
  })

  test('实验F: .market-artifacts 布局——连续安装两个+卸载一个全绿,file: 引用始终在盘', () => {
    const sandbox = createMarketSandbox()
    const first = sandbox.promoteToArtifact(sandbox.buildTarball({ name: 'probe-zero-a', version: '1.0.0' }))
    const second = sandbox.promoteToArtifact(sandbox.buildTarball({ name: 'probe-zero-b', version: '1.0.0' }))
    expect(existsSync(first)).toBe(true)
    expect(existsSync(second)).toBe(true)

    // N1 修复布局:制品保留 ⇒ 连续安装/卸载全绿(实验 F:F1=F2=G=0)。
    expect(sandbox.marketInstall(first).exitCode).toBe(0)
    expect(sandbox.marketInstall(second).exitCode).toBe(0)
    expect(Object.keys(sandbox.readProfileDependencies())).toHaveLength(2)

    // 卸载第一个(N2:不带任何 flag):第二个制品与其引用必须不受牵连。
    expect(sandbox.marketRemove('probe-zero-a').exitCode).toBe(0)
    const afterRemove = sandbox.readProfileDependencies()
    expect(afterRemove['probe-zero-a']).toBeUndefined()
    expect(fileReferenceFor(afterRemove, 'probe-zero-b')).toBeDefined()
    expect(fileReferenceExists(sandbox.profileDir, afterRemove)).toBe(true)
    expect(existsSync(second)).toBe(true)

    // 全清收尾:第二个也卸掉,依赖数归零。
    expect(sandbox.marketRemove('probe-zero-b').exitCode).toBe(0)
    expect(Object.keys(sandbox.readProfileDependencies())).toHaveLength(0)
  })

  test('实验I: pnpm remove 拒收 --offline 与 --ignore-scripts(N2),不带 flag 的卸载正常', () => {
    const sandbox = createMarketSandbox()
    const built = sandbox.buildTarball({ name: 'probe-zero-a', version: '1.0.0' })
    expect(sandbox.marketInstall(built.path).exitCode).toBe(0)

    const withOffline = sandbox.marketRemove('probe-zero-a', ['--offline'])
    expect(withOffline.exitCode).not.toBe(0)
    expect(combinedOutput(withOffline)).toContain('Unknown option')

    const withIgnoreScripts = sandbox.marketRemove('probe-zero-a', ['--ignore-scripts'])
    expect(withIgnoreScripts.exitCode).not.toBe(0)
    expect(combinedOutput(withIgnoreScripts)).toContain('Unknown option')

    // 两次拒绝后制品仍在依赖里;干净卸载(无 flag)成功——wrapper 的
    // removePlugin 永不追加两 flag(已提交实现 64a841c9df 的形态)。
    expect(fileReferenceFor(sandbox.readProfileDependencies(), 'probe-zero-a')).toBeDefined()
    expect(sandbox.marketRemove('probe-zero-a').exitCode).toBe(0)
  })

  test('补强②: --ignore-scripts 机械封死脚本(与批准无关);正向对照按 pnpm 版本条件化', () => {
    // 正向对照(版本条件化,round6 S2):workspace 批准构建后
    // (onlyBuiltDependencies——实测 pnpm 10.32.1 认可的键;harness 提示文本的
    // allowBuilds 被本机版本静默忽略),不带 flag 安装——
    //   · pnpm ≤10.x:批准通道生效,postinstall 真跑 ⇒ 证明「永不
    //     approve-builds」防的是真实威胁;
    //   · pnpm 11.8.0:带 build 脚本的制品以 ERR_PNPM_IGNORED_BUILDS 硬失败
    //     (exit 1,即使已批准)——正向对照在该版本不成立,但失败方向是
    //     fail-closed(脚本未执行),机制结论反而更强(计划〈依赖闭包裁定〉
    //     第三重纵深,round6 S4)。
    const approved = createMarketSandbox({ approveBuildsFor: ['probe-scripted'] })
    const scripted = approved.buildTarball({
      name: 'probe-scripted',
      version: '1.0.0',
      scripts: { postinstall: 'touch POSTINSTALL_RAN' },
    })
    const plainRun = approved.plainInstall(scripted.path)
    const approvedMarker = join(approved.profileDir, 'node_modules', 'probe-scripted', 'POSTINSTALL_RAN')
    if (plainRun.exitCode === 0) {
      // pnpm ≤10.x 形态:批准 ⇒ 脚本执行,威胁为真。
      expect(existsSync(approvedMarker)).toBe(true)
    } else {
      // pnpm 11.8.0 形态:硬失败且脚本未执行(fail-closed)。
      expect(combinedOutput(plainRun)).toContain('ERR_PNPM_IGNORED_BUILDS')
      expect(existsSync(approvedMarker)).toBe(false)
    }

    // 机制证(版本无关的承重断言):同一批准状态下,市场安装链
    // (--ignore-scripts) ⇒ 脚本永不执行。这正是计划〈依赖闭包裁定〉② 的
    // 封死语义:无论 workspace 配置如何,市场制品脚本不跑——不依赖 pnpm
    // 默认封锁,也不依赖 wrapper 预检断言。pnpm 11.8.0 上安装可能整体硬失败
    // (IGNORED_BUILDS,fail-closed),两种形态下「脚本不执行」都必须成立。
    const sealed = createMarketSandbox({ approveBuildsFor: ['probe-scripted'] })
    const scriptedAgain = sealed.buildTarball({
      name: 'probe-scripted',
      version: '1.0.0',
      scripts: { postinstall: 'touch POSTINSTALL_RAN' },
    })
    const marketRun = sealed.marketInstall(scriptedAgain.path)
    if (marketRun.exitCode !== 0) {
      expect(combinedOutput(marketRun)).toContain('ERR_PNPM_IGNORED_BUILDS')
    }
    expect(existsSync(join(sealed.profileDir, 'node_modules', 'probe-scripted', 'POSTINSTALL_RAN'))).toBe(false)
  })
})
