namespace HapsHub.Core;

/// <summary>Extra events for the VR overlay. The ones that fire often in public worlds start off.</summary>
public sealed class OverlayEventsModule : IHubModule
{
    public const string ModuleId = "hub.overlay-events";
    public const string FriendAdded = "friend_added";
    public const string FriendRemoved = "friend_removed";
    public const string NameChange = "name_change";
    public const string TrustChange = "trust_change";
    public const string PortalSpawn = "portal_spawn";

    private HubModuleContext? _context;

    public string Id => ModuleId;
    public string DisplayName => "VR overlay events";

    public IReadOnlyList<HubSettingDefinition> Settings { get; } = new[]
    {
        new HubSettingDefinition(FriendAdded, "Someone becomes your friend", HubSettingKind.Toggle, "true"),
        new HubSettingDefinition(FriendRemoved, "Someone stops being your friend", HubSettingKind.Toggle, "true"),
        new HubSettingDefinition(NameChange, "A friend changes their name", HubSettingKind.Toggle, "true"),
        new HubSettingDefinition(TrustChange, "A friend's trust rank changes", HubSettingKind.Toggle, "true"),
        new HubSettingDefinition(PortalSpawn, "A portal opens in your instance", HubSettingKind.Toggle, "false"),
    };

    /// <summary>Title, text, image, and the friend it's about.</summary>
    public event Action<string, string, string, string>? Show;

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

    public void Raise(string key, string title, string text, string image = "", string friendId = "")
    {
        if (!string.Equals(_context?.GetSetting(key), "true", StringComparison.OrdinalIgnoreCase)) return;
        Show?.Invoke(title, text, image, friendId);
    }
}
