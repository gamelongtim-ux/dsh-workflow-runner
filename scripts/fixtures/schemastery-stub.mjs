// A stand-in for @deepseek-ai/schemastery, with the same shape as the real
// one.
//
// The point is fidelity, not functionality. The real package (3.18.x) is
// probed at scripts/probe-schemastery.mjs; this stub mirrors what that
// probe found:
//
//   - the `z` namespace is the DEFAULT export
//   - there is NO `z` property on it
//   - a description is `.description()`, not `.describe()`
//   - there is no `.nullable()`, no `.optional()`, no `.int()`
//   - an integer is `.step(1)`
//
// Anything else — a method that does not exist here — is left undefined, so
// calling it throws. That is the whole point: a plugin that reaches for an
// API the real package does not have fails here, in the repo, instead of in
// a user's dsh profile.

const STATIC_FACTORIES = [
  'object', 'string', 'number', 'boolean', 'array', 'any', 'never', 'const',
  'union', 'intersect', 'tuple', 'dict', 'date', 'natural', 'percent',
  'regExp', 'function', 'lazy', 'transform', 'bitset', 'arrayBuffer',
];

const INSTANCE_METHODS = [
  'default', 'description', 'required', 'min', 'max', 'step', 'pattern',
  'comment', 'hidden', 'loose', 'role', 'link', 'collapse', 'deprecated',
  'experimental', 'disabled', 'set', 'push', 'simplify', 'i18n', 'volatile',
  'extra',
];

class Schema {
  constructor(kind) {
    this.kind = kind;
  }
}

for (const name of STATIC_FACTORIES) {
  Schema[name] = (...args) => new Schema(name);
}
for (const name of INSTANCE_METHODS) {
  Schema.prototype[name] = function method() {
    return this;
  };
}

export default Schema;
