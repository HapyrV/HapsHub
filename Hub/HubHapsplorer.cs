using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace HapsHub.Core;

/// <summary>
/// The Hapsplorer page's local web server: the same thin client as the standalone Hapsplorer app
/// (D:\VR\Hapsplorer, src/Hapsplorer.Client/ClientProxy.cs), on the same fixed address, http://127.0.0.1:8790.
/// It serves the bundled Hapsplorer UI (frontend/modules/tools/hapsplorer/app) and forwards /api/* to the
/// Hapsplorer server with the access key added: the LAN address if it answers within 300 ms, else the Worker.
/// Settings are shared with the standalone app (%APPDATA%\Hapsplorer\client.json), and so is the origin, so
/// bookmarks and the tier list are the same in both. If the standalone app already holds the port, the page uses it.
/// There is no engine and no dataset here: the server does all the work.
/// </summary>
public sealed class HubHapsplorerModule : IHubModule
{
    public const string ModuleId = "hub.hapsplorer";
    public const int Port = 8790;
    public const string Origin = "http://127.0.0.1:8790";
    private const string KeyHeader = "X-Hapsplorer-Key";
    private const int CacheMax = 400;
    private static readonly string[] NoCache = ["/api/health", "/api/status", "/api/thumb", "/api/me", "/api/rates"];

    private HubModuleContext? _context;
    private HttpListener? _listener;
    private readonly HttpClient _http = new(new SocketsHttpHandler { AutomaticDecompression = DecompressionMethods.All, UseCookies = false }) { Timeout = TimeSpan.FromSeconds(30) };
    private readonly SemaphoreSlim _pickGate = new(1, 1);
    private Uri? _current;
    private DateTime _checked;
    private int _puts;

    public string Id => ModuleId;
    public string DisplayName => "Hapsplorer";

    // Same rule as the standalone app (HAPSPLORER_CLIENT_DIR overrides, for testing).
    private static string Dir => Environment.GetEnvironmentVariable("HAPSPLORER_CLIENT_DIR") is { Length: > 0 } d ? d
        : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "Hapsplorer");
    private static string SettingsFile => Path.Combine(Dir, "client.json");
    private static string CacheDir => Path.Combine(Dir, "cache");
    private static string WebRoot => Path.Combine(AppContext.BaseDirectory, "frontend", "modules", "tools", "hapsplorer", "app");

    public Task StartAsync(HubModuleContext context, CancellationToken cancellationToken)
    {
        _context = context;
        if (IsClientRunning())
        {
            context.Log("The Hapsplorer app already serves 127.0.0.1:8790; the page uses it.");
            context.ReportHealthy();
            return Task.CompletedTask;
        }
        try
        {
            var l = new HttpListener();
            l.Prefixes.Add(Origin + "/");
            l.Start();
            _listener = l;
            context.RunBackground("hapsplorer-proxy", Serve);
            context.ReportHealthy();
        }
        catch (HttpListenerException ex)
        {
            context.ReportDegraded($"Port {Port} is in use, so the Hapsplorer page can't open: {ex.Message}");
        }
        return Task.CompletedTask;
    }

    public Task StopAsync(CancellationToken cancellationToken)
    {
        try { _listener?.Stop(); _listener?.Close(); } catch (ObjectDisposedException) { }
        _listener = null;
        _context = null;
        return Task.CompletedTask;
    }

    private static bool IsClientRunning()
    {
        try
        {
            using var c = new HttpClient { Timeout = TimeSpan.FromMilliseconds(500) };
            return c.GetStringAsync(Origin + "/_client/ping").GetAwaiter().GetResult() == "hapsplorer-client";
        }
        catch (Exception) { return false; }
    }

    private async Task Serve(CancellationToken ct)
    {
        var l = _listener;
        while (l is { IsListening: true } && !ct.IsCancellationRequested)
        {
            HttpListenerContext ctx;
            var pending = l.GetContextAsync();
            try { ctx = await pending.WaitAsync(ct); }
            catch (Exception)
            {
                // On shutdown the wait ends first and the listener closes after, which faults the pending accept.
                // Observe it, or the finalizer reports it as an unobserved task exception (a crash report).
                _ = pending.ContinueWith(t => _ = t.Exception, CancellationToken.None,
                    TaskContinuationOptions.OnlyOnFaulted | TaskContinuationOptions.ExecuteSynchronously, TaskScheduler.Default);
                break;
            }
            _ = Task.Run(async () =>
            {
                try { await Handle(ctx, ct); }
                catch (Exception ex) { _context?.Log($"request failed: {ex.Message}"); try { ctx.Response.StatusCode = 500; } catch { } }
                finally { try { ctx.Response.Close(); } catch { } }
            }, ct);
        }
    }

    private async Task Handle(HttpListenerContext ctx, CancellationToken ct)
    {
        var req = ctx.Request;
        var res = ctx.Response;
        var path = req.Url!.AbsolutePath;
        var isGet = req.HttpMethod is "GET" or "HEAD";
        // Only our own origin: http.sys still passes other Host names to an IP prefix, so a DNS-rebinding page
        // could otherwise read the API with the saved key. Refuse cross-site writes too.
        if (req.Headers["Host"] is not ("127.0.0.1:8790" or "localhost:8790")) { res.StatusCode = 421; return; }
        if (!isGet && req.Headers["Origin"] is { } origin && origin != Origin) { res.StatusCode = 403; return; }

        if (path == "/_client/ping") { await Text(res, "hapsplorer-client", "text/plain"); return; }
        if (path == "/_client/settings")
        {
            var s = Load();
            if (req.HttpMethod == "POST")
            {
                if (req.Headers["X-Hapsplorer-Client"] != "1") { res.StatusCode = 403; return; }
                var body = await JsonSerializer.DeserializeAsync<JsonElement>(req.InputStream, cancellationToken: ct);
                if (body.TryGetProperty("server", out var sv)) s.Server = CleanUrl(sv.GetString());
                if (body.TryGetProperty("lan", out var lv)) s.Lan = CleanUrl(lv.GetString());
                if (body.TryGetProperty("key", out var kv) && kv.GetString() is { Length: > 0 } k) s.Key = k.Trim();
                Save(s);
                _checked = default;
                await Json(res, new { ok = true, via = (await Pick(s, ct))?.ToString() });
                return;
            }
            await Json(res, new { server = s.Server, lan = s.Lan, hasKey = s.Key != null, via = _current?.ToString(), dir = Dir });
            return;
        }
        if (path == "/api/login" && req.HttpMethod == "POST") { await Login(ctx, ct); return; }
        if (path == "/api/logout" && req.HttpMethod == "POST") { var s = Load(); s.Key = null; Save(s); await Json(res, new { }); return; }
        if (path == "/api" || path.StartsWith("/api/", StringComparison.Ordinal)) { await Forward(ctx, ct); return; }
        await StaticFile(res, path, ct);
    }

    private async Task Login(HttpListenerContext ctx, CancellationToken ct)
    {
        var s = Load();
        var body = await JsonSerializer.DeserializeAsync<JsonElement>(ctx.Request.InputStream, cancellationToken: ct);
        var key = body.TryGetProperty("key", out var kv) ? kv.GetString()?.Trim() : null;
        if (string.IsNullOrEmpty(key)) { await Json(ctx.Response, new { error = "That key isn't valid." }, 401); return; }
        if (await Pick(s, ct) is not { } up) { await Offline(ctx.Response, s); return; }
        using var r = new HttpRequestMessage(HttpMethod.Get, new Uri(up, "/api/me"));
        r.Headers.Add(KeyHeader, key);
        HttpResponseMessage answer;
        try { answer = await _http.SendAsync(r, ct); }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException && !ct.IsCancellationRequested)
        {
            _checked = default;
            await Offline(ctx.Response, s);
            return;
        }
        using var _ = answer;
        // Only a refusal means a bad key; an offline or failing server is reported as that.
        if (answer.StatusCode is HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden) { await Json(ctx.Response, new { error = "That key isn't valid." }, 401); return; }
        if (!answer.IsSuccessStatusCode) { _checked = default; await Offline(ctx.Response, s); return; }
        s.Key = key;
        Save(s);
        await Text(ctx.Response, await answer.Content.ReadAsStringAsync(ct), "application/json");
    }

    private async Task Forward(HttpListenerContext ctx, CancellationToken ct)
    {
        var req = ctx.Request;
        var s = Load();
        var pathQuery = req.Url!.PathAndQuery;
        var isGet = req.HttpMethod == "GET";
        var cacheable = isGet && !NoCache.Any(p => req.Url.AbsolutePath == p || req.Url.AbsolutePath.StartsWith(p + "/", StringComparison.Ordinal));
        byte[]? body = null;
        if (!isGet && req.HasEntityBody) { using var ms = new MemoryStream(); await req.InputStream.CopyToAsync(ms, ct); body = ms.ToArray(); }
        for (var attempt = 0; attempt < 2; attempt++)
        {
            if (await Pick(s, ct) is not { } up) break;
            try
            {
                using var r = new HttpRequestMessage(new HttpMethod(req.HttpMethod), new Uri(up, pathQuery));
                if (s.Key is { } key) r.Headers.Add(KeyHeader, key);
                if (body != null)
                {
                    r.Content = new ByteArrayContent(body);
                    if (req.ContentType is { } type) r.Content.Headers.TryAddWithoutValidation("Content-Type", type);
                }
                using var answer = await _http.SendAsync(r, ct);
                if ((int)answer.StatusCode is 502 or 503 or 504 or 530) { if (up == _current) _checked = default; continue; }
                var bytes = await answer.Content.ReadAsByteArrayAsync(ct);
                var contentType = answer.Content.Headers.ContentType?.ToString() ?? "application/octet-stream";
                if (cacheable && answer.StatusCode == HttpStatusCode.OK && contentType.StartsWith("application/json", StringComparison.Ordinal)) CachePut(pathQuery, bytes);
                ctx.Response.StatusCode = (int)answer.StatusCode;
                ctx.Response.ContentType = contentType;
                ctx.Response.Headers["Cache-Control"] = answer.Headers.CacheControl?.ToString() ?? "no-store";
                if (answer.Headers.RetryAfter is { } ra) ctx.Response.Headers["Retry-After"] = ra.ToString();
                await ctx.Response.OutputStream.WriteAsync(bytes, ct);
                return;
            }
            catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException && !ct.IsCancellationRequested)
            {
                if (up == _current) _checked = default;
            }
        }
        if (cacheable && CacheGet(pathQuery) is { } saved)
        {
            ctx.Response.Headers["X-Hapsplorer-Offline"] = "cached";
            ctx.Response.ContentType = "application/json; charset=utf-8";
            await ctx.Response.OutputStream.WriteAsync(saved, ct);
            return;
        }
        await Offline(ctx.Response, s);
    }

    /// <summary>The LAN address if it answers within 300 ms, else the Worker. Checked again every minute and after a failure.</summary>
    private async Task<Uri?> Pick(ClientSettings s, CancellationToken ct)
    {
        TimeSpan Ttl() => TimeSpan.FromSeconds(_current is null ? 5 : 60);
        if (DateTime.UtcNow - _checked < Ttl()) return _current;
        await _pickGate.WaitAsync(ct);
        try
        {
            if (DateTime.UtcNow - _checked < Ttl()) return _current;
            _current = null;
            if (s.Lan is { } lan && await Healthy(lan, TimeSpan.FromMilliseconds(300), ct)) _current = new Uri(lan);
            else if (s.Server is { } srv && await Healthy(srv, TimeSpan.FromSeconds(4), ct)) _current = new Uri(srv);
            _checked = DateTime.UtcNow;
            return _current;
        }
        finally { _pickGate.Release(); }
    }

    private async Task<bool> Healthy(string baseUrl, TimeSpan timeout, CancellationToken ct)
    {
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        cts.CancelAfter(timeout);
        try
        {
            using var r = await _http.GetAsync(baseUrl.TrimEnd('/') + "/api/health", cts.Token);
            return r.IsSuccessStatusCode;
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException) { return false; }
    }

    private static readonly Dictionary<string, string> Types = new(StringComparer.OrdinalIgnoreCase)
    {
        [".html"] = "text/html; charset=utf-8", [".js"] = "text/javascript; charset=utf-8", [".css"] = "text/css; charset=utf-8",
        [".svg"] = "image/svg+xml", [".png"] = "image/png", [".ico"] = "image/x-icon", [".json"] = "application/json",
    };

    private static async Task StaticFile(HttpListenerResponse res, string path, CancellationToken ct)
    {
        if (path == "/") path = "/index.html";
        var root = Path.GetFullPath(WebRoot);
        var full = Path.GetFullPath(Path.Combine(root, Uri.UnescapeDataString(path).TrimStart('/')));
        if (!full.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase) || !File.Exists(full)) { res.StatusCode = 404; return; }
        res.ContentType = Types.GetValueOrDefault(Path.GetExtension(full), "application/octet-stream");
        res.Headers["Cache-Control"] = "no-cache";
        await using var f = File.OpenRead(full);
        res.ContentLength64 = f.Length;
        await f.CopyToAsync(res.OutputStream, ct);
    }

    private static Task Offline(HttpListenerResponse res, ClientSettings s) => Json(res, new
    {
        ok = false,
        offline = true,
        error = s.Server is null && s.Lan is null ? "No server address set yet." : "The Hapsplorer server can't be reached.",
        settings = true,
    }, 503);

    private static Task Json(HttpListenerResponse res, object value, int status = 200)
    {
        res.StatusCode = status;
        res.Headers["Cache-Control"] = "no-store";
        return Text(res, JsonSerializer.Serialize(value, JsonOpts), "application/json; charset=utf-8");
    }

    private static async Task Text(HttpListenerResponse res, string text, string type)
    {
        var b = Encoding.UTF8.GetBytes(text);
        res.ContentType = type;
        res.ContentLength64 = b.Length;
        await res.OutputStream.WriteAsync(b);
    }

    // --- client.json, shared with the standalone Hapsplorer app ---
    private sealed class ClientSettings
    {
        public string? Server { get; set; }
        public string? Lan { get; set; }
        public string? Key { get; set; }
        public int Port { get; set; } = HubHapsplorerModule.Port;
    }

    private static readonly JsonSerializerOptions JsonOpts = new(JsonSerializerDefaults.Web) { WriteIndented = true };
    private static readonly object SaveLock = new();

    private static ClientSettings Load()
    {
        try { return File.Exists(SettingsFile) ? JsonSerializer.Deserialize<ClientSettings>(File.ReadAllText(SettingsFile), JsonOpts) ?? new() : new(); }
        catch (Exception ex) when (ex is JsonException or IOException) { return new(); }
    }

    private static void Save(ClientSettings s)
    {
        lock (SaveLock)
        {
            Directory.CreateDirectory(Dir);
            AtomicFile.WriteAllText(SettingsFile, JsonSerializer.Serialize(s, JsonOpts));
        }
    }

    private static string? CleanUrl(string? u)
    {
        if (string.IsNullOrWhiteSpace(u)) return null;
        u = u.Trim();
        if (!u.Contains("://", StringComparison.Ordinal)) u = "https://" + u;
        return Uri.TryCreate(u, UriKind.Absolute, out var x) && x.Scheme is "http" or "https" ? x.GetLeftPart(UriPartial.Authority) : null;
    }

    // --- last answers, for when the server is offline ---
    private static string CacheFile(string key) => Path.Combine(CacheDir, Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(key)))[..32] + ".json");

    private void CachePut(string key, byte[] body)
    {
        try
        {
            Directory.CreateDirectory(CacheDir);
            File.WriteAllBytes(CacheFile(key), body);
            if (Interlocked.Increment(ref _puts) % 50 == 0)
                foreach (var f in new DirectoryInfo(CacheDir).GetFiles("*.json").OrderByDescending(f => f.LastWriteTimeUtc).Skip(CacheMax))
                    try { f.Delete(); } catch (IOException) { }
        }
        catch (IOException) { }
    }

    private static byte[]? CacheGet(string key)
    {
        try { return File.Exists(CacheFile(key)) ? File.ReadAllBytes(CacheFile(key)) : null; }
        catch (IOException) { return null; }
    }
}
