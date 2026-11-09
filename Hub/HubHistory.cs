using System.Globalization;
using System.Text.Json;
using Microsoft.Data.Sqlite;

namespace HapsHub.Core;

/// <summary>One line on the History page, whichever table it came from.</summary>
public sealed record HubHistoryRow(
    string At, string Kind, string Name, string UserId, string Old, string New, string Text, string Link, string Source,
    string Key = "");

public sealed record HubHistoryPage(IReadOnlyList<HubHistoryRow> Rows, int Total, int Offset);

/// <summary>What HapsHub records for the History page: friends' name and trust changes, and portals.</summary>
public sealed class HubHistoryModule : IHubModule
{
    public const string ModuleId = "hub.history";
    private readonly object _lock = new();
    private readonly Dictionary<string, (string Name, string Trust)> _known = new();
    private HubModuleContext? _context;
    private bool _loaded;

    /// <summary>User ID, name now, "DisplayName" or "TrustLevel", old value, new value.</summary>
    public event Action<string, string, string, string, string>? FriendChanged;

    public string Id => ModuleId;
    public string DisplayName => "History log";

    public IReadOnlyList<HubMigration> Migrations { get; } = new[]
    {
        new HubMigration(1, """
            CREATE TABLE friend_known (
                user_id TEXT PRIMARY KEY,
                name    TEXT NOT NULL DEFAULT '',
                trust   TEXT NOT NULL DEFAULT ''
            );
            CREATE TABLE friend_changes (
                id        INTEGER PRIMARY KEY AUTOINCREMENT,
                at        TEXT NOT NULL,
                user_id   TEXT NOT NULL,
                name      TEXT NOT NULL DEFAULT '',
                kind      TEXT NOT NULL,
                old_value TEXT NOT NULL DEFAULT '',
                new_value TEXT NOT NULL DEFAULT ''
            );
            CREATE INDEX idx_friend_changes_at ON friend_changes(at);
            CREATE TABLE portal_log (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                at         TEXT NOT NULL,
                kind       TEXT NOT NULL,
                location   TEXT NOT NULL DEFAULT '',
                world_name TEXT NOT NULL DEFAULT ''
            );
            CREATE INDEX idx_portal_log_at ON portal_log(at);
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
        lock (_lock) { _known.Clear(); _loaded = false; }
        return Task.CompletedTask;
    }

    /// <summary>VRChat's own rank order, named the way VRCX names them.</summary>
    public static string TrustFromTags(IEnumerable<string>? tags)
    {
        if (tags == null) return "";
        var list = tags as ICollection<string> ?? tags.ToList();
        if (list.Count == 0) return "";
        if (list.Contains("system_trust_veteran")) return "Trusted User";
        if (list.Contains("system_trust_trusted")) return "Known User";
        if (list.Contains("system_trust_known")) return "User";
        if (list.Contains("system_trust_basic")) return "New User";
        return "Visitor";
    }

    /// <summary>
    /// Compares a friend with what was last seen. The first sighting only remembers them, so a
    /// new install doesn't report every friend as changed. An empty value means "not in this update".
    /// </summary>
    public void ObserveFriend(string userId, string name, string trust)
    {
        var database = _context?.Database;
        if (database == null || string.IsNullOrEmpty(userId)) return;
        var changes = new List<(string Kind, string Old, string New, string Name)>();
        try
        {
            lock (_lock)
            {
                // Friend lists arrive in hundreds, nearly always unchanged.
                if (_loaded && _known.TryGetValue(userId, out var cached)
                    && (name.Length == 0 || name == cached.Name) && (trust.Length == 0 || trust == cached.Trust)) return;
                using var connection = database.OpenConnection();
                if (!_loaded)
                {
                    using var read = connection.CreateCommand();
                    read.CommandText = "SELECT user_id, name, trust FROM friend_known";
                    using var reader = read.ExecuteReader();
                    while (reader.Read()) _known[reader.GetString(0)] = (reader.GetString(1), reader.GetString(2));
                    _loaded = true;
                }

                var isNew = !_known.TryGetValue(userId, out var was);
                var nameNow = name.Length > 0 ? name : was.Name;
                var trustNow = trust.Length > 0 ? trust : was.Trust;
                if (!isNew && nameNow == was.Name && trustNow == was.Trust) return;

                using var transaction = connection.BeginTransaction();
                if (!isNew && was.Name.Length > 0 && nameNow != was.Name)
                {
                    InsertChange(connection, transaction, userId, nameNow, "DisplayName", was.Name, nameNow);
                    changes.Add(("DisplayName", was.Name, nameNow, nameNow));
                }
                if (!isNew && was.Trust.Length > 0 && trustNow != was.Trust)
                {
                    InsertChange(connection, transaction, userId, nameNow, "TrustLevel", was.Trust, trustNow);
                    changes.Add(("TrustLevel", was.Trust, trustNow, nameNow));
                }
                using (var save = connection.CreateCommand())
                {
                    save.Transaction = transaction;
                    save.CommandText = """
                        INSERT INTO friend_known(user_id, name, trust) VALUES($id, $name, $trust)
                        ON CONFLICT(user_id) DO UPDATE SET name = excluded.name, trust = excluded.trust
                        """;
                    save.Parameters.AddWithValue("$id", userId);
                    save.Parameters.AddWithValue("$name", nameNow);
                    save.Parameters.AddWithValue("$trust", trustNow);
                    save.ExecuteNonQuery();
                }
                transaction.Commit();
                _known[userId] = (nameNow, trustNow);
            }
        }
        catch (SqliteException ex)
        {
            _context?.Log($"Could not record a friend change: {ex.Message}");
            return;
        }
        foreach (var change in changes) FriendChanged?.Invoke(userId, change.Name, change.Kind, change.Old, change.New);
    }

    private static void InsertChange(SqliteConnection connection, SqliteTransaction transaction,
        string userId, string name, string kind, string oldValue, string newValue)
    {
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = """
            INSERT INTO friend_changes(at, user_id, name, kind, old_value, new_value)
            VALUES($at, $user, $name, $kind, $old, $new)
            """;
        command.Parameters.AddWithValue("$at", DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture));
        command.Parameters.AddWithValue("$user", userId);
        command.Parameters.AddWithValue("$name", name);
        command.Parameters.AddWithValue("$kind", kind);
        command.Parameters.AddWithValue("$old", oldValue);
        command.Parameters.AddWithValue("$new", newValue);
        command.ExecuteNonQuery();
    }

    /// <summary>A portal appeared in your instance ("spawn") or you went through one ("used").</summary>
    public void AddPortal(string kind, string location, string worldName, DateTime? at = null)
    {
        var database = _context?.Database;
        if (database == null) return;
        try
        {
            using var connection = database.OpenConnection();
            using var command = connection.CreateCommand();
            command.CommandText = "INSERT INTO portal_log(at, kind, location, world_name) VALUES($at, $kind, $location, $world)";
            command.Parameters.AddWithValue("$at", (at ?? DateTime.UtcNow).ToUniversalTime().ToString("o", CultureInfo.InvariantCulture));
            command.Parameters.AddWithValue("$kind", kind);
            command.Parameters.AddWithValue("$location", location);
            command.Parameters.AddWithValue("$world", worldName);
            command.ExecuteNonQuery();
        }
        catch (SqliteException ex)
        {
            _context?.Log($"Could not record a portal: {ex.Message}");
        }
    }

    public IReadOnlyList<HubHistoryRow> ReadFriendChanges() => Read(
        "SELECT at, kind, name, user_id, old_value, new_value FROM friend_changes",
        r => new HubHistoryRow(r.GetString(0), r.GetString(1), r.GetString(2), r.GetString(3), r.GetString(4), r.GetString(5), "", "", "HapsHub"));

    public IReadOnlyList<HubHistoryRow> ReadPortals() => Read(
        "SELECT at, kind, world_name, location FROM portal_log",
        r => new HubHistoryRow(r.GetString(0), r.GetString(1), "", "", "", "", r.GetString(2), r.GetString(3), "HapsHub"));

    private IReadOnlyList<HubHistoryRow> Read(string sql, Func<SqliteDataReader, HubHistoryRow> make)
    {
        var rows = new List<HubHistoryRow>();
        var database = _context?.Database;
        if (database == null) return rows;
        try
        {
            using var connection = database.OpenConnection();
            using var command = connection.CreateCommand();
            command.CommandText = sql;
            using var reader = command.ExecuteReader();
            while (reader.Read()) rows.Add(make(reader));
        }
        catch (SqliteException ex)
        {
            _context?.Log($"Could not read history: {ex.Message}");
        }
        return rows;
    }
}

/// <summary>Turns archived VRCX rows into History page lines, merges them with live ones, and pages them.</summary>
public static class HubHistoryViews
{
    public static readonly IReadOnlyList<string> Archived = new[] { "names", "friends", "notifications", "videos", "avatars", "friendavatars", "gamelog" };

    private static readonly Dictionary<string, string[]> Tables = new()
    {
        ["names"] = new[] { "_friend_log_history" },
        ["friends"] = new[] { "_friend_log_history" },
        ["notifications"] = new[] { "_notifications", "_notifications_v2" },
        ["videos"] = new[] { "gamelog_video_play" },
        ["avatars"] = new[] { "_avatar_history" },
        ["friendavatars"] = new[] { "_feed_avatar" },
        ["gamelog"] = new[] { "gamelog_event" },
    };

    public static List<HubHistoryRow> FromArchive(VrcxHistoryModule archive, string view)
    {
        var rows = new List<HubHistoryRow>();
        if (!Tables.TryGetValue(view, out var tables)) return rows;
        foreach (var json in archive.ReadRowsOfTables(tables))
        {
            try
            {
                using var document = JsonDocument.Parse(json);
                var row = Convert(view, document.RootElement);
                if (row != null) rows.Add(row);
            }
            catch (JsonException) { /* One bad row must not hide the rest. */ }
        }
        return rows;
    }

    private static string S(JsonElement row, string name)
    {
        if (!row.TryGetProperty(name, out var value)) return "";
        return value.ValueKind switch
        {
            JsonValueKind.String => value.GetString() ?? "",
            JsonValueKind.Number => value.GetRawText(),
            _ => "",
        };
    }

    private static HubHistoryRow? Convert(string view, JsonElement r)
    {
        var at = S(r, "created_at");
        switch (view)
        {
            case "names":
            {
                var kind = S(r, "type");
                if (kind == "DisplayName")
                    return new(at, kind, S(r, "display_name"), S(r, "user_id"), S(r, "previous_display_name"), S(r, "display_name"), "", "", "VRCX");
                if (kind == "TrustLevel")
                    return new(at, kind, S(r, "display_name"), S(r, "user_id"), S(r, "previous_trust_level"), S(r, "trust_level"), "", "", "VRCX");
                return null;
            }
            case "friends":
            {
                var kind = S(r, "type");
                return kind is "Friend" or "Unfriend" or "FriendRequest"
                    ? new(at, kind, S(r, "display_name"), S(r, "user_id"), "", "", "", "", "VRCX")
                    : null;
            }
            case "notifications":
            {
                var title = S(r, "title");
                var message = S(r, "message");
                var text = title.Length > 0 && title != message ? $"{title}: {message}" : message;
                return new(at, S(r, "type"), S(r, "sender_username"), S(r, "sender_user_id"), "", S(r, "world_name"), text, "", "VRCX", S(r, "id"));
            }
            case "videos":
            {
                var url = S(r, "video_url");
                return new(at, "video", S(r, "display_name"), S(r, "user_id"), "", "", S(r, "video_name"), url, "VRCX", VideoKey(url, at));
            }
            case "avatars":
                return new(at, "avatar", "", "", "", S(r, "time"), "", S(r, "avatar_id"), "VRCX");
            case "friendavatars":
                return new(at, "avatar", S(r, "display_name"), S(r, "user_id"), "", "", S(r, "avatar_name"), "", "VRCX");
            case "gamelog":
                return new(at, "event", "", "", "", "", S(r, "data"), "", "VRCX");
            default:
                return null;
        }
    }

    /// <summary>Both apps can log the same video, a moment apart.</summary>
    public static string VideoKey(string url, string at) =>
        TryParse(at, out var time) ? $"{url}|{time.ToUnixTimeSeconds() / 120}" : "";

    private static bool TryParse(string at, out DateTimeOffset time) =>
        DateTimeOffset.TryParse(at, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out time);

    /// <summary>Newest first. Rows sharing a Key are one event; the first one given wins.</summary>
    public static HubHistoryPage Page(IEnumerable<HubHistoryRow> rows, string search, int offset, int limit)
    {
        var seen = new HashSet<string>();
        var query = (search ?? "").Trim();
        var matched = new List<(DateTimeOffset Time, HubHistoryRow Row)>();
        foreach (var row in rows)
        {
            if (row.Key.Length > 0 && !seen.Add(row.Key)) continue;
            if (query.Length > 0 && !Matches(row, query)) continue;
            matched.Add((TryParse(row.At, out var time) ? time : DateTimeOffset.MinValue, row));
        }
        matched.Sort((a, b) => b.Time.CompareTo(a.Time));
        var start = Math.Max(0, offset);
        return new HubHistoryPage(matched.Skip(start).Take(limit).Select(m => m.Row).ToList(), matched.Count, start);
    }

    private static bool Matches(HubHistoryRow row, string query) =>
        new[] { row.Kind, row.Name, row.UserId, row.Old, row.New, row.Text, row.Link }
            .Any(field => field.Contains(query, StringComparison.OrdinalIgnoreCase));
}
