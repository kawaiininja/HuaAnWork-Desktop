import { Context } from '@deepseek-ai/cordis'

export const HUAANWORK_CONTEXT_PROPS = [
  'huaanworkWorkspaceRoot',
  'huaanworkAllowedOnce',
  'huaanworkDshHome',
  'huaanworkProfileDir',
  'huaanworkUnattended',
  'huaanworkAttachments',
  'huaanworkAgentCatalog',
  'huaanworkApprovals',
  'huaanworkEmit',
  'huaanworkAgentRequest',
] as const

let installed = false

export function installContextHolders(): void {
  if (installed) return
  installed = true

  const dummy = new Context()
  const ReflectProto = Object.getPrototypeOf(dummy.reflect)
  const originalMixin = ReflectProto.mixin

  ReflectProto.mixin = function (source: any, mixins: any) {
    for (const prop of HUAANWORK_CONTEXT_PROPS) {
      if (!this.props[prop]) {
        const privateKey = `_${prop}`
        this.props[prop] = {
          type: 'accessor',
          get() {
            return (this as any).root[privateKey]
          },
          set(value: any) {
            ;(this as any).root[privateKey] = value
            return true
          },
        }
      }
    }
    return originalMixin.call(this, source, mixins)
  }
}

installContextHolders()
