// dsh-workflow-runner —— public/editor.js
//
// Pure-vanilla ES module; no build step. Wires the editor form to /api/* and
// renders live SSE events into the viewer card.
//
// v0.14.0 additions:
//   - A fourth tab, Graphs: the four analysis views the engine's compile step
//     produced (site, causality, control flow, hand-off), drawn by
//     public/graph-view.js.
//   - A `.dwf.ts` script runs on the ENGINE path (compiled first, graphs
//     included); everything else keeps the child-process path.
//
// v0.2.0 additions:
//   - Confirm modal: extracts world.run commands before run start, asks user
//     to approve a subset, sends the approved list as worldRunAllowlist.
//   - 3 tabs in the viewer: Progress (phases/agents/log), Reports, Artifacts.
//   - Artifact renderers: chart (SVG), table, metrics tiles, board (kanban),
//     markdown (minimal subset), file (link to /api/artifact-content).
//   - Phase folding: same-name phase in a loop shows as one pill with ×N.

import { renderGraphs } from './graph-view.js';

const SAMPLES = {
  smoke:       'samples/smoke.mjs',
  planner:     'samples/planner-critic.mjs',
  fanout:      'samples/fanout-summarize.mjs',
  artifact:    'samples/artifact-demo.mjs',
  confirm:     'samples/confirm-demo.mjs',
  loop:        'samples/loop-phases.mjs',
  filegrep:    'samples/file-grep.mjs',
  gitchanged:  'samples/git-changed.mjs',
  channel:     'samples/channel-pipeline.mjs',
  modelrouter: 'samples/model-router.mjs',
  typed:       'samples/typed-plan.mjs',
  askuser:     'samples/ask-user.mjs',
  hole:        'samples/hole-demo.mjs',
  amend:       'samples/amend-demo.mjs',
  models:      'samples/models-list.mjs',
  route:       'samples/route-demo.mjs',
  escalate:    'samples/escalate-demo.mjs',
};

// v0.14.0: the Dynamic Workflow samples — the engine path's authoring
// surface. A `.dwf.ts` script is TypeScript, compiled before it runs, with
// typed asks and the four analysis graphs.
const DWF_SAMPLES = {
  dwfsmoke:     'samples/dwf/smoke.dwf.ts',
  dwfscan:      'samples/dwf/typed-scan.dwf.ts',
  dwfplanner:   'samples/dwf/planner-critic.dwf.ts',
  dwfpipeline:  'samples/dwf/pipeline.dwf.ts',
  dwfhuman:     'samples/dwf/ask-human.dwf.ts',
  dwfroute:     'samples/dwf/route-models.dwf.ts',
};

// dsh mounts this page under a route prefix (default /workflow) and keeps the
// JSON API right beside it, while lib/standalone.js serves the very same page
// at the site root. This module is always served next to the page, so deriving
// the base from its own URL makes both mounts work. Before this, the calls were
// root-absolute ('/api/run'): standalone worked, but under dsh they hit the
// host's own /api gateway and came back 401, leaving Load/Run/Stop dead.
const API_BASE = new URL('.', import.meta.url).pathname.replace(/\/+$/, '');
const api = (path) => API_BASE + '/api' + path;

const $ = (id) => document.getElementById(id);

const els = {
  path: $('scriptPath'),
  loadBtn: $('loadBtn'),
  saveBtn: $('saveBtn'),
  amendFromInput: $('amendFromInput'),
  source: $('scriptSource'),
  runBtn: $('runBtn'),
  stopBtn: $('stopBtn'),
  status: $('runStatus'),
  viewer: $('viewerCard'),
  runIdBadge: $('runIdBadge'),
  phaseBar: $('phaseBar'),
  agentsList: $('agentsList'),
  reportsList: $('reportsList'),
  logView: $('logView'),
  tabBar: $('tabBar'),
  tabPanels: document.querySelectorAll('.tab-panel'),
  artifactsList: $('artifactsList'),
  artifactsEmpty: $('artifactsEmpty'),
  artifactCountBadge: $('artifactCountBadge'),
  // v0.14.0: the four analysis graphs
  graphsList: $('graphsList'),
  // v0.11.0: journal replay trail
  journalTrail: $('journalTrail'),
  journalBadge: $('journalBadge'),
  journalMeta: $('journalMeta'),
  journalList: $('journalList'),
  // confirm modal
  confirmModal: $('confirmModal'),
  confirmCmdList: $('confirmCmdList'),
  confirmCancel: $('confirmCancel'),
  confirmOk: $('confirmOk'),
  // save modal
  saveModal: $('saveModal'),
  saveName: $('saveName'),
  saveDescription: $('saveDescription'),
  saveWhenToUse: $('saveWhenToUse'),
  saveCancel: $('saveCancel'),
  saveOk: $('saveOk'),
  // saved list
  savedList: $('savedList'),
  // snippet
  snippetCode: $('snippetCode'),
  snippetRunBtn: $('snippetRunBtn'),
  snippetStatus: $('snippetStatus'),
  snippetOut: $('snippetOut'),
  // pending questions
  pendingQuestions: $('pendingQuestions'),
  pendingQuestionsList: $('pendingQuestionsList'),
  // pending holes (v0.5.0)
  pendingHoles: $('pendingHoles'),
  pendingHolesList: $('pendingHolesList'),
  // pending escalates (v0.6.0)
  pendingEscalates: $('pendingEscalates'),
  pendingEscalatesList: $('pendingEscalatesList'),
  // v0.7.0: recent runs history
  historyCount: $('historyCount'),
  historyStatus: $('historyStatus'),
  historyList: $('historyList'),
  historyRefresh: $('historyRefresh'),
};

let currentRunId = null;
let currentStream = null;
let pendingRunAllowlist = null; // resolves when user picks a subset in the modal

// ----- helpers -----

const shortRunId = () => currentRunId ? currentRunId.slice(0, 8) : '';

function setStatus(text, klass) {
  els.status.textContent = text;
  els.status.className = 'muted ' + (klass || '');
}

// v0.8.0: render structured TypeScript diagnostics returned by the
// /api/run handler when typecheck fails. The list replaces the
// single-line status; each row shows file:line:col + error code +
// message. The summary line keeps the original error count + header.
function showTypecheckErrors(diagnostics, headerText) {
  const N = diagnostics.length;
  const summary = headerText || `TypeScript typecheck failed (${N} error${N === 1 ? '' : 's'})`;
  setStatus(summary, 'status-error');
  // Render the diagnostics list in the log pane so the user sees
  // them in flow with the rest of the run output. We synthesize a
  // few fake log entries instead of introducing a new DOM region.
  const logView = els.logView;
  logView.innerHTML = '';
  const head = document.createElement('div');
  head.className = 'log-error typecheck-header';
  head.textContent = '── ' + summary + ' ──';
  logView.appendChild(head);
  for (const d of diagnostics) {
    const row = document.createElement('div');
    row.className = 'log-error typecheck-row';
    row.innerHTML = `<strong>${escapeHtml(d.file || '')}:${d.line}:${d.column}</strong> ` +
      `<span class="typecheck-code">${escapeHtml(d.code || '')}</span> ` +
      `<span>${escapeHtml(d.message || '')}</span>`;
    logView.appendChild(row);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function appendLog(line) {
  const span = document.createElement('span');
  const lvl = (line.level || 'info').toLowerCase();
  span.className = 'log-' + lvl;
  const t = new Date(line.at).toISOString().slice(11, 19);
  let body = String(line.message || '');
  if (body.startsWith('[stderr] ')) body = body.slice(9);
  if (body.startsWith('[non-json] ')) body = '⤷ ' + body.slice(11);
  span.textContent = '[' + t + '] ' + body + '\n';
  els.logView.appendChild(span);
  els.logView.scrollTop = els.logView.scrollHeight;
}

// ----- tab switching -----

for (const btn of document.querySelectorAll('.tab')) {
  btn.addEventListener('click', () => {
    const target = btn.dataset.tab;
    for (const t of document.querySelectorAll('.tab')) t.classList.toggle('active', t === btn);
    for (const p of els.tabPanels) p.hidden = (p.dataset.panel !== target);
  });
}

// v0.11.0: journal trail loads on first open, not on every state poll.
els.journalTrail.addEventListener('toggle', () => {
  if (els.journalTrail.open) loadJournal();
});

// ----- confirm modal -----

function showConfirmModal(commands) {
  return new Promise((resolve) => {
    els.confirmCmdList.innerHTML = '';
    for (const cmd of commands) {
      const row = document.createElement('label');
      row.className = 'confirm-row';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = true;
      cb.dataset.cmd = cmd;
      const code = document.createElement('code');
      code.textContent = cmd;
      row.appendChild(cb);
      row.appendChild(code);
      els.confirmCmdList.appendChild(row);
    }
    pendingRunAllowlist = resolve;
    els.confirmModal.hidden = false;
  });
}
function hideConfirmModal() {
  els.confirmModal.hidden = true;
}
els.confirmCancel.addEventListener('click', () => {
  if (pendingRunAllowlist) { const r = pendingRunAllowlist; pendingRunAllowlist = null; r(null); }
  hideConfirmModal();
});
els.confirmOk.addEventListener('click', () => {
  if (!pendingRunAllowlist) return;
  const approved = [];
  for (const cb of els.confirmCmdList.querySelectorAll('input[type=checkbox]')) {
    if (cb.checked) approved.push(cb.dataset.cmd);
  }
  const r = pendingRunAllowlist; pendingRunAllowlist = null; r(approved);
  hideConfirmModal();
});

// ----- phase rendering (folded) -----

function renderPhases(snapshot) {
  els.phaseBar.innerHTML = '';
  // Use phaseSummary (deduped) when present; fall back to phases for
  // back-compat with older runtimes / older snapshots.
  const summary = (snapshot.phaseSummary && snapshot.phaseSummary.length > 0)
    ? snapshot.phaseSummary
    : (snapshot.phases || []).map((p) => ({ name: p.name, firstAt: p.at, lastAt: p.at, count: 1 }));
  for (const p of summary) {
    const div = document.createElement('span');
    div.className = 'phase';
    div.textContent = p.name;
    if (p.count > 1) {
      const c = document.createElement('span');
      c.className = 'count';
      c.textContent = '× ' + p.count;
      div.appendChild(c);
    }
    // v0.12.0: the runtime now stamps an explicit status on every
    // phase node (active | done | error). Prefer it; fall back to the
    // old derivation for runs persisted before v0.12.0, which have no
    // `status` field at all.
    //
    // `pending` is a reserved class: a phase the script never reached
    // is not knowable today, because the facade has no way to declare
    // phases in advance. It is here so a future "declared phases"
    // feature drops straight in.
    if (p.status) {
      div.classList.add(p.status);
    } else {
      if (p.name === snapshot.currentPhase && snapshot.status === 'running') div.classList.add('active');
      if (snapshot.status === 'error' && p.name === snapshot.currentPhase) div.classList.add('error');
      if (snapshot.status === 'completed' || (snapshot.status !== 'running' && p.name !== snapshot.currentPhase)) {
        if (p.name === snapshot.currentPhase || p.lastAt) div.classList.add('done');
      }
    }
    els.phaseBar.appendChild(div);
  }
}

function renderAgents(snapshot) {
  if (!snapshot.agents || snapshot.agents.length === 0) {
    els.agentsList.innerHTML = '<div class="muted">No sub-agents yet.</div>';
    return;
  }
  els.agentsList.innerHTML = '';
  for (const a of snapshot.agents) {
    const item = document.createElement('div');
    item.className = 'item agent-row';
    const stats = a.lastTokens && a.lastTokens.total_tokens
      ? `${a.asks} ask · last ${a.lastTokens.total_tokens} tok · ${a.lastDurationMs}ms`
      : `${a.asks} ask · last ${a.lastDurationMs || '-'}ms`;
    item.innerHTML = `<span class="tag">${escapeHtml(a.model || 'deepseek-chat')}</span>` +
      `<span class="agent-name">${escapeHtml(a.name)}</span>` +
      `<span class="agent-stats">${escapeHtml(stats)}</span>`;
    els.agentsList.appendChild(item);
  }
}

function renderReports(snapshot) {
  if (!snapshot.reports || snapshot.reports.length === 0) {
    els.reportsList.innerHTML = '<div class="muted">No reported items yet.</div>';
    return;
  }
  els.reportsList.innerHTML = '';
  for (const r of snapshot.reports) {
    const item = document.createElement('div');
    item.className = 'item';
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = r.tag || (r.artifactId ? '→ ' + r.artifactId : 'item');
    const summary = renderItem(r.item);
    item.appendChild(tag);
    item.appendChild(summary);
    els.reportsList.appendChild(item);
  }
}

function renderItem(v) {
  const wrap = document.createElement('div');
  if (typeof v === 'string') {
    wrap.textContent = v.length > 240 ? v.slice(0, 240) + '…' : v;
    wrap.style.color = 'var(--muted)';
  } else if (v && typeof v === 'object') {
    wrap.innerHTML = '<pre style="margin:0;white-space:pre-wrap;font-size:12px;color:var(--muted);">' +
      escapeHtml(JSON.stringify(v, null, 2).slice(0, 1200)) +
      (JSON.stringify(v).length > 1200 ? '\n…' : '') +
      '</pre>';
  } else {
    wrap.textContent = String(v);
  }
  return wrap;
}

// ----- artifact rendering -----

function renderArtifacts(snapshot) {
  const list = snapshot.artifacts || [];
  if (list.length === 0) {
    els.artifactsEmpty.hidden = false;
    els.artifactsList.innerHTML = '';
    els.artifactCountBadge.hidden = true;
    return;
  }
  els.artifactsEmpty.hidden = true;
  els.artifactCountBadge.hidden = false;
  els.artifactCountBadge.textContent = String(list.length);
  els.artifactsList.innerHTML = '';
  for (const art of list) {
    const card = document.createElement('div');
    card.className = 'artifact-card' + (art.primary ? ' primary' : '');
    const head = document.createElement('div');
    head.className = 'artifact-head';
    head.innerHTML =
      `<span class="artifact-title">${escapeHtml(art.title || art.id)}</span>` +
      `<span class="artifact-kind">${escapeHtml(art.kind)}</span>` +
      `<span class="artifact-meta">id: ${escapeHtml(art.id)} · v${art.versions.length}</span>`;
    card.appendChild(head);
    if (art.description) {
      const d = document.createElement('div');
      d.className = 'muted';
      d.style.marginBottom = '8px';
      d.textContent = art.description;
      card.appendChild(d);
    }
    try {
      const body = document.createElement('div');
      renderArtifactBody(art, body);
      card.appendChild(body);
    } catch (err) {
      const errBox = document.createElement('div');
      errBox.className = 'muted';
      errBox.textContent = 'render error: ' + String(err.message || err);
      card.appendChild(errBox);
    }
    els.artifactsList.appendChild(card);
  }
}

function renderArtifactBody(art, container) {
  const versions = art.versions || [];
  switch (art.kind) {
    case 'chart':    return renderChart(art, versions, container);
    case 'table':    return renderTable(art, versions, container);
    case 'metrics':  return renderMetrics(art, versions, container);
    case 'board':    return renderBoard(art, versions, container);
    case 'markdown': return renderMarkdown(art, versions, container);
    case 'file':     return renderFile(art, versions, container);
    default: {
      const d = document.createElement('div');
      d.className = 'muted';
      d.textContent = 'unknown artifact kind: ' + art.kind;
      container.appendChild(d);
    }
  }
}

// ---- chart: pure SVG, line / bar / scatter ----
function renderChart(art, versions, container) {
  const spec = art.spec || {};
  const items = versions.map((v) => v.item).filter((x) => x && typeof x === 'object');
  if (items.length === 0) {
    const d = document.createElement('div');
    d.className = 'muted';
    d.textContent = '(no data points yet)';
    container.appendChild(d);
    return;
  }
  const xField = spec.x && spec.x.field;
  const yFieldRaw = spec.y;
  const yFields = Array.isArray(yFieldRaw) ? yFieldRaw : (yFieldRaw ? [yFieldRaw] : []);
  if (!xField || yFields.length === 0) {
    const d = document.createElement('div');
    d.className = 'muted';
    d.textContent = '(chart spec missing x or y field)';
    container.appendChild(d);
    return;
  }
  const type = spec.type || 'line';
  const W = 640, H = 220, PAD = 36;
  const xs = items.map((it) => Number(it[xField])).filter((n) => !Number.isNaN(n));
  const allYs = [];
  for (const yf of yFields) {
    items.map((it) => Number(it[yf.field])).filter((n) => !Number.isNaN(n)).forEach((n) => allYs.push(n));
  }
  const xMin = Math.min(...xs), xMax = Math.max(...xs);
  const yMin = Math.min(...allYs), yMax = Math.max(...allYs);
  const xRange = xMax - xMin || 1;
  const yRange = yMax - yMin || 1;
  const sx = (x) => PAD + ((x - xMin) / xRange) * (W - 2 * PAD);
  const sy = (y) => H - PAD - ((y - yMin) / yRange) * (H - 2 * PAD);
  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('class', 'chart-svg');
  svg.setAttribute('preserveAspectRatio', 'none');

  // grid
  for (let i = 0; i <= 4; i++) {
    const y = PAD + (i / 4) * (H - 2 * PAD);
    const line = document.createElementNS(svgNS, 'line');
    line.setAttribute('class', 'chart-grid');
    line.setAttribute('x1', PAD); line.setAttribute('x2', W - PAD);
    line.setAttribute('y1', y);   line.setAttribute('y2', y);
    svg.appendChild(line);
    const lbl = document.createElementNS(svgNS, 'text');
    lbl.setAttribute('class', 'chart-label');
    lbl.setAttribute('x', 4); lbl.setAttribute('y', y + 4);
    const val = yMax - (i / 4) * yRange;
    lbl.textContent = (yFieldRaw && yFieldRaw.unit) ? val.toFixed(0) + yFieldRaw.unit : val.toFixed(1);
    svg.appendChild(lbl);
  }
  // x axis
  const xAxis = document.createElementNS(svgNS, 'line');
  xAxis.setAttribute('class', 'chart-axis');
  xAxis.setAttribute('x1', PAD); xAxis.setAttribute('x2', W - PAD);
  xAxis.setAttribute('y1', H - PAD); xAxis.setAttribute('y2', H - PAD);
  svg.appendChild(xAxis);

  // baseline (optional)
  if (spec.baseline && spec.baseline.field) {
    const bv = Number(items[items.length - 1][spec.baseline.field]);
    if (!Number.isNaN(bv)) {
      const b = document.createElementNS(svgNS, 'line');
      b.setAttribute('class', 'chart-baseline');
      b.setAttribute('x1', PAD); b.setAttribute('x2', W - PAD);
      b.setAttribute('y1', sy(bv)); b.setAttribute('y2', sy(bv));
      svg.appendChild(b);
    }
  }

  // series
  if (type === 'bar') {
    const barW = Math.max(6, (W - 2 * PAD) / items.length * 0.7);
    items.forEach((it, i) => {
      const x = Number(it[xField]);
      for (const yf of yFields) {
        const y = Number(it[yf.field]);
        if (Number.isNaN(x) || Number.isNaN(y)) continue;
        const rect = document.createElementNS(svgNS, 'rect');
        rect.setAttribute('class', 'chart-bar');
        rect.setAttribute('x', String(sx(x) - barW / 2));
        rect.setAttribute('y', String(sy(y)));
        rect.setAttribute('width', String(barW));
        rect.setAttribute('height', String(H - PAD - sy(y)));
        svg.appendChild(rect);
      }
    });
  } else {
    // line + scatter
    for (const yf of yFields) {
      const pts = items.map((it) => {
        const x = Number(it[xField]), y = Number(it[yf.field]);
        if (Number.isNaN(x) || Number.isNaN(y)) return null;
        return [sx(x), sy(y)];
      }).filter(Boolean);
      if (pts.length === 0) continue;
      if (type !== 'scatter') {
        const path = document.createElementNS(svgNS, 'polyline');
        path.setAttribute('class', 'chart-line');
        path.setAttribute('points', pts.map((p) => p.join(',')).join(' '));
        svg.appendChild(path);
      }
      for (const [px, py] of pts) {
        const dot = document.createElementNS(svgNS, 'circle');
        dot.setAttribute('class', 'chart-dot');
        dot.setAttribute('cx', px); dot.setAttribute('cy', py); dot.setAttribute('r', 3);
        svg.appendChild(dot);
      }
    }
  }
  container.appendChild(svg);

  // x labels (every Nth)
  const labelEvery = Math.max(1, Math.ceil(items.length / 8));
  const xLabels = document.createElement('div');
  xLabels.className = 'muted';
  xLabels.style.fontSize = '11px';
  xLabels.style.marginTop = '4px';
  xLabels.textContent = items.map((it, i) => (i % labelEvery === 0 ? it[xField] : '')).filter(Boolean).join(' · ');
  container.appendChild(xLabels);
}

// ---- table ----
function renderTable(art, versions, container) {
  const spec = art.spec || {};
  const cols = (spec.columns || []).map((c) => c.field || c);
  if (cols.length === 0 && versions.length > 0) {
    // No spec: derive columns from union of all item keys
    const set = new Set();
    for (const v of versions) if (v.item && typeof v.item === 'object') Object.keys(v.item).forEach((k) => set.add(k));
    cols.push(...set);
  }
  if (cols.length === 0) {
    const d = document.createElement('div');
    d.className = 'muted';
    d.textContent = '(table has no columns)';
    container.appendChild(d);
    return;
  }
  // If spec has a key field, latest row with same key replaces earlier one
  let rows = versions.map((v) => v.item);
  if (spec.key) {
    const map = new Map();
    for (const r of rows) if (r && typeof r === 'object') map.set(r[spec.key], r);
    rows = Array.from(map.values());
  }
  const tbl = document.createElement('table');
  tbl.className = 'tbl';
  const thead = document.createElement('thead');
  const trh = document.createElement('tr');
  for (const c of cols) {
    const th = document.createElement('th');
    th.textContent = c;
    trh.appendChild(th);
  }
  thead.appendChild(trh);
  tbl.appendChild(thead);
  const tbody = document.createElement('tbody');
  for (const r of rows) {
    const tr = document.createElement('tr');
    if (spec.key && r && r[spec.key] !== undefined) tr.classList.add('is-key');
    for (const c of cols) {
      const td = document.createElement('td');
      const v = r ? r[c] : '';
      td.textContent = v == null ? '' : (typeof v === 'object' ? JSON.stringify(v) : String(v));
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  tbl.appendChild(tbody);
  container.appendChild(tbl);
}

// ---- metrics: latest item's fields, big number tiles ----
function renderMetrics(art, versions, container) {
  const spec = art.spec || {};
  const tiles = spec.metrics || [];
  if (tiles.length === 0) {
    const d = document.createElement('div');
    d.className = 'muted';
    d.textContent = '(metrics spec missing tiles)';
    container.appendChild(d);
    return;
  }
  const latest = versions[versions.length - 1] && versions[versions.length - 1].item;
  if (!latest) {
    const d = document.createElement('div');
    d.className = 'muted';
    d.textContent = '(no data yet)';
    container.appendChild(d);
    return;
  }
  const wrap = document.createElement('div');
  wrap.className = 'metrics-tiles';
  for (const t of tiles) {
    const f = t.field;
    const v = latest[f];
    const tile = document.createElement('div');
    tile.className = 'metric-tile';
    const lbl = document.createElement('div');
    lbl.className = 'metric-label';
    lbl.textContent = t.label || f;
    const val = document.createElement('div');
    val.className = 'metric-value';
    if (typeof v === 'number') val.textContent = Number.isInteger(v) ? v.toString() : v.toFixed(2);
    else if (v == null) val.textContent = '—';
    else val.textContent = String(v);
    if (t.unit) {
      const u = document.createElement('span');
      u.className = 'metric-unit';
      u.textContent = t.unit;
      val.appendChild(u);
    }
    tile.appendChild(lbl); tile.appendChild(val);
    wrap.appendChild(tile);
  }
  container.appendChild(wrap);
}

// ---- board: kanban columns ----
function renderBoard(art, versions, container) {
  const spec = art.spec || {};
  if (!spec.key) {
    const d = document.createElement('div');
    d.className = 'muted';
    d.textContent = '(board spec missing key)';
    container.appendChild(d);
    return;
  }
  const cols = (spec.columns && spec.columns.length > 0) ? spec.columns : ['todo', 'doing', 'done'];
  const statusField = spec.status || 'status';
  const titleField = spec.cardTitle || spec.key;
  const detailFields = (spec.detail || []).map((d) => d.field || d);
  // latest item with same key wins
  const map = new Map();
  for (const v of versions) if (v.item && v.item[spec.key] !== undefined) map.set(v.item[spec.key], v.item);
  const byCol = new Map();
  for (const c of cols) byCol.set(c, []);
  for (const item of map.values()) {
    const col = item[statusField] || 'other';
    if (!byCol.has(col)) byCol.set(col, []);
    byCol.get(col).push(item);
  }
  const wrap = document.createElement('div');
  wrap.className = 'kanban';
  for (const c of cols) {
    const col = document.createElement('div');
    col.className = 'kanban-col';
    const name = document.createElement('div');
    name.className = 'kanban-col-name';
    name.textContent = c + ' (' + ((byCol.get(c) || []).length) + ')';
    col.appendChild(name);
    for (const item of (byCol.get(c) || [])) {
      const card = document.createElement('div');
      card.className = 'kanban-card';
      const t = document.createElement('div');
      t.className = 'kc-key';
      t.textContent = String(item[titleField] || '(unnamed)');
      card.appendChild(t);
      for (const df of detailFields) {
        const v = item[df];
        if (v == null) continue;
        const d = document.createElement('div');
        d.className = 'kc-detail';
        d.textContent = df + ': ' + (typeof v === 'object' ? JSON.stringify(v) : String(v));
        card.appendChild(d);
      }
      col.appendChild(card);
    }
    wrap.appendChild(col);
  }
  container.appendChild(wrap);
}

// ---- markdown: minimal subset (h1-3, ul, ol, code, pre, **bold**, *italic*, links) ----
function renderMarkdown(art, versions, container) {
  const v = versions[versions.length - 1];
  if (!v || !v.content) {
    const d = document.createElement('div');
    d.className = 'muted';
    d.textContent = '(empty markdown)';
    container.appendChild(d);
    return;
  }
  const html = mdToHtml(v.content);
  const body = document.createElement('div');
  body.className = 'markdown-body';
  body.innerHTML = html;
  container.appendChild(body);
}

function mdToHtml(src) {
  // Minimal markdown -> HTML, line by line. Intentionally small: no nested
  // lists, no tables, no images. Enough for the typical "report" artifact a
  // workflow would publish.
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let inCode = false, codeBuf = [];
  let inUl = false, inOl = false;
  const closeLists = () => { if (inUl) { out.push('</ul>'); inUl = false; } if (inOl) { out.push('</ol>'); inOl = false; } };
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (ln.startsWith('```')) {
      if (inCode) { out.push('<pre><code>' + escapeHtml(codeBuf.join('\n')) + '</code></pre>'); inCode = false; codeBuf = []; }
      else { closeLists(); inCode = true; }
      continue;
    }
    if (inCode) { codeBuf.push(ln); continue; }
    let m;
    if ((m = ln.match(/^(#{1,3})\s+(.*)$/))) {
      closeLists();
      out.push(`<h${m[1].length}>${mdInline(m[2])}</h${m[1].length}>`);
    } else if (/^[-*]\s+/.test(ln)) {
      if (!inUl) { closeLists(); out.push('<ul>'); inUl = true; }
      out.push('<li>' + mdInline(ln.replace(/^[-*]\s+/, '')) + '</li>');
    } else if (/^\d+\.\s+/.test(ln)) {
      if (!inOl) { closeLists(); out.push('<ol>'); inOl = true; }
      out.push('<li>' + mdInline(ln.replace(/^\d+\.\s+/, '')) + '</li>');
    } else if (ln.trim() === '') {
      closeLists();
    } else {
      closeLists();
      out.push('<p>' + mdInline(ln) + '</p>');
    }
  }
  closeLists();
  if (inCode) out.push('<pre><code>' + escapeHtml(codeBuf.join('\n')) + '</code></pre>');
  return out.join('\n');
}
function mdInline(s) {
  return escapeHtml(s)
    .replace(/`([^`]+)`/g, (_, c) => '<code>' + c + '</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
}

// ---- file: link to /api/artifact-content ----
function renderFile(art, versions, container) {
  if (versions.length === 0) {
    const d = document.createElement('div');
    d.className = 'muted';
    d.textContent = '(no file published yet)';
    container.appendChild(d);
    return;
  }
  const v = versions[versions.length - 1];
  const a = document.createElement('a');
  a.className = 'file-link';
  a.href = api('/artifact-content?runId=' + encodeURIComponent(currentRunId) +
    '&id=' + encodeURIComponent(art.id) + '&version=' + v.version);
  a.target = '_blank';
  a.rel = 'noopener';
  a.textContent = '📄 ' + (v.filename || art.id) + '  (v' + v.version + ', ' + (v.content ? v.content.length : 0) + ' bytes)';
  container.appendChild(a);
}

// ----- form wiring -----

async function loadScript(path) {
  const res = await fetch(api('/script-content'), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ scriptPath: path }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'load failed' }));
    alert('Load failed: ' + (err.error || res.status));
    return;
  }
  const j = await res.json();
  els.source.value = j.content || '';
  els.path.value = j.path;
}

for (const btn of document.querySelectorAll('[data-sample]')) {
  btn.addEventListener('click', () => {
    const key = btn.dataset.sample;
    const rel = SAMPLES[key] || DWF_SAMPLES[key];
    if (!rel) return;
    fetch(api('/samples')).then((r) => r.json()).then(({ samplesDir }) => {
      // The path is relative to the samples directory, so a sample can live
      // in a subdirectory (samples/dwf/) and still resolve.
      const abs = samplesDir.replace(/\\/g, '/') + '/' + rel.replace(/^samples\//, '');
      els.path.value = abs;
      loadScript(abs);
    }).catch(() => {
      els.path.value = rel;
    });
  });
}

els.loadBtn.addEventListener('click', () => {
  const p = els.path.value.trim();
  if (p) loadScript(p);
});

async function extractCommands(scriptPath) {
  try {
    const res = await fetch(api('/extract-commands?scriptPath=' + encodeURIComponent(scriptPath)));
    if (!res.ok) return [];
    const j = await res.json();
    return Array.isArray(j.commands) ? j.commands : [];
  } catch (_) { return []; }
}

async function startRun(scriptPath, allowlist) {
  els.viewer.hidden = false;
  els.phaseBar.innerHTML = '';
  els.agentsList.innerHTML = '';
  els.reportsList.innerHTML = '';
  els.artifactsList.innerHTML = '';
  els.logView.innerHTML = '';
  els.graphsList.innerHTML = '';
  els.runIdBadge.textContent = 'starting…';
  setStatus('starting', 'status-running');
  els.runBtn.disabled = true;
  els.stopBtn.disabled = false;
  const amendFrom = (els.amendFromInput && els.amendFromInput.value || '').trim() || undefined;
  // v0.14.0: a `.dwf.ts` script goes to the ENGINE path — it is compiled
  // before it runs, and the compile is what produces the analysis graphs.
  // Everything else keeps the child-process path.
  const isEngine = /\.dwf\.ts$/i.test(scriptPath);
  const endpoint = isEngine ? '/engine/run' : '/run';
  const requestBody = isEngine
    ? {
        scriptPath,
        worldRunAllowlist: allowlist,
        name: scriptPath.split(/[\\/]/).pop(),
      }
    : { scriptPath, worldRunAllowlist: allowlist, amendFrom };
  try {
    const res = await fetch(api(endpoint), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(requestBody),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      // The engine path reports a compile failure as { status, diagnostics, error }.
      const diags = err.diagnostics || (err.error && err.error.diagnostics);
      if (diags && diags.length) {
        const e = new Error((err.error && err.error.message) || err.message || 'the workflow did not compile');
        e.diagnostics = diags;
        throw e;
      }
      throw new Error((err.error && err.error.message) || err.error || 'run failed: HTTP ' + res.status);
    }
    const j = await res.json();
    currentRunId = j.runId;
    els.runIdBadge.textContent = shortRunId();
    // The engine path hands back the graphs with the run: they are known
    // before the first token comes back.
    if (j.graphs) renderGraphs(els.graphsList, j.graphs);
    if (currentStream) { try { currentStream.close(); } catch (_) {} currentStream = null; }
    currentStream = new EventSource(api('/stream') + '?runId=' + currentRunId);
    currentStream.onmessage = (msg) => {
      let evt; try { evt = JSON.parse(msg.data); } catch (_) { return; }
      onEvent(evt);
    };
  } catch (err) {
    // v0.8.0: TS typecheck errors come back as HTTP 400 with a
    // structured diagnostics array. Render them inline rather than
    // collapsing to a single line.
    if (err && err.diagnostics && err.diagnostics.length) {
      showTypecheckErrors(err.diagnostics, err.message);
    } else {
      setStatus('error: ' + String(err.message || err), 'status-error');
    }
    els.runBtn.disabled = false;
    els.stopBtn.disabled = true;
  }
}

els.runBtn.addEventListener('click', async () => {
  let scriptPath = els.path.value.trim();
  if (!scriptPath) { alert('scriptPath is required'); return; }
  if (scriptPath.startsWith('file:')) {
    try { scriptPath = new URL(scriptPath).pathname.replace(/^\/([A-Za-z]:)/, '$1'); }
    catch (_) {}
  }
  // Pre-flight: extract the world.run commands this script will issue, then
  // show a confirm modal listing them. The user picks the subset to allow.
  // Empty list (no world.run in the script) -> no modal, just start.
  const commands = await extractCommands(scriptPath);
  let allowlist;
  if (commands.length > 0) {
    allowlist = await showConfirmModal(commands);
    if (allowlist === null) return; // user cancelled
  } else {
    allowlist = undefined; // runtime treats undefined as "no allowlist"
  }
  await startRun(scriptPath, allowlist);
});

els.stopBtn.addEventListener('click', async () => {
  if (!currentRunId) return;
  await fetch(api('/stop'), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ runId: currentRunId }),
  });
});

async function refreshFromState() {
  if (!currentRunId) return;
  try {
    const r = await fetch(api('/state') + '?runId=' + currentRunId);
    if (!r.ok) return;
    const snap = await r.json();
    renderPhases(snap);
    renderAgents(snap);
    renderReports(snap);
    renderArtifacts(snap);
    renderJournalBadge(snap);
    // v0.14.0: the engine path's compile produced the graphs, so they ride
    // along with the state.
    renderGraphs(els.graphsList, snap.engine ? snap.engine.graphs : null);
  } catch (_) {}
}

/**
 * v0.11.0: journal replay trail.
 *
 * The question this answers is "how much of this run did I actually
 * pay for?" — an amended run interleaves live work with work replayed
 * from an ancestor's journal, and without a visual split the two look
 * identical in the event log.
 *
 * The panel is fetched lazily and only once the user opens it, because
 * a long run's journal can be thousands of entries and this is not a
 * view most runs need.
 */
async function loadJournal() {
  if (!currentRunId) return;
  try {
    const r = await fetch(api('/journal') + '?runId=' + currentRunId + '&limit=300');
    if (!r.ok) return;
    renderJournal(await r.json());
  } catch (_) {}
}

function renderJournalBadge(snapshot) {
  if (!snapshot) return;
  const len = snapshot.journalLength || 0;
  // Only surface the affordance once there is something to show AND
  // this run actually amends another — otherwise it is just noise on
  // top of the event log.
  const interesting = len > 0 && (snapshot.amendFrom || snapshot.journalImportDepth > 0);
  els.journalTrail.hidden = !interesting;
  if (!interesting) return;
  els.journalBadge.textContent = len + ' entries'
    + (snapshot.cacheOpen ? ' · cache open' : '')
    + (snapshot.journalTrimmed ? ` · ${snapshot.journalTrimmed} trimmed` : '');
}

function renderJournal(data) {
  const entries = (data && data.entries) || [];
  els.journalMeta.innerHTML = '';
  if (data) {
    const meta = document.createElement('div');
    const bits = [];
    bits.push(`${data.total} entries`);
    if (data.amendFrom) bits.push(`amend chain depth ${data.journalImportDepth}`);
    if (data.trimmed) bits.push(`${data.trimmed} trimmed by the 5000 cap`);
    meta.textContent = bits.join(' · ');
    els.journalMeta.appendChild(meta);
  }
  els.journalList.innerHTML = '';
  if (entries.length === 0) {
    els.journalList.innerHTML = '<div class="muted">No journal entries.</div>';
    return;
  }
  for (const e of entries) {
    const row = document.createElement('div');
    row.className = 'journal-row ' + (e.live ? 'live' : 'replayed');
    const when = new Date(e.at || 0).toISOString().slice(11, 19);
    let what;
    if (e.kind === 'agent.ask') {
      what = `agent.ask(${e.name})` + (e.typed ? ' [typed]' : '');
    } else if (e.kind === 'world.run') {
      what = `world.run(${e.cmd}) exit=${e.exitCode}`;
    } else {
      what = e.kind;
    }
    const badge = e.live
      ? '<span class="journal-badge live">live</span>'
      : `<span class="journal-badge replayed">replay of ${escapeHtml((e.fromRun || '?').slice(0, 8))}</span>`;
    const tok = e.usage && e.usage.total_tokens ? ` · ${e.usage.total_tokens} tok` : '';
    row.innerHTML = `<span class="journal-time">${when}</span>`
      + `<span class="journal-what">${escapeHtml(what)}</span>`
      + badge
      + `<span class="journal-meta-inline">${escapeHtml(tok)}</span>`;
    els.journalList.appendChild(row);
  }
}

async function onEvent(evt) {
  if (evt.event === 'hello' || evt.event === 'status') {
    if (evt.snapshot) {
      renderPhases(evt.snapshot);
      renderAgents(evt.snapshot);
      renderReports(evt.snapshot);
      renderArtifacts(evt.snapshot);
      renderJournalBadge(evt.snapshot);
    } else if (evt.status) {
      setStatus(evt.status, 'status-' + evt.status);
      refreshFromState().then(() => {
        if (evt.status === 'completed' || evt.status === 'error' || evt.status === 'stopped') {
          els.runBtn.disabled = false;
          els.stopBtn.disabled = true;
          try { if (currentStream) currentStream.close(); } catch (_) {}
          currentStream = null;
        }
      });
    }
    return;
  }
  if (evt.event === 'phase') {
    if (evt.phaseSummary) {
      // Already deduped; render without a full refetch.
      renderPhases({ phaseSummary: evt.phaseSummary, phases: [], currentPhase: evt.phase.name });
    } else {
      refreshFromState();
    }
    return;
  }
  if (evt.event === 'log') { appendLog(evt.entry); return; }
  if (evt.event === 'report') { refreshFromState(); return; }
  if (evt.event === 'artifact.declare' || evt.event === 'artifact.publish' || evt.event === 'world.run.declined') {
    refreshFromState();
    return;
  }
  if (evt.event === 'agent.new' || evt.event === 'agent.ask.start' || evt.event === 'agent.ask.done') {
    refreshFromState();
    return;
  }
  if (evt.event === 'question.asked') {
    renderPendingQuestions([evt.question]);
    return;
  }
  if (evt.event === 'question.answered' || evt.event === 'question.timeout') {
    // The card stays in the DOM with a "resolved" badge; user can review
    // what was answered (or missed) and the run continues.
    refreshFromState();
    return;
  }
  if (evt.event === 'hole.waiting') {
    renderPendingHoles([evt.hole]);
    return;
  }
  if (evt.event === 'hole.answered' || evt.event === 'hole.timeout') {
    refreshFromState();
    return;
  }
  if (evt.event === 'escalate.asked') {
    renderPendingEscalates([evt.escalate]);
    return;
  }
  if (evt.event === 'escalate.answered' || evt.event === 'escalate.timeout') {
    refreshFromState();
    return;
  }
}

// ----- v0.4.0: saved workflows (list / load / save) -----

async function loadSavedWorkflows() {
  if (!els.savedList) return;
  try {
    const r = await fetch(api('/saved-workflows'));
    if (!r.ok) {
      els.savedList.innerHTML = '<span class="muted">No saved workflows dir yet.</span>';
      return;
    }
    const j = await r.json();
    const list = (j.workflows || []);
    if (list.length === 0) {
      els.savedList.innerHTML = '<span class="muted">No saved workflows yet. Click "💾 Save…" to create one.</span>';
      return;
    }
    els.savedList.innerHTML = '';
    for (const w of list) {
      const btn = document.createElement('button');
      btn.className = 'saved-btn';
      btn.title = w.description || w.name;
      const label = document.createElement('div');
      label.textContent = w.name;
      const sub = document.createElement('div');
      sub.className = 'muted';
      sub.style.fontSize = '11px';
      sub.textContent = w.description || '(no description)';
      btn.appendChild(label);
      btn.appendChild(sub);
      btn.addEventListener('click', () => loadSavedWorkflow(w.name));
      els.savedList.appendChild(btn);
    }
  } catch (err) {
    els.savedList.innerHTML = '<span class="muted">Failed to load saved workflows.</span>';
  }
}

async function loadSavedWorkflow(name) {
  try {
    const r = await fetch(api('/saved-workflows/content?name=' + encodeURIComponent(name)));
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      alert('Load failed: ' + (err.error || r.status));
      return;
    }
    const j = await r.json();
    els.source.value = j.content || '';
    els.path.value = j.path || '';
    setStatus('saved: ' + name, 'status-completed');
  } catch (err) {
    alert('Load failed: ' + String(err.message || err));
  }
}

function showSaveModal() {
  // Pre-fill with current scriptPath's basename if it looks like a saved name
  const cur = els.path.value.trim();
  const base = cur ? cur.split(/[\\/]/).pop().replace(/\.mjs$/, '') : '';
  els.saveName.value = /^[A-Za-z0-9_.-]{1,64}$/.test(base) ? base : '';
  els.saveDescription.value = '';
  els.saveWhenToUse.value = '';
  els.saveModal.hidden = false;
  setTimeout(() => els.saveName.focus(), 0);
}
function hideSaveModal() { els.saveModal.hidden = true; }
els.saveCancel.addEventListener('click', hideSaveModal);
els.saveOk.addEventListener('click', async () => {
  const name = els.saveName.value.trim();
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(name)) {
    alert('name must match /^[A-Za-z0-9_.-]{1,64}$/');
    return;
  }
  const script = els.source.value;
  if (!script.trim()) {
    alert('editor is empty');
    return;
  }
  const body = {
    name,
    script,
    description: els.saveDescription.value.trim() || null,
    whenToUse: els.saveWhenToUse.value.trim() || null,
  };
  try {
    const r = await fetch(api('/saved-workflows'), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      alert('Save failed: ' + (err.error || r.status));
      return;
    }
    hideSaveModal();
    await loadSavedWorkflows();
  } catch (err) {
    alert('Save failed: ' + String(err.message || err));
  }
});
els.saveBtn.addEventListener('click', showSaveModal);

// ----- v0.4.0: EvalWorkflowSnippet section -----

els.snippetRunBtn.addEventListener('click', async () => {
  const code = els.snippetCode.value.trim();
  if (!code) { alert('snippet is empty'); return; }
  els.snippetStatus.textContent = 'running…';
  els.snippetStatus.className = 'muted status-running';
  els.snippetOut.hidden = true;
  els.snippetRunBtn.disabled = true;
  try {
    const r = await fetch(api('/eval'), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, timeoutMs: 30000 }),
    });
    const j = await r.json();
    if (!r.ok) {
      els.snippetStatus.textContent = 'error';
      els.snippetStatus.className = 'muted status-error';
      els.snippetOut.hidden = false;
      els.snippetOut.textContent = 'ERROR: ' + (j.error || r.status);
      return;
    }
    els.snippetStatus.textContent = j.status;
    els.snippetStatus.className = 'muted ' + (j.status === 'completed' ? 'status-completed' : 'status-error');
    els.snippetOut.hidden = false;
    const logTail = (j.log || []).slice(-30).map((l) => `[${l.level}] ${l.message}`).join('\n');
    const resultStr = j.result ? `\n\n--- last report ---\n${JSON.stringify(j.result.item, null, 2)}` : '';
    els.snippetOut.textContent = `status: ${j.status}\n\n--- log (last 30) ---\n${logTail}${resultStr}`;
  } catch (err) {
    els.snippetStatus.textContent = 'error';
    els.snippetStatus.className = 'muted status-error';
    els.snippetOut.hidden = false;
    els.snippetOut.textContent = 'ERROR: ' + String(err.message || err);
  } finally {
    els.snippetRunBtn.disabled = false;
  }
});

// ----- v0.4.0: pending questions (UI for askUser) -----

let pendingQuestionById = {}; // questionId -> {question, kind, options}

function renderPendingQuestions(questions) {
  for (const q of questions) {
    pendingQuestionById[q.questionId] = q;
  }
  const ids = Object.keys(pendingQuestionById);
  if (ids.length === 0) {
    els.pendingQuestions.hidden = true;
    els.pendingQuestionsList.innerHTML = '';
    return;
  }
  els.pendingQuestions.hidden = false;
  els.pendingQuestionsList.innerHTML = '';
  for (const id of ids) {
    const q = pendingQuestionById[id];
    const card = document.createElement('div');
    card.className = 'question-card';
    card.dataset.questionId = id;
    const qText = document.createElement('div');
    qText.className = 'question-text';
    qText.textContent = q.question;
    card.appendChild(qText);
    let inputEl;
    if (q.kind === 'confirm') {
      inputEl = document.createElement('div');
      inputEl.className = 'question-input';
      const yesBtn = document.createElement('button');
      yesBtn.textContent = 'Yes';
      yesBtn.addEventListener('click', () => submitQuestion(id, true));
      const noBtn = document.createElement('button');
      noBtn.textContent = 'No';
      noBtn.addEventListener('click', () => submitQuestion(id, false));
      inputEl.appendChild(yesBtn);
      inputEl.appendChild(noBtn);
    } else if (Array.isArray(q.options) && q.options.length > 0) {
      inputEl = document.createElement('div');
      inputEl.className = 'question-input';
      for (const opt of q.options) {
        const b = document.createElement('button');
        b.textContent = String(opt);
        b.addEventListener('click', () => submitQuestion(id, opt));
        inputEl.appendChild(b);
      }
    } else {
      inputEl = document.createElement('div');
      inputEl.className = 'question-input';
      const ta = document.createElement('input');
      ta.type = 'text';
      ta.placeholder = 'Type your answer…';
      ta.style.flex = '1';
      const submit = document.createElement('button');
      submit.textContent = 'Submit';
      submit.className = 'primary';
      submit.addEventListener('click', () => submitQuestion(id, ta.value));
      ta.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitQuestion(id, ta.value); });
      inputEl.appendChild(ta);
      inputEl.appendChild(submit);
    }
    card.appendChild(inputEl);
    els.pendingQuestionsList.appendChild(card);
  }
}

async function submitQuestion(questionId, answer) {
  if (!currentRunId) return;
  try {
    const r = await fetch(api('/question-answer'), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runId: currentRunId, questionId, answer }),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      alert('Answer failed: ' + (err.error || r.status));
      return;
    }
    // Optimistically mark the card as resolved; the SSE 'question.answered'
    // event will be the authoritative signal.
    const card = els.pendingQuestionsList.querySelector(`[data-question-id="${questionId}"]`);
    if (card) {
      card.classList.add('resolved');
      const btns = card.querySelectorAll('button, input');
      btns.forEach((b) => b.disabled = true);
      const note = document.createElement('div');
      note.className = 'muted';
      note.textContent = `answered: ${JSON.stringify(answer)}`;
      card.appendChild(note);
    }
    delete pendingQuestionById[questionId];
    if (Object.keys(pendingQuestionById).length === 0) {
      els.pendingQuestions.hidden = true;
    }
  } catch (err) {
    alert('Answer failed: ' + String(err.message || err));
  }
}

// ----- v0.5.0: pending holes (UI for hole<T>) -----

let pendingHoleById = {}; // holeId -> {holeId, name, prompt, hasContext}

function renderPendingHoles(holes) {
  for (const h of holes) pendingHoleById[h.holeId] = h;
  const ids = Object.keys(pendingHoleById);
  if (ids.length === 0) {
    els.pendingHoles.hidden = true;
    els.pendingHolesList.innerHTML = '';
    return;
  }
  els.pendingHoles.hidden = false;
  els.pendingHolesList.innerHTML = '';
  for (const id of ids) {
    const h = pendingHoleById[id];
    if (els.pendingHolesList.querySelector(`[data-hole-id="${id}"]`)) continue;
    const card = document.createElement('div');
    card.className = 'hole-card';
    card.dataset.holeId = id;
    const head = document.createElement('div');
    head.className = 'hole-head';
    head.textContent = h.name;
    card.appendChild(head);
    const promptEl = document.createElement('div');
    promptEl.className = 'hole-prompt muted';
    promptEl.textContent = h.prompt;
    card.appendChild(promptEl);
    if (h.hasContext) {
      const hint = document.createElement('div');
      hint.className = 'muted hole-hint';
      hint.textContent = 'Body receives `ctx` (whatever you passed into await hole(name, prompt, ctx)).';
      card.appendChild(hint);
    }
    const ta = document.createElement('textarea');
    ta.className = 'hole-body-input';
    ta.placeholder = h.hasContext
      ? '(ctx) => /* your code here */\nreturn ctx;'
      : '/* your code here */\nreturn /* value to unblock the script */;';
    ta.rows = 4;
    const seed = h.hasContext
      ? '({ plan, threshold }) => plan.steps.slice(0, threshold)'
      : '() => null';
    ta.value = seed;
    card.appendChild(ta);
    const row = document.createElement('div');
    row.className = 'row';
    row.style.justifyContent = 'flex-end';
    const submit = document.createElement('button');
    submit.className = 'primary';
    submit.textContent = 'Submit body';
    submit.addEventListener('click', () => submitHole(id, ta.value));
    const cancel = document.createElement('button');
    cancel.className = 'danger';
    cancel.textContent = 'Cancel (return error)';
    cancel.addEventListener('click', () => submitHole(id, null, 'cancelled by user'));
    row.appendChild(cancel);
    row.appendChild(submit);
    card.appendChild(row);
    els.pendingHolesList.appendChild(card);
  }
}

async function submitHole(holeId, body, errorMessage) {
  if (!currentRunId) return;
  try {
    const r = await fetch(api('/hole-answer'), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runId: currentRunId, holeId, body, error: errorMessage || undefined }),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      alert('Hole answer failed: ' + (err.error || r.status));
      return;
    }
    const card = els.pendingHolesList.querySelector(`[data-hole-id="${holeId}"]`);
    if (card) {
      card.classList.add('resolved');
      card.querySelectorAll('button, textarea, input').forEach((b) => b.disabled = true);
      const note = document.createElement('div');
      note.className = 'muted';
      note.textContent = errorMessage ? `cancelled: ${errorMessage}` : `submitted: ${String(body).slice(0, 200)}`;
      card.appendChild(note);
    }
    delete pendingHoleById[holeId];
    if (Object.keys(pendingHoleById).length === 0) {
      els.pendingHoles.hidden = true;
    }
  } catch (err) {
    alert('Hole answer failed: ' + String(err.message || err));
  }
}

// ----- v0.6.0: pending escalates (UI for escalate() + Think via LLM) -----

let pendingEscalateById = {};

function renderPendingEscalates(escalates) {
  for (const e of escalates) pendingEscalateById[e.escalateId] = e;
  const ids = Object.keys(pendingEscalateById);
  if (ids.length === 0) {
    els.pendingEscalates.hidden = true;
    els.pendingEscalatesList.innerHTML = '';
    return;
  }
  els.pendingEscalates.hidden = false;
  els.pendingEscalatesList.innerHTML = '';
  for (const id of ids) {
    if (els.pendingEscalatesList.querySelector(`[data-escalate-id="${id}"]`)) continue;
    const e = pendingEscalateById[id];
    const card = document.createElement('div');
    card.className = 'escalate-card';
    card.dataset.escalateId = id;
    const q = document.createElement('div');
    q.className = 'escalate-q';
    q.textContent = e.question;
    card.appendChild(q);
    if (Array.isArray(e.options) && e.options.length > 0) {
      const opts = document.createElement('div');
      opts.className = 'escalate-opts';
      for (const o of e.options) {
        const b = document.createElement('button');
        b.textContent = String(o);
        b.addEventListener('click', () => submitEscalate(id, o));
        opts.appendChild(b);
      }
      card.appendChild(opts);
    } else if (e.kind === 'confirm') {
      const opts = document.createElement('div');
      opts.className = 'escalate-opts';
      const yes = document.createElement('button');
      yes.textContent = 'Yes';
      yes.addEventListener('click', () => submitEscalate(id, true));
      const no = document.createElement('button');
      no.textContent = 'No';
      no.addEventListener('click', () => submitEscalate(id, false));
      opts.appendChild(yes); opts.appendChild(no);
      card.appendChild(opts);
    } else {
      const ta = document.createElement('input');
      ta.type = 'text';
      ta.placeholder = 'Type your answer…';
      ta.style.flex = '1';
      card.appendChild(ta);
      const row = document.createElement('div');
      row.className = 'row'; row.style.justifyContent = 'flex-end';
      const submit = document.createElement('button');
      submit.className = 'primary';
      submit.textContent = 'Submit';
      submit.addEventListener('click', () => submitEscalate(id, ta.value));
      ta.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') submitEscalate(id, ta.value); });
      row.appendChild(submit);
      card.appendChild(row);
    }
    // v0.6.0: "Think via LLM" button. Always present — host will dispatch
    // an LLM call with run context to answer the question.
    const thinkRow = document.createElement('div');
    thinkRow.className = 'row'; thinkRow.style.justifyContent = 'flex-end';
    const thinkBtn = document.createElement('button');
    thinkBtn.className = 'primary';
    thinkBtn.textContent = '🧠 Think via LLM';
    thinkBtn.addEventListener('click', () => submitEscalateThink(id));
    thinkRow.appendChild(thinkBtn);
    card.appendChild(thinkRow);
    els.pendingEscalatesList.appendChild(card);
  }
}

async function submitEscalate(escalateId, answer) {
  if (!currentRunId) return;
  try {
    const r = await fetch(api('/escalate-answer'), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runId: currentRunId, escalateId, answer }),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      alert('Escalate answer failed: ' + (err.error || r.status));
      return;
    }
    markEscalateResolved(escalateId, `direct answer: ${JSON.stringify(answer)}`);
  } catch (err) {
    alert('Escalate answer failed: ' + String(err.message || err));
  }
}

async function submitEscalateThink(escalateId) {
  if (!currentRunId) return;
  try {
    const r = await fetch(api('/escalate-think'), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runId: currentRunId, escalateId }),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      alert('Escalate think failed: ' + (err.error || r.status));
      return;
    }
    // The actual answer comes back via SSE 'escalate.answered'; for now
    // show a "thinking" badge.
    const card = els.pendingEscalatesList.querySelector(`[data-escalate-id="${escalateId}"]`);
    if (card) {
      card.classList.add('thinking');
      const note = document.createElement('div');
      note.className = 'muted';
      note.textContent = '🧠 Thinking via LLM…';
      card.appendChild(note);
    }
  } catch (err) {
    alert('Escalate think failed: ' + String(err.message || err));
  }
}

function markEscalateResolved(escalateId, noteText) {
  const card = els.pendingEscalatesList.querySelector(`[data-escalate-id="${escalateId}"]`);
  if (card) {
    card.classList.add('resolved');
    card.classList.remove('thinking');
    card.querySelectorAll('button, input').forEach((b) => b.disabled = true);
    const note = document.createElement('div');
    note.className = 'muted';
    note.textContent = noteText;
    card.appendChild(note);
  }
  delete pendingEscalateById[escalateId];
  if (Object.keys(pendingEscalateById).length === 0) {
    els.pendingEscalates.hidden = true;
  }
}

// ----- v0.7.0: recent runs history (uses /api/runs) -----

let historyRefreshTimer = null;
let historyCache = []; // last fetched array

function statusBadgeClass(status) {
  if (status === 'completed') return 'completed';
  if (status === 'error') return 'error';
  if (status === 'stopped') return 'stopped';
  return status; // starting / running
}

function fmtTimeAgo(ms) {
  if (!ms) return '—';
  const dt = Date.now() - ms;
  if (dt < 60_000) return Math.max(1, Math.round(dt / 1000)) + 's ago';
  if (dt < 3_600_000) return Math.round(dt / 60_000) + 'm ago';
  if (dt < 86_400_000) return Math.round(dt / 3_600_000) + 'h ago';
  return Math.round(dt / 86_400_000) + 'd ago';
}

async function loadRunsList() {
  if (!els.historyList) return;
  try {
    const r = await fetch(api('/runs'));
    if (!r.ok) {
      els.historyStatus.textContent = 'failed to load';
      return;
    }
    const j = await r.json();
    historyCache = (j.runs || []).slice(0, 20);
    renderRunsList();
  } catch (err) {
    els.historyStatus.textContent = 'error: ' + String(err.message || err);
  }
}

function renderRunsList() {
  const runs = historyCache;
  els.historyCount.textContent = String(runs.length);
  els.historyStatus.textContent = runs.length === 0
    ? 'no runs yet — start one above'
    : `${runs.length} most-recent run(s)`;
  els.historyList.innerHTML = '';
  for (const r of runs) {
    const row = document.createElement('div');
    row.className = 'run-row';
    const status = document.createElement('span');
    status.className = 'badge-mini ' + statusBadgeClass(r.status);
    status.textContent = r.status;
    const src = document.createElement('span');
    src.className = 'src';
    src.title = r.scriptPath || '';
    const name = r.scriptPath ? r.scriptPath.split(/[\\/]/).pop() : '(no script)';
    src.textContent = name;
    if (r.amendFrom) {
      const tag = document.createElement('span');
      tag.className = 'amend-tag';
      tag.textContent = '(amend)';
      src.appendChild(tag);
    }
    if (r.loadedFromDisk) src.classList.add('src-from-disk');
    const time = document.createElement('span');
    time.className = 'time';
    time.title = new Date(r.startedAt).toISOString();
    time.textContent = fmtTimeAgo(r.startedAt);
    const rid = document.createElement('span');
    rid.className = 'rid';
    rid.textContent = r.runId.slice(0, 8);
    const loadBtn = document.createElement('button');
    loadBtn.textContent = 'Load';
    loadBtn.title = 'Fill scriptPath from this run';
    loadBtn.addEventListener('click', () => loadRunIntoEditor(r));
    const amendBtn = document.createElement('button');
    amendBtn.textContent = 'Amend from';
    amendBtn.title = 'Use this run as the cache source for the next Run';
    amendBtn.addEventListener('click', () => setAmendFrom(r.runId));
    row.append(status, src, time, rid, loadBtn, amendBtn);
    els.historyList.appendChild(row);
  }
}

async function loadRunIntoEditor(r) {
  // Fill the path; if it's under $DSH_HOME/workflows, also fetch the source
  // (the script body is in the run's persisted file when amendFrom is used).
  els.path.value = r.scriptPath || '';
  // Try saved-workflows first; the run was a saved workflow.
  const wf = await fetch(api('/saved-workflows/content?name=' + encodeURIComponent(scriptBaseName(r.scriptPath || ''))));
  if (wf.ok) {
    const j = await wf.json();
    if (j && j.content) { els.source.value = j.content; }
  }
  setStatus('loaded: ' + (r.scriptPath || r.runId.slice(0, 8)), 'status-completed');
}

function scriptBaseName(p) {
  if (!p) return '';
  const m = p.match(/[\\/]([^\\/]+)$/);
  return m ? m[1].replace(/\.[^.]+$/, '') : '';
}

function setAmendFrom(runId) {
  if (els.amendFromInput) {
    els.amendFromInput.value = runId;
    els.amendFromInput.style.outline = '2px solid var(--accent-2)';
    setTimeout(() => { els.amendFromInput.style.outline = ''; }, 1500);
  }
  setStatus('amend from: ' + runId.slice(0, 8), 'status-completed');
}

if (els.historyRefresh) {
  els.historyRefresh.addEventListener('click', loadRunsList);
}

// Initial fetch + 5s auto-refresh.
loadRunsList();
historyRefreshTimer = setInterval(loadRunsList, 5000);
// Stop auto-refresh when the page is hidden.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    if (historyRefreshTimer) { clearInterval(historyRefreshTimer); historyRefreshTimer = null; }
  } else {
    if (!historyRefreshTimer) historyRefreshTimer = setInterval(loadRunsList, 5000);
    loadRunsList();
  }
});

// Initial fetch
loadSavedWorkflows();
