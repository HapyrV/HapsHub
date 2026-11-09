using System.Diagnostics;
using System.Text;

namespace HapsHub.Core;

public sealed record TunnelTrack(string Path, string Title);

/// <summary>A problem worth showing as it is. Its message is written for the page.</summary>
public sealed class TunnelException(string message) : Exception(message);

public static class TunnelLink
{
    private static readonly HashSet<string> Hosts = new(StringComparer.OrdinalIgnoreCase)
    {
        "youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be", "www.youtu.be",
    };

    /// <summary>The link to fetch, or null if this isn't a YouTube link.</summary>
    public static string? Clean(string? text)
    {
        var trimmed = text?.Trim() ?? "";
        if (!Uri.TryCreate(trimmed, UriKind.Absolute, out var uri)) return null;
        if (uri.Scheme != Uri.UriSchemeHttps && uri.Scheme != Uri.UriSchemeHttp) return null;
        return Hosts.Contains(uri.Host) ? uri.AbsoluteUri : null;
    }
}

/// <summary>
/// Fetches a song's audio with yt-dlp so it can play into the VRChat mic without passing through
/// the voice changer. The player itself is in the app, so this stays testable without audio devices.
/// </summary>
public sealed class YoutubeTunnelModule : IHubModule
{
    public const string ModuleId = "hub.youtube-tunnel";
    public const string PathKey = "yt_dlp_path";
    public const string CookiesKey = "cookies_browser";
    public const string SendDeviceKey = "send_device";
    public const string HearDeviceKey = "hear_device";
    public const string SendVolumeKey = "send_volume";
    public const string HearVolumeKey = "hear_volume";

    private const string FilePrefix = "tunnel-";
    private static readonly TimeSpan FetchLimit = TimeSpan.FromMinutes(5);

    private readonly string? _cacheFolder;
    private HubModuleContext? _context;

    public YoutubeTunnelModule(string? cacheFolder = null) => _cacheFolder = cacheFolder;

    public string Id => ModuleId;
    public string DisplayName => "YouTube tunnel";

    public IReadOnlyList<HubSettingDefinition> Settings { get; } = new[]
    {
        new HubSettingDefinition(PathKey, "Path to yt-dlp. Empty looks for it on your PATH", HubSettingKind.Text, ""),
        new HubSettingDefinition(CookiesKey, "Browser to borrow your YouTube sign-in from, like firefox. For Waterfox use firefox:<profile folder>. Empty means none", HubSettingKind.Text, ""),
        new HubSettingDefinition(SendDeviceKey, "Send to", HubSettingKind.Hidden, ""),
        new HubSettingDefinition(HearDeviceKey, "Hear it on", HubSettingKind.Hidden, ""),
        new HubSettingDefinition(SendVolumeKey, "Mic volume", HubSettingKind.Hidden, "100"),
        new HubSettingDefinition(HearVolumeKey, "Your volume", HubSettingKind.Hidden, "50"),
    };

    public Task StartAsync(HubModuleContext context, CancellationToken cancellationToken)
    {
        _context = context;
        ClearCache();
        return Task.CompletedTask;
    }

    public Task StopAsync(CancellationToken cancellationToken)
    {
        ClearCache();
        _context = null;
        return Task.CompletedTask;
    }

    public string Setting(string key) => _context?.GetSetting(key) ?? "";

    public string CacheFolder => _cacheFolder ?? Path.Combine(HubPaths.HubRoot, "tunnel");

    public string? FindYtDlp() => FindYtDlp(Setting(PathKey), Environment.GetEnvironmentVariable("PATH"));

    /// <summary>The configured file if it exists, otherwise the first copy on the PATH.</summary>
    public static string? FindYtDlp(string? configured, string? searchPath)
    {
        var chosen = configured?.Trim().Trim('"') ?? "";
        if (chosen.Length > 0) return File.Exists(chosen) ? chosen : null;
        foreach (var folder in (searchPath ?? "").Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries))
        {
            foreach (var name in new[] { "yt-dlp.exe", "yt-dlp" })
            {
                try
                {
                    var candidate = Path.Combine(folder.Trim('"'), name);
                    if (File.Exists(candidate)) return candidate;
                }
                catch (ArgumentException) { /* A malformed PATH entry. */ }
            }
        }
        return null;
    }

    /// <summary>Only formats Windows can decode without ffmpeg. yt-dlp only tries Deno by default, and YouTube's challenge needs a JavaScript runtime, so Node is allowed too. The link is checked and comes after "--", so it can't become an option.</summary>
    public static IReadOnlyList<string> BuildArguments(string link, string outputTemplate, string? cookiesBrowser)
    {
        var arguments = new List<string>
        {
            "--ignore-config", "--no-playlist", "--no-warnings", "--no-progress", "--no-simulate", "--force-overwrites",
            "--encoding", "utf-8",
            "--js-runtimes", "node",
            "--max-filesize", "300M",
            "-f", "bestaudio[ext=m4a]/best[ext=mp4]",
            "--print", "video:title",
            "--print", "after_move:filepath",
            "-o", outputTemplate,
        };
        var browser = cookiesBrowser?.Trim() ?? "";
        if (browser.Length > 0) arguments.AddRange(new[] { "--cookies-from-browser", browser });
        arguments.Add("--");
        arguments.Add(link);
        return arguments;
    }

    /// <summary>yt-dlp prints the title, then the finished file. Anything else means nothing was fetched.</summary>
    public static TunnelTrack? ParseOutput(string output, string folder)
    {
        var lines = output.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        if (lines.Length < 2) return null;
        var path = lines[^1];
        var root = Path.GetFullPath(folder).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        try
        {
            // Only ever play or delete a file in our own folder.
            if (!Path.GetFullPath(path).StartsWith(root, StringComparison.OrdinalIgnoreCase)) return null;
        }
        catch (ArgumentException) { return null; }
        return new TunnelTrack(path, string.Join(" ", lines[..^1]));
    }

    public static string Explain(string errors)
    {
        if (errors.Contains("confirm you", StringComparison.OrdinalIgnoreCase) || errors.Contains("not a bot", StringComparison.OrdinalIgnoreCase))
            return "YouTube wants a signed-in browser for this. Set one under YouTube tunnel in Settings, Hub modules.";
        if (errors.Contains("Requested format is not available", StringComparison.OrdinalIgnoreCase))
            return "This video has no audio Windows can play.";
        if (errors.Contains("page needs to be reloaded", StringComparison.OrdinalIgnoreCase))
            return "YouTube's check needs Node.js, and yt-dlp couldn't use it. Install Node.js and try again.";
        if (errors.Contains("could not find", StringComparison.OrdinalIgnoreCase) && errors.Contains("cookies", StringComparison.OrdinalIgnoreCase))
            return "Could not read that browser's sign-in. Check the browser name in Settings, Hub modules.";
        var last = errors.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).LastOrDefault(l => l.StartsWith("ERROR", StringComparison.OrdinalIgnoreCase))
                   ?? errors.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).LastOrDefault()
                   ?? "";
        if (last.Length == 0) return "yt-dlp stopped without saying why.";
        return last.Length <= 220 ? last : last[..220];
    }

    /// <summary>Downloads the song's audio. Cancelling stops yt-dlp and everything it started.</summary>
    public async Task<TunnelTrack> FetchAsync(string link, CancellationToken cancellationToken)
    {
        var executable = FindYtDlp()
            ?? throw new TunnelException("yt-dlp wasn't found. Set its path under YouTube tunnel in Settings, Hub modules.");
        var folder = CacheFolder;
        Directory.CreateDirectory(folder);
        ClearCache();

        var start = new ProcessStartInfo(executable)
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
            WorkingDirectory = folder,
        };
        start.Environment["PYTHONUTF8"] = "1";
        foreach (var argument in BuildArguments(link, Path.Combine(folder, FilePrefix + "%(id)s.%(ext)s"), Setting(CookiesKey)))
            start.ArgumentList.Add(argument);

        using var limit = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        limit.CancelAfter(FetchLimit);
        Process process;
        try
        {
            process = Process.Start(start) ?? throw new TunnelException("yt-dlp could not start.");
        }
        catch (Exception ex) when (ex is System.ComponentModel.Win32Exception or InvalidOperationException)
        {
            throw new TunnelException($"yt-dlp could not start: {ex.Message}");
        }

        using (process)
        {
            var output = process.StandardOutput.ReadToEndAsync(CancellationToken.None);
            var errors = process.StandardError.ReadToEndAsync(CancellationToken.None);
            try
            {
                await process.WaitForExitAsync(limit.Token);
            }
            catch (OperationCanceledException)
            {
                try { process.Kill(entireProcessTree: true); }
                catch (Exception ex) when (ex is InvalidOperationException or System.ComponentModel.Win32Exception) { /* Already gone. */ }
                if (cancellationToken.IsCancellationRequested) throw;
                throw new TunnelException("YouTube took too long to answer, so this was stopped.");
            }

            var printed = await output;
            var problems = await errors;
            if (process.ExitCode != 0) throw new TunnelException(Explain(problems));
            var track = ParseOutput(printed, folder);
            if (track == null || !File.Exists(track.Path))
                throw new TunnelException("Nothing was downloaded. The song may be longer than the 300 MB limit.");
            return track;
        }
    }

    /// <summary>Deletes fetched songs. A file still in use stays until the next time.</summary>
    public void ClearCache()
    {
        try
        {
            var folder = CacheFolder;
            if (!Directory.Exists(folder)) return;
            foreach (var file in Directory.EnumerateFiles(folder, FilePrefix + "*"))
            {
                try { File.Delete(file); }
                catch (IOException) { }
                catch (UnauthorizedAccessException) { }
            }
        }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
    }
}
