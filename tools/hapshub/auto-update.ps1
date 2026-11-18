# HapsHub starts this when the repository has a newer commit than the copy you opened. It shows a small update window
# (like Discord's), waits for that copy to close, rebuilds it, and opens it again. If the build fails, the copy you had
# opens instead, and the reason is saved. Your data isn't touched.
# Keep this file ASCII: Windows PowerShell 5.1 reads files without a BOM in the ANSI code page.
param(
    [Parameter(Mandatory)] [string] $Root,
    [Parameter(Mandatory)] [string] $Exe,
    [Parameter(Mandatory)] [int] $WaitPid,
    [Parameter(Mandatory)] [string] $LogFile,
    # The arguments HapsHub was opened with, one per line, base64 encoded.
    [string] $PassArgs = ''
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type -Namespace HapsHubUpdater -Name Native -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
[DllImport("user32.dll")] public static extern bool ReleaseCapture();
[DllImport("user32.dll")] public static extern System.IntPtr SendMessage(System.IntPtr hWnd, int msg, int wParam, int lParam);
'@
[void][HapsHubUpdater.Native]::SetProcessDPIAware()
[Windows.Forms.Application]::EnableVisualStyles()

$passed = @()
if ($PassArgs) { $passed = @([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($PassArgs)) -split "`n" | Where-Object { $_ }) }
# Start-Process joins arguments with spaces, so any with a space are quoted here.
$open = @('--no-update-check') + @($passed | ForEach-Object { if ($_ -match '\s') { '"' + $_ + '"' } else { $_ } })
$output = Join-Path $env:TEMP 'hapshub-update-build.log'
$logDir = Split-Path $LogFile
# How long the last successful build took, so the bar moves at a believable pace.
$timeFile = Join-Path $logDir 'update-duration.txt'
$expected = 60.0
try { if (Test-Path $timeFile) { $expected = [math]::Max(10.0, [double](Get-Content $timeFile -Raw).Trim()) } } catch { }
# Tests can ask for a picture of each stage.
$shots = $env:HAPSHUB_UPDATER_SHOTS

# ---- Window -------------------------------------------------------------------------------------------------------
$form = New-Object Windows.Forms.Form
$g0 = $form.CreateGraphics(); $s = $g0.DpiX / 96.0; $g0.Dispose()
function Px([double] $v) { [int][math]::Round($v * $s) }
$W = 300; $H = 340
$form.Text = 'Updating HapsHub'
$form.FormBorderStyle = 'None'
$form.StartPosition = 'CenterScreen'
$form.ClientSize = New-Object Drawing.Size((Px $W), (Px $H))
$form.BackColor = [Drawing.Color]::FromArgb(17, 17, 20)
$form.ShowInTaskbar = $true
$icon = Join-Path $Root 'logo.ico'
if (Test-Path $icon) { $form.Icon = New-Object Drawing.Icon($icon) }
$form.GetType().GetProperty('DoubleBuffered', [Reflection.BindingFlags]'NonPublic,Instance').SetValue($form, $true, $null)

# Rounded corners.
$r = Px 16; $path = New-Object Drawing.Drawing2D.GraphicsPath
$cw = $form.ClientSize.Width; $ch = $form.ClientSize.Height
$path.AddArc(0, 0, $r * 2, $r * 2, 180, 90); $path.AddArc($cw - $r * 2, 0, $r * 2, $r * 2, 270, 90)
$path.AddArc($cw - $r * 2, $ch - $r * 2, $r * 2, $r * 2, 0, 90); $path.AddArc(0, $ch - $r * 2, $r * 2, $r * 2, 90, 90)
$path.CloseFigure(); $form.Region = New-Object Drawing.Region($path)

# Drag it anywhere.
$form.Add_MouseDown({ if ($_.Button -eq 'Left') { [void][HapsHubUpdater.Native]::ReleaseCapture(); [void][HapsHubUpdater.Native]::SendMessage($form.Handle, 0xA1, 2, 0) } })

$logoFile = Join-Path $Root 'frontend\logo.png'
$logo = if (Test-Path $logoFile) { [Drawing.Image]::FromFile($logoFile) } else { $null }
$accent = [Drawing.Color]::FromArgb(92, 118, 255)
$errColor = [Drawing.Color]::FromArgb(255, 75, 85)
$titleFont = New-Object Drawing.Font('Segoe UI Semibold', 11.5)
$subFont = New-Object Drawing.Font('Segoe UI', 9)

# ---- State --------------------------------------------------------------------------------------------------------
$st = @{
    Stage = 'wait'; Title = 'Checking for updates'; Sub = 'Waiting for HapsHub to close'
    Progress = -1.0; Shown = 0.0; Failed = $false
    Clock = [Diagnostics.Stopwatch]::StartNew(); StageClock = [Diagnostics.Stopwatch]::StartNew()
    Proc = $null; Deadline = (Get-Date).AddSeconds(30)
}

function Set-Stage([string] $stage, [string] $title, [string] $sub, [double] $progress) {
    $st.Stage = $stage; $st.Title = $title; $st.Sub = $sub; $st.Progress = $progress; $st.StageClock.Restart()
    $form.Invalidate()
    if ($shots) {
        $form.Update()
        $bmp = New-Object Drawing.Bitmap($form.ClientSize.Width, $form.ClientSize.Height)
        $form.DrawToBitmap($bmp, (New-Object Drawing.Rectangle(0, 0, $bmp.Width, $bmp.Height)))
        $bmp.Save((Join-Path $shots "updater-$stage.png")); $bmp.Dispose()
    }
}

$form.Add_Paint({
    $g = $_.Graphics
    $g.SmoothingMode = 'AntiAlias'; $g.InterpolationMode = 'HighQualityBicubic'; $g.TextRenderingHint = 'ClearTypeGridFit'
    $t = $st.Clock.Elapsed.TotalSeconds
    $cw = $form.ClientSize.Width

    # Logo: a slow breathe and bob while it works, still when it is done or failed.
    if ($logo) {
        $calm = $st.Stage -in 'done', 'failed'
        $scale = if ($calm) { 1.0 } else { 1.0 + 0.045 * [math]::Sin($t * 3.2) }
        $bob = if ($calm) { 0.0 } else { (Px 4) * [math]::Sin($t * 1.6) }
        $size = (Px 112) * $scale
        $g.DrawImage($logo, [single](($cw - $size) / 2), [single]((Px 120) - $size / 2 + $bob), [single]$size, [single]$size)
    }

    $fmt = New-Object Drawing.StringFormat; $fmt.Alignment = 'Center'
    $titleColor = if ($st.Failed) { $errColor } else { [Drawing.Color]::White }
    $g.DrawString($st.Title, $titleFont, (New-Object Drawing.SolidBrush($titleColor)), (New-Object Drawing.RectangleF(0, (Px 212), $cw, (Px 26))), $fmt)
    $g.DrawString($st.Sub, $subFont, (New-Object Drawing.SolidBrush([Drawing.Color]::FromArgb(138, 138, 155))), (New-Object Drawing.RectangleF((Px 16), (Px 240), ($cw - (Px 32)), (Px 40))), $fmt)

    # Progress bar: a sliding piece while waiting, then real (estimated) progress.
    $bw = Px 196; $bh = Px 6; $bx = ($cw - $bw) / 2; $by = Px 292
    $track = New-Object Drawing.Drawing2D.GraphicsPath
    $track.AddArc($bx, $by, $bh, $bh, 90, 180); $track.AddArc($bx + $bw - $bh, $by, $bh, $bh, 270, 180); $track.CloseFigure()
    $g.FillPath((New-Object Drawing.SolidBrush([Drawing.Color]::FromArgb(36, 36, 42))), $track)
    $g.SetClip($track)
    $fill = if ($st.Failed) { $errColor } else { $accent }
    if ($st.Progress -lt 0) {
        $seg = $bw * 0.32; $x = $bx - $seg + (($t * 0.9) % 1.0) * ($bw + $seg)
        $g.FillRectangle((New-Object Drawing.SolidBrush($fill)), [single]$x, [single]$by, [single]$seg, [single]$bh)
    } else {
        $g.FillRectangle((New-Object Drawing.SolidBrush($fill)), [single]$bx, [single]$by, [single]($bw * $st.Shown), [single]$bh)
    }
    $g.ResetClip()
})

function Open-HapsHub([string] $flag) {
    try { Start-Process -FilePath $Exe -ArgumentList (@($flag) + $open) } catch { }
}

# ---- Work, one small step per tick so the window stays smooth ------------------------------------------------------
$timer = New-Object Windows.Forms.Timer
$timer.Interval = 33
$timer.Add_Tick({
    switch ($st.Stage) {
        'wait' {
            # The copy that started this, plus its helpers (watchdog, VR overlay), must be gone before the files change.
            $left = @(Get-Process -Id $WaitPid -ErrorAction SilentlyContinue) + @(Get-Process -Name HapsHub -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $Exe })
            if ($st.StageClock.Elapsed.TotalSeconds -ge 0.8 -and ($left.Count -eq 0 -or (Get-Date) -gt $st.Deadline)) {
                Set-Stage 'build' 'Installing update' 'Building the newest version of HapsHub' 0.0
                $st.Proc = Start-Process -FilePath 'dotnet' -PassThru -WindowStyle Hidden -RedirectStandardOutput $output `
                    -ArgumentList @('build', ('"' + (Join-Path $Root 'VRCNext.csproj') + '"'), '-c', 'Release', '-maxcpucount:2', '-v', 'quiet', '-nologo')
                [void]$st.Proc.Handle  # keeps ExitCode readable after it ends
            }
        }
        'build' {
            # Eases toward 92% around the time the last build took; the rest waits for the real finish.
            $e = $st.StageClock.Elapsed.TotalSeconds
            $st.Progress = 0.92 * (1 - [math]::Exp(-2.4 * $e / $expected))
            if ($st.Proc.HasExited) {
                $st.Proc.WaitForExit()
                if ($st.Proc.ExitCode -eq 0) {
                    try { New-Item -ItemType Directory -Force -Path $logDir | Out-Null; [string][math]::Round($e, 1) | Set-Content -Path $timeFile -Encoding ascii } catch { }
                    Set-Stage 'done' 'Starting HapsHub' 'Update installed' 1.0
                } else {
                    New-Item -ItemType Directory -Force -Path $logDir | Out-Null
                    "Update on $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') failed to build. Nothing changed." | Set-Content -Path $LogFile -Encoding utf8
                    if (Test-Path $output) { Get-Content $output | Add-Content -Path $LogFile -Encoding utf8 }
                    $st.Failed = $true
                    Set-Stage 'failed' 'Update failed' 'Opening the version you had. The reason is saved in update-failed.log.' 1.0
                }
            }
        }
        'done' {
            if ($st.Shown -ge 0.999 -and $st.StageClock.Elapsed.TotalSeconds -ge 0.7) {
                $timer.Stop(); Open-HapsHub '--updated'; $script:exitCode = 0; $form.Close()
            }
        }
        'failed' {
            if ($st.StageClock.Elapsed.TotalSeconds -ge 3.5) {
                $timer.Stop(); Open-HapsHub '--update-failed'; $script:exitCode = 1; $form.Close()
            }
        }
    }
    # The bar glides to its target instead of jumping.
    if ($st.Progress -ge 0) { $st.Shown += ($st.Progress - $st.Shown) * 0.12; if ([math]::Abs($st.Progress - $st.Shown) -lt 0.002) { $st.Shown = $st.Progress } }
    $form.Invalidate()
})

$script:exitCode = 1
$form.Add_Shown({ Set-Stage 'wait' $st.Title $st.Sub -1.0; $timer.Start() })
# If the window is closed by hand mid-build, the build still finishes and HapsHub still opens.
$form.Add_FormClosing({
    if ($timer.Enabled) {
        $timer.Stop()
        if ($st.Proc) { $st.Proc.WaitForExit(); Open-HapsHub $(if ($st.Proc.ExitCode -eq 0) { '--updated' } else { '--update-failed' }) }
        else { Open-HapsHub '--update-failed' }
    }
})
[Windows.Forms.Application]::Run($form)
exit $script:exitCode
