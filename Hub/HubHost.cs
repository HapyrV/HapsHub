namespace HapsHub.Core;

/// <summary>
/// The only object the app shell talks to. Startup work runs in the background and
/// nothing here may throw into the app: a broken hub leaves the upstream features running.
/// </summary>
public sealed class HubHost
{
    private const long MaxLogBytes = 1024 * 1024;
    private static readonly TimeSpan OrphanAge = TimeSpan.FromDays(1);

    private readonly object _logLock = new();
    private readonly string _logPath;
    private readonly Action<string>? _logSink;

    private HubHost(Action<string>? logSink)
    {
        _logSink = logSink;
        _logPath = Path.Combine(HubPaths.HubRoot, "hub.log");
        Database = new HubDatabase(Path.Combine(HubPaths.HubRoot, "hub.db"), Log);
        Modules = new ModuleRegistry(Database, Log);
    }

    public HubDatabase Database { get; }
    public ModuleRegistry Modules { get; }

    public static HubHost Start(IEnumerable<IHubModule> modules, Action<string>? logSink = null)
    {
        var host = new HubHost(logSink);
        _ = Task.Run(() => host.RunStartup(modules));
        return host;
    }

    /// <summary>Blocks for at most the budget, so it is safe to call during app shutdown.</summary>
    public void Stop(TimeSpan budget)
    {
        try
        {
            var finished = Task.Run(() => Modules.StopAllAsync(budget)).Wait(budget);
            Log(finished ? "Hub stopped." : "Hub stop ran out of time.");
        }
        catch (Exception ex)
        {
            Log($"Hub shutdown: {ex.GetBaseException().Message}");
        }
    }

    private async Task RunStartup(IEnumerable<IHubModule> modules)
    {
        try
        {
            CleanOrphans();
            Database.Open();
            foreach (var module in modules)
            {
                try
                {
                    Modules.Register(module);
                }
                catch (Exception ex)
                {
                    Log($"Could not register a module: {ex.Message}");
                }
            }
            await Modules.StartAllAsync();
            Log($"Hub started. Database {(Database.IsAvailable ? "ready" : "unavailable")}, {Modules.GetModules().Count} module(s).");
        }
        catch (Exception ex)
        {
            Log($"Hub startup failed: {ex}");
        }
    }

    private void CleanOrphans()
    {
        // Top-level folders only: the image cache holds far too many files to scan at startup.
        foreach (var directory in new[]
                 {
                     HubPaths.DataRoot, HubPaths.HubRoot, HubPaths.Data("Caches"), HubPaths.Data("chat"),
                     AppContext.BaseDirectory,
                 })
        {
            var removed = AtomicFile.CleanOrphans(directory, OrphanAge);
            if (removed > 0) Log($"Removed {removed} leftover temp file(s) from {directory}.");
        }
    }

    private void Log(string message)
    {
        try { _logSink?.Invoke(message); }
        catch (Exception) { /* A failing sink must not break the module that was logging. */ }

        lock (_logLock)
        {
            try
            {
                Directory.CreateDirectory(HubPaths.HubRoot);
                if (File.Exists(_logPath) && new FileInfo(_logPath).Length > MaxLogBytes)
                    File.Move(_logPath, _logPath + ".old", overwrite: true);
                File.AppendAllText(_logPath, $"{DateTime.Now:yyyy-MM-dd HH:mm:ss}  {message}{Environment.NewLine}");
            }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
        }
    }
}
