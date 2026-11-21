/**
 * 全屏 Artifact 窗口的共享纯函数。
 *
 * 主进程建窗与客户端 shell 共用同一判定：启动目标只来自受校验的
 * `artifactWindow=1&sessionId=...&artifactId=...`,窗口参数固定为无业务 preload 的
 * 沙箱渲染器与非持久独占 partition。本模块不得引入 Electron 或 React 运行时。
 */
import type { ArtifactRef } from './client-huaanwork/rpc-types.ts'
import { isSinglePathSegment } from './path-segment.ts'
import type { DesktopShellSpec } from './runtime.ts'

/** 全屏窗口启动标记;其他值一律不进入 Artifact 模式。 */
export const ARTIFACT_WINDOW_PARAM = 'artifactWindow'
/** 空 Artifact frame 的名称前缀,与客户端 `crypto.randomUUID()` 拼接。 */
export const ARTIFACT_FRAME_NAME_PREFIX = 'huaanwork-artifact-'

const ARTIFACT_FRAME_NAME_PATTERN =
  /^huaanwork-artifact-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u

/** 原生侧只接受客户端生成的 `huaanwork-artifact-<uuid>` 名称。 */
export function isArtifactFrameName(value: unknown): value is string {
  return typeof value === 'string' && ARTIFACT_FRAME_NAME_PATTERN.test(value)
}

/**
 * 从窗口 query 解析启动目标。
 * @param search - `window.location.search` 或构造 URL 的 search。
 * @returns 同时具备 `artifactWindow=1` 与两个合法单段 ID 时的 ArtifactRef。
 */
export function artifactWindowTargetFromSearch(search: string): ArtifactRef | undefined {
  const params = new URLSearchParams(search)
  if (params.get(ARTIFACT_WINDOW_PARAM) !== '1') return undefined
  const sessionId = params.get('sessionId')
  const artifactId = params.get('artifactId')
  if (!isSinglePathSegment(sessionId) || !isSinglePathSegment(artifactId)) return undefined
  return { sessionId, artifactId }
}

/** 全屏 Artifact 窗口的安全窗口参数。 */
export interface ArtifactWindowOptions {
  readonly fullscreen: true
  readonly url: string
  readonly webPreferences: {
    readonly nodeIntegration: false
    readonly contextIsolation: true
    readonly sandbox: true
    readonly webSecurity: true
    readonly partition: string
  }
}

/**
 * 全屏窗口的业务 URL：双 ID 启动参数。建窗与单例复用加载共用同一构建,
 * 复用时不重建窗口,也不更换 partition。
 */
export function artifactWindowUrl(spec: Pick<DesktopShellSpec, 'url'>, target: ArtifactRef): string {
  const url = new URL(spec.url)
  url.searchParams.set(ARTIFACT_WINDOW_PARAM, '1')
  url.searchParams.set('sessionId', target.sessionId)
  url.searchParams.set('artifactId', target.artifactId)
  return url.href
}

/**
 * 构建无业务 preload 的全屏窗口参数。
 * @param spec - 仅消费当前 Shell 的同源 webserver URL。
 * @param target - 已校验的双 ID 目标。
 * @param partition - 该窗口独占的非持久 session partition。
 */
export function artifactWindowOptions(
  spec: Pick<DesktopShellSpec, 'url'>,
  target: ArtifactRef,
  partition: string,
): ArtifactWindowOptions {
  return {
    fullscreen: true,
    url: artifactWindowUrl(spec, target),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      partition,
    },
  }
}
