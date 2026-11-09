/* === Mutual Network ===
 * Social graph of your friend circle, drawn the way VRCX's Mutual Friends chart is.
 * Edges = mutual friends. Libraries: vendor/graph-lib.js (graphology, Sigma, Louvain)
 * and vendor/net-layout-worker.js (ForceAtlas2, noverlap), all MIT.
 */

let _netGraph        = null;
let _mutualCache     = {};
let _cacheLoadPending = false;
let _externalNonFriends = {};
let _netShowNonFriends = true;
let _netForceRefetch = false;
const NET_NF_STORAGE_KEY = 'vrcnext_net_nonfriends';
const NET_NF_RGB = { r: 255, g: 138, b: 61, raw: 'rgb(255,138,61)' };

let _netCommunities = false;
let _netCommFilter  = -1;

function _netLoadNonFriends() {
    try {
        const raw = localStorage.getItem(NET_NF_STORAGE_KEY);
        if (!raw) return;
        const obj = JSON.parse(raw) || {};
        for (const k in obj) if (!_externalNonFriends[k]) _externalNonFriends[k] = obj[k];
    } catch { /* ignore */ }
}

function _netSaveNonFriends() {
    try { localStorage.setItem(NET_NF_STORAGE_KEY, JSON.stringify(_externalNonFriends)); } catch { /* ignore */ }
}

_netLoadNonFriends();

function networkAddNonFriend(data) {
    if (!data || !data.userId || !Array.isArray(data.mutualIds) || data.mutualIds.length === 0) return;
    _externalNonFriends[data.userId] = {
        id:          data.userId,
        displayName: data.displayName || data.userId,
        image:       data.image || '',
        mutualIds:   data.mutualIds.slice(),
    };
    _netSaveNonFriends();
    if (_netGraph) _netGraph.addNonFriend(_externalNonFriends[data.userId]);
}

function networkToggleNonFriends(btn) {
    _netShowNonFriends = !_netShowNonFriends;
    if (btn) {
        btn.classList.toggle('active', _netShowNonFriends);
        const ic = btn.querySelector('.msi');
        if (ic) ic.textContent = _netShowNonFriends ? 'visibility' : 'visibility_off';
    }
    if (_netGraph) _netGraph._render();
}

function networkToggleCommunities(btn) {
    _netCommunities = !_netCommunities;
    if (btn) btn.classList.toggle('active', _netCommunities);
    if (!_netCommunities) _netCommFilter = -1;
    if (!_netGraph) return;
    _netGraph._renderCommPanel();
    _netGraph._render();
}

function networkFilterCommunity(rank) {
    _netCommFilter = (_netCommFilter === rank) ? -1 : rank;
    if (!_netGraph) return;
    _netGraph._renderCommPanel();
    _netGraph._render();
}

function networkSetMinScore(value) {
    const val = netSetMinScore(parseFloat(value));
    const out = document.getElementById('netMinScoreVal');
    if (out) out.textContent = val.toFixed(2);
    if (_netGraph) _netGraph._scheduleScores(500);
}

function _netNodeHidden(nd) {
    if (!_netShowNonFriends && nd.isNonFriend) return true;
    if (_netCommFilter >= 0 && nd.comm !== _netCommFilter) return true;
    return false;
}

function networkProgressText(done, total) {
    return tf('network.progress', { done, total }, `Loading connections: ${done} / ${total}`);
}

function initNetwork() {
    const canvas = document.getElementById('netCanvas');
    if (!canvas || !window.HHGraphLib) return;
    if (_netGraph) { _netGraph.resize(); return; }
    _netGraph = new MutualGraph(canvas);

    _cacheLoadPending = true;
    sendToCS({ action: 'vrcLoadMutualCache' });
    netSubCacheLoad('groups');
}

function networkCacheLoaded(json) {
    if (!_cacheLoadPending) return;
    _cacheLoadPending = false;
    _netCacheReady = true;
    try { _mutualCache = JSON.parse(json) || {}; } catch { _mutualCache = {}; }
    if (_netGraph) _netGraph.loadFriends();
}

let _netCacheReady = false;

function netEnsureMutualCache() {
    if (_netGraph || _netCacheReady || _cacheLoadPending) return;
    _cacheLoadPending = true;
    sendToCS({ action: 'vrcLoadMutualCache' });
}

function networkAddMutuals(data) {
    if (!data || !data.userId) return;
    _netMutualSets.delete(data.userId);
    if (_netGraph) { _netGraph.onMutualsReceived(data); return; }
    if (!_netCacheReady) { netEnsureMutualCache(); return; }
    _mutualCache[data.userId] = { mutualIds: data.mutualIds || [], optedOut: !!data.optedOut };
    clearTimeout(_netBgSaveTimer);
    _netBgSaveTimer = setTimeout(() => {
        sendToCS({ action: 'vrcSaveMutualCache', cache: JSON.stringify(_mutualCache) });
    }, 2000);
}

let _netBgSaveTimer = null;

function networkCancel() {
    if (_netGraph) _netGraph.cancelLoading();
}

function networkRefresh() {
    if (_netGraph) _netGraph.destroy();
    _netGraph = null;
    initNetwork();
}

function networkReFetch() {
    _mutualCache = {};
    _netForceRefetch = true;
    _netGroupData = {};
    netResetScoreData();
    sendToCS({ action: 'vrcClearMutualCache' });
    sendToCS({ action: 'vrcClearNetworkCache', name: 'groups' });
    networkRefresh();
}

function networkSearch(value) {
    if (_netGraph) _netGraph.setSearch(value);
}

function networkResetView() {
    if (!_netGraph) return;
    _netGraph.fitView();
    _netGraph._render();
}

/* ── Tab activation ── */
document.documentElement.addEventListener('tabchange', () => {
    const tab15 = document.getElementById('tab15');
    if (tab15 && tab15.classList.contains('active')) {
        initNetwork();
        if (_netGraph) _netGraph.reloadImages();
    } else {
        if (_netGraph) { _netGraph._stopSim(); _netGraph.unloadImages(); }
    }
});

/* ════════════════════════════════════════════════════════
   MutualGraph: the way VRCX's Mutual Friends chart works.
   graphology holds the graph, ForceAtlas2 then noverlap lay it out in a worker,
   Louvain finds the communities that colour it, and Sigma draws it with WebGL.
   A node's size follows its mutual count against the biggest one (4 to 22),
   and nodes grow as you zoom in, with names showing once they're big enough.
   ════════════════════════════════════════════════════════ */
const NET_PALETTE = ['#5470c6', '#91cc75', '#fac858', '#ee6666', '#73c0de', '#3ba272', '#fc8452', '#9a60b4', '#ea7ccc'];
const NET_LAYOUT = { iterations: 800, spacing: 60, curvature: 0.1 };
const NET_LABEL_MAX = 20;
const NET_WORKER_URL = 'modules/tools/mutual-network/vendor/net-layout-worker.js';
// While people are still loading, the picture is rebuilt this often instead of after every answer.
const NET_REBUILD_WHILE_LOADING_MS = 4000;

function _netLabel(name) {
    const text = name || 'Unknown';
    return text.length > NET_LABEL_MAX ? `${text.slice(0, NET_LABEL_MAX)}…` : text;
}

function _netIsDark() {
    const raw = getComputedStyle(document.documentElement).getPropertyValue('--bg-base').trim();
    const probe = document.createElement('span');
    probe.style.color = raw || '#000';
    document.body.appendChild(probe);
    const rgb = (getComputedStyle(probe).color.match(/\d+(\.\d+)?/g) || [0, 0, 0]).map(Number);
    probe.remove();
    return (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255 < 0.5;
}

class MutualGraph {
    constructor(container) {
        this.container = container;
        this.nodes   = [];
        this.edges   = [];
        this._edgeSet = new Set();
        this.nodeMap = {};

        this.searchQuery = '';
        this.searchMatch = null;
        this._hovered = null;
        this._neighbors = new Set();

        this.fetchQueue  = [];
        this.fetchDone   = 0;
        this.fetchTotal  = 0;
        this.cancelled   = false;
        this._saveTimer  = null;

        this.graph = null;
        this._sigma = null;
        this._worker = null;
        this._layoutSeq = 0;
        this._layoutWaiting = new Map();
        this._rebuildTimer = null;
        this._rebuilding = false;
        this._rebuildAgain = false;
        this._commList = [];
        this._commReady = false;

        this._resizeObserver = new ResizeObserver(() => this.resize());
        this._resizeObserver.observe(container);
    }

    resize() {
        if (this._sigma) this._sigma.refresh();
        else if (this.graph) this._draw();
    }

    /* ── Load friends as nodes ── */
    loadFriends() {
        if (this._friendsLoaded) return;
        const friends = (typeof vrcFriendsData !== 'undefined') ? vrcFriendsData : [];
        if (friends.length === 0) {
            setTimeout(() => { if (_netGraph === this) this.loadFriends(); }, 800);
            return;
        }
        this._friendsLoaded = true;
        this._friendIds = new Set(friends.map(f => f.id));
        friends.forEach(f => this._addNode({ id: f.id, displayName: f.displayName || f.id, status: f.status || 'offline' }));

        const online  = friends.filter(f => f.status && f.status !== 'offline');
        const offline = friends.filter(f => !f.status || f.status === 'offline');
        this.fetchQueue = [...online, ...offline].map(f => f.id);
        this.fetchTotal = this.fetchQueue.length;
        this.fetchDone  = 0;
        this.cancelled  = false;

        Object.values(_externalNonFriends).forEach(nf => this.addNonFriend(nf));

        if (_netForceRefetch) {
            Object.keys(_externalNonFriends).forEach(id => {
                if (this.nodeMap[id] !== undefined && !this.fetchQueue.includes(id)) this.fetchQueue.push(id);
            });
            _netForceRefetch = false;
            this.fetchTotal = this.fetchQueue.length;
        }

        this._updateProgress();
        this._startFetching();
    }

    addNonFriend(nf) {
        if (!this._friendsLoaded || !nf || !Array.isArray(nf.mutualIds)) return;

        if (this._friendIds && this._friendIds.has(nf.id)) {
            if (_externalNonFriends[nf.id]) { delete _externalNonFriends[nf.id]; _netSaveNonFriends(); }
            const fIdx = this.nodeMap[nf.id];
            if (fIdx !== undefined) this.nodes[fIdx].isNonFriend = false;
            return;
        }

        const mutualIdxs = nf.mutualIds.map(id => this.nodeMap[id]).filter(ix => ix !== undefined);
        if (mutualIdxs.length === 0) return;

        let idx = this.nodeMap[nf.id];
        if (idx === undefined) idx = this._addNode({ id: nf.id, displayName: nf.displayName || nf.id, status: 'offline' });
        this.nodes[idx].isNonFriend = true;

        let changed = false;
        mutualIdxs.forEach(bIdx => { if (this._link(idx, bIdx)) changed = true; });
        if (changed) this._scheduleRebuild();
    }

    _addNode(opts) {
        const idx = this.nodes.length;
        this.nodes.push({ id: opts.id, displayName: opts.displayName, status: opts.status || 'offline' });
        this.nodeMap[opts.id] = idx;
        return idx;
    }

    _link(aIdx, bIdx) {
        if (aIdx === bIdx) return false;
        const key = aIdx < bIdx ? `${aIdx},${bIdx}` : `${bIdx},${aIdx}`;
        if (this._edgeSet.has(key)) return false;
        this._edgeSet.add(key);
        this.edges.push({ a: aIdx, b: bIdx });
        return true;
    }

    // Pictures aren't drawn: like VRCX, people are coloured dots.
    unloadImages() {}
    reloadImages() {}

    /* ── Fetching mutuals (with cache) ── */
    _startFetching() {
        const toFetch = [];
        this.fetchQueue.forEach(uid => {
            if (_mutualCache[uid] !== undefined) {
                this._applyMutuals(uid, _mutualCache[uid].mutualIds, _mutualCache[uid].optedOut);
                this.fetchDone++;
            } else {
                toFetch.push(uid);
            }
        });
        this.fetchQueue = toFetch;

        this._updateProgress();
        if (this.fetchQueue.length === 0) {
            this._hideProgress();
            this._rebuildNow();
            return;
        }
        this._rebuildNow();
        this._fetchBatch();
    }

    _fetchBatch() {
        if (this.cancelled || this.fetchQueue.length === 0) {
            this._hideProgress();
            return;
        }
        const batch = this.fetchQueue.splice(0, 3);
        batch.forEach(uid => {
            if (typeof sendToCS === 'function') sendToCS({ action: 'vrcGetMutualsForNetwork', userId: uid });
        });
        setTimeout(() => this._fetchBatch(), 350);
    }

    _applyMutuals(userId, mutualIds, optedOut) {
        const aIdx = this.nodeMap[userId];
        if (aIdx === undefined || optedOut || !Array.isArray(mutualIds)) return;
        let changed = false;
        mutualIds.forEach(bid => {
            const bIdx = this.nodeMap[bid];
            if (bIdx !== undefined && this._link(aIdx, bIdx)) changed = true;
        });
        if (changed) this._scheduleRebuild();
    }

    onMutualsReceived(data) {
        if (_externalNonFriends[data.userId]) {
            _externalNonFriends[data.userId].mutualIds = data.optedOut ? [] : (data.mutualIds || []);
            _netSaveNonFriends();
            this.fetchDone++;
            this.addNonFriend(_externalNonFriends[data.userId]);
            this._updateProgress();
            if (this.fetchDone >= this.fetchTotal) { this._hideProgress(); this._rebuildNow(); }
            return;
        }

        _mutualCache[data.userId] = { mutualIds: data.mutualIds || [], optedOut: !!data.optedOut };
        clearTimeout(this._saveTimer);
        this._saveTimer = setTimeout(() => {
            sendToCS({ action: 'vrcSaveMutualCache', cache: JSON.stringify(_mutualCache) });
        }, 1500);

        this.fetchDone++;
        this._applyMutuals(data.userId, data.mutualIds, data.optedOut);
        this._updateProgress();
        if (this.fetchDone >= this.fetchTotal) { this._hideProgress(); this._rebuildNow(); }
    }

    cancelLoading() {
        this.cancelled = true;
        clearTimeout(this._saveTimer);
        this._hideProgress();
        this._rebuildNow();
    }

    /* ── Progress ── */
    _updateProgress() {
        const bar  = document.getElementById('netProgress');
        const text = document.getElementById('netProgressText');
        if (!bar) return;
        if (this.fetchTotal === 0) { bar.style.display = 'none'; return; }
        bar.style.display = 'flex';
        if (text) text.textContent = networkProgressText(this.fetchDone, this.fetchTotal);
    }
    _hideProgress() {
        const bar = document.getElementById('netProgress');
        if (bar) bar.style.display = 'none';
    }

    /* ── Building the graph ── */
    _scheduleRebuild() {
        if (this._rebuildTimer) return;
        this._rebuildTimer = setTimeout(() => { this._rebuildTimer = null; this._rebuild(); }, NET_REBUILD_WHILE_LOADING_MS);
    }

    _rebuildNow() {
        clearTimeout(this._rebuildTimer);
        this._rebuildTimer = null;
        this._rebuild();
    }

    async _rebuild() {
        if (this._destroyed) return;
        if (this._rebuilding) { this._rebuildAgain = true; return; }
        this._rebuilding = true;
        try {
            const graph = this._buildGraph();
            if (graph.order > 1) {
                await this._layout(graph, !this.graph);
                this._colourCommunities(graph);
                graph.forEachEdge(edge => graph.mergeEdgeAttributes(edge, { curvature: NET_LAYOUT.curvature, type: 'curve' }));
            }
            if (this._destroyed) return;
            this.graph = graph;
            this._draw();
        } catch (error) {
            console.error('[MutualNetwork] Building the graph failed', error);
        } finally {
            this._rebuilding = false;
            if (this._rebuildAgain && !this._destroyed) { this._rebuildAgain = false; this._rebuild(); }
        }
    }

    _buildGraph() {
        const { Graph } = window.HHGraphLib;
        const graph = new Graph({ type: 'undirected', multi: false, allowSelfLoops: false });
        const degree = new Int32Array(this.nodes.length);
        this.edges.forEach(e => { degree[e.a]++; degree[e.b]++; });
        let most = 0;
        for (let i = 0; i < degree.length; i++) if (degree[i] > most) most = degree[i];
        const old = this.graph;

        this.nodes.forEach((nd, i) => {
            const attrs = {
                label: _netLabel(nd.displayName),
                fullName: nd.displayName || nd.id,
                size: 4 + (most ? (degree[i] / most) * 18 : 0),
                type: 'border',
                mutuals: degree[i],
                nonFriend: !!nd.isNonFriend,
                borderColor: nd.isNonFriend ? NET_NF_RGB.raw : '#f2f2f2',
            };
            // Keeps where people already were, so a rebuild while loading doesn't throw the picture around.
            if (old && old.hasNode(nd.id)) {
                const at = old.getNodeAttributes(nd.id);
                attrs.x = at.x; attrs.y = at.y;
            }
            graph.addNode(nd.id, attrs);
        });
        this.edges.forEach(e => {
            const a = this.nodes[e.a].id, b = this.nodes[e.b].id;
            const [s, t] = a < b ? [a, b] : [b, a];
            const key = `${s}__${t}`;
            if (!graph.hasEdge(key)) graph.addEdgeWithKey(key, s, t, { size: 0.75 });
        });
        // Newcomers start beside the people they know.
        graph.forEachNode((id, at) => {
            if (Number.isFinite(at.x)) return;
            let x = 0, y = 0, n = 0;
            graph.forEachNeighbor(id, (_, nb) => { if (Number.isFinite(nb.x)) { x += nb.x; y += nb.y; n++; } });
            if (n) graph.mergeNodeAttributes(id, { x: x / n + (Math.random() - 0.5) * 20, y: y / n + (Math.random() - 0.5) * 20 });
        });
        return graph;
    }

    _layout(graph, reinitialize) {
        if (!this._worker) {
            this._worker = new Worker(NET_WORKER_URL);
            this._worker.addEventListener('message', event => {
                const waiting = this._layoutWaiting.get(event.data.requestId);
                if (!waiting) return;
                this._layoutWaiting.delete(event.data.requestId);
                if (event.data.error) waiting.reject(new Error(event.data.error));
                else waiting.resolve(event.data.positions);
            });
        }
        const nodes = [];
        graph.forEachNode((id, attributes) => nodes.push({ id, attributes: { x: attributes.x, y: attributes.y } }));
        const edges = [];
        graph.forEachEdge((key, _, source, target) => edges.push({ key, source, target, attributes: {} }));
        const requestId = ++this._layoutSeq;
        return new Promise((resolve, reject) => {
            this._layoutWaiting.set(requestId, { resolve, reject });
            this._worker.postMessage({
                requestId, nodes, edges,
                settings: { layoutIterations: NET_LAYOUT.iterations, layoutSpacing: NET_LAYOUT.spacing, deltaSpacing: 0, reinitialize },
            });
        }).then(positions => {
            for (const [id, at] of Object.entries(positions)) if (graph.hasNode(id)) graph.mergeNodeAttributes(id, { x: at.x, y: at.y });
        });
    }

    _colourCommunities(graph) {
        const found = window.HHGraphLib.louvain(graph);
        const members = new Map();
        graph.forEachNode(id => {
            const c = found[id];
            if (!members.has(c)) members.set(c, []);
            members.get(c).push(id);
        });
        // Biggest community first, so the colours and the list stay in the same order.
        const ordered = [...members.entries()].sort((a, b) => b[1].length - a[1].length || String(a[0]).localeCompare(String(b[0])));
        const list = [];
        ordered.forEach(([, ids], rank) => {
            const color = NET_PALETTE[rank % NET_PALETTE.length];
            let hub = ids[0];
            ids.forEach(id => {
                graph.mergeNodeAttributes(id, { community: rank, color });
                if (graph.degree(id) > graph.degree(hub)) hub = id;
                const idx = this.nodeMap[id];
                if (idx !== undefined) this.nodes[idx].comm = ids.length > 1 ? rank : -1;
            });
            if (ids.length > 1) list.push({ rank, name: graph.getNodeAttribute(hub, 'fullName'), count: ids.length, color });
        });
        this._commList = list;
        this._commReady = true;
        if (_netCommFilter >= list.length) _netCommFilter = -1;
        this._renderCommPanel();
    }

    /* ── Drawing ── */
    _theme() {
        const dark = _netIsDark();
        return {
            label: dark ? '#e2e8f0' : '#111827',
            edge: dark ? '#334155' : '#94a3b8',
            edgeLit: dark ? '#bac1c9' : '#0f172a',
            faded: dark ? 'rgba(148,163,184,0.04)' : 'rgba(100,116,139,0.06)',
            font: getComputedStyle(document.body).fontFamily || 'sans-serif',
        };
    }

    _draw() {
        if (!this.graph || !this.container.offsetWidth) return;
        const { Sigma, EdgeCurveProgram, createNodeBorderProgram } = window.HHGraphLib;
        const theme = this._theme();
        this._colors = theme;
        if (this._sigma) {
            this._sigma.setGraph(this.graph);
            this._sigma.setSetting('labelColor', { color: theme.label });
            this._sigma.setSetting('defaultEdgeColor', theme.edge);
        } else {
            const BorderProgram = createNodeBorderProgram({
                borders: [
                    { size: { value: 0.1 }, color: { attribute: 'borderColor' } },
                    { size: { fill: true }, color: { attribute: 'color' } },
                ],
            });
            this._sigma = new Sigma(this.graph, this.container, {
                allowInvalidContainer: true,
                renderLabels: true,
                labelRenderedSizeThreshold: 10,
                labelColor: { color: theme.label },
                labelFont: theme.font,
                defaultEdgeColor: theme.edge,
                zIndex: true,
                defaultNodeType: 'border',
                nodeProgramClasses: { border: BorderProgram },
                edgeProgramClasses: { curve: EdgeCurveProgram },
                defaultDrawNodeHover: (ctx, data, settings) => this._drawHover(ctx, data, settings),
            });
            this._bindEvents();
            this._sigma.getCamera().animatedReset({ duration: 0 });
        }
        this._sigma.setSetting('nodeReducer', (id, data) => this._reduceNode(id, data));
        this._sigma.setSetting('edgeReducer', (id, data) => this._reduceEdge(id, data));
        this._sigma.refresh();
    }

    _render() {
        if (this._sigma) this._sigma.refresh();
    }

    // The highlighted person: the one under the mouse, or else the one found by search.
    _focus() {
        return this._hovered || this.searchMatch;
    }

    _reduceNode(id, data) {
        const out = { ...data };
        const idx = this.nodeMap[id];
        if (idx !== undefined && _netNodeHidden(this.nodes[idx])) { out.hidden = true; return out; }
        const focus = this._focus();
        if (!focus) { out.zIndex = 1; return out; }
        if (id === focus) {
            return { ...out, color: '#facc15', size: (data.size || 4) * 1.6, label: `${data.label} (${this._neighbors.size})`, zIndex: 3, forceLabel: true };
        }
        if (this._neighbors.has(id)) return { ...out, size: (data.size || 4) * 1.2, zIndex: 2, forceLabel: this._neighbors.size <= 40 };
        return { ...out, color: this._colors.faded, borderColor: this._colors.faded, size: 0.7, label: '', zIndex: 0 };
    }

    _reduceEdge(id, data) {
        const out = { ...data };
        const [a, b] = this.graph.extremities(id);
        const ia = this.nodeMap[a], ib = this.nodeMap[b];
        if ((ia !== undefined && _netNodeHidden(this.nodes[ia])) || (ib !== undefined && _netNodeHidden(this.nodes[ib]))) {
            out.hidden = true;
            return out;
        }
        const focus = this._focus();
        if (!focus) { out.color = this._colors.edge; return out; }
        if (a === focus || b === focus) { out.color = this._colors.edgeLit; return out; }
        out.hidden = true;
        return out;
    }

    // VRCX's hover card: a white box with the name, readable on any theme.
    _drawHover(ctx, data, settings) {
        if (!data.label) return;
        const size = settings.labelSize ?? 12;
        const font = settings.labelFont ?? 'sans-serif';
        ctx.font = `${size}px ${font}`;
        ctx.textBaseline = 'middle';
        const width = ctx.measureText(data.label).width + 12;
        const height = size + 8;
        const x = data.x + data.size - 5, y = data.y - height / 2;
        ctx.shadowColor = 'rgba(0, 0, 0, 0.25)';
        ctx.shadowBlur = 6;
        ctx.shadowOffsetY = 2;
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(x, y, width, height);
        ctx.shadowBlur = 0;
        ctx.shadowColor = 'transparent';
        ctx.fillStyle = '#111827';
        ctx.fillText(data.label, x + 6, y + height / 2);
    }

    _setFocus(id) {
        this._neighbors = id && this.graph && this.graph.hasNode(id) ? new Set(this.graph.neighbors(id)) : new Set();
        if (this._sigma) {
            this._sigma.setSetting('labelRenderedSizeThreshold', id ? 0 : 10);
            this._sigma.refresh();
        }
    }

    _bindEvents() {
        const sigma = this._sigma;
        sigma.on('enterNode', ({ node }) => { this._hovered = node; this._setFocus(node); });
        sigma.on('leaveNode', () => { this._hovered = null; this._setFocus(this.searchMatch); });
        sigma.on('clickNode', ({ node }) => {
            if (this.searchQuery) this._clearSearch();
            if (typeof openFriendDetail === 'function') openFriendDetail(node);
        });
    }

    /** The person under the mouse, for the right-click menu. */
    nodeAtPointer() {
        return this._hovered;
    }

    /* ── Search and view ── */
    setSearch(value) {
        const q = (value || '').trim().toLowerCase();
        this.searchQuery = q;
        let best = null, bestStarts = false;
        if (q) {
            for (const nd of this.nodes) {
                if (_netNodeHidden(nd)) continue;
                const name = (nd.displayName || '').toLowerCase();
                if (!name.includes(q)) continue;
                const starts = name.startsWith(q);
                if (best === null || (starts && !bestStarts)) { best = nd.id; bestStarts = starts; }
                if (starts) break;
            }
        }
        this.searchMatch = best;
        this._setFocus(this._focus());
        if (best && this._sigma && this.graph?.hasNode(best)) {
            const at = this._sigma.getNodeDisplayData(best);
            if (at) this._sigma.getCamera().animate({ x: at.x, y: at.y, ratio: 0.15 }, { duration: 300 });
        }
    }

    _clearSearch() {
        this.searchQuery = '';
        this.searchMatch = null;
        const inp = document.getElementById('netSearchInput');
        if (inp) inp.value = '';
        this._setFocus(this._hovered);
    }

    fitView() {
        if (this._sigma) this._sigma.getCamera().animatedReset({ duration: 300 });
    }

    /* ── Communities panel ── */
    _renderCommPanel() {
        const el = document.getElementById('netCommPanel');
        if (!el) return;
        const list = this._commList || [];
        if (!_netCommunities || !this._commReady || !list.length) {
            el.style.display = 'none';
            return;
        }
        if (el.dataset.built !== '1') {
            el.innerHTML =
                  `<div class="net-comm-head"><span>${esc(t('network.communities', 'Communities'))}</span>`
                + `<span id="netCommCount"></span></div>`
                + `<div class="net-comm-list" id="netCommList"></div>`
                + `<div class="net-comm-hint"><span class="net-comm-hint-dots"><i></i><i></i></span>`
                + `<span>${esc(t('network.comm_hint', 'Bigger dot = more mutual friends'))}</span></div>`;
            el.dataset.built = '1';
        }
        const only = t('network.comm_only', 'Show only this community');
        const all  = t('network.comm_all', 'Show all communities');
        const rows = list.map(c => {
            const on = _netCommFilter === c.rank;
            return `<button type="button" class="net-comm-row${on ? ' active' : ''}" onclick="networkFilterCommunity(${c.rank})" title="${esc(on ? all : only)}">`
                 + `<span class="net-comm-dot" style="background:${c.color};"></span>`
                 + `<span class="net-comm-name">${esc(c.name)}</span>`
                 + `<span class="net-comm-count">${c.count}</span></button>`;
        }).join('');
        const cnt = document.getElementById('netCommCount');
        if (cnt) cnt.textContent = list.length;
        const box = document.getElementById('netCommList');
        if (box) box.innerHTML = rows;
        el.style.display = 'flex';
    }

    // Connection scores aren't part of VRCX's picture, so these have nothing to do here.
    _scheduleScores() {}
    onSessionDataReady() {}
    onGroupDataReady() {}
    _updateScoreCard() {}
    _stopSim() {}

    destroy() {
        this._destroyed = true;
        clearTimeout(this._rebuildTimer);
        if (typeof netStopGroupFetch === 'function') netStopGroupFetch();
        this.cancelled = true;
        clearTimeout(this._saveTimer);
        this._hideProgress();
        this._resizeObserver?.disconnect();
        this._sigma?.kill();
        this._sigma = null;
        this._worker?.terminate();
        this._worker = null;
        for (const waiting of this._layoutWaiting.values()) waiting.reject(new Error('closed'));
        this._layoutWaiting.clear();
        this.container.replaceChildren();
    }
}

function rerenderNetworkTranslations() {
    if (!_netGraph) return;
    const panel = document.getElementById('netCommPanel');
    if (panel) panel.dataset.built = '';
    _netGraph._updateProgress();
    _netGraph._renderCommPanel();
    _netGraph._updateScoreCard();
}

document.documentElement.addEventListener('languagechange', rerenderNetworkTranslations);
