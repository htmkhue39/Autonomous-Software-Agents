// @ts-nocheck -- deterministic test fixtures; production source remains strictly checked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkSchema, validate, ValidationError } from '../src/llm/validation.js';

const schema = {
  type: 'object', additionalProperties: false, required: ['id', 'steps'],
  properties: {
    id: { type: 'string', minLength: 1, maxLength: 10 },
    steps: { type: 'array', maxItems: 3, items: { type: 'integer', minimum: 0, maximum: 8 } },
  },
};

test('strict JSON-schema subset validates nested arguments', () => {
  checkSchema(schema);
  assert.deepEqual(validate({ id: 'p1', steps: [1, 2] }, schema), { id: 'p1', steps: [1, 2] });
});
test('rejects unknown properties, missing keys, and type coercion', () => {
  for (const item of [{ id: 'p1', steps: [1], debug: true }, { id: 'p1' }, { id: 'p1', steps: ['1'] }]) {
    assert.throws(() => validate(item, schema), ValidationError);
  }
});
test('rejects invalid bounds and unsupported schema keywords at registration', () => {
  assert.throws(() => validate({ id: 'p1', steps: [1, 2, 3, 4] }, schema));
  assert.throws(() => checkSchema({ type: 'object', properties: {}, additionalProperties: true }));
  assert.throws(() => checkSchema({ ...schema, $ref: '#/x' }));
});
