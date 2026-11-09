using Microsoft.Data.Sqlite;

namespace VRCNext.Services;

// HapsHub's own reads of the timeline, kept apart from upstream's file.
public partial class TimelineService
{
    /// <summary>What HapsHub recorded itself, so an import can tell which sessions it already has.</summary>
    public sealed class LiveEvents
    {
        private const long SameMomentSeconds = 120;
        internal readonly Dictionary<string, List<long>> Joins = new();
        internal readonly Dictionary<string, List<long>> Friends = new();
        internal readonly HashSet<string> Meets = new();
        internal readonly Dictionary<string, long> FirstMeets = new();

        internal static long Seconds(string timestamp) =>
            Helpers.DateTimeHelper.TryParseUtc(timestamp, out var at) ? new DateTimeOffset(at, TimeSpan.Zero).ToUnixTimeSeconds() : 0;

        internal static string FriendKey(string friendId, string type, string location) =>
            friendId + "|" + type + "|" + (type == "friend_gps" ? location : "");

        private static bool Near(List<long>? times, long at)
        {
            if (times == null || at == 0) return false;
            foreach (var time in times)
                if (Math.Abs(time - at) <= SameMomentSeconds) return true;
            return false;
        }

        public bool HasJoin(string location, string timestamp) =>
            Near(Joins.GetValueOrDefault(location), Seconds(timestamp));

        public bool HasFriendEvent(string friendId, string type, string location, string timestamp) =>
            Near(Friends.GetValueOrDefault(FriendKey(friendId, type, location)), Seconds(timestamp));

        public bool HasMeet(string userId, string location) => Meets.Contains(userId + "|" + location);

        public bool MetBefore(string userId, string timestamp) =>
            FirstMeets.TryGetValue(userId, out var first) && first <= Seconds(timestamp);
    }

    /// <summary>Everything not from a past import, so a repeat import treats its own rows as already handled by their IDs.</summary>
    public LiveEvents ReadLiveEventsForImport()
    {
        var live = new LiveEvents();
        lock (_lock)
        {
            using (var command = _db.CreateCommand())
            {
                command.CommandText = @"SELECT type, timestamp, IFNULL(location,''), IFNULL(user_id,'') FROM events
                    WHERE type IN ('instance_join','first_meet','meet_again') AND id NOT LIKE 'vrcx\_%' ESCAPE '\'";
                using var reader = command.ExecuteReader();
                while (reader.Read())
                {
                    var type = reader.GetString(0);
                    var at = LiveEvents.Seconds(reader.GetString(1));
                    var location = reader.GetString(2);
                    var user = reader.GetString(3);
                    if (type == "instance_join")
                    {
                        if (!live.Joins.TryGetValue(location, out var list)) live.Joins[location] = list = new();
                        list.Add(at);
                    }
                    else if (user.Length > 0)
                    {
                        live.Meets.Add(user + "|" + location);
                        if (type == "first_meet" && at > 0 && (!live.FirstMeets.TryGetValue(user, out var first) || at < first))
                            live.FirstMeets[user] = at;
                    }
                }
            }
            using (var command = _db.CreateCommand())
            {
                command.CommandText = @"SELECT friend_id, type, IFNULL(location,''), timestamp FROM friend_events
                    WHERE id NOT LIKE 'vrcx\_%' ESCAPE '\'";
                using var reader = command.ExecuteReader();
                while (reader.Read())
                {
                    var key = LiveEvents.FriendKey(reader.GetString(0), reader.GetString(1), reader.GetString(2));
                    if (!live.Friends.TryGetValue(key, out var list)) live.Friends[key] = list = new();
                    list.Add(LiveEvents.Seconds(reader.GetString(3)));
                }
            }
        }
        return live;
    }

    /// <summary>Adds time to the yearly recap. Each ID is "userId|year".</summary>
    public void BulkAddYearSeconds(IEnumerable<(string Id, long Seconds)> entries)
    {
        lock (_lock)
        {
            try
            {
                using var transaction = _db.BeginTransaction();
                using var command = _db.CreateCommand();
                command.Transaction = transaction;
                command.CommandText = @"INSERT INTO user_year_tracking(user_id,year,total_seconds,meets) VALUES($u,$y,$s,0)
                    ON CONFLICT(user_id,year) DO UPDATE SET total_seconds = total_seconds + excluded.total_seconds";
                var user = command.Parameters.Add("$u", SqliteType.Text);
                var year = command.Parameters.Add("$y", SqliteType.Integer);
                var seconds = command.Parameters.Add("$s", SqliteType.Integer);
                foreach (var (id, amount) in entries)
                {
                    var split = id.LastIndexOf('|');
                    if (split <= 0 || !int.TryParse(id[(split + 1)..], out var parsedYear)) continue;
                    user.Value = id[..split];
                    year.Value = parsedYear;
                    seconds.Value = amount;
                    command.ExecuteNonQuery();
                }
                transaction.Commit();
            }
            catch (Exception ex) { CrashHandler.WriteEntry("BulkAddYearSeconds", ex); }
        }
    }

    /// <summary>
    /// After an import, leaves each person one first meeting, the earliest, and makes the profile
    /// and recap totals match the timeline. Totals only ever go up, in case old events were pruned.
    /// </summary>
    public void ReconcileMeetsAfterImport()
    {
        lock (_lock)
        {
            try
            {
                var rows = new List<(string Id, string Type, string User, string Timestamp, string Name)>();
                using (var command = _db.CreateCommand())
                {
                    command.CommandText = @"SELECT id, type, user_id, timestamp, IFNULL(user_name,'') FROM events
                        WHERE type IN ('first_meet','meet_again') AND user_id <> '' ORDER BY timestamp ASC";
                    using var reader = command.ExecuteReader();
                    while (reader.Read())
                        rows.Add((reader.GetString(0), reader.GetString(1), reader.GetString(2), reader.GetString(3), reader.GetString(4)));
                }

                var first = new Dictionary<string, string>();
                var again = new Dictionary<string, long>();
                var names = new Dictionary<string, string>();
                var years = new Dictionary<(string User, int Year), long>();
                var demoted = new List<string>();
                foreach (var row in rows)
                {
                    if (row.Name.Length > 0) names[row.User] = row.Name;
                    if (row.Type == "first_meet" && !first.ContainsKey(row.User))
                        first[row.User] = row.Timestamp;
                    else
                    {
                        if (row.Type == "first_meet") demoted.Add(row.Id);
                        again[row.User] = again.GetValueOrDefault(row.User) + 1;
                    }
                    var at = Helpers.DateTimeHelper.TryParseUtc(row.Timestamp, out var parsed) ? parsed : DateTime.UtcNow;
                    var key = (row.User, at.ToLocalTime().Year);
                    years[key] = years.GetValueOrDefault(key) + 1;
                }

                using var transaction = _db.BeginTransaction();
                using (var command = _db.CreateCommand())
                {
                    command.Transaction = transaction;
                    command.CommandText = "UPDATE events SET type = 'meet_again' WHERE id = $id";
                    var id = command.Parameters.Add("$id", SqliteType.Text);
                    foreach (var value in demoted)
                    {
                        id.Value = value;
                        command.ExecuteNonQuery();
                    }
                }
                using (var command = _db.CreateCommand())
                {
                    command.Transaction = transaction;
                    command.CommandText = @"INSERT INTO user_tracking (user_id, total_seconds, last_seen, last_seen_location, display_name, image, first_meet_date, meet_again_count)
                        VALUES ($u, 0, '', '', $n, '', $f, $a)
                        ON CONFLICT(user_id) DO UPDATE SET
                            first_meet_date = CASE WHEN first_meet_date = '' OR excluded.first_meet_date < first_meet_date THEN excluded.first_meet_date ELSE first_meet_date END,
                            meet_again_count = MAX(meet_again_count, excluded.meet_again_count),
                            display_name = CASE WHEN display_name = '' THEN excluded.display_name ELSE display_name END";
                    var user = command.Parameters.Add("$u", SqliteType.Text);
                    var name = command.Parameters.Add("$n", SqliteType.Text);
                    var date = command.Parameters.Add("$f", SqliteType.Text);
                    var count = command.Parameters.Add("$a", SqliteType.Integer);
                    foreach (var value in first.Keys.Union(again.Keys))
                    {
                        user.Value = value;
                        name.Value = names.GetValueOrDefault(value, "");
                        date.Value = first.GetValueOrDefault(value, "");
                        count.Value = again.GetValueOrDefault(value);
                        command.ExecuteNonQuery();
                    }
                }
                using (var command = _db.CreateCommand())
                {
                    command.Transaction = transaction;
                    command.CommandText = @"INSERT INTO user_year_tracking(user_id,year,total_seconds,meets) VALUES($u,$y,0,$m)
                        ON CONFLICT(user_id,year) DO UPDATE SET meets = MAX(meets, excluded.meets)";
                    var user = command.Parameters.Add("$u", SqliteType.Text);
                    var year = command.Parameters.Add("$y", SqliteType.Integer);
                    var meets = command.Parameters.Add("$m", SqliteType.Integer);
                    foreach (var (key, value) in years)
                    {
                        user.Value = key.User;
                        year.Value = key.Year;
                        meets.Value = value;
                        command.ExecuteNonQuery();
                    }
                }
                transaction.Commit();
            }
            catch (Exception ex) { CrashHandler.WriteEntry("ReconcileMeetsAfterImport", ex); }
        }
    }

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
