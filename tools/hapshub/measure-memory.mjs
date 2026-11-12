// H2: memory of a throwaway Debug copy (HapsHub + its WebView2 processes) after 2 minutes idle, then after 1 minute
// minimised. Starts the copy without a debug port, so WebView2 keeps HapsHub's own browser arguments. Stops only
// what it started; never the Release copy a real session uses.
//   node tools/hapshub/measure-memory.mjs [idleSeconds=120] [minSeconds=60]
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const EXE = join(ROOT, 'bin', 'Debug', 'net10.0-windows10.0.19041.0', 'HapsHub.exe');
const version = readFileSync(join(ROOT, 'main', 'AppInfo.cs'), 'utf8').match(/Version = "([^"]+)"/)[1];
const idleS = Number(process.argv[2] || 120), minS = Number(process.argv[3] || 60);
const dir = mkdtempSync(join(tmpdir(), 'hub-mem-'));
writeFileSync(join(dir, 'settings.json'), JSON.stringify({ SetupComplete: true, MinimizeToTray: false, LastChangelogVersion: version }));
const app = spawn(EXE, [], { env: { ...process.env, HAPSHUB_DATA_DIR: dir }, stdio: 'ignore' });
const wait = s => new Promise(r => setTimeout(r, s * 1000));
const ps = cmd => spawnSync('powershell', ['-NoProfile', '-Command', cmd], { encoding: 'utf8' }).stdout.trim();

// Working set and private bytes of the copy and every process under it, in MB.
function measure() {
    const out = ps(`$all=Get-CimInstance Win32_Process; $ids=[System.Collections.Generic.HashSet[uint32]]::new(); [void]$ids.Add(${app.pid});
do { $added=$false; foreach($p in $all){ if($ids.Contains($p.ParentProcessId) -and $ids.Add($p.ProcessId)){ $added=$true } } } while($added)
$ws=0; $pv=0; $n=0; $parts=@(); foreach($id in $ids){ $p=Get-Process -Id $id -ErrorAction SilentlyContinue; if($p){ $ws+=$p.WorkingSet64; $pv+=$p.PrivateMemorySize64; $n++
  $cl=($all | Where-Object ProcessId -eq $id).CommandLine; $t=if($cl -match '--type=([a-z-]+)'){ $matches[1] } elseif($p.ProcessName -eq 'msedgewebview2'){ 'browser' } else { $p.ProcessName }
  $parts+=('{0}:{1}/{2}' -f $t, [math]::Round($p.WorkingSet64/1MB), [math]::Round($p.PrivateMemorySize64/1MB)) } }
"{0} {1} {2} {3}" -f $n, [math]::Round($ws/1MB), [math]::Round($pv/1MB), ($parts -join ',')`);
    const [procs, ws, priv, parts] = out.split(/\s+/);
    return { procs: +procs, ws: +ws, priv: +priv, parts };
}

try {
    await wait(idleS);
    const idle = measure();
    ps(`Add-Type -Name M -Namespace U -MemberDefinition '[DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr h, int c);'; [void][U.M]::ShowWindow((Get-Process -Id ${app.pid}).MainWindowHandle, 6)`);
    await wait(minS);
    const min = measure();
    console.log(JSON.stringify({ idle, minimised: min }));
} finally {
    spawnSync('taskkill', ['/PID', String(app.pid), '/F', '/T']);
    await wait(1.5);
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
}
