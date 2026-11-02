// The chat path: is the plugin reachable from a CHAT TURN?
//
// Three different facts, and only the third one means a model can use
// the plugin:
//
//   1. the plugin LOADED            — the /workflow/ route answers
//   2. the host RECEIVED the tools  — they are in the tools registry
//   3. a LIVE AGENT can see them   — ctx.tools.schemas(agent)
//
// The third is the one that matters, and it is scope-aware: an agent sees
// the global layer plus its own scope chain, and every layer must admit
// the name. A registration that SUCCEEDED can still be invisible to the
// chat.
//
// This runs the plugin's OWN diagnostics endpoint against a LIVE host and
// asserts what it reports. The plugin answers with:
//   registration  — what the host's registry holds
//   agentViews    — what each live agent sees, and which of OUR tools
//                   are missing from it
//
// Usage: node scripts/dwf-chat-path-check.mjs [base-url]
//
// With no base-url it runs against a local in-process runtime and only
// checks the plugin's own wiring.

import { execFileSync } from 'node:child_process';

const base = process.argv[2];
let failures = 0;
function check(label, ok, detail = '') {
  if (!ok) failures += 1;
  process.stdout.write(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? `  — ${detail}` : ''}\n`);
}

if (base === undefined) {
  console.log('\n1. the plugin registers what it claims to');
  {
    // The apply check registers against a fake ctx, which is what proves
    // the registrations happen at all.
    const out = execFileSync(process.execPath, [
      '--import', './scripts/register-schemastery-stub.mjs',
      'scripts/dwf-apply-check.mjs',
    ], { encoding: 'utf8' });
    check('the plugin activates and registers', out.includes('PASS'), out.trim().split('\n').pop());
    check('it registers 11 tools', out.includes('tools registered    : 11'));
    check('it registers the skill', out.includes('skills registered   : 1'));
  }

  console.log('\n2. the diagnostics endpoint exists and answers');
  {
    // The endpoint is what this whole check is built on, so its absence
    // would silently make the check vacuous.
    const src = await import('node:fs').then((fs) =>
      fs.readFileSync('lib/plugin.js', 'utf8'),
    );
    check('the endpoint is registered', src.includes("'/api/tool-schema'"));
    check('it reports the agent views', src.includes('agentViews'));
    check('it reports the skill view', src.includes('collectSkillNames'));
    check('it reports the tool registration', src.includes('registration: toolRegistration'));
  }

  console.log('\n3. the skill definition satisfies the host\'s validator');
  {
    // The host validates a runtime skill before filing it:
    //   validateRuntimeSkill -> a name matching SKILL_NAME, a NON-EMPTY
    //   description, and a valid invocation.
    //
    // A missing description throws INSIDE register(), which is why the
    // skill silently did not exist -- on the host or in any agent, and
    // why every check that read the registry reported an absence without
    // saying why.
    const src = await import('node:fs').then((fs) =>
      fs.readFileSync('lib/plugin.js', 'utf8'),
    );
    const definition = src.match(/name: 'dynamic-workflows',\s*\n(?:\s*[^\n]*\n)*?\s*\};/);
    check('the skill definition is found', definition !== null);
    if (definition !== null) {
      const body = definition[0];
      // The description line must be INSIDE this definition -- a match
      // anywhere in the file would find some other description.
      const m = /description:\s*'([^']*)'/.exec(body);
      check(
        'it declares a non-empty description',
        m !== null && m[1].trim().length > 0,
        m === null ? '(no description — the host rejects this)' : `${m[1].trim().length} chars`,
      );
      check('it declares the invocation', body.includes('modelInvocable'));
      // `source` is a classification label ("bundled", "project-dsh",
      // "custom"). The host's LOADER requires it to be a string:
      // validateDefinition rejects a loaded skill whose source is not.
      // `register()` fills in `provider`, but nothing fills in `source` --
      // so a runtime skill that omits it registers and then fails to LOAD.
      const source = /source:\s*'([^']*)'/.exec(body);
      check(
        'it declares a source',
        source !== null && source[1].trim().length > 0,
        source === null ? '(no source — the host cannot load it)' : source[1],
      );
      check('it declares the content', /content:\s*SKILL_CONTENT/.test(body));
    }
  }
} else {
  console.log(`\n=== the chat path, against ${base} ===`);

  const r = await fetch(`${base}/workflow/api/tool-schema`, {
    headers: {
      accept: 'application/json',
      referer: `${base}/workflow/`,
      origin: base,
    },
  });
  check('the diagnostics endpoint answers', r.status === 200, `status=${r.status}`);
  if (r.status !== 200) {
    process.exitCode = 1;
  } else {
    const j = await r.json();

    console.log('\n1. the host received the tools');
    check(
      'all 11 tools are in the host registry',
      (j.registration?.missing ?? []).length === 0,
      `missing: ${JSON.stringify(j.registration?.missing)}`,
    );

    console.log('\n2. the skill is in the host registry');
    check(
      'the dynamic-workflows skill is registered',
      (j.skill?.missing ?? []).length === 0,
      `missing: ${JSON.stringify(j.skill?.missing)}`,
    );

    console.log('\n3. a LIVE AGENT can see them');
    const views = j.agentViews ?? [];
    if (views.length === 0) {
      // No agent yet: the chat has not run. That is not a failure — but it
      // is also not a proof, and saying so is the point.
      console.log('  [SKIP] no live agent — start a chat turn, then re-run this check');
      console.log('         (the agent views are only meaningful once an agent exists)');
    } else {
      for (const v of views) {
        check(
          `agent ${v.id} sees all 11 of our tools`,
          (v.missingOurs ?? []).length === 0,
          `it sees ${v.toolCount} tool(s); missing: ${JSON.stringify(v.missingOurs)}`,
        );
        check(
          `agent ${v.id} sees the dynamic-workflows skill`,
          v.hasOurSkill === true,
          `it sees ${v.skillCount} skill(s)`,
        );
      }
    }
  }
}

console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures} problem(s))`}`);
process.exitCode = failures === 0 ? 0 : 1;
