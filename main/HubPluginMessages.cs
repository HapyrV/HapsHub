using HapsHub.Core;
using Newtonsoft.Json.Linq;
using VRCNext.Services;

namespace VRCNext;

// The Plugins page and setup's "what do you use?" step.
public partial class AppShell
{
    private bool HandlePluginMessage(string action, JObject msg)
    {
        switch (action)
        {
            case "hubPlugins":
                SendPlugins();
                return true;

            case "hubPluginSet":
                var id = msg["id"]?.ToString() ?? "";
                var on = msg["on"]?.Value<bool>() == true;
                // Switches run one after another in the order the page sent them: on separate tasks a quick
                // off-then-on could be applied as on-then-off and leave the plugin off.
                lock (_pluginQueueLock) _pluginQueue = _pluginQueue.ContinueWith(_ => SetPlugin(id, on), TaskScheduler.Default).Unwrap();
                return true;

            case "hubPluginsDetect":
                _ = Task.Run(SendPluginDetection);
                return true;

            case "hubPluginsSetup":
                var picks = new Dictionary<string, bool>(StringComparer.Ordinal);
                if (msg["picks"] is JObject chosen)
                    foreach (var pick in chosen.Properties())
                        if (pick.Value.Type == JTokenType.Boolean) picks[pick.Name] = pick.Value.Value<bool>();
                var performance = msg["performance"]?.Value<bool>() == true;
                _ = Task.Run(() => ApplyPluginSetup(picks, performance));
                return true;
        }
        return false;
    }

    // switched: this list answers one hubPluginSet, so the page can tell which of its own switches are still on their way.
    private void SendPlugins(bool switched = false)
    {
        var plugins = HubModules.Plugins;
        SendToJS("hubPlugins", new { states = plugins.States(), picked = plugins.Picked, switched });
    }

    private readonly object _pluginQueueLock = new();
    private Task _pluginQueue = Task.CompletedTask;
    private readonly SemaphoreSlim _pluginSwitch = new(1, 1);

    private async Task SetPlugin(string id, bool on)
    {
        // The queue above already runs one switch at a time; this also keeps each switch whole.
        await _pluginSwitch.WaitAsync();
        try
        {
            var plugin = HubPluginsModule.Find(id);
            if (plugin == null || !HubModules.Plugins.Set(id, on)) { SendPlugins(true); return; }
            if (_hub != null)
                foreach (var module in plugin.Modules) await _hub.Modules.SetEnabledAsync(module, on);
#if WINDOWS
            // An app held in a page that's going away goes back to being its own window.
            if (!on && AppEmbedsModule.App(id) is { } app)
            {
                AppEmbedHost? embeds;
                lock (_embedsLock) embeds = _embeds;
                embeds?.Release(app);
            }
#endif
        }
        catch (Exception ex)
        {
            CrashHandler.WriteEntry("hubPluginSet", ex);
        }
        finally
        {
            _pluginSwitch.Release();
        }
        SendPlugins(true);
        SendHubModules();
    }

    private async Task ApplyPluginSetup(Dictionary<string, bool> picks, bool performance)
    {
        try
        {
            HubModules.Plugins.SetAll(picks);
            _hub?.Modules.SetSetting(HubPerformanceModule.ModuleId, HubPerformanceModule.ModeKey, performance ? "true" : "false");
            if (_hub != null)
                foreach (var plugin in HubPluginsModule.Catalog)
                    foreach (var module in plugin.Modules)
                        await _hub.Modules.SetEnabledAsync(module, HubModules.Plugins.IsOn(plugin.Id));
        }
        catch (Exception ex)
        {
            CrashHandler.WriteEntry("hubPluginsSetup", ex);
        }
        SendToJS("hubPluginsSaved", new { ok = true });
    }

    /// <summary>What's installed on this PC, so setup can tick it for you.</summary>
    private void SendPluginDetection()
    {
        bool Safe(Func<bool> check)
        {
            try { return check(); }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or InvalidOperationException) { return false; }
        }
        var embeds = HubModules.AppEmbeds;
        List<string> steam;
        try { steam = SteamHost.SteamLibraries().ToList(); }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { steam = new List<string>(); }
        var detected = new Dictionary<string, bool>
        {
            ["vr"] = Safe(() => steam.Any(l => Directory.Exists(Path.Combine(l, "steamapps", "common", "SteamVR")))),
            ["fbt"] = Safe(() => LaunchAddons.Detect(LaunchAddons.Fbt).Count > 0),
            ["face"] = Safe(() => LaunchAddons.Detect(LaunchAddons.FaceTracking).Count > 0),
            ["haptics"] = Safe(() => LaunchAddons.Detect(LaunchAddons.Haptics).Count > 0),
            ["oyasumi"] = Safe(() => embeds.FindExe(AppEmbedsModule.Oyasumi) != null),
            ["eagle"] = Safe(() => embeds.FindExe(AppEmbedsModule.Eagle) != null),
            ["vrct"] = Safe(() => embeds.FindExe(AppEmbedsModule.Vrct) != null),
            ["ovrtoolkit"] = Safe(() => embeds.FindExe(AppEmbedsModule.OvrToolkit) != null),
            ["standable"] = Safe(() => LaunchAddons.KnownVrApps().Any(a => a.Id == "standable" && a.Path != null)),
            ["vrcx"] = Safe(() => File.Exists(VrcxHistoryModule.DefaultSource)),
            ["ovrAdvanced"] = Safe(() => File.Exists(OvrasSettings.DefaultPath())),
        };
        SendToJS("hubPluginsDetected", new
        {
            detected,
            weak = HubPerformanceModule.WeakMachine,
            threads = HubPerformanceModule.Threads,
            memoryGb = HubPerformanceModule.MemoryGb,
        });
    }
}
