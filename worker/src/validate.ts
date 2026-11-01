// Minimal JSON-schema subset checker (TypeScript port of docs/app/schema-check.js) and the
// per-item classifier for /v1/messages.
import eventSchema from '../../contracts/event.v1.schema.json';
import reviewSchema from '../../contracts/review-v1.schema.json';
import episodeSchema from '../../contracts/episode.v1.schema.json';

export type Schema = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
export type Kind = 'event' | 'review' | 'episode';
export type Doc = Record<string, unknown>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function typeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (Number.isInteger(v)) return 'integer';
  return typeof v;
}

function matchesType(v: unknown, t: string): boolean {
  if (t === 'number') return typeof v === 'number';
  return typeOf(v) === t;
}

function walk(value: unknown, schema: Schema, path: string, out: string[]): void {
  if ('const' in schema && value !== schema.const) { out.push(`${path}: must equal ${JSON.stringify(schema.const)}`); return; }
  if (schema.enum && !schema.enum.includes(value)) { out.push(`${path}: ${JSON.stringify(value)} not in enum [${schema.enum.join(', ')}]`); return; }
  if (schema.type) {
    const types: string[] = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => matchesType(value, t))) { out.push(`${path}: expected type ${types.join('|')}, got ${typeOf(value)}`); return; }
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) out.push(`${path}: shorter than minLength ${schema.minLength}`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) out.push(`${path}: longer than maxLength ${schema.maxLength}`);
    if (schema.format === 'uuid' && !UUID_RE.test(value)) out.push(`${path}: not a valid uuid`);
    if (schema.format === 'date-time' && !Number.isFinite(Date.parse(value))) out.push(`${path}: not a date-time`);
  }
  if (typeof value === 'number' && schema.minimum !== undefined && value < schema.minimum) out.push(`${path}: below minimum ${schema.minimum}`);
  if (Array.isArray(value)) {
    if (schema.maxItems !== undefined && value.length > schema.maxItems) out.push(`${path}: more than maxItems ${schema.maxItems}`);
    if (schema.items) value.forEach((v, i) => walk(v, resolve(schema.items), `${path}[${i}]`, out));
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const props = schema.properties || {};
    for (const key of schema.required || []) if (!(key in (value as Doc))) out.push(`${path}.${key}: required property missing`);
    for (const key of Object.keys(value as Doc)) {
      if (key in props) walk((value as Doc)[key], resolve(props[key]), `${path}.${key}`, out);
      else if (schema.additionalProperties === false) out.push(`${path}.${key}: additional property not allowed`);
    }
  }
}

let root: Schema = {};
function resolve(schema: Schema): Schema {
  if (schema && typeof schema.$ref === 'string' && schema.$ref.startsWith('#/$defs/')) return root.$defs?.[schema.$ref.slice('#/$defs/'.length)] ?? {};
  return schema;
}

export function checkSchema(doc: unknown, schema: Schema): string[] {
  const out: string[] = [];
  root = schema;
  walk(doc, schema, '$', out);
  return out;
}

const SCHEMAS: Record<Kind, Schema> = { event: eventSchema, review: reviewSchema, episode: episodeSchema };

export function validateItem(input: unknown): { kind: Kind; body: Doc } | { error: string } {
  if (!input || typeof input !== 'object') return { error: 'item must be an object' };
  const { kind, body } = input as { kind?: unknown; body?: unknown };
  if (kind !== 'event' && kind !== 'review' && kind !== 'episode') return { error: 'kind must be event, review or episode' };
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'body must be an object' };
  const errors = checkSchema(body, SCHEMAS[kind]);
  if (errors.length) return { error: errors.slice(0, 3).join('; ') };
  return { kind, body: body as Doc };
}
