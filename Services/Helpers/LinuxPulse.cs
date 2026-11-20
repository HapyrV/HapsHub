#if !WINDOWS
using System.Diagnostics;
using HapsHub.Core;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace VRCNext.Services.Helpers;

/// <summary>
/// PulseAudio and PipeWire through pactl, for the YouTube tunnel on Linux. HapsHub adds a virtual speaker,
/// "HapsHub Tunnel", and a microphone fed from it, "HapsHub Tunnel Mic", which you pick as VRChat's microphone.
/// Both go away when you log out.
/// </summary>
internal static class LinuxPulse
{
    public const string TunnelSink = "hapshub_tunnel";
    public const string TunnelMic = "hapshub_tunnel_mic";
    public const string DefaultSink = "@DEFAULT_SINK@";

    /// <summary>Runs pactl and returns what it printed, or null if it isn't installed or failed.</summary>
    public static string? Pactl(params string[] args)
    {
        var pactl = WinePrefix.OnPath("pactl");
        if (pactl == null) return null;
        var info = new ProcessStartInfo(pactl) { UseShellExecute = false, RedirectStandardOutput = true, RedirectStandardError = true, CreateNoWindow = true };
        foreach (var arg in args) info.ArgumentList.Add(arg);
        try
        {
            using var process = Process.Start(info);
            if (process == null) return null;
            var output = process.StandardOutput.ReadToEndAsync();
            _ = process.StandardError.ReadToEndAsync();
            if (!process.WaitForExit(5000)) { try { process.Kill(); } catch (InvalidOperationException) { } return null; }
            return process.ExitCode == 0 ? output.Result : null;
        }
        catch (System.ComponentModel.Win32Exception) { return null; }
    }

    /// <summary>Where the tunnel can play: HapsHub's virtual microphone first, then the default and every real speaker.</summary>
    public static (string Id, string Name)[] ListSinks()
    {
        var list = new List<(string, string)>
        {
            (TunnelSink, "HapsHub Tunnel Mic (choose it as your microphone in VRChat)"),
            (DefaultSink, "Default speakers"),
        };
        var json = Pactl("-f", "json", "list", "sinks");
        if (json != null)
        {
            try
            {
                foreach (var sink in JArray.Parse(json))
                {
                    var name = sink["name"]?.ToString();
                    if (string.IsNullOrEmpty(name) || name == TunnelSink) continue;
                    list.Add((name, sink["description"]?.ToString() is { Length: > 0 } description ? description : name));
                }
                return list.ToArray();
            }
            catch (JsonException) { }
        }
        // Older pactl has no JSON: the short list gives names only.
        foreach (var line in (Pactl("list", "short", "sinks") ?? "").Split('\n', StringSplitOptions.RemoveEmptyEntries))
        {
            var parts = line.Split('\t');
            if (parts.Length > 1 && parts[1] != TunnelSink) list.Add((parts[1], parts[1]));
        }
        return list.ToArray();
    }

    /// <summary>Adds the virtual speaker and microphone if they aren't there yet.</summary>
    public static void EnsureTunnel()
    {
        var sinks = Pactl("list", "short", "sinks")
            ?? throw new TunnelException("On Linux the YouTube tunnel needs PulseAudio or PipeWire with pactl (pulseaudio-utils).");
        if (!sinks.Contains(TunnelSink + "\t"))
            Pactl("load-module", "module-null-sink", $"sink_name={TunnelSink}", "sink_properties=device.description='HapsHub Tunnel'");
        var sources = Pactl("list", "short", "sources") ?? "";
        if (!sources.Contains(TunnelMic + "\t"))
            Pactl("load-module", "module-remap-source", $"master={TunnelSink}.monitor", $"source_name={TunnelMic}",
                "source_properties=device.description='HapsHub Tunnel Mic'");
    }

    /// <summary>Sets the volume of the sound a process is playing. False if its stream isn't there (yet).</summary>
    public static bool SetStreamVolume(int processId, float volume)
    {
        var json = Pactl("-f", "json", "list", "sink-inputs");
        if (json == null) return false;
        try
        {
            foreach (var input in JArray.Parse(json))
            {
                if (input["properties"]?["application.process.id"]?.ToString() != processId.ToString()) continue;
                var percent = (int)Math.Round(Math.Clamp(volume, 0f, 1f) * 100);
                return Pactl("set-sink-input-volume", input["index"]?.ToString() ?? "", $"{percent}%") != null;
            }
        }
        catch (JsonException) { }
        return false;
    }
}
#endif
