// Smoke test for the built app. Runs it with throwaway data folders, so there's no login and
// no VRChat traffic, and drives the real page through WebView2's debug port.
//   node tools/hapshub/smoke.mjs [screenshot.png]
// Exit code 0 means every check passed. It only contacts GitHub, for the update check.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const EXE = join(ROOT, 'bin', 'Debug', 'net10.0-windows10.0.19041.0', 'HapsHub.exe');
const PORT = 9333;
const REAL_DATA = join(process.env.APPDATA, 'HapsHub');
const screenshotPath = process.argv.slice(2).find(arg => !arg.startsWith('--'));

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
        await sleep(200);
    }
}

function realFolderStamp() {
    // Top-level files only: enough to catch a path that escaped the override.
    if (!existsSync(REAL_DATA)) return '';
    return readdirSync(REAL_DATA)
        .map(name => [name, statSync(join(REAL_DATA, name))])
        .filter(([, info]) => info.isFile())
        .map(([name, info]) => `${name}:${info.size}:${info.mtimeMs}`)
        .sort().join('|');
}

function startApp(dataDir) {
    return spawn(EXE, [], {
        detached: true,
        stdio: 'ignore',
        env: {
            ...process.env,
            HAPSHUB_DATA_DIR: dataDir,
            WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
        },
    });
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
        Page.last = page;
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
        const answer = await this.send('Runtime.evaluate', { expression, returnByValue: true });
        return answer.result?.result?.value;
    }
}

function writeSettings(dir, values) {
    writeFileSync(join(dir, 'settings.json'), JSON.stringify(values));
}

const crashes = dir => {
    const folder = join(dir, 'Logs', 'Crashes');
    return existsSync(folder) ? readdirSync(folder).length : 0;
};
const hubLog = dir => {
    const file = join(dir, 'Hub', 'hub.log');
    return existsSync(file) ? readFileSync(file, 'utf8') : '';
};

async function closeApp(page, dir) {
    page.socket.close();
    const log = () => hubLog(dir).includes('Hub stopped.');
    return waitFor('clean exit', log, 20000).catch(() => false);
}

function runTool(name, command, args) {
    const result = spawnSync(command, args, { cwd: ROOT, encoding: 'utf8' });
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    const failed = output.split('\n').filter(line => line.startsWith('FAIL')).join(' | ');
    check(name, result.status === 0, failed || output.slice(-300));
}

if (!process.argv.includes('--app-only')) {
    runTool('hub self-test', 'dotnet', ['run', '--project', 'tools/hapshub/hub-selftest', '-c', 'Release']);
    runTool('forwarding guard', 'python', ['-I', 'tools/hapshub/check-forwarding.py']);
}

if (!existsSync(EXE)) {
    check('app is built', false, EXE);
    process.exit(1);
}
const running = spawnSync('tasklist', ['/FI', 'IMAGENAME eq HapsHub.exe', '/NH'], { encoding: 'utf8' }).stdout;
if (running.includes('HapsHub.exe')) {
    check('no other HapsHub is running', false, 'close it first: only one instance can run');
    process.exit(1);
}

const realBefore = realFolderStamp();
const fresh = mkdtempSync(join(tmpdir(), 'hapshub-smoke-'));
const seeded = mkdtempSync(join(tmpdir(), 'hapshub-smoke-'));

try {
    // First launch: a new WebView2 profile and the setup page.
    startApp(fresh);
    const setup = await Page.connect('setup.html');
    await waitFor('setup page', () => setup.eval(`document.readyState === 'complete'`));
    await sleep(3000);
    check('first launch reaches the setup page', true);
    check('first launch has no page errors', setup.errors.length === 0, setup.errors.join(' | '));
    check('first launch has no crash report', crashes(fresh) === 0);
    await setup.eval(`window.external.sendMessage(JSON.stringify({action:'windowClose'}))`);
    check('setup page exits cleanly', await closeApp(setup, fresh));

    // Normal launch: the main page, signed out.
    const version = readFileSync(join(ROOT, 'main', 'AppInfo.cs'), 'utf8').match(/Version = "([^"]+)"/)[1];
    // Marks the changelog as seen, because its modal would cover the page.
    writeSettings(seeded, { SetupComplete: true, MinimizeToTray: false, LastChangelogVersion: version });
    startApp(seeded);
    const main = await Page.connect('index.html');
    // Scripts load in order and replies sent before the message handler registers are lost,
    // so wait for proof that it has handled a message: the first settings payload sets this flag.
    await waitFor('page message handler', () => main.eval(`window.__vrcndbConsentChecked === true && typeof hubModulesRefresh === 'function'`));
    await waitFor('hub modules', () => hubLog(seeded).includes('Hub started.'));
    const log = hubLog(seeded);
    check('hub database is ready', log.includes('Database ready'), log);
    check('forwarding module runs', log.includes('hub.forwarding: Running'), log);
    check('upstream module runs', log.includes('hub.upstream-watch: Running'), log);

    await main.eval(`showTab(9)`); // Tab 9 is Settings.
    const card = await waitFor('update card', () => main.eval(`!!document.getElementById('hubUpstreamList')`));
    check('settings shows the update card', card);
    check('old install wording is gone', !(await main.eval(`document.getElementById('setUpdInstallBtn')?.textContent.includes('Install')`)));

    check('first-run avatar database prompt stays closed', await main.eval(
        `!document.getElementById('vrcndbConsentModal')`));

    await main.eval(`hubModulesRefresh()`);
    await waitFor('module list',() => main.eval(`document.querySelectorAll('.hub-module-row').length === 2`));
    const toggles = `[...document.querySelectorAll('.hub-module-row input[type=checkbox]')]`;
    check('forwarding toggles start off', await main.eval(`${toggles}.length === 2 && ${toggles}.every(i => !i.checked)`));
    await main.eval(`(() => { const i = ${toggles}[0]; i.checked = true; hubSettingChanged(i); })()`);
    await waitFor('saved toggle to come back on', () => main.eval(`${toggles}[0]?.checked === true`));
    await main.eval(`(() => { const i = ${toggles}[0]; i.checked = false; hubSettingChanged(i); })()`);
    await waitFor('saved toggle to come back off', () => main.eval(`${toggles}[0]?.checked === false`));
    check('forwarding toggle saves in both directions', true);

    await main.eval(`hubUpstreamCheck()`);
    await waitFor('update check results', () => main.eval(`document.querySelectorAll('.hub-upstream-row').length === 3`));
    const rows = await main.eval(`JSON.stringify([...document.querySelectorAll('.hub-upstream-row')].map(r => r.innerText.replace(/\\s+/g, ' ').trim()))`);
    console.log(`      ${rows}`);
    check('all three sources report', ['VRCNext', 'VRCX', 'Space Calibrator'].every(name => rows.includes(name)), rows);
    // GitHub allows 60 anonymous requests an hour, so repeated runs can use them up.
    // That is reported as not checked, never as a pass; any other error is a failure.
    if (rows.includes('hourly limit')) console.log('NOT CHECKED  live GitHub results: the hourly limit was reached');
    else check('live GitHub results have no errors', !/couldn't find|didn't answer|answered \d|expected format/.test(rows), rows);

    if (screenshotPath) {
        // The splash screen covers the page for a few seconds after load.
        await sleep(6000);
        await main.eval(`document.getElementById('hubUpstreamList').scrollIntoView({block:'start'})`);
        await sleep(500);
        const shot = await main.send('Page.captureScreenshot', { format: 'png' });
        writeFileSync(screenshotPath, Buffer.from(shot.result.data, 'base64'));
    }

    check('main page has no page errors', main.errors.length === 0, main.errors.join(' | '));
    await main.eval(`sendToCS({action:'windowClose'})`);
    check('main page exits cleanly', await closeApp(main, seeded));
    check('main launch has no crash report', crashes(seeded) === 0);
    check('real data folder is unchanged', realFolderStamp() === realBefore);
} catch (error) {
    check('smoke run finished', false, `${error.message}; page errors: ${Page.last?.errors.join(' | ') || 'none'}`);
    spawnSync('taskkill', ['/IM', 'HapsHub.exe', '/F', '/T']);
} finally {
    await sleep(1500);
    for (const dir of [fresh, seeded]) {
        try { rmSync(dir, { recursive: true, force: true }); } catch { /* A file may still be held; it's in the temp folder. */ }
    }
}

console.log(failures === 0 ? 'Smoke test passed.' : `${failures} smoke check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
