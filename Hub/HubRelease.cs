namespace HapsHub.Core;

/// <summary>
/// Where HapsHub's own releases live. Updates, release notes and bug reports go here, never to VRCNext:
/// VRCNext's issue tracker and Discord are for VRCNext, and installing a VRCNext release would replace this app.
/// </summary>
public static class HubRelease
{
    public const string Repo = "HapyrV/HapsHub";
    public const string RepoUrl = "https://github.com/" + Repo;
    public const string LatestApi = "https://api.github.com/repos/" + Repo + "/releases/latest";
    public const string ReleasesUrl = RepoUrl + "/releases/latest";
    public const string IssuesUrl = RepoUrl + "/issues/new";

    /// <summary>The VRCNext release HapsHub is built on, shown beside its own version.</summary>
    public const string UpstreamVersion = "2027.2.0";

    public static string TagApi(string version) => $"https://api.github.com/repos/{Repo}/releases/tags/v{version}";
}
