using HapsHub.Core;
using Newtonsoft.Json.Linq;
using VRCNext.Services;

namespace VRCNext;

// OyasumiVR and Eagle in a HapsHub page. Their windows are real windows, so the page only says where the pane is.
public partial class AppShell
{
#if WINDOWS
    private AppEmbedHost? _embeds;
    private readonly object _embedsLock = new();

    private AppEmbedHost Embeds()
    {
        lock (_embedsLock)
        {
            if (_embeds != null) return _embeds;
            _embeds = new AppEmbedHost(() => _window.WindowHandle)
            {
                Changed = (app, _) => SendEmbedState(app),
            };
            AppDomain.CurrentDomain.UnhandledException += (_, _) => _embeds?.ReleaseAll();
            return _embeds;
        }
    }

    private bool HandleEmbedMessage(string action, JObject msg)
    {
        if (!action.StartsWith("hubEmbed", StringComparison.Ordinal)) return false;
        var app = AppEmbedsModule.App(msg["app"]?.ToString());
        if (app == null) return true;
        var module = HubModules.AppEmbeds;
        switch (action)
        {
            case "hubEmbedState":
                _ = Task.Run(() => SendEmbedState(app));
                return true;

            case "hubEmbedPane":
                var rect = new EmbedRect(msg["x"]?.Value<int>() ?? 0, msg["y"]?.Value<int>() ?? 0, msg["w"]?.Value<int>() ?? 0, msg["h"]?.Value<int>() ?? 0);
                var visible = msg["visible"]?.Value<bool>() == true;
                // Nothing is held until someone opens an app, so a passing visit to the page costs nothing.
                lock (_embedsLock)
                {
                    if (_embeds == null && !visible) return true;
                }
                Embeds().SetPane(app, rect, visible);
                return true;

            case "hubEmbedStart":
                var exe = module.FindExe(app);
                if (exe == null) { _ = Task.Run(() => SendEmbedState(app)); return true; }
                Embeds().Start(app, exe, module.Mode(app));
                return true;

            case "hubEmbedRelease":
                Embeds().Release(app);
                return true;

            case "hubEmbedFreeze":
                _ = Task.Run(async () =>
                {
                    var image = await Embeds().FreezeAsync(app);
                    SendToJS("hubEmbedFrozen", new { app = app.Id, image = image ?? "" });
                });
                return true;

            case "hubEmbedUnfreeze":
                Embeds().Unfreeze(app);
                return true;

            case "hubEmbedMode":
                SaveEmbedSetting(app.ModeKey, msg["mode"]?.ToString() == AppEmbedsModule.ModeTracked ? AppEmbedsModule.ModeTracked : AppEmbedsModule.ModeChild);
                Embeds().Release(app);
                return true;

            case "hubEmbedTest":
                _ = Task.Run(() => RunEmbedTest(app));
                return true;
        }
        return true;
    }

    private void SaveEmbedSetting(string key, string value)
    {
        try { _hub?.Modules.SetSetting(AppEmbedsModule.ModuleId, key, value); }
        catch (ArgumentException ex) { CrashHandler.WriteEntry("hubEmbedSetting", ex); }
    }

    private void SendEmbedState(EmbedApp app, IReadOnlyList<EmbedCheck>? checks = null, bool testing = false)
    {
        var module = HubModules.AppEmbeds;
        var status = _embeds?.Status(app);
        SendToJS("hubEmbedState", new
        {
            app = app.Id,
            name = app.Name,
            state = status?.State ?? "idle",
            mode = module.Mode(app),
            message = status?.Message ?? "",
            found = module.FindExe(app) != null,
            enabled = module.Running,
            result = module.Setting(app.ResultKey),
            testing,
            checks = checks?.Select(c => new { name = c.Name, passed = c.Passed, detail = c.Detail }).ToArray(),
        });
    }

    /// <summary>Tries the app held in the pane. If that fails, tries the separate window and keeps whichever passed.</summary>
    private async Task RunEmbedTest(EmbedApp app)
    {
        var module = HubModules.AppEmbeds;
        var exe = module.FindExe(app);
        if (exe == null) { SendEmbedState(app); return; }
        try
        {
            SendEmbedState(app, null, true);
            var when = DateTime.Now.ToString("yyyy-MM-dd HH:mm");
            var held = await Embeds().TestAsync(app, exe, AppEmbedsModule.ModeChild);
            var result = EmbedWindows.Summary(AppEmbedsModule.ModeChild, held, when);
            var shown = held;
            var mode = AppEmbedsModule.ModeChild;
            if (held.Any(c => !c.Passed))
            {
                var alone = await Embeds().TestAsync(app, exe, AppEmbedsModule.ModeTracked);
                result += " " + EmbedWindows.Summary(AppEmbedsModule.ModeTracked, alone, when);
                shown = held.Concat(alone).ToList();
                if (alone.All(c => c.Passed)) mode = AppEmbedsModule.ModeTracked;
            }
            SaveEmbedSetting(app.ModeKey, mode);
            SaveEmbedSetting(app.ResultKey, result);
            SendEmbedState(app, shown);
        }
        catch (Exception ex)
        {
            CrashHandler.WriteEntry("hubEmbedTest", ex);
            SaveEmbedSetting(app.ResultKey, $"The test couldn't finish: {ex.Message}");
            SendEmbedState(app);
        }
    }

    private void ShutDownEmbeds()
    {
        lock (_embedsLock)
        {
            _embeds?.Dispose();
            _embeds = null;
        }
    }
#else
    private bool HandleEmbedMessage(string action, JObject msg) => false;

    private void ShutDownEmbeds() { }
#endif
}
