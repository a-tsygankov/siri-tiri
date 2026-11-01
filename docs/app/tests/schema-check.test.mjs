import test from 'node:test';
import assert from 'node:assert/strict';
import { checkSchema } from '../schema-check.js';

const UUID = '11111111-1111-4111-8111-111111111111';
const schema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'kind'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    kind: { enum: ['a', 'b'] },
    n: { type: ['integer', 'null'], minimum: 1 },
    s: { type: 'string', minLength: 2, maxLength: 3 },
    v: { const: 1 },
    flag: { type: 'boolean' },
  },
};

test('valid doc returns no violations', () => {
  assert.deepEqual(checkSchema({ id: UUID, kind: 'a', n: 2, s: 'ab', v: 1, flag: true }, schema), []);
});
test('missing required field is named', () => {
  const errs = checkSchema({ kind: 'a' }, schema);
  assert.equal(errs.length, 1);
  assert.match(errs[0], /id/);
});
test('wrong enum value is named', () => {
  const errs = checkSchema({ id: UUID, kind: 'zzz' }, schema);
  assert.equal(errs.length, 1);
  assert.match(errs[0], /kind/);
});
test('extra property rejected when additionalProperties false', () => {
  const errs = checkSchema({ id: UUID, kind: 'a', extra: 1 }, schema);
  assert.equal(errs.length, 1);
  assert.match(errs[0], /extra/);
});
test('format uuid rejects not-a-uuid', () => {
  const errs = checkSchema({ id: 'not-a-uuid', kind: 'a' }, schema);
  assert.equal(errs.length, 1);
  assert.match(errs[0], /id/);
});
test('type union integer|null accepts both, rejects others', () => {
  assert.deepEqual(checkSchema({ id: UUID, kind: 'a', n: null }, schema), []);
  assert.deepEqual(checkSchema({ id: UUID, kind: 'a', n: 3 }, schema), []);
  assert.equal(checkSchema({ id: UUID, kind: 'a', n: 1.5 }, schema).length, 1);
  assert.equal(checkSchema({ id: UUID, kind: 'a', n: 'x' }, schema).length, 1);
});
test('minimum, minLength, maxLength, const, boolean type', () => {
  assert.equal(checkSchema({ id: UUID, kind: 'a', n: 0 }, schema).length, 1);
  assert.equal(checkSchema({ id: UUID, kind: 'a', s: 'a' }, schema).length, 1);
  assert.equal(checkSchema({ id: UUID, kind: 'a', s: 'abcd' }, schema).length, 1);
  assert.equal(checkSchema({ id: UUID, kind: 'a', v: 2 }, schema).length, 1);
  assert.equal(checkSchema({ id: UUID, kind: 'a', flag: 'yes' }, schema).length, 1);
});
test('non-object doc is rejected; arrays are not objects', () => {
  assert.equal(checkSchema([], schema).length, 1);
  assert.equal(checkSchema(null, schema).length, 1);
});
