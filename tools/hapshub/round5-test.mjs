// Drives the built app through the features added in the plugins round: the credit to VRCNext, the app's own
// name, plugins, performance mode, the tidier settings and editing the sidebar in place.
// Uses a throwaway data folder, no login and no VRChat traffic. Stops only what it started.
//   node tools/hapshub/round5-test.mjs [--release] [--only name]

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Page, ROOT, checker, cleanUp, closeMain, crashes, freshData, hubLog, killTree, openMain, sleep, startApp, waitFor } from './lib/harness.mjs';

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
    // Since the Smart Search bar shares the top bar (f586a114), "Heavily based on" is dropped when the bar is narrow.
    check('at the usual window size the credit fits in the top bar beside the search bar', usual.pill <= usual.bar && (usual.lead || usual.bar < 520), JSON.stringify(usual));

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
        // "Heavily based on" goes below 520 px since the search bar shares the top bar (f586a114).
        widths[500].more && !widths[500].lead && !widths[300].more && widths[300].text && widths[150].text && !widths[90].text
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
    const pageTab = await main.eval(`NAV_ITEMS_DEF.ovrtoolkit.tab`);
    await main.eval(`document.querySelector('#hubPluginList [data-plugin="ovrtoolkit"] input').click()`);
    await waitFor('the hub to save OVR Toolkit off', () => main.eval(`window.__pluginReplies.some(p => p.states.ovrtoolkit === false)`), 10000);
    check('turning a plugin off removes its page from the sidebar', !(await main.eval(`!!document.querySelector('#navEl .nav-btn[data-nav-key="ovrtoolkit"]')`)) && !(await navShown('ovrtoolkit')));
    await main.eval(`showTab(${pageTab})`);
    check('its page can\'t be opened while it\'s off', await main.eval(`document.getElementById('tab0').classList.contains('active') && !document.getElementById('tab${pageTab}').classList.contains('active')`));

    await main.eval(`hubPluginSet('space-flight', false)`);
    await sleep(300);
    check('a VRCNext tool that\'s off loses its top bar button and its auto-start', await main.eval(`getComputedStyle(document.getElementById('badgeSpace')).display === 'none' && hubPluginBlocks('setSfAutoStartVR') && !hubPluginBlocks('setStAutoStartVR')`));

    await main.eval(`hubPluginSet('history', false)`);
    await waitFor('the History module to stop', async () => (await main.json(`(_hubUiSettings || []).find(m => m.id === 'hub.history')?.status`)) === 'Disabled', 15000).catch(() => {});
    check('a plugin that\'s off stops its background module', await main.json(`(_hubUiSettings || []).find(m => m.id === 'hub.history')?.status`) === 'Disabled');

    // Round 6: options fold open under the plugin in the list instead of getting a Settings entry each.
    const options = await main.eval(`hubOpenPlugins(); [...document.querySelectorAll('.hub-plugin-expand')].map(b => b.closest('.hub-plugin-row').dataset.plugin).join(',')`);
    check("plugins with options can fold them open, and ones that are off can't", options.includes('youtube-tunnel') && options.includes('eagle') && !options.includes('history'), options);
    await main.eval(`hubPluginOptions('youtube-tunnel')`);
    await waitFor('the plugin options', () => visible(main, '.hub-plugin-opts[data-plugin-opts="youtube-tunnel"]'), 5000);
    check("a plugin's options show its settings", await main.eval(`!!document.querySelector('.hub-plugin-opts[data-plugin-opts="youtube-tunnel"] .hub-module-row')`));
    check('module settings are no longer repeated under Hub modules', await main.eval(`(() => { const r = document.querySelector('#hubModulesList .hub-module-row[data-module="hub.youtube-tunnel"]'); return !r || getComputedStyle(r).display === 'none'; })()`));

    await main.eval(`hubOpenPlugins()`);
    // Opening the options scrolls them into view smoothly; click only once the button has stopped moving.
    const moreSel = '#hubPluginList [data-plugin="youtube-tunnel"] .hub-plugin-more';
    await main.eval(`document.querySelector('${moreSel}')?.scrollIntoView({ block: 'center', behavior: 'instant' })`);
    let more = null;
    await waitFor('the ⋮ button to stop moving', async () => {
        const before = more;
        more = await main.center(moreSel);
        return before && more && before.x === more.x && before.y === more.y;
    }, 5000);
    await main.click(more.x, more.y);
    const menu = await main.eval(`document.getElementById('hubPluginMenu')?.innerText || ''`);
    const hit = menu ? '' : await main.eval(`(() => { const e = document.elementFromPoint(${more.x}, ${more.y}); return 'no menu; at (${more.x},${more.y}): ' + (e ? e.tagName + '.' + e.className + ' in ' + (e.closest('[id]')?.id || '?') : 'nothing') + '; viewport ' + innerWidth + 'x' + innerHeight; })()`);
    check('the ⋮ menu offers its page, its options and turning it off', /page/i.test(menu) && /Options/.test(menu) && /Turn off/.test(menu), menu || hit);
    // Clicking elsewhere closes it. Not near the window edge: a press there starts resizing the real window.
    // Nor on the top bar: a press there starts moving the real window, which waits for a real mouse release
    // and holds up the app (and every answer to the page) until then. So the header is scrolled into view first.
    await main.eval(`document.querySelector('#hubPluginsCard .vrcn-panel-card-header').scrollIntoView({ block: 'center' })`);
    await sleep(200);
    const away = await main.center('#hubPluginsCard .vrcn-panel-card-header');
    const under = await main.eval(`(() => { const e = document.elementFromPoint(${away.x}, ${away.y}); return e ? (e.closest('#hubPluginsCard') ? '' : e.tagName + '#' + e.id + '.' + e.className) : 'nothing'; })()`);
    if (under) throw new Error('the plugin card header is covered by ' + under);
    await main.click(away.x, away.y);
    await sleep(200);
    check('a click elsewhere closes the menu', await main.eval(`!document.getElementById('hubPluginMenu')`));

    await main.eval(`hubPluginsAll(true)`);
    await waitFor('everything back on', () => main.eval(`window.__pluginReplies.some(p => Object.values(p.states).every(Boolean))`), 15000);
    check('turning all on brings every page back', await navShown('ovrtoolkit') && await main.eval(`getComputedStyle(document.getElementById('badgeSpace')).display !== 'none'`));
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

section('tidy', async main => {
    await main.eval(`showTab(9); switchSettingsSection('general', document.querySelector('.settings-nav-item'))`);
    await waitFor('the info buttons', () => main.eval(`document.querySelectorAll('#tab9 .hub-more').length > 5`), 10000);
    const state = await main.json(`(() => {
        const buttons = [...document.querySelectorAll('#tab9 .hub-more')].filter(b => b.offsetParent);
        const hidden = [...document.querySelectorAll('#tab9 .hub-desc-collapsed')].filter(d => d.closest('.vrcn-panel-card')?.style.display !== 'none');
        return { buttons: buttons.length, hiddenShown: hidden.filter(d => getComputedStyle(d).display !== 'none').length, hidden: hidden.length };
    })()`);
    check('explanations under settings fold away behind an info button', state.buttons > 3 && state.hidden > 3 && state.hiddenShown === 0, JSON.stringify(state));
    const opened = await main.eval(`(() => { const b = [...document.querySelectorAll('#tab9 .hub-more')].find(x => x.offsetParent); b.click();
        const d = [...document.querySelectorAll('#tab9 .hub-desc-open')][0]; return !!d && getComputedStyle(d).display !== 'none' && b.getAttribute('aria-expanded') === 'true'; })()`);
    check('the info button opens its explanation', opened);
    await main.eval(`hubTidyShowAll(true)`);
    check('"Show all details" opens every explanation', await main.eval(`[...document.querySelectorAll('#tab9 .hub-desc-collapsed')].every(d => getComputedStyle(d).display !== 'none' || d.closest('[style*="display: none"], [style*="display:none"]'))`));
    await main.eval(`hubTidyShowAll(false); document.querySelectorAll('#tab9 .hub-desc-open').forEach(d => d.classList.remove('hub-desc-open'))`);
    await main.eval(`(() => { const s = document.getElementById('settingsSearchInput'); s.value = 'tray'; s.dispatchEvent(new Event('input')); })()`);
    check('searching shows the explanations too', await main.eval(`document.getElementById('tab9').classList.contains('hub-searching')`));
    await main.eval(`(() => { const s = document.getElementById('settingsSearchInput'); s.value = ''; s.dispatchEvent(new Event('input')); clearSettingsSearch?.(); })()`);
    const overflow = await main.json(`(() => { const c = document.querySelector('#tab9 .settings-content'); return c.scrollWidth - c.clientWidth; })()`);
    check('nothing in Settings pokes out sideways', overflow <= 1, String(overflow));
});

section('nav', async main => {
    const layout = () => main.json(`navLoadLayout()`);
    await main.eval(`localStorage.removeItem('vrcnext_nav_layout_v1'); navRender(); showTab(0)`);
    check('the sidebar ends with a + button', await main.eval(`!!document.querySelector('#navEl .hub-nav-add')`));

    await main.eval(`hubNavAdd('folder', { key: 'dashboard' })`);
    await waitFor('the name box', () => main.eval(`!!document.querySelector('#navEl .hub-nav-rename')`), 5000);
    await main.eval(`(() => { const i = document.querySelector('#navEl .hub-nav-rename'); i.value = 'My group'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
    const group = (await layout()).layout.find(e => e.type === 'folder' && e.name === 'My group');
    check('a new group can be added and named in place', !!group && await main.eval(`!!document.querySelector('#navEl .nav-group[data-group-id="${group?.id}"]')`));

    await main.eval(`document.getElementById('navEl').scrollTop = 0`);
    const from = await main.center('#navEl .nav-btn[data-nav-key="worlds"]');
    const to = await main.center(`#navEl .nav-group[data-group-id="${group?.id}"] .nav-group-btn`);
    await main.drag(from, to);
    await sleep(300);
    const moved = (await layout()).layout.find(e => e.id === group?.id);
    check('dragging a page onto a group puts it in the group', moved?.items?.includes('worlds') && !(await layout()).layout.some(e => e.type === 'item' && e.key === 'worlds'), JSON.stringify(moved));
    check('the drag didn\'t open the page it moved', await main.eval(`document.getElementById('tab0').classList.contains('active')`));

    const a = await main.center('#navEl .nav-btn[data-nav-key="groups"]');
    const b = await main.json(`(() => { const r = document.querySelector('#navEl .nav-btn[data-nav-key="avatars"]').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.bottom - 3 }; })()`);
    await main.drag(a, b);
    await sleep(300);
    const order = (await layout()).layout.filter(e => e.type === 'item').map(e => e.key);
    check('dragging a page between two others places it there', order.indexOf('groups') === order.indexOf('avatars') + 1, order.join(','));

    await main.eval(`document.getElementById('navEl').scrollTop = 0`);
    const sep = await main.center('#navEl .nav-sep');
    for (const clickCount of [1, 2]) {
        await main.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: sep.x, y: sep.y, button: 'left', buttons: 1, clickCount });
        await main.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: sep.x, y: sep.y, button: 'left', buttons: 0, clickCount });
    }
    await waitFor('the header name box', () => main.eval(`!!document.querySelector('#navEl .hub-nav-rename')`), 5000).catch(() => {});
    await main.eval(`(() => { const i = document.querySelector('#navEl .hub-nav-rename'); if (!i) return; i.value = 'Mine'; i.blur(); })()`);
    await sleep(200);
    check('double-clicking a header renames it', (await layout()).layout.some(e => e.type === 'separator' && e.name === 'Mine'));

    await main.eval(`document.getElementById('navEl').scrollTop = 0`);
    const item = await main.center('#navEl .nav-btn[data-nav-key="people"]');
    await main.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: item.x, y: item.y, button: 'right', buttons: 2, clickCount: 1 });
    await main.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: item.x, y: item.y, button: 'right', buttons: 0, clickCount: 1 });
    await sleep(400);
    const menuText = await main.eval(`document.body.innerText`);
    check('right-clicking a page offers hiding it and adding a group or header', /Hide this page/.test(menuText) && /New group/.test(menuText) && /Add header/.test(menuText));
    await main.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); hubNavHide('people', true)`);
    check('a hidden page leaves the sidebar', await main.eval(`!document.querySelector('#navEl .nav-btn[data-nav-key="people"]')`));
    await main.eval(`hubNavAddMenu(document.querySelector('#navEl .hub-nav-add'))`);
    const addMenu = await main.eval(`document.getElementById('hubNavAddMenu')?.innerText || ''`);
    check('the + menu can bring a hidden page back', /Show People/.test(addMenu), addMenu);
    await main.eval(`[...document.querySelectorAll('#hubNavAddMenu button')].find(b => /Show People/.test(b.innerText)).click()`);
    check('...and does', await main.eval(`!!document.querySelector('#navEl .nav-btn[data-nav-key="people"]')`));

    await main.eval(`hubNavRemove(${JSON.stringify(group?.id)})`);
    check('removing a group keeps its pages', (await layout()).layout.some(e => e.type === 'item' && e.key === 'worlds'));
    await main.eval(`localStorage.removeItem('vrcnext_nav_layout_v1'); navRender()`);
});

section('vrct', async () => {
    // The VRCT page with a stand-in engine: start it, pick a language pair, hear the microphone, send a message, stop.
    const fake = join(ROOT, 'tools', 'hapshub', 'fake-vrct');
    const exe = join(fake, 'bin', 'Release', 'net10.0', 'FakeVrct-sidecar.exe');
    const built = spawnSync('dotnet', ['build', fake, '-c', 'Release', '-v', 'quiet', '-nologo'], { encoding: 'utf8' });
    if (!check('the stand-in VRCT engine builds', built.status === 0 && existsSync(exe), built.stdout)) return;
    const dir2 = freshData('hapshub-vrct-');
    const logFile = join(dir2, 'fake-vrct.log');
    let copy;
    try {
        copy = await openMain(dir2, PORT + 22, { HAPSHUB_VRCT_SIDECAR: exe, FAKE_VRCT_LOG: logFile });
        const asked = () => existsSync(logFile) ? readFileSync(logFile, 'utf8') : '';
        await waitFor('splash', () => copy.eval(`!document.getElementById('vrcnSplash')`), 15000);
        await copy.eval(`showTab(NAV_ITEMS_DEF.vrct.tab)`);
        await waitFor('the VRCT page', () => copy.eval(`!!document.querySelector('.vrct-page') && document.getElementById('vrctStatus').textContent === 'Off'`), 10000);
        check('the VRCT page is HapsHub\'s own, not a held window', await copy.eval(`!document.getElementById('aemb-pane-vrct') && document.querySelector('.vrct-page').classList.contains('is-off')`));
        await copy.eval(`vrctStart()`);
        await waitFor('the engine', () => copy.eval(`_vrct.state === 'ready'`), 20000);
        check('Start runs VRCT\'s engine and fills in its languages and devices', await copy.eval(`document.getElementById('vrctYour').value === 'English|United States' && document.getElementById('vrctTarget').value === 'Japanese|Japan' && document.getElementById('vrctMic').value === 'Test Microphone'`));
        // F1: the languages are VRCT's own list, and quick pairs are only the ones you used.
        const listed = await copy.json(`({ your: [...document.getElementById('vrctYour').options].map(o => o.value), engine: _vrct.data.selectable_language_list.map(l => l.language + '|' + l.country) })`);
        check('F1: the language lists are exactly the ones VRCT reports', JSON.stringify(listed.your) === JSON.stringify(listed.engine), JSON.stringify(listed));
        check('F1: no language pairs are built in', await copy.eval(`document.querySelectorAll('#vrctPairs .vrct-pair').length === 0 && !!document.querySelector('#vrctPairs .vrct-pairs-empty')`));
        check('a language that comes in several countries says which', await copy.eval(`[...document.getElementById('vrctYour').options].some(o => o.textContent === 'English (United Kingdom)') && [...document.getElementById('vrctYour').options].some(o => o.textContent === 'Hebrew')`));
        // Picking two languages, as the dropdowns do.
        await copy.eval(`vrctSetLanguage('your', 'Hebrew|Israel'); vrctSetLanguage('target', 'English|United States')`);
        await waitFor('the pair to be sent', () => asked().includes('"language":"Hebrew"') && asked().includes('selected_target_languages'), 5000).catch(() => {});
        check('picking languages sets them in the engine', /selected_your_languages .*"language":"Hebrew"/.test(asked()) && /selected_target_languages .*"1":\{"language":"English"/.test(asked()), asked().slice(-400));
        await waitFor('the pair to be remembered', () => copy.eval(`document.querySelectorAll('#vrctPairs .vrct-pair').length === 1`), 7000).catch(() => {});
        const pair = await copy.eval(`document.querySelector('#vrctPairs .vrct-pair.is-on')?.textContent || ''`);
        check('F1: a pair you used becomes a quick pair', pair === 'Hebrew → English (United States)', pair);
        await copy.eval(`document.querySelector('#vrctSwitches input[data-vrct="transcription_send"]').click()`);
        await waitFor('the microphone line', () => copy.eval(`document.getElementById('vrctLog').innerText.includes('hello from the mic')`), 5000).catch(() => {});
        check('what the microphone hears shows with its translation', await copy.eval(`document.getElementById('vrctLog').innerText.includes('[English] hello from the mic')`));
        await copy.eval(`document.getElementById('vrctInput').value = 'שלום'; vrctSendTyped()`);
        await waitFor('the typed line', () => copy.eval(`document.getElementById('vrctLog').innerText.includes('[English] שלום')`), 5000).catch(() => {});
        check('a typed message is sent and its translation shown', await copy.eval(`document.getElementById('vrctLog').innerText.includes('[English] שלום')`));
        // Each translator has its own languages: the stand-in's DeepL has Korean and no Hebrew.
        await copy.eval(`vrctSetEngine('DeepL')`);
        await waitFor('the DeepL languages', () => copy.eval(`[...document.getElementById('vrctYour').options].some(o => o.value === 'Korean|South Korea')`), 5000).catch(() => {});
        const deepl = await copy.json(`({ your: [...document.getElementById('vrctYour').options].map(o => o.value), target: [...document.getElementById('vrctTarget').options].map(o => o.value), pairs: document.querySelectorAll('#vrctPairs .vrct-pair').length })`);
        check('F1: switching translator shows the languages of that translator', JSON.stringify(deepl.your) === JSON.stringify(['English|United States', 'Japanese|Japan', 'Korean|South Korea']) && JSON.stringify(deepl.target) === JSON.stringify(deepl.your), JSON.stringify(deepl));
        check('F1: a quick pair the translator cannot do is hidden', deepl.pairs === 0, JSON.stringify(deepl));
        await sleep(9000);
        check('HapsHub keeps the engine alive past its watchdog', await copy.eval(`_vrct.state === 'ready'`));
        await copy.eval(`vrctStop()`);
        await waitFor('the engine to stop', () => copy.eval(`_vrct.state === 'off'`), 15000).catch(() => {});
        check('Stop closes the engine', await copy.eval(`_vrct.state === 'off'`) && !spawnSync('tasklist', ['/FI', 'IMAGENAME eq FakeVrct-sidecar.exe', '/NH'], { encoding: 'utf8' }).stdout.includes('FakeVrct-sidecar'));
        check('the VRCT page has no page errors', copy.errors.length === 0, copy.errors.join(' | '));
    } finally {
        if (copy) killTree(copy.app.pid);
        spawnSync('taskkill', ['/IM', 'FakeVrct-sidecar.exe', '/F']);
        await sleep(800);
        try { rmSync(dir2, { recursive: true, force: true }); } catch { /* still closing */ }
    }
});

section('map', async main => {
    await main.eval(`(() => {
        const friend = (id, extra) => ({ id, displayName: id, status: 'active', image: '', tags: [], bio: '', statusDescription: '', ...extra });
        window.__savedFriends = vrcFriendsData;
        vrcFriendsData = [
            friend('flag', { bio: 'hi 🇩🇪 here' }),
            friend('from', { bio: 'Hello! I am from Japan, love anime' }),
            friend('living', { statusDescription: 'living in the Netherlands' }),
            friend('hebrew', { tags: ['language_eng', 'language_heb'] }),
            friend('english', { tags: ['language_eng'] }),
            friend('two', { tags: ['language_deu', 'language_jpn'] }),
            friend('rainbow', { bio: '🏳️‍🌈 just vibes' }),
            friend('georgia', { bio: 'My name is Georgia' }),
        ];
    })()`);
    await main.eval(`showTab(NAV_ITEMS_DEF['world-map'].tab)`);
    await waitFor('the globe', () => main.eval(`_wmap.frame > 0 && _wmap.places.size > 0`), 10000);
    const places = await main.json(`Object.fromEntries([..._wmap.places].map(([code, list]) => [code, list.map(p => p.friend.id + ':' + p.how)]))`);
    check('a flag, "from Japan", "living in the Netherlands" and a Hebrew tag each place a friend', places.DE?.[0] === 'flag:flag' && places.JP?.[0] === 'from:bio' && places.NL?.[0] === 'living:bio' && places.IL?.[0] === 'hebrew:language', JSON.stringify(places));
    check('English alone, two clashing languages, a rainbow flag and a name like Georgia place nobody', Object.keys(places).length === 4 && await main.eval(`_wmap.unplaced === 4`), JSON.stringify(places));
    check('the page has a title', (await main.eval(`document.getElementById('pageTitle').textContent`)) === 'World Map');
    const drawn = await main.eval(`(() => { const c = document.getElementById('wmapCanvas'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let lit = 0; for (let i = 3; i < d.length; i += 4 * 97) if (d[i] > 0) lit++; return lit; })()`);
    check('the globe is drawn', drawn > 50, String(drawn));
    await main.eval(`wmapSelect('JP')`);
    await sleep(300);
    check('choosing a country lists who is there', await main.eval(`document.querySelector('.wmap-country.is-on .wmap-name').textContent === 'Japan' && document.querySelectorAll('.wmap-friends .wmap-friend').length === 1`));
    const fits = await main.json(`(() => { const p = document.querySelector('#tab39 .wmap-page'); const c = document.querySelector('.content'); return { page: Math.round(p.getBoundingClientRect().bottom), view: Math.round(c.getBoundingClientRect().bottom), scroll: c.scrollHeight - c.clientHeight }; })()`);
    check('the map page fits the window without scrolling', fits.scroll <= 2, JSON.stringify(fits));
    const frames = await main.eval(`_wmap.frame`);
    await main.eval(`showTab(0)`);
    await sleep(600);
    const after = await main.eval(`_wmap.frame`);
    await sleep(600);
    check('the globe stops drawing when its page is closed', (await main.eval(`_wmap.frame`)) === after, `${frames} ${after}`);
    await main.eval(`vrcFriendsData = window.__savedFriends`);
});

section('release', async main => {
    const shown = await main.eval(`document.querySelector('.logo-sub').textContent`);
    const version = readFileSync(join(ROOT, 'main', 'AppInfo.cs'), 'utf8').match(/Version = "([^"]+)"/)[1];
    check('the sidebar shows the app version', shown === 'v' + version, `${shown} vs ${version}`);
    const help = await main.eval(`[...document.querySelectorAll('#tbMenuHelp .tb-dd-item')].map(i => i.getAttribute('onclick') || '').join(' ')`);
    check('bug reports and feature requests go to HapsHub, not VRCNext', help.includes('HapyrV/HapsHub/issues') && !help.includes('shinyflvre/VRCNext/issues') && !help.includes('discord.gg'), help);
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
    check('the app closes cleanly', closed, hubLog(dir).trim().split(/\r?\n/).slice(-12).map(l => l.replace(/^\S+ /, '')).join(' | '));
} catch (error) {
    check('the run finished', false, error.stack || error.message);
} finally {
    await cleanUp(dir);
}
console.log(state.failures ? `${state.failures} check(s) failed` : `all ${state.passed} checks passed`);
process.exit(state.failures ? 1 : 0);
