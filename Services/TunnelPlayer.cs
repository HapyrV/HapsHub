using HapsHub.Core;
using VRCNext.Services.Helpers;
#if WINDOWS
using NAudio.Wave;
using NAudio.Wave.SampleProviders;
#endif

namespace VRCNext.Services;

/// <summary>Plays one file to the mic device and, if chosen, to a device you can hear it on.</summary>
internal sealed class TunnelPlayer : IDisposable
{
#if WINDOWS
    private sealed class Output : IDisposable
    {
        private readonly MediaFoundationReader _reader;
        private readonly VolumeSampleProvider _volume;
        private readonly WaveOutEvent _device;

        public Output(string path, int deviceIndex, float volume)
        {
            _reader = new MediaFoundationReader(path);
            try
            {
                _volume = new VolumeSampleProvider(_reader.ToSampleProvider()) { Volume = volume };
                _device = new WaveOutEvent { DeviceNumber = deviceIndex };
                _device.Init(_volume);
            }
            catch
            {
                _reader.Dispose();
                throw;
            }
        }

        public TimeSpan Length => _reader.TotalTime;
        public float Volume { set => _volume.Volume = value; }
        public event EventHandler<StoppedEventArgs> Stopped { add => _device.PlaybackStopped += value; remove => _device.PlaybackStopped -= value; }
        public void Play() => _device.Play();

        public void Dispose()
        {
            _device.Dispose();
            _reader.Dispose();
        }
    }

    private Output? _send;
    private Output? _hear;
    private Action? _ended;

    /// <summary>Returns the song's length. <paramref name="ended"/> runs once, when the mic side finishes by itself.</summary>
    public TimeSpan Start(string path, string sendDeviceId, string hearDeviceId, float sendVolume, float hearVolume, Action ended)
    {
        var sendIndex = AudioDeviceManager.ResolveOutputIndex(AudioSelection.From(sendDeviceId, null));
        if (sendIndex == null) throw new TunnelException("The Send to device isn't available right now.");
        try
        {
            _send = new Output(path, sendIndex.Value, sendVolume);
            if (hearDeviceId.Length > 0)
            {
                var hearIndex = AudioDeviceManager.ResolveOutputIndex(AudioSelection.From(hearDeviceId, null));
                if (hearIndex == null) throw new TunnelException("The Hear it on device isn't available right now.");
                _hear = new Output(path, hearIndex.Value, hearVolume);
            }
        }
        catch (Exception ex) when (ex is not TunnelException)
        {
            Dispose();
            throw new TunnelException($"Could not play this song: {ex.Message}");
        }
        catch
        {
            Dispose();
            throw;
        }

        _ended = ended;
        _send.Stopped += OnSendStopped;
        _send.Play();
        _hear?.Play();
        return _send.Length;
    }

    public void SetVolumes(float send, float hear)
    {
        if (_send != null) _send.Volume = send;
        if (_hear != null) _hear.Volume = hear;
    }

    private void OnSendStopped(object? sender, StoppedEventArgs e) => Interlocked.Exchange(ref _ended, null)?.Invoke();

    public void Dispose()
    {
        _ended = null;
        if (_send != null) _send.Stopped -= OnSendStopped;
        _send?.Dispose();
        _hear?.Dispose();
        _send = null;
        _hear = null;
    }
#else
    // Linux: ffmpeg plays the song into PulseAudio or PipeWire. The mic side goes to HapsHub's virtual speaker,
    // whose "HapsHub Tunnel Mic" is what VRChat listens to, or to the speaker chosen under Send to.
    private System.Diagnostics.Process? _send;
    private System.Diagnostics.Process? _hear;
    private volatile bool _stopping;

    public TimeSpan Start(string path, string sendDeviceId, string hearDeviceId, float sendVolume, float hearVolume, Action ended)
    {
        var ffmpeg = WinePrefix.OnPath("ffmpeg")
            ?? throw new TunnelException("On Linux the YouTube tunnel needs ffmpeg. Install it with your package manager.");
        var send = string.IsNullOrEmpty(sendDeviceId) ? LinuxPulse.TunnelSink : sendDeviceId;
        if (send == LinuxPulse.TunnelSink) LinuxPulse.EnsureTunnel();
        var length = Length(path);

        _send = Play(ffmpeg, path, send);
        _send.EnableRaisingEvents = true;
        _send.Exited += (_, _) => { if (!_stopping) ended(); };
        ApplyVolumeSoon(_send, sendVolume);
        if (!string.IsNullOrEmpty(hearDeviceId) && hearDeviceId != send)
        {
            _hear = Play(ffmpeg, path, hearDeviceId);
            ApplyVolumeSoon(_hear, hearVolume);
        }
        return length;
    }

    private static System.Diagnostics.Process Play(string ffmpeg, string path, string sink)
    {
        var info = new System.Diagnostics.ProcessStartInfo(ffmpeg) { UseShellExecute = false, CreateNoWindow = true };
        foreach (var arg in new[] { "-nostdin", "-hide_banner", "-loglevel", "error", "-i", path, "-vn", "-f", "pulse" })
            info.ArgumentList.Add(arg);
        if (sink != LinuxPulse.DefaultSink)
        {
            info.ArgumentList.Add("-device");
            info.ArgumentList.Add(sink);
        }
        info.ArgumentList.Add("HapsHub Tunnel");
        return System.Diagnostics.Process.Start(info) ?? throw new TunnelException("ffmpeg didn't start.");
    }

    /// <summary>The stream shows up in pactl a moment after ffmpeg starts, so the volume is set once it's there.</summary>
    private static void ApplyVolumeSoon(System.Diagnostics.Process process, float volume) => _ = Task.Run(async () =>
    {
        for (var attempt = 0; attempt < 15; attempt++)
        {
            await Task.Delay(200);
            try { if (process.HasExited) return; } catch (InvalidOperationException) { return; }
            if (LinuxPulse.SetStreamVolume(process.Id, volume)) return;
        }
    });

    /// <summary>The song's length from ffprobe, or zero when it isn't installed.</summary>
    private static TimeSpan Length(string path)
    {
        var ffprobe = WinePrefix.OnPath("ffprobe");
        if (ffprobe == null) return TimeSpan.Zero;
        var info = new System.Diagnostics.ProcessStartInfo(ffprobe) { UseShellExecute = false, RedirectStandardOutput = true, CreateNoWindow = true };
        foreach (var arg in new[] { "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path })
            info.ArgumentList.Add(arg);
        try
        {
            using var probe = System.Diagnostics.Process.Start(info);
            if (probe == null) return TimeSpan.Zero;
            var text = probe.StandardOutput.ReadToEnd();
            probe.WaitForExit(5000);
            return double.TryParse(text.Trim(), System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var seconds)
                ? TimeSpan.FromSeconds(seconds) : TimeSpan.Zero;
        }
        catch (System.ComponentModel.Win32Exception) { return TimeSpan.Zero; }
    }

    public void SetVolumes(float send, float hear)
    {
        foreach (var (process, volume) in new[] { (_send, send), (_hear, hear) })
        {
            try { if (process is { HasExited: false }) LinuxPulse.SetStreamVolume(process.Id, volume); }
            catch (InvalidOperationException) { }
        }
    }

    public void Dispose()
    {
        _stopping = true;
        foreach (var process in new[] { _send, _hear })
        {
            if (process == null) continue;
            try { if (!process.HasExited) process.Kill(); } catch (InvalidOperationException) { } catch (System.ComponentModel.Win32Exception) { }
            process.Dispose();
        }
        _send = null;
        _hear = null;
    }
#endif
}
