/**
 * The model-facing schema of a tool.
 *
 * A tool's parameters are declared as a FLAT map — `{ prompt: { type:
 * "string", description: "..." } }` — because that is how a tool reads in
 * source. The model, however, is shown a JSON Schema, and that schema
 * needs a ROOT: `{ type: "object", properties: { ... }, required: [...] }`.
 *
 * The host has `defineTool` for this (`@deepseek-ai/dsh-tools`), and the
 * plugin uses it when it is resolvable. This module is the fallback for a
 * host that does not have it — and it is deliberately the SAME conversion,
 * so the two paths produce the same schema.
 *
 * WHY THIS MATTERS ENOUGH TO HAVE A MODULE: a tool registered with the
 * flat map is not a valid function-call schema. The WorkBuddy gateway
 * answers HTTP 400 / code 11129 "invalid function call parameters" — and
 * it answers it for EVERY turn, because the invalid schema is in the
 * model's tool list, not in one call. The plugin was removed from a real
 * dsh profile over exactly this.
 */

/**
 * One parameter's schema, as declared in the flat map.
 *
 * A parameter may be a bare type name (`'string'`) or an object with a
 * `type` and a `description`.
 *
 * @param {unknown} spec
 * @returns {{type: string, description?: string, [key: string]: unknown}|null}
 */
function compileProperty(spec) {
  if (typeof spec === 'string') return { type: spec };
  if (spec === null || typeof spec !== 'object') return null;
  const out = { ...spec };
  if (typeof out.type !== 'string') {
    // A spec with no type is not usable: the model is told the argument's
    // type, and without one it is told nothing.
    return null;
  }
  return out;
}

/**
 * The JSON Schema for a tool's parameters.
 *
 * The REQUIRED rule is the host's, exactly: a parameter is required only
 * if it declares `required: true` (`@deepseek-ai/dsh-tools`,
 * `parameterSchemaSpecToJsonSchema` → the property-map compiler: "if
 * `required` is present it must be `true`, and then the key is required").
 * A parameter that says nothing is OPTIONAL.
 *
 * Getting this wrong in the other direction is worse than getting it
 * right: a schema that marks an optional parameter required makes the
 * model invent a value for it, and the host's own argument validation
 * then refuses the call.
 *
 * @param {Record<string, unknown>} spec - the flat parameter map
 * @returns {{type: 'object', properties: Record<string, object>, required?: string[]}}
 */
export function parameterSchema(spec) {
  const properties = {};
  const required = [];
  for (const [name, raw] of Object.entries(spec ?? {})) {
    const compiled = compileProperty(raw);
    if (compiled === null) {
      // A malformed parameter is dropped rather than emitted as a broken
      // schema: one bad parameter must not make the whole tool invalid.
      continue;
    }
    properties[name] = compiled;
    if (raw !== null && typeof raw === 'object' && raw.required === true) {
      required.push(name);
    }
  }
  return {
    type: 'object',
    properties,
    // The host's compiler requires an object schema to declare
    // `additionalProperties` EXPLICITLY, and it refuses one that does
    // not: "unsupported JSON schema: parameters.additionalProperties must
    // be explicitly true or false". The host's own root carries it, so
    // the fallback's root must too.
    additionalProperties: true,
    ...(required.length > 0 ? { required } : {}),
  };
}

/**
 * Build a registry-ready tool definition from the plugin's own tool spec.
 *
 * This is the same shape the host's `defineTool` produces: the converted
 * parameters, the output schema, and an `execute` that still calls the
 * plugin's own implementation.
 *
 * @param {object} tool - the plugin's tool spec
 * @returns {object} a registry-ready definition
 */
export function defineTool(tool) {
  const parameters = parameterSchema(tool.parameters);
  return {
    name: tool.name,
    description: tool.description,
    parameters,
    output: tool.output,
    execute: tool.execute,
  };
}
