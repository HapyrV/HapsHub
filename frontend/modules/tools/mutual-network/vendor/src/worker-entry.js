// Layout worker, the same steps as VRCX's Mutual Friends chart: random disc start, ForceAtlas2, then noverlap.
import Graph from 'graphology';
import forceAtlas2 from 'graphology-layout-forceatlas2';
import noverlap from 'graphology-layout-noverlap';

const clamp = (value, min, max) => Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
const lerp = (a, b, t) => a + (b - a) * t;

function jitter(graph, amount) {
    graph.forEachNode((node, at) => {
        if (!Number.isFinite(at.x) || !Number.isFinite(at.y)) return;
        graph.mergeNodeAttributes(node, { x: at.x + (Math.random() - 0.5) * amount, y: at.y + (Math.random() - 0.5) * amount });
    });
}

function scatter(graph) {
    const radius = Math.max(50, Math.sqrt(graph.order) * 30);
    graph.forEachNode(node => {
        const angle = Math.random() * Math.PI * 2;
        const distance = Math.sqrt(Math.random()) * radius;
        graph.mergeNodeAttributes(node, { x: Math.cos(angle) * distance, y: Math.sin(angle) * distance });
    });
}

function layout({ nodes, edges, settings }) {
    const graph = new Graph({ type: 'undirected', multi: false, allowSelfLoops: false });
    for (const node of nodes) graph.addNode(node.id, node.attributes);
    for (const edge of edges) if (!graph.hasEdge(edge.source, edge.target)) graph.addEdgeWithKey(edge.key, edge.source, edge.target, edge.attributes);
    if (settings.reinitialize) scatter(graph);
    graph.forEachNode((node, at) => {
        if (!Number.isFinite(at.x) || !Number.isFinite(at.y)) graph.mergeNodeAttributes(node, { x: (Math.random() - 0.5) * 100, y: (Math.random() - 0.5) * 100 });
    });
    const iterations = clamp(settings.layoutIterations, 300, 1500);
    const spacing = clamp(settings.layoutSpacing, 8, 240);
    const t = clamp((spacing - 8) / 232, 0, 1);
    const delta = settings.deltaSpacing ?? 0;
    const fa2 = {
        ...forceAtlas2.inferSettings(graph),
        barnesHutOptimize: true,
        barnesHutTheta: 0.8,
        strongGravityMode: true,
        gravity: lerp(1.6, 0.6, t),
        scalingRatio: spacing,
        slowDown: 2,
    };
    if (Math.abs(delta) >= 8) jitter(graph, lerp(0.5, 2, t));
    forceAtlas2.assign(graph, { iterations, settings: fa2 });
    const passes = clamp(Math.round(Math.sqrt(graph.order) * 6), 200, 600);
    noverlap.assign(graph, { maxIterations: passes, settings: { ratio: lerp(1.05, 1.35, t), margin: lerp(1, 8, t) } });
    const positions = {};
    graph.forEachNode((node, at) => { positions[node] = { x: at.x, y: at.y }; });
    return positions;
}

self.addEventListener('message', event => {
    const { requestId } = event.data;
    try { self.postMessage({ requestId, positions: layout(event.data) }); }
    catch (error) { self.postMessage({ requestId, error: error.message }); }
});
