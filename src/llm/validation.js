/** Small, fail-closed JSON-schema subset for local tool arguments. No coercion. */
export class ValidationError extends Error {
  /** @param {string} message */
  constructor(message) { super(message); this.name = 'ValidationError'; }
}

/**
 * @typedef {{ type:'object'|'array'|'string'|'number'|'integer'|'boolean', properties?:Record<string,SimpleSchema>, required?:string[], additionalProperties?:boolean, items?:SimpleSchema, enum?:(string|number|boolean)[], minLength?:number, maxLength?:number, minimum?:number, maximum?:number, minItems?:number, maxItems?:number }} SimpleSchema
 */

const allowedKeys = new Set(['type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'minLength', 'maxLength', 'minimum', 'maximum', 'minItems', 'maxItems']);
const allowedTypes = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean']);

/** Validate the *schema* at registration time, not just arguments at invocation. */
export function checkSchema(/** @type {SimpleSchema} */ schema, /** @type {string} */ path = '$') {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) throw new ValidationError(`${path}: schema must be an object`);
  if (!allowedTypes.has(schema.type)) throw new ValidationError(`${path}: unsupported schema type`);
  for (const key of Object.keys(schema)) if (!allowedKeys.has(key)) throw new ValidationError(`${path}: unsupported keyword ${key}`);
  if (schema.enum && (!Array.isArray(schema.enum) || !schema.enum.length)) throw new ValidationError(`${path}: enum must be nonempty`);
  if (schema.type === 'object') {
    if (schema.additionalProperties !== false) throw new ValidationError(`${path}: object schemas must set additionalProperties:false`);
    if (!schema.properties || typeof schema.properties !== 'object' || Array.isArray(schema.properties)) throw new ValidationError(`${path}: object must define properties`);
    if (schema.required && (!Array.isArray(schema.required) || schema.required.some(k => typeof k !== 'string' || !Object.hasOwn(/** @type {Record<string,SimpleSchema>} */ (schema.properties), k)))) throw new ValidationError(`${path}: invalid required keys`);
    for (const [key, child] of Object.entries(/** @type {Record<string,SimpleSchema>} */ (schema.properties))) checkSchema(child, `${path}.${key}`);
  } else if (schema.properties !== undefined || schema.required !== undefined || schema.additionalProperties !== undefined) {
    throw new ValidationError(`${path}: object-only keyword on non-object`);
  }
  if (schema.type === 'array') {
    if (!schema.items) throw new ValidationError(`${path}: array must define items`);
    checkSchema(schema.items, `${path}[]`);
  } else if (schema.items !== undefined || schema.minItems !== undefined || schema.maxItems !== undefined) {
    throw new ValidationError(`${path}: array-only keyword on non-array`);
  }
  if (schema.type !== 'string' && (schema.minLength !== undefined || schema.maxLength !== undefined)) throw new ValidationError(`${path}: string-only keyword`);
  if (!['number', 'integer'].includes(schema.type) && (schema.minimum !== undefined || schema.maximum !== undefined)) throw new ValidationError(`${path}: number-only keyword`);
}

/** Strictly validate runtime arguments against the supported subset. */
export function validate(/** @type {unknown} */ value, /** @type {SimpleSchema} */ schema, /** @type {string} */ path = '$') {
  const type = schema.type;
  const ok = type === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value)
    : type === 'array' ? Array.isArray(value)
    : type === 'integer' ? Number.isSafeInteger(value)
    : type === 'number' ? typeof value === 'number' && Number.isFinite(value)
    : typeof value === type;
  if (!ok) throw new ValidationError(`${path}: expected ${type}`);
  if (schema.enum && !schema.enum.includes(/** @type {any} */ (value))) throw new ValidationError(`${path}: value not in enum`);
  if (type === 'object') {
    const obj = /** @type {Record<string,unknown>} */ (value);
    const properties = schema.properties ?? {};
    for (const key of schema.required ?? []) if (!Object.hasOwn(obj, key)) throw new ValidationError(`${path}.${key}: missing`);
    for (const [key, item] of Object.entries(obj)) {
      if (!Object.hasOwn(properties, key)) throw new ValidationError(`${path}.${key}: unexpected property`);
      validate(item, properties[key], `${path}.${key}`);
    }
  } else if (type === 'array') {
    const arr = /** @type {unknown[]} */ (value);
    if (schema.minItems !== undefined && arr.length < schema.minItems) throw new ValidationError(`${path}: too few items`);
    if (schema.maxItems !== undefined && arr.length > schema.maxItems) throw new ValidationError(`${path}: too many items`);
    arr.forEach((item, index) => validate(item, /** @type {SimpleSchema} */ (schema.items), `${path}[${index}]`));
  } else if (type === 'string') {
    const v = /** @type {string} */ (value);
    if (schema.minLength !== undefined && v.length < schema.minLength) throw new ValidationError(`${path}: string too short`);
    if (schema.maxLength !== undefined && v.length > schema.maxLength) throw new ValidationError(`${path}: string too long`);
  } else if (type === 'integer' || type === 'number') {
    const v = /** @type {number} */ (value);
    if (schema.minimum !== undefined && v < schema.minimum) throw new ValidationError(`${path}: below minimum`);
    if (schema.maximum !== undefined && v > schema.maximum) throw new ValidationError(`${path}: above maximum`);
  }
  return value;
}
