using System.Diagnostics;

namespace HapsHub.Core;

/// <summary>
/// Keeps a copy that was built from this repository up to date, like Discord does at launch: when the repository
/// has a newer commit than the one this copy was built from, HapsHub hands over to an updater that rebuilds it and
/// opens it again. Only a Release build sitting in the repository's own bin folder does this, and only when the
/// repository has no unfinished changes, so a half-done edit is never built.
/// </summary>
public static class SourceUpdate
{
    public const string StampFile = "source-commit.txt";
    public const string SkipArg = "--no-update-check";
    public const string UpdatedArg = "--updated";
    public const string FailedArg = "--update-failed";
    public const string FailedLogName = "update-failed.log";

    /// <summary>The repository this exe was built in: the folder above bin that holds the project and .git.</summary>
    public static string? RepositoryOf(string exeDir)
    {
        var dir = new DirectoryInfo(exeDir);
        // bin\Release\<framework>\ is three levels below the project.
        for (var i = 0; i < 4 && dir != null; i++, dir = dir.Parent)
        {
            if (File.Exists(Path.Combine(dir.FullName, "VRCNext.csproj")) && GitDir(dir.FullName) != null) return dir.FullName;
        }
        return null;
    }

    /// <summary>Only a Release build inside the repository updates itself; test and Debug copies never do.</summary>
    public static bool IsReleaseBuildIn(string repo, string exeDir)
    {
        var release = Path.GetFullPath(Path.Combine(repo, "bin", "Release")) + Path.DirectorySeparatorChar;
        return (Path.GetFullPath(exeDir) + Path.DirectorySeparatorChar).StartsWith(release, StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>The .git folder, following the pointer file a worktree has instead.</summary>
    public static string? GitDir(string repo)
    {
        var path = Path.Combine(repo, ".git");
        if (Directory.Exists(path)) return path;
        if (!File.Exists(path)) return null;
        var line = File.ReadAllText(path).Trim();
        if (!line.StartsWith("gitdir:", StringComparison.Ordinal)) return null;
        var target = line["gitdir:".Length..].Trim();
        target = Path.IsPathRooted(target) ? target : Path.GetFullPath(Path.Combine(repo, target));
        return Directory.Exists(target) ? target : null;
    }

    /// <summary>The commit the repository is on, read from .git without running git.</summary>
    public static string? HeadCommit(string gitDir)
    {
        var head = ReadTrimmed(Path.Combine(gitDir, "HEAD"));
        if (head == null) return null;
        if (!head.StartsWith("ref:", StringComparison.Ordinal)) return IsCommit(head) ? head : null;
        var name = head["ref:".Length..].Trim();
        // A worktree keeps its branches in the main repository.
        var common = ReadTrimmed(Path.Combine(gitDir, "commondir"));
        var roots = new List<string> { gitDir };
        if (common != null) roots.Add(Path.GetFullPath(Path.Combine(gitDir, common)));
        foreach (var root in roots)
        {
            var loose = ReadTrimmed(Path.Combine(root, name.Replace('/', Path.DirectorySeparatorChar)));
            if (loose != null && IsCommit(loose)) return loose;
        }
        foreach (var root in roots)
        {
            var packed = Path.Combine(root, "packed-refs");
            if (!File.Exists(packed)) continue;
            foreach (var line in File.ReadLines(packed))
            {
                var parts = line.Split(' ', 2);
                if (parts.Length == 2 && parts[1].Trim() == name && IsCommit(parts[0])) return parts[0];
            }
        }
        return null;
    }

    /// <summary>Whether to update: the repository moved on from the commit this copy was built from.</summary>
    public static bool Behind(string? builtFrom, string? head) =>
        builtFrom != null && head != null && IsCommit(builtFrom) && IsCommit(head)
        && !string.Equals(builtFrom, head, StringComparison.OrdinalIgnoreCase);

    public static bool IsCommit(string text) => text.Length == 40 && text.All(Uri.IsHexDigit);

    /// <summary>Tracked files with changes not committed yet. Null when git couldn't be asked.</summary>
    public static bool? HasUnfinishedChanges(string repo)
    {
        try
        {
            var info = new ProcessStartInfo("git") { UseShellExecute = false, RedirectStandardOutput = true, RedirectStandardError = true, CreateNoWindow = true };
            foreach (var arg in new[] { "-C", repo, "status", "--porcelain", "--untracked-files=no" }) info.ArgumentList.Add(arg);
            using var git = Process.Start(info);
            if (git == null) return null;
            var output = git.StandardOutput.ReadToEndAsync();
            if (!git.WaitForExit(5000)) { try { git.Kill(); } catch (InvalidOperationException) { } return null; }
            return git.ExitCode == 0 ? output.Result.Trim().Length > 0 : null;
        }
        catch (Exception ex) when (ex is System.ComponentModel.Win32Exception or InvalidOperationException)
        {
            return null;
        }
    }

    private static string? ReadTrimmed(string path)
    {
        try { return File.Exists(path) ? File.ReadAllText(path).Trim() : null; }
        catch (IOException) { return null; }
        catch (UnauthorizedAccessException) { return null; }
    }
}
