// Read the host's chat transcript for a session.
//
// The host keeps a session's events as SEQUENCE-NUMBERED ROWS inside the
// projection at ~/.dsh/storages/session_projcache/sessions/<id>.json.
// Each row is { ver, seq, val }.
//
// "Input a message and nothing happens" has several shapes -- the model
// answered without touching the plugin, the model tried and the tool
// failed, the turn never started, or the tools were never offered -- and
// the transcript tells them apart.
//
// Usage: node scripts/probe-chat-transcript.mjs [session-id]

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
const list = wanted === undefined ? all.slice(0, 2) : all.filter((x) => x.id === wanted);

for (const { id, p, t } of list) {
  const j = JSON.parse(readFileSync(p, 'utf8'));
  const rows = j.record?.rows ?? {};
  console.log(`=== ${id} (${new Date(t).toLocaleString()}) ===`);
  console.log(`  ${Object.keys(rows).length} row kinds: ${Object.keys(rows).slice(0, 20).join(', ')}`);

  // The transcript rows, in sequence order.
  for (const key of Object.keys(rows)) {
    if (!/turnOutline/i.test(key)) continue;
    const turns = rows[key]?.val?.turns ?? [];
    console.log(`  --- ${key}: ${turns.length} turn(s) ---`);
    // The last few turns: the recent ones are what the question is about.
    for (const turn of turns.slice(-4)) {
      console.log(`    turn ${turn.turn} (seq ${turn.seq})`);
      console.log(`      prompt : ${String(turn.prompt ?? '').slice(0, 200).replace(/\n/g, ' ')}`);
      console.log(`      response: ${String(turn.response ?? '').slice(0, 300).replace(/\n/g, ' ')}`);
      const blob = JSON.stringify(turn);
      const ours = OURS.filter((n) => blob.includes(n));
      if (ours.length > 0) console.log(`      >>> OURS: ${ours.join(', ')}`);
    }
  }

  // The turn boundary and the inbox: they say whether the LAST turn
  // actually reached the model.
  for (const key of ['turnBoundary', 'inbox', 'sessionStats', 'agentPreset']) {
    const row = rows[key];
    if (row === undefined) continue;
    console.log(`  --- ${key} (seq ${row.seq}) ---`);
    console.log('      ' + JSON.stringify(row.val).slice(0, 700));
  }

  // The per-step activity: what the last turn's steps DID. This is where
  // "the model called the tool and it failed" shows up.
  for (const key of ['contextActivity', 'contextTimeline']) {
    const row = rows[key];
    if (row === undefined) continue;
    const val = row.val;
    const entries = Array.isArray(val) ? val : (val?.entries ?? val?.steps ?? []);
    console.log(`  --- ${key}: ${Array.isArray(entries) ? entries.length : '?'} entr(ies) ---`);
    for (const e of (Array.isArray(entries) ? entries : []).slice(-8)) {
      const blob = JSON.stringify(e);
      const ours = OURS.filter((n) => blob.includes(n));
      console.log(`    ${blob.slice(0, 240)}${ours.length > 0 ? '  >>> OURS: ' + ours.join(',') : ''}`);
    }
  }
  console.log('');
}
