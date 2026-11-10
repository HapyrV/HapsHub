// Settings census: how many cards and settings each Settings tab holds, so tabs with only one or two settings stand out.
//   node tools/hapshub/settings-census.mjs [--min 3]
// Exits 1 when a tab has fewer settings than --min (default 3). A setting is a switch, a choice, a box to type in or a
// slider; buttons don't count. Tabs with none at all are tool or info pages (VRCX import, About, Accounts) and pass.

import { cleanUp, freshData, openMain, sleep, waitFor } from './lib/harness.mjs';

const MIN = process.argv.includes('--min') ? Number(process.argv[process.argv.indexOf('--min') + 1]) : 3;
const dir = freshData('hapshub-census-');
let small = 0;
try {
    const main = await openMain(dir, 9357);
    await waitFor('the splash to go', () => main.eval(`!document.getElementById('vrcnSplash')`), 15000);
    await sleep(2500);
    const sections = await main.json(`[...new Set([...document.querySelectorAll('#tab9 .settings-nav-item[onclick*="switchSettingsSection"]')].map(b => (b.getAttribute('onclick').match(/switchSettingsSection\\('([^']+)'/) || [])[1]).filter(Boolean))]`);
    for (const section of sections) {
        await main.eval(`showTab(9); switchSettingsSection(${JSON.stringify(section)})`);
        await sleep(300);
        const info = await main.json(`(() => {
            const cards = [...document.querySelectorAll('#tab9 [data-section="${section}"]')].filter(c => c.offsetParent);
            const shown = el => el.offsetParent && el.getBoundingClientRect().width > 0;
            const settings = cards.flatMap(c => [...c.querySelectorAll('input:not([type=hidden]):not([type=file]), select, textarea, .vn-select')])
                .filter(el => el.tagName === 'SELECT' ? !el._vnSelect && shown(el) : (shown(el) || el.closest('.toggle')))
                .filter(el => !el.closest('.search-bar-row'));
            return { cards: cards.map(c => (c.querySelector('.vrcn-panel-card-header')?.textContent || '').trim().replace(/\\s+/g, ' ')), settings: settings.length };
        })()`);
        const tooFew = info.settings > 0 && info.settings < MIN;
        if (tooFew) small++;
        console.log(`${tooFew ? '!' : ' '} ${section.padEnd(14)} ${String(info.settings).padStart(3)} settings, ${info.cards.length} cards: ${info.cards.join(' | ')}`);
    }
} finally {
    await cleanUp(dir);
}
console.log(small ? `${small} tab(s) with fewer than ${MIN} settings.` : `Every tab has ${MIN}+ settings.`);
process.exit(small ? 1 : 0);
