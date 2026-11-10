// Drives the built app through the features added in the plugins round: the credit to VRCNext, the app's own
// name, plugins, performance mode, the tidier settings and editing the sidebar in place.
// Uses a throwaway data folder, no login and no VRChat traffic. Stops only what it started.
//   node tools/hapshub/round5-test.mjs [--release] [--only name]

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Page, checker, cleanUp, closeMain, crashes, freshData, hubLog, killTree, openMain, sleep, startApp, waitFor } from './lib/harness.mjs';

const PORT = 9340;
const { check, state } = checker();
const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;
const sections = [];
const section = (name, run) => sections.push({ name, run });

// Keeps what the page sends to the app, and stops it opening real web pages.
const spySends = main => main.eval(`(() => {
    if (window.__sent) return;
    window.__sent = [];
    const send = sendToCS;
    sendToCS = message => { window.__sent.push(message); if (message.action !== 'openUrl') send(message); };
})()`);
const sent = (main, action) => main.json(`window.__sent.filter(m => m.action === ${JSON.stringify(action)})`);
const setting = (main, module, key) => main.json(`(_hubUiSettings || []).find(m => m.id === ${JSON.stringify(module)})?.settings?.find(s => s.key === ${JSON.stringify(key)})?.value ?? null`);
const visible = (main, selector) => main.eval(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden'; })()`);

section('credit', async main => {
    check('the top bar credits VRCNext', await visible(main, '#tbCredit') && /VRCNext/.test(await main.eval(`document.getElementById('tbCredit').innerText`)));
    const fits = await main.json(`(() => { const p = document.getElementById('tbCredit').getBoundingClientRect(), d = document.getElementById('tb-drag').getBoundingClientRect(); return { inside: p.left >= d.left - 1 && p.right <= d.right + 1, top: p.top, bottom: p.bottom, barHeight: document.getElementById('taskbar').getBoundingClientRect().height }; })()`);
    check('the credit sits inside the top bar', fits.inside && fits.top >= 0 && fits.bottom <= fits.barHeight, JSON.stringify(fits));

    const usual = await main.json(`({ lead: getComputedStyle(document.querySelector('.tb-credit-lead')).display !== 'none', window: innerWidth, pill: document.getElementById('tbCredit').getBoundingClientRect().width, bar: document.getElementById('tb-drag').getBoundingClientRect().width })`);
    check('at the usual window size the credit reads "Heavily based on VRCNext"', usual.lead && usual.pill <= usual.bar, JSON.stringify(usual));

    const at = await main.center('#tbCredit');
    await main.click(at.x, at.y);
    await waitFor('the credit panel', () => visible(main, '#creditPanel'), 5000);
    const title = await main.eval(`document.getElementById('creditPanelTitle').textContent`);
    check('clicking it opens a panel that names the app and VRCNext', title.includes('HapsHub') && title.includes('VRCNext'), title);
    const panel = await main.json(`(() => { const r = document.getElementById('creditPanel').getBoundingClientRect(); return { left: r.left, right: r.right, width: innerWidth }; })()`);
    check('the panel stays inside the window', panel.left >= 0 && panel.right <= panel.width, JSON.stringify(panel));
    await main.eval(`document.querySelector('#creditPanel .vrcn-btn-primary').click()`);
    await main.eval(`document.querySelectorAll('#creditPanel .credit-panel-buttons button')[1].click()`);
    const urls = (await sent(main, 'openUrl')).map(m => m.url);
    check('its buttons lead to VRCNext on GitHub and Patreon', urls.length === 2 && urls[0] === 'https://github.com/shinyflvre/VRCNext' && urls[1].includes('patreon.com'), urls.join(' '));
    await main.click(panel.width / 2, 400);
    await waitFor('the panel to close', async () => !(await visible(main, '#creditPanel')), 5000);
    check('a click elsewhere closes the panel', true);

    // The credit gives up words as the bar narrows, never itself.
    const widths = {};
    for (const width of [500, 300, 150, 90]) {
        await main.eval(`document.getElementById('tb-drag').style.cssText = 'flex:none;width:${width}px'`);
        await sleep(120);
        widths[width] = await main.json(`(() => { const p = document.getElementById('tbCredit'); const shown = s => { const e = p.querySelector(s); return !!e && getComputedStyle(e).display !== 'none'; }; return { pill: p.getBoundingClientRect().width > 0, more: shown('.tb-credit-more'), lead: shown('.tb-credit-lead'), text: shown('.tb-credit-text') }; })()`);
    }
    await main.eval(`document.getElementById('tb-drag').style.cssText = ''`);
    check('the credit shortens as the bar narrows but never disappears',
        widths[500].more && widths[500].lead && !widths[300].more && widths[300].lead && !widths[150].lead && widths[150].text && !widths[90].text
        && Object.values(widths).every(w => w.pill), JSON.stringify(widths));
});

section('name', async main => {
    await main.eval(`showTab(9); switchSettingsSection('appearance', document.querySelector('.settings-nav-item[onclick*="appearance"]'))`);
    await waitFor('the name box', () => visible(main, '#hubAppNameInput'));
    check('the name box starts empty, showing the original name as a hint', await main.eval(`document.getElementById('hubAppNameInput').value === '' && document.getElementById('hubAppNameInput').placeholder === 'HapsHub'`));

    await main.eval(`(() => { const i = document.getElementById('hubAppNameInput'); i.value = '  Moon Base  '; i.dispatchEvent(new Event('change')); })()`);
    await waitFor('the new name in the top bar', () => main.eval(`document.querySelector('.tb-brand').textContent === 'Moon Base'`), 8000);
    const named = await main.json(`({ top: document.querySelector('.tb-brand').textContent, side: document.querySelector('.logo-text').textContent, title: document.title, tooltip: document.getElementById('tbCredit').title, text: t('hub.credit.tooltip', ''), credit: document.getElementById('tbCredit').innerText })`);
    check('a new name shows in the top bar, the sidebar and the window title', named.top === 'Moon Base' && named.side === 'Moon Base' && named.title === 'Moon Base', JSON.stringify(named));
    check('text written for HapsHub uses the new name', named.text.startsWith('Moon Base ') && !named.text.includes('HapsHub'), named.text);
    check('the credit to VRCNext stays after a rename', named.credit.includes('VRCNext') && named.tooltip.includes('VRCNext'), JSON.stringify(named));
    check('the name is saved without the spaces around it', await setting(main, 'hub.ui', 'app_name') === 'Moon Base');

    const long = 'x'.repeat(60);
    await main.eval(`hubBrandSave(${JSON.stringify(long)})`);
    await waitFor('the long name', () => main.eval(`document.querySelector('.tb-brand').textContent.length === 40`), 8000);
    const clipped = await main.json(`(() => { const b = document.querySelector('.tb-brand').getBoundingClientRect(), m = document.getElementById('tbMenuApp').getBoundingClientRect(); return { brand: b.width, menuLeft: m.left, brandRight: b.right }; })()`);
    check('a very long name is cut to 40 characters and doesn\'t cover the menus', clipped.brand <= 241 && clipped.menuLeft >= clipped.brandRight - 1, JSON.stringify(clipped));

    await main.eval(`hubBrandSave('<img src=x onerror=window.__pwned=1>')`);
    await waitFor('the odd name', () => main.eval(`document.querySelector('.tb-brand').textContent.startsWith('<img')`), 8000);
    check('a name with markup in it is shown as plain text', await main.eval(`!window.__pwned && !document.querySelector('.tb-brand img, .logo-text img')`));

    await main.eval(`hubBrandReset()`);
    await waitFor('the original name', () => main.eval(`document.querySelector('.tb-brand').textContent === 'HapsHub' && document.title === 'HapsHub'`), 8000);
    check('the original name comes back', await setting(main, 'hub.ui', 'app_name') === '' && await main.eval(`document.getElementById('hubAppNameInput').value === ''`));
});

section('performance', async main => {
    const cls = () => main.json(`[...document.documentElement.classList]`);
    await main.eval(`showTab(9); switchSettingsSection('performance', document.querySelector('.settings-nav-item[onclick*="performance"]'))`);
    await waitFor('the Performance mode card', () => visible(main, '#hubPerfCard'));
    const system = await main.eval(`document.getElementById('hubPerfSystem').textContent`);
    check('the card says what kind of PC this is', /\d+ threads/.test(system), system);
    check('Performance mode starts off on a fast PC, with its options greyed out', await main.eval(`!document.getElementById('hubPerfMode').checked && document.querySelectorAll('#hubPerfCuts input[disabled]').length === 5`));
    const blurBefore = (await cls()).includes('no-blur');
    await main.eval(`(() => { const i = document.getElementById('hubPerfMode'); i.checked = true; i.dispatchEvent(new Event('change')); })()`);
    await waitFor('the mode to apply', async () => (await cls()).includes('hub-perf'), 8000);
    const on = await cls();
    check('turning it on cuts blur, animations, pictures, the fade and polling', ['no-blur', 'no-animations', 'hub-perf-pictures', 'hub-perf-glass', 'hub-perf-polling'].every(c => on.includes(c)), on.join(' '));
    await main.eval(`(() => { const i = document.querySelector('#hubPerfCuts input[data-cut="blur"]'); i.checked = false; i.dispatchEvent(new Event('change')); })()`);
    await waitFor('blur to come back', async () => !(await cls()).includes('no-blur'), 8000);
    check('one effect can be kept while the mode is on', (await cls()).includes('no-animations'));
    await main.eval(`hubPerfSet('cut_blur', true); hubPerfSet('mode', false)`);
    await waitFor('the mode to go off', async () => !(await cls()).includes('hub-perf'), 8000);
    const off = await cls();
    check('turning it off brings back what the Blur and Animations switches say', off.includes('no-blur') === blurBefore && !off.includes('no-animations') && !off.includes('hub-perf-glass'), off.join(' '));
});

section('plugins', async main => {
    await main.eval(`window.__pluginReplies = []; const before = onHubPlugins; onHubPlugins = p => { window.__pluginReplies.push(p); before(p); };`);
    await main.eval(`hubOpenPlugins()`);
    await waitFor('the plugin list', () => visible(main, '#hubPluginsCard'));
    const rows = await main.eval(`document.querySelectorAll('#hubPluginList .hub-plugin-row').length`);
    const total = await main.eval(`HUB_PLUGINS.length`);
    check('Settings > Plugins lists every plugin, all on', rows === total && await main.eval(`[...document.querySelectorAll('#hubPluginList input[type=checkbox]')].every(i => i.checked)`), `${rows} of ${total}`);
    check('each row says who made it', await main.eval(`/v1\\.0\\.0 by (HapsHub|VRCNext)/.test(document.querySelector('.hub-plugin-meta').textContent)`));

    await main.eval(`document.getElementById('hubPluginSearch').value = 'eagle'; hubPluginsSearch('eagle')`);
    check('searching narrows the list', await main.eval(`document.querySelectorAll('#hubPluginList .hub-plugin-row').length === 1`));
    await main.eval(`document.getElementById('hubPluginSearch').value = ''; hubPluginsSearch('')`);

    const navShown = key => main.eval(`(() => { const b = document.querySelector('#navEl [data-nav-key="${key}"]'); return !!b && getComputedStyle(b).display !== 'none'; })()`);
    const eagleTab = await main.eval(`NAV_ITEMS_DEF.eagle.tab`);
    await main.eval(`document.querySelector('#hubPluginList [data-plugin="eagle"] input').click()`);
    await waitFor('the hub to save Eagle off', () => main.eval(`window.__pluginReplies.some(p => p.states.eagle === false)`), 10000);
    check('turning a plugin off removes its page from the sidebar', !(await main.eval(`!!document.querySelector('#navEl .nav-btn[data-nav-key="eagle"]')`)) && !(await navShown('eagle')));
    await main.eval(`showTab(${eagleTab})`);
    check('its page can\'t be opened while it\'s off', await main.eval(`document.getElementById('tab0').classList.contains('active') && !document.getElementById('tab${eagleTab}').classList.contains('active')`));

    await main.eval(`hubPluginSet('space-flight', false)`);
    await sleep(300);
    check('a VRCNext tool that\'s off loses its top bar button and its auto-start', await main.eval(`getComputedStyle(document.getElementById('badgeSpace')).display === 'none' && hubPluginBlocks('setSfAutoStartVR') && !hubPluginBlocks('setStAutoStartVR')`));

    await main.eval(`hubPluginSet('history', false)`);
    await waitFor('the History module to stop', async () => (await main.json(`(_hubUiSettings || []).find(m => m.id === 'hub.history')?.status`)) === 'Disabled', 15000).catch(() => {});
    check('a plugin that\'s off stops its background module', await main.json(`(_hubUiSettings || []).find(m => m.id === 'hub.history')?.status`) === 'Disabled');

    const options = await main.eval(`hubOpenPlugins(); [...document.querySelectorAll('#hubPluginNavItems .settings-nav-item')].map(b => b.dataset.sectionId).join(',')`);
    check('plugins with options get a settings entry, and ones that are off don\'t', options.includes('plugin-youtube-tunnel') && !options.includes('plugin-eagle') && !options.includes('plugin-history'), options);
    await main.eval(`hubPluginOptions('youtube-tunnel')`);
    await waitFor('the plugin options', () => visible(main, '[data-section="plugin-youtube-tunnel"]'), 5000);
    check('a plugin\'s options page shows its settings', await main.eval(`!!document.querySelector('[data-section="plugin-youtube-tunnel"] .hub-module-row')`));
    check('module settings are no longer repeated under Hub modules', await main.eval(`(() => { const r = document.querySelector('#hubModulesList .hub-module-row[data-module="hub.youtube-tunnel"]'); return !r || getComputedStyle(r).display === 'none'; })()`));

    await main.eval(`hubOpenPlugins()`);
    const more = await main.center('#hubPluginList [data-plugin="youtube-tunnel"] .hub-plugin-more');
    await main.click(more.x, more.y);
    const menu = await main.eval(`document.getElementById('hubPluginMenu')?.innerText || ''`);
    check('the ⋮ menu offers its page, its options and turning it off', /page/i.test(menu) && /Options/.test(menu) && /Turn off/.test(menu), menu);
    // Clicking elsewhere closes it. Not near the window edge: a press there starts resizing the real window.
    const away = await main.center('#hubPluginsCard .vrcn-panel-card-header');
    await sleep(200);
    await main.click(away.x, away.y);
    await sleep(200);
    check('a click elsewhere closes the menu', await main.eval(`!document.getElementById('hubPluginMenu')`));

    await main.eval(`hubPluginsAll(true)`);
    await waitFor('everything back on', () => main.eval(`window.__pluginReplies.some(p => Object.values(p.states).every(Boolean))`), 15000);
    check('turning all on brings every page back', await navShown('eagle') && await main.eval(`getComputedStyle(document.getElementById('badgeSpace')).display !== 'none'`));
});

section('setup', async () => {
    // A brand new install: setup asks what you use, and only those plugins are switched on.
    const fresh = mkdtempSync(join(tmpdir(), 'hapshub-setup-'));
    let copy;
    try {
        copy = startApp(fresh, PORT + 20);
        const setup = await Page.connect(PORT + 20, 'setup.html');
        await waitFor('setup to load', () => setup.eval(`typeof showPage === 'function' && typeof SETUP_PICKS !== 'undefined'`), 30000);
        await setup.eval(`showPage(PAGE_PLUGINS)`);
        await waitFor('the picks', () => setup.eval(`document.querySelectorAll('#setupPicks input[data-pick]').length === SETUP_PICKS.length`), 10000);
        await sleep(1500);
        check('setup asks what you use', await setup.eval(`document.querySelector('[data-page="9"] .setup-title').textContent.includes('What do you use')`));
        const fits = await setup.json(`(() => { const p = document.getElementById('setupPicks').getBoundingClientRect(); return p.width > 0 && p.right <= innerWidth; })()`);
        check('the picks fit the setup window', fits);
        await setup.eval(`document.querySelectorAll('#setupPicks input[data-pick]').forEach(i => i.checked = i.dataset.pick === 'eagle' || i.dataset.pick === 'vr'); nextPage();`);
        await sleep(2500);
        const db = new DatabaseSync(join(fresh, 'Hub', 'hub.db'), { readOnly: true });
        const row = key => db.prepare(`SELECT value FROM module_settings WHERE module_id = ? AND key = ?`).get('hub.plugins', key)?.value;
        const saved = JSON.parse(row('enabled') || '{}');
        const picked = row('picked');
        const perf = db.prepare(`SELECT value FROM module_settings WHERE module_id = 'hub.performance' AND key = 'mode'`).get()?.value;
        db.close();
        check('the picks are saved exactly', saved.eagle === true && saved['space-flight'] === true && saved.oyasumi === false && saved['youtube-tunnel'] === false && saved['upstream-watch'] === false && saved.history === true, JSON.stringify(saved));
        check('Performance mode follows the pick, and setup remembers it asked', perf === 'false' && picked === '1', `${perf} ${picked}`);
        await setup.eval(`window.external.sendMessage(JSON.stringify({action:'windowClose'}))`).catch(() => {});
        setup.socket.close();
        await waitFor('setup copy to close', () => hubLog(fresh).includes('Hub stopped.'), 20000).catch(() => {});
    } finally {
        // Only this copy: the main test copy is still open.
        killTree(copy?.pid);
        await sleep(800);
        try { rmSync(fresh, { recursive: true, force: true }); } catch { /* still closing */ }
    }
});

const dir = freshData('hapshub-round5-');
let main;
try {
    main = await openMain(dir, PORT);
    await spySends(main);
    // The splash covers the page for a moment after it loads; clicks would land on it.
    await waitFor('the splash to go', () => main.eval(`!document.getElementById('vrcnSplash')`), 15000);
    for (const { name, run } of sections) {
        if (only && only !== name) continue;
        try { await run(main); }
        catch (error) { check(`${name}: the section finished`, false, error.message); }
    }
    check('no page errors', main.errors.length === 0, main.errors.join(' | '));
    check('no crash report', crashes(dir) === 0);
    const closed = await closeMain(main);
    check('the app closes cleanly', closed, hubLog(dir).trim().split(/\r?\n/).slice(-6).join(' | '));
} catch (error) {
    check('the run finished', false, error.stack || error.message);
} finally {
    await cleanUp(dir);
}
console.log(state.failures ? `${state.failures} check(s) failed` : `all ${state.passed} checks passed`);
process.exit(state.failures ? 1 : 0);
