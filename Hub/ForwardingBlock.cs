using System.Collections.Concurrent;

namespace HapsHub.Core;

/// <summary>What the app would otherwise send about the user to third-party avatar services.</summary>
public enum ForwardingKind
{
    AvatarSubmit,
    DeletionReport,
    PopularityHit,
    PopularityLike,
    EntitlementLookup,
}

/// <summary>
/// The one gate for outgoing avatar data. Closed unless the forwarding module has opened it,
/// so a failed module or an unavailable database means nothing is sent.
/// Avatar search and Rose lookups are not forwarding and don't pass through here.
/// </summary>
public static class ForwardingBlock
{
    private static readonly ConcurrentDictionary<ForwardingKind, long> Blocked = new();
    private static volatile bool _forwardingOpen;
    private static volatile bool _lookupsOpen;
    private static volatile Action<string>? _log;

    public static bool Allows(ForwardingKind kind)
    {
        var open = kind == ForwardingKind.EntitlementLookup ? _lookupsOpen : _forwardingOpen;
        if (open) return true;
        if (Blocked.AddOrUpdate(kind, 1, (_, count) => count + 1) == 1)
            _log?.Invoke($"Forwarding block: stopped the first {kind} of this run.");
        return false;
    }

    public static long BlockedCount(ForwardingKind kind) => Blocked.TryGetValue(kind, out var count) ? count : 0;

    internal static void Apply(bool forwarding, bool lookups, Action<string>? log)
    {
        _log = log;
        _forwardingOpen = forwarding;
        _lookupsOpen = lookups;
    }

    internal static void Close() => Apply(false, false, _log);
}

/// <summary>Owns the block's settings. Both are off by default.</summary>
public sealed class ForwardingModule : IHubModule
{
    public const string ModuleId = "hub.forwarding";
    public const string ForwardKey = "forward_avatar_data";
    public const string LookupKey = "vrcnplus_lookups";

    private HubModuleContext? _context;

    public string Id => ModuleId;
    public string DisplayName => "Forwarding block";

    public IReadOnlyList<HubSettingDefinition> Settings { get; } = new[]
    {
        new HubSettingDefinition(ForwardKey, "Send avatar data to avatar databases", HubSettingKind.Toggle, "false"),
        new HubSettingDefinition(LookupKey, "Check VRCN+ status online", HubSettingKind.Toggle, "false"),
    };

    public Task StartAsync(HubModuleContext context, CancellationToken cancellationToken)
    {
        _context = context;
        Refresh();
        return Task.CompletedTask;
    }

    public Task StopAsync(CancellationToken cancellationToken)
    {
        _context = null;
        ForwardingBlock.Close();
        return Task.CompletedTask;
    }

    public void OnSettingChanged(string key, string value) => Refresh();

    private void Refresh()
    {
        var context = _context;
        if (context == null) return;
        ForwardingBlock.Apply(IsOn(context, ForwardKey), IsOn(context, LookupKey), context.Log);
    }

    private static bool IsOn(HubModuleContext context, string key) =>
        string.Equals(context.GetSetting(key), "true", StringComparison.OrdinalIgnoreCase);
}
