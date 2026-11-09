using Microsoft.Data.Sqlite;

namespace VRCNext.Services;

// HapsHub's own reads of the timeline, kept apart from upstream's file.
public partial class TimelineService
{
    public sealed record ScheduleData(
        List<object[]> Presence, List<object[]> Relationships, List<object[]> Self, Dictionary<string, string> Names);

    /// <summary>
    /// What the friend schedule needs, as compact rows. Times stay as stored; the page's engine parses them.
    /// Presence is [time, 1 online or 0 offline, friend], relationships [time, 1 added or 0 removed, friend], self [time, ms].
    /// </summary>
    public ScheduleData ReadScheduleData()
    {
        var presence = new List<object[]>();
        var relationships = new List<object[]>();
        var self = new List<object[]>();
        var names = new Dictionary<string, string>();

        lock (_lock)
        {
            using (var command = _db.CreateCommand())
            {
                command.CommandText = @"SELECT timestamp, type, friend_id, friend_name FROM friend_events
                    WHERE type IN ('friend_online','friend_offline','friend_added','friend_removed') AND friend_id <> ''
                    ORDER BY timestamp ASC";
                using var reader = command.ExecuteReader();
                while (reader.Read())
                {
                    var type = reader.GetString(1);
                    var friend = reader.GetString(2);
                    var row = new object[] { reader.GetString(0), type is "friend_online" or "friend_added" ? 1 : 0, friend };
                    (type is "friend_online" or "friend_offline" ? presence : relationships).Add(row);
                    if (!reader.IsDBNull(3) && reader.GetString(3).Length > 0) names[friend] = reader.GetString(3);
                }
            }

            using (var command = _db.CreateCommand())
            {
                command.CommandText = @"SELECT timestamp, left_at FROM events WHERE type = 'instance_join' ORDER BY timestamp ASC";
                using var reader = command.ExecuteReader();
                while (reader.Read())
                {
                    var joined = reader.GetString(0);
                    var left = reader.IsDBNull(1) ? "" : reader.GetString(1);
                    // Zero tells the engine the visit's end is unknown, and to infer it.
                    var duration = DateTime.TryParse(joined, out var from) && DateTime.TryParse(left, out var to) && to > from
                        ? (long)(to - from).TotalMilliseconds
                        : 0L;
                    self.Add(new object[] { joined, duration });
                }
            }
        }
        return new ScheduleData(presence, relationships, self, names);
    }
}
