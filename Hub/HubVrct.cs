namespace HapsHub.Core;

/// <summary>Choices for the VRCT page, where HapsHub runs VRCT's engine itself. The engine keeps its own settings.</summary>
public sealed class HubVrctModule : IHubModule
{
    public const string ModuleId = "hub.vrct";
    public const string AutoStartKey = "auto_start";

    public string Id => ModuleId;
    public string DisplayName => "VRCT";

    public IReadOnlyList<HubSettingDefinition> Settings { get; } = new[]
    {
        new HubSettingDefinition(AutoStartKey, "Start VRCT's translator with HapsHub", HubSettingKind.Toggle, "false"),
    };

    public Task StartAsync(HubModuleContext context, CancellationToken cancellationToken) => Task.CompletedTask;

    public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;
}
