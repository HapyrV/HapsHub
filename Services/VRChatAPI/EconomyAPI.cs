using Newtonsoft.Json.Linq;

namespace VRCNext.Services;

public class EconomyAPI(VRChatApiService ctx)
{
    public async Task<int> GetBalanceAsync()
    {
        if (!ctx.IsLoggedIn) return -1;
        try
        {
            var resp = await ctx._http.GetAsync($"{VRChatApiService.BASE}/user/{ctx.CurrentUserId}/balance");
            if (resp.IsSuccessStatusCode)
            {
                var obj = JObject.Parse(await resp.Content.ReadAsStringAsync());
                return obj["balance"]?.Value<int>() ?? obj["varBalance"]?.Value<int>() ?? -1;
            }
            ctx.Log($"GetBalance failed: {(int)resp.StatusCode} — {await resp.Content.ReadAsStringAsync()}");
        }
        catch (Exception ex) { ctx.Log($"GetBalance exception: {ex.Message}"); }
        return -1;
    }

    public async Task<JArray?> GetPurchasesAsync()
    {
        if (!ctx.IsLoggedIn || string.IsNullOrEmpty(ctx.CurrentUserId)) return null;
        const int pageSize = 50;
        const int maxRows = 2000;
        var purchases = new JArray();
        try
        {
            for (var offset = 0; offset < maxRows; offset += pageSize)
            {
                var resp = await ctx._http.GetAsync($"{VRChatApiService.BASE}/economy/purchases?buyerId={ctx.CurrentUserId}&n={pageSize}&offset={offset}&sort=purchaseDate&order=desc");
                var body = await resp.Content.ReadAsStringAsync();
                if (!resp.IsSuccessStatusCode)
                {
                    ctx.Log($"GetPurchases {(int)resp.StatusCode}: {body[..Math.Min(200, body.Length)]}");
                    return offset == 0 ? null : purchases;
                }
                var page = JArray.Parse(body);
                foreach (var row in page.OfType<JObject>())
                {
                    if (row["buyerId"]?.ToString() != ctx.CurrentUserId) continue;
                    var imageId = row["listingImageId"]?.ToString();
                    row["imageUrl"] = string.IsNullOrEmpty(imageId) ? "" : $"{VRChatApiService.BASE}/image/{imageId}/1/128";
                    purchases.Add(row);
                }
                if (page.Count < pageSize) break;
            }
            return purchases;
        }
        catch (Exception ex) { ctx.Log($"GetPurchases exception: {ex.Message}"); }
        return null;
    }

    public async Task<JArray?> GetCreditTransactionsAsync()
    {
        if (!ctx.IsLoggedIn || string.IsNullOrEmpty(ctx.CurrentUserId)) return null;
        try
        {
            var resp = await ctx._http.GetAsync($"{VRChatApiService.BASE}/user/{ctx.CurrentUserId}/economy/transactions?n=100");
            var body = await resp.Content.ReadAsStringAsync();
            if (!resp.IsSuccessStatusCode)
            {
                ctx.Log($"GetCreditTransactions {(int)resp.StatusCode}: {body[..Math.Min(200, body.Length)]}");
                return null;
            }
            var token = JToken.Parse(body);
            if (token is JObject obj) return obj["transactions"] as JArray ?? new JArray();
            return token as JArray ?? new JArray();
        }
        catch (Exception ex) { ctx.Log($"GetCreditTransactions exception: {ex.Message}"); }
        return null;
    }

    public async Task<int> GetOnlineCountAsync()
    {
        try
        {
            var resp = await ctx._http.GetAsync($"{VRChatApiService.BASE}/visits");
            var body = await resp.Content.ReadAsStringAsync();
            if (resp.IsSuccessStatusCode && int.TryParse(body.Trim(), out var count))
                return count;
        }
        catch (Exception ex) { ctx.Log($"GetOnlineCount exception: {ex.Message}"); }
        return 0;
    }

    // The official VRChat store ids; their shelves hold the store's free items.
    private static readonly string[] VrchatStoreIds =
    {
        "esto_00000000-0000-0000-0000-000000000000",
        "esto_00000000-0000-0000-0000-000000000001",
        "esto_00000000-0000-0000-0000-000000000002",
    };

    // Free, active VRChat store listings the signed-in user doesn't own yet.
    // Null when the purchases or every store could not be read.
    public async Task<JArray?> GetFreeStoreListingsAsync()
    {
        if (!ctx.IsLoggedIn || string.IsNullOrEmpty(ctx.CurrentUserId)) return null;
        var purchases = await GetPurchasesAsync();
        if (purchases == null) return null;

        var ownedListings = new HashSet<string>();
        var ownedProducts = new HashSet<string>();
        foreach (var p in purchases.OfType<JObject>())
        {
            if (p["purchaseActive"]?.Type != JTokenType.Boolean || !p["purchaseActive"]!.Value<bool>()) continue;
            var lid = p["listingId"]?.ToString();
            if (!string.IsNullOrEmpty(lid)) ownedListings.Add(lid);
            foreach (var prod in (p["products"] as JArray ?? new JArray()).OfType<JObject>())
            {
                var pid = prod["id"]?.ToString();
                if (!string.IsNullOrEmpty(pid)) ownedProducts.Add(pid);
            }
        }

        var free = new Dictionary<string, JObject>();
        var storesRead = 0;
        foreach (var storeId in VrchatStoreIds)
        {
            try
            {
                var resp = await ctx._http.GetAsync($"{VRChatApiService.BASE}/economy/store/shelves?storeId={storeId}&fetch=public&hydrateListings=true");
                var body = await resp.Content.ReadAsStringAsync();
                if (!resp.IsSuccessStatusCode)
                {
                    ctx.Log($"GetStoreShelves {storeId} {(int)resp.StatusCode}: {body[..Math.Min(200, body.Length)]}");
                    continue;
                }
                storesRead++;
                foreach (var shelf in JArray.Parse(body).OfType<JObject>())
                foreach (var listing in (shelf["listings"] as JArray ?? new JArray()).OfType<JObject>())
                {
                    var id = listing["id"]?.ToString();
                    if (string.IsNullOrEmpty(id) || free.ContainsKey(id)) continue;
                    if (listing["active"]?.Type != JTokenType.Boolean || !listing["active"]!.Value<bool>()) continue;
                    if (EffectiveListingPrice(listing) is int price && price != 0) continue;
                    if (ownedListings.Contains(id)) continue;
                    var productIds = ListingProductIds(listing);
                    if (productIds.Count > 0 && productIds.All(ownedProducts.Contains)) continue;
                    free[id] = listing;
                }
            }
            catch (Exception ex) { ctx.Log($"GetStoreShelves {storeId} exception: {ex.Message}"); }
        }
        if (storesRead == 0) return null;

        var result = new JArray();
        foreach (var listing in free.Values)
        {
            // A free bundle already covers its single items, so list only the bundle.
            var productIds = ListingProductIds(listing);
            var inBundle = productIds.Count > 0 && free.Values.Any(other =>
            {
                if (ReferenceEquals(other, listing)) return false;
                var otherIds = ListingProductIds(other);
                return otherIds.Count > productIds.Count && productIds.All(otherIds.Contains);
            });
            if (inBundle) continue;

            var imageUrl = listing["imageUrl"]?.ToString();
            var imageId = listing["imageId"]?.ToString();
            if (string.IsNullOrEmpty(imageUrl) && !string.IsNullOrEmpty(imageId))
                imageUrl = $"{VRChatApiService.BASE}/image/{imageId}/1/128";
            result.Add(new JObject
            {
                ["id"]          = listing["id"]?.ToString() ?? "",
                ["displayName"] = listing["displayName"]?.ToString() ?? "",
                ["subtitle"]    = listing["subtitle"]?.ToString() ?? "",
                ["listingType"] = listing["listingType"]?.ToString() ?? "",
                ["imageUrl"]    = imageUrl ?? "",
            });
        }
        return result;
    }

    // VRC+ members pay the discount price when a listing has one.
    private int? EffectiveListingPrice(JObject listing)
    {
        var token = ctx.HasVrcPlus && listing["vrcPlusDiscountPrice"] is { Type: not JTokenType.Null } discount
            ? discount
            : listing["priceTokens"];
        if (token == null || token.Type == JTokenType.Null) return null;
        return token.Type is JTokenType.Integer or JTokenType.Float ? token.Value<int>() : int.TryParse(token.ToString(), out var v) ? v : -1;
    }

    private static List<string> ListingProductIds(JObject listing) =>
        (listing["productIds"] as JArray ?? new JArray()).Select(t => t.ToString()).Where(s => s.Length > 0).ToList();

    // Claims a free store listing for the signed-in user (a purchase at 0 credits).
    public async Task<(bool ok, string error)> ClaimFreeListingAsync(string listingId)
    {
        if (!ctx.IsLoggedIn || string.IsNullOrEmpty(listingId)) return (false, "Not signed in");
        try
        {
            var json = new JObject { ["listingId"] = listingId, ["totalPrice"] = 0, ["quantity"] = 1 }
                .ToString(Newtonsoft.Json.Formatting.None);
            var content = new StringContent(json, System.Text.Encoding.UTF8, "application/json");
            var resp = await ctx._http.PostAsync($"{VRChatApiService.BASE}/economy/purchase/listing", content);
            var body = await resp.Content.ReadAsStringAsync();
            ctx.Log($"ClaimFreeListing {listingId}: {(int)resp.StatusCode}");
            if (resp.IsSuccessStatusCode) return (true, "");
            var error = body;
            try { error = JObject.Parse(body)["error"]?["message"]?.ToString() ?? body; } catch { }
            ctx.Log($"ClaimFreeListing {listingId} failed: {body[..Math.Min(200, body.Length)]}");
            return (false, error.Length > 200 ? error[..200] : error);
        }
        catch (Exception ex)
        {
            ctx.Log($"ClaimFreeListing exception: {ex.Message}");
            return (false, ex.Message);
        }
    }
}
