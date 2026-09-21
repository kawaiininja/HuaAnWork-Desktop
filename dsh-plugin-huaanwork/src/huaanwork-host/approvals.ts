export type ApprovalResult = 'allowed-once' | 'rejected' | 'unavailable' | 'cancelled'
export type ApprovalMap = Map<string, (result: ApprovalResult) => void>

export function registerApproval(
  pendingApprovals: ApprovalMap,
  approvalRequestId: string,
): Promise<ApprovalResult> {
  if (!approvalRequestId) throw new Error('approvalRequestId is required')
  if (pendingApprovals.has(approvalRequestId)) {
    throw new Error(`approval request ${approvalRequestId} is already pending`)
  }

  return new Promise((resolve) => {
    pendingApprovals.set(approvalRequestId, resolve)
  })
}

export function resolveApproval(
  pendingApprovals: ApprovalMap,
  approvalRequestId: string,
  result: ApprovalResult,
): boolean {
  const resolve = pendingApprovals.get(approvalRequestId)
  if (!resolve) return false

  pendingApprovals.delete(approvalRequestId)
  resolve(result)
  return true
}
