using System.Diagnostics;
using System.Text;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace VRCNext.Services;

/// <summary>
/// Runs VRCT's engine (VRCT-sidecar.exe) without VRCT's own window, so HapsHub can be its window instead.
/// The engine reads one JSON request per line on stdin ({"endpoint": "...", "data": base64 of JSON}) and writes one
/// JSON line per answer or event on stdout ({"status", "endpoint", "result"}; status 348 is a log line).
/// It shuts itself down when it isn't fed a watchdog message for a while, so it can't outlive HapsHub.
/// It uses VRCT's own settings file, so a change here shows in VRCT too.
/// </summary>
public sealed class VrctEngine : IDisposable
{
    public const string ProcessName = "VRCT-sidecar";
    public const string WindowProcessName = "VRCT";
    private const int WatchdogMs = 5000;
    private static readonly TimeSpan StopWait = TimeSpan.FromSeconds(8);

    private readonly object _lock = new();
    private Process? _process;
    private StreamWriter? _input;
    private System.Threading.Timer? _watchdog;
    private bool _stopping;
    private bool _starting;

    /// <summary>off, starting, ready or failed.</summary>
    public string State { get; private set; } = "off";
    public int Progress { get; private set; }
    public string Problem { get; private set; } = "";
    /// <summary>Every setting the engine reported when it finished starting, by its /get/data/ endpoint.</summary>
    public JObject? Snapshot { get; private set; }

    /// <summary>Every answer and event from the engine: endpoint, status, result. Runs on the reading thread.</summary>
    public Action<string, int, JToken?>? Message { get; set; }
    public Action? StateChanged { get; set; }

    public static string? SidecarNextTo(string? vrctExe)
    {
        var dir = vrctExe == null ? null : Path.GetDirectoryName(vrctExe);
        var sidecar = dir == null ? null : Path.Combine(dir, ProcessName + ".exe");
        return sidecar != null && File.Exists(sidecar) ? sidecar : null;
    }

    /// <summary>True when this engine is running outside HapsHub, such as with VRCT's own window.
    /// Looks for the file about to start, so a test's stand-in engine doesn't mistake the real VRCT for itself.</summary>
    public bool OtherCopyRunning(string? sidecar = null)
    {
        int? own;
        lock (_lock) own = _process is { HasExited: false } ? _process.Id : null;
        var name = string.IsNullOrEmpty(sidecar) ? ProcessName : Path.GetFileNameWithoutExtension(sidecar);
        var others = Process.GetProcessesByName(name);
        try { return others.Any(p => p.Id != own); }
        finally { foreach (var p in others) p.Dispose(); }
    }

    public static bool WindowRunning()
    {
        var found = Process.GetProcessesByName(WindowProcessName);
        try { return found.Length > 0; }
        finally { foreach (var p in found) p.Dispose(); }
    }

    public bool Start(string sidecar)
    {
        // Starting at HapsHub start and a press of Start at the same moment must not make two engines.
        lock (_lock)
        {
            if (_process is { HasExited: false } || _starting) return true;
            _starting = true;
        }
        try { return StartProcess(sidecar); }
        finally { lock (_lock) _starting = false; }
    }

    private bool StartProcess(string sidecar)
    {
        if (OtherCopyRunning(sidecar))
        {
            SetState("failed", "VRCT is already running on its own. Close it first: two copies would fight over the microphone.");
            return false;
        }
        var info = new ProcessStartInfo(sidecar)
        {
            WorkingDirectory = Path.GetDirectoryName(sidecar) ?? "",
            UseShellExecute = false,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardInputEncoding = new UTF8Encoding(false),
        };
        Process process;
        try
        {
            process = Process.Start(info) ?? throw new InvalidOperationException("no process");
        }
        catch (Exception ex) when (ex is System.ComponentModel.Win32Exception or InvalidOperationException or IOException)
        {
            SetState("failed", $"VRCT's engine wouldn't start: {ex.Message}");
            return false;
        }
        process.EnableRaisingEvents = true;
        process.Exited += (_, _) => OnExited(process);
        process.ErrorDataReceived += (_, _) => { };
        process.BeginErrorReadLine();
        lock (_lock)
        {
            _process = process;
            _input = process.StandardInput;
            _input.AutoFlush = true;
            _stopping = false;
            Snapshot = null;
            Progress = 0;
            _watchdog?.Dispose();
            _watchdog = new System.Threading.Timer(_ => Send("/run/feed_watchdog"), null, 1000, WatchdogMs);
        }
        SetState("starting", "");
        new Thread(() => ReadLoop(process)) { IsBackground = true, Name = "VRCT engine output" }.Start();
        return true;
    }

    /// <summary>Sends one request. False when the engine isn't running.</summary>
    public bool Send(string endpoint, JToken? data = null)
    {
        var request = new JObject { ["endpoint"] = endpoint };
        if (data != null && data.Type != JTokenType.Null)
            request["data"] = Convert.ToBase64String(Encoding.UTF8.GetBytes(data.ToString(Formatting.None)));
        lock (_lock)
        {
            if (_input == null || _process is not { HasExited: false }) return false;
            try
            {
                _input.WriteLine(request.ToString(Formatting.None));
                return true;
            }
            catch (Exception ex) when (ex is IOException or ObjectDisposedException or InvalidOperationException)
            {
                return false;
            }
        }
    }

    /// <summary>Asks the engine to close, and ends it if it hasn't within a few seconds. Waits at most the limit.</summary>
    public void Stop(TimeSpan? limit = null)
    {
        Process? process;
        lock (_lock)
        {
            process = _process;
            _stopping = true;
            _watchdog?.Dispose();
            _watchdog = null;
        }
        if (process == null) return;
        Send("/run/shutdown");
        try
        {
            if (!process.WaitForExit(limit ?? StopWait)) process.Kill(entireProcessTree: true);
        }
        catch (Exception ex) when (ex is InvalidOperationException or System.ComponentModel.Win32Exception) { }
    }

    public void Dispose() => Stop(TimeSpan.FromSeconds(3));

    private void ReadLoop(Process process)
    {
        try
        {
            string? line;
            while ((line = process.StandardOutput.ReadLine()) != null)
            {
                if (line.Length == 0 || line[0] != '{') continue;
                JObject message;
                try { message = JObject.Parse(line); }
                catch (JsonException) { continue; }
                var status = message["status"]?.Value<int>() ?? 0;
                // Log lines: only failures matter here, and the engine already writes all of them to its own log.
                if (status == 348) continue;
                var endpoint = message["endpoint"]?.ToString() ?? "";
                var result = message["result"];
                if (endpoint == "/run/initialization_progress" && result?.Type == JTokenType.Integer)
                {
                    Progress = result.Value<int>();
                    StateChanged?.Invoke();
                }
                else if (endpoint == "/run/initialization_complete")
                {
                    Snapshot = result as JObject;
                    SetState("ready", "");
                }
                try { Message?.Invoke(endpoint, status, result); }
                catch (Exception ex) { CrashHandler.WriteEntry("VrctEngine.Message", ex); }
            }
        }
        catch (Exception ex) when (ex is IOException or ObjectDisposedException or InvalidOperationException) { }
    }

    private void OnExited(Process process)
    {
        bool expected;
        int code;
        lock (_lock)
        {
            if (!ReferenceEquals(_process, process)) return;
            expected = _stopping;
            _process = null;
            _input = null;
            _watchdog?.Dispose();
            _watchdog = null;
        }
        try { code = process.ExitCode; } catch (InvalidOperationException) { code = -1; }
        process.Dispose();
        if (expected) SetState("off", "");
        else SetState("failed", $"VRCT's engine stopped by itself (code {code}). Its log is in VRCT's folder.");
    }

    private void SetState(string state, string problem)
    {
        State = state;
        Problem = problem;
        try { StateChanged?.Invoke(); }
        catch (Exception ex) { CrashHandler.WriteEntry("VrctEngine.State", ex); }
    }
}
