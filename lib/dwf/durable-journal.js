/**
 * A durable `JournalStorePort`.
 *
 * The engine keeps zero I/O, so the journal is a port the host implements.
 * Upstream's production implementation is SQLite; upstream also ships a
 * CONTRACT SUITE for the port
 * (`packages/dynamic-workflow/src/testing/journal-contract.ts`), and the
 * vendored `tsconfig.runtime.json` says why it is vendored at all:
 * "it is meant to be run against OUR journal implementation".
 *
 * This is that implementation. It is a thin wrapper over upstream's
 * `InMemoryJournalStore` — so every semantic is upstream's, byte for byte —
 * plus a write-through to a JSON file per run. The wrapper:
 *
 *   - keeps the in-memory store as the source of truth for reads, so the
 *     port's semantics are exactly upstream's;
 *   - persists the whole run's rows after every write, so a restart can
 *     rebuild them;
 *   - restores a run's rows from disk on demand, so a run that was in
 *     flight when dsh stopped can be read back.
 *
 * WHY A JSON FILE AND NOT SQLITE: the plugin ships with zero third-party
 * runtime dependencies beyond `typescript` (which the vendored engine
 * already needs). `node:sqlite` is available in Node 22+, but dsh's
 * Electron runtime may not expose it, and the plugin's job is to work in
 * whatever host it lands in. A JSON file per run needs nothing.
 *
 * WHY THE WRITE-THROUGH IS WHOLE-RUN: a run's rows are small (a few
 * hundred node rows and events), and the write is already debounced by
 * the host. Writing one file per run, atomically, keeps a half-written
 * file from ever being read back.
 */

import { InMemoryJournalStore } from './engine.js';

import {
  mkdirSync, readFileSync, renameSync, writeFileSync, existsSync, unlinkSync, readdirSync,
} from 'node:fs';
import { join } from 'node:path';

/**
 * @typedef {object} DurableJournalOptions
 * @property {string} dir - where the per-run files live
 * @property {boolean} [enabled] - false disables persistence entirely
 * @property {number} [flushDelayMs] - how long to coalesce writes
 */

/**
 * A journal store whose rows survive a process restart.
 */
export class DurableJournalStore {
  /**
   * @param {DurableJournalOptions} options
   */
  constructor(options = {}) {
    this.dir = options.dir ?? '';
    this.enabled = options.enabled !== false && this.dir !== '';
    /**
     * How long to coalesce writes before flushing to disk.
     *
     * The write-through rewrites the WHOLE run's rows, so flushing on
     * every put is quadratic: a run with N events writes N files whose
     * sizes grow, and the total bytes written are ~N²/2. Measured: 501
     * writes of a 155 KB file wrote ~38 MB.
     *
     * The delay is short enough that a crash loses at most a moment's
     * worth of rows, and long enough that a busy run writes a handful of
     * times instead of hundreds.
     */
    this.flushDelayMs = Number.isFinite(options.flushDelayMs)
      ? Math.max(0, options.flushDelayMs)
      : 250;
    /** @type {Map<string, InMemoryJournalStore>} one store per run */
    this.stores = new Map();
    /** @type {Map<string, object>} the persisted shape of each run */
    this.persisted = new Map();
    /** @type {Set<string>} runs whose rows changed since the last flush */
    this.dirty = new Set();
    /** @type {Map<string, NodeJS.Timeout>} the pending flush per run */
    this.timers = new Map();
  }

  /**
   * The in-memory store for a run, loaded from disk if it is not in memory.
   *
   * @param {string} runId
   * @returns {InMemoryJournalStore}
   */
  #store(runId) {
    let store = this.stores.get(runId);
    if (store !== undefined) return store;
    store = new InMemoryJournalStore();
    this.stores.set(runId, store);
    this.#restore(runId, store);
    return store;
  }

  /**
   * Rebuild a run's rows from its file.
   *
   * @param {string} runId
   * @param {InMemoryJournalStore} store
   */
  #restore(runId, store) {
    if (!this.enabled) return;
    const file = this.#file(runId);
    if (!existsSync(file)) return;
    let raw;
    try {
      raw = readFileSync(file, 'utf8');
    } catch (_) {
      return;
    }
    let snap;
    try {
      snap = JSON.parse(raw);
    } catch (_) {
      // A corrupted file is not a reason to lose the run: the rows are gone,
      // but the run still exists in dsh's own persistence.
      return;
    }
    if (!snap || snap.runId !== runId) return;

    // The run row.
    if (snap.run) {
      try {
        store.createRun(snap.run);
      } catch (_) {
        // Already present (a double restore): leave it.
      }
    }
    // The actor rows.
    for (const actor of snap.actors ?? []) {
      try {
        store.putActor(actor);
      } catch (_) { /* a row that no longer fits is dropped */ }
    }
    // The node rows.
    for (const node of snap.nodes ?? []) {
      try {
        store.putNode(node);
      } catch (_) { /* ditto */ }
    }
    // The event log. The sequence numbers are the list's index, so they are
    // restored by appending in order.
    for (const stored of snap.events ?? []) {
      try {
        store.appendEvent(runId, stored.event);
      } catch (_) { /* ditto */ }
    }
  }

  /**
   * The file a run's rows live in.
   *
   * @param {string} runId
   * @returns {string}
   */
  #file(runId) {
    return join(this.dir, `${encodeURIComponent(runId)}.dwf-journal.json`);
  }

  /**
   * Persist a run's rows.
   *
   * The write is atomic: a temp file is written and then renamed, so a
   * reader never sees a half-written file.
   *
   * @param {string} runId
   */
  #flush(runId) {
    if (!this.enabled) return;
    const store = this.stores.get(runId);
    if (store === undefined) return;
    const snap = {
      runId,
      run: store.getRun(runId) ?? null,
      actors: store.listActors(runId, { withPersona: true }),
      nodes: store.listNodes(runId, { kinds: 'all', withResult: true }),
      events: store.listEvents(runId, { types: 'all', reportItems: 'all' }),
    };
    this.persisted.set(runId, snap);
    this.dirty.delete(runId);
    const file = this.#file(runId);
    const tmp = `${file}.tmp`;
    try {
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(tmp, JSON.stringify(snap), 'utf8');
      renameSync(tmp, file);
    } catch (_) {
      // A failed write is not fatal to the run: the engine's journal is the
      // truth for this process. The file is an aid for the NEXT process.
      try { if (existsSync(tmp)) unlinkSync(tmp); } catch (_) { /* ignore */ }
    }
  }

  /**
   * Mark a run dirty, and schedule a flush.
   *
   * The flush is DEBOUNCED: the write-through rewrites the whole run, so
   * flushing on every put is quadratic. A run that ends flushes
   * immediately — see `flush`.
   *
   * @param {string} runId
   */
  #touch(runId) {
    if (!this.enabled) return;
    this.dirty.add(runId);
    if (this.timers.has(runId)) return;
    const timer = setTimeout(() => {
      this.timers.delete(runId);
      this.#flush(runId);
    }, this.flushDelayMs);
    // A pending flush must not keep the process alive.
    if (typeof timer.unref === 'function') timer.unref();
    this.timers.set(runId, timer);
  }

  /**
   * Flush a run's rows to disk now.
   *
   * Called when a run ends, and by the host before it exits — a pending
   * debounce would otherwise lose the last rows of a run.
   *
   * @param {string} runId
   */
  flush(runId) {
    if (!this.enabled) return;
    const timer = this.timers.get(runId);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.timers.delete(runId);
    }
    this.#flush(runId);
  }

  /**
   * Flush every dirty run.
   */
  flushAll() {
    for (const runId of [...this.dirty]) this.flush(runId);
  }

  // ————————————————— the port —————————————————

  createRun(record) {
    this.#store(record.runId).createRun(record);
    this.#touch(record.runId);
  }

  getRun(runId) {
    return this.#store(runId).getRun(runId);
  }

  updateRunStatus(runId, status, settlement) {
    this.#store(runId).updateRunStatus(runId, status, settlement);
    this.#touch(runId);
  }

  updateRunUsage(runId, spentTokens) {
    this.#store(runId).updateRunUsage(runId, spentTokens);
    this.#touch(runId);
  }

  updateRunCaps(runId, caps) {
    this.#store(runId).updateRunCaps(runId, caps);
    this.#touch(runId);
  }

  updateRunScript(runId, scriptText, scriptHash) {
    this.#store(runId).updateRunScript(runId, scriptText, scriptHash);
    this.#touch(runId);
  }

  putActor(record) {
    this.#store(record.runId).putActor(record);
    this.#touch(record.runId);
  }

  getActor(runId, siteId, ordinal) {
    return this.#store(runId).getActor(runId, siteId, ordinal);
  }

  listActors(runId, opts) {
    return this.#store(runId).listActors(runId, opts);
  }

  putNode(record) {
    this.#store(record.runId).putNode(record);
    this.#touch(record.runId);
  }

  getNode(runId, siteId, ordinal, opts) {
    return this.#store(runId).getNode(runId, siteId, ordinal, opts);
  }

  listNodes(runId, opts) {
    return this.#store(runId).listNodes(runId, opts);
  }

  countNodes(runId, kind) {
    return this.#store(runId).countNodes(runId, kind);
  }

  sumResultBytes(runId, kind) {
    return this.#store(runId).sumResultBytes(runId, kind);
  }

  appendEvent(runId, event) {
    const stored = this.#store(runId).appendEvent(runId, event);
    this.#touch(runId);
    return stored;
  }

  listEvents(runId, opts) {
    return this.#store(runId).listEvents(runId, opts);
  }

  // ————————————————— beyond the port —————————————————

  /**
   * The run ids this store knows about, from disk.
   *
   * @returns {string[]}
   */
  listPersistedRuns() {
    if (!this.enabled) return [];
    let entries;
    try {
      entries = readdirSync(this.dir, { withFileTypes: true });
    } catch (_) {
      return [];
    }
    const out = [];
    for (const ent of entries) {
      if (!ent.isFile()) continue;
      if (!ent.name.endsWith('.dwf-journal.json')) continue;
      out.push(decodeURIComponent(ent.name.slice(0, -'.dwf-journal.json'.length)));
    }
    return out;
  }
}
