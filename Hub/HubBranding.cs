namespace HapsHub.Core;

/// <summary>
/// The name the app shows for itself. Anyone can change it in Settings; an empty choice means HapsHub.
/// It only changes what's on screen: the data folder, the exe and the name sent to servers stay HapsHub,
/// and the credit to VRCNext stays whatever the name is.
/// </summary>
public static class HubBranding
{
    public const int MaxLength = 40;

    private static volatile string _displayName = HubPaths.AppName;

    public static string DisplayName => _displayName;

    /// <summary>Runs after the name changes, on the thread that changed it.</summary>
    public static event Action<string>? Changed;

    /// <summary>A name that's safe to show anywhere: one line, no control characters, not longer than a title bar holds.</summary>
    public static string Clean(string? name)
    {
        if (string.IsNullOrWhiteSpace(name)) return HubPaths.AppName;
        var kept = new string(name.Where(c => !char.IsControl(c)).ToArray()).Trim();
        if (kept.Length > MaxLength) kept = kept[..MaxLength].TrimEnd();
        return kept.Length == 0 ? HubPaths.AppName : kept;
    }

    public static string Set(string? name)
    {
        var cleaned = Clean(name);
        if (cleaned == _displayName) return cleaned;
        _displayName = cleaned;
        try { Changed?.Invoke(cleaned); }
        catch (Exception) { /* A listener that fails must not undo the rename. */ }
        return cleaned;
    }
}
