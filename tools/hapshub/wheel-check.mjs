// Checks that mouse-wheel scrolling doesn't wait for the page's script: no wheel listener that could cancel
// scrolling sits on the page or anywhere under the mouse, and the page scrolls on its own layer.
// (Timing a wheel tick from DevTools doesn't work for this: DevTools waits for the page either way.)
// Also checks Ctrl+wheel still zooms the interface.
//   node tools/hapshub/wheel-check.mjs

import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const EXE = join(ROOT, 'bin', 'Debug', 'net10.0-windows10.0.19041.0', 'HapsHub.exe');
const PORT = 9339;
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

const data = mkdtempSync(join(tmpdir(), 'hapshub-wheel-'));
const version = readFileSync(join(ROOT, 'main', 'AppInfo.cs'), 'utf8').match(/Version = "([^"]+)"/)[1];
writeFileSync(join(data, 'settings.json'), JSON.stringify({ SetupComplete: true, MinimizeToTray: false, LastChangelogVersion: version, EfficiencyMode: false }));
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

    await waitFor('the app to load', () => evaluate(`typeof showTab === 'function' && !!document.querySelector('.content')`));
    await sleep(3000);
    await evaluate(`showTab(0)`);
    await sleep(1500);
    const point = JSON.parse(await evaluate(`JSON.stringify((() => { const r = document.querySelector('#tab0').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + Math.min(r.height, 600) / 2) }; })())`));

    const docRef = (await send('Runtime.evaluate', { expression: 'document' })).result.result.objectId;
    const listeners = (await send('DOMDebugger.getEventListeners', { objectId: docRef })).result.listeners
        .filter(l => l.type === 'wheel' || l.type === 'mousewheel');
    check('no wheel listener on the whole page can hold up scrolling', listeners.every(l => l.passive), `${listeners.filter(l => !l.passive).length} blocking of ${listeners.length}`);

    // Anything between the window and the element under the mouse counts, so each is listed with where it was added.
    const scripts = new Map();
    socket.addEventListener('message', event => {
        const message = JSON.parse(event.data);
        if (message.method === 'Debugger.scriptParsed') scripts.set(message.params.scriptId, message.params.url);
    });
    await send('Debugger.enable');
    const path = (await send('Runtime.evaluate', { expression: `(() => { const out = [window]; let el = document.elementFromPoint(${point.x}, ${point.y}); const chain = []; while (el) { chain.unshift(el); el = el.parentElement; } return out.concat([document], chain); })()` })).result.result.objectId;
    const props = (await send('Runtime.getProperties', { objectId: path, ownProperties: true })).result.result.filter(p => /^\d+$/.test(p.name));
    const blocking = [];
    for (const prop of props) {
        const found = (await send('DOMDebugger.getEventListeners', { objectId: prop.value.objectId })).result.listeners;
        for (const l of found.filter(l => (l.type === 'wheel' || l.type === 'mousewheel' || l.type === 'touchstart' || l.type === 'touchmove') && !l.passive))
            blocking.push(`${l.type} on ${prop.value.description} at ${(scripts.get(l.scriptId) || l.scriptId).split('/').slice(-2).join('/')}:${l.lineNumber + 1}`);
    }
    check('nothing under the mouse can hold up scrolling', blocking.length === 0, blocking.join('; '));
    // Chromium's own view: regions where wheel input or scrolling needs the page's script.
    const layers = await new Promise(async done => {
        const listen = event => {
            const message = JSON.parse(event.data);
            if (message.method === 'LayerTree.layerTreeDidChange' && message.params.layers) { socket.removeEventListener('message', listen); done(message.params.layers); }
        };
        socket.addEventListener('message', listen);
        await send('LayerTree.enable');
        await evaluate(`document.body.style.outline = '0px solid transparent'; requestAnimationFrame(() => document.body.style.outline = ''), true`);
        setTimeout(() => done([]), 5000);
    });
    const marks = {};
    for (const layer of layers) for (const rect of layer.scrollRects || []) marks[rect.type] = (marks[rect.type] || 0) + 1;
    console.log(`     layers ${layers.length}; scroll marks ${JSON.stringify(marks)}`);
    await send('DOM.getDocument', { depth: 0 });
    for (const layer of layers.filter(l => (l.scrollRects || []).some(r => r.type === 'RepaintsOnScroll'))) {
        let who = 'no element';
        if (layer.backendNodeId) {
            const node = (await send('DOM.describeNode', { backendNodeId: layer.backendNodeId })).result?.node;
            if (node) who = `${node.localName}${node.attributes ? ' ' + node.attributes.join(' ').slice(0, 160) : ''}`;
        }
        console.log(`     repaints on scroll: ${layer.width}x${layer.height}, ${who}, rects ${JSON.stringify(layer.scrollRects)}`);
    }
    const scrolls = [];
    for (const layer of layers) {
        if (!layer.backendNodeId) continue;
        const node = (await send('DOM.describeNode', { backendNodeId: layer.backendNodeId })).result?.node;
        if (node?.attributes?.includes('dashSectionsContainer')) scrolls.push(layer);
    }
    check('the dashboard scrolls on its own layer', scrolls.length > 0);
    const before = await evaluate(`_guiZoom`);
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, modifiers: 2 });
    await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: point.x, y: point.y, deltaX: 0, deltaY: -120, modifiers: 2 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, modifiers: 0 });
    await sleep(300);
    const after = await evaluate(`_guiZoom`);
    check('Ctrl+wheel still zooms the interface', after > before, `${before} -> ${after}`);
    await evaluate(`applyGuiZoom(${before})`);
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
