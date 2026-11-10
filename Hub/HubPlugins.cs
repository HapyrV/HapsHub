using System.Text.Json;

namespace HapsHub.Core;

/// <summary>A plugin as the hub sees it: the background modules it owns. The page holds everything else about it.</summary>
public sealed record HubPlugin(string Id, IReadOnlyList<string> Modules, bool OnForNewUsers = true);

/// <summary>
/// Which optional features are switched on. Every plugin is on until someone turns it off, so an existing install
/// keeps working as before. A new install picks them in setup ("what do you use?"), which also decides
/// Performance mode. Turning a plugin off stops the background modules it owns; the page hides the rest.
/// </summary>
public sealed class HubPluginsModule : IHubModule
{
    public const string ModuleId = "hub.plugins";
    public const string EnabledKey = "enabled";
    public const string PickedKey = "picked";

    public static readonly IReadOnlyList<HubPlugin> Catalog = new HubPlugin[]
    {
        new("history", new[] { "hub.history" }),
        new("youtube-tunnel", new[] { "hub.youtube-tunnel" }),
        new("crash-rejoin", new[] { "hub.crash-rejoin" }),
        new("overlay-events", new[] { "hub.overlay-events" }),
        new("photo-metadata", new[] { "hub.photo-metadata" }),
        new("vrcx", new[] { "hub.vrcx-history" }),
        new("spacecal", new[] { "hub.steam-branch" }),
        // Watches VRCNext, VRCX and Space Calibrator for new commits: for whoever maintains HapsHub, not its users.
        new("upstream-watch", new[] { "hub.upstream-watch" }, OnForNewUsers: false),
        new("proxy", new[] { "hub.proxy" }),
        new("oyasumi", Array.Empty<string>()),
        new("eagle", Array.Empty<string>()),
        new("vrct", new[] { "hub.vrct" }),
        new("ovrtoolkit", Array.Empty<string>()),
        new("ovr-advanced", Array.Empty<string>()),
        new("friend-schedule", Array.Empty<string>()),
        new("launch-switches", Array.Empty<string>()),
        new("vr-autostart", Array.Empty<string>()),
        new("world-map", Array.Empty<string>()),
        new("space-flight", Array.Empty<string>()),
        new("space-turn", Array.Empty<string>()),
        new("youtube-fix", Array.Empty<string>()),
        new("frame-shot", Array.Empty<string>()),
        new("osc-tool", Array.Empty<string>()),
        new("voice-fight", Array.Empty<string>()),
        new("discord-presence", Array.Empty<string>()),
        new("vr-overlay", Array.Empty<string>()),
        new("permini", Array.Empty<string>()),
        new("kikitan-xd", Array.Empty<string>()),
        new("event-snipe", Array.Empty<string>()),
        new("avatar-scaling", Array.Empty<string>()),
        new("action-flow", Array.Empty<string>()),
        new("status-schedule", Array.Empty<string>()),
        new("media-relay", Array.Empty<string>()),
        new("chatbox", Array.Empty<string>()),
    };

    private HubModuleContext? _context;
    // Two switches flipped at once would otherwise each save over the other.
    private readonly object _saveLock = new();

    public string Id => ModuleId;
    public string DisplayName => "Plugins";

    public IReadOnlyList<HubSettingDefinition> Settings { get; } = new[]
    {
        // A JSON map of plugin id to true or false. A plugin that isn't in it is on.
        new HubSettingDefinition(EnabledKey, "Plugins switched on or off", HubSettingKind.Hidden, "{}"),
        new HubSettingDefinition(PickedKey, "Plugins were picked in setup", HubSettingKind.Hidden, ""),
    };

    public static HubPlugin? Find(string? id) => Catalog.FirstOrDefault(p => p.Id == id);

    /// <summary>The plugin a background module belongs to, if any.</summary>
    public static HubPlugin? OwnerOf(string moduleId) => Catalog.FirstOrDefault(p => p.Modules.Contains(moduleId));

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

    /// <summary>Every plugin with whether it's on. Plugins this version doesn't know are dropped.</summary>
    public IReadOnlyDictionary<string, bool> States() => Merge(Parse(_context?.GetSetting(EnabledKey)));

    public bool IsOn(string id) => !States().TryGetValue(id, out var on) || on;

    public bool Picked => _context?.GetSetting(PickedKey) == "1";

    /// <summary>Saves one plugin's switch. False if the plugin is unknown or the choice couldn't be saved.</summary>
    public bool Set(string id, bool on)
    {
        if (_context == null || Find(id) == null) return false;
        lock (_saveLock)
        {
            var states = new Dictionary<string, bool>(States()) { [id] = on };
            return _context.SetSetting(EnabledKey, Serialize(states));
        }
    }

    /// <summary>Setup's answer: each plugin on or off. Anything not mentioned takes its default for a new user.</summary>
    public bool SetAll(IReadOnlyDictionary<string, bool> picks)
    {
        if (_context == null) return false;
        var states = Catalog.ToDictionary(p => p.Id, p => picks.TryGetValue(p.Id, out var on) ? on : p.OnForNewUsers);
        return _context.SetSetting(EnabledKey, Serialize(states)) && _context.SetSetting(PickedKey, "1");
    }

    public static Dictionary<string, bool> Parse(string? json)
    {
        var result = new Dictionary<string, bool>(StringComparer.Ordinal);
        if (string.IsNullOrWhiteSpace(json)) return result;
        try
        {
            using var document = JsonDocument.Parse(json);
            if (document.RootElement.ValueKind != JsonValueKind.Object) return result;
            foreach (var property in document.RootElement.EnumerateObject())
                if (property.Value.ValueKind is JsonValueKind.True or JsonValueKind.False)
                    result[property.Name] = property.Value.GetBoolean();
        }
        catch (JsonException) { }
        return result;
    }

    public static Dictionary<string, bool> Merge(IReadOnlyDictionary<string, bool> saved) =>
        Catalog.ToDictionary(p => p.Id, p => !saved.TryGetValue(p.Id, out var on) || on);

    public static string Serialize(IReadOnlyDictionary<string, bool> states) =>
        JsonSerializer.Serialize(states.OrderBy(s => s.Key, StringComparer.Ordinal).ToDictionary(s => s.Key, s => s.Value));
}
