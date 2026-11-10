// Drives the built app through round 6 (docs/hapshub/round6-requirements.md): the Settings clean-up, plugin options
// that fold open, themed controls, launch switches, and the rest as they land.
// Uses a throwaway data folder, no login and no VRChat traffic. Stops only what it started.
//   node tools/hapshub/round6-test.mjs [--release] [--only name]

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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

const dir = freshData('hapshub-round6-');
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
    await cleanUp(dir);
}
console.log(state.failures ? `${state.failures} check(s) failed` : `all ${state.passed} checks passed`);
process.exit(state.failures ? 1 : 0);
