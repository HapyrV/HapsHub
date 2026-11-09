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
// --release tests the Release build, for when the Debug exe is in use by a real session.
const CONFIG = process.argv.includes('--release') ? 'Release' : 'Debug';
const EXE = join(ROOT, 'bin', CONFIG, 'net10.0-windows10.0.19041.0', 'HapsHub.exe');
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

// Only what this run started. A real session may be open, so never stop HapsHub by name.
const started = [];

function startApp(dataDir) {
    const app = spawn(EXE, [], {
        detached: true,
        stdio: 'ignore',
        env: {
            ...process.env,
            HAPSHUB_DATA_DIR: dataDir,
            WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
        },
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
// Test runs use their own folders and locks, so they can sit beside a real session.
// A running session keeps writing to the real folder, so that check can't mean anything then.
const running = spawnSync('tasklist', ['/FI', 'IMAGENAME eq HapsHub.exe', '/NH'], { encoding: 'utf8' }).stdout;
const realSessionOpen = running.includes('HapsHub.exe');

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
    await waitFor('module list',() => main.eval(`document.querySelectorAll('.hub-module-row').length === 6`));
    if (process.env.HAPSHUB_SMOKE_FAIL) throw new Error('failure forced to test the cleanup');
    const toggles = `[...document.querySelectorAll('.hub-module-row[data-module="hub.forwarding"] input[type=checkbox]')]`;
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
    await waitFor('Steam branch panel', () => main.eval(`!!document.querySelector('.hub-steam-branch [data-branch="beta"]')`));
    await waitFor('Steam builds', () => main.eval(`/Beta: \\d+/.test(document.getElementById('hubSteamBranch').innerText)`));
    const steamText = await main.eval(`document.getElementById('hubSteamBranch').innerText.replace(/\\s+/g, ' ')`);
    console.log(`      ${steamText}`);
    check('Steam panel shows the installed branch and beta build', /Installed: \w+, build \d+/.test(steamText) && /Beta: \d+/.test(steamText), steamText);
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

    // The interface changes: toggles reach the dashboard, and the crash card is gone.
    await main.eval(`sendToCS({action:'hubSetSetting',module:'hub.ui',key:'dash_welcome',value:'false'})`);
    await waitFor('welcome message to hide', () => main.eval(`document.getElementById('dashWelcome').style.display === 'none'`));
    await main.eval(`sendToCS({action:'hubSetSetting',module:'hub.ui',key:'dash_welcome',value:'true'})`);
    await waitFor('welcome message to return', () => main.eval(`document.getElementById('dashWelcome').style.display === ''`));
    check('dashboard welcome toggle works both ways', true);
    check('dashboard has a VRChat status stat', await main.eval(`!!document.getElementById('dashStatVrcStatus')`));
    check('crash reporting card is gone', !(await main.eval(`document.getElementById('hubModulesList').closest('.settings-page, body').innerText.includes('Crash Reporting')`)));
    check('avatar database toggles are off while the block is closed', await main.eval(`document.getElementById('setAvtrdbSubmit').disabled && !!document.querySelector('.hub-forwarding-note')`));
    check('font search narrows the list', await main.eval(`(() => { loadSystemFonts(['Arial','Comic Sans MS']); hubFontSearch('comic'); const n = document.getElementById('setCustomFont').options.length; hubFontSearch(''); return n === 2; })()`));
    check('People groups collapse and stay collapsed after a redraw', await main.eval(`(() => {
        const grid = document.getElementById('allFriendsGrid');
        const saved = grid.innerHTML;
        const draw = () => grid.innerHTML = '<div class="fav-group-header"><span class="topbar-title">T</span></div><div class="c">x</div><div class="fav-group-header"><span class="topbar-title">U</span></div><div class="d">y</div>';
        draw(); _hubApplyCollapsed(grid);
        grid.firstChild.click();
        const hidden = grid.querySelector('.c').classList.contains('hub-group-hidden') && !grid.querySelector('.d').classList.contains('hub-group-hidden');
        draw(); _hubApplyCollapsed(grid);
        const kept = grid.querySelector('.c').classList.contains('hub-group-hidden');
        localStorage.removeItem('hapshub.people.collapsed'); grid.innerHTML = saved;
        return hidden && kept;
    })()`));

    // --vrcx reads a temporary copy of the real VRCX database into this run's throwaway folder.
    if (process.argv.includes('--vrcx')) {
        const vrcxFile = join(process.env.APPDATA, 'VRCX', 'VRCX.sqlite3');
        const before = statSync(vrcxFile);
        const archive = async () => {
            await main.eval(`window._hubVrcxLast = null; hubVrcxArchive(false)`);
            await waitFor('VRCX archive', () => main.eval(`window._hubVrcxLast?.stage === 'done'`), 240000);
            return JSON.parse(await main.eval(`JSON.stringify(window._hubVrcxLast)`));
        };
        const first = await archive();
        const totals = report => (report.tables || []).reduce((sum, row) => ({ source: sum.source + row.source, added: sum.added + row.added, total: sum.total + row.total }), { source: 0, added: 0, total: 0 });
        console.log(`      first run: ${JSON.stringify(totals(first))} in ${first.tables?.length} tables; not copied: ${(first.skipped || []).map(row => row.table).join(', ')}`);
        check('VRCX archive accounts for every row', first.complete === true, first.error || '');
        check('VRCX login tables are not archived', !(first.tables || []).some(row => /cookies|configs/.test(row.table)) && (first.skipped || []).some(row => row.table === 'cookies'));
        const second = await archive();
        console.log(`      second run: ${JSON.stringify(totals(second))}`);
        check('repeating the archive adds nothing', second.complete === true && totals(second).added === 0, JSON.stringify(totals(second)));
        const after = statSync(vrcxFile);
        check('VRCX database is untouched', after.mtimeMs === before.mtimeMs && after.size === before.size);
    }

    // Status presets: saved, applied into the status form, and removed.
    const presets = JSON.parse(await main.eval(`JSON.stringify((() => {
        localStorage.removeItem('hubStatusPresets');
        hubStatusPresetAdd('busy', 'Working on it');
        hubStatusPresetAdd('busy', 'Working on it');
        hubStatusPresetAdd('active', 'x'.repeat(50));
        const saved = hubStatusPresets();
        selectedStatus = 'active';
        document.getElementById('statusDescInput').value = '';
        hubStatusPresetApply(0);
        const applied = [selectedStatus, document.getElementById('statusDescInput').value];
        hubStatusPresetRemove(0);
        const left = hubStatusPresets().length;
        localStorage.removeItem('hubStatusPresets');
        return { saved: saved.length, longest: Math.max(...saved.map(p => p.text.length)), applied, left };
    })())`));
    check('status presets: saved once each, and capped at VRChat\'s length', presets.saved === 2 && presets.longest === 32, JSON.stringify(presets));
    check('status presets: applying one fills the form', presets.applied[0] === 'busy' && presets.applied[1] === 'Working on it', JSON.stringify(presets));
    check('status presets: one can be removed', presets.left === 1, JSON.stringify(presets));

    // Your own calendar events: repeats, then saving and deleting through the real backend.
    const repeats = JSON.parse(await main.eval(`JSON.stringify((() => {
        const make = (startsAt, repeat, repeatUntil = '') => ({ startsAt, endsAt: new Date(new Date(startsAt).getTime() + 3600000).toISOString(), repeat, repeatUntil });
        const count = (ev, from, to) => calCustomOccurrences(ev, new Date(from), new Date(to));
        const week = count(make(new Date(2026, 0, 5, 20, 0).toISOString(), 'weekly'), new Date(2026, 0, 1), new Date(2026, 0, 31, 23));
        const month = count(make(new Date(2026, 0, 31, 20, 0).toISOString(), 'monthly'), new Date(2026, 0, 1), new Date(2026, 3, 30, 23));
        const until = count(make(new Date(2026, 0, 1, 20, 0).toISOString(), 'daily', '2026-01-03'), new Date(2026, 0, 1), new Date(2026, 1, 1));
        const once = count(make(new Date(2026, 0, 1, 20, 0).toISOString(), 'none'), new Date(2026, 1, 1), new Date(2026, 2, 1));
        const summer = count(make(new Date(2026, 0, 5, 20, 0).toISOString(), 'weekly'), new Date(2026, 6, 1), new Date(2026, 6, 31));
        return { week: week.length, monthDays: month.map(d => d.getDate()), until: until.length, once: once.length, hours: [...new Set(summer.map(d => d.getHours()))] };
    })())`));
    check('calendar: a weekly event lands every week', repeats.week === 4, JSON.stringify(repeats));
    check('calendar: the 31st falls on the last day of short months', repeats.monthDays.join() === '31,28,31,30', JSON.stringify(repeats));
    check('calendar: repeats stop at the until date', repeats.until === 3, JSON.stringify(repeats));
    check('calendar: one-off events stay out of other months', repeats.once === 0, JSON.stringify(repeats));
    check('calendar: repeats keep local time across clock changes', repeats.hours.join() === '20', JSON.stringify(repeats));
    const calendarAt = new Date(); calendarAt.setHours(12, 0, 0, 0);
    await main.eval(`showTab(17)`);
    await main.eval(`sendToCS({ action: 'hubCalendarSave', title: 'Smoke event', description: '', startsAt: '${calendarAt.toISOString()}', endsAt: '${new Date(calendarAt.getTime() + 3600000).toISOString()}', repeat: 'weekly', repeatUntil: '' })`);
    await waitFor('saved calendar event', () => main.eval(`_calCustom.some(e => e.title === 'Smoke event')`));
    await waitFor('calendar event on the page', () => main.eval(`calendarLoaded && _calEvents.some(e => e._custom && e.title === 'Smoke event')`), 15000).catch(() => null);
    const shown = await main.eval(`calCustomMerge([]).filter(e => e.title === 'Smoke event').length`);
    check('calendar: a saved event shows with its repeats', shown >= 4, String(shown));
    await main.eval(`openEventDetail(CAL_CUSTOM_OWNER, calCustomMerge([]).find(e => e.title === 'Smoke event').id)`);
    check('calendar: clicking an event opens the editor', await main.eval(`document.getElementById('calCustomTitle')?.value === 'Smoke event'`));
    await main.eval(`calCustomDelete()`);
    await waitFor('deleted calendar event', () => main.eval(`!_calCustom.some(e => e.title === 'Smoke event')`));
    check('calendar: an event can be deleted', true);

    // Friend Schedule: the real page and worker, fed synthetic history. A friend online Monday 10:00 to 12:00 UTC for four weeks.
    await main.eval(`showTab(30)`);
    await waitFor('Friend Schedule page', () => main.eval(`!!document.getElementById('fschChart')`));
    // Let the page's own load finish first, or its empty answer would replace the test data.
    await waitFor('Friend Schedule first load', () => main.eval(`typeof _fschResult !== 'undefined' && !!_fschResult`), 60000);
    await main.eval(`(() => {
        document.getElementById('fschTimezone').value = 'UTC';
        document.getElementById('fschScope').value = 'former';
        // The most recent Monday 10:00 UTC at least a day ago, so the weeks stay inside the 30-day range.
        const now = Date.now(), week = 7 * 86400000, dayMs = 86400000;
        let monday = Date.UTC(new Date(now - dayMs).getUTCFullYear(), new Date(now - dayMs).getUTCMonth(), new Date(now - dayMs).getUTCDate(), 10);
        while (new Date(monday).getUTCDay() !== 1 || monday > now - dayMs) monday -= dayMs;
        const rows = [], history = [[new Date(monday - 8 * week).toISOString(), 1, 'usr_a'], [new Date(now - 3600000).toISOString(), 0, 'usr_a']];
        for (let w = -3; w <= 0; w++) {
            rows.push([new Date(monday + w * week).toISOString(), 1, 'usr_a']);
            rows.push([new Date(monday + w * week + 7200000).toISOString(), 0, 'usr_a']);
            // Other traffic through the week, so the time counts as recorded rather than a gap.
            for (let h = 2; h < 168; h += 4) { rows.push([new Date(monday + w * week + h * 3600000).toISOString(), 1, 'usr_b']); rows.push([new Date(monday + w * week + (h + 0.1) * 3600000).toISOString(), 0, 'usr_b']); }
        }
        rows.sort((x, y) => x[0] < y[0] ? -1 : 1);
        window.__fschDone = null;
        const show = _fschShow;
        _fschShow = result => { show(result); window.__fschDone = result; };
        window.__fschRows = { presence: rows, relationships: history, self: [], names: { usr_a: 'Friend A', usr_b: 'Friend B' } };
        onHubSchedule(window.__fschRows);
    })()`);
    await waitFor('schedule analysis', () => main.eval(`!!window.__fschDone`), 60000);
    const schedule = JSON.parse(await main.eval(`(() => {
        const r = window.__fschDone, slots = r.slotsPerDay;
        const at = (day, hour) => r.cells[day * slots + hour * 2];
        const heat = document.querySelectorAll('#fschChart .fsch-cell').length;
        fschSelectCell(1 * slots + 10 * 2);
        fschToggleView();
        const graph = !!document.querySelector('#fschChart svg path');
        fschToggleView();
        return JSON.stringify({ monday: at(1, 10).average, tuesday: at(2, 10).average, heat, expected: slots * 7, graph,
            detail: document.getElementById('fschDetail').innerText, planner: document.getElementById('fschPlanner').innerText });
    })()`));
    console.log(`      schedule: Monday 10:00 average ${schedule.monday}, Tuesday 10:00 ${schedule.tuesday}; ${schedule.planner.split('\n')[0]}`);
    check('Friend Schedule finds the Monday pattern through the worker', schedule.monday > 0.9 && schedule.tuesday < schedule.monday, JSON.stringify(schedule));
    check('Friend Schedule draws every cell, the graph, details and planner', schedule.heat === schedule.expected && schedule.graph && schedule.detail.includes('Friend A') && schedule.planner.length > 0, JSON.stringify(schedule));

    // The leftovers: hours left out, picking friends by hand, and saved results.
    const fschRun = async (what, change) => {
        await main.eval(`window.__fschDone = null; ${change}`);
        await waitFor(what, () => main.eval(`!!window.__fschDone`), 60000);
    };
    await main.eval(`(() => {
        window.__fschPosts = 0;
        const worker = _fschGetWorker(), post = worker.postMessage.bind(worker);
        worker.postMessage = message => { window.__fschPosts++; post(message); };
    })()`);
    await fschRun('hours left out', `document.getElementById('fschExcludeOn').checked = true;
        document.getElementById('fschExcludeFrom').value = 9; document.getElementById('fschExcludeTo').value = 11; fschOptionChanged();`);
    const excluded = JSON.parse(await main.eval(`(() => {
        const r = _fschResult, slots = r.slotsPerDay, at = (day, hour) => r.cells[day * slots + hour * 2];
        return JSON.stringify({ inside: at(1, 10).excluded, outside: at(1, 12).excluded, drawn: document.querySelectorAll('#fschChart .fsch-excluded').length, expected: 4 * 7,
            peakOutside: !r.summary.peakCell || r.summary.peakCell.startMinutes < 540 || r.summary.peakCell.startMinutes >= 660,
            remembered: JSON.parse(localStorage.getItem('fschPrefs')).excludeFrom });
    })()`));
    check('Friend Schedule leaves out the chosen hours', excluded.inside && !excluded.outside && excluded.drawn === excluded.expected && excluded.peakOutside && excluded.remembered === 9, JSON.stringify(excluded));
    await fschRun('hours back', `document.getElementById('fschExcludeOn').checked = false; fschOptionChanged();`);

    await fschRun('nobody chosen', `document.getElementById('fschScope').value = 'selected'; fschOptionChanged();`);
    const pickerOpen = JSON.parse(await main.eval(`JSON.stringify({ shown: document.getElementById('fschPicker').style.display !== 'none', rows: document.querySelectorAll('#fschPickList input').length, status: document.getElementById('fschStatus').textContent })`));
    check('Friend Schedule lists history for picking, and asks when nobody is chosen', pickerOpen.shown && pickerOpen.rows === 2 && pickerOpen.status.length > 0, JSON.stringify(pickerOpen));
    await fschRun('one friend chosen', `(() => {
        const box = [...document.querySelectorAll('#fschPickList input')].find(input => input.dataset.id === 'usr_a');
        box.checked = true; fschTogglePick(box);
    })()`);
    const picked = JSON.parse(await main.eval(`(() => {
        const r = _fschResult, slots = r.slotsPerDay, index = 1 * slots + 10 * 2;
        return JSON.stringify({ count: r.summary.selectedFriends, monday: r.cells[index].average, who: (r.contributorsByCell[index] || []).map(person => person.userId),
            label: document.getElementById('fschPickCount').textContent, remembered: JSON.parse(localStorage.getItem('fschPrefs')).chosen });
    })()`));
    check('Friend Schedule counts only the friend picked by hand', picked.count === 1 && picked.monday > 0.9 && picked.who.length === 1 && picked.who[0] === 'usr_a' && picked.remembered[0] === 'usr_a', JSON.stringify(picked));

    // Back to options analysed earlier: no new work, from memory and then from the disk store.
    const posts = async () => Number(await main.eval(`window.__fschPosts`));
    const before = await posts();
    await fschRun('saved result', `document.getElementById('fschScope').value = 'former'; fschOptionChanged();`);
    const fromMemory = await posts();
    await main.eval(`new Promise(done => setTimeout(done, 500))`);
    await fschRun('saved result from disk', `_fschSaved.clear(); document.getElementById('fschScope').value = 'selected'; fschOptionChanged();`);
    const fromDisk = await posts();
    const savedStatus = await main.eval(`document.getElementById('fschStatus').textContent`);
    check('Friend Schedule reuses saved results without working them out again', before === fromMemory && before === fromDisk && savedStatus.length > 0, `${before} ${fromMemory} ${fromDisk} "${savedStatus}"`);
    await fschRun('more friend-log rows', `window.__fschRows.relationships.push(['2020-01-01T00:00:00.000Z', 1, 'usr_b']); onHubSchedule(window.__fschRows);`);
    check('Friend Schedule works it out again after an import changes friend history', (await posts()) === fromDisk + 1);
    await fschRun('forced refresh', `_fschForce = true; onHubSchedule(window.__fschRows);`);
    check('Friend Schedule refresh ignores saved results', (await posts()) === fromDisk + 2);
    await main.eval(`localStorage.removeItem('fschPrefs')`);

    // All history on a long record: this once overflowed the worker's stack, only with real amounts of data.
    await fschRun('all history on a long record', `(() => {
        const start = Date.now() - 400 * 86400000, rows = [];
        for (let i = 0; i < 150000; i++) rows.push([new Date(start + i * 200000).toISOString(), i % 2 ? 0 : 1, 'usr_a']);
        document.getElementById('fschRange').value = '0';
        document.getElementById('fschScope').value = 'former';
        _fschForce = true;
        onHubSchedule({ presence: rows, relationships: window.__fschRows.relationships, self: [], names: window.__fschRows.names });
    })()`);
    check('Friend Schedule handles all history on a long record', (await main.eval(`_fschResult.summary.selectedFriends`)) === 1 && !(await main.eval(`document.getElementById('fschStatus').style.color`)));

    // Translations reach the page's own text, the drawn chart, and come back again for English.
    const scheduleText = `JSON.stringify({ language: currentLanguage, range: document.querySelector('[data-i18n="hub.schedule.range"]').textContent,
        former: document.querySelector('#fschScope option[value="former"]').textContent, day: document.querySelector('.fsch-day')?.textContent })`;
    await main.eval(`requestTranslation('de')`);
    await waitFor('German text', () => main.eval(`currentLanguage === 'de' && t('hub.schedule.range') === 'Zeitraum'`));
    const german = JSON.parse(await main.eval(scheduleText));
    check('Friend Schedule shows in German', german.range === 'Zeitraum' && german.former === 'Ehemalige Freunde' && german.day === 'So', JSON.stringify(german));
    await main.eval(`requestTranslation('en')`);
    await waitFor('English text', () => main.eval(`currentLanguage === 'en' && t('hub.schedule.range') === 'Range'`));
    const english = JSON.parse(await main.eval(scheduleText));
    check('Friend Schedule comes back to English', english.range === 'Range' && english.former === 'Former friends' && english.day === 'Sun', JSON.stringify(english));

    check('main page has no page errors', main.errors.length === 0, main.errors.join(' | '));
    await main.eval(`sendToCS({action:'windowClose'})`);
    check('main page exits cleanly', await closeApp(main, seeded));
    check('main launch has no crash report', crashes(seeded) === 0);
    if (realSessionOpen) console.log('NOT CHECKED  real data folder is unchanged: a real session is open');
    else check('real data folder is unchanged', realFolderStamp() === realBefore);
} catch (error) {
    check('smoke run finished', false, `${error.message}; page errors: ${Page.last?.errors.join(' | ') || 'none'}`);
    for (const pid of started) spawnSync('taskkill', ['/PID', String(pid), '/F', '/T']);
} finally {
    await sleep(1500);
    for (const dir of [fresh, seeded]) {
        try { rmSync(dir, { recursive: true, force: true }); } catch { /* A file may still be held; it's in the temp folder. */ }
    }
}

console.log(failures === 0 ? 'Smoke test passed.' : `${failures} smoke check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
