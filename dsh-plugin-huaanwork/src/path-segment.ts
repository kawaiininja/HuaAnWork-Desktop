/** 单路径段校验：Artifact 存储目录名、全屏启动参数与原生桥双 ID 共用同一约束。 */
export function isSinglePathSegment(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false
  if (value === '.' || value === '..') return false
  if (/[/\\:*?"<>|\x00-\x1f]/.test(value)) return false
  return !value.endsWith('.') && !value.endsWith(' ')
}