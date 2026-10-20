// What does the host's schemastery actually expose?
//
// Run against a dsh profile's copy, this reports the real surface: the
// static factories on the default export, and the instance methods on a
// schema. The repo's own copy of this file is the reference for what a
// plugin may call.
//
// Usage: node scripts/probe-schemastery.mjs <path-to-schemastery-lib.mjs>

const target = process.argv[2];
if (!target) {
  process.stderr.write('usage: probe-schemastery.mjs <path-to-schemastery-lib.mjs>\n');
  process.exit(2);
}

const mod = await import(`file:///${target.replace(/\\/g, '/')}`);
const Schema = mod.default ?? mod;

console.log('namespace keys :', Object.keys(mod).join(', ') || '(none)');
console.log('default export :', typeof Schema, Schema?.name);
console.log('has .z         :', typeof Schema?.z);

const statics = Object.getOwnPropertyNames(Schema)
  .filter((k) => typeof Schema[k] === 'function')
  .sort();
console.log(`statics (${statics.length})  :`, statics.join(', '));

const str = Schema.string();
const instances = new Set();
for (const k of Object.getOwnPropertyNames(Object.getPrototypeOf(str))) {
  if (k === 'constructor') continue;
  if (typeof str[k] === 'function') instances.add(k);
}
console.log(`instance methods:`, [...instances].sort().join(', '));

for (const m of ['object', 'string', 'number', 'boolean', 'array', 'any', 'never', 'const']) {
  console.log(`  static ${m.padEnd(8)}:`, typeof Schema[m]);
}
for (const m of ['nullable', 'optional', 'int', 'min', 'max', 'describe', 'default']) {
  console.log(`  instance ${m.padEnd(8)}:`, typeof str[m]);
}
