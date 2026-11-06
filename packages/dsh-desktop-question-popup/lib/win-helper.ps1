# DSH desktop question popup -- window control helper (Windows PowerShell 5.1 / pwsh 7).
#
# Protocol: one JSON object per line on stdin, one JSON result per line on stdout.
#   request : {"id":1,"op":"ping"}                                 (id echoes back)
#   response: {"id":1,"ok":true,"result":{...}} / {"id":1,"ok":false,"error":"..."}
#
# Ops: ping / workarea / find / show / hide / place / rect / status / list / quit
#
# The window is located by title prefix ("DSH") among top-level windows whose class
# is Chrome_WidgetWin_1 (Edge/Chromium app window), restricted to a ProcessId when
# the caller supplies one. Topmost placement uses SetWindowPos(HWND_TOPMOST, ...)
# because Chromium's --always-on-top does not set WS_EX_TOPMOST.

$ErrorActionPreference = 'Stop'

try {
  [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
} catch {
  # Older hosts may keep the default encoding; JSON is still ASCII-escaped by ConvertTo-Json.
}

$script:Utf8NoBom = $null

$win32Source = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class DshWin {
    public const int SW_HIDE = 0;
    public const int SW_SHOWNOACTIVATE = 4;
    public const int SW_SHOW = 5;
    public const int GWL_EXSTYLE = -20;
    public const int WS_EX_TOPMOST = 0x00000008;
    public const int WS_EX_TOOLWINDOW = 0x00000080;
    public const uint SWP_NOSIZE = 0x0001;
    public const uint SWP_NOMOVE = 0x0002;
    public const uint SWP_NOACTIVATE = 0x0010;
    public const uint SWP_SHOWWINDOW = 0x0040;
    public const uint SPI_GETWORKAREA = 0x0030;
    public static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
    public static readonly IntPtr HWND_TOP = IntPtr.Zero;

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

    public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr hWnd, int index);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int max);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassNameW(IntPtr hWnd, StringBuilder text, int max);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll")] public static extern bool SystemParametersInfo(uint action, uint param, out RECT rect, uint winIni);

    public static string Title(IntPtr hWnd) {
        StringBuilder sb = new StringBuilder(1024);
        GetWindowTextW(hWnd, sb, 1024);
        return sb.ToString();
    }

    public static string ClassOf(IntPtr hWnd) {
        StringBuilder sb = new StringBuilder(256);
        GetClassNameW(hWnd, sb, 256);
        return sb.ToString();
    }

    public static uint ProcessId(IntPtr hWnd) {
        uint pid;
        GetWindowThreadProcessId(hWnd, out pid);
        return pid;
    }

    public static bool IsTopmost(IntPtr hWnd) {
        return (GetWindowLong(hWnd, GWL_EXSTYLE) & WS_EX_TOPMOST) != 0;
    }

    public static List<IntPtr> AllWindows() {
        List<IntPtr> found = new List<IntPtr>();
        EnumWindows(delegate(IntPtr hWnd, IntPtr lParam) { found.Add(hWnd); return true; }, IntPtr.Zero);
        return found;
    }

    public static bool WorkArea(out RECT rect) {
        return SystemParametersInfo(SPI_GETWORKAREA, 0, out rect, 0);
    }
}
'@

Add-Type -TypeDefinition $win32Source -Language CSharp | Out-Null

function Get-WorkArea {
  $rect = New-Object DshWin+RECT
  $viaForms = $false
  try {
    Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop | Out-Null
    $area = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
    $rect.Left = $area.X
    $rect.Top = $area.Y
    $rect.Right = $area.X + $area.Width
    $rect.Bottom = $area.Y + $area.Height
    $viaForms = $true
  } catch {
    $viaForms = $false
  }
  if (-not $viaForms) {
    if (-not [DshWin]::WorkArea([ref]$rect)) { throw 'cannot read the desktop work area' }
  }
  return @{
    x      = [int]$rect.Left
    y      = [int]$rect.Top
    width  = [int]($rect.Right - $rect.Left)
    height = [int]($rect.Bottom - $rect.Top)
  }
}

function Get-RectOf([IntPtr]$handle) {
  $rect = New-Object DshWin+RECT
  if (-not [DshWin]::GetWindowRect($handle, [ref]$rect)) { return $null }
  return @{
    x      = [int]$rect.Left
    y      = [int]$rect.Top
    width  = [int]($rect.Right - $rect.Left)
    height = [int]($rect.Bottom - $rect.Top)
  }
}

function Find-PopupWindow([string]$prefix, [int]$processId) {
  $best = $null
  foreach ($handle in [DshWin]::AllWindows()) {
    if ([DshWin]::ClassOf($handle) -ne 'Chrome_WidgetWin_1') { continue }
    $title = [DshWin]::Title($handle)
    if ([string]::IsNullOrEmpty($title)) { continue }
    if (-not $title.StartsWith($prefix, [System.StringComparison]::Ordinal)) { continue }
    if ($processId -gt 0 -and [DshWin]::ProcessId($handle) -ne $processId) { continue }
    $best = $handle
    if ([DshWin]::IsWindowVisible($handle)) { break }
  }
  return $best
}

function Describe-Window($handle) {
  if ($null -eq $handle) {
    return @{ hwnd = 0; exists = $false; visible = $false; topmost = $false; title = ''; processId = 0; rect = $null }
  }
  $ptr = $handle
  if ($ptr -isnot [System.IntPtr]) { $ptr = ConvertTo-Handle $ptr }
  if ($ptr -eq [IntPtr]::Zero -or -not [DshWin]::IsWindow($ptr)) {
    return @{ hwnd = 0; exists = $false; visible = $false; topmost = $false; title = ''; processId = 0; rect = $null }
  }
  return @{
    hwnd      = [int64]$ptr.ToInt64()
    exists    = $true
    visible   = [bool][DshWin]::IsWindowVisible($ptr)
    topmost   = [bool][DshWin]::IsTopmost($ptr)
    title     = [DshWin]::Title($ptr)
    processId = [int][DshWin]::ProcessId($ptr)
    rect      = (Get-RectOf $ptr)
  }
}

function ConvertTo-Handle($value) {
  return (New-Object System.IntPtr([int64]$value))
}

$quit = $false

while (-not $quit) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $line = $line.Trim()
  if ($line.Length -eq 0) { continue }

  $id = 0
  $ok = $true
  $result = @{}
  $message = $null

  try {
    $request = $line | ConvertFrom-Json
    if ($null -eq $request) { throw 'empty request' }
    if ($null -ne $request.id) { $id = [int]$request.id }

    switch ([string]$request.op) {
      'ping' {
        $result = @{ pong = $true; pid = $PID; psVersion = $PSVersionTable.PSVersion.ToString() }
      }
      'workarea' {
        $result = Get-WorkArea
      }
      'find' {
        $prefix = 'DSH'
        if ($null -ne $request.prefix) { $prefix = [string]$request.prefix }
        $processId = 0
        if ($null -ne $request.processId) { $processId = [int]$request.processId }
        $handle = Find-PopupWindow $prefix $processId
        $result = Describe-Window $handle
      }
      'show' {
        $handle = ConvertTo-Handle $request.hwnd
        if (-not [DshWin]::IsWindow($handle)) { throw 'window handle is no longer valid' }
        $flags = [uint32]([DshWin]::SWP_NOACTIVATE -bor [DshWin]::SWP_SHOWWINDOW)
        $insertAfter = [DshWin]::HWND_TOP
        if ($request.topmost -eq $true) { $insertAfter = [DshWin]::HWND_TOPMOST }
        $placed = [DshWin]::SetWindowPos(
          $handle, $insertAfter,
          [int]$request.x, [int]$request.y, [int]$request.width, [int]$request.height,
          $flags)
        if (-not $placed) { throw 'SetWindowPos failed' }
        [DshWin]::ShowWindow($handle, [DshWin]::SW_SHOWNOACTIVATE) | Out-Null
        if ($request.activate -eq $true) { [DshWin]::ShowWindow($handle, [DshWin]::SW_SHOW) | Out-Null }
        if ($request.topmost -eq $true) {
          # Measured: the topmost bit only sticks when it is asserted as a separate
          # call AFTER the window is shown (Chromium reverts it otherwise).
          Start-Sleep -Milliseconds 120
          [DshWin]::SetWindowPos($handle, [DshWin]::HWND_TOPMOST, 0, 0, 0, 0, [uint32]([DshWin]::SWP_NOMOVE -bor [DshWin]::SWP_NOSIZE -bor [DshWin]::SWP_NOACTIVATE)) | Out-Null
        }
        $result = Describe-Window $handle
      }
      'topmost' {
        $handle = ConvertTo-Handle $request.hwnd
        if (-not [DshWin]::IsWindow($handle)) { throw 'window handle is no longer valid' }
        $placed = [DshWin]::SetWindowPos($handle, [DshWin]::HWND_TOPMOST, 0, 0, 0, 0, [uint32]([DshWin]::SWP_NOMOVE -bor [DshWin]::SWP_NOSIZE -bor [DshWin]::SWP_NOACTIVATE))
        if (-not $placed) { throw 'SetWindowPos failed' }
        $result = Describe-Window $handle
      }
      'hide' {
        $handle = ConvertTo-Handle $request.hwnd
        if ([DshWin]::IsWindow($handle)) {
          [DshWin]::ShowWindow($handle, [DshWin]::SW_HIDE) | Out-Null
        }
        $result = Describe-Window $handle
      }
      'place' {
        $handle = ConvertTo-Handle $request.hwnd
        if (-not [DshWin]::IsWindow($handle)) { throw 'window handle is no longer valid' }
        $flags = [uint32]([DshWin]::SWP_NOACTIVATE -bor [DshWin]::SWP_SHOWWINDOW)
        $placed = [DshWin]::SetWindowPos(
          $handle, [DshWin]::HWND_TOPMOST,
          [int]$request.x, [int]$request.y, [int]$request.width, [int]$request.height,
          $flags)
        if (-not $placed) { throw 'SetWindowPos failed' }
        $result = Describe-Window $handle
      }
      'rect' {
        $result = Describe-Window (ConvertTo-Handle $request.hwnd)
      }
      'status' {
        $result = Describe-Window (ConvertTo-Handle $request.hwnd)
      }
      'list' {
        $rows = @()
        foreach ($handle in [DshWin]::AllWindows()) {
          if ([DshWin]::ClassOf($handle) -ne 'Chrome_WidgetWin_1') { continue }
          $title = [DshWin]::Title($handle)
          if ([string]::IsNullOrEmpty($title)) { continue }
          $rows += @{ hwnd = [int64]$handle.ToInt64(); title = $title; processId = [int][DshWin]::ProcessId($handle); visible = [bool][DshWin]::IsWindowVisible($handle) }
        }
        $result = @{ windows = $rows }
      }
      'quit' {
        $quit = $true
        $result = @{ bye = $true }
      }
      default {
        throw ("unknown op: " + [string]$request.op)
      }
    }
  } catch {
    $ok = $false
    $message = $_.Exception.Message
  }

  $response = @{ id = $id; ok = $ok }
  if ($ok) { $response.result = $result } else { $response.error = $message }
  [Console]::Out.WriteLine(($response | ConvertTo-Json -Compress -Depth 8))
  [Console]::Out.Flush()
}
