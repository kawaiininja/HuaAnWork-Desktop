param(
  [Parameter(Mandatory = $true)][int]$TargetPid,
  [Parameter(Mandatory = $true)][ValidateSet('suspend', 'resume')]$Action
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class HostLivenessProcessControl {
  [DllImport("ntdll.dll")]
  public static extern uint NtSuspendProcess(IntPtr processHandle);
  [DllImport("ntdll.dll")]
  public static extern uint NtResumeProcess(IntPtr processHandle);
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern IntPtr OpenProcess(uint desiredAccess, bool inheritHandle, int processId);
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool CloseHandle(IntPtr handle);
}
"@
# PROCESS_SUSPEND_RESUME. Enough for NtSuspendProcess on a process we spawned.
$access = [uint32]2048
$handle = [HostLivenessProcessControl]::OpenProcess($access, $false, $TargetPid)
if ($handle -eq [IntPtr]::Zero) {
  $err = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
  throw "OpenProcess $TargetPid failed with Win32 $err"
}
try {
  $status = if ($Action -eq 'suspend') {
    [HostLivenessProcessControl]::NtSuspendProcess($handle)
  } else {
    [HostLivenessProcessControl]::NtResumeProcess($handle)
  }
  if ($status -ne 0) { throw "$Action returned NTSTATUS $status" }
} finally {
  [void][HostLivenessProcessControl]::CloseHandle($handle)
}
Write-Output "$Action $TargetPid ok"
