/** Acceptance-only Electron-main IPC for replacing the Host without replacing the renderer. */
export const ACCEPTANCE_HOST_RESTART_CHANNEL = 'huaanwork:acceptance-host-restart'

export interface AcceptanceHostRestartResult {
  readonly oldPid: number
  readonly newPid: number
}

/** Structural Electron-runtime capability consumed without importing the Electron runtime. */
export interface HostShellAdoptionRuntime {
  beginHostShellAdoption(): void
  completeHostShellAdoption(): void
  cancelHostShellAdoption(): void
}
