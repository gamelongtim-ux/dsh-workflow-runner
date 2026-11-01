// The chat's message timeline.
//
// The projection's `contextTimeline` row is the session's message log: a
// 900 KB JSON array of what was said and done. The last turn's entries
// answer "what did the model actually do".
//
// Usage: node scripts/probe-chat-timeline.mjs [session-id]

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const OURS = [
  'create_workflow', 'dynamic_workflows_brief', 'amend_workflow', 'save_workflow',
  'list_workflow_runs', 'get_workflow_run', 'resume_workflow', 'fill_workflow_hole',
  'eval_workflow_snippet', 'resolve_workflow_question', 'list_saved_workflows',
];

const home = process.env.USERPROFILE;
const cacheDir = join(home, '.dsh', 'storages', 'session_projcache', 'sessions');

const wanted = process.argv[2];
const all = readdirSync(cacheDir)
  .filter((f) => f.endsWith('.json'))
  .map((f) => ({ id: f.replace(/\.json$/, ''), p: join(cacheDir, f), t: statSync(join(cacheDir, f)).mtimeMs }))
  .sort((a, b) => b.t - a.t);
const list = wanted === undefined ? all.slice(0, 1) : all.filter((x) => x.id === wanted);

for (const { id, p } of list) {
  const j = JSON.parse(readFileSync(p, 'utf8'));
  const timeline = j.record?.rows?.contextTimeline?.val ?? {};
  // `surface` is the message timeline: one entry per assistant message,
  // tool call and tool result, in order.
  const entries = Array.isArray(timeline) ? timeline : (timeline.surface ?? []);
  console.log(`=== ${id}: ${entries.length} surface entr(ies) ===`);
  console.log(`  the model: ${timeline.model ?? timeline.lastModel ?? '?'} (${timeline.provider ?? '?'})`);

  const tail = entries.slice(-Number(process.argv[3] ?? 14));
  for (const e of tail) {
    const blob = JSON.stringify(e);
    const ours = OURS.filter((n) => blob.includes(n));
    const cat = e?.cat ?? e?.kind ?? e?.type ?? '?';
    console.log(`  [${cat}]${e?.tool ? ' ' + e.tool : ''}${ours.length > 0 ? '  >>> OURS: ' + ours.join(',') : ''}`);
    if (typeof e?.text === 'string' && e.text !== '') {
      console.log(`      ${e.text.slice(0, 320).replace(/\n/g, ' ')}`);
    } else {
      console.log('      ' + blob.slice(0, 320));
    }
  }

  // EVERY turn that mentions one of our tools, with the turn's prompt.
  console.log('  --- the turns that mention our tools ---');
  const byTurn = new Map();
  for (const e of entries) {
    const turn = e?.turn;
    if (turn === undefined) continue;
    if (!byTurn.has(turn)) byTurn.set(turn, []);
    byTurn.get(turn).push(e);
  }
  for (const [turn, es] of [...byTurn.entries()].sort((a, b) => a[0] - b[0])) {
    const blob = JSON.stringify(es);
    const ours = OURS.filter((n) => blob.includes(n));
    if (ours.length === 0) continue;
    const prompts = es.filter((e) => e?.cat === 'user' || e?.role === 'user').map((e) => e?.text);
    console.log(`    turn ${turn}: ${ours.join(', ')}`);
    for (const pr of prompts.slice(0, 2)) console.log(`        prompt: ${String(pr).slice(0, 120).replace(/\n/g, ' ')}`);
  }
  console.log('');
}
