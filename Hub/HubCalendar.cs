using Microsoft.Data.Sqlite;

namespace HapsHub.Core;

public sealed record HubCalendarEvent(
    string Id, string Title, string Description, string StartsAt, string EndsAt, string Repeat, string RepeatUntil);

/// <summary>Your own calendar events. The page works out when repeats fall, in local time, so they survive clock changes.</summary>
public sealed class HubCalendarModule : IHubModule
{
    public const string ModuleId = "hub.calendar";
    private static readonly HashSet<string> Repeats = new() { "none", "daily", "weekly", "monthly", "yearly" };
    private HubModuleContext? _context;

    public string Id => ModuleId;
    public string DisplayName => "Calendar events";

    public IReadOnlyList<HubMigration> Migrations { get; } = new[]
    {
        new HubMigration(1, """
            CREATE TABLE calendar_events (
                id           TEXT PRIMARY KEY,
                title        TEXT NOT NULL,
                description  TEXT NOT NULL DEFAULT '',
                starts_at    TEXT NOT NULL,
                ends_at      TEXT NOT NULL,
                repeat       TEXT NOT NULL DEFAULT 'none',
                repeat_until TEXT NOT NULL DEFAULT '',
                updated_at   TEXT NOT NULL
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

    /// <summary>Null means the database can't be read, which the page must not show as "no events".</summary>
    public IReadOnlyList<HubCalendarEvent>? List()
    {
        var database = _context?.Database;
        if (database == null) return null;
        try
        {
            var events = new List<HubCalendarEvent>();
            using var connection = database.OpenConnection();
            using var command = connection.CreateCommand();
            command.CommandText = "SELECT id, title, description, starts_at, ends_at, repeat, repeat_until FROM calendar_events ORDER BY starts_at;";
            using var reader = command.ExecuteReader();
            while (reader.Read())
                events.Add(new HubCalendarEvent(reader.GetString(0), reader.GetString(1), reader.GetString(2),
                    reader.GetString(3), reader.GetString(4), reader.GetString(5), reader.GetString(6)));
            return events;
        }
        catch (SqliteException ex)
        {
            _context?.Log($"Could not read calendar events: {ex.Message}");
            return null;
        }
    }

    /// <summary>Saves a new or changed event, and returns why it couldn't, or null.</summary>
    public string? Save(HubCalendarEvent item)
    {
        var database = _context?.Database;
        if (database == null) return "The hub database isn't available.";
        if (string.IsNullOrWhiteSpace(item.Title)) return "Give the event a name.";
        if (!DateTimeOffset.TryParse(item.StartsAt, out var start)) return "The start time isn't valid.";
        if (!DateTimeOffset.TryParse(item.EndsAt, out var end) || end < start) return "The end can't be before the start.";
        if (!Repeats.Contains(item.Repeat)) return "That repeat option isn't valid.";
        try
        {
            using var connection = database.OpenConnection();
            using var command = connection.CreateCommand();
            command.CommandText = """
                INSERT INTO calendar_events (id, title, description, starts_at, ends_at, repeat, repeat_until, updated_at)
                VALUES ($id, $title, $description, $start, $end, $repeat, $until, $now)
                ON CONFLICT(id) DO UPDATE SET title = excluded.title, description = excluded.description,
                    starts_at = excluded.starts_at, ends_at = excluded.ends_at, repeat = excluded.repeat,
                    repeat_until = excluded.repeat_until, updated_at = excluded.updated_at;
                """;
            command.Parameters.AddWithValue("$id", string.IsNullOrEmpty(item.Id) ? Guid.NewGuid().ToString("N") : item.Id);
            command.Parameters.AddWithValue("$title", item.Title.Trim());
            command.Parameters.AddWithValue("$description", item.Description ?? "");
            command.Parameters.AddWithValue("$start", item.StartsAt);
            command.Parameters.AddWithValue("$end", item.EndsAt);
            command.Parameters.AddWithValue("$repeat", item.Repeat);
            command.Parameters.AddWithValue("$until", item.RepeatUntil ?? "");
            command.Parameters.AddWithValue("$now", DateTime.UtcNow.ToString("O"));
            command.ExecuteNonQuery();
            return null;
        }
        catch (SqliteException ex)
        {
            _context?.Log($"Could not save a calendar event: {ex.Message}");
            return "The event couldn't be saved.";
        }
    }

    public bool Delete(string id)
    {
        var database = _context?.Database;
        if (database == null) return false;
        try
        {
            using var connection = database.OpenConnection();
            using var command = connection.CreateCommand();
            command.CommandText = "DELETE FROM calendar_events WHERE id = $id;";
            command.Parameters.AddWithValue("$id", id);
            command.ExecuteNonQuery();
            return true;
        }
        catch (SqliteException ex)
        {
            _context?.Log($"Could not delete a calendar event: {ex.Message}");
            return false;
        }
    }
}
