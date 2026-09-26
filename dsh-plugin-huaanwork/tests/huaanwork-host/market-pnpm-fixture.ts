/**
 * M5 市场安装 pnpm 语义夹具（round5 实验脚本 → Task 5 测试夹具，2026-09-25）。
 *
 * 把 plan-review round5 的隔离实验（A/B/C/F/I，见
 * plans/2026-09-25-dsh-desktop-integration-m5-market-plan-review-round5.md §3）
 * 固化为可复用沙箱，供 market-pnpm-semantics.spec.ts 锁定 pnpm 行为，
 * 也供 Task 5 wrapper install.ts 的端到端测试直接消费（避免实施期重推 pnpm 语义）。
 *
 * 关键语义（全部经 2026-09-25 本机实证，pnpm 10.32.1）：
 * - `pnpm add <本地 .tgz>` 会把 `file:<绝对路径>` 写进 profile `package.json`
 *   的 dependencies——制品与该引用共存亡（round5 N1 / 实验 A/C）。
 * - 删除已被引用的制品后，任何后续 `pnpm add` 以 ENOENT 确定性失败（实验 C）。
 * - 制品保留在 profile 内专用目录时连续安装/卸载全绿（实验 F）。
 * - `--offline` 的解析先查本机元数据镜像：冷 store 下带依赖制品以
 *   ERR_PNPM_NO_OFFLINE_META 确定性失败且不污染 profile（实验 B）；
 *   暖 store 下可离线装成（N3）——故兜底负例必须双密封 store 与 cache。
 * - `pnpm remove` 拒收 `--offline`/`--ignore-scripts`（Unknown option，实验 I）。
 *
 * 沙箱形态：真实 `initProfile` 产物（非手工复刻，上游改 PROFILE_PNPM_WORKSPACE
 * 时夹具自动跟随）+ 独立 `--store-dir`/`--cache-dir`（密封，与机器缓存状态无关）。
 * pnpm 子进程 env 带 CI:true（压掉交互提示，与 DesktopPnpmService `pnpm.ts:219` 同构）。
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initProfile, PROFILE_TEMPLATES } from '@deepseek-ai/dsh-app-boot'

/** pnpm 子进程运行结果。exitCode 为 null 时（进程未跑起）记为 -1。 */
export interface PnpmRunResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

/** 市场制品 tarball 规格：零依赖/带依赖/带 lifecycle 脚本由测试按需构造。 */
export interface MarketTarballSpec {
  readonly name: string
  readonly version: string
  readonly dependencies?: Record<string, string>
  readonly optionalDependencies?: Record<string, string>
  readonly scripts?: Record<string, string>
}

export interface BuiltTarball {
  readonly path: string
  readonly sha256: string
  readonly name: string
  readonly version: string
}

/** 一次沙箱 = 一个隔离 profile + 密封 store/cache + 市场制品目录。 */
export interface MarketSandbox {
  readonly root: string
  /** 真实 initProfile 产物目录（即测试用 profileDir）。 */
  readonly profileDir: string
  /** `<profileDir>/.market-artifacts`（0700）——计划〈安装入口边界〉④ 的制品布局。 */
  readonly artifactsDir: string
  /** 密封 pnpm store（--store-dir）。 */
  readonly storeDir: string
  /** 密封 pnpm 元数据缓存（--cache-dir）——N3 兜底负例密封的第二只手。 */
  readonly cacheDir: string
  /** 构造 tarball 的 scratch 目录。 */
  readonly buildsDir: string
  /** 构造一个真实 tarball 并计算 sha256（npm 形态：package/ 根目录）。 */
  buildTarball(spec: MarketTarballSpec): BuiltTarball
  /** 按计划命名 `<name>-<version>-<sha256前12>.tgz` 把制品落进 .market-artifacts/（0600）。 */
  promoteToArtifact(built: BuiltTarball): string
  /** 市场安装链等价物：`pnpm add <path> --offline --ignore-scripts`（密封）。 */
  marketInstall(path: string): PnpmRunResult
  /** 不带市场 flags 的安装（--ignore-scripts 正反对照用，仍密封）。 */
  plainInstall(path: string): PnpmRunResult
  /** 卸载。extraFlags 仅用于 N2 负例（`--offline`/`--ignore-scripts` 会被 pnpm 拒收）。 */
  marketRemove(name: string, extraFlags?: readonly string[]): PnpmRunResult
  /** profile `package.json` 的 dependencies 原样读回。 */
  readProfileDependencies(): Record<string, string>
  /** profile `package.json` 原始字节（失败不污染断言用）。 */
  readProfileManifestRaw(): string
  dispose(): void
}

/** round5 实验环境能力探测：pnpm/tar 缺席或 win32 时跳过语义锁定套件。 */
export function pnpmSemanticsProbe(): { supported: boolean; reason?: string; pnpmVersion?: string } {
  if (process.platform === 'win32') {
    // 原因：pnpm .cmd shim 与 shell 引用规则使 spawnSync 路径引用不可移植；
    // pnpm 层语义与平台无关，win32 侧覆盖由 Task 5 wrapper 级 e2e 承担。
    return { supported: false, reason: 'win32 skipped: pnpm-level semantics are covered by wrapper e2e' }
  }
  const pnpm = spawnSync('pnpm', ['--version'], { encoding: 'utf8' })
  if (pnpm.status !== 0) return { supported: false, reason: 'pnpm not on PATH' }
  const tar = spawnSync('tar', ['--version'], { encoding: 'utf8' })
  if (tar.status !== 0) return { supported: false, reason: 'tar not on PATH' }
  // round6 S2：pnpm 语义版本敏感（10.32.1 与 11.8.0 在批准/IGNORED_BUILDS
  // 行为上已观察到差异），实测版本随探测结果带出，由套件启动时输出。
  return { supported: true, pnpmVersion: (pnpm.stdout || '').trim() }
}

/** 计划〈安装入口边界〉④ 的制品命名：`<name>-<version>-<sha256前12>.tgz`。 */
export function marketArtifactName(name: string, version: string, sha256hex: string): string {
  return `${name}-${version}-${sha256hex.slice(0, 12)}.tgz`
}

/**
 * pnpm 输出断言一律用合并流：非 TTY 下 pnpm 的 append-only reporter 把运行时
 * 错误（ENOENT / ERR_PNPM_NO_OFFLINE_META 等）写 **stdout**，而 commander 的
 * 参数解析错误（Unknown option）写 **stderr**——按单流断言会随机漏（2026-09-25
 * 首跑实测）。
 */
export function combinedOutput(run: PnpmRunResult): string {
  return `${run.stdout}\n${run.stderr}`
}

const sandboxes: string[] = []

/** 释放本进程内创建的全部沙箱（spec 的 afterEach 里调用一次即可）。 */
export function disposeAllMarketSandboxes(): void {
  while (sandboxes.length > 0) rmSync(sandboxes.pop()!, { recursive: true, force: true })
}

export interface MarketSandboxOptions {
  /**
   * 在 pnpm-workspace.yaml 里追加依赖构建批准（正反对照用：证明批准状态下
   * `--ignore-scripts` 仍机械封死脚本）。键名实测为 `onlyBuiltDependencies`
   * （pnpm 10.32.1 认可并放行脚本；`allowBuilds` 被静默忽略——harness CLI
   * 提示文本 `apps/cli/src/plugin.ts:21-23` 面向其他 pnpm 版本，不适用本机）。
   */
  readonly approveBuildsFor?: readonly string[]
}

export function createMarketSandbox(options?: MarketSandboxOptions): MarketSandbox {
  const root = mkdtempSync(join(tmpdir(), 'hw-market-pnpm-'))
  sandboxes.push(root)
  const profileDir = join(root, 'profile')
  mkdirSync(profileDir, { recursive: true })
  // 真实 initProfile：package.json（dependencies 空）+ cordis.patch.yml 模板
  // + pnpm-workspace.yaml（nodeLinker: hoisted / autoInstallPeers: false）。
  initProfile(profileDir, PROFILE_TEMPLATES.web?.bundles ?? ['@deepseek-ai/dsh-base'])
  if (options?.approveBuildsFor !== undefined) {
    const workspacePath = join(profileDir, 'pnpm-workspace.yaml')
    const block = ['onlyBuiltDependencies:', ...options.approveBuildsFor.map(name => `  - ${name}`)].join('\n')
    writeFileSync(workspacePath, `${readFileSync(workspacePath, 'utf8')}\n${block}\n`)
  }
  const artifactsDir = join(profileDir, '.market-artifacts')
  mkdirSync(artifactsDir)
  chmodSync(artifactsDir, 0o700)
  const storeDir = join(root, 'store')
  const cacheDir = join(root, 'cache')
  const buildsDir = join(root, 'builds')
  for (const dir of [storeDir, cacheDir, buildsDir]) mkdirSync(dir)

  const manifestPath = join(profileDir, 'package.json')

  function runPnpm(args: readonly string[]): PnpmRunResult {
    const run = spawnSync('pnpm', [...args], {
      cwd: profileDir,
      encoding: 'utf8',
      env: { ...process.env, CI: 'true' },
      maxBuffer: 16 * 1024 * 1024,
    })
    return { exitCode: run.status ?? -1, stdout: run.stdout ?? '', stderr: run.stderr ?? '' }
  }

  const sealedArgs = ['--store-dir', storeDir, '--cache-dir', cacheDir]

  return {
    root,
    profileDir,
    artifactsDir,
    storeDir,
    cacheDir,
    buildsDir,
    buildTarball(spec: MarketTarballSpec): BuiltTarball {
      const buildRoot = join(buildsDir, `${spec.name}-${spec.version}`)
      const pkgDir = join(buildRoot, 'package')
      mkdirSync(pkgDir, { recursive: true })
      const manifest: Record<string, unknown> = { name: spec.name, version: spec.version }
      if (spec.dependencies !== undefined) manifest.dependencies = spec.dependencies
      if (spec.optionalDependencies !== undefined) manifest.optionalDependencies = spec.optionalDependencies
      if (spec.scripts !== undefined) manifest.scripts = spec.scripts
      writeFileSync(join(pkgDir, 'package.json'), `${JSON.stringify(manifest, undefined, 2)}\n`)
      const tgzPath = join(buildRoot, `${spec.name}-${spec.version}.tgz`)
      const tar = spawnSync('tar', ['czf', tgzPath, 'package'], { cwd: buildRoot, encoding: 'utf8' })
      if (tar.status !== 0) {
        throw new Error(`market fixture: tar build failed for ${spec.name}: ${tar.stderr}`)
      }
      const sha256 = createHash('sha256').update(readFileSync(tgzPath)).digest('hex')
      return { path: tgzPath, sha256, name: spec.name, version: spec.version }
    },
    promoteToArtifact(built: BuiltTarball): string {
      const target = join(artifactsDir, marketArtifactName(built.name, built.version, built.sha256))
      writeFileSync(target, readFileSync(built.path))
      chmodSync(target, 0o600)
      return target
    },
    marketInstall(path: string): PnpmRunResult {
      return runPnpm(['add', path, '--offline', '--ignore-scripts', ...sealedArgs])
    },
    plainInstall(path: string): PnpmRunResult {
      return runPnpm(['add', path, ...sealedArgs])
    },
    marketRemove(name: string, extraFlags?: readonly string[]): PnpmRunResult {
      return runPnpm(['remove', name, ...(extraFlags ?? []), ...sealedArgs])
    },
    readProfileDependencies(): Record<string, string> {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
        dependencies?: Record<string, string>
      }
      return manifest.dependencies ?? {}
    },
    readProfileManifestRaw(): string {
      return readFileSync(manifestPath, 'utf8')
    },
    dispose(): void {
      const index = sandboxes.indexOf(root)
      if (index >= 0) sandboxes.splice(index, 1)
      rmSync(root, { recursive: true, force: true })
    },
  }
}

/** 便捷断言用：profile dependencies 里是否出现指向给定制品路径的 `file:` 引用。 */
export function fileReferenceFor(dependencies: Record<string, string>, name: string): string | undefined {
  const reference = dependencies[name]
  return typeof reference === 'string' && reference.startsWith('file:') ? reference : undefined
}

/** 验证依赖引用在盘上仍然存在（N1 回归门的核心断言原料）。 */
export function fileReferenceExists(_profileDir: string, dependencies: Record<string, string>): boolean {
  for (const reference of Object.values(dependencies)) {
    if (!reference.startsWith('file:')) continue
    const path = reference.slice('file:'.length)
    if (!existsSync(path)) return false
  }
  return true
}
