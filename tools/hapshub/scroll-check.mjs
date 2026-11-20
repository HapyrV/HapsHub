// Checks that the mouse wheel scrolls every page: each tab (and each sub-tab of Worlds, Avatars, People and
// Groups) gets its main list filled with tall content, then a real wheel tick goes to it. A page fails when
// nothing moved. Pages that are a map or canvas (the networks), a held app or a web frame are skipped.
//   node tools/hapshub/scroll-check.mjs
import { cleanUp, freshData, openMain, sleep, waitFor } from './lib/harness.mjs';

const dir = freshData('hapshub-scroll-');
let failed = 0;
try {
    const main = await openMain(dir, 9353);
    await waitFor('splash', () => main.eval(`!document.getElementById('vrcnSplash')`), 15000);
    const tabs = await main.json(`[...document.querySelectorAll('.content > .tab')].map(t => Number(t.id.replace('tab', '')))`);
    const subs = {
        1: ['setWorldFilter', ['favorites', 'explore', 'recent', 'mine']],
        2: ['setAvatarFilter', ['own', 'favorites', 'recent', 'rose', 'search']],
        3: ['setPeopleFilter', ['favorites', 'all', 'recentseen', 'search', 'blocked', 'muted', 'instance']],
        4: ['setGroupFilter', ['mine', 'search', 'instances']],
    };
    const cases = [];
    for (const tab of tabs) {
        if (subs[tab]) for (const s of subs[tab][1]) cases.push([tab, `${subs[tab][0]}('${s}')`]);
        else cases.push([tab, '']);
    }
    for (const [tab, sub] of cases) {
        await main.eval(`showTab(${tab})`); await sleep(350);
        if (sub) { await main.eval(`try { ${sub} } catch (e) {}`); await sleep(350); }
        const where = `tab ${tab}${sub ? ' ' + sub : ''}`;
        const r = await main.json(`(() => {
            const tab = document.getElementById('tab${tab}');
            if (!tab || getComputedStyle(tab).display === 'none') return { skip: 'not shown' };
            const shown = s => [...tab.querySelectorAll(s)].some(e => e.offsetParent);
            if (shown('.aemb-page')) return { skip: 'held app' };
            if (shown('iframe')) return { skip: 'web frame' };
            if (shown('.net-root')) return { skip: 'network map' };
            const big = e => { const b = e.getBoundingClientRect(); return b.width * b.height > innerWidth * innerHeight * 0.3; };
            if ([...tab.querySelectorAll('canvas')].some(c => c.offsetParent && big(c))) return { skip: 'canvas' };
            const vis = e => { const b = e.getBoundingClientRect(); return e.offsetParent && b.width > 50 && b.height > 30 && b.top < innerHeight && b.bottom > 0; };
            const cands = [...tab.querySelectorAll('[id$="Grid"], [id$="List"], [id$="list"], [id$="Results"], [id$="Container"], [id$="Inner"], .search-grid, .lv-tab-scroll')]
                .filter(vis).filter(e => !e.closest('.modal-box, .vn-select-panel'));
            cands.sort((a, b) => { const A = a.getBoundingClientRect(), B = b.getBoundingClientRect(); return B.width * B.height - A.width * A.height; });
            const box = cands[0] || tab;
            const filler = document.createElement('div');
            filler.id = '__scrollFill';
            filler.style.cssText = 'height:4000px;width:40px;flex-shrink:0;grid-column:1/-1';
            box.appendChild(filler);
            const b = box.getBoundingClientRect();
            return { box: (box.id || box.className).toString().slice(0, 40),
                     x: Math.round(Math.min(b.left + 60, innerWidth - 20)),
                     y: Math.round(Math.max(60, Math.min(b.top + 40, innerHeight - 40))) };
        })()`);
        if (r.skip) { console.log(`skip  ${where}: ${r.skip}`); continue; }
        await main.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: r.x, y: r.y });
        await main.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: r.x, y: r.y, deltaX: 0, deltaY: 500 });
        await sleep(450);
        const moved = await main.json(`(() => {
            const moved = [...document.querySelectorAll('*')].filter(e => e.scrollTop > 0).map(e => (e.id || e.className).toString().slice(0, 30));
            document.getElementById('__scrollFill')?.remove();
            document.querySelectorAll('*').forEach(e => { if (e.scrollTop) e.scrollTop = 0; });
            return moved;
        })()`);
        if (moved.length) console.log(`ok    ${where} (${moved[0]})`);
        else { failed++; console.log(`STUCK ${where}: the wheel over ${r.box} scrolled nothing`); }
    }
    console.log(failed ? `${failed} page(s) don't scroll` : 'every page scrolls');
} finally {
    await cleanUp(dir);
}
process.exit(failed ? 1 : 0);
