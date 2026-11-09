namespace HapsHub.Core;

public sealed record EmbedApp(string Id, string Name, string ProcessName, string PathKey, string ModeKey, string ResultKey,
    string? KnownPath, string? SteamFolder, bool WebView2);

public sealed record EmbedRect(int X, int Y, int Width, int Height)
{
    public bool Usable => Width >= 40 && Height >= 40;

    public bool Matches(EmbedRect other, int tolerance = 2) =>
        Math.Abs(X - other.X) <= tolerance && Math.Abs(Y - other.Y) <= tolerance
        && Math.Abs(Width - other.Width) <= tolerance && Math.Abs(Height - other.Height) <= tolerance;
}

public sealed record EmbedCheck(string Name, bool Passed, string Detail = "");

public sealed record EmbedCandidate(nint Handle, bool Visible, string Title, int Width, int Height, bool Owned, bool ToolWindow);

public static class EmbedWindows
{
    private const int SmallestWindow = 200;

    /// <summary>The window that is the app: a real top-level one, preferring what's on screen, then the largest.</summary>
    public static EmbedCandidate? Pick(IEnumerable<EmbedCandidate> candidates) => candidates
        .Where(c => !c.Owned && !c.ToolWindow && c.Title.Length > 0 && c.Width >= SmallestWindow && c.Height >= SmallestWindow)
        .OrderByDescending(c => c.Visible)
        .ThenByDescending(c => (long)c.Width * c.Height)
        .FirstOrDefault();

    /// <summary>A failed capture comes back as one flat colour. Anything drawn has at least two.</summary>
    public static bool LooksDrawn(IEnumerable<int> samples) => samples.Distinct().Take(2).Count() >= 2;

    /// <summary>
    /// Chromium stops drawing a window it thinks is covered, and a window held inside another app's window always
    /// looks covered to it, so it went black. Both apps are Chromium inside (OyasumiVR through WebView2, Eagle through
    /// Electron), so HapsHub starts them with that check off. The msWeb/msPdf/SmartScreen entries are what Tauri sets
    /// itself, since this replaces its list.
    /// </summary>
    public const string ChromiumArguments =
        "--disable-features=CalculateNativeWinOcclusion,msWebOOUI,msPdfOOUI,msSmartScreenProtection --disable-backgrounding-occluded-windows";

    public static string Summary(string mode, IReadOnlyList<EmbedCheck> checks, string when)
    {
        var failed = checks.Where(c => !c.Passed).Select(c => c.Name).ToList();
        var place = mode == AppEmbedsModule.ModeChild ? "inside the pane" : "in its own window over the pane";
        return failed.Count == 0
            ? $"Passed {place} on {when}."
            : $"Failed {place} on {when}: {string.Join(", ", failed)}.";
    }
}

/// <summary>
/// Shows other apps' windows inside a HapsHub page. This holds what can be tested anywhere.
/// The window handling itself is in the app, since it only exists on Windows.
/// </summary>
public sealed class AppEmbedsModule : IHubModule
{
    public const string ModuleId = "hub.app-embeds";
    public const string ModeChild = "child";
    public const string ModeTracked = "tracked";

    public static readonly EmbedApp Oyasumi = new("oyasumi", "OyasumiVR", "OyasumiVR",
        "oyasumi_path", "oyasumi_mode", "oyasumi_result", null, "OyasumiVR", WebView2: true);

    public static readonly EmbedApp Eagle = new("eagle", "Eagle", "Eagle",
        "eagle_path", "eagle_mode", "eagle_result", @"C:\Program Files\Eagle\Eagle.exe", null, WebView2: false);

    public static IReadOnlyList<EmbedApp> Apps { get; } = new[] { Oyasumi, Eagle };

    private HubModuleContext? _context;

    public string Id => ModuleId;
    public string DisplayName => "App embeds";

    public IReadOnlyList<HubSettingDefinition> Settings { get; } = new[]
    {
        new HubSettingDefinition(Oyasumi.PathKey, "Path to OyasumiVR.exe. Empty looks in your Steam libraries", HubSettingKind.Text, ""),
        new HubSettingDefinition(Eagle.PathKey, "Path to Eagle.exe. Empty looks in Program Files", HubSettingKind.Text, ""),
        new HubSettingDefinition(Oyasumi.ModeKey, "OyasumiVR placement", HubSettingKind.Hidden, ModeChild),
        new HubSettingDefinition(Eagle.ModeKey, "Eagle placement", HubSettingKind.Hidden, ModeChild),
        new HubSettingDefinition(Oyasumi.ResultKey, "OyasumiVR test result", HubSettingKind.Hidden, ""),
        new HubSettingDefinition(Eagle.ResultKey, "Eagle test result", HubSettingKind.Hidden, ""),
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

    public bool Running => _context != null;

    public string Setting(string key) => _context?.GetSetting(key) ?? "";

    public string Mode(EmbedApp app) => Setting(app.ModeKey) == ModeTracked ? ModeTracked : ModeChild;

    public static EmbedApp? App(string? id) => Apps.FirstOrDefault(a => a.Id == id);

    public string? FindExe(EmbedApp app) =>
        FindExe(app, Setting(app.PathKey), SteamHost.SteamLibraries());

    /// <summary>The configured file if one is set, otherwise the app's usual places.</summary>
    public static string? FindExe(EmbedApp app, string? configured, IEnumerable<string> steamLibraries)
    {
        var chosen = configured?.Trim().Trim('"') ?? "";
        if (chosen.Length > 0) return File.Exists(chosen) ? chosen : null;
        if (app.KnownPath != null && File.Exists(app.KnownPath)) return app.KnownPath;
        if (app.SteamFolder == null) return null;
        return steamLibraries
            .Select(library => Path.Combine(library, "steamapps", "common", app.SteamFolder, app.ProcessName + ".exe"))
            .FirstOrDefault(File.Exists);
    }
}
