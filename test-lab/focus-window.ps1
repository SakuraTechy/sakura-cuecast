param(
  [Parameter(Mandatory = $true)]
  [int]$RootPid
)

$ErrorActionPreference = 'SilentlyContinue'

if ($RootPid -le 0) {
  exit 0
}

$pidSet = @{}
$queue = New-Object System.Collections.Queue
$queue.Enqueue($RootPid)
$pidSet[$RootPid] = $true
$rootStartedAt = (Get-Date).AddSeconds(-20)

$rootProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$RootPid"
if ($rootProcess -and $rootProcess.CreationDate) {
  $rootStartedAt = [Management.ManagementDateTimeConverter]::ToDateTime($rootProcess.CreationDate).AddSeconds(-5)
}

while ($queue.Count -gt 0) {
  $currentPid = [int]$queue.Dequeue()
  Get-CimInstance Win32_Process -Filter "ParentProcessId=$currentPid" | ForEach-Object {
    $childPid = [int]$_.ProcessId
    if (-not $pidSet.ContainsKey($childPid)) {
      $pidSet[$childPid] = $true
      $queue.Enqueue($childPid)
    }
  }
}

Add-Type @"
using System;
using System.Runtime.InteropServices;

public static class CueCastWindowFocus {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

  [DllImport("user32.dll")]
  public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

  [DllImport("user32.dll")]
  public static extern bool IsWindowVisible(IntPtr hWnd);

  [DllImport("user32.dll")]
  public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);

  [DllImport("user32.dll")]
  public static extern bool IsIconic(IntPtr hWnd);

  [DllImport("user32.dll")]
  public static extern bool IsZoomed(IntPtr hWnd);

  [DllImport("user32.dll")]
  public static extern bool BringWindowToTop(IntPtr hWnd);

  [DllImport("user32.dll")]
  public static extern bool SetForegroundWindow(IntPtr hWnd);

  [DllImport("user32.dll")]
  public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, UInt32 uFlags);

  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();

  [DllImport("user32.dll")]
  public static extern uint GetCurrentThreadId();

  [DllImport("user32.dll")]
  public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);

  [DllImport("user32.dll")]
  public static extern void SwitchToThisWindow(IntPtr hWnd, bool fAltTab);

  [DllImport("user32.dll")]
  public static extern void keybd_event(byte bVk, byte bScan, UInt32 dwFlags, UIntPtr dwExtraInfo);

  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
}
"@

$SW_RESTORE = 9
$SW_SHOWMAXIMIZED = 3
$VK_MENU = 0x12
$KEYEVENTF_KEYUP = 0x0002
$HWND_TOPMOST = [IntPtr]::new(-1)
$HWND_NOTOPMOST = [IntPtr]::new(-2)
$SWP_NOSIZE = 0x0001
$SWP_NOMOVE = 0x0002
$SWP_SHOWWINDOW = 0x0040

$targets = New-Object System.Collections.Generic.List[System.IntPtr]
$windowPids = New-Object System.Collections.Generic.HashSet[int]

[CueCastWindowFocus]::EnumWindows({
  param($hWnd, $lParam)
  if (-not [CueCastWindowFocus]::IsWindowVisible($hWnd)) {
    return $true
  }

  [uint32]$windowPid = 0
  [void][CueCastWindowFocus]::GetWindowThreadProcessId($hWnd, [ref]$windowPid)
  if ($pidSet.ContainsKey([int]$windowPid)) {
    [void]$windowPids.Add([int]$windowPid)
    $targets.Add($hWnd)
    return $true
  }

  $process = Get-Process -Id ([int]$windowPid)
  if ($process -and $process.ProcessName -match '^(chrome|chromium|msedge)$' -and $process.StartTime -ge $rootStartedAt) {
    [void]$windowPids.Add([int]$windowPid)
    $targets.Add($hWnd)
  }
  return $true
}, [IntPtr]::Zero) | Out-Null

$shell = New-Object -ComObject WScript.Shell

function Invoke-ForegroundWindow {
  param(
    [Parameter(Mandatory = $true)]
    [IntPtr]$WindowHandle
  )

  [uint32]$targetPid = 0
  $targetThread = [CueCastWindowFocus]::GetWindowThreadProcessId($WindowHandle, [ref]$targetPid)
  $foreground = [CueCastWindowFocus]::GetForegroundWindow()
  [uint32]$foregroundPid = 0
  $foregroundThread = [CueCastWindowFocus]::GetWindowThreadProcessId($foreground, [ref]$foregroundPid)
  $currentThread = [CueCastWindowFocus]::GetCurrentThreadId()

  if ($foregroundThread -ne 0) {
    [void][CueCastWindowFocus]::AttachThreadInput($currentThread, $foregroundThread, $true)
  }
  if ($targetThread -ne 0) {
    [void][CueCastWindowFocus]::AttachThreadInput($currentThread, $targetThread, $true)
  }

  [CueCastWindowFocus]::keybd_event($VK_MENU, 0, 0, [UIntPtr]::Zero)
  [CueCastWindowFocus]::keybd_event($VK_MENU, 0, $KEYEVENTF_KEYUP, [UIntPtr]::Zero)

  if ([CueCastWindowFocus]::IsIconic($WindowHandle)) {
    [void][CueCastWindowFocus]::ShowWindowAsync($WindowHandle, $SW_RESTORE)
  } elseif ([CueCastWindowFocus]::IsZoomed($WindowHandle)) {
    [void][CueCastWindowFocus]::ShowWindowAsync($WindowHandle, $SW_SHOWMAXIMIZED)
  }
  [void][CueCastWindowFocus]::SetWindowPos($WindowHandle, $HWND_TOPMOST, 0, 0, 0, 0, $SWP_NOMOVE -bor $SWP_NOSIZE -bor $SWP_SHOWWINDOW)
  [void][CueCastWindowFocus]::SetWindowPos($WindowHandle, $HWND_NOTOPMOST, 0, 0, 0, 0, $SWP_NOMOVE -bor $SWP_NOSIZE -bor $SWP_SHOWWINDOW)
  [void][CueCastWindowFocus]::BringWindowToTop($WindowHandle)
  [void][CueCastWindowFocus]::SetForegroundWindow($WindowHandle)
  [CueCastWindowFocus]::SwitchToThisWindow($WindowHandle, $true)

  if ($targetThread -ne 0) {
    [void][CueCastWindowFocus]::AttachThreadInput($currentThread, $targetThread, $false)
  }
  if ($foregroundThread -ne 0) {
    [void][CueCastWindowFocus]::AttachThreadInput($currentThread, $foregroundThread, $false)
  }
}

foreach ($hWnd in $targets) {
  Invoke-ForegroundWindow -WindowHandle $hWnd
  Start-Sleep -Milliseconds 120
}

foreach ($windowPid in $windowPids) {
  [void]$shell.AppActivate([int]$windowPid)
  Start-Sleep -Milliseconds 120
}

if ($targets.Count -gt 0) {
  Write-Output "focused $($targets.Count) window(s), pid(s): $([string]::Join(',', $windowPids))"
} else {
  Write-Output "focused 0 window(s)"
}
