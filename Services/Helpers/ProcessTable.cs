using System.Diagnostics;
using System.IO.Enumeration;
using System.Text;

namespace VRCNext.Services.Helpers;

// Linux: answers "is VRChat / SteamVR / Steam running?" from one pass over /proc that reads only each process's
// short name, shared for a second by every check. Process.GetProcessesByName reads every process's stat and status
// files on each call, and the tray, the VRChat monitor and crash rejoin asked for several names every few seconds.
internal static class LinuxProcessTable
{
    private const long MaxAgeMs = 1000;
    // The kernel keeps 15 bytes of a process name; longer names need the full command line, which .NET reads.
    private const int ShortNameLimit = 15;

    private static readonly object Gate = new();
    private static Dictionary<string, List<int>> _byName = new(StringComparer.OrdinalIgnoreCase);
    private static long _readAt = -1;

    public static bool IsRunning(string name) => Pids(name).Count > 0;

    public static IReadOnlyList<int> Pids(string name)
    {
        if (name.Length >= ShortNameLimit)
        {
            var found = Process.GetProcessesByName(name);
            var ids = new List<int>(found.Length);
            foreach (var p in found) { using (p) ids.Add(p.Id); }
            return ids;
        }
        lock (Gate)
        {
            if (_readAt < 0 || Environment.TickCount64 - _readAt >= MaxAgeMs)
            {
                _byName = Read();
                _readAt = Environment.TickCount64;
            }
            return _byName.TryGetValue(name, out var pids) ? pids : Array.Empty<int>();
        }
    }

    private static Dictionary<string, List<int>> Read()
    {
        var byName = new Dictionary<string, List<int>>(StringComparer.OrdinalIgnoreCase);
        Span<byte> buffer = stackalloc byte[64];
        foreach (var pid in EnumeratePids())
        {
            int length;
            try
            {
                using var handle = File.OpenHandle($"/proc/{pid}/comm");
                length = RandomAccess.Read(handle, buffer, 0);
            }
            catch (IOException) { continue; }                  // the process ended during the pass
            catch (UnauthorizedAccessException) { continue; }
            while (length > 0 && buffer[length - 1] is (byte)'\n' or 0) length--;
            if (length == 0) continue;
            var name = Encoding.UTF8.GetString(buffer[..length]);
            if (!byName.TryGetValue(name, out var list)) byName[name] = list = new List<int>(1);
            list.Add(pid);
        }
        return byName;
    }

    private static IEnumerable<int> EnumeratePids() =>
        new FileSystemEnumerable<int>("/proc", (ref FileSystemEntry entry) => int.Parse(entry.FileName),
            new EnumerationOptions { RecurseSubdirectories = false, IgnoreInaccessible = true, AttributesToSkip = 0 })
        {
            ShouldIncludePredicate = (ref FileSystemEntry entry) => entry.IsDirectory && IsPid(entry.FileName),
        };

    private static bool IsPid(ReadOnlySpan<char> name)
    {
        if (name.IsEmpty || name.Length > 9) return false;
        foreach (var c in name)
            if (c is < '0' or > '9') return false;
        return true;
    }
}
