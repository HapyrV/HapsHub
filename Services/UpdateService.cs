namespace VRCNext.Services;

// HapsHub only reports upstream VRCNext releases. It must never install them:
// Velopack would replace this fork with the stock upstream build.
public class UpdateService
{
    private const string RepoUrl = "https://github.com/shinyflvre/VRCNext";
    private const string ApiLatest = "https://api.github.com/repos/shinyflvre/VRCNext/releases/latest";

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
