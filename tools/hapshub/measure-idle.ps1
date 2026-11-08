param([string]$Name = 'VRCNext', [int]$Seconds = 60)

function Get-Tree([string]$RootName) {
    $all = Get-CimInstance Win32_Process
    $ids = [System.Collections.Generic.HashSet[uint32]]::new()
    $all | Where-Object { $_.Name -eq "$RootName.exe" } | ForEach-Object { [void]$ids.Add($_.ProcessId) }
    do {
        $added = $false
        foreach ($p in $all) {
            if ($ids.Contains($p.ParentProcessId) -and $ids.Add($p.ProcessId)) { $added = $true }
        }
    } while ($added)
    $all | Where-Object { $ids.Contains($_.ProcessId) }
}

$before = Get-Tree $Name
if (-not $before) { Write-Output "no process named $Name"; exit 1 }
$t0 = Get-Date
$cpu0 = @{}
foreach ($p in $before) { $cpu0[$p.ProcessId] = [uint64]$p.KernelModeTime + [uint64]$p.UserModeTime }

Start-Sleep -Seconds $Seconds

$after = Get-Tree $Name
$elapsed = ((Get-Date) - $t0).TotalSeconds
$cores = [Environment]::ProcessorCount
$rows = foreach ($p in $after) {
    $used = [uint64]$p.KernelModeTime + [uint64]$p.UserModeTime
    $base = if ($cpu0.ContainsKey($p.ProcessId)) { $cpu0[$p.ProcessId] } else { 0 }
    $proc = Get-Process -Id $p.ProcessId -ErrorAction SilentlyContinue
    [pscustomobject]@{
        Name   = $p.Name
        Id     = $p.ProcessId
        WsMB   = [math]::Round($p.WorkingSetSize / 1MB, 1)
        PrivMB = if ($proc) { [math]::Round($proc.PrivateMemorySize64 / 1MB, 1) } else { 0 }
        CpuPct = [math]::Round((($used - $base) / 1e7) / $elapsed / $cores * 100, 2)
    }
}
$rows | Sort-Object PrivMB -Descending | Format-Table -AutoSize | Out-String -Width 120

$gpuPct = 0; $gpuMem = 0
try {
    $idPattern = ($rows.Id | ForEach-Object { "pid_$($_)_" }) -join '|'
    $u = (Get-Counter '\GPU Engine(*)\Utilization Percentage' -ErrorAction Stop).CounterSamples
    $gpuPct = [math]::Round((($u | Where-Object { $_.InstanceName -match $idPattern }).CookedValue | Measure-Object -Sum).Sum, 2)
    $m = (Get-Counter '\GPU Process Memory(*)\Dedicated Usage' -ErrorAction Stop).CounterSamples
    $gpuMem = [math]::Round((($m | Where-Object { $_.InstanceName -match $idPattern }).CookedValue | Measure-Object -Sum).Sum / 1MB, 1)
} catch { Write-Output "gpu counters unavailable: $($_.Exception.Message)" }

$main = Get-Process -Name $Name -ErrorAction SilentlyContinue | Sort-Object WorkingSet64 -Descending | Select-Object -First 1
Write-Output ("TOTAL procs={0} ws={1} MB private={2} MB cpu={3}% (of {4} cores, {5}s window) gpu={6}% gpuMem={7} MB" -f `
    @($rows).Count, [math]::Round(($rows.WsMB | Measure-Object -Sum).Sum, 0), [math]::Round(($rows.PrivMB | Measure-Object -Sum).Sum, 0), `
    [math]::Round(($rows.CpuPct | Measure-Object -Sum).Sum, 2), $cores, [int]$elapsed, $gpuPct, $gpuMem)
Write-Output ("main path={0} started={1} uptime={2:n0} min windowVisible={3} now={4}" -f $main.Path, $main.StartTime, ((Get-Date) - $main.StartTime).TotalMinutes, ($main.MainWindowHandle -ne 0), (Get-Date))
