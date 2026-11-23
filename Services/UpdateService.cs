using System.Formats.Tar;
using System.IO.Compression;
using System.Runtime.InteropServices;
using System.Security.Cryptography;

namespace VRCNext.Services;

// Checks HapsHub's own GitHub releases. On a Windows zip or Linux tar.gz install it downloads the new archive, checks
// it against the SHA-256 GitHub lists for it, unpacks it next to the data folder, and after HapsHub closes copies it
// over the install folder and starts HapsHub again (like VRCX's "download, then restart to update").
// Anywhere else (a build from source, an AppImage, a folder HapsHub can't write to) it opens the download page.
// The helper script also stops HapsHub's own helper processes (watchdog, VR overlay) that run from the same folder.
// VRCNext's releases must never be installed: Velopack would replace this app with the stock upstream build.
public class UpdateService
{
    private const string RepoUrl = HapsHub.Core.HubRelease.RepoUrl;
    private const string ApiLatest = HapsHub.Core.HubRelease.LatestApi;

    private string? _ghReleaseUrl;
    private string? _version;
    private string? _assetUrl;
    private string? _assetSha256;
    private string? _stagedDir;
    private Task? _downloadTask;
    private Action<int>? _progress;

    public bool IsDownloaded => _stagedDir != null && Directory.Exists(_stagedDir);

    private static HttpClient NewClient(TimeSpan timeout)
    {
        var http = new HttpClient { Timeout = timeout };
        http.DefaultRequestHeaders.TryAddWithoutValidation("User-Agent", AppInfo.UserAgent);
        return http;
    }

    public Task<string?> CheckAsync() => CheckGithubAsync();

    private async Task<string?> CheckGithubAsync()
    {
        try
        {
            using var http = NewClient(TimeSpan.FromSeconds(15));
            var body = await http.GetStringAsync(ApiLatest);
            var json = Newtonsoft.Json.Linq.JObject.Parse(body);
            var tag = (json["tag_name"]?.ToString() ?? "").TrimStart('v', 'V');
            if (string.IsNullOrEmpty(tag)) return null;
            if (!Version.TryParse(tag, out var latest)) return null;
            if (!Version.TryParse(AppInfo.Version, out var current)) return null;
            if (latest <= current) return null;

            _ghReleaseUrl = json["html_url"]?.ToString() ?? $"{RepoUrl}/releases/latest";
            _version = tag;
            _assetUrl = _assetSha256 = null;
            var suffix = AssetSuffix;
            foreach (var asset in json["assets"] as Newtonsoft.Json.Linq.JArray ?? new())
            {
                var name = asset["name"]?.ToString() ?? "";
                if (suffix == null || !name.EndsWith(suffix, StringComparison.OrdinalIgnoreCase)) continue;
                _assetUrl = asset["browser_download_url"]?.ToString();
                var digest = asset["digest"]?.ToString() ?? "";
                _assetSha256 = digest.StartsWith("sha256:", StringComparison.OrdinalIgnoreCase) ? digest[7..].ToLowerInvariant() : null;
            }
            return tag;
        }
        catch { return null; }
    }

    /// <summary>The release download this copy updates from: the Windows zip or the Linux tar.gz (x64 only).</summary>
    private static string? AssetSuffix =>
        RuntimeInformation.OSArchitecture != Architecture.X64 ? null
        : OperatingSystem.IsWindows() ? "-win-x64.zip"
        : OperatingSystem.IsLinux() ? "-linux-x64.tar.gz"
        : null;

    /// <summary>The program file inside the install folder.</summary>
    private static string ProgramName => OperatingSystem.IsWindows() ? "HapsHub.exe" : "HapsHub";

    /// <summary>The folder HapsHub runs from.</summary>
    private static string InstallDir => Path.GetDirectoryName(Environment.ProcessPath ?? AppContext.BaseDirectory) ?? AppContext.BaseDirectory;

    /// <summary>
    /// True when this copy can update itself: Windows or Linux, a downloaded release (not built from source, which
    /// updates with git, and not an AppImage), a release archive with a checksum to check, and a folder HapsHub may
    /// write to.
    /// </summary>
    public bool CanSelfUpdate
    {
        get
        {
            if (AssetSuffix == null || _assetUrl == null || _assetSha256 == null) return false;
            if (!string.IsNullOrEmpty(Environment.GetEnvironmentVariable("APPIMAGE"))) return false;
            var dir = InstallDir;
            if (HapsHub.Core.SourceUpdate.RepositoryOf(dir) != null) return false;
            if (File.Exists(Path.Combine(dir, HapsHub.Core.SourceUpdate.StampFile))) return false;
            try
            {
                var probe = Path.Combine(dir, $".write-test-{Guid.NewGuid():N}");
                File.WriteAllText(probe, "");
                File.Delete(probe);
                return true;
            }
            catch { return false; }
        }
    }

    private static string UpdatesDir => Path.Combine(HapsHub.Core.HubPaths.LocalRoot, "updates");

    /// <summary>
    /// Downloads, checks and unpacks the new version (once: a download already running in the background is joined).
    /// Does nothing when this copy can't update itself.
    /// </summary>
    public Task DownloadAsync(Action<int>? onProgress)
    {
        _progress = onProgress;
        if (!CanSelfUpdate || IsDownloaded) { onProgress?.Invoke(100); return Task.CompletedTask; }
        var task = _downloadTask ??= DownloadCoreAsync();
        // A failed download may be tried again.
        _ = task.ContinueWith(t => { if (t.IsFaulted && ReferenceEquals(_downloadTask, t)) _downloadTask = null; }, TaskScheduler.Default);
        return task;
    }

    private async Task DownloadCoreAsync()
    {
        void onProgress(int pct) => _progress?.Invoke(pct);

        var root = UpdatesDir;
        if (Directory.Exists(root)) { try { Directory.Delete(root, recursive: true); } catch { } }
        Directory.CreateDirectory(root);
        var zipPath = Path.Combine(root, $"HapsHub-{_version}{AssetSuffix}");

        using (var http = NewClient(TimeSpan.FromMinutes(20)))
        using (var response = await http.GetAsync(_assetUrl, HttpCompletionOption.ResponseHeadersRead))
        {
            response.EnsureSuccessStatusCode();
            var total = response.Content.Headers.ContentLength ?? 0;
            await using var source = await response.Content.ReadAsStreamAsync();
            await using var target = File.Create(zipPath);
            var buffer = new byte[1 << 16];
            long done = 0;
            int read, lastPct = -1;
            while ((read = await source.ReadAsync(buffer)) > 0)
            {
                await target.WriteAsync(buffer.AsMemory(0, read));
                done += read;
                var pct = total > 0 ? (int)(done * 95 / total) : 0;
                if (pct != lastPct) { lastPct = pct; onProgress(pct); }
            }
        }

        string hash;
        await using (var file = File.OpenRead(zipPath))
            hash = Convert.ToHexStringLower(await SHA256.HashDataAsync(file));
        if (hash != _assetSha256)
            throw new InvalidDataException("The downloaded update doesn't match the checksum on GitHub, so it wasn't installed.");

        var staged = Path.Combine(root, "new");
        if (zipPath.EndsWith(".zip", StringComparison.OrdinalIgnoreCase))
            ZipFile.ExtractToDirectory(zipPath, staged);
        else
        {
            Directory.CreateDirectory(staged);
            await using var file = File.OpenRead(zipPath);
            await using var gz = new GZipStream(file, CompressionMode.Decompress);
            await TarFile.ExtractToDirectoryAsync(gz, staged, overwriteFiles: false);
        }
        // The Windows zip holds the files themselves; the Linux tar.gz holds a HapsHub folder.
        if (!File.Exists(Path.Combine(staged, ProgramName)) && File.Exists(Path.Combine(staged, "HapsHub", ProgramName)))
            staged = Path.Combine(staged, "HapsHub");
        if (!File.Exists(Path.Combine(staged, ProgramName)))
            throw new InvalidDataException($"The downloaded update has no {ProgramName}, so it wasn't installed.");
        File.Delete(zipPath);
        _stagedDir = staged;
        onProgress(100);
    }

    /// <summary>
    /// Starts the hidden helper that waits for HapsHub to close, copies the new files over the install folder and
    /// starts HapsHub again. True means the caller should now close HapsHub. False opened the download page instead.
    /// </summary>
    public bool ApplyAndRestart()
    {
        if (_stagedDir == null || !Directory.Exists(_stagedDir))
        {
            OpenReleasePage();
            return false;
        }

        if (!OperatingSystem.IsWindows()) return ApplyAndRestartUnix();

        var script = Path.Combine(UpdatesDir, "apply-update.ps1");
        File.WriteAllText(script, """
            param([int]$AppPid, [string]$Staged, [string]$Install)
            $log = Join-Path (Split-Path $Staged) 'apply-update.log'
            "Updating $Install from $Staged" | Out-File $log -Encoding utf8
            try { Wait-Process -Id $AppPid -Timeout 60 -ErrorAction Stop } catch { }
            $deadline = (Get-Date).AddSeconds(20)
            do {
                $left = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith($Install + '\', [StringComparison]::OrdinalIgnoreCase) })
                if (-not $left) { break }
                Start-Sleep -Milliseconds 500
            } while ((Get-Date) -lt $deadline)
            $left | Stop-Process -Force -ErrorAction SilentlyContinue
            Start-Sleep -Milliseconds 500
            robocopy $Staged $Install /E /R:10 /W:1 /NP /NFL /NDL | Out-File $log -Append -Encoding utf8
            $code = $LASTEXITCODE
            "robocopy exit $code" | Out-File $log -Append -Encoding utf8
            Start-Process -FilePath (Join-Path $Install 'HapsHub.exe') -WorkingDirectory $Install
            if ($code -lt 8) { Remove-Item -Recurse -Force $Staged -ErrorAction SilentlyContinue }
            """);

        try
        {
            var psi = new System.Diagnostics.ProcessStartInfo
            {
                FileName = "powershell.exe",
                UseShellExecute = false,
                CreateNoWindow = true,
            };
            foreach (var a in new[] { "-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", script,
                         "-AppPid", Environment.ProcessId.ToString(), "-Staged", _stagedDir, "-Install", InstallDir.TrimEnd('\\') })
                psi.ArgumentList.Add(a);
            System.Diagnostics.Process.Start(psi);
            return true;
        }
        catch
        {
            OpenReleasePage();
            return false;
        }
    }

    /// <summary>
    /// Linux: a detached shell script waits for HapsHub and its helpers to close, copies the new files over the
    /// install folder (permissions kept) and starts HapsHub again in its own session. Its log is apply-update.log.
    /// </summary>
    private bool ApplyAndRestartUnix()
    {
        var script = Path.Combine(UpdatesDir, "apply-update.sh");
        File.WriteAllText(script, """
            #!/bin/sh
            app_pid="$1"; staged="$2"; install="$3"; root="$4"
            exec >"$root/apply-update.log" 2>&1
            trap '' HUP
            echo "Updating $install from $staged"
            i=0
            while kill -0 "$app_pid" 2>/dev/null && [ $i -lt 60 ]; do sleep 1; i=$((i+1)); done
            # HapsHub's own helpers (watchdog, VR overlay) run the same program from the install folder.
            running() {
                for p in /proc/[0-9]*; do
                    exe=$(readlink "$p/exe" 2>/dev/null) || continue
                    case "$exe" in "$install"/*) echo "${p#/proc/}" ;; esac
                done
            }
            i=0
            while [ -n "$(running)" ] && [ $i -lt 20 ]; do sleep 1; i=$((i+1)); done
            left=$(running)
            [ -n "$left" ] && kill -9 $left
            sleep 1
            if cp -Rpf "$staged/." "$install/"; then
                echo "copied"
                rm -rf "$root/new"
            else
                echo "copy failed"
            fi
            chmod +x "$install/HapsHub" "$install/run-hapshub.sh" 2>/dev/null
            cd "$install" || exit 1
            if command -v setsid >/dev/null 2>&1; then
                setsid "$install/HapsHub" </dev/null >/dev/null 2>&1 &
            else
                nohup "$install/HapsHub" </dev/null >/dev/null 2>&1 &
            fi
            echo "started"
            """.ReplaceLineEndings("\n"));

        try
        {
            var psi = new System.Diagnostics.ProcessStartInfo { FileName = "/bin/sh", UseShellExecute = false };
            foreach (var a in new[] { script, Environment.ProcessId.ToString(), _stagedDir!, InstallDir.TrimEnd('/'), UpdatesDir })
                psi.ArgumentList.Add(a);
            System.Diagnostics.Process.Start(psi);
            return true;
        }
        catch
        {
            OpenReleasePage();
            return false;
        }
    }

    public void OpenReleasePage()
    {
        var url = _ghReleaseUrl ?? $"{RepoUrl}/releases/latest";
        try { System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo { FileName = url, UseShellExecute = true }); }
        catch { }
    }
}
