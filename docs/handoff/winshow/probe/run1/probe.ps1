$ErrorActionPreference = 'Continue'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System; using System.Text; using System.Collections.Generic; using System.Runtime.InteropServices;
public static class W {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsHungAppWindow(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindow(string c, string t);
  [DllImport("user32.dll")] public static extern IntPtr SendMessageTimeout(IntPtr h, uint m, IntPtr w, IntPtr l, uint f, uint t, out IntPtr r);
  public struct RECT { public int L, T, R, B; }
  public static List<string> List(uint pid) {
    var res = new List<string>();
    EnumWindows((h, l) => { uint p; GetWindowThreadProcessId(h, out p); if (p == pid) { var t = new StringBuilder(256); GetWindowText(h, t, 256); var c = new StringBuilder(256); GetClassName(h, c, 256); RECT r; GetWindowRect(h, out r); res.Add(String.Format("  hwnd={0} title='{1}' class='{2}' vis={3} min={4} rect={5},{6},{7},{8}", h.ToInt64(), t, c, IsWindowVisible(h), IsIconic(h), r.L, r.T, r.R, r.B)); } return true; }, IntPtr.Zero);
    return res;
  }
  public static IntPtr MainOf(uint pid) { IntPtr found = IntPtr.Zero; EnumWindows((h,l)=>{ uint p; GetWindowThreadProcessId(h,out p); if(p==pid){ var t=new StringBuilder(256); GetWindowText(h,t,256); if(t.ToString()=="Zephyr"){found=h; return false;} } return true;}, IntPtr.Zero); return found; }
  public static string Ping(IntPtr h) { if (h == IntPtr.Zero) return "no-window"; IntPtr r; var ok = SendMessageTimeout(h, 0, IntPtr.Zero, IntPtr.Zero, 2, 3000, out r); return ok == IntPtr.Zero ? "NO-REPLY(3s)" : "replied"; }
}
"@

$out = Join-Path $env:RUNNER_TEMP 'out'
New-Item -ItemType Directory -Force $out | Out-Null
$log = Join-Path $out 'probe.log'
function L($m) { $line = "[{0:HH:mm:ss}] {1}" -f (Get-Date), $m; Write-Host $line; Add-Content $log $line }

$zip = Join-Path $env:RUNNER_TEMP 'Zephyr_x64-portable.zip'
$root = Join-Path $env:RUNNER_TEMP 'Z'
Expand-Archive $zip $root -Force
$exe = (Get-ChildItem $root -Recurse -Filter Zephyr.exe | Select-Object -First 1).FullName
$dir = Split-Path $exe
L "exe=$exe"
Get-ChildItem -Force $dir | ForEach-Object { L ("  " + $_.Name) }
if (-not (Test-Path (Join-Path $dir '.portable'))) { New-Item (Join-Path $dir '.portable') -ItemType File | Out-Null; L 'created .portable' }
$id = 'com.zephyr.desktop'
try { $id = (Get-Content (Join-Path $env:GITHUB_WORKSPACE 'id.txt') -ErrorAction Stop).Trim() } catch {}

$script:snapN = 0
function Snap($name) {
  try {
    $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
    $script:snapN++
    $bmp.Save((Join-Path $out ("{0:D2}-{1}.png" -f $script:snapN, $name)))
    $g.Dispose(); $bmp.Dispose()
  } catch { L "snap failed: $_" }
}

function Procs { Get-Process | Where-Object { $_.Path -and $_.Path.StartsWith($dir, 'OrdinalIgnoreCase') } }

function State($tag) {
  L "--- state: $tag"
  foreach ($p in (Procs | Sort-Object StartTime)) {
    L ("  proc {0} pid={1} start={2:HH:mm:ss} responding={3}" -f $p.ProcessName, $p.Id, $p.StartTime, $p.Responding)
  }
  $siw = [W]::FindWindow("$id-sic", "$id-siw")
  if ($siw -ne [IntPtr]::Zero) { [uint32]$sp = 0; [W]::GetWindowThreadProcessId($siw, [ref]$sp) | Out-Null; L ("  single-instance window pid={0} ping={1}" -f $sp, [W]::Ping($siw)) } else { L '  single-instance window: not found' }
  if ($script:A) {
    foreach ($w in [W]::List([uint32]$script:A.Id)) { if ($w -notmatch "class='(IME|MSCTFIME UI|GDI\+ Hook Window Class)'") { L $w } }
    $m = [W]::MainOf([uint32]$script:A.Id)
    if ($m -ne [IntPtr]::Zero) { L ("  main window hwnd={0} visible={1} minimized={2} hung={3} ping={4}" -f $m.ToInt64(), [W]::IsWindowVisible($m), [W]::IsIconic($m), [W]::IsHungAppWindow($m), [W]::Ping($m)) } else { L '  main window: none' }
  }
}

function StartA($tag) {
  $script:A = Start-Process $exe -WorkingDirectory $dir -PassThru
  L "started primary pid=$($script:A.Id) ($tag)"
  Start-Sleep 35
  State "$tag after start"
  Snap "$tag-start"
}

function Launch2($tag, $waitMs = 20000) {
  $p = Start-Process $exe -WorkingDirectory $dir -PassThru
  $exited = $p.WaitForExit($waitMs)
  if ($exited) { L "second launch [$tag] pid=$($p.Id) exited code=$($p.ExitCode)" } else { L "second launch [$tag] pid=$($p.Id) STILL RUNNING after $waitMs ms" }
  Start-Sleep 3
  State "$tag after second launch"
  Snap "$tag-relaunch"
  return $exited
}

function KillAll { Procs | Stop-Process -Force -ErrorAction SilentlyContinue; Start-Sleep 3; $script:A = $null }

function Close-Main($tag) {
  $m = [W]::MainOf([uint32]$script:A.Id)
  L "WM_CLOSE to main window hwnd=$($m.ToInt64()) ($tag)"
  [W]::PostMessage($m, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
  Start-Sleep 5
  State "$tag after close"
}

function Set-Settings($h) {
  $f = Join-Path $dir 'settings.json'
  $s = Get-Content $f -Raw | ConvertFrom-Json
  foreach ($k in $h.Keys) { $s | Add-Member -NotePropertyName $k -NotePropertyValue $h[$k] -Force }
  $s | ConvertTo-Json -Depth 64 | Set-Content $f -Encoding utf8
  L ("settings: " + (($h.GetEnumerator() | ForEach-Object { "$($_.Key)=$($_.Value)" }) -join ', '))
}

# S1 baseline (default settings)
StartA 'S1'
Launch2 'S1-visible' | Out-Null
KillAll
if (-not (Test-Path (Join-Path $dir 'settings.json'))) { L 'no settings.json in exe dir'; Get-ChildItem -Force -Recurse $dir -Depth 1 | ForEach-Object { L ("  " + $_.FullName) } }
Set-Settings @{ close_to_tray = $true; lightweight_mode = $false; log_app_enabled = $true }

# S2 hidden to tray
StartA 'S2'
Close-Main 'S2'
Launch2 'S2-hidden' | Out-Null
KillAll

# S3 lightweight mode (window destroyed on close)
Set-Settings @{ close_to_tray = $true; lightweight_mode = $true; log_app_enabled = $true }
StartA 'S3'
for ($i = 1; $i -le 3; $i++) {
  Close-Main "S3-$i"
  $ok = Launch2 "S3-lightweight-$i"
  if (-not $ok) { foreach ($j in 1..3) { Launch2 "S3-pileup-$i-$j" 8000 | Out-Null } ; break }
}

# S4 minimized long enough for timer throttling, then relaunch
$m = [W]::MainOf([uint32]$script:A.Id)
if ($m -ne [IntPtr]::Zero) {
  [W]::ShowWindow($m, 6) | Out-Null
  L 'minimized main window; waiting 7 minutes'
  Start-Sleep 420
  State 'S4 minimized'
  Launch2 'S4-minimized' | Out-Null
}
KillAll

Get-ChildItem -Force -Recurse $dir -Include *.log | ForEach-Object { Copy-Item $_.FullName (Join-Path $out ($_.Directory.Name + '-' + $_.Name)) }
Copy-Item (Join-Path $dir 'settings.json') $out -ErrorAction SilentlyContinue
L 'done'
