// Shared by the HapsHub tests: starts a throwaway copy of the built app and drives its page through
// WebView2's debug port. A copy gets its own data folder, so there's no login, no VRChat traffic, and
// the real app can stay open beside it. Only what a test started is ever stopped.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const CONFIG = process.argv.includes('--release') ? 'Release' : 'Debug';
// HAPSHUB_TEST_EXE tests another build, such as the release zip's.
export const EXE = process.env.HAPSHUB_TEST_EXE || join(ROOT, 'bin', CONFIG, 'net10.0-windows10.0.19041.0', 'HapsHub.exe');
export const VERSION = readFileSync(join(ROOT, 'main', 'AppInfo.cs'), 'utf8').match(/Version = "([^"]+)"/)[1];

export const sleep = ms => new Promise(done => setTimeout(done, ms));

export async function waitFor(what, test, timeoutMs = 30000, everyMs = 150) {
    const end = Date.now() + timeoutMs;
    for (;;) {
        const value = await test();
        if (value) return value;
        if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
        await sleep(everyMs);
    }
}

/** Counts failures and prints one line per check, the same way every HapsHub test does. */
export function checker() {
    const state = { failures: 0, passed: 0 };
    const check = (name, passed, detail = '') => {
        if (passed) state.passed++; else state.failures++;
        console.log(`${passed ? 'ok   ' : 'FAIL '} ${name}${!passed && detail ? `: ${String(detail).slice(0, 600)}` : ''}`);
        return !!passed;
    };
    return { check, state };
}

export class Page {
    constructor(socket, port) {
        this.socket = socket;
        this.port = port;
        this.nextId = 1;
        this.pending = new Map();
        this.errors = [];
        this.listeners = new Map();
        socket.addEventListener('message', event => {
            const message = JSON.parse(event.data);
            if (message.id && this.pending.has(message.id)) {
                this.pending.get(message.id)(message);
                this.pending.delete(message.id);
            } else if (message.method === 'Runtime.exceptionThrown') {
                const details = message.params.exceptionDetails;
                this.errors.push(details.exception?.description || details.text);
            } else if (message.method && this.listeners.has(message.method)) {
                for (const listener of this.listeners.get(message.method)) listener(message.params);
            }
        });
    }

    static async connect(port, pageFile, timeoutMs = 60000) {
        const target = await waitFor(`page ${pageFile}`, async () => {
            try {
                const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
                return targets.find(t => t.type === 'page' && t.url.includes(pageFile));
            } catch { return null; }
        }, timeoutMs, 200);
        const socket = new WebSocket(target.webSocketDebuggerUrl);
        await new Promise((done, fail) => {
            socket.addEventListener('open', done, { once: true });
            socket.addEventListener('error', fail, { once: true });
        });
        const page = new Page(socket, port);
        await page.send('Runtime.enable');
        return page;
    }

    on(method, listener) {
        if (!this.listeners.has(method)) this.listeners.set(method, []);
        this.listeners.get(method).push(listener);
    }

    send(method, params = {}) {
        const id = this.nextId++;
        return new Promise(done => {
            this.pending.set(id, done);
            this.socket.send(JSON.stringify({ id, method, params }));
        });
    }

    /** Runs an expression in the page. A promise is awaited; a thrown error fails the test that asked. */
    async eval(expression) {
        const answer = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
        if (answer.result?.exceptionDetails)
            throw new Error(`${expression.slice(0, 120)}: ${answer.result.exceptionDetails.exception?.description || answer.result.exceptionDetails.text}`);
        return answer.result?.result?.value;
    }

    /** The same, with the answer sent back as JSON so objects and arrays survive. */
    async json(expression) {
        const text = await this.eval(`JSON.stringify(${expression})`);
        return text === undefined ? undefined : JSON.parse(text);
    }

    mouse(type, x, y, extra = {}) {
        return this.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, ...extra });
    }

    async click(x, y) {
        await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
        await this.mouse('mousePressed', x, y);
        await this.mouse('mouseReleased', x, y);
    }

    /** A real drag through the browser's input queue, not a synthetic DOM event. */
    async drag(from, to, steps = 12) {
        await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y });
        await this.mouse('mousePressed', from.x, from.y);
        for (let step = 1; step <= steps; step++) {
            await this.mouse('mouseMoved', from.x + (to.x - from.x) * step / steps, from.y + (to.y - from.y) * step / steps);
            await sleep(25);
        }
        await sleep(150);
        await this.mouse('mouseReleased', to.x, to.y);
        await sleep(150);
    }

    /** The middle of an element, in page pixels, or null when it isn't on screen. */
    center(selector) {
        return this.json(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; const r = e.getBoundingClientRect(); return r.width && r.height ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null; })()`);
    }

    async screenshot(file, clip) {
        const shot = await this.send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip: { ...clip, scale: 1 } } : {}) });
        writeFileSync(file, Buffer.from(shot.result.data, 'base64'));
        return file;
    }
}

export const hubLog = dir => {
    const file = join(dir, 'Hub', 'hub.log');
    return existsSync(file) ? readFileSync(file, 'utf8') : '';
};

export const crashes = dir => {
    const folder = join(dir, 'Logs', 'Crashes');
    return existsSync(folder) ? readdirSync(folder).length : 0;
};

/** A new data folder with the first-run setup already answered, so the main page opens straight away. */
export function freshData(prefix = 'hapshub-test-', settings = {}) {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ SetupComplete: true, MinimizeToTray: false, LastChangelogVersion: VERSION, ...settings }));
    return dir;
}

const started = [];

export function startApp(dataDir, port, env = {}, args = []) {
    if (!existsSync(EXE)) throw new Error(`the app isn't built: ${EXE}`);
    const app = spawn(EXE, args, {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, ...env, HAPSHUB_DATA_DIR: dataDir, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` },
    });
    started.push(app.pid);
    return app;
}

/** Starts the app on its main page and waits until the page and the hub modules are both ready. */
export async function openMain(dataDir, port, env = {}) {
    const app = startApp(dataDir, port, env);
    const page = await Page.connect(port, 'index.html');
    await waitFor('page message handler', () => page.eval(`window.__vrcndbConsentChecked === true && typeof hubModulesRefresh === 'function'`), 60000);
    await waitFor('hub modules', () => hubLog(dataDir).includes('Hub started.'), 60000);
    // Remembers every message from the app, so a test can wait for one.
    await page.eval(`(() => {
        const before = window.__afOnWebsocketEvent;
        window.__seen = {};
        window.__afOnWebsocketEvent = (type, payload) => { window.__seen[type] = payload; if (before) before(type, payload); };
    })()`);
    page.app = app;
    page.dataDir = dataDir;
    return page;
}

/** Asks the app to close the way its own close button does, and waits for the hub to say it stopped. */
export async function closeMain(page, timeoutMs = 20000) {
    const logged = hubLog(page.dataDir).split('Hub stopped.').length;
    await page.eval(`sendToCS({action:'windowClose'})`).catch(() => {});
    try { page.socket.close(); } catch { /* already closed */ }
    return waitFor('clean exit', () => hubLog(page.dataDir).split('Hub stopped.').length > logged, timeoutMs).catch(() => false);
}

export const seen = (page, type) => page.json(`window.__seen[${JSON.stringify(type)}] ?? null`);

export const waitSeen = (page, type, test = () => true, timeoutMs = 30000) => waitFor(`message ${type}`, async () => {
    const value = await seen(page, type);
    return value !== null && test(value) ? value : null;
}, timeoutMs);

export function processIds(imageName) {
    const out = spawnSync('tasklist', ['/FI', `IMAGENAME eq ${imageName}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8' }).stdout || '';
    return out.split('\n').map(line => Number(line.split('","')[1])).filter(Boolean);
}

export function killTree(pid) {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F']);
}

/** Stops every copy this run started and removes the given data folders. Safe to call twice. */
export async function cleanUp(...dirs) {
    for (const pid of started.splice(0)) killTree(pid);
    await sleep(600);
    for (const dir of dirs) {
        try { rmSync(dir, { recursive: true, force: true }); } catch { /* still closing */ }
    }
}
