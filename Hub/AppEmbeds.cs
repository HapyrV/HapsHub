namespace HapsHub.Core;

/// <summary>An app HapsHub can hold in a page. Chromium says how it's told to keep drawing while held: WebView2, Electron or none.</summary>
public sealed record EmbedApp(string Id, string Name, string ProcessName, string? KnownPath, string? SteamFolder, string Chromium)
{
    /// <summary>
    /// Where the app goes by default. Eagle and VRCT draw nothing while held inside the page (their GPU drawing
    /// doesn't reach a window held by another app), so they sit over the page as their own window instead.
    /// </summary>
    public string DefaultMode { get; init; } = AppEmbedsModule.ModeChild;

    public const string WebView2 = "webview2", Electron = "electron", NoChromium = "none";

    public string PathKey => Id + "_path";
    /// <summary>A new key for apps that changed their default, so a placement saved before doesn't keep them blank.</summary>
    public string ModeKey => Id + (DefaultMode == AppEmbedsModule.ModeTracked ? "_placement" : "_mode");
    public string ResultKey => Id + "_result";
    /// <summary>Set once it's been opened here, so the page opens it again by itself.</summary>
    public string AutoKey => Id + "_auto";
}

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
    /// looks covered to it, so it went black. OyasumiVR and VRCT are Chromium inside (through WebView2) and Eagle through
    /// Electron, so HapsHub starts them with that check off. The msWeb/msPdf/SmartScreen entries are what Tauri sets
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

    /// <summary>What happens to the apps HapsHub is holding when HapsHub closes.</summary>
    public const string ExitKey = "on_exit";
    public const string ExitMinimize = "minimize";
    public const string ExitClose = "close";
    public const string ExitLeave = "leave";

    public static readonly EmbedApp Oyasumi = new("oyasumi", "OyasumiVR", "OyasumiVR", null, "OyasumiVR", EmbedApp.WebView2);
    /// <summary>Shown in a tab inside Media Library rather than a page of its own.</summary>
    public static readonly EmbedApp Eagle = new("eagle", "Eagle", "Eagle", @"%ProgramFiles%\Eagle\Eagle.exe", null, EmbedApp.Electron) { DefaultMode = ModeTracked };
    public static readonly EmbedApp SpaceCalibrator = new("spacecal", "Space Calibrator", "OpenVR-SpaceCalibrator",
        @"%ProgramFiles%\OpenVR-SpaceCalibrator\OpenVR-SpaceCalibrator.exe", null, EmbedApp.NoChromium);
    public static readonly EmbedApp Vrct = new("vrct", "VRCT", "VRCT", @"%LOCALAPPDATA%\VRCT\VRCT.exe", null, EmbedApp.WebView2) { DefaultMode = ModeTracked };
    public static readonly EmbedApp OvrToolkit = new("ovrtoolkit", "OVR Toolkit", "OVR Toolkit", null, "OVR Toolkit", EmbedApp.NoChromium);

    public static IReadOnlyList<EmbedApp> Apps { get; } = new[] { Oyasumi, Eagle, SpaceCalibrator, Vrct, OvrToolkit };

    private HubModuleContext? _context;

    public string Id => ModuleId;
    public string DisplayName => "App embeds";

    public IReadOnlyList<HubSettingDefinition> Settings { get; } = Apps
        .Select(app => new HubSettingDefinition(app.PathKey,
            $"Path to {app.ProcessName}.exe. Empty looks in {(app.SteamFolder != null ? "your Steam libraries" : "its usual place")}", HubSettingKind.Text, ""))
        .Concat(Apps.Select(app => new HubSettingDefinition(app.ModeKey, $"{app.Name} placement", HubSettingKind.Hidden, app.DefaultMode)))
        .Concat(Apps.Select(app => new HubSettingDefinition(app.ResultKey, $"{app.Name} test result", HubSettingKind.Hidden, "")))
        .Concat(Apps.Select(app => new HubSettingDefinition(app.AutoKey, $"Open {app.Name} with its page", HubSettingKind.Hidden, "")))
        .Prepend(new HubSettingDefinition(ExitKey, "When HapsHub closes, apps open in its pages", HubSettingKind.Choice, ExitMinimize)
        {
            Options = new[]
            {
                new HubSettingOption(ExitMinimize, "Minimize"),
                new HubSettingOption(ExitClose, "Close too"),
                new HubSettingOption(ExitLeave, "Stay open"),
            },
        })
        .ToArray();

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

    public bool OpensWithPage(EmbedApp app) => Setting(app.AutoKey) == "1";

    public string ExitAction => Setting(ExitKey) switch
    {
        ExitClose => ExitClose,
        ExitLeave => ExitLeave,
        _ => ExitMinimize,
    };

    public static EmbedApp? App(string? id) => Apps.FirstOrDefault(a => a.Id == id);

    public string? FindExe(EmbedApp app) =>
        FindExe(app, Setting(app.PathKey), SteamHost.SteamLibraries());

    /// <summary>The configured file if one is set, otherwise the app's usual places.</summary>
    public static string? FindExe(EmbedApp app, string? configured, IEnumerable<string> steamLibraries)
    {
        var chosen = configured?.Trim().Trim('"') ?? "";
        if (chosen.Length > 0) return File.Exists(chosen) ? chosen : null;
        var known = app.KnownPath == null ? null : WinePrefix.Expand(app.KnownPath);
        if (known != null && File.Exists(known)) return known;
        if (app.SteamFolder == null) return null;
        return steamLibraries
            .Select(library => Path.Combine(library, "steamapps", "common", app.SteamFolder, app.ProcessName + ".exe"))
            .FirstOrDefault(File.Exists);
    }
}
