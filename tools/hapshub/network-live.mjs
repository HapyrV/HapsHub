// Draws the Mutual Network with made-up friends in a throwaway copy of HapsHub and checks it works like VRCX's:
// a WebGL picture, sizes from mutual counts, coloured communities, and nodes that grow when zooming in.
//   node tools/hapshub/network-live.mjs [folder for pictures]

import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const EXE = join(ROOT, 'bin', 'Debug', 'net10.0-windows10.0.19041.0', 'HapsHub.exe');
const PORT = 9337;
const SHOTS = process.argv[2];
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

const data = mkdtempSync(join(tmpdir(), 'hapshub-net-'));
const version = readFileSync(join(ROOT, 'main', 'AppInfo.cs'), 'utf8').match(/Version = "([^"]+)"/)[1];
writeFileSync(join(data, 'settings.json'), JSON.stringify({ SetupComplete: true, MinimizeToTray: false, LastChangelogVersion: version }));
const app = spawn(EXE, [], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, HAPSHUB_DATA_DIR: data, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` },
});

let failed = 0;
const check = (name, ok, detail = '') => { if (!ok) failed++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`); };
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
    const shot = async name => {
        if (!SHOTS) return;
        const reply = await send('Page.captureScreenshot', { format: 'png' });
        writeFileSync(join(SHOTS, `${name}.png`), Buffer.from(reply.result.data, 'base64'));
    };

    await waitFor('the app to load', () => evaluate(`typeof initNetwork === 'function' && typeof showTab === 'function' && !!window.HHGraphLib`));
    await sleep(2000);

    // Six circles of friends, linked inside their circle and a little across.
    await evaluate(`(() => {
        const friends = [];
        for (let i = 0; i < 300; i++) friends.push({ id: 'usr_' + i, displayName: 'Friend ' + i, status: i % 3 ? 'offline' : 'active' });
        vrcFriendsData = friends;
        const cache = {};
        let seed = 7;
        const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
        for (let i = 0; i < 300; i++) {
            const circle = i % 6, ids = new Set();
            const count = 2 + Math.floor(rnd() * (i < 12 ? 40 : 10));
            while (ids.size < count) {
                const j = rnd() < 0.9 ? circle + 6 * Math.floor(rnd() * 50) : Math.floor(rnd() * 300);
                if (j !== i) ids.add('usr_' + j);
            }
            cache['usr_' + i] = { mutualIds: [...ids], optedOut: false };
        }
        _cacheLoadPending = false; _netCacheReady = true; _mutualCache = cache;
    })()`);
    await evaluate(`showTab(15)`);
    await waitFor('the network page', () => evaluate(`!!document.getElementById('netCanvas') && document.getElementById('tab15').classList.contains('active')`));
    await evaluate(`initNetwork(); networkCacheLoaded(JSON.stringify(_mutualCache));`);
    await evaluate(`_cacheLoadPending = true; networkCacheLoaded(JSON.stringify(_mutualCache))`);
    await waitFor('the graph to be drawn', () => evaluate(`!!(_netGraph && _netGraph._sigma && _netGraph.graph && _netGraph.graph.order > 0)`), 60000);
    await sleep(800);

    const facts = JSON.parse(await evaluate(`JSON.stringify((() => {
        const g = _netGraph.graph, sizes = [];
        g.forEachNode((id, at) => sizes.push(at.size));
        const spread = { minX: Infinity, maxX: -Infinity };
        g.forEachNode((id, at) => { spread.minX = Math.min(spread.minX, at.x); spread.maxX = Math.max(spread.maxX, at.x); });
        return {
            nodes: g.order, edges: g.size, smallest: Math.min(...sizes), biggest: Math.max(...sizes),
            communities: _netGraph._commList.length, webgl: !!document.querySelector('#netCanvas canvas.sigma-nodes'),
            spread: spread.maxX - spread.minX,
        };
    })())`));
    check('the graph is drawn with WebGL', facts.webgl);
    check('every friend is a node', facts.nodes === 300, `${facts.nodes} nodes, ${facts.edges} links`);
    check('sizes run from 4 to 22 by mutual count', Math.abs(facts.smallest - 4) < 2.5 && Math.abs(facts.biggest - 22) < 0.01, `${facts.smallest.toFixed(1)} to ${facts.biggest.toFixed(1)}`);
    check('communities are found and coloured', facts.communities >= 3, `${facts.communities} communities`);
    check('the layout spread people out', facts.spread > 50, `width ${facts.spread.toFixed(0)}`);
    await shot('network-fit');

    const zoom = JSON.parse(await evaluate(`(async () => {
        const s = _netGraph._sigma, id = 'usr_0';
        const before = s.getNodeDisplayData(id).size, camera = s.getCamera();
        const at = s.getNodeDisplayData(id);
        await camera.animate({ x: at.x, y: at.y, ratio: camera.ratio / 6 }, { duration: 0 });
        s.refresh();
        await new Promise(r => setTimeout(r, 300));
        const scaled = s.scaleSize(s.getNodeDisplayData(id).size);
        const labels = document.querySelector('#netCanvas canvas.sigma-labels');
        return JSON.stringify({ before: s.scaleSize(before) / 1, after: scaled, ratio: camera.ratio, hasLabels: !!labels });
    })()`));
    await shot('network-zoomed');
    await evaluate(`_netGraph._sigma.getCamera().animatedReset({ duration: 0 })`);
    const zoomed = JSON.parse(await evaluate(`(async () => {
        const s = _netGraph._sigma;
        await new Promise(r => setTimeout(r, 200));
        const out = s.scaleSize(s.getNodeDisplayData('usr_0').size);
        return JSON.stringify({ out });
    })()`));
    check('nodes grow on screen when zooming in', zoom.after > zoomed.out * 1.5, `${zoomed.out.toFixed(1)} px zoomed out, ${zoom.after.toFixed(1)} px zoomed in`);

    await evaluate(`_netGraph._hovered = 'usr_0'; _netGraph._setFocus('usr_0')`);
    await sleep(300);
    const lit = JSON.parse(await evaluate(`JSON.stringify((() => {
        const s = _netGraph._sigma, me = s.getNodeDisplayData('usr_0'), friendOfMe = _netGraph.graph.neighbors('usr_0')[0];
        const stranger = _netGraph.graph.nodes().find(n => n !== 'usr_0' && !_netGraph.graph.areNeighbors('usr_0', n));
        return { me: me.color, near: s.getNodeDisplayData(friendOfMe).hidden, far: s.getNodeDisplayData(stranger).size };
    })())`));
    check('hovering lights the person up and fades the rest', lit.me === '#facc15' && !lit.near && lit.far < 1, JSON.stringify(lit));
    await shot('network-hover');
    await evaluate(`_netGraph._hovered = null; _netGraph._setFocus(null)`);

    await evaluate(`networkSearch('Friend 42')`);
    await sleep(500);
    check('search finds and highlights a person', await evaluate(`_netGraph.searchMatch === 'usr_42'`));
    await evaluate(`networkSearch('')`);

    await evaluate(`networkToggleCommunities(document.getElementById('netCommunities'))`);
    await sleep(200);
    check('the communities panel lists them', await evaluate(`document.querySelectorAll('#netCommList .net-comm-row').length`) === facts.communities);
    await evaluate(`networkFilterCommunity(0)`);
    await sleep(200);
    const shown = await evaluate(`(() => { let n = 0; _netGraph.graph.forEachNode(id => { if (!_netGraph._sigma.getNodeDisplayData(id).hidden) n++; }); return n; })()`);
    check('picking a community shows only it', shown > 0 && shown < facts.nodes, `${shown} shown`);
    await shot('network-community');
    const errors = await evaluate(`(window.__errors || []).length`);
    check('no page errors', !errors, String(errors));
} catch (error) {
    failed++;
    console.log(`FAIL ${error.message}`);
} finally {
    socket?.close();
    spawnSync('taskkill', ['/PID', String(app.pid), '/T', '/F']);
    await sleep(800);
    try { rmSync(data, { recursive: true, force: true }); } catch { /* still closing */ }
}
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
