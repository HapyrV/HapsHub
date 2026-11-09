namespace HapsHub.Core;

/// <summary>
/// The one place that decides where HapsHub keeps its data. Portable builds and
/// tests move everything by changing the root here. Locations the app does not
/// own (VRChat, Steam, Pictures) and files shipped beside the exe do not belong here.
/// </summary>
public static class HubPaths
{
    public const string AppName = "HapsHub";

    /// <summary>When set, all app data lives under this folder instead of the user profile.</summary>
    public const string DataDirVariable = "HAPSHUB_DATA_DIR";

    private static readonly Lazy<string> _dataRoot = new(() =>
        Override() ?? Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), AppName));

    private static readonly Lazy<string> _localRoot = new(() =>
    {
        var over = Override();
        return over != null
            ? Path.Combine(over, "Local")
            : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), AppName);
    });

    /// <summary>Roaming data: settings, databases, caches, logs.</summary>
    public static string DataRoot => _dataRoot.Value;

    /// <summary>Machine-local data that can be rebuilt, such as downloaded fonts.</summary>
    public static string LocalRoot => _localRoot.Value;

    /// <summary>HapsHub's own files, kept apart from the ones inherited from upstream.</summary>
    public static string HubRoot => Data("Hub");

    /// <summary>True when a test run has pointed the app at its own folders.</summary>
    public static bool IsOverridden => Override() != null;

    /// <summary>Keeps a run with its own folders from colliding with the real app's single-instance locks.</summary>
    public static string InstanceSuffix => IsOverridden
        ? "_" + Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(
            System.Text.Encoding.UTF8.GetBytes(DataRoot.ToLowerInvariant())))[..12]
        : "";

    public static string Data(params string[] parts) => Under(DataRoot, parts);

    public static string Local(params string[] parts) => Under(LocalRoot, parts);

    private static string Under(string root, string[] parts)
    {
        var all = new string[parts.Length + 1];
        all[0] = root;
        parts.CopyTo(all, 1);
        return Path.Combine(all);
    }

    /// <summary>A file with this name beside the exe keeps all data in a Data folder there.</summary>
    public const string PortableMarker = "portable.txt";

    private static string? Override()
    {
        var value = Environment.GetEnvironmentVariable(DataDirVariable);
        if (!string.IsNullOrWhiteSpace(value)) return Path.GetFullPath(value);
        return File.Exists(Path.Combine(AppContext.BaseDirectory, PortableMarker))
            ? Path.Combine(AppContext.BaseDirectory, "Data")
            : null;
    }
}
