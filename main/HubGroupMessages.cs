using HapsHub.Core;
using Newtonsoft.Json.Linq;
using VRCNext.Services;
using VRCNext.Services.Helpers;

namespace VRCNext;

// Blocked groups, and importing a list of bans into a group you moderate.
public partial class AppShell
{
    private static readonly TimeSpan BanPause = TimeSpan.FromSeconds(1.5);
    private static readonly TimeSpan NameLookupPause = TimeSpan.FromMilliseconds(300);
    private const int NameLookupLimit = 100;

    private readonly object _banLock = new();
    private (string GroupId, IReadOnlyList<string> Ids)? _banPreview;
    private (string GroupId, IReadOnlyList<string> Ids)? _banLastDone;
    private CancellationTokenSource? _banRun;

    private bool HandleGroupMessage(string action, JObject msg)
    {
        var groupId = msg["groupId"]?.ToString() ?? "";
        switch (action)
        {
            case "hubBlockedGroups":
                _ = Task.Run(SendBlockedGroups);
                return true;

            case "hubBlockGroup":
                if (groupId.Length > 0) _ = Task.Run(() => SetGroupBlocked(groupId, true));
                return true;

            case "hubUnblockGroup":
                if (groupId.Length > 0) _ = Task.Run(() => SetGroupBlocked(groupId, false));
                return true;

            case "hubGroupBanPreview":
                var text = msg["text"]?.ToString() ?? "";
                if (groupId.Length > 0) _ = Task.Run(() => SendBanPreview(groupId, text));
                return true;

            case "hubGroupBanRun":
                // Only what the preview showed can be run, and only once.
                (string GroupId, IReadOnlyList<string> Ids)? planned;
                lock (_banLock) { planned = _banPreview; _banPreview = null; }
                if (planned?.GroupId == groupId) StartBanRun(groupId, planned.Value.Ids, undo: false);
                return true;

            case "hubGroupBanUndo":
                (string GroupId, IReadOnlyList<string> Ids)? last;
                lock (_banLock) { last = _banLastDone; _banLastDone = null; }
                if (last?.GroupId == groupId) StartBanRun(groupId, last.Value.Ids, undo: true);
                return true;

            case "hubGroupBanCancel":
                lock (_banLock) _banRun?.Cancel();
                return true;
        }
        return false;
    }

    private async Task SendBlockedGroups()
    {
        try
        {
            var groups = await new HubGroupAPI(_vrcApi).GetBlockedGroupsAsync();
            SendToJS("hubBlockedGroups", new
            {
                ok = groups != null,
                groups = (groups ?? new JArray()).Select(g =>
                {
                    var id = g["groupId"]?.ToString() ?? g["id"]?.ToString() ?? "";
                    return new
                    {
                        id,
                        name = g["name"]?.ToString() ?? "",
                        shortCode = g["shortCode"]?.ToString() ?? "",
                        discriminator = g["discriminator"]?.ToString() ?? "",
                        memberCount = g["memberCount"]?.Value<int>() ?? 0,
                        iconUrl = ImageCacheHelper.GetGroupUrl(id, g["iconUrl"]?.ToString()),
                    };
                }).ToList(),
            });
        }
        catch (HttpRequestException ex)
        {
            _vrcApi.Log($"Blocked groups could not be read: {ex.Message}");
            SendToJS("hubBlockedGroups", new { ok = false, groups = Array.Empty<object>() });
        }
        catch (Exception ex)
        {
            CrashHandler.WriteEntry("SendBlockedGroups", ex);
            SendToJS("hubBlockedGroups", new { ok = false, groups = Array.Empty<object>() });
        }
    }

    private async Task SetGroupBlocked(string groupId, bool blocked)
    {
        var success = false;
        try
        {
            var api = new HubGroupAPI(_vrcApi);
            success = blocked ? await api.BlockGroupAsync(groupId) : await api.UnblockGroupAsync(groupId);
        }
        catch (HttpRequestException ex)
        {
            _vrcApi.Log($"Group block change failed: {ex.Message}");
        }
        catch (Exception ex)
        {
            CrashHandler.WriteEntry("SetGroupBlocked", ex);
        }
        SendToJS("hubGroupBlocked", new { groupId, blocked, success });
    }

    private async Task SendBanPreview(string groupId, string text)
    {
        try
        {
            var ids = GroupBanImport.Parse(text);
            var bans = ids.Count > 0 ? await _core.Groups.GetGroupBansAsync(groupId) : new JArray();
            var plan = GroupBanImport.Plan(ids, bans.Select(b => b["userId"]?.ToString() ?? ""), _vrcApi.CurrentUserId);

            var api = new HubGroupAPI(_vrcApi);
            var people = new List<object>();
            var lookups = 0;
            var keepLooking = true;
            foreach (var id in plan.ToBan)
            {
                var name = _friends.TryGetNameImage(id, out var known) ? known.name : "";
                if (name.Length == 0 && keepLooking && lookups < NameLookupLimit)
                {
                    if (lookups++ > 0) await Task.Delay(NameLookupPause);
                    (name, keepLooking) = await api.GetNameAsync(id);
                }
                people.Add(new { id, name });
            }

            lock (_banLock) _banPreview = (groupId, plan.ToBan);
            SendToJS("hubGroupBanPreview", new
            {
                groupId,
                ok = true,
                found = ids.Count,
                people,
                alreadyBanned = plan.AlreadyBanned,
                skippedSelf = plan.SkippedSelf,
                overLimit = plan.OverLimit,
            });
        }
        catch (Exception ex)
        {
            CrashHandler.WriteEntry("SendBanPreview", ex);
            SendToJS("hubGroupBanPreview", new { groupId, ok = false });
        }
    }

    private void StartBanRun(string groupId, IReadOnlyList<string> ids, bool undo)
    {
        CancellationTokenSource cancel;
        lock (_banLock)
        {
            if (_banRun != null) return;
            cancel = new CancellationTokenSource();
            _banRun = cancel;
        }
        _ = Task.Run(async () =>
        {
            BanRunResult? result = null;
            try
            {
                var api = new HubGroupAPI(_vrcApi);
                result = await GroupBanImport.RunAsync(ids,
                    (id, token) => undo ? api.UnbanAsync(groupId, id, token) : api.BanAsync(groupId, id, token),
                    BanPause,
                    (done, total) => SendToJS("hubGroupBanProgress", new { groupId, undo, done, total }),
                    cancel.Token);
                _vrcApi.Log($"[GROUPS] {(undo ? "Ban undo" : "Ban import")} on {groupId}: {result.Done.Count} done, {result.Failed.Count} failed, {result.NotTried} not tried{(result.StoppedBecause.Length > 0 ? $", stopped: {result.StoppedBecause}" : "")}");
                if (!undo) lock (_banLock) _banLastDone = (groupId, result.Done);
            }
            catch (Exception ex)
            {
                CrashHandler.WriteEntry("BanRun", ex);
            }
            finally
            {
                lock (_banLock) _banRun = null;
                cancel.Dispose();
            }
            SendToJS("hubGroupBanDone", new
            {
                groupId,
                undo,
                ok = result != null,
                done = result?.Done.Count ?? 0,
                failed = result?.Failed ?? Array.Empty<string>(),
                notTried = result?.NotTried ?? ids.Count,
                stopped = result?.StoppedBecause ?? "",
            });
        });
    }
}
