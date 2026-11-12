using System.Diagnostics;
using System.Net;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace HapsHub.Core;

public sealed record SteamInstalledApp(string ManifestPath, string Branch, string MountedBranch, string BuildId, bool Ready);

public sealed record SteamBranchBuild(string Name, string BuildId, DateTimeOffset? Updated);

public sealed record SteamAppReport(
    int AppId, string Name, SteamInstalledApp? Installed, bool WatchOn,
    SteamBranchBuild? Public, SteamBranchBuild? Beta, string? ReviewedBetaBuild, string? Error);

public enum SteamSwitchOutcome { AlreadyOn, Applied, Waiting, Blocked, Failed, Reverted }

public sealed record SteamSwitchResult(SteamSwitchOutcome Outcome, string Message);

/// <summary>Reads and edits a Steam app manifest. Only the selected branch ever changes.</summary>
public static class SteamManifest
{
    private static readonly Regex BuildId = new(@"^\s*""buildid""\s+""(\d+)""", RegexOptions.Multiline | RegexOptions.IgnoreCase | RegexOptions.Compiled);
    private static readonly Regex StateFlags = new(@"^\s*""StateFlags""\s+""(\d+)""", RegexOptions.Multiline | RegexOptions.IgnoreCase | RegexOptions.Compiled);
    private static readonly Regex BetaKey = new(@"(""BetaKey""\s+"")([^""]*)("")", RegexOptions.IgnoreCase | RegexOptions.Compiled);

    // Steam's "fully installed, nothing pending" state.
    private const int FullyInstalled = 4;

    public static SteamInstalledApp? Read(string path, string text)
    {
        var build = BuildId.Match(text);
        var flags = StateFlags.Match(text);
        var user = Block(text, "UserConfig");
        if (!build.Success || !flags.Success || user == null) return null;
        var mounted = Block(text, "MountedConfig");
        return new SteamInstalledApp(
            path,
            BranchIn(text.Substring(user.Value.Start, user.Value.Length)),
            mounted == null ? "public" : BranchIn(text.Substring(mounted.Value.Start, mounted.Value.Length)),
            build.Groups[1].Value,
            flags.Groups[1].Value == FullyInstalled.ToString());
    }

    /// <summary>Returns the manifest with a new selected branch, or null if its layout isn't recognised.</summary>
    public static string? WithBranch(string text, string branch)
    {
        var block = Block(text, "UserConfig");
        if (block == null) return null;
        var (start, length) = block.Value;
        var inner = text.Substring(start, length);
        var match = BetaKey.Match(inner);
        string edited;
        if (match.Success)
        {
            edited = inner[..match.Groups[2].Index] + branch + inner[(match.Groups[2].Index + match.Groups[2].Length)..];
        }
        else
        {
            var newline = text.Contains("\r\n") ? "\r\n" : "\n";
            edited = $"{newline}\t\t\"BetaKey\"\t\t\"{branch}\"{inner}";
        }
        var result = text[..start] + edited + text[(start + length)..];
        // Refuse anything that doesn't read back as exactly what was asked for.
        var check = Read("", result);
        return check?.Branch == branch ? result : null;
    }

    private static string BranchIn(string block)
    {
        var match = BetaKey.Match(block);
        return match.Success && match.Groups[2].Length > 0 ? match.Groups[2].Value : "public";
    }

    // The text between a section's braces. Neither section Steam writes here has nested sections.
    private static (int Start, int Length)? Block(string text, string name)
    {
        var header = Regex.Match(text, $@"""{name}""\s*\{{", RegexOptions.IgnoreCase);
        if (!header.Success) return null;
        var start = header.Index + header.Length;
        var end = text.IndexOf('}', start);
        return end < 0 ? null : (start, end - start);
    }
}

/// <summary>What the branch switch needs from Steam and the system. Replaced in tests.</summary>
public interface ISteamHost
{
    string? FindManifest(int appId);

    /// <summary>Things that would be interrupted if Steam closed.</summary>
    IReadOnlyList<string> RunningBlockers();

    bool IsSteamRunning();

    /// <summary>Asks Steam to close and waits. Returns false if it's still open afterwards. Never force-closes it.</summary>
    Task<bool> ShutdownAsync(CancellationToken cancellationToken);

    void Start();
}

/// <summary>The real Steam install.</summary>
public sealed class SteamHost : ISteamHost
{
    private static readonly string[] BlockerProcesses = { "VRChat", "vrserver", "vrmonitor", "vrcompositor" };
    private static readonly TimeSpan ShutdownWait = TimeSpan.FromSeconds(45);
    private static readonly Regex LibraryPath = new(@"""path""\s+""([^""]+)""", RegexOptions.IgnoreCase | RegexOptions.Compiled);

    public string? FindManifest(int appId)
    {
        return SteamLibraries()
            .Select(library => Path.Combine(library, "steamapps", $"appmanifest_{appId}.acf"))
            .FirstOrDefault(File.Exists);
    }

    /// <summary>Every Steam library folder on this PC. Empty when Steam isn't installed.</summary>
    public static IReadOnlyList<string> SteamLibraries()
    {
        var root = SteamRoot();
        if (root == null) return Array.Empty<string>();
        var libraries = new List<string> { root };
        try
        {
            var vdf = Path.Combine(root, "steamapps", "libraryfolders.vdf");
            if (File.Exists(vdf))
                libraries.AddRange(LibraryPath.Matches(File.ReadAllText(vdf)).Select(m => m.Groups[1].Value.Replace(@"\\", @"\")));
        }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
        return libraries;
    }

    private static readonly Regex AppIdField = new(@"^\s*""appid""\s+""(\d+)""", RegexOptions.Multiline | RegexOptions.IgnoreCase | RegexOptions.Compiled);
    private static readonly Regex InstallDirField = new(@"^\s*""installdir""\s+""([^""]+)""", RegexOptions.Multiline | RegexOptions.IgnoreCase | RegexOptions.Compiled);

    /// <summary>The Steam app id of the game a program belongs to, or null when it isn't under a Steam library.
    /// Starting such a program through Steam keeps its Steam Input and SteamVR controller bindings.</summary>
    public static int? AppIdForProgram(string programPath)
    {
        try
        {
            var full = Path.GetFullPath(programPath.Trim().Trim('"'));
            foreach (var library in SteamLibraries())
            {
                var common = Path.GetFullPath(Path.Combine(library, "steamapps", "common")).TrimEnd('\\', '/') + Path.DirectorySeparatorChar;
                if (!full.StartsWith(common, StringComparison.OrdinalIgnoreCase)) continue;
                var installDir = full.Substring(common.Length).Split('\\', '/')[0];
                foreach (var manifest in Directory.EnumerateFiles(Path.Combine(library, "steamapps"), "appmanifest_*.acf"))
                {
                    var text = File.ReadAllText(manifest);
                    var dir = InstallDirField.Match(text);
                    var id = AppIdField.Match(text);
                    if (dir.Success && id.Success && string.Equals(dir.Groups[1].Value, installDir, StringComparison.OrdinalIgnoreCase)
                        && int.TryParse(id.Groups[1].Value, out var appId))
                        return appId;
                }
            }
        }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
        catch (ArgumentException) { }
        catch (NotSupportedException) { }
        return null;
    }

    public IReadOnlyList<string> RunningBlockers()
    {
        var running = BlockerProcesses.Where(IsRunning).ToList();
        if (OperatingSystem.IsWindows() && running.Count == 0)
        {
            var app = Microsoft.Win32.Registry.GetValue(@"HKEY_CURRENT_USER\Software\Valve\Steam", "RunningAppID", 0);
            if (app is int id && id != 0) running.Add($"a Steam game ({id})");
        }
        return running;
    }

    public bool IsSteamRunning() => IsRunning("steam");

    public async Task<bool> ShutdownAsync(CancellationToken cancellationToken)
    {
        RunSteam("-shutdown");
        var end = DateTime.UtcNow + ShutdownWait;
        while (DateTime.UtcNow < end)
        {
            if (!IsSteamRunning()) return true;
            await Task.Delay(500, cancellationToken);
        }
        return !IsSteamRunning();
    }

    public void Start() => RunSteam("steam://open/downloads");

    private static void RunSteam(string argument)
    {
        var executable = OperatingSystem.IsWindows() ? Path.Combine(SteamRoot() ?? "", "steam.exe") : "steam";
        using var process = Process.Start(new ProcessStartInfo(executable, argument) { UseShellExecute = true });
    }

    private static bool IsRunning(string name)
    {
        var processes = Process.GetProcessesByName(name);
        foreach (var process in processes) process.Dispose();
        return processes.Length > 0;
    }

    private static string? SteamRoot()
    {
        if (OperatingSystem.IsWindows())
            return Microsoft.Win32.Registry.GetValue(@"HKEY_CURRENT_USER\Software\Valve\Steam", "SteamPath", null) is string path && path.Length > 0
                ? path.Replace('/', '\\')
                : null;
        var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        return new[] { Path.Combine(home, ".steam", "steam"), Path.Combine(home, ".local", "share", "Steam") }.FirstOrDefault(Directory.Exists);
    }
}

/// <summary>
/// Shows which Steam branch of Space Calibrator is installed, watches the beta for new builds
/// when asked, and switches between the public and beta branches.
/// </summary>
public sealed class SteamBranchModule : IHubModule
{
    public const string ModuleId = "hub.steam-branch";
    public const string WatchKey = "watch_beta";
    public const int SpaceCalibratorAppId = 3368750;
    public const string AppName = "Space Calibrator";

    private static readonly string[] Switchable = { "public", "beta" };

    private readonly HttpClient _http;
    private readonly ISteamHost _steam;
    private readonly TimeSpan _verifyFor;
    private readonly TimeSpan _verifyEvery;
    private readonly string? _backupFolder;
    private HubModuleContext? _context;
    private int _switching;

    public SteamBranchModule(HttpMessageHandler? handler = null, ISteamHost? steam = null,
        TimeSpan? verifyFor = null, TimeSpan? verifyEvery = null, string? backupFolder = null)
    {
        _backupFolder = backupFolder;
        _http = handler != null ? new HttpClient(handler) : new HttpClient();
        _http.Timeout = TimeSpan.FromSeconds(20);
        // Name only: this is a public lookup that needs no contact address.
        _http.DefaultRequestHeaders.TryAddWithoutValidation("User-Agent", HubPaths.AppName);
        _steam = steam ?? new SteamHost();
        _verifyFor = verifyFor ?? TimeSpan.FromSeconds(60);
        _verifyEvery = verifyEvery ?? TimeSpan.FromSeconds(2);
    }

    public string Id => ModuleId;
    public string DisplayName => "Steam branch: Space Calibrator";

    public IReadOnlyList<HubSettingDefinition> Settings { get; } = new[]
    {
        new HubSettingDefinition(WatchKey, "Include the Steam beta in update checks", HubSettingKind.Toggle, "true"),
    };

    public IReadOnlyList<HubMigration> Migrations { get; } = new[]
    {
        new HubMigration(1, """
            CREATE TABLE steam_reviewed (
                app_id      INTEGER NOT NULL,
                branch      TEXT NOT NULL,
                build_id    TEXT NOT NULL,
                reviewed_at TEXT NOT NULL,
                PRIMARY KEY (app_id, branch)
            );
            """),
    };

    public Task StartAsync(HubModuleContext context, CancellationToken cancellationToken)
    {
        _context = context;
        return Task.CompletedTask;
    }

    public Task StopAsync(CancellationToken cancellationToken)
    {
        _context = null;
        return Task.CompletedTask;
    }

    /// <summary>The installed state, read from disk. Touches no network.</summary>
    public SteamInstalledApp? ReadInstalled()
    {
        try
        {
            var path = _steam.FindManifest(SpaceCalibratorAppId);
            return path == null ? null : SteamManifest.Read(path, File.ReadAllText(path));
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            _context?.Log($"Could not read the Steam manifest: {ex.Message}");
            return null;
        }
    }

    /// <summary>The installed state, plus the current builds from Steam when the watch is on and online is true.</summary>
    public async Task<SteamAppReport> CheckAsync(bool online, CancellationToken cancellationToken = default)
    {
        var installed = ReadInstalled();
        var watch = _context == null || !string.Equals(_context.GetSetting(WatchKey), "false", StringComparison.OrdinalIgnoreCase);
        var reviewed = ReadReviewed("beta");
        if (!online || !watch)
            return new SteamAppReport(SpaceCalibratorAppId, AppName, installed, watch, null, null, reviewed, null);

        try
        {
            var (publicBuild, beta) = await FetchBranches(cancellationToken);
            return new SteamAppReport(SpaceCalibratorAppId, AppName, installed, watch, publicBuild, beta, reviewed, null);
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or JsonException
                                       or KeyNotFoundException or InvalidOperationException or FormatException)
        {
            var problem = ex switch
            {
                TaskCanceledException => "The Steam lookup didn't answer in time.",
                HttpRequestException => ex.Message,
                _ => "The Steam lookup's answer wasn't in the expected format.",
            };
            return new SteamAppReport(SpaceCalibratorAppId, AppName, installed, watch, null, null, reviewed, problem);
        }
    }

    /// <summary>Remembers a beta build as reviewed. Returns false if it couldn't be saved.</summary>
    public bool MarkBetaReviewed(string buildId)
    {
        var database = _context?.Database;
        if (database == null || buildId.Length == 0 || buildId.Length > 20 || !buildId.All(char.IsAsciiDigit)) return false;
        try
        {
            using var connection = database.OpenConnection();
            using var command = connection.CreateCommand();
            command.CommandText = """
                INSERT INTO steam_reviewed (app_id, branch, build_id, reviewed_at) VALUES ($a, 'beta', $b, $t)
                ON CONFLICT(app_id, branch) DO UPDATE SET build_id = $b, reviewed_at = $t;
                """;
            command.Parameters.AddWithValue("$a", SpaceCalibratorAppId);
            command.Parameters.AddWithValue("$b", buildId);
            command.Parameters.AddWithValue("$t", DateTime.UtcNow.ToString("O"));
            command.ExecuteNonQuery();
            return true;
        }
        catch (Microsoft.Data.Sqlite.SqliteException ex)
        {
            _context?.Log($"Could not save the reviewed build: {ex.Message}");
            return false;
        }
    }

    /// <summary>
    /// Selects a branch. Steam only reads this choice when it isn't running, so Steam has to close
    /// and reopen. Refuses while anything Steam runs is open, and always reopens a Steam it closed.
    /// </summary>
    public async Task<SteamSwitchResult> SwitchAsync(string branch, CancellationToken cancellationToken = default)
    {
        if (!Switchable.Contains(branch))
            return new SteamSwitchResult(SteamSwitchOutcome.Failed, "Only the public and beta branches can be selected here.");
        if (Interlocked.CompareExchange(ref _switching, 1, 0) != 0)
            return new SteamSwitchResult(SteamSwitchOutcome.Blocked, "A switch is already running.");
        try
        {
            return await RunSwitch(branch, cancellationToken);
        }
        finally
        {
            Volatile.Write(ref _switching, 0);
        }
    }

    private async Task<SteamSwitchResult> RunSwitch(string branch, CancellationToken cancellationToken)
    {
        var path = _steam.FindManifest(SpaceCalibratorAppId);
        if (path == null) return Failed($"{AppName} isn't installed through Steam.");

        string text;
        SteamInstalledApp? before;
        try
        {
            text = File.ReadAllText(path);
            before = SteamManifest.Read(path, text);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return Failed($"Could not read Steam's file: {ex.Message}");
        }

        if (before == null) return Failed("Steam's file isn't in the expected format, so it was left alone.");
        if (before.Branch == branch && before.MountedBranch == branch)
            return new SteamSwitchResult(SteamSwitchOutcome.AlreadyOn, $"Already on {branch}.");
        if (!before.Ready)
            return Blocked("Steam is still updating this app. Try again when it finishes.");

        var blockers = _steam.RunningBlockers();
        if (blockers.Count > 0)
            return Blocked($"Close {string.Join(", ", blockers)} first, because switching has to close Steam.");

        var edited = SteamManifest.WithBranch(text, branch);
        if (edited == null) return Failed("Steam's file isn't in the expected format, so it was left alone.");

        var closedSteam = false;
        var wrote = false;
        string? problem = null;
        try
        {
            if (_steam.IsSteamRunning())
            {
                closedSteam = true;
                if (!await _steam.ShutdownAsync(cancellationToken))
                    return Failed("Steam didn't close in time, so nothing was changed.");
                // Steam rewrites this file as it closes, so edit what it left behind.
                text = File.ReadAllText(path);
                edited = SteamManifest.WithBranch(text, branch);
                if (edited == null) return Failed("Steam's file isn't in the expected format, so it was left alone.");
            }

            var folder = _backupFolder ?? HubPaths.HubRoot;
            Directory.CreateDirectory(folder);
            AtomicFile.WriteAllText(Path.Combine(folder, $"appmanifest_{SpaceCalibratorAppId}.before-switch.acf"), text);
            AtomicFile.WriteAllText(path, edited);
            wrote = true;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            problem = $"Could not change Steam's file, so the branch is unchanged: {ex.Message}";
        }
        finally
        {
            // Steam going away and not coming back would be worse than a failed switch.
            if (closedSteam || wrote) TryStart();
        }

        if (problem != null) return Failed(problem);
        return await Verify(path, branch, cancellationToken);
    }

    private async Task<SteamSwitchResult> Verify(string path, string branch, CancellationToken cancellationToken)
    {
        var end = DateTime.UtcNow + _verifyFor;
        while (true)
        {
            await Task.Delay(_verifyEvery, cancellationToken);
            SteamInstalledApp? now = null;
            try { now = SteamManifest.Read(path, File.ReadAllText(path)); }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { /* Steam may be writing it. */ }

            if (now != null && now.Branch != branch)
                return new SteamSwitchResult(SteamSwitchOutcome.Reverted,
                    $"Steam put the branch back to {now.Branch}. Use Game Versions & Betas in Steam's properties for {AppName} instead.");
            if (now != null && now.MountedBranch == branch && now.Ready)
                return new SteamSwitchResult(SteamSwitchOutcome.Applied, $"{AppName} is on {branch}, build {now.BuildId}.");
            if (DateTime.UtcNow >= end)
                return new SteamSwitchResult(SteamSwitchOutcome.Waiting,
                    $"Steam accepted {branch} and hasn't finished installing it yet. Check its Downloads page.");
        }
    }

    private void TryStart()
    {
        try { _steam.Start(); }
        catch (Exception ex) when (ex is IOException or InvalidOperationException or System.ComponentModel.Win32Exception)
        {
            _context?.Log($"Could not reopen Steam: {ex.Message}");
        }
    }

    private static SteamSwitchResult Failed(string message) => new(SteamSwitchOutcome.Failed, message);
    private static SteamSwitchResult Blocked(string message) => new(SteamSwitchOutcome.Blocked, message);

    private async Task<(SteamBranchBuild? Public, SteamBranchBuild? Beta)> FetchBranches(CancellationToken cancellationToken)
    {
        using var response = await _http.GetAsync($"https://api.steamcmd.net/v1/info/{SpaceCalibratorAppId}", cancellationToken);
        if (!response.IsSuccessStatusCode)
            throw new HttpRequestException($"The Steam lookup answered {(int)response.StatusCode}.");
        await using var body = await response.Content.ReadAsStreamAsync(cancellationToken);
        using var json = await JsonDocument.ParseAsync(body, cancellationToken: cancellationToken);
        var branches = json.RootElement
            .GetProperty("data").GetProperty(SpaceCalibratorAppId.ToString())
            .GetProperty("depots").GetProperty("branches");
        return (Branch(branches, "public"), Branch(branches, "beta"));
    }

    private static SteamBranchBuild? Branch(JsonElement branches, string name)
    {
        if (!branches.TryGetProperty(name, out var branch)) return null;
        var build = branch.GetProperty("buildid").GetString() ?? "";
        DateTimeOffset? updated = branch.TryGetProperty("timeupdated", out var time) && long.TryParse(time.GetString(), out var seconds)
            ? DateTimeOffset.FromUnixTimeSeconds(seconds)
            : null;
        return new SteamBranchBuild(name, build, updated);
    }

    private string? ReadReviewed(string branch)
    {
        var database = _context?.Database;
        if (database == null) return null;
        try
        {
            using var connection = database.OpenConnection();
            using var command = connection.CreateCommand();
            command.CommandText = "SELECT build_id FROM steam_reviewed WHERE app_id = $a AND branch = $b;";
            command.Parameters.AddWithValue("$a", SpaceCalibratorAppId);
            command.Parameters.AddWithValue("$b", branch);
            return command.ExecuteScalar() as string;
        }
        catch (Microsoft.Data.Sqlite.SqliteException ex)
        {
            _context?.Log($"Could not read the reviewed build: {ex.Message}");
            return null;
        }
    }
}
