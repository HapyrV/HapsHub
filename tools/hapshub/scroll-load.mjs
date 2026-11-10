// Scrolls pages with the mouse wheel in a throwaway copy that has a few hundred made-up friends, and reports how
// smooth it was: frame times, and the style and layout work each frame caused.
//   node tools/hapshub/scroll-load.mjs [tab numbers...] [--friends N] [--class no-blur,no-animations]
// Several runs can be compared by changing the build between them.

import { checker, cleanUp, freshData, openMain, sleep, waitFor } from './lib/harness.mjs';

const PORT = 9341;
const args = process.argv.slice(2);
const flag = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const tabs = args.filter(a => /^\d+$/.test(a) && args[args.indexOf(a) - 1] !== '--friends').map(Number);
const friendCount = Number(flag('--friends', 400));
const classes = (flag('--class', '') || '').split(',').filter(Boolean);
const { state } = checker();

const dir = freshData('hapshub-scrolload-', { EfficiencyMode: false });
try {
    const main = await openMain(dir, PORT);
    await waitFor('the splash to go', () => main.eval(`!document.getElementById('vrcnSplash')`), 15000);
    for (const c of classes) await main.eval(`document.documentElement.classList.add(${JSON.stringify(c)})`);
    // --css adds a style rule, to try a fix without rebuilding.
    const css = flag('--css', '');
    if (css) await main.eval(`document.head.appendChild(Object.assign(document.createElement('style'), { textContent: ${JSON.stringify(css)} }))`);
    await main.send('Performance.enable');
    // Made-up friends: a mix of in game, on the web and offline, each with a picture.
    await main.eval(`(() => {
        const pic = (() => { const c = document.createElement('canvas'); c.width = c.height = 64; const x = c.getContext('2d'); x.fillStyle = '#5a7'; x.fillRect(0, 0, 64, 64); return c.toDataURL(); })();
        const friends = [];
        for (let i = 0; i < ${friendCount}; i++) friends.push({
            id: 'usr_' + i, displayName: 'Friend ' + i, status: ['active', 'join me', 'busy', 'ask me'][i % 4],
            statusDescription: 'Status text ' + i, location: i % 3 === 0 ? 'wrld_' + (i % 20) + ':' + i : i % 3 === 1 ? 'private' : 'offline',
            presence: i % 3 === 2 ? 'offline' : 'online', platform: i % 3 === 1 ? 'web' : 'standalonewindows',
            currentAvatarThumbnailImageUrl: pic, image: pic, profilePicOverride: '', userIcon: '', tags: [], last_platform: 'standalonewindows',
        });
        try { renderVrcFriends(friends, null); } catch (e) { console.warn('renderVrcFriends', e); }
        vrcFriendsData = friends;
        try { if (typeof renderDashboard === 'function') renderDashboard(); } catch (e) { console.warn('renderDashboard', e); }
    })()`);
    await sleep(1500);

    // Frames while doing nothing at all: background timers alone shouldn't cost frames.
    const idle = JSON.parse(await main.eval(`new Promise(done => { const t = []; let last = performance.now(); const end = last + 3000;
        (function f(now) { t.push(now - last); last = now; if (now < end) requestAnimationFrame(f); else done(t.slice(1)); })(last); }).then(JSON.stringify)`));
    const metrics = async () => Object.fromEntries((await main.send('Performance.getMetrics')).result.metrics.map(m => [m.name, m.value]));
    const summary = frames => {
        const sorted = [...frames].sort((a, b) => a - b);
        const at = p => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))].toFixed(1);
        return `median ${at(0.5)} ms, 95% ${at(0.95)} ms, worst ${sorted[sorted.length - 1].toFixed(1)} ms, over 25 ms: ${frames.filter(f => f > 25).length}/${frames.length}`;
    };
    console.log(`idle: ${summary(idle)}`);

    for (const tab of tabs.length ? tabs : [0, 3, 9]) {
        await main.eval(`showTab(${tab})`);
        await sleep(1500);
        const point = await main.json(`(() => { const c = document.querySelector('.content'); c.scrollTop = 0; const r = c.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, room: c.scrollHeight - c.clientHeight }; })()`);
        await sleep(300);
        const before = await metrics();
        await main.eval(`window.__frames = []; window.__last = performance.now(); window.__run = true; (function f(now) { window.__frames.push(now - window.__last); window.__last = now; if (window.__run) requestAnimationFrame(f); })(performance.now());`);
        for (let i = 0; i < 60; i++) {
            await main.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: point.x, y: point.y, deltaX: 0, deltaY: i < 40 ? 100 : -100 });
            await sleep(16);
        }
        await sleep(400);
        const frames = await main.json(`(window.__run = false, window.__frames.slice(1))`);
        const after = await metrics();
        const per = (name, scale = 1) => ((after[name] - before[name]) * scale / Math.max(1, frames.length)).toFixed(2);
        console.log(`tab ${tab} (${point.room}px): ${summary(frames)}; per frame: style ${per('RecalcStyleDuration', 1000)} ms (${per('RecalcStyleCount')}x), layout ${per('LayoutDuration', 1000)} ms (${per('LayoutCount')}x), script ${per('ScriptDuration', 1000)} ms`);
    }
    if (main.errors.length) console.log(`page errors: ${main.errors.slice(0, 3).join(' | ')}`);
} catch (error) {
    console.log(`FAIL ${error.message}`);
    state.failures++;
} finally {
    await cleanUp(dir);
}
process.exit(state.failures ? 1 : 0);
