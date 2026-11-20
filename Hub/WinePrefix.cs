namespace HapsHub.Core;

/// <summary>
/// Where Windows programs live on Linux. Apps installed with Wine sit in its prefix (~/.wine, or $WINEPREFIX), so
/// %LOCALAPPDATA%-style paths point there. On Windows everything is the normal Windows lookup.
/// </summary>
public static class WinePrefix
{
    public static string Root => Environment.GetEnvironmentVariable("WINEPREFIX") is { Length: > 0 } prefix
        ? prefix
        : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".wine");

    /// <summary>Expands %LOCALAPPDATA%, %APPDATA% and %ProgramFiles% to their places in the Wine prefix and uses
    /// forward slashes. On Windows it's the usual environment-variable expansion.</summary>
    public static string Expand(string windowsPath)
    {
        if (OperatingSystem.IsWindows()) return Environment.ExpandEnvironmentVariables(windowsPath);
        var drive = Path.Combine(Root, "drive_c");
        var user = Path.Combine(drive, "users", Environment.UserName);
        var places = new (string Variable, string Place)[]
        {
            ("%LOCALAPPDATA%", Path.Combine(user, "AppData", "Local")),
            ("%APPDATA%", Path.Combine(user, "AppData", "Roaming")),
            ("%ProgramFiles(x86)%", Path.Combine(drive, "Program Files (x86)")),
            ("%ProgramFiles%", Path.Combine(drive, "Program Files")),
        };
        foreach (var (variable, place) in places)
            windowsPath = windowsPath.Replace(variable, place, StringComparison.OrdinalIgnoreCase);
        return windowsPath.Replace('\\', '/');
    }

    /// <summary>The full path of a program on PATH, or null.</summary>
    public static string? OnPath(string name)
    {
        foreach (var folder in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries))
        {
            try
            {
                var candidate = Path.Combine(folder.Trim('"'), name);
                if (File.Exists(candidate)) return candidate;
            }
            catch (ArgumentException) { /* A malformed PATH entry. */ }
        }
        return null;
    }
}
