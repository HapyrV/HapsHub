using HapsHub.Core;
using Newtonsoft.Json.Linq;
using VRCNext.Services;
using VRCNext.Services.Helpers;

namespace VRCNext;

// The YouTube tunnel: paste a link and it plays into the VRChat mic, past the voice changer.
public partial class AppShell
{
    private readonly object _tunnelLock = new();
    private CancellationTokenSource? _tunnelRun;
    private TunnelPlayer? _tunnelPlayer;
    private int _tunnelGeneration;
    private string _tunnelState = "idle";
    private string _tunnelTitle = "";
    private string _tunnelMessage = "";
    private double _tunnelSeconds;

    private bool HandleTunnelMessage(string action, JObject msg)
    {
        switch (action)
        {
            case "hubTunnelState":
                _ = Task.Run(SendTunnelState);
                return true;

            case "hubTunnelPlay":
                var link = msg["link"]?.ToString() ?? "";
                _ = Task.Run(() => RunTunnel(link));
                return true;

            case "hubTunnelStop":
                _ = Task.Run(() => StopTunnel(""));
                return true;

            case "hubTunnelDevices":
                SaveTunnelSetting(YoutubeTunnelModule.SendDeviceKey, msg["send"]?.ToString() ?? "");
                SaveTunnelSetting(YoutubeTunnelModule.HearDeviceKey, msg["hear"]?.ToString() ?? "");
                return true;

            case "hubTunnelVolume":
                var send = Math.Clamp(msg["send"]?.Value<int>() ?? 100, 0, 100);
                var hear = Math.Clamp(msg["hear"]?.Value<int>() ?? 50, 0, 100);
                lock (_tunnelLock) _tunnelPlayer?.SetVolumes(send / 100f, hear / 100f);
                if (msg["save"]?.Value<bool>() == true)
                {
                    SaveTunnelSetting(YoutubeTunnelModule.SendVolumeKey, send.ToString());
                    SaveTunnelSetting(YoutubeTunnelModule.HearVolumeKey, hear.ToString());
                }
                return true;
        }
        return false;
    }

    private void SaveTunnelSetting(string key, string value)
    {
        try { _hub?.Modules.SetSetting(YoutubeTunnelModule.ModuleId, key, value); }
        catch (ArgumentException ex) { CrashHandler.WriteEntry("hubTunnelSetting", ex); }
    }

    private void SendTunnelState()
    {
        var module = HubModules.YoutubeTunnel;
        string state, title, message;
        double seconds;
        lock (_tunnelLock)
        {
            state = _tunnelState;
            title = _tunnelTitle;
            message = _tunnelMessage;
            seconds = _tunnelSeconds;
        }
        (string Id, string Name)[] outputs;
        try { outputs = AudioDeviceManager.ListOutputs(); }
        catch (Exception ex)
        {
            CrashHandler.WriteEntry("hubTunnelDevices", ex);
            outputs = Array.Empty<(string, string)>();
        }
        SendToJS("hubTunnelState", new
        {
            state,
            title,
            message,
            seconds,
            found = module.FindYtDlp() != null,
            devices = outputs.Select(o => new { id = o.Id, name = o.Name }).ToArray(),
            send = module.Setting(YoutubeTunnelModule.SendDeviceKey),
            hear = module.Setting(YoutubeTunnelModule.HearDeviceKey),
            sendVolume = VolumeSetting(YoutubeTunnelModule.SendVolumeKey, 100),
            hearVolume = VolumeSetting(YoutubeTunnelModule.HearVolumeKey, 50),
        });
    }

    private static int VolumeSetting(string key, int fallback) =>
        int.TryParse(HubModules.YoutubeTunnel.Setting(key), out var value) ? Math.Clamp(value, 0, 100) : fallback;

    private async Task RunTunnel(string text)
    {
        var module = HubModules.YoutubeTunnel;
        var link = TunnelLink.Clean(text);
        if (link == null)
        {
            StopTunnel("That isn't a YouTube link.");
            return;
        }
        var sendDevice = module.Setting(YoutubeTunnelModule.SendDeviceKey);
        if (sendDevice.Length == 0)
        {
            StopTunnel("Choose a Send to device first.");
            return;
        }

        int generation;
        CancellationTokenSource run;
        lock (_tunnelLock)
        {
            EndTunnelLocked("");
            generation = ++_tunnelGeneration;
            run = _tunnelRun = new CancellationTokenSource();
            _tunnelState = "fetching";
        }
        SendTunnelState();

        try
        {
            var track = await module.FetchAsync(link, run.Token);
            lock (_tunnelLock)
            {
                if (generation != _tunnelGeneration) return;
                var player = new TunnelPlayer();
                var length = player.Start(track.Path, sendDevice, module.Setting(YoutubeTunnelModule.HearDeviceKey),
                    VolumeSetting(YoutubeTunnelModule.SendVolumeKey, 100) / 100f,
                    VolumeSetting(YoutubeTunnelModule.HearVolumeKey, 50) / 100f,
                    () => _ = Task.Run(() => OnTunnelEnded(generation)));
                _tunnelPlayer = player;
                _tunnelState = "playing";
                _tunnelTitle = track.Title;
                _tunnelSeconds = length.TotalSeconds;
            }
            SendTunnelState();
        }
        catch (OperationCanceledException)
        {
            // Stop was pressed or a new song started. Whoever did that reports the state.
        }
        catch (TunnelException ex)
        {
            FinishTunnel(generation, ex.Message);
        }
        catch (Exception ex)
        {
            CrashHandler.WriteEntry("hubTunnelPlay", ex);
            FinishTunnel(generation, "Something went wrong playing this song.");
        }
    }

    private void OnTunnelEnded(int generation) => FinishTunnel(generation, "");

    private void FinishTunnel(int generation, string message)
    {
        lock (_tunnelLock)
        {
            if (generation != _tunnelGeneration) return;
            EndTunnelLocked(message);
        }
        HubModules.YoutubeTunnel.ClearCache();
        SendTunnelState();
    }

    private void StopTunnel(string message)
    {
        lock (_tunnelLock) EndTunnelLocked(message);
        HubModules.YoutubeTunnel.ClearCache();
        SendTunnelState();
    }

    private void EndTunnelLocked(string message)
    {
        _tunnelGeneration++;
        try { _tunnelRun?.Cancel(); }
        catch (ObjectDisposedException) { }
        _tunnelRun = null;
        _tunnelPlayer?.Dispose();
        _tunnelPlayer = null;
        _tunnelState = "idle";
        _tunnelTitle = "";
        _tunnelSeconds = 0;
        _tunnelMessage = message;
    }

    /// <summary>Called when the app closes, so nothing keeps playing into the mic.</summary>
    private void ShutDownTunnel()
    {
        lock (_tunnelLock) EndTunnelLocked("");
    }
}
