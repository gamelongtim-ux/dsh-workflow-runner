// Verify the published tarball against what the registry recorded.
//
// The registry stores two digests for every tarball: a sha1 (shasum) and a
// sha512 (integrity). If the bytes on the CDN hash to those values, then
// what people download is exactly what was uploaded -- no corruption, no
// substitution, no partial upload.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const NAME = 'dsh-workflow-runner';
// The version comes from the argument, or from package.json for the
// version being worked on.
//
// Hardcoding it would compare one version's tarball against ANOTHER
// version's digests -- which is a wrong answer, not a missing one.
const VERSION = process.argv[3]
  ?? JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const tarballPath = process.argv[2];

console.log(`  verifying ${NAME}@${VERSION}`);
const meta = await (await fetch(`https://registry.npmjs.org/${NAME}/${VERSION}`)).json();
const recorded = meta.dist;

const bytes = readFileSync(tarballPath);
const sha1 = createHash('sha1').update(bytes).digest('hex');
const sha512 = createHash('sha512').update(bytes).digest('base64');
const integrity = `sha512-${sha512}`;

console.log('  the registry recorded:');
console.log(`    shasum    : ${recorded.shasum}`);
console.log(`    integrity : ${recorded.integrity}`);
console.log('  the tarball on the CDN:');
console.log(`    shasum    : ${sha1}`);
console.log(`    integrity : ${integrity}`);
console.log(`    bytes     : ${bytes.length} (the registry says ${recorded.unpackedSize} unpacked)`);

const okSha1 = sha1 === recorded.shasum;
const okIntegrity = integrity === recorded.integrity;
console.log(`  sha1 matches      : ${okSha1 ? 'YES' : 'NO'}`);
console.log(`  sha512 matches    : ${okIntegrity ? 'YES' : 'NO'}`);

// `process.exit()` while a fetch's socket is still open trips an assertion
// in Node on Windows ("handle->flags & UV_HANDLE_CLOSING"). Setting
// process.exitCode and letting the process end on its own does not.
process.exitCode = okSha1 && okIntegrity ? 0 : 1;
