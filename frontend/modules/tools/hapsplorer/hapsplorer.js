// Hapsplorer page: the Hapsplorer web UI in a frame, served by the hub's local proxy (Hub/HubHapsplorer.cs)
// on http://127.0.0.1:8790, the same address the standalone Hapsplorer app uses, so bookmarks and the tier
// list are shared. The frame loads the first time the page is opened, not at startup.
// app/ is a copy of Hapsplorer's src/Hapsplorer.Server/wwwroot: refresh it with tools/hapshub/sync-hapsplorer-ui.ps1.
const HAPSPLORER_URL = 'http://127.0.0.1:8790/';

function hapsplorerOpen() {
    const f = document.getElementById('hxFrame');
    if (f && !f.src) f.src = HAPSPLORER_URL;
}
