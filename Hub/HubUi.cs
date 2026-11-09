namespace HapsHub.Core;

/// <summary>Choices about HapsHub's own interface. The page reads them through the module list.</summary>
public sealed class HubUiModule : IHubModule
{
    public const string ModuleId = "hub.ui";

    public string Id => ModuleId;
    public string DisplayName => "Dashboard";

    public IReadOnlyList<HubSettingDefinition> Settings { get; } = new[]
    {
        new HubSettingDefinition("dash_welcome", "Show the welcome message", HubSettingKind.Toggle, "true"),
        new HubSettingDefinition("dash_online", "Show players online", HubSettingKind.Toggle, "true"),
        new HubSettingDefinition("dash_status", "Show VRChat status", HubSettingKind.Toggle, "true"),
        new HubSettingDefinition("dash_friends", "Show friends in game", HubSettingKind.Toggle, "true"),
        new HubSettingDefinition("dash_web", "Show friends on web", HubSettingKind.Toggle, "true"),
        new HubSettingDefinition("letter_spacing", "Letter spacing", HubSettingKind.Number, "0"),
        // Welcome messages: built-in numbers switched off (comma-separated) and the user's own, as a JSON array.
        new HubSettingDefinition("welcome_off", "Welcome messages switched off", HubSettingKind.Text, ""),
        new HubSettingDefinition("welcome_custom", "Your welcome messages", HubSettingKind.Text, "[]"),
    };

    public Task StartAsync(HubModuleContext context, CancellationToken cancellationToken) => Task.CompletedTask;

    public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;
}
