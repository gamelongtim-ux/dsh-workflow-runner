// The four graphs of a Dynamic Workflow, drawn.
//
// The engine's compile step produces four views of the same script:
//
//   site         what the script does — the sites and the data between them
//   causality    what happens before what, and in which lane
//   control flow  where execution can go next
//   hand-off     who takes part in each phase
//
// They share a vocabulary of nodes and edges, so the site graph and the
// control-flow graph share a renderer. The causality graph is a table — it is
// a QUESTION ("what happens before what") and a table answers it better than
// a picture — and the hand-off graph is a list of participants.
//
// The data carries no coordinates: a node knows its id, its kind and, for the
// sites, where it is in the source. So the layout is computed: a node's
// horizontal position is how many edges deep it is, and its vertical position
// is its order among its peers.

const KIND_COLORS = {
  source: '#64748b',
  entry: '#64748b',
  sink: '#64748b',
  ask: '#3b82f6',
  world: '#0d9488',
  report: '#f59e0b',
  artifact: '#10b981',
  phase: '#8b5cf6',
  mark: '#8b5cf6',
  default: '#475569',
};

const NODE_W = 168;
const NODE_H = 46;
const GAP_X = 72;
const GAP_Y = 22;
const PAD = 26;

function colorFor(kind) {
  return KIND_COLORS[kind] || KIND_COLORS.default;
}

function el(tag, attrs = {}, text) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * Lay the nodes out by how deep they are in the edge graph.
 *
 * @param {Array<object>} nodes
 * @param {Array<object>} edges
 * @returns {Map<string, {x: number, y: number, level: number}>}
 */
function layout(nodes, edges) {
  const ids = new Set(nodes.map((n) => n.id));
  const incoming = new Map();
  const outgoing = new Map();
  for (const id of ids) { incoming.set(id, []); outgoing.set(id, []); }
  for (const e of edges) {
    if (!ids.has(e.from) || !ids.has(e.to)) continue;
    outgoing.get(e.from).push(e.to);
    incoming.get(e.to).push(e.from);
  }

  const level = new Map();
  const roots = nodes.filter((n) => incoming.get(n.id).length === 0).map((n) => n.id);
  const queue = [];
  for (const id of roots) { level.set(id, 0); queue.push(id); }
  // A cycle with no root would leave nodes unplaced; give them level 0 too.
  for (const n of nodes) if (!level.has(n.id)) { level.set(n.id, 0); queue.push(n.id); }

  let guard = 0;
  while (queue.length > 0 && guard < 10000) {
    guard += 1;
    const id = queue.shift();
    for (const next of outgoing.get(id)) {
      const want = level.get(id) + 1;
      if (!level.has(next) || (level.get(next) < want && !roots.includes(next))) {
        level.set(next, Math.max(level.get(next) ?? 0, want));
        queue.push(next);
      }
    }
  }

  const byLevel = new Map();
  for (const n of nodes) {
    const l = level.get(n.id) ?? 0;
    if (!byLevel.has(l)) byLevel.set(l, []);
    byLevel.get(l).push(n);
  }

  const pos = new Map();
  let maxRows = 1;
  for (const [l, group] of [...byLevel.entries()].sort((a, b) => a[0] - b[0])) {
    group.sort((a, b) => String(a.label || a.id).localeCompare(String(b.label || b.id)));
    group.forEach((n, i) => {
      pos.set(n.id, { x: PAD + l * (NODE_W + GAP_X), y: PAD + i * (NODE_H + GAP_Y), level: l });
    });
    maxRows = Math.max(maxRows, group.length);
  }
  return { pos, levels: byLevel.size, rows: maxRows };
}

/**
 * Draw a node/edge graph.
 *
 * @param {object} graph - { nodes, edges }
 * @param {string} title
 * @returns {SVGElement}
 */
function drawNodeGraph(graph, title) {
  const nodes = graph.nodes || [];
  const edges = graph.edges || [];
  const { pos, levels, rows } = layout(nodes, edges);
  const width = PAD * 2 + levels * NODE_W + (levels - 1) * GAP_X;
  const height = PAD * 2 + rows * NODE_H + (rows - 1) * GAP_Y;

  const svg = el('svg', {
    class: 'graph-svg',
    viewBox: `0 0 ${Math.max(width, 240)} ${Math.max(height, 120)}`,
    width: '100%',
    preserveAspectRatio: 'xMinYMin meet',
  });

  const defs = el('defs');
  const marker = el('marker', {
    id: 'graph-arrow', viewBox: '0 0 10 10', refX: '9', refY: '5',
    markerWidth: '6', markerHeight: '6', orient: 'auto-start-reverse',
  });
  marker.appendChild(el('path', { d: 'M 0 0 L 10 5 L 0 10 z', fill: '#94a3b8' }));
  defs.appendChild(marker);
  svg.appendChild(defs);

  // Edges first, so the nodes sit on top of them.
  const edgeLabels = [];
  for (const e of edges) {
    const a = pos.get(e.from);
    const b = pos.get(e.to);
    if (!a || !b) continue;
    const x1 = a.x + NODE_W;
    const y1 = a.y + NODE_H / 2;
    const x2 = b.x;
    const y2 = b.y + NODE_H / 2;
    const mid = (x1 + x2) / 2;
    svg.appendChild(el('path', {
      d: `M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`,
      fill: 'none',
      stroke: e.exact === false ? '#cbd5e1' : '#94a3b8',
      'stroke-width': e.exact === false ? '1.5' : '2',
      'stroke-dasharray': e.exact === false ? '4 3' : 'none',
      'marker-end': 'url(#graph-arrow)',
    }));
    if (e.kind && e.kind !== 'next') {
      edgeLabels.push({ x: mid, y: (y1 + y2) / 2 - 7, text: String(e.type || e.kind).slice(0, 18) });
    }
  }

  for (const n of nodes) {
    const p = pos.get(n.id);
    if (!p) continue;
    const g = el('g', { class: 'graph-node' });
    g.appendChild(el('rect', {
      x: p.x, y: p.y, width: NODE_W, height: NODE_H, rx: 9,
      fill: '#0f172a', stroke: colorFor(n.kind), 'stroke-width': '1.6',
    }));
    g.appendChild(el('rect', {
      x: p.x, y: p.y, width: 4, height: NODE_H, rx: 2,
      fill: colorFor(n.kind),
    }));
    g.appendChild(el('text', {
      x: p.x + 14, y: p.y + 20, class: 'graph-node-label',
    }, String(n.label || n.id).slice(0, 26)));
    if (n.kind && n.kind !== 'source' && n.kind !== 'entry') {
      g.appendChild(el('text', {
        x: p.x + 14, y: p.y + 36, class: 'graph-node-kind',
      }, n.kind));
    }
    svg.appendChild(g);
  }

  // The edge labels go on LAST: a long label can be wider than the gap
  // between two nodes, and a node drawn over it would cut it in half.
  for (const label of edgeLabels) {
    svg.appendChild(el('text', {
      x: label.x, y: label.y, 'text-anchor': 'middle',
      class: 'graph-edge-label', stroke: '#0f1115', 'stroke-width': '3',
      'paint-order': 'stroke',
    }, label.text));
  }

  svg.dataset.title = title;
  return svg;
}

/**
 * The causality graph as a table: one row per step, with the lane it runs in,
 * the phase it belongs to, and what it hands to.
 *
 * @param {object} graph
 * @returns {HTMLElement}
 */
function drawCausality(graph) {
  const wrap = document.createElement('div');
  const steps = graph.steps || [];
  if (steps.length === 0) {
    wrap.className = 'muted';
    wrap.textContent = 'No steps.';
    return wrap;
  }
  const laneName = new Map((graph.lanes || []).map((l) => [l.id, l.name]));
  const phaseName = new Map((graph.phases || []).map((p) => [p.id, p.name]));
  const out = new Map();
  for (const e of graph.edges || []) {
    if (!out.has(e.from)) out.set(e.from, []);
    out.get(e.from).push(e.to);
  }

  const table = document.createElement('table');
  table.className = 'graph-table';
  const head = table.createTHead().insertRow();
  for (const h of ['step', 'lane', 'phase', 'certainty', 'hands to']) {
    const th = document.createElement('th');
    th.textContent = h;
    head.appendChild(th);
  }
  const body = table.createTBody();
  for (const s of steps) {
    const row = body.insertRow();
    const label = s.label ? `${s.label} (${s.kind})` : s.kind;
    row.insertCell().textContent = label + (s.loc ? ` :${s.loc.line}` : '');
    row.insertCell().textContent = laneName.get(s.lane) || s.lane || '—';
    row.insertCell().textContent = phaseName.get(s.phase) || '—';
    row.insertCell().textContent = s.certainty || '—';
    row.insertCell().textContent = (out.get(s.id) || []).join(', ') || '—';
  }
  wrap.appendChild(table);
  return wrap;
}

/**
 * The hand-off graph as a list of participants.
 *
 * @param {object} graph
 * @param {Map<string, string>} laneNames - lane id → the actor's name
 * @returns {HTMLElement}
 */
function drawHandoff(graph, laneNames) {
  const wrap = document.createElement('div');
  const participants = graph.participants || [];
  if (participants.length === 0) {
    wrap.className = 'muted';
    wrap.textContent = 'No hand-offs: this workflow keeps every step in one lane.';
    return wrap;
  }
  const list = document.createElement('div');
  list.className = 'graph-participants';
  for (const p of participants) {
    const row = document.createElement('div');
    row.className = 'graph-participant';
    const name = document.createElement('span');
    name.className = 'graph-participant-name';
    name.textContent = laneNames.get(p.lane) || p.lane || p.id;
    const steps = document.createElement('span');
    steps.className = 'graph-participant-steps';
    steps.textContent = (p.steps || []).join(', ');
    row.appendChild(name);
    row.appendChild(steps);
    list.appendChild(row);
  }
  wrap.appendChild(list);
  return wrap;
}

/**
 * Render the four graphs into a container.
 *
 * The container is emptied first, so a re-render replaces what was there.
 *
 * @param {HTMLElement} container
 * @param {object|null} graphs - the engine's graphs, or null
 */
export function renderGraphs(container, graphs) {
  if (!container) return;
  // The editor re-renders on every state poll, so the tab the user is
  // looking at has to survive the re-render — otherwise it snaps back to
  // the first view every second.
  const previousTab = container.dataset.graphTab || 'site';
  container.innerHTML = '';
  if (!graphs) {
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.textContent =
      'No analysis for this run. A run on the engine path is compiled before it runs, ' +
      'and its four graphs show up here. A run on the child-process path has no ' +
      'compile step, so it has none.';
    container.appendChild(empty);
    return;
  }

  const tabs = document.createElement('div');
  tabs.className = 'graph-tabs';

  const panels = document.createElement('div');
  panels.className = 'graph-panels';

  // The lanes of the hand-off graph are actor ids; the site graph knows
  // their names, so the list can show a name instead of an id.
  const laneNames = new Map();
  for (const actor of (graphs.site && graphs.site.actors) || []) {
    if (actor && actor.id) laneNames.set(actor.id, actor.name || actor.id);
  }

  const views = [
    { key: 'site', label: 'Site', build: () => drawNodeGraph(graphs.site || { nodes: [], edges: [] }, 'Site') },
    { key: 'causality', label: 'Causality', build: () => drawCausality(graphs.causality || {}) },
    { key: 'controlFlow', label: 'Control flow', build: () => drawNodeGraph(graphs.controlFlow || { nodes: [], edges: [] }, 'Control flow') },
    { key: 'handoff', label: 'Hand-off', build: () => drawHandoff(graphs.handoff || {}, laneNames) },
  ];

  views.forEach((view) => {
    const btn = document.createElement('button');
    btn.className = 'graph-tab';
    btn.dataset.graphKey = view.key;
    btn.textContent = view.label;
    btn.dataset.graphKey = view.key;
    const panel = document.createElement('div');
    panel.className = 'graph-panel';
    panel.dataset.graphKey = view.key;
    panel.appendChild(view.build());
    btn.addEventListener('click', () => {
      for (const b of tabs.children) b.classList.toggle('active', b === btn);
      for (const p of panels.children) p.hidden = p !== panel;
      container.dataset.graphTab = view.key;
  });
    tabs.appendChild(btn);
    panels.appendChild(panel);
  });

  // Restore the tab that was open before this re-render.
  const wanted = views.findIndex((v) => v.key === previousTab);
  const active = wanted === -1 ? 0 : wanted;
  for (const [i, b] of [...tabs.children].entries()) b.classList.toggle('active', i === active);
  for (const [i, p] of [...panels.children].entries()) p.hidden = (i !== active);

  const sizes = graphs.sizes || {};
  const legend = document.createElement('p');
  legend.className = 'muted graph-legend';
  legend.textContent =
    `site ${sizes.site ?? 0} · causality ${sizes.causality ?? 0} · ` +
    `control flow ${sizes.controlFlow ?? 0} · hand-off ${sizes.handoff ?? 0}`;

  container.appendChild(legend);
  container.appendChild(tabs);
  container.appendChild(panels);
}
