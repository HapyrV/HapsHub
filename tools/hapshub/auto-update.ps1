# HapsHub starts this when the repository has a newer commit than the copy you opened. It waits for that copy to
# close, rebuilds it, and opens it again. If the build fails, the copy you had opens instead, and the reason is saved.
# Your data isn't touched.
param(
    [Parameter(Mandatory)] [string] $Root,
    [Parameter(Mandatory)] [string] $Exe,
    [Parameter(Mandatory)] [int] $WaitPid,
    [Parameter(Mandatory)] [string] $LogFile,
    # The arguments HapsHub was opened with, one per line, base64 encoded.
    [string] $PassArgs = ''
)

$Host.UI.RawUI.WindowTitle = 'Updating HapsHub'
Write-Host 'HapsHub is updating to the newest version.'
Write-Host 'It opens again by itself when this is done, in about a minute.'
Write-Host ''

# The copy that started this, plus its helpers (watchdog, VR overlay), must be gone before the files change.
Wait-Process -Id $WaitPid -Timeout 30 -ErrorAction SilentlyContinue
$deadline = (Get-Date).AddSeconds(30)
while ((Get-Date) -lt $deadline) {
    $left = Get-Process -Name HapsHub -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $Exe }
    if (-not $left) { break }
    Start-Sleep -Milliseconds 500
}

$passed = @()
if ($PassArgs) { $passed = @([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($PassArgs)) -split "`n" | Where-Object { $_ }) }
# Start-Process joins arguments with spaces, so any with a space are quoted here.
$open = @('--no-update-check') + @($passed | ForEach-Object { if ($_ -match '\s') { '"' + $_ + '"' } else { $_ } })
$output = Join-Path $env:TEMP 'hapshub-update-build.log'

Write-Host 'Building...'
& dotnet build (Join-Path $Root 'VRCNext.csproj') -c Release -maxcpucount:2 -v quiet -nologo *> $output
$built = $LASTEXITCODE -eq 0

if ($built) {
    Write-Host 'Done. Opening HapsHub...'
    Start-Process -FilePath $Exe -ArgumentList (@('--updated') + $open)
    exit 0
}

New-Item -ItemType Directory -Force -Path (Split-Path $LogFile) | Out-Null
"Update on $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') failed to build. Nothing changed." | Set-Content -Path $LogFile -Encoding utf8
Get-Content $output | Add-Content -Path $LogFile -Encoding utf8
Write-Host 'The build failed, so HapsHub opens as it was. The reason is saved in:'
Write-Host $LogFile
Start-Process -FilePath $Exe -ArgumentList (@('--update-failed') + $open)
Start-Sleep -Seconds 4
exit 1
