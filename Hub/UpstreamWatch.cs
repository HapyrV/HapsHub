using System.Net;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace HapsHub.Core;

public sealed record UpstreamSource(string Id, string Name, string Repo, string Branch, string? BaselineCommit);

public sealed record UpstreamFlag(string Category, IReadOnlyList<string> Files);

public sealed record UpstreamReport(
    string Id, string Name, string Repo,
    string? ReviewedCommit, string? HeadCommit,
    int? NewCommits,
    string? LatestRelease, string? ReleaseUrl, string? CompareUrl,
    IReadOnlyList<UpstreamFlag> Flags, bool FilesTruncated, string? Error);

/// <summary>
/// Shows what changed upstream since the last commit the user reviewed, and flags changes
/// to the parts most likely to break HapsHub. Reads public GitHub data only when asked,
/// and never downloads or installs anything.
/// </summary>
public sealed class UpstreamWatchModule : IHubModule
{
    public const string ModuleId = "hub.upstream-watch";

    // GitHub returns at most this many files for a comparison.
    private const int CompareFileLimit = 300;

    private static readonly (string Category, Regex Pattern)[] FlagRules =
    {
        ("API", new Regex(@"(^|/)(api|vrchatapi)(/|$)|vrchat.?api|(^|/)request\.(js|ts)$|websocket", RegexOptions.IgnoreCase | RegexOptions.Compiled)),
        ("Log parser", new Regex(@"log.?(watcher|parser|reader)|gamelog", RegexOptions.IgnoreCase | RegexOptions.Compiled)),
        ("Auth", new Regex(@"auth|login|two.?factor|totp|cookie", RegexOptions.IgnoreCase | RegexOptions.Compiled)),
    };

    private static readonly Regex CommitSha = new("^[0-9a-fA-F]{7,64}$", RegexOptions.Compiled);

    public static readonly IReadOnlyList<UpstreamSource> DefaultSources = new[]
    {
        new UpstreamSource("vrcnext", "VRCNext", "shinyflvre/VRCNext", "main", "7589396256a73a4a0364f683d7788b69217fce12"),
        new UpstreamSource("vrcx", "VRCX", "vrcx-team/VRCX", "master", "30e00095b817117660180db96865e158e07d5c0a"),
        new UpstreamSource("spacecalibrator", "Space Calibrator", "hyblocker/OpenVR-SpaceCalibrator", "develop", null),
    };

    private readonly HttpClient _http;
    private readonly IReadOnlyList<UpstreamSource> _sources;
    private HubModuleContext? _context;

    public UpstreamWatchModule(HttpMessageHandler? handler = null, IReadOnlyList<UpstreamSource>? sources = null)
    {
        _sources = sources ?? DefaultSources;
        _http = handler != null ? new HttpClient(handler) : new HttpClient();
        _http.Timeout = TimeSpan.FromSeconds(20);
        _http.BaseAddress = new Uri("https://api.github.com/");
        // Name only: this is a lookup, so it doesn't need the contact address.
        _http.DefaultRequestHeaders.TryAddWithoutValidation("User-Agent", HubPaths.AppName);
        _http.DefaultRequestHeaders.TryAddWithoutValidation("Accept", "application/vnd.github+json");
    }

    public string Id => ModuleId;
    public string DisplayName => "Upstream update check";

    public IReadOnlyList<HubMigration> Migrations { get; } = new[]
    {
        new HubMigration(1, """
            CREATE TABLE upstream_reviewed (
                source_id   TEXT PRIMARY KEY,
                commit_sha  TEXT NOT NULL,
                reviewed_at TEXT NOT NULL
            );
            """),
    };

    public Task StartAsync(HubModuleContext context, CancellationToken cancellationToken)
    {
        _context = context;
        return Task.CompletedTask;
    }

    public Task StopAsync(CancellationToken cancellationToken)
    {
        _context = null;
        return Task.CompletedTask;
    }

    public async Task<IReadOnlyList<UpstreamReport>> CheckAllAsync(CancellationToken cancellationToken = default)
    {
        var reports = new List<UpstreamReport>();
        foreach (var source in _sources)
            reports.Add(await CheckAsync(source, cancellationToken));
        return reports;
    }

    /// <summary>Remembers a commit as reviewed. Returns false if it couldn't be saved.</summary>
    public bool MarkReviewed(string sourceId, string commit)
    {
        var database = _context?.Database;
        if (database == null || !CommitSha.IsMatch(commit) || _sources.All(s => s.Id != sourceId)) return false;
        try
        {
            using var connection = database.OpenConnection();
            using var command = connection.CreateCommand();
            command.CommandText = """
                INSERT INTO upstream_reviewed (source_id, commit_sha, reviewed_at) VALUES ($s, $c, $t)
                ON CONFLICT(source_id) DO UPDATE SET commit_sha = $c, reviewed_at = $t;
                """;
            command.Parameters.AddWithValue("$s", sourceId);
            command.Parameters.AddWithValue("$c", commit);
            command.Parameters.AddWithValue("$t", DateTime.UtcNow.ToString("O"));
            command.ExecuteNonQuery();
            return true;
        }
        catch (Microsoft.Data.Sqlite.SqliteException ex)
        {
            _context?.Log($"Could not save the reviewed commit: {ex.Message}");
            return false;
        }
    }

    /// <summary>Sorts changed file paths into the categories worth a closer look.</summary>
    public static IReadOnlyList<UpstreamFlag> Classify(IEnumerable<string> files)
    {
        var all = files.ToList();
        var flags = new List<UpstreamFlag>();
        foreach (var (category, pattern) in FlagRules)
        {
            var matched = all.Where(f => pattern.IsMatch(f)).ToList();
            if (matched.Count > 0) flags.Add(new UpstreamFlag(category, matched));
        }
        return flags;
    }

    private async Task<UpstreamReport> CheckAsync(UpstreamSource source, CancellationToken cancellationToken)
    {
        var reviewed = ReadReviewed(source) ?? source.BaselineCommit;
        string? head = null, releaseName = null, releaseUrl = null, compareUrl = null;
        int? newCommits = null;
        IReadOnlyList<UpstreamFlag> flags = Array.Empty<UpstreamFlag>();
        var truncated = false;

        try
        {
            using (var commit = await GetJson($"repos/{source.Repo}/commits/{source.Branch}", cancellationToken))
                head = commit.RootElement.GetProperty("sha").GetString();

            using (var releases = await GetJson($"repos/{source.Repo}/releases?per_page=1", cancellationToken))
            {
                if (releases.RootElement.GetArrayLength() > 0)
                {
                    var latest = releases.RootElement[0];
                    releaseName = latest.GetProperty("tag_name").GetString();
                    releaseUrl = latest.GetProperty("html_url").GetString();
                }
            }

            if (reviewed != null && string.Equals(reviewed, head, StringComparison.OrdinalIgnoreCase))
            {
                newCommits = 0;
            }
            else if (reviewed != null)
            {
                using var compare = await GetJson($"repos/{source.Repo}/compare/{reviewed}...{head}", cancellationToken);
                var root = compare.RootElement;
                newCommits = root.GetProperty("total_commits").GetInt32();
                compareUrl = root.GetProperty("html_url").GetString();
                var files = root.TryGetProperty("files", out var list)
                    ? list.EnumerateArray().Select(f => f.GetProperty("filename").GetString() ?? "").ToList()
                    : new List<string>();
                flags = Classify(files);
                truncated = files.Count >= CompareFileLimit;
            }
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or JsonException
                                       or KeyNotFoundException or InvalidOperationException)
        {
            return new UpstreamReport(source.Id, source.Name, source.Repo, reviewed, head, null,
                releaseName, releaseUrl, null, Array.Empty<UpstreamFlag>(), false, Describe(ex));
        }

        return new UpstreamReport(source.Id, source.Name, source.Repo, reviewed, head, newCommits,
            releaseName, releaseUrl, compareUrl, flags, truncated, null);
    }

    private async Task<JsonDocument> GetJson(string path, CancellationToken cancellationToken)
    {
        using var response = await _http.GetAsync(path, cancellationToken);
        if (response.StatusCode is HttpStatusCode.Forbidden or HttpStatusCode.TooManyRequests)
            throw new HttpRequestException("GitHub's hourly limit was reached. Try again later.");
        if (response.StatusCode == HttpStatusCode.NotFound)
            throw new HttpRequestException("GitHub couldn't find this repository, branch or the reviewed commit.");
        if (!response.IsSuccessStatusCode)
            throw new HttpRequestException($"GitHub answered {(int)response.StatusCode}.");
        await using var body = await response.Content.ReadAsStreamAsync(cancellationToken);
        return await JsonDocument.ParseAsync(body, cancellationToken: cancellationToken);
    }

    private string? ReadReviewed(UpstreamSource source)
    {
        var database = _context?.Database;
        if (database == null) return null;
        try
        {
            using var connection = database.OpenConnection();
            using var command = connection.CreateCommand();
            command.CommandText = "SELECT commit_sha FROM upstream_reviewed WHERE source_id = $s;";
            command.Parameters.AddWithValue("$s", source.Id);
            return command.ExecuteScalar() as string;
        }
        catch (Microsoft.Data.Sqlite.SqliteException ex)
        {
            _context?.Log($"Could not read the reviewed commit: {ex.Message}");
            return null;
        }
    }

    private static string Describe(Exception ex) => ex switch
    {
        TaskCanceledException => "GitHub didn't answer in time.",
        HttpRequestException => ex.Message,
        _ => "GitHub's answer wasn't in the expected format.",
    };
}
