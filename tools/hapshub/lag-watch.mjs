// Issue 12: watches the user's own running HapsHub while they use it, to find lag a test copy can't reproduce.
// Only observes: it wraps the message dispatcher and showTab to time them, samples the CPU profiler, and changes nothing.
// The app has to be started with a debug port, keeping its own WebView2 flags, for example:
//   set "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9342 <the app's flags>" & start "" HapsHub.exe
//   node tools/hapshub/lag-watch.mjs [--port 9342] [--minutes 10]
// Writes tools/hapshub/out/lag-watch.json and prints a summary. Ends early if the app closes.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, Page, sleep } from './lib/harness.mjs';

const args = process.argv.slice(2);
const arg = (name, def) => args.includes(name) ? Number(args[args.indexOf(name) + 1]) || def : def;
const port = arg('--port', 9342);
const minutes = arg('--minutes', 10);

const page = await Page.connect(port, 'index.html', 30000);

// In-page recorders. Idempotent: a second run reuses them.
await page.eval(`(() => {
    if (window.__lw) { window.__lw.reset(); return; }
    const lw = window.__lw = {};
    lw.reset = () => Object.assign(lw, { t0: performance.now(), long: [], frames: [], msgs: {}, slowMsgs: [], tabs: [], heap: [] });
    lw.reset();
    new PerformanceObserver(l => { for (const e of l.getEntries()) lw.long.push([Math.round(e.startTime), Math.round(e.duration)]); }).observe({ type: 'longtask' });
    // Frame gaps over 50 ms while the window is actually shown (a hidden window doesn't draw at all).
    let last = performance.now();
    const tick = t => { if (!document.hidden && t - last > 50 && t - last < 10000) lw.frames.push([Math.round(t), Math.round(t - last)]); last = t; requestAnimationFrame(tick); };
    document.addEventListener('visibilitychange', () => { last = performance.now(); });
    requestAnimationFrame(tick);
    // Every message from the app, timed through all of its handlers.
    const dispatch = window.__photinoDispatch;
    if (typeof dispatch === 'function') window.__photinoDispatch = data => {
        const s = performance.now();
        try { return dispatch(data); } finally {
            const ms = performance.now() - s;
            const type = (typeof data === 'string' && /"type"\\s*:\\s*"([^"]+)"/.exec(data.slice(0, 200))?.[1]) || '?';
            const m = lw.msgs[type] ||= { n: 0, ms: 0, max: 0, bytes: 0 };
            m.n++; m.ms += ms; m.max = Math.max(m.max, ms); m.bytes += data?.length || 0;
            if (ms > 16) lw.slowMsgs.push([Math.round(s), type, Math.round(ms), data?.length || 0]);
        }
    };
    lw.dispatchWrapped = typeof dispatch === 'function';
    // Tab switches the user makes.
    const show = window.showTab;
    if (typeof show === 'function') window.showTab = function (...a) {
        const s = performance.now();
        try { return show.apply(this, a); } finally { lw.tabs.push([Math.round(s), a[0], Math.round(performance.now() - s)]); }
    };
    setInterval(() => lw.heap.push([Math.round(performance.now()), Math.round((performance.memory?.usedJSHeapSize || 0) / 1048576),
        document.querySelector('.tab-content.active, .content.active')?.id || '', document.hidden ? 'hidden' : document.hasFocus() ? 'focus' : 'shown']), 5000);
})()`);
const wrapped = await page.json(`window.__lw.dispatchWrapped`);

const metrics = async () => Object.fromEntries((await page.send('Performance.getMetrics')).result.metrics.map(m => [m.name, m.value]));
await page.send('Performance.enable');
const m0 = await metrics();

// CPU samples, taken in 2-minute pieces so a long run doesn't build one huge profile.
await page.send('Profiler.enable');
await page.send('Profiler.setSamplingInterval', { interval: 1000 });
const self = new Map(), runs = [];
let sampledMs = 0, gcMs = 0, idleMs = 0;
function digest(profile) {
    const byId = new Map(profile.nodes.map(n => [n.id, n]));
    const parent = new Map();
    for (const n of profile.nodes) for (const c of n.children || []) parent.set(c, n.id);
    const label = n => `${n.callFrame.functionName || '(anon)'} ${(n.callFrame.url.split('/').pop() || '')}:${n.callFrame.lineNumber + 1}`;
    // The outermost JS frame of a sample: what the browser called into (a message, a timer, an event).
    const entry = id => { let e = null; for (let x = id; x && byId.get(x)?.callFrame.functionName !== '(root)'; x = parent.get(x)) if (byId.get(x).callFrame.url) e = x; return e ? label(byId.get(e)) : label(byId.get(id)); };
    let run = null;
    const endRun = () => { if (run && run.ms >= 50) runs.push(run); run = null; };
    profile.samples.forEach((id, i) => {
        const ms = (profile.timeDeltas[i + 1] ?? 1000) / 1000;
        const n = byId.get(id), name = n.callFrame.functionName;
        sampledMs += ms;
        if (name === '(idle)' || name === '(program)') { if (name === '(idle)') idleMs += ms; endRun(); return; }
        if (name === '(garbage collector)') gcMs += ms;
        const l = label(n);
        self.set(l, (self.get(l) || 0) + ms);
        run ||= { ms: 0, entries: {} };
        run.ms += ms;
        const e = name === '(garbage collector)' ? '(garbage collector)' : entry(id);
        run.entries[e] = (run.entries[e] || 0) + ms;
    });
    endRun();
}

const end = Date.now() + minutes * 60000;
let closed = false;
console.log(`watching port ${port} for ${minutes} min (messages ${wrapped ? 'timed' : 'NOT timed: no __photinoDispatch'})`);
try {
    while (Date.now() < end) {
        await page.send('Profiler.start');
        const pieceEnd = Math.min(end, Date.now() + 120000);
        while (Date.now() < pieceEnd) {
            await sleep(Math.min(30000, pieceEnd - Date.now()));
            const s = await page.json(`({ long: __lw.long.length, frames: __lw.frames.length, tabs: __lw.tabs.length })`);
            console.log(`${Math.round((end - Date.now()) / 1000)} s left: ${s.long} long tasks, ${s.frames} slow frames, ${s.tabs} tab switches`);
        }
        digest((await page.send('Profiler.stop')).result.profile);
    }
} catch (e) { closed = true; console.log('stopped early: ' + e.message); }

const out = { when: new Date().toISOString(), minutes, port, closedEarly: closed };
if (!closed) {
    Object.assign(out, await page.json(`(() => { const l = __lw; return { long: l.long, frames: l.frames, msgs: l.msgs, slowMsgs: l.slowMsgs, tabs: l.tabs, heap: l.heap }; })()`));
    const m1 = await metrics();
    out.metrics = Object.fromEntries(['LayoutDuration', 'RecalcStyleDuration', 'ScriptDuration', 'TaskDuration'].map(k => [k + 'Ms', Math.round((m1[k] - m0[k]) * 1000)]));
    out.metrics.layouts = m1.LayoutCount - m0.LayoutCount;
    out.metrics.styleRecalcs = m1.RecalcStyleCount - m0.RecalcStyleCount;
    out.metrics.nodes = m1.Nodes;
}
out.cpu = { sampledMs: Math.round(sampledMs), busyMs: Math.round(sampledMs - idleMs), gcMs: Math.round(gcMs),
    topSelf: [...self].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([k, v]) => [k, Math.round(v)]),
    longRuns: runs.sort((a, b) => b.ms - a.ms).slice(0, 25).map(r => ({ ms: Math.round(r.ms), top: Object.entries(r.entries).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, v]) => `${k} ${Math.round(v)}`) })) };
try { page.socket.close(); } catch { /* gone */ }

mkdirSync(join(ROOT, 'tools', 'hapshub', 'out'), { recursive: true });
writeFileSync(join(ROOT, 'tools', 'hapshub', 'out', 'lag-watch.json'), JSON.stringify(out, null, 1));

const sum = a => a.reduce((s, x) => s + x, 0);
if (out.long) {
    console.log(`long tasks: ${out.long.length}, ${sum(out.long.map(x => x[1]))} ms, worst ${Math.max(0, ...out.long.map(x => x[1]))} ms; slow frames (shown): ${out.frames.length}, worst ${Math.max(0, ...out.frames.map(x => x[1]))} ms`);
    console.log(`heap MB: ${Math.min(...out.heap.map(h => h[1]))}..${Math.max(...out.heap.map(h => h[1]))}; ${JSON.stringify(out.metrics)}`);
    console.log('messages by time: ' + Object.entries(out.msgs).sort((a, b) => b[1].ms - a[1].ms).slice(0, 12).map(([k, m]) => `${k} n=${m.n} ${Math.round(m.ms)}ms max=${Math.round(m.max)}`).join(' | '));
    console.log('slowest messages: ' + [...out.slowMsgs].sort((a, b) => b[2] - a[2]).slice(0, 10).map(x => `${x[1]} ${x[2]}ms ${Math.round(x[3] / 1024)}KB`).join(' | '));
    console.log('slowest tab switches: ' + [...out.tabs].sort((a, b) => b[2] - a[2]).slice(0, 10).map(x => `tab${x[1]} ${x[2]}ms`).join(' | '));
}
console.log(`cpu: busy ${out.cpu.busyMs} of ${out.cpu.sampledMs} ms, GC ${out.cpu.gcMs} ms`);
console.log('top self time: ' + out.cpu.topSelf.slice(0, 12).map(([k, v]) => `${k} ${v}`).join(' | '));
console.log('longest busy stretches:');
for (const r of out.cpu.longRuns.slice(0, 10)) console.log(`  ${r.ms} ms: ${r.top.join(' ; ')}`);
