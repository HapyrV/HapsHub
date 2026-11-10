namespace VRCNext.Services;

// Checks HapsHub's own GitHub releases and opens the download page; it never installs anything by itself.
// VRCNext's releases must never be installed: Velopack would replace this app with the stock upstream build.
public class UpdateService
{
    private const string RepoUrl = HapsHub.Core.HubRelease.RepoUrl;
    private const string ApiLatest = HapsHub.Core.HubRelease.LatestApi;

    private string? _ghReleaseUrl;

    public Task<string?> CheckAsync() => CheckGithubAsync();

    private async Task<string?> CheckGithubAsync()
    {
        try
        {
            using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(15) };
            http.DefaultRequestVersion = System.Net.HttpVersion.Version20;
            http.DefaultVersionPolicy = System.Net.Http.HttpVersionPolicy.RequestVersionOrLower;
            http.DefaultRequestHeaders.TryAddWithoutValidation("User-Agent", AppInfo.UserAgent);
            var body = await http.GetStringAsync(ApiLatest);
            var json = Newtonsoft.Json.Linq.JObject.Parse(body);
            var tag = (json["tag_name"]?.ToString() ?? "").TrimStart('v', 'V');
            if (string.IsNullOrEmpty(tag)) return null;
            if (!Version.TryParse(tag, out var latest)) return null;
            if (!Version.TryParse(AppInfo.Version, out var current)) return null;
            if (latest <= current) return null;

            _ghReleaseUrl = json["html_url"]?.ToString() ?? $"{RepoUrl}/releases/latest";
            return tag;
        }
        catch { return null; }
    }

    public Task DownloadAsync(Action<int> onProgress)
    {
        onProgress(100);
        return Task.CompletedTask;
    }

    public void ApplyAndRestart()
    {
        var url = _ghReleaseUrl ?? $"{RepoUrl}/releases/latest";
        try
        {
            System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo
            {
                FileName = url,
                UseShellExecute = true,
            });
        }
        catch { }
    }
}
