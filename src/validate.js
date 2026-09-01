/**
 * Check tool arguments against the schema the tool advertises.
 *
 * Every tool in `tools.js` carries an `inputSchema` with types, `required`,
 * `minimum`/`maximum` on ports and `additionalProperties: false` throughout —
 * and until this file existed none of it was enforced anywhere. `tools/call`
 * handed `params.arguments` straight to the handler, so the schema was a
 * DESCRIPTION of what a well-behaved client sends, not a statement about what
 * this server accepts. A model that sends `port: "8080; rm -rf /"` is not
 * hypothetical; a client with a stale tool list sending a field that no longer
 * exists is not either.
 *
 * Hand-rolled, and small on purpose: this package has zero runtime
 * dependencies (`package.json` has no `dependencies` key at all), which is
 * most of why it is safe to `npx` into an agent's process. A JSON Schema
 * library would be the first thing in that empty list, and on a package whose
 * whole review above is about supply chain, adding one to validate eleven
 * hand-written schemas is the wrong trade. So this implements exactly the
 * keywords those schemas use and REFUSES anything it does not understand —
 * an unimplemented keyword must never read as a silent pass.
 *
 * Supported: type (object/string/integer/number/boolean/array), properties,
 * required, additionalProperties (false or a schema), items, minItems,
 * minimum, maximum, enum.
 */

const SUPPORTED = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'minItems',
  'minimum',
  'maximum',
  'enum',
  'description',
  'title',
  'default',
]);

/**
 * @returns {string[]} one message per problem, empty when the value is valid.
 */
export function validateArguments(args, schema) {
  return check(args, schema, 'arguments');
}

function check(value, schema, path) {
  if (!schema || typeof schema !== 'object') return [];

  for (const keyword of Object.keys(schema)) {
    if (!SUPPORTED.has(keyword)) {
      // Louder than a pass, and it fails the tests rather than a user: a
      // schema keyword this file cannot check is a hole in the shape of a
      // check somebody believed was there.
      return [`${path}: schema uses unsupported keyword \`${keyword}\``];
    }
  }

  const problems = [];

  if (schema.enum && !schema.enum.includes(value)) {
    return [`${path}: must be one of ${schema.enum.map((one) => JSON.stringify(one)).join(', ')}`];
  }

  const type = schema.type;
  if (type && !matchesType(value, type)) {
    return [`${path}: expected ${type}, got ${describe(value)}`];
  }

  if (type === 'object' || (!type && isPlainObject(value))) {
    if (!isPlainObject(value)) return [`${path}: expected object, got ${describe(value)}`];
    for (const name of schema.required ?? []) {
      if (value[name] === undefined) problems.push(`${path}: \`${name}\` is required`);
    }
    for (const [name, entry] of Object.entries(value)) {
      // `undefined` is what a client that omitted a key looks like once JSON
      // has been parsed and spread; it is an absence, not a bad value.
      if (entry === undefined) continue;
      const sub = schema.properties?.[name];
      if (sub) {
        problems.push(...check(entry, sub, `${path}.${name}`));
        continue;
      }
      if (schema.additionalProperties === false) {
        problems.push(`${path}: unknown property \`${name}\``);
      } else if (isPlainObject(schema.additionalProperties)) {
        problems.push(...check(entry, schema.additionalProperties, `${path}.${name}`));
      }
    }
  }

  if (type === 'array') {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      problems.push(`${path}: needs at least ${schema.minItems} item(s), got ${value.length}`);
    }
    if (schema.items) {
      value.forEach((entry, index) => {
        problems.push(...check(entry, schema.items, `${path}[${index}]`));
      });
    }
  }

  if (type === 'integer' || type === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) {
      problems.push(`${path}: must be >= ${schema.minimum}, got ${value}`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      problems.push(`${path}: must be <= ${schema.maximum}, got ${value}`);
    }
  }

  return problems;
}

function matchesType(value, type) {
  switch (type) {
    case 'object':
      return isPlainObject(value);
    case 'array':
      return Array.isArray(value);
    case 'string':
      return typeof value === 'string';
    case 'boolean':
      return typeof value === 'boolean';
    // JSON has one number type and MCP clients are JSON. An integer is a
    // number with nothing after the point — `8080.0` is one, `"8080"` is not,
    // and the string is the case that reached a shell.
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    default:
      return false;
  }
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describe(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}
