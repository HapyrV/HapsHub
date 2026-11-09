using System.Text;
using HapsHub.Core;
using Newtonsoft.Json.Linq;

namespace VRCNext.Services;

/// <summary>Groups you have blocked, and the single calls a ban import is made of.</summary>
public class HubGroupAPI(VRChatApiService ctx)
{
    /// <summary>Null when the list couldn't be read, so "couldn't load" never looks like "none blocked".</summary>
    public async Task<JArray?> GetBlockedGroupsAsync()
    {
        if (!ctx.IsLoggedIn || string.IsNullOrEmpty(ctx.CurrentUserId)) return null;
        var url = $"{VRChatApiService.BASE}/users/{Uri.EscapeDataString(ctx.CurrentUserId)}/groups/userblocked";
        HttpResponseMessage response;
        try
        {
            response = await ctx._http.GetAsync(url);
        }
        catch (HttpRequestException ex)
        {
            // VRChat sometimes closes an idle connection just as it's reused. A read is safe to try again.
            ctx.Log($"GetBlockedGroups retrying: {ex.Message}");
            response = await ctx._http.GetAsync(url);
        }
        ctx.Log($"GetBlockedGroups: {(int)response.StatusCode}");
        if (!response.IsSuccessStatusCode) return null;
        return JToken.Parse(await response.Content.ReadAsStringAsync()) as JArray;
    }

    public async Task<bool> BlockGroupAsync(string groupId)
    {
        if (!ctx.IsLoggedIn) return false;
        var response = await ctx._http.PostAsync($"{VRChatApiService.BASE}/groups/{Uri.EscapeDataString(groupId)}/block",
            new StringContent("{}", Encoding.UTF8, "application/json"));
        ctx.Log($"BlockGroup({groupId}): {(int)response.StatusCode}");
        return response.IsSuccessStatusCode;
    }

    /// <summary>VRChat has no unblock call: removing yourself from the group's members is how it's done.</summary>
    public async Task<bool> UnblockGroupAsync(string groupId)
    {
        if (!ctx.IsLoggedIn || string.IsNullOrEmpty(ctx.CurrentUserId)) return false;
        var response = await ctx._http.DeleteAsync(
            $"{VRChatApiService.BASE}/groups/{Uri.EscapeDataString(groupId)}/members/{Uri.EscapeDataString(ctx.CurrentUserId)}");
        ctx.Log($"UnblockGroup({groupId}): {(int)response.StatusCode}");
        return response.IsSuccessStatusCode;
    }

    public async Task<BanOutcome> BanAsync(string groupId, string userId, CancellationToken cancellationToken)
    {
        if (!ctx.IsLoggedIn) return BanOutcome.SignedOut;
        var body = new JObject { ["userId"] = userId }.ToString(Newtonsoft.Json.Formatting.None);
        var response = await ctx._http.PostAsync($"{VRChatApiService.BASE}/groups/{Uri.EscapeDataString(groupId)}/bans",
            new StringContent(body, Encoding.UTF8, "application/json"), cancellationToken);
        return Outcome("Ban", groupId, userId, (int)response.StatusCode);
    }

    public async Task<BanOutcome> UnbanAsync(string groupId, string userId, CancellationToken cancellationToken)
    {
        if (!ctx.IsLoggedIn) return BanOutcome.SignedOut;
        var response = await ctx._http.DeleteAsync(
            $"{VRChatApiService.BASE}/groups/{Uri.EscapeDataString(groupId)}/bans/{Uri.EscapeDataString(userId)}", cancellationToken);
        return Outcome("Unban", groupId, userId, (int)response.StatusCode);
    }

    /// <summary>A person's display name for the preview. Empty when they can't be looked up; False when VRChat says to slow down.</summary>
    public async Task<(string Name, bool KeepGoing)> GetNameAsync(string userId)
    {
        if (!ctx.IsLoggedIn) return ("", false);
        try
        {
            var response = await ctx._http.GetAsync($"{VRChatApiService.BASE}/users/{Uri.EscapeDataString(userId)}");
            if ((int)response.StatusCode == 429) return ("", false);
            if (!response.IsSuccessStatusCode) return ("", true);
            var user = JToken.Parse(await response.Content.ReadAsStringAsync()) as JObject;
            return (user?["displayName"]?.ToString() ?? "", true);
        }
        catch (HttpRequestException ex)
        {
            // A name is only a help for the preview, so a dropped connection doesn't fail it.
            ctx.Log($"Name lookup for {userId} failed: {ex.Message}");
            return ("", true);
        }
    }

    private BanOutcome Outcome(string what, string groupId, string userId, int status)
    {
        ctx.Log($"{what}Import({groupId}/{userId}): {status}");
        if (status == 429) return BanOutcome.RateLimited;
        if (status == 401) return BanOutcome.SignedOut;
        return status is >= 200 and < 300 ? BanOutcome.Done : BanOutcome.Failed;
    }
}
