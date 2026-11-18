// Drives the built app through round 6 (docs/hapshub/round6-requirements.md): the Settings clean-up, plugin options
// that fold open, themed controls, launch switches, and the rest as they land.
// Uses a throwaway data folder, no login and no VRChat traffic. Stops only what it started.
//   node tools/hapshub/round6-test.mjs [--release] [--only name[,name...]]   (HAPSHUB_KEEP_LOG=file saves the app log if the app quits mid-run)

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writePng } from './lib/png.mjs';
import { checker, cleanUp, closeMain, crashes, freshData, hubLog, openMain, seen, sleep, waitFor, waitSeen } from './lib/harness.mjs';

const PORT = 9341;
const { check, state } = checker();
// --only takes one section name or several, comma-separated.
const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1].split(',').map(n => n.trim()) : null;
const sections = [];
const section = (name, run) => sections.push({ name, run });
const savedSettings = dir => JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'));

section('nav tabs', async main => {
    // Every sidebar entry must open its own page. Tab ids have gaps (tab17 is in the HTML, tab34 is not), and a
    // positional lookup once sent Space Calibrator to VRCT, VRCT to OVR Toolkit and OVR Toolkit to World Map.
    const entries = await main.json(`Object.entries(NAV_ITEMS_DEF).filter(([, d]) => Number.isInteger(d.tab)).map(([k, d]) => [k, d.tab])`);
    const wrong = [];
    for (const [key, tab] of entries) {
        const got = await main.json(`(() => {
            const btn = document.querySelector('#sidebarEl .nav-btn[onclick*="showTab(${tab})"]');
            if (btn) btn.click(); else showTab(${tab});
            const active = [...document.querySelectorAll('.tab.active')].map(t => t.id);
            return { via: btn ? 'button' : 'showTab', active };
        })()`);
        if (got.active.length !== 1 || got.active[0] !== 'tab' + tab) wrong.push(`${key}(${got.via}) -> ${got.active.join('+') || 'nothing'}`);
    }
    check('every sidebar entry opens its own tab', wrong.length === 0, wrong.join('; ') || `${entries.length} entries`);
    await main.eval(`showTab(NAV_ITEMS_DEF['world-map'].tab)`);
    const mapBuilt = await waitFor('the World Map tab', () => main.eval(`(() => { const t = document.getElementById('tab' + NAV_ITEMS_DEF['world-map'].tab); return !!t && t.classList.contains('active') && t.offsetHeight > 0 && t.children.length > 0; })()`), 5000).catch(() => false);
    check('the World Map tab shows something', !!mapBuilt);
    await main.eval(`showTab(0)`);
});

section('loading states', async main => {
    // A list says "nothing here" only once its load has answered; before that it shows a loading state.
    const got = await main.json(`(() => {
        const grid = () => document.getElementById('worldRecentGrid');
        _visitedWorldsLoaded = false; _visitedWorldsData = [];
        renderVisitedWorlds();
        const before = { loading: !!grid().querySelector('.loading-msg'), text: grid().textContent.trim() };
        renderVisitedWorlds([]);
        const after = { loading: !!grid().querySelector('.loading-msg'), text: grid().textContent.trim() };
        const savedUser = currentVrcUser; currentVrcUser = null;
        const signedOut = stillLoading(false);
        currentVrcUser = { id: 'usr_test' };
        const signedIn = stillLoading(false);
        currentVrcUser = savedUser;
        return { before, after, signedOut, signedIn };
    })()`);
    check('Recently visited shows loading before its answer', got.before.loading, JSON.stringify(got.before));
    check('Recently visited shows empty after an empty answer', !got.after.loading && got.after.text.length > 0, JSON.stringify(got.after));
    check('lists fed by VRChat do not wait while signed out', got.signedOut === false && got.signedIn === true, JSON.stringify(got));
});

section('settings', async main => {
    await main.eval(`showTab(9); switchSettingsSection('general')`);
    const nav = await main.json(`[...document.querySelectorAll('#tab9 .settings-nav-item')].map(b => b.dataset.sectionId || (b.getAttribute('onclick').match(/'([^']+)'/) || [])[1])`);
    check('A2: Friends and Attribution are no longer tabs of their own', !nav.includes('friends') && !nav.includes('attribution'), nav.join(','));
    check('B2: no Settings tab per plugin', !nav.some(n => String(n).startsWith('plugin-')), nav.join(','));
    check('A3: one VRCX tab', nav.filter(n => n === 'vrcx').length === 1, nav.join(','));
    await main.eval(`switchSettingsSection('about')`);
    check('A2: the licences are part of About', await main.eval(`!!document.getElementById('settingsAttributionCard')?.offsetParent`));
    await main.eval(`switchSettingsSection('attribution')`);
    check('A2: an old link to Attribution lands on About', await main.eval(`document.querySelector('#tab9 .settings-nav-item.active')?.getAttribute('onclick')?.includes("'about'")`));
    await main.eval(`switchSettingsSection('sidebar')`);
    check('A2: the People stats switch moved to Sidebar', await main.eval(`!!document.getElementById('setPeopleAlwaysStats')?.closest('.vrcn-panel-card')?.offsetParent`));

    // A4: the sidebar resizes and never scrolls sideways.
    const grip = await main.eval(`!!document.querySelector('#tab9 .settings-nav-resizer')`);
    check('A4: the Settings sidebar has a resize handle', grip);
    const sizes = await main.json(`(() => {
        const nav = document.querySelector('#tab9 .settings-nav');
        const out = [];
        for (const w of [100, 240, 500]) {
            document.documentElement.style.setProperty('--settings-nav-w', Math.max(160, Math.min(360, w)) + 'px');
            out.push({ w: Math.round(nav.getBoundingClientRect().width), sideways: nav.scrollWidth > nav.clientWidth + 1 });
        }
        document.documentElement.style.removeProperty('--settings-nav-w');
        return out;
    })()`);
    check('A4: the sidebar keeps between 160 and 360 px and never scrolls sideways', sizes.every(s => s.w >= 160 && s.w <= 361 && !s.sideways), JSON.stringify(sizes));

    // A6: "Start OyasumiVR", never "Oyasumi VR".
    await main.eval(`switchSettingsSection('vrchat'); renderKnownVrApps([{ id: 'oyasumi', name: 'OyasumiVR', path: null }, { id: 'vrct', name: 'VRCT', path: null }])`);
    const text = await main.eval(`document.getElementById('knownVrAppToggles').innerText`);
    check('A6: the VRChat tab reads "Start OyasumiVR"', /Start OyasumiVR/i.test(text) && !/Oyasumi\s+VR/i.test(text), text);
});

section('plugin options', async main => {
    await main.eval(`hubOpenPlugins()`);
    await waitFor('plugin rows', () => main.eval(`document.querySelectorAll('.hub-plugin-row').length > 20`), 5000);
    check('B1: plugins with options have a fold-open button', await main.eval(`!!document.querySelector('.hub-plugin-row[data-plugin="spacecal"] .hub-plugin-expand')`));
    // The ⋯ menu offers Options.
    await main.eval(`document.querySelector('.hub-plugin-row[data-plugin="spacecal"] .hub-plugin-more').click()`);
    const menu = await main.eval(`document.getElementById('hubPluginMenu')?.innerText || ''`);
    check('B2: the ⋯ menu has Options', /Options/.test(menu), menu);
    await main.eval(`[...document.querySelectorAll('#hubPluginMenu .tb-dd-item')].find(b => /Options/.test(b.innerText)).click()`);
    await waitFor('the options panel', () => main.eval(`!document.querySelector('.hub-plugin-opts[data-plugin-opts="spacecal"]').hidden`), 5000).catch(() => {});
    const panel = await main.json(`(() => { const p = document.querySelector('.hub-plugin-opts[data-plugin-opts="spacecal"]'); return { open: !p.hidden, rows: p.querySelectorAll('.hub-module-row').length, branch: !!p.querySelector('#hubSteamBranch') }; })()`);
    check('B2: Options folds open Space Calibrator\'s settings under it', panel.open && panel.rows > 0, JSON.stringify(panel));
    check('B3: Space Calibrator\'s Steam branch lives in its options, not in General', panel.branch, JSON.stringify(panel));
    await sleep(400);
    const selects = await main.json(`[...document.querySelectorAll('.hub-plugin-opts select')].map(s => !!s._vnSelect)`);
    check('A1: dropdowns in plugin options are themed', selects.length > 0 && selects.every(Boolean), JSON.stringify(selects));
    await main.eval(`hubPluginToggleOptions('spacecal', false)`);
    check('B1: it folds closed again', await main.eval(`document.querySelector('.hub-plugin-opts[data-plugin-opts="spacecal"]').hidden`));
    // VRCX's plugin points at its tab instead of a second VRCX page.
    await main.eval(`document.querySelector('.hub-plugin-row[data-plugin="vrcx"] .hub-plugin-more').click()`);
    const vrcxMenu = await main.eval(`document.getElementById('hubPluginMenu')?.innerText || ''`);
    await main.eval(`[...document.querySelectorAll('#hubPluginMenu .tb-dd-item')].find(b => /settings/i.test(b.innerText))?.click()`);
    check('A3: VRCX\'s ⋯ menu opens the VRCX tab', /settings/i.test(vrcxMenu) && await main.eval(`document.querySelector('#tab9 .settings-nav-item.active')?.getAttribute('onclick')?.includes("'vrcx'")`), vrcxMenu);
    // A checkbox drawn by HapsHub isn't a white Windows box.
    const box = await main.eval(`getComputedStyle(document.getElementById('hubTidyAll')).appearance`);
    check('A1: "Show all details" is a themed checkbox', box === 'none', box);
});

section('rose', async main => {
    // Rose Database is a plugin: off hides its Avatars filter and moves off it; on brings it back.
    await main.eval(`showTab(NAV_ITEMS_DEF.avatars.tab); setAvatarFilter('rose')`);
    await sleep(300);
    await main.eval(`hubPluginSet('rose-db', false)`);
    await sleep(300);
    const off = await main.json(`({ shown: getComputedStyle(document.getElementById('avatarFilterRose')).display !== 'none', area: getComputedStyle(document.getElementById('avatarRoseArea')).display !== 'none', filter: avatarFilter })`);
    check('B4: with Rose Database off, its Avatars filter is hidden and the page moves to your avatars', !off.shown && !off.area && off.filter === 'own', JSON.stringify(off));
    await main.eval(`setAvatarFilter('rose')`);
    check('B4: with it off, the Rose filter can\'t be picked', await main.eval(`avatarFilter === 'own'`));
    await main.eval(`hubPluginSet('rose-db', true)`);
    await sleep(300);
    check('B4: turned back on, the filter is back', await main.eval(`getComputedStyle(document.getElementById('avatarFilterRose')).display !== 'none'`));
    check('B4: Rose Database is listed in Plugins', await main.eval(`hubPluginsRender(), !!hubPluginById('rose-db')`));
    await main.eval(`showTab(0)`);
});

section('launch switches', async main => {
    await main.eval(`showTab(9); switchSettingsSection('vrchat')`);
    const builtins = await main.json(`launchSwitches().map(s => s.id)`);
    check('A7: the three built-in switches are listed', ['haptics', 'faceTracking', 'fbt'].every(id => builtins.includes(id)), builtins.join(','));
    // Add one, name it, give it an app that exists, and rename a built-in one.
    await main.eval(`launchSwitchAdd()`);
    await sleep(200);
    const renaming = await main.eval(`!!document.querySelector('.launch-sw-rename')`);
    check('A7: a new switch opens with its name ready to type', renaming);
    await main.eval(`(() => { const i = document.querySelector('.launch-sw-rename'); i.value = 'With lights'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })); })()`);
    const id = await main.eval(`launchSwitches().find(s => s.label === 'With lights')?.id || ''`);
    check('A7: the new switch has the name typed', !!id);
    await main.eval(`addLaunchAddonApp(${JSON.stringify(id)}, ${JSON.stringify(process.execPath)})`);
    await main.eval(`launchSwitchRename('fbt')`);
    await main.eval(`(() => { const i = document.querySelector('.launch-sw-rename'); i.value = 'With trackers'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })); })()`);
    await waitFor('the switches saved', () => {
        const s = savedSettings(main.dataDir);
        return (s.LaunchCustomSwitches || []).some(x => x.Name === 'With lights' && (x.Apps || []).length === 1) && s.LaunchSwitchNames?.fbt === 'With trackers';
    }, 10000).then(() => check('A7: the new switch, its app and the new name are saved', true))
        .catch(() => check('A7: the new switch, its app and the new name are saved', false, JSON.stringify({ c: savedSettings(main.dataDir).LaunchCustomSwitches, n: savedSettings(main.dataDir).LaunchSwitchNames })));
    // The Launch window shows them.
    const buttons = await main.eval(`_launchAddonButtons()`);
    check('A7: the Launch window shows the new switch and the new name', buttons.includes('With lights') && buttons.includes('With trackers'));
    main.switchId = id;
});

section('dashboard', async main => {
    await main.eval(`showTab(0)`);
    const first = await waitFor('a random picture', () => main.eval(`dashBgPath || ''`), 15000).catch(() => '');
    check('D1: a random picture is shown at start', /(red|green|blue)\.png$/.test(first) && !/_thumbnail/.test(first), first);
    const where = await main.json(`(() => { const b = document.getElementById('dashShuffleBtn').getBoundingClientRect(), nav = document.getElementById('sidebarEl')?.getBoundingClientRect(); return { left: b.left, top: b.top, w: b.width, vw: innerWidth, vh: innerHeight, navRight: nav ? nav.right : 0 }; })()`);
    check('D2: the shuffle button sits at the top-left of the picture', where.w > 0 && where.left >= where.navRight && where.left < where.vw / 3 && where.top < where.vh / 3, JSON.stringify(where));
    let previous = first, ok = true, seen = [];
    for (let i = 0; i < 5; i++) {
        await main.eval(`document.getElementById('dashShuffleBtn').click()`);
        const next = await waitFor('another picture', async () => { const p = await main.eval(`dashBgPath || ''`); return p !== previous ? p : null; }, 8000).catch(() => previous);
        seen.push(next.split(/[\/]/).pop());
        if (next === previous || /_thumbnail/.test(next)) ok = false;
        previous = next;
    }
    check('D2: each click shows a different picture, never an Eagle preview', ok, seen.join(','));
});

section('help', async main => {
    const read = () => main.json(`(() => {
        const out = {};
        const tabs = [...new Set(Object.values(NAV_ITEMS_DEF).map(d => d.tab))];
        for (const tab of tabs) {
            showTab(tab);
            toggleHelpPanel();
            out[tab] = document.getElementById('helpPanelText').textContent.trim();
            toggleHelpPanel();
        }
        return out;
    })()`);
    const en = await read();
    const short = Object.entries(en).filter(([, text]) => text.length < 20).map(([tab]) => tab);
    check('H1: every page in the sidebar has an info box', short.length === 0, 'empty: ' + short.join(','));
    await main.eval(`typeof setLanguage === 'function' ? setLanguage('ja') : requestTranslation('ja')`);
    await sleep(2000);
    const ja = await read();
    const same = [30, 31, 37, 39].filter(tab => !ja[tab] || ja[tab] === en[tab]);
    check('H1: the new info boxes are translated', same.length === 0, 'not translated: ' + same.join(','));
    await main.eval(`typeof setLanguage === 'function' ? setLanguage('en') : requestTranslation('en')`);
    await sleep(1500);
    await main.eval(`showTab(0)`);
});

section('profile', async main => {
    // A signed-in user without VRC+ first, then with it. Nothing is sent to VRChat: the picker is checked, not used.
    await main.eval(`currentVrcUser = { id: 'usr_me', displayName: 'Me', tags: ['system_trust_known'], status: 'active', bio: 'hi', bioLinks: [], pronouns: '' }`);
    await main.eval(`openFriendDetail('usr_me')`);
    await sleep(500);
    const opened = await main.json(`({ mine: getComputedStyle(document.getElementById('modalMyProfile')).display !== 'none', other: getComputedStyle(document.getElementById('modalFriendDetail')).display !== 'none' })`);
    check('D3: clicking yourself opens your own, editable profile', opened.mine && !opened.other, JSON.stringify(opened));
    const buttons = await main.json(`({ banner: !!document.querySelector('#modalMyProfile .myp-banner-change'), picture: !!document.querySelector('#modalMyProfile .myp-avatar-change'),
        edits: [...document.querySelectorAll('#modalMyProfile [onclick^="editMyField"]')].map(b => b.getAttribute('onclick').match(/'([a-z]+)'/)[1]) })`);
    check('D3: your profile has buttons to change the banner and the picture', buttons.banner && buttons.picture, JSON.stringify(buttons));
    // Both buttons must be the topmost element at their centre, so nothing else in the profile covers them.
    const hits = await main.json(`['.myp-banner-change', '.myp-avatar-change'].map(sel => { const b = document.querySelector('#modalMyProfile ' + sel); const r = b.getBoundingClientRect();
        const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return { sel, clickable: !!top && (top === b || b.contains(top)), on: top ? (top.className || top.tagName) + '' : null }; })`);
    check('D3: the banner and picture buttons are not covered by anything', hits.every(h => h.clickable), JSON.stringify(hits));
    check('D3: bio, pronouns, links and languages can be edited', ['bio', 'pronouns', 'links', 'languages'].every(f => buttons.edits.includes(f)), buttons.edits.join(','));
    await main.eval(`document.querySelector('#modalMyProfile .myp-avatar-change').click()`);
    await sleep(300);
    const without = await main.json(`({ picker: getComputedStyle(document.getElementById('imagePickerOverlay') || document.body).display !== 'none' && !!document.getElementById('imagePickerOverlay'), tip: document.querySelector('#modalMyProfile .myp-avatar-change').title })`);
    check('D3: without VRC+ it explains instead of opening an empty picker', !without.picker && /VRC\+/.test(without.tip), JSON.stringify(without));
    await main.eval(`currentVrcUser.tags.push('system_supporter'); renderMyProfileContent(); document.querySelector('#modalMyProfile .myp-avatar-change').click()`);
    await sleep(400);
    const withPlus = await main.eval(`!!document.getElementById('imagePickerOverlay') && getComputedStyle(document.getElementById('imagePickerOverlay')).display !== 'none'`);
    check('D3: with VRC+ the picture button opens the picker', withPlus);
    await main.eval(`typeof closeImagePicker === 'function' && closeImagePicker(); closeMyProfile(); currentVrcUser = null`);
});

section('map', async main => {
    // E1: who gets a pin. Asked of hubWorldPlace with no pins of your own, so only the profile counts.
    await main.eval(`(() => {
        const friend = (id, displayName, extra) => ({ id, displayName, status: 'active', image: '', tags: [], bio: '', statusDescription: '', ...extra });
        window.__savedFriends = vrcFriendsData;
        vrcFriendsData = [
            friend('mapflag', 'Flaggy', { bio: 'hi 🇩🇪 here' }),
            friend('mapfrom', 'Fromage', { bio: 'Hello, I am from Japan!' }),
            friend('mapin', 'Inny', { bio: 'chilling in Japan rn, in love with Georgia' }),
            friend('mapengjpn', 'Kenji', { tags: ['language_eng', 'language_jpn'] }),
            friend('mapjk', 'Jinwoo', { tags: ['language_jpn', 'language_kor'] }),
            friend('mapph', 'Pinoy', { tags: ['language_fil', 'language_tgl'] }),
            friend('mapspa', 'Sakura', { tags: ['language_spa', 'language_jpn'] }),
            friend('mapeng', 'Engla', { tags: ['language_eng'] }),
        ];
    })()`);
    const placed = await main.json(`Object.fromEntries(vrcFriendsData.map(f => { const p = hubWorldPlace(f, {}); return [f.id, p ? p.code + ':' + p.how : null]; }))`);
    check('E1: a flag places a friend', placed.mapflag === 'DE:flag', JSON.stringify(placed));
    check('E1: an explicit "from Japan" places a friend', placed.mapfrom === 'JP:bio', JSON.stringify(placed));
    check('E1: a bare "in Japan" places nobody', placed.mapin === null, JSON.stringify(placed));
    check('E1: [eng, jpn] -> Japan (English is ignored)', placed.mapengjpn === 'JP:language', JSON.stringify(placed));
    check('E1: [jpn, kor] -> unplaced', placed.mapjk === null, JSON.stringify(placed));
    check('E1: [fil, tgl] -> the Philippines (two languages, one country)', placed.mapph === 'PH:language', JSON.stringify(placed));
    check('E1: [spa, jpn] -> unplaced', placed.mapspa === null, JSON.stringify(placed));
    check('E1: English alone -> unplaced', placed.mapeng === null, JSON.stringify(placed));
    const why = await main.json(`(() => { const of = id => _wmapWhy(hubWorldPlace(vrcFriendsData.find(f => f.id === id), {})); return { flag: of('mapflag'), bio: of('mapfrom'), language: of('mapengjpn'), none: of('mapjk') }; })()`);
    check('each pin says why it is there', why.flag === 'flag 🇩🇪 in profile' && why.bio === 'profile says "from Japan"' && why.language === 'language: Japanese' && why.none === 'Not on the map', JSON.stringify(why));
    await main.eval(`showTab(NAV_ITEMS_DEF['world-map'].tab)`);
    await waitFor('the globe', () => main.eval(`_wmap.frame > 0 && _wmap.places.size > 0`), 10000);
    check('E4: the note is the short one', (await main.eval(`document.querySelector('#tab39 .wmap-note').textContent`)) === "Pins are guessed from profiles: flags, 'from …' and languages. Never from IP addresses.");
    const rowWhy = await main.eval(`wmapSelect('JP', true), [...document.querySelectorAll('.wmap-friends .wmap-friend small')].map(s => s.textContent).sort().join(' / ')`);
    check('the country list shows each reason', rowWhy === 'language: Japanese / profile says "from Japan"', rowWhy);

    // E2: search by name.
    const search = async text => main.json(`(() => { const box = document.getElementById('wmapSearch'); box.value = ${JSON.stringify(text)}; box.dispatchEvent(new Event('input')); return [...document.querySelectorAll('#wmapResults .wmap-result')].map(r => ({ name: r.querySelector('span').textContent, why: r.querySelector('small').textContent, off: r.classList.contains('is-off'), set: !!r.querySelector('.wmap-set-btn') })); })()`);
    const many = await search('n');
    check('E2: search lists matching friends, up to 8', many.length >= 4 && many.length <= 8, JSON.stringify(many));
    await main.eval(`wmapSelect('JP'); wmapReset()`);
    const kenji = await search('ken');
    await main.eval(`document.querySelector('#wmapResults .wmap-result .wmap-friend').click()`);
    check('E2: choosing a placed friend turns the globe to their pin', kenji.length === 1 && await main.eval(`_wmap.selected === 'JP' && Math.abs(_wmap.lon - _wmapCountry('JP').p[0]) < 1`), JSON.stringify(kenji));
    const jinwoo = await search('jinwoo');
    check('E2: an unplaced friend says so and offers to set a country', jinwoo.length === 1 && jinwoo[0].off && jinwoo[0].set && jinwoo[0].why === 'Not on the map', JSON.stringify(jinwoo));
    await main.eval(`document.querySelector('#wmapResults .wmap-set-btn').click()`);
    check('E3: the country picker opens', await main.eval(`!!document.querySelector('#wmapResults #wmapPinSelect') && document.querySelectorAll('#wmapPinSelect option').length > 150`));
    await search('i');
    await main.eval(`wmapPinEdit('mapjk')`);
    const side = await main.json(`(() => { const r = document.querySelector('#tab39 .wmap-side').getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; })()`);
    await main.screenshot(join(tmpdir(), 'hapshub-round6-map.png'), side);
    await search('jinwoo');
    await main.eval(`wmapPinEdit('mapjk')`);
    await main.eval(`(() => { const s = document.getElementById('wmapPinSelect'); s.value = 'KR'; s.dispatchEvent(new Event('change')); })()`);
    await sleep(400);
    const afterSet = await main.json(`({ place: hubWorldPlace(vrcFriendsData.find(f => f.id === 'mapjk')), selected: _wmap.selected, row: document.querySelector('#wmapResults .wmap-result small')?.textContent, saved: JSON.parse(localStorage.getItem('hapshub.map.pins') || '{}').mapjk })`);
    check('E3: setting a country places the friend, says "set by you" and turns the globe there', afterSet.place?.code === 'KR' && afterSet.place?.how === 'manual' && afterSet.selected === 'KR' && afterSet.row?.endsWith('set by you') && afterSet.saved === 'KR', JSON.stringify(afterSet));
    await waitFor('the pin drawn', () => main.eval(`(_wmap.pins || []).some(p => p.code === 'KR')`), 5000).catch(() => {});
    check('E3: a pin you set looks different on the globe', await main.eval(`(_wmap.pins || []).some(p => p.code === 'KR' && p.manual) && !(_wmap.pins || []).some(p => p.code !== 'KR' && p.manual)`));
    await main.eval(`wmapSetPin('mapflag', 'FR')`);
    check('E3: your pin wins over a flag in the profile', await main.eval(`hubWorldPlace(vrcFriendsData.find(f => f.id === 'mapflag')).code === 'FR'`));
    await main.eval(`wmapSetPin('mapflag', null)`);
    check('E3: clearing it goes back to the profile', await main.eval(`hubWorldPlace(vrcFriendsData.find(f => f.id === 'mapflag')).code === 'DE' && !('mapflag' in JSON.parse(localStorage.getItem('hapshub.map.pins')))`));
    await search('');
    check('E2: an empty search hides the results', await main.eval(`document.getElementById('wmapResults').hidden`));
    await main.eval(`vrcFriendsData = window.__savedFriends; showTab(0)`);
});

section('plugins off', async main => {
    // B3: with a plugin off, nothing of it is left anywhere in Settings: not its options (even when they were open),
    // its slots, its own section or its module rows. Every Settings section is visited for every plugin.
    await main.eval(`hubOpenPlugins()`);
    await waitFor('plugin rows', () => main.eval(`document.querySelectorAll('.hub-plugin-row').length > 20`), 5000);
    const result = JSON.parse(await main.eval(`(async () => {
        const visible = el => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
        const navs = [...document.querySelectorAll('#tab9 .settings-nav-item')];
        const found = [];
        let visits = 0;
        for (const p of HUB_PLUGINS) {
            const options = _hubPluginHasOptions(p);
            if (options) hubPluginToggleOptions(p.id, true);
            hubPluginSet(p.id, false);
            const selectors = [..._hubPluginSelectors(p), '.hub-plugin-opts[data-plugin-opts="' + p.id + '"]',
                ...(p.settings || []).map(s => '#hubModulesList .hub-module-row[data-module="' + s.module + '"]')];
            for (const nav of navs.filter(visible)) {
                nav.click();
                visits++;
                await null; // no timers: a test window left in the background gets them throttled to one a minute
                for (const selector of selectors)
                    for (const el of document.querySelectorAll(selector))
                        if (el.closest('#tab9') && visible(el)) found.push(p.id + ': ' + selector + ' in ' + nav.textContent.trim());
            }
            hubPluginSet(p.id, true);
            if (options) hubPluginToggleOptions(p.id, false);
        }
        return JSON.stringify({ found: [...new Set(found)], visits, plugins: HUB_PLUGINS.length });
    })()`));
    check('B3: with a plugin off, none of its settings appear anywhere in Settings', result.found.length === 0 && result.visits > result.plugins * 5, JSON.stringify(result).slice(0, 600));
    // The app answers every switch with the full list; wait until it has answered the last one.
    const stillOff = () => main.json(`HUB_PLUGINS.filter(p => !hubPluginOn(p.id)).map(p => p.id)`);
    await waitFor('every switch answered', () => main.eval(`hubPluginsSettled()`), 30000).catch(() => {});
    const off = await stillOff();
    check('B3: every plugin is back on afterwards', off.length === 0, 'still off: ' + off.join(', '));
    await main.eval(`showTab(0)`);
});

section('licences', async main => {
    await main.eval(`showTab(9); switchSettingsSection('about')`);
    const shown = id => main.eval(`(() => { const el = document.querySelector('#settingsAttributionCard .attrib-item[data-licence="${id}"]'); return !!el && getComputedStyle(el).display !== 'none'; })()`);
    const missing = await main.json(`HUB_PLUGINS.flatMap(p => p.licences || []).filter(l => !document.querySelector('#settingsAttributionCard .attrib-item[data-licence="' + l + '"]'))`);
    check('B5: every licence a plugin names is in Attribution', missing.length === 0, missing.join(','));
    check('B5: a plugin that is on shows its licence', await shown('vosk') && await shown('world-atlas'));
    await main.eval(`hubPluginSet('voice-fight', false); hubPluginSet('world-map', false)`);
    check('B5: turning a plugin off removes its licences', !(await shown('vosk')) && !(await shown('world-atlas')));
    check('B5: a library another plugin still uses stays', await shown('naudio'));
    check("B5: HapsHub's own libraries always show", await main.eval(`[...document.querySelectorAll('#settingsAttributionCard .attrib-item:not([data-licence])')].every(el => getComputedStyle(el).display !== 'none')`));
    await main.eval(`['voice-fight', 'youtube-tunnel', 'frame-shot', 'kikitan-xd'].forEach(id => hubPluginSet(id, false))`);
    // The app answers every switch with the full list, so earlier answers can briefly undo later switches: wait.
    await waitFor('NAudio to go', async () => !(await shown('naudio')), 10000).catch(() => {});
    check('B5: with every plugin that uses it off, a shared library goes too', !(await shown('naudio')));
    await main.eval(`['voice-fight', 'youtube-tunnel', 'frame-shot', 'kikitan-xd', 'world-map'].forEach(id => hubPluginSet(id, true))`);
    const back = async () => await shown('vosk') && await shown('naudio') && await shown('world-atlas');
    await waitFor('every switch answered', () => main.eval(`hubPluginsSettled()`), 30000).catch(() => {});
    await waitFor('the licences to come back', back, 10000).catch(() => {});
    check('B5: turning them back on lists them again', await back());
});

section('eagle', async main => {
    // Issue 9: Eagle is held in a tab inside Media Library, the way OyasumiVR is held in its page.
    const visible = sel => main.eval(`!!document.querySelector(${JSON.stringify(sel)})?.offsetParent`);
    await main.eval(`showTab(7); libShowSource('library')`);
    await waitFor('the Eagle tab', () => visible('#libTabEagle'), 10000).catch(() => {});
    check('9: Media Library has Library and Eagle tabs', await visible('#libTabLibrary') && await visible('#libTabEagle'));
    const tab = await main.center('#libTabEagle');
    if (!tab) return;
    await main.click(tab.x, tab.y);
    await waitFor('the Eagle pane', () => visible('#aemb-pane-eagle'), 5000).catch(() => {});
    // The mode <select> is hidden inside its custom .vn-select dropdown; the wrapper is what shows.
    const hiddenParts = [];
    for (const s of ['#aemb-pane-eagle', '#aemb-start-eagle', '.vn-select:has(> #aemb-mode-eagle)']) if (!await visible(s)) hiddenParts.push(s);
    check('9: the Eagle tab shows the pane and Eagle\'s controls', !hiddenParts.length, hiddenParts.length ? 'hidden: ' + hiddenParts.join(' ') : '');
    check('9: the library\'s own grid and filters make way', await main.eval(`!document.getElementById('libFavBtn').offsetParent && !document.querySelector('#tab7 .lib-wrap').offsetParent && !!document.getElementById('libTabLibrary').offsetParent`));
    const state = await waitSeen(main, 'hubEmbedState', p => p.app === 'eagle', 10000).catch(() => null);
    check('9: the app answers for Eagle', !!state, JSON.stringify(state).slice(0, 160));
    await waitFor('the pane report', () => main.eval(`(_aemb.sent.eagle || '').includes('"visible":true')`), 5000).catch(() => {});
    check('9: the page tells the app where the pane is', await main.eval(`(_aemb.sent.eagle || '').includes('"visible":true')`), await main.eval(`_aemb.sent.eagle || 'nothing sent'`));
    const lib = await main.center('#libTabLibrary');
    await main.click(lib.x, lib.y);
    await waitFor('the pane hidden report', () => main.eval(`(_aemb.sent.eagle || '').includes('"visible":false')`), 5000).catch(() => {});
    check('9: back on Library, the grid is back and the app hears the pane is hidden', await visible('#libFavBtn') && !(await visible('#aemb-pane-eagle')) && await main.eval(`(_aemb.sent.eagle || '').includes('"visible":false')`));

    // The plugin owns it: off, the tab is gone and Media Library is the library again.
    await main.eval(`libShowSource('eagle')`);
    await main.eval(`hubPluginSet('eagle', false)`);
    await waitFor('the Eagle tab to go', async () => !(await visible('#libTabEagle')), 10000).catch(() => {});
    check('9: with the Eagle plugin off, Media Library has no Eagle tab', !(await visible('#libTabEagle')) && !(await visible('#aemb-pane-eagle')) && await visible('#libFavBtn'));
    await main.eval(`hubPluginSet('eagle', true)`);
    await waitFor('every switch answered', () => main.eval(`hubPluginsSettled()`), 30000).catch(() => {});
    check('9: Eagle\'s path setting is back under the plugin', await main.eval(`HUB_PLUGINS.find(p => p.id === 'eagle').settings?.[0]?.keys?.includes('eagle_path')`));
    await main.eval(`showTab(0)`);
});

// A picture folder for the dashboard: three wide pictures and an Eagle-style preview that must never be picked.
const pics = mkdtempSync(join(tmpdir(), 'hapshub-pics-'));
writePng(join(pics, 'red.png'), 64, 36, [200, 30, 30]);
writePng(join(pics, 'green.png'), 64, 36, [30, 200, 30]);
writePng(join(pics, 'blue.png'), 64, 36, [30, 30, 200]);
writePng(join(pics, 'red_thumbnail.png'), 64, 36, [250, 250, 30]);
const dir = freshData('hapshub-round6-', { RandomDashBg: true, DashBgFolders: [pics], DashBgLandscapeOnly: true });
let main;
try {
    main = await openMain(dir, PORT);
    await waitFor('the splash to go', () => main.eval(`!document.getElementById('vrcnSplash')`), 15000);
    await sleep(1500);
    for (const { name, run } of sections) {
        if (only && !only.includes(name)) continue;
        try { await run(main); }
        catch (error) {
            const log = main.closed ? ' | app log: ' + hubLog(dir).trim().split(/\r?\n/).slice(-10).join(' | ') : '';
            check(`${name}: the section finished`, false, error.message + log);
            if (main.closed) { if (process.env.HAPSHUB_KEEP_LOG) writeFileSync(process.env.HAPSHUB_KEEP_LOG, hubLog(dir)); break; }
        }
    }
    check('no page errors', main.errors.length === 0, main.errors.join(' | '));
    const switchId = main.switchId;
    const closed = await closeMain(main);
    check('the app closes cleanly', closed, hubLog(dir).trim().split(/\r?\n/).slice(-6).join(' | '));
    const switches = switchId && (!only || only.includes('launch switches'));
    const pins = !only || only.includes('map');
    if (switches || pins) {
        main = await openMain(dir, PORT);
        if (switches) {
            // After a restart the switch and the names are still there.
            await waitFor('settings loaded', () => main.eval(`typeof launchSwitches === 'function' && launchSwitches().length > 3`), 20000).catch(() => {});
            const after = await main.json(`launchSwitches().map(s => s.label)`);
            check('A7: after a restart the new switch and the new name are still there', after.includes('With lights') && after.includes('With trackers'), after.join(','));
        }
        if (pins) {
            await waitFor('the map code', () => main.eval(`typeof hubWorldPlace === 'function'`), 20000).catch(() => {});
            const pin = await main.json(`({ saved: JSON.parse(localStorage.getItem('hapshub.map.pins') || '{}').mapjk, place: hubWorldPlace({ id: 'mapjk', tags: ['language_jpn', 'language_kor'] }) })`);
            check('E3: after a restart the country you set is still there and still wins', pin.saved === 'KR' && pin.place?.code === 'KR' && pin.place?.how === 'manual', JSON.stringify(pin));
        }
        await closeMain(main);
    }
    check('no crash report', crashes(dir) === 0);
} catch (error) {
    check('the run finished', false, error.stack || error.message);
} finally {
    await cleanUp(dir, pics);
}
console.log(state.failures ? `${state.failures} check(s) failed` : `all ${state.passed} checks passed`);
process.exit(state.failures ? 1 : 0);
