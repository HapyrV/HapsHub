// Measures scrolling in a throwaway copy of HapsHub: how long frames take, and how much style and layout work
// each scroll causes. Scrolls the page the way a mouse wheel does, a step every frame.
//   node tools/hapshub/scroll-perf.mjs [tab numbers...]     (default: 0 = dashboard, 9 = settings)

import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const EXE = join(ROOT, 'bin', 'Debug', 'net10.0-windows10.0.19041.0', 'HapsHub.exe');
const PORT = 9338;
const tabs = process.argv.slice(2).map(Number).filter(n => Number.isInteger(n));
const sleep = ms => new Promise(done => setTimeout(done, ms));

async function waitFor(what, test, timeoutMs = 60000) {
    const end = Date.now() + timeoutMs;
    for (;;) {
        const value = await test().catch(() => null);
        if (value) return value;
        if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
        await sleep(250);
    }
}

const data = mkdtempSync(join(tmpdir(), 'hapshub-scroll-'));
const version = readFileSync(join(ROOT, 'main', 'AppInfo.cs'), 'utf8').match(/Version = "([^"]+)"/)[1];
// SCROLL_SETTINGS can name a JSON file of extra settings, to copy someone's look (theme, background, blur).
const extra = process.env.SCROLL_SETTINGS ? JSON.parse(readFileSync(process.env.SCROLL_SETTINGS, 'utf8')) : {};
writeFileSync(join(data, 'settings.json'), JSON.stringify({ SetupComplete: true, MinimizeToTray: false, LastChangelogVersion: version, EfficiencyMode: false, ...extra }));
const app = spawn(EXE, [], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, HAPSHUB_DATA_DIR: data, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` },
});

let socket;
try {
    const target = await waitFor('the page', async () => {
        const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`, { signal: AbortSignal.timeout(3000) })).json();
        return targets.find(t => t.type === 'page' && t.url.includes('index.html'));
    });
    socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((done, fail) => { socket.addEventListener('open', done, { once: true }); socket.addEventListener('error', fail, { once: true }); });
    let id = 1;
    const pending = new Map();
    socket.addEventListener('message', event => {
        const message = JSON.parse(event.data);
        if (pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); }
    });
    const send = (method, params = {}) => new Promise(done => {
        const myId = id++;
        pending.set(myId, done);
        socket.send(JSON.stringify({ id: myId, method, params }));
    });
    const evaluate = async expression => {
        const reply = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
        if (reply.result?.exceptionDetails) throw new Error(reply.result.exceptionDetails.exception?.description || 'page error');
        return reply.result?.result?.value;
    };
    const metrics = async () => Object.fromEntries((await send('Performance.getMetrics')).result.metrics.map(m => [m.name, m.value]));

    await send('Performance.enable');
    await waitFor('the app to load', () => evaluate(`typeof showTab === 'function' && !!document.querySelector('.content')`));
    await sleep(4000);

    for (const tab of tabs.length ? tabs : [0, 9]) {
        await evaluate(`showTab(${tab})`);
        await sleep(2500);
        const room = await evaluate(`(() => { const c = document.querySelector('#tab${tab}.active')?.closest('.content') || document.querySelector('.content'); c.scrollTop = 0; return c.scrollHeight - c.clientHeight; })()`);
        await sleep(500);
        const before = await metrics();
        const frames = JSON.parse(await evaluate(`new Promise(done => {
            const c = document.querySelector('#tab${tab}.active')?.closest('.content') || document.querySelector('.content');
            const times = []; let last = performance.now(), steps = 0, dir = 1;
            function step(now) {
                times.push(now - last); last = now;
                if (c.scrollTop + c.clientHeight >= c.scrollHeight - 2) dir = -1; else if (c.scrollTop <= 0) dir = 1;
                c.scrollTop += 40 * dir;
                if (++steps < 180) requestAnimationFrame(step); else done(JSON.stringify(times.slice(1)));
            }
            requestAnimationFrame(step);
        })`));
        const after = await metrics();
        frames.sort((a, b) => a - b);
        const pct = p => frames[Math.min(frames.length - 1, Math.floor(frames.length * p))].toFixed(1);
        const per = (name, scale = 1) => ((after[name] - before[name]) * scale / frames.length).toFixed(2);
        console.log(`tab ${tab}: ${room}px to scroll, ${frames.length} frames; median ${pct(0.5)} ms, 90% ${pct(0.9)} ms, worst ${frames[frames.length - 1].toFixed(1)} ms; `
            + `over 20 ms: ${frames.filter(f => f > 20).length}; per frame: layouts ${per('LayoutCount')}, style recalcs ${per('RecalcStyleCount')}, `
            + `layout ${per('LayoutDuration', 1000)} ms, style ${per('RecalcStyleDuration', 1000)} ms, script ${per('ScriptDuration', 1000)} ms`);
    }
} catch (error) {
    console.log(`FAIL ${error.message}`);
} finally {
    socket?.close();
    spawnSync('taskkill', ['/PID', String(app.pid), '/T', '/F']);
    await sleep(800);
    try { rmSync(data, { recursive: true, force: true }); } catch { /* still closing */ }
}
