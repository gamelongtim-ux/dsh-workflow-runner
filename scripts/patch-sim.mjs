// Reproduce dsh's patch application for the workflow-runner row.
//
// The algorithm is the one from @deepseek-ai/cordis-plugin-include
// (applyEntryPatches), reimplemented here so it can run without the packed
// asar. It is a faithful transcription of the upstream function:
//   - patches are applied in order
//   - `insert` without an `id` appends to the entry list
//   - `insert` with an `id` appends into that group entry's `config`
//   - an id-targeted patch with no `insert` sets the named keys on the
//     matched entry, and `disabled` is one of those keys
//   - a patch that matches nothing warns and is skipped
//
// Usage: node scripts/patch-sim.mjs <profile-dir>

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

// js-yaml is not a dependency of this package. The DSH profile has it
// (cordis-plugin-include needs it), so borrow that copy when this repo's
// own node_modules does not carry one.
const require = createRequire(import.meta.url);
let yaml;
try {
  yaml = require('js-yaml');
} catch {
  const profileRequire = createRequire(
    join(process.env.USERPROFILE ?? '', '.dsh', 'profiles', 'desktop', 'package.json'),
  );
  yaml = profileRequire('js-yaml');
}

const dir = process.argv[2];
if (!dir) {
  process.stderr.write('usage: patch-sim.mjs <profile-dir>\n');
  process.exit(1);
}

const JsExpr = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  resolve: (d) => typeof d === 'string',
  construct: (d) => ({ __jsExpr: d }),
  predicate: (d) => typeof d === 'string' && d.trimStart().startsWith('!!js'),
  represent: (d) => d['__jsExpr'],
});
const schema = yaml.JSON_SCHEMA.extend(JsExpr);

function applyEntryPatches(data, patches, warn) {
  if (!patches?.length) return [...data];
  data = structuredClone(data);
  const entryMap = new Map();
  const buildMap = (entries) => {
    for (const entry of entries) {
      if (entry.id) entryMap.set(entry.id, entry);
      if (entry.group && Array.isArray(entry.config)) buildMap(entry.config);
    }
  };
  buildMap(data);
  for (const patch of patches) {
    const { id, insert, name, ...overrides } = patch;
    if (insert) {
      if (id) {
        const target = entryMap.get(id);
        if (!target) { warn('patch insert: entry %C not found', id); continue; }
        if (!target.group) { warn('patch insert: entry %C is not a group', id); continue; }
        if (!Array.isArray(target.config)) target.config = [];
        target.config.push(...insert);
      } else data.push(...insert);
      buildMap(insert);
      continue;
    }
    if (!id) { warn('patch: id is required for non-insert patches'); continue; }
    const target = entryMap.get(id);
    if (!target) { warn('patch: entry %C not found', id); continue; }
    if (name && name !== target.name) {
      warn('patch: name mismatch for %C (expected %C, got %C), skipping', id, target.name, name);
      continue;
    }
    for (const [key, value] of Object.entries(overrides)) {
      if (key === 'id') continue;
      target[key] = value;
    }
  }
  return data;
}

// The profile root is an empty entry list; the plugin enters via the
// profile's own patch layer.
const patchFile = join(dir, 'cordis.patch.yml');
const content = readFileSync(patchFile, 'utf8');
const patches = yaml.load(content, { schema });

const warnings = [];
const composed = applyEntryPatches([], patches, (m, ...a) => {
  let i = 0;
  warnings.push(m.replace(/%C/g, () => JSON.stringify(a[i++])));
});

const rows = composed.map((e) => ({
  id: e.id,
  name: e.name,
  disabled: e.disabled,
  config: e.config,
  group: !!e.group,
}));

console.log('warnings:', JSON.stringify(warnings));
console.log('composed rows:', JSON.stringify(rows, null, 2));

const wf = rows.find((r) => r.id === 'dsh-workflow-runner');
console.log('\n--- verdict ---');
if (!wf) {
  console.log('NO ROW: the plugin was never inserted');
} else if (wf.disabled) {
  console.log('DISABLED: the row exists but carries disabled=true -> the plugin never activates');
} else {
  console.log('ACTIVE: the row exists and is not disabled');
}
