using Newtonsoft.Json.Linq;

namespace HapsHub.Core;

/// <summary>
/// Reads the Eagle picture organizer through its local API (http://localhost:41595), so Media Library can show
/// Eagle's folders and pictures without embedding Eagle's window. Only reads: nothing is ever changed in Eagle.
/// Folders with a password, and the pictures in them, are left out; so is Eagle's trash.
/// HAPSHUB_EAGLE_API points it at another address (the tests use a stand-in server).
/// </summary>
public static class EagleLibrary
{
    public const int PageSize = 100;

    private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(4) };
    private static string Api => (Environment.GetEnvironmentVariable("HAPSHUB_EAGLE_API") ?? "http://localhost:41595").TrimEnd('/') + "/api/";

    private static string? _libraryPath;
    private static HashSet<string> _locked = new(StringComparer.Ordinal);

    private static async Task<JToken?> GetAsync(string path)
    {
        try
        {
            var json = JObject.Parse(await Http.GetStringAsync(Api + path).ConfigureAwait(false));
            return json["status"]?.ToString() == "success" ? json["data"] : null;
        }
        catch { return null; } // Eagle closed, or not answering
    }

    /// <summary>Eagle's folders as a tree, or null when Eagle isn't running.</summary>
    public static async Task<JArray?> FoldersAsync()
    {
        var library = await GetAsync("library/info").ConfigureAwait(false);
        var folders = await GetAsync("folder/list").ConfigureAwait(false) as JArray;
        if (library == null || folders == null) return null;
        _libraryPath = library["library"]?["path"]?.ToString();
        var locked = new HashSet<string>(StringComparer.Ordinal);
        var tree = Shape(folders, locked);
        _locked = locked;
        return tree;
    }

    private static JArray Shape(JArray folders, HashSet<string> locked)
    {
        var shaped = new JArray();
        foreach (var folder in folders.OfType<JObject>())
        {
            var id = folder["id"]?.ToString() ?? "";
            if (!string.IsNullOrEmpty(folder["password"]?.ToString()))
            {
                MarkLocked(folder, locked);
                continue;
            }
            shaped.Add(new JObject
            {
                ["id"] = id,
                ["name"] = folder["name"]?.ToString() ?? "",
                ["children"] = folder["children"] is JArray children ? Shape(children, locked) : new JArray(),
            });
        }
        return shaped;
    }

    private static void MarkLocked(JObject folder, HashSet<string> locked)
    {
        locked.Add(folder["id"]?.ToString() ?? "");
        if (folder["children"] is JArray children)
            foreach (var child in children.OfType<JObject>()) MarkLocked(child, locked);
    }

    /// <summary>
    /// One page of pictures, newest first: all of them, or one folder's. Null when Eagle isn't running. "More" says
    /// whether Eagle has another page (pictures left out still count, so a short page doesn't end the list early).
    /// </summary>
    /// <summary>True when Eagle is installed in one of its usual places.</summary>
    public static bool Installed() =>
        new[] { @"%ProgramFiles%\Eagle\Eagle.exe", @"%LOCALAPPDATA%\Programs\Eagle\Eagle.exe" }
            .Any(p => File.Exists(Environment.ExpandEnvironmentVariables(p)));

    public static async Task<(JArray? Items, bool More)> ItemsAsync(string? folder, int page)
    {
        if (_libraryPath == null && await FoldersAsync().ConfigureAwait(false) == null) return (null, false);
        // Eagle's "offset" is a page number, not an item count.
        var query = $"item/list?limit={PageSize}&offset={Math.Max(0, page)}&orderBy=-CREATEDATE";
        if (IsId(folder)) query += "&folders=" + folder;
        if (await GetAsync(query).ConfigureAwait(false) is not JArray items) return (null, false);
        var shaped = new JArray();
        foreach (var item in items.OfType<JObject>())
        {
            var id = item["id"]?.ToString();
            if (!IsId(id) || item["isDeleted"]?.Value<bool>() == true) continue;
            if (item["folders"] is JArray inFolders && inFolders.Any(f => _locked.Contains(f.ToString()))) continue;
            shaped.Add(new JObject
            {
                ["id"] = id,
                ["name"] = item["name"]?.ToString() ?? "",
                ["ext"] = item["ext"]?.ToString() ?? "",
                ["width"] = item["width"]?.Value<int?>() ?? 0,
                ["height"] = item["height"]?.Value<int?>() ?? 0,
                ["tags"] = item["tags"] as JArray ?? new JArray(),
            });
        }
        return (shaped, items.Count >= PageSize);
    }

    /// <summary>
    /// The file behind a picture: Eagle's small preview, or the picture itself. Only ever a file inside the Eagle
    /// library, and never one from a folder with a password.
    /// </summary>
    public static async Task<string?> FileAsync(string id, bool thumbnail)
    {
        if (!IsId(id)) return null;
        if (_libraryPath == null && await FoldersAsync().ConfigureAwait(false) == null) return null;
        if (await GetAsync("item/info?id=" + id).ConfigureAwait(false) is not JObject info) return null;
        if (info["folders"] is JArray inFolders && inFolders.Any(f => _locked.Contains(f.ToString()))) return null;
        string? file = null;
        if (thumbnail && await GetAsync("item/thumbnail?id=" + id).ConfigureAwait(false) is JValue preview)
            file = Inside(preview.ToString());
        if (file != null && File.Exists(file)) return file;
        // Small pictures have no preview: use the picture itself.
        var name = info["name"]?.ToString() ?? "";
        var ext = info["ext"]?.ToString() ?? "";
        file = Inside(Path.Combine(_libraryPath!, "images", id + ".info", name + "." + ext));
        return file != null && File.Exists(file) ? file : null;
    }

    private static string? Inside(string path)
    {
        if (string.IsNullOrEmpty(_libraryPath)) return null;
        try
        {
            var root = Path.GetFullPath(_libraryPath).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
            var full = Path.GetFullPath(path);
            return full.StartsWith(root, StringComparison.OrdinalIgnoreCase) ? full : null;
        }
        catch { return null; }
    }

    private static bool IsId(string? id) => !string.IsNullOrEmpty(id) && id.Length <= 64 && id.All(char.IsLetterOrDigit);
}
