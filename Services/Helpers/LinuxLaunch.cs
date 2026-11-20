#if !WINDOWS
using System.Diagnostics;
using HapsHub.Core;

namespace VRCNext.Services.Helpers;

/// <summary>
/// Starts programs on Linux, where most VR tools are Windows programs. One inside a Steam library starts through
/// Steam, which runs it with Proton and keeps its SteamVR bindings. Any other .exe runs with Wine when it's installed.
/// </summary>
public static class LinuxLaunch
{
    /// <summary>Starts the program. Returns null when it started, otherwise a sentence saying why it couldn't.</summary>
    public static string? Start(string path)
    {
        path = path.Trim().Trim('"');
        var steamAppId = SteamHost.AppIdForProgram(path);
        if (steamAppId != null)
        {
            OpenUri($"steam://rungameid/{steamAppId}");
            return null;
        }
        if (path.EndsWith(".exe", StringComparison.OrdinalIgnoreCase))
        {
            var wine = WinePrefix.OnPath("wine");
            if (wine == null)
                return $"{Path.GetFileName(path)} is a Windows program. Install Wine, or add it to Steam as a non-Steam game and start it from there.";
            var viaWine = new ProcessStartInfo(wine) { WorkingDirectory = Path.GetDirectoryName(path) ?? "", UseShellExecute = false };
            viaWine.ArgumentList.Add(path);
            Process.Start(viaWine)?.Dispose();
            return null;
        }
        var executable = false;
        try { executable = (File.GetUnixFileMode(path) & (UnixFileMode.UserExecute | UnixFileMode.GroupExecute | UnixFileMode.OtherExecute)) != 0; }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
        if (executable)
            Process.Start(new ProcessStartInfo(path) { WorkingDirectory = Path.GetDirectoryName(path) ?? "", UseShellExecute = false })?.Dispose();
        else
            OpenUri(path);
        return null;
    }

    /// <summary>Opens a file or link with the desktop's default handler.</summary>
    public static void OpenUri(string target)
    {
        var info = new ProcessStartInfo("xdg-open") { UseShellExecute = false };
        info.ArgumentList.Add(target);
        Process.Start(info)?.Dispose();
    }
}
#endif
