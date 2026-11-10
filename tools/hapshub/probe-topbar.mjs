// Probe: which pages leave the top bar's menus cut off at a given size and language.
//   node tools/hapshub/probe-topbar.mjs [width] [scale] [language] [max]
// max: text size, letter spacing and top bar height at their largest (the QA pass leaves them there).
import { checker, cleanUp, closeMain, freshData, openMain, sleep, waitFor } from './lib/harness.mjs';

const [width = 960, scale = 1.25, language = 'ru', max] = process.argv.slice(2);
checker();
const dir = freshData('hapshub-probe-');
let main;
try {
    main = await openMain(dir, 9351);
    await waitFor('the splash to go', () => main.eval(`!document.getElementById('vrcnSplash')`), 15000);
    await main.send('Emulation.setDeviceMetricsOverride', { width: Number(width), height: 600, deviceScaleFactor: Number(scale), mobile: false });
    await main.eval(`requestTranslation(${JSON.stringify(language)})`);
    if (max) await main.eval(`['setFontSize', 'setLetterSpacing', 'setTaskbarHeight'].forEach(id => { const s = document.getElementById(id); if (!s) return; s.value = s.max; s.dispatchEvent(new Event('input', { bubbles: true })); s.dispatchEvent(new Event('change', { bubbles: true })); })`);
    await sleep(1500);
    const tabs = await main.json(`[...document.querySelectorAll('.content > .tab')].map(t => Number(t.id.replace('tab', ''))).filter(n => !isNaN(n))`);
    // The same pages the QA pass visits: every tab, every Settings section, and the plugins with their options open.
    const sections = await main.json(`[...new Set([...document.querySelectorAll('#tab9 .settings-nav-item[onclick*="switchSettingsSection"]')].map(b => (b.getAttribute('onclick').match(/switchSettingsSection\\('([^']+)'/) || [])[1]).filter(Boolean))]`);
    const pages = [...tabs.filter(t => t !== 9).map(t => [`tab ${t}`, `showTab(${t})`]),
        ...sections.map(s => [`settings ${s}`, `showTab(9); switchSettingsSection(${JSON.stringify(s)})`]),
        ['plugin options', `showTab(9); switchSettingsSection('plugins'); HUB_PLUGINS.forEach(p => _hubPluginHasOptions(p) && hubPluginToggleOptions(p.id, true))`]];
    for (const [tab, open] of pages) {
        await main.eval(open);
        await sleep(400);
        const m = await main.json(`(() => {
            const r = id => document.getElementById(id)?.getBoundingClientRect();
            const left = r('tb-left'), drag = r('tb-drag'), right = r('tb-right');
            const items = [...document.querySelectorAll('#tb-left .tb-menu-item')].filter(e => e.offsetParent);
            const last = items[items.length - 1]?.getBoundingClientRect();
            const kids = [...document.getElementById('tb-left').children].filter(e => e.offsetParent).map(e => (e.id || e.className.split(' ')[0]) + ':' + Math.round(e.getBoundingClientRect().width));
            const rightKids = [...document.getElementById('tb-right').children].filter(e => e.offsetParent).map(e => (e.id || e.className.split(' ')[0]) + ':' + Math.round(e.getBoundingClientRect().width));
            return { cut: Math.round(last.right - left.right), steps: document.getElementById('taskbar').className, left: Math.round(left.width), drag: Math.round(drag.width), right: Math.round(right.width), kids, rightKids, title: document.getElementById('pageTitle').textContent };
        })()`);
        if (m.cut > 0 || m.drag < 44) console.log(tab, JSON.stringify(m));
    }
    console.log('done');
    await closeMain(main);
} catch (error) {
    console.log('probe failed', error.message);
} finally {
    await cleanUp(dir);
}
