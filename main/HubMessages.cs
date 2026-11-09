using Newtonsoft.Json.Linq;
using VRCNext.Services;

namespace VRCNext;

// HapsHub's own page messages, kept out of MessageRouter's switch so upstream merges stay simple.
public partial class AppShell
{
    private bool HandleHubMessage(string action, JObject msg)
    {
        if (HandleHistoryMessage(action, msg)) return true;
        if (HandleGroupMessage(action, msg)) return true;
        if (HandleTunnelMessage(action, msg)) return true;
        if (HandleEmbedMessage(action, msg)) return true;
        if (HandleOvrasMessage(action, msg)) return true;
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

            case "hubCalendarList":
                SendCalendarEvents();
                return true;

            case "hubCalendarSave":
                var calendarProblem = HubModules.Calendar.Save(new HubCalendarEvent(
                    msg["id"]?.ToString() ?? "", msg["title"]?.ToString() ?? "", msg["description"]?.ToString() ?? "",
                    msg["startsAt"]?.ToString() ?? "", msg["endsAt"]?.ToString() ?? "",
                    msg["repeat"]?.ToString() ?? "none", msg["repeatUntil"]?.ToString() ?? ""));
                if (calendarProblem != null) SendToJS("hubCalendarEvents", new { error = calendarProblem });
                else SendCalendarEvents();
                return true;

            case "hubCalendarDelete":
                HubModules.Calendar.Delete(msg["id"]?.ToString() ?? "");
                SendCalendarEvents();
                return true;

            case "hubScheduleData":
                _ = Task.Run(SendScheduleData);
                return true;

            case "hubVrcxArchive":
                var vrcxSource = VrcxHistoryModule.DefaultSource;
                if (msg["choose"]?.Value<bool>() == true)
                {
                    var picked = NativeFileDialogSharp.Dialog.FileOpen("sqlite3,db");
                    if (!picked.IsOk) return true;
                    vrcxSource = picked.Path;
                }
                _ = Task.Run(() => RunVrcxArchive(vrcxSource));
                return true;

            case "hubExportNotes":
                var savedTo = NativeFileDialogSharp.Dialog.FileSave("csv");
                if (!savedTo.IsOk) return true;
                var notesPath = savedTo.Path.EndsWith(".csv", StringComparison.OrdinalIgnoreCase) ? savedTo.Path : savedTo.Path + ".csv";
                _ = Task.Run(() => RunNotesExport(notesPath));
                return true;

            case "hubVrcxBrowse":
                var browseTable = msg["table"]?.ToString() ?? "";
                var browseSearch = msg["search"]?.ToString() ?? "";
                var browseOffset = msg["offset"]?.Value<int>() ?? 0;
                _ = Task.Run(() => SendVrcxRows(browseTable, browseSearch, browseOffset));
                return true;

            case "hubVrcxSummary":
                _ = Task.Run(SendVrcxSummary);
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
                    options = s.Definition.Options.Select(o => new { value = o.Value, label = o.Label }),
                }),
            }),
        });
    }

    private void SendScheduleData()
    {
        try
        {
            var data = _core.Timeline.ReadScheduleData();
            Invoke(() => SendToJS("hubSchedule", new { presence = data.Presence, relationships = data.Relationships, self = data.Self, names = data.Names }));
        }
        catch (Exception ex)
        {
            CrashHandler.WriteEntry("SendScheduleData", ex);
            Invoke(() => SendToJS("hubSchedule", new { error = "Could not read your history." }));
        }
    }

    private void SendCalendarEvents()
    {
        var events = HubModules.Calendar.List();
        if (events == null) SendToJS("hubCalendarEvents", new { error = "Your calendar events couldn't be read." });
        else SendToJS("hubCalendarEvents", new
        {
            events = events.Select(e => new
            {
                id = e.Id, title = e.Title, description = e.Description, startsAt = e.StartsAt,
                endsAt = e.EndsAt, repeat = e.Repeat, repeatUntil = e.RepeatUntil,
            }),
        });
    }

    private void RunVrcxArchive(string source)
    {
        try
        {
            var result = HubModules.VrcxHistory.Run(source,
                text => Invoke(() => SendToJS("hubVrcxArchive", new { stage = "progress", text })));
            Invoke(() => SendToJS("hubVrcxArchive", new
            {
                stage = "done",
                error = result.Error,
                complete = result.Complete,
                tables = result.Tables.Select(t => new { table = t.Table, source = t.SourceRows, added = t.Added, already = t.AlreadyHere, total = t.ArchivedTotal }),
                skipped = result.Skipped.Select(s => new { table = s.Table, rows = s.Rows, reason = s.Reason }),
            }));
        }
        catch (Exception ex)
        {
            CrashHandler.WriteEntry("RunVrcxArchive", ex);
            Invoke(() => SendToJS("hubVrcxArchive", new { stage = "done", error = "The archive stopped unexpectedly.", complete = false }));
        }
    }

    private void SendVrcxRows(string table, string search, int offset)
    {
        const int pageSize = 50;
        try
        {
            var (rows, more) = HubModules.VrcxHistory.ReadRows(table, search, Math.Max(0, offset), pageSize);
            Invoke(() => SendToJS("hubVrcxRows", new { table, search, offset, rows, more }));
        }
        catch (Exception ex) when (ex is Microsoft.Data.Sqlite.SqliteException or IOException)
        {
            CrashHandler.WriteEntry("SendVrcxRows", ex);
            Invoke(() => SendToJS("hubVrcxRows", new { table, search, offset, error = "The archive couldn't be read." }));
        }
    }

    private void RunNotesExport(string path)
    {
        try
        {
            var (memos, names) = _core.Timeline.ReadNotesForExport();
            var notes = memos.Select(m => new ExportedNote("user", m.Id, names.GetValueOrDefault(m.Id, ""), m.Memo, m.Edited, "HapsHub")).ToList();
            notes.AddRange(HubModules.VrcxHistory.ReadNotes().Select(n => n with { Name = names.GetValueOrDefault(n.Id, "") }));
            AtomicFile.WriteAllText(path, NotesExport.BuildCsv(notes));
            Invoke(() => SendToJS("hubNotesExported", new { count = notes.Count, path }));
        }
        catch (Exception ex) when (ex is Microsoft.Data.Sqlite.SqliteException or IOException or UnauthorizedAccessException)
        {
            CrashHandler.WriteEntry("RunNotesExport", ex);
            Invoke(() => SendToJS("hubNotesExported", new { error = "Your notes couldn't be exported." }));
        }
    }

    private void SendVrcxSummary()
    {
        try
        {
            var tables = HubModules.VrcxHistory.ReadSummary();
            Invoke(() => SendToJS("hubVrcxArchive", new { stage = "summary", tableCount = tables.Count, tables = tables.Select(t => new { name = t.Table, rows = t.ArchivedTotal }), rows = tables.Sum(t => t.ArchivedTotal) }));
        }
        catch (Exception ex) when (ex is Microsoft.Data.Sqlite.SqliteException or IOException)
        {
            CrashHandler.WriteEntry("SendVrcxSummary", ex);
        }
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
