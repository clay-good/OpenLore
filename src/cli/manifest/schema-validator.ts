/**
 * A deliberately tiny JSON Schema validator — just the subset used by
 * schemas/openlore-manifest-v1.json. Avoids pulling in Ajv (a large dep) for a
 * single internal schema, per spec-05's acceptance criteria.
 *
 * It is no longer single-purpose: `tool-guard.ts` runs every inbound MCP tool
 * call's arguments through it on BOTH transports, and those arguments come from a
 * model that may be under an attacker's influence. A keyword this file ignores is
 * therefore a bound the whole tool surface only *advertises* — a `maxLength: 4096`
 * that nothing enforces. So the size/shape keywords the tool schemas actually
 * declare are implemented here, and `SUPPORTED_SCHEMA_KEYWORDS` is exported so a
 * CI guard can fail the build if a schema ever declares one this file does not
 * enforce (see schema-validator.test.ts).
 *
 * Supported keywords: type (string or array incl. "null"), const, enum,
 * required, dependentRequired, properties, additionalProperties (false, or a
 * subschema applied to the remaining properties), items, oneOf, minLength,
 * maxLength, minimum, maximum, minItems, maxItems, maxProperties. The
 * `integer` type is distinguished from `number`.
 */

export interface ValidationError {
  path: string;
  message: string;
}

type JsonSchema = Record<string, unknown>;

/**
 * Every keyword `validateNode` acts on, plus the pure annotations it may safely
 * ignore. A keyword absent from BOTH lists is one a schema can declare and this
 * validator will silently drop — which is exactly the failure the CI guard exists
 * to prevent, so keep the lists in step with the code below.
 */
export const SUPPORTED_SCHEMA_KEYWORDS: readonly string[] = [
  'type', 'const', 'enum', 'required', 'dependentRequired', 'properties',
  'additionalProperties', 'items', 'oneOf',
  'minLength', 'maxLength', 'minimum', 'maximum', 'minItems', 'maxItems', 'maxProperties',
];

/** Keywords that carry no constraint: ignoring them enforces nothing away. */
export const ANNOTATION_SCHEMA_KEYWORDS: readonly string[] = [
  'description', 'title', 'default', 'examples', '$schema', '$comment',
];

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

  // oneOf — exactly one branch must validate. Branch errors are collected into a
  // scratch list so a failing branch does not pollute the caller's error list; the
  // reported message names the count, not the branch diagnostics (a union's "why"
  // is rarely one branch's complaint).
  if (Array.isArray(schema.oneOf)) {
    const branches = schema.oneOf as JsonSchema[];
    let valid = 0;
    for (const branch of branches) {
      const scratch: ValidationError[] = [];
      validateNode(value, branch, path, scratch);
      if (scratch.length === 0) valid++;
    }
    if (valid !== 1) {
      errors.push({
        path,
        message: `must match exactly one of ${branches.length} allowed shapes (matched ${valid})`,
      });
      return;
    }
  }

  // string bounds
  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
      errors.push({ path, message: `shorter than minLength ${schema.minLength} (got ${value.length})` });
    }
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) {
      errors.push({ path, message: `longer than maxLength ${schema.maxLength} (got ${value.length})` });
    }
  }

  // numeric bounds (inclusive, per JSON Schema)
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      errors.push({ path, message: `below minimum ${schema.minimum} (got ${value})` });
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      errors.push({ path, message: `above maximum ${schema.maximum} (got ${value})` });
    }
  }

  // object
  if (typeOf(value) === 'object') {
    const obj = value as Record<string, unknown>;
    const props = (schema.properties as Record<string, JsonSchema> | undefined) ?? {};

    // maxProperties bounds an open-ended map (e.g. a `layers` object whose keys are
    // caller-chosen), which `properties` cannot.
    if (typeof schema.maxProperties === 'number' && Object.keys(obj).length > schema.maxProperties) {
      errors.push({ path, message: `more than maxProperties ${schema.maxProperties} properties (got ${Object.keys(obj).length})` });
    }

    for (const req of (schema.required as string[] | undefined) ?? []) {
      if (!(req in obj)) errors.push({ path: `${path}/${req}`, message: 'missing required property' });
    }
    const dependentRequired = schema.dependentRequired;
    if (dependentRequired && typeof dependentRequired === 'object' && !Array.isArray(dependentRequired)) {
      for (const [present, dependencies] of Object.entries(dependentRequired as Record<string, unknown>)) {
        if (!(present in obj) || !Array.isArray(dependencies)) continue;
        for (const dependency of dependencies) {
          if (typeof dependency === 'string' && !(dependency in obj)) {
            errors.push({ path: `${path}/${dependency}`, message: `missing property required by ${present}` });
          }
        }
      }
    }

    if (schema.additionalProperties === false) {
      for (const key of Object.keys(obj)) {
        if (!Object.prototype.hasOwnProperty.call(props, key)) {
          errors.push({ path: `${path}/${key}`, message: 'additional property not allowed' });
        }
      }
    } else if (
      schema.additionalProperties
      && typeof schema.additionalProperties === 'object'
      && !Array.isArray(schema.additionalProperties)
    ) {
      // `additionalProperties` as a SUBSCHEMA: the declared shape of every key the
      // schema does not name (an open-ended map's values). Ignoring it left the
      // values of such a map entirely unchecked.
      const extra = schema.additionalProperties as JsonSchema;
      for (const key of Object.keys(obj)) {
        if (!Object.prototype.hasOwnProperty.call(props, key)) {
          validateNode(obj[key], extra, `${path}/${key}`, errors);
        }
      }
    }

    for (const [key, subSchema] of Object.entries(props)) {
      if (key in obj) validateNode(obj[key], subSchema, `${path}/${key}`, errors);
    }
  }

  // array
  if (typeOf(value) === 'array') {
    const arr = value as unknown[];
    if (typeof schema.minItems === 'number' && arr.length < schema.minItems) {
      errors.push({ path, message: `fewer than minItems ${schema.minItems} (got ${arr.length})` });
    }
    // maxItems is checked before the per-item walk so an oversized array is rejected
    // without validating every element of it.
    if (typeof schema.maxItems === 'number' && arr.length > schema.maxItems) {
      errors.push({ path, message: `more than maxItems ${schema.maxItems} items (got ${arr.length})` });
      return;
    }
    if (schema.items) {
      arr.forEach((item, i) => validateNode(item, schema.items as JsonSchema, `${path}/${i}`, errors));
    }
  }
}

/** Validate a parsed JSON value against a parsed JSON Schema. */
export function validateAgainstSchema(value: unknown, schema: JsonSchema): ValidationError[] {
  const errors: ValidationError[] = [];
  validateNode(value, schema, '', errors);
  return errors;
}
