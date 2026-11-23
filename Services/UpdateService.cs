using System.IO.Compression;
using System.Security.Cryptography;

namespace VRCNext.Services;

// Checks HapsHub's own GitHub releases. On a Windows zip install it downloads the new zip, checks it against the
// SHA-256 GitHub lists for it, unpacks it next to the data folder, and after HapsHub closes copies it over the
// install folder and starts HapsHub again (like VRCX's "download, then restart to update").
// Anywhere else (Linux, a build from source, a folder HapsHub can't write to) it opens the download page instead.
// The helper script also stops HapsHub's own helper processes (watchdog, VR overlay) that run from the same folder.
// VRCNext's releases must never be installed: Velopack would replace this app with the stock upstream build.
public class UpdateService
{
    private const string RepoUrl = HapsHub.Core.HubRelease.RepoUrl;
    private const string ApiLatest = HapsHub.Core.HubRelease.LatestApi;

    private string? _ghReleaseUrl;
    private string? _version;
    private string? _zipUrl;
    private string? _zipSha256;
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
            _zipUrl = _zipSha256 = null;
            foreach (var asset in json["assets"] as Newtonsoft.Json.Linq.JArray ?? new())
            {
                var name = asset["name"]?.ToString() ?? "";
                if (!name.EndsWith("-win-x64.zip", StringComparison.OrdinalIgnoreCase)) continue;
                _zipUrl = asset["browser_download_url"]?.ToString();
                var digest = asset["digest"]?.ToString() ?? "";
                _zipSha256 = digest.StartsWith("sha256:", StringComparison.OrdinalIgnoreCase) ? digest[7..].ToLowerInvariant() : null;
            }
            return tag;
        }
        catch { return null; }
    }

    /// <summary>The folder HapsHub.exe runs from.</summary>
    private static string InstallDir => Path.GetDirectoryName(Environment.ProcessPath ?? AppContext.BaseDirectory) ?? AppContext.BaseDirectory;

    /// <summary>
    /// True when this copy can update itself: Windows, a downloaded release (not built from source, which updates
    /// with git), a release zip with a checksum to check, and a folder HapsHub may write to.
    /// </summary>
    public bool CanSelfUpdate
    {
        get
        {
            if (!OperatingSystem.IsWindows() || _zipUrl == null || _zipSha256 == null) return false;
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
        var zipPath = Path.Combine(root, $"HapsHub-{_version}-win-x64.zip");

        using (var http = NewClient(TimeSpan.FromMinutes(20)))
        using (var response = await http.GetAsync(_zipUrl, HttpCompletionOption.ResponseHeadersRead))
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
        if (hash != _zipSha256)
            throw new InvalidDataException("The downloaded update doesn't match the checksum on GitHub, so it wasn't installed.");

        var staged = Path.Combine(root, "new");
        ZipFile.ExtractToDirectory(zipPath, staged);
        if (!File.Exists(Path.Combine(staged, "HapsHub.exe")))
            throw new InvalidDataException("The downloaded update has no HapsHub.exe, so it wasn't installed.");
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

    public void OpenReleasePage()
    {
        var url = _ghReleaseUrl ?? $"{RepoUrl}/releases/latest";
        try { System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo { FileName = url, UseShellExecute = true }); }
        catch { }
    }
}
