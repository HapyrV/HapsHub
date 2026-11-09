using Newtonsoft.Json.Linq;
using VRCNext.Services;

namespace VRCNext;

// HapsHub's own page messages, kept out of MessageRouter's switch so upstream merges stay simple.
public partial class AppShell
{
    private bool HandleHubMessage(string action, JObject msg)
    {
        switch (action)
        {
            case "hubGetModules":
                SendHubModules();
                return true;

            case "hubSetSetting":
                var moduleId = msg["module"]?.ToString() ?? "";
                var key = msg["key"]?.ToString() ?? "";
                var value = msg["value"]?.ToString() ?? "";
                try
                {
                    if (_hub != null && !_hub.Modules.SetSetting(moduleId, key, value))
                        SendToJS("log", new { msg = $"[Hub] Could not save {moduleId}/{key}", color = "err" });
                }
                catch (ArgumentException ex)
                {
                    CrashHandler.WriteEntry("hubSetSetting", ex);
                }
                SendHubModules();
                return true;

            case "hubUpstreamCheck":
                _ = Task.Run(RunUpstreamCheck);
                return true;

            case "hubUpstreamReviewed":
                var sourceId = msg["id"]?.ToString() ?? "";
                var saved = HubModules.UpstreamWatch.MarkReviewed(sourceId, msg["commit"]?.ToString() ?? "");
                SendToJS("hubUpstreamReviewed", new { id = sourceId, saved });
                return true;

            default:
                return false;
        }
    }

    private void SendHubModules()
    {
        var modules = _hub?.Modules.GetModules() ?? Array.Empty<HubModuleInfo>();
        SendToJS("hubModules", new
        {
            modules = modules.Select(m => new
            {
                id = m.Id,
                name = m.DisplayName,
                enabled = m.Enabled,
                status = m.Status.ToString(),
                detail = m.Detail,
                settings = m.Settings.Select(s => new
                {
                    key = s.Definition.Key,
                    label = s.Definition.Label,
                    kind = s.Definition.Kind.ToString(),
                    value = s.Value,
                }),
            }),
        });
    }

    private async Task RunUpstreamCheck()
    {
        try
        {
            var reports = await HubModules.UpstreamWatch.CheckAllAsync();
            var payload = reports.Select(r => new
            {
                id = r.Id,
                name = r.Name,
                repo = r.Repo,
                reviewedCommit = r.ReviewedCommit,
                headCommit = r.HeadCommit,
                newCommits = r.NewCommits,
                latestRelease = r.LatestRelease,
                releaseUrl = r.ReleaseUrl,
                compareUrl = r.CompareUrl,
                flags = r.Flags.Select(f => new { category = f.Category, files = f.Files }),
                filesTruncated = r.FilesTruncated,
                error = r.Error,
            });
            Invoke(() => SendToJS("hubUpstream", new { reports = payload }));
        }
        catch (Exception ex)
        {
            CrashHandler.WriteEntry("RunUpstreamCheck", ex);
        }
    }
}
