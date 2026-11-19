namespace HapsHub.Core;

/// <summary>
/// Small features ported from VRCX, each off unless you turn it on:
/// a chime and flashing taskbar button when a queue for a full instance has a place for you (the in-app message
/// shows either way), and a clock beside friends you invited, or asked for an invite, in the last hour.
/// </summary>
public sealed class VrcxExtrasModule : IHubModule
{
    public const string ModuleId = "hub.vrcx-extras";
    public const string QueueAlarmKey = "queue_alarm";
    public const string RecentInvitesKey = "recent_invites";
    private HubModuleContext? _context;

    public string Id => ModuleId;
    public string DisplayName => "From VRCX";

    public IReadOnlyList<HubSettingDefinition> Settings { get; } = new[]
    {
        new HubSettingDefinition(QueueAlarmKey, "Chime and flash the taskbar when a queued instance is ready", HubSettingKind.Toggle, "false"),
        new HubSettingDefinition(RecentInvitesKey, "Show a clock beside friends you invited in the last hour", HubSettingKind.Toggle, "false"),
    };

    public bool QueueAlarm => string.Equals(_context?.GetSetting(QueueAlarmKey), "true", StringComparison.OrdinalIgnoreCase);

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
}
