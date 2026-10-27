// Which schema conversion did the plugin actually use?
//
// The plugin prefers the host's `@deepseek-ai/dsh-tools` `defineTool`
// and falls back to its own. The two produce the same schema, but the
// host's also validates the arguments before the tool body runs — so
// which one is in use matters.
//
// The plugin reports it on an endpoint that is cheap to call, so the
// answer can be read from a live host.
//
// Usage: node scripts/probe-tool-schema-path.mjs
//
//   node scripts/probe-tool-schema-path.mjs <base-url>
//
// Prints the host's answer as JSON.

const base = process.argv[2];
if (!base) {
  process.stderr.write('usage: probe-tool-schema-path.mjs <base-url>\n');
  process.exit(1);
}

const hdr = {
  Accept: 'application/json',
  Referer: `${base}/workflow/`,
  Origin: base,
};

try {
  const r = await fetch(`${base}/workflow/api/tool-schema`, { headers: hdr });
  const text = await r.text();
  process.stdout.write(`${text}\n`);
} catch (err) {
  process.stderr.write(`err: ${String(err && err.message || err)}\n`);
  process.exit(1);
}
