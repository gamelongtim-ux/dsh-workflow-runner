// The public/ directory ships file by file, and this checks that list.
//
// npm's "files" field wins over .npmignore: a directory entry keeps
// everything inside it. So listing "public" would also ship the dev
// artifacts in there, and the .npmignore rule that excludes them would
// silently do nothing — the file goes into the tarball anyway.
//
// The fix is to list the real assets by name. But a name list is only as
// good as the promise behind it, and the promise is ".npmignore means
// excluded". So this checks that promise, file by file:
//
//   - every name in package.json's "files" must exist
//   - every file .npmignore excludes must genuinely stay out of the tarball:
//     not listed by name, and not inside any directory that is listed
//     wholesale
//
// A violation is the exact bug this exists to catch: a file the package
// says it does not ship, shipping anyway.
//
// It runs on prepack, so the failure lands on the pack, not on a user's
// install.
//
// Usage: node scripts/check-pack-contents.mjs

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');

const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
const files = pkg.files ?? [];

/** A .npmignore pattern → a matcher. Only what this repo uses: a path, with
 *  `*` for one segment and `**` for any number of them. */
function patternToRegExp(pattern) {
  const segments = pattern.split('/');
  let source = '';
  for (const [i, segment] of segments.entries()) {
    if (segment === '**') {
      source += '(?:[^/]+/)*';
      continue;
    }
    source += segment.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*');
    if (i < segments.length - 1) source += '/';
  }
  return new RegExp(`^${source}$`);
}

const ignorePatterns = readFileSync(join(repoRoot, '.npmignore'), 'utf8')
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith('#'))
  .map((pattern) => ({ pattern, re: patternToRegExp(pattern) }));

const toPosix = (p) => p.split(sep).join('/');
const problems = [];

// 1. Nothing listed that is not there.
for (const entry of files) {
  if (!existsSync(join(repoRoot, entry))) {
    problems.push(`package.json "files" lists "${entry}", which does not exist`);
  }
}

// The directories that are shipped wholesale — anything under one of them
// goes into the tarball, whatever .npmignore says.
const wholesaleDirs = files.filter((entry) => existsSync(join(repoRoot, entry)) && statSync(join(repoRoot, entry)).isDirectory());

// 2. Every file .npmignore excludes must really be excluded.
for (const { pattern, re } of ignorePatterns) {
  // The patterns here are repo-root paths. Resolve the ones without a
  // wildcard directly; a wildcard pattern would need a repo walk, and this
  // repo does not use one.
  if (pattern.includes('*')) {
    problems.push(`.npmignore pattern "${pattern}" uses a wildcard; this check only handles plain paths`);
    continue;
  }
  const abs = join(repoRoot, pattern);
  if (!existsSync(abs) || !statSync(abs).isFile()) continue; // the rule points at nothing; nothing to protect

  const rel = toPosix(relative(repoRoot, abs));
  if (files.includes(rel)) {
    problems.push(`"${rel}" is excluded by .npmignore but is also listed in package.json "files"`);
  }
  const inWholesale = wholesaleDirs.find((dir) => rel === dir || rel.startsWith(`${toPosix(dir)}/`));
  if (inWholesale) {
    problems.push(
      `"${rel}" is excluded by .npmignore, but "${inWholesale}" is listed as a directory — npm keeps everything inside a listed directory, so this file would ship anyway. List the directory's real contents by name instead.`,
    );
  }
}

if (problems.length > 0) {
  process.stderr.write('package contents check failed:\n');
  for (const p of problems) process.stderr.write(`  - ${p}\n`);
  process.stderr.write('\n');
  process.exit(1);
}

process.stdout.write(
  `package contents check: OK (${files.length} "files" entries, ${ignorePatterns.length} .npmignore rule(s) honoured)\n`,
);
