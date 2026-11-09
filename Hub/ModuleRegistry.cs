using Microsoft.Data.Sqlite;

namespace HapsHub.Core;

/// <summary>
/// Starts and stops modules and keeps each one's failures to itself.
/// Modules start one at a time so that a crash can be pinned on the right one:
/// a strike is written before each start and cleared once the start returns,
/// so a strike still present on the next launch means the process died inside it.
/// </summary>
public sealed class ModuleRegistry
{
    public const int MaxStartStrikes = 2;

    private sealed class Entry
    {
        public required IHubModule Module { get; init; }
        public HubModuleStatus Status { get; set; } = HubModuleStatus.Registered;
        public string Detail { get; set; } = "";
        public HubModuleContext? Context { get; set; }
    }

    private readonly Dictionary<string, Entry> _entries = new(StringComparer.Ordinal);
    private readonly List<Entry> _order = new();
    private readonly object _lock = new();
    private readonly SemaphoreSlim _lifecycle = new(1, 1);
    private readonly CancellationTokenSource _closing = new();
    private readonly HubDatabase? _database;
    private readonly Action<string> _log;

    public ModuleRegistry(HubDatabase? database, Action<string>? log = null)
    {
        _database = database;
        _log = log ?? (_ => { });
    }

    public TimeSpan StartTimeout { get; init; } = TimeSpan.FromSeconds(15);
    public TimeSpan StopTimeout { get; init; } = TimeSpan.FromSeconds(3);

    public void Register(IHubModule module)
    {
        if (string.IsNullOrWhiteSpace(module.Id))
            throw new ArgumentException("A module needs an id.", nameof(module));

        var keys = new HashSet<string>(StringComparer.Ordinal);
        foreach (var setting in module.Settings)
            if (!keys.Add(setting.Key))
                throw new ArgumentException($"Module {module.Id} declares setting {setting.Key} twice.", nameof(module));

        lock (_lock)
        {
            if (_entries.ContainsKey(module.Id))
                throw new ArgumentException($"Module {module.Id} is already registered.", nameof(module));
            var entry = new Entry { Module = module };
            _entries.Add(module.Id, entry);
            _order.Add(entry);
        }
    }

    public async Task StartAllAsync()
    {
        foreach (var entry in Snapshot())
        {
            if (_closing.IsCancellationRequested) return;
            await RunExclusive(() => StartEntry(entry));
        }
    }

    /// <summary>Stops everything in reverse start order, within a fixed time budget for app shutdown.</summary>
    public async Task StopAllAsync(TimeSpan budget)
    {
        // Releases any start still waiting, so a hung module can't hold up closing the app.
        _closing.Cancel();
        var deadline = DateTime.UtcNow + budget;
        var locked = await _lifecycle.WaitAsync(budget);
        try
        {
            foreach (var entry in Snapshot().AsEnumerable().Reverse())
            {
                var remaining = deadline - DateTime.UtcNow;
                if (remaining <= TimeSpan.Zero)
                {
                    Log("Shutdown budget used up; remaining modules were not stopped cleanly.");
                    return;
                }
                await StopEntry(entry, remaining < StopTimeout ? remaining : StopTimeout);
            }
        }
        finally
        {
            if (locked) _lifecycle.Release();
        }
    }

    /// <summary>Turns a module on or off now and remembers it. Turning it on clears any crash strikes.</summary>
    public async Task SetEnabledAsync(string moduleId, bool enabled)
    {
        var entry = Find(moduleId);
        await RunExclusive(async () =>
        {
            SaveEnabled(moduleId, enabled);
            if (enabled)
            {
                await StartEntry(entry);
            }
            else
            {
                await StopEntry(entry, StopTimeout);
                SetStatus(entry, HubModuleStatus.Disabled, "");
            }
        });
    }

    public IReadOnlyList<HubModuleInfo> GetModules()
    {
        var result = new List<HubModuleInfo>();
        foreach (var entry in Snapshot())
        {
            var settings = entry.Module.Settings
                .Select(d => new HubSettingInfo(d, GetSetting(entry.Module.Id, d.Key)))
                .ToList();
            HubModuleStatus status;
            string detail;
            lock (_lock)
            {
                status = entry.Status;
                detail = entry.Detail;
            }
            result.Add(new HubModuleInfo(entry.Module.Id, entry.Module.DisplayName,
                IsEnabled(entry.Module), status, detail, settings));
        }
        return result;
    }

    public string GetSetting(string moduleId, string key)
    {
        var definition = FindSetting(moduleId, key);
        return ReadDb(connection =>
        {
            using var command = connection.CreateCommand();
            command.CommandText = "SELECT value FROM module_settings WHERE module_id = $m AND key = $k;";
            command.Parameters.AddWithValue("$m", moduleId);
            command.Parameters.AddWithValue("$k", key);
            return command.ExecuteScalar() as string;
        }) ?? definition.DefaultValue;
    }

    /// <summary>Returns false if the value couldn't be saved. Unknown keys throw, so a stale toggle is caught early.</summary>
    public bool SetSetting(string moduleId, string key, string value)
    {
        FindSetting(moduleId, key);
        var saved = WriteDb(connection =>
        {
            using var command = connection.CreateCommand();
            command.CommandText = """
                INSERT INTO module_settings (module_id, key, value, updated_at) VALUES ($m, $k, $v, $t)
                ON CONFLICT(module_id, key) DO UPDATE SET value = $v, updated_at = $t;
                """;
            command.Parameters.AddWithValue("$m", moduleId);
            command.Parameters.AddWithValue("$k", key);
            command.Parameters.AddWithValue("$v", value);
            command.Parameters.AddWithValue("$t", DateTime.UtcNow.ToString("O"));
            command.ExecuteNonQuery();
        });
        if (saved) NotifySettingChanged(Find(moduleId), key, value);
        return saved;
    }

    private void NotifySettingChanged(Entry entry, string key, string value)
    {
        lock (_lock)
        {
            if (entry.Context == null) return;
        }
        try
        {
            entry.Module.OnSettingChanged(key, value);
        }
        catch (Exception ex)
        {
            SetStatus(entry, HubModuleStatus.Failed, $"Could not apply setting {key}: {ex.Message}");
        }
    }

    internal void Log(string message) => _log(message);

    internal void ReportHealth(string moduleId, HubModuleContext reporter, string? degradedReason)
    {
        var entry = Find(moduleId);
        lock (_lock)
        {
            // A module stopped or abandoned after a timeout can still be running. Ignore it.
            if (!ReferenceEquals(entry.Context, reporter)) return;
            if (entry.Status is not (HubModuleStatus.Running or HubModuleStatus.Degraded or HubModuleStatus.Starting)) return;
        }
        if (degradedReason != null) SetStatus(entry, HubModuleStatus.Degraded, degradedReason);
        else SetStatus(entry, HubModuleStatus.Running, "");
    }

    internal void ReportBackgroundFailure(string moduleId, HubModuleContext reporter, string name, Exception ex)
    {
        var entry = Find(moduleId);
        lock (_lock)
        {
            if (!ReferenceEquals(entry.Context, reporter)) return;
        }
        SetStatus(entry, HubModuleStatus.Failed, $"{name} failed: {ex.Message}");
    }

    private async Task StartEntry(Entry entry)
    {
        var module = entry.Module;
        lock (_lock)
        {
            if (entry.Status is HubModuleStatus.Running or HubModuleStatus.Degraded) return;
        }
        if (!IsEnabled(module))
        {
            SetStatus(entry, HubModuleStatus.Disabled, "");
            return;
        }

        var strikes = ReadStrikes(module.Id);
        if (strikes >= MaxStartStrikes)
        {
            SetStatus(entry, HubModuleStatus.Failed,
                "The app closed unexpectedly while this module was starting. Turn it back on to try again.");
            return;
        }

        // A module marked failed by its background work may still have other parts running.
        await StopEntry(entry, StopTimeout);

        if (!PrepareDatabase(entry)) return;

        // Written before the start runs: only a dead process leaves this behind.
        WriteStrikes(module.Id, strikes + 1);
        SetStatus(entry, HubModuleStatus.Starting, "");

        var context = new HubModuleContext(this, module.Id, _database is { IsAvailable: true } ? _database : null);
        lock (_lock) entry.Context = context;

        try
        {
            // Task.Run so that a module blocking before its first await can't hold up the rest.
            var start = Task.Run(() => module.StartAsync(context, context.Stopping));
            await start.WaitAsync(StartTimeout, _closing.Token);
            lock (_lock)
            {
                if (entry.Status == HubModuleStatus.Starting) entry.Status = HubModuleStatus.Running;
            }
            PersistStatus(entry);
        }
        catch (OperationCanceledException) when (_closing.IsCancellationRequested)
        {
            context.Cancel();
            lock (_lock) entry.Context = null;
            SetStatus(entry, HubModuleStatus.Stopped, "The app closed while this module was starting.");
        }
        catch (TimeoutException)
        {
            context.Cancel();
            lock (_lock) entry.Context = null;
            SetStatus(entry, HubModuleStatus.Failed, $"Did not finish starting within {StartTimeout.TotalSeconds:0} seconds.");
        }
        catch (Exception ex)
        {
            context.Cancel();
            lock (_lock) entry.Context = null;
            SetStatus(entry, HubModuleStatus.Failed, ex.Message);
        }
        finally
        {
            // Control came back, so whatever happened, the process survived this start.
            WriteStrikes(module.Id, 0);
        }
    }

    private bool PrepareDatabase(Entry entry)
    {
        var module = entry.Module;
        if (module.Migrations.Count == 0) return true;
        if (_database == null)
        {
            SetStatus(entry, HubModuleStatus.Failed, "The hub database is unavailable.");
            return false;
        }

        var outcome = _database.ApplyMigrations(module.Id, module.Migrations, out var error);
        if (outcome == MigrationOutcome.Applied) return true;
        SetStatus(entry, HubModuleStatus.Failed, error ?? outcome.ToString());
        return false;
    }

    private async Task StopEntry(Entry entry, TimeSpan timeout)
    {
        HubModuleContext? context;
        lock (_lock)
        {
            context = entry.Context;
            entry.Context = null;
        }
        if (context == null) return;

        context.Cancel();
        try
        {
            using var cancel = new CancellationTokenSource(timeout);
            var stop = Task.Run(() => entry.Module.StopAsync(cancel.Token));
            await Task.WhenAll(stop, context.WaitForBackground()).WaitAsync(timeout);
            SetStatus(entry, HubModuleStatus.Stopped, "");
        }
        catch (Exception ex)
        {
            var reason = ex is TimeoutException ? $"Did not stop within {timeout.TotalSeconds:0.#} seconds." : ex.Message;
            Log($"{entry.Module.Id}: {reason}");
            SetStatus(entry, HubModuleStatus.Stopped, reason);
        }
    }

    private async Task RunExclusive(Func<Task> action)
    {
        await _lifecycle.WaitAsync();
        try { await action(); }
        finally { _lifecycle.Release(); }
    }

    private void SetStatus(Entry entry, HubModuleStatus status, string detail)
    {
        lock (_lock)
        {
            entry.Status = status;
            entry.Detail = detail;
        }
        Log(detail.Length > 0
            ? $"{entry.Module.Id}: {status} ({detail})"
            : $"{entry.Module.Id}: {status}");
        PersistStatus(entry);
    }

    private void PersistStatus(Entry entry)
    {
        HubModuleStatus status;
        string detail;
        lock (_lock)
        {
            status = entry.Status;
            detail = entry.Detail;
        }
        Upsert(entry.Module.Id, "status = $s, detail = $d", command =>
        {
            command.Parameters.AddWithValue("$s", status.ToString());
            command.Parameters.AddWithValue("$d", detail);
        });
    }

    private bool IsEnabled(IHubModule module)
    {
        var stored = ReadDb(connection =>
        {
            using var command = connection.CreateCommand();
            command.CommandText = "SELECT enabled FROM module_state WHERE module_id = $m;";
            command.Parameters.AddWithValue("$m", module.Id);
            return command.ExecuteScalar();
        });
        return stored is long value ? value != 0 : module.EnabledByDefault;
    }

    private void SaveEnabled(string moduleId, bool enabled)
    {
        var columns = enabled ? "enabled = $e, start_strikes = 0" : "enabled = $e";
        Upsert(moduleId, columns, command => command.Parameters.AddWithValue("$e", enabled ? 1 : 0));
    }

    private int ReadStrikes(string moduleId)
    {
        var stored = ReadDb(connection =>
        {
            using var command = connection.CreateCommand();
            command.CommandText = "SELECT start_strikes FROM module_state WHERE module_id = $m;";
            command.Parameters.AddWithValue("$m", moduleId);
            return command.ExecuteScalar();
        });
        return stored is long value ? (int)value : 0;
    }

    private void WriteStrikes(string moduleId, int strikes) =>
        Upsert(moduleId, "start_strikes = $n", command => command.Parameters.AddWithValue("$n", strikes));

    private void Upsert(string moduleId, string assignments, Action<SqliteCommand> bind)
    {
        WriteDb(connection =>
        {
            using var command = connection.CreateCommand();
            command.CommandText = $"""
                INSERT INTO module_state (module_id, updated_at) VALUES ($m, $t)
                ON CONFLICT(module_id) DO NOTHING;
                UPDATE module_state SET {assignments}, updated_at = $t WHERE module_id = $m;
                """;
            command.Parameters.AddWithValue("$m", moduleId);
            command.Parameters.AddWithValue("$t", DateTime.UtcNow.ToString("O"));
            bind(command);
            command.ExecuteNonQuery();
        });
    }

    private T? ReadDb<T>(Func<SqliteConnection, T?> read)
    {
        if (_database is not { IsAvailable: true }) return default;
        try
        {
            using var connection = _database.OpenConnection();
            return read(connection);
        }
        catch (SqliteException ex)
        {
            Log($"Hub database read failed: {ex.Message}");
            return default;
        }
    }

    private bool WriteDb(Action<SqliteConnection> write)
    {
        if (_database is not { IsAvailable: true }) return false;
        try
        {
            using var connection = _database.OpenConnection();
            write(connection);
            return true;
        }
        catch (SqliteException ex)
        {
            Log($"Hub database write failed: {ex.Message}");
            return false;
        }
    }

    private List<Entry> Snapshot()
    {
        lock (_lock) return new List<Entry>(_order);
    }

    private Entry Find(string moduleId)
    {
        lock (_lock)
        {
            return _entries.TryGetValue(moduleId, out var entry)
                ? entry
                : throw new ArgumentException($"Unknown module {moduleId}.", nameof(moduleId));
        }
    }

    private HubSettingDefinition FindSetting(string moduleId, string key) =>
        Find(moduleId).Module.Settings.FirstOrDefault(s => s.Key == key)
        ?? throw new ArgumentException($"Module {moduleId} has no setting {key}.", nameof(key));
}
