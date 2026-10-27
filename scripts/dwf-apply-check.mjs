// The plugin must ACTIVATE, not merely import.
//
// `apply(ctx, config)` is what a dsh profile runs: it registers the
// model-facing tools, the skill they are gated on, the slash command, the
// Settings card and the web route. A plugin that imports but whose apply
// throws — or registers nothing — is a plugin that does not work, and no
// import-level check can see it.
//
// This runs apply against a mock cordis context shaped like the one dsh
// passes, and asserts what actually got registered.
//
// Run it with the schemastery stub so the Settings card path is exercised
// too: node --import ./scripts/register-schemastery-stub.mjs scripts/dwf-apply-check.mjs

import { pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const problems = [];

const registered = { tools: [], skills: [], commands: [], web: [], sections: [] };
const disposers = [];

const serviceFor = (dep) => ({
  register: (def) => {
    registered[dep === 'commands' ? 'commands' : dep]?.push(def);
    return () => {};
  },
});

// The mock has to be shaped like cordis, because the plugin branches on
// what is there: `typeof ctx.inject === 'function'`, `ctx.effect`, and the
// services each injection asks for.
const ctx = {
  inject: (deps, fn) => {
    for (const dep of deps) {
      const service = {
        register: (def) => {
          if (dep === 'tools') registered.tools.push(def);
          else if (dep === 'skills') registered.skills.push(def);
          else if (dep === 'commands') registered.commands.push(def);
          return () => {};
        },
      };
      if (dep === 'settings') {
        service.legacy = {
          installSection: (c, name, Config, config, opts) => {
            registered.sections.push({ name, hasConfig: Config !== undefined, config, opts });
            return () => {};
          },
        };
      }
      fn({ [dep]: service });
    }
  },
  effect: (fn) => {
    const disposer = fn();
    disposers.push(disposer);
    return disposer;
  },
  webServer: {
    register: (def) => {
      registered.web.push(def);
      return () => {};
    },
  },
  connection: {
    requestRejection: () => null,
  },
};

const plugin = await import(pathToFileURL(join(here, '..', 'lib', 'plugin.js')).href);

let returned;
try {
  returned = plugin.apply(ctx, { path: '/workflow' });
} catch (err) {
  problems.push(`apply() threw: ${err && (err.stack || err.message)}`);
}

process.stdout.write(`tools registered    : ${registered.tools.length}\n`);
process.stdout.write(`skills registered   : ${registered.skills.length}\n`);
process.stdout.write(`commands registered : ${registered.commands.length}\n`);
process.stdout.write(`web routes          : ${registered.web.length}\n`);
process.stdout.write(`settings sections   : ${registered.sections.length}\n`);

if (registered.tools.length !== 10) {
  problems.push(`expected 10 tools, got ${registered.tools.length}`);
}
for (const tool of registered.tools) {
  if (!tool.name) problems.push('a registered tool has no name');
  if (typeof tool.execute !== 'function') problems.push(`tool ${tool.name} has no execute()`);
}

// The registered definition must be the one the HOST built, not the
// plugin's raw spec. The host's `defineTool` wraps `execute` with
// argument validation; the plugin's fallback does not, and says so.
//
// Which one is in use depends on whether `@deepseek-ai/dsh-tools`
// resolves in this environment — so the check asserts the RIGHT one for
// the path that was taken, rather than asserting the host's always.
const usingHostDefineTool = registered.tools.length > 0
  && /invalid arguments|ToolArgsError/.test(
    Function.prototype.toString.call(registered.tools[0].execute),
  );
for (const tool of registered.tools) {
  const wrapped = /invalid arguments|ToolArgsError/.test(
    Function.prototype.toString.call(tool.execute),
  );
  if (usingHostDefineTool && !wrapped) {
    problems.push(
      `tool ${tool.name} was registered without the host's argument validation`,
    );
  }
}
// Either way, the definition must carry a real schema — that is the part
// the model sees, and it is what the gateway rejects when it is wrong.
for (const tool of registered.tools) {
  const p = tool.parameters;
  if (p === undefined || p.type !== 'object' || p.properties === undefined) {
    problems.push(`tool ${tool.name} was registered without a JSON Schema root`);
  }
}

// The PARAMETER SCHEMA is what the model is shown. A tool registered with
// a flat `parameters` map — no root `type: "object"` — is not a valid
// function-call schema, and the gateway rejects it with HTTP 400 / code
// 11129 "invalid function call parameters", which kills EVERY turn.
//
// The plugin was removed from a real dsh profile over exactly this, so
// the definition that reaches the registry is checked here: this is the
// last point before the host sees it.
for (const tool of registered.tools) {
  const p = tool.parameters;
  if (p === undefined) {
    problems.push(`tool ${tool.name} has no parameters`);
    continue;
  }
  if (p.type !== 'object') {
    problems.push(`tool ${tool.name}: parameters.type is ${p.type}, not "object"`);
  }
  if (p.properties === undefined || typeof p.properties !== 'object') {
    problems.push(`tool ${tool.name}: parameters has no properties`);
    continue;
  }
  for (const [name, spec] of Object.entries(p.properties)) {
    if (spec === null || typeof spec !== 'object' || typeof spec.type !== 'string') {
      problems.push(`tool ${tool.name}: the parameter ${name} declares no type`);
    }
  }
}
if (registered.skills.length !== 1) {
  problems.push(`expected 1 skill, got ${registered.skills.length}`);
} else if (registered.skills[0].name !== 'dynamic-workflows') {
  problems.push(`the skill is called ${registered.skills[0].name}, not dynamic-workflows`);
} else if (!registered.skills[0].content) {
  problems.push('the skill has no content');
}
if (registered.commands.length !== 1) {
  problems.push(`expected 1 command, got ${registered.commands.length}`);
} else if (registered.commands[0].name !== 'workflow') {
  problems.push(`the command is called ${registered.commands[0].name}, not workflow`);
}
if (registered.web.length !== 1) {
  problems.push(`expected 1 web route, got ${registered.web.length}`);
} else if (registered.web[0].path !== '/workflow') {
  problems.push(`the web route is at ${registered.web[0].path}, not /workflow`);
}

// The Settings card only appears when schemastery resolved, and this run
// has the stub in place — so it must be there.
if (registered.sections.length !== 1) {
  problems.push(`expected 1 settings section, got ${registered.sections.length}`);
} else if (!registered.sections[0].hasConfig) {
  problems.push('the settings section got no Config schema');
}

// The disposers must be callable: a plugin that leaves a broken disposer
// behind takes the host's own teardown down with it.
for (const [i, dispose] of disposers.entries()) {
  if (typeof dispose !== 'function') {
    problems.push(`effect #${i} returned ${typeof dispose} instead of a disposer`);
    continue;
  }
  try {
    dispose();
  } catch (err) {
    problems.push(`disposer #${i} threw: ${err && err.message}`);
  }
}

if (problems.length > 0) {
  process.stdout.write(`\nFAIL:\n${problems.map((p) => `  - ${p}`).join('\n')}\n`);
  process.exit(1);
}
process.stdout.write('\nPASS: the plugin activates and registers everything\n');
