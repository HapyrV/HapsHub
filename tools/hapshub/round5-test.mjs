// Drives the built app through the features added in the plugins round: the credit to VRCNext, the app's own
// name, plugins, performance mode, the tidier settings and editing the sidebar in place.
// Uses a throwaway data folder, no login and no VRChat traffic. Stops only what it started.
//   node tools/hapshub/round5-test.mjs [--release] [--only name]

import { checker, cleanUp, closeMain, crashes, freshData, openMain, sleep, waitFor } from './lib/harness.mjs';

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
    check('the app closes cleanly', await closeMain(main));
} catch (error) {
    check('the run finished', false, error.stack || error.message);
} finally {
    await cleanUp(dir);
}
console.log(state.failures ? `${state.failures} check(s) failed` : `all ${state.passed} checks passed`);
process.exit(state.failures ? 1 : 0);
