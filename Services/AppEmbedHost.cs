#if WINDOWS
using System.Collections.Concurrent;
using System.ComponentModel;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using HapsHub.Core;

namespace VRCNext.Services;

public sealed record EmbedStatus(string State, string Mode, string Message);

/// <summary>
/// Holds other apps' windows inside a pane of the HapsHub window, or, when that doesn't work, keeps them
/// borderless on top of the pane. Everything runs on one worker thread, so a stuck app can't stall the page.
/// Nothing here ever activates a window: a game with focus keeps it.
/// </summary>
public sealed class AppEmbedHost : IDisposable
{
    private static readonly TimeSpan StartLimit = TimeSpan.FromSeconds(45);
    private static readonly TimeSpan HungLimit = TimeSpan.FromSeconds(5);
    private const int TickMs = 100;

    private sealed class Slot(EmbedApp app)
    {
        public EmbedApp App { get; } = app;
        public string State = "idle";
        public string Message = "";
        public string Mode = AppEmbedsModule.ModeChild;
        public string Exe = "";
        public DateTime StartDeadline;
        public nint Window;
        public int Pid;
        public bool Attached;
        public nint SavedStyle, SavedExStyle;
        public bool SavedVisible;
        public WINDOWPLACEMENT SavedPlacement;
        public EmbedRect? Pane;
        public bool PaneVisible;
        /// <summary>Where hub menus cover the pane, in pane pixels. The window gets a hole there so the menu shows through.</summary>
        public IReadOnlyList<EmbedRect> Holes = Array.Empty<EmbedRect>();
        public string AppliedRegion = "";
        public DateTime? HungSince;
        public bool Testing;
        /// <summary>A copy that was already running was started without HapsHub's drawing fix.</summary>
        public bool StartedHere;
    }

    private readonly BlockingCollection<Action> _work = new();
    private readonly Dictionary<string, Slot> _slots = new();
    private readonly Func<nint> _hostWindow;
    /// <summary>Copies HapsHub started itself, so with the drawing fix. Only the worker touches it.</summary>
    private readonly HashSet<int> _launched = new();
    private readonly Thread _thread;
    private nint _host;
    private volatile bool _stopped;

    /// <summary>Runs on the worker thread whenever an app's state changes.</summary>
    public Action<EmbedApp, EmbedStatus>? Changed { get; set; }

    public AppEmbedHost(Func<nint> hostWindow)
    {
        _hostWindow = hostWindow;
        foreach (var app in AppEmbedsModule.Apps) _slots[app.Id] = new Slot(app);
        _thread = new Thread(Loop) { IsBackground = true, Name = "HapsHub app embeds" };
        _thread.Start();
    }

    /// <summary>Safe from any thread, the worker included, so it never waits for the worker.</summary>
    public EmbedStatus Status(EmbedApp app) => StatusOf(_slots[app.Id]);

    public void Start(EmbedApp app, string exe, string mode) => Post(() =>
    {
        var slot = _slots[app.Id];
        if (slot.Attached || slot.State == "starting") return;
        slot.Mode = mode;
        slot.Exe = exe;
        slot.Message = "";
        slot.State = "starting";
        slot.StartDeadline = DateTime.UtcNow + StartLimit;
        // Reuses a running copy, and only starts one when there is none. Eagle keeps a single copy anyway.
        var running = Process.GetProcessesByName(app.ProcessName).Select(p => { using (p) return p.Id; }).ToList();
        slot.StartedHere = running.Count == 0 || running.Any(_launched.Contains);
        if (running.Count == 0)
        {
            try
            {
                var start = new ProcessStartInfo(exe) { UseShellExecute = false, WorkingDirectory = Path.GetDirectoryName(exe) ?? "" };
                if (app.Chromium == EmbedApp.WebView2) start.Environment["WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS"] = EmbedWindows.ChromiumArguments;
                else if (app.Chromium == EmbedApp.Electron) start.Arguments = EmbedWindows.ChromiumArguments;
                using var started = Process.Start(start);
                if (started != null) _launched.Add(started.Id);
            }
            catch (Exception ex) when (ex is Win32Exception or InvalidOperationException or FileNotFoundException)
            {
                Fail(slot, $"{app.Name} wouldn't start: {ex.Message}");
                return;
            }
        }
        Notify(slot);
    });

    public void SetPane(EmbedApp app, EmbedRect? pane, bool visible) => Post(() =>
    {
        var slot = _slots[app.Id];
        slot.Pane = pane;
        slot.PaneVisible = visible && pane is { Usable: true };
        if (slot.Attached) Place(slot);
    });

    /// <summary>Puts the app back as a normal window of its own.</summary>
    public void Release(EmbedApp app) => Post(() =>
    {
        var slot = _slots[app.Id];
        Detach(slot);
        slot.State = "idle";
        slot.Message = "";
        Notify(slot);
    });

    /// <summary>Cuts holes where hub menus cover the pane, so they show through the app's window. Empty closes them.</summary>
    public void SetHoles(EmbedApp app, IReadOnlyList<EmbedRect> holes) => Post(() =>
    {
        var slot = _slots[app.Id];
        slot.Holes = holes;
        if (slot.Attached) Place(slot);
    });

    /// <summary>Tries the app in the pane in the given mode. The pane must be on screen, since that's what is being tested.</summary>
    public async Task<IReadOnlyList<EmbedCheck>> TestAsync(EmbedApp app, string exe, string mode)
    {
        var checks = new List<EmbedCheck>();
        void Add(string name, bool passed, string detail = "") => checks.Add(new EmbedCheck(name, passed, detail));

        var slot = _slots[app.Id];
        await Run(() => { slot.Testing = true; Detach(slot); slot.Holes = Array.Empty<EmbedRect>(); slot.State = "idle"; return 0; });
        try
        {
            var paneShown = await Run(() => slot.PaneVisible && slot.Pane != null);
            Add("The pane is on screen", paneShown);
            if (!paneShown) return checks;
            var pane = await Run(() => slot.Pane!);

            var foreground = GetForegroundWindow();
            Start(app, exe, mode);
            var end = DateTime.UtcNow + StartLimit;
            while (DateTime.UtcNow < end && !await Run(() => slot.Attached || slot.State == "failed")) await Task.Delay(200);
            var attached = await Run(() => slot.Attached);
            var problem = await Run(() => slot.Message);
            Add("Its window was found and taken in", attached, problem);
            if (!attached) return checks;

            await Task.Delay(1500);
            var parent = await Run(() => GetParent(slot.Window));
            Add(mode == AppEmbedsModule.ModeChild ? "It's held inside the pane" : "It's a window of its own",
                mode == AppEmbedsModule.ModeChild ? parent == _host : parent == 0, $"parent {parent}");
            // A held window's focus is inside HapsHub, so compare top-level windows.
            // Taking focus back across the shared input of a held window can lock all three apps up, so it's never
            // tried. An app grabbing focus for itself while it starts is the app, not HapsHub moving it elsewhere.
            var nowForeground = GetForegroundWindow();
            var appPid = await Run(() => slot.Pid);
            GetWindowThreadProcessId(nowForeground, out var focusPid);
            Add("Focus stayed where it was",
                GetAncestor(nowForeground, GA_ROOT) == GetAncestor(foreground, GA_ROOT) || (int)focusPid == appPid,
                $"now on {Describe(nowForeground)}, was on {Describe(foreground)}");

            var placed = await Run(() => WindowIn(slot));
            Add("It fills the pane", placed.Matches(pane), $"{placed} in {pane}");

            var smaller = pane with { Width = pane.Width - 60, Height = pane.Height - 60 };
            SetPane(app, smaller, true);
            await Task.Delay(700);
            var followed = await Run(() => WindowIn(slot));
            Add("It follows the pane's size", followed.Matches(smaller), $"{followed} in {smaller}");
            SetPane(app, pane, true);
            await Task.Delay(700);

            var hole = new EmbedRect(10, 10, Math.Max(1, pane.Width / 3), Math.Max(1, pane.Height / 3));
            SetHoles(app, new[] { hole });
            await Task.Delay(400);
            Add("It opens a hole for hub menus", await Run(() => RegionHas(slot.Window, pane.Width - 5, pane.Height - 5) && !RegionHas(slot.Window, hole.X + 5, hole.Y + 5)));
            SetHoles(app, Array.Empty<EmbedRect>());
            await Task.Delay(400);
            Add("The hole closes after a menu", await Run(() => RegionHas(slot.Window, hole.X + 5, hole.Y + 5)));

            await Task.Delay(1000);
            var (drawn, colours, startedHere) = await Run(() =>
            {
                using var picture = Capture(slot);
                var count = picture == null ? 0 : Samples(picture).Distinct().Count();
                return (picture != null && EmbedWindows.LooksDrawn(Samples(picture)), count, slot.StartedHere);
            });
            Add("It draws its page", drawn, startedHere
                ? $"{colours} colour(s) in the picture"
                : $"{colours} colour(s); it was already running, so close {app.Name} and test again to let HapsHub start it");

            await Task.Delay(3000);
            var (exists, hung) = await Run(() => (IsWindow(slot.Window), IsHungAppWindow(slot.Window)));
            Add("It's still running and responding", exists && !hung, !exists ? "its window is gone" : "it isn't responding");
            return checks;
        }
        finally
        {
            await Run(() => { slot.Testing = false; return 0; });
        }
    }

    /// <summary>Hands every window back now. Safe from any thread, because a parent's end would take its children along.</summary>
    public void ReleaseAll()
    {
        foreach (var slot in _slots.Values)
        {
            try { Detach(slot); }
            catch (Exception ex) when (ex is Win32Exception or InvalidOperationException) { CrashHandler.WriteEntry("hubEmbedRelease", ex); }
        }
    }

    public void Dispose()
    {
        if (_stopped) return;
        var done = new ManualResetEventSlim();
        Post(() => { ReleaseAll(); done.Set(); });
        done.Wait(TimeSpan.FromSeconds(3));
        _stopped = true;
        _work.CompleteAdding();
    }

    private void Post(Action action)
    {
        if (!_stopped) _work.Add(action);
    }

    private Task<T> Run<T>(Func<T> action)
    {
        var result = new TaskCompletionSource<T>(TaskCreationOptions.RunContinuationsAsynchronously);
        Post(() =>
        {
            try { result.TrySetResult(action()); }
            catch (Exception ex) { result.TrySetException(ex); }
        });
        return result.Task;
    }

    private void Loop()
    {
        while (!_stopped)
        {
            try
            {
                if (_work.TryTake(out var action, TickMs)) action();
                else Tick();
            }
            catch (InvalidOperationException) when (_work.IsAddingCompleted)
            {
                return;
            }
            catch (Exception ex)
            {
                CrashHandler.WriteEntry("hubEmbedWorker", ex);
            }
        }
    }

    private void Tick()
    {
        foreach (var slot in _slots.Values)
        {
            if (slot.State == "starting") TryAttach(slot);
            else if (slot.Attached) Watch(slot);
        }
    }

    private void TryAttach(Slot slot)
    {
        if (DateTime.UtcNow > slot.StartDeadline)
        {
            Fail(slot, $"{slot.App.Name} didn't open a window in time.");
            return;
        }
        // Wait until the page is showing, so the window never flashes somewhere else.
        if (!slot.PaneVisible || slot.Pane == null) return;

        var pids = Process.GetProcessesByName(slot.App.ProcessName).Select(p => { using (p) return p.Id; }).ToHashSet();
        if (pids.Count == 0) return;
        var found = EmbedWindows.Pick(CandidatesOf(pids));
        if (found == null) return;

        GetWindowThreadProcessId(found.Handle, out var pid);
        if (IsElevated((int)pid) && !IsElevated(Environment.ProcessId))
        {
            Fail(slot, $"{slot.App.Name} runs as administrator, so HapsHub can't hold its window. Run it normally to use it here.");
            return;
        }
        if (_host == 0) _host = _hostWindow();
        if (_host == 0) return;
        Attach(slot, found.Handle, (int)pid);
    }

    private void Attach(Slot slot, nint window, int pid)
    {
        slot.Window = window;
        slot.Pid = pid;
        slot.SavedStyle = GetWindowLongPtr(window, GWL_STYLE);
        slot.SavedExStyle = GetWindowLongPtr(window, GWL_EXSTYLE);
        slot.SavedVisible = IsWindowVisible(window);
        slot.SavedPlacement = new WINDOWPLACEMENT { length = Marshal.SizeOf<WINDOWPLACEMENT>() };
        GetWindowPlacement(window, ref slot.SavedPlacement);

        if (IsIconic(window) || IsZoomed(window)) ShowWindow(window, SW_SHOWNOACTIVATE);

        var style = slot.SavedStyle & ~(nint)(WS_CAPTION | WS_THICKFRAME | WS_MINIMIZEBOX | WS_MAXIMIZEBOX | WS_SYSMENU);
        // Edges drawn by Windows were the thin white outline around a held app.
        var exStyle = slot.SavedExStyle & ~(nint)(WS_EX_DLGMODALFRAME | WS_EX_WINDOWEDGE | WS_EX_CLIENTEDGE | WS_EX_STATICEDGE);
        if (slot.Mode == AppEmbedsModule.ModeChild)
        {
            style = (style & ~unchecked((nint)WS_POPUP)) | (nint)WS_CHILD;
            SetWindowLongPtr(window, GWL_STYLE, style);
            SetWindowLongPtr(window, GWL_EXSTYLE, exStyle);
            var error = SetParentChecked(window, _host);
            if (error != 0)
            {
                SetWindowLongPtr(window, GWL_STYLE, slot.SavedStyle);
                SetWindowLongPtr(window, GWL_EXSTYLE, slot.SavedExStyle);
                Fail(slot, $"Windows wouldn't let HapsHub hold {slot.App.Name} (error {error}).");
                return;
            }
        }
        else
        {
            SetWindowLongPtr(window, GWL_STYLE, style | unchecked((nint)WS_POPUP));
            // A tool window stays off the taskbar. It has no owner on purpose: an owner's end would destroy it.
            SetWindowLongPtr(window, GWL_EXSTYLE, exStyle | (nint)WS_EX_TOOLWINDOW);
        }

        slot.Attached = true;
        slot.State = "open";
        slot.AppliedRegion = "";
        slot.Message = slot.StartedHere || slot.App.Chromium == EmbedApp.NoChromium ? "" : $"{slot.App.Name} was already running, so it may stay blank here. Close it and press Open here to let HapsHub start it.";
        slot.HungSince = null;
        SetWindowPos(window, 0, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED);
        Place(slot);
        Notify(slot);
    }

    private static int SetParentChecked(nint window, nint parent)
    {
        Marshal.SetLastPInvokeError(0);
        var previous = SetParent(window, parent);
        var error = previous == 0 ? Marshal.GetLastPInvokeError() : 0;
        if (error != 0) return error;
        return GetParent(window) == parent ? 0 : -1;
    }

    private void Watch(Slot slot)
    {
        if (!IsWindow(slot.Window))
        {
            slot.Attached = false;
            slot.Window = 0;
            slot.State = "idle";
            slot.Message = $"{slot.App.Name} was closed.";
            Notify(slot);
            return;
        }
        if (IsHungAppWindow(slot.Window))
        {
            slot.HungSince ??= DateTime.UtcNow;
            // A held window shares its input with HapsHub, so one that hangs would soon take the app along.
            if (slot.Mode == AppEmbedsModule.ModeChild && DateTime.UtcNow - slot.HungSince > HungLimit && !slot.Testing)
            {
                Detach(slot);
                Fail(slot, $"{slot.App.Name} stopped responding, so it was put back in its own window.");
            }
            return;
        }
        slot.HungSince = null;
        Place(slot);
    }

    private void Place(Slot slot)
    {
        if (!slot.Attached || !IsWindow(slot.Window)) return;
        var hostShown = IsWindowVisible(_host) && !IsIconic(_host);
        if (!slot.PaneVisible || slot.Pane == null || !hostShown)
        {
            if (IsWindowVisible(slot.Window)) ShowWindowAsync(slot.Window, SW_HIDE);
            return;
        }

        var pane = slot.Pane;
        var child = slot.Mode == AppEmbedsModule.ModeChild;
        // Its own window sits directly above HapsHub: on top of the page, and never in front of whatever is above HapsHub.
        var above = child ? 0 : GetWindow(_host, GW_HWNDPREV);
        var stacked = child || above == slot.Window;
        ApplyRegion(slot, pane);
        var inPlace = IsWindowVisible(slot.Window) && WindowIn(slot).Matches(pane, 0);
        if (inPlace && stacked) return;

        var flags = SWP_NOACTIVATE | SWP_ASYNCWINDOWPOS | SWP_SHOWWINDOW;
        var after = HWND_TOP;
        var x = pane.X;
        var y = pane.Y;
        if (!child)
        {
            var origin = new POINT { X = pane.X, Y = pane.Y };
            ClientToScreen(_host, ref origin);
            x = origin.X;
            y = origin.Y;
            if (stacked) flags |= SWP_NOZORDER;
            // Going behind an always-on-top window would make it always-on-top too, so it takes the top of the normal ones.
            else if (above != 0 && (GetWindowLongPtr(above, GWL_EXSTYLE) & WS_EX_TOPMOST) == 0) after = above;
        }
        SetWindowPos(slot.Window, after, x, y, pane.Width, pane.Height, flags);
    }

    /// <summary>
    /// The window's shape: the whole pane minus the holes. Set only when it changes, since Windows redraws the window each time.
    /// The frame is gone, so the window's own coordinates are the pane's.
    /// </summary>
    private static void ApplyRegion(Slot slot, EmbedRect pane)
    {
        var holes = slot.Holes.Where(h => h.Width > 0 && h.Height > 0).ToList();
        var key = holes.Count == 0 ? "" : $"{pane.Width}x{pane.Height}:" + string.Join(";", holes);
        if (key == slot.AppliedRegion) return;
        nint region = 0;
        if (holes.Count > 0)
        {
            region = CreateRectRgn(0, 0, pane.Width, pane.Height);
            foreach (var hole in holes)
            {
                var cut = CreateRectRgn(hole.X, hole.Y, hole.X + hole.Width, hole.Y + hole.Height);
                CombineRgn(region, region, cut, RGN_DIFF);
                DeleteObject(cut);
            }
        }
        // Windows owns the region once it's set, so it's only deleted when setting it failed.
        if (SetWindowRgn(slot.Window, region, true) == 0 && region != 0) DeleteObject(region);
        slot.AppliedRegion = key;
    }

    /// <summary>Whether a point of the window is part of its shape. A window without a region has all of it.</summary>
    private static bool RegionHas(nint window, int x, int y)
    {
        var region = CreateRectRgn(0, 0, 0, 0);
        try { return GetWindowRgn(window, region) == ERROR_REGION || PtInRegion(region, x, y); }
        finally { DeleteObject(region); }
    }

    /// <summary>Where the window is, in the host's client coordinates, to compare with the pane.</summary>
    private EmbedRect WindowIn(Slot slot)
    {
        GetWindowRect(slot.Window, out var rect);
        var origin = new POINT();
        ClientToScreen(_host, ref origin);
        return new EmbedRect(rect.Left - origin.X, rect.Top - origin.Y, rect.Right - rect.Left, rect.Bottom - rect.Top);
    }

    private void Detach(Slot slot)
    {
        if (!slot.Attached) return;
        slot.Attached = false;
        var window = slot.Window;
        slot.Window = 0;
        slot.AppliedRegion = "";
        if (!IsWindow(window)) return;

        SetWindowRgn(window, 0, false);
        if (slot.Mode == AppEmbedsModule.ModeChild) SetParent(window, 0);
        SetWindowLongPtr(window, GWL_STYLE, slot.SavedStyle);
        SetWindowLongPtr(window, GWL_EXSTYLE, slot.SavedExStyle);
        var placement = slot.SavedPlacement;
        // Never activates, and a maximized window comes back at its normal size rather than taking focus.
        placement.showCmd = !slot.SavedVisible ? SW_HIDE : placement.showCmd == SW_SHOWMINIMIZED ? SW_SHOWMINNOACTIVE : SW_SHOWNOACTIVATE;
        SetWindowPlacement(window, ref placement);
        SetWindowPos(window, 0, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED);
    }

    private void Fail(Slot slot, string message)
    {
        slot.State = "failed";
        slot.Message = message;
        Notify(slot);
    }

    private void Notify(Slot slot)
    {
        try { Changed?.Invoke(slot.App, StatusOf(slot)); }
        catch (Exception ex) { CrashHandler.WriteEntry("hubEmbedNotify", ex); }
    }

    private static EmbedStatus StatusOf(Slot slot) => new(slot.State, slot.Mode, slot.Message);

    private static List<EmbedCandidate> CandidatesOf(HashSet<int> pids)
    {
        var found = new List<EmbedCandidate>();
        EnumWindows((window, _) =>
        {
            GetWindowThreadProcessId(window, out var pid);
            if (!pids.Contains((int)pid)) return true;
            GetWindowRect(window, out var rect);
            var length = GetWindowTextLength(window);
            var title = new char[length + 1];
            var read = GetWindowText(window, title, title.Length);
            found.Add(new EmbedCandidate(window, IsWindowVisible(window), new string(title, 0, Math.Max(read, 0)),
                rect.Right - rect.Left, rect.Bottom - rect.Top, GetWindow(window, GW_OWNER) != 0,
                (GetWindowLongPtr(window, GWL_EXSTYLE) & WS_EX_TOOLWINDOW) != 0));
            return true;
        }, 0);
        return found;
    }

    private static bool IsElevated(int pid)
    {
        var process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
        // Windows refuses this for a process above us, which is itself the answer.
        if (process == 0) return Marshal.GetLastPInvokeError() == ERROR_ACCESS_DENIED;
        try
        {
            if (!OpenProcessToken(process, TOKEN_QUERY, out var token)) return Marshal.GetLastPInvokeError() == ERROR_ACCESS_DENIED;
            try
            {
                return GetTokenInformation(token, TOKEN_ELEVATION_CLASS, out var elevated, sizeof(int), out _) && elevated != 0;
            }
            finally { CloseHandle(token); }
        }
        finally { CloseHandle(process); }
    }

    private Bitmap? Capture(Slot slot)
    {
        GetWindowRect(slot.Window, out var rect);
        int width = rect.Right - rect.Left, height = rect.Bottom - rect.Top;
        if (width <= 0 || height <= 0 || IsHungAppWindow(slot.Window)) return null;
        var picture = new Bitmap(width, height, PixelFormat.Format32bppRgb);
        using (var surface = Graphics.FromImage(picture))
        {
            var dc = surface.GetHdc();
            try { PrintWindow(slot.Window, dc, PW_RENDERFULLCONTENT); }
            finally { surface.ReleaseHdc(dc); }
            // Apps that draw with the GPU can print blank. On screen and in front, the screen itself has the picture.
            if (!EmbedWindows.LooksDrawn(Samples(picture)) && GetForegroundWindow() == _host && IsWindowVisible(slot.Window))
                surface.CopyFromScreen(rect.Left, rect.Top, 0, 0, new Size(width, height));
        }
        return picture;
    }

    private static string Describe(nint window)
    {
        if (window == 0) return "nothing";
        GetWindowThreadProcessId(window, out var pid);
        var title = new char[128];
        var read = GetWindowText(window, title, title.Length);
        string name;
        try { using var process = Process.GetProcessById((int)pid); name = process.ProcessName; }
        catch (ArgumentException) { name = $"process {pid}"; }
        return $"{name} \"{new string(title, 0, Math.Max(read, 0))}\"{(GetParent(window) != 0 ? " (held)" : "")}";
    }

    private static IEnumerable<int> Samples(Bitmap picture)
    {
        for (var row = 1; row <= 8; row++)
            for (var column = 1; column <= 8; column++)
                yield return picture.GetPixel(picture.Width * column / 9, picture.Height * row / 9).ToArgb();
    }

    private const int GWL_STYLE = -16, GWL_EXSTYLE = -20, GW_OWNER = 4, GW_HWNDPREV = 3, GA_ROOT = 2;
    private const int SW_HIDE = 0, SW_SHOWMINIMIZED = 2, SW_SHOWNOACTIVATE = 4, SW_SHOWMINNOACTIVE = 7;
    private const long WS_CHILD = 0x40000000, WS_POPUP = 0x80000000, WS_CAPTION = 0x00C00000, WS_THICKFRAME = 0x00040000,
        WS_MINIMIZEBOX = 0x00020000, WS_MAXIMIZEBOX = 0x00010000, WS_SYSMENU = 0x00080000, WS_EX_TOOLWINDOW = 0x00000080, WS_EX_TOPMOST = 0x00000008,
        WS_EX_DLGMODALFRAME = 0x00000001, WS_EX_WINDOWEDGE = 0x00000100, WS_EX_CLIENTEDGE = 0x00000200, WS_EX_STATICEDGE = 0x00020000;
    private const int RGN_DIFF = 4, ERROR_REGION = 0;
    private const uint SWP_NOSIZE = 0x1, SWP_NOMOVE = 0x2, SWP_NOZORDER = 0x4, SWP_NOACTIVATE = 0x10, SWP_FRAMECHANGED = 0x20,
        SWP_SHOWWINDOW = 0x40, SWP_ASYNCWINDOWPOS = 0x4000;
    private const nint HWND_TOP = 0;
    private const uint PW_RENDERFULLCONTENT = 2, PROCESS_QUERY_LIMITED_INFORMATION = 0x1000, TOKEN_QUERY = 0x8;
    private const int TOKEN_ELEVATION_CLASS = 20, ERROR_ACCESS_DENIED = 5;

    [StructLayout(LayoutKind.Sequential)] private struct RECT { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] private struct POINT { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)]
    private struct WINDOWPLACEMENT { public int length, flags, showCmd; public POINT minPosition, maxPosition; public RECT normalPosition; }

    private delegate bool EnumWindowsProc(nint window, nint param);

    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc callback, nint param);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(nint window, out uint pid);
    [DllImport("user32.dll", EntryPoint = "GetWindowTextLengthW")] private static extern int GetWindowTextLength(nint window);
    [DllImport("user32.dll", EntryPoint = "GetWindowTextW", CharSet = CharSet.Unicode)] private static extern int GetWindowText(nint window, [Out] char[] text, int count);
    [DllImport("user32.dll")] private static extern nint GetWindow(nint window, int command);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] private static extern nint GetWindowLongPtr(nint window, int index);
    [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")] private static extern nint SetWindowLongPtr(nint window, int index, nint value);
    [DllImport("user32.dll", SetLastError = true)] private static extern nint SetParent(nint window, nint parent);
    [DllImport("user32.dll")] private static extern nint GetParent(nint window);
    [DllImport("user32.dll")] private static extern bool SetWindowPos(nint window, nint after, int x, int y, int width, int height, uint flags);
    [DllImport("user32.dll")] private static extern bool GetWindowRect(nint window, out RECT rect);
    [DllImport("user32.dll")] private static extern bool ClientToScreen(nint window, ref POINT point);
    [DllImport("user32.dll")] private static extern bool GetWindowPlacement(nint window, ref WINDOWPLACEMENT placement);
    [DllImport("user32.dll")] private static extern bool SetWindowPlacement(nint window, ref WINDOWPLACEMENT placement);
    [DllImport("user32.dll")] private static extern bool ShowWindow(nint window, int command);
    [DllImport("user32.dll")] private static extern bool ShowWindowAsync(nint window, int command);
    [DllImport("user32.dll")] private static extern bool IsWindow(nint window);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(nint window);
    [DllImport("user32.dll")] private static extern bool IsIconic(nint window);
    [DllImport("user32.dll")] private static extern bool IsZoomed(nint window);
    [DllImport("user32.dll")] private static extern bool IsHungAppWindow(nint window);
    [DllImport("user32.dll")] private static extern nint GetForegroundWindow();
    [DllImport("user32.dll")] private static extern nint GetAncestor(nint window, uint flags);
    [DllImport("user32.dll")] private static extern bool PrintWindow(nint window, nint dc, uint flags);
    [DllImport("gdi32.dll")] private static extern nint CreateRectRgn(int left, int top, int right, int bottom);
    [DllImport("gdi32.dll")] private static extern int CombineRgn(nint destination, nint first, nint second, int mode);
    [DllImport("gdi32.dll")] private static extern bool DeleteObject(nint handle);
    [DllImport("gdi32.dll")] private static extern bool PtInRegion(nint region, int x, int y);
    [DllImport("user32.dll")] private static extern int SetWindowRgn(nint window, nint region, bool redraw);
    [DllImport("user32.dll")] private static extern int GetWindowRgn(nint window, nint region);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern nint OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(nint handle);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool OpenProcessToken(nint process, uint access, out nint token);
    [DllImport("advapi32.dll", SetLastError = true)] private static extern bool GetTokenInformation(nint token, int kind, out int value, int size, out int returned);
}
#endif
