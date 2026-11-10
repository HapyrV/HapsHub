// Tests the app pages with a stand-in app, so it needs no OyasumiVR, Eagle or SteamVR: the stand-in is built from
// tools/hapshub/fake-embed-app and named like OVR Toolkit. It checks that the app is held in the page, hidden with
// the page, and minimized, closed or left open when HapsHub closes, as chosen in Settings.
//   node tools/hapshub/embed-fake-test.mjs [--release]

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT, checker, cleanUp, closeMain, freshData, killTree, openMain, processIds, sleep, waitFor } from './lib/harness.mjs';

const PORT = 9337;
const { check, state } = checker();
const fakeDir = join(ROOT, 'tools', 'hapshub', 'fake-embed-app');
const fakeExe = join(fakeDir, 'bin', 'Release', 'net10.0-windows', 'OVR Toolkit.exe');
const statusFile = join(tmpdir(), `hapshub-fake-embed-${process.pid}.json`);
const commandFile = join(tmpdir(), `hapshub-fake-embed-${process.pid}.cmd`);

const status = () => {
    try { return JSON.parse(readFileSync(statusFile, 'utf8')); } catch { return null; }
};
const waitStatus = (what, test, timeoutMs = 20000) => waitFor(what, () => { const s = status(); return s && test(s) ? s : null; }, timeoutMs);

if (processIds('OVR Toolkit.exe').length) {
    console.log('NOT CHECKED  app pages with the stand-in: the real OVR Toolkit is running');
    process.exit(0);
}
const build = spawnSync('dotnet', ['build', fakeDir, '-c', 'Release', '-v', 'quiet', '-nologo'], { encoding: 'utf8' });
if (build.status !== 0 || !existsSync(fakeExe)) {
    check('the stand-in app builds', false, (build.stdout || '') + (build.stderr || ''));
    process.exit(1);
}

const dirs = [];
async function run(exitAction) {
    rmSync(statusFile, { force: true });
    const dir = freshData('hapshub-embedfake-');
    dirs.push(dir);
    const main = await openMain(dir, PORT, { FAKE_EMBED_STATUS: statusFile, FAKE_EMBED_COMMAND: commandFile });
    const label = `[${exitAction}]`;
    try {
        await main.eval(`sendToCS({ action: 'hubSetSetting', module: 'hub.app-embeds', key: 'ovrtoolkit_path', value: ${JSON.stringify(fakeExe)} })`);
        if (exitAction !== 'minimize')
            await main.eval(`sendToCS({ action: 'hubSetSetting', module: 'hub.app-embeds', key: 'on_exit', value: '${exitAction}' })`);
        await sleep(400);

        if (exitAction === 'minimize') {
            await main.eval(`showTab(9); hubModulesRefresh()`);
            const options = await waitFor('the choice in Settings', () => main.json(
                `(() => { const s = document.querySelector('select[data-module="hub.app-embeds"][data-key="on_exit"]'); return s ? { value: s.value, options: [...s.options].map(o => o.value) } : null; })()`));
            check('Settings offers minimize, close and stay open, with minimize chosen', options.value === 'minimize' && options.options.join() === 'minimize,close,leave', JSON.stringify(options));
        }

        await main.eval(`showTab(38)`);
        await waitFor('the page', () => main.eval(`!!document.getElementById('aemb-pane-ovrtoolkit')`));
        // The page only reports its pane while the window can be seen, as it would be after a click.
        if (processIds('VRChat.exe').length === 0)
            spawnSync('powershell', ['-NoProfile', '-Command', `(New-Object -ComObject WScript.Shell).AppActivate(${main.app.pid})`]);
        await sleep(600);
        await main.eval(`aembStart('ovrtoolkit')`);
        const held = await waitStatus('the stand-in to be held', s => s.held && s.visible, 60000).catch(() => status());
        check(`${label} the app opens inside the page`, !!held?.held && !!held?.visible, JSON.stringify(held));
        if (!held?.held) return;

        const pane = await main.json(`(() => { const r = document.getElementById('aemb-pane-ovrtoolkit').getBoundingClientRect(); const d = devicePixelRatio; return { w: Math.round(r.width * d), h: Math.round(r.height * d) }; })()`);
        const sized = await waitStatus('the stand-in to fill the pane', s => Math.abs(s.width - pane.w) <= 2 && Math.abs(s.height - pane.h) <= 2, 8000).catch(() => status());
        check(`${label} it fills the pane`, Math.abs(sized.width - pane.w) <= 2 && Math.abs(sized.height - pane.h) <= 2, `${sized.width}x${sized.height} in ${pane.w}x${pane.h}`);

        // C2: the app maximizing itself (a double-click on its title bar) is put back to the pane's size.
        writeFileSync(commandFile, 'maximize');
        const maxed = await waitStatus('the stand-in to maximize', s => s.maximized, 3000).catch(() => null);
        const back = await waitStatus('the stand-in to fit again', s => !s.maximized && Math.abs(s.width - pane.w) <= 2 && Math.abs(s.height - pane.h) <= 2, 8000).catch(() => status());
        check(`${label} maximizing itself is undone and it fits the page again`, !!maxed && !back.maximized && Math.abs(back.width - pane.w) <= 2 && Math.abs(back.height - pane.h) <= 2, JSON.stringify(back));

        if (exitAction === 'minimize') {
            await main.eval(`showTab(0)`);
            const hidden = await waitStatus('the stand-in to hide', s => !s.visible, 8000).catch(() => status());
            check('it hides when another page is opened', hidden && !hidden.visible, JSON.stringify(hidden));
            await main.eval(`showTab(38)`);
            const back = await waitStatus('the stand-in to come back', s => s.visible && s.held, 8000).catch(() => status());
            check('it comes back with its page', back?.visible && back?.held, JSON.stringify(back));
        }

        const exited = await closeMain(main);
        check(`${label} HapsHub closes cleanly while holding an app`, exited);
        await sleep(1500);
        const after = status();
        const alive = !!after && !after.closed && processIds('OVR Toolkit.exe').includes(after.pid);
        if (exitAction === 'minimize')
            check(`${label} the app is left running, minimized`, alive && !after.held && after.minimized, JSON.stringify(after));
        else if (exitAction === 'close')
            check(`${label} the app is closed too`, !!after?.closed && !processIds('OVR Toolkit.exe').length, JSON.stringify(after));
        else
            check(`${label} the app is left open as its own window`, alive && !after.held && after.visible && !after.minimized, JSON.stringify(after));
    } finally {
        const last = status();
        if (last?.pid && processIds('OVR Toolkit.exe').includes(last.pid)) killTree(last.pid);
        killTree(main.app.pid);
        await sleep(700);
    }
}

try {
    for (const action of ['minimize', 'close', 'leave']) await run(action);
} catch (error) {
    check('the run finished', false, error.message);
} finally {
    for (const pid of processIds('OVR Toolkit.exe')) killTree(pid);
    await cleanUp(...dirs);
    rmSync(statusFile, { force: true });
}
console.log(state.failures ? `${state.failures} check(s) failed` : `all ${state.passed} checks passed`);
process.exit(state.failures ? 1 : 0);
