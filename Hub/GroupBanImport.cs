using System.Text.RegularExpressions;

namespace HapsHub.Core;

public enum BanOutcome { Done, Failed, RateLimited, SignedOut }

public sealed record BanPlan(IReadOnlyList<string> ToBan, int AlreadyBanned, bool SkippedSelf, int OverLimit);

public sealed record BanRunResult(IReadOnlyList<string> Done, IReadOnlyList<string> Failed, int NotTried, string StoppedBecause);

/// <summary>
/// Reads a pasted list of people and works through it one at a time. Bans are real, so a run
/// stops at the first sign VRChat won't take more, and nothing here decides anything alone:
/// the caller shows the plan and only runs what the user confirmed.
/// </summary>
public static class GroupBanImport
{
    public const int MaxPerRun = 500;
    public const int MaxFailuresInARow = 3;

    public const string StoppedCancelled = "cancelled";
    public const string StoppedRateLimited = "rate_limited";
    public const string StoppedSignedOut = "signed_out";
    public const string StoppedFailures = "failures";

    private static readonly Regex UserId = new(
        @"usr_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant | RegexOptions.Compiled);

    /// <summary>Every user ID in any text: a plain list, a CSV or a VRCX export. The first mention decides the order.</summary>
    public static IReadOnlyList<string> Parse(string? text)
    {
        if (string.IsNullOrEmpty(text)) return Array.Empty<string>();
        var seen = new HashSet<string>();
        var ids = new List<string>();
        foreach (Match match in UserId.Matches(text))
        {
            var id = match.Value.ToLowerInvariant();
            if (seen.Add(id)) ids.Add(id);
        }
        return ids;
    }

    public static BanPlan Plan(IEnumerable<string> ids, IEnumerable<string> alreadyBanned, string? selfId)
    {
        var banned = new HashSet<string>(alreadyBanned, StringComparer.OrdinalIgnoreCase);
        var toBan = new List<string>();
        int already = 0, over = 0;
        var skippedSelf = false;
        foreach (var id in ids)
        {
            if (string.Equals(id, selfId, StringComparison.OrdinalIgnoreCase)) skippedSelf = true;
            else if (banned.Contains(id)) already++;
            else if (toBan.Count >= MaxPerRun) over++;
            else toBan.Add(id);
        }
        return new BanPlan(toBan, already, skippedSelf, over);
    }

    /// <summary>
    /// Calls <paramref name="action"/> for each ID with a pause between them. A repeat run after a
    /// stop is safe, since the next plan leaves out whoever is already banned.
    /// </summary>
    public static async Task<BanRunResult> RunAsync(
        IReadOnlyList<string> ids,
        Func<string, CancellationToken, Task<BanOutcome>> action,
        TimeSpan pause,
        Action<int, int>? progress = null,
        CancellationToken cancellationToken = default)
    {
        var done = new List<string>();
        var failed = new List<string>();
        var failuresInARow = 0;
        var stopped = "";
        var tried = 0;
        foreach (var id in ids)
        {
            try
            {
                if (tried > 0) await Task.Delay(pause, cancellationToken);
                cancellationToken.ThrowIfCancellationRequested();
                var outcome = await action(id, cancellationToken);
                if (outcome == BanOutcome.RateLimited) { stopped = StoppedRateLimited; break; }
                if (outcome == BanOutcome.SignedOut) { stopped = StoppedSignedOut; break; }
                tried++;
                if (outcome == BanOutcome.Done)
                {
                    done.Add(id);
                    failuresInARow = 0;
                }
                else
                {
                    failed.Add(id);
                    if (++failuresInARow >= MaxFailuresInARow) stopped = StoppedFailures;
                }
                progress?.Invoke(tried, ids.Count);
                if (stopped.Length > 0) break;
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                stopped = StoppedCancelled;
                break;
            }
            catch (Exception)
            {
                // A dropped connection or timeout must not lose the record of who was already done.
                tried++;
                failed.Add(id);
                if (++failuresInARow >= MaxFailuresInARow) stopped = StoppedFailures;
                progress?.Invoke(tried, ids.Count);
                if (stopped.Length > 0) break;
            }
        }
        return new BanRunResult(done, failed, ids.Count - tried, stopped);
    }
}
