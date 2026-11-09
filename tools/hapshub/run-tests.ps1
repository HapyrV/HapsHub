# Builds Debug, then runs the self-test and the feature test. Prints only what matters.
# Stops leftover Debug test copies first, never the Release copy a real session may be using.
param([switch]$SkipSelfTest, [switch]$SkipFeatures)
$root = Resolve-Path "$PSScriptRoot\..\.."
Set-Location $root
Get-Process HapsHub -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '*\bin\Debug\*' } | ForEach-Object { Stop-Process -Id $_.Id -Force -Confirm:$false }
$build = dotnet build VRCNext.csproj -maxcpucount:2
$build | Select-String ' error |Error\(s\)' | ForEach-Object { $_.Line.Trim() } | Sort-Object -Unique | Select-Object -First 12
if ($LASTEXITCODE -ne 0) { exit 1 }
if (-not $SkipSelfTest) {
    $self = dotnet run --project tools/hapshub/hub-selftest -c Release
    $self | Select-String '^FAIL|error CS|passed|failed' | ForEach-Object { $_.Line } | Select-Object -First 30
}
if (-not $SkipFeatures) {
    $out = Join-Path $env:TEMP 'hapshub-features.txt'
    node tools/hapshub/features-test.mjs *> $out
    Get-Content $out | ForEach-Object { $_.Substring(0, [Math]::Min(500, $_.Length)) } | Where-Object { $_ -notmatch '^ok ' -or $_ -match 'NOT CHECKED' }
    "ok lines: " + (Get-Content $out | Where-Object { $_ -match '^ok ' }).Count
}
