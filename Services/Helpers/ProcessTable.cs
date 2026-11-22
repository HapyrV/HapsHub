using System.Diagnostics;
using System.IO.Enumeration;
using System.Runtime.InteropServices;
using System.Text;

namespace VRCNext.Services.Helpers;

// Answers "is VRChat / SteamVR / Steam running?" from one look at the process list, shared for a second by every
// check. The SQLite watchdog (every 2 s), the VRChat monitor (3 s), crash rejoin (5 s), the tray and the page each
// asked on their own, and Process.GetProcessesByName takes a fresh snapshot of every process on each call:
// on Windows the whole system's process and thread list, on Linux every process's stat and status files.
// Here Windows lists processes by name only (Toolhelp), and Linux reads only each process's short name from /proc.
internal static class ProcessTable
{
    private const long MaxAgeMs = 1000;
    // Linux keeps 15 bytes of a process name; longer names need the full command line, which .NET reads.
    private const int LinuxShortNameLimit = 15;

    private static readonly object Gate = new();
    private static Dictionary<string, List<int>>? _byName;
    private static long _readAt = -1;

    public static bool IsRunning(string name) => Pids(name).Count > 0;

    /// <summary>Process ids for a name as Process.ProcessName gives it ("VRChat", not "VRChat.exe" on Windows).</summary>
    public static IReadOnlyList<int> Pids(string name)
    {
        if (OperatingSystem.IsLinux() && name.Length >= LinuxShortNameLimit) return PidsFromProcessApi(name);
        lock (Gate)
        {
            if (_readAt < 0 || Environment.TickCount64 - _readAt >= MaxAgeMs)
            {
                _byName = OperatingSystem.IsWindows() ? ReadWindows() : OperatingSystem.IsLinux() ? ReadLinux() : null;
                _readAt = Environment.TickCount64;
            }
            if (_byName == null) return PidsFromProcessApi(name);
            return _byName.TryGetValue(name, out var pids) ? pids : Array.Empty<int>();
        }
    }

    private static List<int> PidsFromProcessApi(string name)
    {
        var found = Process.GetProcessesByName(name);
        var ids = new List<int>(found.Length);
        foreach (var p in found) { using (p) ids.Add(p.Id); }
        return ids;
    }

    private static void Add(Dictionary<string, List<int>> byName, string name, int pid)
    {
        if (!byName.TryGetValue(name, out var list)) byName[name] = list = new List<int>(1);
        list.Add(pid);
    }

    // Windows

    private const uint TH32CS_SNAPPROCESS = 0x2;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct PROCESSENTRY32W
    {
        public uint dwSize;
        public uint cntUsage;
        public uint th32ProcessID;
        public IntPtr th32DefaultHeapID;
        public uint th32ModuleID;
        public uint cntThreads;
        public uint th32ParentProcessID;
        public int pcPriClassBase;
        public uint dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
        public string szExeFile;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr CreateToolhelp32Snapshot(uint dwFlags, uint th32ProcessID);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool Process32FirstW(IntPtr hSnapshot, ref PROCESSENTRY32W lppe);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool Process32NextW(IntPtr hSnapshot, ref PROCESSENTRY32W lppe);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr hObject);

    // Null when the snapshot can't be taken; the caller then asks .NET instead.
    private static Dictionary<string, List<int>>? ReadWindows()
    {
        var snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if (snap == IntPtr.Zero || snap == new IntPtr(-1)) return null;
        try
        {
            var byName = new Dictionary<string, List<int>>(StringComparer.OrdinalIgnoreCase);
            var entry = new PROCESSENTRY32W { dwSize = (uint)Marshal.SizeOf<PROCESSENTRY32W>() };
            if (!Process32FirstW(snap, ref entry)) return null;
            do
            {
                var exe = entry.szExeFile ?? "";
                // Process.ProcessName drops ".exe" and nothing else; match that so callers pass the same names
                var name = exe.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) ? exe[..^4] : exe;
                if (name.Length > 0) Add(byName, name, (int)entry.th32ProcessID);
            } while (Process32NextW(snap, ref entry));
            return byName;
        }
        finally { CloseHandle(snap); }
    }

    // Linux

    private static Dictionary<string, List<int>> ReadLinux()
    {
        var byName = new Dictionary<string, List<int>>(StringComparer.OrdinalIgnoreCase);
        Span<byte> buffer = stackalloc byte[64];
        foreach (var pid in EnumerateLinuxPids())
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
            Add(byName, Encoding.UTF8.GetString(buffer[..length]), pid);
        }
        return byName;
    }

    private static IEnumerable<int> EnumerateLinuxPids() =>
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
