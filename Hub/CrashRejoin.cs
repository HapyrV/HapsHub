namespace HapsHub.Core;

public enum CrashRejoinDecision { Off, QuitNormally, NotInAnInstance, TooSoon, SteamVrClosedToo, Rejoin }

/// <summary>Brings you back to your instance when VRChat crashes. Off unless you turn it on.</summary>
public sealed class CrashRejoinModule : IHubModule
{
    public const string ModuleId = "hub.crash-rejoin";
    private const string EnabledKey = "rejoin";
    private static readonly TimeSpan LoopGuard = TimeSpan.FromMinutes(2);
    private HubModuleContext? _context;
    private DateTime _lastRejoin = DateTime.MinValue;

    public string Id => ModuleId;
    public string DisplayName => "Crash rejoin";

    public IReadOnlyList<HubSettingDefinition> Settings { get; } = new[]
    {
        new HubSettingDefinition(EnabledKey, "Reopen VRChat and rejoin your instance after a crash", HubSettingKind.Toggle, "false"),
    };

    public bool Enabled => string.Equals(_context?.GetSetting(EnabledKey), "true", StringComparison.OrdinalIgnoreCase);

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

    /// <summary>The log's last words tell a normal exit from a crash.</summary>
    public static bool IsNormalQuitLine(string line) =>
        line.Contains("VRCApplication: OnApplicationQuit at ", StringComparison.Ordinal)
        || line.Contains("VRCApplication: HandleApplicationQuit at ", StringComparison.Ordinal);

    /// <summary>Only a world instance can be rejoined, not "offline", "private" or "traveling".</summary>
    public static bool IsRealInstance(string? location) =>
        !string.IsNullOrEmpty(location) && location.StartsWith("wrld_", StringComparison.Ordinal) && location.Contains(':');

    /// <summary>
    /// Whether to reopen VRChat, a moment after it stopped running. If you were in VR and SteamVR
    /// has closed as well, you've most likely stopped playing, so it stays closed.
    /// </summary>
    public static CrashRejoinDecision Decide(bool enabled, bool closedNormally, string? location,
        DateTime lastRejoin, DateTime now, bool wasInVr, bool steamVrRunningNow)
    {
        if (!enabled) return CrashRejoinDecision.Off;
        if (closedNormally) return CrashRejoinDecision.QuitNormally;
        if (!IsRealInstance(location)) return CrashRejoinDecision.NotInAnInstance;
        if (now - lastRejoin < LoopGuard) return CrashRejoinDecision.TooSoon;
        if (wasInVr && !steamVrRunningNow) return CrashRejoinDecision.SteamVrClosedToo;
        return CrashRejoinDecision.Rejoin;
    }

    public CrashRejoinDecision DecideNow(bool closedNormally, string? location, bool wasInVr, bool steamVrRunningNow)
    {
        var now = DateTime.UtcNow;
        var decision = Decide(Enabled, closedNormally, location, _lastRejoin, now, wasInVr, steamVrRunningNow);
        if (decision == CrashRejoinDecision.Rejoin) _lastRejoin = now;
        _context?.Log($"VRChat stopped: {decision}");
        return decision;
    }
}
