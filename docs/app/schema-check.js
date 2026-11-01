// Minimal JSON-schema subset checker for the v1 contracts.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (Number.isInteger(v)) return 'integer';
  return typeof v;
}

function matchesType(v, t) {
  if (t === 'number') return typeof v === 'number';
  return typeOf(v) === t;
}

function walk(value, schema, path, out) {
  if ('const' in schema && value !== schema.const) {
    out.push(`${path}: must equal ${JSON.stringify(schema.const)}`);
    return;
  }
  if (schema.enum && !schema.enum.includes(value)) {
    out.push(`${path}: ${JSON.stringify(value)} not in enum [${schema.enum.join(', ')}]`);
    return;
  }
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => matchesType(value, t))) {
      out.push(`${path}: expected type ${types.join('|')}, got ${typeOf(value)}`);
      return;
    }
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) out.push(`${path}: shorter than minLength ${schema.minLength}`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) out.push(`${path}: longer than maxLength ${schema.maxLength}`);
    if (schema.format === 'uuid' && !UUID_RE.test(value)) out.push(`${path}: not a valid uuid`);
  }
  if (typeof value === 'number' && schema.minimum !== undefined && value < schema.minimum) {
    out.push(`${path}: below minimum ${schema.minimum}`);
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const props = schema.properties || {};
    for (const key of schema.required || []) {
      if (!(key in value)) out.push(`${path}.${key}: required property missing`);
    }
    for (const key of Object.keys(value)) {
      if (key in props) walk(value[key], props[key], `${path}.${key}`, out);
      else if (schema.additionalProperties === false) out.push(`${path}.${key}: additional property not allowed`);
    }
  }
}

export function checkSchema(doc, schema) {
  const out = [];
  walk(doc, schema, '$', out);
  return out;
}
