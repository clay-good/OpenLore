/**
 * A deliberately tiny JSON Schema validator — just the subset used by
 * schemas/openlore-manifest-v1.json. Avoids pulling in Ajv (a large dep) for a
 * single internal schema, per spec-05's acceptance criteria.
 *
 * Supported keywords: type (string or array incl. "null"), const, enum,
 * required, properties, additionalProperties (false only), items. The
 * `integer` type is distinguished from `number`.
 */

export interface ValidationError {
  path: string;
  message: string;
}

type JsonSchema = Record<string, unknown>;

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  return typeof value; // 'number' | 'string' | 'boolean' | 'object'
}

/** Returns true if `value` satisfies a single JSON Schema `type` token. */
function matchesType(value: unknown, type: string): boolean {
  const actual = typeOf(value);
  if (type === 'number') return actual === 'number' || actual === 'integer';
  return actual === type;
}

function validateNode(value: unknown, schema: JsonSchema, path: string, errors: ValidationError[]): void {
  // const
  if ('const' in schema && value !== schema.const) {
    errors.push({ path, message: `expected const ${JSON.stringify(schema.const)}, got ${JSON.stringify(value)}` });
    return;
  }

  // type
  if ('type' in schema) {
    const types = Array.isArray(schema.type) ? (schema.type as string[]) : [schema.type as string];
    if (!types.some(t => matchesType(value, t))) {
      errors.push({ path, message: `expected type ${types.join('|')}, got ${typeOf(value)}` });
      return;
    }
  }

  // null short-circuits remaining checks
  if (value === null) return;

  // enum
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    errors.push({ path, message: `value ${JSON.stringify(value)} not in enum ${JSON.stringify(schema.enum)}` });
  }

  // object
  if (typeOf(value) === 'object') {
    const obj = value as Record<string, unknown>;
    const props = (schema.properties as Record<string, JsonSchema> | undefined) ?? {};

    for (const req of (schema.required as string[] | undefined) ?? []) {
      if (!(req in obj)) errors.push({ path: `${path}/${req}`, message: 'missing required property' });
    }

    if (schema.additionalProperties === false) {
      for (const key of Object.keys(obj)) {
        if (!Object.prototype.hasOwnProperty.call(props, key)) {
          errors.push({ path: `${path}/${key}`, message: 'additional property not allowed' });
        }
      }
    }

    for (const [key, subSchema] of Object.entries(props)) {
      if (key in obj) validateNode(obj[key], subSchema, `${path}/${key}`, errors);
    }
  }

  // array
  if (typeOf(value) === 'array' && schema.items) {
    (value as unknown[]).forEach((item, i) =>
      validateNode(item, schema.items as JsonSchema, `${path}/${i}`, errors)
    );
  }
}

/** Validate a parsed JSON value against a parsed JSON Schema. */
export function validateAgainstSchema(value: unknown, schema: JsonSchema): ValidationError[] {
  const errors: ValidationError[] = [];
  validateNode(value, schema, '', errors);
  return errors;
}
