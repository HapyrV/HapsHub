// Drives the built app through round 6 (docs/hapshub/round6-requirements.md): the Settings clean-up, plugin options
// that fold open, themed controls, launch switches, and the rest as they land.
// Uses a throwaway data folder, no login and no VRChat traffic. Stops only what it started.
//   node tools/hapshub/round6-test.mjs [--release] [--only name]

import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writePng } from './lib/png.mjs';
import { checker, cleanUp, closeMain, crashes, freshData, hubLog, openMain, sleep, waitFor } from './lib/harness.mjs';

const PORT = 9341;
const { check, state } = checker();
const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;
const sections = [];
const section = (name, run) => sections.push({ name, run });
const savedSettings = dir => JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'));

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
        if (only && only !== name) continue;
        try { await run(main); }
        catch (error) { check(`${name}: the section finished`, false, error.message); }
    }
    check('no page errors', main.errors.length === 0, main.errors.join(' | '));
    const switchId = main.switchId;
    const closed = await closeMain(main);
    check('the app closes cleanly', closed, hubLog(dir).trim().split(/\r?\n/).slice(-6).join(' | '));
    if (switchId && (!only || only === 'launch switches')) {
        // After a restart the switch and the names are still there.
        main = await openMain(dir, PORT);
        await waitFor('settings loaded', () => main.eval(`typeof launchSwitches === 'function' && launchSwitches().length > 3`), 20000).catch(() => {});
        const after = await main.json(`launchSwitches().map(s => s.label)`);
        check('A7: after a restart the new switch and the new name are still there', after.includes('With lights') && after.includes('With trackers'), after.join(','));
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
