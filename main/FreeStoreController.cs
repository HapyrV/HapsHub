using Newtonsoft.Json.Linq;
using VRCNext.Services;

namespace VRCNext;

// Free VRChat store items: finds the ones the user hasn't claimed and claims them on request.
public static class FreeStoreController
{
    private static readonly SemaphoreSlim _gate = new(1, 1);

    // auto: the check after sign-in. It only answers when the popup is on and there are items the
    // user hasn't been shown yet. A manual check (menu) always answers with every unclaimed item.
    public static async Task CheckAsync(CoreLibrary core, bool auto)
    {
        if (auto && !core.Settings.ShowFreeStoreItems) return;
        await _gate.WaitAsync();
        try
        {
            var userId = core.VrcApi.CurrentUserId ?? "";
            var items = await core.Economy.GetFreeStoreListingsAsync();
            if (items == null)
            {
                if (!auto) core.SendToJS("vrcFreeStoreItems", new { ok = false, auto, items = new JArray(), dontShow = !core.Settings.ShowFreeStoreItems });
                return;
            }

            var ids = items.Select(i => i["id"]?.ToString() ?? "").Where(s => s.Length > 0).ToList();
            if (!core.Settings.FreeStoreSeenListings.TryGetValue(userId, out var seen))
                seen = new List<string>();
            var hasNew = ids.Any(id => !seen.Contains(id));
            if (hasNew && userId.Length > 0)
            {
                // Keep only ids that are still free and unclaimed, so the list can't grow forever.
                core.Settings.FreeStoreSeenListings[userId] = seen.Where(ids.Contains).Union(ids).ToList();
                core.Settings.Save();
            }
            if (auto && !hasNew) return;

            core.SendToJS("vrcFreeStoreItems", new { ok = true, auto, items, dontShow = !core.Settings.ShowFreeStoreItems });
        }
        catch (Exception ex) { core.VrcApi.Log($"FreeStore check exception: {ex.Message}"); }
        finally { _gate.Release(); }
    }

    public static async Task ClaimAsync(CoreLibrary core, List<string> listingIds)
    {
        var claimed = new List<string>();
        var failed = new JArray();
        foreach (var id in listingIds.Distinct())
        {
            var (ok, error) = await core.Economy.ClaimFreeListingAsync(id);
            if (ok) claimed.Add(id);
            else failed.Add(new JObject { ["id"] = id, ["error"] = error });
        }
        core.SendToJS("vrcFreeStoreClaimResult", new { claimed, failed });
    }

    public static void SetDontShow(CoreLibrary core, bool dontShow)
    {
        if (core.Settings.ShowFreeStoreItems == !dontShow) return;
        core.Settings.ShowFreeStoreItems = !dontShow;
        core.Settings.Save();
    }
}
