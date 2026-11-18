// Issue 12: where does the lag come from? Runs a throwaway Debug copy on a snapshot of the real local data (databases,
// avatar DB, settings) with every secret stripped, so it starts signed out and talks to nobody as the user. Then:
//   - idle: long tasks and frames over 50 ms during a quiet stretch (jitter, freezes)
//   - tabs: opens every sidebar entry, timing the switch, its long tasks, style/layout counts and script time
//   - scroll: wheel-scrolls the busiest tabs a step per frame and reports slow frames
// Writes the numbers to tools/hapshub/out/lag-profile.json and prints a short table.
//   node tools/hapshub/lag-profile.mjs [--fresh] [--idle 30] [--live 4] [--friends 400]
//     --fresh: empty data instead of the real snapshot
//     --live N: stands in for being signed in: a made-up friends list (--friends, no pictures, no network) and N friend
//               updates a second (status, world, online/offline) for the whole run, sent the way the app sends them
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { ROOT, VERSION, cleanUp, closeMain, freshData, openMain, sleep } from './lib/harness.mjs';

const args = process.argv.slice(2);
const fresh = args.includes('--fresh');
const idleS = Number(args[args.indexOf('--idle') + 1]) || 30;
const flag = (name, def) => args.includes(name) ? Number(args[args.indexOf(name) + 1]) || def : 0;
const liveRate = flag('--live', 4);
const friendCount = flag('--friends', 400) || 400;
const PORT = 9341;
const REAL = join(process.env.APPDATA, 'HapsHub');

// Blanks every secret, wherever it sits in the settings tree.
const SECRET = /Enc$|Token|Cookie|Secret|ApiKey|Password|Webhook/i;
function scrub(node) {
    if (Array.isArray(node)) return node.forEach(scrub);
    if (!node || typeof node !== 'object') return;
    for (const [k, v] of Object.entries(node)) {
        if (typeof v === 'string' && SECRET.test(k)) node[k] = '';
        else scrub(v);
    }
}

function snapshot() {
    const dir = mkdtempSync(join(tmpdir(), 'hapshub-lag-'));
    const settings = JSON.parse(readFileSync(join(REAL, 'settings.json'), 'utf8').replace(/^﻿/, ''));
    scrub(settings);
    Object.assign(settings, { SetupComplete: true, MinimizeToTray: false, StartMinimized: false, LastChangelogVersion: VERSION });
    writeFileSync(join(dir, 'settings.json'), JSON.stringify(settings));
    // SQLite's backup API copies a consistent database even while the real app has it open.
    const dbs = ['VRCNData.db', 'MediaLibrary.db', 'VRCNPlus.sqlite', 'Hub/hub.db', 'Hub/vrcx-history.db'].filter(f => existsSync(join(REAL, f)));
    mkdirSync(join(dir, 'Hub'), { recursive: true });
    const py = `import sqlite3,sys\nfor a,b in zip(sys.argv[1::2],sys.argv[2::2]):\n s=sqlite3.connect('file:'+a+'?mode=ro',uri=True);d=sqlite3.connect(b);s.backup(d);d.close();s.close()`;
    const r = spawnSync('python', ['-c', py, ...dbs.flatMap(f => [join(REAL, f), join(dir, f)])], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error('database snapshot failed: ' + r.stderr);
    for (const sub of ['AvatarDB', 'custom-themes']) if (existsSync(join(REAL, sub))) cpSync(join(REAL, sub), join(dir, sub), { recursive: true });
    return dir;
}

// The WebView2 arguments AppShell.BuildChromiumFlags gives the real app; the debug port would otherwise replace them.
// --heap 64|128|off overrides the JS heap cap the settings pick.
function appFlags(s) {
    const heap = args.includes('--heap') ? args[args.indexOf('--heap') + 1] : (s.V8Heap128 ? '128' : '64');
    return [s.GpuAcceleration === false ? '--disable-gpu' : '', s.GpuShaderCache === false ? '--disable-gpu-shader-disk-cache' : '',
        heap === 'off' ? '' : `--js-flags="--max-old-space-size=${heap} --max-semi-space-size=2"`,
        s.TwoRenderProcesses ? '--renderer-process-limit=2' : '--renderer-process-limit=1',
        '--disable-background-networking --disable-sync --no-first-run'].filter(Boolean).join(' ');
}

const dir = fresh ? freshData('hapshub-lag-') : snapshot();
const flags = appFlags(JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8').replace(/^﻿/, '')));
const out = { when: new Date().toISOString(), data: (fresh ? 'fresh' : 'real snapshot (signed out)') + ` | flags: ${flags}` + (liveRate ? `, ${friendCount} made-up friends, ${liveRate} updates/s` : '') };

// Made-up friends shaped like FriendsController's vrcFriendUpdate payload; updates rotate status, world and online state.
const LIVE_JS = `(() => {
    const send = (type, payload) => window.__photinoDispatch(JSON.stringify({ type, payload }));
    const statuses = ['active', 'join me', 'ask me', 'busy'];
    const worlds = Array.from({ length: 40 }, (_, i) => ['wrld_' + String(i).padStart(8, '0') + '-0000-4000-8000-000000000000', 'World ' + i]);
    const friend = i => {
        const online = Math.random() < 0.35, w = worlds[i % worlds.length];
        const where = !online ? 'offline' : Math.random() < 0.3 ? 'private' : w[0] + ':' + (10000 + i) + '~hidden(usr_x)~region(eu)';
        return { id: 'usr_' + String(i).padStart(8, '0') + '-0000-4000-8000-000000000000', displayName: 'Friend ' + i, image: '',
            iconFrame: '', iconFrameUrl: '', nameplateEffect: '', nameplateUrl: '', profileEffect: '', profileEffectUrl: '',
            status: online ? statuses[i % 4] : 'offline', statusDescription: online ? 'status text ' + i : '',
            location: where, platform: online ? (i % 3 ? 'standalonewindows' : 'android') : '', presence: online ? 'online' : 'offline',
            pendingOffline: false, traveling: false, worldName: where.startsWith('wrld_') ? w[1] : '', worldThumb: '', instanceType: where.startsWith('wrld_') ? 'friends' : '',
            tags: ['system_trust_known', 'language_eng'], ageVerified: false, isEconomyCreator: false, ageVerificationStatus: '', avatarFileId: '',
            bio: 'bio ' + i, pronouns: '', bioLinks: [], profilePicOverride: '', lastLogin: '', lastActivity: '', dateJoined: '2022-01-01' };
    };
    const friends = Array.from({ length: ${friendCount} }, (_, i) => friend(i));
    send('vrcFriends', { friends });
    let n = 0;
    window.__liveSent = 0;
    window.__liveTimer = setInterval(() => {
        const i = Math.floor(Math.random() * friends.length), f = friend(i + (++n) * 7);
        f.id = friends[i].id; f.displayName = friends[i].displayName; friends[i] = f;
        send('vrcFriendUpdate', f); window.__liveSent++;
    }, ${liveRate ? Math.round(1000 / liveRate) : 0});
    return typeof window.__photinoDispatch;
})()`;
let main;
try {
    main = await openMain(dir, PORT, { WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: flags });
    await main.send('Performance.enable');
    // Long tasks and slow frames, collected in the page.
    await main.eval(`(() => {
        window.__lt = [];
        new PerformanceObserver(l => { for (const e of l.getEntries()) window.__lt.push([Math.round(e.startTime), Math.round(e.duration)]); }).observe({ type: 'longtask', buffered: true });
        window.__frames = [];
        let last = performance.now();
        const tick = t => { window.__frames.push(Math.round(t - last)); last = t; requestAnimationFrame(tick); };
        requestAnimationFrame(tick);
    })()`);
    const metrics = async () => Object.fromEntries((await main.send('Performance.getMetrics')).result.metrics.map(m => [m.name, m.value]));
    const take = () => main.json(`(() => { const r = { lt: window.__lt, frames: window.__frames }; window.__lt = []; window.__frames = []; return r; })()`);
    const sum = a => a.reduce((s, x) => s + x, 0);
    const summary = ({ lt, frames }) => ({ longTasks: lt.length, longMs: sum(lt.map(x => x[1])), worstTask: Math.max(0, ...lt.map(x => x[1])), slowFrames: frames.filter(f => f > 50).length, worstFrame: Math.max(0, ...frames) });

    // Startup: everything that happened before we looked.
    await sleep(5000);
    out.startup = summary(await take());

    if (liveRate) {
        if (!(await main.json(`typeof window.__photinoDispatch === 'function'`))) throw new Error('no __photinoDispatch: cannot stand in for live traffic');
        await main.eval(LIVE_JS);
        await sleep(3000);
        out.liveStart = { ...summary(await take()), friendNodes: await main.json(`document.getElementById('vrcFriendsList')?.getElementsByTagName('*').length ?? -1`), friendsData: await main.json(`(window.vrcFriendsData || []).length`) };
    }

    // Idle.
    await sleep(idleS * 1000);
    out.idle = { seconds: idleS, ...summary(await take()), heapMB: Math.round((await metrics()).JSHeapUsedSize / 1048576) };

    // Tabs.
    const entries = await main.json(`Object.entries(NAV_ITEMS_DEF).filter(([, d]) => Number.isInteger(d.tab)).map(([k, d]) => [k, d.tab])`);
    out.tabs = [];
    for (const [key, tab] of entries) {
        await take();
        const before = await metrics();
        const ms = await main.json(`(() => { const t0 = performance.now(); const btn = document.querySelector('#sidebarEl .nav-btn[onclick*="showTab(${tab})"]'); if (btn) btn.click(); else showTab(${tab}); return Math.round(performance.now() - t0); })()`);
        // Let async renders that the switch kicked off finish.
        await sleep(1500);
        const after = await metrics();
        const nodes = await main.json(`document.getElementById('tab${tab}')?.getElementsByTagName('*').length ?? 0`);
        out.tabs.push({ key, tab, syncMs: ms, nodes, ...summary(await take()),
            layouts: after.LayoutCount - before.LayoutCount, styles: after.RecalcStyleCount - before.RecalcStyleCount,
            layoutMs: Math.round((after.LayoutDuration - before.LayoutDuration) * 1000), styleMs: Math.round((after.RecalcStyleDuration - before.RecalcStyleDuration) * 1000),
            scriptMs: Math.round((after.ScriptDuration - before.ScriptDuration) * 1000) });
    }

    // Scroll the heaviest tabs.
    const heavy = [...out.tabs].sort((a, b) => b.nodes - a.nodes).slice(0, 5);
    out.scroll = [];
    for (const t of heavy) {
        await main.eval(`showTab(${t.tab})`);
        await sleep(800);
        await take();
        const scrolled = await main.eval(`(async () => {
            const tab = document.getElementById('tab${t.tab}');
            const el = [tab, ...tab.querySelectorAll('*')].find(e => e.scrollHeight > e.clientHeight + 200 && /(auto|scroll)/.test(getComputedStyle(e).overflowY)) || document.scrollingElement;
            for (let i = 0; i < 90; i++) { el.scrollTop += 40; await new Promise(r => requestAnimationFrame(r)); }
            el.scrollTop = 0;
            return el.id || el.className || el.tagName;
        })()`);
        const s = await take();
        const fr = s.frames.slice(1);
        out.scroll.push({ key: t.key, scroller: String(scrolled).slice(0, 40), ...summary(s), p95: fr.sort((a, b) => a - b)[Math.floor(fr.length * 0.95)] || 0 });
    }
    out.heapMB = Math.round((await metrics()).JSHeapUsedSize / 1048576);
    if (liveRate) out.liveSent = await main.json(`window.__liveSent`);
    out.errors = main.errors.slice(0, 10);
} finally {
    if (main) await closeMain(main).catch(() => {});
    await cleanUp(dir);
}

mkdirSync(join(ROOT, 'tools', 'hapshub', 'out'), { recursive: true });
writeFileSync(join(ROOT, 'tools', 'hapshub', 'out', 'lag-profile.json'), JSON.stringify(out, null, 1));
console.log(`data: ${out.data}`);
console.log(`startup: ${JSON.stringify(out.startup)}`);
if (out.liveStart) console.log(`friends list arrives: ${JSON.stringify(out.liveStart)}`);
console.log(`idle: ${JSON.stringify(out.idle)}`);
console.log('tab                     sync  long  longMs worst slowFr layouts styles layMs styMs scrMs nodes');
for (const t of [...out.tabs].sort((a, b) => (b.syncMs + b.longMs) - (a.syncMs + a.longMs)).slice(0, 15))
    console.log(`${t.key.padEnd(22)} ${String(t.syncMs).padStart(5)} ${String(t.longTasks).padStart(5)} ${String(t.longMs).padStart(7)} ${String(t.worstTask).padStart(5)} ${String(t.slowFrames).padStart(6)} ${String(t.layouts).padStart(7)} ${String(t.styles).padStart(6)} ${String(t.layoutMs).padStart(5)} ${String(t.styleMs).padStart(5)} ${String(t.scriptMs).padStart(5)} ${String(t.nodes).padStart(5)}`);
console.log('scroll: ' + out.scroll.map(s => `${s.key} p95=${s.p95} worst=${s.worstFrame} slow=${s.slowFrames}`).join(' | '));
console.log(`heap ${out.heapMB} MB, page errors: ${out.errors.length}${out.liveSent != null ? `, friend updates sent: ${out.liveSent}` : ''}`);
for (const e of out.errors.slice(0, 3)) console.log('  ' + String(e?.text ?? e).slice(0, 200));
