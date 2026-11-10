namespace HapsHub.Core;

/// <summary>
/// Performance mode: one switch that turns off the costly effects for slower PCs, each of which can be kept on.
/// The first time it runs, it's switched on by itself on a PC with four threads or fewer, or under 8 GB of memory.
/// The page applies it; this keeps the choice and says what kind of PC this is.
/// </summary>
public sealed class HubPerformanceModule : IHubModule
{
    public const string ModuleId = "hub.performance";
    public const string ModeKey = "mode";
    public const int WeakThreads = 4;
    public const double WeakMemoryGb = 7.5;

    /// <summary>What Performance mode can turn off. Each is on (cut) by default once the mode is on.</summary>
    public static readonly string[] Cuts = { "blur", "animations", "pictures", "glass", "polling" };

    public string Id => ModuleId;
    public string DisplayName => "Performance mode";

    public IReadOnlyList<HubSettingDefinition> Settings { get; } = new[]
    {
        // Empty until decided, so the first run can pick for this PC.
        new HubSettingDefinition(ModeKey, "Performance mode", HubSettingKind.Toggle, ""),
        new HubSettingDefinition("cut_blur", "No blur behind menus and cards", HubSettingKind.Toggle, "true"),
        new HubSettingDefinition("cut_animations", "No animations", HubSettingKind.Toggle, "true"),
        new HubSettingDefinition("cut_pictures", "No profile pictures in the Mutual Network", HubSettingKind.Toggle, "true"),
        new HubSettingDefinition("cut_glass", "No fade effect while scrolling the dashboard", HubSettingKind.Toggle, "true"),
        new HubSettingDefinition("cut_polling", "Check app pages less often", HubSettingKind.Toggle, "true"),
    };

    public static int Threads => Environment.ProcessorCount;

    public static double MemoryGb
    {
        get
        {
            try { return Math.Round(GC.GetGCMemoryInfo().TotalAvailableMemoryBytes / (1024.0 * 1024 * 1024), 1); }
            catch (Exception) { return 0; }
        }
    }

    public static bool IsWeak(int threads, double memoryGb) => threads <= WeakThreads || (memoryGb > 0 && memoryGb < WeakMemoryGb);

    public static bool WeakMachine => IsWeak(Threads, MemoryGb);

    public Task StartAsync(HubModuleContext context, CancellationToken cancellationToken)
    {
        if (context.GetSetting(ModeKey) == "")
        {
            var on = WeakMachine;
            context.SetSetting(ModeKey, on ? "true" : "false");
            context.Log(on ? $"Performance mode switched on for a PC with {Threads} threads and {MemoryGb} GB." : "Performance mode left off.");
        }
        return Task.CompletedTask;
    }

    public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;
}
