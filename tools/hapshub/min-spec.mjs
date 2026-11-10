// Measures how HapsHub runs on fewer CPU threads and without the GPU, to find the slowest PC it's comfortable on.
// Each run starts a throwaway copy pinned to N threads (Windows' start /affinity, which its WebView2 processes inherit),
// with 400 made-up friends, and times: start-up, switching pages, wheel scrolling, and CPU use while idle.
// "Comfortable" = start under 8 s, page switch under 300 ms, scrolling at 45 fps or better, idle CPU under 3% of the CPU
// it's allowed (its threads together).
//   node tools/hapshub/min-spec.mjs [--threads 16,4,2,1] [--no-gpu]

import { spawn, spawnSync } from 'node:child_process';
import { EXE, Page, cleanUp, freshData, hubLog, sleep, waitFor } from './lib/harness.mjs';

const args = process.argv.slice(2);
const threadsArg = args.includes('--threads') ? args[args.indexOf('--threads') + 1] : '';
const logical = Number(spawnSync('powershell', ['-NoProfile', '-Command', '[Environment]::ProcessorCount'], { encoding: 'utf8' }).stdout.trim()) || 8;
const counts = (threadsArg || `${logical},4,2`).split(',').map(Number).filter(n => n > 0 && n <= logical);
const gpuModes = args.includes('--no-gpu') ? [false] : args.includes('--both') ? [true, false] : [true];

/** CPU seconds used by a process and everything it started. */
function treeCpu(pid) {
    const script = `$all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId; $ids = @(${pid}); $grew = $true
        while ($grew) { $grew = $false; foreach ($p in $all) { if ($ids -contains $p.ParentProcessId -and -not ($ids -contains $p.ProcessId)) { $ids += $p.ProcessId; $grew = $true } } }
        $sum = 0; foreach ($id in $ids) { $proc = Get-Process -Id $id -ErrorAction SilentlyContinue; if ($proc) { $sum += $proc.TotalProcessorTime.TotalSeconds } }; $sum`;
    return Number(spawnSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8' }).stdout.trim()) || 0;
}

async function run(threads, gpu) {
    const dir = freshData('hapshub-minspec-', { EfficiencyMode: false });
    const port = 9360 + threads;
    const mask = ((1n << BigInt(threads)) - 1n).toString(16).toUpperCase();
    const env = { ...process.env, HAPSHUB_DATA_DIR: dir, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}${gpu ? '' : ' --disable-gpu'}` };
    const started = Date.now();
    // start /affinity sets the mask when the process is created, so everything it starts inherits it.
    spawn('cmd.exe', ['/c', 'start', '""', '/affinity', mask, EXE], { env, detached: true, stdio: 'ignore' });
    const result = { threads, gpu };
    try {
        const page = await Page.connect(port, 'index.html', 90000);
        await waitFor('page ready', () => page.eval(`window.__vrcndbConsentChecked === true && typeof showTab === 'function'`), 90000);
        await waitFor('splash gone', () => page.eval(`!document.getElementById('vrcnSplash')`), 30000);
        result.startSeconds = (Date.now() - started) / 1000;
        const pid = Number(spawnSync('powershell', ['-NoProfile', '-Command',
            `(Get-CimInstance Win32_Process -Filter "Name='HapsHub.exe'" | Where-Object { $_.CommandLine -notmatch 'watchdog|vroverlay' -and $_.ExecutablePath -eq '${EXE.replace(/\//g, '\\')}' } | Sort-Object CreationDate | Select-Object -Last 1).ProcessId`], { encoding: 'utf8' }).stdout.trim());
        await page.eval(`(() => {
            const friends = [];
            for (let i = 0; i < 400; i++) friends.push({ id: 'usr_' + i, displayName: 'Friend ' + i, status: ['active', 'join me', 'busy'][i % 3], statusDescription: 'Status ' + i,
                location: i % 3 ? 'offline' : 'wrld_' + i + ':1', presence: i % 3 ? 'offline' : 'online', platform: 'standalonewindows', image: '', currentAvatarThumbnailImageUrl: '', tags: [] });
            try { renderVrcFriends(friends, null); } catch {}
            vrcFriendsData = friends;
        })()`);
        await sleep(1500);
        // Page switches: the time until the new page has been drawn twice.
        const switches = [];
        for (const tab of [3, 9, 12, 15, 39, 0]) {
            switches.push(await page.eval(`new Promise(done => { const t = performance.now(); showTab(${tab}); requestAnimationFrame(() => requestAnimationFrame(() => done(performance.now() - t))); })`));
            await sleep(400);
        }
        result.switchWorstMs = Math.round(Math.max(...switches));
        // Wheel scrolling on the dashboard and in Settings.
        const fps = [];
        for (const tab of [0, 9]) {
            await page.eval(`showTab(${tab})`);
            await sleep(800);
            const point = await page.json(`(() => { const c = document.querySelector('.tab.active .settings-content') || document.querySelector('.content'); c.scrollTop = 0; const r = c.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
            await page.eval(`window.__f = []; window.__l = performance.now(); window.__go = true; (function f(n) { window.__f.push(n - window.__l); window.__l = n; if (window.__go) requestAnimationFrame(f); })(performance.now())`);
            for (let i = 0; i < 50; i++) { await page.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: point.x, y: point.y, deltaX: 0, deltaY: i < 30 ? 100 : -100 }); await sleep(16); }
            await sleep(300);
            const frames = await page.json(`(window.__go = false, window.__f.slice(1))`);
            const sorted = frames.sort((a, b) => a - b);
            fps.push(1000 / sorted[Math.floor(sorted.length * 0.9)]);
        }
        result.scrollFps90 = Math.round(Math.min(...fps));
        // Idle: nothing touched for 20 s.
        await page.eval(`showTab(0)`);
        await sleep(3000);
        const before = treeCpu(pid);
        await sleep(20000);
        result.idleCpuPercentOfThread = Math.round((treeCpu(pid) - before) / 20 * 1000) / 10;
        result.errors = page.errors.length;
        page.socket.close();
    } catch (error) {
        result.failed = error.message;
    } finally {
        // Only copies of this build were started here; the real app runs from bin\Release.
        spawnSync('powershell', ['-NoProfile', '-Command', `Get-Process HapsHub -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq '${EXE.replace(/\//g, '\\')}' } | Stop-Process -Force`]);
        await sleep(1500);
        await cleanUp(dir);
    }
    const comfortable = !result.failed && result.startSeconds < 8 && result.switchWorstMs < 300 && result.scrollFps90 >= 45 && result.idleCpuPercentOfThread / threads < 3;
    console.log(`${threads} thread(s), GPU ${gpu ? 'on' : 'off'}: ${result.failed ? 'FAILED ' + result.failed : `start ${result.startSeconds.toFixed(1)} s, slowest page switch ${result.switchWorstMs} ms, scrolling ${result.scrollFps90} fps, idle CPU ${result.idleCpuPercentOfThread}% of a thread, ${result.errors} page errors`} -> ${comfortable ? 'comfortable' : 'NOT comfortable'}`);
}

if (EXE.includes('\\Release\\') || EXE.includes('/Release/')) { console.log('Use a Debug build or HAPSHUB_TEST_EXE: the real app runs from Release.'); process.exit(2); }
for (const gpu of gpuModes) for (const threads of counts) await run(threads, gpu);
