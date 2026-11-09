using HapsHub.Core;
using Newtonsoft.Json.Linq;
using VRCNext.Services;

namespace VRCNext;

// The History page's data, and the recording that feeds it.
public partial class AppShell
{
    private const int HistoryPageSize = 100;
    private bool _historyHooked;

    /// <summary>Called once at start-up, after the Hub modules are running.</summary>
    private void HookHistoryRecording()
    {
        if (_historyHooked) return;
        _historyHooked = true;
        _logWatcher.PortalSpawned += () =>
        {
            RecordPortal("spawn");
            HubModules.OverlayEvents.Raise(OverlayEventsModule.PortalSpawn, "Portal", "A portal opened in your instance");
        };
        _logWatcher.PortalUsed += () => RecordPortal("used");
        HubModules.History.FriendChanged += (userId, name, kind, oldValue, newValue) =>
        {
            if (kind == "DisplayName") HubModules.OverlayEvents.Raise(OverlayEventsModule.NameChange, name, $"Was {oldValue}", "", userId);
            else HubModules.OverlayEvents.Raise(OverlayEventsModule.TrustChange, name, $"{oldValue} to {newValue}", "", userId);
        };
        HubModules.OverlayEvents.Show += ShowOverlayEvent;
    }

    private void ShowOverlayEvent(string title, string text, string image, string friendId)
    {
        try
        {
            // The overlay's Action Flow type is its one general notice: it's always allowed when notifications are on.
            var time = DateTime.Now.ToString("HH:mm");
            _core.VrOverlay?.AddNotification("notif_actionflow", title, text, time, image, friendId, "");
            _core.VrOverlay?.EnqueueToast("notif_actionflow", title, text, time, image, false, friendId);
        }
        catch (Exception ex)
        {
            CrashHandler.WriteEntry("ShowOverlayEvent", ex);
        }
    }

    // Adds what a screenshot's file knows about itself to the library, for pictures HapsHub didn't see being taken.
    private void SendPhotoMetadata(string path)
    {
        try
        {
            var fileName = Path.GetFileName(path);
            if (!path.EndsWith(".png", StringComparison.OrdinalIgnoreCase) || !File.Exists(path) || _core.PhotoPlayersStore.GetPhotoRecord(fileName) != null)
            {
                SendToJS("hubPhotoMetadata", new { path, found = false });
                return;
            }
            var metadata = PngMetadata.Read(path);
            if (metadata == null)
            {
                SendToJS("hubPhotoMetadata", new { path, found = false });
                return;
            }
            var people = metadata.Players.Where(p => p.Id.Length > 0).Select(p => (p.Id, p.Name, "")).ToList();
            if (people.Count > 0 || metadata.WorldId.Length > 0)
            {
                _core.PhotoPlayersStore.RecordPhoto(fileName, people, metadata.WorldId);
                _core.PhotoPlayersStore.Save();
            }
            SendToJS("hubPhotoMetadata", new
            {
                path, found = true, worldId = metadata.WorldId,
                players = people.Select(p => new { userId = p.Item1, displayName = p.Item2, image = "" }),
            });
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            SendToJS("hubPhotoMetadata", new { path, found = false });
        }
    }

    /// <summary>Called once a new screenshot's people are known. The game may still hold the file, so it waits and retries.</summary>
    internal void WritePhotoMetadata(string path, PhotoMetadata metadata)
    {
        if (!HubModules.PhotoMetadata.WriteEnabled || !path.EndsWith(".png", StringComparison.OrdinalIgnoreCase)) return;
        _ = Task.Run(async () =>
        {
            for (var attempt = 0; attempt < 4; attempt++)
            {
                await Task.Delay(TimeSpan.FromSeconds(2 + attempt * 2));
                try
                {
                    PngMetadata.Write(path, metadata);
                    return;
                }
                catch (IOException) { /* Still in use. */ }
                catch (UnauthorizedAccessException) { return; }
            }
        });
    }

    private void RecordPortal(string kind)
    {
        try
        {
            var location = _logWatcher.CurrentLocation ?? "";
            HubModules.History.AddPortal(kind, location, _core.Timeline.ReadHubWorldName(_logWatcher.CurrentWorldId ?? ""));
        }
        catch (Exception ex)
        {
            CrashHandler.WriteEntry("RecordPortal", ex);
        }
    }

    private bool HandleHistoryMessage(string action, JObject msg)
    {
        switch (action)
        {
            case "hubHistoryRead":
                var view = msg["view"]?.ToString() ?? "";
                var search = msg["search"]?.ToString() ?? "";
                var offset = msg["offset"]?.Value<int>() ?? 0;
                var request = msg["request"]?.Value<int>() ?? 0;
                _ = Task.Run(() => SendHistory(view, search, offset, request));
                return true;

            case "hubHistoryInstances":
                var from = msg["from"]?.ToString() ?? "";
                var to = msg["to"]?.ToString() ?? "";
                var day = msg["day"]?.ToString() ?? "";
                _ = Task.Run(() => SendInstanceVisits(from, to, day));
                return true;

            case "hubPhotoMetadata":
                var photoPath = msg["path"]?.ToString() ?? "";
                _ = Task.Run(() => SendPhotoMetadata(photoPath));
                return true;

            case "hubHistoryAccount":
                var what = msg["view"]?.ToString() ?? "";
                var accountOffset = msg["offset"]?.Value<int>() ?? 0;
                _ = Task.Run(() => SendAccountHistory(what, accountOffset));
                return true;
        }
        return false;
    }

    private void SendHistory(string view, string search, int offset, int request)
    {
        try
        {
            var rows = new List<HubHistoryRow>();
            switch (view)
            {
                case "names":
                    rows.AddRange(HubModules.History.ReadFriendChanges());
                    break;
                case "friends":
                    rows.AddRange(_core.Timeline.ReadHubFriendEvents("friend_added", "friend_removed").Select(e =>
                        new HubHistoryRow(e.At, e.Type == "friend_added" ? "Friend" : "Unfriend", e.Name, e.UserId, "", "", "", "", "HapsHub")));
                    break;
                case "notifications":
                    rows.AddRange(_core.Timeline.ReadHubEvents("notification").Select(e =>
                        new HubHistoryRow(e.At, e.NotifType, e.SenderName, e.SenderId, "", e.WorldName,
                            e.Title.Length > 0 && e.Title != e.Message ? $"{e.Title}: {e.Message}" : e.Message, "", "HapsHub", e.NotifId)));
                    break;
                case "videos":
                    rows.AddRange(_core.Timeline.ReadHubEvents("video_url").Select(e =>
                        new HubHistoryRow(e.At, "video", "", "", "", e.WorldName, "", e.Message, "HapsHub", HubHistoryViews.VideoKey(e.Message, e.At))));
                    break;
                case "avatars":
                    rows.AddRange(_core.Timeline.ReadHubEvents("avatar_switch").Select(e =>
                        new HubHistoryRow(e.At, "avatar", "", "", "", "", e.UserName, e.UserId, "HapsHub")));
                    break;
                case "friendavatars":
                    rows.AddRange(_core.Timeline.ReadHubFriendEvents("friend_avatar").Select(e =>
                        new HubHistoryRow(e.At, "avatar", e.Name, e.UserId, "", "", e.NewValue, "", "HapsHub")));
                    break;
                case "portals":
                    rows.AddRange(HubModules.History.ReadPortals());
                    break;
            }

            var archived = HubHistoryViews.FromArchive(HubModules.VrcxHistory, view);
            if (view == "avatars")
            {
                var names = _core.Timeline.ReadHubAvatarNames();
                archived = archived.Select(r => r with { Text = names.GetValueOrDefault(r.Link, "") }).ToList();
            }
            rows.AddRange(archived);

            var page = HubHistoryViews.Page(rows, search, offset, HistoryPageSize);
            SendToJS("hubHistory", new
            {
                view, search, request, offset = page.Offset, total = page.Total, pageSize = HistoryPageSize,
                rows = page.Rows.Select(r => new
                {
                    at = r.At, kind = r.Kind, name = r.Name, userId = r.UserId, oldValue = r.Old, newValue = r.New,
                    text = r.Text, link = r.Link, source = r.Source,
                }),
            });
        }
        catch (Exception ex)
        {
            CrashHandler.WriteEntry("SendHistory", ex);
            SendToJS("hubHistory", new { view, search, request, offset, error = "This history couldn't be read." });
        }
    }

    private void SendInstanceVisits(string from, string to, string day)
    {
        try
        {
            var visits = _core.Timeline.ReadHubInstanceVisits(from, to);
            SendToJS("hubHistoryInstances", new
            {
                day,
                visits = visits.Select(v => new
                {
                    id = v.Id, at = v.At, leftAt = v.LeftAt, worldId = v.WorldId, worldName = v.WorldName,
                    location = v.Location, players = v.Players,
                }),
            });
        }
        catch (Exception ex)
        {
            CrashHandler.WriteEntry("SendInstanceVisits", ex);
            SendToJS("hubHistoryInstances", new { day, error = "Your visits couldn't be read." });
        }
    }

    private async Task SendAccountHistory(string view, int offset)
    {
        try
        {
            var account = new HubAccountAPI(_vrcApi);
            var result = view == "moderation"
                ? await account.GetModerationReportsAsync(offset)
                : await account.GetPurchasesAsync(offset);
            SendToJS("hubHistoryAccount", new { view, offset, error = result.Error, more = result.More, items = result.Items });
        }
        catch (Exception ex)
        {
            CrashHandler.WriteEntry("SendAccountHistory", ex);
            SendToJS("hubHistoryAccount", new { view, offset, error = "This list couldn't be read.", more = false, items = new JArray() });
        }
    }
}
