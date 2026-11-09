using System.Net;

namespace HapsHub.Core;

/// <summary>
/// Sends the app's web requests through a proxy you choose. It sets the one default every
/// HttpClient and WebSocket starts from, so no feature can be missed.
/// </summary>
public sealed class HubProxyModule : IHubModule
{
    public const string ModuleId = "hub.proxy";
    private const string UrlKey = "url";
    private static readonly IWebProxy SystemDefault = HttpClient.DefaultProxy;
    private HubModuleContext? _context;

    public string Id => ModuleId;
    public string DisplayName => "Proxy";

    public IReadOnlyList<HubSettingDefinition> Settings { get; } = new[]
    {
        new HubSettingDefinition(UrlKey, "Proxy address, like http://host:port or socks5://host:port. Empty means none. Restart HapsHub after changing it", HubSettingKind.Text, ""),
    };

    public Task StartAsync(HubModuleContext context, CancellationToken cancellationToken)
    {
        _context = context;
        Apply(context.GetSetting(UrlKey));
        return Task.CompletedTask;
    }

    public Task StopAsync(CancellationToken cancellationToken)
    {
        _context = null;
        HttpClient.DefaultProxy = SystemDefault;
        return Task.CompletedTask;
    }

    public void OnSettingChanged(string key, string value)
    {
        if (key == UrlKey) Apply(value);
    }

    private void Apply(string? address)
    {
        var (proxy, problem) = Parse(address);
        if (problem != null)
        {
            // A typo must not break sign-in, so the app carries on as if none was set.
            _context?.ReportDegraded($"Proxy address not used: {problem}");
            HttpClient.DefaultProxy = SystemDefault;
            return;
        }
        HttpClient.DefaultProxy = proxy ?? SystemDefault;
        _context?.ReportHealthy();
        _context?.Log(proxy == null ? "No proxy set." : "Using a proxy.");
    }

    /// <summary>A null proxy with no problem means none was asked for. Sign-in details in the address are used, never logged.</summary>
    public static (WebProxy? Proxy, string? Problem) Parse(string? address)
    {
        var text = (address ?? "").Trim();
        if (text.Length == 0) return (null, null);
        if (!Uri.TryCreate(text, UriKind.Absolute, out var uri)) return (null, "it isn't a full address");
        if (uri.Scheme is not ("http" or "https" or "socks4" or "socks4a" or "socks5"))
            return (null, $"{uri.Scheme} isn't a supported kind");
        if (string.IsNullOrEmpty(uri.Host) || uri.IsDefaultPort && uri.Port <= 0) return (null, "it needs a host and port");
        var bare = new UriBuilder(uri) { UserName = "", Password = "" }.Uri;
        var proxy = new WebProxy(bare);
        if (uri.UserInfo.Length > 0)
        {
            var parts = uri.UserInfo.Split(':', 2);
            proxy.Credentials = new NetworkCredential(Uri.UnescapeDataString(parts[0]), parts.Length > 1 ? Uri.UnescapeDataString(parts[1]) : "");
        }
        return (proxy, null);
    }
}
