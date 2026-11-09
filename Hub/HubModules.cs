namespace HapsHub.Core;

/// <summary>Every HapsHub module, in start order. Adding a feature means adding one line here.</summary>
public static class HubModules
{
    public static UpstreamWatchModule UpstreamWatch { get; } = new();
    public static SteamBranchModule SteamBranch { get; } = new();
    public static VrcxHistoryModule VrcxHistory { get; } = new();
    public static HubCalendarModule Calendar { get; } = new();
    public static HubHistoryModule History { get; } = new();
    public static CrashRejoinModule CrashRejoin { get; } = new();
    public static OverlayEventsModule OverlayEvents { get; } = new();
    public static PhotoMetadataModule PhotoMetadata { get; } = new();

    public static IReadOnlyList<IHubModule> All() => new IHubModule[]
    {
        new HubProxyModule(),
        new ForwardingModule(),
        UpstreamWatch,
        SteamBranch,
        new HubUiModule(),
        VrcxHistory,
        Calendar,
        History,
        CrashRejoin,
        OverlayEvents,
        PhotoMetadata,
    };
}
