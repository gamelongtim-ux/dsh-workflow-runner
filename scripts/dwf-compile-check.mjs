// Check the two functions the engine endpoints are built on, and that the
// plugin module still loads.
import { compileWorkflow } from '../lib/dwf/index.js';

const SCRIPT = `
interface Plan { title: string; steps: string[] }
phase("plan");
const plan = await agent("planner", { system: "You plan." }).ask<Plan>("Plan it.");
report({ plan });
return { plan };
`;

const out = compileWorkflow(SCRIPT);
console.log('ok        :', out.ok);
console.log('diagnostics:', out.diagnostics.length);
console.log('sizes     :', JSON.stringify(out.sizes));
console.log('askSites  :', out.askSites.join(', '));
console.log('siteIds   :', out.siteIds.join(', '));
console.log('schemas   :', Object.keys(out.schemas).join(', '));
console.log('lowered   :', out.loweredCode.split('\n')[0]);

const broken = compileWorkflow('const x: number = "nope";\nreturn x;');
console.log('--- broken ---');
console.log('ok        :', broken.ok);
console.log('diagnostics:', broken.diagnostics.map((d) => `${d.code}@${d.line}: ${d.message.slice(0, 60)}`));

// The plugin module must still import cleanly.
const plugin = await import('../lib/plugin.js');
console.log('--- plugin ---');
console.log('exports   :', Object.keys(plugin).join(', '));
