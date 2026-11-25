. (Join-Path $PSScriptRoot 'lib.ps1')

# first run creates settings.json
StartA 'S0'
KillAll
Set-Settings @{ close_to_tray = $true; lightweight_mode = $true; log_app_enabled = $true }

function Lightweight($tag, $rounds) {
  StartA $tag
  for ($i = 1; $i -le $rounds; $i++) {
    Close-Main "$tag-$i"
    $ok = Launch2 "$tag-relaunch-$i"
    if (-not $ok) {
      Launch2 "$tag-pileup-$i" 8000 | Out-Null
      Stacks $script:A.Id "$tag-primary"
      $sec = Procs | Where-Object { $_.ProcessName -eq 'Zephyr' -and $_.Id -ne $script:A.Id } | Select-Object -First 1
      if ($sec) { Stacks $sec.Id "$tag-second" }
      return $false
    }
  }
  return $true
}

# A: current code path (recreate runs inside the single-instance WM_COPYDATA handler)
Remove-Item Env:ZEPHYR_PROBE_DEFER -ErrorAction SilentlyContinue
$a = Lightweight 'A-inline' 3
L "RESULT A-inline ok=$a"
KillAll

# B: same recreate, deferred out of the handler (posted to the event loop from another thread)
$env:ZEPHYR_PROBE_DEFER = '1'
$b = Lightweight 'B-deferred' 5
L "RESULT B-deferred ok=$b"
KillAll

# A again to make sure A's hang is repeatable
Remove-Item Env:ZEPHYR_PROBE_DEFER -ErrorAction SilentlyContinue
$a2 = Lightweight 'A2-inline' 3
L "RESULT A2-inline ok=$a2"
KillAll

Get-ChildItem -Force -Recurse $dir -Include *.log | ForEach-Object { Copy-Item $_.FullName (Join-Path $out ($_.Directory.Name + '-' + $_.Name)) }
L 'done'
