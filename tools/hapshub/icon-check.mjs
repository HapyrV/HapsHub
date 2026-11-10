// Says which icon names the app's icon font has. The font is a subset: a missing icon shows its name as wide text.
//   node tools/hapshub/icon-check.mjs name1 name2 ...      (no names: checks every icon on every page instead)
import { cleanUp, freshData, openMain, sleep, waitFor } from './lib/harness.mjs';

const names = process.argv.slice(2).filter(a => !a.startsWith('--'));
const dir = freshData('hapshub-icons-');
let failed = 0;
try {
    const main = await openMain(dir, 9352);
    await waitFor('splash', () => main.eval(`!document.getElementById('vrcnSplash')`), 15000);
    if (names.length) {
        const result = await main.json(`(() => {
            const box = document.createElement('div'); document.body.appendChild(box);
            const out = {};
            for (const n of ${JSON.stringify(names)}) { const s = document.createElement('span'); s.className = 'msi'; s.style.fontSize = '20px'; s.textContent = n; box.appendChild(s); out[n] = s.getBoundingClientRect().width <= 32; }
            box.remove(); return out; })()`);
        for (const [name, ok] of Object.entries(result)) { if (!ok) failed++; console.log(`${ok ? 'ok  ' : 'MISSING'} ${name}`); }
    } else {
        // Every page and every settings section, plus the plugin options pages.
        const tabs = await main.json(`[...document.querySelectorAll('.content > .tab')].map(t => Number(t.id.replace('tab', '')))`);
        const seen = new Map();
        const collect = where => main.json(`[...document.querySelectorAll('.msi')].filter(e => e.offsetParent && e.textContent.trim() && !/\\s/.test(e.textContent.trim()))
            .filter(e => { const r = e.getBoundingClientRect(); const size = parseFloat(getComputedStyle(e).fontSize); return r.width > size * 1.6; })
            .map(e => e.textContent.trim())`).then(list => list.forEach(n => seen.set(n, seen.get(n) || where)));
        for (const tab of tabs) { await main.eval(`showTab(${tab})`); await sleep(350); await collect(`tab ${tab}`); }
        const sections = await main.json(`[...new Set([...document.querySelectorAll('#tab9 [data-section]')].map(e => e.dataset.section))]`);
        await main.eval(`showTab(9)`);
        for (const section of sections) { await main.eval(`switchSettingsSection(${JSON.stringify(section)})`); await sleep(150); await collect(`settings ${section}`); }
        for (const [name, where] of seen) { failed++; console.log(`MISSING ${name} (${where})`); }
        if (!seen.size) console.log('every icon on every page exists');
    }
} finally {
    await cleanUp(dir);
}
process.exit(failed ? 1 : 0);
