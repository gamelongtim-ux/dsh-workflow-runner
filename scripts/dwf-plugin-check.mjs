// The plugin entry must load, and the bundled skill must be there for the
// brief tool to hand out.
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');

const plugin = await import(pathToFileURL(join(repoRoot, 'lib', 'plugin.js')).href);
const names = Object.keys(plugin).sort();
if (!names.includes('apply')) {
  console.error('no apply export:', names);
  process.exit(1);
}
console.log('plugin exports ok:', names.join(', '));

const skill = readFileSync(join(repoRoot, 'skill', 'dynamic-workflows', 'SKILL.md'), 'utf8');
if (!skill.includes('name: dynamic-workflows')) {
  console.error('the skill has no frontmatter');
  process.exit(1);
}
console.log('the skill is there,', skill.length, 'bytes');
