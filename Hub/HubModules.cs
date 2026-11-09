namespace HapsHub.Core;

/// <summary>Every HapsHub module, in start order. Adding a feature means adding one line here.</summary>
public static class HubModules
{
    public static IReadOnlyList<IHubModule> All() => Array.Empty<IHubModule>();
}
