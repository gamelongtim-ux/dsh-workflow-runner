/**
 * Read the host's own parameter-schema conversion out of an installed dsh.
 *
 * The plugin's fallback schema conversion has to match the host's
 * `parameterSchemaSpecToJsonSchema` exactly, or the plugin's tools
 * behave differently depending on whether `@deepseek-ai/dsh-tools`
 * happens to be resolvable.
 *
 * The host's module is far too entangled to evaluate in isolation (a class
 * extends one of its imports), so instead the host's RULE is read out of
 * its source and applied to the plugin's specs. The rule is one line in
 * the host's property-map compiler:
 *
 *   if (Object.hasOwn(task.property, "required") && task.property.required !== true)
 *     authorError(...);
 *   if (Object.hasOwn(task.property, "required") && task.property.required === true)
 *     task.required.push(task.key);
 *
 * — a parameter is required only if it says `required: true`.
 *
 * @returns {Promise<{origin: string, rule: {requiredByOptIn: boolean}, source: string}|null>}
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

/**
 * Read a file out of the packed asar.
 *
 * @param {string} asar
 * @param {string} innerPath
 * @returns {string|null}
 */
function readFromAsar(asar, innerPath) {
  const reader = join(process.cwd(), 'scripts', 'asar-read.mjs');
  if (!existsSync(reader)) return null;
  const r = spawnSync(process.execPath, [reader, asar, 'read', innerPath], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0) return null;
  return r.stdout;
}

/**
 * Find the host's dsh-tools source.
 *
 * @returns {{origin: string, source: string}|null}
 */
function findHostSource() {
  const profile = join(
    process.env.USERPROFILE ?? '',
    '.dsh', 'profiles', 'desktop', 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js',
  );
  if (existsSync(profile)) {
    return { origin: profile, source: readFileSync(profile, 'utf8') };
  }
  const asar = 'D:/DeepseekHarness/resources/app.asar';
  if (existsSync(asar)) {
    const source = readFromAsar(asar, 'dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js');
    if (source !== null) {
      return { origin: `${asar} (dsh-tools)`, source };
    }
  }
  return null;
}

/**
 * Read the host's required-parameter rule out of its source.
 *
 * @returns {Promise<{origin: string, rule: {requiredByOptIn: boolean}, source: string}|null>}
 */
export async function readHostSchema() {
  const found = findHostSource();
  if (found === null) return null;

  // The host's rule: a parameter is required only if it declares
  // `required: true`. The evidence is the property-map compiler.
  const optIn = /required\s*!==\s*true\s*\)\s*authorError/.test(found.source)
    && /required\s*===\s*true\s*\)\s*task\.required\.push/.test(found.source);
  const always = /task\.required\.push\(task\.key\)/.test(found.source)
    && !/required\s*===\s*true\s*\)\s*task\.required\.push/.test(found.source);

  return {
    origin: found.origin,
    rule: { requiredByOptIn: optIn, alwaysRequired: always },
    source: found.source,
  };
}

/**
 * The host's required list for a flat parameter spec, by the host's rule.
 *
 * @param {Record<string, unknown>} spec
 * @param {{requiredByOptIn: boolean, alwaysRequired?: boolean}} rule
 * @returns {string[]}
 */
export function hostRequired(spec, rule) {
  const out = [];
  for (const [name, raw] of Object.entries(spec ?? {})) {
    if (rule.requiredByOptIn) {
      if (raw !== null && typeof raw === 'object' && raw.required === true) out.push(name);
      continue;
    }
    if (rule.alwaysRequired) {
      out.push(name);
      continue;
    }
    // The host's older rule: required unless it says it is optional.
    if (raw !== null && typeof raw === 'object') {
      if (raw.optional === true || raw.default !== undefined) continue;
    }
    out.push(name);
  }
  return out;
}
