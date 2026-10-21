import { describe, expect, it } from 'vitest';
import { validateSchema } from './schema';

const schema = {
  type: 'object',
  properties: {
    n: { type: 'integer', minimum: 1 },
    list: { type: 'array', maxItems: 2, items: { type: 'string' } },
    kind: { type: 'string', enum: ['a', 'b'] },
  },
  required: ['n'],
};

describe('validateSchema', () => {
  it('accepts valid values and ignores unknown properties', () => {
    expect(validateSchema(schema, { n: 1, list: ['x'], kind: 'a', extra: true }, 'args')).toBeNull();
  });

  it('names the first problem', () => {
    expect(validateSchema(schema, {}, 'args')).toBe('args.n is required');
    expect(validateSchema(schema, { n: 1.5 }, 'args')).toContain('args.n must be an integer');
    expect(validateSchema(schema, { n: 0 }, 'args')).toContain('at least 1');
    expect(validateSchema(schema, { n: 1, list: ['a', 'b', 'c'] }, 'args')).toContain('at most 2');
    expect(validateSchema(schema, { n: 1, list: [3] }, 'args')).toContain('args.list[0] must be a string');
    expect(validateSchema(schema, { n: 1, kind: 'c' }, 'args')).toContain('one of');
    expect(validateSchema(schema, 'x', 'args')).toContain('must be an object');
  });
});
