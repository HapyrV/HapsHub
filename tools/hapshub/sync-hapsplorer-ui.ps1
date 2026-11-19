# Copies the Hapsplorer web UI into the Hapsplorer plugin page (frontend/modules/tools/hapsplorer/app).
# The UI checks the server's API version itself and says "Update needed" when this copy is too old.
param([string]$Hapsplorer = "D:\VR\Hapsplorer")
$src = Join-Path $Hapsplorer "src\Hapsplorer.Server\wwwroot"
$dst = Join-Path $PSScriptRoot "..\..\frontend\modules\tools\hapsplorer\app"
foreach ($f in "index.html", "app.js", "app.css") { Copy-Item (Join-Path $src $f) (Join-Path $dst $f) -Force }
$commit = git -C $Hapsplorer rev-parse --short HEAD
Write-Host "Copied the Hapsplorer UI from $src (commit $commit)."
