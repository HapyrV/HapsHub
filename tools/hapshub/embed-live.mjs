// Tests the real OyasumiVR, Space Calibrator and OVR Toolkit in a throwaway copy of HapsHub, using the page's own Test button.
// Windows go back to how they were. Stops only what it started, including an OyasumiVR it had to open.
//   node tools/hapshub/embed-live.mjs [oyasumi] [--tracked]

import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const EXE = join(ROOT, 'bin', 'Debug', 'net10.0-windows10.0.19041.0', 'HapsHub.exe');
const PORT = 9336;
const TABS = { oyasumi: 33, spacecal: 36, ovrtoolkit: 38 };
const NAMES = { oyasumi: 'OyasumiVR', spacecal: 'Space Calibrator', ovrtoolkit: 'OVR Toolkit' };
const chosen = process.argv.slice(2).filter(a => a in TABS);
const apps = chosen.length ? chosen : Object.keys(TABS);
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

function pids(name) {
    const out = spawnSync('tasklist', ['/FI', `IMAGENAME eq ${name}.exe`, '/FO', 'CSV', '/NH'], { encoding: 'utf8' }).stdout;
    return out.split('\n').map(line => Number(line.split('","')[1])).filter(Boolean);
}

const data = mkdtempSync(join(tmpdir(), 'hapshub-embed-'));
const version = readFileSync(join(ROOT, 'main', 'AppInfo.cs'), 'utf8').match(/Version = "([^"]+)"/)[1];
writeFileSync(join(data, 'settings.json'), JSON.stringify({ SetupComplete: true, MinimizeToTray: false, LastChangelogVersion: version }));
const app = spawn(EXE, [], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, HAPSHUB_DATA_DIR: data, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` },
});

let failed = 0;
let socket;
let giveBack = async () => {};
try {
    const target = await waitFor('the page', async () => {
        const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
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
    const evaluate = expression => new Promise(done => {
        const myId = id++;
        pending.set(myId, message => done(message.result?.result?.value));
        socket.send(JSON.stringify({ id: myId, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
    });
    // Force-closing a parent would destroy a window it still holds, so everything goes back first.
    giveBack = async () => {
        for (const name of apps) await evaluate(`sendToCS({ action: 'hubEmbedRelease', app: '${name}' })`);
        await sleep(1500);
    };
    await waitFor('the app to load', () => evaluate(`typeof onHubEmbedState === 'function' && typeof showTab === 'function'`));
    await sleep(3000);
    // Keeps what the app reports, since the page's own drawing is covered by features-test.
    await evaluate(`(() => { const draw = onHubEmbedState; window.__embed = {}; onHubEmbedState = p => { window.__embed[p.app] = p; draw(p); }; })()`);

    for (const name of apps) {
        const before = pids(NAMES[name]);
        await evaluate(`showTab(${TABS[name]})`);
        await waitFor(`${name} page`, () => evaluate(`!!document.getElementById('aemb-pane-${name}')`));
        await sleep(800);
        // A person starts the test with a click, so HapsHub is in front. Never takes focus from a game.
        if (pids('VRChat').length === 0) spawnSync('powershell', ['-NoProfile', '-Command', `(New-Object -ComObject WScript.Shell).AppActivate(${app.pid})`]);
        await sleep(500);
        await evaluate(`aembTest('${name}')`);
        await sleep(500);
        const report = await waitFor(`${name} test`, async () => {
            const value = await evaluate(`JSON.stringify(window.__embed['${name}'] || null)`);
            const parsed = JSON.parse(value);
            return parsed && !parsed.testing && parsed.checks ? parsed : null;
        }, 180000);
        console.log(`--- ${NAMES[name]} ---`);
        for (const check of report.checks) console.log(`${check.passed ? 'ok  ' : 'FAIL'} ${check.name}${check.passed ? '' : ` (${check.detail})`}`);
        console.log(report.result);
        console.log(`mode kept: ${report.mode}`);
        if (report.result.startsWith('Failed') && !report.result.includes('Passed')) failed++;

        if (report.mode) console.log('ready');
        if (process.env.HOLD_SECONDS) await sleep(Number(process.env.HOLD_SECONDS) * 1000);

        await evaluate(`aembRelease('${name}')`);
        await sleep(1200);
        for (const pid of pids(NAMES[name])) {
            if (!before.includes(pid)) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F']);
        }
    }
} catch (error) {
    failed++;
    console.log(`FAIL ${error.message}`);
} finally {
    await giveBack().catch(() => {});
    socket?.close();
    spawnSync('taskkill', ['/PID', String(app.pid), '/T', '/F']);
    await sleep(800);
    try { rmSync(data, { recursive: true, force: true }); } catch { /* still closing */ }
}
console.log(failed ? `${failed} app(s) failed` : 'all passed');
process.exit(failed ? 1 : 0);
