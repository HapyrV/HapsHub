using Microsoft.Data.Sqlite;

namespace HapsHub.Core;

/// <summary>A numbered schema step. Numbers must increase and shipped steps must never change.</summary>
public sealed record HubMigration(int Version, string Sql);

public enum MigrationOutcome { Applied, Failed, DatabaseIsNewer, Unavailable }

/// <summary>
/// HapsHub's own SQLite file, separate from the upstream databases so that upstream
/// merges and its migrator stay untouched. A failure here never stops the app:
/// IsAvailable goes false and the modules that need the database report it.
/// </summary>
public sealed class HubDatabase
{
    private const string CoreOwner = "hub.core";
    private const int SqliteCorrupt = 11;
    private const int SqliteNotADatabase = 26;

    private static readonly HubMigration[] CoreMigrations =
    {
        new(1, """
            CREATE TABLE module_state (
                module_id     TEXT PRIMARY KEY,
                enabled       INTEGER,
                status        TEXT NOT NULL DEFAULT '',
                detail        TEXT NOT NULL DEFAULT '',
                start_strikes INTEGER NOT NULL DEFAULT 0,
                updated_at    TEXT NOT NULL
            );
            CREATE TABLE module_settings (
                module_id  TEXT NOT NULL,
                key        TEXT NOT NULL,
                value      TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                PRIMARY KEY (module_id, key)
            );
            """),
    };

    private readonly Action<string> _log;
    private readonly string _connectionString;
    private readonly object _migrationLock = new();

    public HubDatabase(string filePath, Action<string>? log = null)
    {
        FilePath = filePath;
        _log = log ?? (_ => { });
        _connectionString = new SqliteConnectionStringBuilder
        {
            DataSource = filePath,
            Mode = SqliteOpenMode.ReadWriteCreate,
            Cache = SqliteCacheMode.Private,
            ForeignKeys = true,
            DefaultTimeout = 5,
        }.ToString();
    }

    public string FilePath { get; }
    public bool IsAvailable { get; private set; }
    public string? LastError { get; private set; }

    /// <summary>Where a damaged file was moved, if that happened on this open.</summary>
    public string? QuarantinedTo { get; private set; }

    public bool Open()
    {
        if (TryOpen(out var damaged)) return true;
        if (!damaged) return false;

        // Only clear evidence of damage gets here, so a locked file or a full disk
        // can't cost anyone their data. The old file is kept, never deleted.
        try
        {
            Quarantine();
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return Fail($"Could not move the damaged database aside: {ex.Message}");
        }
        return TryOpen(out _);
    }

    public SqliteConnection OpenConnection()
    {
        var connection = new SqliteConnection(_connectionString);
        connection.Open();
        Execute(connection, "PRAGMA synchronous=NORMAL;");
        return connection;
    }

    /// <summary>Brings one owner's tables up to date. Each step runs in its own transaction.</summary>
    public MigrationOutcome ApplyMigrations(string owner, IReadOnlyList<HubMigration> migrations, out string? error)
    {
        error = null;
        if (!IsAvailable)
        {
            error = "The hub database is unavailable.";
            return MigrationOutcome.Unavailable;
        }
        if (migrations.Count == 0) return MigrationOutcome.Applied;

        lock (_migrationLock)
        {
            try
            {
                using var connection = OpenConnection();
                return Migrate(connection, owner, migrations, out error);
            }
            catch (SqliteException ex)
            {
                error = ex.Message;
                _log($"Migration for {owner} failed: {ex.Message}");
                return MigrationOutcome.Failed;
            }
        }
    }

    private bool TryOpen(out bool damaged)
    {
        damaged = false;
        IsAvailable = false;
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(FilePath))!);
            using (var connection = new SqliteConnection(_connectionString))
            {
                connection.Open();
                var check = Scalar(connection, "PRAGMA quick_check(1);");
                if (!string.Equals(check, "ok", StringComparison.OrdinalIgnoreCase))
                {
                    damaged = true;
                    return Fail($"Integrity check failed: {check}");
                }
                Execute(connection, "PRAGMA journal_mode=WAL;");
                Execute(connection, """
                    CREATE TABLE IF NOT EXISTS schema_versions (
                        owner      TEXT PRIMARY KEY,
                        version    INTEGER NOT NULL,
                        updated_at TEXT NOT NULL
                    );
                    """);
                if (Migrate(connection, CoreOwner, CoreMigrations, out var error) != MigrationOutcome.Applied)
                    return Fail(error ?? "Core migration failed.");
            }
            IsAvailable = true;
            LastError = null;
            return true;
        }
        catch (SqliteException ex)
        {
            damaged = ex.SqliteErrorCode is SqliteCorrupt or SqliteNotADatabase;
            return Fail(ex.Message);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return Fail(ex.Message);
        }
    }

    private MigrationOutcome Migrate(SqliteConnection connection, string owner,
        IReadOnlyList<HubMigration> migrations, out string? error)
    {
        error = null;
        var current = CurrentVersion(connection, owner);
        var latest = migrations.Max(m => m.Version);

        // Happens after rolling back to an older build. Running against tables from
        // the future could damage them, so the owner sits out until the newer build returns.
        if (current > latest)
        {
            error = $"Its data is at version {current}, but this build only knows version {latest}.";
            _log($"{owner}: {error}");
            return MigrationOutcome.DatabaseIsNewer;
        }

        foreach (var step in migrations.Where(m => m.Version > current).OrderBy(m => m.Version))
        {
            using var transaction = connection.BeginTransaction();
            try
            {
                using (var command = connection.CreateCommand())
                {
                    command.Transaction = transaction;
                    command.CommandText = step.Sql;
                    command.ExecuteNonQuery();
                }
                using (var command = connection.CreateCommand())
                {
                    command.Transaction = transaction;
                    command.CommandText = """
                        INSERT INTO schema_versions (owner, version, updated_at) VALUES ($o, $v, $t)
                        ON CONFLICT(owner) DO UPDATE SET version = $v, updated_at = $t;
                        """;
                    command.Parameters.AddWithValue("$o", owner);
                    command.Parameters.AddWithValue("$v", step.Version);
                    command.Parameters.AddWithValue("$t", DateTime.UtcNow.ToString("O"));
                    command.ExecuteNonQuery();
                }
                transaction.Commit();
                _log($"{owner}: schema now at version {step.Version}.");
            }
            catch (SqliteException ex) when (ex.SqliteErrorCode is not (SqliteCorrupt or SqliteNotADatabase))
            {
                error = $"Step {step.Version} failed: {ex.Message}";
                _log($"{owner}: {error}");
                return MigrationOutcome.Failed;
            }
        }
        return MigrationOutcome.Applied;
    }

    private static int CurrentVersion(SqliteConnection connection, string owner)
    {
        using var command = connection.CreateCommand();
        command.CommandText = "SELECT version FROM schema_versions WHERE owner = $o;";
        command.Parameters.AddWithValue("$o", owner);
        return command.ExecuteScalar() is long version ? (int)version : 0;
    }

    private void Quarantine()
    {
        // Only this file's pool: the upstream databases share the same SQLite provider.
        using (var connection = new SqliteConnection(_connectionString))
            SqliteConnection.ClearPool(connection);
        var stamp = DateTime.Now.ToString("yyyyMMdd-HHmmss");
        var destination = $"{FilePath}.damaged-{stamp}";
        File.Move(FilePath, destination);
        foreach (var suffix in new[] { "-wal", "-shm" })
            if (File.Exists(FilePath + suffix)) File.Move(FilePath + suffix, destination + suffix);
        QuarantinedTo = destination;
        _log($"The hub database was damaged. It was moved to {destination} and a new one was started.");
    }

    private bool Fail(string message)
    {
        LastError = message;
        _log($"Hub database: {message}");
        return false;
    }

    private static void Execute(SqliteConnection connection, string sql)
    {
        using var command = connection.CreateCommand();
        command.CommandText = sql;
        command.ExecuteNonQuery();
    }

    private static string? Scalar(SqliteConnection connection, string sql)
    {
        using var command = connection.CreateCommand();
        command.CommandText = sql;
        return command.ExecuteScalar()?.ToString();
    }
}
