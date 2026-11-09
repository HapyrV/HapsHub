using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Data.Sqlite;

namespace HapsHub.Core;

public sealed record VrcxTableResult(string Table, long SourceRows, long Added, long AlreadyHere, long ArchivedTotal);

public sealed record VrcxSkippedTable(string Table, long Rows, string Reason);

public sealed record VrcxArchiveResult(
    IReadOnlyList<VrcxTableResult> Tables, IReadOnlyList<VrcxSkippedTable> Skipped, string? Error)
{
    /// <summary>Every row in every archived table is now in the archive, and nothing failed.</summary>
    public bool Complete => Error == null && Tables.All(t => t.Added + t.AlreadyHere == t.SourceRows);
}

/// <summary>
/// Keeps a full copy of the VRCX history that the main import doesn't read, as one JSON row per
/// source row, so nothing is lost before HapsHub has a screen for it. Reads a temporary copy,
/// so VRCX's own files are never opened. Running it again only adds rows that are new.
/// </summary>
public sealed class VrcxHistoryModule : IHubModule
{
    public const string ModuleId = "hub.vrcx-history";

    // Tables with a per-account prefix keep it, so two accounts stay apart.
    private static readonly HashSet<string> HistoryTables = new(StringComparer.OrdinalIgnoreCase)
    {
        "activity_sessions_v2", "avatar_history", "avatar_memos", "avatar_tags",
        "favorite_avatar", "favorite_friend", "favorite_print", "favorite_world",
        "feed_avatar", "feed_bio", "feed_gps", "feed_online_offline", "feed_status",
        "friend_log_current", "friend_log_history",
        "gamelog_event", "gamelog_external", "gamelog_join_leave", "gamelog_location",
        "gamelog_portal_spawn", "gamelog_resource_load", "gamelog_video_play",
        "memos", "moderation", "mutual_graph_friends", "mutual_graph_links", "mutual_graph_meta",
        "notes", "notifications", "notifications_v2", "world_memos",
    };

    // Never copied: VRCX keeps its login in these.
    private static readonly HashSet<string> SecretTables = new(StringComparer.OrdinalIgnoreCase) { "cookies", "configs" };

    private readonly Func<bool> _vrcxRunning;
    private readonly string? _archivePath;
    private readonly string? _workFolder;
    private HubModuleContext? _context;
    private int _running;

    public VrcxHistoryModule(Func<bool>? vrcxRunning = null, string? archivePath = null, string? workFolder = null)
    {
        _vrcxRunning = vrcxRunning ?? (() =>
        {
            var processes = Process.GetProcessesByName("VRCX");
            foreach (var process in processes) process.Dispose();
            return processes.Length > 0;
        });
        _archivePath = archivePath;
        _workFolder = workFolder;
    }

    public string Id => ModuleId;
    public string DisplayName => "VRCX history archive";

    public string ArchivePath => _archivePath ?? HubPaths.Data("Hub", "vrcx-history.db");

    public static string DefaultSource => OperatingSystem.IsWindows()
        ? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "VRCX", "VRCX.sqlite3")
        : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".config", "VRCX", "VRCX.sqlite3");

    public IReadOnlyList<HubMigration> Migrations { get; } = new[]
    {
        new HubMigration(1, """
            CREATE TABLE vrcx_merge_ledger (
                kind    TEXT NOT NULL,
                item_id TEXT NOT NULL,
                total   INTEGER NOT NULL,
                PRIMARY KEY (kind, item_id)
            );
            """),
    };

    public Task StartAsync(HubModuleContext context, CancellationToken cancellationToken)
    {
        _context = context;
        return Task.CompletedTask;
    }

    public Task StopAsync(CancellationToken cancellationToken)
    {
        _context = null;
        return Task.CompletedTask;
    }

    /// <summary>
    /// The totals the main import has already added to HapsHub. Its merge adds to what's there,
    /// so running it twice would double the time unless only the difference is merged.
    /// Null means the ledger can't be read, and the import must not run.
    /// </summary>
    public IReadOnlyDictionary<string, long>? ReadMergeLedger(string kind)
    {
        var database = _context?.Database;
        if (database == null) return null;
        try
        {
            var ledger = new Dictionary<string, long>();
            using var connection = database.OpenConnection();
            using var command = connection.CreateCommand();
            command.CommandText = "SELECT item_id, total FROM vrcx_merge_ledger WHERE kind = $k;";
            command.Parameters.AddWithValue("$k", kind);
            using var reader = command.ExecuteReader();
            while (reader.Read()) ledger[reader.GetString(0)] = reader.GetInt64(1);
            return ledger;
        }
        catch (SqliteException ex)
        {
            _context?.Log($"Could not read the import ledger: {ex.Message}");
            return null;
        }
    }

    public bool SaveMergeLedger(string kind, IEnumerable<(string Id, long Total)> totals)
    {
        var database = _context?.Database;
        if (database == null) return false;
        try
        {
            using var connection = database.OpenConnection();
            using var transaction = connection.BeginTransaction();
            using var command = connection.CreateCommand();
            command.Transaction = transaction;
            command.CommandText = """
                INSERT INTO vrcx_merge_ledger (kind, item_id, total) VALUES ($k, $i, $t)
                ON CONFLICT(kind, item_id) DO UPDATE SET total = MAX(total, $t);
                """;
            command.Parameters.AddWithValue("$k", kind);
            var id = command.Parameters.Add("$i", SqliteType.Text);
            var total = command.Parameters.Add("$t", SqliteType.Integer);
            foreach (var item in totals)
            {
                id.Value = item.Id;
                total.Value = item.Total;
                command.ExecuteNonQuery();
            }
            transaction.Commit();
            return true;
        }
        catch (SqliteException ex)
        {
            _context?.Log($"Could not save the import ledger: {ex.Message}");
            return false;
        }
    }

    /// <summary>What's left to add. VRCX's totals only grow, so a smaller one adds nothing.</summary>
    public static long Remaining(IReadOnlyDictionary<string, long> ledger, string id, long total) =>
        Math.Max(0, total - (ledger.TryGetValue(id, out var done) ? done : 0));

    /// <summary>What's in the archive now, per source table. Empty if nothing has been archived.</summary>
    public IReadOnlyList<VrcxTableResult> ReadSummary()
    {
        if (!File.Exists(ArchivePath)) return Array.Empty<VrcxTableResult>();
        var results = new List<VrcxTableResult>();
        using var archive = Open(ArchivePath, SqliteOpenMode.ReadOnly);
        using var command = archive.CreateCommand();
        command.CommandText = "SELECT source_table, COUNT(*) FROM vrcx_rows GROUP BY source_table ORDER BY source_table;";
        using var reader = command.ExecuteReader();
        while (reader.Read())
            results.Add(new VrcxTableResult(reader.GetString(0), 0, 0, 0, reader.GetInt64(1)));
        return results;
    }

    public VrcxArchiveResult Run(string sourcePath, Action<string>? progress = null, CancellationToken cancellationToken = default)
    {
        if (Interlocked.CompareExchange(ref _running, 1, 0) != 0)
            return Failed("An archive run is already going.");
        var work = Path.Combine(_workFolder ?? Path.GetDirectoryName(ArchivePath)!, $"vrcx-read-{Guid.NewGuid():N}");
        try
        {
            if (!File.Exists(sourcePath)) return Failed("VRCX's database wasn't found.");
            if (_vrcxRunning()) return Failed("Close VRCX first, so the copy being read is complete.");

            progress?.Invoke("Copying VRCX's database...");
            Directory.CreateDirectory(work);
            var copy = Path.Combine(work, "vrcx.db");
            foreach (var suffix in new[] { "", "-wal", "-shm" })
                if (File.Exists(sourcePath + suffix))
                    CopyShared(sourcePath + suffix, copy + suffix);

            using var source = Open(copy, SqliteOpenMode.ReadWrite);
            Directory.CreateDirectory(Path.GetDirectoryName(ArchivePath)!);
            using var archive = Open(ArchivePath, SqliteOpenMode.ReadWriteCreate);
            CreateArchive(archive);

            var (tables, skipped) = ListTables(source);
            var results = new List<VrcxTableResult>();
            foreach (var table in tables)
            {
                cancellationToken.ThrowIfCancellationRequested();
                progress?.Invoke($"Archiving {table} ({results.Count + 1} of {tables.Count})...");
                results.Add(CopyTable(source, archive, table, cancellationToken));
            }
            return new VrcxArchiveResult(results, skipped, null);
        }
        catch (Exception ex) when (ex is SqliteException or IOException or UnauthorizedAccessException)
        {
            return Failed($"The archive stopped, and tables already finished are kept: {ex.Message}");
        }
        finally
        {
            SqliteConnection.ClearAllPools();
            try { if (Directory.Exists(work)) Directory.Delete(work, recursive: true); }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { /* A leftover temp copy harms nothing. */ }
            Volatile.Write(ref _running, 0);
        }
    }

    private static VrcxArchiveResult Failed(string message) =>
        new(Array.Empty<VrcxTableResult>(), Array.Empty<VrcxSkippedTable>(), message);

    private static SqliteConnection Open(string path, SqliteOpenMode mode)
    {
        var connection = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = path, Mode = mode, Pooling = false }.ToString());
        connection.Open();
        return connection;
    }

    private static void CopyShared(string from, string to)
    {
        using var input = new FileStream(from, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
        using var output = new FileStream(to, FileMode.CreateNew, FileAccess.Write);
        input.CopyTo(output);
    }

    private static void CreateArchive(SqliteConnection archive)
    {
        using var command = archive.CreateCommand();
        command.CommandText = """
            PRAGMA journal_mode = WAL;
            CREATE TABLE IF NOT EXISTS vrcx_rows (
                source_table TEXT NOT NULL,
                row_hash     BLOB NOT NULL,
                row_json     TEXT NOT NULL,
                PRIMARY KEY (source_table, row_hash)
            ) WITHOUT ROWID;
            """;
        command.ExecuteNonQuery();
    }

    private static (List<string> Tables, List<VrcxSkippedTable> Skipped) ListTables(SqliteConnection source)
    {
        var names = new List<string>();
        using (var command = source.CreateCommand())
        {
            command.CommandText = "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name;";
            using var reader = command.ExecuteReader();
            while (reader.Read()) names.Add(reader.GetString(0));
        }

        var tables = new List<string>();
        var skipped = new List<VrcxSkippedTable>();
        foreach (var name in names)
        {
            var kind = KindOf(name);
            if (HistoryTables.Contains(kind))
            {
                tables.Add(name);
            }
            else if (!name.StartsWith("sqlite_", StringComparison.OrdinalIgnoreCase))
            {
                // Listed so a table VRCX adds later can't vanish without anyone noticing.
                var reason = SecretTables.Contains(kind) ? "VRCX's login and settings" : "A cache VRCX can rebuild, or a table this version doesn't know";
                skipped.Add(new VrcxSkippedTable(name, CountRows(source, name), reason));
            }
        }
        return (tables, skipped);
    }

    private static string KindOf(string name)
    {
        if (!name.StartsWith("usr", StringComparison.OrdinalIgnoreCase)) return name;
        var split = name.IndexOf('_');
        return split < 0 ? name : name[(split + 1)..];
    }

    private static string Quote(string name) => $"\"{name.Replace("\"", "\"\"")}\"";

    private static long CountRows(SqliteConnection connection, string table)
    {
        using var command = connection.CreateCommand();
        command.CommandText = $"SELECT COUNT(*) FROM {Quote(table)};";
        return (long)command.ExecuteScalar()!;
    }

    private static VrcxTableResult CopyTable(SqliteConnection source, SqliteConnection archive, string table, CancellationToken cancellationToken)
    {
        using var transaction = archive.BeginTransaction();
        using var insert = archive.CreateCommand();
        insert.Transaction = transaction;
        insert.CommandText = "INSERT OR IGNORE INTO vrcx_rows (source_table, row_hash, row_json) VALUES ($t, $h, $j);";
        insert.Parameters.AddWithValue("$t", table);
        var hash = insert.Parameters.Add("$h", SqliteType.Blob);
        var json = insert.Parameters.Add("$j", SqliteType.Text);
        insert.Prepare();

        long seen = 0, added = 0;
        using (var read = source.CreateCommand())
        {
            read.CommandText = $"SELECT * FROM {Quote(table)};";
            using var reader = read.ExecuteReader();
            while (reader.Read())
            {
                if (++seen % 5000 == 0) cancellationToken.ThrowIfCancellationRequested();
                var row = RowJson(reader);
                hash.Value = SHA256.HashData(row).AsSpan(0, 16).ToArray();
                json.Value = Encoding.UTF8.GetString(row);
                added += insert.ExecuteNonQuery();
            }
        }

        using var count = archive.CreateCommand();
        count.Transaction = transaction;
        count.CommandText = "SELECT COUNT(*) FROM vrcx_rows WHERE source_table = $t;";
        count.Parameters.AddWithValue("$t", table);
        var total = (long)count.ExecuteScalar()!;
        transaction.Commit();
        return new VrcxTableResult(table, seen, added, seen - added, total);
    }

    private static byte[] RowJson(SqliteDataReader reader)
    {
        using var buffer = new MemoryStream();
        using (var writer = new Utf8JsonWriter(buffer))
        {
            writer.WriteStartObject();
            for (var i = 0; i < reader.FieldCount; i++)
            {
                writer.WritePropertyName(reader.GetName(i));
                if (reader.IsDBNull(i))
                {
                    writer.WriteNullValue();
                    continue;
                }
                switch (reader.GetValue(i))
                {
                    case long number: writer.WriteNumberValue(number); break;
                    case double real: writer.WriteNumberValue(real); break;
                    case byte[] bytes:
                        writer.WriteStartObject();
                        writer.WriteBase64String("$bytes", bytes);
                        writer.WriteEndObject();
                        break;
                    case var other: writer.WriteStringValue(other.ToString()); break;
                }
            }
            writer.WriteEndObject();
        }
        return buffer.ToArray();
    }
}
