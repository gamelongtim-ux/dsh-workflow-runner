// Verify the published tarball against what the registry recorded.
//
// The registry stores two digests for every tarball: a sha1 (shasum) and a
// sha512 (integrity). If the bytes on the CDN hash to those values, then
// what people download is exactly what was uploaded -- no corruption, no
// substitution, no partial upload.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const VERSION = '0.16.2';
const NAME = 'dsh-workflow-runner';
const tarballPath = process.argv[2];

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

process.exit(okSha1 && okIntegrity ? 0 : 1);
