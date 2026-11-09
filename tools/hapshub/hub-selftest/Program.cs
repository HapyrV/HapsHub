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
