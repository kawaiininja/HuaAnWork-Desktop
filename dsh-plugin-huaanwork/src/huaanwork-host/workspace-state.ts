import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const STATE_FILENAME = 'huaanwork-workspace.json'

/**
 * `pendingRoot` 的寿命上限(spec §14 第 23 条残余,Task 6.9):确认框挂起期间进程
 * 被杀(⌘Q)⇒ pendingRoot 已落盘而无裁决可回传,下次启动仍会消费。写入时刻 + 本
 * TTL 把「无限期残留」收窄为「TTL 内残留」,并让残留可诊断(超期在组合期丢弃 +
 * 回报具名理由)。
 *
 * 时刻锚点(评审 F1,Task 6.9 fix round 1):每次写入都带时刻,且**确认被接受时
 * 路由层会以确认时刻重打一次**(workspace.ts)——已裁决切换的年龄因此度量的是
 * 「确认 → 组合」的重启间隙(秒级);对话框挂起期间被杀留下的**未裁决残留**保有
 * 预写时刻,年龄超过 TTL 才在组合期被丢弃。TTL(10 分钟)覆盖正常重启间隙,但
 * 不承诺「永不误伤」:机器挂起等极端情况下,超期丢弃的是长期悬置的意图,方向保守
 * (回落中立根)且必有日志。
 *
 * 与 automations-store 的 `MISSED_GRACE_MS` 同量级(10 分钟)但语义无关——一个是
 * 「错过调度」的宽限,一个是「待切换根」的寿命,故各自持常量,不共享(共享会把
 * 两个不相干的调整耦合在一起)。
 */
export const PENDING_ROOT_TTL_MS = 10 * 60_000

/** 待切换根被丢弃的诊断(组合期经 profile.ts 收进结果,由 main.ts 落日志行)。 */
export interface PendingRootDrop {
  readonly root: string
  /** 诚实人话诊断(含根、写入时刻/年龄与 TTL),组合期诊断与日志行同源。 */
  readonly message: string
}

export interface ReadPendingWorkspaceRootOptions {
  /** 判定时刻,epoch 毫秒(可注入,测试确定性);生产为 Date.now()。 */
  readonly now?: number
  /** 丢弃透出(可选:丢弃判据不依赖它,缺席时照样丢弃,只是无诊断)。 */
  readonly onDrop?: (drop: PendingRootDrop) => void
}

/** 中立根:profile 目录下的 workspace(spec §4.2:旧 $DSH_HOME/workspace 概念落 profile 目录)。 */
export function neutralWorkspaceRoot(profileDir: string): string {
  const root = join(profileDir, 'workspace')
  mkdirSync(root, { recursive: true })
  return root
}

/**
 * 读取待切换根(组合期唯一读取点:profile.ts)。返回 null = 无待切换。
 *
 * 丢弃**只有一条判据**:文件带可解析的 `writtenAt` 且其年龄 > `PENDING_ROOT_TTL_MS`
 * ——典型成因 = 确认框挂起期间进程被杀留下的长残留(超期即回落中立根并回报诊断)。
 *
 * 无 `writtenAt`(或值不可解析)的**旧文件维持既有消费语义**,不改判:这类文件只能
 * 来自本 TTL 之前的构建(一次性的升级过渡;本文档写入路径此后恒带时刻),且组合后
 * 由 huaanwork-host 首个 effect 清除(`{}` 占位),不会长期留存——故「年龄不可知」
 * 不等于「可疑到必须丢弃」,丢弃反而会把升级前那一次**已确认**的切换一并吞掉。
 * 时钟偏移导致 `writtenAt` 在未来时同理按「未超期」处理(绝不因偏移误伤)。
 */
export function readPendingWorkspaceRoot(
  profileDir: string,
  options: ReadPendingWorkspaceRootOptions = {},
): string | null {
  const file = join(profileDir, STATE_FILENAME)
  if (!existsSync(file)) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
  // Minor 2(Task 6.9 fix round 1):属性访问必须在全函数性守卫之后——文件内容恰为
  // 字面 `null` 时 JSON.parse 成功返回 null,旧写法在此抛裸 TypeError。任何非对象
  // (null/标量)一律读回 null,与「任何畸形内容读回 null」的既有语义一致。
  if (parsed === null || typeof parsed !== 'object') return null
  const state = parsed as { pendingRoot?: unknown; writtenAt?: unknown }
  const root = typeof state.pendingRoot === 'string' && state.pendingRoot.length > 0 ? state.pendingRoot : null
  if (root === null) return null

  const now = options.now ?? Date.now()
  const writtenAtText = typeof state.writtenAt === 'string' ? state.writtenAt : undefined
  const writtenAtMs = writtenAtText === undefined ? Number.NaN : Date.parse(writtenAtText)
  if (Number.isNaN(writtenAtMs)) return root

  const ageMs = now - writtenAtMs
  if (ageMs > PENDING_ROOT_TTL_MS) {
    options.onDrop?.({
      root,
      message: `huaanwork-workspace: dropped stale pendingRoot ${root}: written at ${writtenAtText} `
        + `(${String(Math.round(ageMs / 60_000))} minutes ago), over the ${String(PENDING_ROOT_TTL_MS / 60_000)}-minute TTL `
        + `(the restart confirmation was never answered — the process was killed while pending); composition uses the neutral root`,
    })
    return null
  }
  return root
}

/** 组合期已消费 pendingRoot:huaanwork-host apply 的首个 effect 调用本别名清除(不删文件,留 `{}` 占位)。 */
export function clearPendingWorkspaceRoot(profileDir: string): void {
  writePendingWorkspaceRoot(profileDir, null)
}

/**
 * 落盘待切换根:附写入时刻(epoch → ISO 8601 UTC,TTL 判据的原料);
 * `null` = 清除(不删文件,留 `{}` 占位,状态仍可读)。
 *
 * 调用时序(评审 F1):路由层先预写(对话框挂起期间被杀 ⇒ 残留带预写时刻,超期被
 * TTL 抓住),确认被接受时再以确认时刻重打一次——已裁决切换的年龄只度量重启间隙。
 */
export function writePendingWorkspaceRoot(profileDir: string, root: string | null): void {
  const file = join(profileDir, STATE_FILENAME)
  const tmp = `${file}.tmp`
  const payload: Record<string, unknown> = root === null ? {} : { pendingRoot: root, writtenAt: new Date().toISOString() }
  writeFileSync(tmp, `${JSON.stringify(payload)}\n`, 'utf8')
  renameSync(tmp, file)
}
