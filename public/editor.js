// dsh-workflow-runner —— public/editor.js
//
// Pure-vanilla ES module; no build step. Wires the editor form to /api/* and renders
// live SSE events into the viewer card.
//
// 单模块原因：本视图只服务一个页面，分文件只会把逻辑拆得更碎。
//
// State machine of a run:
//   idle → starting → running → completed | error | stopped
// Each transition is reflected on the status chip and reflected through #runStatus.

const SAMPLES = {
  smoke:    'samples/smoke.mjs',
  planner:  'samples/planner-critic.mjs',
  fanout:   'samples/fanout-summarize.mjs',
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
};

let currentRunId = null;
let currentStream = null;

// ----- helpers -----

const shortRunId = () => currentRunId ? currentRunId.slice(0, 8) : '';

function setStatus(text, klass) {
  els.status.textContent = text;
  els.status.className = 'muted ' + (klass || '');
}

function appendLog(line) {
  const span = document.createElement('span');
  const lvl = (line.level || 'info').toLowerCase();
  span.className = 'log-' + lvl;
  const t = new Date(line.at).toISOString().slice(11, 19);
  let body = String(line.message || '');
  // include stderr prefix normalization
  if (body.startsWith('[stderr] ')) body = body.slice(9);
  if (body.startsWith('[non-json] ')) body = '⤷ ' + body.slice(11);
  span.textContent = '[' + t + '] ' + body + '\n';
  els.logView.appendChild(span);
  els.logView.scrollTop = els.logView.scrollHeight;
}

function renderPhases(snapshot) {
  const seen = new Set(snapshot.phases.map((p) => p.name));
  els.phaseBar.innerHTML = '';
  for (const p of snapshot.phases) {
    const div = document.createElement('span');
    div.className = 'phase';
    div.textContent = p.name;
    if (p.name === snapshot.currentPhase && snapshot.status === 'running') {
      div.classList.add('active');
    }
    if (snapshot.status === 'error' && p.name === snapshot.currentPhase) div.classList.add('error');
    if (snapshot.status === 'completed' || (snapshot.status !== 'running' && p.name !== snapshot.currentPhase)) {
      div.classList.add('done');
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
    tag.textContent = r.tag || 'item';
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

function escapeHtml(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
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
    const rel = SAMPLES[key];
    if (!rel) return;
    // Resolve relative path against the plugin directory which plugin.js serves statically.
    // We compute an absolute path by reading /api/samples hint.
    fetch(api('/samples')).then((r) => r.json()).then(({ samplesDir }) => {
      const abs = samplesDir.replace(/\\/g, '/') + '/' + rel.split('/').pop();
      els.path.value = abs;
      loadScript(abs);
    }).catch(() => {
      // standalone.js and plugin.js both expose /api/samples; if absent, leave path empty.
      els.path.value = rel;
    });
  });
}

els.loadBtn.addEventListener('click', () => {
  const p = els.path.value.trim();
  if (p) loadScript(p);
});

els.runBtn.addEventListener('click', async () => {
  let scriptPath = els.path.value.trim();
  if (!scriptPath) { alert('scriptPath is required'); return; }
  // Strip leading file: prefix if present
  if (scriptPath.startsWith('file:')) {
    try { scriptPath = new URL(scriptPath).pathname.replace(/^\/([A-Za-z]:)/, '$1'); }
    catch (_) {}
  }
  els.viewer.hidden = false;
  els.phaseBar.innerHTML = '';
  els.agentsList.innerHTML = '';
  els.reportsList.innerHTML = '';
  els.logView.innerHTML = '';
  els.runIdBadge.textContent = 'starting…';
  setStatus('starting', 'status-running');
  els.runBtn.disabled = true;
  els.stopBtn.disabled = false;
  try {
    const res = await fetch(api('/run'), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scriptPath }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'run failed: HTTP ' + res.status);
    }
    const j = await res.json();
    currentRunId = j.runId;
    els.runIdBadge.textContent = shortRunId();
    if (currentStream) { try { currentStream.close(); } catch (_) {} currentStream = null; }
    currentStream = new EventSource(api('/stream') + '?runId=' + currentRunId);
    currentStream.onmessage = (msg) => {
      let evt; try { evt = JSON.parse(msg.data); } catch (_) { return; }
      onEvent(evt);
    };
    currentStream.onerror = () => {
      // EventSource auto-reconnects; we just close on completion.
    };
  } catch (err) {
    setStatus('error: ' + String(err.message || err), 'status-error');
    els.runBtn.disabled = false;
    els.stopBtn.disabled = true;
  }
});

els.stopBtn.addEventListener('click', async () => {
  if (!currentRunId) return;
  await fetch(api('/stop'), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ runId: currentRunId }),
  });
});

async function onEvent(evt) {
  if (evt.event === 'hello' || evt.event === 'status') {
    if (evt.snapshot) {
      renderPhases(evt.snapshot);
      renderAgents(evt.snapshot);
      renderReports(evt.snapshot);
    } else if (evt.status) {
      setStatus(evt.status, 'status-' + evt.status);
      // refresh snapshot on status change
      fetch(api('/state') + '?runId=' + currentRunId).then((r) => r.json()).then((snap) => {
        renderPhases(snap); renderAgents(snap); renderReports(snap);
        if (snap.status === 'completed' || snap.status === 'error' || snap.status === 'stopped') {
          els.runBtn.disabled = false;
          els.stopBtn.disabled = true;
          try { if (currentStream) currentStream.close(); } catch (_) {}
          currentStream = null;
        }
      }).catch(() => {});
    }
    return;
  }
  if (evt.event === 'phase') {
    // refresh snapshot to keep phase bar current
    fetch(api('/state') + '?runId=' + currentRunId).then((r) => r.json()).then((snap) => {
      renderPhases(snap);
    }).catch(() => {});
    return;
  }
  if (evt.event === 'log') {
    appendLog(evt.entry);
    return;
  }
  if (evt.event === 'report') {
    fetch(api('/state') + '?runId=' + currentRunId).then((r) => r.json()).then((snap) => {
      renderReports(snap);
    }).catch(() => {});
    return;
  }
  if (evt.event === 'agent.new' || evt.event === 'agent.ask.start' || evt.event === 'agent.ask.done') {
    fetch(api('/state') + '?runId=' + currentRunId).then((r) => r.json()).then((snap) => {
      renderAgents(snap);
    }).catch(() => {});
    return;
  }
}
