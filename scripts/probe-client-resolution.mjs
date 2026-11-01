// Can the host resolve a PROFILE plugin's manifest the way the client
// scan does?
//
// The host's client-module scan resolves each Loader row's package
// through `nearestPackage(moduleUrl, expectedPackageName)` — which walks
// up from the resolved module and requires the manifest's `name` to equal
// the expected package name EXACTLY.
//
// This reproduces that resolution for the profile's plugins, so the
// answer is measured rather than guessed.
//
// Usage: node scripts/probe-client-resolution.mjs <base-url>

import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const profileDir = join(process.env.USERPROFILE, '.dsh', 'profiles', 'desktop');
const profile = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'));

/** The host's `exactPackageSpecifier`. */
function exactPackageSpecifier(specifier) {
  if (specifier.startsWith('@')) {
    const parts = specifier.split('/');
    return parts.length === 2 && parts.every(Boolean) ? specifier : undefined;
  }
  return specifier.length > 0 && !specifier.includes('/') && !specifier.includes(':')
    ? specifier
    : undefined;
}

/** The host's `nearestPackage`. */
function nearestPackage(moduleUrl, expectedPackageName) {
  if (!moduleUrl.startsWith('file:')) return undefined;
  let dir = dirname(fileURLToPath(moduleUrl));
  while (true) {
    const candidate = join(dir, 'package.json');
    if (existsSync(candidate)) {
      try {
        const name = JSON.parse(readFileSync(candidate, 'utf8')).name;
        if (typeof name === 'string' && (expectedPackageName === undefined || name === expectedPackageName)) {
          return { path: candidate, packageName: name };
        }
      } catch { /* keep walking */ }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

console.log('=== resolving each profile plugin the way the host does ===');
console.log('');

const requireFrom = createRequire(join(profileDir, 'package.json'));

for (const loaderName of Object.keys(profile.dependencies ?? {})) {
  const expected = exactPackageSpecifier(loaderName);
  let moduleUrl;
  let resolveError = null;
  try {
    moduleUrl = pathToFileURL(requireFrom.resolve(loaderName)).href;
  } catch (err) {
    resolveError = String(err.code ?? err.message);
  }
  const located = moduleUrl === undefined ? undefined : nearestPackage(moduleUrl, expected);
  const pkgPath = located?.path ?? undefined;
  let client = null;
  let clientExport = null;
  if (pkgPath !== undefined) {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    client = pkg.dsh?.client ?? null;
    clientExport = pkg.exports?.['./client'] ?? null;
  }
  const clientFile = pkgPath === undefined || typeof clientExport !== 'string'
    ? undefined
    : join(dirname(pkgPath), clientExport);
  console.log(`  ${loaderName}`);
  console.log(`    resolve       : ${resolveError ?? 'ok'}`);
  console.log(`    located       : ${pkgPath ?? 'NOT FOUND'}`);
  console.log(`    dsh.client    : ${JSON.stringify(client)}`);
  console.log(`    exports.client: ${JSON.stringify(clientExport)}`);
  console.log(`    the file      : ${clientFile === undefined ? '(none)' : (existsSync(clientFile) ? 'EXISTS' : 'MISSING')}`);
  console.log('');
}
