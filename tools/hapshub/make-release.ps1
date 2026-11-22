# Builds the zip people download: a self-contained Windows build of HapsHub, in bin\Release-zip.
# API keys are left out on purpose: anything compiled into a public download can be read back out.
# Data goes to %APPDATA%\HapsHub, not beside the exe, so updating is unzipping over the old folder.
#   powershell -ExecutionPolicy Bypass -File tools\hapshub\make-release.ps1
$ErrorActionPreference = 'Stop'
$root = Resolve-Path "$PSScriptRoot\..\.."
$version = (Select-String -Path "$root\main\AppInfo.cs" -Pattern 'Version = "([^"]+)"').Matches[0].Groups[1].Value
$stage = Join-Path $root "bin\Release-zip\HapsHub"
$zip = Join-Path $root "bin\Release-zip\HapsHub-$version-win-x64.zip"

if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
New-Item -ItemType Directory -Force $stage | Out-Null
dotnet publish "$root\VRCNext.csproj" -c Release -r win-x64 --self-contained true -o $stage -v quiet -nologo `
    -p:VRCNextHypeRateApiKey= -p:VRCNextVrcndbKey=
if ($LASTEXITCODE -ne 0) { throw "The build failed." }

# VRCNext.csproj leaves out linker files, other platforms' libraries and Unity leftovers; fail if any come back.
$stray = Get-ChildItem $stage -Recurse -File -Include *.lib, *.exp, *.so, *.dylib, *.meta
if ($stray) { throw "Files the download shouldn't have: $(($stray | ForEach-Object Name) -join ', ')" }

# A portable marker would move the data beside the exe; the download must not have one.
Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path $stage 'portable.txt'), (Join-Path $stage 'source-commit.txt')
foreach ($needed in 'HapsHub.exe', 'Photino.Native.dll', 'WebView2Loader.dll', 'frontend\index.html', 'LICENSE') {
    if (-not (Test-Path (Join-Path $stage $needed))) {
        if ($needed -eq 'LICENSE') { Copy-Item (Join-Path $root 'LICENSE') $stage } else { throw "The build is missing $needed." }
    }
}
Copy-Item (Join-Path $root 'README.md') (Join-Path $stage 'README.md') -Force
if (Test-Path $zip) { Remove-Item -Force $zip }
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip -CompressionLevel Optimal
$size = [Math]::Round((Get-Item $zip).Length / 1MB, 1)
"Built $zip ($size MB)"
