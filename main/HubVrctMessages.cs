using System.Text.RegularExpressions;
using HapsHub.Core;
using Newtonsoft.Json.Linq;
using VRCNext.Services;

namespace VRCNext;

// The VRCT page: HapsHub runs VRCT's engine and is its window.
public partial class AppShell
{
    private VrctEngine? _vrct;
    private readonly object _vrctLock = new();
    // Requests to VRCT go out one after another, in the order the page sent them
    // (a translator change must reach VRCT before the request for that translator's languages).
    private Task _vrctSendQueue = Task.CompletedTask;

    /// <summary>What the page may ask the engine. Keys, updates, file browsing and shutdown aren't passed on.</summary>
    private static readonly Regex VrctAllowed = new(@"^/(get|set|run)/[a-z0-9_/]+$", RegexOptions.Compiled);
    private static readonly Regex VrctBlocked = new(@"auth_key|update_|open_filepath|shutdown|telemetry|release_channel", RegexOptions.Compiled);

    private VrctEngine Vrct()
    {
        lock (_vrctLock)
        {
            return _vrct ??= new VrctEngine
            {
                Message = (endpoint, status, result) => SendToJS("hubVrct", new { endpoint, status, result }),
                StateChanged = SendVrctState,
            };
        }
    }

    /// <summary>The engine beside VRCT.exe. Tests point at a stand-in with HAPSHUB_VRCT_SIDECAR.</summary>
    private static string? VrctSidecar()
    {
        var forced = Environment.GetEnvironmentVariable("HAPSHUB_VRCT_SIDECAR");
        if (!string.IsNullOrWhiteSpace(forced)) return File.Exists(forced) ? forced : null;
        return VrctEngine.SidecarNextTo(HubModules.AppEmbeds.FindExe(AppEmbedsModule.Vrct));
    }

    private bool HandleVrctMessage(string action, JObject msg)
    {
        switch (action)
        {
            case "hubVrctState":
                _ = Task.Run(SendVrctState);
                return true;

            case "hubVrctStart":
                var sidecar = VrctSidecar();
                if (sidecar == null) { _ = Task.Run(SendVrctState); return true; }
                _ = Task.Run(() => Vrct().Start(sidecar));
                return true;

            case "hubVrctStop":
                _ = Task.Run(() => { _vrct?.Stop(); SendVrctState(); });
                return true;

            case "hubVrctSend":
                var endpoint = msg["endpoint"]?.ToString() ?? "";
                if (!VrctAllowed.IsMatch(endpoint) || VrctBlocked.IsMatch(endpoint)) return true;
                var data = msg["data"];
                lock (_vrctLock) _vrctSendQueue = _vrctSendQueue.ContinueWith(_ => _vrct?.Send(endpoint, data), TaskScheduler.Default);
                return true;
        }
        return false;
    }

    private void SendVrctState()
    {
        var engine = _vrct;
        var sidecar = VrctSidecar();
        SendToJS("hubVrctState", new
        {
            state = engine?.State ?? "off",
            progress = engine?.Progress ?? 0,
            problem = engine?.Problem ?? "",
            found = sidecar != null,
            snapshot = engine?.State == "ready" ? engine.Snapshot : null,
            // VRCT's own window starts its own engine; both at once would fight over the microphone.
            windowOpen = VrctEngine.WindowRunning(),
        });
    }

    private void ShutDownVrct()
    {
        VrctEngine? engine;
        lock (_vrctLock) { engine = _vrct; _vrct = null; }
        engine?.Dispose();
    }
}
