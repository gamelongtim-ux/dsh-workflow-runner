// Install the published package from npm and verify it.
//
// This is the end-to-end check of what a person who runs
//   dsh plugin --profile desktop add dsh-workflow-runner
// actually gets.
//
// Usage: node scripts/dwf-publish-install-check.mjs [version]

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const version = process.argv[2] ?? 'latest';
let failures = 0;
function check(label, ok, detail = '') {
  if (!ok) failures += 1;
  process.stdout.write(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? `  — ${detail}` : ''}\n`);
}

const dir = mkdtempSync(join(tmpdir(), 'dwf-pub-'));
console.log(`\n=== installing dsh-workflow-runner@${version} from npm ===`);
// On Windows `npm` is a batch file: a spawned process cannot run one
// without a shell, and `npm.cmd` without one fails with EINVAL.
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const run = (args) =>
  execFileSync(npm, args, {
    cwd: dir,
    stdio: 'pipe',
    shell: process.platform === 'win32',
  });
run(['init', '-y']);
run(['install', `dsh-workflow-runner@${version}`, '--no-audit', '--no-fund']);

const base = join(dir, 'node_modules', 'dsh-workflow-runner');

console.log('\n1. the package is complete');
{
  const pkg = JSON.parse(readFileSync(join(base, 'package.json'), 'utf8'));
  check('the version is what was asked for', pkg.version === version || version === 'latest', pkg.version);
  check('typescript came with it', existsSync(join(dir, 'node_modules', 'typescript')));
  for (const f of [
    'lib/dwf/governor.js',
    'lib/dwf/durable-journal.js',
    'lib/dwf/tool-schema.js',
    'lib/dwf/imported-cache.js',
    'lib/dwf/driver.js',
    'skill/dynamic-workflows/SKILL.md',
    'packages/dynamic-workflow/dist/engine/engine.js',
    'packages/dynamic-workflow-runtime/dist/index.js',
    'public/graph-view.js',
  ]) {
    check(`${f} is present`, existsSync(join(base, f)));
  }
}

console.log('\n2. the chat-path fixes are in the published code');
{
  const plugin = readFileSync(join(base, 'lib', 'plugin.js'), 'utf8');
  const tools = readFileSync(join(base, 'lib', 'dwf', 'tools.js'), 'utf8');
  const runtime = readFileSync(join(base, 'lib', 'runtime.js'), 'utf8');
  check('the skill declares a description', /description: 'Author and run ZCode-style/.test(plugin));
  check('the skill declares a source', /source: 'bundled'/.test(plugin));
  check('the tools are installed into agent scopes', /installIntoAgent/.test(plugin));
  check('the agent view asks for the "agents" service', /ctx\.get\?\.\('agents'\)/.test(plugin));
  check('every tool output is stripped of lossy values', /const lossless = /.test(tools));
  check(
    'an absent settlement error is omitted, not undefined',
    /settlement\.error === undefined/.test(runtime),
  );
  check(
    'an absent journal parsed is omitted, not undefined',
    /parsed === undefined \? \{\} : \{ parsed \}/.test(runtime),
  );
}

console.log('\n3. the engine works');
{
  const { compileWorkflow } = await import(pathToFileURL(join(base, 'lib', 'dwf', 'index.js')).href);
  const out = compileWorkflow(
    'phase("P");\nconst r = await agent("a").ask<{x:number}>("q");\nreport({r});\nreturn {r};',
  );
  check('a typed workflow compiles', out.ok, JSON.stringify(out.sizes));
  check('all four graphs are produced',
    out.sizes?.site > 0 && out.sizes?.causality > 0 && out.sizes?.controlFlow > 0 && out.sizes?.handoff > 0);
  const { createWorkflowTools } = await import(pathToFileURL(join(base, 'lib', 'dwf', 'tools.js')).href);
  const list = createWorkflowTools({
    runtime: null, startEngine: async () => ({}), injectStage: async () => ({}),
    answerQuestion() {}, listPendingHoles: () => [], fillHole: () => ({}),
    listRuns: () => [], snapshot: () => null, listSavedWorkflows: () => [],
    saveWorkflow: () => ({}), skillContent: () => '', evalSnippet: async () => ({}),
  });
  check('all 11 tools are there', list.length === 11, `${list.length}`);
  check('every tool declares an output schema', list.every((t) => t.output?.schema !== undefined));
}

console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures} problem(s))`}`);
process.exitCode = failures === 0 ? 0 : 1;
