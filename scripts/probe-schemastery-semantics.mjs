// Probe the exact semantics this plugin's Config schema needs.
//
// Usage: node scripts/probe-schemastery-semantics.mjs <path-to-schemastery-lib.mjs>

const target = process.argv[2];
if (!target) {
  process.stderr.write('usage: probe-schemastery-semantics.mjs <path-to-schemastery-lib.mjs>\n');
  process.exit(2);
}

const mod = await import(`file:///${target.replace(/\\/g, '/')}`);
const z = mod.default ?? mod;

const show = (label, fn) => {
  try {
    console.log(`${label}:`, fn());
  } catch (e) {
    console.log(`${label}: THREW ${e.message}`);
  }
};

// This version validates through the static resolve(), not a .validate() method.
const val = (data, schema) => JSON.stringify(z.resolve(data, schema, {})[0]);

show('string().default(null) <- null     ', () => val(null, z.string().default(null)));
show('string().default(null) <- undefined', () => val(undefined, z.string().default(null)));
show('string().default(null) <- "x"       ', () => val('x', z.string().default(null)));

show('number().step(1) <- 8              ', () => val(8, z.number().step(1)));
show('number().step(1) <- 1.5            ', () => val(1.5, z.number().step(1)));
show('number().min(1).max(256) <- 0      ', () => val(0, z.number().min(1).max(256)));
show('number().min(1).max(256) <- 300    ', () => val(300, z.number().min(1).max(256)));
show('number().min(1).max(256) <- 8      ', () => val(8, z.number().min(1).max(256)));

show('object({}) <- {}                   ', () => val({}, z.object({
  path: z.string().default('/workflow'),
  root: z.string().default(null),
  sub: z.object({ flag: z.boolean().default(true) }).default({ flag: true }),
})));

show('object({}) <- {path:"/x"}          ', () => val({ path: '/x' }, z.object({
  path: z.string().default('/workflow'),
  root: z.string().default(null),
  sub: z.object({ flag: z.boolean().default(true) }).default({ flag: true }),
})));

show('array().default([]) <- undefined   ', () => val(undefined, z.array(z.string()).default([])));
show('required() <- undefined            ', () => val(undefined, z.string().required()));
