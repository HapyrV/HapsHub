using HapsHub.Core;
using Newtonsoft.Json.Linq;

namespace VRCNext;

// Media Library's Eagle source: folders and pictures read from Eagle's local API (see Hub/EagleLibrary.cs).
// The pictures themselves come through this app's own server at /eagle?id=..., which only serves files from inside
// the Eagle library.
public partial class AppShell
{
    private bool HandleEagleMessage(string action, JObject msg)
    {
        switch (action)
        {
            case "eagleFolders":
                _ = Task.Run(async () =>
                {
                    var folders = HubModules.Plugins.IsOn("eagle") ? await EagleLibrary.FoldersAsync() : null;
                    SendToJS("eagleFolders", new { running = folders != null, folders = folders ?? new JArray() });
                });
                return true;

            case "eagleItems":
                var folder = msg["folder"]?.ToString();
                var page = msg["page"]?.Value<int?>() ?? 0;
                _ = Task.Run(async () =>
                {
                    var (items, more) = HubModules.Plugins.IsOn("eagle") ? await EagleLibrary.ItemsAsync(folder, page) : (null, false);
                    if (items != null)
                        foreach (var item in items.OfType<JObject>())
                        {
                            var url = $"http://localhost:{_httpPort}/eagle?id={item["id"]}";
                            item["thumb"] = url + "&thumb=1";
                            item["url"] = url;
                        }
                    SendToJS("eagleItems", new { running = items != null, folder = folder ?? "", page, more, items = items ?? new JArray() });
                });
                return true;
        }
        return false;
    }

    private async Task ServeEagleAsync(System.Net.HttpListenerContext ctx, bool thumbnail)
    {
        var id = (ctx.Request.Url?.Query ?? "").TrimStart('?').Split('&')
            .Select(p => p.Split('=', 2))
            .Where(p => p.Length == 2 && p[0] == "id")
            .Select(p => p[1])
            .FirstOrDefault() ?? "";
        var file = HubModules.Plugins.IsOn("eagle") ? await EagleLibrary.FileAsync(id, thumbnail) : null;
        if (file == null) ctx.Response.StatusCode = 404;
        else await ServeFileAsync(ctx, file, "private, max-age=3600");
    }
}
