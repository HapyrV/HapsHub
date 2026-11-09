// Drives the built app through the features added after the first smoke test, using throwaway
// data folders, no login and no VRChat traffic. Stops only the processes it started.
//   node tools/hapshub/features-test.mjs [--release]

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CONFIG = process.argv.includes('--release') ? 'Release' : 'Debug';
const EXE = join(ROOT, 'bin', CONFIG, 'net10.0-windows10.0.19041.0', 'HapsHub.exe');
const PORT = 9334;

let failures = 0;
const check = (name, passed, detail = '') => {
    if (!passed) failures++;
    console.log(`${passed ? 'ok   ' : 'FAIL '} ${name}${!passed && detail ? `: ${detail}` : ''}`);
};
const sleep = ms => new Promise(done => setTimeout(done, ms));
async function waitFor(what, test, timeoutMs = 30000) {
    const end = Date.now() + timeoutMs;
    for (;;) {
        const value = await test();
        if (value) return value;
        if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
        await sleep(150);
    }
}

const started = [];
function startApp(dataDir, extraEnv = {}) {
    const app = spawn(EXE, [], {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, ...extraEnv, HAPSHUB_DATA_DIR: dataDir, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` },
    });
    started.push(app.pid);
    return app;
}

class Page {
    constructor(socket) {
        this.socket = socket;
        this.nextId = 1;
        this.pending = new Map();
        this.errors = [];
        socket.addEventListener('message', event => {
            const message = JSON.parse(event.data);
            if (message.id && this.pending.has(message.id)) {
                this.pending.get(message.id)(message);
                this.pending.delete(message.id);
            } else if (message.method === 'Runtime.exceptionThrown') {
                const details = message.params.exceptionDetails;
                this.errors.push(details.exception?.description || details.text);
            }
        });
    }
    static async connect(pageFile) {
        const target = await waitFor(`page ${pageFile}`, async () => {
            try {
                const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
                return targets.find(t => t.type === 'page' && t.url.includes(pageFile));
            } catch { return null; }
        }, 60000);
        const socket = new WebSocket(target.webSocketDebuggerUrl);
        await new Promise((done, fail) => {
            socket.addEventListener('open', done, { once: true });
            socket.addEventListener('error', fail, { once: true });
        });
        const page = new Page(socket);
        await page.send('Runtime.enable');
        return page;
    }
    send(method, params = {}) {
        const id = this.nextId++;
        return new Promise(done => {
            this.pending.set(id, done);
            this.socket.send(JSON.stringify({ id, method, params }));
        });
    }
    async eval(expression) {
        const answer = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
        if (answer.result?.exceptionDetails) throw new Error(`${expression.slice(0, 80)}: ${answer.result.exceptionDetails.exception?.description}`);
        return answer.result?.result?.value;
    }
    mouse(type, x, y) {
        return this.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 });
    }
    // A real drag through the browser's input queue, not a synthetic DOM event.
    async drag(from, to) {
        await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y });
        await this.mouse('mousePressed', from.x, from.y);
        for (let step = 1; step <= 12; step++) {
            const x = from.x + (to.x - from.x) * step / 12, y = from.y + (to.y - from.y) * step / 12;
            await this.mouse('mouseMoved', x, y);
            await sleep(25);
        }
        await sleep(150);
        await this.mouse('mouseReleased', to.x, to.y);
        await sleep(150);
    }
    screenshot(file) {
        return this.send('Page.captureScreenshot', { format: 'png' }).then(shot => writeFileSync(file, Buffer.from(shot.result.data, 'base64')));
    }
}

const hubLog = dir => {
    const file = join(dir, 'Hub', 'hub.log');
    return existsSync(file) ? readFileSync(file, 'utf8') : '';
};
const crashes = dir => {
    const folder = join(dir, 'Logs', 'Crashes');
    return existsSync(folder) ? readdirSync(folder).length : 0;
};

async function openMain(dir, extraEnv) {
    startApp(dir, extraEnv);
    const page = await Page.connect('index.html');
    await waitFor('page message handler', () => page.eval(`window.__vrcndbConsentChecked === true && typeof hubModulesRefresh === 'function'`));
    await waitFor('hub modules', () => hubLog(dir).includes('Hub started.'));
    // Remembers every message from the app, so a test can wait for one.
    await page.eval(`(() => {
        const before = window.__afOnWebsocketEvent;
        window.__seen = {};
        window.__afOnWebsocketEvent = (type, payload) => { window.__seen[type] = payload; if (before) before(type, payload); };
    })()`);
    return page;
}

async function closeMain(page, dir) {
    await page.eval(`sendToCS({action:'windowClose'})`);
    const logged = hubLog(dir).split('Hub stopped.').length;
    page.socket.close();
    return waitFor('clean exit', () => hubLog(dir).split('Hub stopped.').length > logged, 20000).catch(() => false);
}

const dir = mkdtempSync(join(tmpdir(), 'hapshub-features-'));
const version = readFileSync(join(ROOT, 'main', 'AppInfo.cs'), 'utf8').match(/Version = "([^"]+)"/)[1];
writeFileSync(join(dir, 'settings.json'), JSON.stringify({ SetupComplete: true, MinimizeToTray: false, LastChangelogVersion: version }));

const seen = (page, type) => page.eval(`JSON.stringify(window.__seen[${JSON.stringify(type)}] ?? null)`).then(JSON.parse);
const waitSeen = (page, type, test = () => true) => waitFor(`message ${type}`, async () => {
    const value = await seen(page, type);
    return value !== null && test(value) ? value : null;
});

try {
    let main = await openMain(dir);

    // --- Sidebar: the default sections, dragging a tool between them, and hiding one ---
    await main.eval(`localStorage.removeItem('vrcnext_nav_layout_v1'); navRender();`);
    const sections = await main.eval(`(() => {
        const out = {}; let current = '';
        for (const entry of navLoadLayout().layout) {
            if (entry.type === 'separator') current = entry.name;
            else if (entry.type === 'item') (out[current] ||= []).push(entry.key);
            else (out[current] ||= []).push(...entry.items);
        }
        return JSON.stringify(out);
    })()`).then(JSON.parse);
    check('the five chosen tools default to Overview', ['space-flight', 'space-turn', 'youtube-fix', 'mutual-network', 'time-spent'].every(key => sections.Overview.includes(key)), JSON.stringify(sections));
    check('other tools stay in Tools', sections.Tools.includes('friend-schedule') && !sections.Tools.includes('space-flight'), JSON.stringify(sections));

    await main.eval(`openNavEditor()`);
    await waitFor('nav editor rows', () => main.eval(`document.querySelectorAll('#navEditorList .ne-row[data-key]').length > 10`));
    const handleAt = key => main.eval(`(() => {
        const row = document.querySelector('#navEditorList .ne-row[data-key="${key}"]');
        row.scrollIntoView({ block: 'center' });
        const box = row.querySelector('.ne-handle').getBoundingClientRect();
        return JSON.stringify({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
    })()`).then(JSON.parse);
    const source = await handleAt('friend-schedule');
    const target = await main.eval(`(() => {
        const list = document.getElementById('navEditorList');
        const row = list.querySelector('.ne-row[data-key="time-spent"]');
        const box = row.getBoundingClientRect();
        return JSON.stringify({ x: box.x + 30, y: box.y + box.height + 2, visible: box.bottom > list.getBoundingClientRect().top });
    })()`).then(JSON.parse);
    await main.drag(source, target);
    await sleep(400); // The editor settles the row 200 ms after the drop.
    await main.eval(`_edConfirm()`);
    const moved = await main.eval(`(() => {
        const { layout } = navLoadLayout();
        const folder = layout.find(e => e.type === 'folder' && e.id === 'folder-tools');
        return JSON.stringify({ top: layout.some(e => e.type === 'item' && e.key === 'friend-schedule'), inFolder: folder.items.includes('friend-schedule') });
    })()`).then(JSON.parse);
    check('dragging moves a tool from Tools to Overview and it saves', moved.top && !moved.inFolder, JSON.stringify(moved));
    check('the moved tool is in the sidebar', await main.eval(`(() => { const btn = document.querySelector('.nav-btn[data-nav-key="friend-schedule"]'); return !!btn && !btn.closest('.nav-folder-items, .nav-folder-group, [class*="folder"]'); })()`));

    await main.eval(`openNavEditor(); _edHideItem('time-spent', null); _edConfirm();`);
    const hidden = await main.eval(`JSON.stringify(navLoadLayout().hidden)`).then(JSON.parse);
    check('hiding a tool saves and takes it off the sidebar', hidden.includes('time-spent') && !(await main.eval(`!!document.querySelector('.nav-btn[data-nav-key="time-spent"]')`)), JSON.stringify(hidden));
    await main.eval(`location.reload()`);
    await sleep(1000);
    main.socket.close();
    main = await Page.connect('index.html');
    await waitFor('page after reload', () => main.eval(`window.__vrcndbConsentChecked === true && typeof navLoadLayout === 'function'`));
    await main.eval(`(() => { const before = window.__afOnWebsocketEvent; window.__seen = {}; window.__afOnWebsocketEvent = (t, p) => { window.__seen[t] = p; if (before) before(t, p); }; })()`);
    check('moved and hidden tools survive a reload', await main.eval(`(() => {
        const { layout, hidden } = navLoadLayout();
        return hidden.includes('time-spent') && layout.some(e => e.type === 'item' && e.key === 'friend-schedule');
    })()`));
    await main.eval(`localStorage.removeItem('vrcnext_nav_layout_v1'); navRender();`);

    // --- Worlds: local favourites, signed out ---
    await main.eval(`sendToCS({ action: 'vrcCreateLocalGroup', kind: 'world', displayName: 'Test places' })`);
    const created = await waitSeen(main, 'vrcLocalGroupResult');
    check('a local world group is created', created.ok === true, JSON.stringify(created));
    const worldGroups = await waitSeen(main, 'vrcFavoriteWorlds', value => JSON.stringify(value).includes('Test places')).catch(() => null);
    check('the local group reaches the Worlds page', !!worldGroups);
    if (worldGroups) {
        const group = worldGroups.groups.find(g => g.displayName === 'Test places');
        const worldId = 'wrld_00000000-0000-0000-0000-000000000001';
        await main.eval(`sendToCS({ action: 'vrcAddWorldFavorite', worldId: '${worldId}', groupName: '${group.name}', groupType: '${group.type}' })`);
        const added = await waitSeen(main, 'vrcWorldFavoriteResult');
        check('a world is added to the local group', added.ok === true && String(added.newFvrtId).length > 0, JSON.stringify(added));
        await main.eval(`sendToCS({ action: 'vrcDeleteLocalGroup', kind: 'world', groupName: '${group.name}' })`);
        const gone = await waitSeen(main, 'vrcFavoriteWorlds', value => !JSON.stringify(value).includes('Test places')).catch(() => null);
        check('the local group can be deleted', !!gone);
    }

    check('main page has no page errors', main.errors.length === 0, main.errors.join(' | '));
    check('app exits cleanly', await closeMain(main, dir));
    check('no crash report', crashes(dir) === 0);
} catch (error) {
    check('feature run finished', false, error.message);
    for (const pid of started) spawnSync('taskkill', ['/PID', String(pid), '/F', '/T']);
} finally {
    await sleep(1500);
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* A file may still be held; it's in the temp folder. */ }
}

console.log(failures === 0 ? 'Feature test passed.' : `${failures} feature check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
