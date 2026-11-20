namespace HapsHub.Core;

/// <summary>
/// The extra apps the Launch window's switches start with VRChat: haptics, face tracking and full-body tracking.
/// Each switch has its own list of apps. An empty list is filled from what's installed the first time it's used.
/// </summary>
public static class LaunchAddons
{
    public const string Haptics = "haptics";
    public const string FaceTracking = "faceTracking";
    public const string Fbt = "fbt";

    public static readonly string[] Kinds = { Haptics, FaceTracking, Fbt };

    /// <summary>Installed apps for one switch, best first. Steam copies come before standalone ones.</summary>
    public static List<string> Detect(string kind)
    {
        var steam = SteamHost.SteamLibraries().Select(l => Path.Combine(l, "steamapps", "common")).ToList();
        // On Linux, standalone Windows installs live in the Wine prefix.
        var local = WinePrefix.Expand("%LOCALAPPDATA%");
        var programs = WinePrefix.Expand("%ProgramFiles%");
        IEnumerable<string[]> groups = kind switch
        {
            // One entry per app; the first path found in each group wins.
            Haptics => new[]
            {
                steam.Select(c => Path.Combine(c, "bHapticsPlayer", "BhapticsPlayer.exe"))
                    .Append(Path.Combine(local, "bHapticsPlayer", "BhapticsPlayer.exe")).ToArray(),
            },
            FaceTracking => new[]
            {
                steam.Select(c => Path.Combine(c, "VRCFaceTracking", "VRCFaceTracking.exe")).ToArray(),
            },
            Fbt => new[]
            {
                steam.Select(c => Path.Combine(c, "01spacecalibrator", "SpaceCalibrator.exe"))
                    .Append(Path.Combine(programs, "OpenVR-SpaceCalibrator", "OpenVR-SpaceCalibrator.exe")).ToArray(),
            },
            _ => Array.Empty<string[]>(),
        };
        var found = new List<string>();
        foreach (var group in groups)
        {
            var hit = group.FirstOrDefault(File.Exists);
            if (hit != null) found.Add(hit);
        }
        return found;
    }

    /// <summary>The apps the Launch window's switches that are on start with VRChat. Full-body tracking and
    /// VR-only switches start only in VR.</summary>
    public static List<string> SwitchedOn(bool vr, bool haptics, IEnumerable<string> hapticsApps, bool face, IEnumerable<string> faceApps,
        bool fbt, IEnumerable<string> fbtApps, IEnumerable<CustomLaunchSwitch> custom)
    {
        var apps = new List<string>();
        if (haptics) apps.AddRange(hapticsApps);
        if (face) apps.AddRange(faceApps);
        if (vr && fbt) apps.AddRange(fbtApps);
        foreach (var sw in custom ?? Enumerable.Empty<CustomLaunchSwitch>())
            if (sw.On && (vr || !sw.VrOnly)) apps.AddRange(sw.Apps ?? new List<string>());
        return apps.Where(a => !string.IsNullOrWhiteSpace(a)).Distinct(StringComparer.OrdinalIgnoreCase).ToList();
    }

    /// <summary>A VR app Settings offers as its own "Start with VR" switch. Path is null when it isn't installed.</summary>
    public sealed record KnownApp(string Id, string Name, string? Path);

    /// <summary>VR apps that aren't behind a Launch window switch and that SteamVR doesn't start by itself.</summary>
    public static List<KnownApp> KnownVrApps()
    {
        var steam = SteamHost.SteamLibraries().Select(l => Path.Combine(l, "steamapps", "common")).ToList();
        var local = WinePrefix.Expand("%LOCALAPPDATA%");
        string? First(IEnumerable<string> paths) => paths.FirstOrDefault(File.Exists);
        string? StandableExe()
        {
            foreach (var common in steam)
            {
                var dir = Path.Combine(common, "Standable Full Body Estimation");
                if (!Directory.Exists(dir)) continue;
                try
                {
                    var exe = Directory.EnumerateFiles(dir, "*.exe", SearchOption.AllDirectories)
                        .FirstOrDefault(f => Path.GetFileName(f).Contains("Standable", StringComparison.OrdinalIgnoreCase));
                    if (exe != null) return exe;
                }
                catch { }
            }
            return null;
        }
        return new List<KnownApp>
        {
            new("oyasumi", "OyasumiVR", First(steam.Select(c => Path.Combine(c, "OyasumiVR", "OyasumiVR.exe")))),
            new("standable", "Standable", StandableExe()),
            new("ovr-advanced", "OVR Advanced Settings", First(steam.SelectMany(c => new[]
                { Path.Combine(c, "OVR_AdvancedSettings", "AdvancedSettings.exe"), Path.Combine(c, "OVR_AdvancedSettings", "AdvancedSettings") }))),
            new("vrct", "VRCT", First(new[] { Path.Combine(local, "VRCT", "VRCT.exe") })),
        };
    }

    /// <summary>Paths in <paramref name="apps"/> whose program isn't running yet, so nothing starts twice.</summary>
    public static List<string> NotRunning(IEnumerable<string> apps)
    {
        var result = new List<string>();
        foreach (var app in apps)
        {
            var name = Path.GetFileNameWithoutExtension((app ?? "").Trim().Trim('"'));
            if (string.IsNullOrEmpty(name)) continue;
            var running = System.Diagnostics.Process.GetProcessesByName(name);
            foreach (var process in running) process.Dispose();
            if (running.Length == 0) result.Add(app!);
        }
        return result;
    }
}

/// <summary>A Launch window switch the user added. When it's on, its apps start with VRChat.</summary>
public sealed class CustomLaunchSwitch
{
    public string Id { get; set; } = "";
    public string Name { get; set; } = "";
    public string Icon { get; set; } = "rocket_launch";
    public bool On { get; set; }
    public bool VrOnly { get; set; }
    public List<string> Apps { get; set; } = new();
}
