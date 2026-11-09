// Drives the built app through the features added after the first smoke test, using throwaway
// data folders, no login and no VRChat traffic. Stops only the processes it started.
//   node tools/hapshub/features-test.mjs [--release]

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

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

let window_removed = '';
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
    // The splash screen covers the page for a few seconds after load, and the window may still be settling.
    const source = await waitFor('the row to be reachable', () => main.eval(`(() => {
        const row = document.querySelector('#navEditorList .ne-row[data-key="friend-schedule"]');
        row.scrollIntoView({ block: 'center' });
        const box = row.querySelector('.ne-handle').getBoundingClientRect();
        const x = box.x + box.width / 2, y = box.y + box.height / 2;
        const top = document.elementFromPoint(x, y);
        return top?.closest('.ne-handle') ? JSON.stringify({ x, y }) : '';
    })()`), 45000).then(JSON.parse);
    await sleep(300);
    // Like a person would: hold the row at the top of the list until it has scrolled, then drop.
    const listTop = await main.eval(`document.getElementById('navEditorList').getBoundingClientRect().top`);
    await main.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: source.x, y: source.y });
    await main.mouse('mousePressed', source.x, source.y);
    await main.mouse('mouseMoved', source.x, listTop + 10);
    await waitFor('the list to scroll while dragging', () => main.eval(`document.getElementById('navEditorList').scrollTop === 0`), 8000);
    const target = await main.eval(`(() => {
        const box = document.querySelector('#navEditorList .ne-row[data-key="worlds"]').getBoundingClientRect();
        return JSON.stringify({ x: box.x + 30, y: box.y + box.height / 2 + 2 });
    })()`).then(JSON.parse);
    await main.mouse('mouseMoved', target.x, target.y);
    await sleep(300);
    await main.mouse('mouseReleased', target.x, target.y);
    await sleep(400); // The editor settles the row 200 ms after the drop.
    await main.eval(`_edConfirm()`);
    const moved = await main.eval(`(() => {
        const { layout } = navLoadLayout();
        const folder = layout.find(e => e.type === 'folder' && e.id === 'folder-tools');
        return JSON.stringify({ top: layout.some(e => e.type === 'item' && e.key === 'friend-schedule'), inFolder: folder.items.includes('friend-schedule') });
    })()`).then(JSON.parse);
    check('dragging moves a tool from Tools to Overview and it saves', moved.top && !moved.inFolder, JSON.stringify(moved));
    check('the moved tool is in the sidebar', await main.eval(`(() => { const btn = document.querySelector('.nav-btn[data-nav-key="friend-schedule"]'); return !!btn && !btn.closest('.nav-group'); })()`));

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

    // --- History page, on a seeded archive and timeline ---
    fuzzy: {
        main = await openMain(dir);
        const score = (text, query) => main.eval(`hubSearchScore(${JSON.stringify(text)}, ${JSON.stringify(query)})`);
        const cases = [
            ['Mizuki', 'mizuki', 0], ['Ｍｉｚｕｋｉ ♡', 'mizuki', 0], ['𝓜𝓲𝔃𝓾𝓴𝓲', 'mizuki', 0], ['Mіzukі', 'mizuki', 0], ['Mí-zú_ki', 'mizuki', 0],
            ['Mizuki', 'mizuku', 1], ['Mizuki', 'mizkui', 1], ['Mizuki', 'miuki', 1], ['VRChat Pianist', 'painist', 1], ['Cluelss', 'clueless', 1],
            ['Mizuki', 'xyz', -1], ['Mizuki', 'mi', 0], ['Mizuki', 'mx', -1], ['Bob', 'Rob', 1], ['Bob', 'zed', -1], ['Alexander', 'zzzzzz', -1], ['', 'abc', -1], ['abc', '', -1], ['日本語の名前', '日本語', 0],
        ];
        const wrong = [];
        for (const [text, query, expected] of cases) {
            const got = await score(text, query);
            if (got !== expected) wrong.push(`${text} / ${query}: ${got}, expected ${expected}`);
        }
        check('search forgives typos and decorated names, without matching everything', wrong.length === 0, wrong.join('; '));
        await main.eval(`vrcFriendsData = [{ id: 'usr_1', displayName: 'Ｍｉｚｕｋｉ', status: 'active', location: 'offline' }, { id: 'usr_2', displayName: 'Somebody', status: 'active', location: 'offline' }];`);
        check('friend search finds a typo and an ID', await main.eval(`hubFriendMatches(vrcFriendsData[0], 'mizuku') && !hubFriendMatches(vrcFriendsData[1], 'mizuku') && hubFriendMatches(vrcFriendsData[1], 'usr_2')`));
        check('fuzzy search has no page errors', main.errors.length === 0, main.errors.join(' | '));

        // The dashboard layout is upstream's, proved here by using it: remove a widget, save, come back.
        await main.eval(`showTab(0)`);
        await waitFor('dashboard', () => main.eval(`document.querySelectorAll('#dashSectionsContainer .dash-section-wrap').length > 3`));
        const before = JSON.parse(await main.eval(`JSON.stringify(_dashLayout.rows)`));
        window_removed = before[0].filter(Boolean)[0];
        await main.eval(`openDashLayoutEditor(); dashEditRemoveWidget(0, 0); dashEditDone();`);
        const after = JSON.parse(await main.eval(`JSON.stringify(_dashLayout.order)`));
        check('removing a dashboard widget takes it off the page', !after.includes(window_removed) && await main.eval(`document.querySelector('.dash-section-wrap[data-section="${window_removed}"]').hasAttribute('data-hidden')`), JSON.stringify(after));
        await sleep(1500); // Settings save a moment after a change.
        check('app exits cleanly after search', await closeMain(main, dir));
    }

    const today = new Date(); today.setHours(0, 0, 0, 0);
    const at = hours => new Date(today.getTime() + hours * 3600000).toISOString();
    const archive = new DatabaseSync(join(dir, 'Hub', 'vrcx-history.db'));
    archive.exec(`CREATE TABLE IF NOT EXISTS vrcx_rows (source_table TEXT NOT NULL, row_hash BLOB NOT NULL, row_json TEXT NOT NULL, PRIMARY KEY (source_table, row_hash)) WITHOUT ROWID;`);
    const addRow = archive.prepare('INSERT INTO vrcx_rows VALUES (?, ?, ?)');
    let rowNumber = 0;
    const seedRow = (table, row) => addRow.run(table, Buffer.from([++rowNumber]), JSON.stringify(row));
    seedRow('usrtest_friend_log_history', { created_at: at(-24), type: 'DisplayName', user_id: 'usr_a', display_name: 'New <b>name</b>', previous_display_name: 'Old name' });
    seedRow('usrtest_friend_log_history', { created_at: at(-48), type: 'TrustLevel', user_id: 'usr_b', display_name: 'Bee', trust_level: 'Known User', previous_trust_level: 'User' });
    seedRow('usrtest_notifications', { id: 'not_1', created_at: at(-3), type: 'invite', sender_username: 'Dee', sender_user_id: 'usr_d', message: 'come over', world_name: 'A Place' });
    seedRow('gamelog_video_play', { created_at: at(-5), video_url: 'https://example.com/v', video_name: 'A song', display_name: 'Eff', user_id: 'usr_e' });
    seedRow('usrtest_avatar_history', { avatar_id: 'avtr_seed', created_at: at(-6), time: 7200000 });
    archive.close();
    const timeline = new DatabaseSync(join(dir, 'VRCNData.db'));
    const addVisit = timeline.prepare(`INSERT INTO events (id, type, timestamp, world_id, world_name, location, left_at) VALUES (?, 'instance_join', ?, ?, ?, ?, ?)`);
    addVisit.run('visit1', at(1), 'wrld_a', 'First World', 'wrld_a:1', at(3));
    addVisit.run('visit2', at(3), 'wrld_b', 'Second World', 'wrld_b:2', at(4));
    addVisit.run('visit3', at(5), 'wrld_a', 'First World', 'wrld_a:3', null);
    addVisit.run('other_day', at(-20), 'wrld_c', 'Yesterday World', 'wrld_c:1', at(-19));
    timeline.prepare(`INSERT INTO event_players (event_id, user_id, display_name) VALUES ('visit1', 'usr_p', 'P')`).run();
    timeline.close();

    main = await openMain(dir);
    await waitFor('saved dashboard layout', () => main.eval(`typeof _dashLayout !== 'undefined'`));
    check('the dashboard layout survives a restart', !(await main.eval(`_dashLayout.order.includes(${JSON.stringify(window_removed)})`)), window_removed);
    await main.eval(`openDashLayoutEditor(); dashEditReset(); dashEditDone();`);
    check('resetting the dashboard brings it back', await main.eval(`_dashLayout.order.includes(${JSON.stringify(window_removed)})`));

    // --- Hub settings: a text setting saves, and a bad proxy address is reported, not fatal ---
    await main.eval(`showTab(9); hubModulesRefresh();`);
    await waitFor('proxy setting', () => main.eval(`!!document.querySelector('.hub-setting-text[data-module="hub.proxy"]')`));
    await main.eval(`(() => { const input = document.querySelector('.hub-setting-text[data-module="hub.proxy"]'); input.value = 'not a proxy'; hubSettingChanged(input); })()`);
    await waitFor('proxy problem to show', () => main.eval(`document.querySelector('.hub-module-row[data-module="hub.proxy"]').innerText.includes('Proxy address not used')`));
    await main.eval(`(() => { const input = document.querySelector('.hub-setting-text[data-module="hub.proxy"]'); input.value = ''; hubSettingChanged(input); })()`);
    await waitFor('proxy problem to clear', () => main.eval(`!document.querySelector('.hub-module-row[data-module="hub.proxy"]').innerText.includes('Proxy address not used')`));
    check('a bad proxy address is reported and can be cleared', true);
    check('new modules start with their risky options off', await main.eval(`['hub.crash-rejoin', 'hub.photo-metadata'].every(id => [...document.querySelectorAll('.hub-module-row[data-module="' + id + '"] input[type=checkbox]')].every(i => !i.checked))`));

    await main.eval(`showTab(31)`);
    const rowsText = () => main.eval(`document.getElementById('hhistBody')?.innerText || ''`);
    await waitFor('name history rows', async () => (await rowsText()).includes('Old name'));
    let text = await rowsText();
    check('History shows name and trust changes from the archive', text.includes('Known User') && text.includes('Old name'), text);
    check('History shows names as text, never as markup', await main.eval(`document.querySelectorAll('#hhistBody b').length === 0`));
    await main.eval(`hhistShow('notifications')`);
    await waitFor('notification rows', async () => (await rowsText()).includes('come over'));
    await main.eval(`hhistShow('videos')`);
    await waitFor('video rows', async () => (await rowsText()).includes('A song'));
    await main.eval(`hhistShow('avatars')`);
    await waitFor('avatar rows', async () => (await rowsText()).includes('avtr_seed'));
    check('History shows how long an avatar was worn', (await rowsText()).includes('2 h'), await rowsText());
    check('every archive-only list reached the page', true);
    await main.eval(`hhistShow('names'); document.getElementById('hhistSearch').value = 'bee'; hhistSearchChanged();`);
    await waitFor('search to narrow the list', async () => {
        const found = await rowsText();
        return found.includes('Bee') && !found.includes('Old name');
    });
    check('History search narrows the list', true);
    await main.eval(`document.getElementById('hhistSearch').value = 'bee'; hhistSearchChanged();`);

    await main.eval(`hhistShow('instances')`);
    await waitFor('instance chart', () => main.eval(`document.querySelectorAll('.hhist-lane').length > 0`));
    const chart = JSON.parse(await main.eval(`JSON.stringify([...document.querySelectorAll('.hhist-lane')].map(lane => ({
        name: lane.querySelector('.hhist-lane-name').textContent,
        bars: [...lane.querySelectorAll('.hhist-bar')].map(bar => ({ left: parseFloat(bar.style.left), width: parseFloat(bar.style.width), open: bar.classList.contains('hhist-open'), title: bar.title })),
    })))`));
    check('the instance chart has one line per place on that day', chart.length === 2 && chart[0].name === 'First World' && chart[1].name === 'Second World', JSON.stringify(chart));
    const firstBar = chart[0]?.bars[0];
    check('a visit is placed at the right time of day', firstBar && Math.abs(firstBar.left - 100 / 24) < 0.2 && Math.abs(firstBar.width - 200 / 24) < 0.2, JSON.stringify(firstBar));
    check('a visit with no end is marked', chart[0]?.bars[1]?.open === true, JSON.stringify(chart[0]));
    check('a visit shows how many people were seen', firstBar?.title.includes('1 people'), firstBar?.title);
    await main.eval(`hhistDayStep(-1)`);
    await waitFor('previous day', async () => (await main.eval(`document.getElementById('hhistBody').innerText`)).includes('Yesterday World'), 6000)
        .catch(async error => { throw new Error(`${error.message}; day ${await main.eval(`document.getElementById('hhistDay').value`)}; body: ${await main.eval(`document.getElementById('hhistBody').innerText`)}`); });
    check('the chart moves between days', true);
    await main.eval(`hhistDayStep(1)`);

    await main.eval(`hhistShow('purchases')`);
    await waitFor('signed-out purchases message', async () => (await rowsText()).includes('Sign in'));
    await main.eval(`hhistShow('moderation')`);
    await waitFor('signed-out reports message', async () => (await rowsText()).includes('Sign in'));
    check('account lists ask you to sign in instead of failing', true);
    await main.eval(`onHubHistoryAccount({ view: 'moderation', offset: 0, more: false, error: '', items: [{ id: 'r', type: 'user', contentName: '<i>Someone</i>', category: 'behavior', reason: 'abuse', description: 'd', created: '${at(1)}' }] })`);
    check('a moderation report draws safely', (await rowsText()).includes('<i>Someone</i>'), await rowsText());
    await main.eval(`hhistShow('purchases')`);
    await waitFor('purchases message', async () => (await rowsText()).includes('Sign in'));
    await main.eval(`onHubHistoryAccount({ view: 'purchases', offset: 0, more: false, error: '', items: [{ purchaseId: 'p', listingDisplayName: 'A thing', listingType: 'subscription', purchaseDate: '${at(1)}', purchasePrice: 1200, sellerDisplayName: 'Seller', purchaseActive: false }] })`);
    text = await rowsText();
    check('a purchase draws with its price and state', text.includes('A thing') && text.includes('1,200 V') && text.includes('Not active'), text);

    // --- Group tools: signed out, so nothing here can reach VRChat ---
    const banBoxText = () => main.eval(`document.getElementById('gdBanImport')?.innerText || ''`);
    await main.eval(`(() => {
        window._gbiTestPrevious = window._currentGroupDetail;
        window._currentGroupDetail = { id: 'grp_test' };
        const box = document.createElement('div');
        box.innerHTML = _buildBanImport() + '<div id="gdBannedList"></div>';
        box.id = 'gbiTestHost';
        document.body.appendChild(box);
    })()`);
    check('the ban import starts closed', (await banBoxText()).toLowerCase().includes('import bans'), await banBoxText());
    await main.eval(`gbiOpen(); _gbi.text = 'x,usr_11111111-1111-1111-1111-111111111111,usr_11111111-1111-1111-1111-111111111111 usr_22222222-2222-2222-2222-222222222222'; gbiCheck()`);
    await waitFor('the ban preview', async () => (await main.eval(`document.querySelectorAll('.gbi-person').length`)) === 2, 15000);
    check('the ban preview lists each person once', (await banBoxText()).includes('usr_22222222-2222-2222-2222-222222222222'), await banBoxText());
    await main.eval(`gbiConfirm()`);
    check('banning asks for confirmation first', await main.eval(`_gbi.stage === 'preview' && !!document.getElementById('vrcnConfirmDeleteModalOk')`));
    await main.eval(`document.getElementById('vrcnConfirmDeleteModalOk').click()`);
    await waitFor('the signed-out run to stop', () => main.eval(`_gbi.stage === 'done' && _gbi.result?.stopped === 'signed_out'`), 10000);
    check('a run when signed out stops without banning anyone', await main.eval(`_gbi.result.done === 0 && _gbi.result.notTried === 2`));
    await main.eval(`sendToCS({ action: 'hubGroupBanRun', groupId: 'grp_test' }); gbiClose()`);
    await main.eval(`_gbi = { groupId: 'grp_test', stage: 'preview', text: '', preview: { people: [{ id: 'usr_a', name: '<b>Odd</b>' }], alreadyBanned: 2, skippedSelf: true, overLimit: 0 }, progress: null, result: null }; _gbiRender()`);
    text = await banBoxText();
    check('a name in the ban preview draws safely, and what was left out is named', text.includes('<b>Odd</b>') && text.includes('2 already banned'), text);
    await main.eval(`openBlockedGroups()`);
    await waitFor('the signed-out blocked list', async () => (await main.eval(`document.getElementById('blockedGroupsList')?.innerText || ''`)).includes('could not be loaded'));
    check('blocked groups explains itself when signed out', true);
    await main.eval(`onHubBlockedGroups({ ok: true, groups: [{ id: 'grp_a', name: '<i>A group</i>', shortCode: 'AB', discriminator: '1234', memberCount: 3, iconUrl: '' }] })`);
    text = await main.eval(`document.getElementById('blockedGroupsList').innerText`);
    check('a blocked group draws safely with its code', text.includes('<i>A group</i>') && text.includes('AB.1234') && text.includes('Unblock'), text);
    await main.eval(`onHubBlockedGroups({ ok: true, groups: [] })`);
    check('an empty blocked list says so', (await main.eval(`document.getElementById('blockedGroupsList').innerText`)).includes('not blocked'));
    const wideGroupIcons = JSON.parse(await main.eval(`(() => {
        const probe = document.createElement('div');
        probe.innerHTML = ['block', 'gavel', 'upload', 'refresh', 'arrow_back', 'search', 'close'].map(name => '<span class="msi" style="font-size:16px;">' + name + '</span>').join('');
        document.body.appendChild(probe);
        const wide = [...probe.children].filter(icon => icon.getBoundingClientRect().width > 24).map(icon => icon.textContent);
        probe.remove();
        return JSON.stringify(wide);
    })()`));
    check('every group tool icon exists in the icon font', wideGroupIcons.length === 0, wideGroupIcons.join(', '));
    await main.eval(`document.getElementById('blockedGroupsModal')?.remove(); document.getElementById('gbiTestHost')?.remove(); window._currentGroupDetail = window._gbiTestPrevious; gbiClose()`);

    // --- Settings: letter spacing reaches the page and survives being redrawn ---
    await main.eval(`sendToCS({ action: 'hubSetSetting', module: 'hub.ui', key: 'letter_spacing', value: '1.5' })`);
    await waitFor('letter spacing to apply', () => main.eval(`document.body.style.letterSpacing === '1.5px'`));
    await main.eval(`sendToCS({ action: 'hubSetSetting', module: 'hub.ui', key: 'letter_spacing', value: '0' })`);
    await waitFor('letter spacing to clear', () => main.eval(`document.body.style.letterSpacing === ''`));
    check('letter spacing applies and clears', true);
    check('font search and the update item are on the settings page', await main.eval(`typeof hubFontSearch === 'function' && !!document.getElementById('hubUpstreamList')`));

    // --- Every theme: the new pages must stay readable, light themes included ---
    await main.eval(`hhistShow('names')`);
    await waitFor('rows for the theme check', () => main.eval(`document.querySelectorAll('.hhist-row').length > 0`));
    const unreadable = JSON.parse(await main.eval(`(async () => {
        const parse = color => (color.match(/[\\d.]+/g) || []).map(Number);
        const shine = ([r, g, b]) => [r, g, b].map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }).reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
        const contrast = (a, b) => { const [x, y] = [shine(parse(a)), shine(parse(b))].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
        const bad = [];
        const keep = currentTheme;
        const checks = [['.hhist-row', '.hhist-main', 4], ['.hhist-row', '.hhist-at', 2], ['.hhist-row', '.hhist-link', 2.5]];
        for (const name of Object.keys(THEMES)) {
            selectTheme(name);
            await new Promise(done => setTimeout(done, 30));
            for (const [back, text, need] of checks) {
                const under = document.querySelector(back), over = document.querySelector(text);
                if (!under || !over) { bad.push(name + ': missing ' + text); continue; }
                const ratio = contrast(getComputedStyle(under).backgroundColor, getComputedStyle(over).color);
                if (ratio < need) bad.push(name + ' ' + text + ' ' + ratio.toFixed(2));
            }
        }
        selectTheme(keep);
        return JSON.stringify(bad);
    })()`));
    check('the History page is readable in every built-in theme', unreadable.length === 0, unreadable.join('; '));
    // The icon font is a subset: a missing icon shows its name as wide text instead.
    const wideIcons = JSON.parse(await main.eval(`JSON.stringify([...document.querySelectorAll('#hhistViews .msi'), ...document.querySelectorAll('.nav-btn[data-nav-key="history"] .msi')]
        .filter(icon => icon.getBoundingClientRect().width > parseFloat(getComputedStyle(icon).fontSize) * 1.5).map(icon => icon.textContent))`));
    check('every History icon exists in the icon font', wideIcons.length === 0, wideIcons.join(', '));
    if (process.env.HAPSHUB_SHOTS) {
        const shot = async (name, setup) => {
            await main.eval(setup);
            await sleep(700);
            await main.screenshot(join(process.env.HAPSHUB_SHOTS, `${name}.png`));
        };
        await shot('history-dark', `selectTheme('vrcn'); hhistShow('names')`);
        await shot('chart-dark', `hhistShow('instances')`);
        await shot('history-light', `selectTheme('fluffy'); hhistShow('notifications')`);
        await shot('chart-light', `hhistShow('instances')`);
        await main.eval(`selectTheme('vrcn'); hhistShow('names')`);
    }

    // --- A picture HapsHub didn't see being taken: its file fills in the library ---
    const crc = data => { let c = -1; for (const byte of data) { c ^= byte; for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xEDB88320 : c >>> 1; } return (c ^ -1) >>> 0; };
    const pngChunk = (type, data) => {
        const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
        const size = Buffer.alloc(4); size.writeUInt32BE(data.length);
        const tail = Buffer.alloc(4); tail.writeUInt32BE(crc(body));
        return Buffer.concat([size, body, tail]);
    };
    const details = JSON.stringify({ application: 'VRCX', author: { id: 'usr_me', displayName: 'Me' }, world: { name: 'File World', id: 'wrld_file', instanceId: 'wrld_file:1' }, players: [{ id: 'usr_p', displayName: 'Pat' }] });
    const photo = join(dir, 'VRChat_from_the_file.png');
    writeFileSync(photo, Buffer.concat([
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        pngChunk('IHDR', Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0])),
        pngChunk('iTXt', Buffer.concat([Buffer.from('Description'), Buffer.from([0, 0, 0, 0, 0]), Buffer.from(details)])),
        pngChunk('IDAT', Buffer.from([120, 156, 99, 248, 207, 192, 0, 0, 3, 1, 1, 0])),
        pngChunk('IEND', Buffer.alloc(0)),
    ]));
    await main.eval(`sendToCS({ action: 'hubPhotoMetadata', path: ${JSON.stringify(photo)} })`);
    const fromFile = await waitSeen(main, 'hubPhotoMetadata');
    check('a screenshot\'s own details are read', fromFile.found === true && fromFile.worldId === 'wrld_file' && fromFile.players[0]?.userId === 'usr_p', JSON.stringify(fromFile));
    await main.eval(`window.__seen['hubPhotoMetadata'] = null; sendToCS({ action: 'hubPhotoMetadata', path: ${JSON.stringify(photo)} })`);
    const second = await waitSeen(main, 'hubPhotoMetadata');
    check('once read, the library has them', second.found === false, JSON.stringify(second));

    // --- The logo: the new one is in place, and the page tints it ---
    check('the sidebar logo draws', await main.eval(`!!document.querySelector('#logoIcon canvas') && document.getElementById('logoIcon').textContent === ''`));

    await main.eval(`showTab(0); onHubHistoryAccount({ view: 'names' });`);
    check('History page has no page errors', main.errors.length === 0, main.errors.join(' | '));
    check('app exits cleanly after History', await closeMain(main, dir));
    check('no crash report after History', crashes(dir) === 0);
} catch (error) {
    check('feature run finished', false, error.message);
    for (const pid of started) spawnSync('taskkill', ['/PID', String(pid), '/F', '/T']);
} finally {
    await sleep(1500);
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* A file may still be held; it's in the temp folder. */ }
}

console.log(failures === 0 ? 'Feature test passed.' : `${failures} feature check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
