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
        var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        var programs = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
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
