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
                _ = Task.Run(() => SendSteamBranch(online: true));
                return true;

            case "hubSteamStatus":
                _ = Task.Run(() => SendSteamBranch(online: false));
                return true;

            case "hubSteamReviewed":
                HubModules.SteamBranch.MarkBetaReviewed(msg["build"]?.ToString() ?? "");
                _ = Task.Run(() => SendSteamBranch(online: true));
                return true;

            case "hubSteamSwitch":
                var branch = msg["branch"]?.ToString() ?? "";
                _ = Task.Run(() => RunSteamSwitch(branch));
                return true;

            case "hubSteamOpen":
                try
                {
                    using var steam = System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(
                        $"steam://nav/games/details/{SteamBranchModule.SpaceCalibratorAppId}") { UseShellExecute = true });
                }
                catch (Exception ex) when (ex is System.ComponentModel.Win32Exception or InvalidOperationException)
                {
                    CrashHandler.WriteEntry("hubSteamOpen", ex);
                }
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

    private async Task SendSteamBranch(bool online)
    {
        try
        {
            var report = await HubModules.SteamBranch.CheckAsync(online);
            Invoke(() => SendToJS("hubSteamBranch", new
            {
                name = report.Name,
                watchOn = report.WatchOn,
                checkedOnline = online,
                installed = report.Installed == null ? null : new
                {
                    branch = report.Installed.Branch,
                    mountedBranch = report.Installed.MountedBranch,
                    buildId = report.Installed.BuildId,
                    ready = report.Installed.Ready,
                },
                publicBuild = SteamBuild(report.Public),
                betaBuild = SteamBuild(report.Beta),
                reviewedBeta = report.ReviewedBetaBuild,
                error = report.Error,
            }));
        }
        catch (Exception ex)
        {
            CrashHandler.WriteEntry("SendSteamBranch", ex);
        }
    }

    private static object? SteamBuild(SteamBranchBuild? build) => build == null ? null : new
    {
        buildId = build.BuildId,
        updated = build.Updated?.ToString("O"),
    };

    private async Task RunSteamSwitch(string branch)
    {
        try
        {
            var result = await HubModules.SteamBranch.SwitchAsync(branch);
            Invoke(() => SendToJS("hubSteamSwitched", new { outcome = result.Outcome.ToString(), message = result.Message }));
            await SendSteamBranch(online: false);
        }
        catch (Exception ex)
        {
            CrashHandler.WriteEntry("RunSteamSwitch", ex);
            Invoke(() => SendToJS("hubSteamSwitched", new { outcome = "Failed", message = "The switch stopped unexpectedly. Check Steam is open." }));
        }
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
