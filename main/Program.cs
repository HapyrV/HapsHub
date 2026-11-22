using System.Runtime.InteropServices;
using VRCNext.Services;

namespace VRCNext;

static class Program
{
    // Stable AUMID
    // so the pin survives Velopack updates that move the exe to a new versioned folder.
    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    private static extern int SetCurrentProcessExplicitAppUserModelID(string appID);

    [DllImport("user32.dll")]
    private static extern bool AllowSetForegroundWindow(int processId);
    [DllImport("libc", EntryPoint = "setenv", SetLastError = true)]
    private static extern int LibcSetenv(string name, string value, int overwrite);

    [STAThread]
    static void Main(string[] args)
    {
        ApplyLinuxRenderingEnvironment();
        EnsureConfigRootExists();
        RemoveOldLinuxLayoutFiles();

        if (args.Length >= 4 && args[0] == "--watchdog")
        {
            if (!AcquireMutex("Global\\HapsHub_Watchdog" + HubPaths.InstanceSuffix, out var wdMutex)) return;
            using (wdMutex) WatchdogRunner.Run(args);
            return;
        }

        if (args.Length >= 1 && args[0] == "--vr-subprocess")
        {
            if (!AcquireMutex("Global\\HapsHub_VROverlay" + HubPaths.InstanceSuffix, out var vrMutex)) return;
            using (vrMutex) VRSubprocess.Run();
            return;
        }

        string? deepLink = Array.Find(args, a => a.StartsWith(DeepLinkService.Scheme + "://", StringComparison.OrdinalIgnoreCase));

        bool isRelaunch = false;
        int waitPidIdx = Array.IndexOf(args, "--waitpid");
        if (waitPidIdx >= 0 && waitPidIdx + 1 < args.Length &&
            int.TryParse(args[waitPidIdx + 1], out int waitPid))
        {
            isRelaunch = true;
            try { System.Diagnostics.Process.GetProcessById(waitPid).WaitForExit(10000); } catch { }
        }

        if (!AcquireMutex("Global\\HapsHub" + HubPaths.InstanceSuffix, out var mainMutex, waitMs: isRelaunch ? 10000 : 0))
        {
#if WINDOWS
            // This launch came from the user, so it may hand the foreground to the running app.
            AllowSetForegroundWindow(-1);
#endif
            if (deepLink != null) { DeepLinkService.Forward(deepLink); return; }
            if (DeepLinkService.Forward(DeepLinkService.ShowCommand)) return;
            ShowAlreadyRunningMessage();
            return;
        }
        using (mainMutex)
        {
            if (OperatingSystem.IsWindows())
                SetCurrentProcessExplicitAppUserModelID("com.hapshub.app");
#if WINDOWS
            if (!args.Contains(HapsHub.Core.SourceUpdate.SkipArg) && HandOffToUpdater(args)) return;
#endif
            CrashHandler.Register();
            Velopack.VelopackApp.Build().Run();
            new AppShell(args).Run();
        }
    }

#if WINDOWS
    /// <summary>
    /// When the repository this copy was built from has a newer commit, starts the updater and returns true so this
    /// copy closes. The updater rebuilds HapsHub and opens it again, or opens this version if the build fails.
    /// </summary>
    static bool HandOffToUpdater(string[] args)
    {
        try
        {
            // Throwaway test copies keep the version they were started as.
            if (!string.IsNullOrEmpty(Environment.GetEnvironmentVariable("HAPSHUB_DATA_DIR"))) return false;
            // The updater is a PowerShell script; Linux copies update from the Releases page.
            if (!OperatingSystem.IsWindows()) return false;
            var dir = AppContext.BaseDirectory;
            var exe = Environment.ProcessPath;
            var repo = HapsHub.Core.SourceUpdate.RepositoryOf(dir);
            if (exe == null || repo == null || !HapsHub.Core.SourceUpdate.IsReleaseBuildIn(repo, dir)) return false;
            var stamp = Path.Combine(dir, HapsHub.Core.SourceUpdate.StampFile);
            var builtFrom = File.Exists(stamp) ? File.ReadAllText(stamp).Trim() : null;
            var gitDir = HapsHub.Core.SourceUpdate.GitDir(repo);
            var head = gitDir == null ? null : HapsHub.Core.SourceUpdate.HeadCommit(gitDir);
            if (!HapsHub.Core.SourceUpdate.Behind(builtFrom, head)) return false;
            if (HapsHub.Core.SourceUpdate.HasUnfinishedChanges(repo) != false) return false;
            var script = Path.Combine(repo, "tools", "hapshub", "auto-update.ps1");
            if (!File.Exists(script)) return false;

            static string Quote(string value) => "\"" + value.Replace("\"", "\\\"") + "\"";
            var passOn = args.Where(a => a != HapsHub.Core.SourceUpdate.UpdatedArg && a != HapsHub.Core.SourceUpdate.FailedArg);
            var line = $"-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File {Quote(script)} -Root {Quote(repo)} -Exe {Quote(exe)} "
                + $"-WaitPid {Environment.ProcessId} -LogFile {Quote(HubPaths.Data("Logs", HapsHub.Core.SourceUpdate.FailedLogName))}";
            // PowerShell would read "--minimized" as one of its own parameters, so the arguments travel as one value.
            var rest = Convert.ToBase64String(System.Text.Encoding.UTF8.GetBytes(string.Join("\n", passOn)));
            if (rest.Length > 0) line += " -PassArgs " + rest;
            using var updater = System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo("powershell.exe", line)
            {
                UseShellExecute = true,
                // The script draws its own small update window, so the PowerShell console stays hidden.
                WindowStyle = System.Diagnostics.ProcessWindowStyle.Hidden,
            });
            return updater != null;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or System.ComponentModel.Win32Exception or InvalidOperationException)
        {
            return false;
        }
    }
#endif
    static void ApplyLinuxRenderingEnvironment()
    {
        if (!OperatingSystem.IsLinux()) return;
        // Turning WebKit's DMA-BUF renderer off copies every frame through system memory, so a full-screen window
        // lags even on a fast GPU. It used to be forced on every NVIDIA PC; now WebKit picks (distros that need the
        // NVIDIA workaround, like Debian and Ubuntu, build it into WebKit), and it's only turned off when asked:
        // by the user's own environment, run-hapshub.sh --safe-graphics, or Settings > Force Software Rendering.
        const string key = "WEBKIT_DISABLE_DMABUF_RENDERER";
        if (!string.IsNullOrEmpty(Environment.GetEnvironmentVariable(key))) return;
        if (IsLinuxSoftwareRenderingEnabled()) SetNativeEnvironmentVariable(key, "1");
    }

    // Linux builds used to ship about 190 separate .NET files (.dll and runtime .so files); they now live inside the
    // HapsHub program. Updating means unpacking over the old folder, which leaves the old files behind, so the first
    // start of the newer build clears them away. Photino.Native.so, libSkiaSharp.so, libe_sqlite3.so and libnfd.so stay.
    static void RemoveOldLinuxLayoutFiles()
    {
        if (!OperatingSystem.IsLinux()) return;
#pragma warning disable IL3000 // Location is empty exactly when this is the one-file build, the only case to tidy up
        if (!string.IsNullOrEmpty(typeof(Program).Assembly.Location)) return;
#pragma warning restore IL3000
        try
        {
            var dir = AppContext.BaseDirectory;
            if (!File.Exists(Path.Combine(dir, "HapsHub.dll"))) return;
            string[] leftovers = ["*.dll", "*.pdb", "HapsHub.deps.json", "HapsHub.runtimeconfig.json", "createdump",
                "libSystem.*.so", "libclr*.so", "libcoreclr*.so", "libhost*.so", "libmscord*.so"];
            foreach (var pattern in leftovers)
                foreach (var file in Directory.EnumerateFiles(dir, pattern, SearchOption.TopDirectoryOnly))
                {
                    try { File.Delete(file); }
                    catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { }
                }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { }
    }

    static void SetNativeEnvironmentVariable(string key, string value)
    {
        try { LibcSetenv(key, value, 1); } catch { }
        Environment.SetEnvironmentVariable(key, value);
    }

    static bool IsLinuxSoftwareRenderingEnabled()
    {
        try
        {
            var path = HubPaths.Data("settings.json");
            if (!File.Exists(path)) return false;
            var json = File.ReadAllText(path);
            return System.Text.RegularExpressions.Regex.IsMatch(json, "\"[Ll]inuxSoftwareRendering\"\\s*:\\s*true");
        }
        catch { return false; }
    }

    static void EnsureConfigRootExists()
    {
        if (OperatingSystem.IsWindows()) return;
        try
        {
            if (!string.IsNullOrEmpty(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData)))
                return;
            var xdg = Environment.GetEnvironmentVariable("XDG_CONFIG_HOME");
            var home = Environment.GetEnvironmentVariable("HOME");
            var cfg = !string.IsNullOrEmpty(xdg) ? xdg
                : !string.IsNullOrEmpty(home) ? Path.Combine(home, ".config") : "";
            if (!string.IsNullOrEmpty(cfg)) Directory.CreateDirectory(cfg);
        }
        catch { }
    }

    static bool AcquireMutex(string name, out Mutex mutex, int waitMs = 0)
    {
        mutex = new Mutex(initiallyOwned: true, name: name, out bool createdNew);
        if (createdNew) return true;

        if (waitMs > 0)
        {
            try { if (mutex.WaitOne(waitMs)) return true; }
            catch (AbandonedMutexException) { return true; }
        }

        mutex.Dispose();
        return false;
    }

    static void ShowAlreadyRunningMessage()
    {
        var text = GetAlreadyRunningMessage();
#if WINDOWS
        MessageBox.Show(text, AppInfo.AppName, MessageBoxButtons.OK, MessageBoxIcon.Information);
#else
        Console.Error.WriteLine(text);
        try
        {
            System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo
            {
                FileName = "notify-send",
                ArgumentList = { AppInfo.AppName, text.Replace('\n', ' ') },
                UseShellExecute = false,
            });
        }
        catch { }
#endif
    }

    static string GetAlreadyRunningMessage()
    {
        try
        {
            var path = HubPaths.Data("settings.json");
            var json = File.ReadAllText(path);
            var match = System.Text.RegularExpressions.Regex.Match(json, "\"[Ll]anguage\"\\s*:\\s*\"([^\"]+)\"");
            var lang = match.Success ? match.Groups[1].Value : "en";
            return lang switch
            {
                "de"    => "HapsHub läuft bereits.\nBitte schließe die laufende Instanz zuerst.",
                "es"    => "HapsHub ya está en ejecución.\nCierra la instancia en ejecución primero.",
                "fr"    => "HapsHub est déjà en cours d'exécution.\nVeuillez d'abord fermer l'instance en cours.",
                "ja"    => "HapsHubはすでに起動しています。\n実行中のインスタンスを先に閉じてください。",
                "zh-CN" => "HapsHub已在运行。\n请先关闭正在运行的实例。",
                _       => "HapsHub is already running.\nPlease close the running instance first.",
            };
        }
        catch
        {
            return "HapsHub is already running.\nPlease close the running instance first.";
        }
    }
}
