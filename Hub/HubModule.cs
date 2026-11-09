namespace HapsHub.Core;

public enum HubModuleStatus { Registered, Disabled, Starting, Running, Degraded, Failed, Stopped }

public enum HubSettingKind { Toggle, Text, Number, Hidden, Choice }

/// <summary>A setting owned by a module. Settings only exist through a module, so no toggle is left without a feature.</summary>
public sealed record HubSettingDefinition(string Key, string Label, HubSettingKind Kind, string DefaultValue)
{
    /// <summary>What a Choice can be set to: the stored value and the text shown for it.</summary>
    public IReadOnlyList<HubSettingOption> Options { get; init; } = Array.Empty<HubSettingOption>();
}

public sealed record HubSettingOption(string Value, string Label);

public sealed record HubSettingInfo(HubSettingDefinition Definition, string Value);

public sealed record HubModuleInfo(
    string Id, string DisplayName, bool Enabled, HubModuleStatus Status, string Detail,
    IReadOnlyList<HubSettingInfo> Settings);

/// <summary>
/// One optional HapsHub feature. The registry contains its failures: an exception,
/// a hang or a crash during start costs this module, never the app or other modules.
/// </summary>
public interface IHubModule
{
    /// <summary>Stable and unique. Stored in the database, so it must never change.</summary>
    string Id { get; }

    string DisplayName { get; }

    bool EnabledByDefault => true;

    /// <summary>Tables owned by this module. Non-empty means it can't run without the database.</summary>
    IReadOnlyList<HubMigration> Migrations => Array.Empty<HubMigration>();

    IReadOnlyList<HubSettingDefinition> Settings => Array.Empty<HubSettingDefinition>();

    Task StartAsync(HubModuleContext context, CancellationToken cancellationToken);

    Task StopAsync(CancellationToken cancellationToken);

    /// <summary>Runs after a setting of this module is saved, while the module is running.</summary>
    void OnSettingChanged(string key, string value) { }
}

/// <summary>What a running module may use. Handed to it at start.</summary>
public sealed class HubModuleContext
{
    private readonly ModuleRegistry _registry;
    private readonly CancellationTokenSource _lifetime = new();
    private readonly List<Task> _background = new();

    internal HubModuleContext(ModuleRegistry registry, string moduleId, HubDatabase? database)
    {
        _registry = registry;
        ModuleId = moduleId;
        Database = database;
    }

    public string ModuleId { get; }

    /// <summary>Null when the database is unavailable. Set for every module that declares migrations.</summary>
    public HubDatabase? Database { get; }

    /// <summary>Cancelled when the module is being stopped.</summary>
    public CancellationToken Stopping => _lifetime.Token;

    public void Log(string message) => _registry.Log($"{ModuleId}: {message}");

    /// <summary>The module still works but has lost a capability, such as a missing helper app.</summary>
    public void ReportDegraded(string reason) => _registry.ReportHealth(ModuleId, this, reason);

    public void ReportHealthy() => _registry.ReportHealth(ModuleId, this, null);

    public string GetSetting(string key) => _registry.GetSetting(ModuleId, key);

    /// <summary>Runs long work so that an exception fails only this module instead of going unnoticed.</summary>
    public void RunBackground(string name, Func<CancellationToken, Task> work)
    {
        var task = Task.Run(async () =>
        {
            try
            {
                await work(Stopping);
            }
            catch (OperationCanceledException) when (Stopping.IsCancellationRequested)
            {
            }
            catch (Exception ex)
            {
                _registry.ReportBackgroundFailure(ModuleId, this, name, ex);
            }
        });
        lock (_background)
        {
            _background.RemoveAll(t => t.IsCompleted);
            _background.Add(task);
        }
    }

    internal void Cancel()
    {
        try { _lifetime.Cancel(); }
        catch (AggregateException ex) { _registry.Log($"{ModuleId}: stop callback failed: {ex.GetBaseException().Message}"); }
    }

    internal Task WaitForBackground()
    {
        lock (_background) return Task.WhenAll(_background.ToArray());
    }
}
