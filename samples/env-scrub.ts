// dsh-workflow-runner sample — verify env scrubbing
//
// v0.9.0: the runtime's `_scrubChildEnv()` strips API keys, OAuth
// tokens, cloud creds, and DSH bookkeeping from the workflow
// child's `process.env` before spawn. This sample reads what the
// child actually sees, plus spawns a `node -e` shell to count
// KEY/TOKEN/SECRET-bearing env keys from the perspective of a
// second-tier process (i.e. `world.run`'s shell child). Expected
// on a host with `DSH_API_KEY=...` / `DEEPSEEK_API_KEY=...` set:
//   - `hasDshApiKey === false` in the workflow child
//   - `hasDeepSeekApiKey === false` in the workflow child
//   - `hasNodeOptions === false` in the workflow child
//   - shell child `wc.stdout === '0 sensitive keys visible'`
//
// The runtime's startup log line tells the user how many keys
// were stripped — see the run state for that.
//
// Note: this sample is typechecked under v0.8.0 strict and runs
// without an LLM key. It's a quick smoke test for the sandbox.

phase('Sandbox: read process.env keys visible to the child');

// `process` is a Node global — the workflow facade doesn't expose
// it (that would let any script read unscrubbed host env, which is
// exactly what the sandbox prevents). We access it via a narrow
// cast so the typecheck pass doesn't require @types/node.
const env = ((globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env) || {};
const keys: string[] = Object.keys(env).sort();
const dshWorkflowKeys: string[] = keys.filter((k) => k.startsWith('DSH_WORKFLOW_'));
const hasDeepSeekKey: boolean = !!env.DEEPSEEK_API_KEY;
const hasDshApiKey: boolean = !!env.DSH_API_KEY;
const hasNodeOptions: boolean = !!env.NODE_OPTIONS;
const hasAwsAccessKey: boolean = !!env.AWS_ACCESS_KEY_ID;
const hasLdPreload: boolean = !!env.LD_PRELOAD;

log(`visible env keys: ${keys.length}`);
log(`DSH_WORKFLOW_* keys present: ${dshWorkflowKeys.join(', ') || '(none)'}`);

report({
  totalKeys: keys.length,
  dshWorkflowKeys,
  hasDeepSeekKey,
  hasDshApiKey,
  hasNodeOptions,
  hasAwsAccessKey,
  hasLdPreload,
  // First 30 keys as a sample, useful for verifying the allowlist.
  sampleKeys: keys.slice(0, 30),
}, 'sandbox');

phase('Sandbox: ask a child shell how many KEY/TOKEN/SECRET keys it sees');
const wc = await world.run(
  'node',
  [
    '-e',
    "const k = Object.keys(process.env).filter((x) => /KEY|TOKEN|SECRET/.test(x));" +
    "process.stdout.write(k.length + ' sensitive keys visible')",
  ],
  { timeoutMs: 5000 },
);
log(`shell child saw: ${wc.stdout.trim()}`);

phase('Sandbox: try to escape workspace via files.glob (should be rejected)');
let escapeRejected = false;
try {
  await files.glob('/etc/**/shadow');
} catch (err) {
  escapeRejected = true;
  log(`files.glob escape rejected as expected: ${(err as Error).message?.split('\n')[0]}`);
}
report({ escapeRejected }, 'path-escape');

phase('Done');
log('env-scrub complete');

export default async function main(): Promise<{
  totalKeys: number;
  dshWorkflowKeys: readonly string[];
  sensitiveLeaks: {
    hasDeepSeekKey: boolean;
    hasDshApiKey: boolean;
    hasNodeOptions: boolean;
    hasAwsAccessKey: boolean;
    hasLdPreload: boolean;
  };
  shellChildSensitiveKeyCount: number;
  pathEscapeRejected: boolean;
  ranAt: string;
}> {
  const shellCount = Number((wc.stdout.trim() || '0').split(' ')[0]) || 0;
  return {
    totalKeys: keys.length,
    dshWorkflowKeys,
    sensitiveLeaks: {
      hasDeepSeekKey,
      hasDshApiKey,
      hasNodeOptions,
      hasAwsAccessKey,
      hasLdPreload,
    },
    shellChildSensitiveKeyCount: shellCount,
    pathEscapeRejected: escapeRejected,
    ranAt: new Date().toISOString(),
  };
}