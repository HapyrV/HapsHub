// Starts a throwaway Debug copy with Efficiency mode on and reports the page renderer's priority
// while the window has focus (should be Normal), then closes only that copy.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const EXE = join(ROOT, 'bin', 'Debug', 'net10.0-windows10.0.19041.0', 'HapsHub.exe');
const version = readFileSync(join(ROOT, 'main', 'AppInfo.cs'), 'utf8').match(/Version = "([^"]+)"/)[1];
const dir = mkdtempSync(join(tmpdir(), 'hub-eff-'));
writeFileSync(join(dir, 'settings.json'), JSON.stringify({ SetupComplete: true, MinimizeToTray: false, LastChangelogVersion: version, EfficiencyMode: true }));

const app = spawn(EXE, [], { env: { ...process.env, HAPSHUB_DATA_DIR: dir }, stdio: 'ignore' });
const wait = ms => new Promise(r => setTimeout(r, ms));

function priorities() {
    const ps = `$root=${app.pid}; $all=Get-CimInstance Win32_Process; $ids=@($root); $added=$true;
while($added){$added=$false; foreach($p in $all){ if($ids -contains $p.ParentProcessId -and -not ($ids -contains $p.ProcessId)){$ids+=$p.ProcessId;$added=$true} } }
foreach($id in $ids){ try { $p=Get-Process -Id $id -ErrorAction Stop; "$($p.ProcessName) $($p.PriorityClass)" } catch {} }`;
    return spawnSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' }).stdout.trim();
}

function foreground() {
    const ps = `Add-Type -Name W -Namespace U -MemberDefinition '[DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow(); [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr h, out uint p);';
$p=0; [void][U.W]::GetWindowThreadProcessId([U.W]::GetForegroundWindow(), [ref]$p); (Get-Process -Id $p).ProcessName + " " + $p`;
    return spawnSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' }).stdout.trim();
}

try {
    await wait(20000);
    console.log(`--- after start; test copy pid ${app.pid}; foreground: ${foreground()}`);
    console.log(priorities());
    // Minimizing takes focus away; the throttle should come back.
    spawnSync('powershell', ['-NoProfile', '-Command', `Add-Type -Name M -Namespace U -MemberDefinition '[DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr h, int c);'; [void][U.M]::ShowWindow((Get-Process -Id ${app.pid}).MainWindowHandle, 6)`]);
    await wait(5000);
    console.log(`--- minimized; foreground: ${foreground()}`);
    console.log(priorities());
} finally {
    spawnSync('taskkill', ['/PID', String(app.pid), '/F', '/T']);
    await wait(1500);
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
}
