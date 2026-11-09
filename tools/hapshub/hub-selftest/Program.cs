// Self-test for the Hub folder. Everything runs in a temp folder and touches no real data.
//   dotnet run --project tools/hapshub/hub-selftest
// Exit code 0 means every check passed.

using System.Diagnostics;
using System.Text;
using HapsHub.Core;
using Microsoft.Data.Sqlite;

if (args.Length >= 1 && args[0] == "--print-path")
{
    Console.WriteLine(HubPaths.Data(args[1..]));
    return 0;
}
if (args.Length >= 2 && args[0] == "--writer")
    return RunWriter(bytes => AtomicFile.Commit(args[1], fs => WriteInChunks(fs, bytes), null, null));
if (args.Length >= 2 && args[0] == "--writer-plain")
    return RunWriter(bytes =>
    {
        using var fs = new FileStream(args[1], FileMode.Create, FileAccess.Write, FileShare.Read);
        WriteInChunks(fs, bytes);
    });
if (args.Length >= 2 && args[0] == "--crash-module") return await RunCrashChild(args[1]);

var root = Path.Combine(Path.GetTempPath(), "hub-selftest-" + Guid.NewGuid().ToString("N"));
Directory.CreateDirectory(root);
// Set before anything reads HubPaths, so this run can't reach the real data folder.
Environment.SetEnvironmentVariable(HubPaths.DataDirVariable, Path.Combine(root, "data"));
var failures = 0;

async Task Check(string name, Func<Task> test)
{
    try
    {
        await test();
        Console.WriteLine($"ok    {name}");
    }
    catch (Exception ex)
    {
        failures++;
        Console.WriteLine($"FAIL  {name}: {ex.Message}");
    }
}

static void Assert(bool condition, string message)
{
    if (!condition) throw new Exception(message);
}

string Fresh(string name)
{
    var dir = Path.Combine(root, name);
    Directory.CreateDirectory(dir);
    return dir;
}

HubDatabase OpenDb(string dir)
{
    var db = new HubDatabase(Path.Combine(dir, "hub.db"));
    Assert(db.Open(), "database did not open: " + db.LastError);
    return db;
}

static HubModuleInfo Info(ModuleRegistry registry, string id) => registry.GetModules().Single(m => m.Id == id);

// ---- Paths ----

await Check("paths: default root matches the folder the app has always used", () =>
{
    var expected = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "HapsHub", "Caches", "x.json");
    var actual = ResolvePath(null, "Caches", "x.json");
    Assert(actual == expected, $"{actual} != {expected}");
    return Task.CompletedTask;
});

await Check("paths: the override moves the data root", () =>
{
    var dir = Fresh("paths");
    var data = ResolvePath(dir, "settings.json");
    Assert(data == Path.Combine(dir, "settings.json"), data);
    return Task.CompletedTask;
});

// ---- Atomic writes ----

await Check("atomic: output bytes match File.WriteAll*", () =>
{
    var dir = Fresh("atomic-bytes");
    var a = Path.Combine(dir, "a");
    var b = Path.Combine(dir, "b");

    File.WriteAllText(a, "héllo");
    AtomicFile.WriteAllText(b, "héllo");
    Assert(File.ReadAllBytes(a).SequenceEqual(File.ReadAllBytes(b)), "default encoding differs");

    File.WriteAllText(a, "héllo", Encoding.UTF8);
    AtomicFile.WriteAllText(b, "héllo", Encoding.UTF8);
    Assert(File.ReadAllBytes(a).SequenceEqual(File.ReadAllBytes(b)), "UTF8 with BOM differs");

    File.WriteAllLines(a, new[] { "one", "two" });
    AtomicFile.WriteAllLines(b, new[] { "one", "two" });
    Assert(File.ReadAllBytes(a).SequenceEqual(File.ReadAllBytes(b)), "lines differ");
    return Task.CompletedTask;
});

await Check("atomic: a write that fails part-way leaves the old file and no temp", () =>
{
    var dir = Fresh("atomic-fail");
    var path = Path.Combine(dir, "state.json");
    File.WriteAllText(path, "old");
    var threw = false;
    try
    {
        AtomicFile.Commit(path, fs =>
        {
            fs.WriteByte(1);
            throw new IOException("disk full");
        }, null, null);
    }
    catch (IOException) { threw = true; }
    Assert(threw, "the failure was swallowed");
    Assert(File.ReadAllText(path) == "old", "old contents were lost");
    Assert(Directory.GetFiles(dir).Length == 1, "temp file left behind");
    return Task.CompletedTask;
});

await Check("atomic: backup receives the previous version, first write needs none", () =>
{
    var dir = Fresh("atomic-backup");
    var path = Path.Combine(dir, "settings.json");
    var backup = path + ".bak";
    AtomicFile.WriteAllText(path, "v1", backupPath: backup);
    Assert(!File.Exists(backup), "backup made on first write");
    AtomicFile.WriteAllText(path, "v2", backupPath: backup);
    Assert(File.ReadAllText(path) == "v2" && File.ReadAllText(backup) == "v1", "wrong contents");
    return Task.CompletedTask;
});

await Check("atomic: a locked target throws after retrying and keeps old contents", () =>
{
    var dir = Fresh("atomic-locked");
    var path = Path.Combine(dir, "state.json");
    File.WriteAllText(path, "old");
    using (new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.None))
    {
        var threw = false;
        try { AtomicFile.WriteAllText(path, "new"); }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { threw = true; }
        Assert(threw, "expected a failure while locked");
    }
    Assert(File.ReadAllText(path) == "old", "old contents were lost");
    Assert(Directory.GetFiles(dir).Length == 1, "temp file left behind");
    return Task.CompletedTask;
});

await Check("atomic: orphan cleanup removes only old temp files", () =>
{
    var dir = Fresh("atomic-orphans");
    var old = Path.Combine(dir, "a.json.abc.atomic-tmp");
    var young = Path.Combine(dir, "b.json.def.atomic-tmp");
    var keep = Path.Combine(dir, "c.json");
    foreach (var f in new[] { old, young, keep }) File.WriteAllText(f, "x");
    File.SetLastWriteTimeUtc(old, DateTime.UtcNow.AddDays(-2));
    File.SetLastWriteTimeUtc(keep, DateTime.UtcNow.AddDays(-2));
    Assert(AtomicFile.CleanOrphans(dir, TimeSpan.FromDays(1)) == 1, "wrong count");
    Assert(!File.Exists(old) && File.Exists(young) && File.Exists(keep), "wrong files removed");
    return Task.CompletedTask;
});

await Check("atomic: killing the writer 25 times never leaves a partial file", async () =>
{
    var dir = Fresh("atomic-kill");
    var path = Path.Combine(dir, "state.bin");
    var random = new Random(42);
    for (var i = 0; i < 25; i++)
    {
        await Retry(() => AtomicFile.WriteAllBytes(path, Payload(1)));
        await KillMidWrite("--writer", path, random);
        Assert(IsWholePayload(await ReadSettled(path)), $"partial file after kill {i + 1}");
    }

    // Control: the same test with plain writes has to catch partial files, or it proves nothing.
    var controlPath = Path.Combine(dir, "control.bin");
    var caught = 0;
    for (var i = 0; i < 25; i++)
    {
        await Retry(() => File.WriteAllBytes(controlPath, Payload(1)));
        await KillMidWrite("--writer-plain", controlPath, random);
        if (!IsWholePayload(await ReadSettled(controlPath))) caught++;
    }
    Console.WriteLine($"      control: plain writes left a partial file in {caught} of 25 kills");
    Assert(caught > 0, "the control never caught a partial write, so this test has no power");
});

// ---- Database ----

await Check("db: creates core tables, reopens without reapplying", () =>
{
    var dir = Fresh("db-open");
    var db = OpenDb(dir);
    using (var c = db.OpenConnection())
    {
        using var cmd = c.CreateCommand();
        cmd.CommandText = "SELECT COUNT(*) FROM sqlite_master WHERE name IN ('module_state','module_settings','schema_versions');";
        Assert((long)cmd.ExecuteScalar()! == 3, "core tables missing");
    }
    SqliteConnection.ClearAllPools();
    OpenDb(dir);
    return Task.CompletedTask;
});

await Check("db: uses WAL", () =>
{
    var db = OpenDb(Fresh("db-wal"));
    using var c = db.OpenConnection();
    using var cmd = c.CreateCommand();
    cmd.CommandText = "PRAGMA journal_mode;";
    Assert((string)cmd.ExecuteScalar()! == "wal", "not WAL");
    return Task.CompletedTask;
});

await Check("db: a failed migration rolls back only its own step", () =>
{
    var db = OpenDb(Fresh("db-migrate"));
    var steps = new[]
    {
        new HubMigration(1, "CREATE TABLE t1 (a);"),
        new HubMigration(2, "CREATE TABLE t2 (a); THIS IS NOT SQL;"),
    };
    Assert(db.ApplyMigrations("m", steps, out var error) == MigrationOutcome.Failed, "should have failed");
    Assert(error != null, "no error text");
    using var c = db.OpenConnection();
    using var cmd = c.CreateCommand();
    cmd.CommandText = "SELECT group_concat(name) FROM sqlite_master WHERE name IN ('t1','t2');";
    Assert((string)cmd.ExecuteScalar()! == "t1", "step 2 was not rolled back");
    return Task.CompletedTask;
});

await Check("db: data newer than this build is refused and left alone", () =>
{
    var db = OpenDb(Fresh("db-newer"));
    var newer = new[] { new HubMigration(1, "CREATE TABLE t (a);"), new HubMigration(2, "ALTER TABLE t ADD b;") };
    Assert(db.ApplyMigrations("m", newer, out _) == MigrationOutcome.Applied, "setup failed");
    var older = new[] { new HubMigration(1, "CREATE TABLE t (a);") };
    Assert(db.ApplyMigrations("m", older, out _) == MigrationOutcome.DatabaseIsNewer, "should refuse");
    return Task.CompletedTask;
});

await Check("db: a garbage file is moved aside, kept, and replaced", () =>
{
    var dir = Fresh("db-garbage");
    var path = Path.Combine(dir, "hub.db");
    var garbage = Enumerable.Repeat((byte)0x5A, 8192).ToArray();
    File.WriteAllBytes(path, garbage);
    var db = new HubDatabase(path);
    Assert(db.Open(), "did not recover: " + db.LastError);
    Assert(db.QuarantinedTo != null && File.ReadAllBytes(db.QuarantinedTo).SequenceEqual(garbage), "old file not kept");
    return Task.CompletedTask;
});

await Check("db: a damaged page in a real database is caught and kept", () =>
{
    var dir = Fresh("db-damaged");
    var path = Path.Combine(dir, "hub.db");
    var db = OpenDb(dir);
    using (var c = db.OpenConnection())
    {
        using var cmd = c.CreateCommand();
        cmd.CommandText = "CREATE TABLE big (v TEXT); WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<3000) INSERT INTO big SELECT hex(randomblob(50)) FROM n; PRAGMA wal_checkpoint(TRUNCATE);";
        cmd.ExecuteNonQuery();
    }
    SqliteConnection.ClearAllPools();
    var bytes = File.ReadAllBytes(path);
    Array.Fill(bytes, (byte)0xFF, 4096, Math.Min(bytes.Length - 4096, 40960));
    File.WriteAllBytes(path, bytes);
    var reopened = new HubDatabase(path);
    Assert(reopened.Open(), "did not recover: " + reopened.LastError);
    Assert(reopened.QuarantinedTo != null && File.Exists(reopened.QuarantinedTo), "damage not caught");
    return Task.CompletedTask;
});

await Check("db: a locked file is reported, not treated as damage", () =>
{
    var dir = Fresh("db-locked");
    var path = Path.Combine(dir, "hub.db");
    OpenDb(dir);
    SqliteConnection.ClearAllPools();
    using (new FileStream(path, FileMode.Open, FileAccess.ReadWrite, FileShare.None))
    {
        var db = new HubDatabase(path);
        Assert(!db.Open(), "open should fail while locked");
        Assert(db.QuarantinedTo == null, "healthy file was quarantined");
    }
    Assert(File.Exists(path), "file was moved");
    return Task.CompletedTask;
});

// ---- Modules ----

await Check("modules: throwing and hanging modules fail alone", async () =>
{
    var registry = new ModuleRegistry(OpenDb(Fresh("mod-isolation"))) { StartTimeout = TimeSpan.FromMilliseconds(300) };
    var healthy = new FakeModule("healthy");
    registry.Register(new FakeModule("thrower") { OnStart = (_, _) => throw new InvalidOperationException("boom") });
    registry.Register(new FakeModule("blocker") { OnStart = (_, _) => { Thread.Sleep(1500); return Task.CompletedTask; } });
    registry.Register(new FakeModule("hanger") { OnStart = (_, _) => new TaskCompletionSource().Task });
    registry.Register(healthy);

    var watch = Stopwatch.StartNew();
    await registry.StartAllAsync();
    Assert(watch.Elapsed < TimeSpan.FromSeconds(1.2), $"hung modules held up startup: {watch.Elapsed}");

    Assert(Info(registry, "thrower").Status == HubModuleStatus.Failed, "thrower");
    Assert(Info(registry, "thrower").Detail == "boom", "thrower detail");
    Assert(Info(registry, "blocker").Status == HubModuleStatus.Failed, "blocker");
    Assert(Info(registry, "hanger").Status == HubModuleStatus.Failed, "hanger");
    Assert(Info(registry, "healthy").Status == HubModuleStatus.Running, "healthy did not start");
    Assert(healthy.Started == 1, "healthy start count");
});

await Check("modules: a failed migration fails only that module", async () =>
{
    var registry = new ModuleRegistry(OpenDb(Fresh("mod-migrate")));
    var bad = new FakeModule("bad") { MigrationList = new[] { new HubMigration(1, "NOT SQL") } };
    var good = new FakeModule("good") { MigrationList = new[] { new HubMigration(1, "CREATE TABLE good_t (a);") } };
    registry.Register(bad);
    registry.Register(good);
    await registry.StartAllAsync();
    Assert(Info(registry, "bad").Status == HubModuleStatus.Failed && bad.Started == 0, "bad module ran");
    Assert(Info(registry, "good").Status == HubModuleStatus.Running, "good module blocked");
});

await Check("modules: no database stops only the modules that need one", async () =>
{
    var registry = new ModuleRegistry(null);
    registry.Register(new FakeModule("needs") { MigrationList = new[] { new HubMigration(1, "CREATE TABLE t (a);") } });
    registry.Register(new FakeModule("plain"));
    await registry.StartAllAsync();
    Assert(Info(registry, "needs").Status == HubModuleStatus.Failed, "needs");
    Assert(Info(registry, "plain").Status == HubModuleStatus.Running, "plain");
});

await Check("modules: disabled stays off across restarts, enabling starts it", async () =>
{
    var dir = Fresh("mod-enable");
    var first = new ModuleRegistry(OpenDb(dir));
    var module = new FakeModule("m");
    first.Register(module);
    await first.StartAllAsync();
    await first.SetEnabledAsync("m", false);
    Assert(module.Stopped == 1 && Info(first, "m").Status == HubModuleStatus.Disabled, "did not stop");

    var again = new FakeModule("m");
    var second = new ModuleRegistry(OpenDb(dir));
    second.Register(again);
    await second.StartAllAsync();
    Assert(again.Started == 0 && !Info(second, "m").Enabled, "started while disabled");

    await second.SetEnabledAsync("m", true);
    Assert(again.Started == 1 && Info(second, "m").Status == HubModuleStatus.Running, "did not start");
});

await Check("modules: off-by-default stays off until enabled", async () =>
{
    var registry = new ModuleRegistry(OpenDb(Fresh("mod-default")));
    var module = new FakeModule("m") { DefaultOn = false };
    registry.Register(module);
    await registry.StartAllAsync();
    Assert(module.Started == 0 && Info(registry, "m").Status == HubModuleStatus.Disabled, "started");
});

await Check("modules: a background failure marks the module, not the process", async () =>
{
    var registry = new ModuleRegistry(OpenDb(Fresh("mod-background")));
    registry.Register(new FakeModule("m")
    {
        OnStart = (context, _) =>
        {
            context.RunBackground("poller", _ => throw new InvalidOperationException("lost it"));
            return Task.CompletedTask;
        },
    });
    await registry.StartAllAsync();
    for (var i = 0; i < 50 && Info(registry, "m").Status != HubModuleStatus.Failed; i++) await Task.Delay(10);
    Assert(Info(registry, "m").Detail.Contains("lost it"), "failure not recorded: " + Info(registry, "m").Detail);
});

await Check("modules: degraded and recovered are reported", async () =>
{
    HubModuleContext? captured = null;
    var registry = new ModuleRegistry(OpenDb(Fresh("mod-degraded")));
    registry.Register(new FakeModule("m") { OnStart = (context, _) => { captured = context; return Task.CompletedTask; } });
    await registry.StartAllAsync();
    captured!.ReportDegraded("helper missing");
    Assert(Info(registry, "m").Status == HubModuleStatus.Degraded, "not degraded");
    captured.ReportHealthy();
    Assert(Info(registry, "m").Status == HubModuleStatus.Running, "did not recover");
});

await Check("modules: a late report from an abandoned module is ignored", async () =>
{
    HubModuleContext? captured = null;
    var registry = new ModuleRegistry(OpenDb(Fresh("mod-late"))) { StartTimeout = TimeSpan.FromMilliseconds(100) };
    registry.Register(new FakeModule("m")
    {
        OnStart = (context, _) => { captured = context; return new TaskCompletionSource().Task; },
    });
    await registry.StartAllAsync();
    captured!.ReportHealthy();
    Assert(Info(registry, "m").Status == HubModuleStatus.Failed, "abandoned module changed its status");
});

await Check("modules: stop runs in reverse order; a hanging stop can't exceed the budget", async () =>
{
    var order = new List<string>();
    var registry = new ModuleRegistry(OpenDb(Fresh("mod-stop"))) { StopTimeout = TimeSpan.FromMilliseconds(200) };
    registry.Register(new FakeModule("a") { OnStop = () => { lock (order) order.Add("a"); return Task.CompletedTask; } });
    registry.Register(new FakeModule("hang") { OnStop = () => new TaskCompletionSource().Task });
    registry.Register(new FakeModule("c") { OnStop = () => { lock (order) order.Add("c"); return Task.CompletedTask; } });
    await registry.StartAllAsync();
    var watch = Stopwatch.StartNew();
    await registry.StopAllAsync(TimeSpan.FromSeconds(2));
    Assert(watch.Elapsed < TimeSpan.FromSeconds(1), $"stop took {watch.Elapsed}");
    Assert(string.Join("", order) == "ca", "wrong order: " + string.Join("", order));
});

await Check("modules: closing during a hung start doesn't wait out the start timeout", async () =>
{
    var registry = new ModuleRegistry(OpenDb(Fresh("mod-close-hung"))) { StartTimeout = TimeSpan.FromSeconds(30) };
    var later = new FakeModule("later");
    registry.Register(new FakeModule("hanger") { OnStart = (_, _) => new TaskCompletionSource().Task });
    registry.Register(later);
    var starting = registry.StartAllAsync();
    await Task.Delay(200);
    var watch = Stopwatch.StartNew();
    await registry.StopAllAsync(TimeSpan.FromSeconds(2));
    await starting;
    Assert(watch.Elapsed < TimeSpan.FromSeconds(1), $"close took {watch.Elapsed}");
    Assert(later.Started == 0, "a module was started during shutdown");
});

await Check("modules: re-enabling a failed module stops its old instance first", async () =>
{
    var registry = new ModuleRegistry(OpenDb(Fresh("mod-restart")));
    var module = new FakeModule("m")
    {
        OnStart = (context, _) =>
        {
            context.RunBackground("poller", _ => throw new InvalidOperationException("lost it"));
            return Task.CompletedTask;
        },
    };
    registry.Register(module);
    await registry.StartAllAsync();
    for (var i = 0; i < 50 && Info(registry, "m").Status != HubModuleStatus.Failed; i++) await Task.Delay(10);
    await registry.SetEnabledAsync("m", true);
    Assert(module.Stopped == 1 && module.Started == 2, $"stopped {module.Stopped}, started {module.Started}");
});

await Check("modules: settings persist, default applies, unknown key is refused", async () =>
{
    var dir = Fresh("mod-settings");
    var definitions = new[] { new HubSettingDefinition("on", "On", HubSettingKind.Toggle, "false") };
    var registry = new ModuleRegistry(OpenDb(dir));
    registry.Register(new FakeModule("m") { SettingList = definitions });
    Assert(registry.GetSetting("m", "on") == "false", "default");
    Assert(registry.SetSetting("m", "on", "true"), "save");

    var reopened = new ModuleRegistry(OpenDb(dir));
    reopened.Register(new FakeModule("m") { SettingList = definitions });
    Assert(reopened.GetSetting("m", "on") == "true", "not persisted");

    var refused = false;
    try { reopened.SetSetting("m", "ghost", "x"); }
    catch (ArgumentException) { refused = true; }
    Assert(refused, "dead setting accepted");
    await Task.CompletedTask;
});

await Check("modules: duplicate id and duplicate setting key are refused", () =>
{
    var registry = new ModuleRegistry(null);
    registry.Register(new FakeModule("m"));
    var duplicateId = false;
    try { registry.Register(new FakeModule("m")); }
    catch (ArgumentException) { duplicateId = true; }

    var duplicateKey = false;
    var setting = new HubSettingDefinition("k", "K", HubSettingKind.Text, "");
    try { registry.Register(new FakeModule("n") { SettingList = new[] { setting, setting } }); }
    catch (ArgumentException) { duplicateKey = true; }
    Assert(duplicateId && duplicateKey, "duplicates accepted");
    return Task.CompletedTask;
});

await Check("modules: a real crash during start skips the module on the third launch, enabling retries", async () =>
{
    var dir = Fresh("mod-crash");
    for (var run = 1; run <= 2; run++)
    {
        using var child = StartSelf("--crash-module", dir);
        await child.WaitForExitAsync();
        Assert(child.ExitCode != 0, $"run {run} should have crashed");
    }

    var survivor = new FakeModule("survivor");
    var crasher = new FakeModule("crasher");
    var registry = new ModuleRegistry(OpenDb(dir));
    registry.Register(crasher);
    registry.Register(survivor);
    await registry.StartAllAsync();
    Assert(crasher.Started == 0, "crasher was started a third time");
    Assert(Info(registry, "crasher").Status == HubModuleStatus.Failed, "not marked failed");
    Assert(Info(registry, "survivor").Status == HubModuleStatus.Running, "survivor blocked");

    await registry.SetEnabledAsync("crasher", true);
    Assert(crasher.Started == 1, "enabling did not retry");
    Assert(Info(registry, "crasher").Status == HubModuleStatus.Running, "not running after retry");
});

// ---- Forwarding block ----

static void AssertBlock(bool forwarding, bool lookups)
{
    var kinds = new[] { ForwardingKind.AvatarSubmit, ForwardingKind.DeletionReport, ForwardingKind.PopularityHit, ForwardingKind.PopularityLike };
    Assert(kinds.All(k => ForwardingBlock.Allows(k) == forwarding), $"forwarding should be {forwarding}");
    Assert(ForwardingBlock.Allows(ForwardingKind.EntitlementLookup) == lookups, $"lookups should be {lookups}");
}

await Check("forwarding: closed before any module has started", () =>
{
    AssertBlock(false, false);
    Assert(ForwardingBlock.BlockedCount(ForwardingKind.AvatarSubmit) > 0, "block was not counted");
    return Task.CompletedTask;
});

await Check("forwarding: stays closed by default, opens per setting, closes when stopped", async () =>
{
    var dir = Fresh("forward-settings");
    var registry = new ModuleRegistry(OpenDb(dir));
    registry.Register(new ForwardingModule());
    await registry.StartAllAsync();
    AssertBlock(false, false);

    Assert(registry.SetSetting(ForwardingModule.ModuleId, ForwardingModule.ForwardKey, "true"), "save failed");
    AssertBlock(true, false);
    Assert(registry.SetSetting(ForwardingModule.ModuleId, ForwardingModule.LookupKey, "true"), "save failed");
    AssertBlock(true, true);
    Assert(registry.SetSetting(ForwardingModule.ModuleId, ForwardingModule.ForwardKey, "false"), "save failed");
    AssertBlock(false, true);

    await registry.SetEnabledAsync(ForwardingModule.ModuleId, false);
    AssertBlock(false, false);
});

await Check("forwarding: a saved choice is restored at the next start", async () =>
{
    var dir = Fresh("forward-restore");
    var first = new ModuleRegistry(OpenDb(dir));
    first.Register(new ForwardingModule());
    await first.StartAllAsync();
    first.SetSetting(ForwardingModule.ModuleId, ForwardingModule.ForwardKey, "true");
    await first.StopAllAsync(TimeSpan.FromSeconds(2));
    AssertBlock(false, false);

    var second = new ModuleRegistry(OpenDb(dir));
    second.Register(new ForwardingModule());
    await second.StartAllAsync();
    AssertBlock(true, false);
    await second.StopAllAsync(TimeSpan.FromSeconds(2));
});

await Check("forwarding: without a database everything stays closed", async () =>
{
    var registry = new ModuleRegistry(null);
    registry.Register(new ForwardingModule());
    await registry.StartAllAsync();
    AssertBlock(false, false);
    await registry.StopAllAsync(TimeSpan.FromSeconds(2));
});

// ---- Upstream watch ----

async Task<(ModuleRegistry Registry, UpstreamWatchModule Module, FakeGitHub GitHub)> StartWatch(string name, string? baseline)
{
    var github = new FakeGitHub();
    var sources = new[] { new UpstreamSource("a", "A", "o/a", "main", baseline), new UpstreamSource("b", "B", "o/b", "main", "b1b1b1b") };
    var module = new UpstreamWatchModule(github, sources);
    var registry = new ModuleRegistry(OpenDb(Fresh(name)));
    registry.Register(module);
    await registry.StartAllAsync();
    return (registry, module, github);
}

await Check("upstream: counts commits and flags API, log parser and auth files", async () =>
{
    var (_, module, github) = await StartWatch("up-flags", "a0a0a0a");
    github.CompareFiles["o/a"] = new[] { "Services/VRChatAPI/UsersAPI.cs", "Services/VRChatAPI/VRChatLogWatcher.cs", "main/AuthController.cs", "README.md" };
    var report = (await module.CheckAllAsync())[0];
    Assert(report.Error == null, "error: " + report.Error);
    Assert(report.NewCommits == 7, $"commits {report.NewCommits}");
    Assert(report.LatestRelease == "v1" && report.HeadCommit == "ffffffa", "head or release wrong");
    var flags = report.Flags.ToDictionary(f => f.Category, f => f.Files.Count);
    Assert(flags["API"] == 2 && flags["Log parser"] == 1 && flags["Auth"] == 1, string.Join(",", flags));
});

await Check("upstream: one failing source doesn't affect the others", async () =>
{
    var (_, module, github) = await StartWatch("up-isolated", "a0a0a0a");
    github.FailRepo = "o/a";
    var reports = await module.CheckAllAsync();
    Assert(reports[0].Error != null && reports[0].Error!.Contains("limit"), "no rate limit message: " + reports[0].Error);
    Assert(reports[1].Error == null && reports[1].NewCommits == 7, "second source was affected");
});

await Check("upstream: no baseline means no comparison until one is marked", async () =>
{
    var (_, module, github) = await StartWatch("up-baseline", null);
    var first = (await module.CheckAllAsync())[0];
    Assert(first.NewCommits == null && first.Error == null, "should have no count");
    Assert(!github.Requests.Any(r => r.Contains("o/a/compare")), "compared without a baseline");
    Assert(module.MarkReviewed("a", first.HeadCommit!), "mark failed");
    var second = (await module.CheckAllAsync())[0];
    Assert(second.NewCommits == 0, "head should now be reviewed");
    Assert(!github.Requests.Any(r => r.Contains("o/a/compare")), "compared an up-to-date source");
});

await Check("upstream: a reviewed commit replaces the baseline and survives restart", async () =>
{
    var dir = Fresh("up-persist");
    var sources = new[] { new UpstreamSource("a", "A", "o/a", "main", "a0a0a0a") };
    var firstRegistry = new ModuleRegistry(OpenDb(dir));
    var firstModule = new UpstreamWatchModule(new FakeGitHub(), sources);
    firstRegistry.Register(firstModule);
    await firstRegistry.StartAllAsync();
    Assert(firstModule.MarkReviewed("a", "abcdef1"), "mark failed");
    await firstRegistry.StopAllAsync(TimeSpan.FromSeconds(2));

    var github = new FakeGitHub();
    var secondRegistry = new ModuleRegistry(OpenDb(dir));
    var secondModule = new UpstreamWatchModule(github, sources);
    secondRegistry.Register(secondModule);
    await secondRegistry.StartAllAsync();
    await secondModule.CheckAllAsync();
    Assert(github.Requests.Any(r => r.Contains("compare/abcdef1...")), "old baseline used: " + string.Join(" ", github.Requests));
});

await Check("upstream: bad input is refused, and the address sent carries no email", async () =>
{
    var (_, module, github) = await StartWatch("up-input", "a0a0a0a");
    Assert(!module.MarkReviewed("a", "../../etc"), "accepted a bad commit");
    Assert(!module.MarkReviewed("nope", "abcdef1"), "accepted an unknown source");
    await module.CheckAllAsync();
    Assert(github.UserAgents.All(u => u == "HapsHub"), "user agent: " + string.Join(",", github.UserAgents.Distinct()));
});

// ---- Steam branch ----

const string SteamManifestText = "\"AppState\"\n{\n\t\"appid\"\t\t\"3368750\"\n\t\"StateFlags\"\t\t\"4\"\n\t\"buildid\"\t\t\"18832234\"\n\t\"UserConfig\"\n\t{\n\t\t\"language\"\t\t\"english\"\n\t\t\"BetaKey\"\t\t\"public\"\n\t}\n\t\"MountedConfig\"\n\t{\n\t\t\"language\"\t\t\"english\"\n\t\t\"BetaKey\"\t\t\"public\"\n\t}\n}\n";

async Task<(ModuleRegistry Registry, SteamBranchModule Module, FakeSteam Steam, FakeSteamApi Api, string Manifest)> StartSteam(string name, string manifest = SteamManifestText)
{
    var dir = Fresh(name);
    var path = Path.Combine(dir, "appmanifest_3368750.acf");
    File.WriteAllText(path, manifest);
    var steam = new FakeSteam { Manifest = path };
    var api = new FakeSteamApi();
    var module = new SteamBranchModule(api, steam, TimeSpan.FromMilliseconds(120), TimeSpan.FromMilliseconds(20), Path.Combine(dir, "backup"));
    var registry = new ModuleRegistry(OpenDb(Path.Combine(dir, "db")));
    registry.Register(module);
    await registry.StartAllAsync();
    return (registry, module, steam, api, path);
}

await Check("steam: reads the selected branch, installed branch and build", async () =>
{
    var read = SteamManifest.Read("p", SteamManifestText)!;
    Assert(read.Branch == "public" && read.MountedBranch == "public" && read.BuildId == "18832234" && read.Ready, "manifest misread");
    var updating = SteamManifest.Read("p", SteamManifestText.Replace("\"StateFlags\"\t\t\"4\"", "\"StateFlags\"\t\t\"1026\""))!;
    Assert(!updating.Ready, "an updating app was reported ready");
    Assert(SteamManifest.Read("p", "not a manifest") == null, "garbage was accepted");
    await Task.CompletedTask;
});

await Check("steam: a branch edit changes the selected branch and nothing else", async () =>
{
    var edited = SteamManifest.WithBranch(SteamManifestText, "beta")!;
    Assert(edited == SteamManifestText.Replace("\"language\"\t\t\"english\"\n\t\t\"BetaKey\"\t\t\"public\"\n\t}\n\t\"MountedConfig\"", "\"language\"\t\t\"english\"\n\t\t\"BetaKey\"\t\t\"beta\"\n\t}\n\t\"MountedConfig\""), "other text changed");
    var read = SteamManifest.Read("p", edited)!;
    Assert(read.Branch == "beta" && read.MountedBranch == "public", "wrong section edited");
    var noKey = SteamManifestText.Replace("\t\t\"language\"\t\t\"english\"\n\t\t\"BetaKey\"\t\t\"public\"\n\t}\n\t\"MountedConfig\"", "\t\t\"language\"\t\t\"english\"\n\t}\n\t\"MountedConfig\"");
    Assert(SteamManifest.Read("p", SteamManifest.WithBranch(noKey, "beta")!)!.Branch == "beta", "missing key wasn't added");
    Assert(SteamManifest.WithBranch("not a manifest", "beta") == null, "garbage was edited");
    await Task.CompletedTask;
});

await Check("steam: switching closes Steam, edits the file, reopens Steam and keeps a backup", async () =>
{
    var (registry, module, steam, _, path) = await StartSteam("steam-ok");
    steam.OnStart = () => File.WriteAllText(path, File.ReadAllText(path).Replace("\"MountedConfig\"\n\t{\n\t\t\"language\"\t\t\"english\"\n\t\t\"BetaKey\"\t\t\"public\"", "\"MountedConfig\"\n\t{\n\t\t\"language\"\t\t\"english\"\n\t\t\"BetaKey\"\t\t\"beta\"").Replace("18832234", "26185367"));
    var result = await module.SwitchAsync("beta");
    Assert(result.Outcome == SteamSwitchOutcome.Applied, $"{result.Outcome}: {result.Message}");
    Assert(result.Message.Contains("26185367"), "new build not reported");
    Assert(steam.Shutdowns == 1 && steam.Starts == 1, $"closed {steam.Shutdowns}, opened {steam.Starts}");
    var backup = Path.Combine(Path.GetDirectoryName(path)!, "backup", "appmanifest_3368750.before-switch.acf");
    Assert(File.ReadAllText(backup) == SteamManifestText, "backup isn't the original");
    await registry.StopAllAsync(TimeSpan.FromSeconds(5));
});

await Check("steam: refuses while VRChat or SteamVR runs, and touches nothing", async () =>
{
    var (registry, module, steam, _, path) = await StartSteam("steam-blocked");
    steam.Blockers = new[] { "VRChat", "vrserver" };
    var result = await module.SwitchAsync("beta");
    Assert(result.Outcome == SteamSwitchOutcome.Blocked && result.Message.Contains("VRChat"), $"{result.Outcome}: {result.Message}");
    Assert(steam.Shutdowns == 0 && steam.Starts == 0, "Steam was touched");
    Assert(File.ReadAllText(path) == SteamManifestText, "file changed");
    await registry.StopAllAsync(TimeSpan.FromSeconds(5));
});

await Check("steam: refuses while Steam is updating the app", async () =>
{
    var (registry, module, steam, _, path) = await StartSteam("steam-updating", SteamManifestText.Replace("\"StateFlags\"\t\t\"4\"", "\"StateFlags\"\t\t\"1026\""));
    var result = await module.SwitchAsync("beta");
    Assert(result.Outcome == SteamSwitchOutcome.Blocked, $"{result.Outcome}");
    Assert(steam.Shutdowns == 0, "Steam was closed");
    await registry.StopAllAsync(TimeSpan.FromSeconds(5));
});

await Check("steam: if Steam won't close, nothing is written and it isn't force-closed", async () =>
{
    var (registry, module, steam, _, path) = await StartSteam("steam-stuck");
    steam.ShutdownWorks = false;
    var result = await module.SwitchAsync("beta");
    Assert(result.Outcome == SteamSwitchOutcome.Failed, $"{result.Outcome}");
    Assert(File.ReadAllText(path) == SteamManifestText, "file changed");
    Assert(steam.Starts == 1, "Steam's start wasn't called to recover");
    await registry.StopAllAsync(TimeSpan.FromSeconds(5));
});

await Check("steam: a failed write still reopens Steam and reports it", async () =>
{
    var (registry, module, steam, _, path) = await StartSteam("steam-locked");
    FileStream? hold = null;
    steam.OnShutdown = () => hold = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read);
    try
    {
        var result = await module.SwitchAsync("beta");
        Assert(result.Outcome == SteamSwitchOutcome.Failed, $"{result.Outcome}: {result.Message}");
    }
    finally { hold?.Dispose(); }
    Assert(steam.Starts == 1, $"Steam opened {steam.Starts} times");
    Assert(File.ReadAllText(path) == SteamManifestText, "file changed");
    await registry.StopAllAsync(TimeSpan.FromSeconds(5));
});

await Check("steam: Steam putting the branch back is reported, not hidden", async () =>
{
    var (registry, module, steam, _, path) = await StartSteam("steam-reverted");
    steam.OnStart = () => File.WriteAllText(path, SteamManifestText);
    var result = await module.SwitchAsync("beta");
    Assert(result.Outcome == SteamSwitchOutcome.Reverted, $"{result.Outcome}: {result.Message}");
    await registry.StopAllAsync(TimeSpan.FromSeconds(5));
});

await Check("steam: an accepted branch still downloading reports waiting", async () =>
{
    var (registry, module, _, _, _) = await StartSteam("steam-waiting");
    var result = await module.SwitchAsync("beta");
    Assert(result.Outcome == SteamSwitchOutcome.Waiting, $"{result.Outcome}: {result.Message}");
    await registry.StopAllAsync(TimeSpan.FromSeconds(5));
});

await Check("steam: other branches, a missing install and the current branch are refused safely", async () =>
{
    var (registry, module, steam, _, path) = await StartSteam("steam-refused");
    Assert((await module.SwitchAsync("v1.5.1")).Outcome == SteamSwitchOutcome.Failed, "pinned branch accepted");
    Assert((await module.SwitchAsync("public")).Outcome == SteamSwitchOutcome.AlreadyOn, "current branch not recognised");
    Assert(steam.Shutdowns == 0, "Steam was closed");
    steam.Manifest = null;
    Assert((await module.SwitchAsync("beta")).Outcome == SteamSwitchOutcome.Failed, "missing install accepted");
    await registry.StopAllAsync(TimeSpan.FromSeconds(5));
});

await Check("steam: reads builds, and a failed lookup keeps the installed state", async () =>
{
    var (registry, module, _, api, _) = await StartSteam("steam-lookup");
    var report = await module.CheckAsync(online: true);
    Assert(report.Beta?.BuildId == "26185367" && report.Public?.BuildId == "18832234" && report.Error == null, "builds misread");
    Assert(report.Beta!.Updated?.Year == 2026, "date misread");
    Assert(api.Requests.All(r => !r.UserAgent.Contains('@')), "address sent");
    api.Fail = true;
    var failed = await module.CheckAsync(online: true);
    Assert(failed.Error != null && failed.Installed?.BuildId == "18832234", "failure lost the installed state");
    api.Garbage = true;
    Assert((await module.CheckAsync(online: true)).Error != null, "bad answer not reported");
    await registry.StopAllAsync(TimeSpan.FromSeconds(5));
});

await Check("steam: no lookup is made offline or with the watch off", async () =>
{
    var (registry, module, _, api, _) = await StartSteam("steam-off");
    await module.CheckAsync(online: false);
    Assert(api.Requests.Count == 0, "offline read used the network");
    Assert(registry.SetSetting(SteamBranchModule.ModuleId, SteamBranchModule.WatchKey, "false"), "setting not saved");
    var report = await module.CheckAsync(online: true);
    Assert(api.Requests.Count == 0 && !report.WatchOn, "watch off still used the network");
    await registry.StopAllAsync(TimeSpan.FromSeconds(5));
});

await Check("steam: a reviewed beta build survives restart, and bad input is refused", async () =>
{
    var dir = Fresh("steam-review");
    var path = Path.Combine(dir, "appmanifest_3368750.acf");
    File.WriteAllText(path, SteamManifestText);
    var steam = new FakeSteam { Manifest = path };
    var first = new SteamBranchModule(new FakeSteamApi(), steam);
    var registry = new ModuleRegistry(OpenDb(Path.Combine(dir, "db")));
    registry.Register(first);
    await registry.StartAllAsync();
    Assert(!first.MarkBetaReviewed("not-a-build"), "bad build accepted");
    Assert(first.MarkBetaReviewed("26185367"), "build not saved");
    await registry.StopAllAsync(TimeSpan.FromSeconds(5));

    var second = new SteamBranchModule(new FakeSteamApi(), steam);
    var reopened = new ModuleRegistry(OpenDb(Path.Combine(dir, "db")));
    reopened.Register(second);
    await reopened.StartAllAsync();
    Assert((await second.CheckAsync(online: false)).ReviewedBetaBuild == "26185367", "review lost");
    await reopened.StopAllAsync(TimeSpan.FromSeconds(5));
});

// ---- Hub database backup ----

await Check("backup: copies a database in use, and a missing or bad target only returns false", async () =>
{
    var dir = Fresh("hub-backup");
    var database = OpenDb(dir);
    using (var connection = database.OpenConnection())
    using (var command = connection.CreateCommand())
    {
        command.CommandText = "CREATE TABLE IF NOT EXISTS t (v TEXT); INSERT INTO t VALUES ('kept');";
        command.ExecuteNonQuery();
    }
    var copy = Path.Combine(dir, "copy.db");
    Assert(HubDatabase.TryBackup(database.FilePath, copy), "backup failed");
    using (var check = new Microsoft.Data.Sqlite.SqliteConnection($"Data Source={copy};Pooling=False"))
    {
        check.Open();
        using var read = check.CreateCommand();
        read.CommandText = "SELECT v FROM t;";
        Assert(read.ExecuteScalar() as string == "kept", "copy has no data");
    }
    Assert(!HubDatabase.TryBackup(Path.Combine(dir, "missing.db"), Path.Combine(dir, "c2.db")), "missing source reported success");
    string? logged = null;
    Assert(!HubDatabase.TryBackup(database.FilePath, Path.Combine(dir, "no", "such", "folder", "c3.db"), m => logged = m), "bad target reported success");
    Assert(logged != null, "failure not logged");
    await Task.CompletedTask;
});

// ---- VRCX history archive ----

await Check("overlay events: a toggle decides, and a portal starts off", async () =>
{
    var module = new OverlayEventsModule();
    var registry = new ModuleRegistry(OpenDb(Fresh("overlay-events")));
    registry.Register(module);
    await registry.StartAllAsync();
    var shown = new List<string>();
    module.Show += (title, text, image, id) => shown.Add($"{title}|{text}|{id}");
    module.Raise(OverlayEventsModule.PortalSpawn, "Portal", "opened");
    Assert(shown.Count == 0, "portals must start off");
    module.Raise(OverlayEventsModule.FriendAdded, "Ann", "added", "", "usr_a");
    Assert(shown.SequenceEqual(new[] { "Ann|added|usr_a" }), string.Join(",", shown));
    registry.SetSetting(OverlayEventsModule.ModuleId, OverlayEventsModule.FriendAdded, "false");
    module.Raise(OverlayEventsModule.FriendAdded, "Ann", "added");
    Assert(shown.Count == 1, "a toggle was ignored");
    await registry.StopAllAsync(TimeSpan.FromSeconds(5));
    module.Raise(OverlayEventsModule.NameChange, "Ann", "x");
    Assert(shown.Count == 1, "a stopped module must not fire");
});

await Check("proxy: accepts the kinds .NET can use, refuses the rest, and keeps sign-in out of the address", () =>
{
    Assert(HubProxyModule.Parse("").Proxy == null && HubProxyModule.Parse("").Problem == null, "empty");
    Assert(HubProxyModule.Parse("   ").Problem == null, "spaces");
    foreach (var good in new[] { "http://127.0.0.1:8080", "https://proxy.test:3128", "socks5://127.0.0.1:1080", "socks4://h:1" })
        Assert(HubProxyModule.Parse(good).Proxy != null, good);
    foreach (var bad in new[] { "127.0.0.1:8080x y", "ftp://h:1", "nonsense", "file:///c:/x" })
        Assert(HubProxyModule.Parse(bad).Proxy == null && HubProxyModule.Parse(bad).Problem != null, bad);
    var signedIn = HubProxyModule.Parse("http://me:p%40ss@host.test:8080").Proxy!;
    Assert(signedIn.Address!.ToString() == "http://host.test:8080/", signedIn.Address.ToString());
    var login = (System.Net.NetworkCredential)signedIn.Credentials!;
    Assert(login.UserName == "me" && login.Password == "p@ss", "sign-in details are wrong");
    return Task.CompletedTask;
});

await Check("proxy: every new HttpClient goes through it, and a bad address leaves things alone", async () =>
{
    var original = HttpClient.DefaultProxy;
    var listener = new System.Net.Sockets.TcpListener(System.Net.IPAddress.Loopback, 0);
    listener.Start();
    var port = ((System.Net.IPEndPoint)listener.LocalEndpoint).Port;
    var seen = new System.Collections.Concurrent.ConcurrentBag<string>();
    _ = Task.Run(async () =>
    {
        try
        {
            while (true)
            {
                using var client = await listener.AcceptTcpClientAsync();
                var stream = client.GetStream();
                var buffer = new byte[2048];
                var read = await stream.ReadAsync(buffer);
                seen.Add(System.Text.Encoding.ASCII.GetString(buffer, 0, read).Split('\r')[0]);
                await stream.WriteAsync(System.Text.Encoding.ASCII.GetBytes("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok"));
            }
        }
        catch (Exception) { /* The test is over. */ }
    });

    var module = new HubProxyModule();
    var registry = new ModuleRegistry(OpenDb(Fresh("proxy")));
    registry.Register(module);
    await registry.StartAllAsync();
    registry.SetSetting(HubProxyModule.ModuleId, "url", $"http://127.0.0.1:{port}");
    using (var http = new HttpClient { Timeout = TimeSpan.FromSeconds(10) })
    {
        var answer = await http.GetStringAsync("http://hapshub-proxy-test.invalid/hello");
        Assert(answer == "ok", answer);
    }
    Assert(seen.Any(line => line.Contains("GET http://hapshub-proxy-test.invalid/hello")), string.Join(" | ", seen));

    registry.SetSetting(HubProxyModule.ModuleId, "url", "not a proxy");
    Assert(!ReferenceEquals(HttpClient.DefaultProxy, null), "default went missing");
    Assert(HttpClient.DefaultProxy is not System.Net.WebProxy, "a bad address must not be used");
    Assert(registry.GetModules().Single(m => m.Id == HubProxyModule.ModuleId).Status == HubModuleStatus.Degraded, "a bad address should show as degraded");
    registry.SetSetting(HubProxyModule.ModuleId, "url", "");
    Assert(HttpClient.DefaultProxy is not System.Net.WebProxy, "clearing it must remove it");
    await registry.StopAllAsync(TimeSpan.FromSeconds(5));
    listener.Stop();
    HttpClient.DefaultProxy = original;
});

static byte[] TinyPng(params (string Type, byte[] Data)[] extra)
{
    using var stream = new MemoryStream();
    stream.Write(new byte[] { 137, 80, 78, 71, 13, 10, 26, 10 });
    void Chunk(string type, byte[] data)
    {
        var length = BitConverter.GetBytes((uint)data.Length); Array.Reverse(length);
        stream.Write(length);
        var body = System.Text.Encoding.ASCII.GetBytes(type).Concat(data).ToArray();
        stream.Write(body);
        uint c = 0xFFFFFFFF;
        foreach (var b in body) { c ^= b; for (var k = 0; k < 8; k++) c = (c & 1) != 0 ? 0xEDB88320 ^ (c >> 1) : c >> 1; }
        var crc = BitConverter.GetBytes(c ^ 0xFFFFFFFF); Array.Reverse(crc);
        stream.Write(crc);
    }
    Chunk("IHDR", new byte[] { 0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0 });
    foreach (var (type, data) in extra) Chunk(type, data);
    Chunk("IDAT", new byte[] { 120, 156, 99, 248, 207, 192, 0, 0, 3, 1, 1, 0 });
    Chunk("IEND", Array.Empty<byte>());
    return stream.ToArray();
}

static byte[] TextEntry(string keyword, string text) =>
    System.Text.Encoding.Latin1.GetBytes(keyword).Concat(new byte[] { 0, 0, 0, 0, 0 }).Concat(System.Text.Encoding.UTF8.GetBytes(text)).ToArray();

await Check("screenshot details: a write can be read back, keeps the picture and its dates", () =>
{
    var path = Path.Combine(Fresh("png-write"), "VRChat_test.png");
    var original = TinyPng();
    File.WriteAllBytes(path, original);
    var date = new DateTime(2024, 5, 6, 7, 8, 9, DateTimeKind.Utc);
    File.SetLastWriteTimeUtc(path, date);
    File.SetCreationTimeUtc(path, date);
    var metadata = new PhotoMetadata("HapsHub", "usr_me", "Mé", "wrld_1", "A World ♡", "wrld_1:9", new[] { new PhotoPerson("usr_a", "Ann"), new PhotoPerson("usr_b", "日本語") });
    Assert(PngMetadata.Write(path, metadata), "the write was refused");
    var back = PngMetadata.Read(path)!;
    Assert(back.WorldId == "wrld_1" && back.WorldName == "A World ♡" && back.Location == "wrld_1:9", "world is wrong");
    Assert(back.AuthorName == "Mé" && back.Players.Count == 2 && back.Players[1].Name == "日本語", "people are wrong");
    Assert(File.GetLastWriteTimeUtc(path) == date && File.GetCreationTimeUtc(path) == date, "the dates changed");
    var written = File.ReadAllBytes(path);
    Assert(written.AsSpan(0, 33).SequenceEqual(original.AsSpan(0, 33)), "the header changed");
    Assert(written.AsSpan(written.Length - (original.Length - 33)).SequenceEqual(original.AsSpan(33)), "the picture data changed");
    Assert(!PngMetadata.Write(path, metadata), "a second write must not stack up");
    Assert(File.ReadAllBytes(path).SequenceEqual(written), "a refused write changed the file");
    return Task.CompletedTask;
});

await Check("screenshot details: another app's details are kept, and bad files are left alone", () =>
{
    var dir = Fresh("png-refuse");
    var metadata = new PhotoMetadata("HapsHub", "usr_me", "Me", "wrld_1", "W", "", Array.Empty<PhotoPerson>());
    var vrcxJson = "{\"application\":\"VRCX\",\"author\":{\"id\":\"usr_x\",\"displayName\":\"X\"},\"world\":{\"name\":\"Old\",\"id\":\"wrld_old\",\"instanceId\":\"wrld_old:1\"},\"players\":[{\"id\":\"usr_p\",\"displayName\":\"P\"}]}";
    var vrcx = Path.Combine(dir, "vrcx.png");
    File.WriteAllBytes(vrcx, TinyPng(("iTXt", TextEntry("Description", vrcxJson))));
    var before = File.ReadAllBytes(vrcx);
    Assert(!PngMetadata.Write(vrcx, metadata) && File.ReadAllBytes(vrcx).SequenceEqual(before), "another app's details were replaced");
    var read = PngMetadata.Read(vrcx)!;
    Assert(read.Application == "VRCX" && read.WorldId == "wrld_old" && read.Players.Single().Id == "usr_p", "VRCX's details weren't read");

    var notPng = Path.Combine(dir, "not.png");
    File.WriteAllBytes(notPng, new byte[] { 1, 2, 3, 4 });
    Assert(!PngMetadata.Write(notPng, metadata) && PngMetadata.Read(notPng) == null, "not a PNG");
    var cut = Path.Combine(dir, "cut.png");
    File.WriteAllBytes(cut, TinyPng().Take(40).ToArray());
    Assert(!PngMetadata.Write(cut, metadata), "a cut-off file must be left alone");
    Assert(File.ReadAllBytes(cut).Length == 40, "a cut-off file was changed");
    Assert(PngMetadata.Read(cut) == null, "a cut-off file has no details");

    var noTrust = Path.Combine(dir, "lying.png");
    var lying = TinyPng();
    lying[33] = 0x7F; // The next chunk now claims to be enormous.
    File.WriteAllBytes(noTrust, lying);
    Assert(PngMetadata.Read(noTrust) == null, "a false length must not be followed");
    return Task.CompletedTask;
});

await Check("screenshot details: reads VRChat's own details, and old text and compressed entries", () =>
{
    var dir = Fresh("png-xmp");
    var xmp = "<x:xmpmeta><rdf:Description><xmp:Author>Me &amp; Co</xmp:Author><vrc:WorldID>wrld_v</vrc:WorldID><vrc:WorldDisplayName>Vee</vrc:WorldDisplayName><vrc:AuthorID>usr_v</vrc:AuthorID></rdf:Description></x:xmpmeta>";
    var path = Path.Combine(dir, "vrchat.png");
    File.WriteAllBytes(path, TinyPng(("iTXt", TextEntry("XML:com.adobe.xmp", xmp))));
    var read = PngMetadata.Read(path)!;
    Assert(read.Application == "VRChat" && read.WorldId == "wrld_v" && read.WorldName == "Vee" && read.AuthorId == "usr_v" && read.AuthorName == "Me & Co", "XMP is wrong");
    Assert(PngMetadata.Write(path, new PhotoMetadata("HapsHub", "usr_me", "Me", "wrld_h", "H", "", Array.Empty<PhotoPerson>())), "VRChat's details shouldn't block ours");
    Assert(PngMetadata.Read(path)!.WorldId == "wrld_h", "ours should read first");
    Assert(PngMetadata.ReadTexts(path).ContainsKey("XML:com.adobe.xmp"), "VRChat's details must stay");

    var old = Path.Combine(dir, "old.png");
    File.WriteAllBytes(old, TinyPng(("tEXt", System.Text.Encoding.Latin1.GetBytes("Title\0Hello"))));
    Assert(PngMetadata.ReadTexts(old)["Title"] == "Hello" && PngMetadata.Read(old) == null, "plain text entries");

    using var packed = new MemoryStream();
    using (var zlib = new System.IO.Compression.ZLibStream(packed, System.IO.Compression.CompressionLevel.Optimal, true))
        zlib.Write(System.Text.Encoding.UTF8.GetBytes("{\"world\":{\"id\":\"wrld_z\"}}"));
    var compressed = System.Text.Encoding.Latin1.GetBytes("Description").Concat(new byte[] { 0, 1, 0, 0, 0 }).Concat(packed.ToArray()).ToArray();
    var zip = Path.Combine(dir, "zip.png");
    File.WriteAllBytes(zip, TinyPng(("iTXt", compressed)));
    Assert(PngMetadata.Read(zip)!.WorldId == "wrld_z", "compressed entry");
    return Task.CompletedTask;
});

await Check("crash rejoin: only a crash from a real instance reopens VRChat", () =>
{
    const string place = "wrld_abc:123~region(eu)";
    var now = new DateTime(2026, 11, 9, 12, 0, 0, DateTimeKind.Utc);
    var longAgo = now.AddHours(-1);
    CrashRejoinDecision Run(bool enabled = true, bool normal = false, string? location = place, DateTime? last = null, bool vr = false, bool steamVr = false) =>
        CrashRejoinModule.Decide(enabled, normal, location, last ?? longAgo, now, vr, steamVr);

    Assert(Run() == CrashRejoinDecision.Rejoin, "desktop crash");
    Assert(Run(vr: true, steamVr: true) == CrashRejoinDecision.Rejoin, "VR crash with SteamVR still open");
    Assert(Run(enabled: false) == CrashRejoinDecision.Off, "off must do nothing");
    Assert(Run(normal: true) == CrashRejoinDecision.QuitNormally, "a normal quit");
    Assert(Run(vr: true, steamVr: false) == CrashRejoinDecision.SteamVrClosedToo, "SteamVR closed too");
    Assert(Run(last: now.AddSeconds(-119)) == CrashRejoinDecision.TooSoon, "a crash loop");
    Assert(Run(last: now.AddSeconds(-121)) == CrashRejoinDecision.Rejoin, "after the guard");
    foreach (var bad in new[] { null, "", "offline", "private", "traveling", "wrld_noinstance", "local:abc" })
        Assert(Run(location: bad) == CrashRejoinDecision.NotInAnInstance, $"not an instance: {bad}");
    return Task.CompletedTask;
});

await Check("crash rejoin: recognises the log's normal exit lines, old and new", () =>
{
    Assert(CrashRejoinModule.IsNormalQuitLine("2022.06.12 01:51:46 Log        -  VRCApplication: OnApplicationQuit at 1603.499"), "old line");
    Assert(CrashRejoinModule.IsNormalQuitLine("2024.10.23 21:18:34 Log        -  VRCApplication: HandleApplicationQuit at 936.5161"), "new line");
    Assert(!CrashRejoinModule.IsNormalQuitLine("2024.10.23 21:18:34 Log        -  [Behaviour] Joining wrld_abc"), "other line");
    return Task.CompletedTask;
});

await Check("crash rejoin: it is off until you turn it on, and a loop is held back", async () =>
{
    var module = new CrashRejoinModule();
    var registry = new ModuleRegistry(OpenDb(Fresh("crash-rejoin")));
    registry.Register(module);
    await registry.StartAllAsync();
    Assert(!module.Enabled, "must default to off");
    Assert(module.DecideNow(false, "wrld_a:1", false, false) == CrashRejoinDecision.Off, "off");
    registry.SetSetting(CrashRejoinModule.ModuleId, "rejoin", "true");
    Assert(module.Enabled, "the toggle didn't reach the module");
    Assert(module.DecideNow(false, "wrld_a:1", false, false) == CrashRejoinDecision.Rejoin, "first crash");
    Assert(module.DecideNow(false, "wrld_a:1", false, false) == CrashRejoinDecision.TooSoon, "second crash straight after");
    await registry.StopAllAsync(TimeSpan.FromSeconds(5));
});

async Task<(HubHistoryModule Module, ModuleRegistry Registry)> StartHistory(HubDatabase db)
{
    var module = new HubHistoryModule();
    var registry = new ModuleRegistry(db);
    registry.Register(module);
    await registry.StartAllAsync();
    return (module, registry);
}

async Task<(HubHistoryModule Module, ModuleRegistry Registry)> NewHistory(string name) => await StartHistory(OpenDb(Fresh(name)));

await Check("history: the first sighting of a friend isn't a change, later ones are", async () =>
{
    var (module, registry) = await NewHistory("history-observe");
    module.ObserveFriend("usr_a", "Alice", "User");
    Assert(module.ReadFriendChanges().Count == 0, "a first sighting was recorded as a change");
    module.ObserveFriend("usr_a", "Alice", "User");
    Assert(module.ReadFriendChanges().Count == 0, "no change was recorded as a change");
    module.ObserveFriend("usr_a", "Alicia", "Known User");
    var changes = module.ReadFriendChanges();
    Assert(changes.Count == 2, $"expected a name and a trust change, got {changes.Count}");
    var name = changes.Single(c => c.Kind == "DisplayName");
    Assert(name.Old == "Alice" && name.New == "Alicia" && name.UserId == "usr_a", "name change has the wrong values");
    var trust = changes.Single(c => c.Kind == "TrustLevel");
    Assert(trust.Old == "User" && trust.New == "Known User", "trust change has the wrong values");
    module.ObserveFriend("usr_a", "", "");
    module.ObserveFriend("usr_a", "Alicia", "");
    Assert(module.ReadFriendChanges().Count == 2, "an update without a value was treated as a change");
    await registry.StopAllAsync(TimeSpan.FromSeconds(5));
});

await Check("embeds: picks the app's main window, not its helpers", () =>
{
    var picked = EmbedWindows.Pick(new[]
    {
        new EmbedCandidate(1, true, "", 1000, 800, false, false),
        new EmbedCandidate(2, true, "Tooltip", 1000, 800, false, true),
        new EmbedCandidate(3, true, "Dialog", 1000, 800, true, false),
        new EmbedCandidate(4, true, "Tiny", 100, 100, false, false),
        new EmbedCandidate(5, false, "Hidden and big", 3000, 2000, false, false),
        new EmbedCandidate(6, true, "Small", 400, 300, false, false),
        new EmbedCandidate(7, true, "Main", 1200, 900, false, false),
    });
    Assert(picked?.Handle == 7, $"picked {picked?.Handle}");
    var hidden = EmbedWindows.Pick(new[] { new EmbedCandidate(5, false, "In the tray", 1000, 800, false, false) });
    Assert(hidden?.Handle == 5, "an app hidden in the tray was not found");
    Assert(EmbedWindows.Pick(Array.Empty<EmbedCandidate>()) == null, "picked a window from nothing");
    return Task.CompletedTask;
});

await Check("embeds: geometry, blank pictures and the reported result", () =>
{
    var pane = new EmbedRect(10, 20, 800, 600);
    Assert(pane.Matches(new EmbedRect(11, 19, 802, 598)), "two pixels off should still match");
    Assert(!pane.Matches(new EmbedRect(10, 20, 803, 600)), "three pixels off matched");
    Assert(!pane.Matches(new EmbedRect(11, 20, 800, 600), 0), "an exact match accepted a difference");
    Assert(!new EmbedRect(0, 0, 39, 500).Usable, "a sliver of a pane counted as usable");
    Assert(!EmbedWindows.LooksDrawn(new[] { 5, 5, 5 }), "one flat colour counted as drawn");
    Assert(EmbedWindows.LooksDrawn(new[] { 5, 5, 6 }), "two colours counted as blank");

    var good = new[] { new EmbedCheck("A", true), new EmbedCheck("B", true) };
    var bad = new[] { new EmbedCheck("A", true), new EmbedCheck("B", false) };
    Assert(EmbedWindows.Summary(AppEmbedsModule.ModeChild, good, "today") == "Passed inside the pane on today.", "the passing summary changed");
    var failure = EmbedWindows.Summary(AppEmbedsModule.ModeTracked, bad, "today");
    Assert(failure.StartsWith("Failed in its own window") && failure.Contains("B") && !failure.Contains("A,"), failure);
    return Task.CompletedTask;
});

await Check("embeds: finds the app where it's installed, and a set path wins", () =>
{
    var library = Path.Combine(Path.GetTempPath(), "hub-embed-" + Guid.NewGuid().ToString("N"));
    var folder = Path.Combine(library, "steamapps", "common", "OyasumiVR");
    Directory.CreateDirectory(folder);
    var inSteam = Path.Combine(folder, "OyasumiVR.exe");
    File.WriteAllText(inSteam, "");
    var chosen = Path.Combine(library, "chosen.exe");
    File.WriteAllText(chosen, "");
    try
    {
        var app = AppEmbedsModule.Oyasumi;
        Assert(AppEmbedsModule.FindExe(app, "", new[] { library }) == inSteam, "the Steam copy was not found");
        Assert(AppEmbedsModule.FindExe(app, $"\"{chosen}\"", new[] { library }) == chosen, "the set path lost");
        Assert(AppEmbedsModule.FindExe(app, Path.Combine(library, "gone.exe"), new[] { library }) == null, "a wrong set path fell through to another copy");
        Assert(AppEmbedsModule.App("eagle") == AppEmbedsModule.Eagle && AppEmbedsModule.App("nope") == null, "an app id resolved wrongly");
    }
    finally { Directory.Delete(library, true); }
    return Task.CompletedTask;
});

await Check("embeds: apps are minimized when HapsHub closes unless another choice is saved", async () =>
{
    var registry = new ModuleRegistry(OpenDb(Fresh("embed-exit")));
    var module = new AppEmbedsModule();
    Assert(module.ExitAction == AppEmbedsModule.ExitMinimize, "a module that isn't running didn't fall back to minimize");
    registry.Register(module);
    await registry.StartAllAsync();
    Assert(module.ExitAction == AppEmbedsModule.ExitMinimize, "the default isn't minimize");
    var setting = Info(registry, AppEmbedsModule.ModuleId).Settings.Single(s => s.Definition.Key == AppEmbedsModule.ExitKey);
    Assert(setting.Definition.Kind == HubSettingKind.Choice && setting.Definition.Options.Count == 3, "the choice lost its options");
    registry.SetSetting(AppEmbedsModule.ModuleId, AppEmbedsModule.ExitKey, AppEmbedsModule.ExitClose);
    Assert(module.ExitAction == AppEmbedsModule.ExitClose, "a saved choice wasn't used");
    registry.SetSetting(AppEmbedsModule.ModuleId, AppEmbedsModule.ExitKey, "nonsense");
    Assert(module.ExitAction == AppEmbedsModule.ExitMinimize, "an unknown value wasn't treated as minimize");
    await registry.StopAllAsync(TimeSpan.FromSeconds(5));
});

await Check("tunnel: only YouTube links get through", () =>
{
    Assert(TunnelLink.Clean(" https://youtu.be/abc ") == "https://youtu.be/abc", "a short link was refused");
    Assert(TunnelLink.Clean("https://music.youtube.com/watch?v=abc") != null, "a YouTube Music link was refused");
    foreach (var bad in new[] { "", "--exec calc", "file:///C:/x.m4a", "https://youtube.com.evil.test/watch", "https://example.com/watch?v=abc", "javascript:alert(1)" })
        Assert(TunnelLink.Clean(bad) == null, $"accepted {bad}");
    return Task.CompletedTask;
});

await Check("tunnel: the link can't become an option, and a browser is only used when set", () =>
{
    var plain = YoutubeTunnelModule.BuildArguments("https://youtu.be/a", "out", "");
    Assert(plain[^2] == "--" && plain[^1] == "https://youtu.be/a", "the link isn't after the end of the options");
    Assert(!plain.Contains("--cookies-from-browser"), "asked for browser cookies without a browser");
    var runtime = plain.ToList().IndexOf("--js-runtimes");
    Assert(runtime >= 0 && plain[runtime + 1] == "node", "yt-dlp can't solve YouTube's challenge without a JavaScript runtime");
    Assert(plain.Contains("--ignore-config"), "a yt-dlp config file could change what runs");
    Assert(YoutubeTunnelModule.BuildArguments("https://youtu.be/a", "out", " firefox ").Contains("firefox"), "the browser was dropped");
    return Task.CompletedTask;
});

await Check("tunnel: only a file in our own folder is accepted as the result", () =>
{
    var folder = Path.Combine(Path.GetTempPath(), "tunnel-check");
    var inside = Path.Combine(folder, "tunnel-a.m4a");
    var track = YoutubeTunnelModule.ParseOutput($"A song\n{inside}\n", folder);
    Assert(track != null && track.Title == "A song" && track.Path == inside, "a normal result wasn't read");
    Assert(YoutubeTunnelModule.ParseOutput($"A song\n{Path.Combine(Path.GetTempPath(), "other.m4a")}\n", folder) == null, "a file elsewhere was accepted");
    Assert(YoutubeTunnelModule.ParseOutput($"{folder}2\\x.m4a", folder) == null, "one line was accepted");
    Assert(YoutubeTunnelModule.ParseOutput($"A song\n{folder}2\\x.m4a\n", folder) == null, "a neighbouring folder was accepted");
    return Task.CompletedTask;
});

await Check("tunnel: yt-dlp problems read as something you can act on", () =>
{
    Assert(YoutubeTunnelModule.Explain("ERROR: [youtube] abc: Sign in to confirm you're not a bot.").Contains("signed-in browser"), "the bot check wasn't explained");
    Assert(YoutubeTunnelModule.Explain("noise\nERROR: Private video\nmore").Contains("Private video"), "the error line wasn't picked");
    Assert(YoutubeTunnelModule.Explain("").Length > 0, "an empty error gave no message");
    return Task.CompletedTask;
});

await Check("tunnel: finds yt-dlp, and a wrong path isn't silently replaced", () =>
{
    var folder = Path.Combine(Path.GetTempPath(), $"tunnel-find-{Guid.NewGuid():N}");
    Directory.CreateDirectory(folder);
    var file = Path.Combine(folder, "yt-dlp.exe");
    File.WriteAllText(file, "");
    Assert(YoutubeTunnelModule.FindYtDlp("", folder) == file, "wasn't found on the PATH");
    Assert(YoutubeTunnelModule.FindYtDlp(file, "") == file, "the configured file wasn't used");
    Assert(YoutubeTunnelModule.FindYtDlp(file + ".missing", folder) == null, "a wrong path fell back to another copy");
    Directory.Delete(folder, true);
    return Task.CompletedTask;
});

await Check("tunnel: clearing removes only fetched songs", () =>
{
    var folder = Path.Combine(Path.GetTempPath(), $"tunnel-clear-{Guid.NewGuid():N}");
    Directory.CreateDirectory(folder);
    File.WriteAllText(Path.Combine(folder, "tunnel-a.m4a"), "x");
    File.WriteAllText(Path.Combine(folder, "keep.txt"), "x");
    new YoutubeTunnelModule(folder).ClearCache();
    Assert(!File.Exists(Path.Combine(folder, "tunnel-a.m4a")) && File.Exists(Path.Combine(folder, "keep.txt")), "cleared the wrong files");
    Directory.Delete(folder, true);
    return Task.CompletedTask;
});

const string BanA = "usr_11111111-1111-1111-1111-111111111111";
const string BanB = "usr_22222222-2222-2222-2222-222222222222";
const string BanC = "usr_33333333-3333-3333-3333-333333333333";

await Check("group bans: finds each ID once in any text, ignoring everything else", () =>
{
    var ids = GroupBanImport.Parse($"name,id\nOne,{BanA}\n{BanB.ToUpperInvariant()}; again {BanA}\nusr_short not-an-id");
    Assert(ids.SequenceEqual(new[] { BanA, BanB }), $"got {string.Join(",", ids)}");
    Assert(GroupBanImport.Parse(null).Count == 0 && GroupBanImport.Parse("nothing here").Count == 0, "found IDs in empty text");
    return Task.CompletedTask;
});

await Check("group bans: the plan leaves out you and people already banned, and caps a run", () =>
{
    var plan = GroupBanImport.Plan(new[] { BanA, BanB, BanC }, new[] { BanB.ToUpperInvariant() }, BanC);
    Assert(plan.ToBan.SequenceEqual(new[] { BanA }), "the plan kept the wrong people");
    Assert(plan.AlreadyBanned == 1 && plan.SkippedSelf && plan.OverLimit == 0, "the plan counted wrongly");
    var many = Enumerable.Range(0, GroupBanImport.MaxPerRun + 7).Select(i => $"usr_{i}").ToList();
    var capped = GroupBanImport.Plan(many, Array.Empty<string>(), null);
    Assert(capped.ToBan.Count == GroupBanImport.MaxPerRun && capped.OverLimit == 7, "the run wasn't capped");
    return Task.CompletedTask;
});

await Check("group bans: a run does each person once and reports progress", async () =>
{
    var called = new List<string>();
    var seen = new List<(int, int)>();
    var result = await GroupBanImport.RunAsync(new[] { BanA, BanB, BanC },
        (id, _) => { called.Add(id); return Task.FromResult(id == BanB ? BanOutcome.Failed : BanOutcome.Done); },
        TimeSpan.Zero, (done, total) => seen.Add((done, total)));
    Assert(called.SequenceEqual(new[] { BanA, BanB, BanC }), "people were skipped or repeated");
    Assert(result.Done.SequenceEqual(new[] { BanA, BanC }) && result.Failed.SequenceEqual(new[] { BanB }), "results are wrong");
    Assert(result.NotTried == 0 && result.StoppedBecause == "", "a finished run reported a stop");
    Assert(seen.Count == 3 && seen[^1] == (3, 3), "progress is wrong");
});

await Check("group bans: being rate limited stops the run at once and doesn't count that person", async () =>
{
    var calls = 0;
    var result = await GroupBanImport.RunAsync(new[] { BanA, BanB, BanC },
        (_, _) => Task.FromResult(++calls == 2 ? BanOutcome.RateLimited : BanOutcome.Done), TimeSpan.Zero);
    Assert(calls == 2, $"it carried on after the limit, {calls} calls");
    Assert(result.StoppedBecause == GroupBanImport.StoppedRateLimited, "the reason is wrong");
    Assert(result.Done.Count == 1 && result.Failed.Count == 0 && result.NotTried == 2, "the counts are wrong");
});

await Check("group bans: repeated failures stop the run, one failure doesn't", async () =>
{
    var ids = Enumerable.Range(0, 10).Select(i => $"usr_{i}").ToList();
    var calls = 0;
    var result = await GroupBanImport.RunAsync(ids, (_, _) => { calls++; return Task.FromResult(BanOutcome.Failed); }, TimeSpan.Zero);
    Assert(calls == GroupBanImport.MaxFailuresInARow, $"{calls} calls before stopping");
    Assert(result.StoppedBecause == GroupBanImport.StoppedFailures && result.NotTried == 7, "the stop is wrong");
});

await Check("group bans: a network error counts as one failure and keeps who was already done", async () =>
{
    var calls = 0;
    var result = await GroupBanImport.RunAsync(new[] { BanA, BanB, BanC }, (_, _) =>
    {
        if (++calls == 2) throw new HttpRequestException("connection dropped");
        return Task.FromResult(BanOutcome.Done);
    }, TimeSpan.Zero);
    Assert(result.Done.SequenceEqual(new[] { BanA, BanC }) && result.Failed.SequenceEqual(new[] { BanB }), "the record is wrong");
    Assert(result.NotTried == 0 && result.StoppedBecause == "", "one error stopped the run");
    var timedOut = await GroupBanImport.RunAsync(new[] { BanA },
        (_, _) => throw new TaskCanceledException("timeout"), TimeSpan.Zero);
    Assert(timedOut.Failed.Count == 1 && timedOut.StoppedBecause == "", "a timeout was taken for the user stopping it");
});

await Check("group bans: stopping during the pause leaves the rest untouched", async () =>
{
    using var cancel = new CancellationTokenSource();
    var calls = 0;
    var result = await GroupBanImport.RunAsync(new[] { BanA, BanB, BanC },
        (_, _) => { calls++; cancel.Cancel(); return Task.FromResult(BanOutcome.Done); },
        TimeSpan.FromSeconds(30), null, cancel.Token);
    Assert(calls == 1 && result.StoppedBecause == GroupBanImport.StoppedCancelled, "it didn't stop");
    Assert(result.Done.Count == 1 && result.NotTried == 2, "the counts are wrong");
});

await Check("history: a friend first seen without a name or trust doesn't stop the rest of the list", async () =>
{
    var (module, registry) = await NewHistory("history-no-tags");
    module.ObserveFriends(new[] { ("usr_no_trust", "Nina", ""), ("usr_no_name", "", "User"), ("usr_next", "Nate", "User") });
    module.ObserveFriend("usr_next", "Nathan", "User");
    var changes = module.ReadFriendChanges();
    Assert(changes.Count == 1 && changes[0].New == "Nathan", "the friend after the empty ones wasn't remembered");
    module.ObserveFriend("usr_no_trust", "Nina", "Known User");
    Assert(module.ReadFriendChanges().Count == 1, "learning a missing trust was recorded as a change");
    await registry.StopAllAsync(TimeSpan.FromSeconds(5));
});

await Check("history: a full friend list is quick, the first time and every time after", async () =>
{
    var (module, registry) = await NewHistory("history-many");
    var friends = Enumerable.Range(0, 1000).Select(i => ($"usr_{i}", $"Friend {i}", "User")).ToList();
    var first = System.Diagnostics.Stopwatch.StartNew();
    module.ObserveFriends(friends);
    first.Stop();
    var again = System.Diagnostics.Stopwatch.StartNew();
    module.ObserveFriends(friends);
    again.Stop();
    Console.WriteLine($"      1000 friends: first {first.ElapsedMilliseconds} ms, again {again.ElapsedMilliseconds} ms");
    Assert(module.ReadFriendChanges().Count == 0, "no one changed");
    Assert(again.ElapsedMilliseconds < 100, $"unchanged friends took {again.ElapsedMilliseconds} ms");
    await registry.StopAllAsync(TimeSpan.FromSeconds(5));
});

await Check("history: known friends survive a restart, so changes while closed are caught", async () =>
{
    var dir = Fresh("history-restart");
    var (module, registry) = await StartHistory(OpenDb(dir));
    module.ObserveFriend("usr_b", "Bob", "User");
    await registry.StopAllAsync(TimeSpan.FromSeconds(5));

    (module, registry) = await StartHistory(OpenDb(dir));
    module.ObserveFriend("usr_b", "Robert", "User");
    var changes = module.ReadFriendChanges();
    Assert(changes.Count == 1 && changes[0].Old == "Bob" && changes[0].New == "Robert", $"got {changes.Count} changes");
    await registry.StopAllAsync(TimeSpan.FromSeconds(5));
});

await Check("history: trust names follow VRChat's order", () =>
{
    Assert(HubHistoryModule.TrustFromTags(new[] { "system_trust_basic", "system_trust_known", "system_trust_trusted", "system_trust_veteran" }) == "Trusted User", "veteran");
    Assert(HubHistoryModule.TrustFromTags(new[] { "system_trust_basic", "system_trust_known", "system_trust_trusted" }) == "Known User", "trusted");
    Assert(HubHistoryModule.TrustFromTags(new[] { "system_trust_basic", "system_trust_known" }) == "User", "known");
    Assert(HubHistoryModule.TrustFromTags(new[] { "system_trust_basic" }) == "New User", "basic");
    Assert(HubHistoryModule.TrustFromTags(new[] { "language_eng" }) == "Visitor", "visitor");
    Assert(HubHistoryModule.TrustFromTags(null) == "" && HubHistoryModule.TrustFromTags(Array.Empty<string>()) == "", "no tags must mean unknown");
    return Task.CompletedTask;
});

await Check("history: portals are recorded and read back", async () =>
{
    var (module, registry) = await NewHistory("history-portal");
    module.AddPortal("spawn", "wrld_x:1", "A World");
    module.AddPortal("used", "wrld_x:1", "A World");
    var rows = module.ReadPortals();
    Assert(rows.Count == 2 && rows.Any(r => r.Kind == "spawn" && r.Text == "A World" && r.Link == "wrld_x:1"), "portal rows are wrong");
    await registry.StopAllAsync(TimeSpan.FromSeconds(5));
});

await Check("history: pages sort newest first, search, and merge one event logged by two apps", () =>
{
    HubHistoryRow Row(string at, string text, string key = "", string source = "HapsHub") => new(at, "k", "", "", "", "", text, "", source, key);
    var rows = new[]
    {
        Row("2026-01-01T00:00:00Z", "oldest"),
        Row("2026-01-03T00:00:00Z", "newest", "same"),
        Row("2026-01-03T00:00:30Z", "duplicate", "same", "VRCX"),
        Row("2026-01-02T01:00:00+02:00", "middle"),
        Row("not a date", "undated"),
    };
    var page = HubHistoryViews.Page(rows, "", 0, 10);
    Assert(page.Total == 4, $"total {page.Total}");
    Assert(string.Join(",", page.Rows.Select(r => r.Text)) == "newest,middle,oldest,undated", string.Join(",", page.Rows.Select(r => r.Text)));
    var second = HubHistoryViews.Page(rows, "", 2, 1);
    Assert(second.Rows.Single().Text == "oldest" && second.Total == 4 && second.Offset == 2, "second page is wrong");
    var replays = new[] { Row("2026-01-03T00:00:00Z", "first play", "same", "VRCX"), Row("2026-01-03T00:00:30Z", "second play", "same", "VRCX") };
    Assert(HubHistoryViews.Page(replays, "", 0, 10).Total == 2, "two plays logged by one app are two plays");
    var found = HubHistoryViews.Page(rows, "MIDD", 0, 10);
    Assert(found.Total == 1 && found.Rows[0].Text == "middle", "search is wrong");
    return Task.CompletedTask;
});

await Check("history: archived rows become page lines, for every account, and only the right kinds", () =>
{
    var dir = Fresh("history-archive");
    var path = Path.Combine(dir, "vrcx-history.db");
    using (var connection = new Microsoft.Data.Sqlite.SqliteConnection($"Data Source={path};Pooling=False"))
    {
        connection.Open();
        using var command = connection.CreateCommand();
        command.CommandText = "CREATE TABLE vrcx_rows (source_table TEXT NOT NULL, row_hash BLOB NOT NULL, row_json TEXT NOT NULL, PRIMARY KEY (source_table, row_hash)) WITHOUT ROWID;";
        command.ExecuteNonQuery();
        var id = 0;
        void Add(string table, string json)
        {
            using var insert = connection.CreateCommand();
            insert.CommandText = "INSERT INTO vrcx_rows VALUES($t, $h, $j)";
            insert.Parameters.AddWithValue("$t", table);
            insert.Parameters.AddWithValue("$h", BitConverter.GetBytes(++id));
            insert.Parameters.AddWithValue("$j", json);
            insert.ExecuteNonQuery();
        }
        Add("usra_friend_log_history", """{"created_at":"2026-01-01T00:00:00Z","type":"DisplayName","user_id":"usr_a","display_name":"New","previous_display_name":"Old"}""");
        Add("usrb_friend_log_history", """{"created_at":"2026-01-02T00:00:00Z","type":"TrustLevel","user_id":"usr_b","display_name":"B","trust_level":"Known User","previous_trust_level":"User"}""");
        Add("usrb_friend_log_history", """{"created_at":"2026-01-03T00:00:00Z","type":"Unfriend","user_id":"usr_c","display_name":"C"}""");
        Add("usra_notifications", """{"id":"not_1","created_at":"2026-01-04T00:00:00Z","type":"invite","sender_username":"D","sender_user_id":"usr_d","message":"hi","world_name":"W"}""");
        Add("usra_notifications_v2", """{"id":"not_2","created_at":"2026-01-05T00:00:00Z","type":"boop","title":"T","message":"M","sender_user_id":null}""");
        Add("gamelog_video_play", """{"created_at":"2026-01-06T00:00:00Z","video_url":"https://x/y","video_name":"Song","display_name":"E","user_id":"usr_e"}""");
        Add("usra_avatar_history", """{"avatar_id":"avtr_1","created_at":"2026-01-07T00:00:00Z","time":120000}""");
        Add("usra_feed_avatar", """{"created_at":"2026-01-08T00:00:00Z","display_name":"F","user_id":"usr_f","avatar_name":"Fancy"}""");
        Add("gamelog_event", """{"created_at":"2026-01-09T00:00:00Z","data":"VideoError: x"}""");
        Add("usra_friend_log_history_extra", """{"created_at":"2026-01-10T00:00:00Z","type":"DisplayName"}""");
        Add("usra_notifications", """not json at all""");
    }
    Microsoft.Data.Sqlite.SqliteConnection.ClearAllPools();
    var archive = new VrcxHistoryModule(() => false, path, Path.Combine(dir, "work"));

    var names = HubHistoryViews.FromArchive(archive, "names");
    Assert(names.Count == 2, $"names {names.Count}");
    var name = names.Single(r => r.Kind == "DisplayName");
    Assert(name.Old == "Old" && name.New == "New" && name.UserId == "usr_a" && name.Source == "VRCX", "name row is wrong");
    Assert(names.Single(r => r.Kind == "TrustLevel").New == "Known User", "trust row is wrong");
    var friends = HubHistoryViews.FromArchive(archive, "friends");
    Assert(friends.Count == 1 && friends[0].Kind == "Unfriend", "friend log is wrong");
    var notes = HubHistoryViews.FromArchive(archive, "notifications");
    Assert(notes.Count == 2, $"a bad row must be skipped, not stop the rest: {notes.Count}");
    Assert(notes.Any(r => r.Key == "not_1" && r.Text == "hi" && r.New == "W"), "old notification is wrong");
    Assert(notes.Any(r => r.Key == "not_2" && r.Text == "T: M"), "new notification is wrong");
    var videos = HubHistoryViews.FromArchive(archive, "videos");
    Assert(videos.Single().Link == "https://x/y" && videos[0].Text == "Song", "video is wrong");
    Assert(videos[0].Key.Length > 0, "videos need a key so both apps' logs merge");
    var avatars = HubHistoryViews.FromArchive(archive, "avatars");
    Assert(avatars.Single().Link == "avtr_1" && avatars[0].New == "120000", "avatar is wrong");
    Assert(HubHistoryViews.FromArchive(archive, "friendavatars").Single().Text == "Fancy", "friend avatar is wrong");
    Assert(HubHistoryViews.FromArchive(archive, "gamelog").Single().Text == "VideoError: x", "game event is wrong");
    Assert(HubHistoryViews.FromArchive(archive, "nope").Count == 0, "an unknown view must be empty");
    return Task.CompletedTask;
});

await Check("history: no archive yet means empty lists, not an error", () =>
{
    var dir = Fresh("history-noarchive");
    var archive = new VrcxHistoryModule(() => false, Path.Combine(dir, "missing.db"), Path.Combine(dir, "work"));
    Assert(HubHistoryViews.FromArchive(archive, "names").Count == 0, "expected nothing");
    return Task.CompletedTask;
});

(VrcxHistoryModule Module, string Source, string Archive) NewVrcx(string name, Func<bool>? running = null)
{
    var dir = Fresh(name);
    var source = Path.Combine(dir, "VRCX.sqlite3");
    using (var db = new Microsoft.Data.Sqlite.SqliteConnection($"Data Source={source};Pooling=False"))
    {
        db.Open();
        using var command = db.CreateCommand();
        command.CommandText = """
            CREATE TABLE cookies (key TEXT, value TEXT); INSERT INTO cookies VALUES ('auth', 'SECRET-COOKIE');
            CREATE TABLE configs (key TEXT, value TEXT); INSERT INTO configs VALUES ('login', 'SECRET-CONFIG');
            CREATE TABLE cache_world (id TEXT); INSERT INTO cache_world VALUES ('w');
            CREATE TABLE usrabc_feed_avatar (id INTEGER PRIMARY KEY, name TEXT, thumb BLOB, score REAL, gone TEXT);
            INSERT INTO usrabc_feed_avatar VALUES (1, 'one "quoted"', x'00FF', 1.5, NULL), (2, 'two', NULL, NULL, NULL);
            CREATE TABLE usrdef_feed_avatar (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO usrdef_feed_avatar VALUES (1, 'other account');
            CREATE TABLE gamelog_video_play (id INTEGER PRIMARY KEY, video_url TEXT); INSERT INTO gamelog_video_play VALUES (1, 'u');
            CREATE TABLE memos (user_id TEXT, memo TEXT);
            """;
        command.ExecuteNonQuery();
    }
    var module = new VrcxHistoryModule(running ?? (() => false), Path.Combine(dir, "archive", "vrcx-history.db"));
    return (module, source, module.ArchivePath);
}

static List<string> ArchivedJson(string archive)
{
    var rows = new List<string>();
    using var db = new Microsoft.Data.Sqlite.SqliteConnection($"Data Source={archive};Mode=ReadOnly;Pooling=False");
    db.Open();
    using var command = db.CreateCommand();
    command.CommandText = "SELECT source_table || ' ' || row_json FROM vrcx_rows ORDER BY 1;";
    using var reader = command.ExecuteReader();
    while (reader.Read()) rows.Add(reader.GetString(0));
    return rows;
}

await Check("vrcx: copies every history row, keeps accounts apart and every value type", async () =>
{
    var (module, source, archive) = NewVrcx("vrcx-copy");
    var result = module.Run(source);
    Assert(result.Complete, result.Error ?? "not complete");
    Assert(result.Tables.Count == 4, $"{result.Tables.Count} tables");
    var rows = ArchivedJson(archive);
    Assert(rows.Count == 4, $"{rows.Count} rows");
    Assert(rows.Any(r => r.StartsWith("usrabc_feed_avatar ") && r.Contains("\"thumb\":{\"$bytes\":\"AP8=\"}") && r.Contains("\"score\":1.5") && r.Contains("\"gone\":null")), "values lost");
    Assert(rows.Any(r => r.StartsWith("usrdef_feed_avatar ")), "second account lost");
    await Task.CompletedTask;
});

await Check("vrcx: the login is never copied, and skipped tables are listed", async () =>
{
    var (module, source, archive) = NewVrcx("vrcx-secret");
    var result = module.Run(source);
    Assert(ArchivedJson(archive).All(r => !r.Contains("SECRET")), "login copied");
    var bytes = File.ReadAllBytes(archive);
    Assert(!Encoding.UTF8.GetString(bytes).Contains("SECRET"), "login in the file");
    Assert(new[] { "cookies", "configs", "cache_world" }.All(t => result.Skipped.Any(s => s.Table == t)), "skipped table not listed");
    await Task.CompletedTask;
});

await Check("vrcx: repeating adds only new rows", async () =>
{
    var (module, source, archive) = NewVrcx("vrcx-repeat");
    module.Run(source);
    var again = module.Run(source);
    Assert(again.Complete && again.Tables.Sum(t => t.Added) == 0, $"added {again.Tables.Sum(t => t.Added)}");
    using (var db = new Microsoft.Data.Sqlite.SqliteConnection($"Data Source={source};Pooling=False"))
    {
        db.Open();
        using var command = db.CreateCommand();
        command.CommandText = "INSERT INTO gamelog_video_play VALUES (2, 'new');";
        command.ExecuteNonQuery();
    }
    var third = module.Run(source);
    Assert(third.Complete && third.Tables.Sum(t => t.Added) == 1, $"added {third.Tables.Sum(t => t.Added)}");
    Assert(ArchivedJson(archive).Count == 5, "row count wrong");
    Assert(module.ReadSummary().Sum(t => t.ArchivedTotal) == 5, "summary wrong");
    await Task.CompletedTask;
});

await Check("vrcx: leaves the source alone and removes its temporary copy", async () =>
{
    var (module, source, archive) = NewVrcx("vrcx-untouched");
    var before = File.ReadAllBytes(source);
    var stamp = File.GetLastWriteTimeUtc(source);
    module.Run(source);
    Assert(before.SequenceEqual(File.ReadAllBytes(source)) && stamp == File.GetLastWriteTimeUtc(source), "source changed");
    Assert(!Directory.GetDirectories(Path.GetDirectoryName(archive)!).Any(d => Path.GetFileName(d).StartsWith("vrcx-read-")), "temp copy left");
    await Task.CompletedTask;
});

await Check("vrcx: refuses while VRCX runs or the file is missing, and a bad file fails cleanly", async () =>
{
    var (blocked, source, archive) = NewVrcx("vrcx-blocked", () => true);
    var result = blocked.Run(source);
    Assert(result.Error != null && !result.Complete && !File.Exists(archive), "ran while VRCX was open");
    var (module, _, _) = NewVrcx("vrcx-missing");
    Assert(module.Run(Path.Combine(Fresh("vrcx-none"), "nope.sqlite3")).Error != null, "missing file not reported");
    var bad = Path.Combine(Fresh("vrcx-bad"), "bad.sqlite3");
    File.WriteAllText(bad, "this is not a database, it just has a name that looks like one");
    Assert(module.Run(bad).Error != null, "bad file not reported");
    await Task.CompletedTask;
});

await Check("notes: the export quotes properly and can't smuggle in a formula", () =>
{
    var csv = NotesExport.BuildCsv(new[]
    {
        new ExportedNote("user", "usr_1", "Name, with comma", "said \"hi\"\nline two", "2026", "VRCX"),
        new ExportedNote("user", "usr_2", "=Sneaky", "=SUM(A1)", "", "HapsHub"),
    });
    var lines = csv.Split("\r\n");
    Assert(lines[0] == "kind,id,name,note,edited,source", "header");
    Assert(lines[1] == "user,usr_1,\"Name, with comma\",\"said \"\"hi\"\"\nline two\",2026,VRCX", "quoting: " + lines[1]);
    Assert(lines[2] == "user,usr_2,'=Sneaky,'=SUM(A1),,HapsHub", "formula guard: " + lines[2]);
    return Task.CompletedTask;
});

await Check("vrcx: the archive pages newest first, searches literally and reads VRCX's notes", async () =>
{
    var dir = Fresh("vrcx-browse");
    var path = Path.Combine(dir, "archive.db");
    using (var db = new Microsoft.Data.Sqlite.SqliteConnection($"Data Source={path}"))
    {
        db.Open();
        using var command = db.CreateCommand();
        command.CommandText = """
            CREATE TABLE vrcx_rows (source_table TEXT NOT NULL, row_hash BLOB NOT NULL, row_json TEXT NOT NULL, PRIMARY KEY (source_table, row_hash)) WITHOUT ROWID;
            INSERT INTO vrcx_rows VALUES ('feed', x'01', '{"created_at":"2024","name":"old 100%"}');
            INSERT INTO vrcx_rows VALUES ('feed', x'02', '{"created_at":"2026","name":"new"}');
            INSERT INTO vrcx_rows VALUES ('feed', x'03', '{"created_at":"2025","name":"middle"}');
            INSERT INTO vrcx_rows VALUES ('memos', x'04', '{"user_id":"usr_1","memo":"nice","edited_at":"2025"}');
            INSERT INTO vrcx_rows VALUES ('memos', x'05', '{"user_id":"usr_2","memo":"","edited_at":"2025"}');
            INSERT INTO vrcx_rows VALUES ('world_memos', x'06', '{"world_id":"wrld_1","memo":"fun","edited_at":"2024"}');
            """;
        command.ExecuteNonQuery();
    }
    Microsoft.Data.Sqlite.SqliteConnection.ClearAllPools();
    var module = new VrcxHistoryModule(() => false, path);
    var page = module.ReadRows("feed", "", 0, 2);
    Assert(page.Rows.Count == 2 && page.More && page.Rows[0].Contains("new") && page.Rows[1].Contains("middle"), "first page");
    var last = module.ReadRows("feed", "", 2, 2);
    Assert(last.Rows.Count == 1 && !last.More && last.Rows[0].Contains("old"), "last page");
    Assert(module.ReadRows("feed", "100%", 0, 10).Rows.Count == 1, "a percent sign is literal");
    Assert(module.ReadRows("feed", "%", 0, 10).Rows.Count == 1, "a lone percent matches only itself");
    var notes = module.ReadNotes();
    Assert(notes.Count == 2 && notes.Any(n => n.Kind == "user" && n.Id == "usr_1" && n.Note == "nice") && notes.Any(n => n.Kind == "world" && n.Id == "wrld_1"), "notes: " + notes.Count);
    Microsoft.Data.Sqlite.SqliteConnection.ClearAllPools();
    await Task.CompletedTask;
});

await Check("vrcx: the import ledger stops a repeat doubling times, and survives restart", async () =>
{
    var dir = Fresh("vrcx-ledger");
    var first = new VrcxHistoryModule(() => false, Path.Combine(dir, "a.db"));
    Assert(first.ReadMergeLedger("world_seconds") == null, "ledger read before the module started");
    var registry = new ModuleRegistry(OpenDb(dir));
    registry.Register(first);
    await registry.StartAllAsync();
    var empty = first.ReadMergeLedger("world_seconds")!;
    Assert(VrcxHistoryModule.Remaining(empty, "w", 100) == 100, "first import should add everything");
    Assert(first.SaveMergeLedger("world_seconds", new[] { ("w", 100L) }), "not saved");
    var ledger = first.ReadMergeLedger("world_seconds")!;
    Assert(VrcxHistoryModule.Remaining(ledger, "w", 100) == 0, "repeat added time");
    Assert(VrcxHistoryModule.Remaining(ledger, "w", 130) == 30, "growth not added");
    Assert(VrcxHistoryModule.Remaining(ledger, "w", 90) == 0, "a smaller total took time away");
    Assert(first.ReadMergeLedger("user_seconds")!.Count == 0, "kinds mixed");
    Assert(first.SaveMergeLedger("world_seconds", new[] { ("w", 50L) }) && first.ReadMergeLedger("world_seconds")!["w"] == 100, "ledger went backwards");
    await registry.StopAllAsync(TimeSpan.FromSeconds(5));

    var second = new VrcxHistoryModule(() => false, Path.Combine(dir, "a.db"));
    var reopened = new ModuleRegistry(OpenDb(dir));
    reopened.Register(second);
    await reopened.StartAllAsync();
    Assert(second.ReadMergeLedger("world_seconds")!["w"] == 100, "ledger lost");
    await reopened.StopAllAsync(TimeSpan.FromSeconds(5));
});

// ---- Host ----

await Check("host: the db opens in the background and Stop is bounded", async () =>
{
    var module = new FakeModule("m");
    var host = HubHost.Start(new IHubModule[] { module });
    for (var i = 0; i < 300 && module.Started == 0; i++) await Task.Delay(10);
    Assert(module.Started == 1, "module never started");
    Assert(host.Database.IsAvailable, "database unavailable: " + host.Database.LastError);
    var watch = Stopwatch.StartNew();
    host.Stop(TimeSpan.FromSeconds(2));
    Assert(watch.Elapsed < TimeSpan.FromSeconds(2.5), $"stop took {watch.Elapsed}");
    Assert(module.Stopped == 1, "module not stopped");
    Assert(File.Exists(Path.Combine(HubPaths.HubRoot, "hub.log")), "no log written");
});

await Check("image shape: headers give width and height for each format", () =>
{
    static byte[] Pad(byte[] b) { var o = new byte[Math.Max(64, b.Length)]; b.CopyTo(o, 0); return o; }
    var png = Pad(new byte[] { 0x89, (byte)'P', (byte)'N', (byte)'G', 13, 10, 26, 10, 0, 0, 0, 13, (byte)'I', (byte)'H', (byte)'D', (byte)'R', 0, 0, 7, 128, 0, 0, 4, 56 });
    Assert(ImageShape.Read(png) == (1920, 1080), "png");
    var gif = Pad(new byte[] { (byte)'G', (byte)'I', (byte)'F', (byte)'8', (byte)'9', (byte)'a', 100, 0, 200, 0 });
    Assert(ImageShape.Read(gif) == (100, 200), "gif");
    var bmp = new byte[64]; bmp[0] = (byte)'B'; bmp[1] = (byte)'M';
    BitConverter.GetBytes(640).CopyTo(bmp, 18); BitConverter.GetBytes(-480).CopyTo(bmp, 22);
    Assert(ImageShape.Read(bmp) == (640, 480), "bmp");
    var jpg = Pad(new byte[] { 0xFF, 0xD8, 0xFF, 0xE0, 0, 4, 0, 0, 0xFF, 0xC0, 0, 17, 8, 0x04, 0x38, 0x07, 0x80, 3 });
    Assert(ImageShape.Read(jpg) == (1920, 1080), "jpeg");
    var webp = new byte[64];
    System.Text.Encoding.ASCII.GetBytes("RIFF").CopyTo(webp, 0); System.Text.Encoding.ASCII.GetBytes("WEBPVP8X").CopyTo(webp, 8);
    webp[24] = 0x7F; webp[25] = 0x07; webp[27] = 0x37; webp[28] = 0x04; // 1920-1, 1080-1
    Assert(ImageShape.Read(webp) == (1920, 1080), "webp");
    Assert(ImageShape.Read(new byte[64]) == null, "unknown format gives null");
    var file = Path.Combine(root, "tall.png");
    File.WriteAllBytes(file, Pad(new byte[] { 0x89, (byte)'P', (byte)'N', (byte)'G', 13, 10, 26, 10, 0, 0, 0, 13, (byte)'I', (byte)'H', (byte)'D', (byte)'R', 0, 0, 4, 56, 0, 0, 7, 128 }));
    Assert(!ImageShape.IsLandscape(file), "portrait file is not landscape");
    Assert(!ImageShape.IsLandscape(Path.Combine(root, "missing.png")), "missing file is not landscape");
    return Task.CompletedTask;
});

await Check("launch addons: unknown kinds find nothing; running programs are skipped", () =>
{
    Assert(LaunchAddons.Detect("nope").Count == 0, "unknown kind");
    var known = LaunchAddons.KnownVrApps();
    Assert(string.Join(",", known.Select(a => a.Id)) == "oyasumi,standable,vrct", "known VR apps keep their order");
    Assert(known.All(a => a.Path == null || File.Exists(a.Path)), "a known app's path is a real file or null");
    var self = Environment.ProcessPath!;
    Assert(LaunchAddons.NotRunning(new[] { self }).Count == 0, "this test's own exe counts as running");
    Assert(LaunchAddons.NotRunning(new[] { @"C:\nowhere\hub-never-runs-1234.exe" }).Count == 1, "a program that isn't running stays");
    return Task.CompletedTask;
});

await Check("source update: reads the commit from .git and updates only a Release copy that's behind", () =>
{
    const string a = "1111111111111111111111111111111111111111", b = "2222222222222222222222222222222222222222";
    var repo = Path.Combine(root, "update-repo");
    var git = Path.Combine(repo, ".git");
    Directory.CreateDirectory(Path.Combine(git, "refs", "heads", "hub"));
    File.WriteAllText(Path.Combine(repo, "VRCNext.csproj"), "<Project />");
    File.WriteAllText(Path.Combine(git, "HEAD"), "ref: refs/heads/hub/canvas\n");
    File.WriteAllText(Path.Combine(git, "refs", "heads", "hub", "canvas"), a + "\n");
    Assert(SourceUpdate.HeadCommit(git) == a, "a branch's own file gives its commit");
    File.Delete(Path.Combine(git, "refs", "heads", "hub", "canvas"));
    File.WriteAllText(Path.Combine(git, "packed-refs"), "# pack-refs with: peeled fully-peeled sorted\n" + b + " refs/heads/hub/canvas\n");
    Assert(SourceUpdate.HeadCommit(git) == b, "a packed branch gives its commit");
    File.WriteAllText(Path.Combine(git, "HEAD"), a);
    Assert(SourceUpdate.HeadCommit(git) == a, "a detached HEAD is the commit itself");

    var exeDir = Path.Combine(repo, "bin", "Release", "net10.0-windows10.0.19041.0");
    Directory.CreateDirectory(exeDir);
    Assert(SourceUpdate.RepositoryOf(exeDir) == new DirectoryInfo(repo).FullName, "the repository is found from bin\\Release");
    Assert(SourceUpdate.IsReleaseBuildIn(repo, exeDir), "a Release copy in the repository updates");
    Assert(!SourceUpdate.IsReleaseBuildIn(repo, Path.Combine(repo, "bin", "Debug", "net10.0-windows10.0.19041.0")), "a Debug copy doesn't");
    Assert(SourceUpdate.RepositoryOf(Path.Combine(root, "elsewhere")) == null, "a copy outside a repository has none");

    Assert(SourceUpdate.Behind(a, b), "a new commit means an update");
    Assert(!SourceUpdate.Behind(a, a), "the same commit means none");
    Assert(!SourceUpdate.Behind(null, b), "a copy that doesn't know its commit never updates, so it can't loop");
    Assert(!SourceUpdate.Behind(a, "not a commit"), "an unreadable HEAD means none");
    return Task.CompletedTask;
});

await Check("ovras: changes only the edited lines and keeps the file's bytes", () =>
{
    var original = "[playspaceSettings]\r\nlockXToggle=false\r\ngravityStrength=9.8\r\nsnapTurnAngle=4500\r\n[applicationSettings]\r\nappVolume=0.7\r\nautoApplyChaperoneName=\\xabnone\\xbb\r\n";
    var values = OvrasSettings.Read(original);
    Assert((double)values["snapTurnAngle"] == 45, "the snap angle wasn't shown in degrees");
    Assert((double)values["gravityStrength"] == 9.8, "gravity wasn't read");
    Assert((bool)values["lockXToggle"] == false, "a bool wasn't read");
    Assert((double)values["dragMult"] == 1, "a missing key didn't get its default");

    var changes = new Dictionary<string, string>
    {
        ["gravityStrength"] = OvrasSettings.Format("gravityStrength", "0")!,
        ["snapTurnAngle"] = OvrasSettings.Format("snapTurnAngle", "30")!,
        ["lockXToggle"] = OvrasSettings.Format("lockXToggle", "True")!,
        ["dragMult"] = OvrasSettings.Format("dragMult", "2.5")!,
    };
    var updated = OvrasSettings.Apply(original, OvrasSettings.Section, changes);
    Assert(updated == "[playspaceSettings]\r\nlockXToggle=true\r\ngravityStrength=0\r\nsnapTurnAngle=3000\r\ndragMult=2.5\r\n[applicationSettings]\r\nappVolume=0.7\r\nautoApplyChaperoneName=\\xabnone\\xbb\r\n",
        "the file changed in the wrong places: " + updated.Replace("\r\n", "|"));
    Assert(OvrasSettings.Apply(original, OvrasSettings.Section, new Dictionary<string, string>()) == original, "no change still changed the file");
    Assert(OvrasSettings.Format("gravityStrength", "-1") == null, "a value below the range was accepted");
    Assert(OvrasSettings.Format("snapTurnAngle", "NaN") == null, "NaN was accepted");
    Assert(OvrasSettings.Format("enableDebug", "true") == null, "a key the page doesn't offer was accepted");
    Assert(OvrasSettings.Apply("", OvrasSettings.Section, changes).StartsWith("[playspaceSettings]\n"), "a missing section wasn't added");

    var file = Path.Combine(root, "ovras", "OVR Advanced Settings.ini");
    Directory.CreateDirectory(Path.GetDirectoryName(file)!);
    File.WriteAllText(file, original);
    OvrasSettings.Save(file, changes);
    Assert(File.ReadAllText(Path.Combine(root, "ovras", "OVR Advanced Settings" + OvrasSettings.BackupSuffix)) == original, "the backup isn't the old file");
    Assert(File.ReadAllText(file) == updated, "the saved file isn't the edited text");
    return Task.CompletedTask;
});

SqliteConnection.ClearAllPools();
try { Directory.Delete(root, recursive: true); }
catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { }

Console.WriteLine(failures == 0 ? "All checks passed." : $"{failures} check(s) failed.");
return failures == 0 ? 0 : 1;

// HubPaths caches its root for the process, so each root rule is checked in a new child process.
static string ResolvePath(string? overrideDir, params string[] parts)
{
    var info = new ProcessStartInfo(Environment.ProcessPath!)
    {
        RedirectStandardOutput = true,
        UseShellExecute = false,
    };
    info.ArgumentList.Add("--print-path");
    foreach (var part in parts) info.ArgumentList.Add(part);
    info.Environment[HubPaths.DataDirVariable] = overrideDir ?? "";
    using var child = Process.Start(info)!;
    var output = child.StandardOutput.ReadToEnd().Trim();
    child.WaitForExit();
    return output;
}

static Process StartSelf(params string[] arguments)
{
    var info = new ProcessStartInfo(Environment.ProcessPath!)
    {
        UseShellExecute = false,
        RedirectStandardError = true,
    };
    foreach (var argument in arguments) info.ArgumentList.Add(argument);
    return Process.Start(info)!;
}

// A payload is one repeated byte, large enough that a non-atomic write would often be caught part-way.
static byte[] Payload(byte value)
{
    var bytes = new byte[PayloadSize];
    Array.Fill(bytes, value);
    return bytes;
}

static bool IsWholePayload(byte[] bytes) =>
    bytes.Length == PayloadSize && bytes.All(b => b == bytes[0]);

static int RunWriter(Action<byte[]> write)
{
    var first = Payload(2);
    var second = Payload(3);
    while (true)
    {
        write(first);
        write(second);
    }
}

// Small chunks with flushes, as serializers and stream writers produce, so a kill can land mid-file.
static void WriteInChunks(FileStream stream, byte[] bytes)
{
    const int ChunkSize = 16 * 1024;
    for (var offset = 0; offset < bytes.Length; offset += ChunkSize)
    {
        stream.Write(bytes, offset, Math.Min(ChunkSize, bytes.Length - offset));
        stream.Flush();
    }
}

// Antivirus scanners hold large new files open for a while. That is not what these tests are about.
static async Task Retry(Action action)
{
    for (var attempt = 0; ; attempt++)
    {
        try
        {
            action();
            return;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException && attempt < 100)
        {
            await Task.Delay(100);
        }
    }
}

static async Task<byte[]> ReadSettled(string path)
{
    byte[] bytes = Array.Empty<byte>();
    await Retry(() => bytes = File.ReadAllBytes(path));
    return bytes;
}

// Waits for proof that the child has written, then kills it at a random moment.
static async Task KillMidWrite(string mode, string path, Random random)
{
    using var child = StartSelf(mode, path);
    var started = Stopwatch.StartNew();
    while (started.Elapsed < TimeSpan.FromSeconds(10))
    {
        try
        {
            using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            if (stream.ReadByte() is not (1 or -1)) break;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { }
        await Task.Delay(2);
    }
    if (started.Elapsed >= TimeSpan.FromSeconds(10)) throw new Exception("the writer never wrote");
    await Task.Delay(random.Next(0, 15));
    child.Kill(entireProcessTree: true);
    await child.WaitForExitAsync();
}

static async Task<int> RunCrashChild(string dir)
{
    var db = new HubDatabase(Path.Combine(dir, "hub.db"));
    db.Open();
    var registry = new ModuleRegistry(db);
    registry.Register(new FakeModule("crasher")
    {
        // A native crash that no catch block can stop.
        OnStart = (_, _) => { Environment.FailFast("selftest crash"); return Task.CompletedTask; },
    });
    await registry.StartAllAsync();
    return 0;
}

internal sealed partial class Program
{
    private const int PayloadSize = 4 * 1024 * 1024;
}

internal sealed class FakeGitHub : HttpMessageHandler
{
    public Dictionary<string, string[]> CompareFiles { get; } = new();
    public List<string> Requests { get; } = new();
    public List<string> UserAgents { get; } = new();
    public string? FailRepo { get; set; }

    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        var path = request.RequestUri!.AbsolutePath;
        Requests.Add(path);
        UserAgents.Add(request.Headers.UserAgent.ToString());
        if (FailRepo != null && path.Contains(FailRepo))
            return Task.FromResult(new HttpResponseMessage(System.Net.HttpStatusCode.Forbidden));

        var repo = string.Join('/', path.Split('/')[2..4]);
        string body;
        if (path.Contains("/releases")) body = """[{"tag_name":"v1","html_url":"https://example.test/r"}]""";
        else if (path.Contains("/commits/")) body = """{"sha":"ffffffa"}""";
        else
        {
            var files = CompareFiles.GetValueOrDefault(repo, Array.Empty<string>()).Select(f => new { filename = f });
            body = System.Text.Json.JsonSerializer.Serialize(new { total_commits = 7, html_url = "https://example.test/c", files });
        }
        return Task.FromResult(new HttpResponseMessage(System.Net.HttpStatusCode.OK) { Content = new StringContent(body) });
    }
}

internal sealed class FakeModule : IHubModule
{
    public FakeModule(string id) => Id = id;

    public string Id { get; }
    public string DisplayName => Id;
    public bool DefaultOn { get; init; } = true;
    public bool EnabledByDefault => DefaultOn;
    public IReadOnlyList<HubMigration> MigrationList { get; init; } = Array.Empty<HubMigration>();
    public IReadOnlyList<HubMigration> Migrations => MigrationList;
    public IReadOnlyList<HubSettingDefinition> SettingList { get; init; } = Array.Empty<HubSettingDefinition>();
    public IReadOnlyList<HubSettingDefinition> Settings => SettingList;
    public Func<HubModuleContext, CancellationToken, Task>? OnStart { get; init; }
    public Func<Task>? OnStop { get; init; }
    public int Started { get; private set; }
    public int Stopped { get; private set; }

    public Task StartAsync(HubModuleContext context, CancellationToken cancellationToken)
    {
        Started++;
        return OnStart?.Invoke(context, cancellationToken) ?? Task.CompletedTask;
    }

    public Task StopAsync(CancellationToken cancellationToken)
    {
        Stopped++;
        return OnStop?.Invoke() ?? Task.CompletedTask;
    }
}

internal sealed class FakeSteam : ISteamHost
{
    public string? Manifest { get; set; }
    public IReadOnlyList<string> Blockers { get; set; } = Array.Empty<string>();
    public bool ShutdownWorks { get; set; } = true;
    public bool SteamOpen { get; set; } = true;
    public int Shutdowns { get; private set; }
    public int Starts { get; private set; }
    public Action? OnStart { get; set; }
    public Action? OnShutdown { get; set; }

    public string? FindManifest(int appId) => Manifest;
    public IReadOnlyList<string> RunningBlockers() => Blockers;
    public bool IsSteamRunning() => SteamOpen;

    public Task<bool> ShutdownAsync(CancellationToken cancellationToken)
    {
        Shutdowns++;
        if (ShutdownWorks) SteamOpen = false;
        OnShutdown?.Invoke();
        return Task.FromResult(ShutdownWorks);
    }

    public void Start()
    {
        Starts++;
        SteamOpen = true;
        OnStart?.Invoke();
    }
}

internal sealed class FakeSteamApi : HttpMessageHandler
{
    public sealed record Seen(string Url, string UserAgent);
    public List<Seen> Requests { get; } = new();
    public bool Fail { get; set; }
    public bool Garbage { get; set; }

    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        Requests.Add(new Seen(request.RequestUri!.ToString(), request.Headers.UserAgent.ToString()));
        if (Fail && !Garbage) return Task.FromResult(new HttpResponseMessage(System.Net.HttpStatusCode.BadGateway));
        var body = Garbage
            ? "{\"nope\":1}"
            : "{\"data\":{\"3368750\":{\"depots\":{\"branches\":{\"public\":{\"buildid\":\"18832234\",\"timeupdated\":\"1749685565\"},\"beta\":{\"buildid\":\"26185367\",\"timeupdated\":\"1793662372\"}}}}}}";
        return Task.FromResult(new HttpResponseMessage(System.Net.HttpStatusCode.OK) { Content = new StringContent(body) });
    }
}
