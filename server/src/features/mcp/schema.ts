/**
 * A small validator for the JSON Schema subset the tool input schemas use (type, enum, items, properties, required,
 * minItems, maxItems, minimum, maximum). Returns a message for the first problem, or null. Unknown properties pass.
 */
type Schema = Record<string, unknown>;

function typeName(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

export function validateSchema(schema: Schema, value: unknown, path: string): string | null {
  const type = schema.type;
  if (typeof type === 'string') {
    const actual = typeName(value);
    const ok = type === 'integer' ? typeof value === 'number' && Number.isInteger(value)
      : type === 'number' ? typeof value === 'number' && Number.isFinite(value)
        : actual === type;
    if (!ok) return `${path} must be ${/^[aeiou]/.test(type) ? 'an' : 'a'} ${type}, got ${actual === 'number' && type !== 'number' ? 'a non-integer number' : actual}`;
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    return `${path} must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(', ')}`;
  }
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) return `${path} must be at least ${schema.minimum}`;
    if (typeof schema.maximum === 'number' && value > schema.maximum) return `${path} must be at most ${schema.maximum}`;
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) return `${path} needs at least ${schema.minItems} item(s)`;
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) return `${path} takes at most ${schema.maxItems} item(s)`;
    const items = schema.items as Schema | undefined;
    if (items) {
      for (let i = 0; i < value.length; i++) {
        const problem = validateSchema(items, value[i], `${path}[${i}]`);
        if (problem) return problem;
      }
    }
  }
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) if (typeof key === 'string' && obj[key] === undefined) return `${path}.${key} is required`;
    }
    const props = schema.properties as Record<string, Schema> | undefined;
    if (props) {
      for (const [key, sub] of Object.entries(props)) {
        if (obj[key] === undefined) continue;
        const problem = validateSchema(sub, obj[key], `${path}.${key}`);
        if (problem) return problem;
      }
    }
  }
  return null;
}
