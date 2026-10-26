/**
 * The amend-resume import cache.
 *
 * Upstream's contract (packages/dynamic-workflow/docs/execution-engine.md,
 * "What is imported"): the engine keeps zero I/O, so the cache is PURE DATA
 * built by the caller from a predecessor's journal. The engine consumes it
 * and decides, on its own, whether a fresh ask is a cache hit or a live
 * dispatch.
 *
 * A cached answer is an answer about the PREDECESSOR's world. That world
 * stops existing at the first write, so the cache closes then — which is
 * what `askMutating` (a subagent about to run a mutating tool) and a live
 * `world.run` are for.
 *
 * WHAT IS IMPORTED:
 *
 *   actors: keyed by the subagent's NAME, not its site — a revised script
 *     may move the `agent(...)` call. Only named subagents whose name is
 *     unique in the predecessor are imported; anonymous and duplicated
 *     names are skipped. For each, the contiguous prefix of COMPLETED asks
 *     from sequence 0, each with its inputHash, result, stats and
 *     messageBoundary.
 *
 *   world: keyed by inputHash, holding a queue per hash, so the nth
 *     occurrence of the same read is answered by the nth recorded result.
 *
 * Two facts are read from the SESSION rather than from the journal, and
 * both are optional:
 *
 *   - `inFlight`: the ask the predecessor was still running when it
 *     stopped. It carries no result; what it carries is the transcript so
 *     far, so the successor can continue the exchange instead of throwing
 *     it away.
 *   - the session's message count, which is the `messageBoundary` of that
 *     unfinished ask.
 *
 * The preflight (upstream): every completed ask must have a
 * `messageBoundary`. Without one, the transcript truncation has nothing to
 * truncate by, so the whole import is refused — `missing_boundaries`.
 */

import { canonicalJson, inputHash } from './engine.js';

/**
 * @typedef {object} ImportedRunCache
 * @property {Map<string, object>} actors - keyed by subagent name
 * @property {Map<string, object[]>} world - keyed by inputHash, a queue per hash
 */

/**
 * Build the import cache from a settled predecessor's journal.
 *
 * @param {object} journal - the predecessor's journal store
 * @param {string} predecessorRunId - the predecessor's run id
 * @param {object} [options]
 * @param {Record<string, {messageCount: number, sessionId: string}>} [options.sessions]
 *   The predecessor's live sessions, keyed by session id: their message
 *   counts and ids. The journal cannot say how many messages a session
 *   held — only the driver knows that — so the caller supplies it.
 * @returns {{ok: true, cache: ImportedRunCache}|{ok: false, reason: string}}
 */
export function buildImportedCache(journal, predecessorRunId, options = {}) {
  const sessions = options.sessions ?? {};

  // The predecessor's actors, by name. The persona is needed — the cache
  // matches on the canonical persona — so `withPersona` is on.
  const actors = journal.listActors(predecessorRunId, { withPersona: true });
  const byName = new Map();
  const duplicated = new Set();
  for (const actor of actors) {
    const name = typeof actor.name === 'string' ? actor.name.trim() : '';
    // An anonymous actor has no identity of its own, so it cannot be
    // matched against the successor's.
    if (name === '') continue;
    if (byName.has(name)) {
      // A duplicated name makes the match ambiguous: two candidates, no
      // way to say which one the successor means.
      duplicated.add(name);
      continue;
    }
    byName.set(name, actor);
  }
  for (const name of duplicated) byName.delete(name);

  // The predecessor's nodes, by kind. The results are needed — a cached
  // answer IS the result — so `withResult` is on.
  const nodes = journal.listNodes(predecessorRunId, { kinds: 'all', withResult: true });

  // The ask nodes, grouped by their actor and ordered by actorSeq.
  const asksByActor = new Map();
  for (const node of nodes) {
    if (node.kind !== 'ask') continue;
    if (node.actorSiteId === undefined || node.actorOrdinal === undefined) continue;
    const key = `${node.actorSiteId}@${node.actorOrdinal}`;
    if (!asksByActor.has(key)) asksByActor.set(key, []);
    asksByActor.get(key).push(node);
  }
  for (const list of asksByActor.values()) {
    list.sort((a, b) => (a.actorSeq ?? 0) - (b.actorSeq ?? 0));
  }

  // The cache's actor entries.
  const cacheActors = new Map();
  for (const [name, actor] of byName) {
    const list = asksByActor.get(`${actor.siteId}@${actor.ordinal}`) ?? [];

    // The contiguous prefix of COMPLETED asks from sequence 0. A gap or a
    // failed row ends the prefix — there is nothing to import past it.
    const entries = [];
    let expectedSeq = 0;
    for (const node of list) {
      if ((node.actorSeq ?? 0) !== expectedSeq) break;
      if (node.status !== 'completed') break;
      if (node.messageBoundary === undefined) {
        // The preflight: every completed ask must have a boundary. Without
        // one, the transcript truncation has nothing to truncate by, and the
        // whole import is refused rather than half-done.
        return { ok: false, reason: `ask ${node.siteId} has no messageBoundary` };
      }
      entries.push({
        inputHash: node.inputHash,
        result: node.result,
        ...(node.stats ? { stats: node.stats } : {}),
        messageBoundary: node.messageBoundary,
      });
      expectedSeq += 1;
    }

    // The in-flight ask: the `running` row right after the prefix.
    const running = list.find((n) => n.status === 'running' && (n.actorSeq ?? 0) === expectedSeq);
    let inFlight;
    if (running !== undefined && actor.sessionId !== undefined) {
      const session = sessions[actor.sessionId];
      // The count must be STRICTLY greater than the last completed entry's
      // boundary (or greater than zero when nothing completed): an ask that
      // was queued but never dispatched has written nothing past the
      // prefix, and a seed whose count merely repeated the prefix would
      // mark the subagent as having continued an exchange whose transcript
      // it does not hold.
      const lastBoundary = entries.length > 0 ? entries[entries.length - 1].messageBoundary : 0;
      const count = session?.messageCount ?? 0;
      if (count > lastBoundary) {
        inFlight = {
          inputHash: running.inputHash,
          messageBoundary: count,
        };
      }
    }

    if (entries.length === 0 && inFlight === undefined) continue;

    cacheActors.set(name, {
      persona: actor.persona ?? {},
      entries,
      ...(inFlight ? { inFlight } : {}),
      transcriptSourceSessionId: actor.sessionId ?? '',
      ...(actor.resolvedModel ? { resolvedModel: actor.resolvedModel } : {}),
    });
  }

  // The cache's world entries: completed world rows, queued by inputHash.
  const world = new Map();
  for (const node of nodes) {
    if (node.kind !== 'world-read' && node.kind !== 'world-run') continue;
    if (node.status !== 'completed') continue;
    if (!world.has(node.inputHash)) world.set(node.inputHash, []);
    world.get(node.inputHash).push({
      inputHash: node.inputHash,
      kind: node.kind,
      result: node.result,
    });
  }

  return { ok: true, cache: { actors: cacheActors, world } };
}

/**
 * The hash the engine compares a fresh ask against.
 *
 * Upstream hashes the ask's INSTRUCTIONS. The engine computes it from the
 * ask's own message, so this helper exists only for the world's side,
 * where the hash is over `{op, args}`.
 *
 * @param {string} op
 * @param {unknown[]} args
 * @returns {string}
 */
export function worldInputHash(op, args) {
  return inputHash(canonicalJson({ op, args }));
}
