using Newtonsoft.Json.Linq;

namespace VRCNext.Services;

/// <summary>Read-only lists about your own account for the History page. It only ever sends GET requests.</summary>
public class HubAccountAPI(VRChatApiService ctx)
{
    private const int PageSize = 50;

    public sealed record AccountList(string Error, bool More, JArray Items);

    public async Task<AccountList> GetPurchasesAsync(int offset)
    {
        if (!ctx.IsLoggedIn) return new AccountList("Sign in to see your purchases.", false, new JArray());
        var url = $"{VRChatApiService.BASE}/economy/purchases?buyerId={Uri.EscapeDataString(ctx.CurrentUserId ?? "")}&order=desc&sort=purchaseDate&n={PageSize}&offset={offset}";
        var (error, body) = await GetAsync(url, "Your purchases");
        if (error.Length > 0) return new AccountList(error, false, new JArray());
        var items = JToken.Parse(body) as JArray ?? new JArray();
        return new AccountList("", items.Count >= PageSize, Pick(items,
            "purchaseId", "listingDisplayName", "listingSubtitle", "listingType", "sellerDisplayName",
            "purchaseDate", "purchaseEndDate", "purchasePrice", "isGift", "purchaseActive"));
    }

    public async Task<AccountList> GetModerationReportsAsync(int offset)
    {
        if (!ctx.IsLoggedIn) return new AccountList("Sign in to see your moderation reports.", false, new JArray());
        var url = $"{VRChatApiService.BASE}/moderationReports?reportingUserId={Uri.EscapeDataString(ctx.CurrentUserId ?? "")}&n={PageSize}&offset={offset}";
        var (error, body) = await GetAsync(url, "Your moderation reports");
        if (error.Length > 0) return new AccountList(error, false, new JArray());
        var parsed = JToken.Parse(body) as JObject;
        var items = parsed?["results"] as JArray ?? new JArray();
        return new AccountList("", parsed?["hasNext"]?.Value<bool>() == true, Pick(items,
            "id", "type", "contentId", "contentName", "category", "reason", "description", "created"));
    }

    private async Task<(string Error, string Body)> GetAsync(string url, string what)
    {
        var response = await ctx._http.GetAsync(url);
        var body = await response.Content.ReadAsStringAsync();
        if (response.IsSuccessStatusCode) return ("", body);
        ctx.Log($"{what} failed: {(int)response.StatusCode}");
        return ($"{what} couldn't be loaded (VRChat answered {(int)response.StatusCode}).", "");
    }

    // Only what the page shows goes to it.
    private static JArray Pick(JArray items, params string[] fields)
    {
        var result = new JArray();
        foreach (var item in items.OfType<JObject>())
        {
            var row = new JObject();
            foreach (var field in fields)
                if (item[field] != null) row[field] = item[field];
            result.Add(row);
        }
        return result;
    }
}
