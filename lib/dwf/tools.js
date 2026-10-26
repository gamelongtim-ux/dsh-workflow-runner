/**
 * The model-facing tools of a Dynamic Workflow.
 *
 * Until these exist, the plugin is something the USER drives through the
 * editor. These are what make it something the MODEL can drive: the model
 * authors a workflow, runs it, watches it, answers the questions it asks,
 * amends it, and keeps the ones worth keeping.
 *
 * The set mirrors ZCode's, with dsh's own additions and one deliberate
 * difference: dsh's `amend_workflow` injects a STAGE into a live run (dsh's
 * structural amend), not a re-run with an imported cache. The imported-cache
 * re-run is a different mechanism and a different contract; the structural one
 * is what dsh's runtime has always done, and it is the one that inherits the
 * running workflow's agents, workspace and sandbox.
 *
 * Everything here takes its capabilities as dependencies, so this module
 * knows nothing about cordis, about the HTTP layer, or about how a saved
 * workflow is stored. The host wires those up.
 */

/**
 * @typedef {object} WorkflowToolDeps
 * @property {object} runtime - the WorkflowRuntime
 * @property {(opts: object) => Promise<object>} startEngine - start a run on the engine
 * @property {(opts: object) => Promise<object>} injectStage - dsh's structural amend
 * @property {(runId: string, opts: object) => void} answerQuestion - answer a parked question
 * @property {(runId: string) => string[]} listPendingHoles - the holes waiting for a body
 * @property {(runId: string, holeId: string, body: string) => void} fillHole - fill a hole
 * @property {() => Array<object>} listRuns
 * @property {(runId: string) => object|null} snapshot
 * @property {() => Array<object>} listSavedWorkflows
 * @property {(name: string) => Promise<string>} [readSavedWorkflow] - a saved workflow's source, by name
 * @property {(name: string, spec: object) => object} saveWorkflow
 * @property {() => string} skillContent - the authoring contract
 * @property {(opts: object) => Promise<object>} evalSnippet
 * @property {string} [defaultWorkspaceRoot]
 */

/**
 * The gate.
 *
 * ZCode refuses to accept a workflow script from a model that has not read
 * the authoring contract, because the contract is the only place the rules
 * live. The same holds here: the tool that runs a workflow refuses until the
 * model has read the brief.
 *
 * The gate is per calling agent, not global: two agents in the same session
 * are two authors, and one of them reading the contract does not tell the
 * other anything.
 */
class BriefGate {
  constructor() {
    /** @type {WeakSet<object>} */
    this.briefed = new WeakSet();
  }

  /**
   * @param {object} agent - the calling agent (exec.agent)
   * @returns {boolean}
   */
  has(agent) {
    return agent !== undefined && agent !== null && this.briefed.has(agent);
  }

  /** @param {object} agent */
  mark(agent) {
    if (agent !== undefined && agent !== null) this.briefed.add(agent);
  }
}

const NOT_BRIEFED =
  'Read the Dynamic Workflows authoring contract first: call the ' +
  '`dynamic_workflows_brief` tool. It is the whole contract — the facade, ' +
  'the compile-time rules, and the anti-patterns — and a workflow written ' +
  'without it will not compile.';

/**
 * Build the tool definitions.
 *
 * @param {WorkflowToolDeps} deps
 * @returns {Array<object>} the tool definitions, ready for ctx.tools.register
 */
export function createWorkflowTools(deps) {
  const gate = new BriefGate();

  const text = (value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }];

  const tools = [
    {
      name: 'dynamic_workflows_brief',
      description:
        'Read the Dynamic Workflows authoring contract: the facade, the compile-time ' +
        'rules, the typed-ask discipline, the concurrency primitives and the ' +
        'anti-patterns. Read this before authoring a workflow — the workflow ' +
        'tools refuse to run a script you have not read the brief for.',
      parameters: {},
      output: { schema: { type: 'string' }, render: (_args, result) => text(result) },
      async execute(_args, exec) {
        gate.mark(exec?.agent);
        return deps.skillContent();
      },
    },

    {
      name: 'create_workflow',
      description:
        'Compile and run a Dynamic Workflow. The script is TypeScript: top-level ' +
        'await, no imports, and a final `return` that is the run\'s result. It is ' +
        'compiled first, so a script that does not compile is reported instead of ' +
        'run. Returns the run id, the compile diagnostics and the analysis graphs.',
      parameters: {
        script: {
          type: 'string',
          description:
            'The workflow source. Either `script` or `path` is required, and not both.',
        },
        path: {
          type: 'string',
          description: 'A workspace-relative path to a workflow file to run instead of inline source.',
        },
        saved: {
          type: 'string',
          description:
            'The name of a saved workflow to run. Exactly one of `script`, `path` or ' +
            '`saved` is required.',
        },
        args: {
          type: 'object',
          description: 'Arguments for the run. The script reads them through `args`.',
        },
        name: {
          type: 'string',
          description: 'A display name for the run.',
        },
        max_concurrency: {
          type: 'number',
          description: 'Ceiling on simultaneous subagent asks for this run.',
        },
        resume_from: {
          type: 'string',
          description:
            'The id of an earlier run to resume from. The new run inherits that ' +
            'run\'s cached answers: an ask whose instructions and subagent are ' +
            'unchanged is settled from the cache instead of being paid for again. ' +
            'The cache closes at the first write to the workspace, because a cached ' +
            'answer is an answer about the earlier run\'s world.',
        },
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            run_id: { type: 'string' },
            status: { type: 'string' },
            diagnostics: { type: 'array', items: { type: 'object' } },
            graphs: { type: 'object' },
          },
        },
        render: (_args, result) => text(result),
      },
      async execute(args, exec) {
        if (!gate.has(exec?.agent)) throw new Error(NOT_BRIEFED);
        const source = await resolveSource(args, deps);
        const out = await deps.startEngine({
          scriptText: source,
          name: args.name,
          args: args.args,
          maxConcurrency: args.max_concurrency,
          // Resuming from an earlier run inherits its cached answers.
          ...(typeof args.resume_from === 'string' && args.resume_from.trim() !== ''
            ? { resumeFrom: args.resume_from.trim() }
            : {}),
          ...(deps.defaultWorkspaceRoot ? { workspaceRoot: deps.defaultWorkspaceRoot } : {}),
        });
        return {
          run_id: out.runId,
          status: out.status,
          diagnostics: out.diagnostics ?? [],
          graphs: out.graphs ?? null,
          error: out.error ?? null,
        };
      },
    },

    {
      name: 'amend_workflow',
      description:
        'Inject a new stage into a RUNNING workflow. The stage executes inside the ' +
        'live run, so it shares that run\'s subagents, their chat history, its ' +
        'workspace confinement and its sandbox. It does not restart the run and ' +
        'does not replay anything — the original plan keeps going.',
      parameters: {
        run_id: { type: 'string', description: 'The running workflow to amend.' },
        code: {
          type: 'string',
          description: 'The stage body: a function expression, or a statement block.',
        },
        name: { type: 'string', description: 'A name for the stage.' },
        wait: {
          type: 'boolean',
          description: 'Wait for the stage to settle before returning its result.',
        },
        timeout_ms: { type: 'number', description: 'How long the stage may run.' },
        max_concurrency: {
          type: 'number',
          description:
            'The concurrency ceiling for the run, from now on. Omit it to leave the ' +
            'ceiling as it is; a number sets it.',
        },
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            stage_id: { type: 'string' },
            accepted: { type: 'boolean' },
            status: { type: 'string' },
            result: {},
            error: { type: 'string' },
            max_concurrency: { type: 'number' },
          },
        },
        render: (_args, result) => text(result),
      },
      async execute(args, exec) {
        // A stage body is code, so this tool is gated like the others.
        if (!gate.has(exec?.agent)) throw new Error(NOT_BRIEFED);
        const out = await deps.injectStage(args.run_id, {
          name: args.name,
          code: args.code,
          wait: args.wait === true,
          timeoutMs: args.timeout_ms,
          // The ceiling may be changed for a run that is ALREADY going, which
          // is why upstream has this on AmendWorkflow. `undefined` means "leave
          // it alone"; a number sets it. The three-state upstream form
          // (omit = inherit / null = reset / number = set) is not reproduced
          // here: `null` and "omit" would both have to reach the engine, and
          // the engine's own `setMaxConcurrency` takes a number.
          ...(typeof args.max_concurrency === 'number' && Number.isFinite(args.max_concurrency)
            ? { maxConcurrency: args.max_concurrency }
            : {}),
        });
        return {
          stage_id: out.stageId,
          accepted: out.accepted !== false,
          status: out.status ?? null,
          result: out.result ?? null,
          error: out.error ?? null,
          ...(typeof out.maxConcurrency === 'number' ? { max_concurrency: out.maxConcurrency } : {}),
        };
      },
    },

    {
      name: 'save_workflow',
      description:
        'Save a workflow so it can be run again by name. Saved workflows carry a ' +
        'description and a note about when to use them, so the next run can pick ' +
        'the right one.',
      parameters: {
        name: {
          type: 'string',
          description: 'A file-safe identifier: letters, digits, dash, underscore, dot.',
        },
        description: { type: 'string', description: 'One line: what this workflow does.' },
        when_to_use: {
          type: 'string',
          description: 'One line: when this workflow is the right tool.',
        },
        script: { type: 'string', description: 'The workflow source.' },
        path: {
          type: 'string',
          description: 'A workspace-relative path to the source, instead of inline source.',
        },
        scope: {
          type: 'string',
          description:
            'Where to save it: `project` (with this workspace) or `global` (for every ' +
            'workspace). Required — say where the workflow belongs.',
          enum: ['project', 'global'],
        },
        args: {
          type: 'object',
          description: 'Declared arguments: { name: { type, default, description } }.',
        },
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            path: { type: 'string' },
            scope: { type: 'string' },
          },
        },
        render: (_args, result) => text(result),
      },
      async execute(args, exec) {
        // The gate covers every tool that accepts a script or a snippet.
        // Upstream gates CreateWorkflow / AmendWorkflow / SaveWorkflow /
        // EvalWorkflowSnippet — the four tools a model can hand code to.
        // Gating only the first would leave the other three as a way to
        // submit a workflow that was written without the contract.
        if (!gate.has(exec?.agent)) throw new Error(NOT_BRIEFED);
        // `scope` is required and has no default, upstream. A workflow saved
        // without saying where it belongs is a workflow nobody finds again.
        const scope = args.scope === 'global' ? 'global' : args.scope === 'project' ? 'project' : null;
        if (scope === null) {
          throw new Error(
            'save_workflow: `scope` is required — `project` (with this workspace) or ' +
            '`global` (for every workspace).',
          );
        }
        const source = await resolveSource(args, deps);
        return deps.saveWorkflow(args.name, {
          description: args.description,
          whenToUse: args.when_to_use,
          script: source,
          scope,
          args: args.args,
        });
      },
    },

    {
      name: 'list_saved_workflows',
      description: 'List the saved workflows, with what each one is for.',
      parameters: {},
      output: { schema: { type: 'array', items: { type: 'object' } }, render: (_args, result) => text(result) },
      async execute() {
        return deps.listSavedWorkflows();
      },
    },

    {
      name: 'list_workflow_runs',
      description: 'List the workflow runs this host knows about, newest first.',
      parameters: {},
      output: { schema: { type: 'array', items: { type: 'object' } }, render: (_args, result) => text(result) },
      async execute() {
        return deps.listRuns();
      },
    },

    {
      name: 'get_workflow_run',
      description:
        'One workflow run in full: its status, its phases, its subagents, its ' +
        'reports, its artifacts, its journal and — for a run on the engine — its ' +
        'compile diagnostics and analysis graphs.',
      parameters: {
        run_id: { type: 'string', description: 'The run to look at.' },
        include_journal: {
          type: 'boolean',
          description: 'Include the journal: what actually ran, and what was replayed.',
        },
      },
      output: { schema: { type: 'object' }, render: (_args, result) => text(result) },
      async execute(args) {
        const snap = deps.snapshot(args.run_id, {
          includeJournal: args.include_journal === true,
        });
        if (snap === null || snap === undefined) {
          throw new Error(`no such run: ${args.run_id}`);
        }
        return snap;
      },
    },

    {
      name: 'resolve_workflow_question',
      description:
        'Answer a question a running workflow asked the human. The run is paused ' +
        'until the answer arrives. Use it when you are the human in the loop for ' +
        'a workflow you started.',
      parameters: {
        run_id: { type: 'string', description: 'The run that asked.' },
        question_id: { type: 'string', description: 'The question to answer.' },
        answer: {
          type: 'string',
          description: 'The answer. A boolean for a confirm question; one of the options otherwise.',
        },
      },
      output: { schema: { type: 'object' }, render: (_args, result) => text(result) },
      async execute(args) {
        deps.answerQuestion(args.run_id, args.question_id, args.answer);
        return { ok: true, question_id: args.question_id };
      },
    },

    {
      name: 'fill_workflow_hole',
      description:
        'Fill a hole a running workflow parked on. The body is code, evaluated in ' +
        'the hole\'s place: it sees the bindings declared before it and its ' +
        'return value becomes the hole\'s value.',
      parameters: {
        run_id: { type: 'string', description: 'The run that parked on the hole.' },
        hole_id: { type: 'string', description: 'The hole to fill.' },
        body: { type: 'string', description: 'The code to run in the hole\'s place.' },
      },
      output: { schema: { type: 'object' }, render: (_args, result) => text(result) },
      async execute(args, exec) {
        // A hole body is code too, so it is gated like the rest.
        if (!gate.has(exec?.agent)) throw new Error(NOT_BRIEFED);
        // The fill is AWAITED: on the engine path it recompiles the script
        // and can be refused, and a tool that returned before the refusal
        // would report success for a fill that never happened.
        const out = await deps.fillHole(args.run_id, args.hole_id, args.body);
        return {
          ok: out?.ok === true,
          hole_id: args.hole_id,
          ...(out?.reason ? { error: out.reason } : {}),
        };
      },
    },

    {
      name: 'eval_workflow_snippet',
      description:
        'Compile and run a small snippet of workflow code, with a timeout. Use it ' +
        'to try one facade call, or one piece of the pipeline logic, before it ' +
        'becomes a whole workflow. Returns the compile diagnostics, or the value ' +
        'the snippet returned.',
      parameters: {
        code: {
          type: 'string',
          description: 'The snippet. Either `code` or `path` is required, and not both.',
        },
        path: {
          type: 'string',
          description: 'A workspace-relative path to a snippet file instead of inline code.',
        },
        timeout_ms: { type: 'number', description: 'How long the snippet may run.' },
      },
      output: { schema: { type: 'object' }, render: (_args, result) => text(result) },
      async execute(args, exec) {
        if (!gate.has(exec?.agent)) throw new Error(NOT_BRIEFED);
        const source = await resolveSource(args, deps);
        return deps.evalSnippet({
          scriptText: source,
          timeoutMs: args.timeout_ms,
          ...(deps.defaultWorkspaceRoot ? { workspaceRoot: deps.defaultWorkspaceRoot } : {}),
        });
      },
    },
  ];

  return tools;
}

/**
 * The source to run: inline, from a file, or from a saved workflow.
 *
 * Upstream's `CreateWorkflow` takes exactly one of `script`, `saved` or
 * `path`. dsh has `script` and `path`; `saved` was missing, which meant a
 * workflow saved with `save_workflow` could not be run again by name — the
 * save/run loop did not close.
 *
 * @param {{script?: string, code?: string, path?: string, saved?: string}} args
 * @param {WorkflowToolDeps} deps
 * @returns {Promise<string>}
 */
async function resolveSource(args, deps) {
  // `script` is the general spelling; `code` is the snippet tool's. Both mean
  // "the source to run".
  const inline = args.script ?? args.code;
  const hasScript = typeof inline === 'string' && inline.trim() !== '';
  const hasPath = typeof args.path === 'string' && args.path.trim() !== '';
  const hasSaved = typeof args.saved === 'string' && args.saved.trim() !== '';
  const chosen = [hasScript && 'script', hasPath && 'path', hasSaved && 'saved'].filter(Boolean);
  if (chosen.length > 1) {
    throw new Error(`give only one of \`script\`, \`path\` or \`saved\` (got ${chosen.join(' and ')})`);
  }
  if (hasScript) return inline;
  if (hasSaved) {
    if (typeof deps.readSavedWorkflow !== 'function') {
      throw new Error('this host cannot run saved workflows');
    }
    return deps.readSavedWorkflow(args.saved);
  }
  if (hasPath) {
    if (typeof deps.readWorkspaceFile !== 'function') {
      throw new Error('this host cannot read workflow files by path');
    }
    return deps.readWorkspaceFile(args.path);
  }
  throw new Error('one of `script`, `path` or `saved` is required');
}
