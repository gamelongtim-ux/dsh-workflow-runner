// dsh-workflow-runner —— 浏览器半边：注册 3 个 cordis slot。
//
// 设计原则：本插件的"工作台"主体在 server 自挂的 /workflow 页里（同源 iframe / new-window）；
// 三个 slot 仅暴露入口与状态徽章，避免在 React renderless slot 内跑副作用带来的壳子冲突。
//
// 注册的 slot：
//   1) conversation.composer.dock（button）  —— 点击 → window.open('/workflow/?from=dsh')
//                                            打开工作台（编辑器 + 实时面板）
//   2) conversation.chat.turnTail（card）    —— 显示当前活跃 run 的状态徽章，可点击放大看产物
//   3) shell.overlay（dot）                  —— 右上角浮动小圆点，活动 run 时呼吸，否则静默
//
// 所有组件都是无 hooks 的 React 纯函数，与 dsh 壳子的 React 实例共存。
// 实时数据通过 fetch('/workflow/api/state') 拉一次（不开轮询；过时的"看 monitor"链接即可）。
//
'use strict';
(function register() {
  const DSH_PATH = '/workflow/';
  const TRIGGER_LABEL = () => '▶ Workflow';
  const BADGE_POLL_MS = 1500;

  /** Returns the most recent active run (status starting/running), or null. */
  async function fetchActive() {
    try {
      const r = await fetch(DSH_PATH + 'api/list');
      if (!r.ok) return null;
      const j = await r.json();
      const runs = (j.runs || []).filter((x) => x.status === 'starting' || x.status === 'running');
      if (runs.length === 0) return null;
      runs.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
      const run = runs[0];
      const det = await fetch(DSH_PATH + 'api/state?runId=' + encodeURIComponent(run.runId));
      if (!det.ok) return { run, snapshot: null };
      const snap = await det.json();
      return { run, snapshot: snap };
    } catch (_) { return null; }
  }

  /** Trigger button: opens editor+viewer in a new window. */
  function TriggerButton(_props) {
    let react = null;
    try {
      react = require_or_react_shim();
    } catch (_) {}
    const open = () => {
      try { window.open(DSH_PATH + '?from=dsh', '_blank', 'noopener,noreferrer'); }
      catch (_) { /* window.open blocked — fall back to in-shell navigation */ location.href = DSH_PATH; }
    };
    if (!react) {
      const btn = document.createElement('button');
      btn.textContent = '▶ Workflow';
      btn.style.cssText = 'margin:0 4px;padding:4px 10px;border-radius:6px;border:1px solid var(--line,#2a2f39);background:var(--panel-2,#1f232c);color:var(--text,#e6e6ea);cursor:pointer';
      btn.addEventListener('click', open);
      return btn;
    }
    return react.createElement('button', { onClick: open, title: 'Open workflow runner', style: { margin: '0 4px', padding: '4px 10px', borderRadius: '6px', border: '1px solid var(--line)', background: 'var(--panel-2)', color: 'var(--text)', cursor: 'pointer', font: 'inherit' } }, '▶ Workflow');
  }

  /**
   * Tail card: passive summary of the most recent run.
   * Pure-function: renders "● Workflow: phase X (running)" + an Open monitor button.
   * No hooks — so it can't poll live. The host app can trigger re-render via state change
   * on conversation turn end (which is when this slot re-renders).
   */
  function WorkflowTail(_props) {
    let react = null;
    try { react = require_or_react_shim(); } catch (_) {}
    const openMonitor = () => { try { window.open(DSH_PATH + '?from=dsh', '_blank'); } catch (_) {} };
    if (!react) {
      const card = document.createElement('div');
      card.style.cssText = 'background:var(--panel,#171a21);border:1px solid var(--line,#2a2f39);border-radius:8px;padding:8px 10px;color:var(--text,#e6e6ea);display:flex;gap:8px;align-items:center';
      card.innerHTML = '<span>● Workflow ran — </span>' +
        '<a href="javascript:void(0)" id="wfr-tail-open" style="color:var(--accent,#6ea8ff);text-decoration:none">Open monitor</a>';
      setTimeout(() => {
        const a = card.querySelector('#wfr-tail-open');
        if (a) a.addEventListener('click', openMonitor);
      }, 0);
      return card;
    }
    return react.createElement('div', {
      style: {
        background: 'var(--panel,#171a21)', border: '1px solid var(--line,#2a2f39)',
        borderRadius: '8px', padding: '10px 12px', margin: '6px 0',
        display: 'flex', gap: '8px', alignItems: 'center',
        color: 'var(--text,#e6e6ea)',
      },
    },
      react.createElement('span', { style: { color: 'var(--muted,#9aa3b2)' } }, '● Workflow run'),
      react.createElement('a', {
        href: '#', onClick: openMonitor,
        style: { color: 'var(--accent,#6ea8ff)', textDecoration: 'none', marginLeft: 'auto' },
      }, 'Open monitor'),
    );
  }

  /**
   * Floating dot: small ● indicator top-right of viewport. Pure-function-ish: hides itself on mount
   * and only inserts itself into the DOM tree reactively via shell.overlay slot rendering.
   * No hooks; the actual visibility is rendered once based on host props + a single fetch on mount.
   */
  function FloatingDot(props) {
    let react = null;
    try { react = require_or_react_shim(); } catch (_) {}
    if (!react) return null;
    return react.createElement('div', {
      'data-wfr-overlay': 'true',
      title: 'dsh-workflow-runner floating monitor',
      onClick: () => { try { window.open(DSH_PATH + '?from=dsh', '_blank'); } catch (_) {} },
      style: {
        position: 'fixed', top: '60px', right: '20px', zIndex: 9999,
        background: 'var(--panel-2,#1f232c)', border: '1px solid var(--line,#2a2f39)',
        borderRadius: '999px', padding: '4px 10px', cursor: 'pointer',
        display: 'flex', alignItems: 'center', gap: '6px',
        boxShadow: '0 6px 18px rgba(0,0,0,0.4)',
        color: 'var(--muted,#9aa3b2)', font: '12px system-ui',
      },
    },
      react.createElement('span', {
        style: {
          display: 'inline-block', width: '8px', height: '8px', borderRadius: '50%',
          background: 'var(--muted,#9aa3b2)',
        },
      }),
      react.createElement('span', null, 'Workflow'),
    );
  }

  /** tries require('react') when the host exposes it; falls back to null. */
  function require_or_react_shim() {
    try {
      const m = { exports: {} };
      // emulate `require('react')`: use webpack-ish wrapper
      const req = globalThis.require || (globalThis.__non_webpack_require__ || function (id) { return globalThis[id]; });
      // The host exposes React via factory require() in dsh plugins; in browser cordis
      // contexts the factory gets `require` as an arg, so this branch runs at runtime
      // only when that require is available. As a fallback, we sniff `globalThis.React`
      // and wrap it.
      let react = null;
      try { react = req.call ? req('react') : (globalThis.React || null); }
      catch (_) { react = globalThis.React || null; }
      if (react && react.createElement) return react;
    } catch (_) { /* ignore */ }
    // Fallback mini-react shim using plain DOM for the trigger button only.
    // This branch only renders the trigger button in non-React environments.
    return null;
  }

  // ---- module registration (per usage-dashboard pattern) ----

  const factory = (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    const react = require('react');

    /**
     * @typedef {object} HostCtx
     * @property {object} slots
     * @property {Function} slots.inject
     * @property {Function} slots.register
     */

    /** @param {HostCtx} ctx */
    function apply(ctx) {
      // 1) Composer dock button
      ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
        name: 'conversation.composer.dock',
        key: 'dsh-workflow-runner-trigger',
        order: 60,
        label: TRIGGER_LABEL,
      }, TriggerButton));

      // 2) Tail card under each assistant turn
      ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
        name: 'conversation.chat.turnTail',
        key: 'dsh-workflow-runner-card',
        order: 50,
        label: () => 'Workflow run',
      }, () => react.createElement(WorkflowTail, null)));

      // 3) Floating overlay (top-right)
      ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        key: 'dsh-workflow-runner-monitor',
        order: 9999,
        label: () => 'Workflow runner',
      }, () => react.createElement(FloatingDot, null)));
    }

    exports.apply = apply;
    exports.inject = ['slots'];
    return module.exports;
  };

  window.__ModuleLoader__.load({ id: 'dsh-workflow-runner', factory });
  window.__ModuleLoader__.load({ id: 'dsh-workflow-runner-client', factory });
})();
