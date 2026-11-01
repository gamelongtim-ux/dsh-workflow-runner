// Does the facade check actually FAIL when a name goes missing?
//
// A check that cannot fail is not a check. This proves the one can, by
// removing an upstream name from the facade and confirming the check
// catches it.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const FACADE = 'lib/dwf/dsh-facade.js';
const original = readFileSync(FACADE, 'utf8');
let exitCode = 0;

console.log('\n1. the check passes on the real facade');
{
  const out = execFileSync(process.execPath, ['scripts/dwf-facade-compare.mjs'], { encoding: 'utf8' });
  console.log('  ' + out.trim().split('\n').pop());
}

console.log('\n2. remove an upstream name, and the check must fail');
{
  // `world.run` is upstream's, and it lives in upstream's FACADE_DTS --
  // which the plugin imports. Renaming `run` inside the `world` namespace
  // must make the comparison notice.
  const DTs = 'packages/dynamic-workflow/src/facade/dts.ts';
  const originalDts = readFileSync(DTs, 'utf8');
  const mangled = originalDts.replace(
    /(declare const world: \{[\s\S]*?)\n(\s*)run\(/,
    '$1\n$2run_RENAMED(',
  );
  if (mangled === originalDts) {
    console.log('  [FAIL] the injection did not apply — upstream declares no `world.run` to rename');
    exitCode = 1;
  } else {
    writeFileSync(DTs, mangled);
    // The plugin imports the COMPILED dts, so the build has to see it.
    execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'packages/dynamic-workflow/tsconfig.runtime.json'], { stdio: 'pipe' });
    let failed = false;
    let reported = '';
    try {
      execFileSync(process.execPath, ['scripts/dwf-facade-compare.mjs'], { encoding: 'utf8', stdio: 'pipe' });
    } catch (err) {
      failed = true;
      const out = String(err.stdout ?? '');
      reported = out.split('\n').filter((l) => l.includes('[FAIL]')).slice(0, 4).map((l) => l.trim()).join('\n    ');
    }
    console.log('  the check reported:');
    console.log('    ' + (reported || '(nothing — it failed without saying why)'));
    console.log(`  [${failed ? 'PASS' : 'FAIL'}] the check fails when an upstream name goes missing`);
    if (!failed) exitCode = 1;
    writeFileSync(DTs, originalDts);
    execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'packages/dynamic-workflow/tsconfig.runtime.json'], { stdio: 'pipe' });
  }
}

console.log('\n3. the facade is restored, and the check passes again');
{
  const out = execFileSync(process.execPath, ['scripts/dwf-facade-compare.mjs'], { encoding: 'utf8' });
  console.log('  ' + out.trim().split('\n').pop());
}

process.exitCode = exitCode;
