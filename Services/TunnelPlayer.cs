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
    public TimeSpan Start(string path, string sendDeviceId, string hearDeviceId, float sendVolume, float hearVolume, Action ended) =>
        throw new TunnelException("The YouTube tunnel only works on Windows for now.");

    public void SetVolumes(float send, float hear) { }

    public void Dispose() { }
#endif
}
